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

export type Clip = {
  id: string;
  assetId: string;
  trackId: string;
  startSec: number;
  inSec: number;
  outSec: number;
  /** 0–2, default 1 */
  volume: number;
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
