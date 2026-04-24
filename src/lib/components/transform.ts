import { nanoid } from 'nanoid';
import type { Clip, ComponentInstance, TransformComponentData, KeyframePoint } from '@/types';

export function createDefaultTransformComponent(): ComponentInstance {
  return {
    id: nanoid(8),
    type: 'transform',
    data: {
      scale: 1,
      offsetX: 0,
      offsetY: 0,
      keyframes: {
        scale: [],
        offsetX: [],
        offsetY: [],
      },
    },
  };
}

export function getTransformComponents(clip: Clip): ComponentInstance[] {
  if (clip.components?.length) return clip.components.filter((c) => c.type === 'transform');
  if (clip.transform) {
    return [{
      id: 'legacy-transform',
      type: 'transform',
      data: {
        scale: clip.transform.scale ?? clip.scale ?? 1,
        offsetX: clip.transform.offsetX ?? 0,
        offsetY: clip.transform.offsetY ?? 0,
        keyframes: {
          scale: (clip.transform.keyframes ?? []).map((k) => ({ id: k.id, timeSec: k.timeSec, value: k.scale })),
          offsetX: (clip.transform.keyframes ?? []).map((k) => ({ id: k.id, timeSec: k.timeSec, value: k.offsetX })),
          offsetY: (clip.transform.keyframes ?? []).map((k) => ({ id: k.id, timeSec: k.timeSec, value: k.offsetY })),
        },
      },
    }];
  }
  return [];
}

function evalKeyframes(track: KeyframePoint[], t: number, fallback: number): number {
  if (!track.length) return fallback;
  const sorted = [...track].sort((a, b) => a.timeSec - b.timeSec);
  if (t <= sorted[0]!.timeSec) return sorted[0]!.value;
  const last = sorted[sorted.length - 1]!;
  if (t >= last.timeSec) return last.value;
  const nextIdx = sorted.findIndex((k) => k.timeSec >= t);
  const a = sorted[Math.max(0, nextIdx - 1)]!;
  const b = sorted[nextIdx]!;
  const span = Math.max(1e-6, b.timeSec - a.timeSec);
  const alpha = (t - a.timeSec) / span;
  return a.value + (b.value - a.value) * alpha;
}

export function resolveTransformAtTime(clip: Clip, timelineTimeSec: number) {
  const components = getTransformComponents(clip);
  let scale = 1;
  let offsetX = 0;
  let offsetY = 0;
  for (const component of components) {
    const data: TransformComponentData = component.data;
    const localTimeSec = Math.max(0, timelineTimeSec - clip.startSec);
    scale *= evalKeyframes(data.keyframes.scale, localTimeSec, data.scale);
    offsetX += evalKeyframes(data.keyframes.offsetX, localTimeSec, data.offsetX);
    offsetY += evalKeyframes(data.keyframes.offsetY, localTimeSec, data.offsetY);
  }
  return { scale, offsetX, offsetY };
}
