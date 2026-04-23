import { create } from 'zustand';
import type { Clip } from '@/types';
import { DEFAULT_PX_PER_SEC, clampPxPerSec } from '@/lib/timeline/geometry';

type Selection = { kind: 'clip'; id: string } | { kind: 'none' };

type PlaybackState = {
  playing: boolean;
  currentTimeSec: number;
  pxPerSec: number;
  selection: Selection;
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
  selectClip: (id: string | null) => void;
  setClipboard: (clip: Clip | null) => void;
  setClipReadiness: (readiness: Record<string, boolean>) => void;
};

export const usePlaybackStore = create<PlaybackState>((set, get) => ({
  playing: false,
  currentTimeSec: 0,
  pxPerSec: DEFAULT_PX_PER_SEC,
  selection: { kind: 'none' },
  clipboard: null,
  clipReadiness: {},
  play: () => set({ playing: true }),
  pause: () => set({ playing: false }),
  toggle: () => set({ playing: !get().playing }),
  setCurrentTime: (t) => set({ currentTimeSec: Math.max(0, t) }),
  setPxPerSec: (v) => set({ pxPerSec: clampPxPerSec(v) }),
  zoomBy: (delta) => set({ pxPerSec: clampPxPerSec(get().pxPerSec * (1 + delta)) }),
  selectClip: (id) => set({ selection: id ? { kind: 'clip', id } : { kind: 'none' } }),
  setClipboard: (clip) => set({ clipboard: clip }),
  setClipReadiness: (readiness) => set({ clipReadiness: readiness }),
}));
