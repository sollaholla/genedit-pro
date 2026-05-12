import { getFFmpeg, resetFFmpeg } from '@/lib/ffmpeg/client';
import { activeEditIteration } from '@/lib/media/editTrail';
import { getBlob } from '@/lib/media/storage';
import type { MediaAsset } from '@/types';

export const LITTERBOX_REFERENCE_TTL_MS = 24 * 60 * 60 * 1000;

const LITTERBOX_API_URL = 'https://litterbox.catbox.moe/resources/internals/api.php';
const LITTERBOX_TIME = '24h';
const CACHE_SAFETY_WINDOW_MS = 5 * 60 * 1000;
const LITTERBOX_UPLOAD_COOLDOWN_MS = 2000;
const LITTERBOX_UPLOAD_MAX_ATTEMPTS = 4;
const LITTERBOX_UPLOAD_RETRY_BASE_MS = 1500;
const LITTERBOX_UPLOAD_RETRY_MAX_MS = 12_000;
const LITTERBOX_UPLOAD_TIMEOUT_MS = 180_000;
const MAX_ERROR_DETAIL_LENGTH = 180;
const RETRYABLE_UPLOAD_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524]);

type HostedReference = {
  url: string;
  expiresAt: number;
};

export type HostLitterboxReferenceOptions = {
  forceMp4Video?: boolean;
  maxVideoPixels?: number;
  onStatus?: (status: HostLitterboxReferenceStatus) => void;
};

export type HostLitterboxReferenceStatus =
  | { stage: 'converting'; name: string }
  | { stage: 'converted'; name: string; sizeBytes: number }
  | { stage: 'uploading'; name: string; sizeBytes: number }
  | { stage: 'uploaded'; name: string; url: string };

const hostedReferenceCache = new Map<string, HostedReference>();
const inFlightReferenceUploads = new Map<string, Promise<string>>();
let uploadQueue: Promise<void> = Promise.resolve();
let referenceFfmpegQueue: Promise<unknown> = Promise.resolve();

export async function hostLitterboxReference(
  asset: MediaAsset,
  label: string,
  options: HostLitterboxReferenceOptions = {},
): Promise<string> {
  const blobKey = activeEditIteration(asset)?.blobKey ?? asset.blobKey;
  if (!blobKey) throw new Error(`${label} "${asset.name}" is missing local media data.`);

  const forceMp4Video = Boolean(options.forceMp4Video && asset.kind === 'video');
  const cacheKey = [
    asset.id,
    blobKey,
    forceMp4Video ? 'video-mp4-v2' : 'original',
    forceMp4Video && options.maxVideoPixels ? `max-pixels-${options.maxVideoPixels}` : null,
  ].filter(Boolean).join(':');
  const cached = hostedReferenceCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.url;

  const blob = await getBlob(blobKey);
  if (!blob) throw new Error(`${label} "${asset.name}" is not available locally for temporary hosting.`);

  const latestCached = hostedReferenceCache.get(cacheKey);
  if (latestCached && latestCached.expiresAt > Date.now()) return latestCached.url;
  const pending = inFlightReferenceUploads.get(cacheKey);
  if (pending) return pending;

  const upload = (async () => {
    const file = forceMp4Video
      ? await mp4VideoReferenceFile(asset, blob, label, options)
      : new File([blob], safeReferenceFileName(asset), {
        type: blob.type || asset.mimeType || 'application/octet-stream',
      });
    options.onStatus?.({ stage: 'uploading', name: file.name, sizeBytes: file.size });
    if (import.meta.env.DEV) {
      console.debug('[GenEdit] Uploading Litterbox reference', {
        label,
        name: file.name,
        type: file.type,
        sizeBytes: file.size,
      });
    }
    const url = await enqueueLitterboxUpload(file);
    options.onStatus?.({ stage: 'uploaded', name: file.name, url });
    if (import.meta.env.DEV) {
      console.debug('[GenEdit] Uploaded Litterbox reference', {
        label,
        name: file.name,
        url,
      });
    }
    hostedReferenceCache.set(cacheKey, {
      url,
      expiresAt: Date.now() + LITTERBOX_REFERENCE_TTL_MS - CACHE_SAFETY_WINDOW_MS,
    });
    return url;
  })().finally(() => {
    inFlightReferenceUploads.delete(cacheKey);
  });
  inFlightReferenceUploads.set(cacheKey, upload);
  return upload;
}

