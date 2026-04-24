import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Clip } from '@/types';
import { Plus, Scissors, Trash2 } from 'lucide-react';
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
import { getTransformComponents } from '@/lib/components/transform';
import {
  addClip,
  addTrack,
  clipTimelineDurationSec,
  duplicateClip,
  extractAudioFromClip,
  insertTrack,
  moveClip,
  moveClipsBy,
  moveTrack,
  pasteClipFrom,
  pasteClipsFrom,
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
  const [scrollTop, setScrollTop] = useState(0);
  const [dragOverlay, setDragOverlay] = useState<DragOverlay | null>(null);
  const [clipMenu, setClipMenu] = useState<{ x: number; y: number; clipId: string } | null>(null);
  const [replaceClipId, setReplaceClipId] = useState<string | null>(null);
  const [marquee, setMarquee] = useState<{ startX: number; startY: number; curX: number; curY: number } | null>(null);
  const [dragTrackId, setDragTrackId] = useState<string | null>(null);
  const [trackDropTarget, setTrackDropTarget] = useState<{ trackId: string; position: 'before' | 'after' } | null>(null);
  const [selectedKeyframe, setSelectedKeyframe] = useState<{ componentIndex: number; property: 'scale' | 'offsetX' | 'offsetY'; keyframeId: string } | null>(null);
  const [collapsedComponents, setCollapsedComponents] = useState<Set<number>>(new Set());

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
  const selectedClip = selectedClipId ? project.clips.find((c) => c.id === selectedClipId) ?? null : null;
  const selectedTrackId = selectedClip?.trackId ?? null;
  const visibleKeyframeProperties = useMemo(() => {
    if (!selectedClip) return [];
    return getKeyframeProperties(selectedClip).filter((row) => !collapsedComponents.has(row.componentIndex));
  }, [selectedClip, collapsedComponents]);
  const keyframeLaneHeight = selectedClip ? laneHeightForClip(visibleKeyframeProperties.length, getTransformComponents(selectedClip).length) : 0;
  const deleteSelectedKeyframe = useCallback(() => {
    if (!selectedClip || !selectedKeyframe) return;
    update((p) => ({
      ...p,
      clips: p.clips.map((c) => {
        if (c.id !== selectedClip.id) return c;
        const components = getTransformComponents(c).map((component, idx) => {
          if (idx !== selectedKeyframe.componentIndex) return component;
          return {
            ...component,
            data: {
              ...component.data,
              keyframes: {
                ...component.data.keyframes,
                [selectedKeyframe.property]: component.data.keyframes[selectedKeyframe.property].filter((k) => k.id !== selectedKeyframe.keyframeId),
              },
            },
          };
        });
        return { ...c, components };
      }),
    }));
    setSelectedKeyframe(null);
  }, [selectedClip, selectedKeyframe, update]);

  const snapTargets = useMemo(() => {
    const s = new Set<number>([0, currentTime]);
    for (const c of project.clips) {
      s.add(c.startSec);
      s.add(c.startSec + clipTimelineDurationSec(c));
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
        const selected = usePlaybackStore.getState().selectedClipIds;
        if (selected.length === 0) return;
        const idSet = new Set(selected);
        const copied = useProjectStore.getState().project.clips
          .filter((c) => idSet.has(c.id))
          .map((c) => ({
            ...c,
            volumeEnvelope: c.volumeEnvelope
              ? { ...c.volumeEnvelope, points: c.volumeEnvelope.points.map((p) => ({ ...p })) }
              : undefined,
          }));
        setClipboard(copied);
        return;
      }
      if (mod && (e.key === 'v' || e.key === 'V')) {
        const copied = usePlaybackStore.getState().clipboard;
        if (copied.length === 0) return;
        if (copied.length === 1) {
          const source = copied[0]!;
          update((p) => pasteClipFrom(p, source, source.trackId, currentTime));
        } else {
          update((p) => pasteClipsFrom(p, copied, currentTime));
        }
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
        if (selectedKeyframe) {
          e.preventDefault();
          deleteSelectedKeyframe();
          return;
        }
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
  }, [selectedClipId, currentTime, update, selectClip, undo, redo, setClipboard, selectedKeyframe, deleteSelectedKeyframe]);

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
        if (source) {
          const copied = {
            ...source,
            volumeEnvelope: source.volumeEnvelope
              ? { ...source.volumeEnvelope, points: source.volumeEnvelope.points.map((p) => ({ ...p })) }
              : undefined,
          };
          setClipboard([copied]);
        }
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
    const origEnd = clip.startSec + clipTimelineDurationSec(clip);

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
        const clipEnd = clip.startSec + clipTimelineDurationSec(clip);
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
    if (track.name) return track.name;
    const sameKind = tracks.filter((x) => x.kind === track.kind);
    return `${track.kind === 'video' ? 'V' : 'A'}${sameKind.findIndex((x) => x.id === trackId) + 1}`;
  };

  const replaceClip = replaceClipId ? project.clips.find((c) => c.id === replaceClipId) : null;
  const replaceAssetKind = replaceClip ? assetById.get(replaceClip.assetId)?.kind : undefined;

  const handleTrackDrop = useCallback(() => {
    if (!dragTrackId || !trackDropTarget) return;
    const ordered = sortedTracks(useProjectStore.getState().project);
    const from = ordered.findIndex((t) => t.id === dragTrackId);
    const target = ordered.findIndex((t) => t.id === trackDropTarget.trackId);
    if (from < 0 || target < 0 || from === target) {
      setDragTrackId(null);
      setTrackDropTarget(null);
      return;
    }
    let to = target;
    if (trackDropTarget.position === 'before') {
      if (from < target) to = target - 1;
    } else if (from > target) {
      to = target + 1;
    }
    update((p) => moveTrack(p, dragTrackId, to));
    setDragTrackId(null);
    setTrackDropTarget(null);
  }, [dragTrackId, trackDropTarget, update]);

  // Ghost clip for audio extraction preview
  const ghostClip = dragOverlay?.isAudioExtraction
    ? project.clips.find((c) => c.id === dragOverlay.clipId)
    : null;
  const ghostAsset = ghostClip ? assetById.get(ghostClip.assetId) : undefined;
  const selectedKeyframeData = useMemo(() => {
    if (!selectedClip || !selectedKeyframe) return null;
    const properties = getKeyframeProperties(selectedClip);
    const row = properties.find((r) => r.componentIndex === selectedKeyframe.componentIndex && r.property === selectedKeyframe.property);
    const point = row?.points.find((p) => p.id === selectedKeyframe.keyframeId);
    return point ? { ...selectedKeyframe, ...point } : null;
  }, [selectedClip, selectedKeyframe]);
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
      {selectedClip && selectedKeyframeData && (
        <div className="border-t border-surface-700 bg-surface-900 px-3 py-1.5 text-xs">
          <div className="flex items-center gap-2">
            <span className="text-slate-400">{`Transform ${selectedKeyframeData.componentIndex + 1}.${selectedKeyframeData.property}`}</span>
            <input
              type="number"
              className="w-24 rounded border border-surface-600 bg-surface-800 px-2 py-1 text-slate-100 outline-none"
              value={Number(selectedKeyframeData.value.toFixed(3))}
              onChange={(e) => {
                const nextValue = Number(e.target.value);
                if (!Number.isFinite(nextValue)) return;
                update((p) => ({
                  ...p,
                  clips: p.clips.map((c) => {
                    if (c.id !== selectedClip.id) return c;
                    const components = getTransformComponents(c).map((component, idx) => {
                      if (idx !== selectedKeyframeData.componentIndex) return component;
                      const points = component.data.keyframes[selectedKeyframeData.property].map((k) => (
                        k.id === selectedKeyframeData.keyframeId ? { ...k, value: nextValue } : k
                      ));
                      return {
                        ...component,
                        data: {
                          ...component.data,
                          keyframes: { ...component.data.keyframes, [selectedKeyframeData.property]: points },
                        },
                      };
                    });
                    return { ...c, components };
                  }),
                }));
              }}
            />
            <button
              type="button"
              className="btn-ghost px-2 py-1 text-xs text-rose-300 hover:text-rose-200"
              onClick={deleteSelectedKeyframe}
              title="Delete keyframe (Delete)"
            >
              <Trash2 size={12} />
            </button>
          </div>
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        {/* Track headers: pinned ruler + vertically synced track list */}
        <div className="relative min-h-0 shrink-0 overflow-hidden border-r border-surface-700" style={{ width: TRACK_HEADER_WIDTH_PX }}>
          <div className="sticky top-0 z-20 border-b border-surface-700 bg-surface-900" style={{ height: RULER_HEIGHT_PX }} />
          <div className="relative" style={{ height: tracks.length * TRACK_HEIGHT_PX + keyframeLaneHeight }}>
            <div style={{ transform: `translateY(-${scrollTop}px)` }}>
              {tracks.map((t) => (
                <div key={`h-${t.id}`}>
                  <TrackHeader
                    track={t}
                    label={labelForTrack(t.id)}
                    isDragging={dragTrackId === t.id}
                    showDropBefore={trackDropTarget?.trackId === t.id && trackDropTarget.position === 'before'}
                    showDropAfter={trackDropTarget?.trackId === t.id && trackDropTarget.position === 'after'}
                    onDragStart={() => {
                      setDragTrackId(t.id);
                      setTrackDropTarget(null);
                    }}
                    onDragOver={(position) => {
                      if (!dragTrackId || dragTrackId === t.id) return;
                      setTrackDropTarget({ trackId: t.id, position });
                    }}
                    onDrop={handleTrackDrop}
                    onDragEnd={() => {
                      setDragTrackId(null);
                      setTrackDropTarget(null);
                    }}
                    onInsertVideoBelow={() => update((p) => insertTrack(p, 'video', t.index + 1))}
                    onInsertAudioBelow={() => update((p) => insertTrack(p, 'audio', t.index + 1))}
                  />
                  {selectedTrackId === t.id && (
                    <KeyframeSidebarLane
                      clip={selectedClip}
                      collapsedComponents={collapsedComponents}
                      onToggleComponent={(componentIndex) => {
                        setCollapsedComponents((prev) => {
                          const next = new Set(prev);
                          if (next.has(componentIndex)) next.delete(componentIndex);
                          else next.add(componentIndex);
                          return next;
                        });
                      }}
                    />
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Scrollable track content */}
        <div
          ref={scrollRef}
          className="relative min-h-0 flex-1 overflow-auto"
          onScroll={(e) => {
            const target = e.currentTarget as HTMLDivElement;
            setScrollLeft(target.scrollLeft);
            setScrollTop(target.scrollTop);
          }}
        >
          <div
            className="relative"
            style={{ width: contentWidth, minHeight: RULER_HEIGHT_PX + tracks.length * TRACK_HEIGHT_PX + keyframeLaneHeight }}
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
                <div key={track.id}>
                  <TimelineTrack
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
                  {selectedClip && selectedTrackId === track.id && (
                    <KeyframeTrackLane
                      clip={selectedClip}
                      pxPerSec={pxPerSec}
                      selectedKeyframe={selectedKeyframe}
                      visibleProperties={visibleKeyframeProperties}
                      onDeselectKeyframe={() => setSelectedKeyframe(null)}
                      onMoveKeyframe={(meta) => {
                        update((p) => ({
                          ...p,
                          clips: p.clips.map((c) => {
                            if (c.id !== selectedClip.id) return c;
                            const components = getTransformComponents(c).map((component, idx) => {
                              if (idx !== meta.componentIndex) return component;
                              const points = component.data.keyframes[meta.property].map((k) => (
                                k.id === meta.keyframeId ? { ...k, timeSec: meta.timeSec } : k
                              ));
                              return {
                                ...component,
                                data: {
                                  ...component.data,
                                  keyframes: { ...component.data.keyframes, [meta.property]: points },
                                },
                              };
                            });
                            return { ...c, components };
                          }),
                        }));
                        setSelectedKeyframe({ componentIndex: meta.componentIndex, property: meta.property, keyframeId: meta.keyframeId });
                        setCurrentTime(selectedClip.startSec + meta.timeSec);
                      }}
                      onSelectKeyframe={(meta) => {
                        setSelectedKeyframe(meta);
                        setCurrentTime(selectedClip.startSec + meta.timeSec);
                      }}
                    />
                  )}
                </div>
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
              height={RULER_HEIGHT_PX + tracks.length * TRACK_HEIGHT_PX + keyframeLaneHeight}
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

function KeyframeTrackLane({
  clip,
  pxPerSec,
  selectedKeyframe,
  visibleProperties,
  onDeselectKeyframe,
  onMoveKeyframe,
  onSelectKeyframe,
}: {
  clip: Clip;
  pxPerSec: number;
  selectedKeyframe: { componentIndex: number; property: 'scale' | 'offsetX' | 'offsetY'; keyframeId: string } | null;
  visibleProperties: Array<KeyframePropertyRow>;
  onDeselectKeyframe: () => void;
  onMoveKeyframe: (meta: { componentIndex: number; property: 'scale' | 'offsetX' | 'offsetY'; keyframeId: string; timeSec: number }) => void;
  onSelectKeyframe: (meta: { componentIndex: number; property: 'scale' | 'offsetX' | 'offsetY'; keyframeId: string; timeSec: number }) => void;
}) {
  const transforms = getTransformComponents(clip);
  if (transforms.length === 0) return null;
  const clipLeftPx = timeToPx(clip.startSec, pxPerSec);
  const clipWidthPx = Math.max(48, timeToPx(clipTimelineDurationSec(clip), pxPerSec));
  const properties = visibleProperties;

  return (
    <div
      className="border-b border-surface-800 bg-[#0c1222] py-1.5"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onDeselectKeyframe();
      }}
    >
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Keyframes</div>
      <div className="max-h-[220px] overflow-auto">
        {properties.map((row) => (
          <div
            key={row.label}
            className="mb-1 rounded border border-surface-800 bg-surface-900/80 px-0 py-1"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) onDeselectKeyframe();
            }}
          >
            <div className="relative h-8 overflow-hidden rounded bg-[#0a0f1c]">
              <div
                className="absolute inset-y-0 border border-brand-400/40 bg-brand-500/10"
                style={{ left: clipLeftPx, width: clipWidthPx }}
              >
                <svg className="h-full w-full" viewBox="0 0 500 32" preserveAspectRatio="none">
                  {row.points.length > 1 && (
                    <polyline
                      points={row.points
                        .sort((a, b) => a.timeSec - b.timeSec)
                        .map((k) => {
                          const localSec = Math.max(0, Math.min(clipTimelineDurationSec(clip), k.timeSec));
                          const x = (localSec / Math.max(1e-6, clipTimelineDurationSec(clip))) * 500;
                          return `${x},${16 - Math.max(-12, Math.min(12, k.value * 0.1))}`;
                        })
                        .join(' ')}
                      fill="none"
                      stroke="#7dd3fc"
                      strokeWidth="1.5"
                    />
                  )}
                  {row.points.map((k) => {
                    const localSec = Math.max(0, Math.min(clipTimelineDurationSec(clip), k.timeSec));
                    const x = Math.max(6, Math.min(494, (localSec / Math.max(1e-6, clipTimelineDurationSec(clip))) * 500));
                    const selected = selectedKeyframe?.keyframeId === k.id && selectedKeyframe.componentIndex === row.componentIndex && selectedKeyframe.property === row.property;
                    return (
                      <circle
                        key={k.id}
                        cx={x}
                        cy={16 - Math.max(-12, Math.min(12, k.value * 0.1))}
                        r={selected ? 5.2 : 4}
                        fill={selected ? '#fbbf24' : '#a78bfa'}
                        className="cursor-pointer"
                        onMouseDown={(e) => {
                          e.stopPropagation();
                          onSelectKeyframe({ componentIndex: row.componentIndex, property: row.property, keyframeId: k.id, timeSec: k.timeSec });
                          const svg = (e.currentTarget as SVGCircleElement).ownerSVGElement;
                          if (!svg) return;
                          const duration = Math.max(1e-6, clipTimelineDurationSec(clip));
                          const move = (ev: MouseEvent) => {
                            const rect = svg.getBoundingClientRect();
                            const normalized = Math.max(0, Math.min(1, (ev.clientX - rect.left) / Math.max(1, rect.width)));
                            onMoveKeyframe({
                              componentIndex: row.componentIndex,
                              property: row.property,
                              keyframeId: k.id,
                              timeSec: normalized * duration,
                            });
                          };
                          const up = () => {
                            window.removeEventListener('mousemove', move);
                            window.removeEventListener('mouseup', up);
                          };
                          window.addEventListener('mousemove', move);
                          window.addEventListener('mouseup', up);
                        }}
                      />
                    );
                  })}
                </svg>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

type KeyframePropertyRow = {
  label: string;
  componentIndex: number;
  property: 'scale' | 'offsetX' | 'offsetY';
  points: Array<{ id: string; timeSec: number; value: number }>;
};

function laneHeightForClip(visibleRows: number, totalComponents: number): number {
  if (totalComponents === 0) return 0;
  return Math.min(260, 20 + totalComponents * 26 + visibleRows * 34);
}

function getKeyframeProperties(clip: Clip): Array<KeyframePropertyRow> {
  const transforms = getTransformComponents(clip);
  const properties: Array<KeyframePropertyRow> = [];
  transforms.forEach((component, index) => {
    properties.push({ label: `Transform ${index + 1}.offsetX`, componentIndex: index, property: 'offsetX', points: component.data.keyframes.offsetX });
    properties.push({ label: `Transform ${index + 1}.offsetY`, componentIndex: index, property: 'offsetY', points: component.data.keyframes.offsetY });
    properties.push({ label: `Transform ${index + 1}.scale`, componentIndex: index, property: 'scale', points: component.data.keyframes.scale });
  });
  return properties;
}

function KeyframeSidebarLane({
  clip,
  collapsedComponents,
  onToggleComponent,
}: {
  clip: Clip | null;
  collapsedComponents: Set<number>;
  onToggleComponent: (componentIndex: number) => void;
}) {
  if (!clip) return null;
  const components = getTransformComponents(clip);
  const properties = getKeyframeProperties(clip);
  if (properties.length === 0) return null;
  return (
    <div
      className="border-b border-surface-800 bg-[#0c1222] px-2 py-1.5"
      style={{ height: laneHeightForClip(properties.filter((p) => !collapsedComponents.has(p.componentIndex)).length, components.length) }}
    >
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Keyframes</div>
      <div className="max-h-[220px] overflow-auto">
        {components.map((_, componentIndex) => {
          const groupRows = properties.filter((row) => row.componentIndex === componentIndex);
          const collapsed = collapsedComponents.has(componentIndex);
          return (
            <div key={`group-${componentIndex}`} className="mb-1 rounded border border-surface-800 bg-surface-900/70 px-1.5 py-1">
              <button
                type="button"
                className="mb-1 flex w-full items-center justify-between text-left text-[11px] font-medium text-slate-300"
                onClick={() => onToggleComponent(componentIndex)}
              >
                <span>{`Transform ${componentIndex + 1}`}</span>
                <span className="text-slate-500">{collapsed ? '▸' : '▾'}</span>
              </button>
              {!collapsed && (
                <div className="space-y-1 pl-3">
                  {groupRows.map((row) => (
                    <div key={row.label} className="rounded bg-surface-900/80 px-1.5 py-0.5 text-[11px] text-slate-400">
                      {row.label.split('.').at(-1)}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
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
  const width = Math.max(4, timeToPx(clipTimelineDurationSec(clip), pxPerSec));
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
