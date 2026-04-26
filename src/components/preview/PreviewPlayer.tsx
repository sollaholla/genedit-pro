import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMediaStore } from '@/state/mediaStore';
import { usePlaybackStore } from '@/state/playbackStore';
import { useProjectStore } from '@/state/projectStore';
import { resolveFrame, upcomingClips, type ActiveLayer } from '@/lib/playback/engine';
import type { Clip, MediaAsset, Project } from '@/types';
import { clipSpeed, clipTimelineDurationSec, projectDurationSec } from '@/lib/timeline/operations';
import { evalEnvelopeAt } from '@/lib/timeline/envelope';
import { activeEditTransform } from '@/lib/media/editTrail';
import { getBlob } from '@/lib/media/storage';
import {
  getAudioContext,
  getMasterInput,
  getMasterGain,
  resumeAudioContext,
  createStereoAnalyserMeter,
  type StereoAnalyserMeter,
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
import {
  colorCorrectionCssFilter,
  colorCorrectionFilterId,
  colorCorrectionSvgParams,
  resolveColorCorrectionAtTime,
} from '@/lib/components/colorCorrection';
import {
  dimensionsForProjectFormat,
  fpsForFrameRateOption,
  frameRateOptionForFps,
  inferProjectAspectPreset,
  inferProjectResolutionPreset,
  isProjectAspectPreset,
  isProjectResolutionPreset,
  PROJECT_ASPECT_OPTIONS,
  PROJECT_ASPECTS,
  PROJECT_FRAME_RATE_OPTIONS,
  PROJECT_RESOLUTION_OPTIONS,
} from '@/lib/project/dimensions';

function clipEffectiveGain(layer: ActiveLayer): number {
  const master = Math.max(0, Math.min(2, layer.clip.volume ?? 1));
  const clipDur = Math.max(1e-6, layer.clip.outSec - layer.clip.inSec);
  const localT = Math.max(0, Math.min(1, (layer.sourceTimeSec - layer.clip.inSec) / clipDur));
  return master * evalEnvelopeAt(layer.clip.volumeEnvelope, localT);
}

const CLIP_METER_DB_FLOOR = -60;

function rmsToNorm(rms: number): number {
  if (rms <= 0) return 0;
  const db = Math.max(CLIP_METER_DB_FLOOR, 20 * Math.log10(rms));
  return Math.max(0, Math.min(1, (db - CLIP_METER_DB_FLOOR) / -CLIP_METER_DB_FLOOR));
}

function computeRms(buf: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < buf.length; i += 1) sum += buf[i]! * buf[i]!;
  return Math.sqrt(sum / Math.max(1, buf.length));
}

type ElementPool = Map<string, HTMLMediaElement>;
type ImagePool = Map<string, HTMLImageElement>;

const FADE_OUT_MS = 80;
const FADE_IN_MS = 40;
const HAVE_CURRENT_DATA = 2;
const VIDEO_HANDOFF_GRACE_MS = 500;
const PREROLL_SEC = 2.0;
const HOT_PRIMING_SEC = 0.3;
const MEDIA_KEEP_ALIVE_SEC = 6;
const POOL_PRUNE_INTERVAL_MS = 500;

function seekIfNeeded(el: HTMLMediaElement, target: number, playing: boolean) {
  const drift = Math.abs(el.currentTime - target);
  const threshold = playing ? 0.15 : 0.015;
  if (drift > threshold && !el.seeking && el.readyState >= 1) {
    try { el.currentTime = target; } catch { /* noop */ }
  }
}

function canPaintSyncedVideo(el: HTMLVideoElement, target: number, playing: boolean) {
  if (el.readyState < HAVE_CURRENT_DATA) return false;
  if (el.seeking) return playing;
  const threshold = playing ? 0.25 : 0.015;
  return Math.abs(el.currentTime - target) <= threshold;
}

