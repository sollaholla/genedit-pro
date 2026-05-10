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

const MAX_REFERENCE_TOTAL_SEC = 15;
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
  if (gapDurationSec <= 5) return 5;
  if (gapDurationSec <= 10) return 10;
  return 15;
}

export function sourceEndFrameTimeSec(clip: Clip, fps: number): number {
  const frameDurationSec = clipSpeed(clip) / Math.max(1, fps);
  return Math.max(clip.inSec, clip.outSec - frameDurationSec);
}

export function sourceStartFrameTimeSec(clip: Clip): number {
  return Math.max(0, clip.inSec);
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
  const perSideBudgetSec = MAX_REFERENCE_TOTAL_SEC / 2;
  const leftAvailableSec = Math.max(0.05, leftClip.outSec - leftClip.inSec);
  const rightAvailableSec = Math.max(0.05, rightClip.outSec - rightClip.inSec);
  const leftDurationSec = Math.min(perSideBudgetSec, leftAvailableSec);
  const rightDurationSec = Math.min(perSideBudgetSec, rightAvailableSec, MAX_REFERENCE_TOTAL_SEC - leftDurationSec);
  const leftStartSec = Math.max(leftClip.inSec, leftClip.outSec - leftDurationSec);
  const rightStartSec = rightClip.inSec;

  onStatus?.('Preparing bridge references...');
  const leftFile = await extractVideoSegmentFile({
    asset: leftAsset,
    startSec: leftStartSec,
    durationSec: leftDurationSec,
    name: `bridge_video_1_${Date.now()}.mp4`,
  });
  const rightFile = await extractVideoSegmentFile({
    asset: rightAsset,
    startSec: rightStartSec,
    durationSec: rightDurationSec,
    name: `bridge_video_2_${Date.now()}.mp4`,
  });

  return [
    { file: leftFile, sourceStartSec: leftStartSec, durationSec: leftDurationSec },
    { file: rightFile, sourceStartSec: rightStartSec, durationSec: rightDurationSec },
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
  name,
}: {
  asset: MediaAsset;
  startSec: number;
  durationSec: number;
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
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        '-y',
        outputFile,
      ];
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
