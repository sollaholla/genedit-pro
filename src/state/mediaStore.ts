import { create } from 'zustand';
import { nanoid } from 'nanoid';
import type { EditTrail, EditTrailIteration, EditTrailTransform, GenerateRecipe, MediaAsset, SequenceAssetData } from '@/types';
import type { GenerationErrorType } from '@/lib/videoGeneration/errors';
import { activeEditIteration, DEFAULT_EDIT_TRAIL_TRANSFORM } from '@/lib/media/editTrail';
import { putBlob, deleteBlob, getBlob } from '@/lib/media/storage';
import { probe } from '@/lib/media/probe';
import { generateThumbnail } from '@/lib/media/thumbnail';
import { useProjectStore } from '@/state/projectStore';

const LEGACY_ASSETS_KEY = 'genedit-pro:assets';
const LEGACY_FOLDERS_KEY = 'genedit-pro:folders';
const PROJECT_MEDIA_MIGRATED_KEY = 'genedit-pro:projects:media-migrated';
const PROJECT_MEDIA_PREFIX = 'genedit-pro:projects:media:';

export type MediaFolder = { id: string; name: string };

function projectAssetsKey(projectId: string): string {
  return `${PROJECT_MEDIA_PREFIX}${projectId}:assets`;
}

function projectFoldersKey(projectId: string): string {
  return `${PROJECT_MEDIA_PREFIX}${projectId}:folders`;
}

function currentProjectId(): string {
  return useProjectStore.getState().project.id;
}

function ensureLegacyMediaMigrated(projectId: string) {
  if (localStorage.getItem(PROJECT_MEDIA_MIGRATED_KEY) === 'true') return;
  try {
    if (localStorage.getItem(projectAssetsKey(projectId)) === null) {
      localStorage.setItem(projectAssetsKey(projectId), localStorage.getItem(LEGACY_ASSETS_KEY) ?? '[]');
    }
    if (localStorage.getItem(projectFoldersKey(projectId)) === null) {
      localStorage.setItem(projectFoldersKey(projectId), localStorage.getItem(LEGACY_FOLDERS_KEY) ?? '[]');
    }
    localStorage.setItem(PROJECT_MEDIA_MIGRATED_KEY, 'true');
  } catch {
    // ignore storage failures
  }
}

function loadAssets(projectId: string): MediaAsset[] {
  ensureLegacyMediaMigrated(projectId);
  try {
    const raw = localStorage.getItem(projectAssetsKey(projectId));
    if (!raw) return [];
    return JSON.parse(raw) as MediaAsset[];
  } catch {
    return [];
  }
}

function loadFolders(projectId: string): MediaFolder[] {
  ensureLegacyMediaMigrated(projectId);
  try {
    return JSON.parse(localStorage.getItem(projectFoldersKey(projectId)) || '[]') as MediaFolder[];
  } catch {
    return [];
  }
}

function saveAssets(assets: MediaAsset[], projectId: string) {
  try {
    localStorage.setItem(projectAssetsKey(projectId), JSON.stringify(assets));
  } catch {
    // ignore
  }
}

function saveFolders(folders: MediaFolder[], projectId: string) {
  try {
    localStorage.setItem(projectFoldersKey(projectId), JSON.stringify(folders));
  } catch {
    // ignore
  }
}

type MediaState = {
  activeProjectId: string;
  assets: MediaAsset[];
  folders: MediaFolder[];
  importing: boolean;
  setActiveProject: (projectId: string) => void;
  importFiles: (files: File[], folderId?: string | null) => Promise<MediaAsset[]>;
  removeAsset: (id: string) => Promise<void>;
  renameAsset: (id: string, name: string) => void;
  moveAssetToFolder: (id: string, folderId: string | null) => void;
  objectUrlFor: (assetId: string) => Promise<string | null>;
  ensureEditTrail: (assetId: string) => void;
  addEditTrailIteration: (
    assetId: string,
    file: File | null,
    transform: EditTrailTransform,
    thumbnailDataUrl?: string,
  ) => Promise<void>;
  saveEditTrailIteration: (
    assetId: string,
    file: File | null,
    transform: EditTrailTransform,
    thumbnailDataUrl?: string,
  ) => Promise<void>;
  setActiveEditTrailIteration: (assetId: string, iterationId: string) => void;
  undoEditTrail: (assetId: string) => Promise<void>;
  createFolder: (name: string) => void;
  addGeneratedAsset: (name: string, folderId?: string | null, estimatedCostUsd?: number, recipe?: GenerateRecipe) => string;
  updateGenerationProgress: (id: string, progress: number) => void;
  updateGenerationTask: (
    id: string,
    metadata: {
      provider?: string;
      providerTaskId?: string;
      providerTaskEndpoint?: string;
      providerTaskStatus?: string;
      providerTaskCreatedAt?: number;
    },
  ) => void;
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
  failGeneratedAsset: (
    id: string,
    failure?: {
      actualCostUsd?: number;
      errorMessage?: string;
      errorType?: GenerationErrorType;
    },
  ) => void;
  saveRecipeAsset: (name: string, recipe: GenerateRecipe, existingId?: string | null) => string;
  createSequenceAsset: (folderId?: string | null) => string;
  updateSequenceAsset: (id: string, sequence: SequenceAssetData) => void;
};

