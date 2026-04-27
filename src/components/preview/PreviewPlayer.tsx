import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { AlertTriangle, ImagePlus } from 'lucide-react';
import { useMediaStore } from '@/state/mediaStore';
import { usePlaybackStore } from '@/state/playbackStore';
import { useProjectStore } from '@/state/projectStore';
import { resolveFrame, type ActiveLayer } from '@/lib/playback/engine';
import type { Clip, MediaAsset, Project } from '@/types';
import { clipOpacityAtTimelineTime, clipSpeed, clipTimelineDurationSec, projectDurationSec } from '@/lib/timeline/operations';
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
  const timelineTimeSec = layer.clip.startSec + ((layer.sourceTimeSec - layer.clip.inSec) / clipSpeed(layer.clip));
  return master * evalEnvelopeAt(layer.clip.volumeEnvelope, localT) * clipOpacityAtTimelineTime(layer.clip, timelineTimeSec);
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

type PreviewDebugCanvasSample = {
  width: number;
  height: number;
  pixels: number[];
};

type PreviewDebugMediaSample = {
  clipId: string;
  currentTime: number;
  duration: number;
  paused: boolean;
  readyState: number;
  seeking: boolean;
  playbackRate: number;
};

type PreviewDebugFrameSample = {
  now: number;
  currentTimeSec: number;
  playing: boolean;
  canvas: PreviewDebugCanvasSample | null;
  videos: PreviewDebugMediaSample[];
  audios: PreviewDebugMediaSample[];
};

type PreviewDebugBridge = {
  play: () => void;
  pause: () => void;
  setCurrentTime: (timeSec: number) => void;
  sampleFrame: () => PreviewDebugFrameSample;
};

type PreviewPerformanceWarning = {
  repeatedPct: number;
  troublePct: number;
  samples: number;
};

type PreviewPerformanceFrame = {
  key: string;
  pixels: Uint8Array;
};

type PreviewPerformanceSample = {
  ts: number;
  repeated: boolean;
  troubled: boolean;
};

declare global {
  interface Window {
    __GENEDIT_PREVIEW_DEBUG__?: PreviewDebugBridge;
  }
}

const FADE_OUT_MS = 80;
const FADE_IN_MS = 40;
const PREPARE_BACKWARD_SEC = 5.0;
const PREPARE_FORWARD_SEC = 5.0;
const HOT_PRIMING_SEC = 0.3;
const VISUAL_PREROLL_SEC = 1.25;
const AUDIO_FADE_RETAIN_SEC = 0.25;
const MAX_PREPARED_CLIPS = 48;
const RECENT_MEDIA_RETAIN_MS = 30_000;
const MAX_RECENT_MEDIA_RETAINED = 24;
const STARTUP_AUDIO_SYNC_GRACE_MS = 180;
const STARTUP_AUDIO_SEEK_TOLERANCE_SEC = 0.08;
const STARTUP_DECODER_SYNC_TIMEOUT_MS = 1000;
const PERFORMANCE_SAMPLE_WIDTH = 32;
const PERFORMANCE_SAMPLE_HEIGHT = 18;
const PERFORMANCE_WINDOW_MS = 2500;
const PERFORMANCE_MIN_SAMPLES = 30;
const PERFORMANCE_REPEATED_DIFF_THRESHOLD = 0.75;
const PERFORMANCE_REPEATED_WARNING_RATIO = 0.78;
const PERFORMANCE_EXTREME_REPEATED_WARNING_RATIO = 0.9;
const PERFORMANCE_TROUBLE_WARNING_RATIO = 0.15;
const PERFORMANCE_WARNING_PUBLISH_MS = 350;

function clipEndSec(clip: Clip): number {
  return clip.startSec + clipTimelineDurationSec(clip);
}

