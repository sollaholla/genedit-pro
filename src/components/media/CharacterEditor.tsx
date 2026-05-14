import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Box, Check, Copy, Film, Image as ImageIcon, Minus, Mountain, Paintbrush, Plus, Save, Search, Sparkles, Trash2, Upload, UserRound, X, type LucideIcon } from 'lucide-react';
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
import {
  isReferenceAssetKind,
  isReferenceImageAsset,
  referenceDataForAsset,
  referenceTokenForAsset,
  slugifyReferenceId,
  uniqueReferenceId,
} from '@/lib/media/characterReferences';
import { hostLitterboxFile, hostLitterboxReferences } from '@/lib/videoGeneration/litterbox';
import { VideoGenerationProviderError } from '@/lib/videoGeneration/errors';
import {
  CONNECTION_SETTINGS_CHANGED_EVENT,
  PIAPI_API_KEY_STORAGE,
  PIAPI_KLING_API_KEY_STORAGE,
  PIAPI_VEO_API_KEY_STORAGE,
} from '@/lib/settings/connectionStorage';
import { decryptSecret } from '@/lib/settings/crypto';
import { useMediaStore } from '@/state/mediaStore';
import type { CharacterAssetData, CharacterVisualStyle, EditTrailIteration, MediaAsset, ReferenceAssetData, ReferenceAssetKind } from '@/types';
import { ImageModelSelect } from './ImageModelSelect';
import { MediaPicker } from './MediaPicker';

type Props = {
  assetId: string | null;
  referenceKind?: ReferenceAssetKind;
  folderId?: string | null;
  onClose: () => void;
  onOpenSettings: () => void;
  onGenerationQueued?: (assetId: string) => void;
};

type CharacterForm = {
  name: string;
  characterId: string;
  description: string;
  style: CharacterVisualStyle;
  model: string;
  aspectRatio: string;
  resolution: string;
};

const IMAGE_MODELS = sortImageModelsByPriority(DEFAULT_IMAGE_MODELS);
const REFERENCE_CONFIG: Record<ReferenceAssetKind, {
  label: string;
  labelPlural: string;
  tokenBase: string;
  icon: LucideIcon;
  descriptionPlaceholder: string;
  emptyPreviewText: string;
  sheetTemplate: string;
}> = {
  character: {
    label: 'Character',
    labelPlural: 'characters',
    tokenBase: 'character',
    icon: UserRound,
    descriptionPlaceholder: "Describe the character's face, outfit, style, and visual identity.",
    emptyPreviewText: 'Generate a character image from the description.',
    sheetTemplate: 'Create a single full-body character turnaround reference sheet. Arrange four evenly spaced views of the same character from left to right: front view, left side view, right side view, back view. Keep the face, body proportions, clothing, hairstyle, colors, and accessories consistent in every view. Use neutral studio lighting with no background.',
  },
  object: {
    label: 'Object',
    labelPlural: 'objects',
    tokenBase: 'object',
    icon: Box,
    descriptionPlaceholder: 'Describe the object, materials, markings, scale cues, condition, and signature details.',
    emptyPreviewText: 'Generate an object reference sheet from the description.',
    sheetTemplate: 'Create a single coherent object reference sheet. Arrange four evenly spaced views of the same object from left to right: front view, three-quarter view, side view, and back view. Keep the silhouette, proportions, materials, markings, color, wear, and scale cues consistent in every view. Use neutral studio lighting with a plain background and no extra objects.',
  },
  environment: {
    label: 'Environment',
    labelPlural: 'environments',
    tokenBase: 'environment',
    icon: Mountain,
    descriptionPlaceholder: 'Describe the place, architecture or terrain, lighting, mood, era, palette, and recurring props.',
    emptyPreviewText: 'Generate an environment reference board from the description.',
    sheetTemplate: 'Create a production-design environment reference board as a six-panel contact sheet, not a single continuous camera view. The final image must be divided into a clean 3-by-2 grid: three clearly separated panels across the top row and three clearly separated panels across the bottom row, with visible gutters or thin divider lines between every panel. Panel 1: wide establishing view. Panel 2: entrance or primary approach. Panel 3: key architectural or terrain detail. Panel 4: alternate angle of the same environment. Panel 5: lighting, materials, and palette study. Panel 6: recurring props, signage, surfaces, and small set-dressing details. Keep the architecture, terrain, props, color palette, era, atmosphere, and production design consistent across every panel. Each panel must read as its own framed image while belonging to the same environment. Do not create one panoramic scene, one lobby photo, one interior render, or one uninterrupted composition. Do not add characters unless explicitly requested.',
  },
};
const CHARACTER_STYLE_OPTIONS: Array<{ value: CharacterVisualStyle; label: string; prompt: string }> = [
  { value: 'real-life', label: 'Real-life', prompt: 'Use a real-life photographic style with natural materials, believable surface detail, and practical lighting.' },
  { value: 'anime', label: 'Anime', prompt: 'Use a polished anime production design style with clean linework, expressive proportions, and clear shapes.' },
  { value: '3d', label: '3D', prompt: 'Use a high-quality stylized 3D design style with smooth modeled forms and studio-rendered materials.' },
  { value: 'lego', label: 'Lego', prompt: 'Use a Lego-inspired toy design style with plastic materials, simplified block construction, and readable shapes.' },
];
const PAINT_COLORS = ['#ff3b30', '#ffcc00', '#00d084', '#20a7f3', '#ffffff'];
const PAINT_BRUSH_SIZE = 10;
const MIN_PREVIEW_ZOOM = 100;
const MAX_PREVIEW_ZOOM = 400;
const PREVIEW_ZOOM_STEP = 25;
const VIDEO_REFERENCE_FRAME_COUNT: number = 3;
const VIDEO_REFERENCE_MAX_EDGE_PX = 1280;

