import { useEffect, useMemo, useRef, useState } from 'react';
import { Film, Image as ImageIcon, Search, Upload, UserRound, X } from 'lucide-react';
import { isReferenceImageAsset } from '@/lib/media/characterReferences';
import { useMediaStore } from '@/state/mediaStore';
import type { MediaAsset } from '@/types';
import { isPiApiKlingModel, isPiApiSeedanceModel, type VideoModelDefinition } from '@/lib/videoModels/capabilities';

type MediaPickerMode = 'reference' | 'start' | 'end' | 'source-video';
type SortKey = 'recent' | 'name' | 'duration';

type Props = {
  assets: MediaAsset[];
  onClose: () => void;
  onPick: (asset: MediaAsset) => void;
  onImportFromComputer: () => void;
  pickerMode: MediaPickerMode;
  selectedModel?: VideoModelDefinition;
  allowCharacterReferences?: boolean;
  title?: string;
  helperText?: string;
  importLabel?: string;
  zIndexClassName?: string;
};

export function MediaPicker({
  assets,
  onClose,
  onPick,
  onImportFromComputer,
  pickerMode,
  selectedModel,
  allowCharacterReferences = true,
  title,
  helperText,
  importLabel = 'Import',
  zIndexClassName = 'z-[70]',
}: Props) {
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('recent');
  const visibleAssets = useMemo(() => {
    if (pickerMode === 'reference') {
      return assets.filter((asset) => isReferenceImageAsset(asset) && (allowCharacterReferences || asset.kind !== 'character'));
    }
    if (pickerMode === 'source-video') {
      return assets.filter((asset) => selectedModel ? isSourceVideoReferenceValid(selectedModel, asset) : asset.kind === 'video');
    }
    return assets.filter((asset) => asset.kind === 'image');
  }, [allowCharacterReferences, assets, pickerMode, selectedModel]);
  const filteredAssets = useMemo(() => {
    const q = query.trim().toLowerCase();
    return [...visibleAssets]
      .filter((asset) => {
        if (!q) return true;
        return [
          asset.name,
          asset.kind,
          asset.mimeType,
          asset.character?.characterId,
          asset.character?.description,
          `${asset.width ?? ''}x${asset.height ?? ''}`,
        ].join(' ').toLowerCase().includes(q);
      })
      .sort((a, b) => {
        if (sortKey === 'name') return a.name.localeCompare(b.name);
        if (sortKey === 'duration') return b.durationSec - a.durationSec || a.name.localeCompare(b.name);
        return b.createdAt - a.createdAt || a.name.localeCompare(b.name);
      });
  }, [query, sortKey, visibleAssets]);
  const resolvedHelperText = helperText ?? (pickerMode === 'reference'
    ? allowCharacterReferences
      ? 'Choose image or character references supported by the selected model.'
      : 'Choose image references from media or import new images.'
    : pickerMode === 'source-video'
      ? 'Choose one video reference.'
      : 'Only image assets are valid for frame slots.');
  const resolvedTitle = title ?? (pickerMode === 'source-video'
    ? 'Pick video reference'
    : pickerMode === 'reference'
      ? 'Pick references'
      : 'Pick frame image');
  const inputKindLabel = pickerMode === 'source-video' ? 'Video reference' : pickerMode === 'reference' ? 'Image input' : 'Frame image';

  return (
    <div className={`fixed inset-0 ${zIndexClassName} flex items-center justify-center bg-black/55 p-4`}>
      <div className="w-[min(960px,94vw)] overflow-hidden rounded-lg border border-white/15 bg-surface-950 shadow-2xl">
        <div className="border-b border-surface-700 p-3">
          <div className="mb-2 flex items-center justify-between">
            <div>
              <div className="text-sm font-semibold text-slate-100">{resolvedTitle}</div>
              <div className="text-xs text-slate-400">{resolvedHelperText}</div>
            </div>
            <button className="rounded p-1 text-slate-400 hover:bg-white/10 hover:text-white" onClick={onClose} title="Close" aria-label="Close"><X size={16} /></button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex h-9 min-w-[260px] flex-1 items-center gap-2 rounded-md border border-surface-700 bg-surface-900 px-3 text-xs text-slate-300 focus-within:border-brand-400">
              <Search size={14} className="text-slate-500" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search media by name, type, or size"
                className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-slate-500"
                autoFocus
              />
            </label>
            <SortPills value={sortKey} onChange={setSortKey} />
            <button className="btn-ghost h-9 px-3 text-xs" onClick={onImportFromComputer}><Upload size={12} /> {importLabel}</button>
          </div>
        </div>
        <div className="max-h-[min(640px,70vh)] overflow-auto p-2">
          <div className="mb-2 flex items-center justify-between px-1 text-[11px] text-slate-500">
            <span>{filteredAssets.length} of {visibleAssets.length} matching assets</span>
            <span>{inputKindLabel}</span>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {filteredAssets.map((asset) => (
              <MediaPickerAssetTile key={asset.id} asset={asset} onPick={onPick} />
            ))}
            {filteredAssets.length === 0 && <div className="col-span-full rounded-md border border-dashed border-surface-700 p-6 text-center text-xs text-slate-500">No matching media assets found.</div>}
          </div>
        </div>
      </div>
    </div>
  );
}

