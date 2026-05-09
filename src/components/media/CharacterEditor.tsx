import { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Check, Copy, Image as ImageIcon, Mountain, Save, Sparkles, Upload, UserRound, X, type LucideIcon } from 'lucide-react';
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
import { hostLitterboxReferences } from '@/lib/videoGeneration/litterbox';
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
    sheetTemplate: 'Create a single coherent environment reference board. Arrange four evenly spaced panels from left to right: wide establishing view, key area detail, alternate angle, and lighting/material palette. Keep the architecture, terrain, props, color palette, era, atmosphere, and production design consistent across every panel. Do not add characters unless explicitly requested.',
  },
};
const CHARACTER_STYLE_OPTIONS: Array<{ value: CharacterVisualStyle; label: string; prompt: string }> = [
  { value: 'real-life', label: 'Real-life', prompt: 'Use a real-life photographic style with natural materials, believable surface detail, and practical lighting.' },
  { value: 'anime', label: 'Anime', prompt: 'Use a polished anime production design style with clean linework, expressive proportions, and clear shapes.' },
  { value: '3d', label: '3D', prompt: 'Use a high-quality stylized 3D design style with smooth modeled forms and studio-rendered materials.' },
  { value: 'lego', label: 'Lego', prompt: 'Use a Lego-inspired toy design style with plastic materials, simplified block construction, and readable shapes.' },
];

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
  const [working, setWorking] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const loadedAssetIdRef = useRef<string | null>(null);

  const selectedModel = imageModelById(form.model) ?? defaultImageModel();
  const estimatedCostUsd = estimateImageCostUsd(selectedModel);
  const isCreate = !assetId;
  const promptForGeneration = form.description.trim();
  const providerPrompt = buildReferenceImagePrompt(promptForGeneration, form.style, effectiveKind);
  const canGenerate = Boolean(promptForGeneration) && !working;
  const referenceAssets = useMemo(() => referenceAssetIds
    .map((id) => assets.find((candidate) => candidate.id === id))
    .filter((candidate): candidate is MediaAsset => Boolean(candidate && candidate.kind === 'image' && isReferenceImageAsset(candidate))), [assets, referenceAssetIds]);

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
    setReferenceAssetIds(reference?.sourceImageAssetIds ?? []);
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
    sourceImageAssetIds: referenceAssets.map((reference) => reference.id),
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

  const importReferenceImages = async () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = true;
    input.onchange = async () => {
      const files = Array.from(input.files ?? []);
      if (!files.length) return;
      try {
        const imported = await importFiles(files, asset?.folderId ?? folderId);
        const imageIds = imported.filter((candidate) => candidate.kind === 'image' && candidate.blobKey).map((candidate) => candidate.id);
        if (!imageIds.length) return;
        setReferenceAssetIds((current) => uniqueIds([...current, ...imageIds]));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed importing reference images.');
      }
    };
    input.click();
  };

  const removeReferenceImage = (assetIdToRemove: string) => {
    setReferenceAssetIds((current) => current.filter((id) => id !== assetIdToRemove));
  };

  const attachReferenceImage = (reference: MediaAsset) => {
    if (reference.kind !== 'image' || !isReferenceImageAsset(reference)) return;
    setReferenceAssetIds((current) => uniqueIds([...current, reference.id]));
    setReferencePickerOpen(false);
  };

  const copyToken = async () => {
    if (!token) return;
    await navigator.clipboard?.writeText(token).catch(() => undefined);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  const generate = async () => {
    if (!canGenerate) return;
    const apiKey = await readPiApiKey();
    if (!apiKey) {
      setError(`Connect PiAPI in Settings before generating ${config.labelPlural}.`);
      return;
    }
    setWorking(true);
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

  const regenerateCharacter = async (characterAsset: MediaAsset, apiKey: string) => {
    try {
      const referenceInput = await buildReferenceInput(uniqueAssetReferences([characterAsset, ...referenceAssets]), selectedModel, objectUrlFor);
      const generated = await generatePiApiImage({
        model: selectedModel,
        prompt: providerPrompt,
        aspectRatio: CHARACTER_IMAGE_ASPECT_RATIO,
        resolution: CHARACTER_IMAGE_RESOLUTION,
        outputFormat: selectedModel.capabilities.defaultOutputFormat,
        referenceUrls: referenceInput.referenceUrls,
        referenceFiles: referenceInput.referenceFiles,
        onProgress: setProgress,
      }, { apiKey });
      const file = await downloadGeneratedImageFile(generated.url, setProgress);
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
      setError(formatGenerationError(err));
    } finally {
      setWorking(false);
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
              <div className="flex h-full items-center justify-center overflow-hidden rounded-md border border-white/10 bg-[radial-gradient(circle_at_center,rgba(255,255,255,0.08)_1px,transparent_1px)] [background-size:18px_18px]">
                {sourceUrl ? (
                  <img src={sourceUrl} alt={form.name} draggable={false} className="max-h-full max-w-full select-none object-contain" />
                ) : (
                  <div className="flex flex-col items-center gap-3 text-slate-500">
                    <Icon size={44} />
                    <div className="text-sm">{isCreate ? config.emptyPreviewText : `${config.label} image loading…`}</div>
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
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Reference Images</div>
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
                                <ImageIcon size={18} />
                              </div>
                            )}
                          </div>
                          <button
                            type="button"
                            className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded bg-black/70 text-slate-200 opacity-0 transition hover:bg-red-500 hover:text-white group-hover:opacity-100 focus-visible:opacity-100"
                            onClick={() => removeReferenceImage(reference.id)}
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
                      No reference images
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
                {error && (
                  <div className="rounded-md border border-rose-300/30 bg-rose-500/10 px-2.5 py-2 text-xs text-rose-200">
                    {error}
                    {error.includes('PiAPI') && (
                      <button type="button" className="ml-2 underline" onClick={onOpenSettings}>Settings</button>
                    )}
                  </div>
                )}
                {working && (
                  <progress className="export-progress" value={Math.max(4, Math.min(100, progress))} max={100} aria-label={`${config.label} generation progress`} />
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
          title="Pick Reference Images"
          helperText={`Choose existing image assets or import new images for this ${config.label.toLowerCase()}.`}
          importLabel="Import Images"
          zIndexClassName="z-[120]"
          onPick={attachReferenceImage}
          onImportFromComputer={() => void importReferenceImages()}
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
  if (isGptImageModel(model)) {
    const referenceFiles = await Promise.all(assets.map((asset) => referenceFileForAsset(asset, objectUrlFor)));
    return { referenceFiles: referenceFiles.filter((file): file is File => Boolean(file)) };
  }
  return { referenceUrls: await hostLitterboxReferences(assets, 'Reference image') };
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
