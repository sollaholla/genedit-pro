import { getFFmpeg, resetFFmpeg } from '@/lib/ffmpeg/client';
import { activeEditIteration } from '@/lib/media/editTrail';
import { getBlob } from '@/lib/media/storage';
import { clipSpeed } from '@/lib/timeline/operations';
import type { Clip, MediaAsset } from '@/types';

export type BridgeFrameMatch = {
  inSec: number;
  outSec: number;
  firstScore: number;
  secondScore: number;
};

export type BridgeReferenceSegment = {
  file: File;
  sourceStartSec: number;
  durationSec: number;
};

export type BridgeFrameReference = {
  file: File;
  sourceTimeSec: number;
};

export type BridgeReferencePlan = {
  leftStartSec: number;
  leftDurationSec: number;
  leftPadStartSec: number;
  leftOutputDurationSec: number;
  rightStartSec: number;
  rightDurationSec: number;
  rightPadEndSec: number;
  rightOutputDurationSec: number;
  totalDurationSec: number;
};

const MAX_REFERENCE_TOTAL_SEC = 14;
const MIN_REFERENCE_INPUT_SEC = 2;
const MAX_SCAN_FPS = 30;
const FRAME_SIGNATURE_WIDTH = 32;
const FRAME_SIGNATURE_HEIGHT = 18;
const FRAME_MATCH_MAX_RMS = 30;
const SEEK_TIMEOUT_MS = 5000;

let ffmpegJobQueue: Promise<unknown> = Promise.resolve();

function runFfmpegJob<T>(job: () => Promise<T>): Promise<T> {
  const run = ffmpegJobQueue.catch(() => undefined).then(job);
  ffmpegJobQueue = run.catch(() => undefined);
  return run;
}

export function seedanceDurationForGap(gapDurationSec: number): number {
  const durations = [5, 10, 15];
  let best = durations[0]!;
  let bestDistance = Math.abs(gapDurationSec - best);
  for (const duration of durations.slice(1)) {
    const distance = Math.abs(gapDurationSec - duration);
    if (distance < bestDistance) {
      best = duration;
      bestDistance = distance;
    }
  }
  return best;
}

export function sourceEndFrameTimeSec(clip: Clip, fps: number): number {
  const frameDurationSec = clipSpeed(clip) / Math.max(1, fps);
  return Math.max(clip.inSec, clip.outSec - frameDurationSec);
}

export function sourceStartFrameTimeSec(clip: Clip): number {
  return Math.max(0, clip.inSec);
}

export function planBridgeReferenceSegments(
  leftClip: Clip,
  rightClip: Clip,
  leftAssetDurationSec?: number,
  rightAssetDurationSec?: number,
): BridgeReferencePlan {
  const perSideBudgetSec = MAX_REFERENCE_TOTAL_SEC / 2;
  const leftSourceEndSec = Number.isFinite(leftAssetDurationSec) && (leftAssetDurationSec ?? 0) > 0
    ? Math.min(leftClip.outSec, leftAssetDurationSec!)
    : leftClip.outSec;
  const leftAvailableSec = Math.max(0.05, leftSourceEndSec);
  const rightSourceEndSec = Number.isFinite(rightAssetDurationSec) && (rightAssetDurationSec ?? 0) > rightClip.inSec
    ? rightAssetDurationSec!
    : rightClip.outSec;
  const rightAvailableSec = Math.max(0.05, rightSourceEndSec - rightClip.inSec);
  const leftDurationSec = Math.min(perSideBudgetSec, leftAvailableSec);
  const rightDurationSec = Math.min(perSideBudgetSec, rightAvailableSec, MAX_REFERENCE_TOTAL_SEC - leftDurationSec);
  const leftPadStartSec = Math.max(0, MIN_REFERENCE_INPUT_SEC - leftDurationSec);
  const rightPadEndSec = Math.max(0, MIN_REFERENCE_INPUT_SEC - rightDurationSec);
  const leftOutputDurationSec = leftDurationSec + leftPadStartSec;
  const rightOutputDurationSec = rightDurationSec + rightPadEndSec;
  const totalDurationSec = leftOutputDurationSec + rightOutputDurationSec;
  return {
    leftStartSec: Math.max(0, leftClip.outSec - leftDurationSec),
    leftDurationSec,
    leftPadStartSec,
    leftOutputDurationSec,
    rightStartSec: rightClip.inSec,
    rightDurationSec,
    rightPadEndSec,
    rightOutputDurationSec,
    totalDurationSec,
  };
}

