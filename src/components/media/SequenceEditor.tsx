import { type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from 'react';
import { nanoid } from 'nanoid';
import { Check, Clapperboard, Copy, Image as ImageIcon, Pause, Play, Plus, Search, SkipBack, SkipForward, Sparkles, Trash2, Upload, X } from 'lucide-react';
import {
  DEFAULT_VIDEO_MODELS,
  isPiApiKlingModel,
  isPiApiSeedanceModel,
  sortModelsByPriority,
  type VideoModelDefinition,
} from '@/lib/videoModels/capabilities';
import { composeSequencePrompt, formatSequenceTimestamp, sortedSequenceMarkers } from '@/lib/media/sequence';
import { useMediaStore } from '@/state/mediaStore';
import type { MediaAsset, SequenceAssetData, SequenceMarker } from '@/types';
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
  const updateSequenceAsset = useMediaStore((state) => state.updateSequenceAsset);
  const createSequenceAsset = useMediaStore((state) => state.createSequenceAsset);
  const sequenceModels = useMemo(() => sortModelsByPriority(DEFAULT_VIDEO_MODELS.filter((model) => isPiApiSeedanceModel(model) || isPiApiKlingModel(model))), []);
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
  const durationOptions = useMemo(() => (selectedModel ? durationsForModel(selectedModel) : [8]), [selectedModel]);
  const imageAssets = useMemo(() => assets.filter((candidate) => candidate.kind === 'image'), [assets]);
  const sortedMarkers = useMemo(() => sortedSequenceMarkers(sequence), [sequence]);
  const [selectedMarkerId, setSelectedMarkerId] = useState<string | null>(sortedMarkers[0]?.id ?? null);
  const [currentTimeSec, setCurrentTimeSec] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [draggingMarkerId, setDraggingMarkerId] = useState<string | null>(null);
  const [scrubbing, setScrubbing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [imagePickerMarkerId, setImagePickerMarkerId] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const timelineRef = useRef<SVGSVGElement | null>(null);
  const timelineGestureRef = useRef<{ pointerId: number; startX: number; startY: number; moved: boolean; target: 'timeline' | 'marker' } | null>(null);
  const suppressTimelineDoubleClickUntilRef = useRef(0);
  const selectedMarker = sequence.markers.find((marker) => marker.id === selectedMarkerId) ?? null;
  const selectedMarkerImage = selectedMarker?.imageAssetId ? imageAssets.find((candidate) => candidate.id === selectedMarker.imageAssetId) ?? null : null;
  const imagePickerMarker = imagePickerMarkerId ? sequence.markers.find((marker) => marker.id === imagePickerMarkerId) ?? null : null;
  const previewMarker = mostRecentImageMarker(sortedMarkers, currentTimeSec) ?? (selectedMarker?.imageAssetId ? selectedMarker : null);
  const previewImage = previewMarker?.imageAssetId ? imageAssets.find((candidate) => candidate.id === previewMarker.imageAssetId) ?? null : null;
  const composedPrompt = useMemo(() => composeSequencePrompt(sequence), [sequence]);

  useEffect(() => {
    if (isDraft) return;
    if (!storedAsset) onClose();
  }, [isDraft, storedAsset, onClose]);

  useEffect(() => {
    if (selectedMarkerId && sequence.markers.some((marker) => marker.id === selectedMarkerId)) return;
    setSelectedMarkerId(sortedMarkers[0]?.id ?? null);
  }, [selectedMarkerId, sequence.markers, sortedMarkers]);

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
      else onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [imagePickerMarkerId, onClose]);

  if (!selectedModel) return null;
  if (!isDraft && !storedAsset) return null;

  const shouldCommitDraft = (next: SequenceAssetData): boolean =>
    next.markers.some((marker) => marker.imageAssetId) || next.markers.length > 0;

  const persist = (next: SequenceAssetData) => {
    const normalized = normalizeSequence(next);
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
  const updateMarker = (markerId: string, patch: Partial<SequenceMarker>) => {
    persist({
      ...sequence,
      markers: sequence.markers.map((marker) => (marker.id === markerId
        ? { ...marker, ...patch, timeSec: clampTime(patch.timeSec ?? marker.timeSec, sequence.durationSec) }
        : marker)),
    });
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
  const deleteSelectedMarker = () => {
    if (!selectedMarker) return;
    const remaining = sequence.markers.filter((marker) => marker.id !== selectedMarker.id);
    persist({ ...sequence, markers: remaining });
    setSelectedMarkerId(remaining[0]?.id ?? null);
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

  return (
    <div className="fixed inset-0 z-[95] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm">
      <div className="flex h-[min(880px,94vh)] w-[min(1180px,96vw)] flex-col overflow-hidden rounded-lg border border-white/15 bg-surface-950 shadow-2xl">
        <div className="flex shrink-0 items-center justify-between border-b border-surface-700 px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <Clapperboard size={17} className="shrink-0 text-brand-300" />
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

            <div className="mb-3 flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                <div className="inline-flex items-center rounded-md border border-surface-700 bg-surface-950 p-0.5">
                  <button
                    type="button"
                    className="flex h-7 w-7 items-center justify-center rounded text-slate-400 hover:bg-surface-700 hover:text-slate-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand-300"
                    onClick={seekStart}
                    title="Go to start"
                    aria-label="Go to start"
                  >
                    <SkipBack size={13} />
                  </button>
                  <button
                    type="button"
                    className="flex h-7 w-7 items-center justify-center rounded text-slate-200 hover:bg-surface-700 hover:text-white focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand-300 disabled:cursor-not-allowed disabled:opacity-35"
                    onClick={playPreview}
                    disabled={playing}
                    title="Play preview"
                    aria-label="Play preview"
                  >
                    <Play size={14} />
                  </button>
                  <button
                    type="button"
                    className="flex h-7 w-7 items-center justify-center rounded text-slate-400 hover:bg-surface-700 hover:text-slate-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand-300 disabled:cursor-not-allowed disabled:opacity-35"
                    onClick={pausePreview}
                    disabled={!playing}
                    title="Pause preview"
                    aria-label="Pause preview"
                  >
                    <Pause size={14} />
                  </button>
                  <button
                    type="button"
                    className="flex h-7 w-7 items-center justify-center rounded text-slate-400 hover:bg-surface-700 hover:text-slate-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand-300"
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
                  return (
                    <g
                      key={marker.id}
                      transform={`translate(${x} 0)`}
                      className="cursor-ew-resize"
                      onPointerDown={(event) => {
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
                      onDoubleClick={(event) => event.stopPropagation()}
                    >
                      <line x1="0" y1="18" x2="0" y2="66" className={selected ? 'stroke-brand-300' : 'stroke-amber-300'} strokeWidth={selected ? 3 : 2} />
                      <circle cx="0" cy={TIMELINE_Y} r={selected ? 8 : 6} className={marker.imageAssetId ? 'fill-amber-300' : 'fill-surface-400'} />
                      <text x="0" y="12" textAnchor="middle" className={selected ? 'fill-brand-200 text-[11px] font-semibold' : 'fill-slate-400 text-[10px]'}>{index + 1}</text>
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
                <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap rounded bg-surface-950 p-3 text-xs leading-relaxed text-slate-300">{composedPrompt || ' '}</pre>
              </section>

              <MarkerInspector
                marker={selectedMarker}
                selectedImage={selectedMarkerImage}
                durationSec={sequence.durationSec}
                onUpdate={updateMarker}
                onDelete={deleteSelectedMarker}
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
              ) : (
                <div className="flex flex-col items-center gap-2 text-slate-500">
                  <ImageIcon size={30} />
                  <div className="text-xs">No marker image</div>
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
                    className={`group flex w-full items-center gap-2 rounded border px-2 py-1.5 text-xs ${
                      marker.id === selectedMarkerId
                        ? 'border-brand-400 bg-brand-500/15 text-slate-100'
                        : 'border-surface-700 bg-surface-950 text-slate-300 hover:border-surface-500'
                    }`}
                  >
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center justify-between gap-2 text-left"
                      onClick={() => {
                        setSelectedMarkerId(marker.id);
                        setCurrentTimeSec(marker.timeSec);
                      }}
                    >
                      <span className="min-w-0 truncate">{index + 1}. {marker.prompt || 'Untitled shot'}</span>
                      <span className="shrink-0 font-mono text-[11px] text-slate-500">{formatTime(marker.timeSec)}</span>
                    </button>
                    <button
                      type="button"
                      className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-slate-500 opacity-0 transition hover:bg-red-500/10 hover:text-red-300 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-300/60"
                      title="Delete marker"
                      aria-label="Delete marker"
                      onClick={(event) => {
                        event.stopPropagation();
                        const remaining = sequence.markers.filter((candidate) => candidate.id !== marker.id);
                        persist({ ...sequence, markers: remaining });
                        if (selectedMarkerId === marker.id) setSelectedMarkerId(remaining[0]?.id ?? null);
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
          assets={imageAssets}
          selectedId={imagePickerMarker.imageAssetId ?? null}
          onPick={(image) => {
            updateMarker(imagePickerMarker.id, { imageAssetId: image.id });
            setImagePickerMarkerId(null);
          }}
          onImport={() => void importMarkerImage()}
          onClose={() => setImagePickerMarkerId(null)}
        />
      )}
    </div>
  );
}

function MarkerInspector({
  marker,
  selectedImage,
  durationSec,
  onUpdate,
  onDelete,
  onChooseImage,
}: {
  marker: SequenceMarker | null;
  selectedImage: MediaAsset | null;
  durationSec: number;
  onUpdate: (markerId: string, patch: Partial<SequenceMarker>) => void;
  onDelete: () => void;
  onChooseImage: () => void;
}) {
  if (!marker) {
    return (
      <section className="flex min-h-[220px] items-center justify-center rounded-md border border-surface-700 bg-surface-900/70 p-4 text-center text-sm text-slate-500">
        Select or add a marker.
      </section>
    );
  }

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
          Image
          <button
            type="button"
            className="flex min-h-14 w-full items-center gap-2 rounded-md border border-surface-700 bg-surface-950 px-2 py-2 text-left text-sm font-normal normal-case tracking-normal text-slate-100 outline-none hover:border-surface-500 focus-visible:border-brand-400"
            onClick={onChooseImage}
          >
            {selectedImage?.thumbnailDataUrl ? (
              <img src={selectedImage.thumbnailDataUrl} alt="" className="h-10 w-10 shrink-0 rounded object-cover" />
            ) : (
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-surface-800 text-slate-500">
                <ImageIcon size={16} />
              </span>
            )}
            <span className="min-w-0 flex-1 truncate">{selectedImage ? selectedImage.name : 'Choose from media or import'}</span>
          </button>
          {selectedImage && (
            <button type="button" className="self-start text-[11px] font-normal normal-case tracking-normal text-slate-400 hover:text-slate-100" onClick={() => onUpdate(marker.id, { imageAssetId: null })}>
              Clear image
            </button>
          )}
        </div>
        <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          Shot Prompt
          <textarea
            value={marker.prompt}
            onChange={(event) => onUpdate(marker.id, { prompt: event.target.value })}
            className="min-h-[116px] resize-none rounded-md border border-surface-700 bg-surface-950 px-2 py-2 text-sm font-normal normal-case tracking-normal text-slate-100 outline-none focus:border-brand-400"
          />
        </label>
      </div>
    </section>
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
          asset.mimeType,
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
              <div className="text-sm font-semibold text-slate-100">Pick marker image</div>
              <div className="text-xs text-slate-400">Choose an image from media or import a new one.</div>
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
              Import
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
              No images match this search.
            </div>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-2">
              {filteredAssets.map((asset) => {
                const selected = asset.id === selectedId;
                return (
                  <button
                    key={asset.id}
                    type="button"
                    className={`group overflow-hidden rounded-lg border bg-white/[0.03] text-left transition ${selected ? 'border-brand-300 ring-1 ring-brand-300/70' : 'border-white/10 hover:border-white/25 hover:bg-white/[0.06]'}`}
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
                      {selected && (
                        <span className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-brand-400 text-slate-950">
                          <Check size={12} />
                        </span>
                      )}
                    </div>
                    <div className="px-2 py-1.5">
                      <div className="truncate text-xs font-medium text-slate-100">{asset.name}</div>
                      <div className="mt-0.5 text-[10px] text-slate-500">{asset.width && asset.height ? `${asset.width}x${asset.height}` : asset.mimeType}</div>
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
    durationSec: duration,
    overallPrompt: '',
    markers: [],
  };
}

function normalizeSequence(sequence: SequenceAssetData): SequenceAssetData {
  return {
    ...sequence,
    durationSec: Math.max(1, sequence.durationSec),
    markers: sequence.markers
      .map((marker) => ({ ...marker, timeSec: clampTime(marker.timeSec, sequence.durationSec) }))
      .sort((a, b) => a.timeSec - b.timeSec),
  };
}

function durationsForModel(model: VideoModelDefinition): number[] {
  return model.capabilities.durations.map((duration) => Number(duration.replace('s', ''))).filter((duration) => Number.isFinite(duration));
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
