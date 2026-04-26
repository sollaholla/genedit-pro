import {
  Aperture,
  BookOpen,
  Camera,
  Check,
  Clapperboard,
  Crop,
  ExternalLink,
  Film,
  FolderOpen,
  Image as ImageIcon,
  ListChecks,
  Palette,
  Plus,
  Save,
  Search,
  SunMedium,
  Upload,
  UserRound,
  X,
  Zap,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CONNECTION_SETTINGS_CHANGED_EVENT,
  PIAPI_API_KEY_STORAGE,
  PIAPI_KLING_API_KEY_STORAGE,
  PIAPI_VEO_API_KEY_STORAGE,
} from '@/lib/settings/connectionStorage';
import { decryptSecret } from '@/lib/settings/crypto';
import { composeSequencePrompt, sequenceReferenceAssetIds } from '@/lib/media/sequence';
import { isBillingErrorText, VideoGenerationProviderError, type GenerationErrorType } from '@/lib/videoGeneration/errors';
import { hostLitterboxReference } from '@/lib/videoGeneration/litterbox';
import { downloadGeneratedVideoFile } from '@/lib/videoGeneration/download';
import {
  buildPiApiCreateTaskRequest,
  createPiApiVideoTask,
  generatedPiApiVideoFromTask,
  PIAPI_ARTIFACT_TTL_MS,
  PIAPI_BILLING_URL,
  pollPiApiVideoTask,
} from '@/lib/videoGeneration/piapi';
import { buildVideoGenerationMutation } from '@/lib/videoGeneration/mutations';
import {
  DEFAULT_VIDEO_MODELS,
  buildStructuredPromptText,
  isAspectFeatureSupported,
  isAudioFeatureSupported,
  isDurationFeatureSupported,
  isReferencesFeatureSupported,
  isResolutionFeatureSupported,
  isKlingModel,
  isPiApiKlingModel,
  isPiApiSeedanceModel,
  isPiApiVeoModel,
  isVeoModel,
  missingRequiredStructuredSections,
  sortModelsByPriority,
  structuredPromptSectionsFor,
  type Aspect,
  type StructuredPromptSectionDefinition,
  type StructuredPromptSectionIcon,
  type VideoModelDefinition,
} from '@/lib/videoModels/capabilities';
import { useMediaStore } from '@/state/mediaStore';
import type { GenerateRecipe, MediaAsset } from '@/types';
import { ModelSelect } from './ModelSelect';

type Props = {
  open: boolean;
  onClose: () => void;
  onOpenSettings: () => void;
  onGenerationQueued?: (assetId: string) => void;
  initialRecipeAsset?: MediaAsset | null;
  initialSequenceAsset?: MediaAsset | null;
  folderId?: string | null;
};

type RefToken = {
  id: string;
  token: string;
  assetId: string;
  name: string;
  kind: 'image' | 'video' | 'audio';
  thumbnail?: string;
};

type PromptMode = 'freeform' | 'structured';

type VideoProviderCredentialAvailability = {
  piapi: boolean;
};

const GENERATION_ASPECT_STORAGE_KEY = 'genedit-pro:generation-aspect';
const GENERATION_ASPECTS: readonly Aspect[] = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'];

const STRUCTURED_PROMPT_ICON: Record<StructuredPromptSectionIcon, LucideIcon> = {
  subject: UserRound,
  action: Zap,
  style: Palette,
  camera: Camera,
  composition: Crop,
  lens: Aperture,
  ambience: SunMedium,
};

function isGenerationAspect(value: string | null): value is Aspect {
  return Boolean(value && GENERATION_ASPECTS.includes(value as Aspect));
}

function readStoredGenerationAspect(): Aspect {
  try {
    const stored = localStorage.getItem(GENERATION_ASPECT_STORAGE_KEY);
    if (isGenerationAspect(stored)) return stored;
  } catch {
    // ignore storage failures
  }
  return '16:9';
}

function persistGenerationAspect(value: Aspect) {
  try {
    localStorage.setItem(GENERATION_ASPECT_STORAGE_KEY, value);
  } catch {
    // ignore storage failures
  }
}

