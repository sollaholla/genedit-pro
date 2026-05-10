import { Film, Image as ImageIcon, Paintbrush, Pause, Play, Plus, RotateCcw, Save, Sparkles, Trash2, Undo2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
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
import { downloadGeneratedImageFile } from '@/lib/imageGeneration/download';
import { generatePiApiImage, isGptImageModel } from '@/lib/imageGeneration/piapi';
import { DEFAULT_EDIT_TRAIL_TRANSFORM } from '@/lib/media/editTrail';
import { getBlob, putBlob, deleteBlob } from '@/lib/media/storage';
import {
  CONNECTION_SETTINGS_CHANGED_EVENT,
  PIAPI_API_KEY_STORAGE,
  PIAPI_KLING_API_KEY_STORAGE,
  PIAPI_VEO_API_KEY_STORAGE,
} from '@/lib/settings/connectionStorage';
import { decryptSecret } from '@/lib/settings/crypto';
import { VideoGenerationProviderError } from '@/lib/videoGeneration/errors';
import { hostLitterboxFile } from '@/lib/videoGeneration/litterbox';
import { useMediaStore } from '@/state/mediaStore';
import type { EditTrailIteration, EditTrailTransform, MediaAsset } from '@/types';
import { ImageModelSelect } from './ImageModelSelect';

type Props = {
  assetId: string;
  onClose: () => void;
};

const IMAGE_MODELS = sortImageModelsByPriority(DEFAULT_IMAGE_MODELS);
const PAINT_COLORS = ['#ff3b30', '#ffcc00', '#00d084', '#20a7f3', '#ffffff'];
const PAINT_BRUSH_SIZE = 10;

type SavedPaintOverlay = {
  blobKey: string;
  file: File;
  width: number;
  height: number;
  created: boolean;
};

export function EditTrailDialog({ assetId, onClose }: Props) {
  const asset = useMediaStore((s) => s.assets.find((item) => item.id === assetId) ?? null);
  const ensureEditTrail = useMediaStore((s) => s.ensureEditTrail);
  const addEditTrailIteration = useMediaStore((s) => s.addEditTrailIteration);
  const saveEditTrailIteration = useMediaStore((s) => s.saveEditTrailIteration);
  const startEditTrailGeneration = useMediaStore((s) => s.startEditTrailGeneration);
  const updateEditTrailGenerationProgress = useMediaStore((s) => s.updateEditTrailGenerationProgress);
  const updateEditTrailGenerationTask = useMediaStore((s) => s.updateEditTrailGenerationTask);
  const failEditTrailGeneration = useMediaStore((s) => s.failEditTrailGeneration);
  const addGeneratedEditTrailIteration = useMediaStore((s) => s.addGeneratedEditTrailIteration);
  const setActiveEditTrailIteration = useMediaStore((s) => s.setActiveEditTrailIteration);
  const undoEditTrail = useMediaStore((s) => s.undoEditTrail);
  const objectUrlFor = useMediaStore((s) => s.objectUrlFor);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const imageLayerRef = useRef<HTMLDivElement | null>(null);
  const paintCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const paintingRef = useRef(false);
  const lastPaintPointRef = useRef<{ x: number; y: number } | null>(null);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [draft, setDraft] = useState<EditTrailTransform>(DEFAULT_EDIT_TRAIL_TRANSFORM);
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [generationProgress, setGenerationProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [videoCurrentTime, setVideoCurrentTime] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);
  const [videoPlaying, setVideoPlaying] = useState(false);
  const [imageModelId, setImageModelId] = useState(() => defaultImageModel().id);
  const [editPrompt, setEditPrompt] = useState('');
  const [paintMode, setPaintMode] = useState(false);
  const [paintColor, setPaintColor] = useState(PAINT_COLORS[0]!);
  const [paintHasInk, setPaintHasInk] = useState(false);
  const [paintOverlayUrl, setPaintOverlayUrl] = useState<string | null>(null);

  const iterations = useMemo(() => {
    return [...(asset?.editTrail?.iterations ?? [])].sort((a, b) => b.createdAt - a.createdAt);
  }, [asset?.editTrail?.iterations]);
  const activeIteration = useMemo(() => {
    if (!asset?.editTrail) return null;
    return asset.editTrail.iterations.find((iteration) => iteration.id === asset.editTrail?.activeIterationId) ?? null;
  }, [asset?.editTrail]);
  const baseIterationId = asset?.editTrail?.iterations[0]?.id;
  const activeIsBase = Boolean(activeIteration && activeIteration.id === baseIterationId);
  const canUndo = Boolean(activeIteration && !activeIsBase);
  const activeAssetId = asset?.id;
  const assetKind = asset?.kind;
  const activeIterationTransform = activeIteration?.transform;
  const activeIterationEditPrompt = activeIteration?.generation?.editPrompt;
  const activeIterationModel = activeIteration?.generation?.model;
  const activeIterationPaintOverlayBlobKey = activeIteration?.generation?.paintOverlayBlobKey;
  const selectedImageModel = imageModelById(imageModelId) ?? defaultImageModel();
  const estimatedImageCostUsd = estimateImageCostUsd(selectedImageModel);
  const pendingEditTrailGeneration = asset?.editTrailGeneration ?? null;
  const editTrailGenerating = pendingEditTrailGeneration?.status === 'generating';
  const working = saving || generating || editTrailGenerating;
  const displayedGenerationProgress = editTrailGenerating ? pendingEditTrailGeneration.progress ?? generationProgress : generationProgress;
  const persistedError = pendingEditTrailGeneration?.status === 'error'
    ? pendingEditTrailGeneration.errorMessage ?? 'Generation failed.'
    : null;
  const visibleError = error ?? persistedError;
  const canGenerateImageEdit = Boolean(asset?.kind === 'image' && sourceUrl && editPrompt.trim()) && !working;

  useEffect(() => {
    if (!asset || (asset.kind !== 'image' && asset.kind !== 'video')) return;
    ensureEditTrail(asset.id);
  }, [asset, ensureEditTrail]);

  useEffect(() => {
    if (!assetKind) return;
    setDraft(assetKind === 'video'
      ? activeIterationTransform ?? DEFAULT_EDIT_TRAIL_TRANSFORM
      : DEFAULT_EDIT_TRAIL_TRANSFORM);
  }, [activeAssetId, assetKind, activeIteration?.id, activeIterationTransform]);

  useEffect(() => {
    let mounted = true;
    if (!asset?.blobKey) return;
    setSourceUrl(null);
    void objectUrlFor(asset.id).then((url) => {
      if (mounted) setSourceUrl(url);
    });
    return () => {
      mounted = false;
    };
  }, [asset?.blobKey, asset?.editTrail?.activeIterationId, asset?.id, objectUrlFor]);

  useEffect(() => {
    setVideoCurrentTime(0);
    setVideoDuration(0);
    setVideoPlaying(false);
  }, [sourceUrl]);

  useEffect(() => {
    applyPreviewTransform(videoRef.current, draft);
    applyPreviewTransform(imageLayerRef.current, draft);
  }, [draft, sourceUrl]);

  useEffect(() => {
    if (assetKind !== 'image') return;
    const modelFromIteration = imageModelById(activeIterationModel ?? '');
    setImageModelId(modelFromIteration?.id ?? defaultImageModel().id);
    setEditPrompt(activeIterationEditPrompt ?? '');
    setPaintMode(false);
    setGenerationProgress(0);
  }, [activeAssetId, assetKind, activeIteration?.id, activeIterationEditPrompt, activeIterationModel]);

  useEffect(() => {
    if (assetKind !== 'image') {
      setPaintOverlayUrl(null);
      setPaintHasInk(false);
      return undefined;
    }

    let mounted = true;
    let objectUrl: string | null = null;
    clearPaintCanvas();
    setPaintOverlayUrl(null);

    const overlayBlobKey = activeIterationPaintOverlayBlobKey;
    if (!overlayBlobKey) {
      setPaintHasInk(false);
      return undefined;
    }

    void getBlob(overlayBlobKey).then((blob) => {
      if (!mounted) return;
      if (!blob) {
        setPaintHasInk(false);
        return;
      }
      objectUrl = URL.createObjectURL(blob);
      setPaintOverlayUrl(objectUrl);
      setPaintHasInk(true);
    });

    return () => {
      mounted = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [assetKind, activeIteration?.id, activeIterationPaintOverlayBlobKey]);

  useEffect(() => {
    if (assetKind !== 'image' || !paintMode || !sourceUrl) return undefined;
    const canvas = paintCanvasRef.current;
    const image = imageRef.current;
    if (!canvas || !image) return undefined;

    const resizeCanvas = (forceRedraw = false) => {
      const rect = image.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const width = Math.max(1, Math.round(rect.width * dpr));
      const height = Math.max(1, Math.round(rect.height * dpr));
      const changed = canvas.width !== width || canvas.height !== height;
      if (changed) {
        canvas.width = width;
        canvas.height = height;
      }
      if (changed || forceRedraw) {
        const context = canvas.getContext('2d');
        context?.clearRect(0, 0, canvas.width, canvas.height);
        if (paintOverlayUrl) void drawPaintOverlayFromUrl(canvas, paintOverlayUrl);
      }
    };

    const observer = new ResizeObserver(() => resizeCanvas());
    observer.observe(image);
    const frameId = window.requestAnimationFrame(() => resizeCanvas(true));
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frameId);
    };
  }, [assetKind, paintMode, paintOverlayUrl, sourceUrl]);

  useEffect(() => {
    const onConnectionsChanged = () => setError(null);
    window.addEventListener(CONNECTION_SETTINGS_CHANGED_EVENT, onConnectionsChanged);
    return () => window.removeEventListener(CONNECTION_SETTINGS_CHANGED_EVENT, onConnectionsChanged);
  }, []);

  if (!asset || (asset.kind !== 'image' && asset.kind !== 'video')) return null;

  const commitIteration = async (mode: 'save-active' | 'add-new') => {
    if (!sourceUrl || working) return;
    setSaving(true);
    setError(null);
    try {
      let file: File | null = null;
      let thumbnail: string | undefined;
      if (asset.kind === 'image') {
        file = await renderEditedImageFile(asset, sourceUrl, draft);
      } else {
        thumbnail = asset.thumbnailDataUrl
          ? await renderEditedThumbnail(asset.thumbnailDataUrl, draft).catch(() => asset.thumbnailDataUrl)
          : undefined;
      }
      if (mode === 'add-new') await addEditTrailIteration(asset.id, file, draft, thumbnail);
      else await saveEditTrailIteration(asset.id, file, draft, thumbnail);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save edit iteration.');
    } finally {
      setSaving(false);
    }
  };

  const undoIteration = async () => {
    if (!canUndo || working) return;
    setSaving(true);
    setError(null);
    try {
      await undoEditTrail(asset.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not undo edit iteration.');
    } finally {
      setSaving(false);
    }
  };

  const toggleVideoPlayback = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      void video.play();
      return;
    }
    video.pause();
  };

  const scrubVideo = (value: number) => {
    const video = videoRef.current;
    if (!video || !Number.isFinite(value)) return;
    video.currentTime = value;
    setVideoCurrentTime(value);
  };

  function clearPaintCanvas() {
    const canvas = paintCanvasRef.current;
    if (canvas) {
      const context = canvas.getContext('2d');
      context?.save();
      context?.setTransform(1, 0, 0, 1, 0, 0);
      context?.clearRect(0, 0, canvas.width, canvas.height);
      context?.restore();
    }
    paintingRef.current = false;
    lastPaintPointRef.current = null;
    setPaintOverlayUrl(null);
    setPaintHasInk(false);
  }

  const togglePaintMode = () => {
    if (paintMode) {
      setPaintMode(false);
      return;
    }
    setPaintMode(true);
  };

  const beginPaintStroke = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!paintMode || working) return;
    const canvas = paintCanvasRef.current;
    if (!canvas) return;
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    paintingRef.current = true;
    const point = paintPoint(event, canvas);
    lastPaintPointRef.current = point;
    drawPaintStroke(point, point);
  };

  const continuePaintStroke = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!paintingRef.current || !paintMode || working) return;
    const canvas = paintCanvasRef.current;
    const lastPoint = lastPaintPointRef.current;
    if (!canvas || !lastPoint) return;
    event.preventDefault();
    const point = paintPoint(event, canvas);
    drawPaintStroke(lastPoint, point);
    lastPaintPointRef.current = point;
  };

  const endPaintStroke = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (paintCanvasRef.current?.hasPointerCapture(event.pointerId)) {
      paintCanvasRef.current.releasePointerCapture(event.pointerId);
    }
    paintingRef.current = false;
    lastPaintPointRef.current = null;
  };

  function paintPoint(event: ReactPointerEvent<HTMLCanvasElement>, canvas: HTMLCanvasElement): { x: number; y: number } {
    const rect = canvas.getBoundingClientRect();
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
  }

  function drawPaintStroke(from: { x: number; y: number }, to: { x: number; y: number }) {
    const canvas = paintCanvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = rect.width > 0 ? canvas.width / rect.width : window.devicePixelRatio || 1;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.save();
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.lineWidth = PAINT_BRUSH_SIZE;
    context.strokeStyle = paintColor;
    context.beginPath();
    context.moveTo(from.x, from.y);
    context.lineTo(to.x, to.y);
    context.stroke();
    context.restore();
    setPaintHasInk(true);
  }

  const generateImageEdit = async () => {
    if (!canGenerateImageEdit || asset.kind !== 'image' || !sourceUrl) return;
    const apiKey = await readPiApiKey();
    if (!apiKey) {
      setError('Connect PiAPI in Settings before editing images.');
      return;
    }

    const editPromptText = editPrompt.trim();
    const providerPrompt = buildImagePaintEditPrompt(editPromptText, paintHasInk);
    let savedOverlay: SavedPaintOverlay | null = null;
    setGenerating(true);
    setGenerationProgress(2);
    setError(null);
    startEditTrailGeneration(asset.id, {
      prompt: providerPrompt,
      editPrompt: editPromptText,
      model: selectedImageModel.id,
      estimatedCostUsd: estimatedImageCostUsd,
    });

    const updateProgress = (value: number) => {
      setGenerationProgress(value);
      updateEditTrailGenerationProgress(asset.id, value);
    };

    try {
      const sourceFile = await renderEditedImageFile(asset, sourceUrl, draft);
      savedOverlay = await saveCurrentPaintOverlay(activeIteration, imageRef.current, paintCanvasRef.current, paintHasInk);
      const guideFile = savedOverlay
        ? await paintGuideFileFromOverlay(sourceFile, savedOverlay.file)
        : null;
      const editInput = await buildImageEditInput(sourceFile, guideFile, selectedImageModel);
      const generated = await generatePiApiImage({
        model: selectedImageModel,
        prompt: providerPrompt,
        aspectRatio: CHARACTER_IMAGE_ASPECT_RATIO,
        resolution: CHARACTER_IMAGE_RESOLUTION,
        outputFormat: selectedImageModel.capabilities.defaultOutputFormat,
        ...editInput,
        onProgress: updateProgress,
        onTaskAccepted: (task) => updateEditTrailGenerationTask(asset.id, {
          provider: isGptImageModel(selectedImageModel) ? 'piapi-gpt-image' : 'piapi-gemini',
          providerTaskId: task.task_id,
          providerTaskEndpoint: task.task_id ? `/api/v1/task/${task.task_id}` : '/api/v1/task',
          providerTaskStatus: task.status,
          providerTaskCreatedAt: Date.now(),
        }),
      }, { apiKey });
      const file = await downloadGeneratedImageFile(generated.url, updateProgress);
      await addGeneratedEditTrailIteration(asset.id, file, {
        prompt: providerPrompt,
        editPrompt: editPromptText,
        model: selectedImageModel.id,
        estimatedCostUsd: estimatedImageCostUsd,
        actualCostUsd: generated.actualCostUsd ?? estimatedImageCostUsd,
        provider: generated.provider,
        providerTaskId: generated.providerTaskId,
        providerTaskEndpoint: generated.providerTaskEndpoint,
        providerTaskStatus: generated.providerTaskStatus,
        providerArtifactUri: generated.url,
        providerArtifactExpiresAt: generated.providerArtifactExpiresAt,
        paintOverlayBlobKey: savedOverlay?.blobKey,
        paintOverlayWidth: savedOverlay?.width,
        paintOverlayHeight: savedOverlay?.height,
      });
      savedOverlay = null;
      setGenerationProgress(100);
      setPaintMode(false);
    } catch (err) {
      if (savedOverlay?.created) await deleteBlob(savedOverlay.blobKey).catch(() => undefined);
      const message = formatGenerationError(err);
      setError(message);
      failEditTrailGeneration(asset.id, {
        actualCostUsd: estimatedImageCostUsd,
        errorMessage: message,
        errorType: err instanceof VideoGenerationProviderError ? err.type : 'InternalError',
      });
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm">
      <div className="flex h-[min(760px,92vh)] w-[min(1120px,96vw)] overflow-hidden rounded-lg border border-white/15 bg-surface-950 text-slate-100 shadow-2xl">
        <aside className="flex w-64 shrink-0 flex-col border-r border-surface-700 bg-surface-900/70">
          <div className="border-b border-surface-700 px-3 py-3">
            <div className="min-w-0">
              <div className="text-xs font-semibold uppercase tracking-wider text-slate-500">Edit Trail</div>
              <div className="truncate text-sm font-semibold text-slate-100">{asset.name}</div>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            <div className="space-y-2">
              {iterations.map((iteration) => {
                const active = iteration.id === asset.editTrail?.activeIterationId;
                return (
                  <button
                    type="button"
                    key={iteration.id}
                    aria-current={active ? 'true' : undefined}
                    onClick={() => setActiveEditTrailIteration(asset.id, iteration.id)}
                    className={`w-full rounded-lg border p-2 text-left transition ${
                      active
                        ? 'border-brand-400/80 bg-brand-500/10 shadow-[0_0_0_1px_rgba(124,140,255,0.18)]'
                        : 'border-surface-700 bg-surface-950/60 hover:border-brand-400/70 hover:bg-surface-800 focus-visible:border-brand-400/80 focus-visible:outline-none'
                    }`}
                  >
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-xs font-semibold text-slate-100">{iteration.label}</div>
                        <div className="text-[10px] uppercase tracking-wide text-slate-500">
                          {active ? 'Current source' : iteration.source}
                        </div>
                      </div>
                      {active && <span className="rounded-full bg-brand-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-brand-400">Active</span>}
                    </div>
                    <div className="aspect-video overflow-hidden rounded bg-black/35">
                      {iteration.thumbnailDataUrl ? (
                        <img src={iteration.thumbnailDataUrl} alt="" className="h-full w-full object-cover" />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center text-slate-500">
                          {asset.kind === 'video' ? <Film size={18} /> : <ImageIcon size={18} />}
                        </div>
                      )}
                    </div>
                    <div className="mt-2 grid grid-cols-3 gap-1 text-[10px] text-slate-500">
                      <span>{Math.round(iteration.transform.scale * 100)}%</span>
                      <span>x {Math.round(iteration.transform.offsetX)}</span>
                      <span>y {Math.round(iteration.transform.offsetY)}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center justify-between border-b border-surface-700 px-4 py-3">
            <div>
              <div className="text-sm font-semibold">{asset.kind === 'video' ? 'Video Edit' : 'Image Edit'}</div>
              <div className="text-xs text-slate-500">
                {asset.kind === 'image' ? 'Transform, paint, and prompt edits create trail iterations.' : 'Zoom and offset update the active edit.'}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <div className="rounded-full border border-surface-700 bg-surface-900 px-2.5 py-1 text-xs text-slate-400">
                {iterations.length} {iterations.length === 1 ? 'iteration' : 'iterations'}
              </div>
              <button className="rounded-md p-1 text-slate-400 hover:bg-surface-800 hover:text-white" onClick={onClose} title="Close" aria-label="Close">
                <X size={16} />
              </button>
            </div>
          </div>

          <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_300px]">
            <div className="min-h-0 bg-black p-4">
              <div className="relative flex h-full items-center justify-center overflow-hidden rounded-lg border border-white/10 bg-[radial-gradient(circle_at_center,rgba(255,255,255,0.08)_1px,transparent_1px)] [background-size:18px_18px]">
                {asset.kind === 'image' && sourceUrl && (
                  <div className="absolute left-3 top-3 z-30 flex items-center gap-2">
                    <button
                      type="button"
                      className={`flex h-9 w-9 items-center justify-center rounded-md border transition ${paintMode ? 'border-brand-300 bg-brand-500 text-white shadow-lg shadow-brand-900/30' : 'border-white/10 bg-black/70 text-slate-200 hover:border-white/20 hover:bg-surface-900'}`}
                      onClick={togglePaintMode}
                      disabled={working}
                      title={paintMode ? 'Hide brush overlay' : 'Paint edit guide'}
                      aria-label={paintMode ? 'Hide brush overlay' : 'Paint edit guide'}
                    >
                      <Paintbrush size={16} />
                    </button>
                    {paintMode && (
                      <div className="flex items-center gap-1 rounded-full border border-white/10 bg-black/80 p-1.5 shadow-xl">
                        {PAINT_COLORS.map((color) => (
                          <button
                            key={color}
                            type="button"
                            className={`h-6 w-6 rounded-full border transition ${paintColor === color ? 'border-white ring-2 ring-brand-300/70' : 'border-white/25 hover:border-white/70'}`}
                            style={{ backgroundColor: color }}
                            onClick={() => setPaintColor(color)}
                            aria-label={`Use ${color} brush`}
                            title={`Use ${color} brush`}
                          />
                        ))}
                        <button
                          type="button"
                          className="ml-1 flex h-7 w-7 items-center justify-center rounded-full text-slate-300 hover:bg-white/10 hover:text-white disabled:opacity-40"
                          onClick={clearPaintCanvas}
                          disabled={!paintHasInk}
                          aria-label="Clear paint"
                          title="Clear paint"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    )}
                  </div>
                )}
                {sourceUrl ? (
                  asset.kind === 'video' ? (
                    <div className="relative flex h-full w-full items-center justify-center">
                      <video
                        key={sourceUrl}
                        ref={videoRef}
                        src={sourceUrl}
                        muted
                        loop
                        playsInline
                        className="edit-trail-transform-target max-h-full max-w-full object-contain"
                        onLoadedMetadata={(event) => {
                          const duration = event.currentTarget.duration;
                          setVideoDuration(Number.isFinite(duration) ? duration : 0);
                          setVideoCurrentTime(event.currentTarget.currentTime || 0);
                        }}
                        onTimeUpdate={(event) => setVideoCurrentTime(event.currentTarget.currentTime || 0)}
                        onPlay={() => setVideoPlaying(true)}
                        onPause={() => setVideoPlaying(false)}
                      />
                      <div className="pointer-events-auto absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-black/90 via-black/50 to-transparent px-4 pb-3 pt-12">
                        <div className="mb-2 flex items-center gap-3 text-white">
                          <button
                            type="button"
                            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20"
                            onClick={toggleVideoPlayback}
                            title={videoPlaying ? 'Pause' : 'Play'}
                            aria-label={videoPlaying ? 'Pause' : 'Play'}
                          >
                            {videoPlaying ? <Pause size={16} /> : <Play size={16} />}
                          </button>
                          <div className="font-mono text-sm tabular-nums">
                            {formatPlaybackTime(videoCurrentTime)} / {formatPlaybackTime(videoDuration)}
                          </div>
                        </div>
                        <input
                          type="range"
                          min={0}
                          max={videoDuration || 0}
                          step={0.01}
                          value={Math.min(videoCurrentTime, videoDuration || videoCurrentTime || 0)}
                          disabled={!videoDuration}
                          onChange={(event) => scrubVideo(Number(event.target.value))}
                          className="block h-1 w-full accent-white disabled:opacity-40"
                          aria-label="Video scrubber"
                        />
                      </div>
                    </div>
                  ) : (
                    <div ref={imageLayerRef} className="edit-trail-transform-target relative inline-flex max-h-full max-w-full">
                      <img
                        ref={imageRef}
                        src={sourceUrl}
                        alt=""
                        draggable={false}
                        className="block max-h-full max-w-full select-none object-contain"
                      />
                      {(paintMode || paintHasInk) && (
                        <canvas
                          ref={paintCanvasRef}
                          className={`absolute inset-0 z-10 h-full w-full touch-none ${paintMode ? 'cursor-crosshair' : 'pointer-events-none opacity-0'}`}
                          onPointerDown={beginPaintStroke}
                          onPointerMove={continuePaintStroke}
                          onPointerUp={endPaintStroke}
                          onPointerCancel={endPaintStroke}
                          onPointerLeave={endPaintStroke}
                        />
                      )}
                    </div>
                  )
                ) : (
                  <div className="text-sm text-slate-500">Loading source…</div>
                )}
              </div>
            </div>

            <div className="min-h-0 overflow-y-auto border-l border-surface-700 bg-surface-900/60 p-3">
              <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-500">Transform</div>
              <ControlSlider
                label="Zoom"
                min={25}
                max={300}
                value={Math.round(draft.scale * 100)}
                suffix="%"
                onChange={(value) => setDraft((prev) => ({ ...prev, scale: value / 100 }))}
              />
              <ControlSlider
                label="Offset X"
                min={-600}
                max={600}
                value={Math.round(draft.offsetX)}
                onChange={(value) => setDraft((prev) => ({ ...prev, offsetX: value }))}
              />
              <ControlSlider
                label="Offset Y"
                min={-600}
                max={600}
                value={Math.round(draft.offsetY)}
                onChange={(value) => setDraft((prev) => ({ ...prev, offsetY: value }))}
              />
              <button
                className="mt-2 inline-flex h-8 items-center gap-1 rounded-md border border-surface-600 bg-surface-800 px-3 text-xs text-slate-300 hover:bg-surface-700 hover:text-slate-100"
                onClick={() => setDraft(DEFAULT_EDIT_TRAIL_TRANSFORM)}
              >
                <RotateCcw size={13} />
                Reset view
              </button>
              {asset.kind === 'image' && (
                <div className="mt-5 border-t border-surface-700 pt-4">
                  <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-500">AI Edit</div>
                  <div className="space-y-3">
                    <ImageModelSelect
                      value={selectedImageModel.id}
                      options={IMAGE_MODELS}
                      onChange={setImageModelId}
                      label="Model"
                    />
                    <label className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                      Prompt
                      <textarea
                        value={editPrompt}
                        onChange={(event) => setEditPrompt(event.target.value)}
                        className="mt-1 min-h-24 w-full resize-none rounded-md border border-surface-700 bg-surface-950 px-3 py-2 text-sm font-normal normal-case leading-snug tracking-normal text-slate-100 outline-none placeholder:text-slate-500 focus:border-brand-400"
                        placeholder="Describe the image edit"
                        disabled={working}
                      />
                    </label>
                    <div className="flex items-center justify-between text-[11px] text-slate-500">
                      <span>{paintHasInk ? 'Paint guide saved with this prompt' : 'Paint guide optional'}</span>
                      <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-emerald-300">${estimatedImageCostUsd.toFixed(3)}</span>
                    </div>
                    {(generating || editTrailGenerating) && (
                      <div className="h-1.5 overflow-hidden rounded-full bg-surface-800">
                        <div
                          className="h-full bg-brand-400 transition-[width]"
                          style={{ width: `${Math.max(2, Math.min(100, displayedGenerationProgress))}%` }}
                        />
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-surface-700 px-4 py-3">
            <div className="min-w-0 text-xs text-rose-300">{visibleError}</div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                className="inline-flex h-9 items-center gap-1 rounded-md border border-surface-600 bg-surface-800 px-3 text-sm text-slate-300 hover:bg-surface-700 hover:text-slate-100 disabled:cursor-not-allowed disabled:opacity-45"
                disabled={!canUndo || working}
                onClick={undoIteration}
              >
                <Undo2 size={14} />
                Undo
              </button>
              {asset.kind === 'image' ? (
                <button
                  className="inline-flex h-9 items-center gap-1 rounded-md border border-brand-400/60 bg-brand-500/15 px-3 text-sm font-semibold text-brand-100 hover:bg-brand-500/25 disabled:cursor-not-allowed disabled:border-surface-600 disabled:bg-surface-800 disabled:text-slate-400"
                  disabled={!canGenerateImageEdit}
                  onClick={() => void generateImageEdit()}
                  title={editPrompt.trim() ? 'Generate a new trail iteration from this prompt' : 'Add an edit prompt first'}
                >
                  <Sparkles size={14} />
                  {generating || editTrailGenerating ? 'Generating…' : 'Generate'}
                </button>
              ) : (
                <button
                  className="inline-flex h-9 items-center gap-1 rounded-md border border-surface-600 bg-surface-800 px-3 text-sm text-slate-400 disabled:cursor-not-allowed disabled:opacity-45"
                  disabled
                  title="Prompt-based generation is available for image edits."
                >
                  <Sparkles size={14} />
                  Generate
                </button>
              )}
              <button
                className="inline-flex h-9 items-center gap-1 rounded-md border border-surface-600 bg-surface-800 px-3 text-sm text-slate-300 hover:bg-surface-700 hover:text-slate-100 disabled:cursor-not-allowed disabled:opacity-45"
                disabled={working || !sourceUrl}
                onClick={() => commitIteration('add-new')}
                title="Create a new edit from the active frame"
              >
                <Plus size={14} />
                Add edit
              </button>
              <button
                className="inline-flex h-9 items-center gap-1 rounded-md bg-brand-500 px-4 text-sm font-semibold text-white hover:bg-brand-400 disabled:cursor-not-allowed disabled:bg-surface-600 disabled:text-slate-400"
                disabled={working || !sourceUrl}
                onClick={() => commitIteration('save-active')}
                title={activeIsBase ? 'Create a new edit from the base frame' : 'Overwrite the selected edit'}
              >
                <Save size={14} />
                {saving ? 'Saving…' : 'Save edit'}
              </button>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

function ControlSlider({
  label,
  min,
  max,
  value,
  suffix = '',
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  value: number;
  suffix?: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="mb-4 block">
      <div className="mb-1 flex items-center justify-between text-xs">
        <span className="text-slate-400">{label}</span>
        <span className="font-mono text-slate-200">{value}{suffix}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-brand-500"
      />
    </label>
  );
}

function formatPlaybackTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
  const whole = Math.floor(seconds);
  const minutes = Math.floor(whole / 60);
  const remaining = whole % 60;
  return `${minutes}:${remaining.toString().padStart(2, '0')}`;
}

async function renderEditedImageFile(asset: MediaAsset, sourceUrl: string, transform: EditTrailTransform): Promise<File> {
  const img = await loadImage(sourceUrl);
  const width = img.naturalWidth || asset.width || 1920;
  const height = img.naturalHeight || asset.height || 1080;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas rendering is unavailable.');
  ctx.clearRect(0, 0, width, height);
  drawTransformed(ctx, img, width, height, transform);
  const blob = await canvasToBlob(canvas, 'image/png');
  const baseName = asset.name.replace(/\.[^.]+$/, '') || 'edited-image';
  return new File([blob], `${baseName}-edit.png`, { type: 'image/png' });
}

async function renderEditedThumbnail(dataUrl: string, transform: EditTrailTransform): Promise<string> {
  const img = await loadImage(dataUrl);
  const width = img.naturalWidth || 240;
  const height = img.naturalHeight || 135;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return dataUrl;
  ctx.clearRect(0, 0, width, height);
  drawTransformed(ctx, img, width, height, transform);
  return canvas.toDataURL('image/jpeg', 0.78);
}

async function drawPaintOverlayFromUrl(canvas: HTMLCanvasElement, overlayUrl: string): Promise<void> {
  const overlay = await loadImage(overlayUrl);
  const context = canvas.getContext('2d');
  if (!context) return;
  context.drawImage(overlay, 0, 0, canvas.width, canvas.height);
}

async function saveCurrentPaintOverlay(
  activeIteration: EditTrailIteration | null,
  image: HTMLImageElement | null,
  paintCanvas: HTMLCanvasElement | null,
  paintHasInk: boolean,
): Promise<SavedPaintOverlay | null> {
  if (!paintHasInk) return null;
  const existingBlobKey = activeIteration?.generation?.paintOverlayBlobKey;
  if ((!paintCanvas || paintCanvas.width <= 0 || paintCanvas.height <= 0) && existingBlobKey) {
    const existingBlob = await getBlob(existingBlobKey);
    if (!existingBlob) return null;
    return {
      blobKey: existingBlobKey,
      file: new File([existingBlob], 'paint-overlay.png', { type: existingBlob.type || 'image/png' }),
      width: activeIteration?.generation?.paintOverlayWidth ?? 0,
      height: activeIteration?.generation?.paintOverlayHeight ?? 0,
      created: false,
    };
  }

  if (!image || !paintCanvas || paintCanvas.width <= 0 || paintCanvas.height <= 0) return null;
  const width = image.naturalWidth || Math.round(image.getBoundingClientRect().width);
  const height = image.naturalHeight || Math.round(image.getBoundingClientRect().height);
  if (width <= 0 || height <= 0) return null;

  const overlayCanvas = document.createElement('canvas');
  overlayCanvas.width = width;
  overlayCanvas.height = height;
  const context = overlayCanvas.getContext('2d');
  if (!context) return null;
  context.clearRect(0, 0, width, height);
  context.drawImage(paintCanvas, 0, 0, width, height);
  const blob = await canvasToBlob(overlayCanvas, 'image/png');
  const blobKey = `paint_overlay_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  await putBlob(blobKey, blob, 'paint-overlay.png');
  return {
    blobKey,
    file: new File([blob], 'paint-overlay.png', { type: 'image/png' }),
    width,
    height,
    created: true,
  };
}

async function paintGuideFileFromOverlay(sourceFile: File, overlayFile: File): Promise<File> {
  const sourceUrl = URL.createObjectURL(sourceFile);
  const overlayUrl = URL.createObjectURL(overlayFile);
  try {
    const [source, overlay] = await Promise.all([loadImage(sourceUrl), loadImage(overlayUrl)]);
    const width = source.naturalWidth || overlay.naturalWidth || 1024;
    const height = source.naturalHeight || overlay.naturalHeight || 1024;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas rendering is unavailable.');
    context.drawImage(source, 0, 0, width, height);
    context.drawImage(overlay, 0, 0, width, height);
    const blob = await canvasToBlob(canvas, 'image/png');
    return new File([blob], 'painted-edit-guide.png', { type: 'image/png' });
  } finally {
    URL.revokeObjectURL(sourceUrl);
    URL.revokeObjectURL(overlayUrl);
  }
}

async function buildImageEditInput(
  sourceFile: File,
  paintGuideFile: File | null,
  model: ImageModelDefinition,
): Promise<{ referenceUrls?: string[]; referenceFiles?: File[] }> {
  const files = [sourceFile, paintGuideFile].filter((file): file is File => Boolean(file));
  if (isGptImageModel(model)) return { referenceFiles: files };
  const urls: string[] = [];
  for (const file of files) urls.push(await hostLitterboxFile(file));
  return { referenceUrls: urls };
}

function buildImagePaintEditPrompt(editPrompt: string, hasPaintGuide: boolean): string {
  return [
    `Edit the provided image according to this prompt: ${editPrompt.trim()}`,
    hasPaintGuide
      ? 'Use the painted guide image as spatial direction only. Colored brush marks identify the area to change and must not appear in the final image.'
      : null,
    'Keep the existing composition, perspective, lighting, and unmentioned details unchanged. Return only the edited image.',
  ].filter(Boolean).join('\n\n');
}

function drawTransformed(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  width: number,
  height: number,
  transform: EditTrailTransform,
) {
  const drawWidth = width * transform.scale;
  const drawHeight = height * transform.scale;
  const x = (width - drawWidth) / 2 + transform.offsetX;
  const y = (height - drawHeight) / 2 + transform.offsetY;
  ctx.drawImage(image, x, y, drawWidth, drawHeight);
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not load the edit source.'));
    img.src = src;
  });
}

function applyPreviewTransform(element: HTMLElement | null, transform: EditTrailTransform) {
  if (!element) return;
  element.style.transform = `translate(${transform.offsetX}px, ${transform.offsetY}px) scale(${transform.scale})`;
}

function formatGenerationError(err: unknown): string {
  if (err instanceof VideoGenerationProviderError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Image edit generation failed.';
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

function canvasToBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Could not render the edit iteration.'));
    }, type);
  });
}
