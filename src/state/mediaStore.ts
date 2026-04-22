import { create } from 'zustand';
import { nanoid } from 'nanoid';
import type { MediaAsset } from '@/types';
import { putBlob, deleteBlob, getBlob } from '@/lib/media/storage';
import { probe } from '@/lib/media/probe';
import { generateThumbnail } from '@/lib/media/thumbnail';

const ASSETS_KEY = 'genedit-pro:assets';

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
  importing: boolean;
  importFiles: (files: File[]) => Promise<MediaAsset[]>;
  removeAsset: (id: string) => Promise<void>;
  objectUrlFor: (assetId: string) => Promise<string | null>;
};

const urlCache = new Map<string, string>();

export const useMediaStore = create<MediaState>((set, get) => ({
  assets: loadAssets(),
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
}));