const urlCache = new Map<string, { blobKey: string; url: string }>();
const generatedAssetProjectIds = new Map<string, string>();

function revokeCachedUrl(assetId: string) {
  const cached = urlCache.get(assetId);
  if (!cached) return;
  URL.revokeObjectURL(cached.url);
  urlCache.delete(assetId);
}

function revokeAllCachedUrls() {
  for (const cached of urlCache.values()) URL.revokeObjectURL(cached.url);
  urlCache.clear();
}

function projectIdForAssetMutation(state: MediaState, assetId: string): string {
  if (state.assets.some((asset) => asset.id === assetId)) return state.activeProjectId;
  return generatedAssetProjectIds.get(assetId) ?? state.activeProjectId;
}

function updateAssetsForProject(
  get: () => MediaState,
  set: (patch: Partial<MediaState>) => void,
  projectId: string,
  updater: (assets: MediaAsset[]) => MediaAsset[],
): MediaAsset[] {
  const state = get();
  const baseAssets = state.activeProjectId === projectId ? state.assets : loadAssets(projectId);
  const next = updater(baseAssets);
  saveAssets(next, projectId);
  if (get().activeProjectId === projectId) set({ assets: next });
  return next;
}

function activeBlobKey(asset: MediaAsset): string {
  return activeEditIteration(asset)?.blobKey ?? asset.blobKey;
}

function originalIterationFor(asset: MediaAsset): EditTrailIteration {
  return {
    id: nanoid(10),
    label: 'Original',
    source: 'original',
    blobKey: asset.blobKey,
    thumbnailDataUrl: asset.thumbnailDataUrl,
    mimeType: asset.mimeType,
    width: asset.width,
    height: asset.height,
    durationSec: asset.durationSec,
    transform: DEFAULT_EDIT_TRAIL_TRANSFORM,
    createdAt: asset.createdAt,
  };
}

function withEditTrail(asset: MediaAsset): MediaAsset & { editTrail: EditTrail } {
  if (asset.editTrail?.iterations.length) return asset as MediaAsset & { editTrail: EditTrail };
  const original = originalIterationFor(asset);
  return {
    ...asset,
    editTrail: {
      activeIterationId: original.id,
      iterations: [original],
    },
  };
}

function applyIterationToAsset(asset: MediaAsset, iteration: EditTrailIteration): MediaAsset {
  return {
    ...asset,
    blobKey: iteration.blobKey,
    thumbnailDataUrl: iteration.thumbnailDataUrl || asset.thumbnailDataUrl,
    mimeType: iteration.mimeType,
    width: iteration.width,
    height: iteration.height,
    durationSec: iteration.durationSec,
  };
}

async function buildManualEditIteration(
  base: MediaAsset & { editTrail: EditTrail },
  file: File | null,
  transform: EditTrailTransform,
  thumbnailDataUrl: string | undefined,
  options: {
    id?: string;
    label: string;
    createdAt?: number;
  },
): Promise<EditTrailIteration> {
  if (file) {
    const probed = await probe(file);
    const thumbnail = await generateThumbnail(file, probed.kind).catch(() => '');
    const blobKey = `blob_${nanoid(12)}`;
    await putBlob(blobKey, file, file.name);
    return {
      id: options.id ?? nanoid(10),
      label: options.label,
      source: 'manual',
      blobKey,
      thumbnailDataUrl: thumbnail || thumbnailDataUrl,
      mimeType: file.type || base.mimeType,
      width: probed.width ?? base.width,
      height: probed.height ?? base.height,
      durationSec: probed.durationSec || base.durationSec,
      transform,
      createdAt: options.createdAt ?? Date.now(),
    };
  }

  return {
    id: options.id ?? nanoid(10),
    label: options.label,
    source: 'manual',
    blobKey: activeBlobKey(base),
    thumbnailDataUrl: thumbnailDataUrl || base.thumbnailDataUrl,
    mimeType: base.mimeType,
    width: base.width,
    height: base.height,
    durationSec: base.durationSec,
    transform,
    createdAt: options.createdAt ?? Date.now(),
  };
}

