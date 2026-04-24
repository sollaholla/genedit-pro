export type Aspect = '16:9' | '9:16' | '1:1';

export type VideoModelCapabilities = {
  references: boolean;
  audio: boolean;
  adult: boolean;
  durations: string[];
  resolutions: string[];
  aspects: Aspect[];
};

export type VideoModelDefinition = {
  id: string;
  label: string;
  provider: 'veo' | 'generic';
  priority: number;
  capabilities: VideoModelCapabilities;
};

export const DEFAULT_ASPECTS: Aspect[] = ['16:9', '9:16', '1:1'];
export const DEFAULT_RESOLUTIONS = ['720p', '1080p'] as const;
export const DEFAULT_DURATIONS = ['4s', '6s', '8s'] as const;

export const DEFAULT_VIDEO_MODELS: VideoModelDefinition[] = [
  {
    id: 'veo-3.1-generate-preview',
    label: 'Veo 3.1 (Preview)',
    provider: 'veo',
    priority: 100,
    capabilities: {
      references: false,
      audio: true,
      adult: true,
      durations: ['4s', '8s'],
      resolutions: ['720p', '1080p'],
      aspects: ['16:9', '9:16', '1:1'],
    },
  },
  {
    id: 'veo-3.1-fast-generate-preview',
    label: 'Veo 3.1 Fast (Preview)',
    provider: 'veo',
    priority: 80,
    capabilities: {
      references: false,
      audio: true,
      adult: true,
      durations: ['4s', '6s'],
      resolutions: ['720p'],
      aspects: ['16:9', '9:16'],
    },
  },
];

export const GOOGLE_ALLOWED_VIDEO_MODEL_IDS = new Set(DEFAULT_VIDEO_MODELS.map((m) => m.id));

export function isVeoModel(model: VideoModelDefinition): boolean {
  return model.provider === 'veo' || model.id.toLowerCase().includes('veo');
}

export function isReferencesFeatureSupported(model: VideoModelDefinition): boolean {
  return model.capabilities.references;
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

export function buildRemoteVideoModelDefinition(input: { name: string; displayName?: string }, fallback?: VideoModelDefinition): VideoModelDefinition {
  const id = input.name.replace('models/', '');
  const veo = id.toLowerCase().includes('veo');
  return {
    id,
    label: input.displayName || id,
    provider: veo ? 'veo' : 'generic',
    priority: fallback?.priority ?? (veo ? 50 : 10),
    capabilities: fallback?.capabilities ?? {
      references: !veo,
      audio: veo,
      adult: veo,
      durations: [...DEFAULT_DURATIONS],
      resolutions: [...DEFAULT_RESOLUTIONS],
      aspects: [...DEFAULT_ASPECTS],
    },
  };
}

export function sortModelsByPriority(models: VideoModelDefinition[]): VideoModelDefinition[] {
  return [...models].sort((a, b) => b.priority - a.priority || a.label.localeCompare(b.label));
}
