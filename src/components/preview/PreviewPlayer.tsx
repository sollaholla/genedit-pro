import { useEffect, useMemo, useRef, useState } from 'react';
import { useMediaStore } from '@/state/mediaStore';
import { usePlaybackStore } from '@/state/playbackStore';
import { useProjectStore } from '@/state/projectStore';
import { resolveFrame, upcomingClips, type ActiveLayer } from '@/lib/playback/engine';
import { clipSpeed, projectDurationSec } from '@/lib/timeline/operations';
import { evalEnvelopeAt } from '@/lib/timeline/envelope';
import {
  getAudioContext,
  getMasterGain,
  resumeAudioContext,
} from '@/lib/audio/context';
import { PlayerControls } from './PlayerControls';
import { FullscreenScrubBar } from './FullscreenScrubBar';
import { getTransformComponents, resolveTransformAtTime } from '@/lib/components/transform';
import { nanoid } from 'nanoid';

const KEYFRAME_EPS_SEC = 1 / 120;

function upsertKeyframeValue(track: Array<{ id: string; timeSec: number; value: number }>, timeSec: number, value: number) {
  let matched = false;
  const updated = track.map((k) => {
    if (Math.abs(k.timeSec - timeSec) <= KEYFRAME_EPS_SEC) {
      matched = true;
      return { ...k, value };
    }
    return k;
  });
  return matched ? updated : [...updated, { id: nanoid(8), timeSec, value }];
}

function clipEffectiveGain(layer: ActiveLayer): number {
  const master = Math.max(0, Math.min(2, layer.clip.volume ?? 1));
  const clipDur = Math.max(1e-6, layer.clip.outSec - layer.clip.inSec);
  const localT = Math.max(0, Math.min(1, (layer.sourceTimeSec - layer.clip.inSec) / clipDur));
  return master * evalEnvelopeAt(layer.clip.volumeEnvelope, localT);
}

type ElementPool = Map<string, HTMLMediaElement>;

const FADE_OUT_MS = 80;
const FADE_IN_MS = 40;

function seekIfNeeded(el: HTMLMediaElement, target: number, playing: boolean) {
  const drift = Math.abs(el.currentTime - target);
  const threshold = playing ? 0.15 : 0.015;
  if (drift > threshold && !el.seeking && el.readyState >= 1) {
    try { el.currentTime = target; } catch { /* noop */ }
  }
}

function setPitchPreservingRate(el: HTMLMediaElement, speed: number) {
  if (Math.abs(el.playbackRate - speed) > 1e-3) {
    el.playbackRate = speed;
    el.defaultPlaybackRate = speed;
  }
  const maybe = el as HTMLMediaElement & {
    preservesPitch?: boolean;
    mozPreservesPitch?: boolean;
    webkitPreservesPitch?: boolean;
  };
  maybe.preservesPitch = true;
  maybe.mozPreservesPitch = true;
  maybe.webkitPreservesPitch = true;
}

function resolvedTransform(clip: ActiveLayer['clip']) {
  const resolved = resolveTransformAtTime(clip, usePlaybackStore.getState().currentTimeSec);
  return { ...resolved, keyframes: [] };
}

