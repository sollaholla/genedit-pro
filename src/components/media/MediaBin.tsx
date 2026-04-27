import { type ComponentType, type DragEvent, type MouseEvent, type SVGProps, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BookOpen, Clapperboard, Copy, ExternalLink, Film, Folder, FolderPlus, Image as ImageIcon, Music, Pencil, Plus, SlidersHorizontal, Sparkles, Trash2, Upload, UserRound, X } from 'lucide-react';
import { isEditableMedia } from '@/lib/media/editTrail';
import { characterTokenForAsset } from '@/lib/media/characterReferences';
import { isBillingErrorText } from '@/lib/videoGeneration/errors';
import { PIAPI_BILLING_URL } from '@/lib/videoGeneration/piapi';
import { type MediaFolder, useMediaStore } from '@/state/mediaStore';
import { usePlaybackStore } from '@/state/playbackStore';
import { useProjectStore } from '@/state/projectStore';
import { addClip, sortedTracks } from '@/lib/timeline/operations';
import type { MediaAsset } from '@/types';
import { EditTrailDialog } from './EditTrailDialog';
import { SequenceEditor } from './SequenceEditor';

type Props = {
  onImportClick: () => void;
  onGenerateClick: () => void;
  onCreateCharacter: (folderId: string | null) => void;
  onOpenCharacter: (asset: MediaAsset) => void;
  onOpenRecipe: (asset: MediaAsset) => void;
  onGenerateFromSequence: (asset: MediaAsset) => void;
  highlightedAssetId?: string | null;
};

const kindIcon = {
  video: Film,
  audio: Music,
  image: ImageIcon,
  character: UserRound,
  recipe: BookOpen,
  sequence: Clapperboard,
};

const ASSET_DRAG_MIME = 'application/x-genedit-asset';
const MEDIA_CONTEXT_MENU_WIDTH_PX = 210;
const MEDIA_CONTEXT_MENU_MAX_HEIGHT_PX = 270;
const MEDIA_CONTEXT_MENU_MARGIN_PX = 8;

