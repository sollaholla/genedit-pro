import type { MediaAsset, MediaKind, ReferenceAssetData, ReferenceAssetKind } from '@/types';

const RESERVED_REFERENCE_TOKENS = new Set(['start-frame', 'end-frame']);
const REFERENCE_ASSET_KINDS = new Set<MediaKind>(['character', 'object', 'environment']);

export function isReferenceAssetKind(kind: MediaKind): kind is ReferenceAssetKind {
  return REFERENCE_ASSET_KINDS.has(kind);
}

export function isImageLikeAsset(asset: MediaAsset): boolean {
  return asset.kind === 'image' || isReferenceAssetKind(asset.kind);
}

export function isReferenceImageAsset(asset: MediaAsset): boolean {
  return isImageLikeAsset(asset) && asset.generation?.status !== 'generating' && Boolean(asset.blobKey);
}

export function referenceDataForAsset(asset: MediaAsset): ReferenceAssetData | null {
  if (!isReferenceAssetKind(asset.kind)) return null;
  if (asset.reference?.referenceId) {
    return {
      ...asset.reference,
      referenceKind: asset.reference.referenceKind ?? asset.kind,
    };
  }
  if (asset.kind === 'character' && asset.character?.characterId) {
    return {
      ...asset.character,
      referenceId: asset.character.referenceId || asset.character.characterId,
      referenceKind: 'character',
    };
  }
  return null;
}

export function slugifyReferenceId(value: string, fallback = 'reference'): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  return slug || fallback;
}

export function slugifyCharacterId(value: string): string {
  return slugifyReferenceId(value, 'character');
}

export function isReservedReferenceId(value: string): boolean {
  const normalized = slugifyReferenceId(value);
  return RESERVED_REFERENCE_TOKENS.has(normalized) || /^(?:image|video)\d+$/i.test(normalized);
}

export function isReservedCharacterId(value: string): boolean {
  return isReservedReferenceId(value);
}

export function uniqueReferenceId(
  value: string,
  assets: MediaAsset[],
  referenceKind: ReferenceAssetKind,
  currentAssetId?: string | null,
): string {
  const slug = slugifyReferenceId(value, referenceKind);
  const base = isReservedReferenceId(slug) ? `${slug}-${referenceKind}` : slug;
  const existing = new Set(assets
    .filter((asset) => asset.id !== currentAssetId && isReferenceAssetKind(asset.kind))
    .map(referenceDataForAsset)
    .filter((data): data is ReferenceAssetData => Boolean(data?.referenceId))
    .map((data) => data.referenceId.toLowerCase()));
  if (!existing.has(base.toLowerCase())) return base;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base}-${index}`;
    if (!existing.has(candidate.toLowerCase())) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

export function uniqueCharacterId(value: string, assets: MediaAsset[], currentAssetId?: string | null): string {
  return uniqueReferenceId(value, assets, 'character', currentAssetId);
}

export function referenceTokenForAsset(asset: MediaAsset): string | null {
  const referenceId = referenceDataForAsset(asset)?.referenceId?.trim();
  return referenceId ? `@${referenceId}` : null;
}

export function characterTokenForAsset(asset: MediaAsset): string | null {
  if (asset.kind !== 'character') return null;
  return referenceTokenForAsset(asset);
}

export function extractPromptReferenceTokens(prompt: string): string[] {
  const tokens = new Set<string>();
  for (const match of prompt.matchAll(/@([a-z0-9][a-z0-9-]*)/gi)) {
    const token = match[1]?.toLowerCase();
    if (token) tokens.add(token);
  }
  return [...tokens];
}

export function resolvePromptReferences(prompt: string, assets: MediaAsset[]): MediaAsset[] {
  const tokens = new Set(extractPromptReferenceTokens(prompt));
  if (tokens.size === 0) return [];
  return assets.filter((asset) => {
    if (!isReferenceAssetKind(asset.kind) || !isReferenceImageAsset(asset)) return false;
    const referenceId = referenceDataForAsset(asset)?.referenceId?.toLowerCase();
    return Boolean(referenceId && tokens.has(referenceId));
  });
}

export function resolveCharacterReferences(prompt: string, assets: MediaAsset[]): MediaAsset[] {
  return resolvePromptReferences(prompt, assets);
}
