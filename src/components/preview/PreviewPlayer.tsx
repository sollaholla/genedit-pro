import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useMediaStore } from '@/state/mediaStore';
import { usePlaybackStore } from '@/state/playbackStore';
import { useProjectStore } from '@/state/projectStore';
import { resolveFrame, type ActiveLayer } from '@/lib/playback/engine';
import { PREVIEW_RENDER_SCALE, renderProjectPreview } from '@/lib/ffmpeg/export';
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
const PREPARE_BACKWARD_SEC = 5.0;
const PREPARE_FORWARD_SEC = 5.0;
const HOT_PRIMING_SEC = 0.3;
const AUDIO_FADE_RETAIN_SEC = 0.25;
const MAX_PREPARED_CLIPS = 48;
const PREVIEW_RENDER_CHUNK_SEC = 5;

type FfmpegPreviewState = {
  status: 'idle' | 'rendering' | 'ready' | 'error';
  progress: number;
  startSec: number;
  endSec: number;
  durationSec: number;
  message?: string;
  error?: string;
  url?: string;
  width?: number;
  height?: number;
  signature?: string;
};

type FfmpegPreviewChunk = FfmpegPreviewState & {
  id: string;
  signature: string;
};

type PreviewRenderJob = {
  id: string;
  abortController: AbortController;
};

function cloneForPreviewRender<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function clipEndSec(clip: Clip): number {
  return clip.startSec + clipTimelineDurationSec(clip);
}

function clipIntersectsWindow(clip: Clip, startSec: number, endSec: number): boolean {
  return clip.startSec <= endSec && clipEndSec(clip) >= startSec;
}

function preparedClipScore(clip: Clip, timeSec: number, required: boolean): number {
  if (required) return -1000 + clip.startSec * 0.001;
  const endSec = clipEndSec(clip);
  if (timeSec >= clip.startSec && timeSec <= endSec) return -100 + clip.startSec * 0.001;
  if (clip.startSec > timeSec) return (clip.startSec - timeSec) + clip.startSec * 0.0001;
  return PREPARE_FORWARD_SEC + (timeSec - endSec) + clip.startSec * 0.0001;
}

function preparedClipsForTime(project: Project, timeSec: number): Clip[] {
  const activeFrame = resolveFrame(project, timeSec);
  const requiredIds = new Set<string>();
  for (const layer of [...activeFrame.videos, ...activeFrame.audios]) requiredIds.add(layer.clip.id);

  const candidates = project.clips
    .filter((clip) => clipIntersectsWindow(clip, timeSec - PREPARE_BACKWARD_SEC, timeSec + PREPARE_FORWARD_SEC))
    .map((clip) => ({ clip, score: preparedClipScore(clip, timeSec, requiredIds.has(clip.id)) }))
    .sort((first, second) => first.score - second.score);

  const prepared = new Map<string, Clip>();
  for (const candidate of candidates) {
    if (prepared.size >= MAX_PREPARED_CLIPS && !requiredIds.has(candidate.clip.id)) continue;
    prepared.set(candidate.clip.id, candidate.clip);
  }
  return [...prepared.values()];
}

function visualPreviewDurationSec(project: Project, assets: MediaAsset[]): number {
  const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
  const tracksById = new Map(project.tracks.map((track) => [track.id, track]));
  return project.clips.reduce((maxDuration, clip) => {
    const asset = assetsById.get(clip.assetId);
    const track = tracksById.get(clip.trackId);
    if (!asset || !track) return maxDuration;
    if (track.kind !== 'video' || track.hidden) return maxDuration;
    if (asset.kind !== 'video' && asset.kind !== 'image') return maxDuration;
    return Math.max(maxDuration, clipEndSec(clip));
  }, 0);
}

function previewRenderWindowForTime(timeSec: number, visualDurationSec: number): { startSec: number; endSec: number } {
  const clampedTimeSec = Math.max(0, Math.min(visualDurationSec, timeSec));
  const chunkTimeSec = clampedTimeSec >= visualDurationSec
    ? Math.max(0, visualDurationSec - 1e-6)
    : clampedTimeSec;
  const chunkIndex = Math.floor(chunkTimeSec / PREVIEW_RENDER_CHUNK_SEC);
  const startSec = chunkIndex * PREVIEW_RENDER_CHUNK_SEC;
  return { startSec, endSec: Math.min(visualDurationSec, startSec + PREVIEW_RENDER_CHUNK_SEC) };
}

function previewRenderWindows(visualDurationSec: number): Array<{ id: string; startSec: number; endSec: number }> {
  const windows: Array<{ id: string; startSec: number; endSec: number }> = [];
  for (let startSec = 0; startSec < visualDurationSec; startSec += PREVIEW_RENDER_CHUNK_SEC) {
    const endSec = Math.min(visualDurationSec, startSec + PREVIEW_RENDER_CHUNK_SEC);
    windows.push({ id: previewChunkId(startSec, endSec), startSec, endSec });
  }
  return windows;
}

