export const PROJECT_ASPECTS = {
  '16:9': 16 / 9,
  '2.39:1': 2.39,
  '4:3': 4 / 3,
  '1:1': 1,
  '9:16': 9 / 16,
} as const;

export type ProjectAspectPreset = keyof typeof PROJECT_ASPECTS;

export const PROJECT_ASPECT_OPTIONS: readonly { value: ProjectAspectPreset; label: string }[] = [
  { value: '16:9', label: '16:9' },
  { value: '2.39:1', label: '2.39:1' },
  { value: '4:3', label: '4:3' },
  { value: '1:1', label: '1:1' },
  { value: '9:16', label: '9:16' },
];

export const PROJECT_RESOLUTIONS = {
  '240p': 240,
  '480p': 480,
  '720p': 720,
  '1080p': 1080,
  '4K': 2160,
  '8K': 4320,
} as const;

export type ProjectResolutionPreset = keyof typeof PROJECT_RESOLUTIONS;

export const PROJECT_RESOLUTION_OPTIONS: readonly { value: ProjectResolutionPreset; label: string }[] = [
  { value: '240p', label: '240p' },
  { value: '480p', label: '480p' },
  { value: '720p', label: '720p' },
  { value: '1080p', label: '1080p' },
  { value: '4K', label: '4K' },
  { value: '8K', label: '8K' },
];

export const PROJECT_FRAME_RATE_OPTIONS: readonly { value: string; label: string; fps: number }[] = [
  { value: '23.976', label: '23.976 fps', fps: 23.976 },
  { value: '24', label: '24 fps', fps: 24 },
  { value: '25', label: '25 fps', fps: 25 },
  { value: '29.97', label: '29.97 fps', fps: 29.97 },
  { value: '30', label: '30 fps', fps: 30 },
  { value: '50', label: '50 fps', fps: 50 },
  { value: '59.94', label: '59.94 fps', fps: 59.94 },
  { value: '60', label: '60 fps', fps: 60 },
];

export function isProjectAspectPreset(value: string | null): value is ProjectAspectPreset {
  return Boolean(value && value in PROJECT_ASPECTS);
}

export function isProjectResolutionPreset(value: string | null): value is ProjectResolutionPreset {
  return Boolean(value && value in PROJECT_RESOLUTIONS);
}

export function frameRateOptionForFps(fps: number): string {
  const safeFps = Number.isFinite(fps) && fps > 0 ? fps : 30;
  const exact = PROJECT_FRAME_RATE_OPTIONS.find((option) => Math.abs(option.fps - safeFps) < 0.001);
  if (exact) return exact.value;
  return String(Number(safeFps.toFixed(3)));
}

export function fpsForFrameRateOption(value: string): number | null {
  const option = PROJECT_FRAME_RATE_OPTIONS.find((candidate) => candidate.value === value);
  if (option) return option.fps;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function inferProjectAspectPreset(width: number, height: number): ProjectAspectPreset {
  const ratio = width / Math.max(1, height);
  let best: ProjectAspectPreset = '16:9';
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const option of PROJECT_ASPECT_OPTIONS) {
    const delta = Math.abs(ratio - PROJECT_ASPECTS[option.value]);
    if (delta < bestDelta) {
      best = option.value;
      bestDelta = delta;
    }
  }
  return best;
}

export function inferProjectResolutionPreset(
  width: number,
  height: number,
  aspect: ProjectAspectPreset = inferProjectAspectPreset(width, height),
): ProjectResolutionPreset {
  const ratio = PROJECT_ASPECTS[aspect];
  const basis = ratio < 1 ? width : height;
  let best: ProjectResolutionPreset = '1080p';
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const option of PROJECT_RESOLUTION_OPTIONS) {
    const delta = Math.abs(basis - PROJECT_RESOLUTIONS[option.value]);
    if (delta < bestDelta) {
      best = option.value;
      bestDelta = delta;
    }
  }
  return best;
}

export function dimensionsForProjectFormat(
  aspect: ProjectAspectPreset,
  resolution: ProjectResolutionPreset,
): { width: number; height: number } {
  const ratio = PROJECT_ASPECTS[aspect];
  const basis = PROJECT_RESOLUTIONS[resolution];
  if (ratio >= 1) {
    return {
      width: toEncoderSafeDimension(basis * ratio),
      height: toEncoderSafeDimension(basis),
    };
  }

  return {
    width: toEncoderSafeDimension(basis),
    height: toEncoderSafeDimension(basis / ratio),
  };
}

function toEncoderSafeDimension(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}
