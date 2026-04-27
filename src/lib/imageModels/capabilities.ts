export type ImageAspect = '21:9' | '16:9' | '4:3' | '3:2' | '1:1' | '2:3' | '3:4' | '9:16';

export type ImageModelProvider = 'piapi-gpt-image' | 'piapi-gemini';

export type ImageModelCapabilities = {
  aspects: ImageAspect[];
  resolutions: string[];
  outputFormats: string[];
  defaultOutputFormat: string;
  imageInputs: boolean;
};

export type ImageModelDefinition = {
  id: string;
  label: string;
  provider: ImageModelProvider;
  priority: number;
  estimatedCostUsd: number;
  capabilities: ImageModelCapabilities;
};

export const GPT_IMAGE_1_5_MODEL_ID = 'gpt-image-1.5';
export const GPT_IMAGE_2_PREVIEW_MODEL_ID = 'gpt-image-2-preview';
export const NANO_BANANA_2_MODEL_ID = 'nano-banana-2';
export const NANO_BANANA_PRO_MODEL_ID = 'nano-banana-pro';

export const CHARACTER_IMAGE_ASPECT_RATIO: ImageAspect = '21:9';
export const CHARACTER_IMAGE_RESOLUTION = '2K';

export const DEFAULT_IMAGE_MODELS: ImageModelDefinition[] = [
  {
    id: NANO_BANANA_PRO_MODEL_ID,
    label: 'Nano Banana Pro',
    provider: 'piapi-gemini',
    priority: 100,
    estimatedCostUsd: 0.105,
    capabilities: {
      aspects: [CHARACTER_IMAGE_ASPECT_RATIO],
      resolutions: [CHARACTER_IMAGE_RESOLUTION],
      outputFormats: ['png', 'jpeg'],
      defaultOutputFormat: 'png',
      imageInputs: true,
    },
  },
  {
    id: NANO_BANANA_2_MODEL_ID,
    label: 'Nano Banana 2',
    provider: 'piapi-gemini',
    priority: 90,
    estimatedCostUsd: 0.06,
    capabilities: {
      aspects: [CHARACTER_IMAGE_ASPECT_RATIO],
      resolutions: [CHARACTER_IMAGE_RESOLUTION],
      outputFormats: ['png', 'jpg', 'webp'],
      defaultOutputFormat: 'png',
      imageInputs: true,
    },
  },
  {
    id: GPT_IMAGE_2_PREVIEW_MODEL_ID,
    label: 'GPT Image 2 Preview',
    provider: 'piapi-gpt-image',
    priority: 80,
    estimatedCostUsd: 0.1,
    capabilities: {
      aspects: [CHARACTER_IMAGE_ASPECT_RATIO],
      resolutions: [CHARACTER_IMAGE_RESOLUTION],
      outputFormats: ['png', 'jpeg'],
      defaultOutputFormat: 'png',
      imageInputs: true,
    },
  },
  {
    id: GPT_IMAGE_1_5_MODEL_ID,
    label: 'GPT Image 1.5',
    provider: 'piapi-gpt-image',
    priority: 70,
    estimatedCostUsd: 0.018,
    capabilities: {
      aspects: [CHARACTER_IMAGE_ASPECT_RATIO],
      resolutions: [CHARACTER_IMAGE_RESOLUTION],
      outputFormats: ['png', 'jpeg'],
      defaultOutputFormat: 'png',
      imageInputs: true,
    },
  },
];

export function sortImageModelsByPriority(models: ImageModelDefinition[]): ImageModelDefinition[] {
  return [...models].sort((a, b) => b.priority - a.priority || a.label.localeCompare(b.label));
}

export function imageModelById(modelId: string): ImageModelDefinition | null {
  return DEFAULT_IMAGE_MODELS.find((model) => model.id === modelId) ?? null;
}

export function estimateImageCostUsd(model: ImageModelDefinition): number {
  return model.estimatedCostUsd;
}

export function defaultImageModel(): ImageModelDefinition {
  return sortImageModelsByPriority(DEFAULT_IMAGE_MODELS)[0]!;
}
