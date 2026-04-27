import { useEffect } from 'react';
import {
  PIAPI_API_KEY_STORAGE,
  PIAPI_KLING_API_KEY_STORAGE,
  PIAPI_VEO_API_KEY_STORAGE,
} from '@/lib/settings/connectionStorage';
import { decryptSecret } from '@/lib/settings/crypto';
import { useMediaStore } from '@/state/mediaStore';
import type { MediaAsset } from '@/types';
import { downloadGeneratedVideoFile } from './download';
import { downloadGeneratedImageFile } from '@/lib/imageGeneration/download';
import { generatedPiApiImageFromTask, getPiApiImageTask, PIAPI_IMAGE_ARTIFACT_TTL_MS } from '@/lib/imageGeneration/piapi';
import {
  generatedPiApiVideoFromTask,
  getPiApiVideoTask,
  PIAPI_ARTIFACT_TTL_MS,
} from './piapi';
import { VideoGenerationProviderError } from './errors';

const RESUME_POLL_MS = 15000;

export function usePiApiGenerationResume() {
  useEffect(() => {
    let cancelled = false;
    const inFlight = new Set<string>();

    const tick = async () => {
      const apiKey = await readPiApiKey();
      if (!apiKey || cancelled) return;

      const assets = useMediaStore.getState().assets;
      for (const asset of assets) {
        if ((!isResumablePiApiGeneration(asset) && !isResumablePiApiImageGeneration(asset)) || inFlight.has(asset.id)) continue;
        inFlight.add(asset.id);
        const resume = isResumablePiApiImageGeneration(asset) ? resumePiApiImageGeneration : resumePiApiGeneration;
        void resume(asset, apiKey)
          .catch((error) => {
            if (error instanceof VideoGenerationProviderError) {
              useMediaStore.getState().failGeneratedAsset(asset.id, {
                actualCostUsd: asset.generation?.actualCostUsd,
                errorMessage: formatProviderError(error),
                errorType: error.type,
              });
            } else {
              console.warn('PiAPI generation resume skipped:', error);
            }
          })
          .finally(() => inFlight.delete(asset.id));
      }
    };

    void tick();
    const intervalId = window.setInterval(() => void tick(), RESUME_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, []);
}

async function resumePiApiImageGeneration(asset: MediaAsset, apiKey: string): Promise<void> {
  const generation = asset.generation;
  const taskId = generation?.providerTaskId;
  if (!taskId) return;

  const task = await getPiApiImageTask(taskId, { apiKey });
  const store = useMediaStore.getState();
  store.updateGenerationTask(asset.id, {
    provider: 'piapi-gemini',
    providerTaskId: task.task_id ?? taskId,
    providerTaskEndpoint: `/api/v1/task/${task.task_id ?? taskId}`,
    providerTaskStatus: task.status,
  });

  const generatedImage = generatedPiApiImageFromTask(task);
  if (generatedImage.url) {
    const file = await downloadGeneratedImageFile(generatedImage.url, (progress) => {
      useMediaStore.getState().updateGenerationProgress(asset.id, progress);
    });
    await useMediaStore.getState().finalizeGeneratedAssetWithBlob(asset.id, file, {
      actualCostUsd: generation?.actualCostUsd ?? generation?.estimatedCostUsd,
      provider: 'piapi-gemini',
      providerArtifactUri: generatedImage.url,
      providerArtifactExpiresAt: Date.now() + PIAPI_IMAGE_ARTIFACT_TTL_MS,
    });
    return;
  }

  const currentProgress = generation?.progress ?? 5;
  store.updateGenerationProgress(asset.id, Math.min(95, Math.max(10, currentProgress + 2)));
}

function formatProviderError(error: VideoGenerationProviderError): string {
  const label = {
    NSFW: 'NSFW',
    GuidelinesViolation: 'Guidelines violation',
    Billing: 'Billing issue',
    InternalError: 'Internal error',
  }[error.type];
  return `${label}: ${error.message}`;
}

async function resumePiApiGeneration(asset: MediaAsset, apiKey: string): Promise<void> {
  const generation = asset.generation;
  const taskId = generation?.providerTaskId;
  if (!taskId) return;

  const task = await getPiApiVideoTask(taskId, { apiKey });
  const store = useMediaStore.getState();
  store.updateGenerationTask(asset.id, {
    provider: 'piapi',
    providerTaskId: task.task_id ?? taskId,
    providerTaskEndpoint: `/api/v1/task/${task.task_id ?? taskId}`,
    providerTaskStatus: task.status,
  });

  const generatedVideo = generatedPiApiVideoFromTask(task);
  if (generatedVideo.url) {
    const file = await downloadGeneratedVideoFile(generatedVideo.url, (progress) => {
      useMediaStore.getState().updateGenerationProgress(asset.id, progress);
    });
    await useMediaStore.getState().finalizeGeneratedAssetWithBlob(asset.id, file, {
      actualCostUsd: generation?.actualCostUsd ?? generation?.estimatedCostUsd,
      provider: 'piapi',
      providerArtifactUri: generatedVideo.url,
      providerArtifactExpiresAt: Date.now() + PIAPI_ARTIFACT_TTL_MS,
    });
    return;
  }

  const currentProgress = generation?.progress ?? 5;
  store.updateGenerationProgress(asset.id, Math.min(95, Math.max(10, currentProgress + 2)));
}

function isResumablePiApiGeneration(asset: MediaAsset): boolean {
  return asset.generation?.status === 'generating' &&
    asset.generation.provider === 'piapi' &&
    Boolean(asset.generation.providerTaskId);
}

function isResumablePiApiImageGeneration(asset: MediaAsset): boolean {
  return asset.generation?.status === 'generating' &&
    asset.generation.provider === 'piapi-gemini' &&
    Boolean(asset.generation.providerTaskId);
}

async function readPiApiKey(): Promise<string | null> {
  for (const key of [PIAPI_API_KEY_STORAGE, PIAPI_VEO_API_KEY_STORAGE, PIAPI_KLING_API_KEY_STORAGE]) {
    const encrypted = localStorage.getItem(key);
    if (!encrypted) continue;
    try {
      const decrypted = await decryptSecret(encrypted);
      if (decrypted.trim()) return decrypted.trim();
    } catch {
      // Try the next legacy key slot.
    }
  }
  return null;
}
