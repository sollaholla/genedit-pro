import { activeEditIteration } from '@/lib/media/editTrail';
import { getBlob } from '@/lib/media/storage';
import type { MediaAsset } from '@/types';

export const LITTERBOX_REFERENCE_TTL_MS = 24 * 60 * 60 * 1000;

const LITTERBOX_API_URL = 'https://litterbox.catbox.moe/resources/internals/api.php';
const LITTERBOX_TIME = '24h';
const CACHE_SAFETY_WINDOW_MS = 5 * 60 * 1000;

type HostedReference = {
  url: string;
  expiresAt: number;
};

const hostedReferenceCache = new Map<string, HostedReference>();

export async function hostLitterboxReference(asset: MediaAsset, label: string): Promise<string> {
  const blobKey = activeEditIteration(asset)?.blobKey ?? asset.blobKey;
  if (!blobKey) throw new Error(`${label} "${asset.name}" is missing local media data.`);

  const cacheKey = `${asset.id}:${blobKey}`;
  const cached = hostedReferenceCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.url;

  const blob = await getBlob(blobKey);
  if (!blob) throw new Error(`${label} "${asset.name}" is not available locally for temporary hosting.`);

  const file = new File([blob], safeReferenceFileName(asset), {
    type: blob.type || asset.mimeType || 'application/octet-stream',
  });
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
    throw new Error(`Litterbox temporary upload failed (${response.status}): ${text || response.statusText}`);
  }
  if (!isLitterboxUrl(text)) {
    throw new Error(`Litterbox temporary upload failed: ${text || 'No download URL returned.'}`);
  }

  hostedReferenceCache.set(cacheKey, {
    url: text,
    expiresAt: Date.now() + LITTERBOX_REFERENCE_TTL_MS - CACHE_SAFETY_WINDOW_MS,
  });
  return text;
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
