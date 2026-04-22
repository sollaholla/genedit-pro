import type { Clip, Track } from '@/types';
import { TRACK_HEIGHT_PX, pxToTime } from '@/lib/timeline/geometry';
import { TimelineClip } from './TimelineClip';
import { useProjectStore } from '@/state/projectStore';
import { usePlaybackStore } from '@/state/playbackStore';
import { useMediaStore } from '@/state/mediaStore';
import { addClip, isAssetCompatibleWithTrack } from '@/lib/timeline/operations';

type Props = {
  track: Track;
  clips: Clip[];
  pxPerSec: number;
  selectedClipId: string | null;
  snapTargets: number[];
  contentWidth: number;
};

export function TimelineTrack({
  track,
  clips,
  pxPerSec,
  selectedClipId,
  snapTargets,
  contentWidth,
}: Props) {
  const update = useProjectStore((s) => s.update);
  const selectClip = usePlaybackStore((s) => s.selectClip);
  const assets = useMediaStore((s) => s.assets);
  const assetById = new Map(assets.map((a) => [a.id, a]));

  const onDropAsset = (e: React.DragEvent) => {
    const assetId = e.dataTransfer.getData('application/x-genedit-asset');
    if (!assetId) return;
    const asset = assetById.get(assetId);
    if (!asset) return;
    if (!isAssetCompatibleWithTrack(asset, track)) return;
    e.preventDefault();
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const x = e.clientX - rect.left;
    const startSec = Math.max(0, pxToTime(x, pxPerSec));
    update((p) => addClip(p, asset, track.id, startSec));
  };

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
      onDrop={onDropAsset}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) selectClip(null);
      }}
    >
      {clips.map((clip) => (
        <TimelineClip
          key={clip.id}
          clip={clip}
          asset={assetById.get(clip.assetId)}
          pxPerSec={pxPerSec}
          height={TRACK_HEIGHT_PX}
          selected={selectedClipId === clip.id}
          snapTargets={snapTargets}
        />
      ))}
    </div>
  );
}
