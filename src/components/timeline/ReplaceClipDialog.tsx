import { useEffect, useMemo, useRef, useState } from 'react';
import { Upload, X } from 'lucide-react';
import type { Clip, MediaAsset, MediaKind } from '@/types';
import { useMediaStore } from '@/state/mediaStore';
import { useProjectStore } from '@/state/projectStore';
import { replaceClipAsset } from '@/lib/timeline/operations';
import { formatTimecode } from '@/lib/timeline/geometry';

type Props = {
  clip: Clip;
  requiredKind: MediaKind;
  onClose: () => void;
};

export function ReplaceClipDialog({ clip, requiredKind, onClose }: Props) {
  const assets = useMediaStore((s) => s.assets);
  const importFiles = useMediaStore((s) => s.importFiles);
  const objectUrlFor = useMediaStore((s) => s.objectUrlFor);
  const update = useProjectStore((s) => s.update);

  const compatible = useMemo(() => assets.filter((a) => a.kind === requiredKind), [assets, requiredKind]);
  const [pickedId, setPickedId] = useState<string | null>(compatible[0]?.id ?? null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const picked = compatible.find((a) => a.id === pickedId) ?? null;

  // Default trim to match the original clip's on-timeline duration, clamped into the new asset.
  const origDuration = clip.outSec - clip.inSec;
  const [inSec, setInSec] = useState(0);
  const [outSec, setOutSec] = useState(origDuration);

  // When picked asset changes, reset trim to [0, min(origDuration, assetDuration)].
  useEffect(() => {
    if (!picked) return;
    const assetDur = picked.durationSec;
    setInSec(0);
    setOutSec(Math.min(origDuration, assetDur));
  }, [picked, origDuration]);

  // Load object URL for preview.
  useEffect(() => {
    let cancelled = false;
    if (!pickedId) { setPreviewUrl(null); return; }
    objectUrlFor(pickedId).then((url) => { if (!cancelled) setPreviewUrl(url); });
    return () => { cancelled = true; };
  }, [pickedId, objectUrlFor]);

  // Escape to close.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement | null>(null);
  // Keep preview element in sync with inSec.
  useEffect(() => {
    const el = mediaRef.current;
    if (!el) return;
    try { el.currentTime = inSec; } catch { /* noop */ }
  }, [inSec, previewUrl]);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const pickedDuration = picked?.durationSec ?? 0;
  const segmentDuration = Math.max(0, outSec - inSec);
  const canApply = picked && segmentDuration >= 0.05;

  const apply = () => {
    if (!picked) return;
    update((p) => replaceClipAsset(p, clip.id, picked.id, inSec, outSec));
    onClose();
  };

  const onImport = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const added = await importFiles(Array.from(files));
    const first = added.find((a) => a.kind === requiredKind);
    if (first) setPickedId(first.id);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="flex w-[min(720px,95vw)] max-h-[90vh] flex-col overflow-hidden rounded-lg border border-surface-600 bg-surface-900 shadow-xl">
        <div className="flex items-center justify-between border-b border-surface-700 px-4 py-2.5">
          <div>
            <div className="text-sm font-semibold text-slate-100">Replace Clip</div>
            <div className="text-[11px] text-slate-400">
              Swap the underlying {requiredKind} and edit which portion to use.
            </div>
          </div>
          <button
            type="button"
            className="rounded p-1 text-slate-400 hover:bg-surface-700 hover:text-slate-100"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 gap-3 overflow-auto p-4">
          {/* Asset picker */}
          <div className="flex w-56 shrink-0 flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                {requiredKind} assets
              </span>
              <button
                type="button"
                className="flex items-center gap-1 text-[11px] text-slate-400 hover:text-slate-200"
                onClick={() => fileInputRef.current?.click()}
              >
                <Upload size={11} /> Import
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept={`${requiredKind}/*`}
                multiple
                className="hidden"
                onChange={(e) => { void onImport(e.currentTarget.files); e.currentTarget.value = ''; }}
              />
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-auto rounded bg-surface-950/60 p-1">
              {compatible.length === 0 && (
                <div className="p-3 text-center text-[11px] text-slate-500">
                  No compatible {requiredKind} assets. Import one above.
                </div>
              )}
              {compatible.map((a) => (
                <AssetPickerItem
                  key={a.id}
                  asset={a}
                  selected={pickedId === a.id}
                  onSelect={() => setPickedId(a.id)}
                />
              ))}
            </div>
          </div>

          {/* Preview + trim */}
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            <div className="flex min-h-[180px] items-center justify-center rounded bg-black">
              {picked && previewUrl ? (
                requiredKind === 'audio' ? (
                  <audio
                    ref={mediaRef as React.RefObject<HTMLAudioElement>}
                    src={previewUrl}
                    controls
                    className="w-full px-4"
                  />
                ) : (
                  <video
                    ref={mediaRef as React.RefObject<HTMLVideoElement>}
                    src={previewUrl}
                    controls
                    className="max-h-[280px] w-full"
                  />
                )
              ) : (
                <div className="py-12 text-xs text-slate-500">Pick an asset on the left to preview.</div>
              )}
            </div>

            {picked && (
              <div className="space-y-3 rounded border border-surface-700 bg-surface-800/40 p-3">
                <div className="flex items-center justify-between text-[11px] text-slate-400">
                  <span>Source duration</span>
                  <span className="font-mono">{formatTimecode(pickedDuration, 30)}</span>
                </div>
                <TrimRow
                  label="In"
                  value={inSec}
                  min={0}
                  max={Math.max(0, outSec - 0.05)}
                  step={1 / 30}
                  onChange={setInSec}
                />
                <TrimRow
                  label="Out"
                  value={outSec}
                  min={Math.min(pickedDuration, inSec + 0.05)}
                  max={pickedDuration}
                  step={1 / 30}
                  onChange={setOutSec}
                />
                <div className="flex items-center justify-between text-[11px] text-slate-400">
                  <span>On-timeline duration</span>
                  <span className="font-mono text-slate-200">{formatTimecode(segmentDuration, 30)}</span>
                </div>
                <p className="text-[10px] leading-tight text-slate-500">
                  The clip&apos;s position on the timeline stays the same; its length will
                  become {formatTimecode(segmentDuration, 30)} after replace.
                </p>
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-surface-700 px-4 py-2.5">
          <button
            type="button"
            className="rounded bg-surface-700 px-3 py-1.5 text-xs text-slate-200 hover:bg-surface-600"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rounded bg-brand-500 px-3 py-1.5 text-xs text-white hover:bg-brand-400 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={!canApply}
            onClick={apply}
          >
            Replace
          </button>
        </div>
      </div>
    </div>
  );
}

function AssetPickerItem({
  asset,
  selected,
  onSelect,
}: {
  asset: MediaAsset;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={`flex items-center gap-2 rounded px-2 py-1.5 text-left text-[11px] hover:bg-surface-800 ${
        selected ? 'bg-surface-700 text-slate-100' : 'text-slate-300'
      }`}
      onClick={onSelect}
    >
      {asset.thumbnailDataUrl ? (
        <img src={asset.thumbnailDataUrl} alt="" className="h-8 w-10 shrink-0 rounded object-cover" />
      ) : (
        <div className="h-8 w-10 shrink-0 rounded bg-surface-700" />
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate">{asset.name}</div>
        <div className="font-mono text-[10px] text-slate-500">
          {formatTimecode(asset.durationSec, 30)}
        </div>
      </div>
    </button>
  );
}

function TrimRow({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  const clamp = (n: number) => Math.max(min, Math.min(max, n));
  return (
    <div className="flex items-center gap-2">
      <span className="w-8 shrink-0 text-[11px] text-slate-400">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={clamp(value)}
        onChange={(e) => onChange(Number(e.target.value))}
        className="volume-slider flex-1"
      />
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={clamp(value).toFixed(2)}
        onChange={(e) => onChange(clamp(Number(e.target.value)))}
        className="w-16 rounded bg-surface-700 px-1.5 py-0.5 text-right font-mono text-[11px] text-slate-200"
      />
    </div>
  );
}
