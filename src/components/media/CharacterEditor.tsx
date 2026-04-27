import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Copy, Image as ImageIcon, Save, Sparkles, UserRound, X } from 'lucide-react';
import {
  CHARACTER_IMAGE_ASPECT_RATIO,
  CHARACTER_IMAGE_RESOLUTION,
  DEFAULT_IMAGE_MODELS,
  defaultImageModel,
  estimateImageCostUsd,
  imageModelById,
  sortImageModelsByPriority,
  type ImageModelDefinition,
  type ImageModelProvider,
} from '@/lib/imageModels/capabilities';
import { downloadGeneratedImageFile } from '@/lib/imageGeneration/download';
import { generatePiApiImage, isGptImageModel } from '@/lib/imageGeneration/piapi';
import { characterTokenForAsset, slugifyCharacterId, uniqueCharacterId } from '@/lib/media/characterReferences';
import { hostLitterboxReference } from '@/lib/videoGeneration/litterbox';
import { VideoGenerationProviderError } from '@/lib/videoGeneration/errors';
import {
  CONNECTION_SETTINGS_CHANGED_EVENT,
  PIAPI_API_KEY_STORAGE,
  PIAPI_KLING_API_KEY_STORAGE,
  PIAPI_VEO_API_KEY_STORAGE,
} from '@/lib/settings/connectionStorage';
import { decryptSecret } from '@/lib/settings/crypto';
import { useMediaStore } from '@/state/mediaStore';
import type { CharacterAssetData, CharacterVisualStyle, EditTrailIteration, MediaAsset } from '@/types';
import gptImageLogo from '@/assets/model-logos/gpt-image-logo.png';
import nanoBananaLogo from '@/assets/model-logos/nano-banana-logo.png';

