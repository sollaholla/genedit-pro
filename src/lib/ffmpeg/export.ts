import { FFFSType } from '@ffmpeg/ffmpeg';
import type { Clip, MediaAsset, Project, Track } from '@/types';
import { getBlob } from '@/lib/media/storage';
import { clipSpeed, clipTimelineDurationSec, projectDurationSec } from '@/lib/timeline/operations';
import { resolveFrame } from '@/lib/playback/engine';
import { evalEnvelopeAt } from '@/lib/timeline/envelope';
import { colorCorrectionFfmpegFilters } from '@/lib/components/colorCorrection';
import { getFFmpeg, resetFFmpeg } from './client';

const SOURCE_MOUNT_DIR = '/source-media';
const CONCAT_MOUNT_DIR = '/concat-media';

type Segment = {
  index: number;
  startSec: number;
  endSec: number;
  videoLayer: { clip: Clip; track: Track } | null;
  audioLayer: { clip: Clip; track: Track } | null;
};

export type ExportCallbacks = {
  onStatus?: (message: string) => void;
  onProgress?: (value: number) => void; // 0..1
  onLog?: (line: string) => void;
};

/**
 * Walks the timeline from t=0 to its end, splitting it at every point where
 * the top-most video or audio layer changes. Each segment is a stable
 * slice that can be encoded with a single ffmpeg invocation.
 */
export function planSegments(project: Project): Segment[] {
  const totalDuration = projectDurationSec(project);
  if (totalDuration <= 0) return [];

  const breakpoints = new Set<number>([0, totalDuration]);
  for (const clip of project.clips) {
    breakpoints.add(clip.startSec);
    breakpoints.add(clip.startSec + clipTimelineDurationSec(clip));
  }

  const ordered = [...breakpoints]
    .filter((t) => t >= 0 && t <= totalDuration)
    .sort((a, b) => a - b);

  const segments: Segment[] = [];
  for (let i = 0; i < ordered.length - 1; i++) {
    const start = ordered[i]!;
    const end = ordered[i + 1]!;
    if (end - start < 0.01) continue;
    const mid = (start + end) / 2;
    const frame = resolveFrame(project, mid);
    segments.push({
      index: segments.length,
      startSec: start,
      endSec: end,
      videoLayer: frame.video ? { clip: frame.video.clip, track: frame.video.track } : null,
      audioLayer: frame.audios[0] ? { clip: frame.audios[0].clip, track: frame.audios[0].track } : null,
    });
  }
  return segments;
}

function vfsNameForAsset(asset: MediaAsset): string {
  const ext = asset.name.split('.').pop() || 'mp4';
  return `${SOURCE_MOUNT_DIR}/asset_${asset.id}.${ext.toLowerCase()}`;
}

function workerFsNameForAsset(asset: MediaAsset): string {
  return vfsNameForAsset(asset).slice(SOURCE_MOUNT_DIR.length + 1);
}

async function createDirIfMissing(ffmpeg: Awaited<ReturnType<typeof getFFmpeg>>, path: string): Promise<void> {
  await ffmpeg.createDir(path).catch(() => undefined);
}

async function mountSourceAssets(
  ffmpeg: Awaited<ReturnType<typeof getFFmpeg>>,
  assets: MediaAsset[],
): Promise<void> {
  const blobs: Array<{ name: string; data: Blob }> = [];
  for (const asset of assets) {
    const blob = await getBlob(asset.blobKey);
    if (!blob) throw new Error(`Missing blob for asset ${asset.name}`);
    blobs.push({ name: workerFsNameForAsset(asset), data: blob });
  }

  await unmountDir(ffmpeg, SOURCE_MOUNT_DIR);
  await createDirIfMissing(ffmpeg, SOURCE_MOUNT_DIR);
  await ffmpeg.mount(FFFSType.WORKERFS, { blobs }, SOURCE_MOUNT_DIR);
}

