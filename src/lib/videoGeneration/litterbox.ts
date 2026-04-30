import { activeEditIteration } from '@/lib/media/editTrail';
import { getBlob } from '@/lib/media/storage';
import type { MediaAsset } from '@/types';

export const LITTERBOX_REFERENCE_TTL_MS = 24 * 60 * 60 * 1000;

const LITTERBOX_API_URL = 'https://litterbox.catbox.moe/resources/internals/api.php';
const LITTERBOX_TIME = '24h';
const CACHE_SAFETY_WINDOW_MS = 5 * 60 * 1000;
const LITTERBOX_UPLOAD_COOLDOWN_MS = 2000;
const MAX_ERROR_DETAIL_LENGTH = 180;

type HostedReference = {
  url: string;
  expiresAt: number;
};

const hostedReferenceCache = new Map<string, HostedReference>();
const inFlightReferenceUploads = new Map<string, Promise<string>>();
let uploadQueue: Promise<void> = Promise.resolve();

export async function hostLitterboxReference(asset: MediaAsset, label: string): Promise<string> {
  const blobKey = activeEditIteration(asset)?.blobKey ?? asset.blobKey;
  if (!blobKey) throw new Error(`${label} "${asset.name}" is missing local media data.`);

  const cacheKey = `${asset.id}:${blobKey}`;
  const cached = hostedReferenceCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.url;

  const blob = await getBlob(blobKey);
  if (!blob) throw new Error(`${label} "${asset.name}" is not available locally for temporary hosting.`);

  const latestCached = hostedReferenceCache.get(cacheKey);
  if (latestCached && latestCached.expiresAt > Date.now()) return latestCached.url;
  const pending = inFlightReferenceUploads.get(cacheKey);
  if (pending) return pending;

  const file = new File([blob], safeReferenceFileName(asset), {
    type: blob.type || asset.mimeType || 'application/octet-stream',
  });

  const upload = enqueueLitterboxUpload(file).then((url) => {
    hostedReferenceCache.set(cacheKey, {
      url,
      expiresAt: Date.now() + LITTERBOX_REFERENCE_TTL_MS - CACHE_SAFETY_WINDOW_MS,
    });
    return url;
  }).finally(() => {
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

function enqueueLitterboxUpload(file: File): Promise<string> {
  const upload = uploadQueue.then(() => uploadLitterboxFile(file));
  uploadQueue = upload
    .catch(() => undefined)
    .then(() => wait(LITTERBOX_UPLOAD_COOLDOWN_MS));
  return upload;
}

async function uploadLitterboxFile(file: File): Promise<string> {
  const form = new FormData();
  form.set('reqtype', 'fileupload');
  form.set('time', LITTERBOX_TIME);
  form.set('fileToUpload', file);

  const response = await fetch(LITTERBOX_API_URL, {
    method: 'POST',
    body: form,
  });
  const text = (await response.text().catch(() => '')).trim();
  if (!response.ok) {
    if (import.meta.env.DEV) {
      console.warn('[GenEdit] Litterbox temporary upload failed', {
        status: response.status,
        statusText: response.statusText,
        bodyPreview: compactResponseText(text, 500),
      });
    }
    throw new Error(formatHttpUploadError(response, text));
  }
  if (!isLitterboxUrl(text)) {
    throw new Error(`Litterbox temporary upload failed: ${compactResponseText(text) || 'No download URL returned.'}`);
  }

  return text;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeReferenceFileName(asset: MediaAsset): string {
  const name = asset.name.trim() || `${asset.kind}-reference`;
  const withExtension = /\.[a-z0-9]{2,8}$/i.test(name) ? name : `${name}.${extensionForMime(asset.mimeType)}`;
  const safe = withExtension
    .replace(/[^\w.-]+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '');
  return safe || `${asset.kind}-reference.${extensionForMime(asset.mimeType)}`;
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
