import { useCallback, useMemo } from 'react';
import type { Clip, MediaAsset } from '@/types';
import { timeToPx, pxToTime, SNAP_TOLERANCE_PX, snapTime } from '@/lib/timeline/geometry';
import { useProjectStore } from '@/state/projectStore';
import { usePlaybackStore } from '@/state/playbackStore';
import { moveClip, trimClipLeft, trimClipRight } from '@/lib/timeline/operations';

type Props = {
  clip: Clip;
  asset: MediaAsset | undefined;
  pxPerSec: number;
  height: number;
  selected: boolean;
  snapTargets: number[];
};

const HANDLE_WIDTH = 6;

export function TimelineClip({ clip, asset, pxPerSec, height, selected, snapTargets }: Props) {
  const duration = clip.outSec - clip.inSec;
  const left = timeToPx(clip.startSec, pxPerSec);
  const width = Math.max(4, timeToPx(duration, pxPerSec));
  const selectClip = usePlaybackStore((s) => s.selectClip);
  const update = useProjectStore((s) => s.update);

  const bg = useMemo(() => {
    if (!asset) return 'bg-surface-600';
    if (asset.kind === 'audio') return 'bg-clip-audio/80 hover:bg-clip-audio';
    if (asset.kind === 'image') return 'bg-clip-image/80 hover:bg-clip-image';
    return 'bg-clip-video/80 hover:bg-clip-video';
  }, [asset]);

  const onDragBody = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      const targetEl = (e.target as HTMLElement).closest('[data-role]');
      if (targetEl && (targetEl.getAttribute('data-role') === 'trim-l' ||
          targetEl.getAttribute('data-role') === 'trim-r')) return;

      e.preventDefault();
      e.stopPropagation();
      selectClip(clip.id);

      const startX = e.clientX;
      const origStart = clip.startSec;

      const move = (ev: MouseEvent) => {
        const dxPx = ev.clientX - startX;
        const dt = pxToTime(dxPx, pxPerSec);
        const candidate = Math.max(0, origStart + dt);
        const snapped = snapTime(candidate, snapTargets, pxPerSec, SNAP_TOLERANCE_PX);
        update((p) => moveClip(p, clip.id, snapped));
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    },
    [clip.id, clip.startSec, pxPerSec, selectClip, snapTargets, update],
  );

  const onTrim = useCallback(
    (side: 'l' | 'r') => (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      selectClip(clip.id);

      const startX = e.clientX;
      const origStart = clip.startSec;
      const origEnd = clip.startSec + (clip.outSec - clip.inSec);

      const move = (ev: MouseEvent) => {
        const dxPx = ev.clientX - startX;
        const dt = pxToTime(dxPx, pxPerSec);
        if (side === 'l') {
          const candidate = Math.max(0, origStart + dt);
          const snapped = snapTime(candidate, snapTargets, pxPerSec, SNAP_TOLERANCE_PX);
          update((p) => trimClipLeft(p, clip.id, snapped));
        } else {
          const candidate = origEnd + dt;
          const snapped = snapTime(candidate, snapTargets, pxPerSec, SNAP_TOLERANCE_PX);
          update((p) => trimClipRight(p, clip.id, snapped));
        }
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    },
    [clip.id, clip.inSec, clip.outSec, clip.startSec, pxPerSec, selectClip, snapTargets, update],
  );

  return (
    <div
      className={`absolute top-1 overflow-hidden rounded-sm text-[10px] text-white no-select ${bg} ${
        selected ? 'ring-2 ring-brand-400' : 'ring-1 ring-black/30'
      }`}
      style={{ left, width, height: height - 8 }}
      onMouseDown={onDragBody}
      data-clip-id={clip.id}
    >
      <div
        data-role="trim-l"
        className="absolute left-0 top-0 h-full cursor-ew-resize bg-black/30 hover:bg-white/30"
        style={{ width: HANDLE_WIDTH }}
        onMouseDown={onTrim('l')}
      />
      <div
        data-role="trim-r"
        className="absolute right-0 top-0 h-full cursor-ew-resize bg-black/30 hover:bg-white/30"
        style={{ width: HANDLE_WIDTH }}
        onMouseDown={onTrim('r')}
      />
      {asset?.thumbnailDataUrl && asset.kind !== 'audio' && width > 40 ? (
        <img
          src={asset.thumbnailDataUrl}
          alt=""
          className="pointer-events-none absolute inset-y-0 left-1.5 my-0.5 h-[calc(100%-4px)] rounded-sm object-cover opacity-70"
          draggable={false}
          style={{ width: Math.min(80, Math.max(20, width * 0.25)) }}
        />
      ) : null}
      <div className="pointer-events-none absolute inset-0 flex items-center px-2 font-medium">
        <span className="truncate">{asset?.name ?? 'missing asset'}</span>
      </div>
    </div>
  );
}
