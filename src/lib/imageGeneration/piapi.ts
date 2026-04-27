import type { ImageModelDefinition } from '@/lib/imageModels/capabilities';
import { GPT_IMAGE_1_5_MODEL_ID, GPT_IMAGE_2_PREVIEW_MODEL_ID } from '@/lib/imageModels/capabilities';
import type { MediaAsset } from '@/types';
import { classifyProviderErrorText, VideoGenerationProviderError } from '@/lib/videoGeneration/errors';

export const PIAPI_IMAGE_ARTIFACT_TTL_MS = 48 * 60 * 60 * 1000;
const PIAPI_API_BASE_URL = 'https://api.piapi.ai';

type PiApiCredentials = {
  apiKey: string;
};

export type ImageGenerationRequest = {
  model: ImageModelDefinition;
  prompt: string;
  aspectRatio: string;
  resolution: string;
  outputFormat?: string;
  referenceUrls?: string[];
  referenceFiles?: File[];
  onTaskAccepted?: (task: PiApiImageTaskData) => void;
  onProgress?: (progress: number) => void;
};

export type GeneratedPiApiImage = {
  url: string;
  provider: string;
  providerTaskId?: string;
  providerTaskEndpoint?: string;
  providerTaskStatus?: string;
  providerArtifactExpiresAt: number;
};

export type PiApiImageTaskData = {
  task_id?: string;
  status?: string;
  output?: Record<string, unknown> | null;
  task_result?: {
    task_output?: {
      image_url?: string;
      image_urls?: string[];
      image_base64?: string;
    };
    error_messages?: string[];
  } | null;
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

type GptImageResponse = {
  data?: Array<{
    url?: string;
    b64_json?: string;
  }>;
  error?: {
    message?: string;
    type?: string;
  };
};

export function isGptImageModel(model: ImageModelDefinition): boolean {
  return model.id === GPT_IMAGE_1_5_MODEL_ID || model.id === GPT_IMAGE_2_PREVIEW_MODEL_ID || model.provider === 'piapi-gpt-image';
}

export async function generatePiApiImage(
  request: ImageGenerationRequest,
  credentials: PiApiCredentials,
): Promise<GeneratedPiApiImage> {
  request.onProgress?.(3);
  if (isGptImageModel(request.model)) return generateGptImage(request, credentials);
  return generateGeminiImage(request, credentials);
}

export async function createPiApiImageGenerationTask(
  request: ImageGenerationRequest,
  credentials: PiApiCredentials,
): Promise<PiApiImageTaskData> {
  if (isGptImageModel(request.model)) {
    throw new VideoGenerationProviderError('InternalError', 'This image model uses a synchronous PiAPI endpoint and cannot be resumed as a background task.');
  }
  request.onProgress?.(5);
  const initialTask = await createPiApiImageTask(geminiImageTaskBody(request), credentials);
  if (!initialTask.task_id) throw new VideoGenerationProviderError('InternalError', 'PiAPI did not return an image task id.');
  request.onTaskAccepted?.(initialTask);
  request.onProgress?.(10);
  return initialTask;
}

export async function getPiApiImageTask(taskId: string, credentials: PiApiCredentials): Promise<PiApiImageTaskData> {
  const response = await piApiFetch(`/api/v1/task/${encodeURIComponent(taskId)}`, credentials, { method: 'GET' });
  return readPiApiTaskResponse(response, 'PiAPI image generation poll failed');
}

export function generatedPiApiImageFromTask(task: PiApiImageTaskData): { url?: string } {
  const nestedOutputUrl = imageUrlFromUnknown(task.output);
  if (nestedOutputUrl) return { url: nestedOutputUrl };

  const output = task.output ?? {};
  const outputUrl = firstString([output.image_url, output.url, output.download_url]);
  if (outputUrl) return { url: outputUrl };
  const outputUrls = Array.isArray(output.image_urls) ? output.image_urls : [];
  const arrayUrl = firstString(outputUrls);
  if (arrayUrl) return { url: arrayUrl };

  const taskOutput = task.task_result?.task_output;
  if (!taskOutput) return {};
  const nestedTaskUrl = imageUrlFromUnknown(taskOutput);
  if (nestedTaskUrl) return { url: nestedTaskUrl };
  const taskUrl = firstString([taskOutput.image_url, ...(taskOutput.image_urls ?? [])]);
  if (taskUrl) return { url: taskUrl };
  if (taskOutput.image_base64) return { url: dataUrlFromBase64(taskOutput.image_base64) };
  return {};
}

async function generateGptImage(
  request: ImageGenerationRequest,
  credentials: PiApiCredentials,
): Promise<GeneratedPiApiImage> {
  request.onProgress?.(8);
  const endpoint = request.referenceFiles?.length ? '/v1/images/edits' : '/v1/images/generations';
  const response = request.referenceFiles?.length
    ? await createGptImageEdit(request, credentials, endpoint)
    : await createGptImageGeneration(request, credentials, endpoint);
  request.onProgress?.(90);
  const imageUrl = gptImageUrlFromResponse(response);
  if (!imageUrl) throw new VideoGenerationProviderError('InternalError', 'PiAPI GPT image did not return an image URL.');
  return {
    url: imageUrl,
    provider: 'piapi-gpt-image',
    providerTaskStatus: 'completed',
    providerArtifactExpiresAt: Date.now() + PIAPI_IMAGE_ARTIFACT_TTL_MS,
  };
}

async function createGptImageGeneration(
  request: ImageGenerationRequest,
  credentials: PiApiCredentials,
  endpoint: string,
): Promise<GptImageResponse> {
  const response = await fetch(`${PIAPI_API_BASE_URL}${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${credentials.apiKey}`,
    },
    body: JSON.stringify({
      model: request.model.id,
      prompt: request.prompt,
      n: 1,
      size: request.resolution,
      quality: 'low',
      response_format: 'url',
      output_format: request.outputFormat ?? request.model.capabilities.defaultOutputFormat,
    }),
  });
  return readGptImageResponse(response, 'PiAPI GPT image request failed');
}

