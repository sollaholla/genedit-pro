import type { GenerationErrorType } from '@/lib/videoGeneration/errors';

export type MediaKind = 'video' | 'audio' | 'image' | 'character' | 'recipe' | 'sequence';

export type CharacterAssetData = {
  characterId: string;
  description: string;
  prompt: string;
  generatedPrompt?: string;
  model: string;
  aspectRatio: string;
  resolution: string;
  updatedAt: number;
  sourceImageAssetIds?: string[];
};

export type SequenceMarker = {
  id: string;
  timeSec: number;
  imageAssetId?: string | null;
  prompt: string;
};

export type SequenceAssetData = {
  model: string;
  durationSec: number;
  overallPrompt: string;
  markers: SequenceMarker[];
};

export type EditTrailTransform = {
  scale: number;
  offsetX: number;
  offsetY: number;
};

export type EditTrailIteration = {
  id: string;
  label: string;
  source: 'original' | 'manual' | 'generated';
  blobKey: string;
  thumbnailDataUrl?: string;
  mimeType: string;
  width?: number;
  height?: number;
  durationSec: number;
  transform: EditTrailTransform;
  generation?: {
    prompt?: string;
    model?: string;
    estimatedCostUsd?: number;
    actualCostUsd?: number;
    provider?: string;
    providerTaskId?: string;
    providerTaskEndpoint?: string;
    providerTaskStatus?: string;
    providerTaskCreatedAt?: number;
    providerArtifactUri?: string;
    providerArtifactExpiresAt?: number;
    costAccountedUsd?: number;
    costAccountedAt?: number;
  };
  createdAt: number;
};

export type EditTrail = {
  activeIterationId: string;
  iterations: EditTrailIteration[];
};

export type GenerateRecipe = {
  model: string;
  prompt: string;
  promptMode?: 'freeform' | 'structured';
  structuredPrompt?: Record<string, string>;
  aspect: string;
  resolution: string;
  duration: string;
  audioEnabled: boolean;
  startFrameAssetId?: string | null;
  endFrameAssetId?: string | null;
  sourceVideoAssetId?: string | null;
  referenceAssetIds: string[];
};

export type MediaAsset = {
  id: string;
  name: string;
  kind: MediaKind;
  durationSec: number;
  width?: number;
  height?: number;
  mimeType: string;
  blobKey: string;
  thumbnailDataUrl?: string;
  folderId?: string | null;
  editTrail?: EditTrail;
  generation?: {
    status: 'generating' | 'done' | 'error';
    progress?: number;
    estimatedCostUsd?: number;
    actualCostUsd?: number;
    provider?: string;
    providerTaskId?: string;
    providerTaskEndpoint?: string;
    providerTaskStatus?: string;
    providerTaskCreatedAt?: number;
    providerArtifactUri?: string;
    providerArtifactExpiresAt?: number;
    errorType?: GenerationErrorType;
    errorMessage?: string;
    failedAt?: number;
    costAccountedUsd?: number;
    costAccountedAt?: number;
  };
  recipe?: GenerateRecipe;
  sequence?: SequenceAssetData;
  character?: CharacterAssetData;
  createdAt: number;
};

export type TrackKind = 'video' | 'audio';

export type Track = {
  id: string;
  name: string;
  kind: TrackKind;
  index: number;
  muted: boolean;
  hidden: boolean;
};

export type EnvelopePoint = {
  /** 0..1 normalized within the clip's on-timeline duration. */
  t: number;
  /** 0..1 volume multiplier applied on top of master volume. */
  v: number;
  /** Quadratic bezier curvature for the segment STARTING at this point (to next point).
   *  -1..1, where 0 = linear, >0 bulges up, <0 bulges down. Ignored on the final point. */
  curvature: number;
};

export type VolumeEnvelope = {
  enabled: boolean;
  /** Always >= 2 points, sorted by t, first at t=0, last at t=1. */
  points: EnvelopePoint[];
};

export type Clip = {
  id: string;
  assetId: string;
  trackId: string;
  startSec: number;
  inSec: number;
  outSec: number;
  /** Playback rate applied to this clip (0.25..4). 1 = normal speed. */
  speed?: number;
  /** Visual scale for rendered video in preview/export. 1 = 100%. */
  scale?: number;
  /** Optional transform component state for this clip. */
  transform?: {
    scale: number;
    offsetX: number;
    offsetY: number;
    keyframes: Array<{
      id: string;
      timeSec: number;
      scale: number;
      offsetX: number;
      offsetY: number;
    }>;
  };
  /** Ordered component stack (Unity-style). */
  components?: ComponentInstance[];
  /** 0–2, default 1. Applied as a scalar multiplier over the envelope. */
  volume: number;
  /** Optional editable volume envelope; absent means flat at 100%. */
  volumeEnvelope?: VolumeEnvelope;
  /** Timeline-edge fade-in duration in seconds. Visual fades use alpha transparency. */
  fadeInSec?: number;
  /** Timeline-edge fade-out duration in seconds. Visual fades use alpha transparency. */
  fadeOutSec?: number;
};

export type KeyframePoint = {
  id: string;
  timeSec: number;
  value: number;
};

export type TransformComponentData = {
  scale: number;
  offsetX: number;
  offsetY: number;
  keyframes: {
    scale: KeyframePoint[];
    offsetX: KeyframePoint[];
    offsetY: KeyframePoint[];
  };
};

export type ColorWheelValue = {
  /** Horizontal chroma offset, -1..1. */
  x: number;
  /** Vertical chroma offset, -1..1. */
  y: number;
};

export type ColorCorrectionComponentData = {
  lift: ColorWheelValue;
  gammaWheel: ColorWheelValue;
  gain: ColorWheelValue;
  /** -1..1, default 0. */
  brightness: number;
  /** 0.25..3, default 1. */
  gamma: number;
  /** 0..2, default 1. */
  saturation: number;
  /** 0..2, default 1. */
  contrast: number;
  presetId?: string;
};

export type TransformComponentInstance = {
  id: string;
  type: 'transform';
  data: TransformComponentData;
};

export type ColorCorrectionComponentInstance = {
  id: string;
  type: 'colorCorrection';
  data: ColorCorrectionComponentData;
};

export type ComponentInstance = TransformComponentInstance | ColorCorrectionComponentInstance;

export type Project = {
  id: string;
  name: string;
  fps: number;
  width: number;
  height: number;
  metadata?: {
    aiGenerationSpendUsd?: number;
  };
  tracks: Track[];
  clips: Clip[];
};

export type ExportStatus = 'idle' | 'preparing' | 'encoding' | 'done' | 'error';

export type ExportProgress = {
  status: ExportStatus;
  progress: number;
  message?: string;
  outputUrl?: string;
  error?: string;
};
