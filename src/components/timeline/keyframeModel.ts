import type { Clip, KeyframePoint } from '@/types';
import {
  getTransformComponents,
  keyframeComponentVisibilityKey,
  type TransformProperty,
} from '@/lib/components/transform';

export const KEYFRAME_TITLE_HEIGHT_PX = 18;
export const KEYFRAME_COMPONENT_ROW_HEIGHT_PX = 24;
export const KEYFRAME_PROPERTY_ROW_HEIGHT_PX = 30;

export type KeyframeSelection = {
  clipId: string;
  componentIndex: number;
  componentId: string;
  property: TransformProperty;
  keyframeId: string;
};

export type KeyframePropertyRow = {
  label: string;
  componentIndex: number;
  componentId: string;
  property: TransformProperty;
  points: KeyframePoint[];
};

export type SelectedKeyframeData = KeyframeSelection & KeyframePoint;

const PROPERTY_LABELS: Record<TransformProperty, string> = {
  offsetX: 'Offset X',
  offsetY: 'Offset Y',
  scale: 'Scale',
};

export function laneHeightForClip(visibleRows: number, totalComponents: number): number {
  if (totalComponents === 0) return 0;
  return KEYFRAME_TITLE_HEIGHT_PX +
    totalComponents * KEYFRAME_COMPONENT_ROW_HEIGHT_PX +
    visibleRows * KEYFRAME_PROPERTY_ROW_HEIGHT_PX;
}

export function laneHeightForRows(rows: KeyframePropertyRow[]): number {
  return laneHeightForClip(rows.length, new Set(rows.map((row) => row.componentId)).size);
}

export function getKeyframeProperties(clip: Clip, visibleComponentKeys?: Set<string>): KeyframePropertyRow[] {
  const transforms = getTransformComponents(clip);
  const properties: KeyframePropertyRow[] = [];
  transforms.forEach((component, index) => {
    if (visibleComponentKeys && !visibleComponentKeys.has(keyframeComponentVisibilityKey(clip.id, component.id))) return;
    (['offsetX', 'offsetY', 'scale'] as const).forEach((property) => {
      const points = component.data.keyframes[property];
      if (points.length === 0) return;
      properties.push({
        label: `Transform ${index + 1}.${PROPERTY_LABELS[property]}`,
        componentIndex: index,
        componentId: component.id,
        property,
        points,
      });
    });
  });
  return properties;
}

export function findSelectedKeyframe(clip: Clip | null, selectedKeyframe: KeyframeSelection | null): SelectedKeyframeData | null {
  if (!clip || !selectedKeyframe) return null;
  if (clip.id !== selectedKeyframe.clipId) return null;
  const row = getKeyframeProperties(clip).find((candidate) => (
    candidate.componentId === selectedKeyframe.componentId &&
    candidate.property === selectedKeyframe.property
  ));
  const point = row?.points.find((candidate) => candidate.id === selectedKeyframe.keyframeId);
  return point ? { ...selectedKeyframe, ...point } : null;
}
