import { useEffect, useMemo, useRef, useState } from 'react';
import { useMediaStore } from '@/state/mediaStore';
import { usePlaybackStore } from '@/state/playbackStore';
import { useProjectStore } from '@/state/projectStore';
import { resolveFrame } from '@/lib/playback/engine';
import { projectDurationSec } from '@/lib/timeline/operations';
import { PlayerControls } from './PlayerControls';

type ElementPool = Map<string, HTMLMediaElement>;

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
  const lastFrameRef = useRef<{ videoAssetId: string | null; audioAssetId: string | null }>({
    videoAssetId: null,
    audioAssetId: null,
  });
  const lastTickRef = useRef<number | null>(null);
  const [ready, setReady] = useState(false);

  const duration = useMemo(() => projectDurationSec(project), [project]);

  // Ensure one <video>/<audio> element exists per asset that might be active.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const asset of assets) {
        if (asset.kind === 'image') continue;
        const pool = asset.kind === 'audio' ? audioPool.current : videoPool.current;
        if (pool.has(asset.id)) continue;

        let url = urlCache.current.get(asset.id);
        if (!url) {
          const u = await objectUrlFor(asset.id);
          if (!u) continue;
          url = u;
          urlCache.current.set(asset.id, url);
        }
        if (cancelled) return;

        if (asset.kind === 'audio') {
          const a = new Audio();
          a.preload = 'auto';
          a.src = url;
          pool.set(asset.id, a);
        } else {
          const v = document.createElement('video');
          v.preload = 'auto';
          v.playsInline = true;
          v.muted = true;
          v.src = url;
          v.className = 'absolute inset-0 h-full w-full object-contain';
          v.style.display = 'none';
          videoHostRef.current?.appendChild(v);
          pool.set(asset.id, v);
        }
      }
      if (!cancelled) setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [assets, objectUrlFor]);

  // Clean up elements/URLs for deleted assets
  useEffect(() => {
    const ids = new Set(assets.map((a) => a.id));
    for (const [id, el] of videoPool.current) {
      if (!ids.has(id)) {
        el.pause();
        el.remove();
        videoPool.current.delete(id);
      }
    }
    for (const [id, el] of audioPool.current) {
      if (!ids.has(id)) {
        el.pause();
        audioPool.current.delete(id);
      }
    }
    for (const [id, url] of urlCache.current) {
      if (!ids.has(id)) {
        URL.revokeObjectURL(url);
        urlCache.current.delete(id);
      }
    }
  }, [assets]);

  // Main RAF loop: resolve active frame and drive playback
  useEffect(() => {
    let raf = 0;
    const tick = (ts: number) => {
      const state = usePlaybackStore.getState();
      const proj = useProjectStore.getState().project;
      const totalDuration = projectDurationSec(proj);

      if (state.playing) {
        const last = lastTickRef.current ?? ts;
        const dt = (ts - last) / 1000;
        let next = state.currentTimeSec + dt;
        if (totalDuration > 0 && next >= totalDuration) {
          next = totalDuration;
          state.setCurrentTime(next);
          pause();
        } else {
          state.setCurrentTime(next);
        }
      }
      lastTickRef.current = ts;

      const t = usePlaybackStore.getState().currentTimeSec;
      const frame = resolveFrame(proj, t);

      // --- video ---
      const nextVideoAssetId = frame.video?.clip.assetId ?? null;
      if (nextVideoAssetId !== lastFrameRef.current.videoAssetId) {
        for (const [id, el] of videoPool.current) {
          el.style.display = id === nextVideoAssetId ? '' : 'none';
          if (id !== nextVideoAssetId) el.pause();
        }
        lastFrameRef.current.videoAssetId = nextVideoAssetId;
      }
      if (nextVideoAssetId) {
        const el = videoPool.current.get(nextVideoAssetId) as HTMLVideoElement | undefined;
        if (el && frame.video) {
          const target = frame.video.sourceTimeSec;
          if (!state.playing && !el.paused) el.pause();
          const drift = Math.abs(el.currentTime - target);
          const threshold = state.playing ? 0.15 : 0.015;
          if (drift > threshold && !el.seeking && el.readyState >= 1) {
            try {
              el.currentTime = target;
            } catch {
              // noop
            }
          }
          if (state.playing && el.paused) el.play().catch(() => undefined);
        }
      }

      // --- audio ---
      const nextAudioAssetId = frame.audio?.clip.assetId ?? null;
      if (nextAudioAssetId !== lastFrameRef.current.audioAssetId) {
        for (const [id, el] of audioPool.current) {
          if (id !== nextAudioAssetId) el.pause();
        }
        lastFrameRef.current.audioAssetId = nextAudioAssetId;
      }

      // Audio routing:
      //   - If a dedicated audio clip matches the active video asset, let the <video>
      //     element play the sound (single source of truth, no A/V drift).
      //   - If there's no audio clip at all, the video clip still plays its own audio
      //     (matches user expectations: "MP4s should have sound").
      //   - Otherwise route audio through the audio pool element and mute the video.
      const audioSharesVideo = !!nextAudioAssetId && nextAudioAssetId === nextVideoAssetId;
      const videoProvidesOwnAudio = !nextAudioAssetId && !!nextVideoAssetId;
      if (nextVideoAssetId) {
        const videoEl = videoPool.current.get(nextVideoAssetId);
        if (videoEl) videoEl.muted = !(audioSharesVideo || videoProvidesOwnAudio);
      }
      if (nextAudioAssetId && !audioSharesVideo) {
        const el = audioPool.current.get(nextAudioAssetId) ?? videoPool.current.get(nextAudioAssetId);
        if (el && frame.audio) {
          const target = frame.audio.sourceTimeSec;
          if (!state.playing && !el.paused) el.pause();
          const drift = Math.abs(el.currentTime - target);
          const threshold = state.playing ? 0.15 : 0.015;
          if (drift > threshold && !el.seeking && el.readyState >= 1) {
            try {
              el.currentTime = target;
            } catch {
              // noop
            }
          }
          if (state.playing && el.paused) el.play().catch(() => undefined);
        }
      }

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [pause]);

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

  // Keyboard shortcuts for playback
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;

      if (e.code === 'Space') {
        e.preventDefault();
        usePlaybackStore.getState().toggle();
      } else if (e.key === 'Home') {
        e.preventDefault();
        setCurrentTime(0);
      } else if (e.key === 'End') {
        e.preventDefault();
        setCurrentTime(duration);
      } else if (e.key === ',' || e.key === '<') {
        e.preventDefault();
        setCurrentTime(Math.max(0, currentTime - 1 / project.fps));
      } else if (e.key === '.' || e.key === '>') {
        e.preventDefault();
        setCurrentTime(Math.min(duration, currentTime + 1 / project.fps));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [currentTime, duration, project.fps, setCurrentTime]);

  const activeVideoId = lastFrameRef.current.videoAssetId;

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1 items-center justify-center bg-black p-4">
        <div
          className="relative aspect-video w-full max-w-full overflow-hidden rounded-md bg-black ring-1 ring-surface-700"
          style={{ maxHeight: '100%' }}
        >
          <div ref={videoHostRef} className="absolute inset-0" />
          {!activeVideoId && (
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
