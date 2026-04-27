import type { SequenceAssetData, SequenceMarker } from '@/types';

type SequenceReferenceOptions = {
  availableImageAssetIds?: Set<string>;
  characterTokensByAssetId?: Map<string, string>;
  maxImages?: number;
};

export function sortedSequenceMarkers(sequence: SequenceAssetData): SequenceMarker[] {
  return [...sequence.markers].sort((a, b) => a.timeSec - b.timeSec);
}

export function formatSequenceTimestamp(timeSec: number): string {
  return `${timeSec.toFixed(1)}s`;
}

export function sequenceReferenceAssetIds(sequence: SequenceAssetData, options: SequenceReferenceOptions = {}): string[] {
  const ids: string[] = [];
  const maxImages = options.maxImages ?? Number.POSITIVE_INFINITY;
  for (const marker of sortedSequenceMarkers(sequence)) {
    if (ids.length >= maxImages) break;
    const assetId = marker.imageAssetId;
    if (!assetId) continue;
    if (options.availableImageAssetIds && !options.availableImageAssetIds.has(assetId)) continue;
    ids.push(assetId);
  }
  return ids;
}

export function composeSequencePrompt(sequence: SequenceAssetData, options: SequenceReferenceOptions = {}): string {
  const lines: string[] = [];
  const overallPrompt = sequence.overallPrompt.trim();
  if (overallPrompt) lines.push(overallPrompt, '');
  let referenceIndex = 0;
  const maxImages = options.maxImages ?? Number.POSITIVE_INFINITY;
  for (const marker of sortedSequenceMarkers(sequence)) {
    const hasImage = Boolean(
      marker.imageAssetId &&
      referenceIndex < maxImages &&
      (!options.availableImageAssetIds || options.availableImageAssetIds.has(marker.imageAssetId)),
    );
    const characterToken = marker.imageAssetId ? options.characterTokensByAssetId?.get(marker.imageAssetId) : undefined;
    if (hasImage) referenceIndex += 1;
    const token = hasImage ? ` @${characterToken ?? `image${referenceIndex}`}` : '';
    const prompt = marker.prompt.trim() || 'Shot beat';
    lines.push(`[${formatSequenceTimestamp(marker.timeSec)}] ${prompt}${token}`);
  }
  return lines.join('\n');
}
