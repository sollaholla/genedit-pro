import { FFFSType } from '@ffmpeg/ffmpeg';
import type { Clip, MediaAsset, Project, Track } from '@/types';
import { getBlob } from '@/lib/media/storage';
import { clipSpeed, clipTimelineDurationSec, projectDurationSec } from '@/lib/timeline/operations';
import { evalEnvelopeAt } from '@/lib/timeline/envelope';
import { colorCorrectionFfmpegFiltersWithOptions } from '@/lib/components/colorCorrection';
import { getTransformComponents } from '@/lib/components/transform';
import { activeEditTransform } from '@/lib/media/editTrail';
import { getFFmpeg, resetFFmpeg } from './client';

const SOURCE_MOUNT_DIR = '/source-media';

type TimelineInput = {
  inputIndex: number;
  clip: Clip;
  track: Track;
  asset: MediaAsset;
  timelineDurationSec: number;
};

export type ExportCallbacks = {
  onStatus?: (message: string) => void;
  onProgress?: (value: number) => void;
  onLog?: (line: string) => void;
};

function seconds(value: number): string {
  return Math.max(0, value).toFixed(3);
}

function preciseSeconds(value: number): string {
  return Math.max(0, value).toFixed(5);
}

function filterNumber(value: number): string {
  const safeValue = Number.isFinite(value) ? value : 0;
  return safeValue.toFixed(5);
}

function clipEndSec(clip: Clip): number {
  return clip.startSec + clipTimelineDurationSec(clip);
}

function clipSourceDurationSec(clip: Clip): number {
  return Math.max(0.001, clip.outSec - clip.inSec);
}

function rangesOverlap(startA: number, endA: number, startB: number, endB: number): boolean {
  return startA < endB && startB < endA;
}

function betweenExpression(startSec: number, endSec: number): string {
  return `gte(t,${preciseSeconds(startSec)})*lt(t,${preciseSeconds(endSec)})`;
}

function keyframeExpression(
  points: Array<{ timeSec: number; value: number }>,
  fallback: number,
  localTimeExpr: string,
): string {
  if (points.length === 0) return filterNumber(fallback);
  const sorted = [...points].sort((first, second) => first.timeSec - second.timeSec);
  if (sorted.length === 1) return filterNumber(sorted[0]!.value);

  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  let expr = filterNumber(last.value);
  for (let index = sorted.length - 2; index >= 0; index -= 1) {
    const current = sorted[index]!;
    const next = sorted[index + 1]!;
    const duration = Math.max(1e-5, next.timeSec - current.timeSec);
    const segmentExpr = `${filterNumber(current.value)}+(${filterNumber(next.value - current.value)})*` +
      `(${localTimeExpr}-${filterNumber(current.timeSec)})/${filterNumber(duration)}`;
    expr = `if(lte(${localTimeExpr},${filterNumber(next.timeSec)}),${segmentExpr},${expr})`;
  }

  return `if(lte(${localTimeExpr},${filterNumber(first.timeSec)}),${filterNumber(first.value)},${expr})`;
}

function transformExpression(clip: Clip, property: 'scale' | 'offsetX' | 'offsetY', localTimeExpr: string): string {
  const components = getTransformComponents(clip);
  if (components.length === 0) return property === 'scale' ? '1.00000' : '0.00000';

  const expressions = components.map((component) => keyframeExpression(
    component.data.keyframes[property],
    component.data[property],
    localTimeExpr,
  ));

  if (property === 'scale') return expressions.map((expr) => `(${expr})`).join('*');
  return expressions.map((expr) => `(${expr})`).join('+');
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
    'The export now renders the timeline in one continuous pass to avoid segment-boundary skips.',
    'If this still happens, the timeline is too large for the in-browser encoder at the current resolution.',
  ].join(' ');
}

