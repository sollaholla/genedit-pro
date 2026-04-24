import { useEffect, useMemo, useRef, useState } from 'react';
import { useMediaStore } from '@/state/mediaStore';
import { usePlaybackStore } from '@/state/playbackStore';
import { useProjectStore } from '@/state/projectStore';
import { resolveFrame, upcomingClips, type ActiveLayer } from '@/lib/playback/engine';
import { clipSpeed, projectDurationSec } from '@/lib/timeline/operations';
import { evalEnvelopeAt } from '@/lib/timeline/envelope';
import { activeEditTransform } from '@/lib/media/editTrail';
import {
  getAudioContext,
  getMasterGain,
  resumeAudioContext,
} from '@/lib/audio/context';
import { PlayerControls } from './PlayerControls';
import { FullscreenScrubBar } from './FullscreenScrubBar';
import {
  getActiveTransformComponent,
  getTransformComponents,
  resolveTransformAtTime,
  resolveTransformComponentAtTime,
  setTransformPropertyAtTime,
} from '@/lib/components/transform';

function clipEffectiveGain(layer: ActiveLayer): number {
  const master = Math.max(0, Math.min(2, layer.clip.volume ?? 1));
  const clipDur = Math.max(1e-6, layer.clip.outSec - layer.clip.inSec);
  const localT = Math.max(0, Math.min(1, (layer.sourceTimeSec - layer.clip.inSec) / clipDur));
  return master * evalEnvelopeAt(layer.clip.volumeEnvelope, localT);
}

type ElementPool = Map<string, HTMLMediaElement>;

const FADE_OUT_MS = 80;
const FADE_IN_MS = 40;
const HAVE_CURRENT_DATA = 2;
const PREVIEW_ASPECTS = {
  '16:9': 16 / 9,
  '2.39:1': 2.39,
  '4:3': 4 / 3,
  '1:1': 1,
  '9:16': 9 / 16,
} as const;

type PreviewAspectPreset = keyof typeof PREVIEW_ASPECTS;
const PREVIEW_ASPECT_OPTIONS: readonly { value: PreviewAspectPreset; label: string }[] = [
  { value: '16:9', label: '16:9' },
  { value: '2.39:1', label: '2.39:1' },
  { value: '4:3', label: '4:3' },
  { value: '1:1', label: '1:1' },
  { value: '9:16', label: '9:16' },
];
const PREVIEW_ASPECT_STORAGE_KEY = 'genedit-pro:preview-aspect';

function isPreviewAspectPreset(value: string | null): value is PreviewAspectPreset {
  return Boolean(value && value in PREVIEW_ASPECTS);
}

function initialPreviewAspectPreset(projectWidth: number, projectHeight: number): PreviewAspectPreset {
  try {
    const stored = localStorage.getItem(PREVIEW_ASPECT_STORAGE_KEY);
    if (isPreviewAspectPreset(stored)) return stored;
  } catch {
    // Fall back to the project format when storage is unavailable.
  }

  const ratio = projectWidth / Math.max(1, projectHeight);
  if (Math.abs(ratio - 16 / 9) < 0.02) return '16:9';
  if (Math.abs(ratio - 2.39) < 0.03) return '2.39:1';
  if (Math.abs(ratio - 4 / 3) < 0.02) return '4:3';
  if (Math.abs(ratio - 9 / 16) < 0.02) return '9:16';
  if (Math.abs(ratio - 1) < 0.02) return '1:1';
  return '16:9';
}

function persistPreviewAspectPreset(value: PreviewAspectPreset) {
  try {
    localStorage.setItem(PREVIEW_ASPECT_STORAGE_KEY, value);
  } catch {
    // ignore storage failures
  }
}

function seekIfNeeded(el: HTMLMediaElement, target: number, playing: boolean) {
  const drift = Math.abs(el.currentTime - target);
  const threshold = playing ? 0.15 : 0.015;
  if (drift > threshold && !el.seeking && el.readyState >= 1) {
    try { el.currentTime = target; } catch { /* noop */ }
  }
}