export function MediaBin({ onImportClick, onGenerateClick, onCreateCharacter, onOpenCharacter, onOpenRecipe, onGenerateFromSequence, highlightedAssetId = null }: Props) {
  const assets = useMediaStore((s) => s.assets);
  const folders = useMediaStore((s) => s.folders);
  const createFolder = useMediaStore((s) => s.createFolder);
  const renameFolder = useMediaStore((s) => s.renameFolder);
  const removeFolder = useMediaStore((s) => s.removeFolder);
  const importing = useMediaStore((s) => s.importing);
  const importFiles = useMediaStore((s) => s.importFiles);
  const removeAsset = useMediaStore((s) => s.removeAsset);
  const renameAsset = useMediaStore((s) => s.renameAsset);
  const moveAssetToFolder = useMediaStore((s) => s.moveAssetToFolder);
  const project = useProjectStore((s) => s.project);
  const updateProject = useProjectStore((s) => s.update);
  const currentTime = usePlaybackStore((s) => s.currentTimeSec);
  const [dragOver, setDragOver] = useState(false);
  const [activeFolderId, setActiveFolderId] = useState<string | null>(null);
  const [editingAssetId, setEditingAssetId] = useState<string | null>(null);
  const [sequenceEditor, setSequenceEditor] = useState<
    | { kind: 'edit'; assetId: string }
    | { kind: 'create'; folderId: string | null }
    | null
  >(null);
  const [previewAssetId, setPreviewAssetId] = useState<string | null>(null);
  const [openAssetMenuId, setOpenAssetMenuId] = useState<string | null>(null);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [folderDraft, setFolderDraft] = useState('');
  const [folderMenu, setFolderMenu] = useState<{ folderId: string; x: number; y: number } | null>(null);
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [pendingFolderDelete, setPendingFolderDelete] = useState<MediaFolder | null>(null);
  const folderMenuRef = useRef<HTMLDivElement | null>(null);
  const tileRefs = useRef(new Map<string, HTMLLIElement>());
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const activeFolder = useMemo(
    () => (activeFolderId ? folders.find((folder) => folder.id === activeFolderId) ?? null : null),
    [activeFolderId, folders],
  );
  const visibleAssets = useMemo(
    () => assets.filter((a) => (activeFolderId ? a.folderId === activeFolderId : true)),
    [assets, activeFolderId],
  );
  const folderTiles = activeFolderId ? [] : folders;
  const hasGridItems = folderTiles.length > 0 || visibleAssets.length > 0;
  const previewAsset = useMemo(
    () => (previewAssetId ? assets.find((asset) => asset.id === previewAssetId) ?? null : null),
    [assets, previewAssetId],
  );
  const assetsByFolder = useMemo(() => {
    const map = new Map<string | null, MediaAsset[]>();
    for (const asset of assets) {
      const key = asset.folderId ?? null;
      const bucket = map.get(key) ?? [];
      bucket.push(asset);
      map.set(key, bucket);
    }
    return map;
  }, [assets]);
  const assetCountForFolder = (folderId: string | null) => assetsByFolder.get(folderId)?.length ?? 0;
  const previewsForFolder = (folderId: string) => (assetsByFolder.get(folderId) ?? [])
    .filter((asset) => asset.thumbnailDataUrl)
    .slice(0, 4);
  const addAssetToTimeline = (asset: MediaAsset) => {
    if (asset.kind === 'recipe' || asset.kind === 'sequence' || asset.kind === 'character' || asset.generation?.status === 'generating') return;
    const targetKind = asset.kind === 'audio' ? 'audio' : 'video';
    const track = sortedTracks(project).find((candidate) => candidate.kind === targetKind);
    if (!track) return;
    updateProject((nextProject) => addClip(nextProject, asset, track.id, currentTime));
  };
  const moveDroppedMediaToFolder = async (event: DragEvent<HTMLElement>, folderId: string | null) => {
    event.preventDefault();
    event.stopPropagation();
    const assetId = event.dataTransfer.getData(ASSET_DRAG_MIME) || event.dataTransfer.getData('text/plain');
    if (assetId) {
      moveAssetToFolder(assetId, folderId);
      return;
    }
    const files = Array.from(event.dataTransfer.files);
    if (files.length > 0) await importFiles(files, folderId);
  };
  const commitFolderDraft = () => {
    const name = folderDraft.trim();
    setCreatingFolder(false);
    setFolderDraft('');
    if (name) createFolder(name);
  };
  const createSequence = () => {
    setSequenceEditor({ kind: 'create', folderId: activeFolderId });
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

  useEffect(() => {
    if (!creatingFolder) return;
    requestAnimationFrame(() => {
      folderInputRef.current?.focus();
      folderInputRef.current?.select();
    });
  }, [creatingFolder]);

  useEffect(() => {
    if (activeFolderId && !folders.some((folder) => folder.id === activeFolderId)) {
      setActiveFolderId(null);
    }
  }, [activeFolderId, folders]);

  useEffect(() => {
    if (!folderMenu) return;
    const close = () => setFolderMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('contextmenu', close);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('contextmenu', close);
      window.removeEventListener('resize', close);
    };
  }, [folderMenu]);

  useLayoutEffect(() => {
    if (!folderMenu) return;
    const menu = folderMenuRef.current;
    if (!menu) return;
    const position = clampMediaMenuPosition(folderMenu.x, folderMenu.y, menu.offsetWidth, menu.offsetHeight);
    menu.style.left = `${position.x}px`;
    menu.style.top = `${position.y}px`;
  }, [folderMenu]);

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
        if (files.length > 0) await importFiles(files, activeFolderId);
      }}
    >
      <div className="border-b border-surface-700 px-3 py-2">
        <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">Media</div>
        <div className="flex items-center gap-1.5">
          <ToolbarIconButton icon={Clapperboard} label="New sequence" onClick={createSequence} />
          <ToolbarIconButton icon={UserRound} label="New character" onClick={() => onCreateCharacter(activeFolderId)} />
          <ToolbarIconButton icon={Sparkles} label="Generate video" onClick={onGenerateClick} />
          <ToolbarIconButton icon={Upload} label={importing ? 'Importing…' : 'Import media'} onClick={onImportClick} disabled={importing} />
        </div>
      </div>
      <div className="border-b border-surface-700 px-3 py-2">
        <div className="mb-1 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-slate-500">
          Folders
          <button
            className="rounded p-1 text-slate-400 hover:bg-surface-800 hover:text-slate-200"
            onClick={() => {
              setFolderDraft('');
              setCreatingFolder(true);
            }}
            title="New folder"
          >
            <FolderPlus size={12} />
          </button>
        </div>
        <div className="flex flex-wrap gap-1">
          <FolderFilterButton
            label="All"
            count={assets.length}
            active={activeFolderId === null}
            onClick={() => setActiveFolderId(null)}
            onDropToFolder={(event) => moveDroppedMediaToFolder(event, null)}
          />
          {folders.map((f) => (
            <FolderFilterButton
              key={f.id}
              label={f.name}
              count={assetCountForFolder(f.id)}
              active={activeFolderId === f.id}
              renaming={renamingFolderId === f.id}
              onClick={() => setActiveFolderId(f.id)}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setFolderMenu({ folderId: f.id, x: event.clientX, y: event.clientY });
              }}
              onRenameCommit={(name) => {
                renameFolder(f.id, name);
                setRenamingFolderId(null);
              }}
              onRenameCancel={() => setRenamingFolderId(null)}
              onDropToFolder={(event) => moveDroppedMediaToFolder(event, f.id)}
            />
          ))}
          {creatingFolder && (
            <input
              ref={folderInputRef}
              value={folderDraft}
              onChange={(event) => setFolderDraft(event.target.value)}
              onBlur={commitFolderDraft}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  commitFolderDraft();
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  setCreatingFolder(false);
                  setFolderDraft('');
                }
              }}
              className="min-w-0 rounded border border-brand-400/60 bg-surface-950 px-2 py-0.5 text-[11px] text-slate-100 outline-none"
              placeholder="Folder name"
            />
          )}
        </div>
      </div>
      <div
        className={`relative min-h-0 flex-1 overflow-auto p-2 ${
          dragOver ? 'outline outline-2 -outline-offset-4 outline-brand-500/70' : ''
        }`}
      >
        {!hasGridItems ? (
          <EmptyState onImportClick={onImportClick} folderName={activeFolder?.name} />
        ) : (
          <ul className="grid grid-cols-2 gap-2">
            {folderTiles.map((folder) => (
              <FolderTile
                key={folder.id}
                folder={folder}
                assetCount={assetCountForFolder(folder.id)}
                previews={previewsForFolder(folder.id)}
                renaming={renamingFolderId === folder.id}
                onOpen={() => setActiveFolderId(folder.id)}
                onDropToFolder={(event) => moveDroppedMediaToFolder(event, folder.id)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setFolderMenu({ folderId: folder.id, x: event.clientX, y: event.clientY });
                }}
                onRenameCommit={(name) => {
                  renameFolder(folder.id, name);
                  setRenamingFolderId(null);
                }}
                onRenameCancel={() => setRenamingFolderId(null)}
              />
            ))}
            {visibleAssets.map((asset) => (
              <MediaTile
                key={asset.id}
                asset={asset}
                onDelete={() => removeAsset(asset.id)}
                onRename={(name) => renameAsset(asset.id, name)}
                onOpenEdit={() => {
                  if (asset.kind === 'character') onOpenCharacter(asset);
                  else setEditingAssetId(asset.id);
                }}
                onOpenRecipe={() => onOpenRecipe(asset)}
                onOpenSequence={() => setSequenceEditor({ kind: 'edit', assetId: asset.id })}
                onAddToTimeline={() => addAssetToTimeline(asset)}
                onOpenPreview={() => setPreviewAssetId(asset.id)}
                menuOpen={openAssetMenuId === asset.id}
                onMenuOpen={() => setOpenAssetMenuId(asset.id)}
                onMenuClose={() => setOpenAssetMenuId((currentId) => (currentId === asset.id ? null : currentId))}
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
      {sequenceEditor && (
        <SequenceEditor
          assetId={sequenceEditor.kind === 'edit' ? sequenceEditor.assetId : null}
          draftFolderId={sequenceEditor.kind === 'create' ? sequenceEditor.folderId : null}
          onAssetCommitted={(committedId) => setSequenceEditor({ kind: 'edit', assetId: committedId })}
          onGenerate={(generatedAssetId) => {
            const sequenceAsset = assets.find((candidate) => candidate.id === generatedAssetId && candidate.kind === 'sequence');
            if (!sequenceAsset) return;
            setSequenceEditor(null);
            onGenerateFromSequence(sequenceAsset);
          }}
          onClose={() => setSequenceEditor(null)}
        />
      )}
      {previewAsset && (
        <MediaLightbox
          asset={previewAsset}
          onClose={() => setPreviewAssetId(null)}
          onEdit={previewAsset.kind === 'character'
            ? () => {
                setPreviewAssetId(null);
                onOpenCharacter(previewAsset);
              }
            : undefined}
        />
      )}
      {folderMenu && (
        <div
          ref={folderMenuRef}
          className="fixed z-[120] min-w-[150px] rounded-md border border-surface-600 bg-surface-800 p-1 shadow-xl"
          onContextMenu={(event) => event.preventDefault()}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-slate-200 hover:bg-surface-700"
            onClick={() => {
              setRenamingFolderId(folderMenu.folderId);
              setFolderMenu(null);
            }}
          >
            <Pencil size={12} />
            Rename
          </button>
          <div className="my-1 h-px bg-surface-700" />
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-red-300 hover:bg-red-500/10"
            onClick={() => {
              const folder = folders.find((candidate) => candidate.id === folderMenu.folderId) ?? null;
              if (folder) setPendingFolderDelete(folder);
              setFolderMenu(null);
            }}
          >
            <Trash2 size={12} />
            Delete
          </button>
        </div>
      )}
      {pendingFolderDelete && (
        <FolderDeleteDialog
          folder={pendingFolderDelete}
          assetCount={assetCountForFolder(pendingFolderDelete.id)}
          onCancel={() => setPendingFolderDelete(null)}
          onConfirm={(removeAssets) => {
            void removeFolder(pendingFolderDelete.id, removeAssets);
            if (activeFolderId === pendingFolderDelete.id) setActiveFolderId(null);
            setPendingFolderDelete(null);
          }}
        />
      )}
    </div>
  );
}

function FolderDeleteDialog({
  folder,
  assetCount,
  onCancel,
  onConfirm,
}: {
  folder: MediaFolder;
  assetCount: number;
  onCancel: () => void;
  onConfirm: (removeAssets: boolean) => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" onClick={onCancel}>
      <div
        className="w-[min(440px,94vw)] rounded-lg border border-white/15 bg-surface-950 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-surface-700 px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
            <Trash2 size={16} className="text-red-300" />
            Delete folder
          </div>
          <button
            type="button"
            className="rounded-md p-1 text-slate-400 hover:bg-white/10 hover:text-white"
            onClick={onCancel}
            title="Cancel"
            aria-label="Cancel"
          >
            <X size={16} />
          </button>
        </div>
        <div className="px-4 py-3 text-sm text-slate-300">
          <p>
            Delete <span className="font-semibold text-slate-100">{folder.name}</span>
            {assetCount > 0 ? (
              <>
                {' '}— it contains <span className="font-semibold text-slate-100">{assetCount}</span> file{assetCount === 1 ? '' : 's'}.
                What should happen to them?
              </>
            ) : (
              '?'
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-surface-700 px-4 py-3">
          <button type="button" className="btn-ghost px-3 py-1.5 text-xs" onClick={onCancel}>
            Cancel
          </button>
          {assetCount > 0 && (
            <button
              type="button"
              className="btn-ghost px-3 py-1.5 text-xs"
              onClick={() => onConfirm(false)}
            >
              Move files out
            </button>
          )}
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-md bg-red-500/90 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-red-500"
            onClick={() => onConfirm(true)}
          >
            <Trash2 size={12} />
            {assetCount > 0 ? 'Delete folder & files' : 'Delete folder'}
          </button>
        </div>
      </div>
    </div>
  );
}

function FolderFilterButton({
  label,
  count,
  active,
  onClick,
  onDropToFolder,
  onContextMenu,
  renaming = false,
  onRenameCommit,
  onRenameCancel,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  onDropToFolder: (event: DragEvent<HTMLButtonElement>) => void | Promise<void>;
  onContextMenu?: (event: MouseEvent<HTMLButtonElement>) => void;
  renaming?: boolean;
  onRenameCommit?: (name: string) => void;
  onRenameCancel?: () => void;
}) {
  const [dropOver, setDropOver] = useState(false);
  const [draft, setDraft] = useState(label);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (renaming) {
      setDraft(label);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [renaming, label]);

  if (renaming) {
    return (
      <input
        ref={inputRef}
        title="Folder name"
        aria-label="Folder name"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          const trimmed = draft.trim();
          if (trimmed && trimmed !== label) onRenameCommit?.(trimmed);
          else onRenameCancel?.();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            const trimmed = draft.trim();
            if (trimmed && trimmed !== label) onRenameCommit?.(trimmed);
            else onRenameCancel?.();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            onRenameCancel?.();
          }
        }}
        className="min-w-0 rounded border border-brand-400/60 bg-surface-950 px-2 py-0.5 text-[11px] text-slate-100 outline-none"
      />
    );
  }

  return (
    <button
      className={`rounded px-2 py-0.5 text-[11px] transition ${
        active ? 'bg-surface-700 text-slate-200' : 'bg-surface-800 text-slate-400'
      } ${dropOver ? 'ring-1 ring-brand-400 bg-brand-500/20 text-slate-100' : ''}`}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onDragOver={(event) => {
        if (!canAcceptMediaDrop(event)) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = dragHasAsset(event) ? 'move' : 'copy';
        setDropOver(true);
      }}
      onDragLeave={() => setDropOver(false)}
      onDrop={(event) => {
        setDropOver(false);
        void onDropToFolder(event);
      }}
      title={`Drop media here to move it to ${label}`}
    >
      {label}
      <span className="ml-1 text-slate-500">{count}</span>
    </button>
  );
}

function FolderTile({
  folder,
  assetCount,
  previews,
  onOpen,
  onDropToFolder,
  onContextMenu,
  renaming = false,
  onRenameCommit,
  onRenameCancel,
}: {
  folder: MediaFolder;
  assetCount: number;
  previews: MediaAsset[];
  onOpen: () => void;
  onDropToFolder: (event: DragEvent<HTMLLIElement>) => void | Promise<void>;
  onContextMenu?: (event: MouseEvent<HTMLLIElement>) => void;
  renaming?: boolean;
  onRenameCommit?: (name: string) => void;
  onRenameCancel?: () => void;
}) {
  const [dropOver, setDropOver] = useState(false);
  const [draft, setDraft] = useState(folder.name);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (renaming) {
      setDraft(folder.name);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [renaming, folder.name]);

  const interactiveProps = renaming
    ? { tabIndex: -1 }
    : {
        role: 'button' as const,
        tabIndex: 0,
        onClick: onOpen,
        onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onOpen();
          }
        },
      };

  return (
    <li
      data-folder-id={folder.id}
      className={`group relative overflow-hidden rounded-md border bg-surface-800 transition ${
        dropOver ? 'border-brand-300 ring-2 ring-brand-400/60' : 'border-surface-700 hover:border-surface-500'
      }`}
      onContextMenu={onContextMenu}
      onDragOver={(event) => {
        if (!canAcceptMediaDrop(event)) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = dragHasAsset(event) ? 'move' : 'copy';
        setDropOver(true);
      }}
      onDragLeave={() => setDropOver(false)}
      onDrop={(event) => {
        setDropOver(false);
        void onDropToFolder(event);
      }}
    >
      <div
        {...interactiveProps}
        className={`flex w-full flex-col text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand-400 ${renaming ? 'cursor-default' : 'cursor-pointer'}`}
        title={`Open ${folder.name}`}
      >
        <div className="relative aspect-video overflow-hidden bg-surface-900">
          {previews.length > 0 ? (
            <div className="grid h-full w-full grid-cols-2 gap-px opacity-70">
              {previews.map((asset) => (
                <img
                  key={asset.id}
                  src={asset.thumbnailDataUrl}
                  alt=""
                  className="h-full w-full object-cover"
                  draggable={false}
                />
              ))}
              {Array.from({ length: Math.max(0, 4 - previews.length) }).map((_, index) => (
                <div key={index} className="bg-surface-950" />
              ))}
            </div>
          ) : (
            <div className="flex h-full w-full items-center justify-center text-slate-500">
              <Folder size={28} />
            </div>
          )}
          <div className="absolute inset-0 flex items-center justify-center bg-black/25">
            <div className="rounded-full bg-surface-950/75 p-2 text-slate-200 shadow-lg">
              <Folder size={22} />
            </div>
          </div>
          {dropOver && (
            <div className="absolute inset-0 flex items-center justify-center bg-brand-500/20 text-xs font-semibold text-white">
              Move here
            </div>
          )}
        </div>
        <div className="flex items-center justify-between gap-2 px-2 py-1.5">
          <div className="flex min-w-0 items-center gap-1.5 text-xs text-slate-100">
            <Folder size={12} className="shrink-0 text-slate-400" />
            {renaming ? (
              <input
                ref={inputRef}
                title="Folder name"
                aria-label="Folder name"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onClick={(event) => event.stopPropagation()}
                onBlur={() => {
                  const trimmed = draft.trim();
                  if (trimmed && trimmed !== folder.name) onRenameCommit?.(trimmed);
                  else onRenameCancel?.();
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    const trimmed = draft.trim();
                    if (trimmed && trimmed !== folder.name) onRenameCommit?.(trimmed);
                    else onRenameCancel?.();
                  } else if (event.key === 'Escape') {
                    event.preventDefault();
                    onRenameCancel?.();
                  }
                }}
                className="min-w-0 flex-1 rounded border border-brand-400/60 bg-surface-950 px-1.5 py-0.5 text-xs text-slate-100 outline-none"
              />
            ) : (
              <span className="truncate">{folder.name}</span>
            )}
          </div>
          <span className="shrink-0 rounded bg-surface-700 px-1.5 py-0.5 text-[10px] text-slate-400">
            {assetCount}
          </span>
        </div>
      </div>
    </li>
  );
}

