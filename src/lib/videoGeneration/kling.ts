import { getBlob } from '@/lib/media/storage';
import type { MediaAsset } from '@/types';
import { classifyProviderErrorText, VideoGenerationProviderError } from './errors';
import { assetsByRole, type VideoGenerationMutation } from './mutations';

export const KLING_API_REMOTE_BASE_URL = 'https://api-singapore.klingai.com';
export const KLING_API_BASE_URL = import.meta.env.VITE_KLING_API_BASE_URL?.trim() || '/kling-api';
export const KLING_ARTIFACT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type KlingCredentials = {
  accessKey: string;
  secretKey: string;
};

export type KlingTaskRoute = 'text2video' | 'image2video' | 'omni-video';

export type KlingCreateTaskRequest = {
  route: KlingTaskRoute;
  createPath: string;
  queryPath: (taskId: string) => string;
  body: Record<string, unknown>;
};

export type KlingGeneratedVideo = {
  id?: string;
  url?: string;
  watermark_url?: string;
  duration?: string;
};

export type KlingTaskData = {
  task_id?: string;
  task_status?: 'submitted' | 'processing' | 'succeed' | 'failed' | string;
  task_status_msg?: string;
  task_result?: {
    videos?: KlingGeneratedVideo[];
  };
  final_unit_deduction?: string;
  created_at?: number;
  updated_at?: number;
};

type KlingApiEnvelope<T> = {
  code?: number;
  message?: string;
  request_id?: string;
  data?: T;
};

type KlingOmniImageEntry = {
  token: string;
  asset: MediaAsset;
  type?: 'first_frame' | 'end_frame';
};

export async function buildKlingCreateTaskRequest(
  mutation: VideoGenerationMutation,
): Promise<KlingCreateTaskRequest> {
  const startFrames = assetsByRole(mutation, 'start-frame');
  const endFrames = assetsByRole(mutation, 'end-frame');
  const referenceImages = assetsByRole(mutation, 'reference-image');
  const sourceVideos = assetsByRole(mutation, 'source-video');
  const useOmniVideo = isKlingOmniModel(mutation.modelId) || referenceImages.length > 0 || sourceVideos.length > 0;

  validateKlingMutation({ modelId: mutation.modelId, startFrames, endFrames, referenceImages, sourceVideos, useOmniVideo });

  if (useOmniVideo) {
    return buildKlingOmniVideoTaskRequest(mutation, { startFrames, endFrames, referenceImages, sourceVideos });
  }

  const baseBody: Record<string, unknown> = {
    model_name: mutation.modelId,
    prompt: mutation.prompt,
    duration: String(mutation.config.durationSeconds),
    mode: klingModeFromResolution(mutation.config.resolution),
    sound: mutation.config.audioEnabled ? 'on' : 'off',
  };

  if (startFrames[0] || endFrames[0]) {
    if (startFrames[0]) baseBody.image = await assetToKlingImageBase64(startFrames[0]);
    if (endFrames[0]) baseBody.image_tail = await assetToKlingImageBase64(endFrames[0]);
    return {
      route: 'image2video',
      createPath: '/v1/videos/image2video',
      queryPath: (taskId) => `/v1/videos/image2video/${encodeURIComponent(taskId)}`,
      body: baseBody,
    };
  }

  baseBody.aspect_ratio = mutation.config.aspectRatio;
  return {
    route: 'text2video',
    createPath: '/v1/videos/text2video',
    queryPath: (taskId) => `/v1/videos/text2video/${encodeURIComponent(taskId)}`,
    body: baseBody,
  };
}

export function isKlingVideoReferenceAsset(asset: MediaAsset, now = Date.now()): boolean {
  return Boolean(klingVideoReferenceUrl(asset, now));
}

export async function createKlingVideoTask(
  request: KlingCreateTaskRequest,
  credentials: KlingCredentials,
): Promise<KlingTaskData> {
  const response = await klingFetch(request.createPath, credentials, {
    method: 'POST',
    body: JSON.stringify(request.body),
  });
  return readKlingTaskResponse(response, 'Kling generation request failed');
}

export async function pollKlingVideoTask({
  request,
  credentials,
  initialTask,
  onProgress,
}: {
  request: KlingCreateTaskRequest;
  credentials: KlingCredentials;
  initialTask: KlingTaskData;
  onProgress?: (progress: number) => void;
}): Promise<KlingTaskData> {
  const taskId = initialTask.task_id;
  if (!taskId) throw new VideoGenerationProviderError('InternalError', 'Kling did not return a task id.');

  let task = initialTask;
  let progress = 5;
  for (let attempt = 0; attempt < 180; attempt += 1) {
    if (task.task_status === 'succeed') return task;
    if (task.task_status === 'failed') throw klingTaskFailure(task);

    await new Promise((resolve) => setTimeout(resolve, 5000));
    progress = Math.min(95, progress + 5);
    onProgress?.(progress);
    const response = await klingFetch(request.queryPath(taskId), credentials, { method: 'GET' });
    task = await readKlingTaskResponse(response, 'Kling generation poll failed');
  }

  throw new VideoGenerationProviderError('InternalError', 'Kling generation timed out before returning a video.');
}