async function mountConcatSource(
  ffmpeg: Awaited<ReturnType<typeof getFFmpeg>>,
  blob: Blob,
): Promise<string> {
  await unmountDir(ffmpeg, CONCAT_MOUNT_DIR);
  await createDirIfMissing(ffmpeg, CONCAT_MOUNT_DIR);
  await ffmpeg.mount(FFFSType.WORKERFS, { blobs: [{ name: 'timeline.ts', data: blob }] }, CONCAT_MOUNT_DIR);
  return `${CONCAT_MOUNT_DIR}/timeline.ts`;
}

async function unmountDir(ffmpeg: Awaited<ReturnType<typeof getFFmpeg>>, path: string): Promise<void> {
  await ffmpeg.unmount(path).catch(() => undefined);
  await ffmpeg.deleteDir(path).catch(() => undefined);
}

async function execOrThrow(
  ffmpeg: Awaited<ReturnType<typeof getFFmpeg>>,
  args: string[],
  label: string,
): Promise<void> {
  const code = await ffmpeg.exec(args);
  if (code !== 0) {
    throw new Error(`FFmpeg ${label} failed with exit code ${code}.`);
  }
}

function isFfmpegMemoryError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /memory access out of bounds|out of memory|Cannot enlarge memory/i.test(message);
}

function exportErrorMessage(error: unknown): string {
  if (!isFfmpegMemoryError(error)) {
    return error instanceof Error ? error.message : String(error);
  }
  return [
    'The browser encoder ran out of WebAssembly memory while exporting.',
    'This export path now avoids copying source media and intermediate segments into the encoder, so retry the export once.',
    'If it still happens, the timeline is too large for the in-browser encoder at the current resolution.',
  ].join(' ');
}

function segmentVideoFilter(width: number, height: number, fps: number, clip: Clip | null, timelineTimeSec: number): string {
  return [
    `scale=w=${width}:h=${height}:force_original_aspect_ratio=decrease`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
    'setsar=1',
    ...(clip ? colorCorrectionFfmpegFilters(clip, timelineTimeSec) : []),
    `fps=${fps}`,
  ].join(',');
}

/**
 * Build an FFmpeg audio filter that applies master volume and the volume
 * envelope to the given audio clip for this segment. Returns null if no
 * filter is needed (master=1 and no enabled envelope).
 */
function segmentAudioFilter(clip: Clip, segStartSec: number, segEndSec: number): string | null {
  const master = clip.volume ?? 1;
  const env = clip.volumeEnvelope;
  const hasEnv = !!env && env.enabled && env.points.length >= 2;

  if (!hasEnv) {
    if (Math.abs(master - 1) < 1e-4) return null;
    return `volume=${master.toFixed(4)}`;
  }

  const clipDur = Math.max(1e-6, clip.outSec - clip.inSec);
  const segDur = Math.max(1e-6, segEndSec - segStartSec);
  // Sample the envelope at N points along the segment, then emit a piecewise
  // linear expression evaluated each frame. N=24 is plenty given the curve is
  // already smooth and segments are short.
  const N = 24;
  const samples: { t: number; v: number }[] = [];
  for (let i = 0; i <= N; i++) {
    const tau = (i / N) * segDur;
    const sourceTime = clip.inSec + (segStartSec - clip.startSec + tau) * clipSpeed(clip);
    const localT = Math.max(0, Math.min(1, (sourceTime - clip.inSec) / clipDur));
    const envV = evalEnvelopeAt(env, localT);
    samples.push({ t: tau, v: Math.max(0, master * envV) });
  }

  // Build a nested if() expression, innermost = last sample's value.
  let expr = samples[N]!.v.toFixed(5);
  for (let i = N - 1; i >= 0; i--) {
    const s0 = samples[i]!;
    const s1 = samples[i + 1]!;
    const t0 = s0.t.toFixed(5);
    const dt = Math.max(1e-5, s1.t - s0.t).toFixed(5);
    const v0 = s0.v.toFixed(5);
    const dv = (s1.v - s0.v).toFixed(5);
    expr = `if(lt(t,${s1.t.toFixed(5)}),${v0}+(${dv})*(t-${t0})/${dt},${expr})`;
  }

  // Wrap in single quotes so the filtergraph parser treats commas inside the
  // expression as literal (not as filter-chain separators).
  return `volume=eval=frame:volume='${expr}'`;
}

