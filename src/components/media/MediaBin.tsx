import { useEffect, useMemo, useState } from 'react';
import { Film, FolderPlus, Image as ImageIcon, Music, Sparkles, Trash2, Upload, BookOpen } from 'lucide-react';
import { useMediaStore } from '@/state/mediaStore';
import type { MediaAsset } from '@/types';

type Props = {
  onImportClick: () => void;
  onGenerateClick: () => void;
  onOpenRecipe: (asset: MediaAsset) => void;
};

const kindIcon = {
  video: Film,
  audio: Music,
  image: ImageIcon,
  recipe: BookOpen,
};

export function MediaBin({ onImportClick, onGenerateClick, onOpenRecipe }: Props) {
  const assets = useMediaStore((s) => s.assets);
  const folders = useMediaStore((s) => s.folders);
  const createFolder = useMediaStore((s) => s.createFolder);
  const importing = useMediaStore((s) => s.importing);
  const importFiles = useMediaStore((s) => s.importFiles);
  const removeAsset = useMediaStore((s) => s.removeAsset);
  const renameAsset = useMediaStore((s) => s.renameAsset);
  const [dragOver, setDragOver] = useState(false);
  const [activeFolderId, setActiveFolderId] = useState<string | null>(null);
  const visibleAssets = useMemo(
    () => assets.filter((a) => (activeFolderId ? a.folderId === activeFolderId : true)),
    [assets, activeFolderId],
  );

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
                onOpenRecipe={() => onOpenRecipe(asset)}
              />
            ))}
          </ul>
        )}
      </div>
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

function MediaTile({
  asset,
  onDelete,
  onRename,
  onOpenRecipe,
}: {
  asset: MediaAsset;
  onDelete: () => void;
  onRename: (name: string) => void;
  onOpenRecipe: () => void;
}) {
  const Icon = kindIcon[asset.kind];
  const objectUrlFor = useMediaStore((s) => s.objectUrlFor);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [playingPreview, setPlayingPreview] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState({ x: 0, y: 0 });

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
    let mounted = true;
    if (!playingPreview || asset.kind !== 'video' || !asset.blobKey || asset.generation?.status === 'generating') {
      return;
    }
    void objectUrlFor(asset.id).then((url) => {
      if (mounted) setVideoUrl(url);
    });
    return () => {
      mounted = false;
    };
  }, [playingPreview, asset.id, asset.kind, asset.blobKey, asset.generation?.status, objectUrlFor]);

  return (
    <li
      className="group relative cursor-grab overflow-hidden rounded-md border border-surface-700 bg-surface-800 hover:border-surface-500 active:cursor-grabbing"
      draggable
      onDragStart={(e) => {
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
        if (asset.kind !== 'video' || asset.generation?.status === 'generating' || !asset.blobKey) return;
        setPlayingPreview((v) => !v);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenuPos({ x: e.clientX, y: e.clientY });
        setMenuOpen(true);
      }}
      title={asset.name}
    >
      <div className="relative aspect-video bg-surface-900">
        {playingPreview && videoUrl ? (
          <video
            src={videoUrl}
            autoPlay
            muted
            loop
            playsInline
            className="h-full w-full object-cover"
          />
        ) : asset.thumbnailDataUrl ? (
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
        <span className="absolute right-1 top-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-mono text-white">
          {asset.kind === 'recipe' ? 'Recipe' : asset.generation?.status === 'generating' ? 'Generating' : `${asset.durationSec.toFixed(1)}s`}
        </span>
        {asset.generation?.status === 'generating' && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/35 text-xs text-white">
            <div className="rounded bg-black/60 px-2 py-1">{Math.round(asset.generation.progress ?? 0)}%</div>
          </div>
        )}
        {asset.generation?.status === 'error' && (
          <div className="absolute inset-0 flex items-center justify-center bg-red-900/30 text-xs text-white">
            <div className="rounded bg-red-900/70 px-2 py-1">Generation failed</div>
          </div>
        )}
      </div>
      <div className="flex items-center justify-between px-2 py-1.5">
        <div className="flex min-w-0 items-center gap-1.5 text-xs">
          <Icon size={12} className="shrink-0 text-slate-400" />
          <span className="truncate">{asset.name}</span>
        </div>
        <button
          className="shrink-0 rounded p-1 text-slate-500 opacity-0 transition-opacity hover:text-red-400 group-hover:opacity-100"
          onClick={onDelete}
          title="Remove"
        >
          <Trash2 size={12} />
        </button>
      </div>
      {menuOpen && (
        <div
          className="fixed z-[80] min-w-[130px] rounded-md border border-surface-600 bg-surface-800 p-1 shadow-xl"
          style={{ left: menuPos.x, top: menuPos.y }}
        >
          <button
            className="block w-full rounded px-2 py-1 text-left text-xs text-slate-200 hover:bg-surface-700"
            onClick={() => {
              const nextName = window.prompt('Rename media item', asset.name);
              if (nextName?.trim()) onRename(nextName);
              setMenuOpen(false);
            }}
          >
            Rename
          </button>
        </div>
      )}
    </li>
  );
}
