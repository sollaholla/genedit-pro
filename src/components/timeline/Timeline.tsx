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
  duplicateClip,
  extractAudioFromClip,
  insertTrack,
  moveClip,
  moveClipsBy,
  moveTrackBy,
  pasteClipFrom,
  projectDurationSec,
  removeClip,
  sortedTracks,
  splitClipAt,
  trimClipLeft,
  trimClipRight,
} from '@/lib/timeline/operations';
import { ClipContextMenu, type ClipMenuAction } from './ClipContextMenu';
import { ReplaceClipDialog } from './ReplaceClipDialog';

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
  const selectedClipIds = usePlaybackStore((s) => s.selectedClipIds);
  const selectClip = usePlaybackStore((s) => s.selectClip);
  const toggleClipSelection = usePlaybackStore((s) => s.toggleClipSelection);
  const setClipSelection = usePlaybackStore((s) => s.setClipSelection);
  // Convenience: the single-selected clip ID (when exactly one is selected).
  const selectedClipId = selectedClipIds.length === 1 ? selectedClipIds[0]! : null;

  const assets = useMediaStore((s) => s.assets);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [viewportWidth, setViewportWidth] = useState(1200);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [dragOverlay, setDragOverlay] = useState<DragOverlay | null>(null);
  const [clipMenu, setClipMenu] = useState<{ x: number; y: number; clipId: string } | null>(null);
  const [replaceClipId, setReplaceClipId] = useState<string | null>(null);
  const [marquee, setMarquee] = useState<{ startX: number; startY: number; curX: number; curY: number } | null>(null);

  const setClipboard = usePlaybackStore((s) => s.setClipboard);
  // A Set version for O(1) membership checks in the render path.
  const selectedSet = useMemo(() => new Set(selectedClipIds), [selectedClipIds]);

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

      if (mod && (e.key === 'c' || e.key === 'C')) {
        if (!selectedClipId) return;
        const source = useProjectStore.getState().project.clips.find((c) => c.id === selectedClipId);
        if (source) setClipboard(source);
        return;
      }
      if (mod && (e.key === 'v' || e.key === 'V')) {
        const source = usePlaybackStore.getState().clipboard;
        if (!source) return;
        // Paste onto the same track, at the playhead.
        update((p) => pasteClipFrom(p, source, source.trackId, currentTime));
        return;
      }
      if (mod && (e.key === 'd' || e.key === 'D')) {
        if (!selectedClipId) return;
        e.preventDefault();
        update((p) => duplicateClip(p, selectedClipId));
        return;
      }

      if (e.key === 's' || e.key === 'S') {
        if (!selectedClipId) return;
        update((p) => splitClipAt(p, selectedClipId, currentTime));
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        const ids = usePlaybackStore.getState().selectedClipIds;
        if (ids.length === 0) return;
        update((p) => ids.reduce((proj, id) => removeClip(proj, id), p));
        selectClip(null);
      } else if (e.key === 'Escape') {
        selectClip(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedClipId, currentTime, update, selectClip, undo, redo, setClipboard]);

  // ---- Clip right-click context menu ----
  const handleClipContextMenu = useCallback((clipId: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    selectClip(clipId);
    setClipMenu({ x: e.clientX, y: e.clientY, clipId });
  }, [selectClip]);

  const handleClipMenuAction = useCallback((action: ClipMenuAction) => {
    if (!clipMenu) return;
    const { clipId } = clipMenu;
    switch (action) {
      case 'duplicate':
        update((p) => duplicateClip(p, clipId));
        break;
      case 'copy': {
        const source = useProjectStore.getState().project.clips.find((c) => c.id === clipId);
        if (source) setClipboard(source);
        break;
      }
      case 'replace':
        setReplaceClipId(clipId);
        break;
      case 'delete':
        update((p) => removeClip(p, clipId));
        if (selectedClipId === clipId) selectClip(null);
        break;
    }
  }, [clipMenu, update, selectClip, selectedClipId, setClipboard]);

  // ---- Clip body drag (cross-track) ----
  const handleClipBodyMouseDown = useCallback((clipId: string, e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();

    // Ctrl/Cmd-click toggles the clip in the selection and does NOT initiate a drag.
    if (e.ctrlKey || e.metaKey) {
      toggleClipSelection(clipId);
      return;
    }

    // If the clicked clip is already part of a multi-selection, drag the whole
    // group. Otherwise replace the selection with this clip and drag it alone.
    const priorSelection = usePlaybackStore.getState().selectedClipIds;
    const isGroupDrag = priorSelection.length > 1 && priorSelection.includes(clipId);
    if (!isGroupDrag) selectClip(clipId);

    const clip = useProjectStore.getState().project.clips.find((c) => c.id === clipId);
    if (!clip) return;

    const origStart = clip.startSec;
    const origTrackId = clip.trackId;
    // The track the clip started on determines extraction eligibility.
    const origTrack = tracks.find((t) => t.id === origTrackId);

    beginTx();

    const startX = e.clientX;
    let lastGhost: DragOverlay | null = null;

    const move = (ev: MouseEvent) => {
      const el = scrollRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const scrollL = el.scrollLeft;
      const scrollT = el.scrollTop;

      // X → time
      const dxPx = ev.clientX - startX;
      void scrollL;
      const dt = pxToTime(dxPx, pxPerSec);
      const candidate = snapTime(Math.max(0, origStart + dt), snapTargets, pxPerSec, SNAP_TOLERANCE_PX);

      // Y → track index
      const relY = ev.clientY - rect.top + scrollT - RULER_HEIGHT_PX;
      const rawIdx = Math.floor(relY / TRACK_HEIGHT_PX);
      const trackIdx = Math.max(0, Math.min(tracks.length - 1, rawIdx));
      const targetTrack = tracks[trackIdx];
      if (!targetTrack) return;

      const sourceAsset = assetById.get(clip.assetId);
      // Audio extraction only applies when dragging FROM a video track TO an audio track.
      // A video-asset clip that is already on an audio track moves normally.
      const isAudioExtraction =
        origTrack?.kind === 'video' &&
        sourceAsset?.kind === 'video' &&
        targetTrack.kind === 'audio';
      // Compatible = same kind of track, or audio extraction.
      const compatible = isAudioExtraction || targetTrack.kind === origTrack?.kind;

      if (isGroupDrag) {
        // Multi-selection drag: shift all selected clips by dt (time-only, no
        // track change). This keeps the group's relative spacing and track
        // assignment; cross-track moves for multi-select aren't supported.
        updateSilent((p) => moveClipsBy(p, priorSelection, dt));
        lastGhost = null;
        setDragOverlay(null);
      } else if (isAudioExtraction) {
        // Video stays put; show ghost on target audio track
        updateSilent((p) => moveClip(p, clipId, origStart, origTrackId));
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

      if (lastGhost?.isAudioExtraction && targetTrack?.kind === 'audio') {
        // Commit audio extraction as a normal history entry
        cancelTx(); // cancel the beginTx snapshot (video never moved)
        update((p) => extractAudioFromClip(p, clipId, targetTrack.id));
      } else if (targetTrack && targetTrack.kind !== origTrack?.kind) {
        // Cross-kind drop that isn't an audio extraction — revert
        cancelTx();
      }
      // Otherwise: committed via updateSilent; beginTx snapshot is the undo point
    };

    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }, [tracks, pxPerSec, snapTargets, assetById, selectClip, toggleClipSelection, beginTx, cancelTx, update, updateSilent]);

  // ---- Clip trim ----
  const handleClipTrimMouseDown = useCallback((clipId: string, side: ClipDragSide, e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    selectClip(clipId);

    const clip = useProjectStore.getState().project.clips.find((c) => c.id === clipId);
    if (!clip) return;
    const sourceAsset = assetById.get(clip.assetId);
    const maxSourceSec = sourceAsset?.durationSec;

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
        updateSilent((p) => trimClipRight(p, clipId, snapped, maxSourceSec));
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

  // ---- Marquee selection from empty track area ----
  const handleEmptyMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    // Ctrl/Cmd-click on empty area starts an additive marquee; otherwise replaces.
    const additive = e.ctrlKey || e.metaKey;
    const baseline = additive ? usePlaybackStore.getState().selectedClipIds : [];
    const el = scrollRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const startX = e.clientX - rect.left + el.scrollLeft;
    const startY = e.clientY - rect.top + el.scrollTop;
    setMarquee({ startX, startY, curX: startX, curY: startY });
    if (!additive) selectClip(null);

    const move = (ev: MouseEvent) => {
      const s = scrollRef.current;
      if (!s) return;
      const r = s.getBoundingClientRect();
      const curX = Math.max(0, ev.clientX - r.left + s.scrollLeft);
      const curY = Math.max(0, ev.clientY - r.top + s.scrollTop);
      setMarquee({ startX, startY, curX, curY });

      // Compute clips intersecting the box.
      const x0 = Math.min(startX, curX);
      const x1 = Math.max(startX, curX);
      const y0 = Math.min(startY, curY);
      const y1 = Math.max(startY, curY);
      const tStart = x0 / pxPerSec;
      const tEnd = x1 / pxPerSec;
      const idxStart = Math.floor((y0 - RULER_HEIGHT_PX) / TRACK_HEIGHT_PX);
      const idxEnd = Math.floor((y1 - RULER_HEIGHT_PX) / TRACK_HEIGHT_PX);
      const hitIds = new Set(baseline);
      for (const clip of useProjectStore.getState().project.clips) {
        const trackIdx = tracks.findIndex((t) => t.id === clip.trackId);
        if (trackIdx < idxStart || trackIdx > idxEnd) continue;
        const clipEnd = clip.startSec + (clip.outSec - clip.inSec);
        if (clipEnd < tStart || clip.startSec > tEnd) continue;
        hitIds.add(clip.id);
      }
      setClipSelection([...hitIds]);
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      setMarquee(null);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }, [pxPerSec, tracks, selectClip, setClipSelection]);

  const labelForTrack = (trackId: string) => {
    const track = project.tracks.find((t) => t.id === trackId);
    if (!track) return '';
    const sameKind = tracks.filter((x) => x.kind === track.kind);
    return `${track.kind === 'video' ? 'V' : 'A'}${sameKind.findIndex((x) => x.id === trackId) + 1}`;
  };

  const replaceClip = replaceClipId ? project.clips.find((c) => c.id === replaceClipId) : null;
  const replaceAssetKind = replaceClip ? assetById.get(replaceClip.assetId)?.kind : undefined;

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
        <ShortcutHints />
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Fixed track headers */}
        <div className="shrink-0" style={{ width: TRACK_HEADER_WIDTH_PX }}>
          <div className="border-b border-r border-surface-700 bg-surface-900" style={{ height: RULER_HEIGHT_PX }} />
          {tracks.map((t) => (
            <TrackHeader
              key={`h-${t.id}`}
              track={t}
              label={labelForTrack(t.id)}
              canMoveUp={t.index > 0}
              canMoveDown={t.index < tracks.length - 1}
              onMoveUp={() => update((p) => moveTrackBy(p, t.id, -1))}
              onMoveDown={() => update((p) => moveTrackBy(p, t.id, 1))}
              onInsertVideoBelow={() => update((p) => insertTrack(p, 'video', t.index + 1))}
              onInsertAudioBelow={() => update((p) => insertTrack(p, 'audio', t.index + 1))}
            />
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
                  selectedClipIds={selectedSet}
                  contentWidth={contentWidth}
                  onDropAsset={handleDropAsset}
                  onClipBodyMouseDown={handleClipBodyMouseDown}
                  onClipTrimMouseDown={handleClipTrimMouseDown}
                  onClipContextMenu={handleClipContextMenu}
                  onEmptyMouseDown={handleEmptyMouseDown}
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

            {/* Marquee selection rectangle */}
            {marquee && (
              <div
                className="pointer-events-none absolute rounded-sm border border-brand-400 bg-brand-400/15"
                style={{
                  left: Math.min(marquee.startX, marquee.curX),
                  top: Math.min(marquee.startY, marquee.curY),
                  width: Math.abs(marquee.curX - marquee.startX),
                  height: Math.abs(marquee.curY - marquee.startY),
                }}
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

      {clipMenu && (
        <ClipContextMenu
          x={clipMenu.x}
          y={clipMenu.y}
          onPick={handleClipMenuAction}
          onClose={() => setClipMenu(null)}
        />
      )}

      {replaceClip && replaceAssetKind && (
        <ReplaceClipDialog
          clip={replaceClip}
          requiredKind={replaceAssetKind}
          onClose={() => setReplaceClipId(null)}
        />
      )}
    </div>
  );
}

// Detect Mac once at module level so there are no per-render allocations.
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = IS_MAC ? '⌘' : 'Ctrl';
const ALT = IS_MAC ? '⌥' : 'Alt';

function Key({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex items-center justify-center rounded border border-surface-500 bg-surface-700 px-1 py-px font-sans text-[10px] text-slate-200 shadow-[0_1px_0_0_rgba(0,0,0,0.5)]">
      {children}
    </kbd>
  );
}

function Hint({ keys, label }: { keys: React.ReactNode[]; label: string }) {
  return (
    <span className="flex items-center gap-0.5">
      {keys.map((k, i) => <Key key={i}>{k}</Key>)}
      <span className="ml-1 text-slate-500">{label}</span>
    </span>
  );
}

function ShortcutHints() {
  return (
    <div className="flex items-center gap-3 text-[11px]">
      <Hint keys={[MOD, 'scroll']} label="zoom" />
      <Hint keys={['S']} label="split" />
      <Hint keys={['Del']} label="remove" />
      <Hint keys={[MOD, 'Z']} label="undo" />
      <Hint keys={[MOD, IS_MAC ? '⇧' : 'Shift', 'Z']} label="redo" />
      <Hint keys={[ALT, '↕ drag']} label="change track" />
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