function EmptyState({ onImportClick, folderName }: { onImportClick: () => void; folderName?: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-slate-400">
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-surface-800">
        <Upload size={18} />
      </div>
      <div>
        {folderName
          ? `Drop media here to add it to ${folderName}.`
          : 'Drag video, audio, or image files here to add them to your project.'}
      </div>
      <button className="btn-ghost text-xs" onClick={onImportClick}>
        Browse files…
      </button>
    </div>
  );
}

function canAcceptMediaDrop(event: DragEvent<HTMLElement>): boolean {
  const types = Array.from(event.dataTransfer.types);
  return types.includes(ASSET_DRAG_MIME) || types.includes('text/plain') || types.includes('Files');
}

function dragHasAsset(event: DragEvent<HTMLElement>): boolean {
  const types = Array.from(event.dataTransfer.types);
  return types.includes(ASSET_DRAG_MIME) || types.includes('text/plain');
}

function MediaLightbox({ asset, onClose, onEdit }: { asset: MediaAsset; onClose: () => void; onEdit?: () => void }) {
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
          <div className="flex shrink-0 items-center gap-1.5">
            {asset.kind === 'character' && onEdit && (
              <button
                type="button"
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-white/10 bg-white/[0.04] px-2 text-xs font-medium text-slate-200 hover:border-brand-300/50 hover:bg-brand-500/15 hover:text-white"
                onClick={onEdit}
                title="Edit character"
              >
                <SlidersHorizontal size={13} />
                Edit
              </button>
            )}
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
  if (asset.kind === 'image' || asset.kind === 'character') {
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
      {asset.kind === 'sequence' ? <Clapperboard size={32} /> : <BookOpen size={32} />}
      <div className="text-sm">{asset.kind === 'sequence' ? 'Sequences open in the sequence editor.' : 'Recipes open in the generator.'}</div>
    </div>
  );
}

