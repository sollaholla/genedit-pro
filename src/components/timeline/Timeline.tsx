import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Clip, Project } from '@/types';
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
import {
  addClip,
  addTrack,
  clipSpeed,
  clipTimelineDurationSec,
  duplicateClip,
  extractAudioFromClip,
  insertTrack,
  MIN_CLIP_DURATION,
  moveClip,
  moveClipsBy,
  moveTrack,
  pasteClipFrom,
  pasteClipsFrom,
  projectDurationSec,
  removeClip,
  sortedTracks,
  splitClipAt,
} from '@/lib/timeline/operations';
import { ClipContextMenu, type ClipMenuAction } from './ClipContextMenu';
import { ReplaceClipDialog } from './ReplaceClipDialog';
import { KeyframeSidebarLane, KeyframeTrackLane } from './KeyframeTrackLane';
import { useKeyframeController } from './useKeyframeController';
import { getKeyframeProperties, laneHeightForRows, type KeyframePropertyRow } from './keyframeModel';
import { keyframeComponentVisibilityKey } from '@/lib/components/transform';

type DragOverlay = {
  clipId: string;
  /** Track index in sorted tracks list where the ghost renders. */
  ghostTrackIdx: number;
  /** Whether this is an audio-extraction ghost (video clip → audio track). */
  isAudioExtraction: boolean;
};

type TimelineKeyframeLane = {
  clip: Clip;
  rows: KeyframePropertyRow[];
  height: number;
};

