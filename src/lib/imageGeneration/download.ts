const GENERATED_IMAGE_DOWNLOAD_ATTEMPTS = 10;
const GENERATED_IMAGE_DOWNLOAD_RETRY_MS = 2500;
const MIN_GENERATED_IMAGE_BYTES = 512;

export async function downloadGeneratedImageFile(
  url: string,
  onProgress?: (progress: number) => void,
): Promise<File> {
  onProgress?.(96);
  const blob = await fetchGeneratedImageBlobWithRetries(url);
  onProgress?.(99);
  return generatedImageFileFromBlob(blob);
}

async function fetchGeneratedImageBlobWithRetries(url: string): Promise<Blob> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= GENERATED_IMAGE_DOWNLOAD_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) throw new Error(await responseErrorMessage(response, 'Failed downloading generated image'));
      const blob = await response.blob();
      if (blob.size < MIN_GENERATED_IMAGE_BYTES) throw new Error('Failed downloading generated image: received an empty image.');
      return blob;
    } catch (err) {
      lastError = err;
      if (attempt < GENERATED_IMAGE_DOWNLOAD_ATTEMPTS) await delay(GENERATED_IMAGE_DOWNLOAD_RETRY_MS);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Failed downloading generated image.');
}

function generatedImageFileFromBlob(blob: Blob): File {
  const extension = extensionForMime(blob.type);
  return new File([blob], `piapi_image_${Date.now()}.${extension}`, { type: blob.type || 'image/png' });
}

function extensionForMime(mimeType: string): string {
  if (mimeType === 'image/jpeg') return 'jpg';
  if (mimeType === 'image/webp') return 'webp';
  return 'png';
}

async function responseErrorMessage(response: Response, fallback: string): Promise<string> {
  const body = await response.text().catch(() => '');
  return body ? `${fallback} (${response.status}): ${body.slice(0, 300)}` : `${fallback} (${response.status}).`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
