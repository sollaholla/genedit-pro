import { useState } from 'react';
import { Film, Image as ImageIcon, Music, Trash2, Upload } from 'lucide-react';
import { useMediaStore } from '@/state/mediaStore';
import type { MediaAsset } from '@/types';

type Props = {
  onImportClick: () => void;
};

const kindIcon = {
  video: Film,
  audio: Music,
  image: ImageIcon,
};

export function MediaBin({ onImportClick }: Props) {
  const assets = useMediaStore((s) => s.assets);
  const importing = useMediaStore((s) => s.importing);
  const importFiles = useMediaStore((s) => s.importFiles);
  const removeAsset = useMediaStore((s) => s.removeAsset);
  const [dragOver, setDragOver] = useState(false);

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
        <button className="btn-ghost px-2 py-1 text-xs" onClick={onImportClick} disabled={importing}>
          <Upload size={12} />
          {importing ? 'Importing…' : 'Import'}
        </button>
      </div>
      <div
        className={`relative min-h-0 flex-1 overflow-auto p-2 ${
          dragOver ? 'outline outline-2 -outline-offset-4 outline-brand-500/70' : ''
        }`}
      >
        {assets.length === 0 ? (
          <EmptyState onImportClick={onImportClick} />
        ) : (
          <ul className="grid grid-cols-2 gap-2">
            {assets.map((asset) => (
              <MediaTile key={asset.id} asset={asset} onDelete={() => removeAsset(asset.id)} />
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

function MediaTile({ asset, onDelete }: { asset: MediaAsset; onDelete: () => void }) {
  const Icon = kindIcon[asset.kind];
  return (
    <li
      className="group relative cursor-grab overflow-hidden rounded-md border border-surface-700 bg-surface-800 hover:border-surface-500 active:cursor-grabbing"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('application/x-genedit-asset', asset.id);
        e.dataTransfer.effectAllowed = 'copy';
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
        <span className="absolute right-1 top-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-mono text-white">
          {asset.durationSec.toFixed(1)}s
        </span>
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
    </li>
  );
}
