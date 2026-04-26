export const MIN_PX_PER_SEC = 5;
export const MAX_PX_PER_SEC = 400;
export const DEFAULT_PX_PER_SEC = 60;
export const SNAP_TOLERANCE_PX = 8;
export const TRACK_HEIGHT_PX = 56;
export const TRACK_GAP_PX = 4;
export const TRACK_HEADER_WIDTH_PX = 128;
export const RULER_HEIGHT_PX = 28;

export function timeToPx(timeSec: number, pxPerSec: number): number {
  return timeSec * pxPerSec;
}

export function pxToTime(px: number, pxPerSec: number): number {
  return pxPerSec === 0 ? 0 : px / pxPerSec;
}

export function clampPxPerSec(value: number): number {
  return Math.min(MAX_PX_PER_SEC, Math.max(MIN_PX_PER_SEC, value));
}

export function snapTime(
  candidate: number,
  targets: number[],
  pxPerSec: number,
  tolerancePx = SNAP_TOLERANCE_PX,
): number {
  const toleranceSec = pxPerSec === 0 ? 0 : tolerancePx / pxPerSec;
  let best = candidate;
  let bestDist = toleranceSec;
  for (const t of targets) {
    const d = Math.abs(candidate - t);
    if (d <= bestDist) {
      bestDist = d;
      best = t;
    }
  }
  return best;
}

export type FrameSnapMode = 'nearest' | 'floor' | 'ceil';

export function snapTimeToFrame(timeSec: number, fps = 30, mode: FrameSnapMode = 'nearest'): number {
  const safeFps = Number.isFinite(fps) && fps > 0 ? fps : 30;
  const rawFrame = Math.max(0, Number.isFinite(timeSec) ? timeSec : 0) * safeFps;
  const frame = mode === 'floor'
    ? Math.floor(rawFrame + 1e-6)
    : mode === 'ceil'
      ? Math.ceil(rawFrame - 1e-6)
      : Math.round(rawFrame);
  return Math.max(0, frame / safeFps);
}

export function formatTimecode(totalSec: number, fps = 30): string {
  const sign = totalSec < 0 ? '-' : '';
  const t = Math.max(0, Math.abs(totalSec));
  const hours = Math.floor(t / 3600);
  const minutes = Math.floor((t % 3600) / 60);
  const seconds = Math.floor(t % 60);
  const frames = Math.floor((t - Math.floor(t)) * fps);
  const pad = (n: number, w = 2) => n.toString().padStart(w, '0');
  return `${sign}${pad(hours)}:${pad(minutes)}:${pad(seconds)}:${pad(frames)}`;
}