function MediaTile({
  asset,
  onDelete,
  onRename,
  onOpenEdit,
  onOpenRecipe,
  onOpenSequence,
  onAddToTimeline,
  onOpenPreview,
  menuOpen,
  onMenuOpen,
  onMenuClose,
  isHighlighted,
  tileRef,
}: {
  asset: MediaAsset;
  onDelete: () => void;
  onRename: (name: string) => void;
  onOpenEdit: () => void;
  onOpenRecipe: () => void;
  onOpenSequence: () => void;
  onAddToTimeline: () => void;
  onOpenPreview: () => void;
  menuOpen: boolean;
  onMenuOpen: () => void;
  onMenuClose: () => void;
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
  const [menuPos, setMenuPos] = useState({ x: 0, y: 0 });
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(nameParts.base);
  const [failureTooltipVisible, setFailureTooltipVisible] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const failureTooltipRef = useRef<HTMLDivElement | null>(null);
  const failureTooltipPositionRef = useRef({ x: 12, y: 12 });
  const skipRenameCommitRef = useRef(false);
  const pointerButtonRef = useRef(0);
  const canInsert = asset.kind !== 'recipe' && asset.kind !== 'sequence' && asset.kind !== 'character' && asset.generation?.status !== 'generating';
  const canEdit = isEditableMedia(asset);
  const canReusePrompt = Boolean(asset.recipe) &&
    asset.kind !== 'recipe' &&
    (asset.kind === 'video' || asset.kind === 'image') &&
    asset.generation?.status !== 'generating';
  const failureMessage = generationFailureMessage(asset);
  const failureIsBilling = asset.generation?.errorType === 'Billing' || Boolean(failureMessage && isBillingErrorText(failureMessage));
  const generatedWithUi = Boolean(asset.generation) && asset.kind !== 'recipe';

  useEffect(() => {
    if (!menuOpen) return;
    const close = () => onMenuClose();
    window.addEventListener('click', close);
    window.addEventListener('contextmenu', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('contextmenu', close);
    };
  }, [menuOpen, onMenuClose]);

  useEffect(() => {
    if (!renaming) setDraftName(splitFilename(asset.name).base);
  }, [asset.name, renaming]);

  useEffect(() => {
    if (!failureMessage) setFailureTooltipVisible(false);
  }, [failureMessage]);

  useLayoutEffect(() => {
    if (!menuOpen) return;
    const menu = menuRef.current;
    if (!menu) return;
    const position = clampMediaMenuPosition(menuPos.x, menuPos.y, menu.offsetWidth, menu.offsetHeight);
    menu.style.left = `${position.x}px`;
    menu.style.top = `${position.y}px`;
  }, [menuOpen, menuPos]);

  useLayoutEffect(() => {
    if (!failureTooltipVisible) return;
    const tooltip = failureTooltipRef.current;
    if (!tooltip) return;
    tooltip.style.left = `${failureTooltipPositionRef.current.x}px`;
    tooltip.style.top = `${failureTooltipPositionRef.current.y}px`;
  }, [failureTooltipVisible]);

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
    onMenuClose();
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

  const placeFailureTooltip = (event: MouseEvent<HTMLElement>) => {
    if (!failureMessage) return;
    const padding = 12;
    const offsetX = 14;
    const offsetY = 12;
    const tooltipWidth = failureTooltipRef.current?.offsetWidth ?? 384;
    const tooltipHeight = failureTooltipRef.current?.offsetHeight ?? 96;
    const x = Math.min(event.clientX + offsetX, window.innerWidth - tooltipWidth - padding);
    const y = Math.max(padding, event.clientY - tooltipHeight - offsetY);
    const nextPosition = { x: Math.max(padding, x), y };
    failureTooltipPositionRef.current = nextPosition;
    if (failureTooltipRef.current) {
      failureTooltipRef.current.style.left = `${nextPosition.x}px`;
      failureTooltipRef.current.style.top = `${nextPosition.y}px`;
    }
    setFailureTooltipVisible(true);
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
        e.dataTransfer.setData(ASSET_DRAG_MIME, asset.id);
        e.dataTransfer.setData('text/plain', asset.id);
        e.dataTransfer.effectAllowed = 'copyMove';
      }}
      onClick={() => {
        onMenuClose();
      }}
      onDoubleClick={() => {
        if (asset.kind === 'recipe') {
          onOpenRecipe();
          return;
        }
        if (asset.kind === 'sequence') {
          onOpenSequence();
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
        onMenuOpen();
      }}
      title={asset.name}
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
          <span className="absolute bottom-1 left-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-mono text-white">
            {statusLabel}
          </span>
        )}
        {asset.generation?.status === 'generating' && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/35 text-xs text-white">
            <div className="rounded bg-black/60 px-2 py-1">{Math.round(asset.generation.progress ?? 0)}%</div>
          </div>
        )}
        {asset.generation?.status === 'error' && (
          <div
            className="absolute inset-0 flex items-center justify-center bg-red-900/30 text-xs text-white"
            aria-label={failureMessage ?? 'Generation failed.'}
            onMouseEnter={placeFailureTooltip}
            onMouseMove={placeFailureTooltip}
            onMouseLeave={() => setFailureTooltipVisible(false)}
          >
            <div className="flex flex-col items-center gap-1 rounded bg-red-900/75 px-2 py-1">
              <span>Generation failed</span>
              {failureIsBilling && (
                <a
                  className="inline-flex items-center gap-1 rounded border border-red-100/40 px-1.5 py-0.5 text-[10px] text-red-50 hover:bg-red-200/10"
                  href={PIAPI_BILLING_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(event) => event.stopPropagation()}
                  onMouseDown={(event) => event.stopPropagation()}
                >
                  Billing
                  <ExternalLink size={10} />
                </a>
              )}
            </div>
          </div>
        )}
        {failureMessage && failureTooltipVisible && (
          <div
            ref={failureTooltipRef}
            role="tooltip"
            className="pointer-events-none fixed left-3 top-3 z-[120] max-w-[min(24rem,calc(100vw-1.5rem))] rounded border border-red-300/40 bg-red-950/95 px-2.5 py-2 text-left text-[11px] leading-snug text-red-50 shadow-2xl"
          >
            {failureMessage}
          </div>
        )}
        {generatedWithUi && (
          <span
            className="absolute bottom-1 right-1 z-20 flex h-5 w-5 items-center justify-center rounded bg-brand-500/95 text-white shadow-[0_0_0_1px_rgba(255,255,255,0.18)]"
            title="Generated with AI"
          >
            <Sparkles size={11} />
          </span>
        )}
        {canInsert && (
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
                title="Asset name"
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
          ref={menuRef}
          className="fixed z-[80] min-w-[150px] rounded-md border border-surface-600 bg-surface-800 p-1 shadow-xl"
          onContextMenu={(e) => e.preventDefault()}
        >
          {canReusePrompt && (
            <>
              <button
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-slate-200 hover:bg-surface-700"
                onClick={() => {
                  onMenuClose();
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
              onMenuClose();
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
                onMenuClose();
                onOpenEdit();
              }}
            >
              <SlidersHorizontal size={12} />
              {asset.kind === 'character' ? 'Edit Character' : 'Edit'}
            </button>
          )}
          {asset.kind === 'character' && (
            <button
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-slate-200 hover:bg-surface-700"
              onClick={() => {
                const token = characterTokenForAsset(asset);
                if (token) void navigator.clipboard?.writeText(token);
                onMenuClose();
              }}
            >
              <Copy size={12} />
              Copy Reference
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
              onMenuClose();
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

function clampMediaMenuPosition(
  x: number,
  y: number,
  width = MEDIA_CONTEXT_MENU_WIDTH_PX,
  height = MEDIA_CONTEXT_MENU_MAX_HEIGHT_PX,
): { x: number; y: number } {
  const maxX = window.innerWidth - width - MEDIA_CONTEXT_MENU_MARGIN_PX;
  const maxY = window.innerHeight - height - MEDIA_CONTEXT_MENU_MARGIN_PX;
  return {
    x: Math.max(MEDIA_CONTEXT_MENU_MARGIN_PX, Math.min(x, maxX)),
    y: Math.max(MEDIA_CONTEXT_MENU_MARGIN_PX, Math.min(y, maxY)),
  };
}

function assetBadgeLabel(asset: MediaAsset): string {
  if (asset.kind === 'character') return 'Character';
  if (asset.kind === 'recipe') return 'Recipe';
  if (asset.kind === 'sequence') return 'Sequence';
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

function ToolbarIconButton({
  icon: Icon,
  label,
  onClick,
  disabled = false,
}: {
  icon: ComponentType<SVGProps<SVGSVGElement> & { size?: number | string }>;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  const [tooltip, setTooltip] = useState<{ x: number; y: number } | null>(null);

  return (
    <>
      <button
        type="button"
        className="btn-ghost flex h-7 w-7 shrink-0 items-center justify-center px-0 py-0"
        onClick={() => {
          setTooltip(null);
          onClick();
        }}
        disabled={disabled}
        aria-label={label}
        onMouseEnter={(event) => setTooltip({ x: event.clientX, y: event.clientY })}
        onMouseMove={(event) => setTooltip({ x: event.clientX, y: event.clientY })}
        onMouseLeave={() => setTooltip(null)}
      >
        <Icon size={14} />
      </button>
      {tooltip && !disabled && <MouseFollowTooltip x={tooltip.x} y={tooltip.y} label={label} />}
    </>
  );
}

function MouseFollowTooltip({ x, y, label }: { x: number; y: number; label: string }) {
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const tooltip = tooltipRef.current;
    if (!tooltip) return;
    const offsetX = 14;
    const offsetY = 18;
    const maxWidth = 240;
    const left = Math.min(x + offsetX, window.innerWidth - maxWidth - 8);
    const top = Math.min(y + offsetY, window.innerHeight - 32);
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  }, [x, y]);
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      ref={tooltipRef}
      role="tooltip"
      className="pointer-events-none fixed z-[200] max-w-[240px] whitespace-nowrap rounded-md border border-white/10 bg-surface-950/95 px-2 py-1 text-[11px] text-slate-100 shadow-lg"
    >
      {label}
    </div>,
    document.body,
  );
}