export async function extractBridgeReferenceSegments({
  leftAsset,
  leftClip,
  rightAsset,
  rightClip,
  onStatus,
}: {
  leftAsset: MediaAsset;
  leftClip: Clip;
  rightAsset: MediaAsset;
  rightClip: Clip;
  onStatus?: (message: string) => void;
}): Promise<[BridgeReferenceSegment, BridgeReferenceSegment]> {
  const plan = planBridgeReferenceSegments(leftClip, rightClip, leftAsset.durationSec, rightAsset.durationSec);

  onStatus?.('Preparing bridge references...');
  const leftFile = await extractVideoSegmentFile({
    asset: leftAsset,
    startSec: plan.leftStartSec,
    durationSec: plan.leftDurationSec,
    padStartSec: plan.leftPadStartSec,
    name: `bridge_video_1_${Date.now()}.mp4`,
  });
  const rightFile = await extractVideoSegmentFile({
    asset: rightAsset,
    startSec: plan.rightStartSec,
    durationSec: plan.rightDurationSec,
    padEndSec: plan.rightPadEndSec,
    name: `bridge_video_2_${Date.now()}.mp4`,
  });

  return [
    { file: leftFile, sourceStartSec: plan.leftStartSec, durationSec: plan.leftOutputDurationSec },
    { file: rightFile, sourceStartSec: plan.rightStartSec, durationSec: plan.rightOutputDurationSec },
  ];
}

export async function extractBridgeEndpointFrames({
  leftAsset,
  leftClip,
  rightAsset,
  rightClip,
  fps,
  onStatus,
}: {
  leftAsset: MediaAsset;
  leftClip: Clip;
  rightAsset: MediaAsset;
  rightClip: Clip;
  fps: number;
  onStatus?: (message: string) => void;
}): Promise<[BridgeFrameReference, BridgeFrameReference]> {
  const leftBlob = await activeBlobForAsset(leftAsset);
  const rightBlob = await activeBlobForAsset(rightAsset);
  if (!leftBlob || !rightBlob) throw new Error('Both neighboring video clips must still be available locally.');

  onStatus?.('Preparing start and end frames...');
  const leftTimeSec = sourceEndFrameTimeSec(leftClip, fps);
  const rightTimeSec = sourceStartFrameTimeSec(rightClip);
  const [leftFile, rightFile] = await Promise.all([
    frameFileFromBlob(leftBlob, leftTimeSec, `bridge_start_frame_${Date.now()}.jpg`),
    frameFileFromBlob(rightBlob, rightTimeSec, `bridge_end_frame_${Date.now()}.jpg`),
  ]);
  return [
    { file: leftFile, sourceTimeSec: leftTimeSec },
    { file: rightFile, sourceTimeSec: rightTimeSec },
  ];
}

