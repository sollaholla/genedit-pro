import { timeToPx } from '@/lib/timeline/geometry';

type Props = {
  timeSec: number;
  pxPerSec: number;
  height: number;
  offsetLeft: number;
};

export function Playhead({ timeSec, pxPerSec, height, offsetLeft }: Props) {
  const left = offsetLeft + timeToPx(timeSec, pxPerSec);
  return (
    <div
      className="pointer-events-none absolute top-0 z-20"
      style={{ left, height }}
    >
      <div className="h-full w-px bg-brand-400 shadow-[0_0_6px_rgba(124,140,255,0.6)]" />
      <div
        className="absolute -top-1 -translate-x-1/2"
        style={{ left: 0 }}
      >
        <div className="h-0 w-0 border-x-[5px] border-t-[6px] border-x-transparent border-t-brand-400" />
      </div>
    </div>
  );
}
