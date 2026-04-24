import type { MediaAsset } from '@/types';
import {
  PIAPI_KLING_3_OMNI_MODEL_ID,
  PIAPI_VEO_FAST_MODEL_ID,
  PIAPI_VEO_STANDARD_MODEL_ID,
} from '@/lib/videoModels/capabilities';
import { classifyProviderErrorText, VideoGenerationProviderError } from './errors';
import { assetsByRole, type VideoGenerationMutation } from './mutations';

export const PIAPI_API_BASE_URL = 'https://api.piapi.ai';
export const PIAPI_ARTIFACT_TTL_MS = 48 * 60 * 60 * 1000;

export type PiApiCredentials = {
  apiKey: string;
};

export type PiApiCreateTaskRequest = {
  body: Record<string, unknown>;
};

export type PiApiReferenceUrlResolver = (asset: MediaAsset, label: string) => Promise<string>;

export type PiApiCreateTaskOptions = {
  resolveReferenceUrl?: PiApiReferenceUrlResolver;
};

export type PiApiTaskData = {
  task_id?: string;
  status?: string;
  output?: Record<string, unknown> | null;
  error?: {
    code?: number | string;
    message?: string;
    raw_message?: string;
    detail?: unknown;
  };
};

type PiApiEnvelope<T> = {
  code?: number;
  message?: string;
  data?: T;
};

type PiApiImageEntry = {
  token: string;
  url: string;
  purpose: string;
};

type PiApiVideoEntry = {
  token: string;
  url: string;
};

export function isPiApiReferenceAsset(asset: MediaAsset, now = Date.now()): boolean {
  return Boolean(piApiReferenceUrl(asset, now));
}

export async function buildPiApiCreateTaskRequest(
  mutation: VideoGenerationMutation,
  options: PiApiCreateTaskOptions = {},
): Promise<PiApiCreateTaskRequest> {
  if (isPiApiKlingModelId(mutation.modelId)) return buildPiApiKlingOmniRequest(mutation, options);
  if (isPiApiVeoModelId(mutation.modelId)) return buildPiApiVeoRequest(mutation, options);
  throw new VideoGenerationProviderError('InternalError', `${mutation.modelId} is not configured for PiAPI.`);
}

export async function createPiApiVideoTask(
  request: PiApiCreateTaskRequest,
  credentials: PiApiCredentials,
): Promise<PiApiTaskData> {
  const response = await piApiFetch('/api/v1/task', credentials, {
    method: 'POST',
    body: JSON.stringify(request.body),
  });
  return readPiApiTaskResponse(response, 'PiAPI generation request failed');
}

export async function pollPiApiVideoTask({
  credentials,
  initialTask,
  onProgress,
}: {
  credentials: PiApiCredentials;
  initialTask: PiApiTaskData;
  onProgress?: (progress: number) => void;
}): Promise<PiApiTaskData> {
  const taskId = initialTask.task_id;
  if (!taskId) throw new VideoGenerationProviderError('InternalError', 'PiAPI did not return a task id.');

  let task = initialTask;
  let progress = 5;
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const status = normalizeStatus(task.status);
    if (isFailedStatus(status)) throw piApiTaskFailure(task);
    if (isCompletedStatus(status) && generatedPiApiVideoFromTask(task).url) return task;

    await new Promise((resolve) => setTimeout(resolve, 5000));
    progress = Math.min(95, progress + 5);
    onProgress?.(progress);
    const response = await piApiFetch(`/api/v1/task/${encodeURIComponent(taskId)}`, credentials, { method: 'GET' });
    task = await readPiApiTaskResponse(response, 'PiAPI generation poll failed');
  }

  throw new VideoGenerationProviderError('InternalError', 'PiAPI generation timed out before returning a video.');
}

export function generatedPiApiVideoFromTask(task: PiApiTaskData): { url?: string } {
  const output = task.output ?? {};
  const directCandidates = [
    output.video,
    output.video_url,
    output.url,
    output.download_url,
  ];
  for (const candidate of directCandidates) {
    if (typeof candidate === 'string' && candidate.trim()) return { url: candidate.trim() };
    if (isObject(candidate)) {
      const nested = [candidate.url, candidate.uri, candidate.video_url];
      const found = nested.find((value) => typeof value === 'string' && value.trim());
      if (typeof found === 'string') return { url: found.trim() };
    }
  }

  const arrayCandidates = [output.videos, output.generated_videos, output.samples];
  for (const candidate of arrayCandidates) {
    if (!Array.isArray(candidate)) continue;
    for (const item of candidate) {
      if (typeof item === 'string' && item.trim()) return { url: item.trim() };
      if (!isObject(item)) continue;
      const found = [item.url, item.uri, item.video_url].find((value) => typeof value === 'string' && value.trim());
      if (typeof found === 'string') return { url: found.trim() };
    }
  }

  return {};
}