export async function matchBridgeFrames({
  generatedFile,
  leftAsset,
  leftClip,
  rightAsset,
  rightClip,
  fps,
  onStatus,
}: {
  generatedFile: File;
  leftAsset: MediaAsset;
  leftClip: Clip;
  rightAsset: MediaAsset;
  rightClip: Clip;
  fps: number;
  onStatus?: (message: string) => void;
}): Promise<BridgeFrameMatch | null> {
  const leftBlob = await activeBlobForAsset(leftAsset);
  const rightBlob = await activeBlobForAsset(rightAsset);
  if (!leftBlob || !rightBlob) return null;

  onStatus?.('Scanning bridge frames...');
  const leftTarget = await frameSignatureFromBlob(leftBlob, sourceEndFrameTimeSec(leftClip, fps));
  const rightTarget = await frameSignatureFromBlob(rightBlob, sourceStartFrameTimeSec(rightClip));
  const generatedUrl = URL.createObjectURL(generatedFile);
  try {
    const generatedVideo = await loadVideo(generatedUrl);
    const scanFps = Math.min(MAX_SCAN_FPS, Math.max(1, fps));
    const frameStepSec = 1 / scanFps;
    const durationSec = Math.max(0, generatedVideo.duration || 0);
    let firstMatch: { timeSec: number; score: number } | null = null;

    for (let timeSec = 0; timeSec <= durationSec + frameStepSec / 2; timeSec += frameStepSec) {
      const signature = await frameSignatureFromVideo(generatedVideo, Math.min(durationSec, timeSec));
      const score = frameRms(signature, leftTarget);
      if (score <= FRAME_MATCH_MAX_RMS) {
        firstMatch = { timeSec: Math.min(durationSec, timeSec), score };
        break;
      }
    }

    if (!firstMatch) return null;

    let secondMatch: { timeSec: number; score: number } | null = null;
    const startSecondSearchSec = Math.min(durationSec, firstMatch.timeSec + frameStepSec);
    for (let timeSec = startSecondSearchSec; timeSec <= durationSec + frameStepSec / 2; timeSec += frameStepSec) {
      const signature = await frameSignatureFromVideo(generatedVideo, Math.min(durationSec, timeSec));
      const score = frameRms(signature, rightTarget);
      if (score <= FRAME_MATCH_MAX_RMS) {
        secondMatch = { timeSec: Math.min(durationSec, timeSec), score };
        break;
      }
    }

    if (!secondMatch || secondMatch.timeSec <= firstMatch.timeSec) return null;
    return {
      inSec: firstMatch.timeSec,
      outSec: secondMatch.timeSec,
      firstScore: firstMatch.score,
      secondScore: secondMatch.score,
    };
  } finally {
    URL.revokeObjectURL(generatedUrl);
  }
}

async function extractVideoSegmentFile({
  asset,
  startSec,
  durationSec,
  padStartSec = 0,
  padEndSec = 0,
  name,
}: {
  asset: MediaAsset;
  startSec: number;
  durationSec: number;
  padStartSec?: number;
  padEndSec?: number;
  name: string;
}): Promise<File> {
  return runFfmpegJob(async () => {
    const blob = await activeBlobForAsset(asset);
    if (!blob) throw new Error(`${asset.name} is not available locally.`);

    const ffmpeg = await getFFmpeg();
    const inputFile = `bridge-input-${asset.id}-${Date.now()}.${extensionForMime(asset.mimeType)}`;
    const outputFile = `bridge-output-${asset.id}-${Date.now()}.mp4`;
    let resetEncoder = false;
    try {
      await ffmpeg.writeFile(inputFile, new Uint8Array(await blob.arrayBuffer()));
      const args = [
        '-hide_banner',
        '-ss', seconds(startSec),
        '-t', seconds(durationSec),
        '-i', inputFile,
        '-map', '0:v:0',
        '-an',
      ];
      const padFilter = tpadFilter(padStartSec, padEndSec);
      if (padFilter) args.push('-vf', padFilter);
      args.push(
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        '-y',
        outputFile,
      );
      const code = await ffmpeg.exec(args);
      if (code !== 0) throw new Error(`Could not prepare ${asset.name} as a bridge reference.`);
      const data = (await ffmpeg.readFile(outputFile)) as Uint8Array;
      return new File([data.slice()], name, { type: 'video/mp4' });
    } catch (error) {
      resetEncoder = isFfmpegMemoryError(error);
      throw error;
    } finally {
      await ffmpeg.deleteFile(inputFile).catch(() => undefined);
      await ffmpeg.deleteFile(outputFile).catch(() => undefined);
      if (resetEncoder) resetFFmpeg();
    }
  });
}

async function activeBlobForAsset(asset: MediaAsset): Promise<Blob | null> {
  const blobKey = activeEditIteration(asset)?.blobKey ?? asset.blobKey;
  if (!blobKey) return null;
  return getBlob(blobKey);
}

function seconds(value: number): string {
  return Math.max(0, value).toFixed(3);
}

function tpadFilter(padStartSec: number, padEndSec: number): string | null {
  const parts: string[] = [];
  if (padStartSec > 0.001) parts.push(`start_duration=${seconds(padStartSec)}`, 'start_mode=clone');
  if (padEndSec > 0.001) parts.push(`stop_duration=${seconds(padEndSec)}`, 'stop_mode=clone');
  return parts.length > 0 ? `tpad=${parts.join(':')}` : null;
}

