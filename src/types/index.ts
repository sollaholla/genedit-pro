export type MediaKind = 'video' | 'audio' | 'image' | 'recipe';

export type GenerateRecipe = {
  model: string;
  prompt: string;
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
  generation?: {
    status: 'generating' | 'done' | 'error';
    progress?: number;
    estimatedCostUsd?: number;
    actualCostUsd?: number;
  };
  recipe?: GenerateRecipe;
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

export type ComponentInstance = {
  id: string;
  type: 'transform';
  data: TransformComponentData;
};

export type Project = {
  id: string;
  name: string;
  fps: number;
  width: number;
  height: number;
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
