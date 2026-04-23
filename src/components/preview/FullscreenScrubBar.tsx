import { useCallback, useEffect, useRef, useState } from 'react';
import { useProjectStore } from '@/state/projectStore';
import { usePlaybackStore } from '@/state/playbackStore';
import { useMediaStore } from '@/state/mediaStore';
import { resolveFrame } from '@/lib/playback/engine';
import { projectDurationSec } from '@/lib/timeline/operations';
import { formatTimecode } from '@/lib/timeline/geometry';

const PREVIEW_WIDTH = 220;
const PREVIEW_HEIGHT = 124;
const SEEK_THROTTLE_MS = 40;

export function FullscreenScrubBar() {
  const project = useProjectStore((s) => s.project);
  const currentTime = usePlaybackStore((s) => s.currentTimeSec);
  const setCurrentTime = usePlaybackStore((s) => s.setCurrentTime);
  const pause = usePlaybackStore((s) => s.pause);
  const assets = useMediaStore((s) => s.assets);
  const objectUrlFor = useMediaStore((s) => s.objectUrlFor);

  const barRef = useRef<HTMLDivElement | null>(null);
  const previewVideoRef = useRef<HTMLVideoElement | null>(null);
  const currentSrcAssetRef = useRef<string | null>(null);
  const lastSeekAtRef = useRef(0);
  const pendingSeekTimeRef = useRef<number | null>(null);

  const [hover, setHover] = useState<{ x: number; time: number } | null>(null);
  const [previewHasFrame, setPreviewHasFrame] = useState(false);
  const [barWidth, setBarWidth] = useState(0);

  const duration = projectDurationSec(project);

  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBarWidth(el.clientWidth));
    ro.observe(el);
    setBarWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const xToTime = useCallback((clientX: number): number => {
    const rect = barRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || duration === 0) return 0;
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return ratio * duration;
  }, [duration]);

  const seekPreviewTo = useCallback((time: number) => {
    const vid = previewVideoRef.current;
    if (!vid) return;
    if (vid.seeking) {
      pendingSeekTimeRef.current = time;
      return;
    }
    const now = performance.now();
    if (now - lastSeekAtRef.current < SEEK_THROTTLE_MS) {
      pendingSeekTimeRef.current = time;
      return;
    }
    if (Math.abs(vid.currentTime - time) > 0.02) {
      lastSeekAtRef.current = now;
      try { vid.currentTime = time; } catch { /* noop */ }
    }
  }, []);

  // Apply any pending seek when the preview finishes a seek.
  useEffect(() => {
    const vid = previewVideoRef.current;
    if (!vid) return;
    const onSeeked = () => {
      const pending = pendingSeekTimeRef.current;
      pendingSeekTimeRef.current = null;
      if (pending !== null) seekPreviewTo(pending);
    };
    vid.addEventListener('seeked', onSeeked);
    return () => vid.removeEventListener('seeked', onSeeked);
  }, [seekPreviewTo]);

  const updatePreview = useCallback(async (time: number) => {
    const vid = previewVideoRef.current;
    if (!vid) return;
    const frame = resolveFrame(project, time);
    if (!frame.video) {
      vid.style.display = 'none';
      setPreviewHasFrame(false);
      return;
    }
    const asset = assets.find((a) => a.id === frame.video!.clip.assetId);
    if (!asset) {
      vid.style.display = 'none';
      setPreviewHasFrame(false);
      return;
    }
    vid.style.display = '';
    setPreviewHasFrame(true);

    if (currentSrcAssetRef.current !== asset.id) {
      currentSrcAssetRef.current = asset.id;
      const url = await objectUrlFor(asset.id);
      if (!url || !previewVideoRef.current) return;
      // Race: user may have moved to a different asset mid-fetch.
      if (currentSrcAssetRef.current !== asset.id) return;
      previewVideoRef.current.src = url;
    }
    seekPreviewTo(frame.video.sourceTimeSec);
  }, [project, assets, objectUrlFor, seekPreviewTo]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const t = xToTime(e.clientX);
    const rect = barRef.current?.getBoundingClientRect();
    const x = rect ? e.clientX - rect.left : 0;
    setHover({ x, time: t });
    void updatePreview(t);
  }, [xToTime, updatePreview]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    pause();
    const t = xToTime(e.clientX);
    setCurrentTime(t);

    const onMove = (ev: MouseEvent) => {
      const time = xToTime(ev.clientX);
      setCurrentTime(time);
      const rect = barRef.current?.getBoundingClientRect();
      const x = rect ? ev.clientX - rect.left : 0;
      setHover({ x, time });
      void updatePreview(time);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [xToTime, setCurrentTime, updatePreview, pause]);

  if (duration === 0) return null;

  const progressPct = Math.min(100, (currentTime / duration) * 100);
  const hoverPct = hover ? Math.min(100, (hover.time / duration) * 100) : 0;

  // Clamp preview tooltip X so it stays onscreen.
  const tooltipX = hover
    ? Math.max(PREVIEW_WIDTH / 2 + 6, Math.min(barWidth - PREVIEW_WIDTH / 2 - 6, hover.x))
    : 0;

  return (
    <div className="relative w-full px-4">
      {hover && (
        <div
          className="pointer-events-none absolute -translate-x-1/2 rounded border border-surface-600 bg-black/90 p-1 shadow-xl"
          style={{ left: tooltipX + 16, bottom: '100%', marginBottom: 10 }}
        >
          <div
            className="relative overflow-hidden rounded bg-black"
            style={{ width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT }}
          >
            <video
              ref={previewVideoRef}
              muted
              playsInline
              preload="auto"
              className="absolute inset-0 h-full w-full object-contain"
              style={{ display: 'none' }}
            />
            {!previewHasFrame && (
              <div className="absolute inset-0 flex items-center justify-center text-[10px] text-slate-500">
                No clip here
              </div>
            )}
          </div>
          <div className="mt-1 text-center font-mono text-[10px] text-slate-200">
            {formatTimecode(hover.time, project.fps)}
          </div>
        </div>
      )}

      <div
        ref={barRef}
        className="group relative h-1.5 cursor-pointer rounded-full bg-white/20 transition-[height] hover:h-2.5"
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHover(null)}
        onMouseDown={handleMouseDown}
      >
        {/* Hover fill (ghost progress up to hovered time) */}
        {hover && (
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-white/25"
            style={{ width: `${hoverPct}%` }}
          />
        )}
        {/* Actual progress */}
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-brand-500"
          style={{ width: `${progressPct}%` }}
        />
        {/* Playhead knob */}
        <div
          className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white opacity-0 shadow-[0_0_0_2px_rgba(91,110,255,0.8)] transition-opacity group-hover:opacity-100"
          style={{ left: `${progressPct}%` }}
        />
      </div>
    </div>
  );
}
