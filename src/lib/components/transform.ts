import { nanoid } from 'nanoid';
import type { Clip, ComponentInstance, TransformComponentData, KeyframePoint } from '@/types';

export type TransformProperty = 'scale' | 'offsetX' | 'offsetY';

export type TransformTarget = {
  componentId?: string | null;
  componentIndex?: number | null;
};

export const KEYFRAME_EPS_SEC = 1 / 120;

export function keyframeComponentVisibilityKey(clipId: string, componentId: string): string {
  return `${clipId}:${componentId}`;
}

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

export function findTransformComponentIndex(clip: Clip, target: TransformTarget): number {
  const components = getTransformComponents(clip);
  if (components.length === 0) return -1;
  if (target.componentId) {
    const byId = components.findIndex((component) => component.id === target.componentId);
    if (byId >= 0) return byId;
  }
  if (typeof target.componentIndex === 'number') {
    return Math.max(0, Math.min(components.length - 1, target.componentIndex));
  }
  return components.length - 1;
}

export function getActiveTransformComponent(clip: Clip, componentId?: string | null): ComponentInstance | null {
  const components = getTransformComponents(clip);
  if (components.length === 0) return null;
  return components.find((component) => component.id === componentId) ?? components[components.length - 1]!;
}

export function upsertKeyframeValue(
  track: KeyframePoint[],
  timeSec: number,
  value: number,
  epsSec = KEYFRAME_EPS_SEC,
): KeyframePoint[] {
  let matched = false;
  const updated = track.map((k) => {
    if (Math.abs(k.timeSec - timeSec) <= epsSec) {
      matched = true;
      return { ...k, timeSec, value };
    }
    return k;
  });
  return matched ? updated : [...updated, { id: nanoid(8), timeSec, value }];
}

export function updateTransformKeyframe(
  clip: Clip,
  target: TransformTarget & { property: TransformProperty; keyframeId: string },
  patch: Partial<Pick<KeyframePoint, 'timeSec' | 'value'>>,
): Clip {
  const components = getTransformComponents(clip);
  const componentIndex = findTransformComponentIndex(clip, target);
  if (componentIndex < 0) return clip;
  return {
    ...clip,
    components: components.map((component, idx) => {
      if (idx !== componentIndex) return component;
      const points = component.data.keyframes[target.property].map((point) => (
        point.id === target.keyframeId ? { ...point, ...patch } : point
      ));
      return {
        ...component,
        data: {
          ...component.data,
          keyframes: { ...component.data.keyframes, [target.property]: points },
        },
      };
    }),
  };
}

export function moveTransformKeyframeGroup(
  clip: Clip,
  targets: Array<TransformTarget & { property: TransformProperty; keyframeId: string }>,
  timeSec: number,
): Clip {
  const components = getTransformComponents(clip);
  if (targets.length === 0 || components.length === 0) return clip;
  return {
    ...clip,
    components: components.map((component, idx) => {
      const componentTargets = targets.filter((target) => {
        if (target.componentId) return target.componentId === component.id;
        return target.componentIndex === idx;
      });
      if (componentTargets.length === 0) return component;

      const keyframes = { ...component.data.keyframes };
      (['scale', 'offsetX', 'offsetY'] as const).forEach((property) => {
        const ids = new Set(
          componentTargets
            .filter((target) => target.property === property)
            .map((target) => target.keyframeId),
        );
        if (ids.size === 0) return;
        keyframes[property] = keyframes[property].map((point) => (
          ids.has(point.id) ? { ...point, timeSec } : point
        ));
      });

      return {
        ...component,
        data: {
          ...component.data,
          keyframes,
        },
      };
    }),
  };
}

export function removeTransformKeyframe(
  clip: Clip,
  target: TransformTarget & { property: TransformProperty; keyframeId: string },
): Clip {
  const components = getTransformComponents(clip);
  const componentIndex = findTransformComponentIndex(clip, target);
  if (componentIndex < 0) return clip;
  return {
    ...clip,
    components: components.map((component, idx) => {
      if (idx !== componentIndex) return component;
      return {
        ...component,
        data: {
          ...component.data,
          keyframes: {
            ...component.data.keyframes,
            [target.property]: component.data.keyframes[target.property].filter((point) => point.id !== target.keyframeId),
          },
        },
      };
    }),
  };
}