async function buildPiApiVeoRequest(
  mutation: VideoGenerationMutation,
  options: PiApiCreateTaskOptions,
): Promise<PiApiCreateTaskRequest> {
  const startFrames = assetsByRole(mutation, 'start-frame');
  const endFrames = assetsByRole(mutation, 'end-frame');
  const referenceImages = assetsByRole(mutation, 'reference-image');
  const sourceVideos = assetsByRole(mutation, 'source-video');

  validatePiApiVeoMutation({ startFrames, endFrames, referenceImages, sourceVideos, mutation });

  const referenceUrls = await Promise.all(
    referenceImages.map((asset) => resolvePiApiReferenceUrl(asset, 'Veo image reference', options)),
  );
  const imageUrl = startFrames[0]
    ? await resolvePiApiReferenceUrl(startFrames[0], 'Veo start frame', options)
    : referenceUrls[0];
  const tailImageUrl = endFrames[0]
    ? await resolvePiApiReferenceUrl(endFrames[0], 'Veo end frame', options)
    : undefined;
  const extraReferenceUrls = startFrames[0] ? referenceUrls : referenceUrls.slice(1);

  const input: Record<string, unknown> = {
    prompt: mutation.prompt,
    aspect_ratio: mutation.config.aspectRatio,
    duration: `${mutation.config.durationSeconds}s`,
    resolution: mutation.config.resolution,
    generate_audio: mutation.config.audioEnabled,
  };
  if (imageUrl) input.image_url = imageUrl;
  if (tailImageUrl) input.tail_image_url = tailImageUrl;
  if (extraReferenceUrls.length > 0) input.reference_image_urls = extraReferenceUrls;

  return {
    body: {
      model: 'veo3.1',
      task_type: mutation.modelId === PIAPI_VEO_FAST_MODEL_ID ? 'veo3.1-video-fast' : 'veo3.1-video',
      input,
      config: {
        service_mode: 'public',
      },
    },
  };
}

async function buildPiApiKlingOmniRequest(
  mutation: VideoGenerationMutation,
  options: PiApiCreateTaskOptions,
): Promise<PiApiCreateTaskRequest> {
  const startFrames = assetsByRole(mutation, 'start-frame');
  const endFrames = assetsByRole(mutation, 'end-frame');
  const referenceImages = assetsByRole(mutation, 'reference-image');
  const sourceVideos = assetsByRole(mutation, 'source-video');

  validatePiApiKlingMutation({ startFrames, endFrames, referenceImages, sourceVideos });

  const referenceImageEntries = await Promise.all(referenceImages.map(async (asset, index) => ({
      token: `image${index + 1}`,
      url: await resolvePiApiReferenceUrl(asset, 'Kling image reference', options),
      purpose: `reference image ${index + 1}`,
    })));
  const frameImageEntries = await Promise.all([
    ...(startFrames[0] ? [{
      token: 'start-frame',
      asset: startFrames[0],
      purpose: 'start frame',
    }] : []),
    ...(endFrames[0] ? [{
      token: 'end-frame',
      asset: endFrames[0],
      purpose: 'end frame',
    }] : []),
  ].map(async (entry) => ({
    token: entry.token,
    url: await resolvePiApiReferenceUrl(entry.asset, `Kling ${entry.purpose}`, options),
    purpose: entry.purpose,
  })));
  const imageEntries: PiApiImageEntry[] = [...referenceImageEntries, ...frameImageEntries];
  const videoEntries: PiApiVideoEntry[] = await Promise.all(sourceVideos.map(async (asset, index) => ({
    token: `video${index + 1}`,
    url: await resolvePiApiReferenceUrl(asset, 'Kling video reference', options),
  })));

  const input: Record<string, unknown> = {
    prompt: rewriteKlingPromptReferences(mutation.prompt, imageEntries, videoEntries),
    version: '3.0',
    resolution: mutation.config.resolution,
    duration: mutation.config.durationSeconds,
    aspect_ratio: mutation.config.aspectRatio,
    enable_audio: mutation.config.audioEnabled,
  };
  if (imageEntries.length > 0) input.images = imageEntries.map((entry) => entry.url);
  if (videoEntries[0]) {
    input.video = videoEntries[0].url;
    input.keep_original_audio = mutation.config.audioEnabled;
  }

  return {
    body: {
      model: 'kling',
      task_type: 'omni_video_generation',
      input,
      config: {
        service_mode: 'public',
      },
    },
  };
}

