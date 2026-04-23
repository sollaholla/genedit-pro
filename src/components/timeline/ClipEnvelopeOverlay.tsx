import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Clip, EnvelopePoint } from '@/types';
import {
  addEnvelopePoint,
  flattenEnvelopeSegmentAt,
  removeEnvelopePoint,
  segmentControlY,
  updateEnvelopePoint,
} from '@/lib/timeline/envelope';
import { useProjectStore } from '@/state/projectStore';

type Props = {
  clip: Clip;
  width: number;
  height: number;
};

type Menu = {
  x: number;
  y: number;
  kind: 'point' | 'segment';
  index: number;
};

const POINT_R = 4;
const HIT_R = 9;

export function ClipEnvelopeOverlay({ clip, width, height }: Props) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const updateSilent = useProjectStore((s) => s.updateSilent);
  const beginTx = useProjectStore((s) => s.beginTx);

  const env = clip.volumeEnvelope;
  const points = useMemo(() => env?.points ?? [], [env]);

  const toScreenX = useCallback((t: number) => t * width, [width]);
  const toScreenY = useCallback((v: number) => (1 - v) * height, [height]);

  // Dismiss menu on outside click / escape.
  useEffect(() => {
    if (!menu) return;
    const onDown = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  // Build the SVG path for the envelope curve.
  const pathD = useMemo(() => {
    if (points.length === 0) return '';
    const parts: string[] = [];
    parts.push(`M ${toScreenX(points[0]!.t)} ${toScreenY(points[0]!.v)}`);
    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[i]!;
      const p1 = points[i + 1]!;
      const cx = toScreenX((p0.t + p1.t) / 2);
      const cy = toScreenY(segmentControlY(p0, p1));
      parts.push(`Q ${cx} ${cy} ${toScreenX(p1.t)} ${toScreenY(p1.v)}`);
    }
    return parts.join(' ');
  }, [points, toScreenX, toScreenY]);

  // Shaded area under the curve (for visual weight, like FL Studio).
  const fillD = useMemo(() => {
    if (!pathD) return '';
    const last = points[points.length - 1]!;
    const first = points[0]!;
    return `${pathD} L ${toScreenX(last.t)} ${height} L ${toScreenX(first.t)} ${height} Z`;
  }, [pathD, points, height, toScreenX]);

  const clientToLocal = useCallback((clientX: number, clientY: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return { t: 0, v: 0 };
    const t = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const v = Math.max(0, Math.min(1, 1 - (clientY - rect.top) / rect.height));
    return { t, v };
  }, []);

  // Drag an existing point.
  const startPointDrag = useCallback((index: number, e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    beginTx();
    const move = (ev: MouseEvent) => {
      const { t, v } = clientToLocal(ev.clientX, ev.clientY);
      updateSilent((p) => updateEnvelopePoint(p, clip.id, index, { t, v }));
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }, [clip.id, beginTx, updateSilent, clientToLocal]);

  // Drag the midpoint handle of a segment to adjust its curvature.
  const startSegmentDrag = useCallback((index: number, e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const p0 = points[index];
    const p1 = points[index + 1];
    if (!p0 || !p1) return;
    beginTx();
    const move = (ev: MouseEvent) => {
      const { v } = clientToLocal(ev.clientX, ev.clientY);
      const midV = (p0.v + p1.v) / 2;
      // curvature ∈ [-1, 1]; v = midV + curvature * 0.5  →  c = (v - midV) * 2
      const c = Math.max(-1, Math.min(1, (v - midV) * 2));
      updateSilent((proj) => updateEnvelopePoint(proj, clip.id, index, { curvature: c }));
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }, [clip.id, points, beginTx, updateSilent, clientToLocal]);

  // Click on the curve line to add a new point at that position and begin
  // dragging it in the same gesture.
  const onCurveMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const { t, v } = clientToLocal(e.clientX, e.clientY);
    if (t <= 0 || t >= 1) return;

    // Determine the index the new point will occupy so we can drag it.
    let newIndex = points.length;
    for (let i = 0; i < points.length; i++) {
      if (points[i]!.t > t) { newIndex = i; break; }
    }

    beginTx();
    updateSilent((p) => addEnvelopePoint(p, clip.id, t, v));
    const move = (ev: MouseEvent) => {
      const next = clientToLocal(ev.clientX, ev.clientY);
      updateSilent((p) => updateEnvelopePoint(p, clip.id, newIndex, { t: next.t, v: next.v }));
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }, [clip.id, points, beginTx, updateSilent, clientToLocal]);

  const onPointContextMenu = useCallback((index: number, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, kind: 'point', index });
  }, []);

  const onSegmentContextMenu = useCallback((index: number, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, kind: 'segment', index });
  }, []);

  if (!env?.enabled || points.length < 2) return null;

  return (
    <>
      {/* The SVG itself is pointer-events: none so clicks on empty space fall
          through to the clip body (for drag/trim). Only the curve path and
          individual points/handles are interactive. */}
      <svg
        ref={svgRef}
        className="pointer-events-none absolute inset-0"
        width={width}
        height={height}
        style={{ overflow: 'visible' }}
      >
        {/* Shaded area under the curve (decorative, non-interactive) */}
        <path d={fillD} fill="rgba(255, 255, 255, 0.08)" stroke="none" />

        {/* Invisible thick hit area for the curve — click/drag to add a point */}
        <path
          d={pathD}
          fill="none"
          stroke="transparent"
          strokeWidth={12}
          style={{ cursor: 'copy', pointerEvents: 'stroke' }}
          onMouseDown={onCurveMouseDown}
        />
        {/* The visible curve on top */}
        <path
          d={pathD}
          fill="none"
          stroke="rgba(255, 255, 255, 0.9)"
          strokeWidth={1.5}
          pointerEvents="none"
        />

        {/* Segment midpoint handles (for curvature adjustment) */}
        {points.slice(0, -1).map((p0, i) => {
          const p1 = points[i + 1]!;
          const cx = toScreenX((p0.t + p1.t) / 2);
          const cy = toScreenY(segmentControlY(p0, p1));
          return (
            <circle
              key={`seg-${i}`}
              cx={cx}
              cy={cy}
              r={4}
              fill="rgba(255, 255, 255, 0.5)"
              stroke="none"
              style={{ cursor: 'ns-resize', pointerEvents: 'auto' }}
              onMouseDown={(e) => startSegmentDrag(i, e)}
              onContextMenu={(e) => onSegmentContextMenu(i, e)}
            />
          );
        })}

        {/* Endpoints / user points */}
        {points.map((p, i) => {
          const cx = toScreenX(p.t);
          const cy = toScreenY(p.v);
          const isEndpoint = i === 0 || i === points.length - 1;
          return (
            <g key={`pt-${i}`}>
              {/* Larger transparent hit target */}
              <circle
                cx={cx}
                cy={cy}
                r={HIT_R}
                fill="transparent"
                style={{ cursor: 'grab', pointerEvents: 'auto' }}
                onMouseDown={(e) => startPointDrag(i, e)}
                onContextMenu={(e) => onPointContextMenu(i, e)}
              />
              <circle
                cx={cx}
                cy={cy}
                r={POINT_R}
                fill="white"
                stroke="rgba(0,0,0,0.4)"
                strokeWidth={1}
                pointerEvents="none"
              />
              {isEndpoint && (
                <circle
                  cx={cx}
                  cy={cy}
                  r={POINT_R - 1.5}
                  fill="rgba(0,0,0,0.4)"
                  pointerEvents="none"
                />
              )}
            </g>
          );
        })}
      </svg>

      {menu && (
        <ContextMenu
          menu={menu}
          clip={clip}
          point={menu.kind === 'point' ? points[menu.index] : undefined}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  );
}

function ContextMenu({
  menu,
  clip,
  point,
  onClose,
}: {
  menu: Menu;
  clip: Clip;
  point: EnvelopePoint | undefined;
  onClose: () => void;
}) {
  const update = useProjectStore((s) => s.update);
  const isEndpoint =
    menu.kind === 'point' &&
    (menu.index === 0 || menu.index === (clip.volumeEnvelope?.points.length ?? 0) - 1);

  const items: { label: string; disabled?: boolean; run: () => void }[] = [];

  if (menu.kind === 'point') {
    items.push({ label: 'Reset (100%)', run: () => update((p) => updateEnvelopePoint(p, clip.id, menu.index, { v: 1 })) });
    items.push({ label: 'Mute (0%)', run: () => update((p) => updateEnvelopePoint(p, clip.id, menu.index, { v: 0 })) });
    items.push({
      label: 'Flatten',
      disabled: !point || point.curvature === 0,
      run: () => update((p) => updateEnvelopePoint(p, clip.id, menu.index, { curvature: 0 })),
    });
    items.push({
      label: 'Delete',
      disabled: isEndpoint,
      run: () => update((p) => removeEnvelopePoint(p, clip.id, menu.index)),
    });
  } else {
    items.push({ label: 'Flatten', run: () => update((p) => flattenEnvelopeSegmentAt(p, clip.id, menu.index)) });
  }

  return (
    <div
      className="fixed z-50 min-w-[140px] rounded-md border border-surface-600 bg-surface-800 py-1 text-xs text-slate-200 shadow-lg"
      style={{ left: menu.x, top: menu.y }}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) => (
        <button
          key={i}
          type="button"
          disabled={item.disabled}
          className="flex w-full items-center px-3 py-1.5 text-left hover:bg-surface-700 disabled:cursor-not-allowed disabled:opacity-40"
          onClick={() => { if (!item.disabled) { item.run(); onClose(); } }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
