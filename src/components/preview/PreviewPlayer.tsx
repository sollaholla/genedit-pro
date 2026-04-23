import { useEffect, useMemo, useRef, useState } from 'react';
import { useMediaStore } from '@/state/mediaStore';
import { usePlaybackStore } from '@/state/playbackStore';
import { useProjectStore } from '@/state/projectStore';
import { resolveFrame } from '@/lib/playback/engine';
import { projectDurationSec } from '@/lib/timeline/operations';
import { PlayerControls } from './PlayerControls';

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
  const videoPool = useRef<ElementPool>(new Map());
  const audioPool = useRef<ElementPool>(new Map());
  const urlCache = useRef<Map<string, string>>(new Map());
  const lastTickRef = useRef<number | null>(null);
  const lastVideoAssetIdRef = useRef<string | null>(null);
  const [ready, setReady] = useState(false);

  const duration = useMemo(() => projectDurationSec(project), [project]);

  // Create one HTMLMediaElement per asset.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const asset of assets) {
        if (asset.kind === 'image') continue;
        const isAudio = asset.kind === 'audio';
        const pool = isAudio ? audioPool.current : videoPool.current;
        if (pool.has(asset.id)) continue;

        let url = urlCache.current.get(asset.id);
        if (!url) {
          const u = await objectUrlFor(asset.id);
          if (!u) continue;
          url = u;
          urlCache.current.set(asset.id, url);
        }
        if (cancelled) return;

        if (isAudio) {
          const a = new Audio();
          a.preload = 'auto';
          a.src = url;
          pool.set(asset.id, a);
        } else {
          const v = document.createElement('video');
          v.preload = 'auto';
          v.playsInline = true;
          v.muted = true; // will be unmuted in RAF when needed
          v.src = url;
          v.className = 'absolute inset-0 h-full w-full object-contain';
          v.style.display = 'none';
          videoHostRef.current?.appendChild(v);
          pool.set(asset.id, v);
        }
      }
      if (!cancelled) setReady(true);
    })();
    return () => { cancelled = true; };
  }, [assets, objectUrlFor]);

  // Clean up deleted assets.
  useEffect(() => {
    const ids = new Set(assets.map((a) => a.id));
    for (const [id, el] of videoPool.current) {
      if (!ids.has(id)) { el.pause(); (el as HTMLVideoElement).remove(); videoPool.current.delete(id); }
    }
    for (const [id, el] of audioPool.current) {
      if (!ids.has(id)) { el.pause(); audioPool.current.delete(id); }
    }
    for (const [id, url] of urlCache.current) {
      if (!ids.has(id)) { URL.revokeObjectURL(url); urlCache.current.delete(id); }
    }
  }, [assets]);

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
      const nextVideoAssetId = frame.video?.clip.assetId ?? null;
      if (nextVideoAssetId !== lastVideoAssetIdRef.current) {
        for (const [id, el] of videoPool.current) {
          (el as HTMLVideoElement).style.display = id === nextVideoAssetId ? '' : 'none';
          if (id !== nextVideoAssetId) el.pause();
        }
        lastVideoAssetIdRef.current = nextVideoAssetId;
      }

      // ---- AUDIO MIX ----
      // Build set of asset IDs contributing audio this frame.
      const activeAudioAssetIds = new Set<string>();
      for (const layer of frame.audios) activeAudioAssetIds.add(layer.clip.assetId);

      // Pause any pool elements not in this frame's mix.
      for (const [id, el] of videoPool.current) {
        if (!activeAudioAssetIds.has(id)) el.muted = true;
      }
      for (const [id, el] of audioPool.current) {
        if (!activeAudioAssetIds.has(id) && !el.paused) el.pause();
      }

      // Drive each active audio layer.
      for (const layer of frame.audios) {
        const assetId = layer.clip.assetId;
        const isVideoEl = videoPool.current.has(assetId);
        const el = isVideoEl
          ? videoPool.current.get(assetId)!
          : (audioPool.current.get(assetId) ?? videoPool.current.get(assetId));
        if (!el) continue;

        const vol = Math.max(0, Math.min(2, layer.clip.volume ?? 1));
        el.volume = Math.min(1, vol); // HTMLMediaElement.volume ∈ [0,1]

        if (isVideoEl) (el as HTMLVideoElement).muted = false;

        if (!state.playing && !el.paused) el.pause();
        seekIfNeeded(el, layer.sourceTimeSec, state.playing);
        if (state.playing && el.paused) el.play().catch(() => undefined);
      }

      // Video display element's position (separate from audio).
      if (nextVideoAssetId && frame.video) {
        const el = videoPool.current.get(nextVideoAssetId);
        if (el) {
          if (!state.playing && !el.paused) el.pause();
          seekIfNeeded(el, frame.video.sourceTimeSec, state.playing);
          if (state.playing && el.paused) el.play().catch(() => undefined);
        }
      }

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
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [currentTime, duration, project.fps, setCurrentTime]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1 items-center justify-center bg-black p-4">
        <div
          className="relative aspect-video w-full max-w-full overflow-hidden rounded-md bg-black ring-1 ring-surface-700"
          style={{ maxHeight: '100%' }}
        >
          <div ref={videoHostRef} className="absolute inset-0" />
          {!lastVideoAssetIdRef.current && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-slate-500">
              {ready ? 'No clip at playhead' : 'Loading…'}
            </div>
          )}
        </div>
      </div>
      <PlayerControls />
    </div>
  );
}
