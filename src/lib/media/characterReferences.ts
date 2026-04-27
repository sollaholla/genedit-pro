import type { MediaAsset } from '@/types';

const RESERVED_REFERENCE_TOKENS = new Set(['start-frame', 'end-frame']);

export function isImageLikeAsset(asset: MediaAsset): boolean {
  return asset.kind === 'image' || asset.kind === 'character';
}

export function isReferenceImageAsset(asset: MediaAsset): boolean {
  return isImageLikeAsset(asset) && asset.generation?.status !== 'generating' && Boolean(asset.blobKey);
}

export function slugifyCharacterId(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  return slug || 'character';
}

export function isReservedCharacterId(value: string): boolean {
  const normalized = slugifyCharacterId(value);
  return RESERVED_REFERENCE_TOKENS.has(normalized) || /^(?:image|video)\d+$/i.test(normalized);
}

export function uniqueCharacterId(value: string, assets: MediaAsset[], currentAssetId?: string | null): string {
  const base = isReservedCharacterId(value) ? `${slugifyCharacterId(value)}-character` : slugifyCharacterId(value);
  const existing = new Set(assets
    .filter((asset) => asset.id !== currentAssetId && asset.kind === 'character' && asset.character?.characterId)
    .map((asset) => asset.character!.characterId.toLowerCase()));
  if (!existing.has(base.toLowerCase())) return base;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base}-${index}`;
    if (!existing.has(candidate.toLowerCase())) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

export function characterTokenForAsset(asset: MediaAsset): string | null {
  if (asset.kind !== 'character') return null;
  const characterId = asset.character?.characterId?.trim();
  return characterId ? `@${characterId}` : null;
}

export function extractPromptReferenceTokens(prompt: string): string[] {
  const tokens = new Set<string>();
  for (const match of prompt.matchAll(/@([a-z0-9][a-z0-9-]*)/gi)) {
    const token = match[1]?.toLowerCase();
    if (token) tokens.add(token);
  }
  return [...tokens];
}

export function resolveCharacterReferences(prompt: string, assets: MediaAsset[]): MediaAsset[] {
  const tokens = new Set(extractPromptReferenceTokens(prompt));
  if (tokens.size === 0) return [];
  return assets.filter((asset) => {
    if (asset.kind !== 'character' || !isReferenceImageAsset(asset)) return false;
    const characterId = asset.character?.characterId?.toLowerCase();
    return Boolean(characterId && tokens.has(characterId));
  });
}
