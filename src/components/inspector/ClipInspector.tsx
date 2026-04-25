import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, BookOpen, Contrast, Diamond, Eye, EyeOff, Film, GripVertical, Image as ImageIcon, Music, Palette, Plus, RotateCcw, Search, SlidersHorizontal, Trash2, Volume2, X } from 'lucide-react';
import { useProjectStore } from '@/state/projectStore';
import { usePlaybackStore } from '@/state/playbackStore';
import { useMediaStore } from '@/state/mediaStore';
import { clipSpeed, clipTimelineDurationSec, setClipProp } from '@/lib/timeline/operations';
import { resetEnvelope, setEnvelopeEnabled } from '@/lib/timeline/envelope';
import { formatTimecode } from '@/lib/timeline/geometry';
import type { Clip, ColorCorrectionComponentData, ColorCorrectionComponentInstance, ColorWheelValue, ComponentInstance, TransformComponentInstance } from '@/types';
import {
  COLOR_CORRECTION_PRESETS,
  clampWheel,
  createDefaultColorCorrectionComponent,
  normalizeColorCorrectionData,
} from '@/lib/components/colorCorrection';
import {
  addTransformKeyframeAtTime,
  createDefaultTransformComponent,
  getClipComponents,
  getTransformComponents,
  keyframeComponentVisibilityKey,
  reorderComponents,
  resolveTransformComponentAtTime,
  setTransformPropertyAtTime,
  type TransformProperty,
} from '@/lib/components/transform';

const kindIcon = { video: Film, audio: Music, image: ImageIcon, recipe: BookOpen };
const SPEED_SLIDER_MIN = 0.25;
const SPEED_SLIDER_MAX = 3;

function speedTickPercent(value: number): number {
  return ((value - SPEED_SLIDER_MIN) / (SPEED_SLIDER_MAX - SPEED_SLIDER_MIN)) * 100;
}

type ProjectHistoryMode = 'normal' | 'silent';

function useProjectHistoryGesture() {
  const beginTx = useProjectStore((s) => s.beginTx);
  const activeRef = useRef(false);

  useEffect(() => () => {
    activeRef.current = false;
  }, []);

  return {
    beginHistoryGesture: () => {
      if (activeRef.current) return;
      activeRef.current = true;
      beginTx();
    },
    endHistoryGesture: () => {
      activeRef.current = false;
    },
  };
}