function hideVideoElement(el: HTMLVideoElement) {
  el.style.display = 'none';
  el.style.visibility = 'hidden';
  el.style.transform = '';
  el.style.filter = '';
  el.style.cursor = 'default';
  el.style.zIndex = '';
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

function previewPixelScale(stage: HTMLElement | null, project: Pick<Project, 'width' | 'height'>): number {
  if (!stage || project.width <= 0 || project.height <= 0) return 1;
  const rect = stage.getBoundingClientRect();
  const scaleX = rect.width / project.width;
  const scaleY = rect.height / project.height;
  const scale = Math.min(scaleX, scaleY);
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

function applyVisualLayout(
  el: HTMLVideoElement | HTMLImageElement,
  asset: MediaAsset | undefined,
  clip: Clip,
  project: Project,
  timelineTimeSec: number,
  stage: HTMLElement | null,
) {
  const stageRect = stage?.getBoundingClientRect();
  if (!stageRect || stageRect.width <= 0 || stageRect.height <= 0) return;

  const tf = resolvedTransform(clip);
  const mediaTransform = asset ? activeEditTransform(asset) : { scale: 1, offsetX: 0, offsetY: 0 };
  const mediaWidth = Math.max(1, asset?.width ?? ('videoWidth' in el ? el.videoWidth : el.naturalWidth) ?? project.width);
  const mediaHeight = Math.max(1, asset?.height ?? ('videoHeight' in el ? el.videoHeight : el.naturalHeight) ?? project.height);
  const scale = previewPixelScale(stage, project);
  const x = project.width / 2 + (tf.offsetX + mediaTransform.offsetX);
  const y = project.height / 2 + (tf.offsetY + mediaTransform.offsetY);
  const visualScale = Math.max(0.1, Math.min(6, (tf.scale ?? clip.scale ?? 1) * mediaTransform.scale));

  el.style.left = `${x * scale}px`;
  el.style.top = `${y * scale}px`;
  el.style.width = `${mediaWidth * scale}px`;
  el.style.height = `${mediaHeight * scale}px`;
  el.style.transform = `translate(-50%, -50%) scale(${visualScale})`;
  el.style.transformOrigin = 'center center';
  el.style.filter = colorCorrectionCssFilter(clip, timelineTimeSec);
  el.style.cursor = tf ? 'move' : 'default';
}

export function PreviewPlayer() {
  const project = useProjectStore((s) => s.project);
  const assets = useMediaStore((s) => s.assets);
  const currentTime = usePlaybackStore((s) => s.currentTimeSec);
  const selectedClipIds = usePlaybackStore((s) => s.selectedClipIds);
  const setCurrentTime = usePlaybackStore((s) => s.setCurrentTime);
  const pause = usePlaybackStore((s) => s.pause);
  const updateSilent = useProjectStore((s) => s.updateSilent);
  const updateProject = useProjectStore((s) => s.update);
  const beginTx = useProjectStore((s) => s.beginTx);
  const activeTransformComponentId = usePlaybackStore((s) => s.activeTransformComponentId);

  const videoHostRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const previewFrameRef = useRef<HTMLDivElement | null>(null);
  const previewStageRef = useRef<HTMLDivElement | null>(null);

  // Pools keyed by CLIP id (not asset id). Each clip needs its own element so
  // overlapping same-asset clips don't fight over currentTime.
  const videoPool = useRef<ElementPool>(new Map());
  const imagePool = useRef<ImagePool>(new Map());
  const audioPool = useRef<ElementPool>(new Map());
  // clipId -> asset id + active blob key that el.src is currently set to.
  const clipAssetRef = useRef<Map<string, string>>(new Map());
  // clipId → GainNode connected to the master bus
  const gainNodes = useRef<Map<string, GainNode>>(new Map());
  // clipId → MediaElementAudioSourceNode (keep ref so it isn't GC'd)
  const sourceNodes = useRef<Map<string, MediaElementAudioSourceNode>>(new Map());
  const clipMeters = useRef<Map<string, StereoAnalyserMeter>>(new Map());
  const clipMeterBuffers = useRef<Map<string, [Float32Array, Float32Array]>>(new Map());

  const urlCache = useRef<Map<string, string>>(new Map());
  const pendingClipLoadsRef = useRef<Set<string>>(new Set());
  const assetsRef = useRef(assets);
  const lastTickRef = useRef<number | null>(null);
  const prevHasVideoRef = useRef(false);
  const lastPaintedVisualRef = useRef<{ clipId: string; ts: number } | null>(null);
  const lastPoolPruneRef = useRef(0);
  const prerolledRef = useRef<Set<string>>(new Set());
  // Tracks which upcoming clips we've aligned for hot-priming. Alignment seeks
  // `currentTime = inSec - timeUntilActive` so after playing for
  // `timeUntilActive` seconds muted, currentTime naturally arrives at inSec at
  // the exact moment of handoff — avoiding a seek inside the active loop (which
  // briefly silences audio and creates the "eeee---eeee" gap on snapped clips).
  const hotPrimedSeekRef = useRef<Set<string>>(new Set());
  const prevReadinessRef = useRef<Record<string, boolean>>({});
  const lastReadinessPublishRef = useRef(0);
  const lastClipMeterPublishRef = useRef(0);

  // Smooth transitions: track which clips are fading out/in to avoid pops.
  const fadingOut = useRef<Map<string, { startTs: number; fromGain: number }>>(new Map());
  const fadingIn = useRef<Map<string, { startTs: number; targetGain: number }>>(new Map());
  const prevActiveAudioIds = useRef<Set<string>>(new Set());

  const [hasActiveVideo, setHasActiveVideo] = useState(false);
  const [ready, setReady] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [previewFrameSize, setPreviewFrameSize] = useState<{ width: number; height: number } | null>(null);
  const aspectPreset = inferProjectAspectPreset(project.width, project.height);
  const resolutionPreset = inferProjectResolutionPreset(project.width, project.height, aspectPreset);
  const frameRatePreset = frameRateOptionForFps(project.fps);
  const previewAspectRatio = PROJECT_ASPECTS[aspectPreset];

  const updateAspectPreset = (value: string) => {
    if (!isProjectAspectPreset(value)) return;
    const next = dimensionsForProjectFormat(value, resolutionPreset);
    updateProject((p) => ({ ...p, ...next }));
  };

  const updateResolutionPreset = (value: string) => {
    if (!isProjectResolutionPreset(value)) return;
    const next = dimensionsForProjectFormat(aspectPreset, value);
    updateProject((p) => ({ ...p, ...next }));
  };

  const updateFrameRatePreset = (value: string) => {
    const fps = fpsForFrameRateOption(value);
    if (!fps) return;
    updateProject((p) => ({ ...p, fps }));
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

  useEffect(() => {
    const node = previewStageRef.current;
    if (!node) return;
    node.style.aspectRatio = String(previewStageStyle.aspectRatio);
    node.style.width = previewStageStyle.width;
    if ('height' in previewStageStyle && previewStageStyle.height) {
      node.style.height = previewStageStyle.height;
    } else {
      node.style.removeProperty('height');
    }
  }, [previewStageStyle]);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
    } else {
      void containerRef.current?.requestFullscreen().catch(() => undefined);
    }
  };

  const releaseAudioGraph = useCallback((clipId: string) => {
    gainNodes.current.get(clipId)?.disconnect();
    gainNodes.current.delete(clipId);
    sourceNodes.current.get(clipId)?.disconnect();
    sourceNodes.current.delete(clipId);
    clipMeters.current.get(clipId)?.dispose();
    clipMeters.current.delete(clipId);
    clipMeterBuffers.current.delete(clipId);
    fadingOut.current.delete(clipId);
    fadingIn.current.delete(clipId);
    hotPrimedSeekRef.current.delete(clipId);
    prerolledRef.current.delete(clipId);
    pendingClipLoadsRef.current.delete(clipId);
  }, []);

  const removeVideoElement = useCallback((clipId: string) => {
    const el = videoPool.current.get(clipId);
    if (el) {
      el.pause();
      (el as HTMLVideoElement).remove();
      videoPool.current.delete(clipId);
    }
    clipAssetRef.current.delete(clipId);
    releaseAudioGraph(clipId);
  }, [releaseAudioGraph]);

  const removeAudioElement = useCallback((clipId: string) => {
    const el = audioPool.current.get(clipId);
    if (el) {
      el.pause();
      audioPool.current.delete(clipId);
    }
    clipAssetRef.current.delete(clipId);
    releaseAudioGraph(clipId);
  }, [releaseAudioGraph]);

  const removeImageElement = useCallback((clipId: string) => {
    imagePool.current.get(clipId)?.remove();
    imagePool.current.delete(clipId);
    clipAssetRef.current.delete(clipId);
    pendingClipLoadsRef.current.delete(clipId);
  }, []);

  const removeClipElements = useCallback((clipId: string) => {
    removeVideoElement(clipId);
    removeAudioElement(clipId);
    removeImageElement(clipId);
  }, [removeAudioElement, removeImageElement, removeVideoElement]);

  const attachClipElement = useCallback((clip: Clip, asset: MediaAsset, url: string, mediaKey: string) => {
    if (asset.kind === 'image') {
      removeVideoElement(clip.id);
      removeAudioElement(clip.id);
      const existing = imagePool.current.get(clip.id);
      if (!existing) {
        const img = document.createElement('img');
        img.src = url;
        img.alt = '';
        img.decoding = 'async';
        img.className = 'absolute max-w-none object-contain';
        img.style.display = 'none';
        img.style.visibility = 'hidden';
        videoHostRef.current?.appendChild(img);
        imagePool.current.set(clip.id, img);
      } else if (clipAssetRef.current.get(clip.id) !== mediaKey) {
        existing.src = url;
        existing.style.display = 'none';
        existing.style.visibility = 'hidden';
      }
      clipAssetRef.current.set(clip.id, mediaKey);
      return imagePool.current.get(clip.id) ?? null;
    }

    removeImageElement(clip.id);
    const isAudio = asset.kind === 'audio';
    const pool = isAudio ? audioPool.current : videoPool.current;
    const existing = pool.get(clip.id);
    if (existing) {
      if (clipAssetRef.current.get(clip.id) !== mediaKey) {
        existing.src = url;
        if (!isAudio) hideVideoElement(existing as HTMLVideoElement);
        clipAssetRef.current.set(clip.id, mediaKey);
      }
      return existing;
    }

    let el: HTMLMediaElement;
    if (isAudio) {
      const audio = new Audio();
      audio.preload = 'auto';
      audio.src = url;
      pool.set(clip.id, audio);
      el = audio;
    } else {
      const video = document.createElement('video');
      video.preload = 'auto';
      video.playsInline = true;
      video.muted = true;
      video.src = url;
      video.className = 'absolute max-w-none object-contain';
      video.style.display = 'none';
      video.style.visibility = 'hidden';
      videoHostRef.current?.appendChild(video);
      pool.set(clip.id, video);
      el = video;
    }
    clipAssetRef.current.set(clip.id, mediaKey);

    try {
      const ctx = getAudioContext();
      const source = ctx.createMediaElementSource(el);
      const gain = ctx.createGain();
      gain.gain.value = 0;
      const meter = createStereoAnalyserMeter();
      source.connect(gain);
      gain.connect(getMasterInput());
      gain.connect(meter.input);
      sourceNodes.current.set(clip.id, source);
      gainNodes.current.set(clip.id, gain);
      clipMeters.current.set(clip.id, meter);
    } catch {
      // Fallback: element won't route through Web Audio; volume stays at el.volume.
    }

    return el;
  }, [removeAudioElement, removeImageElement, removeVideoElement]);

  const ensureClipElement = useCallback((clip: Clip, asset: MediaAsset) => {
    if (asset.kind === 'recipe' || asset.kind === 'sequence') return null;
    const mediaKey = `${asset.id}:${asset.blobKey}`;
    const existing = imagePool.current.get(clip.id) ?? videoPool.current.get(clip.id) ?? audioPool.current.get(clip.id);
    if (existing && clipAssetRef.current.get(clip.id) === mediaKey) return existing;

    const cachedUrl = urlCache.current.get(mediaKey);
    if (cachedUrl) return attachClipElement(clip, asset, cachedUrl, mediaKey);

    if (!pendingClipLoadsRef.current.has(clip.id)) {
      pendingClipLoadsRef.current.add(clip.id);
      void getBlob(asset.blobKey).then((blob) => {
        pendingClipLoadsRef.current.delete(clip.id);
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        urlCache.current.set(mediaKey, url);
        const latestClip = useProjectStore.getState().project.clips.find((candidate) => candidate.id === clip.id);
        const latestAsset = assetsRef.current.find((candidate) => candidate.id === asset.id);
        if (!latestClip || !latestAsset || latestClip.assetId !== asset.id || latestAsset.blobKey !== asset.blobKey) {
          URL.revokeObjectURL(url);
          urlCache.current.delete(mediaKey);
          return;
        }
        attachClipElement(latestClip, latestAsset, url, mediaKey);
      });
    }

    return null;
  }, [attachClipElement]);

  const pruneMediaElements = useCallback((projectToPrune: Project, timeSec: number, ts: number) => {
    const clipsById = new Map(projectToPrune.clips.map((clip) => [clip.id, clip]));
    const keepClip = (clipId: string) => {
      const clip = clipsById.get(clipId);
      if (!clip) return false;
      const endSec = clip.startSec + clipTimelineDurationSec(clip);
      const nearPlayhead = timeSec >= clip.startSec - MEDIA_KEEP_ALIVE_SEC && timeSec <= endSec + MEDIA_KEEP_ALIVE_SEC;
      const recentlyPainted = lastPaintedVisualRef.current?.clipId === clipId
        && ts - lastPaintedVisualRef.current.ts <= VIDEO_HANDOFF_GRACE_MS;
      return nearPlayhead || recentlyPainted || fadingOut.current.has(clipId) || fadingIn.current.has(clipId);
    };

    for (const clipId of [...videoPool.current.keys()]) {
      if (!keepClip(clipId)) removeVideoElement(clipId);
    }
    for (const clipId of [...imagePool.current.keys()]) {
      if (!keepClip(clipId)) removeImageElement(clipId);
    }
    for (const clipId of [...audioPool.current.keys()]) {
      if (!keepClip(clipId)) removeAudioElement(clipId);
    }
  }, [removeAudioElement, removeImageElement, removeVideoElement]);

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
    const el = (videoPool.current.get(selectedId) as HTMLVideoElement | undefined) ?? imagePool.current.get(selectedId);
    if (!el) return;

    const onDown = (event: Event) => {
      const e = event as MouseEvent;
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
      const pixelScale = previewPixelScale(videoHostRef.current, useProjectStore.getState().project);
      beginTx();

      const onMove = (ev: MouseEvent) => {
        const dx = (ev.clientX - startX) / pixelScale;
        const dy = (ev.clientY - startY) / pixelScale;
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

  // Reconcile the lazy media pools. Elements are created on demand for the
  // active/preroll window so dense chopped timelines do not exhaust decoders.
  useEffect(() => {
    const assetsById = new Map(assets.map((a) => [a.id, a]));
    const knownClipIds = new Set(project.clips.map((clip) => clip.id));

    const wantedVideoClipIds = new Set<string>();
    const wantedImageClipIds = new Set<string>();
    const wantedAudioClipIds = new Set<string>();
    for (const clip of project.clips) {
      const asset = assetsById.get(clip.assetId);
      if (!asset) continue;
      if (asset.kind === 'image') wantedImageClipIds.add(clip.id);
      else if (asset.kind === 'audio') wantedAudioClipIds.add(clip.id);
      else if (asset.kind === 'video') wantedVideoClipIds.add(clip.id);
    }

    for (const clipId of new Set([
      ...videoPool.current.keys(),
      ...imagePool.current.keys(),
      ...audioPool.current.keys(),
    ])) {
      if (!knownClipIds.has(clipId)) removeClipElements(clipId);
    }

    for (const clipId of [...videoPool.current.keys()]) {
      if (!wantedVideoClipIds.has(clipId)) removeVideoElement(clipId);
    }
    for (const clipId of [...imagePool.current.keys()]) {
      if (!wantedImageClipIds.has(clipId)) removeImageElement(clipId);
    }
    for (const clipId of [...audioPool.current.keys()]) {
      if (!wantedAudioClipIds.has(clipId)) removeAudioElement(clipId);
    }

    const aliveMediaKeys = new Set(assets.map((a) => `${a.id}:${a.blobKey}`));
    for (const [mediaKey, url] of [...urlCache.current.entries()]) {
      if (!aliveMediaKeys.has(mediaKey)) {
        URL.revokeObjectURL(url);
        urlCache.current.delete(mediaKey);
      }
    }

    const timeSec = usePlaybackStore.getState().currentTimeSec;
    for (const clip of project.clips) {
      const endSec = clip.startSec + clipTimelineDurationSec(clip);
      if (timeSec < clip.startSec - PREROLL_SEC || timeSec > endSec + 1) continue;
      const asset = assetsById.get(clip.assetId);
      if (asset) ensureClipElement(clip, asset);
    }
    setReady(true);
  }, [assets, ensureClipElement, project.clips, removeAudioElement, removeClipElements, removeImageElement, removeVideoElement]);

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
      const assetsById = new Map(assetsRef.current.map((asset) => [asset.id, asset]));
      const upcoming = upcomingClips(proj, t, PREROLL_SEC);
      const neededClipIds = new Set<string>();
      for (const layer of [...frame.videos, ...frame.audios]) {
        if (neededClipIds.has(layer.clip.id)) continue;
        neededClipIds.add(layer.clip.id);
        const asset = assetsById.get(layer.clip.assetId);
        if (asset) ensureClipElement(layer.clip, asset);
      }
      for (const clip of upcoming) {
        if (neededClipIds.has(clip.id)) continue;
        neededClipIds.add(clip.id);
        const asset = assetsById.get(clip.assetId);
        if (asset) ensureClipElement(clip, asset);
      }

      // ---- VIDEO DISPLAY ----
      const visualLayers = frame.videos;
      const activeVisualLayersByClipId = new Map(visualLayers.map((layer) => [layer.clip.id, layer]));
      const activeVisualAssetsByClipId = new Map<string, MediaAsset>();
      for (const layer of visualLayers) {
        const asset = assetsById.get(layer.clip.assetId);
        if (asset?.kind === 'video' || asset?.kind === 'image') activeVisualAssetsByClipId.set(layer.clip.id, asset);
      }
      const visualZIndexByClipId = new Map<string, number>();
      visualLayers.forEach((layer, index) => visualZIndexByClipId.set(layer.clip.id, visualLayers.length - index));
      const paintableVisualClipIds = new Set<string>();
      for (const layer of visualLayers) {
        const activeAsset = activeVisualAssetsByClipId.get(layer.clip.id);
        if (activeAsset?.kind === 'image') {
          paintableVisualClipIds.add(layer.clip.id);
          continue;
        }
        if (activeAsset?.kind !== 'video') continue;
        const videoEl = videoPool.current.get(layer.clip.id) as HTMLVideoElement | undefined;
        if (!videoEl) continue;
        seekIfNeeded(videoEl, layer.sourceTimeSec, state.playing);
        if (canPaintSyncedVideo(videoEl, layer.sourceTimeSec, state.playing)) {
          paintableVisualClipIds.add(layer.clip.id);
        }
      }
      const topPaintableLayer = visualLayers.find((layer) => paintableVisualClipIds.has(layer.clip.id)) ?? null;
      if (topPaintableLayer) {
        lastPaintedVisualRef.current = { clipId: topPaintableLayer.clip.id, ts };
      }
      const lastPaintedVisual = lastPaintedVisualRef.current;
      const fallbackVisualClipId = !topPaintableLayer
        && visualLayers.length > 0
        && lastPaintedVisual
        && ts - lastPaintedVisual.ts <= VIDEO_HANDOFF_GRACE_MS
        ? lastPaintedVisual.clipId
        : null;
      for (const [clipId, el] of videoPool.current) {
        const videoEl = el as HTMLVideoElement;
        const activeLayer = activeVisualLayersByClipId.get(clipId);
        const activeAsset = activeVisualAssetsByClipId.get(clipId);
        const isFallbackVisual = clipId === fallbackVisualClipId;
        if (activeLayer && activeAsset?.kind === 'video') {
          videoEl.style.display = '';
          videoEl.style.visibility = paintableVisualClipIds.has(clipId) || isFallbackVisual
            ? 'visible'
            : 'hidden';
          videoEl.style.zIndex = String(visualZIndexByClipId.get(clipId) ?? 1);
          applyVisualLayout(videoEl, activeAsset, activeLayer.clip, proj, t, videoHostRef.current);
        } else if (isFallbackVisual) {
          videoEl.style.display = '';
          videoEl.style.visibility = 'visible';
        } else {
          hideVideoElement(videoEl);
        }
      }
      for (const [clipId, img] of imagePool.current) {
        const activeLayer = activeVisualLayersByClipId.get(clipId);
        const activeAsset = activeVisualAssetsByClipId.get(clipId);
        const isFallbackVisual = clipId === fallbackVisualClipId;
        if (activeLayer && activeAsset?.kind === 'image') {
          img.style.display = '';
          img.style.visibility = 'visible';
          img.style.zIndex = String(visualZIndexByClipId.get(clipId) ?? 1);
          applyVisualLayout(img, activeAsset, activeLayer.clip, proj, t, videoHostRef.current);
        } else if (isFallbackVisual) {
          img.style.display = '';
          img.style.visibility = 'visible';
        } else {
          img.style.display = 'none';
          img.style.visibility = 'hidden';
          img.style.transform = '';
          img.style.filter = '';
          img.style.cursor = 'default';
          img.style.zIndex = '';
        }
      }
      const hasVideo = visualLayers.length > 0;
      if (hasVideo !== prevHasVideoRef.current) {
        prevHasVideoRef.current = hasVideo;
        setHasActiveVideo(hasVideo);
      }

      // ---- AUDIO MIX + PREROLL ----
      const activeAudioIds = new Set<string>();
      for (const layer of frame.audios) activeAudioIds.add(layer.clip.id);

      // Preroll: seek upcoming clips so their decoder buffer is warm.
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

      if (ts - lastPoolPruneRef.current > POOL_PRUNE_INTERVAL_MS) {
        lastPoolPruneRef.current = ts;
        pruneMediaElements(proj, t, ts);
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

      if (ts - lastClipMeterPublishRef.current > 100) {
        lastClipMeterPublishRef.current = ts;
        const levels: Record<string, { left: number; right: number }> = {};
        for (const [clipId, meter] of clipMeters.current) {
          let buffers = clipMeterBuffers.current.get(clipId);
          if (!buffers || buffers[0].length !== meter.left.fftSize || buffers[1].length !== meter.right.fftSize) {
            buffers = [new Float32Array(meter.left.fftSize), new Float32Array(meter.right.fftSize)];
            clipMeterBuffers.current.set(clipId, buffers);
          }
          const [leftBuffer, rightBuffer] = buffers;
          const leftData = leftBuffer as Float32Array<ArrayBuffer>;
          const rightData = rightBuffer as Float32Array<ArrayBuffer>;
          meter.left.getFloatTimeDomainData(leftData);
          meter.right.getFloatTimeDomainData(rightData);
          levels[clipId] = {
            left: rmsToNorm(computeRms(leftData)),
            right: rmsToNorm(computeRms(rightData)),
          };
        }
        usePlaybackStore.getState().setClipAudioLevels(levels);
      }

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [ensureClipElement, pause, pruneMediaElements]);

  // Cleanup on unmount.
  useEffect(() => {
    const videoEls = videoPool.current;
    const imageEls = imagePool.current;
    const audioEls = audioPool.current;
    const urls = urlCache.current;
    const pendingLoads = pendingClipLoadsRef.current;
    const meters = clipMeters.current;
    const meterBuffers = clipMeterBuffers.current;
    return () => {
      for (const el of videoEls.values()) el.pause();
      for (const el of imageEls.values()) el.remove();
      for (const el of audioEls.values()) el.pause();
      for (const meter of meters.values()) meter.dispose();
      meters.clear();
      meterBuffers.clear();
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
      pendingLoads.clear();
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
        className={`flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden bg-black ${
          isFullscreen ? '' : 'p-4'
        }`}
      >
        <div
          ref={previewStageRef}
          className={`relative max-h-full max-w-full overflow-hidden bg-black ${
            isFullscreen ? '' : 'rounded-md ring-1 ring-surface-700'
          }`}
          onDoubleClick={toggleFullscreen}
        >
          <svg aria-hidden className="pointer-events-none absolute h-0 w-0" focusable="false">
            <defs>
              {project.clips.map((clip) => (
                <ColorCorrectionFilterDef
                  key={clip.id}
                  clip={clip}
                  currentTime={currentTime}
                />
              ))}
            </defs>
          </svg>
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
        aspectOptions={PROJECT_ASPECT_OPTIONS}
        resolutionPreset={resolutionPreset}
        resolutionOptions={PROJECT_RESOLUTION_OPTIONS}
        frameRatePreset={frameRatePreset}
        frameRateOptions={PROJECT_FRAME_RATE_OPTIONS}
        onAspectPresetChange={updateAspectPreset}
        onResolutionPresetChange={updateResolutionPreset}
        onFrameRatePresetChange={updateFrameRatePreset}
        onToggleFullscreen={toggleFullscreen}
      />
    </div>
  );
}

function ColorCorrectionFilterDef({
  clip,
  currentTime,
}: {
  clip: ActiveLayer['clip'];
  currentTime: number;
}) {
  const params = colorCorrectionSvgParams(resolveColorCorrectionAtTime(clip, currentTime));
  return (
    <filter
      id={colorCorrectionFilterId(clip.id)}
      x="-20%"
      y="-20%"
      width="140%"
      height="140%"
      colorInterpolationFilters="sRGB"
    >
      <feComponentTransfer>
        <feFuncR type="gamma" amplitude={params.gain.r} exponent={params.exponent.r} offset={params.lift.r} />
        <feFuncG type="gamma" amplitude={params.gain.g} exponent={params.exponent.g} offset={params.lift.g} />
        <feFuncB type="gamma" amplitude={params.gain.b} exponent={params.exponent.b} offset={params.lift.b} />
      </feComponentTransfer>
    </filter>
  );
}
