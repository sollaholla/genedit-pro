import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, Clapperboard, ExternalLink, Film, GripVertical, Sparkles, X } from 'lucide-react';
import type { Clip, GenerateRecipe, MediaAsset, Project } from '@/types';
import { addClipWithTiming } from '@/lib/timeline/operations';
import { formatTimecode } from '@/lib/timeline/geometry';
import {
  extractBridgeEndpointFrames,
  matchBridgeFrames,
  planBridgeReferenceSegments,
  seedanceDurationForGap,
  sourceEndFrameTimeSec,
  sourceStartFrameTimeSec,
  type BridgeFrameMatch,
} from '@/lib/videoGeneration/bridge';
import { hostLitterboxFile } from '@/lib/videoGeneration/litterbox';
import { downloadGeneratedVideoFile } from '@/lib/videoGeneration/download';
import {
  createPiApiVideoTask,
  generatedPiApiVideoFromTask,
  PIAPI_ARTIFACT_TTL_MS,
  PIAPI_BILLING_URL,
  pollPiApiVideoTask,
} from '@/lib/videoGeneration/piapi';
import { VideoGenerationProviderError } from '@/lib/videoGeneration/errors';
import { PIAPI_SEEDANCE_2_MODEL_ID, type Aspect } from '@/lib/videoModels/capabilities';
import { piApiUsageCostUsd } from '@/lib/piapi/usage';
import {
  PIAPI_API_KEY_STORAGE,
  PIAPI_KLING_API_KEY_STORAGE,
  PIAPI_VEO_API_KEY_STORAGE,
} from '@/lib/settings/connectionStorage';
import { decryptSecret } from '@/lib/settings/crypto';
import { useMediaStore } from '@/state/mediaStore';
import { useProjectStore } from '@/state/projectStore';

export type BridgeGap = {
  trackId: string;
  startSec: number;
  endSec: number;
  durationSec: number;
  leftClip: Clip;
  rightClip: Clip;
};

type Props = {
  gap: BridgeGap;
  onClose: () => void;
  onOpenSettings: () => void;
  onHighlightMediaAsset: (assetId: string) => void;
};

const RESOLUTION_OPTIONS = ['480p', '720p', '1080p'] as const;
const DURATION_OPTIONS = [5, 10, 15] as const;
type DurationMode = 'auto' | 'manual';

