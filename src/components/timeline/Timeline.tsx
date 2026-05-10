import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Clip, MediaAsset, Project, Track } from '@/types';
import { ChevronLeft, FolderInput, Plus, Scissors } from 'lucide-react';
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
  clipFadeInSec,
  clipFadeOutSec,
  clipSpeed,
  clipTimelineDurationSec,
  duplicateClip,
  extractAudioFromClip,
  groupPathLabels,
  groupTrackDurationSec,
  groupTrackEndSec,
  groupTracks,
  insertTrack,
  MIN_CLIP_DURATION,
  moveClip,
  moveClipsBy,
  moveGroupTrackStart,
  moveTrack,
  pasteClipFrom,
  pasteClipsFrom,
  projectDurationSec,
  removeClip,
  replaceClipAsset,
  sortedTracks,
  splitClipAt,
  timelineAtPath,
  timelineStartOffsetSec,
  ungroupTrack,
  updateTimelineAtPath,
  withClampedClipFades,
} from '@/lib/timeline/operations';
import { ClipContextMenu, type ClipMenuAction } from './ClipContextMenu';
import { TrackContextMenu, type TrackMenuAction } from './TrackContextMenu';
import { ReplaceClipDialog } from './ReplaceClipDialog';
import { BridgeGenerateDialog, type BridgeGap } from './BridgeGenerateDialog';
import { KeyframeSidebarLane, KeyframeTrackLane } from './KeyframeTrackLane';
import { useKeyframeController } from './useKeyframeController';
import {
  getKeyframeProperties,
  KEYFRAME_COMPONENT_ROW_HEIGHT_PX,
  KEYFRAME_PROPERTY_ROW_HEIGHT_PX,
  KEYFRAME_TITLE_HEIGHT_PX,
  keyframeSelectionKey,
  laneHeightForRows,
  type KeyframePropertyRow,
  type KeyframeSelection,
} from './keyframeModel';
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

type TimelineProps = {
  onOpenSettings?: () => void;
  onMediaAssetHighlight?: (assetId: string) => void;
};

