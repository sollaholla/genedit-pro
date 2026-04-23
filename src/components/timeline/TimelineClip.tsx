import { useMemo } from 'react';
import type { Clip, MediaAsset } from '@/types';
import { timeToPx } from '@/lib/timeline/geometry';
import { ClipEnvelopeOverlay } from './ClipEnvelopeOverlay';

const HANDLE_WIDTH = 6;

export type ClipDragSide = 'l' | 'r';

type Props = {
  clip: Clip;
  asset: MediaAsset | undefined;
  trackKind: 'video' | 'audio';
  pxPerSec: number;
  height: number;
  selected: boolean;
  /** Render as a semi-transparent ghost (drag preview). */
  ghost?: boolean;
  /** Override the clip's startSec for rendering (used during ghost drag). */
  overrideStartSec?: number;
  onBodyMouseDown: (clipId: string, e: React.MouseEvent) => void;
  onTrimMouseDown: (clipId: string, side: ClipDragSide, e: React.MouseEvent) => void;
  onContextMenu: (clipId: string, e: React.MouseEvent) => void;
};

export function TimelineClip({
  clip,
  asset,
  trackKind,
  pxPerSec,
  height,
  selected,
  ghost = false,
  overrideStartSec,
  onBodyMouseDown,
  onTrimMouseDown,
  onContextMenu,
}: Props) {
  const startSec = overrideStartSec ?? clip.startSec;
  const duration = clip.outSec - clip.inSec;
  const left = timeToPx(startSec, pxPerSec);
  const width = Math.max(4, timeToPx(duration, pxPerSec));

  const bg = useMemo(() => {
    if (!asset) return 'bg-surface-600';
    // Color by track kind so video clips on audio tracks look like audio clips.
    if (trackKind === 'audio') return 'bg-clip-audio/80 hover:bg-clip-audio';
    if (asset.kind === 'image') return 'bg-clip-image/80 hover:bg-clip-image';
    return 'bg-clip-video/80 hover:bg-clip-video';
  }, [asset, trackKind]);

  return (
    <div
      className={`absolute top-1 overflow-hidden rounded-sm text-[10px] text-white no-select
        ${bg}
        ${selected && !ghost ? 'ring-2 ring-brand-400' : 'ring-1 ring-black/30'}
        ${ghost ? 'pointer-events-none opacity-60 ring-2 ring-brand-400 ring-dashed' : 'cursor-grab active:cursor-grabbing'}`}
      style={{ left, width, height: height - 8 }}
      draggable={false}
      onDragStart={(e) => e.preventDefault()}
      onMouseDown={ghost ? undefined : (e) => {
        const target = e.target as HTMLElement;
        const role = target.closest('[data-role]')?.getAttribute('data-role');
        if (role === 'trim-l' || role === 'trim-r') return;
        onBodyMouseDown(clip.id, e);
      }}
      onContextMenu={ghost ? undefined : (e) => onContextMenu(clip.id, e)}
      data-clip-id={clip.id}
    >
      {!ghost && (
        <>
          <div
            data-role="trim-l"
            className="absolute left-0 top-0 h-full cursor-ew-resize bg-black/30 hover:bg-white/30"
            style={{ width: HANDLE_WIDTH }}
            onMouseDown={(e) => { e.stopPropagation(); onTrimMouseDown(clip.id, 'l', e); }}
          />
          <div
            data-role="trim-r"
            className="absolute right-0 top-0 h-full cursor-ew-resize bg-black/30 hover:bg-white/30"
            style={{ width: HANDLE_WIDTH }}
            onMouseDown={(e) => { e.stopPropagation(); onTrimMouseDown(clip.id, 'r', e); }}
          />
        </>
      )}
      {asset?.thumbnailDataUrl && trackKind === 'audio' && width > 24 && (
        <img
          src={asset.thumbnailDataUrl}
          alt=""
          className="pointer-events-none absolute inset-0 h-full w-full object-cover opacity-45"
          draggable={false}
        />
      )}
      {asset?.thumbnailDataUrl && trackKind !== 'audio' && width > 40 && (
        <img
          src={asset.thumbnailDataUrl}
          alt=""
          className="pointer-events-none absolute inset-y-0 left-1.5 my-0.5 h-[calc(100%-4px)] rounded-sm object-cover opacity-70"
          draggable={false}
          style={{ width: Math.min(80, Math.max(20, width * 0.25)) }}
        />
      )}
      <div className="pointer-events-none absolute inset-0 flex items-center px-2 font-medium">
        <span className="truncate">{asset?.name ?? 'missing asset'}</span>
      </div>
      {!ghost && clip.volumeEnvelope?.enabled && (
        <ClipEnvelopeOverlay clip={clip} width={width} height={height - 8} />
      )}
    </div>
  );
}
