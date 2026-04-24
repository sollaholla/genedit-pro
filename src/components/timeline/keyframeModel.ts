import type { Clip, KeyframePoint } from '@/types';
import {
  getTransformComponents,
  transformPropertyRange,
  type TransformProperty,
  type TransformPropertyRange,
} from '@/lib/components/transform';

export type KeyframeSelection = {
  componentIndex: number;
  property: TransformProperty;
  keyframeId: string;
};

export type KeyframePropertyRow = {
  label: string;
  componentIndex: number;
  property: TransformProperty;
  points: KeyframePoint[];
  baseValue: number;
  range: TransformPropertyRange;
};

export type SelectedKeyframeData = KeyframeSelection & KeyframePoint;

const PROPERTY_LABELS: Record<TransformProperty, string> = {
  offsetX: 'Offset X',
  offsetY: 'Offset Y',
  scale: 'Scale',
};

export function laneHeightForClip(visibleRows: number, totalComponents: number): number {
  if (totalComponents === 0) return 0;
  return Math.min(260, 20 + totalComponents * 26 + visibleRows * 34);
}

export function getKeyframeProperties(clip: Clip): KeyframePropertyRow[] {
  const transforms = getTransformComponents(clip);
  const properties: KeyframePropertyRow[] = [];
  transforms.forEach((component, index) => {
    (['offsetX', 'offsetY', 'scale'] as const).forEach((property) => {
      const points = component.data.keyframes[property];
      const baseValue = component.data[property];
      properties.push({
        label: `Transform ${index + 1}.${PROPERTY_LABELS[property]}`,
        componentIndex: index,
        property,
        points,
        baseValue,
        range: transformPropertyRange(property, points, baseValue),
      });
    });
  });
  return properties;
}

export function findSelectedKeyframe(clip: Clip | null, selectedKeyframe: KeyframeSelection | null): SelectedKeyframeData | null {
  if (!clip || !selectedKeyframe) return null;
  const row = getKeyframeProperties(clip).find((candidate) => (
    candidate.componentIndex === selectedKeyframe.componentIndex &&
    candidate.property === selectedKeyframe.property
  ));
  const point = row?.points.find((candidate) => candidate.id === selectedKeyframe.keyframeId);
  return point ? { ...selectedKeyframe, ...point } : null;
}
