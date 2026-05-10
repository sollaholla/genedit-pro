import type { Clip, Track } from '@/types';
import { TRACK_HEIGHT_PX, pxToTime, timeToPx } from '@/lib/timeline/geometry';
import { TimelineClip, type ClipDragSide } from './TimelineClip';
import { useMediaStore } from '@/state/mediaStore';
import { groupTrackDurationSec } from '@/lib/timeline/operations';
import { Sparkles } from 'lucide-react';
import type { BridgeGap } from './BridgeGenerateDialog';

type Props = {
  track: Track;
  clips: Clip[];
  pxPerSec: number;
  selectedClipIds: Set<string>;
  selectedTrackIds: Set<string>;
  contentWidth: number;
  onDropAsset: (trackId: string, assetId: string, startSec: number) => void;
  onClipBodyMouseDown: (clipId: string, e: React.MouseEvent) => void;
  onClipTrimMouseDown: (clipId: string, side: ClipDragSide, e: React.MouseEvent) => void;
  onClipContextMenu: (clipId: string, e: React.MouseEvent) => void;
  onGroupTrackMouseDown: (trackId: string, e: React.MouseEvent) => void;
  onGroupTrackDoubleClick: (trackId: string) => void;
  onGroupTrackContextMenu: (trackId: string, e: React.MouseEvent) => void;
  bridgeGaps: BridgeGap[];
  onBridgeGapClick: (gap: BridgeGap, e: React.MouseEvent) => void;
  /** Fired when the user mousedowns on empty track area (not on a clip).
   *  The Timeline uses this to start a marquee selection. */
  onEmptyMouseDown: (trackId: string, e: React.MouseEvent) => void;
};

export function TimelineTrack({
  track,
  clips,
  pxPerSec,
  selectedClipIds,
  selectedTrackIds,
  contentWidth,
  onDropAsset,
  onClipBodyMouseDown,
  onClipTrimMouseDown,
  onClipContextMenu,
  onGroupTrackMouseDown,
  onGroupTrackDoubleClick,
  onGroupTrackContextMenu,
  bridgeGaps,
  onBridgeGapClick,
  onEmptyMouseDown,
}: Props) {
  const assets = useMediaStore((s) => s.assets);
  const assetById = new Map(assets.map((a) => [a.id, a]));

  return (
    <div
      className="relative border-b border-surface-800 bg-surface-950/40"
      style={{ height: TRACK_HEIGHT_PX, width: contentWidth }}
      onDragOver={(e) => {
        if (track.group) return;
        if (e.dataTransfer.types.includes('application/x-genedit-asset')) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        }
      }}
      onDrop={(e) => {
        const assetId = e.dataTransfer.getData('application/x-genedit-asset');
        if (track.group) return;
        if (!assetId) return;
        e.preventDefault();
        // Video assets cannot be dropped directly onto audio tracks from the media bin.
        // Audio extraction happens by dragging an existing video clip from a video track.
        const asset = assetById.get(assetId);
        if (track.kind === 'audio' && asset?.kind === 'video') return;
        const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
        const startSec = Math.max(0, pxToTime(e.clientX - rect.left, pxPerSec));
        onDropAsset(track.id, assetId, startSec);
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onEmptyMouseDown(track.id, e);
      }}
    >
      {bridgeGaps.map((bridgeGap) => (
        <BridgeGapOverlay
          key={`${bridgeGap.trackId}:${bridgeGap.startSec}:${bridgeGap.endSec}`}
          gap={bridgeGap}
          pxPerSec={pxPerSec}
          onClick={onBridgeGapClick}
        />
      ))}
      {track.group && (
        <GroupTrackBlock
          track={track}
          pxPerSec={pxPerSec}
          height={TRACK_HEIGHT_PX}
          selected={selectedTrackIds.has(track.id)}
          onMouseDown={onGroupTrackMouseDown}
          onDoubleClick={onGroupTrackDoubleClick}
          onContextMenu={onGroupTrackContextMenu}
        />
      )}
      {clips.map((clip) => (
        <TimelineClip
          key={clip.id}
          clip={clip}
          asset={assetById.get(clip.assetId)}
          trackKind={track.kind}
          pxPerSec={pxPerSec}
          height={TRACK_HEIGHT_PX}
          selected={selectedClipIds.has(clip.id)}
          onBodyMouseDown={onClipBodyMouseDown}
          onTrimMouseDown={onClipTrimMouseDown}
          onContextMenu={onClipContextMenu}
        />
      ))}
    </div>
  );
}

function BridgeGapOverlay({
  gap,
  pxPerSec,
  onClick,
}: {
  gap: BridgeGap;
  pxPerSec: number;
  onClick: (gap: BridgeGap, e: React.MouseEvent) => void;
}) {
  const left = timeToPx(gap.startSec, pxPerSec);
  const width = Math.max(34, timeToPx(gap.durationSec, pxPerSec));

  return (
    <div
      className="absolute top-1 z-10 flex items-center justify-center rounded-sm border border-brand-400/80 bg-brand-500/20 text-white shadow-[0_0_18px_rgba(99,102,241,0.25)] ring-1 ring-brand-400/40"
      style={{ left, width, height: TRACK_HEIGHT_PX - 8 }}
      data-bridge-gap="true"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
    >
      <button
        type="button"
        className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-white/40 bg-brand-500 text-white shadow-lg transition hover:bg-brand-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
        title="Bridge Generate"
        aria-label="Bridge Generate"
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => onClick(gap, event)}
        onContextMenu={(event) => onClick(gap, event)}
      >
        <Sparkles size={15} />
      </button>
    </div>
  );
}

function GroupTrackBlock({
  track,
  pxPerSec,
  height,
  selected,
  onMouseDown,
  onDoubleClick,
  onContextMenu,
}: {
  track: Track;
  pxPerSec: number;
  height: number;
  selected: boolean;
  onMouseDown: (trackId: string, e: React.MouseEvent) => void;
  onDoubleClick: (trackId: string) => void;
  onContextMenu: (trackId: string, e: React.MouseEvent) => void;
}) {
  const startSec = track.group?.startSec ?? 0;
  const durationSec = Math.max(0.05, groupTrackDurationSec(track));
  const left = timeToPx(startSec, pxPerSec);
  const width = Math.max(48, timeToPx(durationSec, pxPerSec));

  return (
    <div
      className={`absolute top-1 z-0 isolate flex cursor-grab items-center overflow-hidden rounded-sm border bg-emerald-600/70 px-2 text-[10px] font-medium text-white no-select active:cursor-grabbing ${
        selected ? 'ring-2 ring-brand-400' : 'ring-1 ring-black/30'
      }`}
      style={{ left, width, height: height - 8 }}
      onMouseDown={(event) => onMouseDown(track.id, event)}
      onDoubleClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onDoubleClick(track.id);
      }}
      onContextMenu={(event) => onContextMenu(track.id, event)}
    >
      <span className="truncate">{track.name || 'Group'}</span>
      <span className="ml-2 shrink-0 rounded bg-black/25 px-1 py-px uppercase tracking-wide text-emerald-50/90">Group</span>
    </div>
  );
}
