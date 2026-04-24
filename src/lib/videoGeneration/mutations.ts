import type { MediaAsset } from '@/types';

export type GenerationAssetRole = 'start-frame' | 'end-frame' | 'reference-image' | 'source-video';

export type GenerationAssetMutation = {
  role: GenerationAssetRole;
  asset: MediaAsset;
};

export type VideoGenerationMutation = {
  modelId: string;
  prompt: string;
  config: {
    aspectRatio: string;
    durationSeconds: number;
    resolution: string;
    audioEnabled: boolean;
  };
  assets: GenerationAssetMutation[];
};

export function buildVideoGenerationMutation({
  modelId,
  prompt,
  aspectRatio,
  duration,
  resolution,
  audioEnabled,
  startFrame,
  endFrame,
  sourceVideo,
  referenceImages,
}: {
  modelId: string;
  prompt: string;
  aspectRatio: string;
  duration: string;
  resolution: string;
  audioEnabled: boolean;
  startFrame: MediaAsset | null;
  endFrame: MediaAsset | null;
  sourceVideo: MediaAsset | null;
  referenceImages: MediaAsset[];
}): VideoGenerationMutation {
  const assets: GenerationAssetMutation[] = [];
  if (startFrame) assets.push({ role: 'start-frame', asset: startFrame });
  if (endFrame) assets.push({ role: 'end-frame', asset: endFrame });
  if (sourceVideo) assets.push({ role: 'source-video', asset: sourceVideo });
  for (const asset of referenceImages) assets.push({ role: 'reference-image', asset });

  return {
    modelId,
    prompt,
    config: {
      aspectRatio,
      durationSeconds: Number(duration.replace('s', '')),
      resolution,
      audioEnabled,
    },
    assets,
  };
}

export function assetsByRole(mutation: VideoGenerationMutation, role: GenerationAssetRole): MediaAsset[] {
  return mutation.assets
    .filter((entry) => entry.role === role)
    .map((entry) => entry.asset);
}
