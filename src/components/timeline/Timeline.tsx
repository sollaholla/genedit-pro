import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Clip } from '@/types';
import { Plus, Scissors } from 'lucide-react';
import {
  RULER_HEIGHT_PX,
  TRACK_HEADER_WIDTH_PX,
  TRACK_HEIGHT_PX,
  clampPxPerSec,
  pxToTime,
  timeToPx,
  snapTime,
  SNAP_TOLERANCE_PX,
} from '@/lib/timeline/geometry';
import { TimelineRuler } from './TimelineRuler';
import { TimelineTrack } from './TimelineTrack';
import { type ClipDragSide } from './TimelineClip';
import { TrackHeader } from './TrackHeader';
import { Playhead } from './Playhead';
import { useProjectStore } from '@/state/projectStore';
import { usePlaybackStore } from '@/state/playbackStore';
import { useMediaStore } from '@/state/mediaStore';
import {
  addClip,
  addTrack,
  extractAudioFromClip,
  isAssetCompatibleWithTrack,
  moveClip,
  projectDurationSec,
  removeClip,
  sortedTracks,
  splitClipAt,
  trimClipLeft,
  trimClipRight,
} from '@/lib/timeline/operations';

type DragOverlay = {
  clipId: string;
  /** Track index in sorted tracks list where the ghost renders. */
  ghostTrackIdx: number;
  /** Whether this is an audio-extraction ghost (video clip → audio track). */
  isAudioExtraction: boolean;
};