function validatePiApiVeoMutation({
  startFrames,
  endFrames,
  referenceImages,
  sourceVideos,
  mutation,
}: {
  startFrames: MediaAsset[];
  endFrames: MediaAsset[];
  referenceImages: MediaAsset[];
  sourceVideos: MediaAsset[];
  mutation: VideoGenerationMutation;
}) {
  if (sourceVideos.length > 0) throw new Error('PiAPI Veo 3.1 video references are not enabled in GenEdit yet.');
  if (startFrames.length > 1) throw new Error('Veo accepts one start frame.');
  if (endFrames.length > 1) throw new Error('Veo accepts one end frame.');
  if (endFrames.length > 0 && startFrames.length === 0) throw new Error('A Veo end frame requires a start frame.');
  if (referenceImages.length > 0 && (startFrames.length > 0 || endFrames.length > 0)) {
    throw new Error('References will not be used since start / end frame is specified.');
  }
  if (referenceImages.length > 3) throw new Error('Veo accepts up to 3 image references.');
  if (referenceImages.length > 0 && mutation.config.durationSeconds !== 8) {
    throw new Error('PiAPI Veo image references require an 8 second generation.');
  }
  if (referenceImages.length > 0 && mutation.config.aspectRatio !== '16:9') {
    throw new Error('PiAPI Veo reference-image mode supports 16:9 output.');
  }
  for (const asset of [...startFrames, ...endFrames, ...referenceImages]) {
    if (asset.kind !== 'image') throw new Error(`${asset.name} must be an image input.`);
  }
}

function validatePiApiKlingMutation({
  startFrames,
  endFrames,
  referenceImages,
  sourceVideos,
}: {
  startFrames: MediaAsset[];
  endFrames: MediaAsset[];
  referenceImages: MediaAsset[];
  sourceVideos: MediaAsset[];
}) {
  if (startFrames.length > 1) throw new Error('Kling accepts one start frame.');
  if (endFrames.length > 1) throw new Error('Kling accepts one end frame.');
  if (sourceVideos.length > 1) throw new Error('Kling Omni accepts one video reference.');
  if (sourceVideos.length > 0 && (startFrames.length > 0 || endFrames.length > 0)) {
    throw new Error('Kling video references cannot be combined with start/end frames.');
  }
  const imageLimit = sourceVideos.length > 0 ? 4 : 7;
  if (referenceImages.length > imageLimit) throw new Error(`Kling Omni accepts up to ${imageLimit} image references in this mode.`);
  for (const asset of [...startFrames, ...endFrames, ...referenceImages]) {
    if (asset.kind !== 'image') throw new Error(`${asset.name} must be an image input.`);
  }
  for (const asset of sourceVideos) {
    if (asset.kind !== 'video') throw new Error(`${asset.name} must be a video input.`);
  }
}

