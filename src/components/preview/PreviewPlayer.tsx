import { useEffect, useMemo, useRef, useState } from 'react';
import { useMediaStore } from '@/state/mediaStore';
import { usePlaybackStore } from '@/state/playbackStore';
import { useProjectStore } from '@/state/projectStore';
import { resolveFrame, type ActiveLayer } from '@/lib/playback/engine';
import { projectDurationSec } from '@/lib/timeline/operations';
import { evalEnvelopeAt } from '@/lib/timeline/envelope';
import { PlayerControls } from './PlayerControls';
import { FullscreenScrubBar } from './FullscreenScrubBar';

function effectiveVolume(layer: ActiveLayer): number {
  const master = Math.max(0, Math.min(2, layer.clip.volume ?? 1));
  const clipDur = Math.max(1e-6, layer.clip.outSec - layer.clip.inSec);
  const localT = Math.max(0, Math.min(1, (layer.sourceTimeSec - layer.clip.inSec) / clipDur));
  const envMul = evalEnvelopeAt(layer.clip.volumeEnvelope, localT);
  return master * envMul;
}

type ElementPool = Map<string, HTMLMediaElement>;

function seekIfNeeded(el: HTMLMediaElement, target: number, playing: boolean) {
  const drift = Math.abs(el.currentTime - target);
  const threshold = playing ? 0.15 : 0.015;
  if (drift > threshold && !el.seeking && el.readyState >= 1) {
    try { el.currentTime = target; } catch { /* noop */ }
  }
}

