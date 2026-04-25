import { useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, Film, FolderPlus, Image as ImageIcon, Music, Pencil, Plus, SlidersHorizontal, Sparkles, Trash2, Upload, X } from 'lucide-react';
import { isEditableMedia } from '@/lib/media/editTrail';
import { useMediaStore } from '@/state/mediaStore';
import { usePlaybackStore } from '@/state/playbackStore';
import { useProjectStore } from '@/state/projectStore';
import { addClip, sortedTracks } from '@/lib/timeline/operations';
import type { MediaAsset } from '@/types';
import { EditTrailDialog } from './EditTrailDialog';

type Props = {
  onImportClick: () => void;
  onGenerateClick: () => void;
  onOpenRecipe: (asset: MediaAsset) => void;
  highlightedAssetId?: string | null;
};

const kindIcon = {
  video: Film,
  audio: Music,
  image: ImageIcon,
  recipe: BookOpen,
};

export function MediaBin({ onImportClick, onGenerateClick, onOpenRecipe, highlightedAssetId = null }: Props) {
  const assets = useMediaStore((s) => s.assets);
  const folders = useMediaStore((s) => s.folders);
  const createFolder = useMediaStore((s) => s.createFolder);
  const importing = useMediaStore((s) => s.importing);
  const importFiles = useMediaStore((s) => s.importFiles);
  const removeAsset = useMediaStore((s) => s.removeAsset);
  const renameAsset = useMediaStore((s) => s.renameAsset);
  const project = useProjectStore((s) => s.project);
  const updateProject = useProjectStore((s) => s.update);
  const currentTime = usePlaybackStore((s) => s.currentTimeSec);
  const [dragOver, setDragOver] = useState(false);
  const [activeFolderId, setActiveFolderId] = useState<string | null>(null);
  const [editingAssetId, setEditingAssetId] = useState<string | null>(null);
  const [previewAssetId, setPreviewAssetId] = useState<string | null>(null);
  const tileRefs = useRef(new Map<string, HTMLLIElement>());
  const visibleAssets = useMemo(
    () => assets.filter((a) => (activeFolderId ? a.folderId === activeFolderId : true)),
    [assets, activeFolderId],
  );
  const previewAsset = useMemo(
    () => (previewAssetId ? assets.find((asset) => asset.id === previewAssetId) ?? null : null),
    [assets, previewAssetId],
  );
  const addAssetToTimeline = (asset: MediaAsset) => {
    if (asset.kind === 'recipe' || asset.generation?.status === 'generating') return;
    const targetKind = asset.kind === 'audio' ? 'audio' : 'video';
    const track = sortedTracks(project).find((candidate) => candidate.kind === targetKind);
    if (!track) return;
    updateProject((nextProject) => addClip(nextProject, asset, track.id, currentTime));
  };

  useEffect(() => {
    if (!highlightedAssetId) return;
    const highlightedAsset = assets.find((asset) => asset.id === highlightedAssetId);
    if (!highlightedAsset) return;
    if (activeFolderId && highlightedAsset.folderId !== activeFolderId) {
      setActiveFolderId(null);
      return;
    }
    requestAnimationFrame(() => {
      tileRefs.current.get(highlightedAssetId)?.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
    });
  }, [activeFolderId, assets, highlightedAssetId]);

  return (
    <div
      className="flex h-full flex-col"
      onDragOver={(e) => {
        if (Array.from(e.dataTransfer.types).includes('Files')) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={async (e) => {
        e.preventDefault();
        setDragOver(false);
        const files = Array.from(e.dataTransfer.files);
        if (files.length > 0) await importFiles(files);
      }}
    >
      <div className="flex items-center justify-between border-b border-surface-700 px-3 py-2">
        <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">Media</div>
        <div className="flex items-center gap-1.5">
          <button className="btn-ghost px-2 py-1 text-xs" onClick={onGenerateClick}>
            <Sparkles size={12} />
            Generate
          </button>
          <button className="btn-ghost px-2 py-1 text-xs" onClick={onImportClick} disabled={importing}>
            <Upload size={12} />
            {importing ? 'Importing…' : 'Import'}
          </button>
        </div>
      </div>
      <div className="border-b border-surface-700 px-3 py-2">
        <div className="mb-1 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-slate-500">
          Folders
          <button
            className="rounded p-1 text-slate-400 hover:bg-surface-800 hover:text-slate-200"
            onClick={() => {
              const name = window.prompt('Folder name');
              if (name?.trim()) createFolder(name.trim());
            }}
          >
            <FolderPlus size={12} />
          </button>
        </div>
        <div className="flex flex-wrap gap-1">
          <button className={`rounded px-2 py-0.5 text-[11px] ${activeFolderId === null ? 'bg-surface-700 text-slate-200' : 'bg-surface-800 text-slate-400'}`} onClick={() => setActiveFolderId(null)}>All</button>
          {folders.map((f) => (
            <button key={f.id} className={`rounded px-2 py-0.5 text-[11px] ${activeFolderId === f.id ? 'bg-surface-700 text-slate-200' : 'bg-surface-800 text-slate-400'}`} onClick={() => setActiveFolderId(f.id)}>
              {f.name}
            </button>
          ))}
        </div>
      </div>
      <div
        className={`relative min-h-0 flex-1 overflow-auto p-2 ${
          dragOver ? 'outline outline-2 -outline-offset-4 outline-brand-500/70' : ''
        }`}
      >
        {visibleAssets.length === 0 ? (
          <EmptyState onImportClick={onImportClick} />
        ) : (
          <ul className="grid grid-cols-2 gap-2">
            {visibleAssets.map((asset) => (
              <MediaTile
                key={asset.id}
                asset={asset}
                onDelete={() => removeAsset(asset.id)}
                onRename={(name) => renameAsset(asset.id, name)}
                onOpenEdit={() => setEditingAssetId(asset.id)}
                onOpenRecipe={() => onOpenRecipe(asset)}
                onAddToTimeline={() => addAssetToTimeline(asset)}
                onOpenPreview={() => setPreviewAssetId(asset.id)}
                isHighlighted={asset.id === highlightedAssetId}
                tileRef={(node) => {
                  if (node) tileRefs.current.set(asset.id, node);
                  else tileRefs.current.delete(asset.id);
                }}
              />
            ))}
          </ul>
        )}
      </div>
      {editingAssetId && (
        <EditTrailDialog
          assetId={editingAssetId}
          onClose={() => setEditingAssetId(null)}
        />
      )}
      {previewAsset && (
        <MediaLightbox
          asset={previewAsset}
          onClose={() => setPreviewAssetId(null)}
        />
      )}
    </div>
  );
}

function EmptyState({ onImportClick }: { onImportClick: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-slate-400">
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-surface-800">
        <Upload size={18} />
      </div>
      <div>Drag video, audio, or image files here to add them to your project.</div>
      <button className="btn-ghost text-xs" onClick={onImportClick}>
        Browse files…
      </button>
    </div>
  );
}

function MediaLightbox({ asset, onClose }: { asset: MediaAsset; onClose: () => void }) {
  const objectUrlFor = useMediaStore((s) => s.objectUrlFor);
  const [url, setUrl] = useState<string | null>(null);
  const Icon = kindIcon[asset.kind];

  useEffect(() => {
    let mounted = true;
    setUrl(null);
    void objectUrlFor(asset.id).then((nextUrl) => {
      if (mounted) setUrl(nextUrl);
    });
    return () => {
      mounted = false;
    };
  }, [asset.id, asset.blobKey, asset.editTrail?.activeIterationId, objectUrlFor]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/80 p-6 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-[90vh] w-[min(980px,94vw)] flex-col overflow-hidden rounded-xl border border-white/15 bg-surface-950 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex min-h-0 items-center justify-between border-b border-white/10 px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <Icon size={16} className="shrink-0 text-slate-400" />
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-slate-100">{asset.name}</div>
              <div className="text-[11px] uppercase tracking-wide text-slate-500">{asset.kind}</div>
            </div>
          </div>
          <button
            type="button"
            className="rounded-md p-1 text-slate-400 hover:bg-white/10 hover:text-white"
            onClick={onClose}
            title="Close preview"
            aria-label="Close preview"
          >
            <X size={18} />
          </button>
        </div>
        <div className="flex min-h-[280px] flex-1 items-center justify-center bg-black p-4">
          {url ? (
            <LightboxMedia asset={asset} url={url} />
          ) : (
            <div className="flex flex-col items-center gap-3 text-slate-500">
              <Icon size={32} />
              <div className="text-sm">Preview unavailable</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function LightboxMedia({ asset, url }: { asset: MediaAsset; url: string }) {
  if (asset.kind === 'video') {
    return (
      <video
        src={url}
        controls
        autoPlay
        playsInline
        className="max-h-[72vh] max-w-full bg-black object-contain"
      />
    );
  }
  if (asset.kind === 'audio') {
    return (
      <div className="flex w-full max-w-xl flex-col items-center gap-5 rounded-xl border border-white/10 bg-white/[0.03] p-8">
        <div className="flex h-24 w-24 items-center justify-center rounded-full bg-surface-800 text-slate-400">
          <Music size={42} />
        </div>
        <audio src={url} controls autoPlay className="w-full" />
      </div>
    );
  }
  if (asset.kind === 'image') {
    return (
      <img
        src={url}
        alt={asset.name}
        className="max-h-[72vh] max-w-full object-contain"
        draggable={false}
      />
    );
  }
  return (
    <div className="flex flex-col items-center gap-3 text-slate-500">
      <BookOpen size={32} />
      <div className="text-sm">Recipes open in the generator.</div>
    </div>
  );
}

function MediaTile({
  asset,
  onDelete,
  onRename,
  onOpenEdit,
  onOpenRecipe,
  onAddToTimeline,
  onOpenPreview,
  isHighlighted,
  tileRef,
}: {
  asset: MediaAsset;
  onDelete: () => void;
  onRename: (name: string) => void;
  onOpenEdit: () => void;
  onOpenRecipe: () => void;
  onAddToTimeline: () => void;
  onOpenPreview: () => void;
  isHighlighted: boolean;
  tileRef: (node: HTMLLIElement | null) => void;
}) {
  const Icon = kindIcon[asset.kind];
  const nameParts = splitFilename(asset.name);
  const badgeLabel = assetBadgeLabel(asset);
  const statusLabel = asset.generation?.status === 'generating'
      ? 'Generating'
      : asset.kind === 'video' || asset.kind === 'audio'
        ? `${asset.durationSec.toFixed(1)}s`
        : '';
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState({ x: 0, y: 0 });
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(nameParts.base);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const skipRenameCommitRef = useRef(false);
  const pointerButtonRef = useRef(0);
  const canInsert = asset.kind !== 'recipe' && asset.generation?.status !== 'generating';
  const canEdit = isEditableMedia(asset);
  const canReusePrompt = Boolean(asset.recipe) &&
    asset.kind !== 'recipe' &&
    (asset.kind === 'video' || asset.kind === 'image') &&
    asset.generation?.status !== 'generating';
  const failureMessage = generationFailureMessage(asset);

  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    window.addEventListener('click', close);
    window.addEventListener('contextmenu', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('contextmenu', close);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (!renaming) setDraftName(splitFilename(asset.name).base);
  }, [asset.name, renaming]);

  useEffect(() => {
    if (!renaming) return;
    requestAnimationFrame(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    });
  }, [renaming]);

  const beginRename = () => {
    setDraftName(splitFilename(asset.name).base);
    skipRenameCommitRef.current = false;
    setRenaming(true);
    setMenuOpen(false);
  };

  const commitRename = () => {
    if (skipRenameCommitRef.current) {
      skipRenameCommitRef.current = false;
      return;
    }
    const nextBaseName = draftName.trim();
    setRenaming(false);
    if (!nextBaseName) return;
    const nextName = nameParts.extension ? `${nextBaseName}.${nameParts.extension}` : nextBaseName;
    if (nextName !== asset.name) onRename(nextName);
  };

  const cancelRename = () => {
    skipRenameCommitRef.current = true;
    setDraftName(nameParts.base);
    setRenaming(false);
  };

  return (
    <li
      ref={tileRef}
      data-asset-id={asset.id}
      className={`group relative overflow-hidden rounded-md border bg-surface-800 transition ${
        isHighlighted
          ? 'border-brand-300 ring-2 ring-brand-400/80 shadow-[0_0_0_3px_rgba(99,102,241,0.22)]'
          : 'border-surface-700 hover:border-surface-500'
      } ${
        renaming ? 'cursor-default' : 'cursor-grab active:cursor-grabbing'
      }`}
      draggable={!renaming}
      onMouseDown={(e) => {
        pointerButtonRef.current = e.button;
      }}
      onDragStart={(e) => {
        if (renaming || pointerButtonRef.current !== 0) {
          e.preventDefault();
          return;
        }
        e.dataTransfer.setData('application/x-genedit-asset', asset.id);
        e.dataTransfer.effectAllowed = 'copy';
      }}
      onClick={() => {
        setMenuOpen(false);
      }}
      onDoubleClick={() => {
        if (asset.kind === 'recipe') {
          onOpenRecipe();
          return;
        }
        if (asset.generation?.status === 'generating' || !asset.blobKey) return;
        onOpenPreview();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        pointerButtonRef.current = 2;
        setMenuPos({ x: e.clientX, y: e.clientY });
        setMenuOpen(true);
      }}
      title={failureMessage ?? asset.name}
    >
      <div className="relative aspect-video bg-surface-900">
        {asset.thumbnailDataUrl ? (
          <img
            src={asset.thumbnailDataUrl}
            alt=""
            className="h-full w-full object-cover"
            draggable={false}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-slate-500">
            <Icon size={24} />
          </div>
        )}
        {badgeLabel && (
          <span className="absolute right-1 top-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
            {badgeLabel}
          </span>
        )}
        {statusLabel && (
          <span className="absolute bottom-1 right-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-mono text-white">
            {statusLabel}
          </span>
        )}
        {asset.generation?.status === 'generating' && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/35 text-xs text-white">
            <div className="rounded bg-black/60 px-2 py-1">{Math.round(asset.generation.progress ?? 0)}%</div>
          </div>
        )}
        {asset.generation?.status === 'error' && (
          <div className="absolute inset-0 flex items-center justify-center bg-red-900/30 text-xs text-white" title={failureMessage ?? 'Generation failed.'}>
            {failureMessage && (
              <div className="pointer-events-none absolute left-2 right-2 top-2 z-10 hidden rounded border border-red-300/30 bg-red-950/95 px-2 py-1.5 text-left text-[10px] leading-snug text-red-50 shadow-xl group-hover:block">
                {failureMessage}
              </div>
            )}
            <div className="rounded bg-red-900/70 px-2 py-1">Generation failed</div>
          </div>
        )}
        {asset.kind !== 'recipe' && asset.generation?.status !== 'generating' && (
          <button
            type="button"
            className="absolute left-1 top-1 flex h-6 w-6 items-center justify-center rounded bg-black/65 text-white opacity-0 transition-opacity hover:bg-brand-500 group-hover:opacity-100"
            title="Add to timeline"
            onClick={(e) => {
              e.stopPropagation();
              onAddToTimeline();
            }}
          >
            <Plus size={13} />
          </button>
        )}
      </div>
      <div className="flex items-center justify-between px-2 py-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-1.5 text-xs">
          <Icon size={12} className="shrink-0 text-slate-400" />
          {renaming ? (
            <div className="flex min-w-0 flex-1 items-center">
              <input
                ref={renameInputRef}
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                onBlur={commitRename}
                onClick={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    commitRename();
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    cancelRename();
                  }
                }}
                className={`min-w-0 flex-1 border border-brand-400/60 bg-surface-950 px-1.5 py-0.5 text-xs text-slate-100 outline-none ${
                  nameParts.extension ? 'rounded-l' : 'rounded'
                }`}
              />
              {nameParts.extension && (
                <span className="shrink-0 rounded-r border-y border-r border-brand-400/60 bg-surface-700 px-1.5 py-0.5 text-xs text-slate-300">
                  .{nameParts.extension}
                </span>
              )}
            </div>
          ) : (
            <button
              type="button"
              className="min-w-0 flex-1 truncate rounded px-0.5 py-0.5 text-left text-slate-100 hover:text-white focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand-400"
              title="Double-click to rename"
              onClick={(e) => e.stopPropagation()}
              onDoubleClick={(e) => {
                e.stopPropagation();
                beginRename();
              }}
            >
              {nameParts.base}
            </button>
          )}
        </div>
        <button
          className="shrink-0 rounded p-1 text-slate-500 opacity-0 transition-opacity hover:text-red-400 group-hover:opacity-100"
          onClick={(e) => {
            e.stopPropagation();
            void onDelete();
          }}
          title="Remove"
        >
          <Trash2 size={12} />
        </button>
      </div>
      {menuOpen && (
        <div
          className="fixed z-[80] min-w-[150px] rounded-md border border-surface-600 bg-surface-800 p-1 shadow-xl"
          style={{ left: menuPos.x, top: menuPos.y }}
          onContextMenu={(e) => e.preventDefault()}
        >
          {canReusePrompt && (
            <>
              <button
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-slate-200 hover:bg-surface-700"
                onClick={() => {
                  setMenuOpen(false);
                  onOpenRecipe();
                }}
              >
                <Sparkles size={12} />
                Reuse Prompt
              </button>
              <div className="my-1 h-px bg-surface-700" />
            </>
          )}
          <button
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-slate-200 hover:bg-surface-700 disabled:cursor-not-allowed disabled:opacity-45"
            disabled={!canInsert}
            onClick={() => {
              if (!canInsert) return;
              setMenuOpen(false);
              onAddToTimeline();
            }}
          >
            <Plus size={12} />
            Insert
          </button>
          {canEdit && (
            <button
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-slate-200 hover:bg-surface-700"
              onClick={() => {
                setMenuOpen(false);
                onOpenEdit();
              }}
            >
              <SlidersHorizontal size={12} />
              Edit
            </button>
          )}
          <button
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-slate-200 hover:bg-surface-700"
            onClick={() => {
              beginRename();
            }}
          >
            <Pencil size={12} />
            Rename
          </button>
          <div className="my-1 h-px bg-surface-700" />
          <button
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-red-300 hover:bg-red-500/10"
            onClick={() => {
              setMenuOpen(false);
              void onDelete();
            }}
          >
            <Trash2 size={12} />
            Delete
          </button>
        </div>
      )}
    </li>
  );
}

function splitFilename(name: string): { base: string; extension: string } {
  const trimmed = name.trim();
  const lastDot = trimmed.lastIndexOf('.');
  if (lastDot <= 0 || lastDot === trimmed.length - 1) return { base: trimmed, extension: '' };
  return {
    base: trimmed.slice(0, lastDot),
    extension: trimmed.slice(lastDot + 1),
  };
}

function assetBadgeLabel(asset: MediaAsset): string {
  if (asset.kind === 'recipe') return 'Recipe';
  const extension = splitFilename(asset.name).extension;
  if (extension) return extension;
  const subtype = asset.mimeType.split('/')[1]?.split(';')[0];
  if (!subtype) return asset.kind;
  if (subtype === 'mpeg') return 'mp3';
  if (subtype === 'jpeg') return 'jpg';
  return subtype;
}

function generationFailureMessage(asset: MediaAsset): string | null {
  if (asset.generation?.status !== 'error') return null;
  return asset.generation.errorMessage || 'Generation failed. No provider error was returned.';
}
