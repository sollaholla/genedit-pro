import { nanoid } from 'nanoid';
import type {
  Clip,
  ColorCorrectionComponentData,
  ColorCorrectionComponentInstance,
  ColorWheelValue,
} from '@/types';
import { getClipComponents } from './transform';

export const DEFAULT_COLOR_CORRECTION_DATA: ColorCorrectionComponentData = {
  lift: { x: 0, y: 0 },
  gammaWheel: { x: 0, y: 0 },
  gain: { x: 0, y: 0 },
  brightness: 0,
  gamma: 1,
  saturation: 1,
  contrast: 1,
  presetId: 'neutral',
};

export type ColorCorrectionPreset = {
  id: string;
  label: string;
  data: ColorCorrectionComponentData;
};

export const COLOR_CORRECTION_PRESETS: ColorCorrectionPreset[] = [
  {
    id: 'neutral',
    label: 'Neutral',
    data: DEFAULT_COLOR_CORRECTION_DATA,
  },
  {
    id: 'punch',
    label: 'Punch',
    data: {
      ...DEFAULT_COLOR_CORRECTION_DATA,
      contrast: 1.18,
      saturation: 1.16,
      gain: { x: 0.08, y: -0.04 },
      presetId: 'punch',
    },
  },
  {
    id: 'cinema',
    label: 'Cinema',
    data: {
      ...DEFAULT_COLOR_CORRECTION_DATA,
      brightness: -0.04,
      contrast: 1.24,
      saturation: 0.9,
      lift: { x: -0.18, y: -0.18 },
      gammaWheel: { x: 0.06, y: 0.1 },
      gain: { x: 0.12, y: 0.02 },
      presetId: 'cinema',
    },
  },
  {
    id: 'warm',
    label: 'Warm',
    data: {
      ...DEFAULT_COLOR_CORRECTION_DATA,
      brightness: 0.03,
      saturation: 1.08,
      gammaWheel: { x: 0.12, y: 0.05 },
      gain: { x: 0.18, y: 0.02 },
      presetId: 'warm',
    },
  },
  {
    id: 'cool',
    label: 'Cool',
    data: {
      ...DEFAULT_COLOR_CORRECTION_DATA,
      contrast: 1.08,
      lift: { x: -0.08, y: -0.24 },
      gammaWheel: { x: -0.14, y: -0.1 },
      gain: { x: -0.08, y: -0.12 },
      presetId: 'cool',
    },
  },
  {
    id: 'noir',
    label: 'Noir',
    data: {
      ...DEFAULT_COLOR_CORRECTION_DATA,
      brightness: -0.08,
      contrast: 1.38,
      saturation: 0.12,
      gamma: 0.92,
      presetId: 'noir',
    },
  },
];

export type SvgColorCorrectionParams = {
  lift: { r: number; g: number; b: number };
  gain: { r: number; g: number; b: number };
  exponent: { r: number; g: number; b: number };
};

export function createDefaultColorCorrectionComponent(): ColorCorrectionComponentInstance {
  return {
    id: nanoid(8),
    type: 'colorCorrection',
    data: { ...DEFAULT_COLOR_CORRECTION_DATA },
  };
}

export function normalizeColorCorrectionData(
  data?: Partial<ColorCorrectionComponentData> | null,
): ColorCorrectionComponentData {
  return {
    lift: normalizeWheel(data?.lift),
    gammaWheel: normalizeWheel(data?.gammaWheel),
    gain: normalizeWheel(data?.gain),
    brightness: clamp(data?.brightness ?? DEFAULT_COLOR_CORRECTION_DATA.brightness, -1, 1),
    gamma: clamp(data?.gamma ?? DEFAULT_COLOR_CORRECTION_DATA.gamma, 0.25, 3),
    saturation: clamp(data?.saturation ?? DEFAULT_COLOR_CORRECTION_DATA.saturation, 0, 2),
    contrast: clamp(data?.contrast ?? DEFAULT_COLOR_CORRECTION_DATA.contrast, 0, 2),
    presetId: data?.presetId ?? inferPresetId(data),
  };
}

