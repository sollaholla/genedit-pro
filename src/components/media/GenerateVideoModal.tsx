import { Clapperboard, Image as ImageIcon, Plus, Upload, X, Save, FolderOpen } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { decryptSecret } from '@/lib/settings/crypto';
import { createMockGeneratedVideo } from '@/lib/media/mockVideoGenerator';
import {
  DEFAULT_VIDEO_MODELS,
  GOOGLE_ALLOWED_VIDEO_MODEL_IDS,
  buildRemoteVideoModelDefinition,
  isAdultContentFeatureSupported,
  isAspectFeatureSupported,
  isAudioFeatureSupported,
  isDurationFeatureSupported,
  isReferencesFeatureSupported,
  isResolutionFeatureSupported,
  isVeoModel,
  sortModelsByPriority,
  type Aspect,
  type VideoModelDefinition,
} from '@/lib/videoModels/capabilities';
import { useMediaStore } from '@/state/mediaStore';
import type { GenerateRecipe, MediaAsset } from '@/types';

type Props = {
  open: boolean;
  onClose: () => void;
  onOpenSettings: () => void;
  initialRecipeAsset?: MediaAsset | null;
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

type VideoGenerationOperation = {
  name?: string;
  done?: boolean;
  response?: {
    generatedVideos?: Array<{
      video?: {
        uri?: string;
        fileUri?: string;
      };
    }>;
  };
};

const KEY_STORAGE = 'genedit-pro:connections:google-veo';
const MODEL_PRICING_PER_SECOND_USD: Record<string, Partial<Record<'720p' | '1080p' | '4k', number>>> = {
  // https://ai.google.dev/gemini-api/docs/pricing#veo-3.1
  'veo-3.1-generate-preview': { '720p': 0.4, '1080p': 0.4, '4k': 0.6 },
  'veo-3.1-fast-generate-preview': { '720p': 0.1, '1080p': 0.12, '4k': 0.3 },
};
export function GenerateVideoModal({ open, onClose, onOpenSettings, initialRecipeAsset = null, folderId = null }: Props) {
  const assets = useMediaStore((s) => s.assets);
  const importFiles = useMediaStore((s) => s.importFiles);
  const addGeneratedAsset = useMediaStore((s) => s.addGeneratedAsset);
  const updateGenerationProgress = useMediaStore((s) => s.updateGenerationProgress);
  const finalizeGeneratedAssetWithBlob = useMediaStore((s) => s.finalizeGeneratedAssetWithBlob);
  const failGeneratedAsset = useMediaStore((s) => s.failGeneratedAsset);
  const saveRecipeAsset = useMediaStore((s) => s.saveRecipeAsset);

  const [models, setModels] = useState<VideoModelDefinition[]>(DEFAULT_VIDEO_MODELS);
  const [loadingModels, setLoadingModels] = useState(false);
  const [model, setModel] = useState(DEFAULT_VIDEO_MODELS[0].id);
  const [aspect, setAspect] = useState<Aspect>('16:9');
  const [resolution, setResolution] = useState('720p');
  const [duration, setDuration] = useState('4s');
  const [audioEnabled, setAudioEnabled] = useState(false);
  const [hoveredToken, setHoveredToken] = useState<RefToken | null>(null);
  const [hoverPos, setHoverPos] = useState({ x: 0, y: 0 });
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [loadedRecipeId, setLoadedRecipeId] = useState<string | null>(null);

  const [prompt, setPrompt] = useState('');
  const [showMediaPicker, setShowMediaPicker] = useState(false);
  const [pickerMode, setPickerMode] = useState<'reference' | 'start' | 'end'>('reference');
  const [references, setReferences] = useState<RefToken[]>([]);
  const [startFrame, setStartFrame] = useState<MediaAsset | null>(null);
  const [endFrame, setEndFrame] = useState<MediaAsset | null>(null);

  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionPos, setMentionPos] = useState({ x: 0, y: 0 });
  const editorRef = useRef<HTMLTextAreaElement | null>(null);

  const selectedModel = useMemo(
    () => models.find((m) => m.id === model) ?? DEFAULT_VIDEO_MODELS[0],
    [model, models],
  );
  const estimatedCostUsd = useMemo(() => {
    const seconds = Number(duration.replace('s', ''));
    if (!Number.isFinite(seconds) || seconds <= 0) return 0;
    const modelRates = MODEL_PRICING_PER_SECOND_USD[selectedModel.id];
    if (!modelRates) return 0;
    const rate = modelRates[(resolution as '720p' | '1080p' | '4k')] ?? modelRates['720p'];
    if (!rate) return 0;
    return Number((rate * seconds).toFixed(2));
  }, [duration, resolution, selectedModel.id]);

  const loadModels = useCallback(async () => {
    setLoadingModels(true);
    try {
      const encryptedKey = localStorage.getItem(KEY_STORAGE);
      if (!encryptedKey) {
        const prioritized = sortModelsByPriority(DEFAULT_VIDEO_MODELS);
        setModels(prioritized);
        if (!initialRecipeAsset?.recipe) setModel(prioritized[0]!.id);
        return;
      }
      const key = await decryptSecret(encryptedKey);
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`);
      if (!res.ok) throw new Error(`Unable to fetch models: ${res.status}`);
      const data = await res.json() as { models?: Array<{ name: string; displayName?: string; supportedGenerationMethods?: string[] }> };
      const available = sortModelsByPriority((data.models ?? [])
        .filter((m) => (m.supportedGenerationMethods ?? []).some((method) => method.toLowerCase().includes('video')) || m.name.toLowerCase().includes('veo'))
        .filter((m) => GOOGLE_ALLOWED_VIDEO_MODEL_IDS.has(m.name.replace('models/', '')))
        .map((m) => {
          const id = m.name.replace('models/', '');
          const fallback = DEFAULT_VIDEO_MODELS.find((fm) => fm.id === id);
          return buildRemoteVideoModelDefinition(m, fallback);
        }));
      if (available.length) {
        setModels(available);
        if (!initialRecipeAsset?.recipe) setModel(available[0]!.id);
      } else {
        const prioritized = sortModelsByPriority(DEFAULT_VIDEO_MODELS);
        setModels(prioritized);
        if (!initialRecipeAsset?.recipe) setModel(prioritized[0]!.id);
      }
    } catch {
      const prioritized = sortModelsByPriority(DEFAULT_VIDEO_MODELS);
      setModels(prioritized);
      if (!initialRecipeAsset?.recipe) setModel(prioritized[0]!.id);
    } finally {
      setLoadingModels(false);
    }
  }, [initialRecipeAsset?.recipe]);

  useEffect(() => {
    if (!open) return;
    void loadModels();
  }, [loadModels, open]);

  useEffect(() => {
    if (!open || !initialRecipeAsset?.recipe) return;
    const recipe = initialRecipeAsset.recipe;
    setLoadedRecipeId(initialRecipeAsset.id);
    setModel(recipe.model);
    setPrompt(recipe.prompt);
    setAspect((recipe.aspect as Aspect) || '16:9');
    setResolution(recipe.resolution || '720p');
    setDuration(recipe.duration || '4s');
    setAudioEnabled(Boolean(recipe.audioEnabled));
    setStartFrame(recipe.startFrameAssetId ? assets.find((a) => a.id === recipe.startFrameAssetId) ?? null : null);
    setEndFrame(recipe.endFrameAssetId ? assets.find((a) => a.id === recipe.endFrameAssetId) ?? null : null);
    const selectedRefs = recipe.referenceAssetIds
      .map((assetId) => assets.find((a) => a.id === assetId))
      .filter((a): a is MediaAsset => Boolean(a))
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
    if (!isResolutionFeatureSupported(selectedModel, resolution)) {
      setResolution(selectedModel.capabilities.resolutions[0] ?? '720p');
    }
    if (!isDurationFeatureSupported(selectedModel, duration)) {
      setDuration(selectedModel.capabilities.durations[0] ?? '4s');
    }
    if (!isAspectFeatureSupported(selectedModel, aspect)) {
      setAspect(selectedModel.capabilities.aspects[0] ?? '16:9');
    }
    setAudioEnabled(isAudioFeatureSupported(selectedModel));
  }, [aspect, duration, resolution, selectedModel]);

  const allMentionItems = [
    ...(startFrame ? [{ key: 'start-frame', label: '@start-frame', action: () => insertToken('@start-frame') }] : []),
    ...(endFrame ? [{ key: 'end-frame', label: '@end-frame', action: () => insertToken('@end-frame') }] : []),
    ...references.map((ref) => ({ key: ref.id, label: `@${ref.token}`, action: () => insertToken(`@${ref.token}`) })),
  ];

  const filteredMentionItems = mentionQuery.trim()
    ? allMentionItems.filter((item) => item.label.toLowerCase().includes(mentionQuery.toLowerCase()))
    : allMentionItems;

  const referenceMap = useMemo(() => {
    const out = new Map<string, RefToken | 'start' | 'end'>();
    for (const ref of references) out.set(ref.token.toLowerCase(), ref);
    if (startFrame) out.set('start-frame', 'start');
    if (endFrame) out.set('end-frame', 'end');
    return out;
  }, [references, startFrame, endFrame]);

  const promptTokens = useMemo(
    () => Array.from(prompt.matchAll(/@([a-z0-9-]+)/gi)),
    [prompt],
  );
  const recipeAssets = useMemo(() => assets.filter((a) => a.kind === 'recipe' && a.recipe), [assets]);
  const usingLocalDemoGenerator = import.meta.env.DEV || !localStorage.getItem(KEY_STORAGE);

  if (!open) return null;

  function buildToken(kind: RefToken['kind'], index: number) {
    return `${kind}${index + 1}`;
  }

  function addReferenceAsset(asset: MediaAsset) {
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
    setReferences((prev) => [...prev, entry]);
  }

  function insertToken(token: string) {
    const textarea = editorRef.current;
    if (!textarea) {
      setPrompt((prev) => `${prev} ${token}`.trim());
      return;
    }
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const next = `${prompt.slice(0, start)}${token} ${prompt.slice(end)}`;
    setPrompt(next);
    requestAnimationFrame(() => {
      textarea.focus();
      const pos = start + token.length + 1;
      textarea.setSelectionRange(pos, pos);
    });
    setMentionOpen(false);
    setMentionQuery('');
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
      return;
    }
    setMentionQuery(match[1]);
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
    input.accept = 'image/*,video/*,audio/*';
    input.multiple = true;
    input.onchange = async () => {
      const files = Array.from(input.files ?? []);
      if (!files.length) return;
      const imported = await importFiles(files);
      const first = imported[0];
      if (!first) return;
      if (pickerMode === 'start') setStartFrame(first.kind === 'image' ? first : null);
      else if (pickerMode === 'end') setEndFrame(first.kind === 'image' ? first : null);
      else addReferenceAsset(first);
    };
    input.click();
  }

  async function generate() {
    setGenerationError(null);
    setIsGenerating(true);
    const encryptedKey = localStorage.getItem(KEY_STORAGE);
    const useLocalGenerator = import.meta.env.DEV || !encryptedKey;
    const generationCostUsd = useLocalGenerator ? undefined : estimatedCostUsd || undefined;
    const id = addGeneratedAsset(
      `${useLocalGenerator ? 'Demo_Generation' : 'Generating'}_${Date.now()}.${useLocalGenerator ? 'webm' : 'mp4'}`,
      folderId,
      generationCostUsd,
    );
    try {
      if (useLocalGenerator) {
        const file = await createMockGeneratedVideo({
          prompt,
          aspect,
          duration,
          resolution,
          audioEnabled,
          onProgress: (progress) => updateGenerationProgress(id, progress),
        });
        await finalizeGeneratedAssetWithBlob(id, file, generationCostUsd);
        onClose();
        return;
      }

      const apiKey = await decryptSecret(encryptedKey);
      const modelId = selectedModel.id;
      const payload = {
        model: modelId,
        prompt,
        config: {
          aspectRatio: aspect,
          durationSeconds: Number(duration.replace('s', '')),
          resolution,
          generateAudio: audioEnabled,
          ...(isVeoModel(selectedModel) && isAdultContentFeatureSupported(selectedModel) ? { allowAdult: true } : {}),
        },
      };

      const opRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:generateVideos?key=${encodeURIComponent(apiKey)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!opRes.ok) throw new Error(`Generation request failed (${opRes.status}).`);

      let operation = await opRes.json() as VideoGenerationOperation;
      if (!operation.name) throw new Error('Generation operation did not return an operation id.');
      let spinnerProgress = 5;
      while (!operation.done) {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        spinnerProgress = Math.min(95, spinnerProgress + 10);
        updateGenerationProgress(id, spinnerProgress);
        const pollRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/${operation.name}?key=${encodeURIComponent(apiKey)}`);
        if (!pollRes.ok) throw new Error(`Generation poll failed (${pollRes.status}).`);
        operation = await pollRes.json() as VideoGenerationOperation;
      }

      const generatedVideo = operation.response?.generatedVideos?.[0]?.video;
      const fileUri: string | undefined = generatedVideo?.uri || generatedVideo?.fileUri;
      if (!fileUri) throw new Error('No generated video URI returned by API.');

      const videoRes = await fetch(fileUri);
      if (!videoRes.ok) throw new Error(`Failed downloading generated video (${videoRes.status}).`);
      const blob = await videoRes.blob();
      const file = new File([blob], `generated_${Date.now()}.mp4`, { type: blob.type || 'video/mp4' });
      await finalizeGeneratedAssetWithBlob(id, file, generationCostUsd);
      onClose();
    } catch (err) {
      failGeneratedAsset(id, generationCostUsd);
      setGenerationError(err instanceof Error ? err.message : 'Generation failed.');
    } finally {
      setIsGenerating(false);
    }
  }

  function buildCurrentRecipe(): GenerateRecipe {
    return {
      model,
      prompt,
      aspect,
      resolution,
      duration,
      audioEnabled,
      startFrameAssetId: startFrame?.id ?? null,
      endFrameAssetId: endFrame?.id ?? null,
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
    setPrompt(recipe.prompt);
    setAspect((recipe.aspect as Aspect) || '16:9');
    setResolution(recipe.resolution || '720p');
    setDuration(recipe.duration || '4s');
    setAudioEnabled(Boolean(recipe.audioEnabled));
    setStartFrame(recipe.startFrameAssetId ? assets.find((a) => a.id === recipe.startFrameAssetId) ?? null : null);
    setEndFrame(recipe.endFrameAssetId ? assets.find((a) => a.id === recipe.endFrameAssetId) ?? null : null);
    const selectedRefs = recipe.referenceAssetIds
      .map((assetId) => assets.find((a) => a.id === assetId))
      .filter((a): a is MediaAsset => Boolean(a))
      .map((refAsset, index) => ({
        id: `${refAsset.id}-${Date.now()}-${index}`,
        token: `${refAsset.kind}${index + 1}`,
        assetId: refAsset.id,
        name: refAsset.name,
        kind: refAsset.kind as RefToken['kind'],
        thumbnail: refAsset.thumbnailDataUrl,
      }));
    setReferences(selectedRefs);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm">
      <div className="w-[min(680px,92vw)] rounded-2xl border border-white/10 bg-[#0b1020] text-slate-100 shadow-2xl">
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-semibold"><Clapperboard size={16} /> Generate Video</div>
          <button className="rounded-md p-1 text-slate-400 hover:bg-white/10" onClick={onClose}><X size={16} /></button>
        </div>

        <div className="space-y-3 p-4">
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-2 py-1.5">
            <button className="inline-flex items-center gap-1 rounded border border-white/15 px-2 py-1 text-xs hover:bg-white/10" onClick={() => saveRecipe(false)}>
              <Save size={12} /> Save
            </button>
            <button className="inline-flex items-center gap-1 rounded border border-white/15 px-2 py-1 text-xs hover:bg-white/10" onClick={() => saveRecipe(true)}>
              <Save size={12} /> Save as
            </button>
            <label className="inline-flex items-center gap-1 rounded border border-white/15 px-2 py-1 text-xs">
              <FolderOpen size={12} /> Open recipe
              <select className="bg-transparent outline-none" value={loadedRecipeId ?? ''} onChange={(e) => openRecipeById(e.target.value)}>
                <option value="">Select…</option>
                {recipeAssets.map((recipeAsset) => (
                  <option key={recipeAsset.id} value={recipeAsset.id} className="bg-slate-900">
                    {recipeAsset.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <FrameRefButton
              label="Start frame"
              value={startFrame}
              onClick={() => {
                setPickerMode('start');
                setShowMediaPicker(true);
              }}
              onClear={() => setStartFrame(null)}
            />
            <FrameRefButton
              label="End frame"
              value={endFrame}
              onClick={() => {
                setPickerMode('end');
                setShowMediaPicker(true);
              }}
              onClear={() => setEndFrame(null)}
            />
          </div>

          <div className="relative">
            <textarea
              ref={editorRef}
              value={prompt}
              onChange={(e) => onPromptChange(e.target.value)}
              placeholder="Describe your video. Type @ to insert @start-frame, @end-frame, or @image1/@video1/@audio1 references."
              className="h-32 w-full resize-none rounded-xl border border-white/10 bg-[#121833] px-3 py-3 text-sm text-slate-100 outline-none placeholder:text-slate-400"
            />
            <div className="mt-2 flex flex-wrap gap-1.5">
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
          </div>

          <div className="rounded-xl border border-white/10 bg-white/5 p-2.5">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs text-slate-400">References</span>
              <button
                className="inline-flex items-center gap-1 rounded-md border border-white/15 bg-white/10 px-2 py-1 text-xs hover:bg-white/20"
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
            <div className="flex flex-wrap gap-2">
              {references.length === 0 && <span className="text-xs text-slate-500">No references selected.</span>}
              {references.map((ref) => (
                <button key={ref.id} onClick={() => removeReference(ref.id)} className="inline-flex items-center gap-1 rounded-full border border-white/15 bg-white/5 px-2 py-1 text-xs hover:bg-white/10">
                  {ref.thumbnail ? <img src={ref.thumbnail} alt="" className="h-4 w-4 rounded object-cover" /> : <ImageIcon size={12} />}
                  @{ref.token}
                  <X size={11} />
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <FieldSelect label="Model" value={model} onChange={setModel} options={models.map((m) => ({ value: m.id, label: m.label }))} loading={loadingModels} />
            <FieldSelect label="Aspect" value={aspect} onChange={(v) => setAspect(v as Aspect)} options={selectedModel.capabilities.aspects.map((v) => ({ value: v, label: v }))} />
            <FieldSelect label="Resolution" value={resolution} onChange={setResolution} options={selectedModel.capabilities.resolutions.map((v) => ({ value: v, label: v }))} />
            <FieldSelect label="Duration" value={duration} onChange={setDuration} options={selectedModel.capabilities.durations.map((v) => ({ value: v, label: v }))} />
            <button
              disabled={!isAudioFeatureSupported(selectedModel)}
              className={`rounded-lg border px-2 py-2 text-xs ${audioEnabled ? 'border-emerald-400/60 bg-emerald-500/10 text-emerald-200' : 'border-white/15 bg-white/5 text-slate-300'} disabled:cursor-not-allowed disabled:opacity-60`}
              onClick={() => setAudioEnabled((v) => !v)}
            >
              Audio {audioEnabled ? 'On' : 'Off'}
            </button>
          </div>

          <div className="flex items-center justify-between gap-3">
            <div className="text-[11px] text-slate-500">
              {usingLocalDemoGenerator ? 'Local demo generator' : selectedModel.label}
            </div>
            {generationError && (
              <div className="flex items-center gap-2 text-xs text-rose-300">
                <span>{generationError}</span>
                {generationError.includes('Missing Google API key') && (
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
              disabled={!prompt.trim() || isGenerating}
              className="inline-flex h-9 items-center rounded-full bg-white px-4 text-sm font-semibold text-black transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:bg-slate-500"
            >
              {isGenerating ? 'Generating...' : (
                <>
                  {usingLocalDemoGenerator ? 'Generate demo' : 'Generate'}
                  {!usingLocalDemoGenerator && (
                    <span className="ml-1 text-[10px] font-medium text-slate-700">${estimatedCostUsd.toFixed(2)}</span>
                  )}
                </>
              )}
            </button>
          </div>
        </div>
      </div>

      {mentionOpen && filteredMentionItems.length > 0 && (
        <div
          className="fixed z-[60] w-52 rounded-md border border-white/15 bg-[#101735] p-1 shadow-2xl"
          style={{ left: mentionPos.x, top: mentionPos.y }}
        >
          {filteredMentionItems.map((item) => (
            <button key={item.key} className="block w-full rounded px-2 py-1 text-left text-xs text-slate-200 hover:bg-white/10" onClick={item.action}>
              {item.label}
            </button>
          ))}
        </div>
      )}

      {hoveredToken && (
        <div
          className="fixed z-[72] rounded-md border border-white/20 bg-[#111933] p-2 shadow-2xl"
          style={{ left: hoverPos.x, top: hoverPos.y }}
        >
          <div className="mb-1 text-[11px] text-slate-400">@{hoveredToken.token}</div>
          <div className="flex items-center gap-2">
            {hoveredToken.thumbnail ? (
              <img src={hoveredToken.thumbnail} alt="" className="h-10 w-10 rounded object-cover" />
            ) : (
              <div className="flex h-10 w-10 items-center justify-center rounded bg-black/25 text-[10px] text-slate-400">{hoveredToken.kind.toUpperCase()}</div>
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
            if (pickerMode === 'start') setStartFrame(asset.kind === 'image' ? asset : null);
            else if (pickerMode === 'end') setEndFrame(asset.kind === 'image' ? asset : null);
            else addReferenceAsset(asset);
            setShowMediaPicker(false);
          }}
          onImportFromComputer={() => void onImportFromComputer()}
          pickerMode={pickerMode}
        />
      )}
    </div>
  );
}

function FieldSelect({
  label,
  value,
  options,
  onChange,
  loading = false,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
  loading?: boolean;
}) {
  return (
    <label className="space-y-1 rounded-lg border border-white/10 bg-white/5 px-2 py-1.5">
      <div className="text-[11px] text-slate-400">{label}</div>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full bg-transparent text-xs text-slate-100 outline-none"
        disabled={loading}
      >
        {loading ? <option>Loading…</option> : options.map((option) => <option key={option.value} value={option.value} className="bg-slate-900">{option.label}</option>)}
      </select>
    </label>
  );
}

function FrameRefButton({ label, value, onClick, onClear }: { label: string; value: MediaAsset | null; onClick: () => void; onClear: () => void }) {
  return (
    <div className="rounded-xl border border-dashed border-white/20 bg-white/5 p-2">
      <div className="mb-2 flex items-center justify-between text-xs text-slate-400">
        <span>{label}</span>
        {value && <button className="text-slate-300 hover:text-white" onClick={onClear}>Clear</button>}
      </div>
      <button className="flex w-full items-center gap-2 rounded-lg border border-white/10 bg-[#111833] px-2 py-2 text-xs hover:bg-[#1a2345]" onClick={onClick}>
        {value?.thumbnailDataUrl ? <img src={value.thumbnailDataUrl} alt="" className="h-8 w-8 rounded object-cover" /> : <ImageIcon size={14} />}
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
}: {
  assets: MediaAsset[];
  onClose: () => void;
  onPick: (asset: MediaAsset) => void;
  onImportFromComputer: () => void;
  pickerMode: 'reference' | 'start' | 'end';
}) {
  const visibleAssets = pickerMode === 'reference' ? assets : assets.filter((a) => a.kind === 'image');
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/55 p-4">
      <div className="w-[min(680px,94vw)] rounded-xl border border-white/15 bg-[#0b1127] p-3">
        <div className="mb-2 flex items-center justify-between">
          <div className="text-sm font-semibold">Pick from media</div>
          <button className="rounded p-1 hover:bg-white/10" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="mb-3 flex items-center justify-between">
          <div className="text-xs text-slate-400">{pickerMode === 'reference' ? 'Choose image, video, or audio references.' : 'Only image assets are valid for frame slots.'}</div>
          <button className="inline-flex items-center gap-1 rounded-md border border-white/15 bg-white/10 px-2 py-1 text-xs hover:bg-white/20" onClick={onImportFromComputer}><Upload size={12} /> Import</button>
        </div>
        <div className="grid max-h-[340px] grid-cols-2 gap-2 overflow-auto sm:grid-cols-3 md:grid-cols-4">
          {visibleAssets.map((asset) => (
            <button key={asset.id} className="rounded-lg border border-white/10 bg-white/5 p-2 text-left hover:bg-white/10" onClick={() => onPick(asset)}>
              <div className="mb-1 h-20 w-full overflow-hidden rounded bg-black/25">
                {asset.thumbnailDataUrl ? <img src={asset.thumbnailDataUrl} alt="" className="h-full w-full object-cover" /> : <div className="flex h-full items-center justify-center text-[11px] text-slate-500">{asset.kind.toUpperCase()}</div>}
              </div>
              <div className="truncate text-xs text-slate-200">{asset.name}</div>
              <div className="text-[11px] text-slate-500">{asset.kind}</div>
            </button>
          ))}
          {visibleAssets.length === 0 && <div className="col-span-full rounded border border-dashed border-white/15 p-4 text-center text-xs text-slate-500">No matching media assets found.</div>}
        </div>
      </div>
    </div>
  );
}
