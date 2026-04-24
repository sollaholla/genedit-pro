import { getBlob } from '@/lib/media/storage';
import type { MediaAsset } from '@/types';
import { classifyProviderErrorText, VideoGenerationProviderError } from './errors';
import { assetsByRole, type VideoGenerationMutation } from './mutations';

export const KLING_API_BASE_URL = 'https://api-singapore.klingai.com';
export const KLING_ARTIFACT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type KlingCredentials = {
  accessKey: string;
  secretKey: string;
};

export type KlingTaskRoute = 'text2video' | 'image2video';

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

export async function buildKlingCreateTaskRequest(
  mutation: VideoGenerationMutation,
): Promise<KlingCreateTaskRequest> {
  const startFrames = assetsByRole(mutation, 'start-frame');
  const endFrames = assetsByRole(mutation, 'end-frame');
  const referenceImages = assetsByRole(mutation, 'reference-image');
  const sourceVideos = assetsByRole(mutation, 'source-video');

  validateKlingMutation({ startFrames, endFrames, referenceImages, sourceVideos });

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
  const token = await createKlingJwt(credentials);
  return fetch(`${KLING_API_BASE_URL}${path}`, {
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

function validateKlingMutation({
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
  if (sourceVideos.length > 0) throw new Error('Kling video references are not enabled in this generator yet.');
  if (referenceImages.length > 0) throw new Error('Kling uses the start/end frame slots for image inputs.');
  for (const asset of [...startFrames, ...endFrames]) {
    if (asset.kind !== 'image') throw new Error(`${asset.name} must be an image input.`);
  }
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