async function detectAssetAudioStreams(
  ffmpeg: Awaited<ReturnType<typeof getFFmpeg>>,
  assets: MediaAsset[],
): Promise<Map<string, boolean>> {
  const hasAudioByAssetId = new Map<string, boolean>();
  const probeLines: string[] = [];
  const probeLogHandler = ({ message }: { message: string }) => {
    probeLines.push(message);
  };

  ffmpeg.on('log', probeLogHandler);
  try {
    for (const asset of assets) {
      if (asset.kind === 'audio') {
        hasAudioByAssetId.set(asset.id, true);
        continue;
      }
      if (asset.kind !== 'video') {
        hasAudioByAssetId.set(asset.id, false);
        continue;
      }

      probeLines.length = 0;
      await ffmpeg.exec(['-hide_banner', '-i', vfsNameForAsset(asset)]).catch(() => undefined);
      hasAudioByAssetId.set(asset.id, probeLines.some((line) => /Stream #\d+:\d+.*Audio:/i.test(line)));
    }
  } finally {
    ffmpeg.off('log', probeLogHandler);
  }

  return hasAudioByAssetId;
}

async function detectFfmpegFilterSupport(
  ffmpeg: Awaited<ReturnType<typeof getFFmpeg>>,
  filterName: string,
): Promise<boolean> {
  const filterLines: string[] = [];
  const filterLogHandler = ({ message }: { message: string }) => {
    filterLines.push(message);
  };

  ffmpeg.on('log', filterLogHandler);
  try {
    const code = await ffmpeg.exec(['-hide_banner', '-filters']);
    if (code !== 0) return false;
    return filterLines.some((line) => new RegExp(`\\b${filterName}\\b`).test(line));
  } finally {
    ffmpeg.off('log', filterLogHandler);
  }
}

function timelineVisualFilters(
  input: TimelineInput,
  project: Project,
  supportsPerChannelColor: boolean,
): { filters: string; overlayX: string; overlayY: string } {
  const { clip, asset } = input;
  const mediaTransform = activeEditTransform(asset);
  const localOverlayTimeExpr = `(t-${preciseSeconds(clip.startSec)})`;
  const rawScaleExpr = transformExpression(clip, 'scale', 't');
  const visualScaleExpr = `min(6,max(0.1,(${rawScaleExpr})*${filterNumber(mediaTransform.scale)}))`;
  const offsetXExpr = `(${transformExpression(clip, 'offsetX', localOverlayTimeExpr)})+${filterNumber(mediaTransform.offsetX)}`;
  const offsetYExpr = `(${transformExpression(clip, 'offsetY', localOverlayTimeExpr)})+${filterNumber(mediaTransform.offsetY)}`;
  const filters: string[] = ['setsar=1', 'settb=AVTB'];

  if (asset.kind !== 'image') {
    const speed = clipSpeed(clip);
    filters.push(Math.abs(speed - 1) > 0.001
      ? `setpts=(PTS-STARTPTS)/${speed.toFixed(5)}`
      : 'setpts=PTS-STARTPTS');
  }

  filters.push(
    `scale=eval=frame:w='trunc(iw*${visualScaleExpr}/2)*2':h='trunc(ih*${visualScaleExpr}/2)*2'`,
  );

  filters.push(
    ...colorCorrectionFfmpegFiltersWithOptions(clip, clip.startSec, { perChannel: supportsPerChannelColor }),
    `fps=${project.fps}`,
    `trim=duration=${seconds(input.timelineDurationSec)}`,
    `setpts=PTS-STARTPTS+${preciseSeconds(clip.startSec)}/TB`,
    'format=rgba',
  );

  return {
    filters: filters.join(','),
    overlayX: `(W-w)/2+${offsetXExpr}`,
    overlayY: `(H-h)/2+${offsetYExpr}`,
  };
}

function visualEnableExpression(input: TimelineInput, visualInputs: TimelineInput[]): string {
  const inputStart = input.clip.startSec;
  const inputEnd = clipEndSec(input.clip);
  const activeExpression = betweenExpression(inputStart, inputEnd);
  const higherTrackExpressions = visualInputs
    .filter((candidate) => (
      candidate !== input &&
      candidate.track.index < input.track.index &&
      rangesOverlap(inputStart, inputEnd, candidate.clip.startSec, clipEndSec(candidate.clip))
    ))
    .map((candidate) => betweenExpression(candidate.clip.startSec, clipEndSec(candidate.clip)));

  if (higherTrackExpressions.length === 0) return activeExpression;
  return `${activeExpression}*not(${higherTrackExpressions.join('+')})`;
}

function timelineAudioVolumeFilter(clip: Clip, segStartSec: number, segEndSec: number): string | null {
  const master = clip.volume ?? 1;
  const env = clip.volumeEnvelope;
  const hasEnv = !!env && env.enabled && env.points.length >= 2;

  if (!hasEnv) {
    if (Math.abs(master - 1) < 1e-4) return null;
    return `volume=${master.toFixed(4)}`;
  }

  const clipDur = Math.max(1e-6, clip.outSec - clip.inSec);
  const segDur = Math.max(1e-6, segEndSec - segStartSec);
  const sampleCount = 24;
  const samples: { timeSec: number; volume: number }[] = [];
  for (let index = 0; index <= sampleCount; index += 1) {
    const tau = (index / sampleCount) * segDur;
    const sourceTime = clip.inSec + (segStartSec - clip.startSec + tau) * clipSpeed(clip);
    const localTime = Math.max(0, Math.min(1, (sourceTime - clip.inSec) / clipDur));
    const envelopeVolume = evalEnvelopeAt(env, localTime);
    samples.push({ timeSec: tau, volume: Math.max(0, master * envelopeVolume) });
  }

  let expr = samples[sampleCount]!.volume.toFixed(5);
  for (let index = sampleCount - 1; index >= 0; index -= 1) {
    const current = samples[index]!;
    const next = samples[index + 1]!;
    const startTime = current.timeSec.toFixed(5);
    const duration = Math.max(1e-5, next.timeSec - current.timeSec).toFixed(5);
    const startVolume = current.volume.toFixed(5);
    const volumeDelta = (next.volume - current.volume).toFixed(5);
    expr = `if(lt(t,${next.timeSec.toFixed(5)}),${startVolume}+(${volumeDelta})*(t-${startTime})/${duration},${expr})`;
  }

  return `volume=eval=frame:volume='${expr}'`;
}

function atempoFilters(speed: number): string[] {
  const filters: string[] = [];
  let remainingSpeed = Math.max(0.25, Math.min(4, speed));
  while (remainingSpeed > 2) {
    filters.push('atempo=2');
    remainingSpeed /= 2;
  }
  while (remainingSpeed < 0.5) {
    filters.push('atempo=0.5');
    remainingSpeed /= 0.5;
  }
  if (Math.abs(remainingSpeed - 1) > 0.001) filters.push(`atempo=${remainingSpeed.toFixed(5)}`);
  return filters;
}

function buildTimelineFilterGraph(
  project: Project,
  totalDurationSec: number,
  visualInputs: TimelineInput[],
  audioInputs: TimelineInput[],
  backgroundInputIndex: number,
  silenceInputIndex: number | null,
  supportsPerChannelColor: boolean,
): string {
  const parts: string[] = [
    `[${backgroundInputIndex}:v]trim=duration=${seconds(totalDurationSec)},settb=AVTB,setpts=PTS-STARTPTS,format=rgba[base0]`,
  ];

  const visualStack = [...visualInputs].sort((first, second) => second.track.index - first.track.index);
  let baseLabel = 'base0';
  visualStack.forEach((input, index) => {
    const visual = timelineVisualFilters(input, project, supportsPerChannelColor);
    const layerLabel = `v${index}`;
    const nextBaseLabel = `base${index + 1}`;
    const enable = visualEnableExpression(input, visualInputs);
    parts.push(`[${input.inputIndex}:v:0]${visual.filters}[${layerLabel}]`);
    parts.push(
      `[${baseLabel}][${layerLabel}]overlay=x='${visual.overlayX}':y='${visual.overlayY}':` +
      `enable='${enable}':eof_action=pass:repeatlast=0:shortest=0[${nextBaseLabel}]`,
    );
    baseLabel = nextBaseLabel;
  });
  parts.push(`[${baseLabel}]format=yuv420p[vout]`);

  const audioLabels: string[] = [];
  audioInputs.forEach((input, index) => {
    const clip = input.clip;
    const delayMs = Math.max(0, Math.round(clip.startSec * 1000));
    const filters = [
      'aresample=48000',
      'asetpts=PTS-STARTPTS',
      ...atempoFilters(clipSpeed(clip)),
      `atrim=duration=${seconds(input.timelineDurationSec)}`,
    ];
    const volumeFilter = timelineAudioVolumeFilter(clip, clip.startSec, clipEndSec(clip));
    if (volumeFilter) filters.push(volumeFilter);
    filters.push('aformat=sample_rates=48000:channel_layouts=stereo');
    filters.push(`adelay=${delayMs}|${delayMs}`);
    filters.push('apad');
    filters.push(`atrim=duration=${seconds(totalDurationSec)}`);
    const label = `a${index}`;
    parts.push(`[${input.inputIndex}:a:0]${filters.join(',')}[${label}]`);
    audioLabels.push(label);
  });

  if (audioLabels.length === 0 && silenceInputIndex !== null) {
    parts.push(
      `[${silenceInputIndex}:a]atrim=duration=${seconds(totalDurationSec)},asetpts=PTS-STARTPTS,` +
      'aformat=sample_rates=48000:channel_layouts=stereo[aout]',
    );
  } else if (audioLabels.length === 1) {
    parts.push(`[${audioLabels[0]}]anull[aout]`);
  } else {
    parts.push(
      `${audioLabels.map((label) => `[${label}]`).join('')}` +
      `amix=inputs=${audioLabels.length}:duration=longest:normalize=0,` +
      `atrim=duration=${seconds(totalDurationSec)},` +
      'alimiter=limit=0.98,aformat=sample_rates=48000:channel_layouts=stereo[aout]',
    );
  }

  return parts.join(';');
}

function shouldRenderVisual(input: TimelineInput): boolean {
  return input.track.kind === 'video' && !input.track.hidden && input.asset.kind !== 'audio';
}

function shouldRenderAudio(input: TimelineInput, hasAudioByAssetId: Map<string, boolean>): boolean {
  if (input.asset.kind === 'image') return false;
  if (!hasAudioByAssetId.get(input.asset.id)) return false;
  if (input.track.kind === 'audio') return !input.track.muted;
  return input.track.kind === 'video' && !input.track.hidden;
}

export async function exportProject(
  project: Project,
  assets: MediaAsset[],
  callbacks: ExportCallbacks = {},
): Promise<Blob> {
  const { onStatus, onProgress, onLog } = callbacks;
  const totalDuration = projectDurationSec(project);
  if (totalDuration <= 0) throw new Error('Timeline is empty. Add at least one clip to export.');

  onStatus?.('Loading encoder...');
  const recentLogs: string[] = [];
  const ffmpeg = await getFFmpeg();

  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  const tracksById = new Map(project.tracks.map((track) => [track.id, track]));
  const sourceAssetsById = new Map<string, MediaAsset>();
  for (const clip of project.clips) {
    const asset = assetById.get(clip.assetId);
    const track = tracksById.get(clip.trackId);
    if (asset && track) sourceAssetsById.set(asset.id, asset);
  }
  const sourceAssets = [...sourceAssetsById.values()];

  let sourceMounted = false;
  const temporaryFiles = new Set<string>();
  let resetEncoder = false;

  const logHandler = ({ message }: { message: string }) => {
    recentLogs.push(message);
    if (recentLogs.length > 40) recentLogs.shift();
    onLog?.(message);
  };
  const progressHandler = (progressEvent: { progress: number }) => {
    onProgress?.(Math.min(0.98, Math.max(0, progressEvent.progress) * 0.98));
  };

  try {
    onStatus?.('Preparing source media...');
    if (sourceAssets.length > 0) {
      await mountSourceAssets(ffmpeg, sourceAssets);
      sourceMounted = true;
    }

    onStatus?.('Inspecting audio streams...');
    const hasAudioByAssetId = await detectAssetAudioStreams(ffmpeg, sourceAssets);
    const supportsPerChannelColor = await detectFfmpegFilterSupport(ffmpeg, 'lutrgb');

    const args: string[] = [];
    const timelineInputs: TimelineInput[] = [];
    let nextInputIndex = 0;

    for (const clip of project.clips) {
      const track = tracksById.get(clip.trackId);
      const asset = assetById.get(clip.assetId);
      if (!track || !asset) continue;

      const timelineDurationSec = clipTimelineDurationSec(clip);
      if (asset.kind === 'image') {
        args.push('-loop', '1', '-framerate', String(project.fps), '-t', seconds(timelineDurationSec));
      } else {
        args.push('-ss', seconds(clip.inSec), '-t', seconds(clipSourceDurationSec(clip)));
      }
      args.push('-i', vfsNameForAsset(asset));
      timelineInputs.push({
        inputIndex: nextInputIndex,
        clip,
        track,
        asset,
        timelineDurationSec,
      });
      nextInputIndex += 1;
    }

    args.push('-f', 'lavfi', '-t', seconds(totalDuration),
      '-i', `color=c=black:s=${project.width}x${project.height}:r=${project.fps}`);
    const backgroundInputIndex = nextInputIndex;
    nextInputIndex += 1;

    const visualInputs = timelineInputs.filter(shouldRenderVisual);
    const audioInputs = timelineInputs.filter((input) => shouldRenderAudio(input, hasAudioByAssetId));

    let silenceInputIndex: number | null = null;
    if (audioInputs.length === 0) {
      args.push('-f', 'lavfi', '-t', seconds(totalDuration),
        '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
      silenceInputIndex = nextInputIndex;
      nextInputIndex += 1;
    }

    const outputFile = 'output.mp4';
    temporaryFiles.add(outputFile);

    args.push('-filter_complex', buildTimelineFilterGraph(
      project,
      totalDuration,
      visualInputs,
      audioInputs,
      backgroundInputIndex,
      silenceInputIndex,
      supportsPerChannelColor,
    ));
    args.push('-map', '[vout]', '-map', '[aout]');
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-r', String(project.fps));
    args.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2');
    args.push('-t', seconds(totalDuration), '-video_track_timescale', '90000');
    args.push('-movflags', '+faststart', '-y', outputFile);

    ffmpeg.on('progress', progressHandler);
    ffmpeg.on('log', logHandler);
    onStatus?.('Rendering timeline...');
    await execOrThrow(ffmpeg, args, 'timeline render', recentLogs);

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
    if (sourceMounted) await unmountDir(ffmpeg, SOURCE_MOUNT_DIR);
    if (resetEncoder) resetFFmpeg();
  }
}