export function Timeline() {
  const project = useProjectStore((s) => s.project);
  const update = useProjectStore((s) => s.update);
  const updateSilent = useProjectStore((s) => s.updateSilent);
  const beginTx = useProjectStore((s) => s.beginTx);
  const cancelTx = useProjectStore((s) => s.cancelTx);
  const undo = useProjectStore((s) => s.undo);
  const redo = useProjectStore((s) => s.redo);

  const currentTime = usePlaybackStore((s) => s.currentTimeSec);
  const setCurrentTime = usePlaybackStore((s) => s.setCurrentTime);
  const pxPerSec = usePlaybackStore((s) => s.pxPerSec);
  const setPxPerSec = usePlaybackStore((s) => s.setPxPerSec);
  const selection = usePlaybackStore((s) => s.selection);
  const selectedClipId = selection.kind === 'clip' ? selection.id : null;
  const selectClip = usePlaybackStore((s) => s.selectClip);

  const assets = useMediaStore((s) => s.assets);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [viewportWidth, setViewportWidth] = useState(1200);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [dragOverlay, setDragOverlay] = useState<DragOverlay | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewportWidth(el.clientWidth));
    ro.observe(el);
    setViewportWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const durationSec = projectDurationSec(project);
  const visibleDuration = Math.max(durationSec + 5, viewportWidth / pxPerSec + 5);
  const contentWidth = Math.max(viewportWidth, visibleDuration * pxPerSec);
  const tracks = sortedTracks(project);
  const assetById = useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets]);

  const snapTargets = useMemo(() => {
    const s = new Set<number>([0, currentTime]);
    for (const c of project.clips) {
      s.add(c.startSec);
      s.add(c.startSec + (c.outSec - c.inSec));
    }
    return [...s];
  }, [project.clips, currentTime]);

  // Zoom on Cmd/Ctrl+wheel
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const delta = -e.deltaY * 0.002;
      const rect = el.getBoundingClientRect();
      const anchorLocalX = e.clientX - rect.left + el.scrollLeft;
      const anchorTime = Math.max(0, anchorLocalX / pxPerSec);
      const nextPx = clampPxPerSec(pxPerSec * (1 + delta));
      setPxPerSec(nextPx);
      requestAnimationFrame(() => {
        el.scrollLeft = Math.max(0, anchorTime * nextPx - (e.clientX - rect.left));
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [pxPerSec, setPxPerSec]);

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      const mod = e.ctrlKey || e.metaKey;

      if (mod && e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
      if (mod && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) { e.preventDefault(); redo(); return; }

      if (e.key === 's' || e.key === 'S') {
        if (!selectedClipId) return;
        update((p) => splitClipAt(p, selectedClipId, currentTime));
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (!selectedClipId) return;
        update((p) => removeClip(p, selectedClipId));
        selectClip(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedClipId, currentTime, update, selectClip, undo, redo]);

  // ---- Clip body drag (cross-track) ----
  const handleClipBodyMouseDown = useCallback((clipId: string, e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    selectClip(clipId);

    const clip = useProjectStore.getState().project.clips.find((c) => c.id === clipId);
    if (!clip) return;

    const origStart = clip.startSec;
    const origTrackId = clip.trackId;
    const origTrackIdx = tracks.findIndex((t) => t.id === origTrackId);

    beginTx();

    const startX = e.clientX;
    let committed = false;
    let lastGhost: DragOverlay | null = null;

    const move = (ev: MouseEvent) => {
      const el = scrollRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const scrollL = el.scrollLeft;
      const scrollT = el.scrollTop;

      // X → time
      const relX = ev.clientX - rect.left + scrollL;
      const dxPx = ev.clientX - startX;
      const dt = pxToTime(dxPx, pxPerSec);
      const candidate = snapTime(Math.max(0, origStart + dt), snapTargets, pxPerSec, SNAP_TOLERANCE_PX);
      void relX;

      // Y → track index
      const relY = ev.clientY - rect.top + scrollT - RULER_HEIGHT_PX;
      const rawIdx = Math.floor(relY / TRACK_HEIGHT_PX);
      const trackIdx = Math.max(0, Math.min(tracks.length - 1, rawIdx));
      const targetTrack = tracks[trackIdx];
      if (!targetTrack) return;

      const sourceAsset = assetById.get(clip.assetId);
      const isAudioExtraction =
        sourceAsset?.kind === 'video' && targetTrack.kind === 'audio';
      const compatible = isAudioExtraction || isAssetCompatibleWithTrack(
        sourceAsset ?? { kind: 'video', id: '', name: '', durationSec: 0, mimeType: '', blobKey: '', createdAt: 0 },
        targetTrack,
      );

      if (isAudioExtraction) {
        // Video stays put; show ghost on target audio track
        if (!committed) {
          // Revert any silent moves to keep video in place
          updateSilent((p) => moveClip(p, clipId, origStart, origTrackId));
        }
        const ghost: DragOverlay = { clipId, ghostTrackIdx: trackIdx, isAudioExtraction: true };
        lastGhost = ghost;
        setDragOverlay(ghost);
      } else if (compatible) {
        updateSilent((p) => moveClip(p, clipId, candidate, targetTrack.id));
        lastGhost = null;
        setDragOverlay(null);
      } else {
        // Incompatible — snap back to original
        updateSilent((p) => moveClip(p, clipId, origStart, origTrackId));
        lastGhost = null;
        setDragOverlay(null);
      }
    };

    const up = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      setDragOverlay(null);

      const el = scrollRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const scrollT = el.scrollTop;
      const relY = ev.clientY - rect.top + scrollT - RULER_HEIGHT_PX;
      const rawIdx = Math.floor(relY / TRACK_HEIGHT_PX);
      const trackIdx = Math.max(0, Math.min(tracks.length - 1, rawIdx));
      const targetTrack = tracks[trackIdx];
      const sourceAsset = assetById.get(clip.assetId);

      if (lastGhost?.isAudioExtraction && targetTrack?.kind === 'audio') {
        // Commit audio extraction as a normal history entry
        cancelTx(); // cancel the beginTx snapshot (video never moved)
        update((p) => extractAudioFromClip(p, clipId, targetTrack.id));
      } else if (targetTrack && !isAssetCompatibleWithTrack(
        sourceAsset ?? { kind: 'video', id: '', name: '', durationSec: 0, mimeType: '', blobKey: '', createdAt: 0 },
        targetTrack,
      )) {
        // Invalid drop — revert to original position
        cancelTx();
        void origTrackIdx;
      }
      // Otherwise: committed via updateSilent; beginTx snapshot is the undo point
      committed = true;
    };

    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }, [tracks, pxPerSec, snapTargets, assetById, selectClip, beginTx, cancelTx, update, updateSilent]);

  // ---- Clip trim ----
  const handleClipTrimMouseDown = useCallback((clipId: string, side: ClipDragSide, e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    selectClip(clipId);

    const clip = useProjectStore.getState().project.clips.find((c) => c.id === clipId);
    if (!clip) return;

    beginTx();
    const startX = e.clientX;
    const origStart = clip.startSec;
    const origEnd = clip.startSec + (clip.outSec - clip.inSec);

    const move = (ev: MouseEvent) => {
      const dt = pxToTime(ev.clientX - startX, pxPerSec);
      if (side === 'l') {
        const snapped = snapTime(Math.max(0, origStart + dt), snapTargets, pxPerSec, SNAP_TOLERANCE_PX);
        updateSilent((p) => trimClipLeft(p, clipId, snapped));
      } else {
        const snapped = snapTime(origEnd + dt, snapTargets, pxPerSec, SNAP_TOLERANCE_PX);
        updateSilent((p) => trimClipRight(p, clipId, snapped));
      }
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }, [pxPerSec, snapTargets, selectClip, beginTx, updateSilent]);

  // ---- Asset drop from media bin ----
  const handleDropAsset = useCallback((trackId: string, assetId: string, startSec: number) => {
    const asset = assetById.get(assetId);
    if (!asset) return;
    update((p) => addClip(p, asset, trackId, startSec));
  }, [assetById, update]);

  const labelForTrack = (trackId: string) => {
    const track = project.tracks.find((t) => t.id === trackId);
    if (!track) return '';
    const sameKind = tracks.filter((x) => x.kind === track.kind);
    return `${track.kind === 'video' ? 'V' : 'A'}${sameKind.findIndex((x) => x.id === trackId) + 1}`;
  };

  // Ghost clip for audio extraction preview
  const ghostClip = dragOverlay?.isAudioExtraction
    ? project.clips.find((c) => c.id === dragOverlay.clipId)
    : null;
  const ghostAsset = ghostClip ? assetById.get(ghostClip.assetId) : undefined;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-surface-700 px-3 py-1.5">
        <div className="flex items-center gap-2">
          <button className="btn-ghost px-2 py-1 text-xs" onClick={() => update((p) => addTrack(p, 'video'))}>
            <Plus size={12} /> Video track
          </button>
          <button className="btn-ghost px-2 py-1 text-xs" onClick={() => update((p) => addTrack(p, 'audio'))}>
            <Plus size={12} /> Audio track
          </button>
          <button
            className="btn-ghost px-2 py-1 text-xs disabled:opacity-50"
            disabled={!selectedClipId}
            onClick={() => selectedClipId && update((p) => splitClipAt(p, selectedClipId, currentTime))}
            title="Split at playhead (S)"
          >
            <Scissors size={12} /> Split
          </button>
        </div>
        <div className="text-[11px] text-slate-400">
          Cmd/Ctrl-scroll to zoom · S split · Del remove · ⌘Z undo · ⌘⇧Z redo
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Fixed track headers */}
        <div className="shrink-0" style={{ width: TRACK_HEADER_WIDTH_PX }}>
          <div className="border-b border-r border-surface-700 bg-surface-900" style={{ height: RULER_HEIGHT_PX }} />
          {tracks.map((t) => (
            <TrackHeader key={`h-${t.id}`} track={t} label={labelForTrack(t.id)} />
          ))}
        </div>

        {/* Scrollable track content */}
        <div
          ref={scrollRef}
          className="relative min-h-0 flex-1 overflow-auto"
          onScroll={(e) => setScrollLeft((e.currentTarget as HTMLDivElement).scrollLeft)}
        >
          <div
            className="relative"
            style={{ width: contentWidth, minHeight: RULER_HEIGHT_PX + tracks.length * TRACK_HEIGHT_PX }}
          >
            <TimelineRuler
              pxPerSec={pxPerSec}
              durationSec={durationSec}
              viewportWidth={viewportWidth}
              scrollLeft={scrollLeft}
              onScrub={setCurrentTime}
            />
            <div>
              {tracks.map((track) => (
                <TimelineTrack
                  key={track.id}
                  track={track}
                  clips={project.clips.filter((c) => c.trackId === track.id)}
                  pxPerSec={pxPerSec}
                  selectedClipId={selectedClipId}
                  contentWidth={contentWidth}
                  onDropAsset={handleDropAsset}
                  onClipBodyMouseDown={handleClipBodyMouseDown}
                  onClipTrimMouseDown={handleClipTrimMouseDown}
                  onClipSelect={selectClip}
                />
              ))}
            </div>

            {/* Audio-extraction ghost: shows where the audio strip will land */}
            {dragOverlay?.isAudioExtraction && ghostClip && (
              <AudioExtractionGhost
                clip={ghostClip}
                assetName={ghostAsset?.name ?? ''}
                pxPerSec={pxPerSec}
                trackIdx={dragOverlay.ghostTrackIdx}
              />
            )}

            <Playhead
              timeSec={currentTime}
              pxPerSec={pxPerSec}
              height={RULER_HEIGHT_PX + tracks.length * TRACK_HEIGHT_PX}
              offsetLeft={0}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function AudioExtractionGhost({
  clip,
  assetName,
  pxPerSec,
  trackIdx,
}: {
  clip: Clip;
  assetName: string;
  pxPerSec: number;
  trackIdx: number;
}) {
  const left = timeToPx(clip.startSec, pxPerSec);
  const width = Math.max(4, timeToPx(clip.outSec - clip.inSec, pxPerSec));
  const top = RULER_HEIGHT_PX + trackIdx * TRACK_HEIGHT_PX + 4;
  return (
    <div
      className="pointer-events-none absolute rounded-sm bg-clip-audio/60 ring-2 ring-dashed ring-clip-audio"
      style={{ left, width, top, height: TRACK_HEIGHT_PX - 8 }}
    >
      <span className="flex h-full items-center px-2 text-[10px] font-medium text-white opacity-80 truncate">
        {assetName}
      </span>
    </div>
  );
}