export async function hostLitterboxReferences(assets: MediaAsset[], label: string): Promise<string[]> {
  const urls: string[] = [];
  for (const asset of assets) urls.push(await hostLitterboxReference(asset, label));
  return urls;
}

export async function hostLitterboxFile(file: File): Promise<string> {
  return enqueueLitterboxUpload(file);
}

function enqueueLitterboxUpload(file: File): Promise<string> {
  const upload = uploadQueue.then(() => uploadLitterboxFile(file));
  uploadQueue = upload
    .catch(() => undefined)
    .then(() => wait(LITTERBOX_UPLOAD_COOLDOWN_MS));
  return upload;
}

async function uploadLitterboxFile(file: File): Promise<string> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= LITTERBOX_UPLOAD_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await uploadLitterboxFileOnce(file);
    } catch (err) {
      const error = err instanceof LitterboxUploadError ? err : new LitterboxUploadError(err instanceof Error ? err.message : 'Litterbox temporary upload failed.', true);
      lastError = error;
      const shouldRetry = error.retryable && attempt < LITTERBOX_UPLOAD_MAX_ATTEMPTS;
      if (!shouldRetry) break;
      const delayMs = retryDelayMs(attempt);
      if (import.meta.env.DEV) {
        console.warn('[GenEdit] Retrying Litterbox temporary upload', {
          attempt,
          nextAttempt: attempt + 1,
          delayMs,
          error: error.message,
        });
      }
      await wait(delayMs);
    }
  }
  throw lastError ?? new Error('Litterbox temporary upload failed.');
}

async function uploadLitterboxFileOnce(file: File): Promise<string> {
  const form = new FormData();
  form.set('reqtype', 'fileupload');
  form.set('time', LITTERBOX_TIME);
  form.set('fileToUpload', file);

  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), LITTERBOX_UPLOAD_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(LITTERBOX_API_URL, {
      method: 'POST',
      body: form,
      signal: abortController.signal,
    });
  } catch (error) {
    const isAbort = error instanceof DOMException && error.name === 'AbortError';
    throw new LitterboxUploadError(
      isAbort
        ? 'Litterbox temporary upload timed out before returning a URL.'
        : error instanceof Error ? error.message : 'Litterbox temporary upload failed.',
      true,
    );
  } finally {
    clearTimeout(timeout);
  }
  const text = (await response.text().catch(() => '')).trim();
  if (!response.ok) {
    if (import.meta.env.DEV) {
      console.warn('[GenEdit] Litterbox temporary upload failed', {
        status: response.status,
        statusText: response.statusText,
        bodyPreview: compactResponseText(text, 500),
      });
    }
    throw new LitterboxUploadError(formatHttpUploadError(response, text), isRetryableHttpUploadFailure(response, text));
  }
  if (!isLitterboxUrl(text)) {
    throw new LitterboxUploadError(
      `Litterbox temporary upload failed: ${compactResponseText(text) || 'No download URL returned.'}`,
      looksLikeHtml(text),
    );
  }

  return text;
}

class LitterboxUploadError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = 'LitterboxUploadError';
  }
}

function isRetryableHttpUploadFailure(response: Response, text: string): boolean {
  return RETRYABLE_UPLOAD_STATUSES.has(response.status) || looksLikeHtml(text);
}