export async function exportProject(
  project: Project,
  assets: MediaAsset[],
  callbacks: ExportCallbacks = {},
): Promise<Blob> {
  const { onStatus, onProgress, onLog } = callbacks;
  const totalDuration = projectDurationSec(project);
  if (totalDuration <= 0) throw new Error('Timeline is empty. Add at least one clip to export.');

  onStatus?.('Loading encoder…');
  const ffmpeg = await getFFmpeg(onLog);

  const assetById = new Map(assets.map((a) => [a.id, a]));
  const segments = planSegments(project);
  if (segments.length === 0) throw new Error('No segments to export.');

  onStatus?.('Preparing source media…');
  const uniqueAssetIds = new Set<string>();
  for (const seg of segments) {
    if (seg.videoLayer) uniqueAssetIds.add(seg.videoLayer.clip.assetId);
    if (seg.audioLayer) uniqueAssetIds.add(seg.audioLayer.clip.assetId);
  }
  const sourceAssets = [...uniqueAssetIds]
    .map((assetId) => assetById.get(assetId))
    .filter((asset): asset is MediaAsset => !!asset);
  let sourceMounted = false;
  if (sourceAssets.length > 0) {
    await mountSourceAssets(ffmpeg, sourceAssets);
    sourceMounted = true;
  }

  const segmentChunks: BlobPart[] = [];
  const temporaryFiles = new Set<string>();
  let concatMounted = false;
  let resetEncoder = false;
  let lastFfmpegProgress = 0;

  // ffmpeg progress is reported per-invocation; we scale each to its slice of total.
  const progressHandler = (p: { progress: number }) => {
    lastFfmpegProgress = Math.max(0, Math.min(1, p.progress));
  };
  ffmpeg.on('progress', progressHandler);

  try {
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]!;
      const segDuration = seg.endSec - seg.startSec;
      const outName = `seg_${String(i).padStart(4, '0')}.ts`;
      temporaryFiles.add(outName);
      onStatus?.(`Encoding segment ${i + 1}/${segments.length}`);

      const args: string[] = [];
      let videoInputIndex: number | null = null;
      let audioInputIndex: number | null = null;
      let nextIndex = 0;

      if (seg.videoLayer) {
        const asset = assetById.get(seg.videoLayer.clip.assetId);
        if (asset) {
          const startInSource = seg.videoLayer.clip.inSec
            + (seg.startSec - seg.videoLayer.clip.startSec) * clipSpeed(seg.videoLayer.clip);
          args.push('-ss', startInSource.toFixed(3));
          args.push('-t', segDuration.toFixed(3));
          args.push('-i', vfsNameForAsset(asset));
          videoInputIndex = nextIndex++;
        }
      }
      if (seg.audioLayer && (!seg.videoLayer || seg.audioLayer.clip.assetId !== seg.videoLayer.clip.assetId)) {
        const asset = assetById.get(seg.audioLayer.clip.assetId);
        if (asset) {
          const startInSource = seg.audioLayer.clip.inSec
            + (seg.startSec - seg.audioLayer.clip.startSec) * clipSpeed(seg.audioLayer.clip);
          args.push('-ss', startInSource.toFixed(3));
          args.push('-t', segDuration.toFixed(3));
          args.push('-i', vfsNameForAsset(asset));
          audioInputIndex = nextIndex++;
        }
      } else if (seg.audioLayer && seg.videoLayer && seg.audioLayer.clip.assetId === seg.videoLayer.clip.assetId) {
        // Audio comes from the same input as the video.
        audioInputIndex = videoInputIndex;
      }

      // If nothing is active, generate black + silence for this segment.
      if (videoInputIndex === null && audioInputIndex === null) {
        args.push('-f', 'lavfi', '-t', segDuration.toFixed(3),
          '-i', `color=c=black:s=${project.width}x${project.height}:r=${project.fps}`);
        args.push('-f', 'lavfi', '-t', segDuration.toFixed(3),
          '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
        videoInputIndex = 0;
        audioInputIndex = 1;
      } else {
        if (videoInputIndex === null) {
          args.push('-f', 'lavfi', '-t', segDuration.toFixed(3),
            '-i', `color=c=black:s=${project.width}x${project.height}:r=${project.fps}`);
          videoInputIndex = nextIndex++;
        }
        if (audioInputIndex === null) {
          args.push('-f', 'lavfi', '-t', segDuration.toFixed(3),
            '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
          audioInputIndex = nextIndex++;
        }
      }

      const vFilter = segmentVideoFilter(
        project.width,
        project.height,
        project.fps,
        seg.videoLayer?.clip ?? null,
        seg.startSec,
      );
      args.push('-map', `${videoInputIndex}:v:0`);
      args.push('-map', `${audioInputIndex}:a:0?`);
      args.push('-vf', vFilter);
      // Apply master volume + envelope to the mapped audio stream, if any.
      if (seg.audioLayer) {
        const aFilter = segmentAudioFilter(seg.audioLayer.clip, seg.startSec, seg.endSec);
        if (aFilter) args.push('-af', aFilter);
      }
      args.push('-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p');
      args.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2');
      args.push('-video_track_timescale', '90000');
      args.push('-muxdelay', '0', '-muxpreload', '0');
      args.push('-f', 'mpegts');
      args.push('-y', outName);

      lastFfmpegProgress = 0;
      await execOrThrow(ffmpeg, args, `segment ${i + 1}/${segments.length}`);
      const segmentData = (await ffmpeg.readFile(outName)) as Uint8Array;
      const segmentCopy = new Uint8Array(segmentData.byteLength);
      segmentCopy.set(segmentData);
      segmentChunks.push(segmentCopy.buffer);
      await ffmpeg.deleteFile(outName).catch(() => undefined);
      temporaryFiles.delete(outName);

      const overall = (i + lastFfmpegProgress) / segments.length;
      onProgress?.(Math.min(0.98, overall));
    }

    onStatus?.('Finalizing…');
    await unmountDir(ffmpeg, SOURCE_MOUNT_DIR);
    sourceMounted = false;

    const concatBlob = new Blob(segmentChunks, { type: 'video/mp2t' });
    segmentChunks.length = 0;
    const concatInput = await mountConcatSource(ffmpeg, concatBlob);
    concatMounted = true;

    const outputFile = 'output.mp4';
    temporaryFiles.add(outputFile);
    await execOrThrow(ffmpeg, [
      '-fflags', '+genpts',
      '-i', concatInput,
      '-c', 'copy',
      '-movflags', '+faststart',
      '-y', outputFile,
    ], 'final mux');

    const data = (await ffmpeg.readFile(outputFile)) as Uint8Array;
    onProgress?.(1);
    onStatus?.('Done');

    return new Blob([data.slice().buffer], { type: 'video/mp4' });
  } catch (error) {
    resetEncoder = isFfmpegMemoryError(error);
    throw new Error(exportErrorMessage(error));
  } finally {
    ffmpeg.off('progress', progressHandler);
    for (const file of temporaryFiles) {
      await ffmpeg.deleteFile(file).catch(() => undefined);
    }
    if (concatMounted) await unmountDir(ffmpeg, CONCAT_MOUNT_DIR);
    if (sourceMounted) await unmountDir(ffmpeg, SOURCE_MOUNT_DIR);
    if (resetEncoder) resetFFmpeg();
  }
}