export function ClipInspector() {
  const [componentPickerOpen, setComponentPickerOpen] = useState(false);
  const [componentSearch, setComponentSearch] = useState('');
  const [draggingComponentId, setDraggingComponentId] = useState<string | null>(null);
  const [focusedComponentId, setFocusedComponentId] = useState<string | null>(null);
  const selectedClipIds = usePlaybackStore((s) => s.selectedClipIds);
  const currentTime = usePlaybackStore((s) => s.currentTimeSec);
  const activeTransformComponentId = usePlaybackStore((s) => s.activeTransformComponentId);
  const setActiveTransformComponentId = usePlaybackStore((s) => s.setActiveTransformComponentId);
  const visibleKeyframeComponentKeys = usePlaybackStore((s) => s.visibleKeyframeComponentKeys);
  const showKeyframeComponent = usePlaybackStore((s) => s.showKeyframeComponent);
  const toggleKeyframeComponent = usePlaybackStore((s) => s.toggleKeyframeComponent);
  const hideKeyframeComponent = usePlaybackStore((s) => s.hideKeyframeComponent);
  const selectedId = selectedClipIds.length === 1 ? selectedClipIds[0]! : null;
  const clipAudioLevel = usePlaybackStore((s) => (selectedId ? s.clipAudioLevels[selectedId] : undefined));
  const project = useProjectStore((s) => s.project);
  const update = useProjectStore((s) => s.update);
  const updateSilent = useProjectStore((s) => s.updateSilent);
  const assets = useMediaStore((s) => s.assets);
  const speedGesture = useProjectHistoryGesture();
  const clipVolumeGesture = useProjectHistoryGesture();

  useEffect(() => {
    setFocusedComponentId(null);
  }, [selectedId]);

  if (selectedClipIds.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-slate-500">
        Select a clip on the timeline to inspect it.
      </div>
    );
  }
  if (selectedClipIds.length > 1 || !selectedId) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-slate-400">
        <div className="font-semibold text-slate-200">{selectedClipIds.length} clips selected</div>
        <div className="text-[11px] text-slate-500">
          Select a single clip to edit its properties.
        </div>
      </div>
    );
  }

  const clip = project.clips.find((c) => c.id === selectedId);
  if (!clip) return null;

  const asset = assets.find((a) => a.id === clip.assetId);
  const track = project.tracks.find((candidate) => candidate.id === clip.trackId);
  const isVisualClip = track?.kind === 'video';
  const fps = project.fps;
  const timelineDuration = clipTimelineDurationSec(clip);
  const speed = clipSpeed(clip);
  const Icon = asset ? kindIcon[asset.kind] : Film;

  const setVolume = (v: number, mode: ProjectHistoryMode = 'normal') => {
    const apply = mode === 'silent' ? updateSilent : update;
    apply((p) => setClipProp(p, selectedId, 'volume', v));
  };
  const setSpeed = (nextSpeed: number, mode: ProjectHistoryMode = 'normal') => {
    const apply = mode === 'silent' ? updateSilent : update;
    apply((p) => setClipProp(p, selectedId, 'speed', nextSpeed));
  };
  const envelopeEnabled = clip.volumeEnvelope?.enabled ?? false;
  const hasCustomEnvelope =
    !!clip.volumeEnvelope &&
    (clip.volumeEnvelope.points.length !== 2 ||
      clip.volumeEnvelope.points.some((p) => p.v !== 1 || p.curvature !== 0));
  const components = getClipComponents(clip);
  const transformComponents = getTransformComponents(clip);
  const componentOptions = [
    { id: 'transform', label: 'Transform', description: 'Position/scale offsets and keyframes.' },
    { id: 'colorCorrection', label: 'Color Correction', description: 'Lift, gamma, gain, and image tone controls.' },
  ];
  const filteredComponentOptions = componentOptions.filter((option) => (
    `${option.label} ${option.description}`.toLowerCase().includes(componentSearch.trim().toLowerCase())
  ));

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* Asset info */}
      <div className="flex items-start gap-3">
        {asset?.thumbnailDataUrl ? (
          <img
            src={asset.thumbnailDataUrl}
            alt=""
            className="h-14 w-20 shrink-0 rounded object-cover"
          />
        ) : (
          <div className="flex h-14 w-20 shrink-0 items-center justify-center rounded bg-surface-700 text-slate-400">
            <Icon size={20} />
          </div>
        )}
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-slate-200">
            {asset?.name ?? 'Missing asset'}
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-[11px] text-slate-400">
            <Icon size={11} />
            <span>{asset?.kind ?? '—'}</span>
            {asset?.width && <span>{asset.width}×{asset.height}</span>}
          </div>
        </div>
      </div>

      <Divider />

      {/* Clip timing */}
      <Section label="Timing">
        <Row label="Start">{formatTimecode(clip.startSec, fps)}</Row>
        <Row label="Duration">{formatTimecode(timelineDuration, fps)}</Row>
        <Row label="In">{formatTimecode(clip.inSec, fps)}</Row>
        <Row label="Out">{formatTimecode(clip.outSec, fps)}</Row>
        <div className="mt-2 space-y-2 rounded border border-surface-700 bg-surface-900/50 p-2.5">
          <div className="flex items-center justify-between">
            <label className="text-xs text-slate-400">Speed</label>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="inline-flex h-6 w-6 items-center justify-center rounded bg-surface-700 text-slate-300 hover:bg-surface-600 hover:text-slate-100 disabled:cursor-not-allowed disabled:opacity-35"
                title="Reset speed"
                disabled={Math.abs(speed - 1) < 0.001}
                onClick={() => setSpeed(1)}
              >
                <RotateCcw size={11} />
              </button>
              <span className="font-mono text-xs text-slate-200">{speed.toFixed(2)}x</span>
            </div>
          </div>
          <input
            type="range"
            min={SPEED_SLIDER_MIN}
            max={SPEED_SLIDER_MAX}
            step={0.05}
            value={speed}
            onPointerUp={speedGesture.endHistoryGesture}
            onPointerCancel={speedGesture.endHistoryGesture}
            onKeyUp={speedGesture.endHistoryGesture}
            onBlur={speedGesture.endHistoryGesture}
            onChange={(e) => {
              const next = Number(e.target.value);
              speedGesture.beginHistoryGesture();
              setSpeed(next, 'silent');
            }}
            className="volume-slider w-full"
          />
          <div className="flex justify-between text-[10px] text-slate-500">
            <div className="relative h-4 w-full">
              <span className="absolute left-0">0.25x</span>
              <span className="absolute -translate-x-1/2" style={{ left: `${speedTickPercent(1)}%` }}>1.0x</span>
              <span className="absolute right-0">3.0x</span>
            </div>
          </div>
          <p className="text-[10px] text-slate-500">
            Pitch is preserved during preview/export; slower rates are smoothed asynchronously.
          </p>
        </div>
      </Section>

      <Divider />

      {/* Volume */}
      <Section label="Audio">
        <div className="space-y-3 rounded border border-surface-700 bg-surface-900/50 p-2.5">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="flex items-center gap-1.5 text-xs text-slate-400">
                <Volume2 size={12} />
                Master Volume
              </label>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="inline-flex h-6 w-6 items-center justify-center rounded bg-surface-700 text-slate-300 hover:bg-surface-600 hover:text-slate-100 disabled:cursor-not-allowed disabled:opacity-35"
                  title="Reset clip volume"
                  disabled={Math.abs((clip.volume ?? 1) - 1) < 0.001}
                  onClick={() => setVolume(1)}
                >
                  <RotateCcw size={11} />
                </button>
                <span className="font-mono text-xs text-slate-300">
                  {Math.round((clip.volume ?? 1) * 100)}%
                </span>
              </div>
            </div>
            <input
              type="range"
              min={0}
              max={200}
              step={1}
              value={Math.round((clip.volume ?? 1) * 100)}
              onPointerUp={clipVolumeGesture.endHistoryGesture}
              onPointerCancel={clipVolumeGesture.endHistoryGesture}
              onKeyUp={clipVolumeGesture.endHistoryGesture}
              onBlur={clipVolumeGesture.endHistoryGesture}
              onChange={(e) => {
                clipVolumeGesture.beginHistoryGesture();
                setVolume(Number(e.target.value) / 100, 'silent');
              }}
              className="volume-slider w-full"
            />
            <div className="flex justify-between text-[10px] text-slate-500">
              <span>0%</span>
              <span>100%</span>
              <span>200%</span>
            </div>
            <ClipStereoMeter level={clipAudioLevel} />
          </div>
          <EnvelopeControls
            clipId={selectedId}
            enabled={envelopeEnabled}
            hasCustomEnvelope={hasCustomEnvelope}
          />
        </div>
      </Section>

      {/* Source asset info */}
      {asset && (
        <>
          <Divider />
          <Section label="Source">
            <Row label="Duration">{formatTimecode(asset.durationSec, fps)}</Row>
            {asset.mimeType && <Row label="Format">{asset.mimeType.split('/')[1]?.toUpperCase()}</Row>}
          </Section>
        </>
      )}

      <Divider />

      <Section label="Components">
        <div className="space-y-2">
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded bg-surface-700 px-2 py-1 text-[11px] text-slate-200 hover:bg-surface-600 disabled:opacity-40"
              disabled={!isVisualClip}
              onClick={() => setComponentPickerOpen(true)}
            >
              <Plus size={12} />
              Add
            </button>
          </div>
          {componentPickerOpen && (
            <div className="rounded border border-surface-700 bg-surface-900 p-2.5">
              <div className="mb-2 flex items-center gap-1.5 rounded border border-surface-600 bg-surface-800 px-2 py-1">
                <Search size={12} className="text-slate-500" />
                <input
                  value={componentSearch}
                  onChange={(e) => setComponentSearch(e.target.value)}
                  placeholder="Search components..."
                  className="min-w-0 flex-1 bg-transparent text-xs text-slate-100 outline-none"
                />
                <button
                  type="button"
                  className="text-slate-500 hover:text-slate-200"
                  onClick={() => {
                    setComponentPickerOpen(false);
                    setComponentSearch('');
                  }}
                  title="Close"
                >
                  <X size={12} />
                </button>
              </div>
              {filteredComponentOptions.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className="mb-1 block w-full rounded border border-surface-700 bg-surface-800 px-2 py-1 text-left text-xs text-slate-200 hover:bg-surface-700"
                  onClick={() => {
                    if (option.id === 'transform') {
                      const nextComponent = createDefaultTransformComponent();
                      update((p) => setClipProp(p, selectedId, 'components', [...components, nextComponent]));
                      setActiveTransformComponentId(nextComponent.id);
                      setFocusedComponentId(nextComponent.id);
                    } else if (option.id === 'colorCorrection') {
                      const nextComponent = createDefaultColorCorrectionComponent();
                      update((p) => setClipProp(p, selectedId, 'components', [...components, nextComponent]));
                      setActiveTransformComponentId(null);
                      setFocusedComponentId(nextComponent.id);
                    }
                    setComponentPickerOpen(false);
                    setComponentSearch('');
                  }}
                >
                  <div className="font-medium">{option.label}</div>
                  <div className="text-[10px] text-slate-400">{option.description}</div>
                </button>
              ))}
              {filteredComponentOptions.length === 0 && (
                <div className="rounded border border-dashed border-surface-700 px-2 py-2 text-[11px] text-slate-500">No matching components.</div>
              )}
            </div>
          )}
          {components.length === 0 && (
            <div className="rounded border border-dashed border-surface-600 bg-surface-900/30 p-2.5 text-[11px] text-slate-500">
              No components on this clip yet.
            </div>
          )}
          {components.map((component, idx) => {
            const setComponents = (next: ComponentInstance[]) => update((p) => setClipProp(p, selectedId, 'components', next));
            const moveComponent = (toIndex: number) => {
              update((p) => ({
                ...p,
                clips: p.clips.map((candidate) => (
                  candidate.id === selectedId ? reorderComponents(candidate, idx, toIndex) : candidate
                )),
              }));
              setFocusedComponentId(component.id);
              if (component.type === 'transform') setActiveTransformComponentId(component.id);
            };
            const removeComponent = () => {
              const next = components.filter((candidate) => candidate.id !== component.id);
              setComponents(next);
              if (component.type === 'transform') {
                const nextTransform = next.filter((candidate) => candidate.type === 'transform').at(-1);
                if (activeTransformComponentId === component.id) setActiveTransformComponentId(nextTransform?.id ?? null);
                hideKeyframeComponent(keyframeComponentVisibilityKey(selectedId, component.id));
              }
              if (focusedComponentId === component.id) setFocusedComponentId(next.at(-1)?.id ?? null);
            };
            const dragProps = {
              onDragOver: (e: DragEvent<HTMLDivElement>) => {
                if (!draggingComponentId || draggingComponentId === component.id) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
              },
              onDrop: (e: DragEvent<HTMLDivElement>) => {
                e.preventDefault();
                const fromIndex = components.findIndex((candidate) => candidate.id === draggingComponentId);
                if (fromIndex >= 0 && fromIndex !== idx) {
                  update((p) => ({
                    ...p,
                    clips: p.clips.map((candidate) => (
                      candidate.id === selectedId ? reorderComponents(candidate, fromIndex, idx) : candidate
                    )),
                  }));
                }
                setDraggingComponentId(null);
              },
              onDragEnd: () => setDraggingComponentId(null),
            };

            if (component.type === 'colorCorrection') {
              return (
                <ColorCorrectionCard
                  key={component.id}
                  component={component}
                  index={idx}
                  total={components.length}
                  dragProps={dragProps}
                  onFocus={() => {
                    setFocusedComponentId(component.id);
                    setActiveTransformComponentId(null);
                  }}
                  onStartDrag={() => setDraggingComponentId(component.id)}
                  onMove={moveComponent}
                  onRemove={removeComponent}
                  onChange={(data, mode = 'normal') => {
                    setFocusedComponentId(component.id);
                    const apply = mode === 'silent' ? updateSilent : update;
                    apply((p) => ({
                      ...p,
                      clips: p.clips.map((candidate) => (
                        candidate.id === selectedId
                          ? {
                            ...candidate,
                            components: getClipComponents(candidate).map((item) => (
                              item.id === component.id && item.type === 'colorCorrection'
                                ? { ...item, data }
                                : item
                            )),
                          }
                        : candidate
                      )),
                    }));
                  }}
                />
              );
            }

            return (
              <TransformComponentCard
                key={component.id}
                component={component}
                index={idx}
                transformIndex={transformComponents.findIndex((candidate) => candidate.id === component.id)}
                total={components.length}
                clip={clip}
                clipId={selectedId}
                currentTime={currentTime}
                keyframesVisible={visibleKeyframeComponentKeys.includes(keyframeComponentVisibilityKey(selectedId, component.id))}
                dragProps={dragProps}
                onFocus={() => {
                  setFocusedComponentId(component.id);
                  setActiveTransformComponentId(component.id);
                }}
                onStartDrag={() => setDraggingComponentId(component.id)}
                onMove={moveComponent}
                onRemove={removeComponent}
                onToggleKeyframes={() => toggleKeyframeComponent(keyframeComponentVisibilityKey(selectedId, component.id))}
                onShowKeyframes={() => showKeyframeComponent(keyframeComponentVisibilityKey(selectedId, component.id))}
              />
            );
          })}
        </div>
      </Section>
    </div>
  );
}

