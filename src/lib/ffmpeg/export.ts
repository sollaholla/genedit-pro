import { FFFSType } from '@ffmpeg/ffmpeg';
import type { Clip, MediaAsset, Project, Track } from '@/types';
import { getBlob } from '@/lib/media/storage';
import { clipSpeed, clipTimelineDurationSec, projectDurationSec } from '@/lib/timeline/operations';
import { resolveFrame } from '@/lib/playback/engine';
import { evalEnvelopeAt } from '@/lib/timeline/envelope';
import { colorCorrectionFfmpegFilters } from '@/lib/components/colorCorrection';
import { resolveTransformAtTime } from '@/lib/components/transform';
import { activeEditTransform } from '@/lib/media/editTrail';
import { getFFmpeg, resetFFmpeg } from './client';

const SOURCE_MOUNT_DIR = '/source-media';
const CONCAT_MOUNT_DIR = '/concat-media';

type Segment = {
  index: number;
  startSec: number;
  endSec: number;
  videoLayers: { clip: Clip; track: Track }[];
  audioLayers: { clip: Clip; track: Track }[];
};

type SegmentInput = {
  inputIndex: number;
  layer: { clip: Clip; track: Track };
  asset: MediaAsset;
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
      videoLayers: frame.videos.map((layer) => ({ clip: layer.clip, track: layer.track })),
      audioLayers: frame.audios.map((layer) => ({ clip: layer.clip, track: layer.track })),
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
  recentLogs: string[],
): Promise<void> {
  const code = await ffmpeg.exec(args);
  if (code !== 0) {
    const tail = recentLogs.slice(-8).join('\n');
    throw new Error([
      `FFmpeg ${label} failed with exit code ${code}.`,
      tail ? `Last encoder log:\n${tail}` : '',
      `Command: ffmpeg ${args.join(' ')}`,
    ].filter(Boolean).join('\n'));
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

function segmentVisualFilters(
  fps: number,
  clip: Clip,
  asset: MediaAsset,
  timelineTimeSec: number,
  segDuration: number,
): { filters: string; overlayX: string; overlayY: string } {
  const transform = resolveTransformAtTime(clip, timelineTimeSec);
  const mediaTransform = activeEditTransform(asset);
  const scale = Math.max(0.1, Math.min(6, (transform.scale ?? clip.scale ?? 1) * mediaTransform.scale));
  const offsetX = transform.offsetX + mediaTransform.offsetX;
  const offsetY = transform.offsetY + mediaTransform.offsetY;
  const filters: string[] = [
    'setsar=1',
  ];

  if (asset.kind !== 'image') {
    const speed = clipSpeed(clip);
    const setpts = Math.abs(speed - 1) > 0.001 ? `setpts=(PTS-STARTPTS)/${speed.toFixed(5)}` : 'setpts=PTS-STARTPTS';
    filters.push(setpts);
  }

  if (Math.abs(scale - 1) > 0.001) {
    const scaleExpr = scale.toFixed(5);
    filters.push(`scale=w=trunc(iw*${scaleExpr}/2)*2:h=trunc(ih*${scaleExpr}/2)*2`);
  }

  filters.push(
    ...colorCorrectionFfmpegFilters(clip, timelineTimeSec),
    `fps=${fps}`,
    `trim=duration=${segDuration.toFixed(3)}`,
    'setpts=PTS-STARTPTS',
    'format=rgba',
  );

  return {
    filters: filters.join(','),
    overlayX: `(W-w)/2${offsetX >= 0 ? '+' : ''}${offsetX.toFixed(2)}`,
    overlayY: `(H-h)/2${offsetY >= 0 ? '+' : ''}${offsetY.toFixed(2)}`,
  };
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

function atempoFilters(speed: number): string[] {
  const filters: string[] = [];
  let remaining = Math.max(0.25, Math.min(4, speed));
  while (remaining > 2) {
    filters.push('atempo=2');
    remaining /= 2;
  }
  while (remaining < 0.5) {
    filters.push('atempo=0.5');
    remaining /= 0.5;
  }
  if (Math.abs(remaining - 1) > 0.001) filters.push(`atempo=${remaining.toFixed(5)}`);
  return filters;
}

function buildSegmentFilterGraph(
  project: Project,
  seg: Segment,
  videoInputs: SegmentInput[],
  audioInputs: SegmentInput[],
  backgroundInputIndex: number,
  silenceInputIndex: number | null,
): string {
  const segDuration = seg.endSec - seg.startSec;
  const parts: string[] = [
    `[${backgroundInputIndex}:v]trim=duration=${segDuration.toFixed(3)},setpts=PTS-STARTPTS,format=rgba[base0]`,
  ];

  const visualStack = [...videoInputs].sort((a, b) => b.layer.track.index - a.layer.track.index);
  let baseLabel = 'base0';
  visualStack.forEach((input, index) => {
    const visual = segmentVisualFilters(
      project.fps,
      input.layer.clip,
      input.asset,
      seg.startSec,
      segDuration,
    );
    const layerLabel = `v${index}`;
    const nextBaseLabel = `base${index + 1}`;
    parts.push(`[${input.inputIndex}:v:0]${visual.filters}[${layerLabel}]`);
    parts.push(
      `[${baseLabel}][${layerLabel}]overlay=x='${visual.overlayX}':y='${visual.overlayY}':eof_action=pass:shortest=0[${nextBaseLabel}]`,
    );
    baseLabel = nextBaseLabel;
  });
  parts.push(`[${baseLabel}]format=yuv420p[vout]`);

  const audioLabels: string[] = [];
  audioInputs.forEach((input, index) => {
    const clip = input.layer.clip;
    const filters = [
      'aresample=48000',
      'asetpts=PTS-STARTPTS',
      ...atempoFilters(clipSpeed(clip)),
      `atrim=duration=${segDuration.toFixed(3)}`,
    ];
    const volumeFilter = segmentAudioFilter(clip, seg.startSec, seg.endSec);
    if (volumeFilter) filters.push(volumeFilter);
    filters.push('aformat=sample_rates=48000:channel_layouts=stereo');
    filters.push('apad');
    filters.push(`atrim=duration=${segDuration.toFixed(3)}`);
    const label = `a${index}`;
    parts.push(`[${input.inputIndex}:a:0]${filters.join(',')}[${label}]`);
    audioLabels.push(label);
  });

  if (audioLabels.length === 0 && silenceInputIndex !== null) {
    parts.push(
      `[${silenceInputIndex}:a]atrim=duration=${segDuration.toFixed(3)},asetpts=PTS-STARTPTS,` +
      'aformat=sample_rates=48000:channel_layouts=stereo[aout]',
    );
  } else if (audioLabels.length === 1) {
    parts.push(`[${audioLabels[0]}]anull[aout]`);
  } else {
    parts.push(
      `${audioLabels.map((label) => `[${label}]`).join('')}` +
      `amix=inputs=${audioLabels.length}:duration=longest:normalize=0,` +
      'alimiter=limit=0.98,aformat=sample_rates=48000:channel_layouts=stereo[aout]',
    );
  }

  return parts.join(';');
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
  const recentLogs: string[] = [];
  const ffmpeg = await getFFmpeg();

  const assetById = new Map(assets.map((a) => [a.id, a]));
  const segments = planSegments(project);
  if (segments.length === 0) throw new Error('No segments to export.');

  onStatus?.('Preparing source media…');
  const uniqueAssetIds = new Set<string>();
  for (const seg of segments) {
    for (const layer of seg.videoLayers) uniqueAssetIds.add(layer.clip.assetId);
    for (const layer of seg.audioLayers) uniqueAssetIds.add(layer.clip.assetId);
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
  const logHandler = ({ message }: { message: string }) => {
    recentLogs.push(message);
    if (recentLogs.length > 40) recentLogs.shift();
    onLog?.(message);
  };
  ffmpeg.on('progress', progressHandler);
  ffmpeg.on('log', logHandler);

  try {
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]!;
      const segDuration = seg.endSec - seg.startSec;
      const outName = `seg_${String(i).padStart(4, '0')}.ts`;
      temporaryFiles.add(outName);
      onStatus?.(`Encoding segment ${i + 1}/${segments.length}`);

      const args: string[] = [];
      const inputByClipId = new Map<string, SegmentInput>();
      const videoInputs: SegmentInput[] = [];
      const audioInputs: SegmentInput[] = [];
      let nextIndex = 0;

      const addClipInput = (layer: { clip: Clip; track: Track }): SegmentInput | null => {
        const existing = inputByClipId.get(layer.clip.id);
        if (existing) return existing;
        const asset = assetById.get(layer.clip.assetId);
        if (!asset) return null;
        const speed = clipSpeed(layer.clip);
        const startInSource = layer.clip.inSec + (seg.startSec - layer.clip.startSec) * speed;
        if (asset.kind === 'image') {
          args.push('-loop', '1');
          args.push('-framerate', String(project.fps));
          args.push('-t', segDuration.toFixed(3));
        } else {
          args.push('-ss', startInSource.toFixed(3));
          args.push('-t', (segDuration * speed).toFixed(3));
        }
        args.push('-i', vfsNameForAsset(asset));
        const input = { inputIndex: nextIndex++, layer, asset };
        inputByClipId.set(layer.clip.id, input);
        return input;
      };

      for (const layer of seg.videoLayers) {
        const input = addClipInput(layer);
        if (input && input.asset.kind !== 'audio') videoInputs.push(input);
      }
      for (const layer of seg.audioLayers) {
        const input = addClipInput(layer);
        if (input && input.asset.kind !== 'image') audioInputs.push(input);
      }

      args.push('-f', 'lavfi', '-t', segDuration.toFixed(3),
        '-i', `color=c=black:s=${project.width}x${project.height}:r=${project.fps}`);
      const backgroundInputIndex = nextIndex++;

      let silenceInputIndex: number | null = null;
      if (audioInputs.length === 0) {
        args.push('-f', 'lavfi', '-t', segDuration.toFixed(3),
          '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
        silenceInputIndex = nextIndex++;
      }

      args.push('-filter_complex', buildSegmentFilterGraph(
        project,
        seg,
        videoInputs,
        audioInputs,
        backgroundInputIndex,
        silenceInputIndex,
      ));
      args.push('-map', '[vout]');
      args.push('-map', '[aout]');
      args.push('-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p');
      args.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2');
      args.push('-t', segDuration.toFixed(3));
      args.push('-video_track_timescale', '90000');
      args.push('-muxdelay', '0', '-muxpreload', '0');
      args.push('-f', 'mpegts');
      args.push('-y', outName);

      lastFfmpegProgress = 0;
      await execOrThrow(ffmpeg, args, `segment ${i + 1}/${segments.length}`, recentLogs);
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
    ], 'final mux', recentLogs);

    const data = (await ffmpeg.readFile(outputFile)) as Uint8Array;
    onProgress?.(1);
    onStatus?.('Done');

    return new Blob([data.slice().buffer], { type: 'video/mp4' });
  } catch (error) {
    resetEncoder = isFfmpegMemoryError(error);
    throw new Error(exportErrorMessage(error));
  } finally {
    ffmpeg.off('progress', progressHandler);
    ffmpeg.off('log', logHandler);
    for (const file of temporaryFiles) {
      await ffmpeg.deleteFile(file).catch(() => undefined);
    }
    if (concatMounted) await unmountDir(ffmpeg, CONCAT_MOUNT_DIR);
    if (sourceMounted) await unmountDir(ffmpeg, SOURCE_MOUNT_DIR);
    if (resetEncoder) resetFFmpeg();
  }
}
