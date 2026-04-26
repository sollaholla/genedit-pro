import { create } from 'zustand';
import type { Clip } from '@/types';
import { DEFAULT_PX_PER_SEC, clampPxPerSec, snapTimeToFrame, type FrameSnapMode } from '@/lib/timeline/geometry';
import { nextHistorySeq, notifyHistoryMutation, subscribeHistoryMutation } from './historyClock';
import { useProjectStore } from './projectStore';

export type ClipAudioLevel = {
  left: number;
  right: number;
};

const MAX_SELECTION_HISTORY = 500;

type SetCurrentTimeOptions = {
  snap?: boolean;
  snapMode?: FrameSnapMode;
};

type PlaybackState = {
  playing: boolean;
  currentTimeSec: number;
  pxPerSec: number;
  /** IDs of all currently selected clips. Empty = nothing selected. */
  selectedClipIds: string[];
  _selectionPast: string[][];
  _selectionFuture: string[][];
  _selectionPastSeq: number[];
  _selectionFutureSeq: number[];
  clipboard: Clip[];
  /** Map of clipId -> true when the underlying media element has enough data
   *  (readyState >= HAVE_FUTURE_DATA) to play without stutter. Updated by
   *  PreviewPlayer each RAF frame, diff-guarded so renders are rare. */
  clipReadiness: Record<string, boolean>;
  /** Active transform card for inspector/preview edits on the selected clip. */
  activeTransformComponentId: string | null;
  /** Clip/component keys whose keyframes are visible in the timeline. */
  visibleKeyframeComponentKeys: string[];
  /** Overall output gain (0–2). Applied at the master GainNode in PreviewPlayer. */
  masterVolume: number;
  clipAudioLevels: Record<string, ClipAudioLevel>;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  setCurrentTime: (t: number, options?: SetCurrentTimeOptions) => void;
  setPxPerSec: (v: number) => void;
  zoomBy: (delta: number) => void;
  /** Replace selection with just this clip, or clear if null. */
  selectClip: (id: string | null, options?: { silent?: boolean }) => void;
  /** Add or remove clipId from the selection (Ctrl/Cmd-click semantics). */
  toggleClipSelection: (id: string, options?: { silent?: boolean }) => void;
  /** Replace the selection with the provided list (marquee commits this). */
  setClipSelection: (ids: string[], options?: { silent?: boolean }) => void;
  /** Commit a silent selection gesture using the provided previous selection. */
  commitClipSelection: (previousIds: string[]) => void;
  undoSelection: () => void;
  redoSelection: () => void;
  peekSelectionUndoSeq: () => number | null;
  peekSelectionRedoSeq: () => number | null;
  setClipboard: (clips: Clip[]) => void;
  setClipReadiness: (readiness: Record<string, boolean>) => void;
  setActiveTransformComponentId: (id: string | null) => void;
  showKeyframeComponent: (id: string) => void;
  toggleKeyframeComponent: (id: string) => void;
  hideKeyframeComponent: (id: string) => void;
  hideKeyframeComponents: (ids: string[]) => void;
  setMasterVolume: (v: number) => void;
  setClipAudioLevels: (levels: Record<string, ClipAudioLevel>) => void;
};