export function PreviewPlayer() {
  const project = useProjectStore((s) => s.project);
  const assets = useMediaStore((s) => s.assets);
  const objectUrlFor = useMediaStore((s) => s.objectUrlFor);
  const currentTime = usePlaybackStore((s) => s.currentTimeSec);
  const selectedClipIds = usePlaybackStore((s) => s.selectedClipIds);
  const setCurrentTime = usePlaybackStore((s) => s.setCurrentTime);
  const pause = usePlaybackStore((s) => s.pause);
  const updateSilent = useProjectStore((s) => s.updateSilent);

  const videoHostRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Pools keyed by CLIP id (not asset id). Each clip needs its own element so
  // overlapping same-asset clips don't fight over currentTime.
  const videoPool = useRef<ElementPool>(new Map());
  const audioPool = useRef<ElementPool>(new Map());
  // clipId → assetId that el.src is currently set to (for Replace detection)
  const clipAssetRef = useRef<Map<string, string>>(new Map());
  // clipId → GainNode connected to the master bus
  const gainNodes = useRef<Map<string, GainNode>>(new Map());
  // clipId → MediaElementAudioSourceNode (keep ref so it isn't GC'd)
  const sourceNodes = useRef<Map<string, MediaElementAudioSourceNode>>(new Map());

  const urlCache = useRef<Map<string, string>>(new Map()); // assetId → object URL
  const lastTickRef = useRef<number | null>(null);
  const prevHasVideoRef = useRef(false);
  const prerolledRef = useRef<Set<string>>(new Set());
  // Tracks which upcoming clips we've aligned for hot-priming. Alignment seeks
  // `currentTime = inSec - timeUntilActive` so after playing for
  // `timeUntilActive` seconds muted, currentTime naturally arrives at inSec at
  // the exact moment of handoff — avoiding a seek inside the active loop (which
  // briefly silences audio and creates the "eeee---eeee" gap on snapped clips).
  const hotPrimedSeekRef = useRef<Set<string>>(new Set());
  const prevReadinessRef = useRef<Record<string, boolean>>({});
  const lastReadinessPublishRef = useRef(0);

  // Smooth transitions: track which clips are fading out/in to avoid pops.
  const fadingOut = useRef<Map<string, { startTs: number; fromGain: number }>>(new Map());
  const fadingIn = useRef<Map<string, { startTs: number; targetGain: number }>>(new Map());
  const prevActiveAudioIds = useRef<Set<string>>(new Set());

  const [hasActiveVideo, setHasActiveVideo] = useState(false);
  const [ready, setReady] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [aspectPreset, setAspectPreset] = useState<'16:9' | '9:16' | '1:1' | '4:3'>(() => {
    const ratio = project.width / Math.max(1, project.height);
    if (Math.abs(ratio - 16 / 9) < 0.02) return '16:9';
    if (Math.abs(ratio - 9 / 16) < 0.02) return '9:16';
    if (Math.abs(ratio - 1) < 0.02) return '1:1';
    return '4:3';
  });

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

  // Drag-manipulate transform component directly in the preview window.
  useEffect(() => {
    if (selectedClipIds.length !== 1) return;
    const selectedId = selectedClipIds[0]!;
    const frame = resolveFrame(project, currentTime);
    if (frame.video?.clip.id !== selectedId || getTransformComponents(frame.video.clip).length === 0) return;
    const el = videoPool.current.get(selectedId) as HTMLVideoElement | undefined;
    if (!el) return;

    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const clip = useProjectStore.getState().project.clips.find((c) => c.id === selectedId);
      if (!clip) return;
      const components = getTransformComponents(clip);
      if (components.length === 0) return;
      const top = components[components.length - 1]!;
      const startX = e.clientX;
      const startY = e.clientY;
      const baseX = top.data.offsetX;
      const baseY = top.data.offsetY;

      const onMove = (ev: MouseEvent) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        const localTimeSec = Math.max(0, currentTime - clip.startSec);
        const nextX = baseX + dx;
        const nextY = baseY + dy;
        updateSilent((p) => ({
          ...p,
          clips: p.clips.map((c) => (c.id === selectedId
            ? {
                ...c,
                components: getTransformComponents(c).map((component, idx, arr) => (
                  idx === arr.length - 1
                    ? {
                        ...component,
                        data: {
                          ...component.data,
                          offsetX: nextX,
                          offsetY: nextY,
                          keyframes: {
                            ...component.data.keyframes,
                            offsetX: upsertKeyframeValue(component.data.keyframes.offsetX, localTimeSec, nextX),
                            offsetY: upsertKeyframeValue(component.data.keyframes.offsetY, localTimeSec, nextY),
                          },
                        },
                      }
                    : component
                )),
              }
            : c)),
        }));
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    };

    el.addEventListener('mousedown', onDown);
    return () => el.removeEventListener('mousedown', onDown);
  }, [project, currentTime, selectedClipIds, updateSilent]);

  // Reconcile: one HTMLMediaElement + one GainNode per clip.
  useEffect(() => {
    let cancelled = false;
    const assetsById = new Map(assets.map((a) => [a.id, a]));

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
        gainNodes.current.get(clipId)?.disconnect();
        gainNodes.current.delete(clipId);
        sourceNodes.current.get(clipId)?.disconnect();
        sourceNodes.current.delete(clipId);
        fadingOut.current.delete(clipId);
        fadingIn.current.delete(clipId);
        hotPrimedSeekRef.current.delete(clipId);
        prerolledRef.current.delete(clipId);
      }
    }
    for (const [clipId, el] of audioPool.current) {
      if (!wantedClipIds.has(clipId)) {
        el.pause();
        audioPool.current.delete(clipId);
        clipAssetRef.current.delete(clipId);
        gainNodes.current.get(clipId)?.disconnect();
        gainNodes.current.delete(clipId);
        sourceNodes.current.get(clipId)?.disconnect();
        sourceNodes.current.delete(clipId);
        fadingOut.current.delete(clipId);
        fadingIn.current.delete(clipId);
        hotPrimedSeekRef.current.delete(clipId);
        prerolledRef.current.delete(clipId);
      }
    }

    // Revoke URLs for gone assets.
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

        let url = urlCache.current.get(asset.id);
        if (!url) {
          const u = await objectUrlFor(asset.id);
          if (!u) continue;
          url = u;
          urlCache.current.set(asset.id, url);
        }
        if (cancelled) return;

        if (!existing) {
          let el: HTMLMediaElement;
          if (isAudio) {
            const a = new Audio();
            a.preload = 'auto';
            a.src = url;
            pool.set(clip.id, a);
            el = a;
          } else {
            const v = document.createElement('video');
            v.preload = 'auto';
            v.playsInline = true;
            v.muted = true; // starts muted; unmuted by RAF when active for audio
            v.src = url;
            v.className = 'absolute inset-0 h-full w-full object-cover';
            v.style.display = 'none';
            videoHostRef.current?.appendChild(v);
            pool.set(clip.id, v);
            el = v;
          }
          clipAssetRef.current.set(clip.id, asset.id);

          // Wire up to the Web Audio graph.
          try {
            const ctx = getAudioContext();
            const source = ctx.createMediaElementSource(el);
            const gain = ctx.createGain();
            gain.gain.value = 0; // silent until activated
            source.connect(gain);
            gain.connect(getMasterGain());
            sourceNodes.current.set(clip.id, source);
            gainNodes.current.set(clip.id, gain);
          } catch {
            // Fallback: element won't route through Web Audio; volume stays at el.volume
          }
        } else if (previousAssetId !== asset.id) {
          // Asset replaced on this clip.
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
        resumeAudioContext();
        const dt = (ts - (lastTickRef.current ?? ts)) / 1000;
        const next = Math.min(total, state.currentTimeSec + dt);
        state.setCurrentTime(next);
        if (total > 0 && next >= total) pause();
      }
      lastTickRef.current = ts;

      // Apply master volume to the master GainNode each frame.
      const masterVol = state.masterVolume;
      const masterGain = getMasterGain();
      if (Math.abs(masterGain.gain.value - masterVol) > 0.001) {
        masterGain.gain.setTargetAtTime(masterVol, getAudioContext().currentTime, 0.01);
      }

      const t = usePlaybackStore.getState().currentTimeSec;
      const frame = resolveFrame(proj, t);

      // ---- VIDEO DISPLAY ----
      const nextVideoClipId = frame.video?.clip.id ?? null;
      for (const [clipId, el] of videoPool.current) {
        const videoEl = el as HTMLVideoElement;
        videoEl.style.display = clipId === nextVideoClipId ? '' : 'none';
        if (clipId === nextVideoClipId) {
          const tf = frame.video ? resolvedTransform(frame.video.clip) : null;
          const s = Math.max(0.1, Math.min(3, tf?.scale ?? frame.video?.clip.scale ?? 1));
          const ox = tf?.offsetX ?? 0;
          const oy = tf?.offsetY ?? 0;
          videoEl.style.transform = `translate(${ox}px, ${oy}px) scale(${s})`;
          videoEl.style.transformOrigin = 'center center';
          videoEl.style.cursor = tf ? 'move' : 'default';
        } else {
          videoEl.style.transform = '';
          videoEl.style.cursor = 'default';
        }
      }
      const hasVideo = nextVideoClipId !== null;
      if (hasVideo !== prevHasVideoRef.current) {
        prevHasVideoRef.current = hasVideo;
        setHasActiveVideo(hasVideo);
      }

      // ---- AUDIO MIX + PREROLL ----
      const activeAudioIds = new Set<string>();
      for (const layer of frame.audios) activeAudioIds.add(layer.clip.id);

      // Preroll: seek upcoming clips so their decoder buffer is warm.
      const PREROLL_SEC = 2.0;
      const HOT_PRIMING_SEC = 0.3;
      const upcoming = upcomingClips(proj, t, PREROLL_SEC);
      const hotPrimedIds = new Set<string>();
      for (const clip of upcoming) {
        const el = videoPool.current.get(clip.id) ?? audioPool.current.get(clip.id);
        if (!el) continue;
        const timeUntilActive = clip.startSec - t;

        if (!prerolledRef.current.has(clip.id) && el.readyState >= 1 && !el.seeking) {
          if (Math.abs(el.currentTime - clip.inSec) > 0.2) {
            try { el.currentTime = clip.inSec; } catch { /* noop */ }
          }
          prerolledRef.current.add(clip.id);
        }

        // Keep decoder running just before handoff. Unmute video so audio flows
        // through the Web Audio graph (Chrome silences MediaElementSourceNode when
        // el.muted=true). GainNode stays at 0 so no audible output yet.
        //
        // CRITICAL: align currentTime to (inSec - timeUntilActive) the first frame
        // we enter the hot-priming window, so playing forward for `timeUntilActive`
        // seconds lands us on inSec at the boundary. Without this alignment the
        // element would reach inSec + HOT_PRIMING_SEC by handoff, the active-loop
        // seekIfNeeded would see >150ms drift, and the backward seek would briefly
        // silence audio — the "eeee---eeee" gap the user hears on snapped clips.
        if (state.playing && timeUntilActive <= HOT_PRIMING_SEC && timeUntilActive >= 0) {
          hotPrimedIds.add(clip.id);
          setPitchPreservingRate(el, clipSpeed(clip));
          const gn = gainNodes.current.get(clip.id);
          if (gn) gn.gain.value = 0;
          if (videoPool.current.has(clip.id)) {
            (el as HTMLVideoElement).muted = false;
          }

          if (!hotPrimedSeekRef.current.has(clip.id)) {
            const alignedStart = Math.max(0, clip.inSec - timeUntilActive);
            if (el.readyState >= 1 && !el.seeking) {
              try { el.currentTime = alignedStart; } catch { /* noop */ }
              hotPrimedSeekRef.current.add(clip.id);
            }
          }
          if (el.paused) el.play().catch(() => undefined);
        }
      }

      // Reset preroll markers for clips that moved out of the lookahead window.
      for (const id of prerolledRef.current) {
        const c = proj.clips.find((cl) => cl.id === id);
        if (!c || c.startSec - t > PREROLL_SEC + 0.5 || t > c.startSec) {
          prerolledRef.current.delete(id);
        }
      }
      // Reset hot-prime alignment markers when a clip moves past handoff or far
      // away (e.g. user scrubbed backward into the pre-hot-prime range).
      for (const id of hotPrimedSeekRef.current) {
        const c = proj.clips.find((cl) => cl.id === id);
        if (!c || t >= c.startSec || c.startSec - t > HOT_PRIMING_SEC + 0.1) {
          hotPrimedSeekRef.current.delete(id);
        }
      }

      // Snapshot previous active set BEFORE updating it, so we can detect entries/exits.
      const prevIds = prevActiveAudioIds.current;

      // ---- FADE-OUT for clips leaving active ----
      for (const id of prevIds) {
        if (!activeAudioIds.has(id) && !fadingOut.current.has(id)) {
          const gn = gainNodes.current.get(id);
          if (gn) {
            fadingOut.current.set(id, { startTs: ts, fromGain: gn.gain.value });
          }
        }
      }
      // Update for next frame.
      prevActiveAudioIds.current = new Set(activeAudioIds);

      // ---- PROCESS FADING-OUT clips ----
      const toRemoveFromFade: string[] = [];
      for (const [id, fadeInfo] of fadingOut.current) {
        const el = videoPool.current.get(id) ?? audioPool.current.get(id);
        const gn = gainNodes.current.get(id);
        if (!el || !gn) { toRemoveFromFade.push(id); continue; }

        const alpha = Math.min(1, (ts - fadeInfo.startTs) / FADE_OUT_MS);
        gn.gain.value = fadeInfo.fromGain * (1 - alpha);

        if (alpha >= 1) {
          // Fade complete: silence and pause.
          gn.gain.value = 0;
          if (!el.paused) el.pause();
          toRemoveFromFade.push(id);
        }
      }
      for (const id of toRemoveFromFade) fadingOut.current.delete(id);

      // ---- SILENCE + PAUSE fully inactive elements ----
      for (const [clipId, el] of videoPool.current) {
        if (!activeAudioIds.has(clipId) && !fadingOut.current.has(clipId) && !hotPrimedIds.has(clipId)) {
          const gn = gainNodes.current.get(clipId);
          if (gn) gn.gain.value = 0;
          el.muted = true;
          if (!el.paused) el.pause();
        }
      }
      for (const [clipId, el] of audioPool.current) {
        if (!activeAudioIds.has(clipId) && !fadingOut.current.has(clipId) && !hotPrimedIds.has(clipId)) {
          const gn = gainNodes.current.get(clipId);
          if (gn) gn.gain.value = 0;
          if (!el.paused) el.pause();
        }
      }

      // ---- DRIVE ACTIVE AUDIO LAYERS ----
      for (const layer of frame.audios) {
        const clipId = layer.clip.id;
        const isVideoEl = videoPool.current.has(clipId);
        const el = isVideoEl
          ? videoPool.current.get(clipId)!
          : audioPool.current.get(clipId);
        if (!el) continue;

        const targetGain = Math.max(0, clipEffectiveGain(layer));
        const gn = gainNodes.current.get(clipId);

        // Fade-in: ramp gain from 0 if this clip just entered active (not in previous frame's set).
        if (!prevIds.has(clipId) && !fadingIn.current.has(clipId) && !fadingOut.current.has(clipId)) {
          fadingIn.current.set(clipId, { startTs: ts, targetGain });
          if (gn) gn.gain.value = 0;
        }

        if (gn) {
          const fadeInInfo = fadingIn.current.get(clipId);
          if (fadeInInfo) {
            const alpha = Math.min(1, (ts - fadeInInfo.startTs) / FADE_IN_MS);
            gn.gain.value = fadeInInfo.targetGain * alpha;
            if (alpha >= 1) {
              gn.gain.value = targetGain;
              fadingIn.current.delete(clipId);
            }
          } else {
            gn.gain.value = targetGain;
          }
        } else {
          // No Web Audio — fall back to element volume (capped at 1).
          el.volume = Math.max(0, Math.min(1, targetGain));
        }

        if (isVideoEl) (el as HTMLVideoElement).muted = false;
        setPitchPreservingRate(el, clipSpeed(layer.clip));

        if (!state.playing && !el.paused) el.pause();
        seekIfNeeded(el, layer.sourceTimeSec, state.playing);
        if (state.playing && el.paused) el.play().catch(() => undefined);
      }

      // ---- PUBLISH READINESS (throttled to ~4Hz; diff-guarded) ----
      if (ts - lastReadinessPublishRef.current > 250) {
        lastReadinessPublishRef.current = ts;
        const next: Record<string, boolean> = {};
        for (const [id, el] of videoPool.current) next[id] = el.readyState >= 3;
        for (const [id, el] of audioPool.current) next[id] = el.readyState >= 3;
        const prev = prevReadinessRef.current;
        let changed = false;
        const prevKeys = Object.keys(prev);
        const nextKeys = Object.keys(next);
        if (prevKeys.length !== nextKeys.length) changed = true;
        else {
          for (const k of nextKeys) {
            if (prev[k] !== next[k]) { changed = true; break; }
          }
        }
        if (changed) {
          prevReadinessRef.current = next;
          usePlaybackStore.getState().setClipReadiness(next);
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
            isFullscreen ? '' : 'rounded-md ring-1 ring-surface-700'
          }`}
          style={{ aspectRatio: aspectPreset.replace(':', ' / '), maxHeight: '100%' }}
          onDoubleClick={toggleFullscreen}
        >
          <div className="absolute right-2 top-2 z-20">
            <select
              className="rounded border border-surface-600 bg-surface-900/90 px-2 py-1 text-[11px] text-slate-200"
              value={aspectPreset}
              onChange={(e) => setAspectPreset(e.target.value as typeof aspectPreset)}
              title="Preview aspect ratio"
            >
              <option value="16:9">16:9</option>
              <option value="4:3">4:3</option>
              <option value="1:1">1:1</option>
              <option value="9:16">9:16</option>
            </select>
          </div>
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