function canPaintSyncedVideo(el: HTMLVideoElement, target: number, playing: boolean) {
  if (el.readyState < HAVE_CURRENT_DATA || el.seeking) return false;
  const threshold = playing ? 0.15 : 0.015;
  return Math.abs(el.currentTime - target) <= threshold;
}

function hideVideoElement(el: HTMLVideoElement) {
  el.style.display = 'none';
  el.style.visibility = 'hidden';
  el.style.transform = '';
  el.style.cursor = 'default';
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
  const beginTx = useProjectStore((s) => s.beginTx);
  const activeTransformComponentId = usePlaybackStore((s) => s.activeTransformComponentId);

  const videoHostRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const previewFrameRef = useRef<HTMLDivElement | null>(null);

  // Pools keyed by CLIP id (not asset id). Each clip needs its own element so
  // overlapping same-asset clips don't fight over currentTime.
  const videoPool = useRef<ElementPool>(new Map());
  const audioPool = useRef<ElementPool>(new Map());
  // clipId -> asset id + active blob key that el.src is currently set to.
  const clipAssetRef = useRef<Map<string, string>>(new Map());
  // clipId → GainNode connected to the master bus
  const gainNodes = useRef<Map<string, GainNode>>(new Map());
  // clipId → MediaElementAudioSourceNode (keep ref so it isn't GC'd)
  const sourceNodes = useRef<Map<string, MediaElementAudioSourceNode>>(new Map());

  const urlCache = useRef<Map<string, string>>(new Map()); // assetId → object URL
  const assetsRef = useRef(assets);
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
  const [previewFrameSize, setPreviewFrameSize] = useState<{ width: number; height: number } | null>(null);
  const [aspectPreset, setAspectPreset] = useState<PreviewAspectPreset>(() =>
    initialPreviewAspectPreset(project.width, project.height),
  );
  const previewAspectRatio = PREVIEW_ASPECTS[aspectPreset];

  const updateAspectPreset = (value: string) => {
    if (!isPreviewAspectPreset(value)) return;
    setAspectPreset(value);
    persistPreviewAspectPreset(value);
  };

  useEffect(() => {
    assetsRef.current = assets;
  }, [assets]);
  const previewStageStyle = useMemo(() => {
    if (!previewFrameSize || previewFrameSize.width <= 0 || previewFrameSize.height <= 0) {
      return { aspectRatio: previewAspectRatio, width: '100%' };
    }

    const widthFromHeight = previewFrameSize.height * previewAspectRatio;
    if (widthFromHeight <= previewFrameSize.width) {
      return {
        aspectRatio: previewAspectRatio,
        width: `${Math.round(widthFromHeight)}px`,
        height: `${Math.round(previewFrameSize.height)}px`,
      };
    }

    return {
      aspectRatio: previewAspectRatio,
      width: `${Math.round(previewFrameSize.width)}px`,
      height: `${Math.round(previewFrameSize.width / previewAspectRatio)}px`,
    };
  }, [previewAspectRatio, previewFrameSize]);

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

  useEffect(() => {
    const node = previewFrameRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return;

    const updateFrameSize = (rect: DOMRectReadOnly | DOMRect) => {
      const next = {
        width: Math.max(0, rect.width),
        height: Math.max(0, rect.height),
      };
      setPreviewFrameSize((prev) => {
        if (
          prev &&
          Math.abs(prev.width - next.width) < 0.5 &&
          Math.abs(prev.height - next.height) < 0.5
        ) {
          return prev;
        }
        return next;
      });
    };

    updateFrameSize(node.getBoundingClientRect());
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) updateFrameSize(entry.contentRect);
    });
    observer.observe(node);
    return () => observer.disconnect();
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
      const active = getActiveTransformComponent(clip, activeTransformComponentId);
      if (!active) return;
      const startX = e.clientX;
      const startY = e.clientY;
      const resolved = resolveTransformComponentAtTime(clip, active, currentTime);
      const baseX = resolved.offsetX;
      const baseY = resolved.offsetY;
      beginTx();

      const onMove = (ev: MouseEvent) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        const nextX = baseX + dx;
        const nextY = baseY + dy;
        updateSilent((p) => ({
          ...p,
          clips: p.clips.map((c) => (c.id === selectedId
            ? setTransformPropertyAtTime(
              setTransformPropertyAtTime(c, { componentId: active.id, property: 'offsetX' }, currentTime, nextX),
              { componentId: active.id, property: 'offsetY' },
              currentTime,
              nextY,
            )
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
  }, [project, currentTime, selectedClipIds, updateSilent, beginTx, activeTransformComponentId]);

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
    const aliveMediaKeys = new Set(assets.map((a) => `${a.id}:${a.blobKey}`));
    for (const [mediaKey, url] of urlCache.current) {
      if (!aliveMediaKeys.has(mediaKey)) {
        URL.revokeObjectURL(url);
        urlCache.current.delete(mediaKey);
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
        const mediaKey = `${asset.id}:${asset.blobKey}`;
        const previousMediaKey = clipAssetRef.current.get(clip.id);

        let url = urlCache.current.get(mediaKey);
        if (!url) {
          const u = await objectUrlFor(asset.id);
          if (!u) continue;
          url = u;
          urlCache.current.set(mediaKey, url);
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
            v.style.visibility = 'hidden';
            videoHostRef.current?.appendChild(v);
            pool.set(clip.id, v);
            el = v;
          }
          clipAssetRef.current.set(clip.id, mediaKey);

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
        } else if (previousMediaKey !== mediaKey) {
          // Asset replaced on this clip.
          existing.src = url;
          if (!isAudio) hideVideoElement(existing as HTMLVideoElement);
          clipAssetRef.current.set(clip.id, mediaKey);
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
      const activeVideoLayer = frame.video;
      const nextVideoClipId = activeVideoLayer?.clip.id ?? null;
      for (const [clipId, el] of videoPool.current) {
        const videoEl = el as HTMLVideoElement;
        if (clipId === nextVideoClipId && activeVideoLayer) {
          seekIfNeeded(videoEl, activeVideoLayer.sourceTimeSec, state.playing);
          const tf = resolvedTransform(activeVideoLayer.clip);
          const asset = assetsRef.current.find((item) => item.id === activeVideoLayer.clip.assetId);
          const mediaTransform = asset ? activeEditTransform(asset) : { scale: 1, offsetX: 0, offsetY: 0 };
          const s = Math.max(0.1, Math.min(6, (tf?.scale ?? activeVideoLayer.clip.scale ?? 1) * mediaTransform.scale));
          const ox = (tf?.offsetX ?? 0) + mediaTransform.offsetX;
          const oy = (tf?.offsetY ?? 0) + mediaTransform.offsetY;
          videoEl.style.display = '';
          videoEl.style.visibility = canPaintSyncedVideo(videoEl, activeVideoLayer.sourceTimeSec, state.playing)
            ? 'visible'
            : 'hidden';
          videoEl.style.transform = `translate(${ox}px, ${oy}px) scale(${s})`;
          videoEl.style.transformOrigin = 'center center';
          videoEl.style.cursor = tf ? 'move' : 'default';
        } else {
          hideVideoElement(videoEl);
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
        ref={previewFrameRef}
        className={`flex min-h-0 flex-1 items-center justify-center bg-black ${
          isFullscreen ? '' : 'p-4'
        }`}
      >
        <div
          className={`relative max-h-full max-w-full overflow-hidden bg-black ${
            isFullscreen ? '' : 'rounded-md ring-1 ring-surface-700'
          }`}
          style={previewStageStyle}
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
      <PlayerControls
        isFullscreen={isFullscreen}
        aspectPreset={aspectPreset}
        aspectOptions={PREVIEW_ASPECT_OPTIONS}
        onAspectPresetChange={updateAspectPreset}
        onToggleFullscreen={toggleFullscreen}
      />
    </div>
  );
}