export const usePlaybackStore = create<PlaybackState>((set, get) => ({
  playing: false,
  currentTimeSec: 0,
  pxPerSec: DEFAULT_PX_PER_SEC,
  selectedClipIds: [],
  _selectionPast: [],
  _selectionFuture: [],
  _selectionPastSeq: [],
  _selectionFutureSeq: [],
  clipboard: [],
  clipReadiness: {},
  activeTransformComponentId: null,
  visibleKeyframeComponentKeys: [],
  masterVolume: 1,
  clipAudioLevels: {},
  play: () => set({ playing: true }),
  pause: () => set({ playing: false }),
  toggle: () => set({ playing: !get().playing }),
  setCurrentTime: (t, options) => set({ currentTimeSec: normalizePlaybackTime(t, options) }),
  setPxPerSec: (v) => set({ pxPerSec: clampPxPerSec(v) }),
  zoomBy: (delta) => set({ pxPerSec: clampPxPerSec(get().pxPerSec * (1 + delta)) }),
  selectClip: (id, options) => {
    commitSelection(set, get, id ? [id] : [], {
      silent: options?.silent,
      activeTransformComponentId: null,
    });
  },
  toggleClipSelection: (id, options) => {
    const cur = get().selectedClipIds;
    commitSelection(set, get, cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id], {
      silent: options?.silent,
      activeTransformComponentId: get().activeTransformComponentId,
    });
  },
  setClipSelection: (ids, options) => {
    commitSelection(set, get, ids, {
      silent: options?.silent,
      activeTransformComponentId: ids.length === 1 ? get().activeTransformComponentId : null,
    });
  },
  commitClipSelection: (previousIds) => {
    const cur = normalizeSelection(get().selectedClipIds);
    const previous = normalizeSelection(previousIds);
    if (sameSelection(previous, cur)) return;
    const { _selectionPast, _selectionPastSeq } = get();
    set({
      _selectionPast: [..._selectionPast, previous].slice(-MAX_SELECTION_HISTORY),
      _selectionPastSeq: [..._selectionPastSeq, nextHistorySeq()].slice(-MAX_SELECTION_HISTORY),
      _selectionFuture: [],
      _selectionFutureSeq: [],
    });
    notifyHistoryMutation('selection');
  },
  undoSelection: () => {
    const { selectedClipIds, _selectionPast, _selectionPastSeq, _selectionFuture, _selectionFutureSeq } = get();
    if (_selectionPast.length === 0) return;
    const previous = _selectionPast[_selectionPast.length - 1]!;
    const seq = _selectionPastSeq[_selectionPastSeq.length - 1] ?? nextHistorySeq();
    set({
      selectedClipIds: previous,
      activeTransformComponentId: null,
      _selectionPast: _selectionPast.slice(0, -1),
      _selectionPastSeq: _selectionPastSeq.slice(0, -1),
      _selectionFuture: [selectedClipIds, ..._selectionFuture],
      _selectionFutureSeq: [seq, ..._selectionFutureSeq],
    });
  },
  redoSelection: () => {
    const { selectedClipIds, _selectionPast, _selectionPastSeq, _selectionFuture, _selectionFutureSeq } = get();
    if (_selectionFuture.length === 0) return;
    const next = _selectionFuture[0]!;
    set({
      selectedClipIds: next,
      activeTransformComponentId: null,
      _selectionPast: [..._selectionPast, selectedClipIds].slice(-MAX_SELECTION_HISTORY),
      _selectionPastSeq: [..._selectionPastSeq, nextHistorySeq()].slice(-MAX_SELECTION_HISTORY),
      _selectionFuture: _selectionFuture.slice(1),
      _selectionFutureSeq: _selectionFutureSeq.slice(1),
    });
  },
  peekSelectionUndoSeq: () => {
    const { _selectionPastSeq } = get();
    return _selectionPastSeq.length ? _selectionPastSeq[_selectionPastSeq.length - 1]! : null;
  },
  peekSelectionRedoSeq: () => {
    const { _selectionFutureSeq } = get();
    return _selectionFutureSeq.length ? _selectionFutureSeq[0]! : null;
  },
  setClipboard: (clips) => set({ clipboard: clips }),
  setClipReadiness: (readiness) => set({ clipReadiness: readiness }),
  setActiveTransformComponentId: (id) => set({ activeTransformComponentId: id }),
  showKeyframeComponent: (id) => {
    const cur = get().visibleKeyframeComponentKeys;
    if (!cur.includes(id)) set({ visibleKeyframeComponentKeys: [...cur, id] });
  },
  toggleKeyframeComponent: (id) => {
    const cur = get().visibleKeyframeComponentKeys;
    set({
      visibleKeyframeComponentKeys: cur.includes(id)
        ? cur.filter((candidate) => candidate !== id)
        : [...cur, id],
    });
  },
  hideKeyframeComponent: (id) => {
    const cur = get().visibleKeyframeComponentKeys;
    if (cur.includes(id)) set({ visibleKeyframeComponentKeys: cur.filter((candidate) => candidate !== id) });
  },
  hideKeyframeComponents: (ids) => {
    if (ids.length === 0) return;
    const hidden = new Set(ids);
    const cur = get().visibleKeyframeComponentKeys;
    const next = cur.filter((candidate) => !hidden.has(candidate));
    if (next.length !== cur.length) set({ visibleKeyframeComponentKeys: next });
  },
  setMasterVolume: (v) => set({ masterVolume: Math.max(0, Math.min(2, v)) }),
  setClipAudioLevels: (levels) => set({ clipAudioLevels: levels }),
}));

subscribeHistoryMutation((domain) => {
  if (domain === 'selection') return;
  usePlaybackStore.setState({ _selectionFuture: [], _selectionFutureSeq: [] });
});

type SelectionCommitOptions = {
  silent?: boolean;
  activeTransformComponentId: string | null;
};

function commitSelection(
  set: (partial: Partial<PlaybackState>) => void,
  get: () => PlaybackState,
  rawIds: string[],
  options: SelectionCommitOptions,
) {
  const current = normalizeSelection(get().selectedClipIds);
  const next = normalizeSelection(rawIds);
  if (sameSelection(current, next)) return;

  if (options.silent) {
    set({ selectedClipIds: next, activeTransformComponentId: options.activeTransformComponentId });
    return;
  }

  const { _selectionPast, _selectionPastSeq } = get();
  set({
    selectedClipIds: next,
    activeTransformComponentId: options.activeTransformComponentId,
    _selectionPast: [..._selectionPast, current].slice(-MAX_SELECTION_HISTORY),
    _selectionPastSeq: [..._selectionPastSeq, nextHistorySeq()].slice(-MAX_SELECTION_HISTORY),
    _selectionFuture: [],
    _selectionFutureSeq: [],
  });
  notifyHistoryMutation('selection');
}

function normalizeSelection(ids: string[]): string[] {
  return [...new Set(ids)];
}

function normalizePlaybackTime(timeSec: number, options?: SetCurrentTimeOptions): number {
  const clamped = Math.max(0, Number.isFinite(timeSec) ? timeSec : 0);
  if (options?.snap === false) return clamped;
  return snapTimeToFrame(clamped, useProjectStore.getState().project.fps, options?.snapMode ?? 'nearest');
}

function sameSelection(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((id, index) => id === b[index]);
}