function previewChunkId(startSec: number, endSec: number): string {
  return `${startSec.toFixed(3)}-${endSec.toFixed(3)}`;
}

function previewRenderSignature(project: Project, assets: MediaAsset[]): string {
  return JSON.stringify({
    project,
    assets: assets.map((asset) => ({
      id: asset.id,
      kind: asset.kind,
      blobKey: asset.blobKey,
      durationSec: asset.durationSec,
      width: asset.width,
      height: asset.height,
      activeIterationId: asset.editTrail?.activeIterationId,
    })),
  });
}

function previewChunkSignature(
  project: Project,
  assets: MediaAsset[],
  startSec: number,
  endSec: number,
): string {
  const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
  const tracksById = new Map(project.tracks.map((track) => [track.id, track]));
  const visualTracks = project.tracks
    .filter((track) => track.kind === 'video')
    .map((track) => ({ id: track.id, index: track.index, hidden: track.hidden }));
  const clips = project.clips
    .filter((clip) => {
      const track = tracksById.get(clip.trackId);
      const asset = assetsById.get(clip.assetId);
      return !!track
        && !!asset
        && track.kind === 'video'
        && !track.hidden
        && (asset.kind === 'video' || asset.kind === 'image')
        && clipIntersectsWindow(clip, startSec, endSec);
    })
    .sort((first, second) => first.startSec - second.startSec || first.id.localeCompare(second.id))
    .map((clip) => {
      const asset = assetsById.get(clip.assetId)!;
      return {
        clip: {
          id: clip.id,
          assetId: clip.assetId,
          trackId: clip.trackId,
          startSec: clip.startSec,
          inSec: clip.inSec,
          outSec: clip.outSec,
          speed: clip.speed,
          scale: clip.scale,
          transform: clip.transform,
          components: clip.components,
        },
        asset: {
          id: asset.id,
          name: asset.name,
          kind: asset.kind,
          blobKey: asset.blobKey,
          durationSec: asset.durationSec,
          width: asset.width,
          height: asset.height,
          transform: activeEditTransform(asset),
        },
      };
    });

  return JSON.stringify({
    width: project.width,
    height: project.height,
    fps: project.fps,
    scale: PREVIEW_RENDER_SCALE,
    startSec,
    endSec,
    visualTracks,
    clips,
  });
}

function safeProjectFps(project: Pick<Project, 'fps'>): number {
  return Number.isFinite(project.fps) && project.fps > 0 ? project.fps : 30;
}

function projectFrameIndex(timeSec: number, fps: number): number {
  return Math.max(0, Math.floor(Math.max(0, timeSec) * fps + 1e-6));
}

function projectFrameTime(timeSec: number, fps: number): number {
  return projectFrameIndex(timeSec, fps) / fps;
}

type VideoSyncWindow = {
  beforeSec: number;
  afterSec: number;
};

function videoSyncWindow(clip: Clip, fps: number, playing: boolean): VideoSyncWindow {
  const frameSec = 1 / Math.max(1, fps);
  const sourceFrameSec = frameSec * Math.max(0.01, Math.abs(clipSpeed(clip)));
  const beforeSec = Math.min(0.035, Math.max(0.015, sourceFrameSec * 0.75));
  if (!playing) return { beforeSec, afterSec: beforeSec };
  return {
    beforeSec: Math.min(0.16, Math.max(0.05, sourceFrameSec * 1.75)),
    afterSec: Math.min(0.12, Math.max(0.035, sourceFrameSec * 1.25)),
  };
}

function outsideSyncWindow(current: number, target: number, tolerance: number | VideoSyncWindow): boolean {
  if (typeof tolerance === 'number') return Math.abs(current - target) > tolerance;
  return current < target - tolerance.beforeSec || current > target + tolerance.afterSec;
}

function seekIfNeeded(
  el: HTMLMediaElement,
  target: number,
  playing: boolean,
  tolerance?: number | VideoSyncWindow,
  requestedSeekTargets?: WeakMap<HTMLMediaElement, number>,
): boolean {
  const drift = Math.abs(el.currentTime - target);
  const threshold = tolerance ?? (playing ? 0.15 : 0.015);
  const shouldSeek = typeof threshold === 'number'
    ? drift > threshold
    : outsideSyncWindow(el.currentTime, target, threshold);
  if (!shouldSeek) {
    requestedSeekTargets?.delete(el);
    return false;
  }
  const lastRequestedTarget = requestedSeekTargets?.get(el);
  const hasRequestedTarget = lastRequestedTarget !== undefined && Math.abs(lastRequestedTarget - target) <= 0.002;
  const canRetargetPausedSeek = !playing && !hasRequestedTarget;
  if ((!el.seeking || canRetargetPausedSeek) && el.readyState >= 1) {
    try { el.currentTime = target; } catch { /* noop */ }
    requestedSeekTargets?.set(el, target);
    return true;
  }
  return false;
}