export function GenerateVideoModal({ open, onClose, onOpenSettings, onGenerationQueued, initialRecipeAsset = null, initialSequenceAsset = null, folderId = null }: Props) {
  const assets = useMediaStore((s) => s.assets);
  const importFiles = useMediaStore((s) => s.importFiles);
  const addGeneratedAsset = useMediaStore((s) => s.addGeneratedAsset);
  const updateGenerationProgress = useMediaStore((s) => s.updateGenerationProgress);
  const updateGenerationTask = useMediaStore((s) => s.updateGenerationTask);
  const finalizeGeneratedAssetWithBlob = useMediaStore((s) => s.finalizeGeneratedAssetWithBlob);
  const failGeneratedAsset = useMediaStore((s) => s.failGeneratedAsset);
  const saveRecipeAsset = useMediaStore((s) => s.saveRecipeAsset);

  const [models, setModels] = useState<VideoModelDefinition[]>(DEFAULT_VIDEO_MODELS);
  const [loadingModels, setLoadingModels] = useState(false);
  const [connectionRevision, setConnectionRevision] = useState(0);
  const [model, setModel] = useState(DEFAULT_VIDEO_MODELS[0].id);
  const [aspect, setAspect] = useState<Aspect>(readStoredGenerationAspect);
  const [resolution, setResolution] = useState('720p');
  const [duration, setDuration] = useState('4s');
  const [audioEnabled, setAudioEnabled] = useState(false);
  const [hoveredToken, setHoveredToken] = useState<RefToken | null>(null);
  const [hoverPos, setHoverPos] = useState({ x: 0, y: 0 });
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [loadedRecipeId, setLoadedRecipeId] = useState<string | null>(null);
  const [recipePickerOpen, setRecipePickerOpen] = useState(false);
  const [recipeQuery, setRecipeQuery] = useState('');

  const [prompt, setPrompt] = useState('');
  const [promptMode, setPromptMode] = useState<PromptMode>('freeform');
  const [structuredPrompt, setStructuredPrompt] = useState<Record<string, string>>({});
  const [showMediaPicker, setShowMediaPicker] = useState(false);
  const [pickerMode, setPickerMode] = useState<'reference' | 'start' | 'end' | 'source-video'>('reference');
  const [references, setReferences] = useState<RefToken[]>([]);
  const [startFrame, setStartFrame] = useState<MediaAsset | null>(null);
  const [endFrame, setEndFrame] = useState<MediaAsset | null>(null);
  const [sourceVideo, setSourceVideo] = useState<MediaAsset | null>(null);

  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionPos, setMentionPos] = useState({ x: 0, y: 0 });
  const [mentionRange, setMentionRange] = useState<{ start: number; end: number } | null>(null);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const initialRecipeLoadKeyRef = useRef<string | null>(null);
  const initialSequenceLoadKeyRef = useRef<string | null>(null);

  const selectedModel = useMemo(
    () => models.find((m) => m.id === model) ?? DEFAULT_VIDEO_MODELS[0],
    [model, models],
  );
  const credentialAvailability = useMemo(readVideoProviderCredentialAvailability, [connectionRevision]);
  const selectableModels = useMemo(
    () => sortModelsByPriority(models.filter((candidate) => hasVideoProviderCredentials(candidate, credentialAvailability))),
    [credentialAvailability, models],
  );
  const hasConfiguredProviderModels = selectableModels.length > 0;
  const providerCredentialsAvailable = hasVideoProviderCredentials(selectedModel, credentialAvailability);
  const structuredSections = useMemo(() => structuredPromptSectionsFor(selectedModel), [selectedModel]);
  const structuredPromptText = useMemo(
    () => buildStructuredPromptText(selectedModel, structuredPrompt),
    [selectedModel, structuredPrompt],
  );
  const missingStructuredRequired = useMemo(
    () => missingRequiredStructuredSections(selectedModel, structuredPrompt),
    [selectedModel, structuredPrompt],
  );
  const activePrompt = promptMode === 'structured' ? structuredPromptText : prompt;
  const structuredPromptSupported = structuredSections.length > 0;
  const audioLockedOn = isAudioLockedOnModel(selectedModel);
  const referencesIgnoredByFrameMode = Boolean((isVeoModel(selectedModel) || isPiApiSeedanceModel(selectedModel)) && (startFrame || endFrame) && references.length > 0);
  const referencesIgnoredByVideoMode = Boolean(isVeoModel(selectedModel) && sourceVideo && references.length > 0);
  const generateDisabled = isGenerating ||
    !providerCredentialsAvailable ||
    (promptMode === 'structured' ? missingStructuredRequired.length > 0 || !activePrompt.trim() : !prompt.trim());
  const estimatedCostUsd = useMemo(() => {
    const seconds = Number(duration.replace('s', ''));
    return estimatePiApiCostUsd(selectedModel, resolution, seconds, audioEnabled);
  }, [audioEnabled, duration, resolution, selectedModel]);
  const imageReferenceLimit = sourceVideo
    ? isKlingModel(selectedModel)
      ? Math.min(selectedModel.capabilities.assetInputs.imageReferencesMax, 4)
      : isPiApiSeedanceModel(selectedModel)
        ? Math.max(0, selectedModel.capabilities.assetInputs.imageReferencesMax - 1)
        : selectedModel.capabilities.assetInputs.imageReferencesMax
    : selectedModel.capabilities.assetInputs.imageReferencesMax;
  const sourceVideoSupported = selectedModel.capabilities.assetInputs.videoExtension;
  const frameInputsSupported = selectedModel.capabilities.assetInputs.startFrame;
  const constrainedByEightSecondGeneration = Boolean(
    isPiApiVeoModel(selectedModel) && references.length > 0,
  );
  const durationOptions = useMemo(
    () => (constrainedByEightSecondGeneration
      ? selectedModel.capabilities.durations.filter((candidate) => candidate === '8s')
      : selectedModel.capabilities.durations),
    [constrainedByEightSecondGeneration, selectedModel.capabilities.durations],
  );
  const resolutionOptions = useMemo(
    () => selectedModel.capabilities.resolutions,
    [selectedModel.capabilities.resolutions],
  );
  const referenceImageAssets = useMemo(() => references
    .map((ref) => assets.find((asset) => asset.id === ref.assetId))
    .filter((asset): asset is MediaAsset => asset !== undefined)
    .filter((asset) => asset.kind === 'image'), [assets, references]);
  const shouldSendImageReferences = isReferencesFeatureSupported(selectedModel) &&
    !((isVeoModel(selectedModel) || isPiApiSeedanceModel(selectedModel)) && (startFrame || endFrame)) &&
    !(isVeoModel(selectedModel) && sourceVideo);
  const loadModels = useCallback(async () => {
    setLoadingModels(true);
    try {
      const prioritized = sortModelsByPriority(DEFAULT_VIDEO_MODELS);
      setModels(prioritized);
      if (!initialRecipeAsset?.recipe && !initialSequenceAsset?.sequence) setModel(prioritized[0]!.id);
    } finally {
      setLoadingModels(false);
    }
  }, [initialRecipeAsset?.recipe, initialSequenceAsset?.sequence]);

  useEffect(() => {
    if (!open) return;
    setConnectionRevision((value) => value + 1);
    void loadModels();
  }, [loadModels, open]);

  useEffect(() => {
    persistGenerationAspect(aspect);
  }, [aspect]);

  useEffect(() => {
    if (!open) return undefined;
    const refreshConnections = () => setConnectionRevision((value) => value + 1);
    window.addEventListener(CONNECTION_SETTINGS_CHANGED_EVENT, refreshConnections);
    window.addEventListener('storage', refreshConnections);
    return () => {
      window.removeEventListener(CONNECTION_SETTINGS_CHANGED_EVENT, refreshConnections);
      window.removeEventListener('storage', refreshConnections);
    };
  }, [open]);

  useEffect(() => {
    if (!open || selectableModels.length === 0) return;
    if (!selectableModels.some((candidate) => candidate.id === model)) setModel(selectableModels[0]!.id);
  }, [model, open, selectableModels]);

  useEffect(() => {
    if (!open) {
      initialRecipeLoadKeyRef.current = null;
      return;
    }
    if (initialSequenceAsset?.sequence) return;
    if (!initialRecipeAsset?.recipe) return;
    if (initialRecipeLoadKeyRef.current === initialRecipeAsset.id) return;
    initialRecipeLoadKeyRef.current = initialRecipeAsset.id;
    const recipe = initialRecipeAsset.recipe;
    setLoadedRecipeId(initialRecipeAsset.kind === 'recipe' ? initialRecipeAsset.id : null);
    setModel(recipe.model);
    const nextStartFrame = recipe.startFrameAssetId ? assets.find((a) => a.id === recipe.startFrameAssetId) ?? null : null;
    const nextEndFrame = recipe.endFrameAssetId ? assets.find((a) => a.id === recipe.endFrameAssetId) ?? null : null;
    setPrompt(recipe.prompt);
    setPromptMode(recipe.promptMode ?? 'freeform');
    setStructuredPrompt(recipe.structuredPrompt ?? {});
    setAspect((recipe.aspect as Aspect) || '16:9');
    setResolution(recipe.resolution || '720p');
    setDuration(recipe.duration || '4s');
    setAudioEnabled(Boolean(recipe.audioEnabled));
    const nextSourceVideo = recipe.sourceVideoAssetId
      ? assets.find((a) => a.id === recipe.sourceVideoAssetId && a.kind === 'video') ?? null
      : null;
    setSourceVideo(nextSourceVideo);
    setStartFrame(nextSourceVideo ? null : nextStartFrame);
    setEndFrame(nextSourceVideo ? null : nextEndFrame);
    const selectedRefs = recipe.referenceAssetIds
      .map((assetId) => assets.find((a) => a.id === assetId))
      .filter((a): a is MediaAsset => Boolean(a))
      .filter((a) => a.kind === 'image')
      .map((asset, index) => ({
        id: `${asset.id}-${Date.now()}-${index}`,
        token: `${asset.kind}${index + 1}`,
        assetId: asset.id,
        name: asset.name,
        kind: asset.kind as RefToken['kind'],
        thumbnail: asset.thumbnailDataUrl,
      }));
    setReferences(selectedRefs);
  }, [open, initialRecipeAsset, assets]);

  useEffect(() => {
    if (!open) {
      initialSequenceLoadKeyRef.current = null;
      return;
    }
    if (!initialSequenceAsset?.sequence) return;
    if (initialSequenceLoadKeyRef.current === initialSequenceAsset.id) return;
    initialSequenceLoadKeyRef.current = initialSequenceAsset.id;
    const sequence = initialSequenceAsset.sequence;
    const imageAssetIds = new Set(assets.filter((asset) => asset.kind === 'image').map((asset) => asset.id));
    const sequenceModel = models.find((candidate) => candidate.id === sequence.model) ?? DEFAULT_VIDEO_MODELS.find((candidate) => candidate.id === sequence.model);
    const maxImages = sequenceModel?.capabilities.assetInputs.imageReferencesMax ?? 12;
    const referenceAssetIds = sequenceReferenceAssetIds(sequence, { availableImageAssetIds: imageAssetIds, maxImages });
    setLoadedRecipeId(null);
    setRecipePickerOpen(false);
    setRecipeQuery('');
    setModel(sequence.model);
    setPrompt(composeSequencePrompt(sequence, { availableImageAssetIds: imageAssetIds, maxImages }));
    setPromptMode('freeform');
    setStructuredPrompt({});
    setDuration(`${sequence.durationSec}s`);
    setAudioEnabled(true);
    setStartFrame(null);
    setEndFrame(null);
    setSourceVideo(null);
    setReferences(referenceAssetIds
      .map((assetId) => assets.find((asset) => asset.id === assetId && asset.kind === 'image'))
      .filter((asset): asset is MediaAsset => Boolean(asset))
      .map((asset, index) => ({
        id: `${initialSequenceAsset.id}-${asset.id}-${index}`,
        token: `image${index + 1}`,
        assetId: asset.id,
        name: asset.name,
        kind: 'image' as const,
        thumbnail: asset.thumbnailDataUrl,
      })));
  }, [open, initialSequenceAsset, assets]);

  useEffect(() => {
    if (!isResolutionFeatureSupported(selectedModel, resolution) || !resolutionOptions.includes(resolution)) {
      setResolution(resolutionOptions[0] ?? selectedModel.capabilities.resolutions[0] ?? '720p');
    }
    if (!isDurationFeatureSupported(selectedModel, duration) || !durationOptions.includes(duration)) {
      setDuration(durationOptions[0] ?? selectedModel.capabilities.durations[0] ?? '4s');
    }
    if (!isAspectFeatureSupported(selectedModel, aspect)) {
      setAspect(selectedModel.capabilities.aspects[0] ?? '16:9');
    }
    if (!frameInputsSupported) {
      setStartFrame(null);
      setEndFrame(null);
    }
    if (!sourceVideoSupported || (sourceVideo && !isSourceVideoReferenceValid(selectedModel, sourceVideo))) setSourceVideo(null);
    if (imageReferenceLimit > 0 && references.length > imageReferenceLimit) setReferences((prev) => prev.slice(0, imageReferenceLimit));
    if (audioLockedOn) setAudioEnabled(true);
    else if (!isAudioFeatureSupported(selectedModel)) setAudioEnabled(false);
    if (!selectedModel.promptGuidelines?.structuredSections.length && promptMode === 'structured') {
      setPromptMode('freeform');
    }
  }, [
    aspect,
    duration,
    durationOptions,
    frameInputsSupported,
    imageReferenceLimit,
    references.length,
    resolution,
    resolutionOptions,
    selectedModel,
    sourceVideo,
    sourceVideoSupported,
    promptMode,
    audioLockedOn,
  ]);

  const sourceVideoToken = useMemo<RefToken | null>(() => sourceVideo ? {
    id: `${sourceVideo.id}-video-reference`,
    token: 'video1',
    assetId: sourceVideo.id,
    name: sourceVideo.name,
    kind: 'video',
    thumbnail: sourceVideo.thumbnailDataUrl,
  } : null, [sourceVideo]);

  const allMentionItems = [
    ...(startFrame ? [{ key: 'start-frame', label: '@start-frame', action: () => insertToken('@start-frame') }] : []),
    ...(endFrame ? [{ key: 'end-frame', label: '@end-frame', action: () => insertToken('@end-frame') }] : []),
    ...(sourceVideoToken ? [{ key: sourceVideoToken.id, label: '@video1', action: () => insertToken('@video1') }] : []),
    ...references.map((ref) => ({ key: ref.id, label: `@${ref.token}`, action: () => insertToken(`@${ref.token}`) })),
  ];

  const filteredMentionItems = mentionQuery.trim()
    ? allMentionItems.filter((item) => item.label.toLowerCase().includes(mentionQuery.toLowerCase()))
    : allMentionItems;

  const referenceMap = useMemo(() => {
    const out = new Map<string, RefToken | 'start' | 'end'>();
    for (const ref of references) out.set(ref.token.toLowerCase(), ref);
    if (sourceVideoToken) out.set(sourceVideoToken.token.toLowerCase(), sourceVideoToken);
    if (startFrame) out.set('start-frame', 'start');
    if (endFrame) out.set('end-frame', 'end');
    return out;
  }, [references, sourceVideoToken, startFrame, endFrame]);

  const promptTokens = useMemo(
    () => Array.from(prompt.matchAll(/@([a-z0-9-]+)/gi)),
    [prompt],
  );
  const recipeAssets = useMemo(() => assets.filter((a) => a.kind === 'recipe' && a.recipe), [assets]);
  const filteredRecipeAssets = useMemo(() => {
    const q = recipeQuery.trim().toLowerCase();
    return [...recipeAssets]
      .sort((a, b) => b.createdAt - a.createdAt || a.name.localeCompare(b.name))
      .filter((asset) => {
        if (!q) return true;
        const recipe = asset.recipe;
        const haystack = [
          asset.name,
          recipe?.prompt,
          ...(recipe?.structuredPrompt ? Object.values(recipe.structuredPrompt) : []),
          recipe?.model,
          recipe?.aspect,
          recipe?.resolution,
          recipe?.duration,
        ].join(' ').toLowerCase();
        return haystack.includes(q);
      });
  }, [recipeAssets, recipeQuery]);
  const loadedRecipeAsset = useMemo(
    () => (loadedRecipeId ? recipeAssets.find((asset) => asset.id === loadedRecipeId) ?? null : null),
    [loadedRecipeId, recipeAssets],
  );
  if (!open) return null;

  function buildToken(kind: RefToken['kind'], index: number) {
    return `${kind}${index + 1}`;
  }

  function addReferenceAsset(asset: MediaAsset) {
    if (asset.kind !== 'image') return;
    if (imageReferenceLimit <= 0) return;
    if (references.length >= imageReferenceLimit) return;
    const kind = asset.kind as RefToken['kind'];
    const countForKind = references.filter((r) => r.kind === kind).length;
    const token = buildToken(kind, countForKind);
    const entry: RefToken = {
      id: `${asset.id}-${Date.now()}`,
      token,
      assetId: asset.id,
      name: asset.name,
      kind,
      thumbnail: asset.thumbnailDataUrl,
    };
    if (!isKlingModel(selectedModel) && !isPiApiSeedanceModel(selectedModel)) setSourceVideo(null);
    setReferences((prev) => [...prev, entry]);
  }

  function insertToken(token: string) {
    const textarea = editorRef.current;
    if (!textarea) {
      setPrompt((prev) => `${prev} ${token}`.trim());
      return;
    }
    const start = mentionRange?.start ?? textarea.selectionStart;
    const end = mentionRange?.end ?? textarea.selectionEnd;
    const next = `${prompt.slice(0, start)}${token} ${prompt.slice(end)}`;
    setPrompt(next);
    requestAnimationFrame(() => {
      textarea.focus();
      const pos = start + token.length + 1;
      textarea.setSelectionRange(pos, pos);
    });
    setMentionOpen(false);
    setMentionQuery('');
    setMentionRange(null);
  }

  function onPromptChange(value: string) {
    setPrompt(value);
    const textarea = editorRef.current;
    if (!textarea) return;
    const cursor = textarea.selectionStart;
    const prefix = value.slice(0, cursor);
    const match = prefix.match(/@([a-z0-9-]*)$/i);
    if (!match) {
      setMentionOpen(false);
      setMentionQuery('');
      setMentionRange(null);
      return;
    }
    setMentionQuery(match[1]);
    setMentionRange({ start: match.index ?? 0, end: cursor });
    const rect = textarea.getBoundingClientRect();
    setMentionPos({ x: rect.left + 18, y: rect.bottom - 12 });
    setMentionOpen(true);
  }

  function removeReference(id: string) {
    const ref = references.find((item) => item.id === id);
    if (!ref) return;
    setReferences((prev) => prev.filter((r) => r.id !== id));
    setPrompt((prev) => prev.replaceAll(`@${ref.token}`, '').replace(/\s{2,}/g, ' ').trim());
  }

  async function onImportFromComputer() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = pickerMode === 'source-video' ? 'video/*' : 'image/*';
    input.multiple = true;
    input.onchange = async () => {
      const files = Array.from(input.files ?? []);
      if (!files.length) return;
      const imported = await importFiles(files);
      const first = imported[0];
      if (!first) return;
      if (pickerMode === 'start') {
        setStartFrame(first.kind === 'image' ? first : null);
        if (first.kind === 'image') setSourceVideo(null);
      } else if (pickerMode === 'end') {
        setEndFrame(first.kind === 'image' ? first : null);
        if (first.kind === 'image') setSourceVideo(null);
      } else if (pickerMode === 'source-video') {
        const validSource = first.kind === 'video' && isSourceVideoReferenceValid(selectedModel, first);
        setSourceVideo(validSource ? first : null);
        if (validSource) {
          setStartFrame(null);
          setEndFrame(null);
        }
      }
      else addReferenceAsset(first);
    };
    input.click();
  }

  async function generate() {
    setGenerationError(null);
    const promptForGeneration = activePrompt.trim();
    if (promptMode === 'structured') {
      const missing = missingRequiredStructuredSections(selectedModel, structuredPrompt);
      if (missing.length > 0) {
        setGenerationError(`Structured prompt needs: ${missing.map((section) => section.label).join(', ')}.`);
        return;
      }
    }
    if (!promptForGeneration) {
      setGenerationError('Add a generation description first.');
      return;
    }
    if (!providerCredentialsAvailable) {
      setGenerationError(`Connect ${providerNameForModel(selectedModel)} in Settings before generating.`);
      return;
    }
    setIsGenerating(true);
    const generationCostUsd = estimatedCostUsd || undefined;
    const generationRecipe = buildCurrentRecipe();
    const id = addGeneratedAsset(
      `Generating_${Date.now()}.mp4`,
      folderId,
      generationCostUsd,
      generationRecipe,
    );
    let taskAccepted = false;
    try {
      const mutation = buildVideoGenerationMutation({
        prompt: promptForGeneration,
        modelId: selectedModel.id,
        aspectRatio: aspect,
        duration,
        resolution,
        audioEnabled,
        startFrame,
        endFrame,
        sourceVideo,
        referenceImages: shouldSendImageReferences ? referenceImageAssets : [],
      });

      const apiKey = await readPiApiKey();
      if (!apiKey) throw new Error(`Missing ${providerNameForModel(selectedModel)} API key.`);
      let uploadProgress = 2;
      const request = await buildPiApiCreateTaskRequest(mutation, {
        resolveReferenceUrl: async (asset, label) => {
          updateGenerationProgress(id, uploadProgress);
          const url = await hostLitterboxReference(asset, label);
          uploadProgress = Math.min(15, uploadProgress + 4);
          updateGenerationProgress(id, uploadProgress);
          return url;
        },
      });
      const initialTask = await createPiApiVideoTask(request, { apiKey });
      if (!initialTask.task_id) throw new VideoGenerationProviderError('InternalError', 'PiAPI did not return a task id.');
      taskAccepted = true;
      updateGenerationTask(id, {
        provider: 'piapi',
        providerTaskId: initialTask.task_id,
        providerTaskEndpoint: initialTask.task_id ? `/api/v1/task/${initialTask.task_id}` : '/api/v1/task',
        providerTaskStatus: initialTask.status,
        providerTaskCreatedAt: Date.now(),
      });
      setIsGenerating(false);
      onGenerationQueued?.(id);
      onClose();
      const finalTask = await pollPiApiVideoTask({
        credentials: { apiKey },
        initialTask,
        onProgress: (progress) => updateGenerationProgress(id, progress),
      });
      updateGenerationTask(id, {
        provider: 'piapi',
        providerTaskId: finalTask.task_id ?? initialTask.task_id,
        providerTaskEndpoint: (finalTask.task_id ?? initialTask.task_id) ? `/api/v1/task/${finalTask.task_id ?? initialTask.task_id}` : '/api/v1/task',
        providerTaskStatus: finalTask.status,
      });
      const generatedVideo = generatedPiApiVideoFromTask(finalTask);
      if (!generatedVideo.url) throw new VideoGenerationProviderError('InternalError', 'No generated video URL returned by PiAPI.');

      const file = await downloadGeneratedVideoFile(generatedVideo.url, (progress) => updateGenerationProgress(id, progress));
      await finalizeGeneratedAssetWithBlob(id, file, {
        actualCostUsd: generationCostUsd,
        provider: 'piapi',
        providerArtifactUri: generatedVideo.url,
        providerArtifactExpiresAt: Date.now() + PIAPI_ARTIFACT_TTL_MS,
      });
    } catch (err) {
      const message = formatGenerationError(err);
      failGeneratedAsset(id, {
        actualCostUsd: generationCostUsd,
        errorMessage: message,
        errorType: generationErrorType(err),
      });
      if (!taskAccepted) setGenerationError(message);
    } finally {
      setIsGenerating(false);
    }
  }

  function buildCurrentRecipe(): GenerateRecipe {
    return {
      model,
      prompt,
      promptMode,
      structuredPrompt,
      aspect,
      resolution,
      duration,
      audioEnabled,
      startFrameAssetId: startFrame?.id ?? null,
      endFrameAssetId: endFrame?.id ?? null,
      sourceVideoAssetId: sourceVideo?.id ?? null,
      referenceAssetIds: references.map((r) => r.assetId),
    };
  }

  function saveRecipe(saveAs: boolean) {
    const recipeNameDefault = loadedRecipeId && !saveAs
      ? (assets.find((a) => a.id === loadedRecipeId)?.name ?? 'Recipe')
      : `Recipe ${new Date().toLocaleString()}`;
    const name = window.prompt('Recipe name', recipeNameDefault);
    if (!name?.trim()) return;
    const id = saveRecipeAsset(name.trim(), buildCurrentRecipe(), saveAs ? null : loadedRecipeId);
    setLoadedRecipeId(id);
  }

  function openRecipeById(recipeId: string) {
    const asset = recipeAssets.find((a) => a.id === recipeId);
    if (!asset?.recipe) return;
    const recipe = asset.recipe;
    setLoadedRecipeId(asset.id);
    setModel(recipe.model);
    const nextStartFrame = recipe.startFrameAssetId ? assets.find((a) => a.id === recipe.startFrameAssetId) ?? null : null;
    const nextEndFrame = recipe.endFrameAssetId ? assets.find((a) => a.id === recipe.endFrameAssetId) ?? null : null;
    setPrompt(recipe.prompt);
    setPromptMode(recipe.promptMode ?? 'freeform');
    setStructuredPrompt(recipe.structuredPrompt ?? {});
    setAspect((recipe.aspect as Aspect) || '16:9');
    setResolution(recipe.resolution || '720p');
    setDuration(recipe.duration || '4s');
    setAudioEnabled(Boolean(recipe.audioEnabled));
    const nextSourceVideo = recipe.sourceVideoAssetId
      ? assets.find((a) => a.id === recipe.sourceVideoAssetId && a.kind === 'video') ?? null
      : null;
    setSourceVideo(nextSourceVideo);
    setStartFrame(nextSourceVideo ? null : nextStartFrame);
    setEndFrame(nextSourceVideo ? null : nextEndFrame);
    const selectedRefs = recipe.referenceAssetIds
      .map((assetId) => assets.find((a) => a.id === assetId))
      .filter((a): a is MediaAsset => Boolean(a))
      .filter((a) => a.kind === 'image')
      .map((refAsset, index) => ({
        id: `${refAsset.id}-${Date.now()}-${index}`,
        token: `${refAsset.kind}${index + 1}`,
        assetId: refAsset.id,
        name: refAsset.name,
        kind: refAsset.kind as RefToken['kind'],
        thumbnail: refAsset.thumbnailDataUrl,
      }));
    setReferences(selectedRefs);
    setRecipePickerOpen(false);
    setRecipeQuery('');
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm">
      <div className="w-[min(780px,94vw)] rounded-lg border border-white/15 bg-surface-950 text-slate-100 shadow-2xl">
        <div className="flex items-center justify-between border-b border-surface-700 px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-100"><Clapperboard size={16} className="text-brand-300" /> Generate Video</div>
          <button className="rounded-md p-1 text-slate-400 hover:bg-white/10 hover:text-white" onClick={onClose} title="Close" aria-label="Close"><X size={16} /></button>
        </div>

        <div className="space-y-3 p-4">
          <div className="relative rounded-md border border-surface-700 bg-surface-900/70 p-2">
            <div className="flex flex-wrap items-center gap-2">
            <button className="btn-ghost px-2 py-1 text-xs" onClick={() => saveRecipe(false)}>
              <Save size={12} /> Save
            </button>
            <button className="btn-ghost px-2 py-1 text-xs" onClick={() => saveRecipe(true)}>
              <Save size={12} /> Save as
            </button>
            <button
              type="button"
              className="btn-ghost max-w-full px-2 py-1 text-xs"
              onClick={() => setRecipePickerOpen((v) => !v)}
            >
              <FolderOpen size={12} />
              <span>{loadedRecipeAsset ? 'Recipe' : 'Open recipe'}</span>
              {loadedRecipeAsset && <span className="max-w-[220px] truncate text-slate-400">{loadedRecipeAsset.name}</span>}
              <span className="rounded bg-surface-800 px-1.5 py-0.5 text-[10px] text-slate-400">{recipeAssets.length}</span>
            </button>
            </div>
            {recipePickerOpen && (
              <RecipePicker
                recipes={filteredRecipeAssets}
                totalCount={recipeAssets.length}
                query={recipeQuery}
                selectedId={loadedRecipeId}
                modelLabelFor={(modelId) => models.find((item) => item.id === modelId)?.label ?? modelId}
                onQueryChange={setRecipeQuery}
                onPick={openRecipeById}
                onClose={() => setRecipePickerOpen(false)}
              />
            )}
          </div>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <FrameRefButton
              label="Start frame"
              value={startFrame}
              disabled={!frameInputsSupported || Boolean(sourceVideo)}
              onClick={() => {
                setPickerMode('start');
                setShowMediaPicker(true);
              }}
              onClear={() => setStartFrame(null)}
            />
            <FrameRefButton
              label="End frame"
              value={endFrame}
              disabled={!frameInputsSupported || Boolean(sourceVideo) || !startFrame}
              onClick={() => {
                setPickerMode('end');
                setShowMediaPicker(true);
              }}
              onClear={() => setEndFrame(null)}
            />
            <FrameRefButton
              label="Video reference"
              value={sourceVideo}
              disabled={!sourceVideoSupported || Boolean(startFrame || endFrame) || Boolean(isVeoModel(selectedModel) && references.length)}
              onClick={() => {
                setPickerMode('source-video');
                setShowMediaPicker(true);
              }}
              onClear={() => setSourceVideo(null)}
            />
          </div>

          <div className="flex justify-end">
            <PromptModeSwatch
              mode={promptMode}
              structuredSupported={structuredPromptSupported}
              onChange={setPromptMode}
            />
          </div>

          <div className="relative rounded-md border border-surface-700 bg-surface-900 focus-within:border-brand-400">
            {promptMode === 'structured' && structuredPromptSupported ? (
              <StructuredPromptEditor
                sections={structuredSections}
                values={structuredPrompt}
                onChange={(id, value) => setStructuredPrompt((prev) => ({ ...prev, [id]: value }))}
                missingRequired={missingStructuredRequired.map((section) => section.id)}
              />
            ) : (
              <textarea
                ref={editorRef}
                value={prompt}
                onChange={(e) => onPromptChange(e.target.value)}
                placeholder="Describe your video. Type @ to insert @start-frame, @end-frame, or @image1 references."
                className="h-32 w-full resize-none rounded-md bg-transparent px-3 pb-11 pt-3 text-sm text-slate-100 outline-none placeholder:text-slate-500"
              />
            )}
            {promptMode === 'freeform' && promptTokens.length > 0 && (
              <div className="absolute inset-x-2 bottom-2 flex max-h-8 flex-wrap gap-1.5 overflow-y-auto rounded bg-surface-900/85 pr-1 backdrop-blur">
                {promptTokens.map((m, i) => {
                  const key = m[1].toLowerCase();
                  const meta = referenceMap.get(key);
                  const valid = Boolean(meta);
                  return (
                    <span
                      key={`${m.index}-${i}`}
                      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ${valid ? 'border-emerald-400/40 bg-emerald-500/10 text-emerald-200' : 'border-amber-400/40 bg-amber-500/10 text-amber-200'}`}
                      onMouseEnter={(e) => {
                        if (meta && typeof meta !== 'string') {
                          setHoveredToken(meta);
                          setHoverPos({ x: e.clientX + 12, y: e.clientY + 12 });
                        }
                      }}
                      onMouseMove={(e) => {
                        if (hoveredToken) setHoverPos({ x: e.clientX + 12, y: e.clientY + 12 });
                      }}
                      onMouseLeave={() => setHoveredToken(null)}
                    >
                      {meta && typeof meta !== 'string' && meta.thumbnail && <img src={meta.thumbnail} alt="" className="h-3.5 w-3.5 rounded object-cover" />}
                      @{m[1]}
                    </span>
                  );
                })}
              </div>
            )}
          </div>

          <div className="rounded-md border border-surface-700 bg-surface-900/70 p-2.5">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Image references</span>
              <button
                disabled={!isReferencesFeatureSupported(selectedModel) || references.length >= imageReferenceLimit || Boolean(sourceVideo && isVeoModel(selectedModel))}
                className="btn-ghost px-2 py-1 text-xs"
                onClick={() => {
                  setPickerMode('reference');
                  setShowMediaPicker(true);
                }}
              >
                <Plus size={12} /> Add reference
              </button>
            </div>
            {!isReferencesFeatureSupported(selectedModel) && (
              <div className="mb-2 rounded-md border border-amber-400/30 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-200">
                References are not supported by the selected model.
              </div>
            )}
            {isReferencesFeatureSupported(selectedModel) && (
              <div className="mb-2 text-[11px] text-slate-500">
                Up to {imageReferenceLimit} image references. {isVeoModel(selectedModel)
                  ? 'Start/end frames take precedence over image references.'
                  : 'References are sent through Kling Omni images.'}
              </div>
            )}
            {referencesIgnoredByFrameMode && (
              <div className="mb-2 rounded-md border border-amber-400/30 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-200">
                References will not be used since start / end frame is specified.
              </div>
            )}
            {referencesIgnoredByVideoMode && (
              <div className="mb-2 rounded-md border border-amber-400/30 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-200">
                References will not be used since a Veo video reference is specified.
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              {references.length === 0 && <span className="text-xs text-slate-500">No references selected.</span>}
              {references.map((ref) => (
                <button key={ref.id} onClick={() => removeReference(ref.id)} className="inline-flex items-center gap-1 rounded-md border border-surface-700 bg-surface-950 px-2 py-1 text-xs text-slate-200 hover:border-surface-500 hover:bg-surface-800">
                  {ref.thumbnail ? <img src={ref.thumbnail} alt="" className="h-4 w-4 rounded object-cover" /> : <ImageIcon size={12} />}
                  @{ref.token}
                  <X size={11} />
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-2 rounded-md border border-surface-700 bg-surface-900/70 p-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <ModelSelect value={model} onChange={setModel} options={selectableModels} loading={loadingModels} disabled={!hasConfiguredProviderModels} emptyLabel="Connect provider" />
              <PillOptionGroup label="Aspect" value={aspect} options={selectedModel.capabilities.aspects.map((v) => ({ value: v, label: v }))} onChange={(v) => setAspect(v as Aspect)} />
              <PillOptionGroup label="Resolution" value={resolution} options={resolutionOptions.map((v) => ({ value: v, label: v }))} onChange={setResolution} />
              <PillOptionGroup label="Duration" value={duration} options={durationOptions.map((v) => ({ value: v, label: v }))} onChange={setDuration} />
              <button
                disabled={!isAudioFeatureSupported(selectedModel) || audioLockedOn}
                title={audioLockedOn ? 'Audio is always on for this model.' : undefined}
                className={`inline-flex h-8 items-center rounded-md border px-3 text-xs transition ${audioEnabled ? 'border-emerald-400/60 bg-emerald-500/10 text-emerald-200' : 'border-surface-700 bg-surface-950 text-slate-300 hover:border-surface-500 hover:bg-surface-800'} disabled:cursor-not-allowed disabled:opacity-60`}
                onClick={() => {
                  if (audioLockedOn) return;
                  setAudioEnabled((v) => !v);
                }}
              >
                Audio {audioEnabled ? 'On' : 'Off'}
              </button>
            </div>
          </div>

          <div className="flex items-center justify-between gap-3">
            <div className="text-[11px] text-slate-500">
              {providerCredentialsAvailable ? selectedModel.label : `Connect ${providerNameForModel(selectedModel)} in Settings`}
            </div>
            {!hasConfiguredProviderModels && (
              <div className="flex items-center gap-2 rounded-md border border-amber-400/25 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-100">
                <span>Add a PiAPI key to enable generation models.</span>
                <button
                  type="button"
                  className="rounded border border-amber-200/40 px-2 py-0.5 text-amber-50 hover:bg-amber-300/10"
                  onClick={onOpenSettings}
                >
                  Settings
                </button>
              </div>
            )}
            {generationError && (
              <div className="flex items-center gap-2 text-xs text-rose-300">
                <span>{generationError}</span>
                {isBillingErrorText(generationError) && (
                  <a
                    className="inline-flex items-center gap-1 rounded border border-rose-300/40 px-2 py-1 text-[11px] text-rose-200 hover:bg-rose-500/10"
                    href={PIAPI_BILLING_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Open Billing
                    <ExternalLink size={11} />
                  </a>
                )}
                {(generationError.includes('Missing PiAPI') || generationError.includes('Settings')) && (
                  <button
                    className="rounded border border-rose-300/40 px-2 py-1 text-[11px] text-rose-200 hover:bg-rose-500/10"
                    onClick={onOpenSettings}
                  >
                    Open Settings
                  </button>
                )}
              </div>
            )}
            <button
              type="button"
              onClick={generate}
              disabled={generateDisabled}
              className="btn-primary h-9 px-4 text-sm font-semibold"
            >
              {isGenerating ? 'Generating...' : (
                <>
                  Generate
                  {estimatedCostUsd > 0 && (
                    <span className="ml-1 text-[10px] font-medium text-white/80">${estimatedCostUsd.toFixed(2)}</span>
                  )}
                </>
              )}
            </button>
          </div>
        </div>
      </div>

      {mentionOpen && filteredMentionItems.length > 0 && (
        <div
          className="fixed z-[60] w-52 rounded-md border border-surface-600 bg-surface-800 p-1 shadow-xl"
          style={{ left: mentionPos.x, top: mentionPos.y }}
        >
          {filteredMentionItems.map((item) => (
            <button key={item.key} className="block w-full rounded px-2 py-1 text-left text-xs text-slate-200 hover:bg-surface-700" onClick={item.action}>
              {item.label}
            </button>
          ))}
        </div>
      )}

      {hoveredToken && (
        <div
          className="fixed z-[72] rounded-md border border-surface-600 bg-surface-800 p-2 shadow-xl"
          style={{ left: hoverPos.x, top: hoverPos.y }}
        >
          <div className="mb-1 text-[11px] text-slate-400">@{hoveredToken.token}</div>
          <div className="flex items-center gap-2">
            {hoveredToken.thumbnail ? (
              <img src={hoveredToken.thumbnail} alt="" className="h-10 w-10 rounded object-cover" />
            ) : (
              <div className="flex h-10 w-10 items-center justify-center rounded bg-surface-950 text-[10px] text-slate-400">{hoveredToken.kind.toUpperCase()}</div>
            )}
            <div>
              <div className="max-w-[180px] truncate text-xs text-slate-100">{hoveredToken.name}</div>
              <div className="text-[11px] text-slate-400">{hoveredToken.kind}</div>
            </div>
          </div>
        </div>
      )}

      {showMediaPicker && (
        <MediaPicker
          assets={assets}
          onClose={() => setShowMediaPicker(false)}
          onPick={(asset) => {
            if (pickerMode === 'start') {
              setStartFrame(asset.kind === 'image' ? asset : null);
              if (asset.kind === 'image') setSourceVideo(null);
            } else if (pickerMode === 'end') {
              setEndFrame(asset.kind === 'image' ? asset : null);
              if (asset.kind === 'image') setSourceVideo(null);
            } else if (pickerMode === 'source-video') {
              const validSource = asset.kind === 'video' && isSourceVideoReferenceValid(selectedModel, asset);
              setSourceVideo(validSource ? asset : null);
              if (validSource) {
                setStartFrame(null);
                setEndFrame(null);
              }
            }
            else addReferenceAsset(asset);
            setShowMediaPicker(false);
          }}
          onImportFromComputer={() => void onImportFromComputer()}
          pickerMode={pickerMode}
          selectedModel={selectedModel}
        />
      )}
    </div>
  );
}

function PromptModeSwatch({
  mode,
  structuredSupported,
  onChange,
}: {
  mode: PromptMode;
  structuredSupported: boolean;
  onChange: (mode: PromptMode) => void;
}) {
  const buttonBase = 'inline-flex h-6 items-center gap-1 rounded px-2.5 text-[11px] font-medium transition';
  return (
    <div className="inline-flex items-center rounded-md border border-surface-700 bg-surface-950 p-0.5">
      <button
        type="button"
        className={`${buttonBase} ${mode === 'freeform' ? 'bg-surface-700 text-slate-100' : 'text-slate-400 hover:bg-surface-800 hover:text-slate-200'}`}
        onClick={() => onChange('freeform')}
      >
        Free
      </button>
      <button
        type="button"
        disabled={!structuredSupported}
        title={structuredSupported ? 'Structured prompt mode' : 'Structured prompts are not available for this model'}
        className={`${buttonBase} ${mode === 'structured' ? 'bg-brand-500 text-white' : 'text-slate-400 hover:bg-surface-800 hover:text-slate-200'} disabled:cursor-not-allowed disabled:opacity-40`}
        onClick={() => onChange('structured')}
      >
        <ListChecks size={12} />
        Structured
      </button>
    </div>
  );
}

function StructuredPromptEditor({
  sections,
  values,
  missingRequired,
  onChange,
}: {
  sections: StructuredPromptSectionDefinition[];
  values: Record<string, string>;
  missingRequired: string[];
  onChange: (sectionId: string, value: string) => void;
}) {
  const missing = new Set(missingRequired);
  return (
    <div className="max-h-[330px] overflow-y-auto p-3">
      <div className="grid gap-2 sm:grid-cols-2">
        {sections.map((section) => {
          const Icon = STRUCTURED_PROMPT_ICON[section.icon];
          const isMissing = missing.has(section.id);
          return (
            <label
              key={section.id}
              className={`rounded-md border bg-surface-950 p-2.5 transition ${isMissing ? 'border-amber-300/55 bg-amber-500/5' : 'border-surface-700 hover:border-surface-500'}`}
            >
              <div className="mb-1.5 flex min-w-0 items-center gap-2">
                <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${isMissing ? 'bg-amber-300/15 text-amber-200' : 'bg-surface-800 text-slate-300'}`}>
                  <Icon size={13} />
                </span>
                <span className="min-w-0 flex-1 truncate text-xs font-semibold text-slate-100">{section.label}</span>
                <span className={`rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${section.optional ? 'bg-surface-800 text-slate-400' : 'bg-emerald-400/15 text-emerald-200'}`}>
                  {section.optional ? 'Optional' : 'Required'}
                </span>
              </div>
              <textarea
                value={values[section.id] ?? ''}
                onChange={(e) => onChange(section.id, e.target.value)}
                placeholder={section.placeholder}
                aria-invalid={isMissing}
                className="h-[58px] w-full resize-none rounded-md border border-surface-700 bg-surface-900 px-2 py-1.5 text-xs text-slate-100 outline-none placeholder:text-slate-600 focus:border-brand-400"
              />
              <div className="mt-1 line-clamp-2 text-[10px] leading-4 text-slate-500">{section.description}</div>
            </label>
          );
        })}
      </div>
    </div>
  );
}