type ComponentDragProps = {
  onDragOver: (e: DragEvent<HTMLDivElement>) => void;
  onDrop: (e: DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
};

function TransformComponentCard({
  component,
  index,
  transformIndex,
  total,
  clip,
  clipId,
  currentTime,
  keyframesVisible,
  dragProps,
  onFocus,
  onStartDrag,
  onMove,
  onRemove,
  onToggleKeyframes,
  onShowKeyframes,
}: {
  component: TransformComponentInstance;
  index: number;
  transformIndex: number;
  total: number;
  clip: Clip;
  clipId: string;
  currentTime: number;
  keyframesVisible: boolean;
  dragProps: ComponentDragProps;
  onFocus: () => void;
  onStartDrag: () => void;
  onMove: (toIndex: number) => void;
  onRemove: () => void;
  onToggleKeyframes: () => void;
  onShowKeyframes: () => void;
}) {
  const update = useProjectStore((s) => s.update);
  const updateSilent = useProjectStore((s) => s.updateSilent);
  const { beginHistoryGesture, endHistoryGesture } = useProjectHistoryGesture();
  const resolvedTransform = resolveTransformComponentAtTime(clip, component, currentTime);
  const hasKeyframes = hasTransformKeyframes(component);

  const setPropertyAtPlayhead = (property: TransformProperty, value: number, mode: ProjectHistoryMode = 'normal') => {
    const apply = mode === 'silent' ? updateSilent : update;
    apply((p) => ({
      ...p,
      clips: p.clips.map((candidate) => (
        candidate.id === clipId
          ? setTransformPropertyAtTime(candidate, { componentId: component.id, property }, currentTime, value)
          : candidate
      )),
    }));
    onFocus();
  };

  const addPropertyKeyframe = (property: TransformProperty) => {
    update((p) => ({
      ...p,
      clips: p.clips.map((candidate) => (
        candidate.id === clipId
          ? addTransformKeyframeAtTime(candidate, { componentId: component.id, property }, currentTime)
          : candidate
      )),
    }));
    onFocus();
    onShowKeyframes();
  };

  return (
    <div
      className="space-y-3 rounded border border-surface-700 bg-surface-900/50 p-2.5"
      onClick={onFocus}
      {...dragProps}
    >
      <ComponentHeader
        title="Transform"
        icon={<SlidersHorizontal size={12} />}
        index={transformIndex >= 0 ? transformIndex + 1 : index + 1}
        onStartDrag={onStartDrag}
        onRemove={onRemove}
        onMove={onMove}
        indexInStack={index}
        total={total}
      >
        <button
          type="button"
          className={`inline-flex h-6 w-6 items-center justify-center rounded ${
            keyframesVisible
              ? 'bg-brand-500 text-white hover:bg-brand-400'
              : 'bg-surface-700 text-slate-200 hover:bg-surface-600'
          } disabled:cursor-not-allowed disabled:opacity-40`}
          title={hasKeyframes ? (keyframesVisible ? 'Hide keyframes in timeline' : 'Show keyframes in timeline') : 'Add keyframes first'}
          disabled={!hasKeyframes}
          onClick={(e) => {
            e.stopPropagation();
            onToggleKeyframes();
          }}
        >
          {keyframesVisible ? <Eye size={11} /> : <EyeOff size={11} />}
        </button>
        <button
          type="button"
          className="inline-flex h-6 w-6 items-center justify-center rounded bg-surface-700 text-slate-200 hover:bg-surface-600"
          title="Add transform keyframes and show them"
          onClick={(e) => {
            e.stopPropagation();
            ['scale', 'offsetX', 'offsetY'].forEach((property) => addPropertyKeyframe(property as TransformProperty));
          }}
        >
          <Diamond size={10} />
        </button>
      </ComponentHeader>

      <div className="grid grid-cols-2 gap-2 text-xs">
        <label className="space-y-1">
          <span className="text-slate-400">Offset X</span>
          <input
            type="number"
            value={Math.round(resolvedTransform.offsetX)}
            onChange={(e) => setPropertyAtPlayhead('offsetX', Number(e.target.value) || 0)}
            className="w-full rounded border border-surface-600 bg-surface-800 px-2 py-1 text-slate-200"
          />
        </label>
        <label className="space-y-1">
          <span className="text-slate-400">Offset Y</span>
          <input
            type="number"
            value={Math.round(resolvedTransform.offsetY)}
            onChange={(e) => setPropertyAtPlayhead('offsetY', Number(e.target.value) || 0)}
            className="w-full rounded border border-surface-600 bg-surface-800 px-2 py-1 text-slate-200"
          />
        </label>
      </div>
      <div className="flex items-center justify-between text-xs">
        <span className="text-slate-400">Scale</span>
        <span className="font-mono text-slate-200">{Math.round(resolvedTransform.scale * 100)}%</span>
      </div>
      <input
        type="range"
        min={25}
        max={200}
        step={1}
        value={Math.round(resolvedTransform.scale * 100)}
        onChange={(e) => {
          beginHistoryGesture();
          setPropertyAtPlayhead('scale', Number(e.target.value) / 100, 'silent');
        }}
        onPointerUp={endHistoryGesture}
        onPointerCancel={endHistoryGesture}
        onKeyUp={endHistoryGesture}
        onBlur={endHistoryGesture}
        className="volume-slider w-full"
      />
      <div className="flex items-center gap-2">
        <button type="button" className="rounded bg-surface-700 px-2 py-1 text-[11px] text-slate-200 hover:bg-surface-600" onClick={() => setPropertyAtPlayhead('scale', 1)}>Reset Scale</button>
        <button type="button" className="rounded bg-surface-700 px-2 py-1 text-[11px] text-slate-200 hover:bg-surface-600" onClick={() => {
          setPropertyAtPlayhead('offsetX', 0);
          setPropertyAtPlayhead('offsetY', 0);
        }}>Reset Position</button>
      </div>
    </div>
  );
}

function ColorCorrectionCard({
  component,
  index,
  total,
  dragProps,
  onFocus,
  onStartDrag,
  onMove,
  onRemove,
  onChange,
}: {
  component: ColorCorrectionComponentInstance;
  index: number;
  total: number;
  dragProps: ComponentDragProps;
  onFocus: () => void;
  onStartDrag: () => void;
  onMove: (toIndex: number) => void;
  onRemove: () => void;
  onChange: (data: ColorCorrectionComponentData, mode?: ProjectHistoryMode) => void;
}) {
  const data = normalizeColorCorrectionData(component.data);
  const updateData = (patch: Partial<ColorCorrectionComponentData>, mode: ProjectHistoryMode = 'normal') => {
    onFocus();
    onChange(normalizeColorCorrectionData({
      ...data,
      ...patch,
      presetId: patch.presetId ?? undefined,
    }), mode);
  };

  return (
    <div
      className="space-y-3 rounded border border-surface-700 bg-surface-900/50 p-2.5"
      onClick={onFocus}
      {...dragProps}
    >
      <ComponentHeader
        title="Color Correction"
        icon={<Palette size={12} />}
        index={index + 1}
        onStartDrag={onStartDrag}
        onRemove={onRemove}
        onMove={onMove}
        indexInStack={index}
        total={total}
      />

      <div className="flex flex-wrap gap-1.5">
        {COLOR_CORRECTION_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            className={`rounded-full border px-2 py-1 text-[10px] font-medium ${
              data.presetId === preset.id
                ? 'border-emerald-400 bg-emerald-500/20 text-emerald-100'
                : 'border-surface-600 bg-surface-800 text-slate-300 hover:border-surface-500'
            }`}
            onClick={(e) => {
              e.stopPropagation();
              onFocus();
              onChange(normalizeColorCorrectionData(preset.data));
            }}
          >
            {preset.label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-2">
        <ColorWheelControl label="Lift" value={data.lift} onChange={(lift, mode) => updateData({ lift }, mode)} />
        <ColorWheelControl label="Gamma" value={data.gammaWheel} onChange={(gammaWheel, mode) => updateData({ gammaWheel }, mode)} />
        <ColorWheelControl label="Gain" value={data.gain} onChange={(gain, mode) => updateData({ gain }, mode)} />
      </div>

      <div className="space-y-2">
        <ToneSlider
          icon={<SunIcon />}
          label="Brightness"
          value={Math.round(data.brightness * 100)}
          min={-100}
          max={100}
          step={1}
          suffix="%"
          onChange={(value, mode) => updateData({ brightness: value / 100 }, mode)}
        />
        <ToneSlider
          icon={<Contrast size={12} />}
          label="Contrast"
          value={Math.round(data.contrast * 100)}
          min={0}
          max={200}
          step={1}
          suffix="%"
          onChange={(value, mode) => updateData({ contrast: value / 100 }, mode)}
        />
        <ToneSlider
          icon={<Palette size={12} />}
          label="Saturation"
          value={Math.round(data.saturation * 100)}
          min={0}
          max={200}
          step={1}
          suffix="%"
          onChange={(value, mode) => updateData({ saturation: value / 100 }, mode)}
        />
        <ToneSlider
          icon={<SlidersHorizontal size={12} />}
          label="Gamma"
          value={Math.round(data.gamma * 100)}
          min={25}
          max={300}
          step={1}
          suffix="%"
          onChange={(value, mode) => updateData({ gamma: value / 100 }, mode)}
        />
      </div>

      <button
        type="button"
        className="inline-flex items-center gap-1.5 rounded bg-surface-700 px-2 py-1 text-[11px] text-slate-200 hover:bg-surface-600"
        onClick={(e) => {
          e.stopPropagation();
          onChange(normalizeColorCorrectionData(COLOR_CORRECTION_PRESETS[0]!.data));
        }}
      >
        <RotateCcw size={11} />
        Reset grade
      </button>
    </div>
  );
}

function ComponentHeader({
  title,
  icon,
  index,
  children,
  onStartDrag,
  onRemove,
  onMove,
  indexInStack,
  total,
}: {
  title: string;
  icon: ReactNode;
  index: number;
  children?: ReactNode;
  onStartDrag: () => void;
  onRemove: () => void;
  onMove: (toIndex: number) => void;
  indexInStack: number;
  total: number;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            draggable
            className="inline-flex h-6 w-5 shrink-0 cursor-grab items-center justify-center rounded text-slate-500 hover:bg-surface-800 hover:text-slate-300 active:cursor-grabbing"
            title="Drag to reorder"
            onDragStart={(e) => {
              onStartDrag();
              e.dataTransfer.effectAllowed = 'move';
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <GripVertical size={13} />
          </button>
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="text-slate-400">{icon}</span>
            <span className="whitespace-nowrap text-[10px] font-semibold uppercase tracking-wider text-slate-300">{title}</span>
            <span className="rounded bg-surface-800 px-1 font-mono text-[9px] leading-4 text-slate-400">#{index}</span>
          </div>
        </div>
        <button
          type="button"
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded bg-surface-700 text-red-300 hover:bg-surface-600"
          title="Remove"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        >
          <Trash2 size={11} />
        </button>
      </div>
      <div className="flex items-center justify-end gap-1.5">
        <div className="flex shrink-0 items-center gap-1.5">
          {children}
          <button
            type="button"
            className="inline-flex h-6 w-6 items-center justify-center rounded bg-surface-700 text-slate-200 hover:bg-surface-600 disabled:opacity-40"
            disabled={indexInStack === 0}
            title="Move up"
            onClick={(e) => {
              e.stopPropagation();
              onMove(indexInStack - 1);
            }}
          >
            <ArrowUp size={11} />
          </button>
          <button
            type="button"
            className="inline-flex h-6 w-6 items-center justify-center rounded bg-surface-700 text-slate-200 hover:bg-surface-600 disabled:opacity-40"
            disabled={indexInStack === total - 1}
            title="Move down"
            onClick={(e) => {
              e.stopPropagation();
              onMove(indexInStack + 1);
            }}
          >
            <ArrowDown size={11} />
          </button>
        </div>
      </div>
    </div>
  );
}

function ColorWheelControl({
  label,
  value,
  onChange,
}: {
  label: string;
  value: ColorWheelValue;
  onChange: (value: ColorWheelValue, mode?: ProjectHistoryMode) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const { beginHistoryGesture, endHistoryGesture } = useProjectHistoryGesture();
  const normalized = clampWheel(value);

  const commitFromPointer = (clientX: number, clientY: number, mode: ProjectHistoryMode = 'normal') => {
    const node = ref.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const radius = rect.width / 2;
    const x = (clientX - (rect.left + radius)) / radius;
    const y = (clientY - (rect.top + radius)) / radius;
    onChange(clampWheel({ x, y }), mode);
  };

  return (
    <div className="space-y-1 text-center">
      <div
        ref={ref}
        role="slider"
        aria-label={`${label} color balance`}
        aria-valuetext={`${Math.round(normalized.x * 100)}, ${Math.round(normalized.y * 100)}`}
        tabIndex={0}
        className="relative aspect-square w-full cursor-crosshair rounded-full border border-surface-600 p-1 shadow-inner shadow-black/60"
        style={{
          background: 'conic-gradient(from 0deg, #f43f5e, #f59e0b, #84cc16, #22c55e, #06b6d4, #3b82f6, #a855f7, #f43f5e)',
        }}
        onPointerDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          beginHistoryGesture();
          commitFromPointer(e.clientX, e.clientY, 'silent');
          const onMove = (event: PointerEvent) => commitFromPointer(event.clientX, event.clientY, 'silent');
          const onUp = () => {
            endHistoryGesture();
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            window.removeEventListener('pointercancel', onUp);
          };
          window.addEventListener('pointermove', onMove);
          window.addEventListener('pointerup', onUp);
          window.addEventListener('pointercancel', onUp);
        }}
        onDoubleClick={(e) => {
          e.stopPropagation();
          onChange({ x: 0, y: 0 });
        }}
      >
        <div className="absolute inset-[7px] rounded-full bg-surface-950/90 ring-1 ring-white/10" />
        <div className="absolute left-1/2 top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-slate-400/80" />
        <div
          className="absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/80 bg-slate-200 shadow"
          style={{
            left: `${50 + normalized.x * 42}%`,
            top: `${50 + normalized.y * 42}%`,
          }}
        />
      </div>
      <div className="text-[10px] font-medium text-slate-300">{label}</div>
    </div>
  );
}

function ToneSlider({
  icon,
  label,
  value,
  min,
  max,
  step,
  suffix,
  onChange,
}: {
  icon: ReactNode;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix: string;
  onChange: (value: number, mode?: ProjectHistoryMode) => void;
}) {
  const { beginHistoryGesture, endHistoryGesture } = useProjectHistoryGesture();

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <label className="flex items-center gap-1.5 text-slate-400">
          {icon}
          {label}
        </label>
        <span className="font-mono text-slate-200">{value}{suffix}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onPointerUp={endHistoryGesture}
        onPointerCancel={endHistoryGesture}
        onKeyUp={endHistoryGesture}
        onBlur={endHistoryGesture}
        onChange={(e) => {
          beginHistoryGesture();
          onChange(Number(e.target.value), 'silent');
        }}
        className="volume-slider w-full"
      />
    </div>
  );
}

function SunIcon() {
  return (
    <span className="inline-block h-3 w-3 rounded-full border border-current" />
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">{label}</div>
      {children}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="text-slate-400">{label}</span>
      <span className="font-mono text-slate-200">{children}</span>
    </div>
  );
}

function Divider() {
  return <div className="h-px bg-surface-700" />;
}

function hasTransformKeyframes(component: TransformComponentInstance): boolean {
  return component.data.keyframes.scale.length > 0 ||
    component.data.keyframes.offsetX.length > 0 ||
    component.data.keyframes.offsetY.length > 0;
}

function ClipStereoMeter({ level }: { level?: { left: number; right: number } }) {
  const left = Math.max(0, Math.min(1, level?.left ?? 0));
  const right = Math.max(0, Math.min(1, level?.right ?? 0));
  return (
    <div className="rounded border border-surface-700 bg-surface-950/50 px-2 py-1.5">
      <ClipMeterRow label="L" value={left} />
      <ClipMeterRow label="R" value={right} />
    </div>
  );
}

function ClipMeterRow({ label, value }: { label: string; value: number }) {
  const pct = Math.round(value * 100);
  const color = value > 0.9 ? 'bg-red-500' : value > 0.72 ? 'bg-amber-400' : 'bg-emerald-400';
  return (
    <div className="grid grid-cols-[12px_1fr_28px] items-center gap-2 text-[10px] text-slate-500">
      <span className="font-mono">{label}</span>
      <div className="relative h-1.5 overflow-hidden rounded-full bg-surface-700">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
        <div className="absolute inset-y-0 left-[75%] w-px bg-white/20" />
        <div className="absolute inset-y-0 left-[90%] w-px bg-white/25" />
      </div>
      <span className="text-right font-mono text-slate-500">{pct}%</span>
    </div>
  );
}

function EnvelopeControls({
  clipId,
  enabled,
  hasCustomEnvelope,
}: {
  clipId: string;
  enabled: boolean;
  hasCustomEnvelope: boolean;
}) {
  const update = useProjectStore((s) => s.update);
  const [confirmingReset, setConfirmingReset] = useState(false);

  const toggle = () => update((p) => setEnvelopeEnabled(p, clipId, !enabled));
  const doReset = () => {
    update((p) => resetEnvelope(p, clipId));
    setConfirmingReset(false);
  };

  return (
    <div className="space-y-2">
      <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-300">
        <input
          type="checkbox"
          className="h-3.5 w-3.5 accent-brand-500"
          checked={enabled}
          onChange={toggle}
        />
        Enable Editable Curve
      </label>

      {enabled && (
        <>
          <p className="text-[10px] leading-tight text-slate-500">
            Click the curve to add a point, drag points to move them,
            drag segment midpoints to bend, and right-click for options.
          </p>
          {confirmingReset ? (
            <div className="flex items-center justify-between gap-2 rounded bg-surface-800 p-2">
              <span className="text-[11px] text-slate-300">Reset this curve?</span>
              <div className="flex gap-1.5">
                <button
                  type="button"
                  className="rounded bg-surface-700 px-2 py-0.5 text-[11px] text-slate-300 hover:bg-surface-600"
                  onClick={() => setConfirmingReset(false)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="rounded bg-brand-500 px-2 py-0.5 text-[11px] text-white hover:bg-brand-400"
                  onClick={doReset}
                >
                  Reset
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="flex items-center gap-1.5 text-[11px] text-slate-400 hover:text-slate-200 disabled:opacity-40"
              disabled={!hasCustomEnvelope}
              onClick={() => setConfirmingReset(true)}
            >
              <RotateCcw size={11} />
              Reset curve
            </button>
          )}
        </>
      )}
    </div>
  );
}

// Intentionally a named export so React DevTools show the component name.
export function VolumeSliderStyles() {
  return null;
}
