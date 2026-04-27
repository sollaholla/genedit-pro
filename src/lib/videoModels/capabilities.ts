export type Aspect = '21:9' | '16:9' | '4:3' | '1:1' | '3:4' | '9:16';

export type StructuredPromptSectionIcon =
  | 'subject'
  | 'action'
  | 'style'
  | 'camera'
  | 'composition'
  | 'lens'
  | 'ambience';

export type StructuredPromptSectionDefinition = {
  id: string;
  label: string;
  icon: StructuredPromptSectionIcon;
  optional?: boolean;
  description: string;
  placeholder: string;
};

export type PromptGuidelines = {
  structuredSections: StructuredPromptSectionDefinition[];
};

export type VideoModelCapabilities = {
  references: boolean;
  audio: boolean;
  adult: boolean;
  durations: string[];
  resolutions: string[];
  aspects: Aspect[];
  assetInputs: {
    startFrame: boolean;
    endFrame: boolean;
    imageReferencesMax: number;
    videoExtension: boolean;
  };
};

export type VideoModelDefinition = {
  id: string;
  label: string;
  provider: 'piapi' | 'veo' | 'kling' | 'generic';
  priority: number;
  capabilities: VideoModelCapabilities;
  promptGuidelines?: PromptGuidelines;
};

export const DEFAULT_ASPECTS: Aspect[] = ['16:9', '9:16', '1:1'];
export const SEEDANCE_ASPECTS: Aspect[] = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'];
export const DEFAULT_RESOLUTIONS = ['720p', '1080p'] as const;
export const DEFAULT_DURATIONS = ['4s', '6s', '8s'] as const;
export const KLING_DURATIONS = ['3s', '4s', '5s', '6s', '7s', '8s', '9s', '10s', '11s', '12s', '13s', '14s', '15s'] as const;
export const SEEDANCE_DURATIONS = ['4s', '5s', '6s', '7s', '8s', '9s', '10s', '11s', '12s', '13s', '14s', '15s'] as const;
export const KLING_OMNI_IMAGE_REFERENCE_LIMIT = 7;
export const PIAPI_VEO_STANDARD_MODEL_ID = 'piapi-veo-3.1';
export const PIAPI_VEO_FAST_MODEL_ID = 'piapi-veo-3.1-fast';
export const PIAPI_KLING_3_OMNI_MODEL_ID = 'piapi-kling-3-omni';
export const PIAPI_SEEDANCE_2_MODEL_ID = 'piapi-seedance-2';
export const PIAPI_SEEDANCE_2_FAST_MODEL_ID = 'piapi-seedance-2-fast';

export const VEO_STRUCTURED_PROMPT_SECTIONS: StructuredPromptSectionDefinition[] = [
  {
    id: 'subject',
    label: 'Subject',
    icon: 'subject',
    description: 'The object, person, animal, or scenery that should appear in the video.',
    placeholder: 'A rain-slick city street with a vintage taxi',
  },
  {
    id: 'action',
    label: 'Action',
    icon: 'action',
    description: 'What the subject is doing or how the scene changes.',
    placeholder: 'The taxi rolls forward as steam rises from the street',
  },
  {
    id: 'style',
    label: 'Style',
    icon: 'style',
    description: 'Creative direction using specific film, genre, or animation keywords.',
    placeholder: 'Cinematic film noir, high contrast, moody',
  },
  {
    id: 'camera',
    label: 'Camera positioning and motion',
    icon: 'camera',
    optional: true,
    description: 'The camera location and movement.',
    placeholder: 'Low-angle dolly shot moving beside the taxi',
  },
  {
    id: 'composition',
    label: 'Composition',
    icon: 'composition',
    optional: true,
    description: 'How the shot is framed.',
    placeholder: 'Wide shot with the taxi framed in the lower third',
  },
  {
    id: 'focus',
    label: 'Focus and lens effects',
    icon: 'lens',
    optional: true,
    description: 'Focus behavior and lens treatment.',
    placeholder: 'Shallow focus, soft bloom, anamorphic lens',
  },
  {
    id: 'ambience',
    label: 'Ambience',
    icon: 'ambience',
    optional: true,
    description: 'How color and light contribute to the scene.',
    placeholder: 'Cool blue tones, wet reflections, late night',
  },
];

