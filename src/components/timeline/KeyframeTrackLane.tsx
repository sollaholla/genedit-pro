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
  visibleProperties,
  onDeselectKeyframe,
  onBeginKeyframeDrag,
  onMoveKeyframe,
  onSelectKeyframe,
}: {
  clip: Clip;
  pxPerSec: number;
  selectedKeyframe: KeyframeSelection | null;
  visibleProperties: KeyframePropertyRow[];
  onDeselectKeyframe: () => void;
  onBeginKeyframeDrag: () => void;
  onMoveKeyframe: (meta: DragKeyframeMeta) => void;
  onSelectKeyframe: (meta: KeyframeSelection & { timeSec: number }) => void;
}) {
  const transforms = getTransformComponents(clip);
  if (transforms.length === 0) return null;
  const durationSec = Math.max(1e-6, clipTimelineDurationSec(clip));
  const clipLeftPx = timeToPx(clip.startSec, pxPerSec);
  const clipWidthPx = Math.max(48, timeToPx(durationSec, pxPerSec));

  return (
    <div
      className="border-b border-surface-800 bg-[#0c1222] py-1.5"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onDeselectKeyframe();
      }}
    >
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Keyframes</div>
      <div className="max-h-[220px] overflow-auto">
        {visibleProperties.map((row) => (
          <div
            key={row.label}
            className="mb-1 rounded border border-surface-800 bg-surface-900/80 px-0 py-1"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) onDeselectKeyframe();
            }}
          >
            <div className="relative h-8 overflow-hidden rounded bg-[#0a0f1c]">
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
                      <circle
                        key={keyframe.id}
                        cx={timeToGraphX(keyframe.timeSec, durationSec)}
                        cy={valueToY(keyframe.value, row)}
                        r={selected ? 5.2 : 4}
                        fill={selected ? '#fbbf24' : '#a78bfa'}
                        stroke={selected ? '#fef3c7' : '#c4b5fd'}
                        strokeWidth="1"
                        className="cursor-move"
                        onMouseDown={(e) => {
                          e.stopPropagation();
                          onSelectKeyframe({
                            componentIndex: row.componentIndex,
                            property: row.property,
                            keyframeId: keyframe.id,
                            timeSec: keyframe.timeSec,
                          });
                          const svg = (e.currentTarget as SVGCircleElement).ownerSVGElement;
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
                      />
                    );
                  })}
                </svg>
              </div>
            </div>
          </div>
        ))}
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
  return (
    <div
      className="border-b border-surface-800 bg-[#0c1222] px-2 py-1.5"
      style={{ height: laneHeightForClip(properties.filter((property) => !collapsedComponents.has(property.componentIndex)).length, components.length) }}
    >
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Keyframes</div>
      <div className="max-h-[220px] overflow-auto">
        {components.map((_, componentIndex) => {
          const groupRows = properties.filter((row) => row.componentIndex === componentIndex);
          const collapsed = collapsedComponents.has(componentIndex);
          const Chevron = collapsed ? ChevronRight : ChevronDown;
          return (
            <div key={`group-${componentIndex}`} className="mb-1 rounded border border-surface-800 bg-surface-900/70 px-1.5 py-1">
              <button
                type="button"
                className="mb-1 flex w-full items-center justify-between text-left text-[11px] font-medium text-slate-300"
                onClick={() => onToggleComponent(componentIndex)}
              >
                <span>{`Transform ${componentIndex + 1}`}</span>
                <Chevron size={12} className="text-slate-500" />
              </button>
              {!collapsed && (
                <div className="space-y-1 pl-3">
                  {groupRows.map((row) => (
                    <div key={row.label} className="rounded bg-surface-900/80 px-1.5 py-0.5 text-[11px] text-slate-400">
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