export function CharacterEditor({ assetId, referenceKind = 'character', folderId = null, onClose, onOpenSettings, onGenerationQueued }: Props) {
  const assets = useMediaStore((state) => state.assets);
  const asset = useMemo(
    () => (assetId ? assets.find((candidate) => candidate.id === assetId && isReferenceAssetKind(candidate.kind)) ?? null : null),
    [assetId, assets],
  );
  const effectiveKind = asset && isReferenceAssetKind(asset.kind) ? asset.kind : referenceKind;
  const config = REFERENCE_CONFIG[effectiveKind];
  const Icon = config.icon;
  const addGeneratedAsset = useMediaStore((state) => state.addGeneratedAsset);
  const updateGenerationProgress = useMediaStore((state) => state.updateGenerationProgress);
  const updateGenerationTask = useMediaStore((state) => state.updateGenerationTask);
  const finalizeGeneratedAssetWithBlob = useMediaStore((state) => state.finalizeGeneratedAssetWithBlob);
  const failGeneratedAsset = useMediaStore((state) => state.failGeneratedAsset);
  const startEditTrailGeneration = useMediaStore((state) => state.startEditTrailGeneration);
  const updateEditTrailGenerationProgress = useMediaStore((state) => state.updateEditTrailGenerationProgress);
  const updateEditTrailGenerationTask = useMediaStore((state) => state.updateEditTrailGenerationTask);
  const failEditTrailGeneration = useMediaStore((state) => state.failEditTrailGeneration);
  const addGeneratedEditTrailIteration = useMediaStore((state) => state.addGeneratedEditTrailIteration);
  const ensureEditTrail = useMediaStore((state) => state.ensureEditTrail);
  const setActiveEditTrailIteration = useMediaStore((state) => state.setActiveEditTrailIteration);
  const updateCharacterAsset = useMediaStore((state) => state.updateCharacterAsset);
  const updateReferenceAsset = useMediaStore((state) => state.updateReferenceAsset);
  const renameAsset = useMediaStore((state) => state.renameAsset);
  const objectUrlFor = useMediaStore((state) => state.objectUrlFor);
  const importFiles = useMediaStore((state) => state.importFiles);
  const [form, setForm] = useState<CharacterForm>(() => defaultCharacterForm(assets, referenceKind));
  const [referenceAssetIds, setReferenceAssetIds] = useState<string[]>([]);
  const [referencePickerOpen, setReferencePickerOpen] = useState(false);
  const [slugTouched, setSlugTouched] = useState(false);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [localWorking, setLocalWorking] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [paintMode, setPaintMode] = useState(false);
  const [paintColor, setPaintColor] = useState(PAINT_COLORS[0]!);
  const [paintHasInk, setPaintHasInk] = useState(false);
  const [editPrompt, setEditPrompt] = useState('');
  const [previewZoom, setPreviewZoom] = useState(MIN_PREVIEW_ZOOM);
  const [previewPan, setPreviewPan] = useState({ x: 0, y: 0 });
  const [previewPanning, setPreviewPanning] = useState(false);
  const loadedAssetIdRef = useRef<string | null>(null);
  const previewViewportRef = useRef<HTMLDivElement | null>(null);
  const previewImageRef = useRef<HTMLImageElement | null>(null);
  const paintCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const paintingRef = useRef(false);
  const lastPaintPointRef = useRef<{ x: number; y: number } | null>(null);
  const previewPanDragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    startPan: { x: number; y: number };
  } | null>(null);

  const selectedModel = imageModelById(form.model) ?? defaultImageModel();
  const supportsVideoReferences = selectedModel.capabilities.videoInputs;
  const estimatedCostUsd = estimateImageCostUsd(selectedModel);
  const isCreate = !assetId;
  const promptForGeneration = form.description.trim();
  const pendingEditTrailGeneration = asset?.editTrailGeneration ?? null;
  const editTrailGenerating = pendingEditTrailGeneration?.status === 'generating';
  const working = localWorking || editTrailGenerating;
  const displayedProgress = editTrailGenerating ? pendingEditTrailGeneration.progress ?? progress : progress;
  const persistedError = pendingEditTrailGeneration?.status === 'error'
    ? pendingEditTrailGeneration.errorMessage ?? 'Generation failed.'
    : null;
  const visibleError = error ?? persistedError;
  const canGenerate = Boolean(promptForGeneration) && !working;
  const canEdit = Boolean(asset && sourceUrl && editPrompt.trim()) && !working;
  const previewScale = previewZoom / 100;
  const previewCanPan = previewZoom > MIN_PREVIEW_ZOOM && !paintMode;
  const referenceAssets = useMemo(() => referenceAssetIds
    .map((id) => assets.find((candidate) => candidate.id === id))
    .filter((candidate): candidate is MediaAsset => Boolean(candidate && (
      isReferenceImageAsset(candidate) || (supportsVideoReferences && isReferenceVideoAsset(candidate))
    ))), [assets, referenceAssetIds, supportsVideoReferences]);
  const videoReferenceCount = referenceAssets.filter((reference) => reference.kind === 'video').length;
  const providerPrompt = addReferenceMediaPromptGuidance(
    buildReferenceImagePrompt(promptForGeneration, form.style, effectiveKind),
    videoReferenceCount,
  );

  useEffect(() => {
    if (!asset || asset.generation?.status === 'generating') return;
    ensureEditTrail(asset.id);
  }, [asset, ensureEditTrail]);

  useEffect(() => {
    if (!assetId) {
      if (loadedAssetIdRef.current !== null) {
        loadedAssetIdRef.current = null;
        setForm(defaultCharacterForm(assets, referenceKind));
        setReferenceAssetIds([]);
        setSlugTouched(false);
      }
      return;
    }
    if (!asset || loadedAssetIdRef.current === asset.id) return;
    loadedAssetIdRef.current = asset.id;
    const reference = referenceDataForAsset(asset);
    const nextModel = imageModelById(reference?.model ?? '') ?? defaultImageModel();
    setForm({
      name: asset.name,
      characterId: reference?.referenceId ?? uniqueReferenceId(asset.name, assets, effectiveKind, asset.id),
      description: reference?.description ?? reference?.prompt ?? '',
      style: reference?.style ?? 'real-life',
      model: nextModel.id,
      aspectRatio: CHARACTER_IMAGE_ASPECT_RATIO,
      resolution: CHARACTER_IMAGE_RESOLUTION,
    });
    setReferenceAssetIds(uniqueIds([
      ...(reference?.sourceImageAssetIds ?? []),
      ...(reference?.sourceVideoAssetIds ?? []),
    ]));
    setSlugTouched(false);
  }, [asset, assetId, assets, effectiveKind, referenceKind]);

  useEffect(() => {
    let mounted = true;
    setSourceUrl(null);
    if (!asset?.blobKey) return () => {
      mounted = false;
    };
    void objectUrlFor(asset.id).then((url) => {
      if (mounted) setSourceUrl(url);
    });
    return () => {
      mounted = false;
    };
  }, [asset?.blobKey, asset?.editTrail?.activeIterationId, asset?.id, objectUrlFor]);

  useEffect(() => {
    setPaintMode(false);
    setEditPrompt('');
    setPreviewZoom(MIN_PREVIEW_ZOOM);
    setPreviewPan({ x: 0, y: 0 });
    setPreviewPanning(false);
    previewPanDragRef.current = null;
    clearPaintCanvas();
  }, [asset?.editTrail?.activeIterationId, asset?.id]);

  useEffect(() => {
    if (!paintMode || !sourceUrl) {
      clearPaintCanvas();
      return undefined;
    }
    const canvas = paintCanvasRef.current;
    if (!canvas) return undefined;
    const resizeCanvas = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const width = Math.max(1, Math.round(rect.width * dpr));
      const height = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width === width && canvas.height === height) return;
      canvas.width = width;
      canvas.height = height;
      setPaintHasInk(false);
    };
    const observer = new ResizeObserver(resizeCanvas);
    observer.observe(canvas);
    const frameId = window.requestAnimationFrame(resizeCanvas);
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frameId);
    };
  }, [paintMode, sourceUrl]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (referencePickerOpen) setReferencePickerOpen(false);
      else onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, referencePickerOpen]);

  useEffect(() => {
    const onConnectionsChanged = () => setError(null);
    window.addEventListener(CONNECTION_SETTINGS_CHANGED_EVENT, onConnectionsChanged);
    return () => window.removeEventListener(CONNECTION_SETTINGS_CHANGED_EVENT, onConnectionsChanged);
  }, []);

  if (assetId && !asset) return null;

  const iterations = [...(asset?.editTrail?.iterations ?? [])].sort((a, b) => b.createdAt - a.createdAt);
  const activeIteration = asset?.editTrail?.iterations.find((iteration) => iteration.id === asset.editTrail?.activeIterationId) ?? null;
  const token = asset ? referenceTokenForAsset(asset) : `@${form.characterId}`;
  const referenceData = (referenceId: string): ReferenceAssetData => ({
    referenceId,
    referenceKind: effectiveKind,
    description: form.description.trim(),
    prompt: promptForGeneration,
    generatedPrompt: providerPrompt,
    style: form.style,
    model: selectedModel.id,
    aspectRatio: CHARACTER_IMAGE_ASPECT_RATIO,
    resolution: CHARACTER_IMAGE_RESOLUTION,
    sourceImageAssetIds: referenceAssets.filter((reference) => reference.kind !== 'video').map((reference) => reference.id),
    sourceVideoAssetIds: referenceAssets.filter((reference) => reference.kind === 'video').map((reference) => reference.id),
    updatedAt: Date.now(),
  });
  const characterData = (referenceId: string): CharacterAssetData => ({
    ...referenceData(referenceId),
    referenceKind: 'character',
    characterId: referenceId,
  });

  const updateName = (name: string) => {
    setForm((current) => ({
      ...current,
      name,
      characterId: slugTouched ? current.characterId : uniqueReferenceId(name, assets, effectiveKind, asset?.id),
    }));
  };

  const saveDetails = () => {
    if (!asset) return;
    const referenceId = uniqueReferenceId(form.characterId, assets, effectiveKind, asset.id);
    const name = form.name.trim() || referenceId;
    const reference = referenceData(referenceId);
    renameAsset(asset.id, name);
    if (asset.kind === 'character') updateCharacterAsset(asset.id, characterData(referenceId));
    updateReferenceAsset(asset.id, reference);
    setForm((current) => ({ ...current, name, characterId: referenceId }));
  };

  const importReferenceMedia = async () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = supportsVideoReferences ? 'image/*,video/*' : 'image/*';
    input.multiple = true;
    input.onchange = async () => {
      const files = Array.from(input.files ?? []);
      if (!files.length) return;
      try {
        const imported = await importFiles(files, asset?.folderId ?? folderId);
        const mediaIds = imported
          .filter((candidate) => (
            (candidate.kind === 'image' || (supportsVideoReferences && candidate.kind === 'video')) && candidate.blobKey
          ))
          .map((candidate) => candidate.id);
        if (!mediaIds.length) return;
        setReferenceAssetIds((current) => uniqueIds([...current, ...mediaIds]));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed importing reference media.');
      }
    };
    input.click();
  };

  const removeReferenceAsset = (assetIdToRemove: string) => {
    setReferenceAssetIds((current) => current.filter((id) => id !== assetIdToRemove));
  };

  const attachReferenceAsset = (reference: MediaAsset) => {
    if (!isReferenceImageAsset(reference) && !(supportsVideoReferences && isReferenceVideoAsset(reference))) return;
    setReferenceAssetIds((current) => uniqueIds([...current, reference.id]));
    setReferencePickerOpen(false);
  };

  const copyToken = async () => {
    if (!token) return;
    await navigator.clipboard?.writeText(token).catch(() => undefined);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
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
    setPaintHasInk(false);
  }

  const togglePaintMode = () => {
    if (paintMode) {
      clearPaintCanvas();
      setPaintMode(false);
      return;
    }
    setPaintMode(true);
  };

  const updatePreviewZoom = (delta: number) => {
    const nextZoom = clamp(previewZoom + delta, MIN_PREVIEW_ZOOM, MAX_PREVIEW_ZOOM);
    setPreviewZoom(nextZoom);
    setPreviewPan((currentPan) => (nextZoom <= MIN_PREVIEW_ZOOM ? { x: 0, y: 0 } : clampPreviewPan(currentPan, nextZoom)));
  };

  const resetPreviewZoom = () => {
    setPreviewZoom(MIN_PREVIEW_ZOOM);
    setPreviewPan({ x: 0, y: 0 });
    setPreviewPanning(false);
    previewPanDragRef.current = null;
  };

  const beginPreviewPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!previewCanPan || working || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    previewPanDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startPan: previewPan,
    };
    setPreviewPanning(true);
  };

  const continuePreviewPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = previewPanDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    setPreviewPan(clampPreviewPan({
      x: drag.startPan.x + event.clientX - drag.startX,
      y: drag.startPan.y + event.clientY - drag.startY,
    }, previewZoom));
  };

  const endPreviewPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    previewPanDragRef.current = null;
    setPreviewPanning(false);
  };

  function clampPreviewPan(nextPan: { x: number; y: number }, zoomPercent: number): { x: number; y: number } {
    if (zoomPercent <= MIN_PREVIEW_ZOOM) return { x: 0, y: 0 };
    const viewport = previewViewportRef.current;
    const image = previewImageRef.current;
    if (!viewport || !image) return nextPan;
    const scale = zoomPercent / 100;
    const viewportRect = viewport.getBoundingClientRect();
    const scaledWidth = image.offsetWidth * scale;
    const scaledHeight = image.offsetHeight * scale;
    const maxX = Math.max(0, (scaledWidth - viewportRect.width) / 2);
    const maxY = Math.max(0, (scaledHeight - viewportRect.height) / 2);
    return {
      x: clamp(nextPan.x, -maxX, maxX),
      y: clamp(nextPan.y, -maxY, maxY),
    };
  }

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

  const submitPaintEdit = async () => {
    if (!asset || !canEdit) return;
    const apiKey = await readPiApiKey();
    if (!apiKey) {
      setError('Connect PiAPI in Settings before editing images.');
      return;
    }
    setLocalWorking(true);
    setProgress(2);
    setError(null);
    await editCharacter(asset, apiKey);
  };

  const generate = async () => {
    if (!canGenerate) return;
    const apiKey = await readPiApiKey();
    if (!apiKey) {
      setError(`Connect PiAPI in Settings before generating ${config.labelPlural}.`);
      return;
    }
    setLocalWorking(true);
    setProgress(2);
    setError(null);
    if (isCreate) {
      await createCharacter(apiKey);
    } else if (asset) {
      await regenerateCharacter(asset, apiKey);
    }
  };

  const createCharacter = async (apiKey: string) => {
    const referenceId = uniqueReferenceId(form.characterId || form.name, assets, effectiveKind);
    const name = form.name.trim() || referenceId;
    const reference = referenceData(referenceId);
    const character = effectiveKind === 'character' ? characterData(referenceId) : undefined;
    const generatedAssetId = addGeneratedAsset(name, folderId, estimatedCostUsd, undefined, {
      kind: effectiveKind,
      mimeType: 'image/png',
      durationSec: 5,
      character,
      reference,
    });
    updateGenerationProgress(generatedAssetId, 3);
    onGenerationQueued?.(generatedAssetId);
    onClose();
    try {
      const referenceInput = await buildReferenceInput(referenceAssets, selectedModel, objectUrlFor);
      const generated = await generatePiApiImage({
        model: selectedModel,
        prompt: providerPrompt,
        aspectRatio: CHARACTER_IMAGE_ASPECT_RATIO,
        resolution: CHARACTER_IMAGE_RESOLUTION,
        outputFormat: selectedModel.capabilities.defaultOutputFormat,
        referenceUrls: referenceInput.referenceUrls,
        referenceFiles: referenceInput.referenceFiles,
        onProgress: (value) => updateGenerationProgress(generatedAssetId, value),
        onTaskAccepted: (task) => updateGenerationTask(generatedAssetId, {
          provider: 'piapi-gemini',
          providerTaskId: task.task_id,
          providerTaskEndpoint: task.task_id ? `/api/v1/task/${task.task_id}` : '/api/v1/task',
          providerTaskStatus: task.status,
          providerTaskCreatedAt: Date.now(),
        }),
      }, { apiKey });
      const file = await downloadGeneratedImageFile(generated.url, (value) => updateGenerationProgress(generatedAssetId, value));
      await finalizeGeneratedAssetWithBlob(generatedAssetId, file, {
        actualCostUsd: generated.actualCostUsd ?? estimatedCostUsd,
        provider: generated.provider,
        providerArtifactUri: generated.url,
        providerArtifactExpiresAt: generated.providerArtifactExpiresAt,
      });
    } catch (err) {
      failGeneratedAsset(generatedAssetId, {
        actualCostUsd: estimatedCostUsd,
        errorMessage: formatGenerationError(err),
        errorType: err instanceof VideoGenerationProviderError ? err.type : 'InternalError',
      });
    }
  };

  const editCharacter = async (characterAsset: MediaAsset, apiKey: string) => {
    const editPromptText = editPrompt.trim();
    if (!editPromptText) {
      setLocalWorking(false);
      return;
    }
    const editProviderPrompt = addReferenceMediaPromptGuidance(
      buildPaintEditPrompt(editPromptText, effectiveKind, paintHasInk),
      videoReferenceCount,
    );
    startEditTrailGeneration(characterAsset.id, {
      prompt: editProviderPrompt,
      model: selectedModel.id,
      estimatedCostUsd,
    });
    const updateProgress = (value: number) => {
      setProgress(value);
      updateEditTrailGenerationProgress(characterAsset.id, value);
    };
    try {
      const paintGuideFile = paintHasInk
        ? await paintGuideFileFromCanvas(previewImageRef.current, paintCanvasRef.current)
        : null;
      const referenceInput = await buildPaintEditInput(characterAsset, paintGuideFile, referenceAssets, selectedModel, objectUrlFor);
      if (!referenceInput.referenceFiles?.length && !referenceInput.referenceUrls?.length) {
        throw new Error(`${config.label} image is not available for editing.`);
      }
      const generated = await generatePiApiImage({
        model: selectedModel,
        prompt: editProviderPrompt,
        aspectRatio: CHARACTER_IMAGE_ASPECT_RATIO,
        resolution: CHARACTER_IMAGE_RESOLUTION,
        outputFormat: selectedModel.capabilities.defaultOutputFormat,
        referenceUrls: referenceInput.referenceUrls,
        referenceFiles: referenceInput.referenceFiles,
        onProgress: updateProgress,
        onTaskAccepted: (task) => updateEditTrailGenerationTask(characterAsset.id, {
          provider: 'piapi-gemini',
          providerTaskId: task.task_id,
          providerTaskEndpoint: task.task_id ? `/api/v1/task/${task.task_id}` : '/api/v1/task',
          providerTaskStatus: task.status,
          providerTaskCreatedAt: Date.now(),
        }),
      }, { apiKey });
      const file = await downloadGeneratedImageFile(generated.url, updateProgress);
      await addGeneratedEditTrailIteration(characterAsset.id, file, {
        prompt: editProviderPrompt,
        model: selectedModel.id,
        estimatedCostUsd,
        actualCostUsd: generated.actualCostUsd ?? estimatedCostUsd,
        provider: generated.provider,
        providerTaskId: generated.providerTaskId,
        providerTaskEndpoint: generated.providerTaskEndpoint,
        providerTaskStatus: generated.providerTaskStatus,
        providerArtifactUri: generated.url,
        providerArtifactExpiresAt: generated.providerArtifactExpiresAt,
      });
      setProgress(100);
      setEditPrompt('');
      setPaintMode(false);
      clearPaintCanvas();
    } catch (err) {
      const message = formatGenerationError(err);
      setError(message);
      failEditTrailGeneration(characterAsset.id, {
        actualCostUsd: estimatedCostUsd,
        errorMessage: message,
        errorType: err instanceof VideoGenerationProviderError ? err.type : 'InternalError',
      });
    } finally {
      setLocalWorking(false);
    }
  };

  const regenerateCharacter = async (characterAsset: MediaAsset, apiKey: string) => {
    startEditTrailGeneration(characterAsset.id, {
      prompt: providerPrompt,
      model: selectedModel.id,
      estimatedCostUsd,
    });
    const updateProgress = (value: number) => {
      setProgress(value);
      updateEditTrailGenerationProgress(characterAsset.id, value);
    };
    try {
      const referenceInput = await buildReferenceInput(referenceAssets, selectedModel, objectUrlFor);
      const generated = await generatePiApiImage({
        model: selectedModel,
        prompt: providerPrompt,
        aspectRatio: CHARACTER_IMAGE_ASPECT_RATIO,
        resolution: CHARACTER_IMAGE_RESOLUTION,
        outputFormat: selectedModel.capabilities.defaultOutputFormat,
        referenceUrls: referenceInput.referenceUrls,
        referenceFiles: referenceInput.referenceFiles,
        onProgress: updateProgress,
        onTaskAccepted: (task) => updateEditTrailGenerationTask(characterAsset.id, {
          provider: 'piapi-gemini',
          providerTaskId: task.task_id,
          providerTaskEndpoint: task.task_id ? `/api/v1/task/${task.task_id}` : '/api/v1/task',
          providerTaskStatus: task.status,
          providerTaskCreatedAt: Date.now(),
        }),
      }, { apiKey });
      const file = await downloadGeneratedImageFile(generated.url, updateProgress);
      await addGeneratedEditTrailIteration(characterAsset.id, file, {
        prompt: providerPrompt,
        model: selectedModel.id,
        estimatedCostUsd,
        actualCostUsd: generated.actualCostUsd ?? estimatedCostUsd,
        provider: generated.provider,
        providerTaskId: generated.providerTaskId,
        providerTaskEndpoint: generated.providerTaskEndpoint,
        providerTaskStatus: generated.providerTaskStatus,
        providerArtifactUri: generated.url,
        providerArtifactExpiresAt: generated.providerArtifactExpiresAt,
        character: effectiveKind === 'character'
          ? characterData(uniqueReferenceId(form.characterId, assets, effectiveKind, characterAsset.id))
          : undefined,
        reference: referenceData(uniqueReferenceId(form.characterId, assets, effectiveKind, characterAsset.id)),
      });
      if (form.name.trim() && form.name.trim() !== characterAsset.name) renameAsset(characterAsset.id, form.name.trim());
      setProgress(100);
    } catch (err) {
      const message = formatGenerationError(err);
      setError(message);
      failEditTrailGeneration(characterAsset.id, {
        actualCostUsd: estimatedCostUsd,
        errorMessage: message,
        errorType: err instanceof VideoGenerationProviderError ? err.type : 'InternalError',
      });
    } finally {
      setLocalWorking(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[95] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm">
      <div className="flex h-[min(820px,94vh)] w-[min(1180px,96vw)] overflow-hidden rounded-lg border border-white/15 bg-surface-950 text-slate-100 shadow-2xl">
        {!isCreate && (
          <aside className="flex w-64 shrink-0 flex-col border-r border-surface-700 bg-surface-900/70">
            <div className="border-b border-surface-700 px-3 py-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{config.label} Trail</div>
              <div className="mt-1 truncate text-sm font-semibold text-slate-100">{asset?.name}</div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              <div className="space-y-2">
                {iterations.map((iteration) => (
                  <IterationButton
                    key={iteration.id}
                    iteration={iteration}
                    active={iteration.id === asset?.editTrail?.activeIterationId}
                    onClick={() => {
                      if (asset) setActiveEditTrailIteration(asset.id, iteration.id);
                    }}
                  />
                ))}
              </div>
            </div>
          </aside>
        )}

        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center justify-between border-b border-surface-700 px-4 py-3">
            <div className="flex min-w-0 items-center gap-2">
              <Icon size={17} className="shrink-0 text-brand-300" />
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold">{isCreate ? `New ${config.label}` : form.name || config.label}</div>
                <div className="text-[11px] uppercase tracking-wide text-slate-500">{token}</div>
              </div>
            </div>
            <button className="rounded-md p-1 text-slate-400 hover:bg-white/10 hover:text-white" onClick={onClose} title="Close" aria-label="Close">
              <X size={18} />
            </button>
          </div>

          <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_340px]">
            <div className="min-h-0 bg-black p-4">
              <div ref={previewViewportRef} className="relative flex h-full items-center justify-center overflow-hidden rounded-md border border-white/10 bg-[radial-gradient(circle_at_center,rgba(255,255,255,0.08)_1px,transparent_1px)] [background-size:18px_18px]">
                {!isCreate && sourceUrl && (
                  <div className="absolute left-3 top-3 z-30 flex items-center gap-2">
                    <button
                      type="button"
                      className={`flex h-9 w-9 items-center justify-center rounded-md border transition ${paintMode ? 'border-brand-300 bg-brand-500 text-white shadow-lg shadow-brand-900/30' : 'border-white/10 bg-black/70 text-slate-200 hover:border-white/20 hover:bg-surface-900'}`}
                      onClick={togglePaintMode}
                      disabled={working}
                      title={paintMode ? 'Disable brush' : 'Paint edit guide'}
                      aria-label={paintMode ? 'Disable brush' : 'Paint edit guide'}
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
                {sourceUrl && (
                  <div className="absolute right-3 top-3 z-30 flex h-9 items-center gap-1 rounded-md border border-white/10 bg-black/75 px-1.5 text-slate-200 shadow-xl backdrop-blur">
                    <Search size={14} className="mx-1 text-slate-400" />
                    <button
                      type="button"
                      className="flex h-7 w-7 items-center justify-center rounded text-slate-100 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
                      onClick={() => updatePreviewZoom(PREVIEW_ZOOM_STEP)}
                      disabled={previewZoom >= MAX_PREVIEW_ZOOM}
                      title="Zoom in"
                      aria-label="Zoom in"
                    >
                      <Plus size={14} />
                    </button>
                    <button
                      type="button"
                      className="h-7 min-w-12 rounded px-2 text-center text-xs font-semibold tabular-nums text-slate-100 hover:bg-white/10"
                      onClick={resetPreviewZoom}
                      title="Reset zoom"
                      aria-label="Reset zoom"
                    >
                      {previewZoom}%
                    </button>
                    <button
                      type="button"
                      className="flex h-7 w-7 items-center justify-center rounded text-slate-100 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
                      onClick={() => updatePreviewZoom(-PREVIEW_ZOOM_STEP)}
                      disabled={previewZoom <= MIN_PREVIEW_ZOOM}
                      title="Zoom out"
                      aria-label="Zoom out"
                    >
                      <Minus size={14} />
                    </button>
                  </div>
                )}
                {sourceUrl ? (
                  <div
                    className={`relative inline-flex max-h-full max-w-full ${previewCanPan ? previewPanning ? 'cursor-grabbing' : 'cursor-grab' : ''}`}
                    style={{
                      transform: `translate3d(${previewPan.x}px, ${previewPan.y}px, 0) scale(${previewScale})`,
                      transformOrigin: 'center center',
                      transition: previewPanning ? 'none' : 'transform 120ms ease-out',
                    }}
                    onPointerDown={beginPreviewPan}
                    onPointerMove={continuePreviewPan}
                    onPointerUp={endPreviewPan}
                    onPointerCancel={endPreviewPan}
                  >
                    <img ref={previewImageRef} src={sourceUrl} alt={form.name} draggable={false} className="block max-h-full max-w-full select-none object-contain" />
                    {paintMode && !isCreate && (
                      <canvas
                        ref={paintCanvasRef}
                        className="absolute inset-0 z-10 h-full w-full cursor-crosshair touch-none"
                        onPointerDown={beginPaintStroke}
                        onPointerMove={continuePaintStroke}
                        onPointerUp={endPaintStroke}
                        onPointerCancel={endPaintStroke}
                        onPointerLeave={endPaintStroke}
                      />
                    )}
                  </div>
                ) : (
                  <div className="flex flex-col items-center gap-3 text-slate-500">
                    <Icon size={44} />
                    <div className="text-sm">{isCreate ? config.emptyPreviewText : `${config.label} image loading…`}</div>
                  </div>
                )}
                {paintMode && !isCreate && sourceUrl && (
                  <div className="pointer-events-none absolute inset-x-4 bottom-4 z-30 flex justify-center">
                    <div className="pointer-events-auto flex w-[min(560px,100%)] items-center gap-2 rounded-lg border border-white/10 bg-black/80 p-2 shadow-2xl backdrop-blur">
                      <input
                        value={editPrompt}
                        onChange={(event) => setEditPrompt(event.target.value)}
                        className="h-9 min-w-0 flex-1 rounded-md border border-white/10 bg-surface-950 px-3 text-sm text-slate-100 outline-none placeholder:text-slate-500 focus:border-brand-400"
                        placeholder="Edit Prompt"
                        disabled={working}
                      />
                      <button
                        type="button"
                        className="btn-primary h-9 shrink-0 px-3 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50"
                        onClick={() => void submitPaintEdit()}
                        disabled={!canEdit}
                      >
                        <Sparkles size={14} />
                        Edit
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="min-h-0 overflow-y-auto border-l border-surface-700 bg-surface-900/60 p-4">
              <div className="space-y-3">
                <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Name
                  <input
                    value={form.name}
                    onChange={(event) => updateName(event.target.value)}
                    className="mt-1 h-9 w-full rounded-md border border-surface-700 bg-surface-950 px-3 text-sm font-normal normal-case tracking-normal text-slate-100 outline-none focus:border-brand-400"
                    placeholder={`${config.label} name`}
                  />
                </label>
                <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
                  {config.label} ID
                  <div className="mt-1 flex overflow-hidden rounded-md border border-surface-700 bg-surface-950 focus-within:border-brand-400">
                    <span className="flex items-center border-r border-surface-700 px-2 text-sm font-normal normal-case tracking-normal text-slate-500">@</span>
                    <input
                      value={form.characterId}
                      onChange={(event) => {
                        setSlugTouched(true);
                        setForm((current) => ({ ...current, characterId: slugifyReferenceId(event.target.value, config.tokenBase) }));
                      }}
                      className="min-w-0 flex-1 bg-transparent px-2 text-sm font-normal normal-case tracking-normal text-slate-100 outline-none"
                      placeholder={`${config.tokenBase}-id`}
                    />
                    <button type="button" className="flex h-9 w-9 items-center justify-center border-l border-surface-700 text-slate-300 hover:bg-surface-800" onClick={() => void copyToken()} title={`Copy ${config.label.toLowerCase()} reference`}>
                      {copied ? <Check size={14} /> : <Copy size={14} />}
                    </button>
                  </div>
                </label>
                <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Description
                  <textarea
                    value={form.description}
                    onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))}
                    className="mt-1 h-32 w-full resize-none rounded-md border border-surface-700 bg-surface-950 px-3 py-2 text-sm font-normal normal-case tracking-normal text-slate-100 outline-none focus:border-brand-400"
                    placeholder={config.descriptionPlaceholder}
                  />
                </label>

                <div className="rounded-md border border-surface-700 bg-surface-950/60 p-2.5">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                      {supportsVideoReferences ? 'Reference Media' : 'Reference Images'}
                    </div>
                    <button
                      type="button"
                      className="inline-flex h-7 items-center gap-1.5 rounded bg-surface-800 px-2 text-xs text-slate-200 hover:bg-surface-700 disabled:cursor-not-allowed disabled:opacity-50"
                      onClick={() => setReferencePickerOpen(true)}
                      disabled={working}
                    >
                      <Upload size={12} />
                      Add
                    </button>
                  </div>
                  {referenceAssets.length > 0 ? (
                    <div className="grid grid-cols-3 gap-1.5">
                      {referenceAssets.map((reference) => (
                        <div key={reference.id} className="group relative overflow-hidden rounded border border-surface-700 bg-black/40">
                          <div className="aspect-square">
                            {reference.thumbnailDataUrl ? (
                              <img src={reference.thumbnailDataUrl} alt={reference.name} className="h-full w-full object-cover" draggable={false} />
                            ) : (
                              <div className="flex h-full w-full items-center justify-center text-slate-500">
                                {reference.kind === 'video' ? <Film size={18} /> : <ImageIcon size={18} />}
                              </div>
                            )}
                          </div>
                          {reference.kind === 'video' && (
                            <div className="absolute left-1 top-1 rounded bg-black/70 px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-white">
                              Video
                            </div>
                          )}
                          <button
                            type="button"
                            className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded bg-black/70 text-slate-200 opacity-0 transition hover:bg-red-500 hover:text-white group-hover:opacity-100 focus-visible:opacity-100"
                            onClick={() => removeReferenceAsset(reference.id)}
                            title="Remove reference"
                            aria-label={`Remove ${reference.name}`}
                            disabled={working}
                          >
                            <X size={11} />
                          </button>
                          <div className="absolute inset-x-0 bottom-0 truncate bg-black/70 px-1 py-0.5 text-[10px] font-medium normal-case tracking-normal text-white">
                            {reference.name}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="rounded border border-dashed border-surface-700 px-2 py-3 text-center text-xs font-normal normal-case tracking-normal text-slate-500">
                      {supportsVideoReferences ? 'No reference media' : 'No reference images'}
                    </div>
                  )}
                </div>

                <div className="space-y-2 rounded-md border border-surface-700 bg-surface-950/60 p-2.5">
                  <ImageModelSelect value={selectedModel.id} options={IMAGE_MODELS} onChange={(modelId) => setFormForModel(modelId, setForm)} />
                  <StyleSelect value={form.style} onChange={(style) => setForm((current) => ({ ...current, style }))} />
                </div>

                {activeIteration?.generation?.actualCostUsd !== undefined && (
                  <div className="rounded-md border border-emerald-400/20 bg-emerald-500/10 px-2.5 py-2 text-xs text-emerald-200">
                    Active image cost ${activeIteration.generation.actualCostUsd.toFixed(3)}
                  </div>
                )}
                {visibleError && (
                  <div className="rounded-md border border-rose-300/30 bg-rose-500/10 px-2.5 py-2 text-xs text-rose-200">
                    {visibleError}
                    {visibleError.includes('PiAPI') && (
                      <button type="button" className="ml-2 underline" onClick={onOpenSettings}>Settings</button>
                    )}
                  </div>
                )}
                {working && (
                  <progress className="export-progress" value={Math.max(4, Math.min(100, displayedProgress))} max={100} aria-label={`${config.label} generation progress`} />
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-surface-700 px-4 py-3">
            <div className="text-[11px] text-slate-500">
              {selectedModel.label} · ${estimatedCostUsd.toFixed(3)} / image
            </div>
            <div className="flex items-center gap-2">
              {!isCreate && (
                <button className="btn-ghost h-9 px-3 text-xs" onClick={saveDetails} disabled={working}>
                  <Save size={13} /> Save details
                </button>
              )}
              <button className="btn-primary h-9 px-4 text-sm font-semibold" onClick={() => void generate()} disabled={!canGenerate}>
                <Sparkles size={14} />
                {working ? 'Generating…' : isCreate ? `Generate ${config.label}` : 'Regenerate'}
                <span className="ml-1 text-[10px] font-medium text-white/80">${estimatedCostUsd.toFixed(3)}</span>
              </button>
            </div>
          </div>
        </main>
      </div>
      {referencePickerOpen && (
        <MediaPicker
          assets={assets}
          pickerMode="reference"
          allowCharacterReferences={false}
          allowVideoReferences={supportsVideoReferences}
          title={supportsVideoReferences ? 'Pick Reference Media' : 'Pick Reference Images'}
          helperText={supportsVideoReferences
            ? `Choose existing image or video assets, or import new media for this ${config.label.toLowerCase()}.`
            : `Choose existing image assets or import new images for this ${config.label.toLowerCase()}.`}
          importLabel={supportsVideoReferences ? 'Import Media' : 'Import Images'}
          zIndexClassName="z-[120]"
          onPick={attachReferenceAsset}
          onImportFromComputer={() => void importReferenceMedia()}
          onClose={() => setReferencePickerOpen(false)}
        />
      )}
    </div>
  );
}

function defaultCharacterForm(assets: MediaAsset[], referenceKind: ReferenceAssetKind): CharacterForm {
  const model = defaultImageModel();
  return {
    name: '',
    characterId: uniqueReferenceId(referenceKind, assets, referenceKind),
    description: '',
    style: 'real-life',
    model: model.id,
    aspectRatio: CHARACTER_IMAGE_ASPECT_RATIO,
    resolution: CHARACTER_IMAGE_RESOLUTION,
  };
}

function setFormForModel(modelId: string, setForm: (updater: (current: CharacterForm) => CharacterForm) => void) {
  const model = imageModelById(modelId) ?? defaultImageModel();
  setForm((current) => ({
    ...current,
    model: model.id,
    aspectRatio: CHARACTER_IMAGE_ASPECT_RATIO,
    resolution: CHARACTER_IMAGE_RESOLUTION,
  }));
}

function buildReferenceImagePrompt(basePrompt: string, style: CharacterVisualStyle, referenceKind: ReferenceAssetKind): string {
  const stylePrompt = CHARACTER_STYLE_OPTIONS.find((option) => option.value === style)?.prompt;
  return [basePrompt.trim(), stylePrompt, REFERENCE_CONFIG[referenceKind].sheetTemplate].filter(Boolean).join('\n\n');
}

function addReferenceMediaPromptGuidance(prompt: string, videoReferenceCount: number): string {
  if (videoReferenceCount <= 0) return prompt;
  return [
    prompt,
    `Use the attached sampled frames from ${videoReferenceCount === 1 ? 'the reference video' : 'the reference videos'} to infer motion continuity, recurring details, material behavior, lighting changes, and spatial context. Treat these frames as visual references, not as storyboard panels to copy verbatim.`,
  ].join('\n\n');
}

function buildPaintEditPrompt(editPrompt: string, referenceKind: ReferenceAssetKind, hasPaintGuide: boolean): string {
  const label = REFERENCE_CONFIG[referenceKind].label.toLowerCase();
  return [
    `Edit the provided ${label} image according to this prompt: ${editPrompt.trim()}`,
    hasPaintGuide
      ? 'Use the painted guide image as spatial direction only. Colored brush marks identify the area to change and must not appear in the final image.'
      : null,
    'Keep the existing identity, layout, camera angle, and unmentioned details unchanged. Return only the edited image.',
  ].filter(Boolean).join('\n\n');
}

async function paintGuideFileFromCanvas(image: HTMLImageElement | null, paintCanvas: HTMLCanvasElement | null): Promise<File | null> {
  if (!image || !paintCanvas) return null;
  const width = image.naturalWidth || Math.round(paintCanvas.getBoundingClientRect().width);
  const height = image.naturalHeight || Math.round(paintCanvas.getBoundingClientRect().height);
  if (width <= 0 || height <= 0) return null;

  const guideCanvas = document.createElement('canvas');
  guideCanvas.width = width;
  guideCanvas.height = height;
  const context = guideCanvas.getContext('2d');
  if (!context) return null;
  context.drawImage(image, 0, 0, width, height);
  context.drawImage(paintCanvas, 0, 0, width, height);

  const blob = await canvasToBlob(guideCanvas);
  if (!blob) return null;
  return new File([blob], 'painted-edit-guide.png', { type: 'image/png' });
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

function IterationButton({ iteration, active, onClick }: { iteration: EditTrailIteration; active: boolean; onClick: () => void }) {
  const cost = iteration.generation?.actualCostUsd ?? iteration.generation?.estimatedCostUsd;
  return (
    <button
      type="button"
      className={`w-full rounded-md border p-2 text-left transition ${active ? 'border-brand-300 bg-brand-500/15' : 'border-surface-700 bg-surface-950/50 hover:border-surface-500 hover:bg-surface-800/70'}`}
      onClick={onClick}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-xs font-semibold text-slate-100">{iteration.label}</div>
          <div className="text-[10px] uppercase tracking-wide text-slate-500">{iteration.generation?.model ?? iteration.source}</div>
        </div>
        {cost !== undefined && <span className="rounded bg-surface-800 px-1.5 py-0.5 text-[10px] text-emerald-200">${cost.toFixed(3)}</span>}
      </div>
      <div className="aspect-square overflow-hidden rounded bg-black/35">
        {iteration.thumbnailDataUrl ? (
          <img src={iteration.thumbnailDataUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-slate-500"><ImageIcon size={18} /></div>
        )}
      </div>
    </button>
  );
}

function StyleSelect({ value, onChange }: { value: CharacterVisualStyle; onChange: (value: CharacterVisualStyle) => void }) {
  return (
    <div>
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Style</div>
      <div className="flex flex-wrap gap-1">
        {CHARACTER_STYLE_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            className={`h-7 rounded px-2 text-xs transition ${value === option.value ? 'bg-brand-500 text-white' : 'bg-surface-800 text-slate-300 hover:bg-surface-700'}`}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

async function buildReferenceInput(
  assets: MediaAsset[],
  model: ImageModelDefinition,
  objectUrlFor: (assetId: string) => Promise<string | null>,
): Promise<{ referenceUrls?: string[]; referenceFiles?: File[] }> {
  if (assets.length === 0) return {};
  const imageAssets = assets.filter(isReferenceImageAsset);
  const videoAssets = model.capabilities.videoInputs ? assets.filter(isReferenceVideoAsset) : [];
  if (isGptImageModel(model)) {
    const referenceFiles = await Promise.all(imageAssets.map((asset) => referenceFileForAsset(asset, objectUrlFor)));
    return { referenceFiles: referenceFiles.filter((file): file is File => Boolean(file)) };
  }
  const imageUrls = imageAssets.length > 0
    ? await hostLitterboxReferences(imageAssets, 'Reference image')
    : [];
  const videoFrameUrls = await hostVideoReferenceFrameUrls(videoAssets, objectUrlFor);
  return { referenceUrls: [...imageUrls, ...videoFrameUrls] };
}

async function buildPaintEditInput(
  sourceAsset: MediaAsset,
  paintGuideFile: File | null,
  referenceAssets: MediaAsset[],
  model: ImageModelDefinition,
  objectUrlFor: (assetId: string) => Promise<string | null>,
): Promise<{ referenceUrls?: string[]; referenceFiles?: File[] }> {
  const imageReferences = referenceAssets.filter(isReferenceImageAsset);
  const videoReferences = model.capabilities.videoInputs ? referenceAssets.filter(isReferenceVideoAsset) : [];
  if (isGptImageModel(model)) {
    const sourceFile = await referenceFileForAsset(sourceAsset, objectUrlFor);
    const referenceFiles = await Promise.all(imageReferences.map((asset) => referenceFileForAsset(asset, objectUrlFor)));
    return {
      referenceFiles: [sourceFile, paintGuideFile, ...referenceFiles].filter((file): file is File => Boolean(file)),
    };
  }

  const sourceAndReferenceUrls = await hostLitterboxReferences([sourceAsset, ...imageReferences], 'Edit reference image');
  const videoFrameUrls = await hostVideoReferenceFrameUrls(videoReferences, objectUrlFor);
  if (!paintGuideFile) return { referenceUrls: [...sourceAndReferenceUrls, ...videoFrameUrls] };
  const guideUrl = await hostLitterboxFile(paintGuideFile);
  const [sourceUrl, ...referenceUrls] = sourceAndReferenceUrls;
  return {
    referenceUrls: [sourceUrl, guideUrl, ...referenceUrls, ...videoFrameUrls].filter((url): url is string => Boolean(url)),
  };
}

async function hostVideoReferenceFrameUrls(
  videoAssets: MediaAsset[],
  objectUrlFor: (assetId: string) => Promise<string | null>,
): Promise<string[]> {
  const urls: string[] = [];
  for (const asset of videoAssets) {
    const frameFiles = await videoReferenceFrameFilesForAsset(asset, objectUrlFor);
    for (const file of frameFiles) urls.push(await hostLitterboxFile(file));
  }
  return urls;
}

async function videoReferenceFrameFilesForAsset(
  asset: MediaAsset,
  objectUrlFor: (assetId: string) => Promise<string | null>,
): Promise<File[]> {
  const url = await objectUrlFor(asset.id);
  if (!url) return [];

  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'metadata';
  video.crossOrigin = 'anonymous';

  const metadataReady = waitForVideoEvent(video, 'loadedmetadata', `Could not read metadata from reference video "${asset.name}".`);
  video.src = url;
  video.load();
  await metadataReady;
  const durationSec = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : asset.durationSec;
  const times = videoReferenceFrameTimes(durationSec);
  const frames: File[] = [];

  for (let index = 0; index < times.length; index += 1) {
    await seekVideo(video, times[index]!);
    const frame = await videoFrameFile(video, asset, index);
    if (frame) frames.push(frame);
  }

  video.removeAttribute('src');
  video.load();
  return frames;
}

function videoReferenceFrameTimes(durationSec: number): number[] {
  if (!Number.isFinite(durationSec) || durationSec <= 0.25) return [0];
  const rawTimes = VIDEO_REFERENCE_FRAME_COUNT === 1
    ? [durationSec / 2]
    : [0.12, 0.5, 0.88].slice(0, VIDEO_REFERENCE_FRAME_COUNT).map((ratio) => durationSec * ratio);
  const maxTime = Math.max(0, durationSec - 0.05);
  const uniqueTimes: number[] = [];
  for (const timeSec of rawTimes) {
    const clampedTime = clamp(timeSec, 0, maxTime);
    if (!uniqueTimes.some((existing) => Math.abs(existing - clampedTime) < 0.1)) uniqueTimes.push(clampedTime);
  }
  return uniqueTimes.length > 0 ? uniqueTimes : [0];
}

async function seekVideo(video: HTMLVideoElement, timeSec: number): Promise<void> {
  const targetTime = Math.max(0, timeSec);
  if (Math.abs(video.currentTime - targetTime) < 0.02 && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return;
  const seeked = waitForVideoEvent(video, 'seeked', 'Could not sample a reference video frame.');
  video.currentTime = targetTime;
  await seeked;
}

async function videoFrameFile(video: HTMLVideoElement, asset: MediaAsset, index: number): Promise<File | null> {
  const sourceWidth = video.videoWidth;
  const sourceHeight = video.videoHeight;
  if (sourceWidth <= 0 || sourceHeight <= 0) return null;

  const scale = Math.min(1, VIDEO_REFERENCE_MAX_EDGE_PX / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.drawImage(video, 0, 0, width, height);
  const blob = await canvasToBlob(canvas);
  if (!blob) return null;
  return new File([blob], referenceVideoFrameFileName(asset, index), { type: 'image/png' });
}

function waitForVideoEvent(video: HTMLVideoElement, eventName: keyof HTMLMediaElementEventMap, fallbackMessage: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error(fallbackMessage));
    }, 15_000);
    const cleanup = () => {
      window.clearTimeout(timeout);
      video.removeEventListener(eventName, onEvent);
      video.removeEventListener('error', onError);
    };
    const onEvent = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error(fallbackMessage));
    };
    video.addEventListener(eventName, onEvent, { once: true });
    video.addEventListener('error', onError, { once: true });
  });
}

function referenceVideoFrameFileName(asset: MediaAsset, index: number): string {
  const base = (referenceDataForAsset(asset)?.referenceId ?? asset.name.replace(/\.[a-z0-9]{2,8}$/i, '') ?? asset.id)
    .trim()
    .replace(/[^a-z0-9_-]+/gi, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '');
  return `${base || asset.id}-video-frame-${index + 1}.png`;
}

async function referenceFileForAsset(asset: MediaAsset, objectUrlFor: (assetId: string) => Promise<string | null>): Promise<File | null> {
  const url = await objectUrlFor(asset.id);
  if (!url) return null;
  const blob = await fetch(url).then((response) => response.blob());
  const extension = extensionForMime(blob.type || asset.mimeType);
  return new File([blob], referenceFileName(asset, extension), { type: blob.type || asset.mimeType || 'image/png' });
}

function referenceFileName(asset: MediaAsset, extension: string): string {
  const base = referenceDataForAsset(asset)?.referenceId ?? asset.name.replace(/\.[a-z0-9]{2,8}$/i, '') ?? asset.id;
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

function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids)];
}

function isReferenceVideoAsset(asset: MediaAsset): boolean {
  return asset.kind === 'video' && asset.generation?.status !== 'generating' && Boolean(asset.blobKey);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function formatGenerationError(err: unknown): string {
  if (err instanceof VideoGenerationProviderError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Reference generation failed.';
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