async function piApiFetch(path: string, credentials: PiApiCredentials, init: RequestInit): Promise<Response> {
  return fetch(`${PIAPI_API_BASE_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': credentials.apiKey,
      ...(init.headers ?? {}),
    },
  });
}

async function readPiApiTaskResponse(response: Response, fallback: string): Promise<PiApiTaskData> {
  const text = await response.text().catch(() => '');
  let parsed: PiApiEnvelope<PiApiTaskData> | null = null;
  if (text) {
    try {
      parsed = JSON.parse(text) as PiApiEnvelope<PiApiTaskData>;
    } catch {
      // fall through to plain text
    }
  }

  const envelopeOk = parsed?.code === undefined || parsed.code === 0 || parsed.code === 200;
  const taskData = parsed?.data;
  const dataStatus = normalizeStatus(taskData?.status);
  const hasDataFailure = taskData && (
    isFailedStatus(dataStatus) ||
    hasPiApiTaskError(taskData)
  );
  if (hasDataFailure) throw piApiTaskFailure(taskData, fallback, response.status, parsed?.code);

  if (!response.ok || !envelopeOk) {
    const message = piApiErrorMessage(taskData, parsed?.message || text || `${fallback} (${response.status}).`);
    throw new VideoGenerationProviderError(
      classifyPiApiError(response.status, parsed?.code, message),
      `${fallback} (${response.status}${parsed?.code !== undefined ? `/${parsed.code}` : ''}): ${message}`,
    );
  }

  if (!parsed?.data) throw new VideoGenerationProviderError('InternalError', `${fallback}: PiAPI returned no task data.`);
  return parsed.data;
}

function piApiTaskFailure(
  task: PiApiTaskData,
  fallback = 'PiAPI generation failed',
  status?: number,
  envelopeCode?: number,
): VideoGenerationProviderError {
  const message = piApiErrorMessage(task, 'PiAPI generation failed.');
  const prefix = status
    ? `${fallback} (${status}${envelopeCode !== undefined ? `/${envelopeCode}` : ''})`
    : fallback;
  return new VideoGenerationProviderError(classifyProviderErrorText(message), `${prefix}: ${message}`);
}

function classifyPiApiError(status: number, code: number | undefined, message: string) {
  if (status === 401 || status === 403) return 'InternalError';
  if (status >= 500 || (code !== undefined && code >= 5000)) return 'InternalError';
  return classifyProviderErrorText(message);
}

function hasPiApiTaskError(task: PiApiTaskData): boolean {
  const dataErrorCode = task.error?.code;
  const numericErrorCode = typeof dataErrorCode === 'string' ? Number(dataErrorCode) : dataErrorCode;
  return Boolean(
    (Number.isFinite(numericErrorCode) && numericErrorCode !== 0) ||
    task.error?.message ||
    task.error?.raw_message ||
    task.error?.detail,
  );
}

function piApiErrorMessage(task: PiApiTaskData | undefined, fallback: string): string {
  if (!task) return fallback;
  const rawMessage = task.error?.raw_message?.trim();
  const message = task.error?.message?.trim();
  const detail = typeof task.error?.detail === 'string' ? task.error.detail.trim() : '';
  const parts = [message, rawMessage, detail]
    .filter((part): part is string => Boolean(part))
    .filter((part, index, all) => all.findIndex((candidate) => candidate.toLowerCase() === part.toLowerCase()) === index);
  return parts.join(': ') || fallback;
}

function rewriteKlingPromptReferences(
  prompt: string,
  imageEntries: PiApiImageEntry[],
  videoEntries: PiApiVideoEntry[],
): string {
  let next = prompt;
  const missingDirectives: string[] = [];
  imageEntries.forEach((entry, index) => {
    const replacement = `@image_${index + 1}`;
    const hadToken = containsPromptToken(next, entry.token);
    next = replacePromptToken(next, entry.token, replacement);
    if (!hadToken) missingDirectives.push(`Use ${replacement} as the ${entry.purpose}.`);
  });
  videoEntries.forEach((entry) => {
    const hadToken = containsPromptToken(next, entry.token);
    next = replacePromptToken(next, entry.token, '@video');
    if (!hadToken) missingDirectives.push('Use @video as the video reference.');
  });
  return `${missingDirectives.join(' ')} ${next}`.trim();
}

function containsPromptToken(prompt: string, token: string): boolean {
  return new RegExp(`@${escapeRegExp(token)}(?=\\b|[^a-zA-Z0-9_-]|$)`, 'i').test(prompt);
}

function replacePromptToken(prompt: string, token: string, replacement: string): string {
  return prompt.replace(new RegExp(`@${escapeRegExp(token)}(?=\\b|[^a-zA-Z0-9_-]|$)`, 'gi'), replacement);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function resolvePiApiReferenceUrl(
  asset: MediaAsset,
  label: string,
  options: PiApiCreateTaskOptions,
): Promise<string> {
  const url = piApiReferenceUrl(asset);
  if (url) return url;
  if (options.resolveReferenceUrl) return options.resolveReferenceUrl(asset, label);
  throw new Error(`${label} "${asset.name}" needs an active hosted URL or temporary reference host.`);
}

function piApiReferenceUrl(asset: MediaAsset, now = Date.now()): string | null {
  const uri = asset.generation?.providerArtifactUri?.trim();
  if (!uri || !/^https?:\/\//i.test(uri)) return null;
  if (asset.generation?.provider === 'google-veo') return null;
  const expiresAt = asset.generation?.providerArtifactExpiresAt;
  if (expiresAt && expiresAt <= now) return null;
  return uri;
}

function normalizeStatus(status: string | undefined): string {
  return (status ?? '').trim().toLowerCase();
}

function isCompletedStatus(status: string): boolean {
  return status === 'completed' || status === 'succeed' || status === 'succeeded' || status === 'success' || status === 'finished';
}

function isFailedStatus(status: string): boolean {
  return status === 'failed' || status === 'failure' || status === 'error';
}

function isPiApiVeoModelId(modelId: string): boolean {
  return modelId === PIAPI_VEO_STANDARD_MODEL_ID || modelId === PIAPI_VEO_FAST_MODEL_ID;
}

function isPiApiKlingModelId(modelId: string): boolean {
  return modelId === PIAPI_KLING_3_OMNI_MODEL_ID;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
