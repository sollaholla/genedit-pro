import { type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { nanoid } from 'nanoid';
import { Check, Clapperboard, Copy, Image as ImageIcon, Loader2, Pause, Play, Plus, Search, SkipBack, SkipForward, Sparkles, Trash2, Upload, UserRound, X } from 'lucide-react';
import {
  CHARACTER_IMAGE_ASPECT_RATIO,
  CHARACTER_IMAGE_RESOLUTION,
  DEFAULT_IMAGE_MODELS,
  defaultImageModel,
  estimateImageCostUsd,
  imageModelById,
  sortImageModelsByPriority,
  type ImageModelDefinition,
} from '@/lib/imageModels/capabilities';
import {
  DEFAULT_VIDEO_MODELS,
  isPiApiKlingModel,
  isPiApiSeedanceModel,
  sortModelsByPriority,
  type VideoModelDefinition,
} from '@/lib/videoModels/capabilities';
import { composeSequencePrompt, formatSequenceTimestamp, sortedSequenceMarkers } from '@/lib/media/sequence';
import { characterTokenForAsset, extractPromptReferenceTokens, isReferenceImageAsset } from '@/lib/media/characterReferences';
import { downloadGeneratedImageFile } from '@/lib/imageGeneration/download';
import { createPiApiImageGenerationTask, generatePiApiImage, isGptImageModel } from '@/lib/imageGeneration/piapi';
import { decryptSecret } from '@/lib/settings/crypto';
import { PIAPI_API_KEY_STORAGE, PIAPI_KLING_API_KEY_STORAGE, PIAPI_VEO_API_KEY_STORAGE } from '@/lib/settings/connectionStorage';
import { hostLitterboxReference } from '@/lib/videoGeneration/litterbox';
import { VideoGenerationProviderError } from '@/lib/videoGeneration/errors';
import { useMediaStore } from '@/state/mediaStore';
import type { MediaAsset, SequenceAssetData, SequenceMarker } from '@/types';
import { ImageModelSelect } from './ImageModelSelect';
import { ModelSelect } from './ModelSelect';

type Props = {
  assetId: string | null;
  draftFolderId?: string | null;
  onClose: () => void;
  onGenerate: (assetId: string) => void;
  onAssetCommitted?: (assetId: string) => void;
};

const SVG_WIDTH = 1000;
const TIMELINE_Y = 42;

export function SequenceEditor({ assetId, draftFolderId = null, onClose, onGenerate, onAssetCommitted }: Props) {
  const assets = useMediaStore((state) => state.assets);
  const importFiles = useMediaStore((state) => state.importFiles);
  const objectUrlFor = useMediaStore((state) => state.objectUrlFor);
  const addGeneratedAsset = useMediaStore((state) => state.addGeneratedAsset);
  const updateGenerationProgress = useMediaStore((state) => state.updateGenerationProgress);
  const updateGenerationTask = useMediaStore((state) => state.updateGenerationTask);
  const finalizeGeneratedAssetWithBlob = useMediaStore((state) => state.finalizeGeneratedAssetWithBlob);
  const failGeneratedAsset = useMediaStore((state) => state.failGeneratedAsset);
  const updateSequenceAsset = useMediaStore((state) => state.updateSequenceAsset);
  const createSequenceAsset = useMediaStore((state) => state.createSequenceAsset);
  const sequenceModels = useMemo(() => sortModelsByPriority(DEFAULT_VIDEO_MODELS.filter((model) => isPiApiSeedanceModel(model) || isPiApiKlingModel(model))), []);
  const imageModels = useMemo(() => sortImageModelsByPriority(DEFAULT_IMAGE_MODELS), []);
  const fallbackModel = sequenceModels[0];
  const [committedAssetId, setCommittedAssetId] = useState<string | null>(null);
  const [draftSequence, setDraftSequence] = useState<SequenceAssetData>(() => createDefaultSequence(fallbackModel));
  const effectiveAssetId = assetId ?? committedAssetId;
  const storedAsset = effectiveAssetId
    ? assets.find((candidate) => candidate.id === effectiveAssetId && candidate.kind === 'sequence') ?? null
    : null;
  const isDraft = !effectiveAssetId;
  const sequence = storedAsset?.sequence ?? draftSequence;
  const selectedModel = sequenceModels.find((model) => model.id === sequence.model) ?? fallbackModel;
  const selectedImageModel = imageModels.find((model) => model.id === sequence.imageModel) ?? imageModels[0] ?? imageModelById(sequence.imageModel ?? '') ?? defaultImageModel();
  const durationOptions = useMemo(() => (selectedModel ? durationsForModel(selectedModel) : [8]), [selectedModel]);
  const imageAssets = useMemo(() => assets.filter((asset) => asset.kind === 'image'), [assets]);
  const imageReferenceAssets = useMemo(() => imageAssets.filter(isReferenceImageAsset), [imageAssets]);
  const characterAssets = useMemo(() => assets.filter((asset) => asset.kind === 'character' && isReferenceImageAsset(asset)), [assets]);
  const sequenceCharacterAssets = useMemo(() => {
    const ids = new Set(sequence.characterAssetIds ?? []);
    return characterAssets.filter((asset) => ids.has(asset.id));
  }, [characterAssets, sequence.characterAssetIds]);
  const characterTokensByAssetId = useMemo(() => new Map(assets
    .filter((candidate) => candidate.kind === 'character' && candidate.character?.characterId)
    .map((candidate) => [candidate.id, candidate.character!.characterId])), [assets]);
  const sortedMarkers = useMemo(() => sortedSequenceMarkers(sequence), [sequence]);
  const [selectedMarkerId, setSelectedMarkerId] = useState<string | null>(sortedMarkers[0]?.id ?? null);
  const [currentTimeSec, setCurrentTimeSec] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [draggingMarkerId, setDraggingMarkerId] = useState<string | null>(null);
  const [scrubbing, setScrubbing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [imagePickerMarkerId, setImagePickerMarkerId] = useState<string | null>(null);
  const [characterPickerOpen, setCharacterPickerOpen] = useState(false);
  const [imageGenerationError, setImageGenerationError] = useState<string | null>(null);
  const [imageGeneratingMarkerId, setImageGeneratingMarkerId] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [markerContextMenu, setMarkerContextMenu] = useState<{ x: number; y: number; markerId: string } | null>(null);
  const timelineRef = useRef<SVGSVGElement | null>(null);
  const timelineGestureRef = useRef<{ pointerId: number; startX: number; startY: number; moved: boolean; target: 'timeline' | 'marker' } | null>(null);
  const suppressTimelineDoubleClickUntilRef = useRef(0);
  const selectedMarker = sequence.markers.find((marker) => marker.id === selectedMarkerId) ?? null;
  const selectedMarkerImage = selectedMarker?.imageAssetId ? imageAssets.find((candidate) => candidate.id === selectedMarker.imageAssetId) ?? null : null;
  const imagePickerMarker = imagePickerMarkerId ? sequence.markers.find((marker) => marker.id === imagePickerMarkerId) ?? null : null;
  const previewMarker = mostRecentImageMarker(sortedMarkers, currentTimeSec) ?? (selectedMarker?.imageAssetId ? selectedMarker : null);
  const previewImage = previewMarker?.imageAssetId ? imageAssets.find((candidate) => candidate.id === previewMarker.imageAssetId) ?? null : null;
  const composedPrompt = useMemo(() => composeSequencePrompt(sequence, { characterTokensByAssetId }), [characterTokensByAssetId, sequence]);
  const selectedImagePrompt = useMemo(() => (selectedMarker ? buildShotImagePrompt(sequence, selectedMarker, assets) : ''), [assets, selectedMarker, sequence]);

  useEffect(() => {
    if (isDraft) return;
    if (!storedAsset) onClose();
  }, [isDraft, storedAsset, onClose]);

  useEffect(() => {
    if (selectedMarkerId && sequence.markers.some((marker) => marker.id === selectedMarkerId)) return;
    setSelectedMarkerId(sortedMarkers[0]?.id ?? null);
  }, [selectedMarkerId, sequence.markers, sortedMarkers]);

  useEffect(() => {
    if (!markerContextMenu) return;
    if (!sequence.markers.some((marker) => marker.id === markerContextMenu.markerId)) setMarkerContextMenu(null);
  }, [markerContextMenu, sequence.markers]);

  useEffect(() => {
    setCurrentTimeSec((time) => clampTime(time, sequence.durationSec));
  }, [sequence.durationSec]);

  useEffect(() => {
    if (!playing) return undefined;
    let raf = 0;
    let lastTs: number | null = null;
    const tick = (ts: number) => {
      if (lastTs === null) lastTs = ts;
      const dt = (ts - lastTs) / 1000;
      lastTs = ts;
      let reachedEnd = false;
      setCurrentTimeSec((time) => {
        const next = clampTime(time + dt, sequence.durationSec);
        if (next >= sequence.durationSec) {
          reachedEnd = true;
          return sequence.durationSec;
        }
        return next;
      });
      if (reachedEnd) {
        setPlaying(false);
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, sequence.durationSec]);

  useEffect(() => {
    let mounted = true;
    setPreviewUrl(null);
    if (!previewImage) return () => {
      mounted = false;
    };
    void objectUrlFor(previewImage.id).then((url) => {
      if (mounted) setPreviewUrl(url);
    });
    return () => {
      mounted = false;
    };
  }, [objectUrlFor, previewImage?.blobKey, previewImage?.editTrail?.activeIterationId, previewImage?.id]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (imagePickerMarkerId) setImagePickerMarkerId(null);
      else if (characterPickerOpen) setCharacterPickerOpen(false);
      else onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [characterPickerOpen, imagePickerMarkerId, onClose]);

  if (!selectedModel) return null;
  if (!isDraft && !storedAsset) return null;

  const shouldCommitDraft = (next: SequenceAssetData): boolean =>
    next.markers.some((marker) => marker.imageAssetId) || next.markers.length > 0 || Boolean(next.characterAssetIds?.length);

  const persist = (next: SequenceAssetData) => {
    const normalized = normalizeSequence(next, assets);
    if (effectiveAssetId) {
      updateSequenceAsset(effectiveAssetId, normalized);
      return;
    }
    if (shouldCommitDraft(normalized)) {
      const newId = createSequenceAsset(draftFolderId);
      updateSequenceAsset(newId, normalized);
      setCommittedAssetId(newId);
      onAssetCommitted?.(newId);
      return;
    }
    setDraftSequence(normalized);
  };
  const addSequenceCharacter = (asset: MediaAsset) => {
    if (asset.kind !== 'character') return;
    const latestSequence = effectiveAssetId
      ? useMediaStore.getState().assets.find((candidate) => candidate.id === effectiveAssetId && candidate.kind === 'sequence')?.sequence ?? sequence
      : sequence;
    const ids = uniqueIds([...(latestSequence.characterAssetIds ?? []), asset.id]);
    persist({ ...latestSequence, characterAssetIds: ids });
  };
  const removeSequenceCharacter = (assetId: string) => {
    const latestSequence = effectiveAssetId
      ? useMediaStore.getState().assets.find((candidate) => candidate.id === effectiveAssetId && candidate.kind === 'sequence')?.sequence ?? sequence
      : sequence;
    persist({ ...latestSequence, characterAssetIds: (latestSequence.characterAssetIds ?? []).filter((id) => id !== assetId) });
  };
  const updateMarker = (markerId: string, patch: Partial<SequenceMarker>) => {
    persist({
      ...sequence,
      markers: sequence.markers.map((marker) => (marker.id === markerId
        ? { ...marker, ...patch, timeSec: clampTime(patch.timeSec ?? marker.timeSec, sequence.durationSec) }
        : marker)),
    });
  };
  const changeImageModel = (modelId: string) => {
    const nextModel = imageModels.find((model) => model.id === modelId) ?? selectedImageModel;
    persist({ ...sequence, imageModel: nextModel.id });
  };
  const addMarker = (timeSec = currentTimeSec) => {
    const marker: SequenceMarker = {
      id: nanoid(10),
      timeSec: clampTime(timeSec, sequence.durationSec),
      imageAssetId: null,
      prompt: '',
    };
    persist({ ...sequence, markers: [...sequence.markers, marker] });
    setSelectedMarkerId(marker.id);
    setCurrentTimeSec(marker.timeSec);
  };
  const seekStart = () => setCurrentTimeSec(0);
  const seekEnd = () => {
    setCurrentTimeSec(sequence.durationSec);
    setPlaying(false);
  };
  const playPreview = () => {
    setCurrentTimeSec((time) => (time >= sequence.durationSec ? 0 : time));
    setPlaying(true);
  };
  const pausePreview = () => setPlaying(false);
  const deleteMarker = (markerId: string) => {
    const remaining = sequence.markers.filter((marker) => marker.id !== markerId);
    persist({ ...sequence, markers: remaining });
    if (selectedMarkerId === markerId) setSelectedMarkerId(remaining[0]?.id ?? null);
    if (imagePickerMarkerId === markerId) setImagePickerMarkerId(null);
    if (draggingMarkerId === markerId) setDraggingMarkerId(null);
    setMarkerContextMenu(null);
  };
  const deleteSelectedMarker = () => {
    if (!selectedMarker) return;
    deleteMarker(selectedMarker.id);
  };
  const selectMarker = (marker: SequenceMarker) => {
    setPlaying(false);
    setSelectedMarkerId(marker.id);
    setCurrentTimeSec(marker.timeSec);
  };
  const clientXToTime = (clientX: number) => {
    const rect = timelineRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return 0;
    return clampTime(((clientX - rect.left) / rect.width) * sequence.durationSec, sequence.durationSec);
  };
  const scrubToClientX = (clientX: number) => {
    const timeSec = clientXToTime(clientX);
    setCurrentTimeSec(timeSec);
    if (draggingMarkerId) updateMarker(draggingMarkerId, { timeSec });
  };
  const trackPointerMovement = (event: ReactPointerEvent<SVGSVGElement>) => {
    const gesture = timelineGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId || gesture.moved) return;
    const distance = Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY);
    if (distance > 4) gesture.moved = true;
  };
  const handleTimelinePointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!scrubbing && !draggingMarkerId) return;
    trackPointerMovement(event);
    scrubToClientX(event.clientX);
  };
  const stopTimelinePointer = (event: ReactPointerEvent<SVGSVGElement>) => {
    const gesture = timelineGestureRef.current;
    if (gesture?.pointerId === event.pointerId) {
      if (gesture.target === 'marker' || gesture.moved) suppressTimelineDoubleClickUntilRef.current = Date.now() + 450;
      timelineGestureRef.current = null;
    }
    setScrubbing(false);
    setDraggingMarkerId(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const addMarkerFromEmptyTrackDoubleClick = (event: ReactMouseEvent<SVGRectElement>) => {
    event.stopPropagation();
    if (Date.now() < suppressTimelineDoubleClickUntilRef.current) return;
    addMarker(clientXToTime(event.clientX));
  };
  const changeModel = (modelId: string) => {
    const nextModel = sequenceModels.find((model) => model.id === modelId) ?? selectedModel;
    const nextDurations = durationsForModel(nextModel);
    const nextDuration = nextDurations.includes(sequence.durationSec) ? sequence.durationSec : nextDurations[0] ?? sequence.durationSec;
    persist({
      ...sequence,
      model: nextModel.id,
      durationSec: nextDuration,
      markers: sequence.markers.map((marker) => ({ ...marker, timeSec: clampTime(marker.timeSec, nextDuration) })),
    });
  };
  const changeDuration = (durationSec: number) => {
    persist({
      ...sequence,
      durationSec,
      markers: sequence.markers.map((marker) => ({ ...marker, timeSec: clampTime(marker.timeSec, durationSec) })),
    });
  };
  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(composedPrompt);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  };
  const importMarkerImage = async () => {
    if (!imagePickerMarker) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const imported = await importFiles([file]);
      const image = imported.find((candidate) => candidate.kind === 'image');
      if (!image) return;
      updateMarker(imagePickerMarker.id, { imageAssetId: image.id });
      setImagePickerMarkerId(null);
    };
    input.click();
  };
  const generateShotImage = async (markerId: string) => {
    const marker = sequence.markers.find((candidate) => candidate.id === markerId);
    if (!marker) return;
    const prompt = buildShotImagePrompt(sequence, marker, assets);
    if (!prompt.trim()) {
      setImageGenerationError('Add a shot prompt before generating an image.');
      return;
    }
    const apiKey = await readPiApiKey();
    if (!apiKey) {
      setImageGenerationError('Add a PiAPI key in Settings before generating sequence images.');
      return;
    }

    setImageGenerationError(null);
    setImageGeneratingMarkerId(markerId);
    const shotIndex = Math.max(1, sortedMarkers.findIndex((candidate) => candidate.id === markerId) + 1);
    const estimatedCostUsd = estimateImageCostUsd(selectedImageModel);
    const generatedAssetId = addGeneratedAsset(
      `Sequence shot ${shotIndex}.png`,
      storedAsset?.folderId ?? draftFolderId ?? null,
      estimatedCostUsd,
      undefined,
      { kind: 'image', mimeType: 'image/png', durationSec: 5 },
    );

    const attachGeneratedAssetToMarker = () => {
      const latestAssets = useMediaStore.getState().assets;
      const latestSequence = latestAssets.find((asset) => asset.id === effectiveAssetId && asset.kind === 'sequence')?.sequence ?? sequence;
      const nextSequence = {
        ...latestSequence,
        imageModel: selectedImageModel.id,
        markers: latestSequence.markers.map((candidate) => (candidate.id === markerId ? { ...candidate, imageAssetId: generatedAssetId } : candidate)),
      };
      if (effectiveAssetId) updateSequenceAsset(effectiveAssetId, normalizeSequence(nextSequence, latestAssets));
      else persist(nextSequence);
    };

    attachGeneratedAssetToMarker();

    try {
      const referenceAssetsForShot = shotImageReferenceAssets(sequence, marker, assets);
      const referenceInput = await buildImageReferenceInput(referenceAssetsForShot, selectedImageModel, objectUrlFor);
      if (isGptImageModel(selectedImageModel)) {
        updateGenerationTask(generatedAssetId, {
          provider: 'piapi-gpt-image',
          providerTaskStatus: 'requesting',
          providerTaskCreatedAt: Date.now(),
        });
        const result = await generatePiApiImage({
          model: selectedImageModel,
          prompt,
          aspectRatio: CHARACTER_IMAGE_ASPECT_RATIO,
          resolution: CHARACTER_IMAGE_RESOLUTION,
          outputFormat: selectedImageModel.capabilities.defaultOutputFormat,
          ...referenceInput,
          onProgress: (progress) => updateGenerationProgress(generatedAssetId, progress),
        }, { apiKey });
        const file = await downloadGeneratedImageFile(result.url, (progress) => updateGenerationProgress(generatedAssetId, progress));
        await finalizeGeneratedAssetWithBlob(generatedAssetId, file, {
          actualCostUsd: estimatedCostUsd,
          provider: result.provider,
          providerArtifactUri: result.url,
          providerArtifactExpiresAt: result.providerArtifactExpiresAt,
        });
        return;
      }

      const initialTask = await createPiApiImageGenerationTask({
        model: selectedImageModel,
        prompt,
        aspectRatio: CHARACTER_IMAGE_ASPECT_RATIO,
        resolution: CHARACTER_IMAGE_RESOLUTION,
        outputFormat: selectedImageModel.capabilities.defaultOutputFormat,
        ...referenceInput,
        onTaskAccepted: (task) => updateGenerationTask(generatedAssetId, {
          provider: selectedImageModel.provider,
          providerTaskId: task.task_id,
          providerTaskEndpoint: task.task_id ? `/api/v1/task/${task.task_id}` : undefined,
          providerTaskStatus: task.status,
          providerTaskCreatedAt: Date.now(),
        }),
        onProgress: (progress) => updateGenerationProgress(generatedAssetId, progress),
      }, { apiKey });
      updateGenerationTask(generatedAssetId, {
        provider: selectedImageModel.provider,
        providerTaskId: initialTask.task_id,
        providerTaskEndpoint: initialTask.task_id ? `/api/v1/task/${initialTask.task_id}` : undefined,
        providerTaskStatus: initialTask.status,
        providerTaskCreatedAt: Date.now(),
      });
    } catch (err) {
      const message = formatGenerationError(err);
      setImageGenerationError(message);
      failGeneratedAsset(generatedAssetId, {
        actualCostUsd: estimatedCostUsd,
        errorType: err instanceof VideoGenerationProviderError ? err.type : 'InternalError',
        errorMessage: message,
      });
    } finally {
      setImageGeneratingMarkerId(null);
    }
  };

  return (
    <div className="fixed inset-0 z-[95] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm">
      <div className="flex h-[min(880px,94vh)] w-[min(1180px,96vw)] flex-col overflow-hidden rounded-lg border border-white/15 bg-surface-950 shadow-2xl">
        <div className="flex shrink-0 items-center justify-between border-b border-surface-700 px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <Clapperboard size={17} className="shrink-0 text-brand-400" />
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-slate-100">{storedAsset?.name ?? 'New sequence'}</div>
              <div className="text-[11px] uppercase tracking-wide text-slate-500">Sequence{isDraft ? ' · Draft' : ''}</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              className="btn-ghost px-2 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => {
                if (effectiveAssetId) onGenerate(effectiveAssetId);
              }}
              disabled={!effectiveAssetId}
              title={effectiveAssetId ? 'Generate' : 'Add a marker first'}
            >
              <Sparkles size={12} />
              Generate
            </button>
            <button className="rounded-md p-1 text-slate-400 hover:bg-white/10 hover:text-white" onClick={onClose} title="Close sequence" aria-label="Close sequence">
              <X size={18} />
            </button>
          </div>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_320px] gap-0 overflow-hidden">
          <main className="flex min-w-0 flex-col overflow-auto p-4">
            <div className="mb-4 grid grid-cols-[minmax(0,1fr)_190px_120px] gap-3">
              <label className="flex min-w-0 flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                Overall Prompt
                <textarea
                  value={sequence.overallPrompt}
                  onChange={(event) => persist({ ...sequence, overallPrompt: event.target.value })}
                  className="min-h-[88px] resize-none rounded-md border border-surface-700 bg-surface-900 px-3 py-2 text-sm font-normal normal-case tracking-normal text-slate-100 outline-none focus:border-brand-400"
                />
              </label>
              <div className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                Model
                <ModelSelect
                  value={selectedModel.id}
                  onChange={changeModel}
                  options={sequenceModels}
                  showInlineLabel={false}
                  className="w-full"
                />
              </div>
              <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                Duration
                <select
                  value={sequence.durationSec}
                  onChange={(event) => changeDuration(Number(event.target.value))}
                  className="rounded-md border border-surface-700 bg-surface-900 px-2 py-2 text-sm font-normal normal-case tracking-normal text-slate-100 outline-none focus:border-brand-400"
                >
                  {durationOptions.map((duration) => (
                    <option key={duration} value={duration}>{duration}s</option>
                  ))}
                </select>
              </label>
            </div>

            <SequenceCharacterStrip
              characters={sequenceCharacterAssets}
              onAdd={() => setCharacterPickerOpen(true)}
              onRemove={removeSequenceCharacter}
            />

            <div className="mb-3 flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                <div className="inline-flex items-center rounded-md border border-surface-700 bg-surface-950 p-0.5">
                  <button
                    type="button"
                    className="flex h-7 w-7 items-center justify-center rounded text-slate-400 hover:bg-surface-700 hover:text-slate-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand-400"
                    onClick={seekStart}
                    title="Go to start"
                    aria-label="Go to start"
                  >
                    <SkipBack size={13} />
                  </button>
                  <button
                    type="button"
                    className="flex h-7 w-7 items-center justify-center rounded text-slate-200 hover:bg-surface-700 hover:text-white focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand-400 disabled:cursor-not-allowed disabled:opacity-35"
                    onClick={playPreview}
                    disabled={playing}
                    title="Play preview"
                    aria-label="Play preview"
                  >
                    <Play size={14} />
                  </button>
                  <button
                    type="button"
                    className="flex h-7 w-7 items-center justify-center rounded text-slate-400 hover:bg-surface-700 hover:text-slate-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand-400 disabled:cursor-not-allowed disabled:opacity-35"
                    onClick={pausePreview}
                    disabled={!playing}
                    title="Pause preview"
                    aria-label="Pause preview"
                  >
                    <Pause size={14} />
                  </button>
                  <button
                    type="button"
                    className="flex h-7 w-7 items-center justify-center rounded text-slate-400 hover:bg-surface-700 hover:text-slate-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand-400"
                    onClick={seekEnd}
                    title="Go to end"
                    aria-label="Go to end"
                  >
                    <SkipForward size={13} />
                  </button>
                </div>
                <div className="font-mono text-xs text-slate-400">{formatTime(currentTimeSec)} / {formatTime(sequence.durationSec)}</div>
              </div>
              <button className="btn-ghost px-2 py-1 text-xs" onClick={() => addMarker()}>
                <Plus size={12} />
                Add Marker
              </button>
            </div>

            <div className="rounded-md border border-surface-700 bg-surface-900 p-3">
              <svg
                ref={timelineRef}
                viewBox={`0 0 ${SVG_WIDTH} 92`}
                className="block h-28 w-full touch-none select-none overflow-visible"
                onPointerDown={(event) => {
                  setPlaying(false);
                  event.currentTarget.setPointerCapture(event.pointerId);
                  timelineGestureRef.current = {
                    pointerId: event.pointerId,
                    startX: event.clientX,
                    startY: event.clientY,
                    moved: false,
                    target: 'timeline',
                  };
                  setScrubbing(true);
                  scrubToClientX(event.clientX);
                }}
                onPointerMove={handleTimelinePointerMove}
                onPointerUp={stopTimelinePointer}
                onPointerCancel={stopTimelinePointer}
              >
                <rect x="0" y="24" width={SVG_WIDTH} height="36" rx="8" className="fill-surface-800" onDoubleClick={addMarkerFromEmptyTrackDoubleClick} />
                <line x1="0" y1={TIMELINE_Y} x2={SVG_WIDTH} y2={TIMELINE_Y} className="stroke-surface-500" strokeWidth="2" pointerEvents="none" />
                {timelineTicks(sequence.durationSec).map((tick) => {
                  const x = timeToX(tick, sequence.durationSec);
                  return (
                    <g key={tick} pointerEvents="none">
                      <line x1={x} y1="18" x2={x} y2="66" className="stroke-surface-600" strokeWidth="1" />
                      <text x={x} y="82" textAnchor="middle" className="fill-slate-500 text-[10px]">{tick}s</text>
                    </g>
                  );
                })}
                {sortedMarkers.map((marker, index) => {
                  const x = timeToX(marker.timeSec, sequence.durationSec);
                  const selected = marker.id === selectedMarkerId;
                  const markerLineClassName = selected
                    ? 'stroke-brand-400'
                    : marker.imageAssetId
                      ? 'stroke-amber-300'
                      : 'stroke-brand-500';
                  const markerCircleClassName = marker.imageAssetId
                    ? 'fill-amber-300 stroke-white'
                    : selected
                      ? 'fill-brand-400 stroke-white'
                      : 'fill-brand-500 stroke-white';
                  return (
                    <g
                      key={marker.id}
                      transform={`translate(${x} 0)`}
                      className="cursor-ew-resize"
                      onPointerDown={(event) => {
                        if (event.button !== 0) return;
                        setPlaying(false);
                        event.stopPropagation();
                        event.currentTarget.ownerSVGElement?.setPointerCapture(event.pointerId);
                        timelineGestureRef.current = {
                          pointerId: event.pointerId,
                          startX: event.clientX,
                          startY: event.clientY,
                          moved: false,
                          target: 'marker',
                        };
                        setSelectedMarkerId(marker.id);
                        setDraggingMarkerId(marker.id);
                        setCurrentTimeSec(marker.timeSec);
                      }}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        setPlaying(false);
                        setSelectedMarkerId(marker.id);
                        setCurrentTimeSec(marker.timeSec);
                        setMarkerContextMenu({ x: event.clientX, y: event.clientY, markerId: marker.id });
                      }}
                      onDoubleClick={(event) => event.stopPropagation()}
                    >
                      <line x1="0" y1="18" x2="0" y2="66" className={markerLineClassName} strokeWidth={selected ? 3 : 2} />
                      <circle
                        cx="0"
                        cy={TIMELINE_Y}
                        r={selected ? 8 : 6}
                        className={markerCircleClassName}
                        strokeWidth="2"
                      />
                      <text x="0" y="12" textAnchor="middle" className={selected ? 'fill-brand-400 text-[11px] font-semibold' : 'fill-slate-400 text-[10px]'}>{index + 1}</text>
                    </g>
                  );
                })}
                <line
                  x1={timeToX(currentTimeSec, sequence.durationSec)}
                  y1="14"
                  x2={timeToX(currentTimeSec, sequence.durationSec)}
                  y2="70"
                  className="stroke-brand-400"
                  strokeWidth="2"
                  pointerEvents="none"
                />
              </svg>
            </div>

            <div className="mt-4 grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_280px] gap-4">
              <section className="flex min-h-0 flex-col rounded-md border border-surface-700 bg-surface-900/70 p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Prompt Output</div>
                  <button className="btn-ghost px-2 py-1 text-xs" onClick={() => void copyPrompt()} disabled={!composedPrompt.trim()}>
                    <Copy size={12} />
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <SequencePromptOutput
                  sequence={sequence}
                  markers={sortedMarkers}
                  imageAssets={imageAssets}
                  selectedMarkerId={selectedMarkerId}
                  onSelectMarker={selectMarker}
                />
              </section>

              <MarkerInspector
                marker={selectedMarker}
                selectedImage={selectedMarkerImage}
                selectedImageModel={selectedImageModel}
                imageModels={imageModels}
                sequenceCharacters={sequenceCharacterAssets}
                allCharacters={characterAssets}
                imageGenerationError={selectedMarker?.id === imageGeneratingMarkerId ? null : imageGenerationError}
                imageGenerating={Boolean(selectedMarker && selectedMarker.id === imageGeneratingMarkerId)}
                imagePrompt={selectedImagePrompt}
                durationSec={sequence.durationSec}
                onUpdate={updateMarker}
                onDelete={deleteSelectedMarker}
                onImageModelChange={changeImageModel}
                onAcceptCharacterMention={addSequenceCharacter}
                onGenerateImage={() => {
                  if (selectedMarker) void generateShotImage(selectedMarker.id);
                }}
                onChooseImage={() => {
                  if (selectedMarker) setImagePickerMarkerId(selectedMarker.id);
                }}
              />
            </div>
          </main>

          <aside className="flex min-w-0 flex-col border-l border-surface-700 bg-surface-900/50 p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Preview</div>
                <div className="mt-0.5 font-mono text-[11px] text-slate-500">{previewMarker ? formatTime(previewMarker.timeSec) : formatTime(currentTimeSec)}</div>
              </div>
            </div>
            <div className="flex aspect-video w-full items-center justify-center overflow-hidden rounded-md border border-surface-700 bg-black">
              {previewUrl && previewImage ? (
                <img src={previewUrl} alt={previewImage.name} className="h-full w-full object-contain" draggable={false} />
              ) : previewImage?.generation?.status === 'generating' ? (
                <GeneratedShotLoading asset={previewImage} />
              ) : previewImage?.generation?.status === 'error' ? (
                <div className="flex flex-col items-center gap-2 px-4 text-center text-rose-300">
                  <ImageIcon size={30} />
                  <div className="text-xs font-medium">Image generation failed</div>
                  <div className="line-clamp-2 text-[11px] text-rose-200/80">{previewImage.generation.errorMessage ?? 'Try generating this shot again.'}</div>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-2 text-slate-500">
                  <ImageIcon size={30} />
                  <div className="text-xs">No marker reference</div>
                </div>
              )}
            </div>
            {previewMarker && (
              <div className="mt-3 rounded-md border border-surface-700 bg-surface-950 p-3">
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Current Shot</div>
                <div className="text-sm text-slate-200">{previewMarker.prompt || 'Untitled shot'}</div>
              </div>
            )}
            <div className="mt-4 min-h-0 overflow-auto">
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Markers</div>
              <div className="space-y-1.5">
                {sortedMarkers.map((marker, index) => (
                  <div
                    key={marker.id}
                    className={`group flex w-full items-center gap-2 rounded border text-xs ${
                      marker.id === selectedMarkerId
                        ? 'border-brand-400 bg-brand-500/15 text-slate-100'
                        : 'border-surface-700 bg-surface-950 text-slate-300 hover:border-surface-500'
                    }`}
                  >
                    <button
                      type="button"
                      className="flex min-h-9 min-w-0 flex-1 items-center justify-between gap-2 rounded-l px-2 py-1.5 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand-400"
                      onClick={() => selectMarker(marker)}
                    >
                      <span className="min-w-0 truncate">{index + 1}. {marker.prompt || 'Untitled shot'}</span>
                      <span className="shrink-0 font-mono text-[11px] text-slate-500">{formatTime(marker.timeSec)}</span>
                    </button>
                    <button
                      type="button"
                      className="mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded text-slate-500 opacity-0 transition hover:bg-red-500/10 hover:text-red-300 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-300/60"
                      title="Delete marker"
                      aria-label="Delete marker"
                      onClick={(event) => {
                        event.stopPropagation();
                        deleteMarker(marker.id);
                      }}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </aside>
        </div>
      </div>
      {imagePickerMarker && (
        <SequenceImagePicker
          assets={imageReferenceAssets}
          selectedId={imagePickerMarker.imageAssetId ?? null}
          onPick={(reference) => {
            updateMarker(imagePickerMarker.id, { imageAssetId: reference.id });
            setImagePickerMarkerId(null);
          }}
          onImport={() => void importMarkerImage()}
          onClose={() => setImagePickerMarkerId(null)}
        />
      )}
      {characterPickerOpen && (
        <SequenceCharacterPicker
          assets={characterAssets}
          selectedIds={sequence.characterAssetIds ?? []}
          onPick={(asset) => addSequenceCharacter(asset)}
          onClose={() => setCharacterPickerOpen(false)}
        />
      )}
      {markerContextMenu && (
        <SequenceMarkerContextMenu
          x={markerContextMenu.x}
          y={markerContextMenu.y}
          onDelete={() => deleteMarker(markerContextMenu.markerId)}
          onClose={() => setMarkerContextMenu(null)}
        />
      )}
    </div>
  );
}

function SequenceCharacterStrip({
  characters,
  onAdd,
  onRemove,
}: {
  characters: MediaAsset[];
  onAdd: () => void;
  onRemove: (assetId: string) => void;
}) {
  return (
    <div className="mb-4 rounded-md border border-surface-700 bg-surface-900/70 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Sequence Characters</div>
        <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={onAdd}>
          <Plus size={12} />
          Add Character
        </button>
      </div>
      <div className="flex flex-wrap gap-2">
        {characters.length === 0 && <span className="text-xs text-slate-500">No characters attached to this sequence.</span>}
        {characters.map((asset) => {
          const token = bareCharacterToken(asset);
          return (
            <span key={asset.id} className="inline-flex max-w-full items-center gap-2 rounded-md border border-surface-700 bg-surface-950 px-2 py-1 text-xs text-slate-200">
              {asset.thumbnailDataUrl ? (
                <img src={asset.thumbnailDataUrl} alt="" className="h-6 w-6 shrink-0 rounded object-cover" />
              ) : (
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-surface-800 text-slate-500"><UserRound size={13} /></span>
              )}
              <span className="min-w-0">
                <span className="block max-w-[180px] truncate">{asset.name}</span>
                {token && <span className="block text-[10px] text-brand-300">@{token}</span>}
              </span>
              <button type="button" className="rounded p-0.5 text-slate-500 hover:bg-white/10 hover:text-slate-100" onClick={() => onRemove(asset.id)} title="Remove character" aria-label="Remove character">
                <X size={12} />
              </button>
            </span>
          );
        })}
      </div>
    </div>
  );
}

function SequencePromptOutput({
  sequence,
  markers,
  imageAssets,
  selectedMarkerId,
  onSelectMarker,
}: {
  sequence: SequenceAssetData;
  markers: SequenceMarker[];
  imageAssets: MediaAsset[];
  selectedMarkerId: string | null;
  onSelectMarker: (marker: SequenceMarker) => void;
}) {
  const imageAssetsById = useMemo(() => new Map(imageAssets.map((asset) => [asset.id, asset])), [imageAssets]);
  const imageReferenceNumbers = useMemo(() => {
    let nextIndex = 0;
    const indexes = new Map<string, number>();
    for (const marker of markers) {
      if (!marker.imageAssetId) continue;
      nextIndex += 1;
      indexes.set(marker.id, nextIndex);
    }
    return indexes;
  }, [markers]);
  const overallPrompt = sequence.overallPrompt.trim();
  if (!overallPrompt && markers.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center rounded border border-dashed border-surface-700 bg-surface-950/80 p-6 text-center text-sm text-slate-500">
        Add markers to build a shot sequence.
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto rounded border border-surface-800 bg-surface-950/90">
      {overallPrompt && (
        <div className="border-b border-surface-800 bg-surface-900/55 p-3">
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Sequence Brief</span>
            <span className="rounded bg-surface-800 px-1.5 py-0.5 text-[10px] text-slate-400">{markers.length} shots</span>
          </div>
          <p className="whitespace-pre-wrap text-sm leading-6 text-slate-200">{overallPrompt}</p>
        </div>
      )}
      <div className="relative p-3">
        {markers.length > 1 && <div className="absolute bottom-5 left-[2.15rem] top-5 w-px bg-surface-700/80" />}
        <div className="space-y-2">
          {markers.map((marker, index) => {
            const selected = marker.id === selectedMarkerId;
            const image = marker.imageAssetId ? imageAssetsById.get(marker.imageAssetId) ?? null : null;
            const imageReferenceNumber = imageReferenceNumbers.get(marker.id);
            return (
              <div
                key={marker.id}
                role="button"
                tabIndex={0}
                className={`relative grid cursor-pointer grid-cols-[2.35rem_minmax(0,1fr)] gap-3 rounded-md border px-3 py-2.5 text-left transition focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand-400 ${selected ? 'border-brand-400/70 bg-brand-500/15 shadow-[inset_3px_0_0_rgba(124,140,255,0.95)]' : 'border-surface-800 bg-surface-900/35 hover:border-surface-600 hover:bg-surface-900/60'}`}
                onClick={() => onSelectMarker(marker)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return;
                  event.preventDefault();
                  onSelectMarker(marker);
                }}
              >
                <div className="relative flex flex-col items-center gap-2 pt-0.5">
                  <span className={`z-10 flex h-8 w-8 items-center justify-center rounded-full border text-[11px] font-semibold ${selected ? 'border-brand-300 bg-brand-500 text-white' : 'border-surface-600 bg-surface-950 text-slate-300'}`}>
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <span className="rounded bg-surface-950 px-1.5 py-0.5 font-mono text-[10px] text-slate-500">{formatTime(marker.timeSec)}</span>
                </div>
                <div className="min-w-0">
                  <div className="mb-2 flex min-w-0 flex-wrap items-center gap-1.5">
                    <span className="rounded bg-surface-800 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">Shot {index + 1}</span>
                    {imageReferenceNumber && (
                      <span className="inline-flex min-w-0 items-center gap-1 rounded bg-amber-400/10 px-1.5 py-0.5 text-[10px] text-amber-200 ring-1 ring-amber-300/20">
                        <ImageIcon size={10} />
                        <span>@image{imageReferenceNumber}</span>
                      </span>
                    )}
                    {image && <span className="min-w-0 truncate rounded bg-surface-800 px-1.5 py-0.5 text-[10px] text-slate-400">{image.name}</span>}
                  </div>
                  <div className="whitespace-pre-wrap text-sm leading-6 text-slate-200">
                    {marker.prompt.trim() || <span className="text-slate-500">Untitled shot</span>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function GeneratedShotLoading({ asset }: { asset: MediaAsset }) {
  const progress = Math.round(asset.generation?.progress ?? 10);
  const status = asset.generation?.providerTaskStatus === 'requesting' ? 'Starting' : 'In progress';
  return (
    <div className="flex w-full max-w-[260px] flex-col items-center gap-3 px-4 text-center text-slate-300">
      <span className="flex h-12 w-12 items-center justify-center rounded-md bg-brand-500/10 text-brand-300 ring-1 ring-brand-400/25">
        <Loader2 size={24} className="animate-spin" />
      </span>
      <div>
        <div className="text-sm font-medium text-slate-100">Generating shot image</div>
        <div className="mt-1 text-xs text-slate-500">{status} - {progress}%</div>
      </div>
      <progress value={progress} max={100} className="h-1.5 w-full overflow-hidden rounded bg-surface-800 accent-brand-400" />
    </div>
  );
}

function MarkerInspector({
  marker,
  selectedImage,
  selectedImageModel,
  imageModels,
  sequenceCharacters,
  allCharacters,
  imageGenerationError,
  imageGenerating,
  imagePrompt,
  durationSec,
  onUpdate,
  onDelete,
  onImageModelChange,
  onAcceptCharacterMention,
  onGenerateImage,
  onChooseImage,
}: {
  marker: SequenceMarker | null;
  selectedImage: MediaAsset | null;
  selectedImageModel: ImageModelDefinition;
  imageModels: ImageModelDefinition[];
  sequenceCharacters: MediaAsset[];
  allCharacters: MediaAsset[];
  imageGenerationError: string | null;
  imageGenerating: boolean;
  imagePrompt: string;
  durationSec: number;
  onUpdate: (markerId: string, patch: Partial<SequenceMarker>) => void;
  onDelete: () => void;
  onImageModelChange: (modelId: string) => void;
  onAcceptCharacterMention: (asset: MediaAsset) => void;
  onGenerateImage: () => void;
  onChooseImage: () => void;
}) {
  if (!marker) {
    return (
      <section className="flex min-h-[220px] items-center justify-center rounded-md border border-surface-700 bg-surface-900/70 p-4 text-center text-sm text-slate-500">
        Select or add a marker.
      </section>
    );
  }

  const selectedImageGenerating = selectedImage?.generation?.status === 'generating';
  const selectedImageError = selectedImage?.generation?.status === 'error';
  const selectedImageSubtitle = selectedImageGenerating
    ? `Generating${formatGenerationProgress(selectedImage)}`
    : selectedImageError
      ? selectedImage.generation?.errorMessage ?? 'Generation failed'
      : selectedImage
        ? selectedImage.width && selectedImage.height ? `${selectedImage.width}x${selectedImage.height}` : selectedImage.mimeType
        : 'Choose or generate a shot image';

  return (
    <section className="rounded-md border border-surface-700 bg-surface-900/70 p-3">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Shot Marker</div>
        <button className="rounded p-1 text-slate-500 hover:bg-red-500/10 hover:text-red-300" onClick={onDelete} title="Delete marker" aria-label="Delete marker">
          <Trash2 size={14} />
        </button>
      </div>
      <div className="space-y-3">
        <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          Time
          <input
            type="number"
            min={0}
            max={durationSec}
            step={0.1}
            value={Number(marker.timeSec.toFixed(1))}
            onChange={(event) => onUpdate(marker.id, { timeSec: Number(event.target.value) })}
            className="rounded-md border border-surface-700 bg-surface-950 px-2 py-1.5 text-sm font-normal normal-case tracking-normal text-slate-100 outline-none focus:border-brand-400"
          />
        </label>
        <div className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          Shot Image
          <button
            type="button"
            className="flex min-h-14 w-full items-center gap-2 rounded-md border border-surface-700 bg-surface-950 px-2 py-2 text-left text-sm font-normal normal-case tracking-normal text-slate-100 outline-none hover:border-surface-500 focus-visible:border-brand-400"
            onClick={onChooseImage}
          >
            {selectedImage?.thumbnailDataUrl ? (
              <img src={selectedImage.thumbnailDataUrl} alt="" className="h-10 w-10 shrink-0 rounded object-cover" />
            ) : selectedImageGenerating ? (
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-brand-500/10 text-brand-300">
                <Loader2 size={18} className="animate-spin" />
              </span>
            ) : (
              <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded ${selectedImageError ? 'bg-rose-500/10 text-rose-300' : 'bg-surface-800 text-slate-500'}`}>
                <ImageIcon size={16} />
              </span>
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate">{selectedImage ? selectedImage.name : 'Choose or generate an image'}</span>
              <span className={`block truncate text-[11px] ${selectedImageGenerating ? 'text-brand-300' : selectedImageError ? 'text-rose-300' : 'text-slate-500'}`}>{selectedImageSubtitle}</span>
            </span>
          </button>
          {selectedImage && (
            <button type="button" className="self-start text-[11px] font-normal normal-case tracking-normal text-slate-400 hover:text-slate-100" onClick={() => onUpdate(marker.id, { imageAssetId: null })}>
              Clear shot image
            </button>
          )}
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
          <ImageModelSelect value={selectedImageModel.id} options={imageModels} onChange={onImageModelChange} />
          <button
            type="button"
            className="btn-primary h-9 self-end px-3 text-xs disabled:cursor-not-allowed disabled:opacity-50"
            onClick={onGenerateImage}
            disabled={imageGenerating || !marker.prompt.trim()}
            title={marker.prompt.trim() ? 'Generate this shot image' : 'Add a shot prompt first'}
          >
            <Sparkles size={12} />
            {imageGenerating ? 'Generating' : `$${estimateImageCostUsd(selectedImageModel).toFixed(3)}`}
          </button>
        </div>
        {imageGenerationError && <div className="rounded-md border border-rose-400/30 bg-rose-500/10 px-2 py-1.5 text-xs font-normal normal-case tracking-normal text-rose-200">{imageGenerationError}</div>}
        {imagePrompt.trim() && (
          <div className="rounded-md border border-surface-700 bg-surface-950/80 text-xs font-normal normal-case tracking-normal text-slate-300">
            <div className="flex items-center justify-between gap-2 border-b border-surface-800 px-2 py-1.5">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Image Prompt Used</span>
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded border border-surface-700 px-1.5 py-0.5 text-[10px] font-medium normal-case tracking-normal text-slate-300 hover:border-surface-500 hover:bg-surface-800"
                onClick={() => {
                  void navigator.clipboard.writeText(imagePrompt);
                }}
              >
                <Copy size={10} />
                Copy
              </button>
            </div>
            <details>
              <summary className="cursor-pointer list-none px-2 py-1.5 text-[11px] text-slate-400 hover:text-slate-200 marker:hidden">Show compiled prompt</summary>
              <pre className="max-h-44 overflow-auto whitespace-pre-wrap border-t border-surface-800 p-2 text-[11px] leading-5 text-slate-400">{imagePrompt}</pre>
            </details>
          </div>
        )}
        <div className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          Shot Prompt
          <ShotPromptEditor
            marker={marker}
            sequenceCharacters={sequenceCharacters}
            allCharacters={allCharacters}
            onChange={(value) => onUpdate(marker.id, { prompt: value })}
            onAcceptCharacter={onAcceptCharacterMention}
          />
        </div>
      </div>
    </section>
  );
}

function formatGenerationProgress(asset: MediaAsset): string {
  const progress = asset.generation?.progress;
  return Number.isFinite(progress) ? ` ${Math.round(progress ?? 0)}%` : '';
}

function ShotPromptEditor({
  marker,
  sequenceCharacters,
  allCharacters,
  onChange,
  onAcceptCharacter,
}: {
  marker: SequenceMarker;
  sequenceCharacters: MediaAsset[];
  allCharacters: MediaAsset[];
  onChange: (value: string) => void;
  onAcceptCharacter: (asset: MediaAsset) => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [mention, setMention] = useState<{ query: string; start: number; end: number; left: number; top: number } | null>(null);
  const attachedIds = useMemo(() => new Set(sequenceCharacters.map((asset) => asset.id)), [sequenceCharacters]);
  const mentionItems = useMemo(() => {
    const query = mention?.query.trim().toLowerCase() ?? '';
    return allCharacters
      .filter((asset) => {
        if (!query) return true;
        return [asset.name, asset.character?.characterId, asset.character?.description]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
          .includes(query);
      })
      .slice(0, 8);
  }, [allCharacters, mention?.query]);

  useEffect(() => {
    if (!mention) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (textareaRef.current?.contains(target)) return;
      setMention(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMention(null);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [mention]);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu || !mention) return;
    const margin = 8;
    const left = Math.min(Math.max(margin, mention.left), Math.max(margin, window.innerWidth - menu.offsetWidth - margin));
    const top = Math.min(Math.max(margin, mention.top), Math.max(margin, window.innerHeight - menu.offsetHeight - margin));
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
  }, [mention]);

  const refreshMention = (value: string, cursor: number) => {
    const prefix = value.slice(0, cursor);
    const match = prefix.match(/(^|\s)@([a-z0-9_-]{0,32})$/i);
    if (!match) {
      setMention(null);
      return;
    }
    const textarea = textareaRef.current;
    const rect = textarea?.getBoundingClientRect();
    setMention({
      query: match[2] ?? '',
      start: cursor - (match[2]?.length ?? 0) - 1,
      end: cursor,
      left: rect ? rect.left + 12 : 0,
      top: rect ? Math.min(rect.bottom - 4, window.innerHeight - 220) : 0,
    });
  };

  const handleChange = (value: string) => {
    onChange(value);
    const cursor = textareaRef.current?.selectionStart ?? value.length;
    refreshMention(value, cursor);
  };

  const insertCharacter = (asset: MediaAsset) => {
    const token = bareCharacterToken(asset);
    if (!token || !mention) return;
    const value = marker.prompt;
    const replacementEnd = mentionTokenEnd(value, mention.end);
    const next = `${value.slice(0, mention.start)}@${token} ${value.slice(replacementEnd)}`;
    const nextCursor = mention.start + token.length + 2;
    onChange(next);
    onAcceptCharacter(asset);
    setMention(null);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextCursor, nextCursor);
    });
  };

  return (
    <>
      <textarea
        ref={textareaRef}
        value={marker.prompt}
        onChange={(event) => handleChange(event.target.value)}
        onKeyUp={(event) => refreshMention(event.currentTarget.value, event.currentTarget.selectionStart)}
        onClick={(event) => refreshMention(event.currentTarget.value, event.currentTarget.selectionStart)}
        placeholder="Type @ to reference a sequence character."
        className="min-h-[116px] resize-none rounded-md border border-surface-700 bg-surface-950 px-2 py-2 text-sm font-normal normal-case tracking-normal text-slate-100 outline-none placeholder:text-slate-600 focus:border-brand-400"
      />
      {mention && mentionItems.length > 0 && createPortal(
        <div
          ref={menuRef}
          className="fixed z-[150] w-64 overflow-hidden rounded-md border border-surface-600 bg-surface-800 p-1 shadow-xl"
        >
          {mentionItems.map((asset) => {
            const token = bareCharacterToken(asset);
            return (
              <button
                key={asset.id}
                type="button"
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-slate-200 hover:bg-surface-700"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => insertCharacter(asset)}
              >
                {asset.thumbnailDataUrl ? (
                  <img src={asset.thumbnailDataUrl} alt="" className="h-7 w-7 shrink-0 rounded object-cover" />
                ) : (
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-surface-950 text-slate-500"><UserRound size={14} /></span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{asset.name}</span>
                  {token && <span className="block truncate text-[10px] text-brand-300">@{token}</span>}
                </span>
                {attachedIds.has(asset.id) && <Check size={13} className="shrink-0 text-emerald-300" />}
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </>
  );
}

function mentionTokenEnd(value: string, start: number): number {
  let index = start;
  while (index < value.length && /[a-z0-9_-]/i.test(value[index] ?? '')) index += 1;
  return index;
}

function SequenceMarkerContextMenu({
  x,
  y,
  onDelete,
  onClose,
}: {
  x: number;
  y: number;
  onDelete: () => void;
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
    const onDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('[data-sequence-marker-context-menu]')) return;
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
      data-sequence-marker-context-menu
      className="fixed z-[130] min-w-[130px] rounded-md border border-surface-600 bg-surface-800 py-1 text-xs text-slate-200 shadow-lg"
      onContextMenu={(event) => event.preventDefault()}
    >
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-red-300 hover:bg-red-900/40"
        onClick={() => {
          onDelete();
          onClose();
        }}
      >
        <Trash2 size={12} />
        Delete
      </button>
    </div>
  );
}

function SequenceImagePicker({
  assets,
  selectedId,
  onPick,
  onImport,
  onClose,
}: {
  assets: MediaAsset[];
  selectedId: string | null;
  onPick: (asset: MediaAsset) => void;
  onImport: () => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<'recent' | 'name' | 'size'>('recent');
  const filteredAssets = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return [...assets]
      .filter((asset) => {
        if (!normalizedQuery) return true;
        return [
          asset.name,
          asset.kind,
          asset.mimeType,
          asset.character?.characterId,
          asset.character?.description,
          `${asset.width ?? ''}x${asset.height ?? ''}`,
        ].join(' ').toLowerCase().includes(normalizedQuery);
      })
      .sort((a, b) => {
        if (sortKey === 'name') return a.name.localeCompare(b.name);
        if (sortKey === 'size') return (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0) || a.name.localeCompare(b.name);
        return b.createdAt - a.createdAt || a.name.localeCompare(b.name);
      });
  }, [assets, query, sortKey]);

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/55 p-4">
      <div className="w-[min(960px,94vw)] overflow-hidden rounded-xl border border-white/15 bg-[#0b1127] shadow-2xl">
        <div className="border-b border-white/10 p-3">
          <div className="mb-2 flex items-center justify-between">
            <div>
              <div className="text-sm font-semibold text-slate-100">Pick shot image</div>
              <div className="text-xs text-slate-400">Choose an image from media, or import a new image.</div>
            </div>
            <button className="rounded p-1 text-slate-400 hover:bg-white/10 hover:text-slate-100" onClick={onClose} title="Close" aria-label="Close">
              <X size={16} />
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex h-9 min-w-[260px] flex-1 items-center gap-2 rounded-full border border-white/10 bg-black/20 px-3 text-xs text-slate-300">
              <Search size={14} className="text-slate-500" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search images by name, type, or size"
                className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-slate-500"
                autoFocus
              />
            </label>
            <div className="inline-flex h-9 items-center rounded-full border border-white/10 bg-black/20 p-0.5">
              {(['recent', 'name', 'size'] as const).map((key) => (
                <button
                  key={key}
                  type="button"
                  className={`h-7 rounded-full px-2.5 text-xs capitalize transition ${sortKey === key ? 'bg-white text-slate-950' : 'text-slate-300 hover:bg-white/10'}`}
                  onClick={() => setSortKey(key)}
                >
                  {key}
                </button>
              ))}
            </div>
            <button className="inline-flex h-9 items-center gap-1 rounded-full border border-white/15 bg-white/10 px-3 text-xs text-slate-100 hover:bg-white/20" onClick={onImport}>
              <Upload size={12} />
              Import Image
            </button>
          </div>
        </div>
        <div className="max-h-[520px] overflow-auto p-3">
          <div className="mb-2 flex items-center justify-between px-1 text-[11px] text-slate-500">
            <span>{filteredAssets.length} of {assets.length} images</span>
            <span>{sortKey === 'recent' ? 'Recent first' : sortKey === 'size' ? 'Largest first' : 'A-Z'}</span>
          </div>
          {filteredAssets.length === 0 ? (
            <div className="rounded-lg border border-dashed border-white/15 p-8 text-center text-xs text-slate-500">
              No references match this search.
            </div>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-2">
              {filteredAssets.map((asset) => {
                const selected = asset.id === selectedId;
                return (
                  <button
                    key={asset.id}
                    type="button"
                    className={`group overflow-hidden rounded-lg border bg-white/[0.03] text-left transition ${selected ? 'border-brand-400 ring-1 ring-brand-400/70' : 'border-white/10 hover:border-white/25 hover:bg-white/[0.06]'}`}
                    onClick={() => onPick(asset)}
                  >
                    <div className="relative aspect-video bg-black/45">
                      {asset.thumbnailDataUrl ? (
                        <img src={asset.thumbnailDataUrl} alt="" className="h-full w-full object-cover" draggable={false} />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center text-slate-500">
                          <ImageIcon size={22} />
                        </div>
                      )}
                      <span className="absolute left-1 top-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-medium text-white">
                        Image
                      </span>
                      {selected && (
                        <span className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-brand-400 text-slate-950">
                          <Check size={12} />
                        </span>
                      )}
                    </div>
                    <div className="px-2 py-1.5">
                      <div className="truncate text-xs font-medium text-slate-100">{asset.name}</div>
                      <div className="mt-0.5 truncate text-[10px] text-slate-500">{referenceSubtitle(asset)}</div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SequenceCharacterPicker({
  assets,
  selectedIds,
  onPick,
  onClose,
}: {
  assets: MediaAsset[];
  selectedIds: string[];
  onPick: (asset: MediaAsset) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const filteredAssets = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return [...assets]
      .filter((asset) => {
        if (!normalizedQuery) return true;
        return [asset.name, asset.character?.characterId, asset.character?.description, asset.character?.style]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
          .includes(normalizedQuery);
      })
      .sort((a, b) => b.createdAt - a.createdAt || a.name.localeCompare(b.name));
  }, [assets, query]);

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/55 p-4">
      <div className="w-[min(860px,94vw)] overflow-hidden rounded-xl border border-white/15 bg-[#0b1127] shadow-2xl">
        <div className="border-b border-white/10 p-3">
          <div className="mb-2 flex items-center justify-between">
            <div>
              <div className="text-sm font-semibold text-slate-100">Attach sequence characters</div>
              <div className="text-xs text-slate-400">Characters attached here can be referenced from any shot prompt with @.</div>
            </div>
            <button className="rounded p-1 text-slate-400 hover:bg-white/10 hover:text-slate-100" onClick={onClose} title="Close" aria-label="Close">
              <X size={16} />
            </button>
          </div>
          <label className="flex h-9 items-center gap-2 rounded-full border border-white/10 bg-black/20 px-3 text-xs text-slate-300">
            <Search size={14} className="text-slate-500" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search characters by name or @token"
              className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-slate-500"
              autoFocus
            />
          </label>
        </div>
        <div className="max-h-[520px] overflow-auto p-3">
          <div className="mb-2 flex items-center justify-between px-1 text-[11px] text-slate-500">
            <span>{filteredAssets.length} of {assets.length} characters</span>
            <span>{selected.size} attached</span>
          </div>
          {filteredAssets.length === 0 ? (
            <div className="rounded-lg border border-dashed border-white/15 p-8 text-center text-xs text-slate-500">
              No character references match this search.
            </div>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-2">
              {filteredAssets.map((asset) => {
                const active = selected.has(asset.id);
                const token = bareCharacterToken(asset);
                return (
                  <button
                    key={asset.id}
                    type="button"
                    className={`group overflow-hidden rounded-lg border bg-white/[0.03] text-left transition ${active ? 'border-brand-400 ring-1 ring-brand-400/70' : 'border-white/10 hover:border-white/25 hover:bg-white/[0.06]'}`}
                    onClick={() => onPick(asset)}
                  >
                    <div className="relative aspect-video bg-black/45">
                      {asset.thumbnailDataUrl ? (
                        <img src={asset.thumbnailDataUrl} alt="" className="h-full w-full object-cover" draggable={false} />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center text-slate-500">
                          <UserRound size={24} />
                        </div>
                      )}
                      <span className="absolute left-1 top-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-medium text-white">
                        @{token ?? 'character'}
                      </span>
                      {active && (
                        <span className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-brand-400 text-slate-950">
                          <Check size={12} />
                        </span>
                      )}
                    </div>
                    <div className="px-2 py-1.5">
                      <div className="truncate text-xs font-medium text-slate-100">{asset.name}</div>
                      <div className="mt-0.5 truncate text-[10px] text-slate-500">{referenceSubtitle(asset)}</div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function createDefaultSequence(model?: VideoModelDefinition): SequenceAssetData {
  const duration = model ? durationsForModel(model)[0] ?? 8 : 8;
  return {
    model: model?.id ?? 'piapi-seedance-2',
    imageModel: defaultImageModel().id,
    durationSec: duration,
    overallPrompt: '',
    characterAssetIds: [],
    markers: [],
  };
}

function normalizeSequence(sequence: SequenceAssetData, assets: MediaAsset[] = []): SequenceAssetData {
  const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
  const characterAssetIds = [...(sequence.characterAssetIds ?? [])];
  const markers = sequence.markers.map((marker) => {
    const referenceAsset = marker.imageAssetId ? assetsById.get(marker.imageAssetId) : null;
    if (referenceAsset?.kind === 'character') {
      characterAssetIds.push(referenceAsset.id);
      return { ...marker, imageAssetId: null, timeSec: clampTime(marker.timeSec, sequence.durationSec) };
    }
    return { ...marker, timeSec: clampTime(marker.timeSec, sequence.durationSec) };
  });
  return {
    ...sequence,
    imageModel: sequence.imageModel ?? defaultImageModel().id,
    characterAssetIds: uniqueIds(characterAssetIds),
    durationSec: Math.max(1, sequence.durationSec),
    markers: markers.sort((a, b) => a.timeSec - b.timeSec),
  };
}

function buildShotImagePrompt(sequence: SequenceAssetData, targetMarker: SequenceMarker, assets: MediaAsset[]): string {
  const sortedMarkers = sortedSequenceMarkers(sequence);
  const targetIndex = Math.max(0, sortedMarkers.findIndex((marker) => marker.id === targetMarker.id));
  const targetShotNumber = targetIndex + 1;
  const previousMarker = previousMarkerWithPrompt(sortedMarkers, targetIndex);
  const nextMarker = nextMarkerWithPrompt(sortedMarkers, targetIndex);
  const frameCharacters = characterReferenceAssetsForTarget(sequence, targetMarker, assets);
  const adjacentReferences = adjacentShotImageReferences(sequence, targetMarker, assets);
  const lines: string[] = [];
  const overallPrompt = sequence.overallPrompt.trim();

  lines.push('Generate exactly one still frame for a video sequence.');
  lines.push('The selected frame below is the only moment to render. Treat every other shot as continuity context, not as visual action to depict.');
  lines.push('');
  lines.push('SELECTED FRAME TO RENDER:');
  lines.push(`- Shot: ${targetShotNumber} of ${sortedMarkers.length || 1}`);
  lines.push(`- Timecode: ${formatSequenceTimestamp(targetMarker.timeSec)}`);
  lines.push(`- Frame prompt: ${targetMarker.prompt.trim() || 'Untitled shot'}`);
  lines.push('');
  lines.push('FRAME LOCK:');
  lines.push('- Render this single time slice only.');
  lines.push('- Do not turn it into a montage, summary, or later beat from the sequence.');
  lines.push('- If surrounding shots mention future action, use that only for continuity of location, wardrobe, character identity, lighting, and tone.');
  lines.push('');

  if (frameCharacters.length > 0) {
    lines.push('CHARACTER REFERENCES FOR THIS FRAME:');
    for (const asset of frameCharacters) {
      const token = bareCharacterToken(asset);
      const description = asset.character?.description?.trim();
      if (token) lines.push(`- @${token}: ${asset.name}${description ? `, ${description}` : ''}`);
    }
    lines.push('');
  }

  if (adjacentReferences.length > 0) {
    lines.push('SUPPLIED IMAGE REFERENCES:');
    for (const reference of adjacentReferences) {
      lines.push(`- ${reference.label}: ${reference.marker.prompt.trim() || 'Adjacent shot'} (${formatSequenceTimestamp(reference.marker.timeSec)}), use for continuity only.`);
    }
    lines.push('');
  }

  lines.push('LIGHTING AND STYLE CONTINUITY:');
  if (adjacentReferences.length > 0) {
    lines.push('- Match the supplied reference frame lighting direction, color temperature, exposure, contrast, lens feel, grain/noise level, and overall visual style.');
    lines.push('- Keep character wardrobe, materials, skin tone, hair, and environment treatment consistent with the reference frames.');
    lines.push('- Do not copy the pose, gesture, facial expression, camera action, or story event from the reference frames unless it is explicitly part of the selected frame prompt.');
  } else {
    lines.push('- Establish a consistent cinematic lighting style that can be carried across later frames in this sequence.');
    lines.push('- Keep exposure, contrast, color temperature, lens feel, and production design coherent with the sequence brief and character references.');
  }
  lines.push('');

  if (overallPrompt) {
    lines.push('SEQUENCE BRIEF FOR CONTINUITY ONLY:');
    lines.push(overallPrompt);
    lines.push('');
  }

  if (previousMarker || nextMarker) {
    lines.push('ADJACENT STORY CONTEXT, NOT THE IMAGE SUBJECT:');
    if (previousMarker) lines.push(`- Previous: ${previousMarker.prompt.trim()} (${formatSequenceTimestamp(previousMarker.timeSec)})`);
    if (nextMarker) lines.push(`- Next: ${nextMarker.prompt.trim()} (${formatSequenceTimestamp(nextMarker.timeSec)})`);
    lines.push('');
  }

  lines.push('OUTPUT:');
  lines.push('Create a production-ready cinematic still image for the selected frame only. Keep later story events outside this frame. No captions, no UI, no text overlays, no timeline graphics.');
  return lines.join('\n');
}

function shotImageReferenceAssets(sequence: SequenceAssetData, targetMarker: SequenceMarker, assets: MediaAsset[]): MediaAsset[] {
  const characterReferences = characterReferenceAssetsForTarget(sequence, targetMarker, assets);
  const shotImages = adjacentShotImageReferences(sequence, targetMarker, assets).map((reference) => reference.asset);
  return uniqueAssetReferences([...characterReferences, ...shotImages]);
}

function characterReferenceAssetsForTarget(sequence: SequenceAssetData, targetMarker: SequenceMarker, assets: MediaAsset[]): MediaAsset[] {
  const attached = new Set(sequence.characterAssetIds ?? []);
  if (attached.size === 0) return [];
  const promptText = [sequence.overallPrompt, targetMarker.prompt].join('\n');
  const tokens = new Set(extractPromptReferenceTokens(promptText));
  const referenced = assets.filter((asset) => {
    if (!attached.has(asset.id) || asset.kind !== 'character') return false;
    const token = bareCharacterToken(asset);
    return token ? tokens.has(token.toLowerCase()) : false;
  });
  if (referenced.length > 0) return referenced;
  return assets.filter((asset) => attached.has(asset.id) && asset.kind === 'character');
}

function adjacentShotImageReferences(sequence: SequenceAssetData, targetMarker: SequenceMarker, assets: MediaAsset[]): Array<{ asset: MediaAsset; marker: SequenceMarker; label: string }> {
  const sortedMarkers = sortedSequenceMarkers(sequence);
  const targetIndex = sortedMarkers.findIndex((marker) => marker.id === targetMarker.id);
  const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
  const references: Array<{ asset: MediaAsset; marker: SequenceMarker; label: string }> = [];
  const previous = nearestImageMarker(sortedMarkers, targetIndex, -1);
  const next = nearestImageMarker(sortedMarkers, targetIndex, 1);
  if (previous?.imageAssetId) {
    const asset = assetsById.get(previous.imageAssetId);
    if (asset?.kind === 'image') references.push({ asset, marker: previous, label: 'Previous shot image reference' });
  }
  if (next?.imageAssetId) {
    const asset = assetsById.get(next.imageAssetId);
    if (asset?.kind === 'image') references.push({ asset, marker: next, label: 'Next shot image reference' });
  }
  return references;
}

function previousMarkerWithPrompt(markers: SequenceMarker[], targetIndex: number): SequenceMarker | null {
  for (let index = targetIndex - 1; index >= 0; index -= 1) {
    if (markers[index]?.prompt.trim()) return markers[index]!;
  }
  return null;
}

function nextMarkerWithPrompt(markers: SequenceMarker[], targetIndex: number): SequenceMarker | null {
  for (let index = targetIndex + 1; index < markers.length; index += 1) {
    if (markers[index]?.prompt.trim()) return markers[index]!;
  }
  return null;
}

function nearestImageMarker(markers: SequenceMarker[], targetIndex: number, direction: -1 | 1): SequenceMarker | null {
  for (let index = targetIndex + direction; index >= 0 && index < markers.length; index += direction) {
    if (markers[index]?.imageAssetId) return markers[index]!;
  }
  return null;
}

async function buildImageReferenceInput(
  assets: MediaAsset[],
  model: ImageModelDefinition,
  objectUrlFor: (assetId: string) => Promise<string | null>,
): Promise<{ referenceUrls?: string[]; referenceFiles?: File[] }> {
  if (assets.length === 0) return {};
  if (isGptImageModel(model)) {
    const files = await Promise.all(assets.map((asset) => referenceFileForAsset(asset, objectUrlFor)));
    return { referenceFiles: files.filter((file): file is File => Boolean(file)) };
  }
  return { referenceUrls: await Promise.all(assets.map((asset) => hostLitterboxReference(asset, 'Sequence reference'))) };
}

async function referenceFileForAsset(asset: MediaAsset, objectUrlFor: (assetId: string) => Promise<string | null>): Promise<File | null> {
  const url = await objectUrlFor(asset.id);
  if (!url) return null;
  const blob = await fetch(url).then((response) => response.blob());
  const extension = extensionForMime(blob.type || asset.mimeType);
  return new File([blob], referenceFileName(asset, extension), { type: blob.type || asset.mimeType || 'image/png' });
}

function referenceFileName(asset: MediaAsset, extension: string): string {
  const base = asset.character?.characterId ?? asset.name.replace(/\.[a-z0-9]{2,8}$/i, '') ?? asset.id;
  const safe = base
    .trim()
    .replace(/[^a-z0-9_-]+/gi, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '');
  return `${safe || asset.id}.${extension}`;
}

function extensionForMime(mimeType: string): string {
  if (/jpe?g/i.test(mimeType)) return 'jpg';
  if (/webp/i.test(mimeType)) return 'webp';
  return 'png';
}

function uniqueAssetReferences(assets: MediaAsset[]): MediaAsset[] {
  const seen = new Set<string>();
  const unique: MediaAsset[] = [];
  for (const asset of assets) {
    if (seen.has(asset.id)) continue;
    seen.add(asset.id);
    unique.push(asset);
  }
  return unique;
}

function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids)];
}

function formatGenerationError(err: unknown): string {
  if (err instanceof VideoGenerationProviderError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Sequence image generation failed.';
}

async function readPiApiKey(): Promise<string | null> {
  for (const key of [PIAPI_API_KEY_STORAGE, PIAPI_VEO_API_KEY_STORAGE, PIAPI_KLING_API_KEY_STORAGE]) {
    const encrypted = localStorage.getItem(key);
    if (!encrypted) continue;
    try {
      const decrypted = await decryptSecret(encrypted);
      if (decrypted.trim()) return decrypted.trim();
    } catch {
      // Try the next legacy key slot.
    }
  }
  return null;
}

function durationsForModel(model: VideoModelDefinition): number[] {
  return model.capabilities.durations.map((duration) => Number(duration.replace('s', ''))).filter((duration) => Number.isFinite(duration));
}

function referenceSubtitle(asset: MediaAsset): string {
  if (asset.kind === 'character') {
    const token = bareCharacterToken(asset) ? `@${bareCharacterToken(asset)}` : 'Character';
    const style = asset.character?.style ? ` · ${asset.character.style}` : '';
    return `${token}${style}`;
  }
  return asset.width && asset.height ? `${asset.width}x${asset.height}` : asset.mimeType;
}

function bareCharacterToken(asset: MediaAsset): string | null {
  return characterTokenForAsset(asset)?.replace(/^@/, '') ?? null;
}

function clampTime(timeSec: number, durationSec: number): number {
  if (!Number.isFinite(timeSec)) return 0;
  return Math.max(0, Math.min(durationSec, Number(timeSec.toFixed(2))));
}

function timeToX(timeSec: number, durationSec: number): number {
  if (durationSec <= 0) return 0;
  return (clampTime(timeSec, durationSec) / durationSec) * SVG_WIDTH;
}

function timelineTicks(durationSec: number): number[] {
  const step = durationSec > 10 ? 2 : 1;
  const ticks: number[] = [];
  for (let tick = 0; tick <= durationSec; tick += step) ticks.push(tick);
  if (ticks[ticks.length - 1] !== durationSec) ticks.push(durationSec);
  return ticks;
}

function formatTime(timeSec: number): string {
  return formatSequenceTimestamp(timeSec);
}

function mostRecentImageMarker(markers: SequenceMarker[], currentTimeSec: number): SequenceMarker | null {
  let latest: SequenceMarker | null = null;
  for (const marker of markers) {
    if (marker.timeSec > currentTimeSec) break;
    if (marker.imageAssetId) latest = marker;
  }
  return latest;
}