type Props = {
  assetId: string | null;
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
const CHARACTER_SHEET_TEMPLATE = 'Create a single full-body character turnaround reference sheet. Arrange four evenly spaced views of the same character from left to right: front view, left side view, right side view, back view. Keep the face, body proportions, clothing, hairstyle, colors, and accessories consistent in every view. Use neutral studio lighting with no background.';
const CHARACTER_STYLE_OPTIONS: Array<{ value: CharacterVisualStyle; label: string; prompt: string }> = [
  { value: 'real-life', label: 'Real-life', prompt: 'Use a real-life photographic style with natural human materials and believable fabric detail.' },
  { value: 'anime', label: 'Anime', prompt: 'Use a polished anime character design style with clean linework and expressive proportions.' },
  { value: '3d', label: '3D', prompt: 'Use a high-quality stylized 3D character design style with smooth modeled forms and studio-rendered materials.' },
  { value: 'lego', label: 'Lego', prompt: 'Use a Lego minifigure inspired character design style with toy-like plastic materials and simplified block construction.' },
];

export function CharacterEditor({ assetId, folderId = null, onClose, onOpenSettings, onGenerationQueued }: Props) {
  const assets = useMediaStore((state) => state.assets);
  const asset = useMemo(
    () => (assetId ? assets.find((candidate) => candidate.id === assetId && candidate.kind === 'character') ?? null : null),
    [assetId, assets],
  );
  const addGeneratedAsset = useMediaStore((state) => state.addGeneratedAsset);
  const updateGenerationProgress = useMediaStore((state) => state.updateGenerationProgress);
  const updateGenerationTask = useMediaStore((state) => state.updateGenerationTask);
  const finalizeGeneratedAssetWithBlob = useMediaStore((state) => state.finalizeGeneratedAssetWithBlob);
  const failGeneratedAsset = useMediaStore((state) => state.failGeneratedAsset);
  const addGeneratedEditTrailIteration = useMediaStore((state) => state.addGeneratedEditTrailIteration);
  const ensureEditTrail = useMediaStore((state) => state.ensureEditTrail);
  const setActiveEditTrailIteration = useMediaStore((state) => state.setActiveEditTrailIteration);
  const updateCharacterAsset = useMediaStore((state) => state.updateCharacterAsset);
  const renameAsset = useMediaStore((state) => state.renameAsset);
  const objectUrlFor = useMediaStore((state) => state.objectUrlFor);
  const [form, setForm] = useState<CharacterForm>(() => defaultCharacterForm(assets));
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
  const providerPrompt = buildCharacterImagePrompt(promptForGeneration, form.style);
  const canGenerate = Boolean(promptForGeneration) && !working;

  useEffect(() => {
    if (!asset || asset.generation?.status === 'generating') return;
    ensureEditTrail(asset.id);
  }, [asset, ensureEditTrail]);

  useEffect(() => {
    if (!assetId) {
      if (loadedAssetIdRef.current !== null) {
        loadedAssetIdRef.current = null;
        setForm(defaultCharacterForm(assets));
        setSlugTouched(false);
      }
      return;
    }
    if (!asset || loadedAssetIdRef.current === asset.id) return;
    loadedAssetIdRef.current = asset.id;
    const nextModel = imageModelById(asset.character?.model ?? '') ?? defaultImageModel();
    setForm({
      name: asset.name,
      characterId: asset.character?.characterId ?? uniqueCharacterId(asset.name, assets, asset.id),
      description: asset.character?.description ?? asset.character?.prompt ?? '',
      style: asset.character?.style ?? 'real-life',
      model: nextModel.id,
      aspectRatio: CHARACTER_IMAGE_ASPECT_RATIO,
      resolution: CHARACTER_IMAGE_RESOLUTION,
    });
    setSlugTouched(false);
  }, [asset, assetId, assets]);

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
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  useEffect(() => {
    const onConnectionsChanged = () => setError(null);
    window.addEventListener(CONNECTION_SETTINGS_CHANGED_EVENT, onConnectionsChanged);
    return () => window.removeEventListener(CONNECTION_SETTINGS_CHANGED_EVENT, onConnectionsChanged);
  }, []);

  if (assetId && !asset) return null;

  const iterations = [...(asset?.editTrail?.iterations ?? [])].sort((a, b) => b.createdAt - a.createdAt);
  const activeIteration = asset?.editTrail?.iterations.find((iteration) => iteration.id === asset.editTrail?.activeIterationId) ?? null;
  const token = asset ? characterTokenForAsset(asset) : `@${form.characterId}`;

  const updateName = (name: string) => {
    setForm((current) => ({
      ...current,
      name,
      characterId: slugTouched ? current.characterId : uniqueCharacterId(name, assets, asset?.id),
    }));
  };

  const saveDetails = () => {
    if (!asset) return;
    const characterId = uniqueCharacterId(form.characterId, assets, asset.id);
    const name = form.name.trim() || characterId;
    renameAsset(asset.id, name);
    updateCharacterAsset(asset.id, {
      characterId,
      description: form.description.trim(),
      prompt: promptForGeneration,
      generatedPrompt: providerPrompt,
      style: form.style,
      model: selectedModel.id,
      aspectRatio: CHARACTER_IMAGE_ASPECT_RATIO,
      resolution: CHARACTER_IMAGE_RESOLUTION,
    });
    setForm((current) => ({ ...current, name, characterId }));
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
      setError('Connect PiAPI in Settings before generating characters.');
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
    const characterId = uniqueCharacterId(form.characterId || form.name, assets);
    const name = form.name.trim() || characterId;
    const character: CharacterAssetData = {
      characterId,
      description: form.description.trim(),
      prompt: promptForGeneration,
      generatedPrompt: providerPrompt,
      style: form.style,
      model: selectedModel.id,
      aspectRatio: CHARACTER_IMAGE_ASPECT_RATIO,
      resolution: CHARACTER_IMAGE_RESOLUTION,
      updatedAt: Date.now(),
    };
    const generatedAssetId = addGeneratedAsset(name, folderId, estimatedCostUsd, undefined, {
      kind: 'character',
      mimeType: 'image/png',
      durationSec: 5,
      character,
    });
    updateGenerationProgress(generatedAssetId, 3);
    onGenerationQueued?.(generatedAssetId);
    onClose();
    try {
      const generated = await generatePiApiImage({
        model: selectedModel,
        prompt: providerPrompt,
        aspectRatio: CHARACTER_IMAGE_ASPECT_RATIO,
        resolution: CHARACTER_IMAGE_RESOLUTION,
        outputFormat: selectedModel.capabilities.defaultOutputFormat,
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
        actualCostUsd: estimatedCostUsd,
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
      const referenceInput = await buildReferenceInput(characterAsset, sourceUrl, selectedModel);
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
        actualCostUsd: estimatedCostUsd,
        provider: generated.provider,
        providerTaskId: generated.providerTaskId,
        providerTaskEndpoint: generated.providerTaskEndpoint,
        providerTaskStatus: generated.providerTaskStatus,
        providerArtifactUri: generated.url,
        providerArtifactExpiresAt: generated.providerArtifactExpiresAt,
        character: {
          characterId: uniqueCharacterId(form.characterId, assets, characterAsset.id),
          description: form.description.trim(),
          prompt: promptForGeneration,
          generatedPrompt: providerPrompt,
          style: form.style,
          model: selectedModel.id,
          aspectRatio: CHARACTER_IMAGE_ASPECT_RATIO,
          resolution: CHARACTER_IMAGE_RESOLUTION,
        },
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
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Character Trail</div>
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
              <UserRound size={17} className="shrink-0 text-brand-300" />
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold">{isCreate ? 'New Character' : form.name || 'Character'}</div>
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
                    <UserRound size={44} />
                    <div className="text-sm">{isCreate ? 'Generate a character image from the description.' : 'Character image loading…'}</div>
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
                    placeholder="Character name"
                  />
                </label>
                <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Character ID
                  <div className="mt-1 flex overflow-hidden rounded-md border border-surface-700 bg-surface-950 focus-within:border-brand-400">
                    <span className="flex items-center border-r border-surface-700 px-2 text-sm font-normal normal-case tracking-normal text-slate-500">@</span>
                    <input
                      value={form.characterId}
                      onChange={(event) => {
                        setSlugTouched(true);
                        setForm((current) => ({ ...current, characterId: slugifyCharacterId(event.target.value) }));
                      }}
                      className="min-w-0 flex-1 bg-transparent px-2 text-sm font-normal normal-case tracking-normal text-slate-100 outline-none"
                      placeholder="character-id"
                    />
                    <button type="button" className="flex h-9 w-9 items-center justify-center border-l border-surface-700 text-slate-300 hover:bg-surface-800" onClick={() => void copyToken()} title="Copy character reference">
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
                    placeholder="Describe the character's face, outfit, style, and visual identity."
                  />
                </label>

                <div className="space-y-2 rounded-md border border-surface-700 bg-surface-950/60 p-2.5">
                  <ImageModelSelect value={selectedModel.id} options={IMAGE_MODELS} onChange={(modelId) => setFormForModel(modelId, setForm)} />
                  <StyleSelect value={form.style} onChange={(style) => setForm((current) => ({ ...current, style }))} />
                  <div className="grid grid-cols-2 gap-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                    <div className="rounded-md border border-surface-700 bg-surface-900 px-2 py-1.5">
                      <div>Aspect</div>
                      <div className="mt-0.5 text-sm font-medium normal-case tracking-normal text-slate-100">{CHARACTER_IMAGE_ASPECT_RATIO}</div>
                    </div>
                    <div className="rounded-md border border-surface-700 bg-surface-900 px-2 py-1.5">
                      <div>Resolution</div>
                      <div className="mt-0.5 text-sm font-medium normal-case tracking-normal text-slate-100">{CHARACTER_IMAGE_RESOLUTION}</div>
                    </div>
                  </div>
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
                  <progress className="export-progress" value={Math.max(4, Math.min(100, progress))} max={100} aria-label="Character generation progress" />
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-surface-700 px-4 py-3">
            <div className="text-[11px] text-slate-500">
              {selectedModel.label} · {CHARACTER_IMAGE_ASPECT_RATIO} · {CHARACTER_IMAGE_RESOLUTION} · ${estimatedCostUsd.toFixed(3)} / image
            </div>
            <div className="flex items-center gap-2">
              {!isCreate && (
                <button className="btn-ghost h-9 px-3 text-xs" onClick={saveDetails} disabled={working}>
                  <Save size={13} /> Save details
                </button>
              )}
              <button className="btn-primary h-9 px-4 text-sm font-semibold" onClick={() => void generate()} disabled={!canGenerate}>
                <Sparkles size={14} />
                {working ? 'Generating…' : isCreate ? 'Generate Character' : 'Regenerate'}
                <span className="ml-1 text-[10px] font-medium text-white/80">${estimatedCostUsd.toFixed(3)}</span>
              </button>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

function defaultCharacterForm(assets: MediaAsset[]): CharacterForm {
  const model = defaultImageModel();
  return {
    name: '',
    characterId: uniqueCharacterId('character', assets),
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

function buildCharacterImagePrompt(basePrompt: string, style: CharacterVisualStyle): string {
  const stylePrompt = CHARACTER_STYLE_OPTIONS.find((option) => option.value === style)?.prompt;
  return [basePrompt.trim(), stylePrompt, CHARACTER_SHEET_TEMPLATE].filter(Boolean).join('\n\n');
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

function ImageModelSelect({ value, options, onChange }: { value: string; options: ImageModelDefinition[]; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const selected = options.find((option) => option.id === value) ?? null;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || popupRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const updatePosition = () => {
      const trigger = triggerRef.current;
      const popup = popupRef.current;
      if (!trigger || !popup) return;
      const rect = trigger.getBoundingClientRect();
      const margin = 8;
      const width = Math.min(320, window.innerWidth - margin * 2);
      const estimatedHeight = popup.offsetHeight || 320;
      const spaceBelow = window.innerHeight - rect.bottom - margin;
      const spaceAbove = rect.top - margin;
      const placeAbove = spaceBelow < estimatedHeight && spaceAbove > spaceBelow;
      const left = Math.min(Math.max(margin, rect.left), window.innerWidth - width - margin);
      const top = placeAbove
        ? Math.max(margin, rect.top - estimatedHeight - 4)
        : Math.min(rect.bottom + 4, window.innerHeight - estimatedHeight - margin);
      popup.style.left = `${left}px`;
      popup.style.top = `${top}px`;
      popup.style.width = `${width}px`;
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open]);

  return (
    <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
      Image Model
      <button
        ref={triggerRef}
        type="button"
        className="flex h-9 w-full items-center gap-2 rounded-md border border-surface-700 bg-surface-900 px-2 text-sm font-normal normal-case tracking-normal text-slate-100 transition hover:border-surface-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="listbox"
        aria-label={selected ? `Image model: ${selected.label}` : 'Select image model'}
      >
        {selected ? (
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-surface-950">
              <ImageProviderLogo provider={selected.provider} size={18} />
            </span>
            <span className="min-w-0 flex-1 truncate text-left font-medium">{selected.label}</span>
          </span>
        ) : (
          <span className="min-w-0 flex-1 truncate text-left text-slate-400">No image models</span>
        )}
        <ChevronDown size={13} className={`shrink-0 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && typeof document !== 'undefined' && createPortal(
        <div
          ref={popupRef}
          className="fixed z-[200] overflow-hidden rounded-md border border-surface-700 bg-surface-900 shadow-2xl"
          role="listbox"
          aria-label="Image models"
        >
          <div className="border-b border-surface-700 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Image Models</div>
          <div className="max-h-[360px] overflow-auto p-1.5">
            {options.map((option) => {
              const active = option.id === value;
              return (
                <button
                  key={option.id}
                  type="button"
                  role="option"
                  className={`flex w-full items-center gap-2.5 rounded px-2 py-1.5 text-left transition ${active ? 'bg-surface-700' : 'hover:bg-surface-800'}`}
                  onClick={() => {
                    onChange(option.id);
                    setOpen(false);
                  }}
                >
                  <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md ${active ? 'bg-surface-800' : 'bg-surface-950'}`}>
                    <ImageProviderLogo provider={option.provider} size={24} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className={`truncate text-sm font-medium ${active ? 'text-slate-100' : 'text-slate-200'}`}>{option.label}</div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[10px] text-slate-400">
                      <span className="rounded bg-surface-800 px-1.5 py-0.5">{CHARACTER_IMAGE_ASPECT_RATIO}</span>
                      <span className="rounded bg-surface-800 px-1.5 py-0.5">{CHARACTER_IMAGE_RESOLUTION}</span>
                      <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-emerald-300">${option.estimatedCostUsd.toFixed(3)}</span>
                    </div>
                  </div>
                  {active && <Check size={14} className="shrink-0 text-brand-300" />}
                </button>
              );
            })}
          </div>
        </div>,
        document.body,
      )}
    </label>
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

function ImageProviderLogo({ provider, size }: { provider: ImageModelProvider; size: number }) {
  if (provider === 'piapi-gpt-image') return <LogoImage src={gptImageLogo} alt="GPT Image" size={size} />;
  return <LogoImage src={nanoBananaLogo} alt="Nano Banana" size={size} />;
}

function LogoImage({ src, alt, size }: { src: string; alt: string; size: number }) {
  return (
    <img src={src} alt={alt} width={size} height={size} className="shrink-0 object-contain" draggable={false} />
  );
}

async function buildReferenceInput(asset: MediaAsset, sourceUrl: string | null, model: ImageModelDefinition): Promise<{ referenceUrls?: string[]; referenceFiles?: File[] }> {
  if (isGptImageModel(model)) {
    if (!sourceUrl) return {};
    const blob = await fetch(sourceUrl).then((response) => response.blob());
    const extension = blob.type === 'image/jpeg' ? 'jpg' : blob.type === 'image/webp' ? 'webp' : 'png';
    return {
      referenceFiles: [new File([blob], `${asset.character?.characterId ?? asset.id}.${extension}`, { type: blob.type || asset.mimeType || 'image/png' })],
    };
  }
  return { referenceUrls: [await hostLitterboxReference(asset, 'Character reference')] };
}

function formatGenerationError(err: unknown): string {
  if (err instanceof VideoGenerationProviderError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Character generation failed.';
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
