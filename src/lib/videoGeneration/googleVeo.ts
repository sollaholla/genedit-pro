import { getBlob } from '@/lib/media/storage';
import type { MediaAsset } from '@/types';
import { assetsByRole, type VideoGenerationMutation } from './mutations';

type InlineMedia = {
  inlineData: {
    mimeType: string;
    data: string;
  };
};

export type GoogleVeoPredictRequest = {
  instances: Array<{
    prompt: string;
    image?: InlineMedia;
    lastFrame?: InlineMedia;
    referenceImages?: Array<{
      image: InlineMedia;
      referenceType: 'asset';
    }>;
    video?: InlineMedia;
  }>;
  parameters: {
    aspectRatio?: string;
    durationSeconds?: number;
    resolution?: string;
    numberOfVideos?: number;
    personGeneration?: 'allow_all' | 'allow_adult';
  };
};

type VideoOperationResponse = {
  response?: {
    generatedVideos?: Array<{ video?: { uri?: string; fileUri?: string } }>;
    generateVideoResponse?: {
      generatedSamples?: Array<{ video?: { uri?: string; fileUri?: string } }>;
    };
  };
};

export async function buildGoogleVeoPredictRequest(
  mutation: VideoGenerationMutation,
): Promise<GoogleVeoPredictRequest> {
  const startFrames = assetsByRole(mutation, 'start-frame');
  const endFrames = assetsByRole(mutation, 'end-frame');
  const referenceImages = assetsByRole(mutation, 'reference-image');
  const sourceVideos = assetsByRole(mutation, 'source-video');

  validateGoogleVeoMutation({ startFrames, endFrames, referenceImages, sourceVideos, mutation });

  const instance: GoogleVeoPredictRequest['instances'][number] = { prompt: mutation.prompt };
  if (startFrames[0]) instance.image = await assetToInlineMedia(startFrames[0]);
  if (endFrames[0]) instance.lastFrame = await assetToInlineMedia(endFrames[0]);
  if (referenceImages.length > 0) {
    instance.referenceImages = await Promise.all(referenceImages.map(async (asset) => ({
      image: await assetToInlineMedia(asset),
      referenceType: 'asset' as const,
    })));
  }
  if (sourceVideos[0]) instance.video = await assetToInlineMedia(sourceVideos[0]);

  const imageConditioned = Boolean(instance.image || instance.lastFrame || instance.referenceImages?.length);
  return {
    instances: [instance],
    parameters: {
      numberOfVideos: 1,
      aspectRatio: mutation.config.aspectRatio,
      durationSeconds: mutation.config.durationSeconds,
      resolution: mutation.config.resolution,
      personGeneration: imageConditioned ? 'allow_adult' : 'allow_all',
    },
  };
}

export function generatedVideoUriFromOperation(operation: VideoOperationResponse): string | undefined {
  return operation.response?.generatedVideos?.[0]?.video?.uri ||
    operation.response?.generatedVideos?.[0]?.video?.fileUri ||
    operation.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri ||
    operation.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.fileUri;
}

function validateGoogleVeoMutation({
  startFrames,
  endFrames,
  referenceImages,
  sourceVideos,
  mutation,
}: {
  startFrames: MediaAsset[];
  endFrames: MediaAsset[];
  referenceImages: MediaAsset[];
  sourceVideos: MediaAsset[];
  mutation: VideoGenerationMutation;
}) {
  if (sourceVideos.length > 1) throw new Error('Veo extension accepts one source video.');
  if (sourceVideos.length > 0 && (startFrames.length > 0 || endFrames.length > 0 || referenceImages.length > 0)) {
    throw new Error('Veo video extension cannot be combined with frame or image references.');
  }
  if (sourceVideos.length > 0 && mutation.config.resolution !== '720p') {
    throw new Error('Veo video extension requires 720p output.');
  }
  if (endFrames.length > 0 && startFrames.length === 0) {
    throw new Error('An end frame requires a start frame.');
  }
  if (referenceImages.length > 3) throw new Error('Veo accepts up to 3 image references.');
  for (const asset of [...startFrames, ...endFrames, ...referenceImages]) {
    if (asset.kind !== 'image') throw new Error(`${asset.name} must be an image input.`);
  }
  for (const asset of sourceVideos) {
    if (asset.kind !== 'video') throw new Error(`${asset.name} must be a video input.`);
  }
  if ((referenceImages.length > 0 || sourceVideos.length > 0) && mutation.config.durationSeconds !== 8) {
    throw new Error('Veo reference images and video extension require an 8 second generation.');
  }
}

async function assetToInlineMedia(asset: MediaAsset): Promise<InlineMedia> {
  const blob = await getBlob(asset.blobKey);
  if (!blob) throw new Error(`Could not read ${asset.name}.`);
  return {
    inlineData: {
      mimeType: blob.type || asset.mimeType || 'application/octet-stream',
      data: await blobToBase64(blob),
    },
  };
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
