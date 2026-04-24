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

export type PiApiTaskData = {
  task_id?: string;
  status?: string;
  output?: Record<string, unknown>;
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
): Promise<PiApiCreateTaskRequest> {
  if (isPiApiKlingModelId(mutation.modelId)) return buildPiApiKlingOmniRequest(mutation);
  if (isPiApiVeoModelId(mutation.modelId)) return buildPiApiVeoRequest(mutation);
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
    if (isCompletedStatus(status)) return task;
    if (isFailedStatus(status)) throw piApiTaskFailure(task);

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

async function buildPiApiVeoRequest(mutation: VideoGenerationMutation): Promise<PiApiCreateTaskRequest> {
  const startFrames = assetsByRole(mutation, 'start-frame');
  const endFrames = assetsByRole(mutation, 'end-frame');
  const referenceImages = assetsByRole(mutation, 'reference-image');
  const sourceVideos = assetsByRole(mutation, 'source-video');

  validatePiApiVeoMutation({ startFrames, endFrames, referenceImages, sourceVideos, mutation });

  const referenceUrls = referenceImages.map((asset) => requirePiApiReferenceUrl(asset, 'Veo image reference'));
  const imageUrl = startFrames[0]
    ? requirePiApiReferenceUrl(startFrames[0], 'Veo start frame')
    : referenceUrls[0];
  const tailImageUrl = endFrames[0] ? requirePiApiReferenceUrl(endFrames[0], 'Veo end frame') : undefined;
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

async function buildPiApiKlingOmniRequest(mutation: VideoGenerationMutation): Promise<PiApiCreateTaskRequest> {
  const startFrames = assetsByRole(mutation, 'start-frame');
  const endFrames = assetsByRole(mutation, 'end-frame');
  const referenceImages = assetsByRole(mutation, 'reference-image');
  const sourceVideos = assetsByRole(mutation, 'source-video');

  validatePiApiKlingMutation({ startFrames, endFrames, referenceImages, sourceVideos });

  const imageEntries: PiApiImageEntry[] = [
    ...referenceImages.map((asset, index) => ({
      token: `image${index + 1}`,
      url: requirePiApiReferenceUrl(asset, 'Kling image reference'),
      purpose: `reference image ${index + 1}`,
    })),
    ...(startFrames[0] ? [{
      token: 'start-frame',
      url: requirePiApiReferenceUrl(startFrames[0], 'Kling start frame'),
      purpose: 'start frame',
    }] : []),
    ...(endFrames[0] ? [{
      token: 'end-frame',
      url: requirePiApiReferenceUrl(endFrames[0], 'Kling end frame'),
      purpose: 'end frame',
    }] : []),
  ];
  const videoEntries: PiApiVideoEntry[] = sourceVideos.map((asset, index) => ({
    token: `video${index + 1}`,
    url: requirePiApiReferenceUrl(asset, 'Kling video reference'),
  }));

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
  if (!response.ok || !envelopeOk) {
    const message = parsed?.message || text || `${fallback} (${response.status}).`;
    throw new VideoGenerationProviderError(
      classifyPiApiError(response.status, parsed?.code, message),
      `${fallback} (${response.status}${parsed?.code !== undefined ? `/${parsed.code}` : ''}): ${message}`,
    );
  }

  if (!parsed?.data) throw new VideoGenerationProviderError('InternalError', `${fallback}: PiAPI returned no task data.`);
  const dataErrorCode = parsed.data.error?.code;
  const numericErrorCode = typeof dataErrorCode === 'string' ? Number(dataErrorCode) : dataErrorCode;
  if (Number.isFinite(numericErrorCode) && numericErrorCode !== 0) throw piApiTaskFailure(parsed.data);
  if (isFailedStatus(normalizeStatus(parsed.data.status))) throw piApiTaskFailure(parsed.data);
  return parsed.data;
}

function piApiTaskFailure(task: PiApiTaskData): VideoGenerationProviderError {
  const message = [
    task.error?.message,
    task.error?.raw_message,
    typeof task.error?.detail === 'string' ? task.error.detail : '',
  ].filter(Boolean).join(' ') || 'PiAPI generation failed.';
  return new VideoGenerationProviderError(classifyProviderErrorText(message), message);
}

function classifyPiApiError(status: number, code: number | undefined, message: string) {
  if (status === 401 || status === 403) return 'InternalError';
  if (status >= 500 || (code !== undefined && code >= 5000)) return 'InternalError';
  return classifyProviderErrorText(message);
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

function requirePiApiReferenceUrl(asset: MediaAsset, label: string): string {
  const url = piApiReferenceUrl(asset);
  if (!url) {
    throw new Error(`${label} "${asset.name}" needs an active hosted URL. PiAPI's browser task endpoint works client-side, but its file-upload endpoint is not browser-callable yet.`);
  }
  return url;
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
