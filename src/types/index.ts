export type MediaKind = 'video' | 'audio' | 'image';

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
  createdAt: number;
};

export type TrackKind = 'video' | 'audio';

export type Track = {
  id: string;
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
  /** 0–2, default 1. Applied as a scalar multiplier over the envelope. */
  volume: number;
  /** Optional editable volume envelope; absent means flat at 100%. */
  volumeEnvelope?: VolumeEnvelope;
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