function extensionForMime(mimeType: string): string {
  if (/quicktime|mov/i.test(mimeType)) return 'mov';
  if (/webm/i.test(mimeType)) return 'webm';
  if (/mp4|mpeg4/i.test(mimeType)) return 'mp4';
  return 'mp4';
}

function isFfmpegMemoryError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /memory access out of bounds|out of memory|Cannot enlarge memory/i.test(message);
}

async function frameSignatureFromBlob(blob: Blob, timeSec: number): Promise<Uint8ClampedArray> {
  const url = URL.createObjectURL(blob);
  try {
    const video = await loadVideo(url);
    return frameSignatureFromVideo(video, timeSec);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function frameFileFromBlob(blob: Blob, timeSec: number, name: string): Promise<File> {
  const url = URL.createObjectURL(blob);
  try {
    const video = await loadVideo(url);
    await seekVideo(video, timeSec);
    const maxWidth = 1280;
    const sourceWidth = video.videoWidth || 1280;
    const sourceHeight = video.videoHeight || 720;
    const width = Math.max(1, Math.min(maxWidth, sourceWidth));
    const height = Math.max(1, Math.round(width * (sourceHeight / Math.max(1, sourceWidth))));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not extract video frame.');
    context.drawImage(video, 0, 0, width, height);
    const frameBlob = await canvasToBlob(canvas, 'image/jpeg', 0.92);
    return new File([frameBlob], name, { type: 'image/jpeg' });
  } finally {
    URL.revokeObjectURL(url);
  }
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Could not encode video frame.'));
    }, type, quality);
  });
}

async function loadVideo(url: string): Promise<HTMLVideoElement> {
  const video = document.createElement('video');
  video.preload = 'auto';
  video.muted = true;
  video.playsInline = true;
  video.crossOrigin = 'anonymous';
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      video.onloadeddata = null;
      video.onloadedmetadata = null;
      video.onerror = null;
    };
    video.onloadeddata = () => {
      cleanup();
      resolve(video);
    };
    video.onloadedmetadata = () => {
      if (video.readyState >= 2) {
        cleanup();
        resolve(video);
      }
    };
    video.onerror = () => {
      cleanup();
      reject(new Error('Could not load video frames.'));
    };
    video.src = url;
  });
}

async function frameSignatureFromVideo(video: HTMLVideoElement, timeSec: number): Promise<Uint8ClampedArray> {
  await seekVideo(video, timeSec);
  const canvas = document.createElement('canvas');
  canvas.width = FRAME_SIGNATURE_WIDTH;
  canvas.height = FRAME_SIGNATURE_HEIGHT;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Could not inspect video frame.');
  ctx.drawImage(video, 0, 0, FRAME_SIGNATURE_WIDTH, FRAME_SIGNATURE_HEIGHT);
  return ctx.getImageData(0, 0, FRAME_SIGNATURE_WIDTH, FRAME_SIGNATURE_HEIGHT).data;
}

function seekVideo(video: HTMLVideoElement, timeSec: number): Promise<void> {
  const durationSec = Number.isFinite(video.duration) ? Math.max(0, video.duration) : 0;
  const target = Math.max(0, Math.min(durationSec || timeSec, timeSec));
  if (Math.abs(video.currentTime - target) < 0.002 && video.readyState >= 2) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error('Timed out while scanning video frames.'));
    }, SEEK_TIMEOUT_MS);
    const cleanup = () => {
      window.clearTimeout(timeout);
      video.onseeked = null;
      video.onerror = null;
    };
    video.onseeked = () => {
      cleanup();
      resolve();
    };
    video.onerror = () => {
      cleanup();
      reject(new Error('Could not seek video frame.'));
    };
    try {
      video.currentTime = target;
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

function frameRms(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  const count = Math.min(a.length, b.length);
  if (count === 0) return Number.POSITIVE_INFINITY;
  let sum = 0;
  let samples = 0;
  for (let index = 0; index < count; index += 4) {
    const dr = a[index]! - b[index]!;
    const dg = a[index + 1]! - b[index + 1]!;
    const db = a[index + 2]! - b[index + 2]!;
    sum += dr * dr + dg * dg + db * db;
    samples += 3;
  }
  return Math.sqrt(sum / Math.max(1, samples));
}
