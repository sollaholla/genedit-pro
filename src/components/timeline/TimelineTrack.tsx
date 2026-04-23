import type { Clip, Track } from '@/types';
import { TRACK_HEIGHT_PX, pxToTime } from '@/lib/timeline/geometry';
import { TimelineClip, type ClipDragSide } from './TimelineClip';
import { useMediaStore } from '@/state/mediaStore';

type Props = {
  track: Track;
  clips: Clip[];
  pxPerSec: number;
  selectedClipId: string | null;
  contentWidth: number;
  onDropAsset: (trackId: string, assetId: string, startSec: number) => void;
  onClipBodyMouseDown: (clipId: string, e: React.MouseEvent) => void;
  onClipTrimMouseDown: (clipId: string, side: ClipDragSide, e: React.MouseEvent) => void;
  onClipSelect: (clipId: string | null) => void;
};

export function TimelineTrack({
  track,
  clips,
  pxPerSec,
  selectedClipId,
  contentWidth,
  onDropAsset,
  onClipBodyMouseDown,
  onClipTrimMouseDown,
  onClipSelect,
}: Props) {
  const assets = useMediaStore((s) => s.assets);
  const assetById = new Map(assets.map((a) => [a.id, a]));

  return (
    <div
      className="relative border-b border-surface-800 bg-surface-950/40"
      style={{ height: TRACK_HEIGHT_PX, width: contentWidth }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('application/x-genedit-asset')) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        }
      }}
      onDrop={(e) => {
        const assetId = e.dataTransfer.getData('application/x-genedit-asset');
        if (!assetId) return;
        e.preventDefault();
        const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
        const startSec = Math.max(0, pxToTime(e.clientX - rect.left, pxPerSec));
        onDropAsset(track.id, assetId, startSec);
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClipSelect(null);
      }}
    >
      {clips.map((clip) => (
        <TimelineClip
          key={clip.id}
          clip={clip}
          asset={assetById.get(clip.assetId)}
          trackKind={track.kind}
          pxPerSec={pxPerSec}
          height={TRACK_HEIGHT_PX}
          selected={selectedClipId === clip.id}
          onBodyMouseDown={onClipBodyMouseDown}
          onTrimMouseDown={onClipTrimMouseDown}
        />
      ))}
    </div>
  );
}