export function Timeline() {
  const project = useProjectStore((s) => s.project);
  const update = useProjectStore((s) => s.update);
  const updateSilent = useProjectStore((s) => s.updateSilent);
  const beginTx = useProjectStore((s) => s.beginTx);
  const cancelTx = useProjectStore((s) => s.cancelTx);

  const currentTime = usePlaybackStore((s) => s.currentTimeSec);
  const setCurrentTime = usePlaybackStore((s) => s.setCurrentTime);
  const pause = usePlaybackStore((s) => s.pause);
  const pxPerSec = usePlaybackStore((s) => s.pxPerSec);
  const setPxPerSec = usePlaybackStore((s) => s.setPxPerSec);
  const selectedClipIds = usePlaybackStore((s) => s.selectedClipIds);
  const selectClip = usePlaybackStore((s) => s.selectClip);
  const toggleClipSelection = usePlaybackStore((s) => s.toggleClipSelection);
  const setClipSelection = usePlaybackStore((s) => s.setClipSelection);
  const commitClipSelection = usePlaybackStore((s) => s.commitClipSelection);
  const visibleKeyframeComponentKeys = usePlaybackStore((s) => s.visibleKeyframeComponentKeys);
  const hideKeyframeComponents = usePlaybackStore((s) => s.hideKeyframeComponents);
  // Convenience: the single-selected clip ID (when exactly one is selected).
  const selectedClipId = selectedClipIds.length === 1 ? selectedClipIds[0]! : null;

  const assets = useMediaStore((s) => s.assets);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const trackEditorRef = useRef<HTMLDivElement | null>(null);
  const trackEditorHoverRef = useRef(false);
  const [viewportWidth, setViewportWidth] = useState(1200);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [dragOverlay, setDragOverlay] = useState<DragOverlay | null>(null);
  const [clipMenu, setClipMenu] = useState<{ x: number; y: number; clipId: string } | null>(null);
  const [replaceClipId, setReplaceClipId] = useState<string | null>(null);
  const [marquee, setMarquee] = useState<{ startX: number; startY: number; curX: number; curY: number } | null>(null);
  const [dragTrackId, setDragTrackId] = useState<string | null>(null);
  const [trackDropTarget, setTrackDropTarget] = useState<{ trackId: string; position: 'before' | 'after' } | null>(null);

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
  const visibleKeyframeKeySet = useMemo(() => new Set(visibleKeyframeComponentKeys), [visibleKeyframeComponentKeys]);
  const keyframeLanesByTrack = useMemo(() => {
    const lanes = new Map<string, TimelineKeyframeLane[]>();
    for (const track of tracks) lanes.set(track.id, []);
    for (const clip of project.clips) {
      const rows = getKeyframeProperties(clip, visibleKeyframeKeySet);
      if (rows.length === 0) continue;
      lanes.get(clip.trackId)?.push({
        clip,
        rows,
        height: laneHeightForRows(rows),
      });
    }
    for (const trackLanes of lanes.values()) {
      trackLanes.sort((a, b) => a.clip.startSec - b.clip.startSec);
    }
    return lanes;
  }, [project.clips, tracks, visibleKeyframeKeySet]);
  const keyframeLaneHeight = useMemo(() => {
    let total = 0;
    for (const lanes of keyframeLanesByTrack.values()) {
      for (const lane of lanes) total += lane.height;
    }
    return total;
  }, [keyframeLanesByTrack]);
  const {
    deleteSelectedKeyframe,
    selectedKeyframe,
    selectedKeyframeData,
    setSelectedKeyframe,
    setSelectedKeyframeValue,
    beginKeyframeDrag,
    moveKeyframe,
    moveKeyframeGroup,
    nudgeSelectedKeyframe,
    selectKeyframe,
    selectKeyframeGroup,
  } = useKeyframeController({
    clips: project.clips,
    selectedClip,
    currentTimeSec: currentTime,
    fps: project.fps,
    visibleKeyframeComponentKeys,
    update,
    updateSilent,
    beginTx,
    setCurrentTime,
  });

  const snapTargets = useMemo(() => {
    return buildSnapTargets(project.clips, currentTime);
  }, [project.clips, currentTime]);

  const trackIndexFromContentY = useCallback((contentY: number) => {
    let y = RULER_HEIGHT_PX;
    for (let index = 0; index < tracks.length; index += 1) {
      const track = tracks[index]!;
      if (contentY < y + TRACK_HEIGHT_PX) return index;
      y += TRACK_HEIGHT_PX;
      const laneHeight = (keyframeLanesByTrack.get(track.id) ?? []).reduce((sum, lane) => sum + lane.height, 0);
      if (contentY < y + laneHeight) return index;
      y += laneHeight;
    }
    return Math.max(0, tracks.length - 1);
  }, [keyframeLanesByTrack, tracks]);

  const isTrackEditorHovered = useCallback(() => (
    trackEditorHoverRef.current || Boolean(trackEditorRef.current?.matches(':hover'))
  ), []);

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
      const key = e.key.toLowerCase();

      if (mod && key === 'a' && isTrackEditorHovered()) {
        e.preventDefault();
        const allClipIds = useProjectStore.getState().project.clips.map((clip) => clip.id);
        setSelectedKeyframe(null);
        setClipSelection(allClipIds);
        return;
      }

      if (mod && key === 'c') {
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
      if (mod && key === 'v') {
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
      if (mod && key === 'd') {
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
        if (selectedKeyframe) {
          setSelectedKeyframe(null);
          return;
        }
        selectClip(null);
      } else if (selectedKeyframe && (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        if (e.key === 'ArrowLeft') nudgeSelectedKeyframe('time', -1);
        if (e.key === 'ArrowRight') nudgeSelectedKeyframe('time', 1);
        if (e.key === 'ArrowUp') nudgeSelectedKeyframe('value', 1);
        if (e.key === 'ArrowDown') nudgeSelectedKeyframe('value', -1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedClipId, currentTime, update, selectClip, setClipSelection, setClipboard, selectedKeyframe, deleteSelectedKeyframe, setSelectedKeyframe, nudgeSelectedKeyframe, isTrackEditorHovered]);

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
    const origDuration = clipTimelineDurationSec(clip);
    // The track the clip started on determines extraction eligibility.
    const origTrack = tracks.find((t) => t.id === origTrackId);
    const groupBounds = isGroupDrag
      ? selectedClipBounds(useProjectStore.getState().project.clips.filter((candidate) => priorSelection.includes(candidate.id)))
      : null;

    const startX = e.clientX;
    let lastGhost: DragOverlay | null = null;
    let txStarted = false;
    const ensureTx = () => {
      if (txStarted) return;
      beginTx();
      txStarted = true;
    };

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
      const candidate = snapMovedClipStartOrEnd(Math.max(0, origStart + dt), origDuration, snapTargets, pxPerSec);

      // Y → track index
      const contentY = ev.clientY - rect.top + scrollT;
      const trackIdx = trackIndexFromContentY(contentY);
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
        const snappedDelta = groupBounds
          ? snapMovedClipStartOrEnd(
              Math.max(0, groupBounds.startSec + dt),
              groupBounds.durationSec,
              snapTargets,
              pxPerSec,
            ) - groupBounds.startSec
          : dt;
        ensureTx();
        updateSilent((p) => moveClipsBy(p, priorSelection, snappedDelta));
        lastGhost = null;
        setDragOverlay(null);
      } else if (isAudioExtraction) {
        // Video stays put; show ghost on target audio track
        ensureTx();
        updateSilent((p) => moveClip(p, clipId, origStart, origTrackId));
        const ghost: DragOverlay = { clipId, ghostTrackIdx: trackIdx, isAudioExtraction: true };
        lastGhost = ghost;
        setDragOverlay(ghost);
      } else if (compatible) {
        ensureTx();
        updateSilent((p) => moveClip(p, clipId, candidate, targetTrack.id));
        lastGhost = null;
        setDragOverlay(null);
      } else {
        // Incompatible — snap back to original
        ensureTx();
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
      if (!el) {
        if (txStarted) cancelTx();
        return;
      }
      const rect = el.getBoundingClientRect();
      const scrollT = el.scrollTop;
      const trackIdx = trackIndexFromContentY(ev.clientY - rect.top + scrollT);
      const targetTrack = tracks[trackIdx];

      if (lastGhost?.isAudioExtraction && targetTrack?.kind === 'audio') {
        // Commit audio extraction as a normal history entry
        if (txStarted) cancelTx(); // cancel the beginTx snapshot (video never moved)
        update((p) => extractAudioFromClip(p, clipId, targetTrack.id));
      } else if (targetTrack && targetTrack.kind !== origTrack?.kind) {
        // Cross-kind drop that isn't an audio extraction — revert
        if (txStarted) cancelTx();
      }
      // Otherwise: committed via updateSilent; beginTx snapshot is the undo point
    };

    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }, [tracks, pxPerSec, snapTargets, assetById, selectClip, toggleClipSelection, beginTx, cancelTx, update, updateSilent, trackIndexFromContentY]);

  // ---- Clip trim ----
  const handleClipTrimMouseDown = useCallback((clipId: string, side: ClipDragSide, e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    pause();
    selectClip(clipId);

    const clip = useProjectStore.getState().project.clips.find((c) => c.id === clipId);
    if (!clip) return;
    const sourceAsset = assetById.get(clip.assetId);
    const maxSourceSec = sourceAsset?.durationSec;

    const startX = e.clientX;
    const origStart = clip.startSec;
    const origEnd = clip.startSec + clipTimelineDurationSec(clip);
    const trimSnapTargets = buildSnapTargets(useProjectStore.getState().project.clips, undefined, new Set([clipId]));
    setCurrentTime(trimPreviewTimeForClip(clip, side, project.fps));
    let txStarted = false;
    const ensureTx = () => {
      if (txStarted) return;
      beginTx();
      txStarted = true;
    };

    const move = (ev: MouseEvent) => {
      const dt = pxToTime(ev.clientX - startX, pxPerSec);
      let previewTime = trimPreviewTimeForClip(clip, side, project.fps);
      if (side === 'l') {
        const candidate = Math.max(0, origStart + dt);
        const snapped = ev.altKey ? candidate : snapTime(candidate, trimSnapTargets, pxPerSec, SNAP_TOLERANCE_PX);
        ensureTx();
        updateSilent((p) => {
          const next = trimClipLeftFromBaseline(p, clip, snapped);
          const nextClip = next.clips.find((candidate) => candidate.id === clipId);
          if (nextClip) previewTime = trimPreviewTimeForClip(nextClip, side, project.fps);
          return next;
        });
      } else {
        const candidate = origEnd + dt;
        const snapped = ev.altKey ? candidate : snapTime(candidate, trimSnapTargets, pxPerSec, SNAP_TOLERANCE_PX);
        ensureTx();
        updateSilent((p) => {
          const next = trimClipRightFromBaseline(p, clip, snapped, maxSourceSec);
          const nextClip = next.clips.find((candidate) => candidate.id === clipId);
          if (nextClip) previewTime = trimPreviewTimeForClip(nextClip, side, project.fps);
          return next;
        });
      }
      setCurrentTime(previewTime);
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }, [assetById, pause, project.fps, pxPerSec, selectClip, beginTx, setCurrentTime, updateSilent]);

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
    const initialSelection = usePlaybackStore.getState().selectedClipIds;
    setMarquee({ startX, startY, curX: startX, curY: startY });
    if (!additive) setClipSelection([], { silent: true });

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
      const idxStart = trackIndexFromContentY(y0);
      const idxEnd = trackIndexFromContentY(y1);
      const hitIds = new Set(baseline);
      for (const clip of useProjectStore.getState().project.clips) {
        const trackIdx = tracks.findIndex((t) => t.id === clip.trackId);
        if (trackIdx < idxStart || trackIdx > idxEnd) continue;
        const clipEnd = clip.startSec + clipTimelineDurationSec(clip);
        if (clipEnd < tStart || clip.startSec > tEnd) continue;
        hitIds.add(clip.id);
      }
      setClipSelection([...hitIds], { silent: true });
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      setMarquee(null);
      commitClipSelection(initialSelection);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }, [pxPerSec, tracks, setClipSelection, commitClipSelection, trackIndexFromContentY]);

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

  const hideTrackKeyframes = useCallback((trackId: string) => {
    const lanes = keyframeLanesByTrack.get(trackId) ?? [];
    const keys = new Set<string>();
    for (const lane of lanes) {
      for (const row of lane.rows) {
        keys.add(keyframeComponentVisibilityKey(lane.clip.id, row.componentId));
      }
    }
    hideKeyframeComponents([...keys]);
    if (selectedKeyframe && lanes.some((lane) => lane.clip.id === selectedKeyframe.clipId)) {
      setSelectedKeyframe(null);
    }
  }, [hideKeyframeComponents, keyframeLanesByTrack, selectedKeyframe, setSelectedKeyframe]);

  // Ghost clip for audio extraction preview
  const ghostClip = dragOverlay?.isAudioExtraction
    ? project.clips.find((c) => c.id === dragOverlay.clipId)
    : null;
  const ghostAsset = ghostClip ? assetById.get(ghostClip.assetId) : undefined;
  return (
    <div
      ref={trackEditorRef}
      className="flex h-full flex-col"
      onPointerEnter={() => {
        trackEditorHoverRef.current = true;
      }}
      onPointerMove={() => {
        trackEditorHoverRef.current = true;
      }}
      onPointerLeave={() => {
        trackEditorHoverRef.current = false;
      }}
      onMouseMove={() => {
        trackEditorHoverRef.current = true;
      }}
      onMouseLeave={() => {
        trackEditorHoverRef.current = false;
      }}
    >
      <div className="flex items-center justify-between border-b border-surface-700 px-3 py-1.5">
        <div className="flex items-center gap-2">
          <TrackCreateMenu
            onVideo={() => update((p) => addTrack(p, 'video'))}
            onAudio={() => update((p) => addTrack(p, 'audio'))}
          />
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
            <span className="text-slate-400">{`Transform ${selectedKeyframeData.componentIndex + 1}.${formatKeyframeProperty(selectedKeyframeData.property)}`}</span>
            <input
              type="number"
              className="w-24 rounded border border-surface-600 bg-surface-800 px-2 py-1 text-slate-100 outline-none"
              value={Number(selectedKeyframeData.value.toFixed(3))}
              onChange={(e) => {
                const nextValue = Number(e.target.value);
                if (!Number.isFinite(nextValue)) return;
                setSelectedKeyframeValue(nextValue);
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
                  {(keyframeLanesByTrack.get(t.id) ?? []).map((lane, index) => (
                    <KeyframeSidebarLane
                      key={`h-keyframes-${lane.clip.id}`}
                      clip={lane.clip}
                      currentTimeSec={currentTime}
                      rows={lane.rows}
                      showTitle={index === 0}
                      onHideTrackKeyframes={() => hideTrackKeyframes(t.id)}
                    />
                  ))}
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
                  {(keyframeLanesByTrack.get(track.id) ?? []).map((lane) => (
                    <KeyframeTrackLane
                      key={`keyframes-${lane.clip.id}`}
                      clip={lane.clip}
                      pxPerSec={pxPerSec}
                      fps={project.fps}
                      selectedKeyframe={selectedKeyframe}
                      rows={lane.rows}
                      onDeselectKeyframe={() => setSelectedKeyframe(null)}
                      onBeginKeyframeDrag={beginKeyframeDrag}
                      onMoveKeyframe={moveKeyframe}
                      onMoveKeyframeGroup={moveKeyframeGroup}
                      onSelectKeyframe={(meta) => {
                        selectClip(lane.clip.id);
                        selectKeyframe(meta);
                      }}
                      onSelectKeyframeGroup={(meta) => {
                        selectClip(lane.clip.id);
                        selectKeyframeGroup(meta);
                      }}
                      onEmptyMouseDown={handleEmptyMouseDown}
                    />
                  ))}
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

// Detect Mac once at module level so there are no per-render allocations.
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = IS_MAC ? '⌘' : 'Ctrl';
const ALT = IS_MAC ? '⌥' : 'Alt';

function trimPreviewTimeForClip(clip: Clip, side: ClipDragSide, fps: number): number {
  if (side === 'l') return clip.startSec;
  const frameDuration = 1 / Math.max(1, fps);
  const lastVisibleFrame = clip.startSec + clipTimelineDurationSec(clip) - frameDuration;
  return Math.max(clip.startSec, lastVisibleFrame);
}

function buildSnapTargets(clips: Clip[], currentTime?: number, excludedClipIds = new Set<string>()): number[] {
  const targets = new Set<number>([0]);
  if (currentTime !== undefined) targets.add(currentTime);
  for (const clip of clips) {
    if (excludedClipIds.has(clip.id)) continue;
    targets.add(clip.startSec);
    targets.add(clip.startSec + clipTimelineDurationSec(clip));
  }
  return [...targets];
}

function trimClipLeftFromBaseline(project: Project, baselineClip: Clip, newStartSec: number): Project {
  if (!project.clips.some((clip) => clip.id === baselineClip.id)) return project;
  const rawDelta = newStartSec - baselineClip.startSec;
  const minDelta = Math.max(-baselineClip.inSec, -baselineClip.startSec);
  const maxDelta = clipTimelineDurationSec(baselineClip) - MIN_CLIP_DURATION;
  const delta = Math.max(minDelta, Math.min(maxDelta, rawDelta));
  const nextInSec = baselineClip.inSec + delta * clipSpeed(baselineClip);
  const nextStart = baselineClip.startSec + delta;
  return {
    ...project,
    clips: project.clips.map((clip) => (
      clip.id === baselineClip.id ? { ...clip, startSec: nextStart, inSec: nextInSec } : clip
    )),
  };
}

function trimClipRightFromBaseline(
  project: Project,
  baselineClip: Clip,
  newEndSec: number,
  maxSourceSec?: number,
): Project {
  if (!project.clips.some((clip) => clip.id === baselineClip.id)) return project;
  const requestedDur = newEndSec - baselineClip.startSec;
  const maxDurFromSource = maxSourceSec !== undefined
    ? Math.max(MIN_CLIP_DURATION, (maxSourceSec - baselineClip.inSec) / clipSpeed(baselineClip))
    : Infinity;
  const dur = Math.max(MIN_CLIP_DURATION, Math.min(maxDurFromSource, requestedDur));
  const nextOutSec = baselineClip.inSec + dur * clipSpeed(baselineClip);
  return {
    ...project,
    clips: project.clips.map((clip) => (
      clip.id === baselineClip.id ? { ...clip, outSec: nextOutSec } : clip
    )),
  };
}

function snapMovedClipStartOrEnd(
  candidateStartSec: number,
  durationSec: number,
  targets: number[],
  pxPerSec: number,
): number {
  const toleranceSec = pxPerSec === 0 ? 0 : SNAP_TOLERANCE_PX / pxPerSec;
  let bestStart = candidateStartSec;
  let bestDist = toleranceSec;

  for (const target of targets) {
    const startDist = Math.abs(candidateStartSec - target);
    if (startDist <= bestDist) {
      bestDist = startDist;
      bestStart = target;
    }

    const endDist = Math.abs(candidateStartSec + durationSec - target);
    if (endDist <= bestDist) {
      bestDist = endDist;
      bestStart = target - durationSec;
    }
  }

  return Math.max(0, bestStart);
}

function selectedClipBounds(clips: Clip[]): { startSec: number; durationSec: number } | null {
  if (clips.length === 0) return null;
  const startSec = Math.min(...clips.map((clip) => clip.startSec));
  const endSec = Math.max(...clips.map((clip) => clip.startSec + clipTimelineDurationSec(clip)));
  return { startSec, durationSec: Math.max(0, endSec - startSec) };
}

function Key({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex items-center justify-center rounded border border-surface-500 bg-surface-700 px-1 py-px font-sans text-[10px] text-slate-200 shadow-[0_1px_0_0_rgba(0,0,0,0.5)]">
      {children}
    </kbd>
  );
}

function TrackCreateMenu({ onVideo, onAudio }: { onVideo: () => void; onAudio: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const closeOnPointer = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', closeOnPointer);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('pointerdown', closeOnPointer);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        className="btn-ghost px-2 py-1 text-xs"
        title="Add track"
        aria-haspopup="menu"
        aria-expanded={open}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={() => setOpen((value) => !value)}
      >
        <Plus size={12} /> Track
      </button>
      {open && (
        <div
          role="menu"
          className="absolute left-0 top-full z-40 mt-1 w-36 overflow-hidden rounded-md border border-surface-600 bg-surface-800 p-1 shadow-xl"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            className="block w-full rounded px-2 py-1.5 text-left text-xs text-slate-200 hover:bg-surface-700"
            onClick={() => {
              onVideo();
              setOpen(false);
            }}
          >
            Video track
          </button>
          <button
            type="button"
            role="menuitem"
            className="block w-full rounded px-2 py-1.5 text-left text-xs text-slate-200 hover:bg-surface-700"
            onClick={() => {
              onAudio();
              setOpen(false);
            }}
          >
            Audio track
          </button>
        </div>
      )}
    </div>
  );
}

function formatKeyframeProperty(property: string): string {
  if (property === 'offsetX') return 'Offset X';
  if (property === 'offsetY') return 'Offset Y';
  if (property === 'scale') return 'Scale';
  return property;
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
      <Hint keys={[MOD, 'A']} label="select all" />
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