async function createGptImageEdit(
  request: ImageGenerationRequest,
  credentials: PiApiCredentials,
  endpoint: string,
): Promise<GptImageResponse> {
  const form = new FormData();
  form.set('model', request.model.id);
  form.set('prompt', request.prompt);
  form.set('n', '1');
  form.set('size', request.resolution);
  form.set('response_format', 'url');
  form.set('output_format', request.outputFormat ?? request.model.capabilities.defaultOutputFormat);
  for (const file of request.referenceFiles ?? []) form.append('image', file, file.name || 'reference.png');

  const response = await fetch(`${PIAPI_API_BASE_URL}${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${credentials.apiKey}`,
    },
    body: form,
  });
  return readGptImageResponse(response, 'PiAPI GPT image edit failed');
}

async function generateGeminiImage(
  request: ImageGenerationRequest,
  credentials: PiApiCredentials,
): Promise<GeneratedPiApiImage> {
  const initialTask = await createPiApiImageGenerationTask(request, credentials);
  const finalTask = await pollPiApiImageTask({ credentials, initialTask, onProgress: request.onProgress });
  const image = generatedPiApiImageFromTask(finalTask);
  if (!image.url) throw new VideoGenerationProviderError('InternalError', 'No generated image URL returned by PiAPI.');
  return {
    url: image.url,
    provider: 'piapi-gemini',
    providerTaskId: finalTask.task_id ?? initialTask.task_id,
    providerTaskEndpoint: `/api/v1/task/${finalTask.task_id ?? initialTask.task_id}`,
    providerTaskStatus: finalTask.status,
    providerArtifactExpiresAt: Date.now() + PIAPI_IMAGE_ARTIFACT_TTL_MS,
  };
}

function geminiImageTaskBody(request: ImageGenerationRequest): Record<string, unknown> {
  return {
    model: 'gemini',
    task_type: request.model.id,
    input: {
      prompt: request.prompt,
      image_urls: request.referenceUrls ?? [],
      output_format: request.outputFormat ?? request.model.capabilities.defaultOutputFormat,
      aspect_ratio: request.aspectRatio,
      resolution: request.resolution,
      safety_level: 'high',
    },
    config: {
      service_mode: 'public',
    },
  };
}