export const DEFAULT_VIDEO_MODELS: VideoModelDefinition[] = [
  {
    id: PIAPI_SEEDANCE_2_MODEL_ID,
    label: 'Seedance 2.0',
    provider: 'piapi',
    priority: 100,
    promptGuidelines: {
      structuredSections: VEO_STRUCTURED_PROMPT_SECTIONS,
    },
    capabilities: {
      references: true,
      audio: true,
      adult: false,
      durations: [...SEEDANCE_DURATIONS],
      resolutions: ['480p', '720p', '1080p'],
      aspects: [...SEEDANCE_ASPECTS],
      assetInputs: {
        startFrame: true,
        endFrame: true,
        imageReferencesMax: 12,
        videoExtension: true,
      },
    },
  },
  {
    id: PIAPI_VEO_STANDARD_MODEL_ID,
    label: 'Veo 3.1',
    provider: 'piapi',
    priority: 90,
    promptGuidelines: {
      structuredSections: VEO_STRUCTURED_PROMPT_SECTIONS,
    },
    capabilities: {
      references: true,
      audio: true,
      adult: true,
      durations: ['4s', '6s', '8s'],
      resolutions: ['720p', '1080p'],
      aspects: ['16:9', '9:16'],
      assetInputs: {
        startFrame: true,
        endFrame: true,
        imageReferencesMax: 3,
        videoExtension: false,
      },
    },
  },
  {
    id: PIAPI_KLING_3_OMNI_MODEL_ID,
    label: 'Kling 3.0 Omni',
    provider: 'piapi',
    priority: 80,
    promptGuidelines: {
      structuredSections: VEO_STRUCTURED_PROMPT_SECTIONS,
    },
    capabilities: {
      references: true,
      audio: true,
      adult: false,
      durations: [...KLING_DURATIONS],
      resolutions: ['720p', '1080p'],
      aspects: ['16:9', '9:16', '1:1'],
      assetInputs: {
        startFrame: true,
        endFrame: true,
        imageReferencesMax: KLING_OMNI_IMAGE_REFERENCE_LIMIT,
        videoExtension: true,
      },
    },
  },
  {
    id: PIAPI_SEEDANCE_2_FAST_MODEL_ID,
    label: 'Seedance 2.0 Fast',
    provider: 'piapi',
    priority: 70,
    promptGuidelines: {
      structuredSections: VEO_STRUCTURED_PROMPT_SECTIONS,
    },
    capabilities: {
      references: true,
      audio: true,
      adult: false,
      durations: [...SEEDANCE_DURATIONS],
      resolutions: ['480p', '720p'],
      aspects: [...SEEDANCE_ASPECTS],
      assetInputs: {
        startFrame: true,
        endFrame: true,
        imageReferencesMax: 12,
        videoExtension: true,
      },
    },
  },
  {
    id: PIAPI_VEO_FAST_MODEL_ID,
    label: 'Veo 3.1 Fast',
    provider: 'piapi',
    priority: 60,
    promptGuidelines: {
      structuredSections: VEO_STRUCTURED_PROMPT_SECTIONS,
    },
    capabilities: {
      references: true,
      audio: true,
      adult: true,
      durations: ['4s', '6s', '8s'],
      resolutions: ['720p', '1080p'],
      aspects: ['16:9', '9:16'],
      assetInputs: {
        startFrame: true,
        endFrame: true,
        imageReferencesMax: 3,
        videoExtension: false,
      },
    },
  },
];

export const GOOGLE_ALLOWED_VIDEO_MODEL_IDS = new Set(DEFAULT_VIDEO_MODELS.filter((m) => m.provider === 'veo').map((m) => m.id));

