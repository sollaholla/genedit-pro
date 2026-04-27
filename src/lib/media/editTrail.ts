import type { EditTrailIteration, EditTrailTransform, MediaAsset } from '@/types';
import { isImageLikeAsset } from '@/lib/media/characterReferences';

export const DEFAULT_EDIT_TRAIL_TRANSFORM: EditTrailTransform = {
  scale: 1,
  offsetX: 0,
  offsetY: 0,
};

export function isEditableMedia(asset: MediaAsset): boolean {
  return (isImageLikeAsset(asset) || asset.kind === 'video') && asset.generation?.status !== 'generating';
}

export function activeEditIteration(asset: MediaAsset): EditTrailIteration | null {
  if (!asset.editTrail) return null;
  return asset.editTrail.iterations.find((iteration) => iteration.id === asset.editTrail?.activeIterationId) ?? null;
}

export function activeEditTransform(asset: MediaAsset): EditTrailTransform {
  return activeEditIteration(asset)?.transform ?? DEFAULT_EDIT_TRAIL_TRANSFORM;
}

export function hasActiveMediaTransform(asset: MediaAsset): boolean {
  const transform = activeEditTransform(asset);
  return (
    Math.abs(transform.scale - 1) > 0.001 ||
    Math.abs(transform.offsetX) > 0.001 ||
    Math.abs(transform.offsetY) > 0.001
  );
}
