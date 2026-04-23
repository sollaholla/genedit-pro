import { useMemo } from 'react';
import { RULER_HEIGHT_PX, timeToPx } from '@/lib/timeline/geometry';
import { useProjectStore } from '@/state/projectStore';
import { usePlaybackStore } from '@/state/playbackStore';

type Props = {
  pxPerSec: number;
  durationSec: number;
  viewportWidth: number;
  scrollLeft: number;
  onScrub: (timeSec: number) => void;
};

const BUFFER_BAR_HEIGHT = 2;

function niceStep(pxPerSec: number): number {
  const targetPx = 100;
  const rawSec = targetPx / pxPerSec;
  const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  for (const s of steps) if (s >= rawSec) return s;
  return steps[steps.length - 1]!;
}

export function TimelineRuler({ pxPerSec, durationSec, viewportWidth, scrollLeft, onScrub }: Props) {
  const pause = usePlaybackStore((s) => s.pause);
  const step = niceStep(pxPerSec);
  const visibleEndSec = (scrollLeft + viewportWidth) / pxPerSec + step;
  const displayDuration = Math.max(durationSec + 5, visibleEndSec);

  const ticks = useMemo(() => {
    const out: { t: number; major: boolean }[] = [];
    const minor = step / 5;
    for (let t = 0; t <= displayDuration; t += minor) {
      const isMajor = Math.abs(t / step - Math.round(t / step)) < 1e-6;
      out.push({ t, major: isMajor });
    }
    return out;
  }, [step, displayDuration]);

  return (
    <div
      className="relative shrink-0 border-b border-surface-700 bg-surface-900 no-select"
      style={{ height: RULER_HEIGHT_PX, width: displayDuration * pxPerSec }}
      onMouseDown={(e) => {
        pause();
        const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
        const move = (ev: MouseEvent) => {
          const x = ev.clientX - rect.left;
          onScrub(Math.max(0, x / pxPerSec));
        };
        move(e.nativeEvent);
        const up = () => {
          window.removeEventListener('mousemove', move);
          window.removeEventListener('mouseup', up);
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
      }}
    >
      {ticks.map(({ t, major }, i) => (
        <div
          key={i}
          className={major ? 'absolute bottom-0 w-px bg-slate-500' : 'absolute bottom-0 w-px bg-surface-600'}
          style={{
            left: timeToPx(t, pxPerSec),
            height: major ? RULER_HEIGHT_PX - 8 : 6,
          }}
        />
      ))}
      {ticks
        .filter((tk) => tk.major)
        .map(({ t }, i) => (
          <div
            key={`l-${i}`}
            className="absolute top-1 text-[10px] font-mono text-slate-400"
            style={{ left: timeToPx(t, pxPerSec) + 3 }}
          >
            {formatTickLabel(t)}
          </div>
        ))}
      <BufferBar pxPerSec={pxPerSec} />
    </div>
  );
}

/**
 * Thin green strip at the bottom of the ruler showing which timeline ranges
 * have a buffered/ready clip — similar to Premiere's render bar. Ranges come
 * from clips whose media element has readyState >= HAVE_FUTURE_DATA, as
 * published by PreviewPlayer on each RAF frame.
 */
function BufferBar({ pxPerSec }: { pxPerSec: number }) {
  const clips = useProjectStore((s) => s.project.clips);
  const readiness = usePlaybackStore((s) => s.clipReadiness);

  const segments = useMemo(() => {
    return clips
      .filter((c) => readiness[c.id])
      .map((c) => ({
        id: c.id,
        left: timeToPx(c.startSec, pxPerSec),
        width: Math.max(1, timeToPx(c.outSec - c.inSec, pxPerSec)),
      }));
  }, [clips, readiness, pxPerSec]);

  return (
    <div
      className="pointer-events-none absolute left-0 right-0"
      style={{ bottom: 0, height: BUFFER_BAR_HEIGHT }}
      title="Buffered / ready to play"
    >
      {segments.map((s) => (
        <div
          key={s.id}
          className="absolute bg-emerald-500/80"
          style={{ left: s.left, width: s.width, height: '100%' }}
        />
      ))}
    </div>
  );
}

function formatTickLabel(t: number): string {
  if (t >= 60) {
    const m = Math.floor(t / 60);
    const s = (t % 60).toFixed(0).padStart(2, '0');
    return `${m}:${s}`;
  }
  if (t >= 10) return `${t.toFixed(0)}s`;
  if (t >= 1) return `${t.toFixed(1)}s`;
  return `${(t * 1000).toFixed(0)}ms`;
}
