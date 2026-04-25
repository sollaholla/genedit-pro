import type { Clip } from '@/types';
import { EyeOff } from 'lucide-react';
import { clipTimelineDurationSec } from '@/lib/timeline/operations';
import { timeToPx } from '@/lib/timeline/geometry';
import type { KeyframePropertyRow, KeyframeSelection } from './keyframeModel';
import {
  KEYFRAME_COMPONENT_ROW_HEIGHT_PX,
  KEYFRAME_PROPERTY_ROW_HEIGHT_PX,
  KEYFRAME_TITLE_HEIGHT_PX,
  laneHeightForClip,
} from './keyframeModel';

type DragKeyframeMeta = KeyframeSelection & {
  timeSec: number;
  value: number;
};

type KeyframeFrameGroup = {
  frame: number;
  timeSec: number;
  members: Array<KeyframeSelection & { timeSec: number; value: number }>;
};

export function KeyframeTrackLane({
  clip,
  pxPerSec,
  fps,
  selectedKeyframe,
  rows,
  onDeselectKeyframe,
  onBeginKeyframeDrag,
  onMoveKeyframe,
  onMoveKeyframeGroup,
  onSelectKeyframe,
  onSelectKeyframeGroup,
  onEmptyMouseDown,
}: {
  clip: Clip;
  pxPerSec: number;
  fps: number;
  selectedKeyframe: KeyframeSelection | null;
  rows: KeyframePropertyRow[];
  onDeselectKeyframe: () => void;
  onBeginKeyframeDrag: () => void;
  onMoveKeyframe: (meta: DragKeyframeMeta) => void;
  onMoveKeyframeGroup: (meta: { members: KeyframeSelection[]; timeSec: number }) => void;
  onSelectKeyframe: (meta: KeyframeSelection & { timeSec: number }) => void;
  onSelectKeyframeGroup: (meta: { members: KeyframeSelection[]; timeSec: number }) => void;
  onEmptyMouseDown?: (e: React.MouseEvent) => void;
}) {
  if (rows.length === 0) return null;
  const groupedRows = groupRows(rows);
  const frameGroups = buildFrameGroups(rows, fps, clip.id);
  const selectedFrame = findSelectedFrame(rows, selectedKeyframe, fps, clip.id);
  const durationSec = Math.max(1e-6, clipTimelineDurationSec(clip));
  const clipLeftPx = timeToPx(clip.startSec, pxPerSec);
  const clipWidthPx = Math.max(48, timeToPx(durationSec, pxPerSec));

  return (
    <div
      className="border-b border-surface-800 bg-surface-950/80"
      style={{ height: laneHeightForClip(rows.length, groupedRows.length) }}
      onMouseDown={(e) => {
        if (e.target !== e.currentTarget) return;
        onDeselectKeyframe();
        onEmptyMouseDown?.(e);
      }}
    >
      <div
        className="relative"
        style={{ height: KEYFRAME_TITLE_HEIGHT_PX }}
        onMouseDown={(e) => {
          if (e.target !== e.currentTarget) return;
          onDeselectKeyframe();
          onEmptyMouseDown?.(e);
        }}
      >
        <div
          className="absolute bottom-0"
          style={{ left: clipLeftPx, width: clipWidthPx, height: KEYFRAME_TITLE_HEIGHT_PX }}
          onMouseDown={(e) => {
            if (e.target !== e.currentTarget) return;
            onDeselectKeyframe();
            onEmptyMouseDown?.(e);
          }}
        >
          {frameGroups.map((group) => {
            const selected = selectedFrame === group.frame;
            const left = Math.max(0, Math.min(clipWidthPx, timeToPx(group.timeSec, pxPerSec)));
            return (
              <button
                key={`frame-${group.frame}`}
                type="button"
                className="absolute bottom-0 flex h-4 w-5 -translate-x-1/2 items-center justify-center rounded-t outline-none"
                style={{ left }}
                title={`${group.members.length} keyframe${group.members.length === 1 ? '' : 's'} at frame ${group.frame}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onSelectKeyframeGroup({
                    members: group.members,
                    timeSec: group.timeSec,
                  });
                  const rail = e.currentTarget.parentElement;
                  if (!rail) return;
                  onBeginKeyframeDrag();
                  const move = (ev: MouseEvent) => {
                    const rect = rail.getBoundingClientRect();
                    const localPx = Math.max(0, Math.min(rect.width, ev.clientX - rect.left));
                    const nextFrame = Math.round((localPx / pxPerSec) * fps);
                    const nextTimeSec = Math.max(0, Math.min(durationSec, nextFrame / fps));
                    onMoveKeyframeGroup({
                      members: group.members,
                      timeSec: nextTimeSec,
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
                <span
                  className={`h-2 w-2 rotate-45 rounded-[2px] border ${
                    selected
                      ? 'border-amber-100 bg-amber-300 shadow-[0_0_0_3px_rgba(251,191,36,0.24)]'
                      : 'border-violet-200 bg-violet-400/90'
                  }`}
                />
              </button>
            );
          })}
        </div>
      </div>
      {groupedRows.map((group) => (
        <div key={`body-group-${group.componentId}`}>
          <div
            className="border-y border-surface-800/70 bg-surface-900/30"
            style={{ height: KEYFRAME_COMPONENT_ROW_HEIGHT_PX }}
            onMouseDown={(e) => {
              if (e.target !== e.currentTarget) return;
              onDeselectKeyframe();
              onEmptyMouseDown?.(e);
            }}
          />
          {group.rows.map((row) => (
            <div
              key={row.label}
              className="relative border-b border-surface-800/70 bg-[#090f1d]"
              style={{ height: KEYFRAME_PROPERTY_ROW_HEIGHT_PX }}
              onMouseDown={(e) => {
                if (e.target !== e.currentTarget) return;
                onDeselectKeyframe();
                onEmptyMouseDown?.(e);
              }}
            >
              <div
                className="absolute border-x border-brand-400/35 bg-brand-500/10"
                style={{
                  left: clipLeftPx,
                  width: clipWidthPx,
                  top: 0,
                  bottom: 0,
                }}
                onMouseDown={(e) => {
                  if (e.target !== e.currentTarget) return;
                  onDeselectKeyframe();
                  onEmptyMouseDown?.(e);
                }}
              >
                <div className="pointer-events-none absolute left-0 right-0 top-1/2 h-px -translate-y-1/2 bg-slate-600/45" />
                {row.points.map((keyframe) => {
                  const frame = Math.round(keyframe.timeSec * fps);
                  const selected = selectedFrame === frame ||
                    (selectedKeyframe?.keyframeId === keyframe.id &&
                      selectedKeyframe.clipId === clip.id &&
                      selectedKeyframe.componentId === row.componentId &&
                      selectedKeyframe.property === row.property);
                  const left = Math.max(0, Math.min(clipWidthPx, timeToPx(keyframe.timeSec, pxPerSec)));
                  return (
                    <button
                      key={keyframe.id}
                      type="button"
                      className="absolute top-1/2 flex h-5 w-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full outline-none"
                      style={{ left }}
                      title={`${row.label} at ${keyframe.timeSec.toFixed(2)}s`}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        onSelectKeyframe({
                          componentIndex: row.componentIndex,
                          componentId: row.componentId,
                          clipId: clip.id,
                          property: row.property,
                          keyframeId: keyframe.id,
                          timeSec: keyframe.timeSec,
                        });
                        const rail = e.currentTarget.parentElement;
                        if (!rail) return;
                        onBeginKeyframeDrag();
                        const move = (ev: MouseEvent) => {
                          const rect = rail.getBoundingClientRect();
                          const localPx = Math.max(0, Math.min(rect.width, ev.clientX - rect.left));
                          onMoveKeyframe({
                            componentIndex: row.componentIndex,
                            componentId: row.componentId,
                            clipId: clip.id,
                            property: row.property,
                            keyframeId: keyframe.id,
                            timeSec: Math.max(0, Math.min(durationSec, localPx / pxPerSec)),
                            value: keyframe.value,
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
                      <span
                        className={`block h-2.5 w-2.5 rotate-45 rounded-[2px] border ${
                          selected
                            ? 'border-amber-100 bg-amber-300 shadow-[0_0_0_3px_rgba(251,191,36,0.25)]'
                            : 'border-violet-200 bg-violet-400'
                        }`}
                      />
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export function KeyframeSidebarLane({
  rows,
  showTitle = true,
  onHideTrackKeyframes,
}: {
  rows: KeyframePropertyRow[];
  showTitle?: boolean;
  onHideTrackKeyframes?: () => void;
}) {
  if (rows.length === 0) return null;
  const groupedRows = groupRows(rows);
  return (
    <div
      className="border-b border-surface-800 bg-surface-950/80 px-2"
      style={{ height: laneHeightForClip(rows.length, groupedRows.length) }}
    >
      <div
        className="flex items-center justify-between text-[10px] font-semibold uppercase tracking-wider text-slate-500"
        style={{ height: KEYFRAME_TITLE_HEIGHT_PX }}
      >
        {showTitle ? (
          <>
            <span>Keyframes</span>
            {onHideTrackKeyframes && (
              <button
                type="button"
                className="inline-flex h-5 w-5 items-center justify-center rounded text-slate-500 hover:bg-surface-800 hover:text-slate-200"
                title="Hide keyframe lanes for this track"
                onClick={onHideTrackKeyframes}
              >
                <EyeOff size={12} />
              </button>
            )}
          </>
        ) : null}
      </div>
      {groupedRows.map((group) => (
        <div key={`side-group-${group.componentId}`}>
          <div
            className="flex items-center rounded-t border-x border-t border-surface-800 bg-surface-900/80 px-2 text-[11px] font-medium text-slate-300"
            style={{ height: KEYFRAME_COMPONENT_ROW_HEIGHT_PX }}
          >
            {`Transform ${group.componentIndex + 1}`}
          </div>
          {group.rows.map((row) => (
            <div
              key={row.label}
              className="flex items-center border-x border-t border-surface-800/80 bg-surface-900/45 px-2 pl-4 text-[11px] text-slate-400 last:border-b"
              style={{ height: KEYFRAME_PROPERTY_ROW_HEIGHT_PX }}
            >
              {row.label.split('.').at(-1)}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function groupRows(rows: KeyframePropertyRow[]) {
  const groups: Array<{ componentId: string; componentIndex: number; rows: KeyframePropertyRow[] }> = [];
  for (const row of rows) {
    const last = groups.at(-1);
    if (last?.componentId === row.componentId) {
      last.rows.push(row);
    } else {
      groups.push({ componentId: row.componentId, componentIndex: row.componentIndex, rows: [row] });
    }
  }
  return groups;
}

function buildFrameGroups(rows: KeyframePropertyRow[], fps: number, clipId: string): KeyframeFrameGroup[] {
  const safeFps = Math.max(1, fps);
  const groups = new Map<number, KeyframeFrameGroup>();
  for (const row of rows) {
    for (const point of row.points) {
      const frame = Math.round(point.timeSec * safeFps);
      const existing = groups.get(frame);
      const member = {
        clipId,
        componentIndex: row.componentIndex,
        componentId: row.componentId,
        property: row.property,
        keyframeId: point.id,
        timeSec: point.timeSec,
        value: point.value,
      };
      if (existing) {
        existing.members.push(member);
      } else {
        groups.set(frame, {
          frame,
          timeSec: frame / safeFps,
          members: [member],
        });
      }
    }
  }
  return [...groups.values()].sort((a, b) => a.frame - b.frame);
}

function findSelectedFrame(rows: KeyframePropertyRow[], selected: KeyframeSelection | null, fps: number, clipId: string): number | null {
  if (!selected) return null;
  if (selected.clipId !== clipId) return null;
  const row = rows.find((candidate) => (
    candidate.componentId === selected.componentId &&
    candidate.property === selected.property
  ));
  const point = row?.points.find((candidate) => candidate.id === selected.keyframeId);
  return point ? Math.round(point.timeSec * Math.max(1, fps)) : null;
}
