import type { Clip } from '@/types';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { clipTimelineDurationSec } from '@/lib/timeline/operations';
import { timeToPx } from '@/lib/timeline/geometry';
import { getTransformComponents, normalizedToValue, valueToNormalized } from '@/lib/components/transform';
import type { KeyframePropertyRow, KeyframeSelection } from './keyframeModel';
import { getKeyframeProperties, laneHeightForClip } from './keyframeModel';

const GRAPH_WIDTH = 500;
const GRAPH_HEIGHT = 32;
const PLOT_TOP = 5;
const PLOT_BOTTOM = 27;

type DragKeyframeMeta = KeyframeSelection & {
  timeSec: number;
  value: number;
};

export function KeyframeTrackLane({
  clip,
  pxPerSec,
  selectedKeyframe,
  collapsedComponents,
  onDeselectKeyframe,
  onBeginKeyframeDrag,
  onMoveKeyframe,
  onSelectKeyframe,
}: {
  clip: Clip;
  pxPerSec: number;
  selectedKeyframe: KeyframeSelection | null;
  collapsedComponents: Set<number>;
  onDeselectKeyframe: () => void;
  onBeginKeyframeDrag: () => void;
  onMoveKeyframe: (meta: DragKeyframeMeta) => void;
  onSelectKeyframe: (meta: KeyframeSelection & { timeSec: number }) => void;
}) {
  const transforms = getTransformComponents(clip);
  const properties = getKeyframeProperties(clip);
  if (transforms.length === 0 || properties.length === 0) return null;
  const componentsWithKeyframes = transforms
    .map((component, componentIndex) => ({ component, componentIndex }))
    .filter(({ componentIndex }) => properties.some((row) => row.componentIndex === componentIndex));
  const visibleRows = properties.filter((property) => !collapsedComponents.has(property.componentIndex)).length;
  const laneHeight = laneHeightForClip(visibleRows, componentsWithKeyframes.length);
  const durationSec = Math.max(1e-6, clipTimelineDurationSec(clip));
  const clipLeftPx = timeToPx(clip.startSec, pxPerSec);
  const clipWidthPx = Math.max(48, timeToPx(durationSec, pxPerSec));

  return (
    <div
      className="border-b border-surface-800 bg-surface-950/80"
      style={{ height: laneHeight }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onDeselectKeyframe();
      }}
    >
      <div className="flex h-full flex-col">
        <div className="h-[18px] px-1 pt-0.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Keyframes</div>
        <div className="min-h-0 flex-1 overflow-auto pr-1">
          {componentsWithKeyframes.map(({ componentIndex }) => {
            const collapsed = collapsedComponents.has(componentIndex);
            const groupRows = properties.filter((row) => row.componentIndex === componentIndex);
            return (
              <div key={`body-group-${componentIndex}`}>
                <div className="mb-0.5 h-[20px] border-y border-surface-800/70 bg-surface-900/30" />
                {!collapsed && groupRows.map((row) => (
                  <div
                    key={row.label}
                    className="mb-0.5 border-y border-surface-800/80 bg-surface-900/40"
                    onMouseDown={(e) => {
                      if (e.target === e.currentTarget) onDeselectKeyframe();
                    }}
                  >
                    <div className="relative h-[28px] overflow-hidden bg-[#090f1d]">
                      <div
                        className="absolute inset-y-0 border border-brand-400/40 bg-brand-500/10"
                        style={{ left: clipLeftPx, width: clipWidthPx }}
                      >
                        <svg className="h-full w-full" viewBox={`0 0 ${GRAPH_WIDTH} ${GRAPH_HEIGHT}`} preserveAspectRatio="none">
                          <line x1="0" x2={GRAPH_WIDTH} y1={valueToY(row.baseValue, row)} y2={valueToY(row.baseValue, row)} stroke="#334155" strokeWidth="1" />
                          {row.points.length > 1 && (
                            <polyline
                              points={[...row.points]
                                .sort((a, b) => a.timeSec - b.timeSec)
                                .map((keyframe) => `${timeToGraphX(keyframe.timeSec, durationSec)},${valueToY(keyframe.value, row)}`)
                                .join(' ')}
                              fill="none"
                              stroke="#7dd3fc"
                              strokeWidth="1.5"
                            />
                          )}
                          {row.points.map((keyframe) => {
                            const selected = selectedKeyframe?.keyframeId === keyframe.id &&
                              selectedKeyframe.componentIndex === row.componentIndex &&
                              selectedKeyframe.property === row.property;
                            return (
                              <g
                                key={keyframe.id}
                                className="cursor-move"
                                onMouseDown={(e) => {
                                  e.stopPropagation();
                                  onSelectKeyframe({
                                    componentIndex: row.componentIndex,
                                    property: row.property,
                                    keyframeId: keyframe.id,
                                    timeSec: keyframe.timeSec,
                                  });
                                  const svg = (e.currentTarget as SVGGElement).ownerSVGElement;
                                  if (!svg) return;
                                  onBeginKeyframeDrag();
                                  const move = (ev: MouseEvent) => {
                                    const rect = svg.getBoundingClientRect();
                                    const xNorm = Math.max(0, Math.min(1, (ev.clientX - rect.left) / Math.max(1, rect.width)));
                                    const yNorm = 1 - Math.max(0, Math.min(1, (ev.clientY - rect.top - PLOT_TOP) / Math.max(1, PLOT_BOTTOM - PLOT_TOP)));
                                    onMoveKeyframe({
                                      componentIndex: row.componentIndex,
                                      property: row.property,
                                      keyframeId: keyframe.id,
                                      timeSec: xNorm * durationSec,
                                      value: roundTransformValue(row.property, normalizedToValue(yNorm, row.range)),
                                    });
                                  };
                                  const up = () => {
                                    window.removeEventListener('mousemove', move);
                                    window.removeEventListener('mouseup', up);
                                  };
                                  window.addEventListener('mousemove', move);
                                  window.addEventListener('mouseup', up);
                                }}
                              >
                                <circle
                                  cx={timeToGraphX(keyframe.timeSec, durationSec)}
                                  cy={valueToY(keyframe.value, row)}
                                  r="9"
                                  fill="transparent"
                                />
                                <circle
                                  cx={timeToGraphX(keyframe.timeSec, durationSec)}
                                  cy={valueToY(keyframe.value, row)}
                                  r={selected ? 5.2 : 4}
                                  fill={selected ? '#fbbf24' : '#a78bfa'}
                                  stroke={selected ? '#fef3c7' : '#c4b5fd'}
                                  strokeWidth="1"
                                  pointerEvents="none"
                                />
                              </g>
                            );
                          })}
                        </svg>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function KeyframeSidebarLane({
  clip,
  collapsedComponents,
  onToggleComponent,
}: {
  clip: Clip | null;
  collapsedComponents: Set<number>;
  onToggleComponent: (componentIndex: number) => void;
}) {
  if (!clip) return null;
  const components = getTransformComponents(clip);
  const properties = getKeyframeProperties(clip);
  if (properties.length === 0) return null;
  const componentsWithKeyframes = components
    .map((component, componentIndex) => ({ component, componentIndex }))
    .filter(({ componentIndex }) => properties.some((row) => row.componentIndex === componentIndex));
  const visibleRows = properties.filter((property) => !collapsedComponents.has(property.componentIndex)).length;
  return (
    <div
      className="border-b border-surface-800 bg-surface-950/80 px-2"
      style={{ height: laneHeightForClip(visibleRows, componentsWithKeyframes.length) }}
    >
      <div className="h-[18px] text-[10px] font-semibold uppercase tracking-wider text-slate-500">Keyframes</div>
      <div className="max-h-[220px] overflow-auto pr-1">
        {componentsWithKeyframes.map(({ componentIndex }) => {
          const groupRows = properties.filter((row) => row.componentIndex === componentIndex);
          const collapsed = collapsedComponents.has(componentIndex);
          const Chevron = collapsed ? ChevronRight : ChevronDown;
          return (
            <div key={`group-${componentIndex}`} className="mb-0.5">
              <button
                type="button"
                className="flex h-[20px] w-full items-center justify-between rounded border border-surface-800 bg-surface-900/70 px-1.5 text-left text-[11px] font-medium text-slate-300"
                onClick={() => onToggleComponent(componentIndex)}
              >
                <span>{`Transform ${componentIndex + 1}`}</span>
                <Chevron size={12} className="text-slate-500" />
              </button>
              {!collapsed && (
                <div>
                  {groupRows.map((row) => (
                    <div key={row.label} className="mb-0.5 flex h-[28px] items-center rounded bg-surface-900/70 px-1.5 pl-4 text-[11px] text-slate-400">
                      {row.label.split('.').at(-1)}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function timeToGraphX(timeSec: number, durationSec: number): number {
  const localSec = Math.max(0, Math.min(durationSec, timeSec));
  return Math.max(6, Math.min(GRAPH_WIDTH - 6, (localSec / durationSec) * GRAPH_WIDTH));
}

function valueToY(value: number, row: KeyframePropertyRow): number {
  const normalized = valueToNormalized(value, row.range);
  return PLOT_BOTTOM - normalized * (PLOT_BOTTOM - PLOT_TOP);
}

function roundTransformValue(property: KeyframePropertyRow['property'], value: number): number {
  if (property === 'scale') return Math.max(0.01, Math.round(value * 1000) / 1000);
  return Math.round(value * 10) / 10;
}