function RecipePicker({
  recipes,
  totalCount,
  query,
  selectedId,
  modelLabelFor,
  onQueryChange,
  onPick,
  onClose,
}: {
  recipes: MediaAsset[];
  totalCount: number;
  query: string;
  selectedId: string | null;
  modelLabelFor: (modelId: string) => string;
  onQueryChange: (value: string) => void;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[75] flex items-center justify-center bg-black/55 p-4">
      <div className="w-[min(820px,94vw)] overflow-hidden rounded-lg border border-white/15 bg-surface-950 shadow-2xl">
        <div className="border-b border-surface-700 p-3">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
              <BookOpen size={15} className="text-brand-300" />
              Recipe library
              <span className="rounded bg-surface-800 px-1.5 py-0.5 text-[10px] font-normal text-slate-400">{totalCount}</span>
            </div>
            <button className="rounded-md p-1 text-slate-400 hover:bg-white/10 hover:text-white" onClick={onClose} title="Close" aria-label="Close">
              <X size={14} />
            </button>
          </div>
          <label className="flex h-9 items-center gap-2 rounded-md border border-surface-700 bg-surface-900 px-3 text-xs text-slate-300 focus-within:border-brand-400">
            <Search size={14} className="text-slate-500" />
            <input
              value={query}
              onChange={(e) => onQueryChange(e.target.value)}
              placeholder="Search recipes by name, prompt, model, or setting"
              className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-slate-500"
              autoFocus
            />
          </label>
        </div>
        <div className="max-h-[430px] overflow-auto p-2">
          <div className="mb-2 flex items-center justify-between px-1 text-[11px] text-slate-500">
            <span>{recipes.length} of {totalCount} recipes</span>
            <span>Recent first</span>
          </div>
          {recipes.length === 0 ? (
            <div className="rounded-md border border-dashed border-surface-700 p-6 text-center text-xs text-slate-500">
              No recipes match this search.
            </div>
          ) : recipes.map((asset) => {
            const recipe = asset.recipe;
            if (!recipe) return null;
            const selected = selectedId === asset.id;
            return (
              <button
                key={asset.id}
                className={`group mb-1 flex w-full items-start gap-3 rounded-md border px-2.5 py-2 text-left transition ${selected ? 'border-brand-400/70 bg-brand-500/15' : 'border-transparent hover:border-surface-700 hover:bg-surface-900/70'}`}
                onClick={() => onPick(asset.id)}
              >
                <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-surface-800 text-slate-300">
                  {selected ? <Check size={15} /> : <BookOpen size={15} />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-sm font-medium text-slate-100">{asset.name}</span>
                    <span className="shrink-0 rounded bg-surface-800 px-1.5 py-0.5 text-[10px] text-slate-400">{recipe.duration}</span>
                    <span className="shrink-0 rounded bg-surface-800 px-1.5 py-0.5 text-[10px] text-slate-400">{recipe.aspect}</span>
                  </div>
                  <div className="mt-0.5 truncate text-[11px] text-slate-400">{recipePreviewText(recipe) || 'No prompt text'}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-slate-500">
                    <span>{modelLabelFor(recipe.model)}</span>
                    <span>{recipe.resolution}</span>
                    {recipe.referenceAssetIds.length > 0 && <span>{recipe.referenceAssetIds.length} refs</span>}
                    {recipe.sourceVideoAssetId && <span>video reference</span>}
                    <span>{formatShortDate(asset.createdAt)}</span>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function PillOptionGroup({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
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
            className={`h-6 rounded px-2.5 text-xs transition ${selected ? 'bg-surface-700 text-slate-100' : 'text-slate-400 hover:bg-surface-800 hover:text-slate-200'}`}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function FrameRefButton({
  label,
  value,
  disabled = false,
  onClick,
  onClear,
}: {
  label: string;
  value: MediaAsset | null;
  disabled?: boolean;
  onClick: () => void;
  onClear: () => void;
}) {
  return (
    <div className={`rounded-md border border-dashed border-surface-700 bg-surface-900/70 p-2 ${disabled ? 'opacity-50' : ''}`}>
      <div className="mb-2 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        <span>{label}</span>
        {value && <button className="font-normal normal-case tracking-normal text-slate-400 hover:text-slate-100" onClick={onClear}>Clear</button>}
      </div>
      <button disabled={disabled} className="flex w-full items-center gap-2 rounded-md border border-surface-700 bg-surface-950 px-2 py-2 text-xs text-slate-100 hover:border-surface-500 hover:bg-surface-800 disabled:cursor-not-allowed" onClick={onClick}>
        {value?.thumbnailDataUrl ? <img src={value.thumbnailDataUrl} alt="" className="h-8 w-8 rounded object-cover" /> : value?.kind === 'video' ? <Film size={14} /> : <ImageIcon size={14} />}
        <span className="truncate">{value ? value.name : 'Choose from media or import'}</span>
      </button>
    </div>
  );
}

function MediaPicker({
  assets,
  onClose,
  onPick,
  onImportFromComputer,
  pickerMode,
  selectedModel,
}: {
  assets: MediaAsset[];
  onClose: () => void;
  onPick: (asset: MediaAsset) => void;
  onImportFromComputer: () => void;
  pickerMode: 'reference' | 'start' | 'end' | 'source-video';
  selectedModel: VideoModelDefinition;
}) {
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<'recent' | 'name' | 'duration'>('recent');
  const visibleAssets = pickerMode === 'reference'
    ? assets.filter((a) => a.kind === 'image')
    : pickerMode === 'source-video'
      ? assets.filter((a) => a.kind === 'video' && isSourceVideoReferenceValid(selectedModel, a))
      : assets.filter((a) => a.kind === 'image');
  const filteredAssets = useMemo(() => {
    const q = query.trim().toLowerCase();
    return [...visibleAssets]
      .filter((asset) => {
        if (!q) return true;
        return [
          asset.name,
          asset.kind,
          asset.mimeType,
          `${asset.width ?? ''}x${asset.height ?? ''}`,
        ].join(' ').toLowerCase().includes(q);
      })
      .sort((a, b) => {
        if (sortKey === 'name') return a.name.localeCompare(b.name);
        if (sortKey === 'duration') return b.durationSec - a.durationSec || a.name.localeCompare(b.name);
        return b.createdAt - a.createdAt || a.name.localeCompare(b.name);
      });
  }, [query, sortKey, visibleAssets]);
  const helperText = pickerMode === 'reference'
    ? 'Choose image references supported by the selected model.'
    : pickerMode === 'source-video'
      ? 'Choose one video reference.'
      : 'Only image assets are valid for frame slots.';
  const title = pickerMode === 'source-video' ? 'Pick video reference' : pickerMode === 'reference' ? 'Pick image references' : 'Pick frame image';
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/55 p-4">
      <div className="w-[min(960px,94vw)] overflow-hidden rounded-lg border border-white/15 bg-surface-950 shadow-2xl">
        <div className="border-b border-surface-700 p-3">
        <div className="mb-2 flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold text-slate-100">{title}</div>
            <div className="text-xs text-slate-400">{helperText}</div>
          </div>
          <button className="rounded p-1 text-slate-400 hover:bg-white/10 hover:text-white" onClick={onClose} title="Close" aria-label="Close"><X size={16} /></button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex h-9 min-w-[260px] flex-1 items-center gap-2 rounded-md border border-surface-700 bg-surface-900 px-3 text-xs text-slate-300 focus-within:border-brand-400">
            <Search size={14} className="text-slate-500" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search media by name, type, or size"
              className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-slate-500"
              autoFocus
            />
          </label>
          <SortPills value={sortKey} onChange={setSortKey} />
          <button className="btn-ghost h-9 px-3 text-xs" onClick={onImportFromComputer}><Upload size={12} /> Import</button>
        </div>
        </div>
        <div className="max-h-[min(640px,70vh)] overflow-auto p-2">
          <div className="mb-2 flex items-center justify-between px-1 text-[11px] text-slate-500">
            <span>{filteredAssets.length} of {visibleAssets.length} matching assets</span>
            <span>{pickerMode === 'source-video' ? 'Video reference' : 'Image input'}</span>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {filteredAssets.map((asset) => (
            <MediaPickerAssetTile key={asset.id} asset={asset} onPick={onPick} />
          ))}
          {filteredAssets.length === 0 && <div className="col-span-full rounded-md border border-dashed border-surface-700 p-6 text-center text-xs text-slate-500">No matching media assets found.</div>}
          </div>
        </div>
      </div>
    </div>
  );
}

function MediaPickerAssetTile({
  asset,
  onPick,
}: {
  asset: MediaAsset;
  onPick: (asset: MediaAsset) => void;
}) {
  const objectUrlFor = useMediaStore((s) => s.objectUrlFor);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [hovered, setHovered] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null);
  const isVideo = asset.kind === 'video';

  useEffect(() => {
    if (asset.kind !== 'image') {
      setImagePreviewUrl(null);
      return;
    }

    let active = true;
    setImagePreviewUrl(null);
    void objectUrlFor(asset.id).then((url) => {
      if (active) setImagePreviewUrl(url);
    });

    return () => {
      active = false;
    };
  }, [asset.id, asset.kind, objectUrlFor]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !hovered || !previewUrl) return;
    try { video.currentTime = 0; } catch { /* metadata may not be ready yet */ }
    void video.play().catch(() => undefined);
  }, [hovered, previewUrl]);

  const startPreview = () => {
    if (!isVideo) return;
    setHovered(true);
    if (!previewUrl) {
      void objectUrlFor(asset.id).then((url) => {
        if (url) setPreviewUrl(url);
      });
    }
  };

  const stopPreview = () => {
    setHovered(false);
    const video = videoRef.current;
    if (!video) return;
    video.pause();
    try { video.currentTime = 0; } catch { /* noop */ }
  };

  const badge = mediaAssetBadgeLabel(asset).toUpperCase();
  return (
    <button
      type="button"
      className="group relative aspect-square min-w-0 overflow-hidden rounded-md border border-surface-700 bg-black text-left transition hover:border-brand-300/70 hover:shadow-[0_0_0_1px_rgba(124,140,255,0.35)] focus-visible:border-brand-300 focus-visible:outline-none"
      onClick={() => onPick(asset)}
      onMouseEnter={startPreview}
      onMouseLeave={stopPreview}
      onFocus={startPreview}
      onBlur={stopPreview}
      title={asset.name}
    >
      {isVideo && hovered && previewUrl ? (
        <video
          ref={videoRef}
          src={previewUrl}
          poster={asset.thumbnailDataUrl}
          muted
          loop
          playsInline
          preload="metadata"
          className="absolute inset-0 h-full w-full object-cover"
        />
      ) : imagePreviewUrl || asset.thumbnailDataUrl ? (
        <img
          src={imagePreviewUrl ?? asset.thumbnailDataUrl}
          alt=""
          className="absolute inset-0 h-full w-full object-cover transition duration-200 group-hover:scale-[1.015]"
          draggable={false}
          loading="lazy"
          decoding="async"
        />
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-surface-950 text-slate-500">
          {isVideo ? <Film size={26} /> : <ImageIcon size={26} />}
          <span className="text-[11px] uppercase tracking-[0.18em]">{asset.kind}</span>
        </div>
      )}
      <div className="absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-black/85 via-black/30 to-transparent" />
      <span className="absolute right-2 top-2 rounded-sm bg-black/70 px-1.5 py-1 text-[10px] font-semibold leading-none tracking-[0.12em] text-white shadow-sm">
        {badge}
      </span>
      {isVideo && asset.durationSec > 0 && (
        <span className="absolute left-2 top-2 rounded-sm bg-black/70 px-1.5 py-1 text-[10px] font-medium leading-none text-white shadow-sm">
          {asset.durationSec.toFixed(1)}s
        </span>
      )}
      <div className="absolute bottom-2 left-2 right-2">
        <div className="inline-flex max-w-full rounded-sm bg-black/75 px-2 py-1 text-[11px] font-medium leading-tight text-white shadow-sm ring-1 ring-white/10">
          <span className="truncate">{asset.name}</span>
        </div>
      </div>
    </button>
  );
}

function SortPills({
  value,
  onChange,
}: {
  value: 'recent' | 'name' | 'duration';
  onChange: (value: 'recent' | 'name' | 'duration') => void;
}) {
  const options: Array<{ value: 'recent' | 'name' | 'duration'; label: string }> = [
    { value: 'recent', label: 'Recent' },
    { value: 'name', label: 'Name' },
    { value: 'duration', label: 'Length' },
  ];
  return (
    <div className="inline-flex h-9 items-center gap-1 rounded-md border border-surface-700 bg-surface-950 px-1">
      {options.map((option) => (
        <button
          key={option.value}
          className={`h-7 rounded px-2.5 text-xs ${value === option.value ? 'bg-surface-700 text-slate-100' : 'text-slate-400 hover:bg-surface-800 hover:text-slate-200'}`}
          onClick={() => onChange(option.value)}
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function recipePreviewText(recipe: GenerateRecipe): string {
  if (recipe.promptMode !== 'structured') return recipe.prompt;
  const values = recipe.structuredPrompt ?? {};
  return Object.values(values)
    .map((value) => value.trim())
    .filter(Boolean)
    .join(' / ');
}

function formatShortDate(timestamp: number) {
  if (!timestamp) return '';
  return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function mediaAssetBadgeLabel(asset: MediaAsset): string {
  const trimmed = asset.name.trim();
  const lastDot = trimmed.lastIndexOf('.');
  if (lastDot > 0 && lastDot < trimmed.length - 1) return trimmed.slice(lastDot + 1);
  const subtype = asset.mimeType.split('/')[1]?.split(';')[0];
  if (!subtype) return asset.kind;
  if (subtype === 'jpeg') return 'jpg';
  if (subtype === 'mpeg') return 'mp3';
  return subtype;
}

function isSourceVideoReferenceValid(model: VideoModelDefinition, asset: MediaAsset): boolean {
  if (asset.kind !== 'video') return false;
  if (isPiApiSeedanceModel(model)) return asset.durationSec <= 15.4;
  return isPiApiKlingModel(model);
}

function isAudioLockedOnModel(model: VideoModelDefinition): boolean {
  return isPiApiSeedanceModel(model);
}

function providerNameForModel(model: VideoModelDefinition): string {
  if (isPiApiKlingModel(model) || isPiApiSeedanceModel(model) || isPiApiVeoModel(model)) return 'PiAPI';
  return 'this provider';
}

function readVideoProviderCredentialAvailability(): VideoProviderCredentialAvailability {
  return {
    piapi: Boolean(
      localStorage.getItem(PIAPI_API_KEY_STORAGE) ||
      localStorage.getItem(PIAPI_VEO_API_KEY_STORAGE) ||
      localStorage.getItem(PIAPI_KLING_API_KEY_STORAGE),
    ),
  };
}

function hasVideoProviderCredentials(
  model: VideoModelDefinition,
  availability: VideoProviderCredentialAvailability = readVideoProviderCredentialAvailability(),
): boolean {
  if (isPiApiKlingModel(model) || isPiApiSeedanceModel(model) || isPiApiVeoModel(model)) return availability.piapi;
  return false;
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

function estimatePiApiCostUsd(
  model: VideoModelDefinition,
  resolution: string,
  seconds: number,
  audioEnabled: boolean,
): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  let rate = 0;
  if (isPiApiKlingModel(model)) {
    rate = resolution === '1080p'
      ? (audioEnabled ? 0.2 : 0.15)
      : (audioEnabled ? 0.15 : 0.1);
  } else if (isPiApiVeoModel(model)) {
    const fast = model.id.toLowerCase().includes('fast');
    rate = fast
      ? (audioEnabled ? 0.09 : 0.06)
      : (audioEnabled ? 0.24 : 0.12);
  } else if (isPiApiSeedanceModel(model)) {
    const fast = model.id.toLowerCase().includes('fast');
    if (fast) rate = resolution === '720p' ? 0.16 : 0.08;
    else if (resolution === '1080p') rate = 0.5;
    else if (resolution === '720p') rate = 0.2;
    else rate = 0.1;
  }
  return rate > 0 ? Number((rate * seconds).toFixed(2)) : 0;
}

function formatGenerationError(err: unknown): string {
  if (err instanceof VideoGenerationProviderError) {
    const label = {
      NSFW: 'NSFW',
      GuidelinesViolation: 'Guidelines violation',
      Billing: 'Billing issue',
      InternalError: 'Internal error',
    }[err.type];
    return `${label}: ${err.message}`;
  }
  return err instanceof Error ? err.message : 'Generation failed.';
}

function generationErrorType(err: unknown): GenerationErrorType {
  return err instanceof VideoGenerationProviderError ? err.type : 'InternalError';
}