function canPaintSyncedVideo(
  el: HTMLVideoElement,
  clip: Clip,
  target: number,
  tolerance: number | VideoSyncWindow,
) {
  if (el.readyState < 1 || el.videoWidth <= 0 || el.videoHeight <= 0) return false;
  if (el.currentTime < Math.max(0, clip.inSec - 0.015)) return false;
  if (el.currentTime > clip.outSec + 0.05) return false;
  return !outsideSyncWindow(el.currentTime, target, tolerance);
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

function syncRenderedPreviewVideo(
  el: HTMLVideoElement | null,
  targetTimeSec: number,
  playing: boolean,
  active: boolean,
  startSec: number,
  durationSec: number,
) {
  if (!el) return;
  if (!active || durationSec <= 0) {
    el.style.display = 'none';
    if (!el.paused) el.pause();
    return;
  }

  const target = Math.max(0, Math.min(durationSec, targetTimeSec - startSec));
  el.style.display = 'block';
  el.muted = true;
  el.playbackRate = 1;
  const threshold = playing ? 0.14 : 0.025;
  if (Math.abs(el.currentTime - target) > threshold && !el.seeking) {
    try { el.currentTime = target; } catch { /* noop */ }
  }
  if (playing) {
    if (el.paused) el.play().catch(() => undefined);
  } else if (!el.paused) {
    el.pause();
  }
}

function resolvedTransform(clip: ActiveLayer['clip'], timelineTimeSec: number) {
  const resolved = resolveTransformAtTime(clip, timelineTimeSec);
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

  const tf = resolvedTransform(clip, timelineTimeSec);
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

function canvasFilterForClip(clip: Clip, timelineTimeSec: number): string {
  return colorCorrectionCssFilter(clip, timelineTimeSec)
    .replace(/url\([^)]*\)\s*/g, '')
    .trim() || 'none';
}

function renderPreviewCanvas(
  canvas: HTMLCanvasElement | null,
  visualLayers: ActiveLayer[],
  assetsById: Map<string, MediaAsset>,
  project: Project,
  timelineTimeSec: number,
  previewFps: number,
  playing: boolean,
  videoPool: ElementPool,
  imagePool: ImagePool,
): boolean {
  if (!canvas || project.width <= 0 || project.height <= 0) return false;
  const drawItems: Array<{
    source: HTMLVideoElement | HTMLImageElement;
    asset: MediaAsset;
    clip: Clip;
  }> = [];

  for (const layer of [...visualLayers].reverse()) {
    const asset = assetsById.get(layer.clip.assetId);
    if (asset?.kind !== 'video' && asset?.kind !== 'image') continue;
    const source = asset.kind === 'image'
      ? imagePool.get(layer.clip.id)
      : videoPool.get(layer.clip.id) as HTMLVideoElement | undefined;
    if (!source) return false;
    if (source instanceof HTMLVideoElement) {
      const tolerance = videoSyncWindow(layer.clip, previewFps, playing);
      if (!canPaintSyncedVideo(source, layer.clip, layer.sourceTimeSec, tolerance)) return false;
    }
    if (source instanceof HTMLImageElement && !source.complete) return false;
    drawItems.push({ source, asset, clip: layer.clip });
  }

  if (drawItems.length === 0) return false;
  if (canvas.width !== project.width) canvas.width = project.width;
  if (canvas.height !== project.height) canvas.height = project.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return false;
  try {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'black';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (const { source, asset, clip } of drawItems) {
      const tf = resolvedTransform(clip, timelineTimeSec);
      const mediaTransform = activeEditTransform(asset);
      const sourceWidth = source instanceof HTMLVideoElement ? source.videoWidth : source.naturalWidth;
      const sourceHeight = source instanceof HTMLVideoElement ? source.videoHeight : source.naturalHeight;
      const mediaWidth = Math.max(1, asset.width ?? sourceWidth ?? project.width);
      const mediaHeight = Math.max(1, asset.height ?? sourceHeight ?? project.height);
      const x = project.width / 2 + (tf.offsetX + mediaTransform.offsetX);
      const y = project.height / 2 + (tf.offsetY + mediaTransform.offsetY);
      const visualScale = Math.max(0.1, Math.min(6, (tf.scale ?? clip.scale ?? 1) * mediaTransform.scale));
      ctx.save();
      ctx.filter = canvasFilterForClip(clip, timelineTimeSec);
      ctx.translate(x, y);
      ctx.scale(visualScale, visualScale);
      ctx.drawImage(source, -mediaWidth / 2, -mediaHeight / 2, mediaWidth, mediaHeight);
      ctx.restore();
    }
    return true;
  } catch {
    return false;
  } finally {
    ctx.filter = 'none';
  }
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
  const freezeFrameCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const previewFrameRef = useRef<HTMLDivElement | null>(null);
  const previewStageRef = useRef<HTMLDivElement | null>(null);
  const ffmpegPreviewVideoRef = useRef<HTMLVideoElement | null>(null);
  const ffmpegPreviewCacheRef = useRef<Map<string, FfmpegPreviewChunk>>(new Map());
  const ffmpegPreviewRenderJobRef = useRef<PreviewRenderJob | null>(null);
  const ffmpegPreviewStateRef = useRef<FfmpegPreviewState>({
    status: 'idle',
    progress: 0,
    startSec: 0,
    endSec: 0,
    durationSec: 0,
  });

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
  const requestedSeekTargetsRef = useRef<WeakMap<HTMLMediaElement, number>>(new WeakMap());
  const playbackVideoBlockedRef = useRef(false);
  const assetsRef = useRef(assets);
  const lastTickRef = useRef<number | null>(null);
  const prevHasVideoRef = useRef(false);
  const lastPaintedVisualRef = useRef<{ clipId: string; ts: number } | null>(null);
  const hasFreezeFrameRef = useRef(false);
  const lastRenderedPreviewFrameRef = useRef<string | null>(null);
  const lastRenderedPreviewClipKeyRef = useRef<string | null>(null);
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
  const [ffmpegPreview, setFfmpegPreview] = useState<FfmpegPreviewState>({
    status: 'idle',
    progress: 0,
    startSec: 0,
    endSec: 0,
    durationSec: 0,
  });
  const [ffmpegPreviewCacheVersion, setFfmpegPreviewCacheVersion] = useState(0);
  const aspectPreset = inferProjectAspectPreset(project.width, project.height);
  const resolutionPreset = inferProjectResolutionPreset(project.width, project.height, aspectPreset);
  const frameRatePreset = frameRateOptionForFps(project.fps);
  const previewAspectRatio = PROJECT_ASPECTS[aspectPreset];
  const ffmpegPreviewSignature = useMemo(() => previewRenderSignature(project, assets), [project, assets]);
  const ffmpegPreviewDuration = useMemo(() => visualPreviewDurationSec(project, assets), [project, assets]);
  const ffmpegPreviewWindows = useMemo(() => previewRenderWindows(ffmpegPreviewDuration), [ffmpegPreviewDuration]);
  const ffmpegPreviewBufferChunks = useMemo(() => ffmpegPreviewWindows.map((window) => {
    const signature = previewChunkSignature(project, assets, window.startSec, window.endSec);
    const chunk = ffmpegPreviewCacheRef.current.get(window.id);
    if (chunk?.signature === signature) return chunk;
    return {
      id: window.id,
      signature,
      status: 'idle' as const,
      progress: 0,
      startSec: window.startSec,
      endSec: window.endSec,
      durationSec: Math.max(0, window.endSec - window.startSec),
    };
  }), [assets, ffmpegPreviewCacheVersion, ffmpegPreviewWindows, project]);
  const ffmpegPreviewVisible = ffmpegPreview.status === 'ready'
    && !!ffmpegPreview.url
    && currentTime >= ffmpegPreview.startSec - 0.05
    && currentTime <= ffmpegPreview.endSec + 0.05;

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

  useEffect(() => {
    ffmpegPreviewStateRef.current = ffmpegPreview;
  }, [ffmpegPreview]);

  useEffect(() => {
    const bumpCacheVersion = () => setFfmpegPreviewCacheVersion((version) => version + 1);
    const cache = ffmpegPreviewCacheRef.current;
    const noVisualAtPlayhead = ffmpegPreviewDuration <= 0 || currentTime > ffmpegPreviewDuration + 0.05;

    let cacheChanged = false;
    for (const [chunkId, chunk] of [...cache.entries()]) {
      const currentSignature = previewChunkSignature(project, assets, chunk.startSec, chunk.endSec);
      const stillExists = ffmpegPreviewWindows.some((window) => window.id === chunkId);
      if (!stillExists || chunk.signature !== currentSignature) {
        if (chunk.url) URL.revokeObjectURL(chunk.url);
        cache.delete(chunkId);
        cacheChanged = true;
      }
    }
    if (cacheChanged) bumpCacheVersion();

    if (noVisualAtPlayhead) {
      setFfmpegPreview({
        status: 'idle',
        progress: 0,
        startSec: 0,
        endSec: 0,
        durationSec: 0,
        signature: ffmpegPreviewSignature,
      });
      return undefined;
    }

    const activeWindow = previewRenderWindowForTime(currentTime, ffmpegPreviewDuration);
    const activeChunkId = previewChunkId(activeWindow.startSec, activeWindow.endSec);
    const activeSignature = previewChunkSignature(project, assets, activeWindow.startSec, activeWindow.endSec);
    const activeChunk = cache.get(activeChunkId);
    const activeIsValid = activeChunk?.signature === activeSignature;
    setFfmpegPreview(activeIsValid ? activeChunk : {
      status: 'idle',
      progress: 0,
      startSec: activeWindow.startSec,
      endSec: activeWindow.endSec,
      durationSec: Math.max(0, activeWindow.endSec - activeWindow.startSec),
      signature: activeSignature,
    });

    const activeNeedsRender = !activeIsValid || (activeChunk.status !== 'ready' && activeChunk.status !== 'rendering');
    const currentRenderJob = ffmpegPreviewRenderJobRef.current;
    if (currentRenderJob) {
      if (!activeNeedsRender || currentRenderJob.id === activeChunkId) return undefined;
      currentRenderJob.abortController.abort();
      ffmpegPreviewRenderJobRef.current = null;
    }

    const activeWindowIndex = ffmpegPreviewWindows.findIndex((window) => window.id === activeChunkId);
    const orderedWindows = activeWindowIndex >= 0
      ? ffmpegPreviewWindows.slice(activeWindowIndex)
      : ffmpegPreviewWindows;
    const nextWindow = activeNeedsRender ? { ...activeWindow, id: activeChunkId } : orderedWindows.find((window) => {
      const signature = previewChunkSignature(project, assets, window.startSec, window.endSec);
      const chunk = cache.get(window.id);
      return chunk?.signature !== signature || (chunk.status !== 'ready' && chunk.status !== 'rendering');
    });
    if (!nextWindow) return undefined;

    const signature = previewChunkSignature(project, assets, nextWindow.startSec, nextWindow.endSec);
    const durationSec = Math.max(0, nextWindow.endSec - nextWindow.startSec);
    if (durationSec <= 0) return undefined;

    const abortController = new AbortController();
    const renderingChunk: FfmpegPreviewChunk = {
      id: nextWindow.id,
      status: 'rendering',
      progress: 0,
      startSec: nextWindow.startSec,
      endSec: nextWindow.endSec,
      durationSec,
      signature,
      message: 'Preparing preview...',
    };
    cache.set(nextWindow.id, renderingChunk);
    ffmpegPreviewRenderJobRef.current = { id: nextWindow.id, abortController };
    bumpCacheVersion();
    if (nextWindow.id === activeChunkId) setFfmpegPreview(renderingChunk);

    const projectSnapshot = cloneForPreviewRender(project);
    const assetsSnapshot = cloneForPreviewRender(assets);
    void renderProjectPreview(projectSnapshot, assetsSnapshot, {
      onStatus: (message) => {
        const chunk = cache.get(nextWindow.id);
        if (!chunk || chunk.signature !== signature || abortController.signal.aborted) return;
        cache.set(nextWindow.id, { ...chunk, message });
        bumpCacheVersion();
      },
      onProgress: (progress) => {
        const chunk = cache.get(nextWindow.id);
        if (!chunk || chunk.signature !== signature || abortController.signal.aborted) return;
        cache.set(nextWindow.id, { ...chunk, progress });
        bumpCacheVersion();
      },
    }, { startSec: nextWindow.startSec, endSec: nextWindow.endSec, signal: abortController.signal }).then((result) => {
      if (abortController.signal.aborted) return;
      const chunk = cache.get(nextWindow.id);
      if (!chunk || chunk.signature !== signature) return;
      if (chunk.url) URL.revokeObjectURL(chunk.url);
      const url = URL.createObjectURL(result.blob);
      cache.set(nextWindow.id, {
        ...chunk,
        status: 'ready',
        progress: 1,
        startSec: result.startSec,
        endSec: result.endSec,
        durationSec: result.durationSec,
        message: 'Preview ready',
        url,
        width: result.width,
        height: result.height,
      });
      if (ffmpegPreviewRenderJobRef.current?.id === nextWindow.id) ffmpegPreviewRenderJobRef.current = null;
      bumpCacheVersion();
    }).catch((error) => {
      if (abortController.signal.aborted) return;
      const chunk = cache.get(nextWindow.id);
      if (!chunk || chunk.signature !== signature) return;
      cache.set(nextWindow.id, {
        ...chunk,
        status: 'error',
        progress: 0,
        error: error instanceof Error ? error.message : String(error),
      });
      if (ffmpegPreviewRenderJobRef.current?.id === nextWindow.id) ffmpegPreviewRenderJobRef.current = null;
      bumpCacheVersion();
    });

    return undefined;
  }, [assets, currentTime, ffmpegPreviewCacheVersion, ffmpegPreviewDuration, ffmpegPreviewSignature, ffmpegPreviewWindows, project]);

  useEffect(() => () => {
    ffmpegPreviewRenderJobRef.current?.abortController.abort();
    ffmpegPreviewRenderJobRef.current = null;
    for (const chunk of ffmpegPreviewCacheRef.current.values()) {
      if (chunk.url) URL.revokeObjectURL(chunk.url);
    }
    ffmpegPreviewCacheRef.current.clear();
  }, []);

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
        existing.load();
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
    el.load();

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
        let url = urlCache.current.get(mediaKey);
        let ownsUrl = false;
        if (!url) {
          url = URL.createObjectURL(blob);
          ownsUrl = true;
          urlCache.current.set(mediaKey, url);
        }
        const latestClip = useProjectStore.getState().project.clips.find((candidate) => candidate.id === clip.id);
        const latestAsset = assetsRef.current.find((candidate) => candidate.id === asset.id);
        const latestTimeSec = usePlaybackStore.getState().currentTimeSec;
        if (
          !latestClip ||
          !latestAsset ||
          latestClip.assetId !== asset.id ||
          latestAsset.blobKey !== asset.blobKey ||
          !preparedClipsForTime(useProjectStore.getState().project, latestTimeSec).some((candidate) => candidate.id === latestClip.id)
        ) {
          if (ownsUrl && urlCache.current.get(mediaKey) === url) {
            URL.revokeObjectURL(url);
            urlCache.current.delete(mediaKey);
          }
          return;
        }
        attachClipElement(latestClip, latestAsset, url, mediaKey);
      });
    }

    return null;
  }, [attachClipElement]);

  const pruneMediaElements = useCallback((projectToPrune: Project, timeSec: number) => {
    const clipsById = new Map(projectToPrune.clips.map((clip) => [clip.id, clip]));
    const keepIds = new Set<string>();
    for (const clip of preparedClipsForTime(projectToPrune, timeSec)) keepIds.add(clip.id);
    const keepClip = (clipId: string) => {
      const clip = clipsById.get(clipId);
      if (!clip) return false;
      const selectedForPlayback = keepIds.has(clipId);
      const closeEnoughToFade = (fadingOut.current.has(clipId) || fadingIn.current.has(clipId))
        && clipIntersectsWindow(clip, timeSec - AUDIO_FADE_RETAIN_SEC, timeSec + AUDIO_FADE_RETAIN_SEC);
      return selectedForPlayback || closeEnoughToFade;
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
    const clipsToWarm = new Map<string, Clip>();
    for (const clip of preparedClipsForTime(project, timeSec)) clipsToWarm.set(clip.id, clip);
    for (const clip of clipsToWarm.values()) {
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
      const ffmpegPreviewSnapshot = ffmpegPreviewStateRef.current;
      const renderedPreviewActive = ffmpegPreviewSnapshot.status === 'ready'
        && !!ffmpegPreviewSnapshot.url
        && state.currentTimeSec >= ffmpegPreviewSnapshot.startSec - 0.05
        && state.currentTimeSec <= ffmpegPreviewSnapshot.endSec + 0.05;
      const mediaPlaybackBlocked = state.playing && !renderedPreviewActive && playbackVideoBlockedRef.current;
      const mediaPlaying = state.playing && !mediaPlaybackBlocked;

      if (state.playing) {
        resumeAudioContext();
        const dt = (ts - (lastTickRef.current ?? ts)) / 1000;
        if (!mediaPlaybackBlocked) {
          const next = Math.min(total, state.currentTimeSec + dt);
          state.setCurrentTime(next);
          if (total > 0 && next >= total) pause();
        }
      }
      lastTickRef.current = ts;

      // Apply master volume to the master GainNode each frame.
      const masterVol = state.masterVolume;
      const masterGain = getMasterGain();
      if (Math.abs(masterGain.gain.value - masterVol) > 0.001) {
        masterGain.gain.setTargetAtTime(masterVol, getAudioContext().currentTime, 0.01);
      }

      const t = usePlaybackStore.getState().currentTimeSec;
      syncRenderedPreviewVideo(
        ffmpegPreviewVideoRef.current,
        t,
        mediaPlaying,
        renderedPreviewActive,
        ffmpegPreviewSnapshot.startSec,
        ffmpegPreviewSnapshot.durationSec,
      );
      const previewFps = safeProjectFps(proj);
      const visualTime = state.playing ? projectFrameTime(t, previewFps) : t;
      const visualFrameIndex = projectFrameIndex(t, previewFps);
      const audioFrame = resolveFrame(proj, t);
      const visualFrame = resolveFrame(proj, visualTime);
      const assetsById = new Map(assetsRef.current.map((asset) => [asset.id, asset]));
      const preparedClips = preparedClipsForTime(proj, t);
      const neededClipIds = new Set<string>();
      for (const layer of [...visualFrame.videos, ...audioFrame.audios]) {
        if (neededClipIds.has(layer.clip.id)) continue;
        neededClipIds.add(layer.clip.id);
        const asset = assetsById.get(layer.clip.assetId);
        if (asset) ensureClipElement(layer.clip, asset);
      }
      for (const clip of preparedClips) {
        if (neededClipIds.has(clip.id)) continue;
        neededClipIds.add(clip.id);
        const asset = assetsById.get(clip.assetId);
        if (asset) ensureClipElement(clip, asset);
      }

      // ---- VIDEO DISPLAY ----
      const visualLayers = visualFrame.videos;
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
        const tolerance = videoSyncWindow(layer.clip, previewFps, mediaPlaying);
        seekIfNeeded(videoEl, layer.sourceTimeSec, mediaPlaying, tolerance, requestedSeekTargetsRef.current);
        const canPaint = canPaintSyncedVideo(
          videoEl,
          layer.clip,
          layer.sourceTimeSec,
          tolerance,
        );
        const canKeepSameClipVisible = lastPaintedVisualRef.current?.clipId === layer.clip.id
          && videoEl.readyState >= 1
          && videoEl.videoWidth > 0
          && videoEl.videoHeight > 0
          && videoEl.currentTime >= Math.max(0, layer.clip.inSec - 0.015)
          && videoEl.currentTime <= layer.clip.outSec + 0.05
          && !outsideSyncWindow(videoEl.currentTime, layer.sourceTimeSec, tolerance);
        if (canPaint || canKeepSameClipVisible) {
          paintableVisualClipIds.add(layer.clip.id);
        }
      }
      const topPaintableLayer = visualLayers.find((layer) => paintableVisualClipIds.has(layer.clip.id)) ?? null;
      const topVisualLayer = visualLayers[0] ?? null;
      const topVisualAsset = topVisualLayer ? activeVisualAssetsByClipId.get(topVisualLayer.clip.id) : null;
      playbackVideoBlockedRef.current = Boolean(
        topVisualLayer && topVisualAsset?.kind === 'video' && !paintableVisualClipIds.has(topVisualLayer.clip.id),
      );
      const previewClipKey = visualLayers.map((layer) => layer.clip.id).join('|');
      const previewFrameKey = `${previewFps}:${visualFrameIndex}:${previewClipKey}`;
      if (visualLayers.length > 0 && (state.playing || topPaintableLayer)) {
        if (previewFrameKey !== lastRenderedPreviewFrameRef.current) {
          const rendered = renderPreviewCanvas(
            freezeFrameCanvasRef.current,
            visualLayers,
            assetsById,
            proj,
            visualTime,
            previewFps,
            mediaPlaying,
            videoPool.current,
            imagePool.current,
          );
          if (rendered) {
            hasFreezeFrameRef.current = true;
            lastRenderedPreviewFrameRef.current = previewFrameKey;
            lastRenderedPreviewClipKeyRef.current = previewClipKey;
          }
        }
      } else {
        lastRenderedPreviewFrameRef.current = null;
        lastRenderedPreviewClipKeyRef.current = null;
      }
      if (topPaintableLayer) {
        lastPaintedVisualRef.current = { clipId: topPaintableLayer.clip.id, ts };
      }
      const hasCurrentFreezeFrame = hasFreezeFrameRef.current && lastRenderedPreviewFrameRef.current === previewFrameKey;
      const hasSameClipFreezeFrame = hasFreezeFrameRef.current && lastRenderedPreviewClipKeyRef.current === previewClipKey;
      const showFreezeFrame = visualLayers.length > 0 && (state.playing
        ? hasCurrentFreezeFrame || (!topPaintableLayer && hasSameClipFreezeFrame)
        : !topPaintableLayer && (hasCurrentFreezeFrame || hasSameClipFreezeFrame));
      if (freezeFrameCanvasRef.current) {
        freezeFrameCanvasRef.current.style.display = showFreezeFrame ? 'block' : 'none';
      }
      for (const [clipId, el] of videoPool.current) {
        const videoEl = el as HTMLVideoElement;
        const activeLayer = activeVisualLayersByClipId.get(clipId);
        const activeAsset = activeVisualAssetsByClipId.get(clipId);
        if (activeLayer && activeAsset?.kind === 'video') {
          videoEl.style.display = '';
          videoEl.style.visibility = paintableVisualClipIds.has(clipId)
            ? 'visible'
            : 'hidden';
          videoEl.style.zIndex = String(visualZIndexByClipId.get(clipId) ?? 1);
          applyVisualLayout(videoEl, activeAsset, activeLayer.clip, proj, visualTime, videoHostRef.current);
        } else {
          hideVideoElement(videoEl);
        }
      }
      for (const [clipId, img] of imagePool.current) {
        const activeLayer = activeVisualLayersByClipId.get(clipId);
        const activeAsset = activeVisualAssetsByClipId.get(clipId);
        if (activeLayer && activeAsset?.kind === 'image') {
          img.style.display = '';
          img.style.visibility = 'visible';
          img.style.zIndex = String(visualZIndexByClipId.get(clipId) ?? 1);
          applyVisualLayout(img, activeAsset, activeLayer.clip, proj, visualTime, videoHostRef.current);
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
      for (const layer of audioFrame.audios) activeAudioIds.add(layer.clip.id);

      // Preroll: seek upcoming clips so their decoder buffer is warm.
      const hotPrimedIds = new Set<string>();
      const preparedClipIds = new Set(preparedClips.map((clip) => clip.id));
      for (const clip of preparedClips) {
        const el = videoPool.current.get(clip.id) ?? audioPool.current.get(clip.id);
        if (!el) continue;
        const timeUntilActive = clip.startSec - t;
        if (timeUntilActive < 0) continue;

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
        if (mediaPlaying && timeUntilActive <= HOT_PRIMING_SEC && timeUntilActive >= 0) {
          const alignedStart = clip.inSec - timeUntilActive;
          if (alignedStart < 0) {
            if (!hotPrimedSeekRef.current.has(clip.id) && el.readyState >= 1 && !el.seeking) {
              if (Math.abs(el.currentTime - clip.inSec) > 0.05) {
                try { el.currentTime = clip.inSec; } catch { /* noop */ }
              }
              hotPrimedSeekRef.current.add(clip.id);
            }
            continue;
          }

          hotPrimedIds.add(clip.id);
          setPitchPreservingRate(el, clipSpeed(clip));
          const gn = gainNodes.current.get(clip.id);
          if (gn) gn.gain.value = 0;
          if (videoPool.current.has(clip.id)) {
            (el as HTMLVideoElement).muted = false;
          }

          if (!hotPrimedSeekRef.current.has(clip.id)) {
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
        if (!c || !preparedClipIds.has(id) || t > c.startSec) {
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
      for (const layer of audioFrame.audios) {
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

        if (!mediaPlaying && !el.paused) el.pause();
        seekIfNeeded(el, layer.sourceTimeSec, mediaPlaying, undefined, requestedSeekTargetsRef.current);
        if (mediaPlaying && el.paused) el.play().catch(() => undefined);
      }

      pruneMediaElements(proj, t);

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
          <canvas
            ref={freezeFrameCanvasRef}
            className="pointer-events-none absolute inset-0 z-20 hidden h-full w-full"
            aria-hidden
          />
          <div ref={videoHostRef} className="absolute inset-0 z-10" />
          {ffmpegPreview.url && (
            <video
              ref={ffmpegPreviewVideoRef}
              className={`pointer-events-none absolute inset-0 z-30 h-full w-full object-contain ${
                ffmpegPreviewVisible ? 'block' : 'hidden'
              }`}
              src={ffmpegPreview.url}
              muted
              playsInline
              preload="auto"
              aria-hidden
            />
          )}
          {ffmpegPreviewDuration > 0 && (
            <div className="pointer-events-none absolute bottom-2 left-2 right-2 z-40 rounded border border-surface-700 bg-surface-950/85 px-2 py-1 shadow-lg">
              <div className="mb-1 flex h-3 items-center gap-1 text-[10px] text-slate-300">
                {ffmpegPreviewBufferChunks.some((chunk) => chunk.status === 'rendering') && (
                  <Loader2 size={11} className="animate-spin text-brand-300" />
                )}
                <span className="font-mono tabular-nums">
                  {ffmpegPreviewBufferChunks.filter((chunk) => chunk.status === 'ready').length}/{ffmpegPreviewBufferChunks.length}
                </span>
              </div>
              <svg
                className="block h-2 w-full overflow-hidden rounded bg-surface-800"
                viewBox={`0 0 ${Math.max(1, ffmpegPreviewDuration)} 1`}
                preserveAspectRatio="none"
                aria-hidden
              >
                <rect x="0" y="0" width={Math.max(1, ffmpegPreviewDuration)} height="1" className="fill-surface-700" />
                {ffmpegPreviewBufferChunks.map((chunk) => (
                  <rect
                    key={`${chunk.id}-base`}
                    x={chunk.startSec}
                    y="0"
                    width={Math.max(0, chunk.endSec - chunk.startSec)}
                    height="1"
                    className={chunk.status === 'ready'
                      ? 'fill-brand-500'
                      : chunk.status === 'error'
                        ? 'fill-red-500'
                        : 'fill-surface-600'}
                  />
                ))}
                {ffmpegPreviewBufferChunks.filter((chunk) => chunk.status === 'rendering').map((chunk) => (
                  <rect
                    key={`${chunk.id}-progress`}
                    x={chunk.startSec}
                    y="0"
                    width={Math.max(0, (chunk.endSec - chunk.startSec) * chunk.progress)}
                    height="1"
                    className="fill-amber-400"
                  />
                ))}
                <rect
                  x={Math.max(0, Math.min(ffmpegPreviewDuration, currentTime))}
                  y="0"
                  width={Math.max(0.035, ffmpegPreviewDuration / 600)}
                  height="1"
                  className="fill-white"
                />
              </svg>
            </div>
          )}
          {ffmpegPreview.status === 'error' && !ffmpegPreviewBufferChunks.some((chunk) => chunk.status === 'error') && (
            <div
              className="pointer-events-none absolute bottom-2 left-2 z-40 rounded border border-red-500/40 bg-red-500/10 px-2 py-1 text-[11px] text-red-200"
              title={ffmpegPreview.error}
            >
              Preview render failed
            </div>
          )}
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
