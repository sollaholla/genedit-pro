import { create } from 'zustand';
import { nanoid } from 'nanoid';
import type { GenerateRecipe, MediaAsset } from '@/types';
import { putBlob, deleteBlob, getBlob } from '@/lib/media/storage';
import { probe } from '@/lib/media/probe';
import { generateThumbnail } from '@/lib/media/thumbnail';

const ASSETS_KEY = 'genedit-pro:assets';
const FOLDERS_KEY = 'genedit-pro:folders';

export type MediaFolder = { id: string; name: string };

function loadAssets(): MediaAsset[] {
  try {
    const raw = localStorage.getItem(ASSETS_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as MediaAsset[];
  } catch {
    return [];
  }
}

function saveAssets(assets: MediaAsset[]) {
  try {
    localStorage.setItem(ASSETS_KEY, JSON.stringify(assets));
  } catch {
    // ignore
  }
}

type MediaState = {
  assets: MediaAsset[];
  folders: MediaFolder[];
  importing: boolean;
  importFiles: (files: File[]) => Promise<MediaAsset[]>;
  removeAsset: (id: string) => Promise<void>;
  renameAsset: (id: string, name: string) => void;
  objectUrlFor: (assetId: string) => Promise<string | null>;
  createFolder: (name: string) => void;
  addGeneratedAsset: (name: string, folderId?: string | null, estimatedCostUsd?: number) => string;
  updateGenerationProgress: (id: string, progress: number) => void;
  finalizeGeneratedAsset: (id: string) => void;
  finalizeGeneratedAssetWithBlob: (
    id: string,
    file: File,
    metadata?: {
      actualCostUsd?: number;
      provider?: string;
      providerArtifactUri?: string;
      providerArtifactExpiresAt?: number;
    },
  ) => Promise<void>;
  failGeneratedAsset: (id: string, actualCostUsd?: number) => void;
  saveRecipeAsset: (name: string, recipe: GenerateRecipe, existingId?: string | null) => string;
};

const urlCache = new Map<string, string>();

export const useMediaStore = create<MediaState>((set, get) => ({
  assets: loadAssets(),
  folders: (() => {
    try { return JSON.parse(localStorage.getItem(FOLDERS_KEY) || '[]') as MediaFolder[]; } catch { return []; }
  })(),
  importing: false,

  importFiles: async (files: File[]) => {
    set({ importing: true });
    const added: MediaAsset[] = [];
    for (const file of files) {
      try {
        const probed = await probe(file);
        const thumbnail = await generateThumbnail(file, probed.kind).catch(() => '');
        const asset: MediaAsset = {
          id: nanoid(10),
          name: file.name,
          kind: probed.kind,
          durationSec: probed.durationSec || 5,
          width: probed.width,
          height: probed.height,
          mimeType: file.type || 'application/octet-stream',
          blobKey: `blob_${nanoid(12)}`,
          thumbnailDataUrl: thumbnail || undefined,
          folderId: null,
          createdAt: Date.now(),
        };
        await putBlob(asset.blobKey, file, file.name);
        added.push(asset);
      } catch (err) {
        console.error('Failed to import file', file.name, err);
      }
    }
    const nextAssets = [...get().assets, ...added];
    saveAssets(nextAssets);
    set({ assets: nextAssets, importing: false });
    return added;
  },

  removeAsset: async (id) => {
    const asset = get().assets.find((a) => a.id === id);
    if (!asset) return;
    await deleteBlob(asset.blobKey).catch(() => undefined);
    const cached = urlCache.get(asset.id);
    if (cached) {
      URL.revokeObjectURL(cached);
      urlCache.delete(asset.id);
    }
    const next = get().assets.filter((a) => a.id !== id);
    saveAssets(next);
    set({ assets: next });
  },

  renameAsset: (id, name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const next = get().assets.map((a) => (a.id === id ? { ...a, name: trimmed } : a));
    saveAssets(next);
    set({ assets: next });
  },

  objectUrlFor: async (assetId) => {
    const cached = urlCache.get(assetId);
    if (cached) return cached;
    const asset = get().assets.find((a) => a.id === assetId);
    if (!asset) return null;
    const blob = await getBlob(asset.blobKey);
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    urlCache.set(assetId, url);
    return url;
  },

  createFolder: (name) => {
    const next = [...get().folders, { id: nanoid(8), name }];
    try { localStorage.setItem(FOLDERS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
    set({ folders: next });
  },

  addGeneratedAsset: (name, folderId = null, estimatedCostUsd) => {
    const id = nanoid(10);
    const asset: MediaAsset = {
      id,
      name,
      kind: 'video',
      durationSec: 8,
      mimeType: 'video/mp4',
      blobKey: '',
      folderId,
      generation: { status: 'generating' as const, progress: 0, estimatedCostUsd },
      createdAt: Date.now(),
    };
    const next = [...get().assets, asset];
    saveAssets(next);
    set({ assets: next });
    return id;
  },

  updateGenerationProgress: (id, progress) => {
    const next: MediaAsset[] = get().assets.map((a) => (a.id === id
      ? { ...a, generation: { status: 'generating' as const, progress: Math.max(0, Math.min(100, progress)) } }
      : a));
    saveAssets(next);
    set({ assets: next });
  },

  finalizeGeneratedAsset: (id) => {
    const next: MediaAsset[] = get().assets.map((a) => (a.id === id
      ? { ...a, generation: { status: 'done' as const, progress: 100 } }
      : a));
    saveAssets(next);
    set({ assets: next });
  },

  finalizeGeneratedAssetWithBlob: async (id, file, metadata = {}) => {
    const probed = await probe(file);
    const thumbnail = await generateThumbnail(file, probed.kind).catch(() => '');
    const blobKey = `blob_${nanoid(12)}`;
    await putBlob(blobKey, file, file.name);

    const next: MediaAsset[] = get().assets.map((a) => (a.id === id
      ? {
          ...a,
          name: file.name,
          kind: probed.kind,
          durationSec: probed.durationSec || a.durationSec,
          width: probed.width,
          height: probed.height,
          mimeType: file.type || a.mimeType,
          blobKey,
          thumbnailDataUrl: thumbnail || a.thumbnailDataUrl,
          generation: {
            status: 'done' as const,
            progress: 100,
            estimatedCostUsd: a.generation?.estimatedCostUsd,
            actualCostUsd: metadata.actualCostUsd ?? a.generation?.estimatedCostUsd,
            provider: metadata.provider ?? a.generation?.provider,
            providerArtifactUri: metadata.providerArtifactUri ?? a.generation?.providerArtifactUri,
            providerArtifactExpiresAt: metadata.providerArtifactExpiresAt ?? a.generation?.providerArtifactExpiresAt,
          },
        }
      : a));
    saveAssets(next);
    set({ assets: next });
  },

  failGeneratedAsset: (id, actualCostUsd) => {
    const next: MediaAsset[] = get().assets.map((a) => (a.id === id
      ? {
          ...a,
          generation: {
            status: 'error' as const,
            progress: 0,
            estimatedCostUsd: a.generation?.estimatedCostUsd,
            actualCostUsd: actualCostUsd ?? a.generation?.estimatedCostUsd,
          },
        }
      : a));
    saveAssets(next);
    set({ assets: next });
  },

  saveRecipeAsset: (name, recipe, existingId = null) => {
    if (existingId) {
      const next = get().assets.map((a) => (a.id === existingId ? { ...a, name, recipe, kind: 'recipe' as const, mimeType: 'application/x-genedit-recipe' } : a));
      saveAssets(next);
      set({ assets: next });
      return existingId;
    }
    const id = nanoid(10);
    const asset: MediaAsset = {
      id,
      name,
      kind: 'recipe',
      durationSec: 0,
      mimeType: 'application/x-genedit-recipe',
      blobKey: '',
      recipe,
      createdAt: Date.now(),
    };
    const next = [...get().assets, asset];
    saveAssets(next);
    set({ assets: next });
    return id;
  },
}));
