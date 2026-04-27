import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Copy, Image as ImageIcon, Save, Sparkles, UserRound, X } from 'lucide-react';
import {
  DEFAULT_IMAGE_MODELS,
  defaultImageModel,
  estimateImageCostUsd,
  imageModelById,
  sortImageModelsByPriority,
  type ImageModelDefinition,
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
import type { CharacterAssetData, EditTrailIteration, MediaAsset } from '@/types';

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
  prompt: string;
  model: string;
  aspectRatio: string;
  resolution: string;
};

const IMAGE_MODELS = sortImageModelsByPriority(DEFAULT_IMAGE_MODELS);
const CHARACTER_SHEET_TEMPLATE = 'Create a single full-body character turnaround reference sheet. Arrange four evenly spaced views of the same character from left to right: front view, left side view, right side view, back view. Keep the face, body proportions, clothing, hairstyle, colors, and accessories consistent in every view. Use neutral studio lighting with no background.';

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
  const promptForGeneration = (form.prompt.trim() || form.description.trim()).trim();
  const providerPrompt = buildCharacterImagePrompt(promptForGeneration);
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
      description: asset.character?.description ?? '',
      prompt: asset.character?.prompt ?? '',
      model: nextModel.id,
      aspectRatio: asset.character?.aspectRatio ?? nextModel.capabilities.aspects[0] ?? '1:1',
      resolution: asset.character?.resolution ?? nextModel.capabilities.resolutions[0] ?? '1K',
    });
    setSlugTouched(false);
  }, [asset, assetId, assets]);

  useEffect(() => {
    const model = imageModelById(form.model) ?? defaultImageModel();
    if (!model.capabilities.aspects.includes(form.aspectRatio as never)) {
      setForm((current) => ({ ...current, aspectRatio: model.capabilities.aspects[0] ?? '1:1' }));
    }
    if (!model.capabilities.resolutions.includes(form.resolution)) {
      setForm((current) => ({ ...current, resolution: model.capabilities.resolutions[0] ?? '1K' }));
    }
  }, [form.aspectRatio, form.model, form.resolution]);

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
      model: selectedModel.id,
      aspectRatio: form.aspectRatio,
      resolution: form.resolution,
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
      model: selectedModel.id,
      aspectRatio: form.aspectRatio,
      resolution: form.resolution,
      updatedAt: Date.now(),
    };
    const generatedAssetId = addGeneratedAsset(name, folderId, estimatedCostUsd, undefined, {
      kind: 'character',
      mimeType: 'image/png',
      durationSec: 5,
      character,
    });
    onGenerationQueued?.(generatedAssetId);
    onClose();
    try {
      const generated = await generatePiApiImage({
        model: selectedModel,
        prompt: providerPrompt,
        aspectRatio: form.aspectRatio,
        resolution: form.resolution,
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
        aspectRatio: form.aspectRatio,
        resolution: form.resolution,
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
          model: selectedModel.id,
          aspectRatio: form.aspectRatio,
          resolution: form.resolution,
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
                    onChange={(event) => setForm((current) => ({ ...current, description: event.target.value, prompt: current.prompt || event.target.value }))}
                    className="mt-1 h-24 w-full resize-none rounded-md border border-surface-700 bg-surface-950 px-3 py-2 text-sm font-normal normal-case tracking-normal text-slate-100 outline-none focus:border-brand-400"
                    placeholder="Describe the character's face, outfit, style, and visual identity."
                  />
                </label>
                <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Generation Prompt
                  <textarea
                    value={form.prompt}
                    onChange={(event) => setForm((current) => ({ ...current, prompt: event.target.value }))}
                    className="mt-1 h-28 w-full resize-none rounded-md border border-surface-700 bg-surface-950 px-3 py-2 text-sm font-normal normal-case tracking-normal text-slate-100 outline-none focus:border-brand-400"
                    placeholder="Prompt used for this image generation."
                  />
                </label>

                <div className="space-y-2 rounded-md border border-surface-700 bg-surface-950/60 p-2.5">
                  <ImageModelSelect value={selectedModel.id} options={IMAGE_MODELS} onChange={(modelId) => setFormForModel(modelId, setForm)} />
                  <OptionRow label="Aspect" value={form.aspectRatio} options={selectedModel.capabilities.aspects} onChange={(value) => setForm((current) => ({ ...current, aspectRatio: value }))} />
                  <OptionRow label="Resolution" value={form.resolution} options={selectedModel.capabilities.resolutions} onChange={(value) => setForm((current) => ({ ...current, resolution: value }))} />
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
    prompt: '',
    model: model.id,
    aspectRatio: model.capabilities.aspects[0] ?? '1:1',
    resolution: model.capabilities.resolutions[0] ?? '1K',
  };
}

function setFormForModel(modelId: string, setForm: (updater: (current: CharacterForm) => CharacterForm) => void) {
  const model = imageModelById(modelId) ?? defaultImageModel();
  setForm((current) => ({
    ...current,
    model: model.id,
    aspectRatio: model.capabilities.aspects.includes(current.aspectRatio as never) ? current.aspectRatio : model.capabilities.aspects[0] ?? '1:1',
    resolution: model.capabilities.resolutions.includes(current.resolution) ? current.resolution : model.capabilities.resolutions[0] ?? '1K',
  }));
}

function buildCharacterImagePrompt(basePrompt: string): string {
  return [basePrompt.trim(), CHARACTER_SHEET_TEMPLATE].filter(Boolean).join('\n\n');
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
  return (
    <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
      Image Model
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 rounded-md border border-surface-700 bg-surface-900 px-2 text-sm font-normal normal-case tracking-normal text-slate-100 outline-none focus:border-brand-400"
      >
        {options.map((option) => (
          <option key={option.id} value={option.id}>{option.label} · ${option.estimatedCostUsd.toFixed(3)}</option>
        ))}
      </select>
    </label>
  );
}

function OptionRow({ label, value, options, onChange }: { label: string; value: string; options: readonly string[]; onChange: (value: string) => void }) {
  return (
    <div>
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</div>
      <div className="flex flex-wrap gap-1">
        {options.map((option) => (
          <button
            key={option}
            type="button"
            className={`h-7 rounded px-2 text-xs transition ${value === option ? 'bg-brand-500 text-white' : 'bg-surface-800 text-slate-300 hover:bg-surface-700'}`}
            onClick={() => onChange(option)}
          >
            {option}
          </button>
        ))}
      </div>
    </div>
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
