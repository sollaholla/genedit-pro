import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';

const CORE_VERSION = '0.12.9';
const CORE_CDN_CANDIDATES = [
  {
    label: 'unpkg',
    baseURL: `https://unpkg.com/@ffmpeg/core@${CORE_VERSION}/dist/esm`,
  },
  {
    label: 'jsDelivr',
    baseURL: `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${CORE_VERSION}/dist/esm`,
  },
] as const;

let instance: FFmpeg | null = null;
let loadingPromise: Promise<FFmpeg> | null = null;

export type LoadProgress = (msg: string) => void;

export async function getFFmpeg(onLog?: LoadProgress): Promise<FFmpeg> {
  if (instance) return instance;
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    const errors: string[] = [];

    for (const candidate of CORE_CDN_CANDIDATES) {
      const ffmpeg = new FFmpeg();
      if (onLog) {
        onLog(`Loading encoder core from ${candidate.label}...`);
        ffmpeg.on('log', ({ message }) => onLog(message));
      }

      try {
        await ffmpeg.load({
          coreURL: await toBlobURL(`${candidate.baseURL}/ffmpeg-core.js`, 'text/javascript'),
          wasmURL: await toBlobURL(`${candidate.baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
        });
        instance = ffmpeg;
        return ffmpeg;
      } catch (error) {
        ffmpeg.terminate();
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${candidate.label}: ${message}`);
      }
    }

    throw new Error(`Failed to load FFmpeg encoder core. ${errors.join(' | ')}`);
  })();

  try {
    return await loadingPromise;
  } catch (error) {
    loadingPromise = null;
    throw error;
  }
}

export function resetFFmpeg(): void {
  instance?.terminate();
  instance = null;
  loadingPromise = null;
}
