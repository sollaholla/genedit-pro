const GENERATED_VIDEO_DOWNLOAD_ATTEMPTS = 18;
const GENERATED_VIDEO_DOWNLOAD_RETRY_MS = 5000;
const GENERATED_VIDEO_CORS_RELAY_ATTEMPTS = 18;
const MIN_GENERATED_VIDEO_BYTES = 1024;

export async function downloadGeneratedVideoFile(
  url: string,
  onProgress?: (progress: number) => void,
): Promise<File> {
  onProgress?.(96);
  try {
    const blob = await fetchGeneratedVideoBlobWithRetries(url, {
      attempts: GENERATED_VIDEO_DOWNLOAD_ATTEMPTS,
      delayMs: GENERATED_VIDEO_DOWNLOAD_RETRY_MS,
      label: 'PiAPI video',
      useCorsRelayAfterNetworkFailures: true,
    });
    onProgress?.(99);
    return generatedVideoFileFromBlob(blob);
  } catch (directError) {
    if (!shouldUseCorsRelay(url, directError)) throw directError;
  }

  onProgress?.(97);
  const relayUrl = `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(url)}`;
  const blob = await fetchGeneratedVideoBlobWithRetries(relayUrl, {
    attempts: GENERATED_VIDEO_CORS_RELAY_ATTEMPTS,
    delayMs: GENERATED_VIDEO_DOWNLOAD_RETRY_MS,
    label: 'PiAPI video through CORS relay',
  });
  onProgress?.(99);
  return generatedVideoFileFromBlob(blob);
}

async function fetchGeneratedVideoBlobWithRetries(
  url: string,
  {
    attempts,
    delayMs,
    label,
    useCorsRelayAfterNetworkFailures = false,
  }: {
    attempts: number;
    delayMs: number;
    label: string;
    useCorsRelayAfterNetworkFailures?: boolean;
  },
): Promise<Blob> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) throw new Error(await responseErrorMessage(response, `Failed downloading ${label}`));
      const blob = await response.blob();
      if (blob.size < MIN_GENERATED_VIDEO_BYTES) {
        throw new Error(`Failed downloading ${label}: received an empty or incomplete video.`);
      }
      return blob;
    } catch (err) {
      lastError = err;
      if (useCorsRelayAfterNetworkFailures && shouldUseCorsRelay(url, err) && attempt >= 2) throw err;
      if (attempt < attempts) await delay(delayMs);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Failed downloading ${label}.`);
}

function shouldUseCorsRelay(url: string, err: unknown): boolean {
  if (!/^https:\/\/(?:storage|img)\.theapi\.app\//i.test(url)) return false;
  if (!(err instanceof TypeError)) return false;
  return true;
}

function generatedVideoFileFromBlob(blob: Blob): File {
  return new File([blob], `piapi_${Date.now()}.mp4`, { type: blob.type || 'video/mp4' });
}

async function responseErrorMessage(response: Response, fallback: string): Promise<string> {
  const body = await response.text().catch(() => '');
  return body ? `${fallback} (${response.status}): ${body.slice(0, 300)}` : `${fallback} (${response.status}).`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