export function PreviewPlayer() {
  const project = useProjectStore((s) => s.project);
  const assets = useMediaStore((s) => s.assets);
  const objectUrlFor = useMediaStore((s) => s.objectUrlFor);
  const currentTime = usePlaybackStore((s) => s.currentTimeSec);
  const setCurrentTime = usePlaybackStore((s) => s.setCurrentTime);
  const pause = usePlaybackStore((s) => s.pause);

  const videoHostRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Pools keyed by CLIP id (not asset id). Overlapping clips of the same asset
  // each need their own HTMLMediaElement, otherwise a single element's
  // currentTime is fought over by multiple layers each frame, producing a
  // rapid "flipping" effect in audio and video.
  const videoPool = useRef<ElementPool>(new Map());
  const audioPool = useRef<ElementPool>(new Map());
  const clipAssetRef = useRef<Map<string, string>>(new Map()); // clipId -> assetId that el.src is set to
  const urlCache = useRef<Map<string, string>>(new Map()); // assetId -> object URL
  const lastTickRef = useRef<number | null>(null);
  const prevHasVideoRef = useRef(false);
  const [hasActiveVideo, setHasActiveVideo] = useState(false);
  const [ready, setReady] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
    } else {
      void containerRef.current?.requestFullscreen().catch(() => undefined);
    }
  };

  useEffect(() => {
    const onChange = () => setIsFullscreen(document.fullscreenElement === containerRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const duration = useMemo(() => projectDurationSec(project), [project]);

  // Reconcile: one HTMLMediaElement per clip (not per asset). Shared blob URLs
  // are cached per-asset in urlCache. Each clip's element uses the URL of its
  // assetId; when the assetId changes (e.g. via Replace), we update el.src.
  useEffect(() => {
    let cancelled = false;
    const assetsById = new Map(assets.map((a) => [a.id, a]));

    // Set of clip IDs that should currently exist in a pool.
    const wantedClipIds = new Set<string>();
    for (const clip of project.clips) {
      const asset = assetsById.get(clip.assetId);
      if (!asset || asset.kind === 'image') continue;
      wantedClipIds.add(clip.id);
    }

    // Remove elements for clips that no longer exist.
    for (const [clipId, el] of videoPool.current) {
      if (!wantedClipIds.has(clipId)) {
        el.pause();
        (el as HTMLVideoElement).remove();
        videoPool.current.delete(clipId);
        clipAssetRef.current.delete(clipId);
      }
    }
    for (const [clipId, el] of audioPool.current) {
      if (!wantedClipIds.has(clipId)) {
        el.pause();
        audioPool.current.delete(clipId);
        clipAssetRef.current.delete(clipId);
      }
    }

    // Revoke URLs for assets that are fully gone.
    const aliveAssetIds = new Set(assets.map((a) => a.id));
    for (const [assetId, url] of urlCache.current) {
      if (!aliveAssetIds.has(assetId)) {
        URL.revokeObjectURL(url);
        urlCache.current.delete(assetId);
      }
    }

    (async () => {
      for (const clip of project.clips) {
        if (cancelled) return;
        const asset = assetsById.get(clip.assetId);
        if (!asset || asset.kind === 'image') continue;
        const isAudio = asset.kind === 'audio';
        const pool = isAudio ? audioPool.current : videoPool.current;
        const existing = pool.get(clip.id);
        const previousAssetId = clipAssetRef.current.get(clip.id);

        // Look up or create the blob URL for this asset.
        let url = urlCache.current.get(asset.id);
        if (!url) {
          const u = await objectUrlFor(asset.id);
          if (!u) continue;
          url = u;
          urlCache.current.set(asset.id, url);
        }
        if (cancelled) return;

        if (!existing) {
          if (isAudio) {
            const a = new Audio();
            a.preload = 'auto';
            a.src = url;
            pool.set(clip.id, a);
          } else {
            const v = document.createElement('video');
            v.preload = 'auto';
            v.playsInline = true;
            v.muted = true;
            v.src = url;
            v.className = 'absolute inset-0 h-full w-full object-contain';
            v.style.display = 'none';
            videoHostRef.current?.appendChild(v);
            pool.set(clip.id, v);
          }
          clipAssetRef.current.set(clip.id, asset.id);
        } else if (previousAssetId !== asset.id) {
          // Asset was swapped on this clip (Replace dialog).
          existing.src = url;
          clipAssetRef.current.set(clip.id, asset.id);
        }
      }
      if (!cancelled) setReady(true);
    })();

    return () => { cancelled = true; };
  }, [project.clips, assets, objectUrlFor]);

  // Main RAF loop.
  useEffect(() => {
    let raf = 0;
    const tick = (ts: number) => {
      const state = usePlaybackStore.getState();
      const proj = useProjectStore.getState().project;
      const total = projectDurationSec(proj);

      if (state.playing) {
        const dt = (ts - (lastTickRef.current ?? ts)) / 1000;
        const next = Math.min(total, state.currentTimeSec + dt);
        state.setCurrentTime(next);
        if (total > 0 && next >= total) pause();
      }
      lastTickRef.current = ts;

      const t = usePlaybackStore.getState().currentTimeSec;
      const frame = resolveFrame(proj, t);

      // ---- VIDEO DISPLAY ----
      // Show only the top-most active video clip's element; hide all others.
      const nextVideoClipId = frame.video?.clip.id ?? null;
      for (const [clipId, el] of videoPool.current) {
        (el as HTMLVideoElement).style.display = clipId === nextVideoClipId ? '' : 'none';
      }
      const hasVideo = nextVideoClipId !== null;
      if (hasVideo !== prevHasVideoRef.current) {
        prevHasVideoRef.current = hasVideo;
        setHasActiveVideo(hasVideo);
      }

      // ---- AUDIO MIX ----
      // Set of CLIP ids contributing audio this frame.
      const activeClipIds = new Set<string>();
      for (const layer of frame.audios) activeClipIds.add(layer.clip.id);

      // Mute + pause any elements not in this frame's mix.
      for (const [clipId, el] of videoPool.current) {
        if (!activeClipIds.has(clipId)) {
          el.muted = true;
          if (!el.paused) el.pause();
        }
      }
      for (const [clipId, el] of audioPool.current) {
        if (!activeClipIds.has(clipId) && !el.paused) el.pause();
      }

      // Drive each active audio layer using its own per-clip element.
      for (const layer of frame.audios) {
        const clipId = layer.clip.id;
        const isVideoEl = videoPool.current.has(clipId);
        const el = isVideoEl
          ? videoPool.current.get(clipId)!
          : audioPool.current.get(clipId);
        if (!el) continue;

        const vol = effectiveVolume(layer);
        el.volume = Math.max(0, Math.min(1, vol));

        if (isVideoEl) (el as HTMLVideoElement).muted = false;

        if (!state.playing && !el.paused) el.pause();
        seekIfNeeded(el, layer.sourceTimeSec, state.playing);
        if (state.playing && el.paused) el.play().catch(() => undefined);
      }

      // The visible video element is the same one already handled above via
      // the audio mix loop (the top video clip is in frame.audios too), so no
      // extra seek/play is needed here.

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [pause]);

  // Cleanup on unmount.
  useEffect(() => {
    const videoEls = videoPool.current;
    const audioEls = audioPool.current;
    const urls = urlCache.current;
    return () => {
      for (const el of videoEls.values()) el.pause();
      for (const el of audioEls.values()) el.pause();
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
    };
  }, []);

  // Playback keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      if (e.code === 'Space') { e.preventDefault(); usePlaybackStore.getState().toggle(); }
      else if (e.key === 'Home') { e.preventDefault(); setCurrentTime(0); }
      else if (e.key === 'End') { e.preventDefault(); setCurrentTime(duration); }
      else if (e.key === ',' || e.key === '<') { e.preventDefault(); setCurrentTime(Math.max(0, currentTime - 1 / project.fps)); }
      else if (e.key === '.' || e.key === '>') { e.preventDefault(); setCurrentTime(Math.min(duration, currentTime + 1 / project.fps)); }
      else if (e.key === 'f' || e.key === 'F') { e.preventDefault(); toggleFullscreen(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [currentTime, duration, project.fps, setCurrentTime]);

  return (
    <div
      ref={containerRef}
      className={`flex h-full flex-col bg-black ${isFullscreen ? 'preview-fullscreen' : ''}`}
    >
      <div
        className={`flex min-h-0 flex-1 items-center justify-center bg-black ${
          isFullscreen ? '' : 'p-4'
        }`}
      >
        <div
          className={`relative w-full max-w-full overflow-hidden bg-black ${
            isFullscreen ? 'h-full' : 'aspect-video rounded-md ring-1 ring-surface-700'
          }`}
          style={isFullscreen ? undefined : { maxHeight: '100%' }}
          onDoubleClick={toggleFullscreen}
        >
          <div ref={videoHostRef} className="absolute inset-0" />
          {!hasActiveVideo && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-slate-500">
              {ready ? 'No clip at playhead' : 'Loading…'}
            </div>
          )}
        </div>
      </div>
      {isFullscreen && (
        <div className="shrink-0 bg-surface-900 pt-2">
          <FullscreenScrubBar />
        </div>
      )}
      <PlayerControls isFullscreen={isFullscreen} onToggleFullscreen={toggleFullscreen} />
    </div>
  );
}