export function resolveColorCorrectionAtTime(clip: Clip, _timelineTimeSec: number): ColorCorrectionComponentData {
  const colorComponents = getClipComponents(clip).filter((component) => component.type === 'colorCorrection');
  if (colorComponents.length === 0) return DEFAULT_COLOR_CORRECTION_DATA;

  const stacked = colorComponents.reduce<ColorCorrectionComponentData>((acc, component) => {
    const data = normalizeColorCorrectionData(component.data);
    return {
      lift: addWheels(acc.lift, data.lift),
      gammaWheel: addWheels(acc.gammaWheel, data.gammaWheel),
      gain: addWheels(acc.gain, data.gain),
      brightness: clamp(acc.brightness + data.brightness, -1, 1),
      gamma: clamp(acc.gamma * data.gamma, 0.25, 3),
      saturation: clamp(acc.saturation * data.saturation, 0, 2),
      contrast: clamp(acc.contrast * data.contrast, 0, 2),
      presetId: undefined,
    };
  }, DEFAULT_COLOR_CORRECTION_DATA);

  return normalizeColorCorrectionData(stacked);
}

export function isNeutralColorCorrection(data: ColorCorrectionComponentData): boolean {
  const normalized = normalizeColorCorrectionData(data);
  return (
    wheelMagnitude(normalized.lift) < 0.001 &&
    wheelMagnitude(normalized.gammaWheel) < 0.001 &&
    wheelMagnitude(normalized.gain) < 0.001 &&
    Math.abs(normalized.brightness) < 0.001 &&
    Math.abs(normalized.gamma - 1) < 0.001 &&
    Math.abs(normalized.saturation - 1) < 0.001 &&
    Math.abs(normalized.contrast - 1) < 0.001
  );
}

export function colorCorrectionFilterId(clipId: string): string {
  return `ge-color-${clipId.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

export function colorCorrectionCssFilter(clip: Clip, timelineTimeSec: number): string {
  const data = resolveColorCorrectionAtTime(clip, timelineTimeSec);
  if (isNeutralColorCorrection(data)) return '';
  const id = colorCorrectionFilterId(clip.id);
  const brightness = clamp(1 + data.brightness, 0, 2);
  return [
    `url(#${id})`,
    `brightness(${roundCss(brightness)})`,
    `contrast(${roundCss(data.contrast)})`,
    `saturate(${roundCss(data.saturation)})`,
  ].join(' ');
}

export function colorCorrectionSvgParams(data: ColorCorrectionComponentData): SvgColorCorrectionParams {
  const normalized = normalizeColorCorrectionData(data);
  const lift = wheelToRgbDelta(normalized.lift, 0.16);
  const gainDelta = wheelToRgbDelta(normalized.gain, 0.38);
  const gammaDelta = wheelToRgbDelta(normalized.gammaWheel, 0.42);
  const scalarExponent = 1 / normalized.gamma;

  return {
    lift: {
      r: clamp(lift.r, -0.4, 0.4),
      g: clamp(lift.g, -0.4, 0.4),
      b: clamp(lift.b, -0.4, 0.4),
    },
    gain: {
      r: clamp(1 + gainDelta.r, 0.1, 3),
      g: clamp(1 + gainDelta.g, 0.1, 3),
      b: clamp(1 + gainDelta.b, 0.1, 3),
    },
    exponent: {
      r: clamp(scalarExponent * (1 - gammaDelta.r), 0.25, 3),
      g: clamp(scalarExponent * (1 - gammaDelta.g), 0.25, 3),
      b: clamp(scalarExponent * (1 - gammaDelta.b), 0.25, 3),
    },
  };
}

export function colorCorrectionFfmpegFilters(clip: Clip, timelineTimeSec: number): string[] {
  return colorCorrectionFfmpegFiltersWithOptions(clip, timelineTimeSec);
}