function retryDelayMs(attempt: number): number {
  const exponentialDelay = LITTERBOX_UPLOAD_RETRY_BASE_MS * (2 ** (attempt - 1));
  const jitter = Math.floor(Math.random() * 500);
  return Math.min(LITTERBOX_UPLOAD_RETRY_MAX_MS, exponentialDelay + jitter);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mp4VideoReferenceFile(
  asset: MediaAsset,
  blob: Blob,
  label: string,
  options: HostLitterboxReferenceOptions,
): Promise<File> {
  const outputName = safeReferenceFileName(asset, 'mp4');
  if (!shouldTranscodeVideoReference(asset, blob, options)) {
    return new File([blob], outputName, { type: 'video/mp4' });
  }

  options.onStatus?.({ stage: 'converting', name: asset.name });
  const file = await transcodeVideoReferenceToMp4(asset, blob, label, outputName, options.maxVideoPixels);
  options.onStatus?.({ stage: 'converted', name: file.name, sizeBytes: file.size });
  return file;
}

function transcodeVideoReferenceToMp4(
  asset: MediaAsset,
  blob: Blob,
  label: string,
  outputName: string,
  maxVideoPixels?: number,
): Promise<File> {
  return runReferenceFfmpegJob(async () => {
    const ffmpeg = await getFFmpeg();
    const inputFile = `reference-input-${asset.id}-${Date.now()}.${sourceVideoExtension(asset, blob)}`;
    const outputFile = `reference-output-${asset.id}-${Date.now()}.mp4`;
    let resetEncoder = false;
    try {
      await ffmpeg.writeFile(inputFile, new Uint8Array(await blob.arrayBuffer()));
      const args = [
        '-hide_banner',
        '-i', inputFile,
        '-map', '0:v:0',
        '-map', '0:a?',
      ];
      const scaleFilter = videoReferenceScaleFilter(asset, maxVideoPixels);
      if (scaleFilter) args.push('-vf', scaleFilter);
      args.push(
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-movflags', '+faststart',
        '-y',
        outputFile,
      );
      const code = await ffmpeg.exec(args);
      if (code !== 0) throw new Error(`Could not convert ${label} "${asset.name}" to an MP4 reference.`);
      const data = (await ffmpeg.readFile(outputFile)) as Uint8Array;
      return new File([data.slice()], outputName, { type: 'video/mp4' });
    } catch (error) {
      resetEncoder = isFfmpegMemoryError(error);
      throw error;
    } finally {
      await ffmpeg.deleteFile(inputFile).catch(() => undefined);
      await ffmpeg.deleteFile(outputFile).catch(() => undefined);
      if (resetEncoder) resetFFmpeg();
    }
  });
}

function runReferenceFfmpegJob<T>(job: () => Promise<T>): Promise<T> {
  const run = referenceFfmpegQueue.catch(() => undefined).then(job);
  referenceFfmpegQueue = run.catch(() => undefined);
  return run;
}

function safeReferenceFileName(asset: MediaAsset, forcedExtension?: string): string {
  const name = asset.name.trim() || `${asset.kind}-reference`;
  const baseName = forcedExtension ? name.replace(/\.[a-z0-9]{2,8}$/i, '') : name;
  const withExtension = forcedExtension
    ? `${baseName}.${forcedExtension}`
    : /\.[a-z0-9]{2,8}$/i.test(name) ? name : `${name}.${extensionForMime(asset.mimeType)}`;
  const safe = withExtension
    .replace(/[^\w.-]+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '');
  return safe || `${asset.kind}-reference.${forcedExtension ?? extensionForMime(asset.mimeType)}`;
}

function extensionForMime(mimeType: string): string {
  if (/png/i.test(mimeType)) return 'png';
  if (/jpe?g/i.test(mimeType)) return 'jpg';
  if (/webp/i.test(mimeType)) return 'webp';
  if (/gif/i.test(mimeType)) return 'gif';
  if (/quicktime|mov/i.test(mimeType)) return 'mov';
  if (/webm/i.test(mimeType)) return 'webm';
  if (/mp4|mpeg4/i.test(mimeType)) return 'mp4';
  return 'bin';
}

function sourceVideoExtension(asset: MediaAsset, blob: Blob): string {
  const extension = fileExtension(asset.name);
  if (extension) return extension;
  const mimeExtension = extensionForMime(blob.type || asset.mimeType || '');
  return mimeExtension === 'bin' ? 'mp4' : mimeExtension;
}

function isMp4VideoReference(asset: MediaAsset, blob: Blob): boolean {
  const extension = fileExtension(asset.name);
  if (extension) return extension === 'mp4';
  const mimeType = blob.type || asset.mimeType || '';
  if (/mp4|mpeg4/i.test(mimeType)) return true;
  if (/quicktime|mov|webm/i.test(mimeType)) return false;
  return false;
}

function shouldTranscodeVideoReference(asset: MediaAsset, blob: Blob, options: HostLitterboxReferenceOptions): boolean {
  if (!isMp4VideoReference(asset, blob)) return true;
  if (!options.maxVideoPixels) return false;
  const dimensions = videoReferenceDimensions(asset);
  if (!dimensions) return true;
  return dimensions.width * dimensions.height > options.maxVideoPixels;
}

function videoReferenceScaleFilter(asset: MediaAsset, maxVideoPixels?: number): string | null {
  if (!maxVideoPixels) return null;
  const dimensions = videoReferenceDimensions(asset);
  if (dimensions && dimensions.width * dimensions.height <= maxVideoPixels) return null;
  const box = videoReferenceBoundingBox(dimensions, maxVideoPixels);
  return `scale=w=${box.width}:h=${box.height}:force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1`;
}

function videoReferenceBoundingBox(
  dimensions: { width: number; height: number } | null,
  maxVideoPixels: number,
): { width: number; height: number } {
  const maxLongEdge = 1920;
  if (!dimensions) return { width: maxLongEdge, height: 1080 };
  const aspectRatio = dimensions.width / dimensions.height;
  if (!Number.isFinite(aspectRatio) || aspectRatio <= 0) return { width: maxLongEdge, height: 1080 };

  if (aspectRatio >= 1) {
    const maxWidthByPixels = Math.floor(Math.sqrt(maxVideoPixels * aspectRatio));
    const width = even(Math.min(dimensions.width, maxLongEdge, maxWidthByPixels));
    const height = even(Math.max(2, Math.floor(width / aspectRatio)));
    return { width, height };
  }

  const maxHeightByPixels = Math.floor(Math.sqrt(maxVideoPixels / aspectRatio));
  const height = even(Math.min(dimensions.height, maxLongEdge, maxHeightByPixels));
  const width = even(Math.max(2, Math.floor(height * aspectRatio)));
  return { width, height };
}

function videoReferenceDimensions(asset: MediaAsset): { width: number; height: number } | null {
  const iteration = activeEditIteration(asset);
  const width = iteration?.width ?? asset.width;
  const height = iteration?.height ?? asset.height;
  if (!width || !height || width <= 0 || height <= 0) return null;
  return { width, height };
}

function even(value: number): number {
  return Math.max(2, Math.floor(value / 2) * 2);
}

function fileExtension(name: string): string | null {
  const match = /\.([a-z0-9]{2,8})$/i.exec(name.trim());
  return match ? match[1]!.toLowerCase() : null;
}

function isFfmpegMemoryError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /memory access out of bounds|out of memory|Cannot enlarge memory/i.test(message);
}

function isLitterboxUrl(value: string): boolean {
  return /^https:\/\/litter\.catbox\.moe\/[a-z0-9_.-]+$/i.test(value);
}

function formatHttpUploadError(response: Response, text: string): string {
  const statusLabel = [response.status, response.statusText].filter(Boolean).join(' ');
  if (response.status === 429) {
    return `Litterbox temporary upload is rate limited (${statusLabel}). Try again in a few minutes.`;
  }

  const detail = compactResponseText(text) || 'No error details returned.';
  return `Litterbox temporary upload failed (${statusLabel}): ${detail}`;
}

function compactResponseText(text: string, maxLength = MAX_ERROR_DETAIL_LENGTH): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  if (looksLikeHtml(normalized)) return 'The upload service returned an HTML error page instead of a URL.';

  const withoutTags = normalized.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const detail = withoutTags || normalized;
  if (detail.length <= maxLength) return detail;
  return `${detail.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function looksLikeHtml(value: string): boolean {
  return /^<!doctype html\b/i.test(value) || /^<html\b/i.test(value) || /<(?:head|body|meta|style|script)\b/i.test(value);
}