async function createPiApiImageTask(body: Record<string, unknown>, credentials: PiApiCredentials): Promise<PiApiImageTaskData> {
  const response = await piApiFetch('/api/v1/task', credentials, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return readPiApiTaskResponse(response, 'PiAPI image generation request failed');
}

async function pollPiApiImageTask({
  credentials,
  initialTask,
  onProgress,
}: {
  credentials: PiApiCredentials;
  initialTask: PiApiImageTaskData;
  onProgress?: (progress: number) => void;
}): Promise<PiApiImageTaskData> {
  const taskId = initialTask.task_id;
  if (!taskId) throw new VideoGenerationProviderError('InternalError', 'PiAPI did not return an image task id.');
  let task = initialTask;
  let progress = 10;
  onProgress?.(progress);
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const status = normalizeStatus(task.status);
    if (isFailedStatus(status)) throw piApiTaskFailure(task, 'PiAPI image generation failed');
    if (isCompletedStatus(status) && generatedPiApiImageFromTask(task).url) return task;
    await new Promise((resolve) => setTimeout(resolve, 3000));
    task = await getPiApiImageTask(taskId, credentials);
    progress = Math.min(95, progress + 5);
    onProgress?.(progress);
  }
  throw new VideoGenerationProviderError('InternalError', 'PiAPI image generation timed out before returning an image.');
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

async function readPiApiTaskResponse(response: Response, fallback: string): Promise<PiApiImageTaskData> {
  const text = await response.text().catch(() => '');
  let parsed: PiApiEnvelope<PiApiImageTaskData> | null = null;
  if (text) {
    try {
      parsed = JSON.parse(text) as PiApiEnvelope<PiApiImageTaskData>;
    } catch {
      // Use the raw body below.
    }
  }
  const envelopeOk = parsed?.code === undefined || parsed.code === 0 || parsed.code === 200;
  const taskData = parsed?.data;
  if (taskData && (isFailedStatus(normalizeStatus(taskData.status)) || hasPiApiTaskError(taskData))) {
    throw piApiTaskFailure(taskData, fallback, response.status, parsed?.code);
  }
  if (!response.ok || !envelopeOk) {
    const message = piApiErrorMessage(taskData, parsed?.message || text || `${fallback} (${response.status}).`);
    throw new VideoGenerationProviderError(classifyProviderErrorText(message), `${fallback} (${response.status}): ${message}`);
  }
  if (!parsed?.data) throw new VideoGenerationProviderError('InternalError', `${fallback}: PiAPI returned no task data.`);
  return parsed.data;
}

async function readGptImageResponse(response: Response, fallback: string): Promise<GptImageResponse> {
  const text = await response.text().catch(() => '');
  let parsed: GptImageResponse | null = null;
  if (text) {
    try {
      parsed = JSON.parse(text) as GptImageResponse;
    } catch {
      // Use raw body below.
    }
  }
  if (!response.ok || parsed?.error) {
    const message = parsed?.error?.message || text || `${fallback} (${response.status}).`;
    throw new VideoGenerationProviderError(classifyProviderErrorText(message), `${fallback} (${response.status}): ${message}`);
  }
  if (!parsed) throw new VideoGenerationProviderError('InternalError', `${fallback}: empty response.`);
  return parsed;
}

function gptImageUrlFromResponse(response: GptImageResponse): string | null {
  const first = response.data?.[0];
  if (first?.url?.trim()) return first.url.trim();
  if (first?.b64_json) return dataUrlFromBase64(first.b64_json);
  return null;
}

function piApiTaskFailure(
  task: PiApiImageTaskData,
  fallback: string,
  status?: number,
  envelopeCode?: number,
): VideoGenerationProviderError {
  const message = piApiErrorMessage(task, fallback);
  const prefix = status ? `${fallback} (${status}${envelopeCode !== undefined ? `/${envelopeCode}` : ''})` : fallback;
  return new VideoGenerationProviderError(classifyProviderErrorText(message), `${prefix}: ${message}`);
}

function hasPiApiTaskError(task: PiApiImageTaskData): boolean {
  const code = typeof task.error?.code === 'string' ? Number(task.error.code) : task.error?.code;
  return Boolean(
    (Number.isFinite(code) && code !== 0) ||
    task.error?.message ||
    task.error?.raw_message ||
    task.error?.detail ||
    task.task_result?.error_messages?.length,
  );
}

function piApiErrorMessage(task: PiApiImageTaskData | undefined, fallback: string): string {
  if (!task) return fallback;
  const rawMessage = task.error?.raw_message?.trim();
  const message = task.error?.message?.trim();
  const detail = typeof task.error?.detail === 'string' ? task.error.detail.trim() : '';
  const taskResultMessages = task.task_result?.error_messages ?? [];
  const parts = [message, rawMessage, detail, ...taskResultMessages]
    .filter((part): part is string => Boolean(part))
    .filter((part, index, all) => all.findIndex((candidate) => candidate.toLowerCase() === part.toLowerCase()) === index);
  return parts.join(': ') || fallback;
}

function firstString(values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function imageUrlFromUnknown(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return /^(?:https?:\/\/|data:image\/)/i.test(trimmed) ? trimmed : null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const url = imageUrlFromUnknown(item);
      if (url) return url;
    }
    return null;
  }
  if (!isObject(value)) return null;
  const preferredKeys = ['image_url', 'image_urls', 'images', 'url', 'urls', 'download_url', 'output_url', 'result_url'];
  for (const key of preferredKeys) {
    const url = imageUrlFromUnknown(value[key]);
    if (url) return url;
  }
  for (const nested of Object.values(value)) {
    const url = imageUrlFromUnknown(nested);
    if (url) return url;
  }
  return null;
}

function dataUrlFromBase64(value: string): string {
  return value.startsWith('data:') ? value : `data:image/png;base64,${value}`;
}

function normalizeStatus(status: string | undefined): string {
  return (status ?? '').trim().toLowerCase();
}

function isCompletedStatus(status: string): boolean {
  return status === 'completed' || status === 'succeed' || status === 'succeeded' || status === 'success' || status === 'finished';
}

function isFailedStatus(status: string): boolean {
  return status === 'failed' || status === 'failure' || status === 'fail' || status === 'error' || status === 'cancelled' || status === 'canceled';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function activeCharacterReferenceFile(asset: MediaAsset, blob: Blob | null): File | null {
  if (!blob) return null;
  const extension = blob.type === 'image/jpeg' ? 'jpg' : blob.type === 'image/webp' ? 'webp' : 'png';
  return new File([blob], `${asset.character?.characterId ?? asset.id}.${extension}`, { type: blob.type || asset.mimeType || 'image/png' });
}