export function isVeoModel(model: VideoModelDefinition): boolean {
  return model.provider === 'veo' || model.id.toLowerCase().includes('veo');
}

export function isKlingModel(model: VideoModelDefinition): boolean {
  return model.provider === 'kling' || model.id.toLowerCase().includes('kling');
}

export function isSeedanceModel(model: VideoModelDefinition): boolean {
  return model.id.toLowerCase().includes('seedance');
}

export function isPiApiModel(model: VideoModelDefinition): boolean {
  return model.provider === 'piapi' || model.id.toLowerCase().startsWith('piapi-');
}

export function isPiApiVeoModel(model: VideoModelDefinition): boolean {
  return isPiApiModel(model) && isVeoModel(model);
}

export function isPiApiKlingModel(model: VideoModelDefinition): boolean {
  return isPiApiModel(model) && isKlingModel(model);
}

export function isPiApiSeedanceModel(model: VideoModelDefinition): boolean {
  return isPiApiModel(model) && isSeedanceModel(model);
}

export function isReferencesFeatureSupported(model: VideoModelDefinition): boolean {
  return model.capabilities.references && model.capabilities.assetInputs.imageReferencesMax > 0;
}

export function isAudioFeatureSupported(model: VideoModelDefinition): boolean {
  return model.capabilities.audio;
}

export function isAdultContentFeatureSupported(model: VideoModelDefinition): boolean {
  return model.capabilities.adult;
}

export function isAspectFeatureSupported(model: VideoModelDefinition, value: string): boolean {
  return model.capabilities.aspects.includes(value as Aspect);
}

export function isResolutionFeatureSupported(model: VideoModelDefinition, value: string): boolean {
  return model.capabilities.resolutions.includes(value);
}

export function isDurationFeatureSupported(model: VideoModelDefinition, value: string): boolean {
  return model.capabilities.durations.includes(value);
}

export function structuredPromptSectionsFor(model: VideoModelDefinition): StructuredPromptSectionDefinition[] {
  return model.promptGuidelines?.structuredSections ?? [];
}

export function missingRequiredStructuredSections(
  model: VideoModelDefinition,
  values: Record<string, string>,
): StructuredPromptSectionDefinition[] {
  return structuredPromptSectionsFor(model).filter((section) => !section.optional && !values[section.id]?.trim());
}

export function buildStructuredPromptText(
  model: VideoModelDefinition,
  values: Record<string, string>,
): string {
  return structuredPromptSectionsFor(model)
    .map((section) => {
      const value = values[section.id]?.trim();
      return value ? `${section.label}: ${value}` : '';
    })
    .filter(Boolean)
    .join('\n');
}

export function buildRemoteVideoModelDefinition(input: { name: string; displayName?: string }, fallback?: VideoModelDefinition): VideoModelDefinition {
  const id = input.name.replace('models/', '');
  const veo = id.toLowerCase().includes('veo');
  return {
    id,
    label: input.displayName || id,
    provider: veo ? 'veo' : 'generic',
    priority: fallback?.priority ?? (veo ? 50 : 10),
    promptGuidelines: fallback?.promptGuidelines ?? (veo ? { structuredSections: VEO_STRUCTURED_PROMPT_SECTIONS } : undefined),
    capabilities: fallback?.capabilities ?? {
      references: !veo,
      audio: veo,
      adult: veo,
      durations: [...DEFAULT_DURATIONS],
      resolutions: [...DEFAULT_RESOLUTIONS],
      aspects: [...DEFAULT_ASPECTS],
      assetInputs: {
        startFrame: veo,
        endFrame: veo,
        imageReferencesMax: veo ? 3 : 0,
        videoExtension: veo,
      },
    },
  };
}

export function sortModelsByPriority(models: VideoModelDefinition[]): VideoModelDefinition[] {
  return [...models].sort((a, b) => b.priority - a.priority || a.label.localeCompare(b.label));
}