export function generatedKlingVideoFromTask(task: KlingTaskData): KlingGeneratedVideo | undefined {
  return task.task_result?.videos?.find((video) => video.url);
}

async function klingFetch(path: string, credentials: KlingCredentials, init: RequestInit): Promise<Response> {
  const normalizedCredentials = normalizeKlingCredentials(credentials);
  const token = await createKlingJwt(normalizedCredentials);
  return fetch(klingApiUrl(path), {
    ...init,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

async function readKlingTaskResponse(response: Response, fallback: string): Promise<KlingTaskData> {
  const text = await response.text().catch(() => '');
  let parsed: KlingApiEnvelope<KlingTaskData> | null = null;
  if (text) {
    try {
      parsed = JSON.parse(text) as KlingApiEnvelope<KlingTaskData>;
    } catch {
      // fall through to plain text error
    }
  }

  if (!response.ok || (parsed?.code !== undefined && parsed.code !== 0)) {
    const message = parsed?.message || text || `${fallback} (${response.status}).`;
    throw new VideoGenerationProviderError(
      classifyKlingError(response.status, parsed?.code, message),
      `${fallback} (${response.status}${parsed?.code !== undefined ? `/${parsed.code}` : ''}): ${message}`,
    );
  }

  if (!parsed?.data) throw new VideoGenerationProviderError('InternalError', `${fallback}: Kling returned no task data.`);
  if (parsed.data.task_status === 'failed') throw klingTaskFailure(parsed.data);
  return parsed.data;
}

function klingTaskFailure(task: KlingTaskData): VideoGenerationProviderError {
  const message = task.task_status_msg || 'Kling generation failed.';
  return new VideoGenerationProviderError(classifyProviderErrorText(message), message);
}

function classifyKlingError(status: number, code: number | undefined, message: string) {
  if (code === 1300 || code === 1301) return 'GuidelinesViolation';
  if (status >= 500 || (code !== undefined && code >= 5000)) return 'InternalError';
  return classifyProviderErrorText(message);
}

async function buildKlingOmniVideoTaskRequest(
  mutation: VideoGenerationMutation,
  {
    startFrames,
    endFrames,
    referenceImages,
    sourceVideos,
  }: {
    startFrames: MediaAsset[];
    endFrames: MediaAsset[];
    referenceImages: MediaAsset[];
    sourceVideos: MediaAsset[];
  },
): Promise<KlingCreateTaskRequest> {
  const imageEntries: KlingOmniImageEntry[] = [
    ...referenceImages.map((asset, index) => ({ token: `image${index + 1}`, asset })),
    ...(startFrames[0] ? [{ token: 'start-frame', asset: startFrames[0], type: 'first_frame' as const }] : []),
    ...(endFrames[0] ? [{ token: 'end-frame', asset: endFrames[0], type: 'end_frame' as const }] : []),
  ];
  const videoEntries = sourceVideos.map((asset, index) => ({ token: `video${index + 1}`, asset }));
  const hasFrameInput = startFrames.length > 0 || endFrames.length > 0;

  const body: Record<string, unknown> = {
    model_name: klingOmniModelName(mutation.modelId),
    prompt: rewriteKlingPromptReferences(mutation.prompt, imageEntries, videoEntries),
    duration: String(mutation.config.durationSeconds),
    mode: klingModeFromResolution(mutation.config.resolution),
    sound: sourceVideos.length > 0 ? 'off' : (mutation.config.audioEnabled ? 'on' : 'off'),
  };

  if (!hasFrameInput) body.aspect_ratio = mutation.config.aspectRatio;
  if (imageEntries.length > 0) {
    body.image_list = await Promise.all(imageEntries.map(async (entry) => ({
      image_url: await assetToKlingImageBase64(entry.asset),
      ...(entry.type ? { type: entry.type } : {}),
    })));
  }
  if (videoEntries.length > 0) {
    body.video_list = videoEntries.map((entry) => {
      const videoUrl = klingVideoReferenceUrl(entry.asset);
      if (!videoUrl) throw new Error(`${entry.asset.name} needs an active remote URL for Kling video reference.`);
      return {
        video_url: videoUrl,
        refer_type: 'feature',
        keep_original_sound: mutation.config.audioEnabled ? 'yes' : 'no',
      };
    });
  }

  return {
    route: 'omni-video',
    createPath: '/v1/videos/omni-video',
    queryPath: (taskId) => `/v1/videos/omni-video/${encodeURIComponent(taskId)}`,
    body,
  };
}

function validateKlingMutation({
  modelId,
  startFrames,
  endFrames,
  referenceImages,
  sourceVideos,
  useOmniVideo,
}: {
  modelId: string;
  startFrames: MediaAsset[];
  endFrames: MediaAsset[];
  referenceImages: MediaAsset[];
  sourceVideos: MediaAsset[];
  useOmniVideo: boolean;
}) {
  if (startFrames.length > 1) throw new Error('Kling accepts one start frame.');
  if (endFrames.length > 1) throw new Error('Kling accepts one end frame.');
  if (endFrames.length > 0 && startFrames.length === 0) throw new Error('Kling end frame generation requires a start frame.');
  if ((referenceImages.length > 0 || sourceVideos.length > 0) && !useOmniVideo) {
    throw new Error(`${modelId} does not support Kling Omni references.`);
  }
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
    if (!klingVideoReferenceUrl(asset)) {
      throw new Error(`${asset.name} needs an active remote URL for Kling video reference. Local video upload is not available yet.`);
    }
  }
}

function isKlingOmniModel(modelId: string): boolean {
  return ['kling-v3', 'kling-v3-omni', 'kling-video-o1'].includes(modelId);
}

function klingOmniModelName(modelId: string): string {
  if (modelId === 'kling-v3' || modelId === 'kling-v3-omni') return 'kling-v3-omni';
  if (modelId === 'kling-video-o1') return 'kling-video-o1';
  return modelId;
}

function rewriteKlingPromptReferences(
  prompt: string,
  imageEntries: Array<{ token: string }>,
  videoEntries: Array<{ token: string }>,
): string {
  let next = prompt;
  imageEntries.forEach((entry, index) => {
    next = replacePromptToken(next, entry.token, `<<<image_${index + 1}>>>`);
  });
  videoEntries.forEach((entry, index) => {
    next = replacePromptToken(next, entry.token, `<<<video_${index + 1}>>>`);
  });
  return next;
}

function replacePromptToken(prompt: string, token: string, replacement: string): string {
  return prompt.replace(new RegExp(`@${escapeRegExp(token)}(?=\\b|[^a-zA-Z0-9_-]|$)`, 'gi'), replacement);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function klingVideoReferenceUrl(asset: MediaAsset, now = Date.now()): string | null {
  if (asset.kind !== 'video') return null;
  const uri = asset.generation?.providerArtifactUri?.trim();
  if (!uri) return null;
  const expiresAt = asset.generation?.providerArtifactExpiresAt;
  if (expiresAt && expiresAt <= now) return null;
  return uri;
}

function klingModeFromResolution(resolution: string): 'std' | 'pro' | '4k' {
  if (resolution === '720p') return 'std';
  if (resolution === '1080p') return 'pro';
  if (resolution === '4k') return '4k';
  throw new Error(`Kling does not support ${resolution} output.`);
}

async function assetToKlingImageBase64(asset: MediaAsset): Promise<string> {
  const blob = await getBlob(asset.blobKey);
  if (!blob) throw new Error(`Could not read ${asset.name}.`);
  if (blob.size > 10 * 1024 * 1024) throw new Error(`${asset.name} is larger than Kling's 10MB image limit.`);
  const mimeType = supportedKlingImageMimeType(asset, blob);
  if (!mimeType) throw new Error(`${asset.name} must be a PNG or JPEG image for Kling.`);
  return blobToBase64(blob);
}

function supportedKlingImageMimeType(asset: MediaAsset, blob: Blob): string | null {
  const candidates = [
    blob.type,
    asset.mimeType,
    mimeTypeFromFilename(asset.name),
  ].map((mimeType) => mimeType.toLowerCase());
  for (const mimeType of candidates) {
    if (mimeType === 'image/jpg') return 'image/jpeg';
    if (mimeType === 'image/jpeg' || mimeType === 'image/png') return mimeType;
  }
  return null;
}

function mimeTypeFromFilename(name: string): string {
  const extension = name.split('.').pop()?.toLowerCase();
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg';
  if (extension === 'png') return 'image/png';
  return '';
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not encode media reference.'));
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      resolve(result.split(',')[1] ?? '');
    };
    reader.readAsDataURL(blob);
  });
}

async function createKlingJwt(credentials: KlingCredentials): Promise<string> {
  if (!crypto.subtle) throw new Error('This browser does not support secure JWT signing.');
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlJson({ alg: 'HS256', typ: 'JWT' });
  const payload = base64UrlJson({
    iss: credentials.accessKey,
    exp: now + 1800,
    nbf: now - 5,
  });
  const signingInput = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(credentials.secretKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64UrlBytes(new Uint8Array(signature))}`;
}

function normalizeKlingCredentials(credentials: KlingCredentials): KlingCredentials {
  return {
    accessKey: credentials.accessKey.trim(),
    secretKey: credentials.secretKey.trim(),
  };
}

function klingApiUrl(path: string): string {
  const base = KLING_API_BASE_URL.replace(/\/+$/, '');
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${base}${normalizedPath}`;
}

function base64UrlJson(value: unknown): string {
  return base64UrlBytes(new TextEncoder().encode(JSON.stringify(value)));
}

function base64UrlBytes(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.slice(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