export function BridgeGenerateDialog({ gap, onClose, onOpenSettings, onHighlightMediaAsset }: Props) {
  const project = useProjectStore((s) => s.project);
  const updateProject = useProjectStore((s) => s.update);
  const assets = useMediaStore((s) => s.assets);
  const addGeneratedAsset = useMediaStore((s) => s.addGeneratedAsset);
  const updateGenerationProgress = useMediaStore((s) => s.updateGenerationProgress);
  const updateGenerationTask = useMediaStore((s) => s.updateGenerationTask);
  const finalizeGeneratedAssetWithBlob = useMediaStore((s) => s.finalizeGeneratedAssetWithBlob);
  const failGeneratedAsset = useMediaStore((s) => s.failGeneratedAsset);
  const leftAsset = assets.find((asset) => asset.id === gap.leftClip.assetId) ?? null;
  const rightAsset = assets.find((asset) => asset.id === gap.rightClip.assetId) ?? null;
  const [prompt, setPrompt] = useState(() => defaultBridgePrompt(gap));
  const [resolution, setResolution] = useState<(typeof RESOLUTION_OPTIONS)[number]>('720p');
  const [durationMode, setDurationMode] = useState<DurationMode>('auto');
  const [manualDurationSec, setManualDurationSec] = useState(seedanceDurationForGap(gap.durationSec));
  const [working, setWorking] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fitAssetId, setFitAssetId] = useState<string | null>(null);
  const [lastMatch, setLastMatch] = useState<BridgeFrameMatch | null>(null);

  const aspect = useMemo(() => aspectForProject(project), [project]);
  const autoDurationSec = useMemo(() => seedanceDurationForGap(gap.durationSec), [gap.durationSec]);
  const durationSec = durationMode === 'auto' ? autoDurationSec : manualDurationSec;
  const estimatedCostUsd = useMemo(() => estimateSeedanceCostUsd(resolution, durationSec), [durationSec, resolution]);
  const fitAsset = fitAssetId ? assets.find((asset) => asset.id === fitAssetId) ?? null : null;
  const referencePlan = useMemo(
    () => planBridgeReferenceSegments(gap.leftClip, gap.rightClip, leftAsset?.durationSec, rightAsset?.durationSec),
    [gap.leftClip, gap.rightClip, leftAsset?.durationSec, rightAsset?.durationSec],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !working) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, working]);

  const insertBridgeClip = useCallback((asset: MediaAsset, inSec: number, outSec: number) => {
    updateProject((current) => addClipWithTiming(current, asset, gap.trackId, {
      startSec: gap.startSec,
      inSec,
      outSec,
      timelineDurationSec: gap.durationSec,
    }));
  }, [gap.durationSec, gap.startSec, gap.trackId, updateProject]);

  const generate = async () => {
    setError(null);
    setLastMatch(null);
    if (!leftAsset || !rightAsset) {
      setError('Both neighboring video clips must still be available in the media bin.');
      return;
    }
    const apiKey = await readPiApiKey();
    if (!apiKey) {
      setError('Connect PiAPI in Settings before generating.');
      return;
    }

    setWorking(true);
    const assetId = addGeneratedAsset(
      `Bridge_${Date.now()}.mp4`,
      null,
      estimatedCostUsd,
      bridgeRecipe({ prompt, aspect, resolution, durationSec, leftAsset, rightAsset }),
    );
    let actualCostUsd: number | undefined = estimatedCostUsd;
    let taskAccepted = false;

    try {
      updateGenerationProgress(assetId, 2);
      setStatus('Preparing start/end frames...');
      const [startFrameReference, endFrameReference] = await extractBridgeEndpointFrames({
        leftAsset,
        leftClip: gap.leftClip,
        rightAsset,
        rightClip: gap.rightClip,
        fps: project.fps,
        onStatus: setStatus,
      });
      updateGenerationProgress(assetId, 14);

      setStatus('Uploading start/end frames...');
      const startFrameUrl = await hostLitterboxFile(startFrameReference.file);
      updateGenerationProgress(assetId, 22);
      const endFrameUrl = await hostLitterboxFile(endFrameReference.file);
      updateGenerationProgress(assetId, 30);

      const request = {
        body: {
          model: 'seedance',
          task_type: 'seedance-2',
          input: {
            prompt: seedanceBridgeFramePrompt(prompt),
            mode: 'omni_reference',
            duration: durationSec,
            resolution,
            aspect_ratio: aspect,
            image_urls: [startFrameUrl, endFrameUrl],
          },
          config: {
            service_mode: 'public',
          },
        },
      };
      if (import.meta.env.DEV) {
        console.debug('[GenEdit] Seedance bridge request', request.body);
      }

      setStatus('Generating bridge...');
      const initialTask = await createPiApiVideoTask(request, { apiKey });
      if (!initialTask.task_id) throw new VideoGenerationProviderError('InternalError', 'PiAPI did not return a task id.');
      taskAccepted = true;
      onHighlightMediaAsset(assetId);
      updateGenerationTask(assetId, {
        provider: 'piapi',
        providerTaskId: initialTask.task_id,
        providerTaskEndpoint: `/api/v1/task/${initialTask.task_id}`,
        providerTaskStatus: initialTask.status,
        providerTaskCreatedAt: Date.now(),
      });

      const finalTask = await pollPiApiVideoTask({
        credentials: { apiKey },
        initialTask,
        onProgress: (progress) => updateGenerationProgress(assetId, Math.max(30, progress)),
      });
      actualCostUsd = piApiUsageCostUsd(finalTask) ?? estimatedCostUsd;
      updateGenerationTask(assetId, {
        provider: 'piapi',
        providerTaskId: finalTask.task_id ?? initialTask.task_id,
        providerTaskEndpoint: `/api/v1/task/${finalTask.task_id ?? initialTask.task_id}`,
        providerTaskStatus: finalTask.status,
      });
      const generatedVideo = generatedPiApiVideoFromTask(finalTask);
      if (!generatedVideo.url) throw new VideoGenerationProviderError('InternalError', 'No generated video URL returned by PiAPI.');

      setStatus('Downloading bridge...');
      const file = await downloadGeneratedVideoFile(generatedVideo.url, (progress) => updateGenerationProgress(assetId, progress));
      await finalizeGeneratedAssetWithBlob(assetId, file, {
        actualCostUsd,
        provider: 'piapi',
        providerArtifactUri: generatedVideo.url,
        providerArtifactExpiresAt: Date.now() + PIAPI_ARTIFACT_TTL_MS,
      });

      const generatedAsset = useMediaStore.getState().assets.find((asset) => asset.id === assetId);
      if (!generatedAsset) throw new Error('Generated bridge asset was not saved.');

      setStatus('Fitting bridge...');
      const match = await matchBridgeFrames({
        generatedFile: file,
        leftAsset,
        leftClip: gap.leftClip,
        rightAsset,
        rightClip: gap.rightClip,
        fps: project.fps,
        onStatus: setStatus,
      }).catch((scanError) => {
        if (import.meta.env.DEV) console.warn('[GenEdit] Bridge frame scan failed', scanError);
        return null;
      });
      setLastMatch(match);
      if (match) {
        insertBridgeClip(generatedAsset, match.inSec, match.outSec);
        onClose();
        return;
      }

      setFitAssetId(assetId);
    } catch (err) {
      const message = formatBridgeGenerationError(err);
      failGeneratedAsset(assetId, {
        actualCostUsd,
        errorMessage: message,
        errorType: err instanceof VideoGenerationProviderError ? err.type : 'InternalError',
      });
      if (!taskAccepted) setError(message);
      else setError(message);
    } finally {
      setWorking(false);
      setStatus('');
    }
  };

  if (fitAsset) {
    return (
      <TimelineFittingModal
        gap={gap}
        asset={fitAsset}
        leftAsset={leftAsset}
        rightAsset={rightAsset}
        lastMatch={lastMatch}
        onCancel={() => {
          onHighlightMediaAsset(fitAsset.id);
          onClose();
        }}
        onConfirm={(placement) => {
          updateProject((current) => addClipWithTiming(current, fitAsset, gap.trackId, placement));
          onClose();
        }}
      />
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (!working && event.target === event.currentTarget) onClose();
      }}
    >
      <div className="w-[min(760px,94vw)] overflow-hidden rounded-lg border border-white/15 bg-surface-950 text-slate-100 shadow-2xl">
        <div className="flex items-center justify-between border-b border-surface-700 px-4 py-3">
          <div className="flex min-w-0 items-center gap-2 text-sm font-semibold">
            <Sparkles size={16} className="text-brand-400" />
            Bridge Generate
          </div>
          <button
            type="button"
            className="rounded-md p-1 text-slate-400 hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
            disabled={working}
            onClick={onClose}
            title="Close"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="space-y-3 p-4">
          <div className="grid grid-cols-[1fr_auto_1fr] items-stretch gap-2">
            <BridgeEndpoint
              asset={leftAsset}
              clip={gap.leftClip}
              label="Start frame"
              edge="end"
              fps={project.fps}
              contextStartSec={referencePlan.leftStartSec}
              contextDurationSec={referencePlan.leftDurationSec}
              holdSec={referencePlan.leftPadStartSec}
            />
            <div className="flex min-w-[112px] flex-col items-center justify-center rounded-md border border-brand-400/30 bg-brand-500/10 px-3 text-center">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-brand-400">Gap</div>
              <div className="font-mono text-xs text-slate-100">{formatTimecode(gap.durationSec, project.fps)}</div>
            </div>
            <BridgeEndpoint
              asset={rightAsset}
              clip={gap.rightClip}
              label="End frame"
              edge="start"
              fps={project.fps}
              contextStartSec={referencePlan.rightStartSec}
              contextDurationSec={referencePlan.rightDurationSec}
              holdSec={referencePlan.rightPadEndSec}
            />
          </div>

          <label className="block rounded-md border border-surface-700 bg-surface-900 focus-within:border-brand-400">
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              className="min-h-32 w-full resize-y rounded-md bg-transparent px-3 py-3 text-sm leading-6 text-slate-100 outline-none placeholder:text-slate-600"
              placeholder="@start-frame, describe the transition, then connect to @end-frame."
            />
          </label>

          <div className="flex flex-wrap items-center gap-2 rounded-md border border-surface-700 bg-surface-900/70 p-2.5">
            <PillGroup
              label="Resolution"
              value={resolution}
              options={RESOLUTION_OPTIONS.map((value) => ({ value, label: value }))}
              onChange={(value) => setResolution(value as (typeof RESOLUTION_OPTIONS)[number])}
              disabled={working}
            />
            <PillGroup
              label="Duration"
              value={durationMode === 'auto' ? 'auto' : `${manualDurationSec}s`}
              options={[
                { value: 'auto', label: `Auto ${autoDurationSec}s` },
                ...DURATION_OPTIONS.map((value) => ({ value: `${value}s`, label: `${value}s` })),
              ]}
              onChange={(value) => {
                if (value === 'auto') {
                  setDurationMode('auto');
                  return;
                }
                setDurationMode('manual');
                setManualDurationSec(Number(value.replace(/s$/i, '')));
              }}
              disabled={working}
            />
            <div className="ml-auto rounded bg-surface-950 px-2 py-1 text-[11px] text-slate-400">
              {aspect} · Seedance 2.0
            </div>
          </div>

          {error && (
            <div className="flex items-start gap-2 rounded-md border border-rose-300/35 bg-rose-500/10 px-3 py-2 text-xs text-rose-100">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <div className="min-w-0 flex-1">{error}</div>
              {error.includes('PiAPI') && (
                <button
                  type="button"
                  className="shrink-0 rounded border border-rose-200/40 px-2 py-1 text-[11px] text-rose-50 hover:bg-rose-300/10"
                  onClick={onOpenSettings}
                >
                  Settings
                </button>
              )}
              {error.toLowerCase().includes('billing') && (
                <a
                  className="inline-flex shrink-0 items-center gap-1 rounded border border-rose-200/40 px-2 py-1 text-[11px] text-rose-50 hover:bg-rose-300/10"
                  href={PIAPI_BILLING_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Billing <ExternalLink size={11} />
                </a>
              )}
            </div>
          )}

          <div className="flex items-center justify-between gap-3 border-t border-surface-800 pt-3">
            <div className="min-w-0 text-[11px] text-slate-500">
              {working ? status || 'Working...' : 'Seedance bridge generation uses the neighboring edge frames as first/last frame references.'}
            </div>
            <button
              type="button"
              className="btn-primary h-9 px-4 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50"
              disabled={working || !prompt.trim() || !leftAsset || !rightAsset}
              onClick={() => void generate()}
            >
              {working ? 'Generating...' : (
                <>
                  Generate
                  <span className="ml-1 text-[10px] font-medium text-white/80">${estimatedCostUsd.toFixed(2)}</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function TimelineFittingModal({
  gap,
  asset,
  leftAsset,
  rightAsset,
  lastMatch,
  onCancel,
  onConfirm,
}: {
  gap: BridgeGap;
  asset: MediaAsset;
  leftAsset: MediaAsset | null;
  rightAsset: MediaAsset | null;
  lastMatch: BridgeFrameMatch | null;
  onCancel: () => void;
  onConfirm: (placement: { startSec: number; inSec: number; outSec: number; timelineDurationSec: number }) => void;
}) {
  const project = useProjectStore((s) => s.project);
  const objectUrlFor = useMediaStore((s) => s.objectUrlFor);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [targetStartSec, setTargetStartSec] = useState(gap.startSec);
  const [targetDurationSec, setTargetDurationSec] = useState(gap.durationSec);
  const [sourceInSec, setSourceInSec] = useState(0);
  const [sourceOutSec, setSourceOutSec] = useState(Math.max(0.05, Math.min(asset.durationSec, gap.durationSec)));
  const targetRef = useRef<HTMLDivElement | null>(null);
  const sourceRef = useRef<HTMLDivElement | null>(null);
  const minDurationSec = 1 / Math.max(1, project.fps);

  useEffect(() => {
    let cancelled = false;
    void objectUrlFor(asset.id).then((url) => {
      if (!cancelled) setPreviewUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [asset.id, asset.blobKey, objectUrlFor]);

  const startTargetDrag = (mode: 'move' | 'left' | 'right', event: React.PointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = targetRef.current?.getBoundingClientRect();
    if (!rect) return;
    const originX = event.clientX;
    const initialStart = targetStartSec;
    const initialDuration = targetDurationSec;
    const secPerPx = gap.durationSec / Math.max(1, rect.width);

    const move = (moveEvent: PointerEvent) => {
      const deltaSec = (moveEvent.clientX - originX) * secPerPx;
      if (mode === 'move') {
        const nextStart = clamp(initialStart + deltaSec, gap.startSec, gap.endSec - initialDuration);
        setTargetStartSec(nextStart);
      } else if (mode === 'left') {
        const nextStart = clamp(initialStart + deltaSec, gap.startSec, initialStart + initialDuration - minDurationSec);
        setTargetStartSec(nextStart);
        setTargetDurationSec(initialDuration + (initialStart - nextStart));
      } else {
        const nextEnd = clamp(initialStart + initialDuration + deltaSec, initialStart + minDurationSec, gap.endSec);
        setTargetDurationSec(nextEnd - initialStart);
      }
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const startSourceDrag = (mode: 'move' | 'left' | 'right', event: React.PointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = sourceRef.current?.getBoundingClientRect();
    if (!rect) return;
    const originX = event.clientX;
    const initialIn = sourceInSec;
    const initialOut = sourceOutSec;
    const secPerPx = asset.durationSec / Math.max(1, rect.width);

    const move = (moveEvent: PointerEvent) => {
      const deltaSec = (moveEvent.clientX - originX) * secPerPx;
      if (mode === 'move') {
        const range = initialOut - initialIn;
        const nextIn = clamp(initialIn + deltaSec, 0, Math.max(0, asset.durationSec - range));
        setSourceInSec(nextIn);
        setSourceOutSec(nextIn + range);
      } else if (mode === 'left') {
        setSourceInSec(clamp(initialIn + deltaSec, 0, initialOut - minDurationSec));
      } else {
        setSourceOutSec(clamp(initialOut + deltaSec, initialIn + minDurationSec, asset.durationSec));
      }
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const targetLeftPct = ((targetStartSec - gap.startSec) / gap.durationSec) * 100;
  const targetWidthPct = (targetDurationSec / gap.durationSec) * 100;
  const sourceLeftPct = asset.durationSec > 0 ? (sourceInSec / asset.durationSec) * 100 : 0;
  const sourceWidthPct = asset.durationSec > 0 ? ((sourceOutSec - sourceInSec) / asset.durationSec) * 100 : 100;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm">
      <div className="w-[min(980px,96vw)] overflow-hidden rounded-lg border border-white/15 bg-surface-950 text-slate-100 shadow-2xl">
        <div className="flex items-center justify-between border-b border-surface-700 px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Clapperboard size={16} className="text-brand-400" />
            Timeline Fitting
          </div>
          <button type="button" className="rounded-md p-1 text-slate-400 hover:bg-white/10 hover:text-white" onClick={onCancel} title="Cancel" aria-label="Cancel">
            <X size={16} />
          </button>
        </div>

        <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="space-y-4">
            <div className="grid grid-cols-[86px_minmax(160px,1fr)_86px] gap-2">
              <EndpointThumb asset={leftAsset} label="Video 1" />
              <div className="rounded-md border border-brand-400/25 bg-brand-500/10 p-3">
                <div className="mb-2 flex items-center justify-between text-[11px] text-slate-300">
                  <span>Timeline gap</span>
                  <span className="font-mono">{formatTimecode(gap.durationSec, project.fps)}</span>
                </div>
                <div ref={targetRef} className="relative h-14 rounded bg-surface-950 ring-1 ring-brand-400/25">
                  <div
                    className="absolute inset-y-2 rounded border border-brand-400/70 bg-brand-500/30 shadow-[0_0_16px_rgba(99,102,241,0.18)]"
                    style={{ left: `${targetLeftPct}%`, width: `${targetWidthPct}%` }}
                    onPointerDown={(event) => startTargetDrag('move', event)}
                  >
                    <button
                      type="button"
                      aria-label="Resize bridge start"
                      className="absolute inset-y-0 left-0 flex w-3 cursor-ew-resize items-center justify-center rounded-l bg-brand-400/80 text-white"
                      onPointerDown={(event) => startTargetDrag('left', event)}
                    >
                      <GripVertical size={10} />
                    </button>
                    <button
                      type="button"
                      aria-label="Move bridge"
                      className="flex h-full w-full cursor-grab items-center justify-center text-[11px] font-semibold text-white active:cursor-grabbing"
                    >
                      {asset.name}
                    </button>
                    <button
                      type="button"
                      aria-label="Resize bridge end"
                      className="absolute inset-y-0 right-0 flex w-3 cursor-ew-resize items-center justify-center rounded-r bg-brand-400/80 text-white"
                      onPointerDown={(event) => startTargetDrag('right', event)}
                    >
                      <GripVertical size={10} />
                    </button>
                  </div>
                </div>
              </div>
              <EndpointThumb asset={rightAsset} label="Video 2" />
            </div>

            <div className="rounded-md border border-surface-700 bg-surface-900/70 p-3">
              <div className="mb-2 flex items-center justify-between text-[11px] text-slate-400">
                <span>Generated source range</span>
                <span className="font-mono">{formatTimecode(sourceOutSec - sourceInSec, project.fps)}</span>
              </div>
              <div ref={sourceRef} className="relative h-12 rounded bg-surface-950 ring-1 ring-surface-700">
                <div
                  className="absolute inset-y-2 rounded border border-brand-400/70 bg-brand-500/30"
                  style={{ left: `${sourceLeftPct}%`, width: `${sourceWidthPct}%` }}
                  onPointerDown={(event) => startSourceDrag('move', event)}
                >
                  <button
                    type="button"
                    aria-label="Trim source start"
                    className="absolute inset-y-0 left-0 flex w-3 cursor-ew-resize items-center justify-center rounded-l bg-brand-400/80 text-white"
                    onPointerDown={(event) => startSourceDrag('left', event)}
                  >
                    <GripVertical size={10} />
                  </button>
                  <button
                    type="button"
                    aria-label="Move source range"
                    className="h-full w-full cursor-grab active:cursor-grabbing"
                  />
                  <button
                    type="button"
                    aria-label="Trim source end"
                    className="absolute inset-y-0 right-0 flex w-3 cursor-ew-resize items-center justify-center rounded-r bg-brand-400/80 text-white"
                    onPointerDown={(event) => startSourceDrag('right', event)}
                  >
                    <GripVertical size={10} />
                  </button>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2 text-[11px] text-slate-400">
              <Metric label="Timeline start" value={formatTimecode(targetStartSec, project.fps)} />
              <Metric label="Timeline duration" value={formatTimecode(targetDurationSec, project.fps)} />
              <Metric label="Source in" value={formatTimecode(sourceInSec, project.fps)} />
              <Metric label="Source out" value={formatTimecode(sourceOutSec, project.fps)} />
            </div>
            {!lastMatch && (
              <div className="rounded-md border border-surface-600 bg-surface-900/70 px-3 py-2 text-xs text-slate-300">
                Matching endpoints were not found automatically.
              </div>
            )}
          </div>

          <div className="flex flex-col gap-3">
            <div className="flex min-h-[190px] items-center justify-center rounded-md bg-black">
              {previewUrl ? (
                <video src={previewUrl} controls className="max-h-[280px] w-full" />
              ) : (
                <div className="text-xs text-slate-500">Preview unavailable</div>
              )}
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-ghost px-3 py-1.5 text-xs" onClick={onCancel}>
                Cancel
              </button>
              <button
                type="button"
                className="btn-primary px-3 py-1.5 text-xs"
                onClick={() => onConfirm({
                  startSec: targetStartSec,
                  timelineDurationSec: targetDurationSec,
                  inSec: sourceInSec,
                  outSec: sourceOutSec,
                })}
              >
                <Check size={13} />
                Confirm
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function BridgeEndpoint({
  asset,
  clip,
  label,
  edge,
  fps,
  contextStartSec,
  contextDurationSec,
  holdSec,
}: {
  asset: MediaAsset | null;
  clip: Clip;
  label: string;
  edge: 'start' | 'end';
  fps: number;
  contextStartSec: number;
  contextDurationSec: number;
  holdSec: number;
}) {
  const objectUrlFor = useMediaStore((s) => s.objectUrlFor);
  const [edgeFrameUrl, setEdgeFrameUrl] = useState<string | null>(null);
  const edgeTimeSec = edge === 'end' ? sourceEndFrameTimeSec(clip, fps) : sourceStartFrameTimeSec(clip);
  const contextEndSec = contextStartSec + contextDurationSec;
  const assetId = asset?.id;
  const assetKind = asset?.kind;
  const assetBlobKey = asset?.blobKey;

  useEffect(() => {
    let cancelled = false;
    setEdgeFrameUrl(null);
    if (!assetId || assetKind !== 'video') return () => {
      cancelled = true;
    };

    void objectUrlFor(assetId)
      .then((url) => (url ? captureVideoFrameDataUrl(url, edgeTimeSec) : null))
      .then((frameUrl) => {
        if (!cancelled) setEdgeFrameUrl(frameUrl);
      })
      .catch(() => {
        if (!cancelled) setEdgeFrameUrl(null);
      });

    return () => {
      cancelled = true;
    };
  }, [assetBlobKey, assetId, assetKind, edgeTimeSec, objectUrlFor]);

  return (
    <div className="min-w-0 rounded-md border border-surface-700 bg-surface-900/70 p-2">
      <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        <Film size={12} />
        {label}
      </div>
      <div className="flex min-w-0 items-center gap-2">
        {edgeFrameUrl || asset?.thumbnailDataUrl ? (
          <img src={edgeFrameUrl ?? asset?.thumbnailDataUrl} alt="" className="h-12 w-16 shrink-0 rounded object-cover" />
        ) : (
          <div className="flex h-12 w-16 shrink-0 items-center justify-center rounded bg-surface-950 text-slate-500">
            <Film size={16} />
          </div>
        )}
        <div className="min-w-0">
          <div className="truncate text-xs font-medium text-slate-100">{asset?.name ?? 'Missing asset'}</div>
          <div className="font-mono text-[10px] text-slate-500">
            Source {edge} {formatTimecode(edgeTimeSec, fps)}
          </div>
          <div className="truncate font-mono text-[10px] text-slate-600">
            Context {formatTimecode(contextStartSec, fps)}-{formatTimecode(contextEndSec, fps)}
          </div>
          {holdSec > 0.001 && (
            <div className="font-mono text-[10px] text-slate-500">Hold {holdSec.toFixed(1)}s</div>
          )}
        </div>
      </div>
    </div>
  );
}

async function captureVideoFrameDataUrl(url: string, timeSec: number): Promise<string | null> {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;

    let settled = false;
    const done = (dataUrl: string | null) => {
      if (settled) return;
      settled = true;
      video.removeAttribute('src');
      video.load();
      resolve(dataUrl);
    };

    video.onloadedmetadata = () => {
      const maxTime = Number.isFinite(video.duration) && video.duration > 0
        ? Math.max(0, video.duration - 0.001)
        : timeSec;
      try {
        video.currentTime = clamp(timeSec, 0, maxTime);
      } catch {
        done(null);
      }
    };
    video.onseeked = () => {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.min(240, video.videoWidth || 240));
      canvas.height = Math.max(1, Math.round(canvas.width * ((video.videoHeight || 135) / (video.videoWidth || 240))));
      const context = canvas.getContext('2d');
      if (!context) {
        done(null);
        return;
      }
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      done(canvas.toDataURL('image/jpeg', 0.78));
    };
    video.onerror = () => done(null);
    video.src = url;
  });
}

function EndpointThumb({ asset, label }: { asset: MediaAsset | null; label: string }) {
  return (
    <div className="overflow-hidden rounded-md border border-surface-700 bg-surface-900">
      <div className="aspect-video bg-surface-950">
        {asset?.thumbnailDataUrl ? (
          <img src={asset.thumbnailDataUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-slate-500">
            <Film size={18} />
          </div>
        )}
      </div>
      <div className="truncate px-1.5 py-1 text-[10px] text-slate-400">{label}</div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-surface-700 bg-surface-900/70 px-2 py-1.5">
      <span>{label}</span>
      <span className="float-right font-mono text-slate-200">{value}</span>
    </div>
  );
}

function PillGroup({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="inline-flex min-h-8 flex-wrap items-center gap-1 rounded-md border border-surface-700 bg-surface-950 px-1 py-1">
      <span className="px-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</span>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            disabled={disabled}
            className={`h-6 rounded px-2.5 text-xs transition disabled:cursor-not-allowed disabled:opacity-50 ${
              selected ? 'bg-surface-700 text-slate-100' : 'text-slate-400 hover:bg-surface-800 hover:text-slate-200'
            }`}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function defaultBridgePrompt(gap: BridgeGap): string {
  return [
    '@start-frame, continue naturally from this exact frame with consistent motion, lighting, framing, and subject continuity.',
    `Bridge the ${gap.durationSec.toFixed(1)} second timeline gap, then connect to @end-frame as the final frame.`,
    'No captions, no text overlays, no hard cut.',
  ].join(' ');
}

function seedanceBridgeFramePrompt(prompt: string): string {
  const rewritten = prompt
    .trim()
    .replaceAll(/@video1\b/gi, '@image1')
    .replaceAll(/@start-frame\b/gi, '@image1')
    .replaceAll(/@video2\b/gi, '@image2')
    .replaceAll(/@end-frame\b/gi, '@image2');
  const withImage1 = rewritten.includes('@image1')
    ? rewritten
    : `Start from @image1. ${rewritten}`;
  const withImage2 = withImage1.includes('@image2')
    ? withImage1
    : `${withImage1} End on @image2.`;
  return [
    'Use @image1 as the exact first frame of the generated bridge.',
    'Use @image2 as the exact final frame of the generated bridge.',
    withImage2,
  ].join(' ');
}

function bridgeRecipe({
  prompt,
  aspect,
  resolution,
  durationSec,
  leftAsset,
  rightAsset,
}: {
  prompt: string;
  aspect: Aspect;
  resolution: string;
  durationSec: number;
  leftAsset: MediaAsset;
  rightAsset: MediaAsset;
}): GenerateRecipe {
  return {
    model: PIAPI_SEEDANCE_2_MODEL_ID,
    prompt,
    promptMode: 'freeform',
    structuredPrompt: {},
    aspect,
    resolution,
    duration: `${durationSec}s`,
    audioEnabled: true,
    sourceVideoAssetId: null,
    referenceAssetIds: [leftAsset.id, rightAsset.id],
  };
}

function aspectForProject(project: Project): Aspect {
  const ratio = project.width / Math.max(1, project.height);
  if (ratio > 2.1) return '21:9';
  if (ratio > 1.45) return '16:9';
  if (ratio > 1.1) return '4:3';
  if (ratio > 0.85) return '1:1';
  if (ratio > 0.6) return '3:4';
  return '9:16';
}

function estimateSeedanceCostUsd(resolution: string, seconds: number): number {
  const rate = resolution === '1080p' ? 0.5 : resolution === '720p' ? 0.2 : 0.1;
  return Number((rate * seconds).toFixed(2));
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.max(min, Math.min(max, value));
}

async function readEncryptedSecret(storageKey: string): Promise<string | null> {
  const encrypted = localStorage.getItem(storageKey);
  if (!encrypted) return null;
  try {
    const secret = await decryptSecret(encrypted);
    return secret.trim() || null;
  } catch {
    return null;
  }
}

async function readPiApiKey(): Promise<string | null> {
  return (await readEncryptedSecret(PIAPI_API_KEY_STORAGE)) ||
    (await readEncryptedSecret(PIAPI_VEO_API_KEY_STORAGE)) ||
    (await readEncryptedSecret(PIAPI_KLING_API_KEY_STORAGE));
}

function formatBridgeGenerationError(err: unknown): string {
  if (err instanceof VideoGenerationProviderError) {
    const label = {
      NSFW: 'NSFW',
      GuidelinesViolation: 'Guidelines violation',
      Billing: 'Billing issue',
      InternalError: 'Internal error',
    }[err.type];
    return `${label}: ${err.message}`;
  }
  return err instanceof Error ? err.message : 'Bridge generation failed.';
}