const initialMediaProjectId = currentProjectId();

export const useMediaStore = create<MediaState>((set, get) => ({
  activeProjectId: initialMediaProjectId,
  assets: loadAssets(initialMediaProjectId),
  folders: loadFolders(initialMediaProjectId),
  importing: false,

  setActiveProject: (projectId) => {
    if (get().activeProjectId === projectId) return;
    revokeAllCachedUrls();
    set({
      activeProjectId: projectId,
      assets: loadAssets(projectId),
      folders: loadFolders(projectId),
      importing: false,
    });
  },

  importFiles: async (files: File[], folderId = null) => {
    set({ importing: true });
    const projectId = get().activeProjectId;
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
          folderId,
          createdAt: Date.now(),
        };
        await putBlob(asset.blobKey, file, file.name);
        added.push(asset);
      } catch (err) {
        console.error('Failed to import file', file.name, err);
      }
    }
    const baseAssets = get().activeProjectId === projectId ? get().assets : loadAssets(projectId);
    const nextAssets = [...baseAssets, ...added];
    saveAssets(nextAssets, projectId);
    if (get().activeProjectId === projectId) set({ assets: nextAssets, importing: false });
    else set({ importing: false });
    return added;
  },

  removeAsset: async (id) => {
    const asset = get().assets.find((a) => a.id === id);
    if (!asset) return;
    const blobKeys = new Set([
      asset.blobKey,
      ...(asset.editTrail?.iterations.map((iteration) => iteration.blobKey) ?? []),
    ].filter(Boolean));
    await Promise.all([...blobKeys].map((blobKey) => deleteBlob(blobKey).catch(() => undefined)));
    revokeCachedUrl(asset.id);
    const next = get().assets.filter((a) => a.id !== id);
    saveAssets(next, get().activeProjectId);
    set({ assets: next });
  },

  renameAsset: (id, name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const next = get().assets.map((a) => (a.id === id ? { ...a, name: trimmed } : a));
    saveAssets(next, get().activeProjectId);
    set({ assets: next });
  },

  moveAssetToFolder: (id, folderId) => {
    const next = get().assets.map((a) => (a.id === id ? { ...a, folderId } : a));
    saveAssets(next, get().activeProjectId);
    set({ assets: next });
  },

  objectUrlFor: async (assetId) => {
    const cached = urlCache.get(assetId);
    const asset = get().assets.find((a) => a.id === assetId);
    if (!asset) return null;
    const blobKey = activeBlobKey(asset);
    if (cached && cached.blobKey === blobKey) return cached.url;
    if (cached) revokeCachedUrl(assetId);
    const blob = await getBlob(blobKey);
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    urlCache.set(assetId, { blobKey, url });
    return url;
  },

  ensureEditTrail: (assetId) => {
    let changed = false;
    const next = get().assets.map((asset) => {
      if (asset.id !== assetId || asset.editTrail?.iterations.length || !asset.blobKey) return asset;
      changed = true;
      return withEditTrail(asset);
    });
    if (!changed) return;
    saveAssets(next, get().activeProjectId);
    set({ assets: next });
  },

  addEditTrailIteration: async (assetId, file, transform, thumbnailDataUrl) => {
    const asset = get().assets.find((item) => item.id === assetId);
    if (!asset || !asset.blobKey || (asset.kind !== 'image' && asset.kind !== 'video')) return;

    const base = withEditTrail(asset);
    const label = `Edit ${base.editTrail.iterations.length}`;
    const iteration = await buildManualEditIteration(base, file, transform, thumbnailDataUrl, { label });

    revokeCachedUrl(assetId);
    const next = get().assets.map((item) => {
      if (item.id !== assetId) return item;
      const trailed = withEditTrail(item);
      const editTrail = {
        activeIterationId: iteration.id,
        iterations: [...trailed.editTrail.iterations, iteration],
      };
      return applyIterationToAsset({ ...trailed, editTrail }, iteration);
    });
    saveAssets(next, get().activeProjectId);
    set({ assets: next });
  },

  saveEditTrailIteration: async (assetId, file, transform, thumbnailDataUrl) => {
    const asset = get().assets.find((item) => item.id === assetId);
    if (!asset || !asset.blobKey || (asset.kind !== 'image' && asset.kind !== 'video')) return;

    const base = withEditTrail(asset);
    const active = base.editTrail.iterations.find((iteration) => iteration.id === base.editTrail.activeIterationId);
    if (!active || active.source === 'original') {
      await get().addEditTrailIteration(assetId, file, transform, thumbnailDataUrl);
      return;
    }

    const iteration = await buildManualEditIteration(base, file, transform, thumbnailDataUrl, {
      id: active.id,
      label: active.label,
      createdAt: Date.now(),
    });
    const replacedBlobKey = active.blobKey;

    revokeCachedUrl(assetId);
    const next = get().assets.map((item) => {
      if (item.id !== assetId) return item;
      const trailed = withEditTrail(item);
      const editTrail = {
        activeIterationId: iteration.id,
        iterations: trailed.editTrail.iterations.map((candidate) => (candidate.id === iteration.id ? iteration : candidate)),
      };
      return applyIterationToAsset({ ...trailed, editTrail }, iteration);
    });
    saveAssets(next, get().activeProjectId);
    set({ assets: next });

    const stillUsed = next
      .find((item) => item.id === assetId)
      ?.editTrail?.iterations.some((candidate) => candidate.blobKey === replacedBlobKey);
    if (replacedBlobKey !== iteration.blobKey && !stillUsed) {
      await deleteBlob(replacedBlobKey).catch(() => undefined);
    }
  },

  setActiveEditTrailIteration: (assetId, iterationId) => {
    const asset = get().assets.find((item) => item.id === assetId);
    if (!asset?.editTrail || asset.editTrail.activeIterationId === iterationId) return;
    const iteration = asset.editTrail.iterations.find((candidate) => candidate.id === iterationId);
    if (!iteration) return;

    revokeCachedUrl(assetId);
    const next = get().assets.map((item) => {
      if (item.id !== assetId) return item;
      const trailed = withEditTrail(item);
      const editTrail = {
        ...trailed.editTrail,
        activeIterationId: iteration.id,
      };
      return applyIterationToAsset({ ...trailed, editTrail }, iteration);
    });
    saveAssets(next, get().activeProjectId);
    set({ assets: next });
  },

  undoEditTrail: async (assetId) => {
    const asset = get().assets.find((item) => item.id === assetId);
    if (!asset?.editTrail || asset.editTrail.iterations.length <= 1) return;
    const iterations = asset.editTrail.iterations;
    const activeIndex = iterations.findIndex((iteration) => iteration.id === asset.editTrail?.activeIterationId);
    if (activeIndex <= 0) return;
    const removed = iterations[activeIndex]!;
    const remaining = iterations.filter((_, index) => index !== activeIndex);
    const nextActive = remaining[Math.max(0, activeIndex - 1)]!;
    const remainingBlobKeys = new Set(remaining.map((iteration) => iteration.blobKey));
    if (!remainingBlobKeys.has(removed.blobKey)) {
      await deleteBlob(removed.blobKey).catch(() => undefined);
    }
    revokeCachedUrl(assetId);
    const next = get().assets.map((item) => {
      if (item.id !== assetId) return item;
      const editTrail = {
        activeIterationId: nextActive.id,
        iterations: remaining,
      };
      return applyIterationToAsset({ ...item, editTrail }, nextActive);
    });
    saveAssets(next, get().activeProjectId);
    set({ assets: next });
  },

  createFolder: (name) => {
    const next = [...get().folders, { id: nanoid(8), name }];
    saveFolders(next, get().activeProjectId);
    set({ folders: next });
  },

  addGeneratedAsset: (name, folderId = null, estimatedCostUsd, recipe) => {
    const projectId = get().activeProjectId;
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
      recipe,
      createdAt: Date.now(),
    };
    const next = [...get().assets, asset];
    generatedAssetProjectIds.set(id, projectId);
    saveAssets(next, projectId);
    set({ assets: next });
    return id;
  },

  updateGenerationProgress: (id, progress) => {
    const projectId = projectIdForAssetMutation(get(), id);
    updateAssetsForProject(get, set, projectId, (assets) => assets.map((a) => (a.id === id
      ? { ...a, generation: { ...(a.generation ?? {}), status: 'generating' as const, progress: Math.max(0, Math.min(100, progress)) } }
      : a)));
  },

  updateGenerationTask: (id, metadata) => {
    const projectId = projectIdForAssetMutation(get(), id);
    updateAssetsForProject(get, set, projectId, (assets) => assets.map((a) => (a.id === id
      ? {
          ...a,
          generation: {
            ...(a.generation ?? { status: 'generating' as const }),
            status: a.generation?.status ?? 'generating',
            ...metadata,
          },
        }
      : a)));
  },

  finalizeGeneratedAsset: (id) => {
    const projectId = projectIdForAssetMutation(get(), id);
    updateAssetsForProject(get, set, projectId, (assets) => assets.map((a) => (a.id === id
      ? { ...a, generation: { ...(a.generation ?? {}), status: 'done' as const, progress: 100 } }
      : a)));
  },

  finalizeGeneratedAssetWithBlob: async (id, file, metadata = {}) => {
    const projectId = projectIdForAssetMutation(get(), id);
    const probed = await probe(file);
    const thumbnail = await generateThumbnail(file, probed.kind).catch(() => '');
    const blobKey = `blob_${nanoid(12)}`;
    await putBlob(blobKey, file, file.name);

    const sourceAssets = get().activeProjectId === projectId ? get().assets : loadAssets(projectId);
    const existing = sourceAssets.find((a) => a.id === id);
    const accountedAt = existing?.generation?.costAccountedAt;
    const actualCostUsd = metadata.actualCostUsd ?? existing?.generation?.estimatedCostUsd;
    const shouldAccountCost = Boolean(
      existing &&
      existing.generation?.status !== 'done' &&
      !accountedAt &&
      Number.isFinite(actualCostUsd) &&
      (actualCostUsd ?? 0) > 0,
    );

    updateAssetsForProject(get, set, projectId, (assets) => assets.map((a) => (a.id === id
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
            ...(a.generation ?? {}),
            status: 'done' as const,
            progress: 100,
            estimatedCostUsd: a.generation?.estimatedCostUsd,
            actualCostUsd,
            provider: metadata.provider ?? a.generation?.provider,
            providerArtifactUri: metadata.providerArtifactUri ?? a.generation?.providerArtifactUri,
            providerArtifactExpiresAt: metadata.providerArtifactExpiresAt ?? a.generation?.providerArtifactExpiresAt,
            costAccountedUsd: shouldAccountCost
              ? actualCostUsd
              : a.generation?.costAccountedUsd,
            costAccountedAt: shouldAccountCost
              ? Date.now()
              : a.generation?.costAccountedAt,
          },
        }
      : a)));
    if (shouldAccountCost) {
      useProjectStore.getState().recordGenerationCostForProject(projectId, actualCostUsd ?? 0);
    }
  },

  failGeneratedAsset: (id, failure = {}) => {
    const projectId = projectIdForAssetMutation(get(), id);
    updateAssetsForProject(get, set, projectId, (assets) => assets.map((a) => (a.id === id
      ? {
          ...a,
          generation: {
            ...(a.generation ?? {}),
            status: 'error' as const,
            progress: 0,
            estimatedCostUsd: a.generation?.estimatedCostUsd,
            actualCostUsd: failure.actualCostUsd ?? a.generation?.estimatedCostUsd,
            errorType: failure.errorType ?? a.generation?.errorType ?? 'InternalError',
            errorMessage: failure.errorMessage ?? a.generation?.errorMessage ?? 'Generation failed.',
            failedAt: Date.now(),
          },
        }
      : a)));
  },

  saveRecipeAsset: (name, recipe, existingId = null) => {
    if (existingId) {
      const next = get().assets.map((a) => (a.id === existingId ? { ...a, name, recipe, kind: 'recipe' as const, mimeType: 'application/x-genedit-recipe' } : a));
      saveAssets(next, get().activeProjectId);
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
    saveAssets(next, get().activeProjectId);
    set({ assets: next });
    return id;
  },

  createSequenceAsset: (folderId = null) => {
    const count = get().assets.filter((asset) => asset.kind === 'sequence').length + 1;
    const id = nanoid(10);
    const sequence: SequenceAssetData = {
      model: 'piapi-seedance-2',
      durationSec: 8,
      overallPrompt: '',
      markers: [],
    };
    const asset: MediaAsset = {
      id,
      name: `Sequence ${count}`,
      kind: 'sequence',
      durationSec: sequence.durationSec,
      mimeType: 'application/x-genedit-sequence',
      blobKey: '',
      folderId,
      sequence,
      createdAt: Date.now(),
    };
    const next = [...get().assets, asset];
    saveAssets(next, get().activeProjectId);
    set({ assets: next });
    return id;
  },

  updateSequenceAsset: (id, sequence) => {
    const next = get().assets.map((asset) => (asset.id === id
      ? {
          ...asset,
          kind: 'sequence' as const,
          durationSec: sequence.durationSec,
          mimeType: 'application/x-genedit-sequence',
          sequence,
        }
      : asset));
    saveAssets(next, get().activeProjectId);
    set({ assets: next });
  },
}));