export function removeTransformKeyframeGroup(
  clip: Clip,
  target: TransformTarget & { property: TransformProperty; keyframeId: string },
  epsSec = KEYFRAME_EPS_SEC,
): Clip {
  const components = getTransformComponents(clip);
  const componentIndex = findTransformComponentIndex(clip, target);
  if (componentIndex < 0) return clip;
  const component = components[componentIndex]!;
  const selectedPoint = component.data.keyframes[target.property].find((point) => point.id === target.keyframeId);
  if (!selectedPoint) return removeTransformKeyframe(clip, target);

  return {
    ...clip,
    components: components.map((candidate, idx) => {
      if (idx !== componentIndex) return candidate;
      return {
        ...candidate,
        data: {
          ...candidate.data,
          keyframes: {
            scale: candidate.data.keyframes.scale.filter((point) => Math.abs(point.timeSec - selectedPoint.timeSec) > epsSec),
            offsetX: candidate.data.keyframes.offsetX.filter((point) => Math.abs(point.timeSec - selectedPoint.timeSec) > epsSec),
            offsetY: candidate.data.keyframes.offsetY.filter((point) => Math.abs(point.timeSec - selectedPoint.timeSec) > epsSec),
          },
        },
      };
    }),
  };
}

export function setTransformPropertyAtTime(
  clip: Clip,
  target: TransformTarget & { property: TransformProperty },
  timeSec: number,
  value: number,
  options: { forceKeyframe?: boolean } = {},
): Clip {
  const components = getTransformComponents(clip);
  const componentIndex = findTransformComponentIndex(clip, target);
  if (componentIndex < 0) return clip;
  const localTimeSec = Math.max(0, timeSec - clip.startSec);
  return {
    ...clip,
    components: components.map((component, idx) => {
      if (idx !== componentIndex) return component;
      const existing = component.data.keyframes[target.property];
      const shouldWriteKeyframe = options.forceKeyframe || existing.length > 0;
      return {
        ...component,
        data: {
          ...component.data,
          [target.property]: value,
          keyframes: {
            ...component.data.keyframes,
            [target.property]: shouldWriteKeyframe
              ? upsertKeyframeValue(existing, localTimeSec, value)
              : existing,
          },
        },
      };
    }),
  };
}

export function addTransformKeyframeAtTime(
  clip: Clip,
  target: TransformTarget & { property: TransformProperty },
  timeSec: number,
): Clip {
  const components = getTransformComponents(clip);
  const componentIndex = findTransformComponentIndex(clip, target);
  if (componentIndex < 0) return clip;
  const component = components[componentIndex]!;
  const value = resolveTransformComponentAtTime(clip, component, timeSec)[target.property];
  return setTransformPropertyAtTime(clip, target, timeSec, value, { forceKeyframe: true });
}

export function reorderTransformComponents(clip: Clip, fromIndex: number, toIndex: number): Clip {
  const components = getTransformComponents(clip);
  if (components.length === 0) return clip;
  const from = Math.max(0, Math.min(components.length - 1, fromIndex));
  const to = Math.max(0, Math.min(components.length - 1, toIndex));
  if (from === to) return clip;
  const next = [...components];
  const [moved] = next.splice(from, 1);
  if (!moved) return clip;
  next.splice(to, 0, moved);
  return { ...clip, components: next };
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

export function resolveTransformComponentAtTime(
  clip: Clip,
  component: ComponentInstance,
  timelineTimeSec: number,
) {
  const data: TransformComponentData = component.data;
  const localTimeSec = Math.max(0, timelineTimeSec - clip.startSec);
  return {
    scale: evalKeyframes(data.keyframes.scale, localTimeSec, data.scale),
    offsetX: evalKeyframes(data.keyframes.offsetX, localTimeSec, data.offsetX),
    offsetY: evalKeyframes(data.keyframes.offsetY, localTimeSec, data.offsetY),
  };
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