function previewTopologySignature(project: Project): string {
  const tracks = [...project.tracks]
    .sort((first, second) => first.index - second.index)
    .map((track) => [track.id, track.kind, track.index, track.hidden ? 1 : 0, track.muted ? 1 : 0].join(':'))
    .join(',');
  const clips = [...project.clips]
    .sort((first, second) => first.id.localeCompare(second.id))
    .map((clip) => [
      clip.id,
      clip.assetId,
      clip.trackId,
      clip.startSec.toFixed(6),
      clip.inSec.toFixed(6),
      clip.outSec.toFixed(6),
      (clip.speed ?? 1).toFixed(6),
    ].join(':'))
    .join(',');
  return `${tracks}|${clips}`;
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

function safeProjectFps(project: Pick<Project, 'fps'>): number {
  return Number.isFinite(project.fps) && project.fps > 0 ? project.fps : 30;
}

function projectFrameIndex(timeSec: number, fps: number): number {
  return Math.max(0, Math.floor(Math.max(0, timeSec) * fps + 1e-6));
}

function projectFrameTime(timeSec: number, fps: number): number {
  return projectFrameIndex(timeSec, fps) / fps;
}

function layerVisualTimelineTime(layer: ActiveLayer, timelineTimeSec: number, fps: number, playing: boolean): number {
  if (!playing) return timelineTimeSec;
  const localTimeSec = Math.max(0, timelineTimeSec - layer.clip.startSec);
  return layer.clip.startSec + projectFrameTime(localTimeSec, fps);
}

function layerSourceTimeAt(layer: ActiveLayer, timelineTimeSec: number): number {
  const durationSec = clipTimelineDurationSec(layer.clip);
  const localTimeSec = Math.max(0, Math.min(durationSec, timelineTimeSec - layer.clip.startSec));
  return layer.clip.inSec + localTimeSec * clipSpeed(layer.clip);
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
    beforeSec: Math.min(0.28, Math.max(0.12, sourceFrameSec * 4)),
    afterSec: Math.min(0.18, Math.max(0.08, sourceFrameSec * 3)),
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
    if (!el.seeking) requestedSeekTargets?.delete(el);
    return false;
  }
  if (el.seeking) return false;
  const lastRequestedTarget = requestedSeekTargets?.get(el);
  const hasRequestedTarget = lastRequestedTarget !== undefined && Math.abs(lastRequestedTarget - target) <= 0.002;
  const canRetargetPausedSeek = !playing && !hasRequestedTarget;
  const canRetargetPlayingSeek = playing && (
    lastRequestedTarget === undefined || Math.abs(lastRequestedTarget - target) > 0.2
  );
  if ((lastRequestedTarget === undefined || canRetargetPausedSeek || canRetargetPlayingSeek) && el.readyState >= 1) {
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
  if (el.readyState < 2 || el.videoWidth <= 0 || el.videoHeight <= 0) return false;
  if (el.currentTime < Math.max(0, clip.inSec - 0.015)) return false;
  if (el.currentTime > clip.outSec + 0.05) return false;
  return !outsideSyncWindow(el.currentTime, target, tolerance);
}

function mediaElementReadyForSourceTime(el: HTMLMediaElement, target: number, toleranceSec: number): boolean {
  if (el.readyState < 2 || el.seeking) return false;
  return Math.abs(el.currentTime - target) <= toleranceSec;
}

function sampledFrameDiff(previous: Uint8Array, next: Uint8Array): number {
  const count = Math.min(previous.length, next.length);
  if (count === 0) return 0;
  let total = 0;
  for (let index = 0; index < count; index += 1) total += Math.abs(previous[index]! - next[index]!);
  return total / count;
}

function activeVideoPlaybackTroubled(
  visualLayers: ActiveLayer[],
  assetsById: Map<string, MediaAsset>,
  videoPool: ElementPool,
  timelineTimeSec: number,
  previewFps: number,
): boolean {
  for (const layer of visualLayers) {
    const asset = assetsById.get(layer.clip.assetId);
    if (asset?.kind !== 'video') continue;
    const video = videoPool.get(layer.clip.id) as HTMLVideoElement | undefined;
    if (!video) return true;
    const layerTimelineTimeSec = layerVisualTimelineTime(layer, timelineTimeSec, previewFps, true);
    const layerSourceTimeSec = layerSourceTimeAt(layer, layerTimelineTimeSec);
    if (video.seeking || video.readyState < 3) return true;
    if (Math.abs(video.currentTime - layerSourceTimeSec) > 0.22) return true;
  }
  return false;
}

function sampleCanvas(canvas: HTMLCanvasElement | null): PreviewDebugCanvasSample | null {
  if (!canvas || canvas.width <= 0 || canvas.height <= 0) return null;
  const width = 64;
  const height = 36;
  const sample = document.createElement('canvas');
  sample.width = width;
  sample.height = height;
  const ctx = sample.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(canvas, 0, 0, width, height);
  const data = ctx.getImageData(0, 0, width, height).data;
  const pixels: number[] = [];
  for (let index = 0; index < data.length; index += 4) {
    pixels.push(Math.round((data[index]! + data[index + 1]! + data[index + 2]!) / 3));
  }
  return { width, height, pixels };
}

function sampleMediaPool(pool: ElementPool): PreviewDebugMediaSample[] {
  return [...pool.entries()].map(([clipId, el]) => ({
    clipId,
    currentTime: el.currentTime,
    duration: Number.isFinite(el.duration) ? el.duration : 0,
    paused: el.paused,
    readyState: el.readyState,
    seeking: el.seeking,
    playbackRate: el.playbackRate,
  }));
}

function activeMediaReadyForStartup(
  visualLayers: ActiveLayer[],
  audioLayers: ActiveLayer[],
  assetsById: Map<string, MediaAsset>,
  timelineTimeSec: number,
  previewFps: number,
  videoPool: ElementPool,
  imagePool: ImagePool,
  audioPool: ElementPool,
  requireAudio: boolean,
): boolean {
  for (const layer of visualLayers) {
    const asset = assetsById.get(layer.clip.assetId);
    if (asset?.kind === 'image') {
      const image = imagePool.get(layer.clip.id);
      if (!image?.complete) return false;
      continue;
    }
    if (asset?.kind !== 'video') continue;
    const video = videoPool.get(layer.clip.id) as HTMLVideoElement | undefined;
    if (!video || video.seeking) return false;
    const layerTimelineTimeSec = layerVisualTimelineTime(layer, timelineTimeSec, previewFps, false);
    const layerSourceTimeSec = layerSourceTimeAt(layer, layerTimelineTimeSec);
    if (!canPaintSyncedVideo(video, layer.clip, layerSourceTimeSec, videoSyncWindow(layer.clip, previewFps, false))) {
      return false;
    }
  }

  if (!requireAudio) return true;

  for (const layer of audioLayers) {
    const asset = assetsById.get(layer.clip.assetId);
    if (asset?.kind !== 'video' && asset?.kind !== 'audio') continue;
    const el = audioPool.get(layer.clip.id) ?? (asset.kind === 'video' ? videoPool.get(layer.clip.id) : undefined);
    if (!el || !mediaElementReadyForSourceTime(el, layer.sourceTimeSec, STARTUP_AUDIO_SEEK_TOLERANCE_SEC)) return false;
  }

  return true;
}

function hideVideoElement(el: HTMLVideoElement) {
  el.style.display = 'none';
  el.style.visibility = 'hidden';
  el.style.transform = '';
  el.style.filter = '';
  el.style.opacity = '';
  el.style.cursor = 'default';
  el.style.zIndex = '';
}

function keepVideoDecoderElementWarm(el: HTMLVideoElement) {
  el.style.display = 'block';
  el.style.visibility = 'visible';
  el.style.left = '0';
  el.style.top = '0';
  el.style.width = '1px';
  el.style.height = '1px';
  el.style.transform = '';
  el.style.filter = '';
  el.style.opacity = '1';
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

function canvasFilterForClip(clip: Clip, timelineTimeSec: number): string {
  return colorCorrectionCssFilter(clip, timelineTimeSec)
    .replace(/url\([^)]*\)\s*/g, '')
    .trim() || 'none';
}

type PreviewCanvasRenderOptions = {
  colorCorrection?: boolean;
};

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
  options: PreviewCanvasRenderOptions = {},
): boolean {
  if (!canvas || project.width <= 0 || project.height <= 0) return false;
  const drawItems: Array<{
    source: HTMLVideoElement | HTMLImageElement;
    asset: MediaAsset;
    clip: Clip;
    timelineTimeSec: number;
  }> = [];

  for (const layer of [...visualLayers].reverse()) {
    const asset = assetsById.get(layer.clip.assetId);
    if (asset?.kind !== 'video' && asset?.kind !== 'image') continue;
    const source = asset.kind === 'image'
      ? imagePool.get(layer.clip.id)
      : videoPool.get(layer.clip.id) as HTMLVideoElement | undefined;
    if (!source) continue;
    const layerTimelineTimeSec = layerVisualTimelineTime(layer, timelineTimeSec, previewFps, playing);
    const layerSourceTimeSec = layerSourceTimeAt(layer, layerTimelineTimeSec);
    if (source instanceof HTMLVideoElement) {
      const tolerance = videoSyncWindow(layer.clip, previewFps, playing);
      if (!canPaintSyncedVideo(source, layer.clip, layerSourceTimeSec, tolerance)) continue;
    }
    if (source instanceof HTMLImageElement && !source.complete) continue;
    if (clipOpacityAtTimelineTime(layer.clip, layerTimelineTimeSec) <= 0.001) continue;
    drawItems.push({ source, asset, clip: layer.clip, timelineTimeSec: layerTimelineTimeSec });
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
    const applyColorCorrection = options.colorCorrection !== false;
    for (const { source, asset, clip, timelineTimeSec: layerTimelineTimeSec } of drawItems) {
      const tf = resolvedTransform(clip, layerTimelineTimeSec);
      const mediaTransform = activeEditTransform(asset);
      const sourceWidth = source instanceof HTMLVideoElement ? source.videoWidth : source.naturalWidth;
      const sourceHeight = source instanceof HTMLVideoElement ? source.videoHeight : source.naturalHeight;
      const mediaWidth = Math.max(1, asset.width ?? sourceWidth ?? project.width);
      const mediaHeight = Math.max(1, asset.height ?? sourceHeight ?? project.height);
      const x = project.width / 2 + (tf.offsetX + mediaTransform.offsetX);
      const y = project.height / 2 + (tf.offsetY + mediaTransform.offsetY);
      const visualScale = Math.max(0.1, Math.min(6, (tf.scale ?? clip.scale ?? 1) * mediaTransform.scale));
      ctx.save();
      try {
        ctx.filter = applyColorCorrection ? canvasFilterForClip(clip, layerTimelineTimeSec) : 'none';
        ctx.globalAlpha = clipOpacityAtTimelineTime(clip, layerTimelineTimeSec);
        ctx.translate(x, y);
        ctx.scale(visualScale, visualScale);
        ctx.drawImage(source, -mediaWidth / 2, -mediaHeight / 2, mediaWidth, mediaHeight);
      } finally {
        ctx.restore();
      }
    }
    return true;
  } catch {
    return false;
  } finally {
    ctx.filter = 'none';
  }
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

function timecodeForFilename(timeSec: number, fps: number): string {
  const safeFps = Math.max(1, fps);
  const totalFrames = Math.max(0, Math.floor(timeSec * safeFps + 1e-6));
  const frames = totalFrames % Math.round(safeFps);
  const totalSeconds = Math.floor(totalFrames / safeFps);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  return [hours, minutes, seconds, frames]
    .map((part) => String(part).padStart(2, '0'))
    .join('-');
}

function safeFrameAssetName(projectName: string, timeSec: number, fps: number): string {
  const safeProjectName = projectName.trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').slice(0, 48) || 'GenEdit';
  return `${safeProjectName} frame ${timecodeForFilename(timeSec, fps)}.png`;
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
  const clipMediaTouchedAtRef = useRef<Map<string, number>>(new Map());
  const requestedSeekTargetsRef = useRef<WeakMap<HTMLMediaElement, number>>(new WeakMap());
  const assetsRef = useRef(assets);
  const lastTickRef = useRef<number | null>(null);
  const lastTimelineTimeRef = useRef<number | null>(null);
  const playbackClockTimeRef = useRef<number | null>(null);
  const previewTopologySignatureRef = useRef('');
  const lastPlayingStateRef = useRef(false);
  const prevHasVideoRef = useRef(false);
  const needsDecoderSyncOnPlayRef = useRef(false);
  const startupDecoderSyncStartedAtRef = useRef<number | null>(null);
  const lastPlayingCanvasFrameKeyRef = useRef<string | null>(null);
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
  const performanceSampleCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const performanceSampleContextRef = useRef<CanvasRenderingContext2D | null>(null);
  const lastPerformanceFrameRef = useRef<PreviewPerformanceFrame | null>(null);
  const performanceSamplesRef = useRef<PreviewPerformanceSample[]>([]);
  const lastPerformanceWarningPublishRef = useRef(0);

  // Smooth transitions: track which clips are fading out/in to avoid pops.
  const fadingOut = useRef<Map<string, { startTs: number; fromGain: number }>>(new Map());
  const fadingIn = useRef<Map<string, { startTs: number; targetGain: number }>>(new Map());
  const prevActiveAudioIds = useRef<Set<string>>(new Set());

  const [hasActiveVideo, setHasActiveVideo] = useState(false);
  const [ready, setReady] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [previewFrameSize, setPreviewFrameSize] = useState<{ width: number; height: number } | null>(null);
  const [previewContextMenu, setPreviewContextMenu] = useState<{ x: number; y: number; canSaveFrame: boolean } | null>(null);
  const [previewPerformanceWarning, setPreviewPerformanceWarning] = useState<PreviewPerformanceWarning | null>(null);
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
    setCurrentTime(usePlaybackStore.getState().currentTimeSec);
  };

  useEffect(() => {
    assetsRef.current = assets;
  }, [assets]);

  const resetTransientPlaybackState = useCallback(() => {
    requestedSeekTargetsRef.current = new WeakMap();
    needsDecoderSyncOnPlayRef.current = false;
    startupDecoderSyncStartedAtRef.current = null;
    lastPlayingCanvasFrameKeyRef.current = null;
    prerolledRef.current.clear();
    hotPrimedSeekRef.current.clear();
    fadingOut.current.clear();
    fadingIn.current.clear();
    prevActiveAudioIds.current.clear();
    lastPerformanceFrameRef.current = null;
    performanceSamplesRef.current = [];
    setPreviewPerformanceWarning(null);
  }, []);

  const samplePreviewPerformanceFrame = useCallback((): Uint8Array | null => {
    const source = freezeFrameCanvasRef.current;
    if (!source || source.width <= 0 || source.height <= 0) return null;
    let canvas = performanceSampleCanvasRef.current;
    let ctx = performanceSampleContextRef.current;
    if (!canvas || !ctx) {
      canvas = document.createElement('canvas');
      canvas.width = PERFORMANCE_SAMPLE_WIDTH;
      canvas.height = PERFORMANCE_SAMPLE_HEIGHT;
      ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return null;
      performanceSampleCanvasRef.current = canvas;
      performanceSampleContextRef.current = ctx;
    }
    ctx.drawImage(source, 0, 0, PERFORMANCE_SAMPLE_WIDTH, PERFORMANCE_SAMPLE_HEIGHT);
    const data = ctx.getImageData(0, 0, PERFORMANCE_SAMPLE_WIDTH, PERFORMANCE_SAMPLE_HEIGHT).data;
    const pixels = new Uint8Array(PERFORMANCE_SAMPLE_WIDTH * PERFORMANCE_SAMPLE_HEIGHT);
    for (let index = 0, pixelIndex = 0; index < data.length; index += 4, pixelIndex += 1) {
      pixels[pixelIndex] = Math.round((data[index]! + data[index + 1]! + data[index + 2]!) / 3);
    }
    return pixels;
  }, []);

  const resetPreviewPerformanceMonitor = useCallback(() => {
    lastPerformanceFrameRef.current = null;
    performanceSamplesRef.current = [];
    if (previewPerformanceWarning) setPreviewPerformanceWarning(null);
  }, [previewPerformanceWarning]);

  const updatePreviewPerformanceMonitor = useCallback((params: {
    ts: number;
    frameKey: string;
    mediaPlaying: boolean;
    visualLayers: ActiveLayer[];
    assetsById: Map<string, MediaAsset>;
    timelineTimeSec: number;
    previewFps: number;
  }) => {
    const hasActiveVideoLayer = params.visualLayers.some((layer) => params.assetsById.get(layer.clip.assetId)?.kind === 'video');
    if (!params.mediaPlaying || !hasActiveVideoLayer || !params.frameKey) {
      resetPreviewPerformanceMonitor();
      return;
    }

    if (lastPerformanceFrameRef.current?.key === params.frameKey) return;
    const pixels = samplePreviewPerformanceFrame();
    if (!pixels) return;

    const previous = lastPerformanceFrameRef.current;
    lastPerformanceFrameRef.current = { key: params.frameKey, pixels };
    if (!previous) return;

    const repeated = sampledFrameDiff(previous.pixels, pixels) < PERFORMANCE_REPEATED_DIFF_THRESHOLD;
    const troubled = activeVideoPlaybackTroubled(
      params.visualLayers,
      params.assetsById,
      videoPool.current,
      params.timelineTimeSec,
      params.previewFps,
    );
    const samples = performanceSamplesRef.current;
    samples.push({ ts: params.ts, repeated, troubled });
    while (samples.length > 0 && params.ts - samples[0]!.ts > PERFORMANCE_WINDOW_MS) samples.shift();

    if (params.ts - lastPerformanceWarningPublishRef.current < PERFORMANCE_WARNING_PUBLISH_MS) return;
    lastPerformanceWarningPublishRef.current = params.ts;
    if (samples.length < PERFORMANCE_MIN_SAMPLES) {
      if (previewPerformanceWarning) setPreviewPerformanceWarning(null);
      return;
    }

    const repeatedCount = samples.filter((sample) => sample.repeated).length;
    const troubleCount = samples.filter((sample) => sample.troubled).length;
    const repeatedPct = repeatedCount / samples.length;
    const troublePct = troubleCount / samples.length;
    const shouldWarn = repeatedPct >= PERFORMANCE_REPEATED_WARNING_RATIO
      && (troublePct >= PERFORMANCE_TROUBLE_WARNING_RATIO || repeatedPct >= PERFORMANCE_EXTREME_REPEATED_WARNING_RATIO);
    setPreviewPerformanceWarning(shouldWarn ? { repeatedPct, troublePct, samples: samples.length } : null);
  }, [previewPerformanceWarning, resetPreviewPerformanceMonitor, samplePreviewPerformanceFrame]);

  useEffect(() => {
    const nextSignature = previewTopologySignature(project);
    if (previewTopologySignatureRef.current && previewTopologySignatureRef.current !== nextSignature) {
      resetTransientPlaybackState();
      lastTimelineTimeRef.current = null;
      playbackClockTimeRef.current = usePlaybackStore.getState().currentTimeSec;
    }
    previewTopologySignatureRef.current = nextSignature;
  }, [project, resetTransientPlaybackState]);

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

  const saveCurrentVideoFrame = useCallback(async () => {
    const latestProject = useProjectStore.getState().project;
    const latestPlayback = usePlaybackStore.getState();
    const timelineTimeSec = latestPlayback.currentTimeSec;
    const previewFps = safeProjectFps(latestProject);
    const visualFrame = resolveFrame(latestProject, timelineTimeSec);
    if (visualFrame.videos.length === 0) return;

    const assetsById = new Map(assetsRef.current.map((asset) => [asset.id, asset]));
    const canvas = document.createElement('canvas');
    const rendered = renderPreviewCanvas(
      canvas,
      visualFrame.videos,
      assetsById,
      latestProject,
      timelineTimeSec,
      previewFps,
      latestPlayback.playing,
      videoPool.current,
      imagePool.current,
      { colorCorrection: false },
    );
    if (!rendered) return;

    const blob = await canvasToBlob(canvas);
    if (!blob) return;
    const filename = safeFrameAssetName(latestProject.name, timelineTimeSec, previewFps);
    const file = new File([blob], filename, { type: blob.type || 'image/png' });
    await useMediaStore.getState().importFiles([file]);
  }, []);

  const handlePreviewContextMenu = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const latestProject = useProjectStore.getState().project;
    const timelineTimeSec = usePlaybackStore.getState().currentTimeSec;
    const canSaveFrame = resolveFrame(latestProject, timelineTimeSec).videos.length > 0;
    setPreviewContextMenu({ x: event.clientX, y: event.clientY, canSaveFrame });
  }, []);

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
    clipMediaTouchedAtRef.current.delete(clipId);
  }, []);

  const removeAudioElement = useCallback((clipId: string) => {
    const el = audioPool.current.get(clipId);
    if (el) {
      el.pause();
      audioPool.current.delete(clipId);
    }
    clipAssetRef.current.delete(clipId);
    clipMediaTouchedAtRef.current.delete(clipId);
    releaseAudioGraph(clipId);
  }, [releaseAudioGraph]);

  const removeImageElement = useCallback((clipId: string) => {
    imagePool.current.get(clipId)?.remove();
    imagePool.current.delete(clipId);
    clipAssetRef.current.delete(clipId);
    clipMediaTouchedAtRef.current.delete(clipId);
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
    if (asset.kind === 'video') {
      let visualVideo = videoPool.current.get(clip.id) as HTMLVideoElement | undefined;
      if (!visualVideo) {
        visualVideo = document.createElement('video');
        visualVideo.preload = 'auto';
        visualVideo.playsInline = true;
        visualVideo.muted = true;
        visualVideo.className = 'absolute max-w-none object-contain';
        visualVideo.style.display = 'none';
        visualVideo.style.visibility = 'hidden';
        videoHostRef.current?.appendChild(visualVideo);
        videoPool.current.set(clip.id, visualVideo);
      }

      let audioEl = audioPool.current.get(clip.id);
      if (!audioEl) {
        const audioVideo = document.createElement('video');
        audioVideo.preload = 'auto';
        audioVideo.playsInline = true;
        audioVideo.style.display = 'none';
        audioVideo.style.visibility = 'hidden';
        audioEl = audioVideo;
        audioPool.current.set(clip.id, audioEl);
      }

      if (clipAssetRef.current.get(clip.id) !== mediaKey) {
        visualVideo.src = url;
        hideVideoElement(visualVideo);
        visualVideo.load();
        audioEl.src = url;
        audioEl.load();
      }

      clipAssetRef.current.set(clip.id, mediaKey);
      if (!sourceNodes.current.has(clip.id)) {
        try {
          const ctx = getAudioContext();
          const source = ctx.createMediaElementSource(audioEl);
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
      }

      return visualVideo;
    }

    const existing = audioPool.current.get(clip.id);
    if (existing) {
      if (clipAssetRef.current.get(clip.id) !== mediaKey) {
        existing.src = url;
        clipAssetRef.current.set(clip.id, mediaKey);
        existing.load();
      }
      return existing;
    }

    const audio = new Audio();
    audio.preload = 'auto';
    audio.src = url;
    audioPool.current.set(clip.id, audio);
    const el: HTMLMediaElement = audio;
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
    if (existing && clipAssetRef.current.get(clip.id) === mediaKey) {
      if (asset.kind !== 'video' || (videoPool.current.has(clip.id) && audioPool.current.has(clip.id))) {
        return existing;
      }
    }

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

  const pruneMediaElements = useCallback((projectToPrune: Project, timeSec: number, nowMs: number) => {
    const clipsById = new Map(projectToPrune.clips.map((clip) => [clip.id, clip]));
    const keepIds = new Set<string>();
    for (const clip of preparedClipsForTime(projectToPrune, timeSec)) keepIds.add(clip.id);
    const currentPoolIds = new Set([
      ...videoPool.current.keys(),
      ...imagePool.current.keys(),
      ...audioPool.current.keys(),
    ]);
    const recentRetainedIds = new Set(
      [...currentPoolIds]
        .filter((clipId) => !keepIds.has(clipId) && clipsById.has(clipId))
        .map((clipId) => ({ clipId, touchedAt: clipMediaTouchedAtRef.current.get(clipId) ?? 0 }))
        .filter(({ touchedAt }) => touchedAt > 0 && nowMs - touchedAt <= RECENT_MEDIA_RETAIN_MS)
        .sort((first, second) => second.touchedAt - first.touchedAt)
        .slice(0, MAX_RECENT_MEDIA_RETAINED)
        .map(({ clipId }) => clipId),
    );
    const keepClip = (clipId: string) => {
      const clip = clipsById.get(clipId);
      if (!clip) return false;
      const selectedForPlayback = keepIds.has(clipId);
      const closeEnoughToFade = (fadingOut.current.has(clipId) || fadingIn.current.has(clipId))
        && clipIntersectsWindow(clip, timeSec - AUDIO_FADE_RETAIN_SEC, timeSec + AUDIO_FADE_RETAIN_SEC);
      return selectedForPlayback || closeEnoughToFade || recentRetainedIds.has(clipId);
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
    const stage = previewStageRef.current;
    if (!stage) return;

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
      const pixelScale = previewPixelScale(previewStageRef.current, useProjectStore.getState().project);
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

    stage.addEventListener('mousedown', onDown);
    stage.style.cursor = 'move';
    return () => {
      stage.removeEventListener('mousedown', onDown);
      stage.style.cursor = '';
    };
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
      else if (asset.kind === 'video') {
        wantedVideoClipIds.add(clip.id);
        wantedAudioClipIds.add(clip.id);
      }
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
      const previewFps = safeProjectFps(proj);
      const frameSec = 1 / previewFps;
      const previousTimelineTime = lastTimelineTimeRef.current;
      const timelineDelta = previousTimelineTime === null ? 0 : state.currentTimeSec - previousTimelineTime;
      const wasPlaying = lastPlayingStateRef.current;
      const playStateChanged = wasPlaying !== state.playing;
      const startingPlayback = !wasPlaying && state.playing;
      const needsDecoderSyncBeforeReset = needsDecoderSyncOnPlayRef.current;
      const pausedPlayheadChanged = previousTimelineTime !== null
        && !state.playing
        && Math.abs(timelineDelta) > frameSec * 0.5;
      const jumpedBackward = previousTimelineTime !== null && timelineDelta < -frameSec * 1.5;
      const jumpedFar = previousTimelineTime !== null && Math.abs(timelineDelta) > Math.max(0.25, frameSec * 8);

      if (playStateChanged || pausedPlayheadChanged || jumpedBackward || jumpedFar) {
        resetTransientPlaybackState();
        playbackClockTimeRef.current = state.currentTimeSec;
        lastTickRef.current = ts;
      }
      if (pausedPlayheadChanged || jumpedBackward || jumpedFar) {
        needsDecoderSyncOnPlayRef.current = true;
        if (state.playing) startupDecoderSyncStartedAtRef.current = ts;
      }
      if (startingPlayback && needsDecoderSyncOnPlayRef.current) {
        startupDecoderSyncStartedAtRef.current = ts;
      } else if (startingPlayback && needsDecoderSyncBeforeReset) {
        needsDecoderSyncOnPlayRef.current = true;
        startupDecoderSyncStartedAtRef.current = ts;
      }
      if (!state.playing) {
        startupDecoderSyncStartedAtRef.current = null;
      }
      lastPlayingStateRef.current = state.playing;

      const startupDecoderSyncActive = state.playing && startupDecoderSyncStartedAtRef.current !== null;
      const mediaPlaying = state.playing && !startupDecoderSyncActive;

      if (state.playing) {
        resumeAudioContext();
        const dt = (ts - (lastTickRef.current ?? ts)) / 1000;
        if (startupDecoderSyncActive) {
          playbackClockTimeRef.current = state.currentTimeSec;
        } else {
          const clockTime = playbackClockTimeRef.current ?? state.currentTimeSec;
          const nextContinuous = Math.min(total, clockTime + dt);
          playbackClockTimeRef.current = nextContinuous;
          state.setCurrentTime(nextContinuous, { snapMode: 'floor' });
          if (total > 0 && nextContinuous >= total) pause();
        }
      } else {
        playbackClockTimeRef.current = state.currentTimeSec;
      }
      lastTickRef.current = ts;

      // Apply master volume to the master GainNode each frame.
      const masterVol = state.masterVolume;
      const masterGain = getMasterGain();
      if (Math.abs(masterGain.gain.value - masterVol) > 0.001) {
        masterGain.gain.setTargetAtTime(masterVol, getAudioContext().currentTime, 0.01);
      }

      const t = usePlaybackStore.getState().currentTimeSec;
      const audioFrame = resolveFrame(proj, t);
      const visualFrame = resolveFrame(proj, t);
      for (const layer of [...visualFrame.videos, ...audioFrame.audios]) {
        clipMediaTouchedAtRef.current.set(layer.clip.id, ts);
      }
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
      const tracksById = new Map(proj.tracks.map((track) => [track.id, track]));
      const activeVisualLayersByClipId = new Map(visualLayers.map((layer) => [layer.clip.id, layer]));
      const activeVisualAssetsByClipId = new Map<string, MediaAsset>();
      for (const layer of visualLayers) {
        const asset = assetsById.get(layer.clip.assetId);
        if (asset?.kind === 'video' || asset?.kind === 'image') activeVisualAssetsByClipId.set(layer.clip.id, asset);
      }
      const warmVisualClipIds = new Set<string>();
      for (const layer of visualLayers) {
        const activeAsset = activeVisualAssetsByClipId.get(layer.clip.id);
        if (activeAsset?.kind !== 'video') continue;
        const videoEl = videoPool.current.get(layer.clip.id) as HTMLVideoElement | undefined;
        if (!videoEl) continue;
        keepVideoDecoderElementWarm(videoEl);
        setPitchPreservingRate(videoEl, clipSpeed(layer.clip));
        if (!mediaPlaying && !videoEl.paused) videoEl.pause();
        const tolerance = videoSyncWindow(layer.clip, previewFps, mediaPlaying);
        const layerTimelineTimeSec = layerVisualTimelineTime(layer, t, previewFps, mediaPlaying);
        const layerSourceTimeSec = layerSourceTimeAt(layer, layerTimelineTimeSec);
        seekIfNeeded(videoEl, layerSourceTimeSec, mediaPlaying, tolerance, requestedSeekTargetsRef.current);
        if (mediaPlaying && videoEl.paused) {
          videoEl.muted = true;
          videoEl.play().catch(() => undefined);
        }
      }
      if (mediaPlaying) {
        for (const clip of preparedClips) {
          if (activeVisualLayersByClipId.has(clip.id)) continue;
          const track = tracksById.get(clip.trackId);
          if (track?.kind !== 'video' || track.hidden) continue;
          const timeUntilActive = clip.startSec - t;
          if (timeUntilActive < 0 || timeUntilActive > VISUAL_PREROLL_SEC) continue;
          const asset = assetsById.get(clip.assetId);
          if (asset?.kind !== 'video') continue;
          const videoEl = videoPool.current.get(clip.id) as HTMLVideoElement | undefined;
          if (!videoEl) continue;
          warmVisualClipIds.add(clip.id);
          keepVideoDecoderElementWarm(videoEl);
          videoEl.muted = true;
          setPitchPreservingRate(videoEl, clipSpeed(clip));
          seekIfNeeded(videoEl, clip.inSec, false, 0.04, requestedSeekTargetsRef.current);
        }
      }
      const canvasFrameKey = visualLayers.map((layer) => (
        `${layer.track.id}:${layer.track.index}:${layer.clip.id}:${projectFrameIndex(Math.max(0, t - layer.clip.startSec), previewFps)}`
      )).join('|');
      const shouldRenderCanvas = !mediaPlaying || canvasFrameKey !== lastPlayingCanvasFrameKeyRef.current;
      if (visualLayers.length > 0 && shouldRenderCanvas) {
        const rendered = renderPreviewCanvas(
          freezeFrameCanvasRef.current,
          visualLayers,
          assetsById,
          proj,
          t,
          previewFps,
          mediaPlaying,
          videoPool.current,
          imagePool.current,
        );
        if (mediaPlaying && rendered) lastPlayingCanvasFrameKeyRef.current = canvasFrameKey;
      } else if (visualLayers.length === 0) {
        lastPlayingCanvasFrameKeyRef.current = null;
      }
      if (freezeFrameCanvasRef.current) {
        freezeFrameCanvasRef.current.style.display = visualLayers.length > 0 ? 'block' : 'none';
      }
      updatePreviewPerformanceMonitor({
        ts,
        frameKey: canvasFrameKey,
        mediaPlaying,
        visualLayers,
        assetsById,
        timelineTimeSec: t,
        previewFps,
      });
      for (const [clipId, el] of videoPool.current) {
        const videoEl = el as HTMLVideoElement;
        const activeLayer = activeVisualLayersByClipId.get(clipId);
        const activeAsset = activeVisualAssetsByClipId.get(clipId);
        if ((activeLayer && activeAsset?.kind === 'video') || warmVisualClipIds.has(clipId)) {
          keepVideoDecoderElementWarm(videoEl);
        } else {
          hideVideoElement(videoEl);
        }
      }
      for (const img of imagePool.current.values()) {
        img.style.display = 'none';
        img.style.visibility = 'hidden';
        img.style.transform = '';
        img.style.filter = '';
        img.style.opacity = '';
        img.style.cursor = 'default';
        img.style.zIndex = '';
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
        const el = audioPool.current.get(clip.id) ?? videoPool.current.get(clip.id);
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
          if (el === videoPool.current.get(clip.id)) {
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
        const visualVideoEl = videoPool.current.get(clipId);
        const el = audioPool.current.get(clipId) ?? visualVideoEl;
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

        if (el === visualVideoEl) (el as HTMLVideoElement).muted = false;
        setPitchPreservingRate(el, clipSpeed(layer.clip));

        if (!mediaPlaying && !el.paused) el.pause();
        if (el !== visualVideoEl || !activeVisualLayersByClipId.has(clipId)) {
          seekIfNeeded(
            el,
            layer.sourceTimeSec,
            mediaPlaying,
            startupDecoderSyncActive ? STARTUP_AUDIO_SEEK_TOLERANCE_SEC : undefined,
            requestedSeekTargetsRef.current,
          );
        }
        if (mediaPlaying && el.paused) el.play().catch(() => undefined);
      }

      if (state.playing && startupDecoderSyncStartedAtRef.current !== null) {
        const startupElapsedMs = ts - startupDecoderSyncStartedAtRef.current;
        const requireAudioForStartup = startupElapsedMs < STARTUP_AUDIO_SYNC_GRACE_MS;
        const startupReady = activeMediaReadyForStartup(
          visualFrame.videos,
          audioFrame.audios,
          assetsById,
          t,
          previewFps,
          videoPool.current,
          imagePool.current,
          audioPool.current,
          requireAudioForStartup,
        );
        const startupTimedOut = startupElapsedMs >= STARTUP_DECODER_SYNC_TIMEOUT_MS;
        if (startupReady || startupTimedOut) {
          needsDecoderSyncOnPlayRef.current = false;
          startupDecoderSyncStartedAtRef.current = null;
          requestedSeekTargetsRef.current = new WeakMap();
          playbackClockTimeRef.current = t;
          lastTickRef.current = ts;
        }
      }

      pruneMediaElements(proj, t, ts);

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

      lastTimelineTimeRef.current = usePlaybackStore.getState().currentTimeSec;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [ensureClipElement, pause, pruneMediaElements, resetTransientPlaybackState, updatePreviewPerformanceMonitor]);

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
    const stepFrame = (direction: -1 | 1) => {
      const fps = Math.max(1, project.fps);
      const latestTime = usePlaybackStore.getState().currentTimeSec;
      const currentFrame = Math.round(latestTime * fps);
      setCurrentTime(Math.max(0, Math.min(duration, (currentFrame + direction) / fps)));
    };
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      if (e.code === 'Space') { e.preventDefault(); usePlaybackStore.getState().toggle(); }
      else if (e.key === 'Home') { e.preventDefault(); setCurrentTime(0); }
      else if (e.key === 'End') { e.preventDefault(); setCurrentTime(duration, { snapMode: 'floor' }); }
      else if (e.key === ',' || e.key === '<') { e.preventDefault(); stepFrame(-1); }
      else if (e.key === '.' || e.key === '>') { e.preventDefault(); stepFrame(1); }
      else if (e.key === 'f' || e.key === 'F') { e.preventDefault(); toggleFullscreen(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [duration, project.fps, setCurrentTime]);

  useEffect(() => {
    if (!import.meta.env.DEV) return undefined;
    const bridge: PreviewDebugBridge = {
      play: () => usePlaybackStore.getState().play(),
      pause: () => usePlaybackStore.getState().pause(),
      setCurrentTime: (timeSec) => usePlaybackStore.getState().setCurrentTime(timeSec, { snap: false }),
      sampleFrame: () => {
        const playback = usePlaybackStore.getState();
        return {
          now: performance.now(),
          currentTimeSec: playback.currentTimeSec,
          playing: playback.playing,
          canvas: sampleCanvas(freezeFrameCanvasRef.current),
          videos: sampleMediaPool(videoPool.current),
          audios: sampleMediaPool(audioPool.current),
        };
      },
    };
    window.__GENEDIT_PREVIEW_DEBUG__ = bridge;
    return () => {
      if (window.__GENEDIT_PREVIEW_DEBUG__ === bridge) delete window.__GENEDIT_PREVIEW_DEBUG__;
    };
  }, []);

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
          onContextMenu={handlePreviewContextMenu}
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
          <div ref={videoHostRef} className="pointer-events-none absolute inset-0 z-0 overflow-hidden opacity-0" aria-hidden />
          {!hasActiveVideo && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-slate-500">
              {ready ? 'No clip at playhead' : 'Loading…'}
            </div>
          )}
          {previewPerformanceWarning && (
            <div className="pointer-events-none absolute right-3 top-3 z-30">
              <div className="pointer-events-auto group relative">
                <div
                  className="flex h-9 w-9 items-center justify-center rounded-full border border-amber-300/70 bg-surface-950/90 text-amber-300 shadow-lg shadow-black/30 backdrop-blur"
                  role="status"
                  aria-label="Preview performance warning"
                >
                  <AlertTriangle size={18} />
                </div>
                <div className="pointer-events-none absolute right-0 top-11 hidden w-72 rounded-md border border-amber-300/40 bg-surface-950/95 p-3 text-xs leading-relaxed text-slate-300 shadow-xl shadow-black/40 group-hover:block">
                  <div className="mb-1 font-semibold text-amber-200">Preview performance warning</div>
                  <div>
                    Repeated preview frames are high ({Math.round(previewPerformanceWarning.repeatedPct * 100)}%).
                    Your hardware or browser may be struggling to decode this section in real time. Exports are unaffected.
                  </div>
                </div>
              </div>
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
      {previewContextMenu && (
        <PreviewContextMenu
          x={previewContextMenu.x}
          y={previewContextMenu.y}
          canSaveFrame={previewContextMenu.canSaveFrame}
          onSaveFrame={() => { void saveCurrentVideoFrame(); }}
          onClose={() => setPreviewContextMenu(null)}
        />
      )}
    </div>
  );
}

function PreviewContextMenu({
  x,
  y,
  canSaveFrame,
  onSaveFrame,
  onClose,
}: {
  x: number;
  y: number;
  canSaveFrame: boolean;
  onSaveFrame: () => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const margin = 8;
    const maxLeft = Math.max(margin, window.innerWidth - menu.offsetWidth - margin);
    const maxTop = Math.max(margin, window.innerHeight - menu.offsetHeight - margin);
    const left = Math.min(Math.max(margin, x), maxLeft);
    const top = Math.min(Math.max(margin, y), maxTop);
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
  }, [x, y]);

  useEffect(() => {
    const onDown = (event: globalThis.MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('[data-preview-context-menu]')) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      data-preview-context-menu
      className="fixed z-[90] min-w-[190px] rounded-md border border-surface-600 bg-surface-800 py-1 text-xs text-slate-200 shadow-lg"
      onContextMenu={(event) => event.preventDefault()}
    >
      <button
        type="button"
        disabled={!canSaveFrame}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-surface-700 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
        onClick={() => {
          if (canSaveFrame) onSaveFrame();
          onClose();
        }}
      >
        <ImagePlus size={12} />
        Save Video Frame
      </button>
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
