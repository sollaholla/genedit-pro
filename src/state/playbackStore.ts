import { create } from 'zustand';
import type { Clip } from '@/types';
import { DEFAULT_PX_PER_SEC, clampPxPerSec } from '@/lib/timeline/geometry';

type PlaybackState = {
  playing: boolean;
  currentTimeSec: number;
  pxPerSec: number;
  /** IDs of all currently selected clips. Empty = nothing selected. */
  selectedClipIds: string[];
  clipboard: Clip | null;
  /** Map of clipId -> true when the underlying media element has enough data
   *  (readyState >= HAVE_FUTURE_DATA) to play without stutter. Updated by
   *  PreviewPlayer each RAF frame, diff-guarded so renders are rare. */
  clipReadiness: Record<string, boolean>;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  setCurrentTime: (t: number) => void;
  setPxPerSec: (v: number) => void;
  zoomBy: (delta: number) => void;
  /** Replace selection with just this clip, or clear if null. */
  selectClip: (id: string | null) => void;
  /** Add or remove clipId from the selection (Ctrl/Cmd-click semantics). */
  toggleClipSelection: (id: string) => void;
  /** Replace the selection with the provided list (marquee commits this). */
  setClipSelection: (ids: string[]) => void;
  setClipboard: (clip: Clip | null) => void;
  setClipReadiness: (readiness: Record<string, boolean>) => void;
};

export const usePlaybackStore = create<PlaybackState>((set, get) => ({
  playing: false,
  currentTimeSec: 0,
  pxPerSec: DEFAULT_PX_PER_SEC,
  selectedClipIds: [],
  clipboard: null,
  clipReadiness: {},
  play: () => set({ playing: true }),
  pause: () => set({ playing: false }),
  toggle: () => set({ playing: !get().playing }),
  setCurrentTime: (t) => set({ currentTimeSec: Math.max(0, t) }),
  setPxPerSec: (v) => set({ pxPerSec: clampPxPerSec(v) }),
  zoomBy: (delta) => set({ pxPerSec: clampPxPerSec(get().pxPerSec * (1 + delta)) }),
  selectClip: (id) => set({ selectedClipIds: id ? [id] : [] }),
  toggleClipSelection: (id) => {
    const cur = get().selectedClipIds;
    set({
      selectedClipIds: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id],
    });
  },
  setClipSelection: (ids) => set({ selectedClipIds: ids }),
  setClipboard: (clip) => set({ clipboard: clip }),
  setClipReadiness: (readiness) => set({ clipReadiness: readiness }),
}));
