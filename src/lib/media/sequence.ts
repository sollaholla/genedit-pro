import type { SequenceAssetData, SequenceMarker } from '@/types';

type SequenceReferenceOptions = {
  availableImageAssetIds?: Set<string>;
  characterTokensByAssetId?: Map<string, string>;
  characterAssetIds?: string[];
  startFrameAssetId?: string | null;
  maxImages?: number;
};

export type SequencePromptLine = {
  markerId: string | null;
  text: string;
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
  const addReferenceId = (assetId: string | null | undefined): boolean => {
    if (!assetId || ids.length >= maxImages) return false;
    if (assetId === options.startFrameAssetId) return false;
    if (ids.includes(assetId)) return false;
    if (options.availableImageAssetIds && !options.availableImageAssetIds.has(assetId)) return false;
    ids.push(assetId);
    return true;
  };
  for (const assetId of options.characterAssetIds ?? sequence.characterAssetIds ?? []) {
    if (ids.length >= maxImages) break;
    addReferenceId(assetId);
  }
  for (const marker of sortedSequenceMarkers(sequence)) {
    if (ids.length >= maxImages) break;
    addReferenceId(marker.imageAssetId);
  }
  return ids;
}

export function composeSequencePrompt(sequence: SequenceAssetData, options: SequenceReferenceOptions = {}): string {
  return composeSequencePromptLines(sequence, options).map((line) => line.text).join('\n');
}

export function composeSequencePromptLines(sequence: SequenceAssetData, options: SequenceReferenceOptions = {}): SequencePromptLine[] {
  const promptLines: SequencePromptLine[] = [];
  const overallPrompt = sequence.overallPrompt.trim();
  if (overallPrompt) {
    promptLines.push({ markerId: null, text: overallPrompt }, { markerId: null, text: '' });
  }
  const referenceTokenByAssetId = sequenceReferenceTokenMap(sequence, options);
  for (const marker of sortedSequenceMarkers(sequence)) {
    const referenceToken = marker.imageAssetId ? referenceTokenByAssetId.get(marker.imageAssetId) : undefined;
    const token = referenceToken ? ` @${referenceToken}` : '';
    const prompt = marker.prompt.trim() || 'Shot beat';
    const text = `[${formatSequenceTimestamp(marker.timeSec)}] ${prompt}${token}`;
    promptLines.push({ markerId: marker.id, text });
  }
  return promptLines;
}

function sequenceReferenceTokenMap(sequence: SequenceAssetData, options: SequenceReferenceOptions): Map<string, string> {
  const out = new Map<string, string>();
  if (options.startFrameAssetId) out.set(options.startFrameAssetId, 'start-frame');
  let imageIndex = 0;
  for (const assetId of sequenceReferenceAssetIds(sequence, options)) {
    const characterToken = options.characterTokensByAssetId?.get(assetId);
    if (characterToken) {
      out.set(assetId, characterToken);
      continue;
    }
    imageIndex += 1;
    out.set(assetId, `image${imageIndex}`);
  }
  return out;
}