export function Timeline({ onOpenSettings, onMediaAssetHighlight }: TimelineProps = {}) {
  const rootProject = useProjectStore((s) => s.project);
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
  const selectedTrackIds = usePlaybackStore((s) => s.selectedTrackIds);
  const activeGroupPath = usePlaybackStore((s) => s.activeGroupPath);
  const selectClip = usePlaybackStore((s) => s.selectClip);
  const toggleClipSelection = usePlaybackStore((s) => s.toggleClipSelection);
  const setClipSelection = usePlaybackStore((s) => s.setClipSelection);
  const commitClipSelection = usePlaybackStore((s) => s.commitClipSelection);
  const selectTrack = usePlaybackStore((s) => s.selectTrack);
  const toggleTrackSelection = usePlaybackStore((s) => s.toggleTrackSelection);
  const setTrackSelection = usePlaybackStore((s) => s.setTrackSelection);
  const enterGroupTrack = usePlaybackStore((s) => s.enterGroupTrack);
  const exitGroupTrack = usePlaybackStore((s) => s.exitGroupTrack);
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
  const [trackMenu, setTrackMenu] = useState<{ x: number; y: number; trackId: string } | null>(null);
  const [replaceClipId, setReplaceClipId] = useState<string | null>(null);
  const [bridgeDialogGap, setBridgeDialogGap] = useState<BridgeGap | null>(null);
  const [bridgeModifierHeld, setBridgeModifierHeld] = useState(false);
  const [marquee, setMarquee] = useState<{ startX: number; startY: number; curX: number; curY: number } | null>(null);
  const [dragTrackId, setDragTrackId] = useState<string | null>(null);
  const [trackDropTarget, setTrackDropTarget] = useState<{ trackId: string; position: 'before' | 'after' } | null>(null);

  const setClipboard = usePlaybackStore((s) => s.setClipboard);
  // A Set version for O(1) membership checks in the render path.
  const selectedSet = useMemo(() => new Set(selectedClipIds), [selectedClipIds]);
  const selectedTrackSet = useMemo(() => new Set(selectedTrackIds), [selectedTrackIds]);

  const project = useMemo(() => timelineAtPath(rootProject, activeGroupPath), [rootProject, activeGroupPath]);
  const timelineOffsetSec = useMemo(() => timelineStartOffsetSec(rootProject, activeGroupPath), [rootProject, activeGroupPath]);
  const localCurrentTime = Math.max(0, currentTime - timelineOffsetSec);
  const breadcrumbLabels = useMemo(() => groupPathLabels(rootProject, activeGroupPath), [rootProject, activeGroupPath]);
  const setLocalCurrentTime = useCallback((timeSec: number) => {
    setCurrentTime(timeSec + timelineOffsetSec);
  }, [setCurrentTime, timelineOffsetSec]);
  const updateActive = useCallback((fn: (p: Project) => Project) => {
    update((p) => updateTimelineAtPath(p, activeGroupPath, fn));
  }, [activeGroupPath, update]);
  const updateActiveSilent = useCallback((fn: (p: Project) => Project) => {
    updateSilent((p) => updateTimelineAtPath(p, activeGroupPath, fn));
  }, [activeGroupPath, updateSilent]);

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
  const bridgeGapsByTrack = useMemo(() => {
    const byTrack = new Map<string, BridgeGap[]>();
    if (!bridgeModifierHeld) return byTrack;
    for (const gap of bridgeGapsForProject(project, assetById)) {
      const trackGaps = byTrack.get(gap.trackId) ?? [];
      trackGaps.push(gap);
      byTrack.set(gap.trackId, trackGaps);
    }
    return byTrack;
  }, [assetById, bridgeModifierHeld, project]);
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
    selectedKeyframes,
    setSelectedKeyframe,
    selectKeyframes,
    beginKeyframeDrag,
    moveKeyframe,
    moveKeyframeGroup,
    nudgeSelectedKeyframe,
    selectKeyframe,
    selectKeyframeGroup,
  } = useKeyframeController({
    clips: project.clips,
    selectedClip,
    currentTimeSec: localCurrentTime,
    fps: project.fps,
    visibleKeyframeComponentKeys,
    update: updateActive,
    updateSilent: updateActiveSilent,
    beginTx,
    setCurrentTime: setLocalCurrentTime,
  });

  const snapTargets = useMemo(() => {
    return buildSnapTargets(project, localCurrentTime);
  }, [project, localCurrentTime]);

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
  const syncBridgeModifier = useCallback((held: boolean) => {
    setBridgeModifierHeld((current) => (current === held ? current : held));
  }, []);

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

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.key === 'Meta' || event.key === 'Control') {
        setBridgeModifierHeld(true);
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (!event.metaKey && !event.ctrlKey) setBridgeModifierHeld(false);
      if (event.key === 'Meta' || event.key === 'Control') setBridgeModifierHeld(false);
    };
    const onBlur = () => setBridgeModifierHeld(false);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  const groupSelectedTracks = useCallback((trackIds: string[]): string | null => {
    const selectedIds = new Set(trackIds);
    const groupable = tracks.filter((track) => selectedIds.has(track.id));
    if (groupable.length < 2) return null;
    const groupTrackId = crypto.randomUUID?.().slice(0, 8) ?? `group-${Date.now().toString(36)}`;
    const groupId = crypto.randomUUID?.().slice(0, 8) ?? `timeline-${Date.now().toString(36)}`;
    updateActive((p) => groupTracks(p, groupable.map((track) => track.id), groupTrackId, groupId));
    setTrackSelection([groupTrackId]);
    return groupTrackId;
  }, [setTrackSelection, tracks, updateActive]);

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();

      if (mod && key === 'a' && isTrackEditorHovered()) {
        e.preventDefault();
        const allClipIds = project.clips.map((clip) => clip.id);
        setSelectedKeyframe(null);
        setClipSelection(allClipIds);
        return;
      }

      if (mod && key === 'g') {
        const selectedTracks = usePlaybackStore.getState().selectedTrackIds;
        if (selectedTracks.length < 2) return;
        e.preventDefault();
        const groupTrackId = groupSelectedTracks(selectedTracks);
        if (groupTrackId) selectTrack(groupTrackId);
        return;
      }

      if (mod && key === 'c') {
        const selected = usePlaybackStore.getState().selectedClipIds;
        if (selected.length === 0) return;
        const idSet = new Set(selected);
        const copied = project.clips
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
          updateActive((p) => pasteClipFrom(p, source, source.trackId, localCurrentTime));
        } else {
          updateActive((p) => pasteClipsFrom(p, copied, localCurrentTime));
        }
        return;
      }
      if (mod && key === 'd') {
        if (!selectedClipId) return;
        e.preventDefault();
        updateActive((p) => duplicateClip(p, selectedClipId));
        return;
      }

      if (e.key === 's' || e.key === 'S') {
        if (!selectedClipId) return;
        updateActive((p) => splitClipAt(p, selectedClipId, localCurrentTime));
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedKeyframe) {
          e.preventDefault();
          deleteSelectedKeyframe();
          return;
        }
        const ids = usePlaybackStore.getState().selectedClipIds;
        if (ids.length === 0) return;
        updateActive((p) => ids.reduce((proj, id) => removeClip(proj, id), p));
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
  }, [selectedClipId, localCurrentTime, project.clips, updateActive, selectClip, selectTrack, setClipSelection, setClipboard, selectedKeyframe, deleteSelectedKeyframe, setSelectedKeyframe, nudgeSelectedKeyframe, isTrackEditorHovered, groupSelectedTracks]);

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
        updateActive((p) => duplicateClip(p, clipId));
        break;
      case 'copy': {
        const source = project.clips.find((c) => c.id === clipId);
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
        updateActive((p) => removeClip(p, clipId));
        if (selectedClipId === clipId) selectClip(null);
        break;
    }
  }, [clipMenu, project.clips, updateActive, selectClip, selectedClipId, setClipboard]);

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

    const clip = project.clips.find((c) => c.id === clipId);
    if (!clip) return;

    const origStart = clip.startSec;
    const origTrackId = clip.trackId;
    const origDuration = clipTimelineDurationSec(clip);
    // The track the clip started on determines extraction eligibility.
    const origTrack = tracks.find((t) => t.id === origTrackId);
    const groupBounds = isGroupDrag
      ? selectedClipBounds(project.clips.filter((candidate) => priorSelection.includes(candidate.id)))
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
        !targetTrack.group &&
        origTrack?.kind === 'video' &&
        sourceAsset?.kind === 'video' &&
        targetTrack.kind === 'audio';
      // Compatible = same kind of track, or audio extraction.
      const compatible = !targetTrack.group && (isAudioExtraction || targetTrack.kind === origTrack?.kind);

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
        updateActiveSilent((p) => moveClipsBy(p, priorSelection, snappedDelta));
        lastGhost = null;
        setDragOverlay(null);
      } else if (isAudioExtraction) {
        // Video stays put; show ghost on target audio track
        ensureTx();
        updateActiveSilent((p) => moveClip(p, clipId, origStart, origTrackId));
        const ghost: DragOverlay = { clipId, ghostTrackIdx: trackIdx, isAudioExtraction: true };
        lastGhost = ghost;
        setDragOverlay(ghost);
      } else if (compatible) {
        ensureTx();
        updateActiveSilent((p) => moveClip(p, clipId, candidate, targetTrack.id));
        lastGhost = null;
        setDragOverlay(null);
      } else {
        // Incompatible — snap back to original
        ensureTx();
        updateActiveSilent((p) => moveClip(p, clipId, origStart, origTrackId));
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
        updateActive((p) => extractAudioFromClip(p, clipId, targetTrack.id));
      } else if (targetTrack && targetTrack.kind !== origTrack?.kind) {
        // Cross-kind drop that isn't an audio extraction — revert
        if (txStarted) cancelTx();
      }
      // Otherwise: committed via updateSilent; beginTx snapshot is the undo point
    };

    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }, [project.clips, tracks, pxPerSec, snapTargets, assetById, selectClip, toggleClipSelection, beginTx, cancelTx, updateActive, updateActiveSilent, trackIndexFromContentY]);

  // ---- Clip trim ----
  const handleClipTrimMouseDown = useCallback((clipId: string, side: ClipDragSide, e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    pause();
    selectClip(clipId);

    const clip = project.clips.find((c) => c.id === clipId);
    if (!clip) return;
    const sourceAsset = assetById.get(clip.assetId);
    const maxSourceSec = sourceAsset?.durationSec;

    const startX = e.clientX;
    const origStart = clip.startSec;
    const origEnd = clip.startSec + clipTimelineDurationSec(clip);
    const editingFade = e.shiftKey;
    const origFade = side === 'l' ? clipFadeInSec(clip) : clipFadeOutSec(clip);
    const trimSnapTargets = buildSnapTargets(project, undefined, new Set([clipId]));
    setLocalCurrentTime(editingFade
      ? fadePreviewTimeForClip(clip, side, origFade, project.fps)
      : trimPreviewTimeForClip(clip, side, project.fps));
    let txStarted = false;
    const ensureTx = () => {
      if (txStarted) return;
      beginTx();
      txStarted = true;
    };

    const move = (ev: MouseEvent) => {
      const dt = pxToTime(ev.clientX - startX, pxPerSec);
      let previewTime = editingFade
        ? fadePreviewTimeForClip(clip, side, origFade, project.fps)
        : trimPreviewTimeForClip(clip, side, project.fps);
      if (editingFade) {
        const nextFadeSec = side === 'l' ? origFade + dt : origFade - dt;
        ensureTx();
        updateActiveSilent((p) => {
          const next = setClipFadeFromBaseline(p, clip, side, nextFadeSec);
          const nextClip = next.clips.find((candidate) => candidate.id === clipId);
          if (nextClip) {
            previewTime = fadePreviewTimeForClip(
              nextClip,
              side,
              side === 'l' ? clipFadeInSec(nextClip) : clipFadeOutSec(nextClip),
              project.fps,
            );
          }
          return next;
        });
        setLocalCurrentTime(previewTime);
        return;
      }
      if (side === 'l') {
        const candidate = Math.max(0, origStart + dt);
        const snapped = ev.altKey ? candidate : snapTime(candidate, trimSnapTargets, pxPerSec, SNAP_TOLERANCE_PX);
        ensureTx();
        updateActiveSilent((p) => {
          const next = trimClipLeftFromBaseline(p, clip, snapped);
          const nextClip = next.clips.find((candidate) => candidate.id === clipId);
          if (nextClip) previewTime = trimPreviewTimeForClip(nextClip, side, project.fps);
          return next;
        });
      } else {
        const candidate = origEnd + dt;
        const snapped = ev.altKey ? candidate : snapTime(candidate, trimSnapTargets, pxPerSec, SNAP_TOLERANCE_PX);
        ensureTx();
        updateActiveSilent((p) => {
          const next = trimClipRightFromBaseline(p, clip, snapped, maxSourceSec);
          const nextClip = next.clips.find((candidate) => candidate.id === clipId);
          if (nextClip) previewTime = trimPreviewTimeForClip(nextClip, side, project.fps);
          return next;
        });
      }
      setLocalCurrentTime(previewTime);
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }, [assetById, pause, project, pxPerSec, selectClip, beginTx, setLocalCurrentTime, updateActiveSilent]);

  // ---- Asset drop from media bin ----
  const handleDropAsset = useCallback((trackId: string, assetId: string, startSec: number) => {
    const asset = assetById.get(assetId);
    if (!asset) return;
    updateActive((p) => addClip(p, asset, trackId, startSec));
  }, [assetById, updateActive]);

  // ---- Marquee selection from empty track area ----
  const handleEmptyMouseDown = useCallback((_trackId: string | null, e: React.MouseEvent) => {
    if (e.button !== 0) return;
    // Ctrl/Cmd-click on empty area starts an additive marquee; otherwise replaces.
    const additive = e.ctrlKey || e.metaKey;
    const el = scrollRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const startX = e.clientX - rect.left + el.scrollLeft;
    const startY = e.clientY - rect.top + el.scrollTop;
    const marqueeMode = isKeyframeContentY(startY, tracks, keyframeLanesByTrack) ? 'keyframes' : 'clips';
    const clipBaseline = additive ? usePlaybackStore.getState().selectedClipIds : [];
    const keyframeBaseline = additive ? selectedKeyframes : [];
    const initialSelection = usePlaybackStore.getState().selectedClipIds;
    setMarquee({ startX, startY, curX: startX, curY: startY });

    if (marqueeMode === 'keyframes') {
      if (!additive) selectKeyframes([]);
    } else {
      setSelectedKeyframe(null);
      if (!additive) setTrackSelection([]);
      if (!additive) setClipSelection([], { silent: true });
    }

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

      if (marqueeMode === 'keyframes') {
        const hits = collectKeyframesInRect({ x0, x1, y0, y1 }, tracks, keyframeLanesByTrack, pxPerSec, project.fps);
        const first = hits[0] ?? keyframeBaseline[0];
        selectKeyframes([...keyframeBaseline, ...hits]);
        if (first) selectClip(first.clipId);
        return;
      }

      const tStart = x0 / pxPerSec;
      const tEnd = x1 / pxPerSec;
      const idxStart = trackIndexFromContentY(y0);
      const idxEnd = trackIndexFromContentY(y1);
      const hitIds = new Set(clipBaseline);
      for (const clip of project.clips) {
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
      if (marqueeMode === 'clips') commitClipSelection(initialSelection);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }, [commitClipSelection, keyframeLanesByTrack, project, pxPerSec, selectClip, selectKeyframes, selectedKeyframes, setClipSelection, setSelectedKeyframe, setTrackSelection, trackIndexFromContentY, tracks]);

  const labelForTrack = (trackId: string) => {
    const track = project.tracks.find((t) => t.id === trackId);
    if (!track) return '';
    if (track.name) return track.name;
    const sameKind = tracks.filter((x) => x.kind === track.kind);
    return `${track.kind === 'video' ? 'V' : 'A'}${sameKind.findIndex((x) => x.id === trackId) + 1}`;
  };

  const replaceClip = replaceClipId ? project.clips.find((c) => c.id === replaceClipId) : null;
  const replaceAssetKind = replaceClip ? assetById.get(replaceClip.assetId)?.kind : undefined;

  const handleTrackSelect = useCallback((trackId: string, event: React.MouseEvent) => {
    setSelectedKeyframe(null);
    if (event.metaKey || event.ctrlKey) {
      toggleTrackSelection(trackId);
      return;
    }
    if (event.shiftKey && selectedTrackIds.length > 0) {
      const lastSelected = selectedTrackIds[selectedTrackIds.length - 1]!;
      const from = tracks.findIndex((track) => track.id === lastSelected);
      const to = tracks.findIndex((track) => track.id === trackId);
      if (from >= 0 && to >= 0) {
        const [start, end] = from < to ? [from, to] : [to, from];
        setTrackSelection(tracks.slice(start, end + 1).map((track) => track.id));
        return;
      }
    }
    selectTrack(trackId);
  }, [selectTrack, selectedTrackIds, setSelectedKeyframe, setTrackSelection, toggleTrackSelection, tracks]);

  const handleTrackContextMenu = useCallback((trackId: string, event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (!selectedTrackSet.has(trackId)) selectTrack(trackId);
    setTrackMenu({ x: event.clientX, y: event.clientY, trackId });
  }, [selectTrack, selectedTrackSet]);

  const handleTrackMenuAction = useCallback((action: TrackMenuAction) => {
    if (!trackMenu) return;
    const menuTrackId = trackMenu.trackId;
    if (action === 'group') {
      const ids = selectedTrackSet.has(menuTrackId) ? selectedTrackIds : [menuTrackId];
      const groupTrackId = groupSelectedTracks(ids);
      if (groupTrackId) selectTrack(groupTrackId);
      return;
    }
    if (action === 'enter-group') {
      const track = project.tracks.find((candidate) => candidate.id === menuTrackId);
      if (track?.group) enterGroupTrack(menuTrackId);
      return;
    }
    if (action === 'ungroup') {
      updateActive((p) => ungroupTrack(p, menuTrackId));
      setTrackSelection([]);
    }
  }, [enterGroupTrack, groupSelectedTracks, project.tracks, selectTrack, selectedTrackIds, selectedTrackSet, setTrackSelection, trackMenu, updateActive]);

  const handleGroupTrackMouseDown = useCallback((trackId: string, e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    handleTrackSelect(trackId, e);
    if (e.metaKey || e.ctrlKey) return;

    const track = project.tracks.find((candidate) => candidate.id === trackId);
    if (!track?.group) return;
    const startX = e.clientX;
    const origStart = track.group.startSec;
    const durationSec = groupTrackDurationSec(track);
    const groupSnapTargets = buildSnapTargets(project, localCurrentTime, new Set(), new Set([trackId]));
    let txStarted = false;
    const ensureTx = () => {
      if (txStarted) return;
      beginTx();
      txStarted = true;
    };

    const move = (ev: MouseEvent) => {
      const dt = pxToTime(ev.clientX - startX, pxPerSec);
      const candidate = Math.max(0, origStart + dt);
      const snapped = ev.altKey
        ? candidate
        : snapMovedClipStartOrEnd(candidate, durationSec, groupSnapTargets, pxPerSec);
      ensureTx();
      updateActiveSilent((p) => moveGroupTrackStart(p, trackId, snapped));
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }, [beginTx, handleTrackSelect, localCurrentTime, project, pxPerSec, updateActiveSilent]);

  const handleGroupTrackContextMenu = useCallback((trackId: string, e: React.MouseEvent) => {
    handleTrackContextMenu(trackId, e);
  }, [handleTrackContextMenu]);

  const handleTrackDrop = useCallback(() => {
    if (!dragTrackId || !trackDropTarget) return;
    const ordered = sortedTracks(project);
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
    updateActive((p) => moveTrack(p, dragTrackId, to));
    setDragTrackId(null);
    setTrackDropTarget(null);
  }, [dragTrackId, project, trackDropTarget, updateActive]);

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
      onPointerMove={(event) => {
        trackEditorHoverRef.current = true;
        syncBridgeModifier(event.metaKey || event.ctrlKey);
      }}
      onPointerLeave={() => {
        trackEditorHoverRef.current = false;
      }}
      onMouseMove={(event) => {
        trackEditorHoverRef.current = true;
        syncBridgeModifier(event.metaKey || event.ctrlKey);
      }}
      onMouseLeave={() => {
        trackEditorHoverRef.current = false;
      }}
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-b border-surface-700 px-3 py-1.5">
        <div className="flex shrink-0 items-center gap-2">
          {activeGroupPath.length > 0 && (
            <button
              className="btn-ghost px-2 py-1 text-xs"
              onClick={exitGroupTrack}
              title="Back to parent timeline"
            >
              <ChevronLeft size={12} /> Back
            </button>
          )}
          <TrackCreateMenu
            onVideo={() => updateActive((p) => addTrack(p, 'video'))}
            onAudio={() => updateActive((p) => addTrack(p, 'audio'))}
          />
          <button
            className="btn-ghost px-2 py-1 text-xs disabled:opacity-50"
            disabled={selectedTrackIds.length < 2}
            onClick={() => {
              const groupTrackId = groupSelectedTracks(selectedTrackIds);
              if (groupTrackId) selectTrack(groupTrackId);
            }}
            title={`Group selected tracks (${MOD}+G)`}
          >
            <FolderInput size={12} /> Group
          </button>
          <button
            className="btn-ghost px-2 py-1 text-xs disabled:opacity-50"
            disabled={!selectedClipId}
            onClick={() => selectedClipId && updateActive((p) => splitClipAt(p, selectedClipId, localCurrentTime))}
            title="Split at playhead (S)"
          >
            <Scissors size={12} /> Split
          </button>
        </div>
        {breadcrumbLabels.length > 0 && (
          <div className="min-w-0 flex-1 truncate px-2 text-center text-[11px] text-slate-400">
            Root / {breadcrumbLabels.join(' / ')}
          </div>
        )}
        <ShortcutHints />
      </div>
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
                    selected={selectedTrackSet.has(t.id)}
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
                    onSelect={(event) => handleTrackSelect(t.id, event)}
                    onContextMenu={(event) => handleTrackContextMenu(t.id, event)}
                    onEnterGroup={() => {
                      if (t.group) enterGroupTrack(t.id);
                    }}
                    onInsertVideoBelow={() => updateActive((p) => insertTrack(p, 'video', t.index + 1))}
                    onInsertAudioBelow={() => updateActive((p) => insertTrack(p, 'audio', t.index + 1))}
                  />
                  {(keyframeLanesByTrack.get(t.id) ?? []).map((lane, index) => (
                    <KeyframeSidebarLane
                      key={`h-keyframes-${lane.clip.id}`}
                      clip={lane.clip}
                      currentTimeSec={localCurrentTime}
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
              clips={project.clips}
              onScrub={setLocalCurrentTime}
            />
            <div>
              {tracks.map((track) => (
                <div key={track.id}>
                  <TimelineTrack
                    track={track}
                    clips={project.clips.filter((c) => c.trackId === track.id)}
                    pxPerSec={pxPerSec}
                    selectedClipIds={selectedSet}
                    selectedTrackIds={selectedTrackSet}
                    contentWidth={contentWidth}
                    onDropAsset={handleDropAsset}
                    onClipBodyMouseDown={handleClipBodyMouseDown}
                    onClipTrimMouseDown={handleClipTrimMouseDown}
                    onClipContextMenu={handleClipContextMenu}
                    onGroupTrackMouseDown={handleGroupTrackMouseDown}
                    onGroupTrackDoubleClick={(trackId) => enterGroupTrack(trackId)}
                    onGroupTrackContextMenu={handleGroupTrackContextMenu}
                    bridgeGaps={bridgeGapsByTrack.get(track.id) ?? []}
                    onBridgeGapClick={(gap, event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setBridgeDialogGap(gap);
                    }}
                    onEmptyMouseDown={handleEmptyMouseDown}
                  />
                  {(keyframeLanesByTrack.get(track.id) ?? []).map((lane) => (
                    <KeyframeTrackLane
                      key={`keyframes-${lane.clip.id}`}
                      clip={lane.clip}
                      pxPerSec={pxPerSec}
                      fps={project.fps}
                      selectedKeyframe={selectedKeyframe}
                      selectedKeyframes={selectedKeyframes}
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
                      onEmptyMouseDown={(event) => handleEmptyMouseDown(null, event)}
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
              timeSec={localCurrentTime}
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

      {trackMenu && (
        <TrackContextMenu
          x={trackMenu.x}
          y={trackMenu.y}
          canGroup={(selectedTrackSet.has(trackMenu.trackId) ? selectedTrackIds.length : 1) >= 2}
          canEnterGroup={Boolean(project.tracks.find((track) => track.id === trackMenu.trackId)?.group)}
          canUngroup={Boolean(project.tracks.find((track) => track.id === trackMenu.trackId)?.group)}
          onPick={handleTrackMenuAction}
          onClose={() => setTrackMenu(null)}
        />
      )}

      {replaceClip && replaceAssetKind && (
        <ReplaceClipDialog
          clip={replaceClip}
          requiredKind={replaceAssetKind}
          onReplace={(assetId, inSec, outSec) => {
            updateActive((p) => replaceClipAsset(p, replaceClip.id, assetId, inSec, outSec));
          }}
          onClose={() => setReplaceClipId(null)}
        />
      )}
      {bridgeDialogGap && (
        <BridgeGenerateDialog
          gap={bridgeDialogGap}
          onClose={() => setBridgeDialogGap(null)}
          onOpenSettings={() => onOpenSettings?.()}
          onHighlightMediaAsset={(assetId) => onMediaAssetHighlight?.(assetId)}
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

function fadePreviewTimeForClip(clip: Clip, side: ClipDragSide, fadeSec: number, fps: number): number {
  const frameDuration = 1 / Math.max(1, fps);
  const durationSec = clipTimelineDurationSec(clip);
  const clampedFade = Math.max(0, Math.min(durationSec, fadeSec));
  const maxPreviewLocalTime = Math.max(0, durationSec - frameDuration);
  if (side === 'l') return clip.startSec + Math.min(maxPreviewLocalTime, clampedFade);
  return clip.startSec + Math.max(0, durationSec - Math.max(frameDuration, clampedFade));
}

function buildSnapTargets(
  project: Project,
  currentTime?: number,
  excludedClipIds = new Set<string>(),
  excludedGroupTrackIds = new Set<string>(),
): number[] {
  const targets = new Set<number>([0]);
  if (currentTime !== undefined) targets.add(currentTime);
  for (const clip of project.clips) {
    if (excludedClipIds.has(clip.id)) continue;
    targets.add(clip.startSec);
    targets.add(clip.startSec + clipTimelineDurationSec(clip));
  }
  for (const track of project.tracks) {
    if (!track.group || excludedGroupTrackIds.has(track.id)) continue;
    targets.add(track.group.startSec);
    targets.add(groupTrackEndSec(track));
  }
  return [...targets];
}

function bridgeGapsForProject(
  project: Project,
  assetById: Map<string, MediaAsset>,
): BridgeGap[] {
  const gaps: BridgeGap[] = [];
  for (const track of project.tracks) {
    if (track.kind !== 'video' || track.group) continue;
    const clips = project.clips
      .filter((clip) => clip.trackId === track.id)
      .sort((first, second) => first.startSec - second.startSec);
    for (let index = 0; index < clips.length - 1; index += 1) {
      const leftClip = clips[index]!;
      const rightClip = clips[index + 1]!;
      const leftEndSec = leftClip.startSec + clipTimelineDurationSec(leftClip);
      const rightStartSec = rightClip.startSec;
      const gapDurationSec = rightStartSec - leftEndSec;
      if (gapDurationSec <= 1) continue;
      const leftAsset = assetById.get(leftClip.assetId);
      const rightAsset = assetById.get(rightClip.assetId);
      if (leftAsset?.kind !== 'video' || rightAsset?.kind !== 'video') continue;
      if (leftAsset.generation?.status === 'generating' || rightAsset.generation?.status === 'generating') continue;
      if (!leftAsset.blobKey || !rightAsset.blobKey) continue;
      gaps.push({
        trackId: track.id,
        startSec: leftEndSec,
        endSec: rightStartSec,
        durationSec: gapDurationSec,
        leftClip,
        rightClip,
      });
    }
  }
  return gaps;
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
      clip.id === baselineClip.id ? withClampedClipFades({ ...clip, startSec: nextStart, inSec: nextInSec }) : clip
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
      clip.id === baselineClip.id ? withClampedClipFades({ ...clip, outSec: nextOutSec }) : clip
    )),
  };
}

function setClipFadeFromBaseline(
  project: Project,
  baselineClip: Clip,
  side: ClipDragSide,
  fadeSec: number,
): Project {
  if (!project.clips.some((clip) => clip.id === baselineClip.id)) return project;
  const durationSec = clipTimelineDurationSec(baselineClip);
  const oppositeFadeSec = side === 'l' ? clipFadeOutSec(baselineClip) : clipFadeInSec(baselineClip);
  const clampedFade = Math.max(0, Math.min(Math.max(0, durationSec - oppositeFadeSec), fadeSec));
  return {
    ...project,
    clips: project.clips.map((clip) => (
      clip.id === baselineClip.id
        ? withClampedClipFades({
            ...clip,
            fadeInSec: side === 'l' ? clampedFade : clip.fadeInSec,
            fadeOutSec: side === 'r' ? clampedFade : clip.fadeOutSec,
          })
        : clip
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

function isKeyframeContentY(
  contentY: number,
  tracks: Track[],
  keyframeLanesByTrack: Map<string, TimelineKeyframeLane[]>,
): boolean {
  let y = RULER_HEIGHT_PX;
  for (const track of tracks) {
    if (contentY < y + TRACK_HEIGHT_PX) return false;
    y += TRACK_HEIGHT_PX;
    for (const lane of keyframeLanesByTrack.get(track.id) ?? []) {
      if (contentY < y + lane.height) return true;
      y += lane.height;
    }
  }
  return false;
}

function collectKeyframesInRect(
  rect: { x0: number; x1: number; y0: number; y1: number },
  tracks: Track[],
  keyframeLanesByTrack: Map<string, TimelineKeyframeLane[]>,
  pxPerSec: number,
  fps: number,
): KeyframeSelection[] {
  const hits: KeyframeSelection[] = [];
  const seen = new Set<string>();
  const safeFps = Math.max(1, fps);
  let y = RULER_HEIGHT_PX;

  const addHit = (selection: KeyframeSelection) => {
    const key = keyframeSelectionKey(selection);
    if (seen.has(key)) return;
    seen.add(key);
    hits.push(selection);
  };

  for (const track of tracks) {
    y += TRACK_HEIGHT_PX;
    for (const lane of keyframeLanesByTrack.get(track.id) ?? []) {
      const laneY = y;
      const clipDurationSec = Math.max(1e-6, clipTimelineDurationSec(lane.clip));
      const clipLeftPx = timeToPx(lane.clip.startSec, pxPerSec);
      const clipWidthPx = Math.max(48, timeToPx(clipDurationSec, pxPerSec));
      const titleY = laneY + KEYFRAME_TITLE_HEIGHT_PX - 8;
      const frameGroups = collectFrameGroupsForMarquee(lane.rows, safeFps, lane.clip.id);

      for (const group of frameGroups) {
        const x = clipLeftPx + Math.max(0, Math.min(clipWidthPx, timeToPx(group.timeSec, pxPerSec)));
        if (pointInRect(x, titleY, rect)) group.members.forEach(addHit);
      }

      let rowY = laneY + KEYFRAME_TITLE_HEIGHT_PX;
      for (const group of groupKeyframeRowsForMarquee(lane.rows)) {
        rowY += KEYFRAME_COMPONENT_ROW_HEIGHT_PX;
        for (const row of group.rows) {
          const pointY = rowY + KEYFRAME_PROPERTY_ROW_HEIGHT_PX / 2;
          for (const point of row.points) {
            const frame = Math.round(point.timeSec * safeFps);
            const frameTimeSec = Math.max(0, Math.min(clipDurationSec, frame / safeFps));
            const x = clipLeftPx + Math.max(0, Math.min(clipWidthPx, timeToPx(frameTimeSec, pxPerSec)));
            if (pointInRect(x, pointY, rect)) {
              addHit({
                clipId: lane.clip.id,
                componentIndex: row.componentIndex,
                componentId: row.componentId,
                property: row.property,
                keyframeId: point.id,
              });
            }
          }
          rowY += KEYFRAME_PROPERTY_ROW_HEIGHT_PX;
        }
      }

      y += lane.height;
    }
  }

  return hits;
}

function pointInRect(x: number, y: number, rect: { x0: number; x1: number; y0: number; y1: number }): boolean {
  return x >= rect.x0 && x <= rect.x1 && y >= rect.y0 && y <= rect.y1;
}

function groupKeyframeRowsForMarquee(rows: KeyframePropertyRow[]) {
  const groups: Array<{ componentId: string; rows: KeyframePropertyRow[] }> = [];
  for (const row of rows) {
    const last = groups.at(-1);
    if (last?.componentId === row.componentId) {
      last.rows.push(row);
    } else {
      groups.push({ componentId: row.componentId, rows: [row] });
    }
  }
  return groups;
}

function collectFrameGroupsForMarquee(rows: KeyframePropertyRow[], fps: number, clipId: string) {
  const groups = new Map<number, { timeSec: number; members: KeyframeSelection[] }>();
  for (const row of rows) {
    for (const point of row.points) {
      const frame = Math.round(point.timeSec * fps);
      const member = {
        clipId,
        componentIndex: row.componentIndex,
        componentId: row.componentId,
        property: row.property,
        keyframeId: point.id,
      };
      const existing = groups.get(frame);
      if (existing) {
        existing.members.push(member);
      } else {
        groups.set(frame, { timeSec: frame / fps, members: [member] });
      }
    }
  }
  return [...groups.values()];
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

function Hint({ keys, label }: { keys: React.ReactNode[]; label: string }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap">
      {keys.map((k, i) => <Key key={i}>{k}</Key>)}
      <span className="ml-1 text-slate-500">{label}</span>
    </span>
  );
}

function ShortcutHints() {
  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-x-3 gap-y-1 overflow-hidden text-[11px]">
      <Hint keys={[MOD, 'scroll']} label="zoom" />
      <Hint keys={['S']} label="split" />
      <Hint keys={['Del']} label="remove" />
      <Hint keys={[MOD, 'Z']} label="undo" />
      <Hint keys={[MOD, IS_MAC ? '⇧' : 'Shift', 'Z']} label="redo" />
      <Hint keys={[MOD, 'A']} label="select all" />
      <Hint keys={[MOD, 'G']} label="group tracks" />
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
