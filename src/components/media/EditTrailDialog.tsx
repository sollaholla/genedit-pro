import { Film, Image as ImageIcon, Pause, Play, RotateCcw, Save, Sparkles, Undo2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { DEFAULT_EDIT_TRAIL_TRANSFORM } from '@/lib/media/editTrail';
import { useMediaStore } from '@/state/mediaStore';
import type { EditTrailTransform, MediaAsset } from '@/types';

type Props = {
  assetId: string;
  onClose: () => void;
};

export function EditTrailDialog({ assetId, onClose }: Props) {
  const asset = useMediaStore((s) => s.assets.find((item) => item.id === assetId) ?? null);
  const ensureEditTrail = useMediaStore((s) => s.ensureEditTrail);
  const saveEditTrailIteration = useMediaStore((s) => s.saveEditTrailIteration);
  const setActiveEditTrailIteration = useMediaStore((s) => s.setActiveEditTrailIteration);
  const undoEditTrail = useMediaStore((s) => s.undoEditTrail);
  const objectUrlFor = useMediaStore((s) => s.objectUrlFor);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [draft, setDraft] = useState<EditTrailTransform>(DEFAULT_EDIT_TRAIL_TRANSFORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [videoCurrentTime, setVideoCurrentTime] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);
  const [videoPlaying, setVideoPlaying] = useState(false);

  useEffect(() => {
    if (!asset || (asset.kind !== 'image' && asset.kind !== 'video')) return;
    ensureEditTrail(asset.id);
  }, [asset, ensureEditTrail]);

  useEffect(() => {
    if (!asset) return;
    setDraft(asset.kind === 'video'
      ? asset.editTrail?.iterations.find((iteration) => iteration.id === asset.editTrail?.activeIterationId)?.transform ?? DEFAULT_EDIT_TRAIL_TRANSFORM
      : DEFAULT_EDIT_TRAIL_TRANSFORM);
  }, [asset]);

  useEffect(() => {
    let mounted = true;
    if (!asset?.blobKey) return;
    setSourceUrl(null);
    void objectUrlFor(asset.id).then((url) => {
      if (mounted) setSourceUrl(url);
    });
    return () => {
      mounted = false;
    };
  }, [asset?.blobKey, asset?.editTrail?.activeIterationId, asset?.id, objectUrlFor]);

  useEffect(() => {
    setVideoCurrentTime(0);
    setVideoDuration(0);
    setVideoPlaying(false);
  }, [sourceUrl]);

  const iterations = useMemo(() => {
    return [...(asset?.editTrail?.iterations ?? [])].sort((a, b) => b.createdAt - a.createdAt);
  }, [asset?.editTrail?.iterations]);
  const activeIteration = useMemo(() => {
    if (!asset?.editTrail) return null;
    return asset.editTrail.iterations.find((iteration) => iteration.id === asset.editTrail?.activeIterationId) ?? null;
  }, [asset?.editTrail]);
  const canUndo = Boolean(activeIteration && activeIteration.source !== 'original');

  if (!asset || (asset.kind !== 'image' && asset.kind !== 'video')) return null;

  const saveIteration = async () => {
    if (!sourceUrl || saving) return;
    setSaving(true);
    setError(null);
    try {
      if (asset.kind === 'image') {
        const file = await renderEditedImageFile(asset, sourceUrl, draft);
        await saveEditTrailIteration(asset.id, file, draft);
      } else {
        const thumbnail = asset.thumbnailDataUrl
          ? await renderEditedThumbnail(asset.thumbnailDataUrl, draft).catch(() => asset.thumbnailDataUrl)
          : undefined;
        await saveEditTrailIteration(asset.id, null, draft, thumbnail);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save edit iteration.');
    } finally {
      setSaving(false);
    }
  };

  const undoIteration = async () => {
    if (!canUndo || saving) return;
    setSaving(true);
    setError(null);
    try {
      await undoEditTrail(asset.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not undo edit iteration.');
    } finally {
      setSaving(false);
    }
  };

  const toggleVideoPlayback = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      void video.play();
      return;
    }
    video.pause();
  };

  const scrubVideo = (value: number) => {
    const video = videoRef.current;
    if (!video || !Number.isFinite(value)) return;
    video.currentTime = value;
    setVideoCurrentTime(value);
  };

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <div className="flex h-[min(760px,92vh)] w-[min(1120px,96vw)] overflow-hidden rounded-xl border border-white/12 bg-[#0b1020] text-slate-100 shadow-2xl">
        <aside className="flex w-64 shrink-0 flex-col border-r border-white/10 bg-black/20">
          <div className="border-b border-white/10 px-3 py-3">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-xs font-semibold uppercase tracking-wider text-slate-500">Edit Trail</div>
                <div className="truncate text-sm font-semibold text-slate-100">{asset.name}</div>
              </div>
              <button className="rounded-md p-1 text-slate-400 hover:bg-white/10 hover:text-slate-100" onClick={onClose} title="Close" aria-label="Close">
                <X size={16} />
              </button>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            <div className="space-y-2">
              {iterations.map((iteration) => {
                const active = iteration.id === asset.editTrail?.activeIterationId;
                return (
                  <button
                    type="button"
                    key={iteration.id}
                    aria-current={active ? 'true' : undefined}
                    onClick={() => setActiveEditTrailIteration(asset.id, iteration.id)}
                    className={`w-full rounded-lg border p-2 text-left transition ${
                      active
                        ? 'border-emerald-400/80 bg-emerald-500/10 shadow-[0_0_0_1px_rgba(52,211,153,0.18)]'
                        : 'border-white/10 bg-white/[0.03] hover:border-brand-300/70 hover:bg-brand-500/10 focus-visible:border-brand-300/80 focus-visible:outline-none'
                    }`}
                  >
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-xs font-semibold text-slate-100">{iteration.label}</div>
                        <div className="text-[10px] uppercase tracking-wide text-slate-500">
                          {active ? 'Current source' : iteration.source}
                        </div>
                      </div>
                      {active && <span className="rounded-full bg-emerald-400/15 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-200">Active</span>}
                    </div>
                    <div className="aspect-video overflow-hidden rounded bg-black/35">
                      {iteration.thumbnailDataUrl ? (
                        <img src={iteration.thumbnailDataUrl} alt="" className="h-full w-full object-cover" />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center text-slate-500">
                          {asset.kind === 'video' ? <Film size={18} /> : <ImageIcon size={18} />}
                        </div>
                      )}
                    </div>
                    <div className="mt-2 grid grid-cols-3 gap-1 text-[10px] text-slate-500">
                      <span>{Math.round(iteration.transform.scale * 100)}%</span>
                      <span>x {Math.round(iteration.transform.offsetX)}</span>
                      <span>y {Math.round(iteration.transform.offsetY)}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
            <div>
              <div className="text-sm font-semibold">{asset.kind === 'video' ? 'Video Edit' : 'Image Edit'}</div>
              <div className="text-xs text-slate-500">Zoom and offset update the active edit.</div>
            </div>
            <div className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-slate-400">
              {iterations.length} {iterations.length === 1 ? 'iteration' : 'iterations'}
            </div>
          </div>

          <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_240px]">
            <div className="min-h-0 bg-black p-4">
              <div className="flex h-full items-center justify-center overflow-hidden rounded-lg border border-white/10 bg-[radial-gradient(circle_at_center,rgba(255,255,255,0.08)_1px,transparent_1px)] [background-size:18px_18px]">
                {sourceUrl ? (
                  asset.kind === 'video' ? (
                    <div className="relative flex h-full w-full items-center justify-center">
                      <video
                        key={sourceUrl}
                        ref={videoRef}
                        src={sourceUrl}
                        muted
                        loop
                        playsInline
                        className="max-h-full max-w-full object-contain"
                        style={transformStyle(draft)}
                        onLoadedMetadata={(event) => {
                          const duration = event.currentTarget.duration;
                          setVideoDuration(Number.isFinite(duration) ? duration : 0);
                          setVideoCurrentTime(event.currentTarget.currentTime || 0);
                        }}
                        onTimeUpdate={(event) => setVideoCurrentTime(event.currentTarget.currentTime || 0)}
                        onPlay={() => setVideoPlaying(true)}
                        onPause={() => setVideoPlaying(false)}
                      />
                      <div className="pointer-events-auto absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-black/90 via-black/50 to-transparent px-4 pb-3 pt-12">
                        <div className="mb-2 flex items-center gap-3 text-white">
                          <button
                            type="button"
                            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20"
                            onClick={toggleVideoPlayback}
                            title={videoPlaying ? 'Pause' : 'Play'}
                            aria-label={videoPlaying ? 'Pause' : 'Play'}
                          >
                            {videoPlaying ? <Pause size={16} /> : <Play size={16} />}
                          </button>
                          <div className="font-mono text-sm tabular-nums">
                            {formatPlaybackTime(videoCurrentTime)} / {formatPlaybackTime(videoDuration)}
                          </div>
                        </div>
                        <input
                          type="range"
                          min={0}
                          max={videoDuration || 0}
                          step={0.01}
                          value={Math.min(videoCurrentTime, videoDuration || videoCurrentTime || 0)}
                          disabled={!videoDuration}
                          onChange={(event) => scrubVideo(Number(event.target.value))}
                          className="block h-1 w-full accent-white disabled:opacity-40"
                          aria-label="Video scrubber"
                        />
                      </div>
                    </div>
                  ) : (
                    <img
                      src={sourceUrl}
                      alt=""
                      draggable={false}
                      className="max-h-full max-w-full select-none object-contain"
                      style={transformStyle(draft)}
                    />
                  )
                ) : (
                  <div className="text-sm text-slate-500">Loading source…</div>
                )}
              </div>
            </div>

            <div className="border-l border-white/10 bg-black/20 p-3">
              <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-500">Transform</div>
              <ControlSlider
                label="Zoom"
                min={25}
                max={300}
                value={Math.round(draft.scale * 100)}
                suffix="%"
                onChange={(value) => setDraft((prev) => ({ ...prev, scale: value / 100 }))}
              />
              <ControlSlider
                label="Offset X"
                min={-600}
                max={600}
                value={Math.round(draft.offsetX)}
                onChange={(value) => setDraft((prev) => ({ ...prev, offsetX: value }))}
              />
              <ControlSlider
                label="Offset Y"
                min={-600}
                max={600}
                value={Math.round(draft.offsetY)}
                onChange={(value) => setDraft((prev) => ({ ...prev, offsetY: value }))}
              />
              <button
                className="mt-2 inline-flex h-8 items-center gap-1 rounded-full border border-white/15 bg-white/5 px-3 text-xs text-slate-300 hover:bg-white/10"
                onClick={() => setDraft(DEFAULT_EDIT_TRAIL_TRANSFORM)}
              >
                <RotateCcw size={13} />
                Reset view
              </button>
            </div>
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-white/10 px-4 py-3">
            <div className="min-w-0 text-xs text-rose-300">{error}</div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                className="inline-flex h-9 items-center gap-1 rounded-full border border-white/15 bg-white/5 px-3 text-sm text-slate-300 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-45"
                disabled={!canUndo || saving}
                onClick={undoIteration}
              >
                <Undo2 size={14} />
                Undo
              </button>
              <button
                className="inline-flex h-9 items-center gap-1 rounded-full border border-white/15 bg-white/5 px-3 text-sm text-slate-400 disabled:cursor-not-allowed disabled:opacity-45"
                disabled
                title="Prompt-based generation will plug into this edit trail next."
              >
                <Sparkles size={14} />
                Generate
              </button>
              <button
                className="inline-flex h-9 items-center gap-1 rounded-full bg-emerald-400 px-4 text-sm font-semibold text-black hover:bg-emerald-300 disabled:cursor-not-allowed disabled:bg-slate-500"
                disabled={saving || !sourceUrl}
                onClick={saveIteration}
              >
                <Save size={14} />
                {saving ? 'Saving…' : 'Save edit'}
              </button>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

function ControlSlider({
  label,
  min,
  max,
  value,
  suffix = '',
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  value: number;
  suffix?: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="mb-4 block">
      <div className="mb-1 flex items-center justify-between text-xs">
        <span className="text-slate-400">{label}</span>
        <span className="font-mono text-slate-200">{value}{suffix}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-emerald-400"
      />
    </label>
  );
}

function transformStyle(transform: EditTrailTransform): CSSProperties {
  return {
    transform: `translate(${transform.offsetX}px, ${transform.offsetY}px) scale(${transform.scale})`,
    transformOrigin: 'center center',
  };
}

function formatPlaybackTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
  const whole = Math.floor(seconds);
  const minutes = Math.floor(whole / 60);
  const remaining = whole % 60;
  return `${minutes}:${remaining.toString().padStart(2, '0')}`;
}

async function renderEditedImageFile(asset: MediaAsset, sourceUrl: string, transform: EditTrailTransform): Promise<File> {
  const img = await loadImage(sourceUrl);
  const width = img.naturalWidth || asset.width || 1920;
  const height = img.naturalHeight || asset.height || 1080;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas rendering is unavailable.');
  ctx.clearRect(0, 0, width, height);
  drawTransformed(ctx, img, width, height, transform);
  const blob = await canvasToBlob(canvas, 'image/png');
  const baseName = asset.name.replace(/\.[^.]+$/, '') || 'edited-image';
  return new File([blob], `${baseName}-edit.png`, { type: 'image/png' });
}

async function renderEditedThumbnail(dataUrl: string, transform: EditTrailTransform): Promise<string> {
  const img = await loadImage(dataUrl);
  const width = img.naturalWidth || 240;
  const height = img.naturalHeight || 135;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return dataUrl;
  ctx.clearRect(0, 0, width, height);
  drawTransformed(ctx, img, width, height, transform);
  return canvas.toDataURL('image/jpeg', 0.78);
}

function drawTransformed(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  width: number,
  height: number,
  transform: EditTrailTransform,
) {
  const drawWidth = width * transform.scale;
  const drawHeight = height * transform.scale;
  const x = (width - drawWidth) / 2 + transform.offsetX;
  const y = (height - drawHeight) / 2 + transform.offsetY;
  ctx.drawImage(image, x, y, drawWidth, drawHeight);
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not load the edit source.'));
    img.src = src;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Could not render the edit iteration.'));
    }, type);
  });
}