function MediaPickerAssetTile({
  asset,
  onPick,
}: {
  asset: MediaAsset;
  onPick: (asset: MediaAsset) => void;
}) {
  const objectUrlFor = useMediaStore((state) => state.objectUrlFor);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [hovered, setHovered] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null);
  const isVideo = asset.kind === 'video';

  useEffect(() => {
    if (asset.kind !== 'image' && asset.kind !== 'character') {
      setImagePreviewUrl(null);
      return;
    }

    let active = true;
    setImagePreviewUrl(null);
    void objectUrlFor(asset.id).then((url) => {
      if (active) setImagePreviewUrl(url);
    });

    return () => {
      active = false;
    };
  }, [asset.id, asset.kind, objectUrlFor]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !hovered || !previewUrl) return;
    try { video.currentTime = 0; } catch { /* metadata may not be ready yet */ }
    void video.play().catch(() => undefined);
  }, [hovered, previewUrl]);

  const startPreview = () => {
    if (!isVideo) return;
    setHovered(true);
    if (!previewUrl) {
      void objectUrlFor(asset.id).then((url) => {
        if (url) setPreviewUrl(url);
      });
    }
  };

  const stopPreview = () => {
    setHovered(false);
    const video = videoRef.current;
    if (!video) return;
    video.pause();
    try { video.currentTime = 0; } catch { /* noop */ }
  };

  const badge = mediaAssetBadgeLabel(asset).toUpperCase();
  return (
    <button
      type="button"
      className="group relative aspect-square min-w-0 overflow-hidden rounded-md border border-surface-700 bg-black text-left transition hover:border-brand-300/70 hover:shadow-[0_0_0_1px_rgba(124,140,255,0.35)] focus-visible:border-brand-300 focus-visible:outline-none"
      onClick={() => onPick(asset)}
      onMouseEnter={startPreview}
      onMouseLeave={stopPreview}
      onFocus={startPreview}
      onBlur={stopPreview}
      title={asset.name}
    >
      {isVideo && hovered && previewUrl ? (
        <video
          ref={videoRef}
          src={previewUrl}
          poster={asset.thumbnailDataUrl}
          muted
          loop
          playsInline
          preload="metadata"
          className="absolute inset-0 h-full w-full object-cover"
        />
      ) : imagePreviewUrl || asset.thumbnailDataUrl ? (
        <img
          src={imagePreviewUrl ?? asset.thumbnailDataUrl}
          alt=""
          className="absolute inset-0 h-full w-full object-cover transition duration-200 group-hover:scale-[1.015]"
          draggable={false}
          loading="lazy"
          decoding="async"
        />
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-surface-950 text-slate-500">
          {isVideo ? <Film size={26} /> : asset.kind === 'character' ? <UserRound size={26} /> : <ImageIcon size={26} />}
          <span className="text-[11px] uppercase tracking-[0.18em]">{asset.kind}</span>
        </div>
      )}
      <div className="absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-black/85 via-black/30 to-transparent" />
      <span className="absolute right-2 top-2 rounded-sm bg-black/70 px-1.5 py-1 text-[10px] font-semibold leading-none tracking-[0.12em] text-white shadow-sm">
        {badge}
      </span>
      {isVideo && asset.durationSec > 0 && (
        <span className="absolute left-2 top-2 rounded-sm bg-black/70 px-1.5 py-1 text-[10px] font-medium leading-none text-white shadow-sm">
          {asset.durationSec.toFixed(1)}s
        </span>
      )}
      <div className="absolute bottom-2 left-2 right-2">
        <div className="inline-flex max-w-full rounded-sm bg-black/75 px-2 py-1 text-[11px] font-medium leading-tight text-white shadow-sm ring-1 ring-white/10">
          <span className="truncate">{asset.name}</span>
        </div>
      </div>
    </button>
  );
}

function SortPills({
  value,
  onChange,
}: {
  value: SortKey;
  onChange: (value: SortKey) => void;
}) {
  const options: Array<{ value: SortKey; label: string }> = [
    { value: 'recent', label: 'Recent' },
    { value: 'name', label: 'Name' },
    { value: 'duration', label: 'Length' },
  ];
  return (
    <div className="inline-flex h-9 items-center gap-1 rounded-md border border-surface-700 bg-surface-950 px-1">
      {options.map((option) => (
        <button
          key={option.value}
          className={`h-7 rounded px-2.5 text-xs ${value === option.value ? 'bg-surface-700 text-slate-100' : 'text-slate-400 hover:bg-surface-800 hover:text-slate-200'}`}
          onClick={() => onChange(option.value)}
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function mediaAssetBadgeLabel(asset: MediaAsset): string {
  if (asset.kind === 'character') return 'character';
  const trimmed = asset.name.trim();
  const lastDot = trimmed.lastIndexOf('.');
  if (lastDot > 0 && lastDot < trimmed.length - 1) return trimmed.slice(lastDot + 1);
  const subtype = asset.mimeType.split('/')[1]?.split(';')[0];
  if (!subtype) return asset.kind;
  if (subtype === 'jpeg') return 'jpg';
  if (subtype === 'mpeg') return 'mp3';
  return subtype;
}

function isSourceVideoReferenceValid(model: VideoModelDefinition, asset: MediaAsset): boolean {
  if (asset.kind !== 'video') return false;
  if (isPiApiSeedanceModel(model)) return asset.durationSec <= 15.4;
  return isPiApiKlingModel(model);
}