export function colorCorrectionFfmpegFiltersWithOptions(
  clip: Clip,
  timelineTimeSec: number,
  options: { perChannel?: boolean } = {},
): string[] {
  const data = resolveColorCorrectionAtTime(clip, timelineTimeSec);
  if (isNeutralColorCorrection(data)) return [];

  const filters: string[] = [];
  if (options.perChannel !== false) {
    filters.push(svgTransferFfmpegFilter(colorCorrectionSvgParams(data)));
  }

  const eqOptions = [
    `brightness=${roundFilter(data.brightness)}`,
    `contrast=${roundFilter(data.contrast)}`,
    `saturation=${roundFilter(data.saturation)}`,
  ];
  if (options.perChannel === false) eqOptions.splice(2, 0, `gamma=${roundFilter(data.gamma)}`);
  filters.push(`eq=${eqOptions.join(':')}`);
  return filters;
}

export function clampWheel(value: ColorWheelValue): ColorWheelValue {
  const x = clamp(value.x, -1, 1);
  const y = clamp(value.y, -1, 1);
  const mag = Math.hypot(x, y);
  if (mag <= 1) return { x, y };
  return { x: x / mag, y: y / mag };
}

function normalizeWheel(value?: Partial<ColorWheelValue> | null): ColorWheelValue {
  return clampWheel({
    x: value?.x ?? 0,
    y: value?.y ?? 0,
  });
}

function addWheels(a: ColorWheelValue, b: ColorWheelValue): ColorWheelValue {
  return clampWheel({ x: a.x + b.x, y: a.y + b.y });
}

function wheelMagnitude(value: ColorWheelValue): number {
  return Math.hypot(value.x, value.y);
}

function wheelToRgbDelta(value: ColorWheelValue, scale: number): { r: number; g: number; b: number } {
  const wheel = clampWheel(value);
  const amount = wheelMagnitude(wheel);
  if (amount < 0.001) return { r: 0, g: 0, b: 0 };

  const hue = ((Math.atan2(-wheel.y, wheel.x) / (Math.PI * 2)) + 1) % 1;
  const rgb = hslToRgb(hue, 1, 0.5);
  const mean = (rgb.r + rgb.g + rgb.b) / 3;
  return {
    r: (rgb.r - mean) * amount * scale,
    g: (rgb.g - mean) * amount * scale,
    b: (rgb.b - mean) * amount * scale,
  };
}

function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  const hue2rgb = (p: number, q: number, t: number) => {
    let next = t;
    if (next < 0) next += 1;
    if (next > 1) next -= 1;
    if (next < 1 / 6) return p + (q - p) * 6 * next;
    if (next < 1 / 2) return q;
    if (next < 2 / 3) return p + (q - p) * (2 / 3 - next) * 6;
    return p;
  };

  if (s === 0) return { r: l, g: l, b: l };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return {
    r: hue2rgb(p, q, h + 1 / 3),
    g: hue2rgb(p, q, h),
    b: hue2rgb(p, q, h - 1 / 3),
  };
}

function inferPresetId(data?: Partial<ColorCorrectionComponentData> | null): string | undefined {
  if (!data) return 'neutral';
  return undefined;
}

function svgTransferFfmpegFilter(params: SvgColorCorrectionParams): string {
  const expr = (channel: keyof SvgColorCorrectionParams['lift']) => {
    const lift = roundFilter(params.lift[channel]);
    const gain = roundFilter(params.gain[channel]);
    const exponent = roundFilter(params.exponent[channel]);
    return `'clip((${gain}*pow(val/maxval,${exponent})+${lift})*maxval,0,maxval)'`;
  };
  return `lutrgb=r=${expr('r')}:g=${expr('g')}:b=${expr('b')}`;
}

function roundCss(value: number): string {
  return Number(value.toFixed(4)).toString();
}

function roundFilter(value: number): string {
  return value.toFixed(5);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}
