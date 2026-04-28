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
  UserRound,
  X,
  Zap,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import {
  CONNECTION_SETTINGS_CHANGED_EVENT,
  PIAPI_API_KEY_STORAGE,
  PIAPI_KLING_API_KEY_STORAGE,
  PIAPI_VEO_API_KEY_STORAGE,
} from '@/lib/settings/connectionStorage';
import { decryptSecret } from '@/lib/settings/crypto';
import { composeSequencePrompt, sequenceReferenceAssetIds, sortedSequenceMarkers } from '@/lib/media/sequence';
import { characterTokenForAsset, isReferenceImageAsset, resolveCharacterReferences } from '@/lib/media/characterReferences';
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
import { MediaPicker } from './MediaPicker';
import { ReferencePromptEditor, type ReferencePromptEditorHandle, type ReferencePromptMention, type ReferencePromptTokenMeta } from './ReferencePromptEditor';

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
  kind: 'image' | 'character' | 'video' | 'audio';
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
  const editorRef = useRef<ReferencePromptEditorHandle | null>(null);
  const mentionMenuRef = useRef<HTMLDivElement | null>(null);
  const hoverCardRef = useRef<HTMLDivElement | null>(null);
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
  const promptCharacterReferences = useMemo(() => resolveCharacterReferences(activePrompt, assets), [activePrompt, assets]);
  const explicitReferenceAssets = useMemo(() => references
    .map((ref) => assets.find((asset) => asset.id === ref.assetId))
    .filter((asset): asset is MediaAsset => asset !== undefined)
    .filter(isReferenceImageAsset), [assets, references]);
  const referenceImageAssets = useMemo(() => {
    const frameAssetIds = new Set([startFrame?.id, endFrame?.id].filter((id): id is string => Boolean(id)));
    return uniqueReferenceAssets([...explicitReferenceAssets, ...promptCharacterReferences])
      .filter((asset) => !frameAssetIds.has(asset.id));
  }, [endFrame?.id, explicitReferenceAssets, promptCharacterReferences, startFrame?.id]);
  const activeReferenceCount = referenceImageAssets.length;
  const referencesIgnoredByFrameMode = Boolean(isVeoModel(selectedModel) && (startFrame || endFrame) && activeReferenceCount > 0);
  const referencesIgnoredByVideoMode = Boolean(isVeoModel(selectedModel) && sourceVideo && activeReferenceCount > 0);
  const generateDisabled = isGenerating ||
    !providerCredentialsAvailable ||
    (promptMode === 'structured' ? missingStructuredRequired.length > 0 || !activePrompt.trim() : !prompt.trim());
  const estimatedCostUsd = useMemo(() => {
    const seconds = Number(duration.replace('s', ''));
    return estimatePiApiCostUsd(selectedModel, resolution, seconds, audioEnabled);
  }, [audioEnabled, duration, resolution, selectedModel]);
  const baseImageReferenceLimit = sourceVideo
    ? isKlingModel(selectedModel)
      ? Math.min(selectedModel.capabilities.assetInputs.imageReferencesMax, 4)
      : isPiApiSeedanceModel(selectedModel)
        ? Math.max(0, selectedModel.capabilities.assetInputs.imageReferencesMax - 1)
        : selectedModel.capabilities.assetInputs.imageReferencesMax
    : selectedModel.capabilities.assetInputs.imageReferencesMax;
  const frameImageReferenceCount = isPiApiSeedanceModel(selectedModel) && !sourceVideo
    ? Number(Boolean(startFrame)) + Number(Boolean(endFrame))
    : 0;
  const imageReferenceLimit = Math.max(0, baseImageReferenceLimit - frameImageReferenceCount);
  const sourceVideoSupported = selectedModel.capabilities.assetInputs.videoExtension;
  const frameInputsSupported = selectedModel.capabilities.assetInputs.startFrame;
  const constrainedByEightSecondGeneration = Boolean(
    isPiApiVeoModel(selectedModel) && activeReferenceCount > 0,
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
  const shouldSendImageReferences = isReferencesFeatureSupported(selectedModel) &&
    !(isVeoModel(selectedModel) && (startFrame || endFrame)) &&
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

  useLayoutEffect(() => {
    const menu = mentionMenuRef.current;
    if (!mentionOpen || !menu) return;
    menu.style.left = `${mentionPos.x}px`;
    menu.style.top = `${mentionPos.y}px`;
  }, [mentionOpen, mentionPos]);

  useLayoutEffect(() => {
    const card = hoverCardRef.current;
    if (!hoveredToken || !card) return;
    card.style.left = `${hoverPos.x}px`;
    card.style.top = `${hoverPos.y}px`;
  }, [hoverPos, hoveredToken]);

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
    const selectedRefAssets = recipe.referenceAssetIds
      .map((assetId) => assets.find((a) => a.id === assetId))
      .filter((a): a is MediaAsset => Boolean(a))
      .filter(isReferenceImageAsset);
    setReferences(referenceTokensForAssets(selectedRefAssets, `recipe-${initialRecipeAsset.id}-${Date.now()}`));
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
    const imageAssetIds = new Set(assets.filter(isReferenceImageAsset).map((asset) => asset.id));
    const characterTokensByAssetId = new Map(assets
      .filter((asset) => asset.kind === 'character' && asset.character?.characterId)
      .map((asset) => [asset.id, asset.character!.characterId]));
    const sequenceModel = models.find((candidate) => candidate.id === sequence.model) ?? DEFAULT_VIDEO_MODELS.find((candidate) => candidate.id === sequence.model);
    const sequenceStartFrame = sequenceModel?.capabilities.assetInputs.startFrame
      ? startFrameAssetForSequence(sequence, assets)
      : null;
    const frameReferenceSlots = sequenceStartFrame && sequenceModel && isPiApiSeedanceModel(sequenceModel) ? 1 : 0;
    const maxImages = Math.max(0, (sequenceModel?.capabilities.assetInputs.imageReferencesMax ?? 12) - frameReferenceSlots);
    const sequenceReferenceOptions = {
      availableImageAssetIds: imageAssetIds,
      characterTokensByAssetId,
      maxImages,
      startFrameAssetId: sequenceStartFrame?.id ?? null,
    };
    const referenceAssetIds = sequenceReferenceAssetIds(sequence, sequenceReferenceOptions);
    setLoadedRecipeId(null);
    setRecipePickerOpen(false);
    setRecipeQuery('');
    setModel(sequence.model);
    setPrompt(composeSequencePrompt(sequence, sequenceReferenceOptions));
    setPromptMode('freeform');
    setStructuredPrompt({});
    setDuration(durationOptionForSeconds(sequence.durationSec, sequenceModel));
    setAudioEnabled(true);
    setStartFrame(sequenceStartFrame);
    setEndFrame(null);
    setSourceVideo(null);
    const sequenceRefAssets = referenceAssetIds
      .map((assetId) => assets.find((asset) => asset.id === assetId && isReferenceImageAsset(asset)))
      .filter((asset): asset is MediaAsset => Boolean(asset));
    setReferences(referenceTokensForAssets(sequenceRefAssets, `sequence-${initialSequenceAsset.id}`));
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
    ...assets
      .filter((asset) => asset.kind === 'character' && asset.character?.characterId && asset.generation?.status !== 'generating')
      .map((asset) => {
        const token = characterTokenForAsset(asset) ?? '';
        return { key: asset.id, label: token, action: () => insertToken(token) };
      }),
  ];

  const filteredMentionItems = mentionQuery.trim()
    ? allMentionItems.filter((item) => item.label.toLowerCase().includes(mentionQuery.toLowerCase()))
    : allMentionItems;

  const referenceMap = useMemo(() => {
    const out = new Map<string, RefToken | 'start' | 'end'>();
    for (const ref of references) out.set(ref.token.toLowerCase(), ref);
    for (const asset of assets) {
      if (asset.kind !== 'character' || !asset.character?.characterId || asset.generation?.status === 'generating') continue;
      out.set(asset.character.characterId.toLowerCase(), {
        id: asset.id,
        token: asset.character.characterId,
        assetId: asset.id,
        name: asset.name,
        kind: 'character',
        thumbnail: asset.thumbnailDataUrl,
      });
    }
    if (sourceVideoToken) out.set(sourceVideoToken.token.toLowerCase(), sourceVideoToken);
    if (startFrame) out.set('start-frame', 'start');
    if (endFrame) out.set('end-frame', 'end');
    return out;
  }, [assets, references, sourceVideoToken, startFrame, endFrame]);

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

  const referenceTokenMeta = (token: string): ReferencePromptTokenMeta => {
    const meta = referenceMap.get(token.toLowerCase());
    if (!meta) return { valid: false, title: 'Reference is not selected or available.' };
    if (meta === 'start') return { valid: true, title: 'Start frame' };
    if (meta === 'end') return { valid: true, title: 'End frame' };
    return { valid: true, title: meta.name };
  };

  const showTokenHover = (token: string, event: ReactMouseEvent<HTMLElement>) => {
    const meta = referenceMap.get(token.toLowerCase());
    if (!meta || typeof meta === 'string') return;
    setHoveredToken(meta);
    setHoverPos({ x: event.clientX + 12, y: event.clientY + 12 });
  };

  const moveTokenHover = (_token: string, event: ReactMouseEvent<HTMLElement>) => {
    if (hoveredToken) setHoverPos({ x: event.clientX + 12, y: event.clientY + 12 });
  };

  const handlePromptMentionChange = (mention: ReferencePromptMention | null) => {
    if (!mention) {
      setMentionOpen(false);
      setMentionQuery('');
      setMentionRange(null);
      return;
    }
    setMentionQuery(mention.query);
    setMentionRange({ start: mention.start, end: mention.end });
    setMentionPos({ x: mention.left, y: mention.top });
    setMentionOpen(true);
  };

  function buildToken(kind: RefToken['kind'], index: number) {
    return `${kind}${index + 1}`;
  }

  function addReferenceAsset(asset: MediaAsset) {
    if (!isReferenceImageAsset(asset)) return;
    if (imageReferenceLimit <= 0) return;
    if (asset.id === startFrame?.id || asset.id === endFrame?.id) return;
    if (references.some((ref) => ref.assetId === asset.id)) return;
    if (references.length >= imageReferenceLimit) return;
    const kind = asset.kind as RefToken['kind'];
    const countForKind = references.filter((r) => r.kind === kind).length;
    const token = asset.kind === 'character'
      ? asset.character?.characterId ?? buildToken(kind, countForKind)
      : buildToken(kind, countForKind);
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
    const editor = editorRef.current;
    if (!editor) {
      setPrompt((prev) => `${prev} ${token}`.trim());
      return;
    }
    const selection = editor.getSelectionRange();
    const start = mentionRange?.start ?? selection.start;
    const end = mentionRange?.end ?? selection.end;
    const next = `${prompt.slice(0, start)}${token} ${prompt.slice(end)}`;
    setPrompt(next);
    requestAnimationFrame(() => {
      editor.focus();
      const pos = start + token.length + 1;
      editor.setSelectionRange(pos, pos);
    });
    setMentionOpen(false);
    setMentionQuery('');
    setMentionRange(null);
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
      if (import.meta.env.DEV) {
        console.debug('[GenEdit] PiAPI request', {
          model: request.body.model,
          task_type: request.body.task_type,
          input: request.body.input,
        });
      }
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
      referenceAssetIds: uniqueReferenceAssetIds(references.map((r) => r.assetId)),
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
    const selectedRefAssets = recipe.referenceAssetIds
      .map((assetId) => assets.find((a) => a.id === assetId))
      .filter((a): a is MediaAsset => Boolean(a))
      .filter(isReferenceImageAsset);
    setReferences(referenceTokensForAssets(selectedRefAssets, `recipe-${asset.id}-${Date.now()}`));
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
                tokenMeta={referenceTokenMeta}
                onTokenMouseEnter={showTokenHover}
                onTokenMouseMove={moveTokenHover}
                onTokenMouseLeave={() => setHoveredToken(null)}
              />
            ) : (
              <ReferencePromptEditor
                ref={editorRef}
                value={prompt}
                onChange={setPrompt}
                onMentionChange={handlePromptMentionChange}
                tokenMeta={referenceTokenMeta}
                onTokenMouseEnter={showTokenHover}
                onTokenMouseMove={moveTokenHover}
                onTokenMouseLeave={() => setHoveredToken(null)}
                placeholder="Describe your video. Type @ to insert @start-frame, @end-frame, or @image1 references."
                className="min-h-32 max-h-52 w-full overflow-y-auto rounded-md bg-transparent px-3 py-3 text-sm leading-6 text-slate-100 outline-none"
              />
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
                  : 'References are sent as image inputs.'}
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
          ref={mentionMenuRef}
          className="fixed z-[60] w-52 rounded-md border border-surface-600 bg-surface-800 p-1 shadow-xl"
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
          ref={hoverCardRef}
          className="fixed z-[72] rounded-md border border-surface-600 bg-surface-800 p-2 shadow-xl"
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
  tokenMeta,
  onTokenMouseEnter,
  onTokenMouseMove,
  onTokenMouseLeave,
}: {
  sections: StructuredPromptSectionDefinition[];
  values: Record<string, string>;
  missingRequired: string[];
  onChange: (sectionId: string, value: string) => void;
  tokenMeta: (token: string) => ReferencePromptTokenMeta;
  onTokenMouseEnter: (token: string, event: ReactMouseEvent<HTMLElement>) => void;
  onTokenMouseMove: (token: string, event: ReactMouseEvent<HTMLElement>) => void;
  onTokenMouseLeave: () => void;
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
              <ReferencePromptEditor
                value={values[section.id] ?? ''}
                onChange={(value) => onChange(section.id, value)}
                placeholder={section.placeholder}
                tokenMeta={tokenMeta}
                onTokenMouseEnter={onTokenMouseEnter}
                onTokenMouseMove={onTokenMouseMove}
                onTokenMouseLeave={onTokenMouseLeave}
                className="min-h-[58px] w-full rounded-md border border-surface-700 bg-surface-900 px-2 py-1.5 text-xs leading-5 text-slate-100 outline-none focus:border-brand-400"
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

function referenceTokenForAsset(asset: MediaAsset, index: number): string {
  if (asset.kind === 'character' && asset.character?.characterId) return asset.character.characterId;
  return `image${index + 1}`;
}

function startFrameAssetForSequence(sequence: NonNullable<MediaAsset['sequence']>, assets: MediaAsset[]): MediaAsset | null {
  const startMarker = sortedSequenceMarkers(sequence).find((marker) => marker.imageAssetId && Math.abs(marker.timeSec) < 0.001);
  if (!startMarker?.imageAssetId) return null;
  return assets.find((asset) => asset.id === startMarker.imageAssetId && isReferenceImageAsset(asset)) ?? null;
}

function referenceTokensForAssets(assets: MediaAsset[], idPrefix: string): RefToken[] {
  const countsByKind = new Map<RefToken['kind'], number>();
  return uniqueReferenceAssets(assets).map((asset, index) => {
    const kind = asset.kind as RefToken['kind'];
    const countForKind = countsByKind.get(kind) ?? 0;
    countsByKind.set(kind, countForKind + 1);
    return {
      id: `${idPrefix}-${asset.id}-${index}`,
      token: referenceTokenForAsset(asset, countForKind),
      assetId: asset.id,
      name: asset.name,
      kind,
      thumbnail: asset.thumbnailDataUrl,
    };
  });
}

function durationOptionForSeconds(seconds: number, model: VideoModelDefinition | undefined): string {
  const roundedSeconds = Math.round(seconds);
  const duration = Number.isFinite(roundedSeconds) ? `${roundedSeconds}s` : null;
  if (!model) return duration ?? '4s';
  if (duration && model.capabilities.durations.includes(duration)) return duration;
  return model.capabilities.durations[0] ?? '4s';
}

function uniqueReferenceAssetIds(assetIds: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const assetId of assetIds) {
    if (seen.has(assetId)) continue;
    seen.add(assetId);
    out.push(assetId);
  }
  return out;
}

function uniqueReferenceAssets(assets: MediaAsset[]): MediaAsset[] {
  const seen = new Set<string>();
  const out: MediaAsset[] = [];
  for (const asset of assets) {
    if (seen.has(asset.id)) continue;
    seen.add(asset.id);
    out.push(asset);
  }
  return out;
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
