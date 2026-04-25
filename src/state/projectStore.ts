import { create } from 'zustand';
import type { ComponentInstance, Project } from '@/types';
import * as ops from '@/lib/timeline/operations';
import { createInitialProject } from '@/lib/timeline/operations';
import { normalizeColorCorrectionData } from '@/lib/components/colorCorrection';

const STORAGE_KEY = 'genedit-pro:project';
const MAX_HISTORY = 500;

function loadProject(): Project {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return createInitialProject();
    const parsed = JSON.parse(raw) as Project;
    if (!parsed.tracks || !parsed.clips) return createInitialProject();
    parsed.tracks = parsed.tracks.map((t, i) => ({
      ...t,
      name: (t as { name?: string }).name ?? `${t.kind === 'video' ? 'Video' : 'Audio'} ${i + 1}`,
    }));
    // Backfill clip props added after initial release.
    parsed.clips = parsed.clips.map((c) => ({
      ...c,
      volume: (c as { volume?: number }).volume ?? 1,
      speed: (c as { speed?: number }).speed ?? 1,
      scale: (c as { scale?: number }).scale ?? 1,
      transform: (c as {
        transform?: {
          scale?: number;
          offsetX?: number;
          offsetY?: number;
          keyframes?: Array<{
            id: string;
            timeSec: number;
            scale: number;
            offsetX: number;
            offsetY: number;
          }>;
        };
      }).transform
        ? {
          scale: (c as { transform: { scale?: number } }).transform.scale ?? 1,
          offsetX: (c as { transform: { offsetX?: number } }).transform.offsetX ?? 0,
          offsetY: (c as { transform: { offsetY?: number } }).transform.offsetY ?? 0,
          keyframes: (c as {
            transform: {
              keyframes?: Array<{
                id: string;
                timeSec: number;
                scale: number;
                offsetX: number;
                offsetY: number;
              }>;
            };
          }).transform.keyframes ?? [],
        }
        : undefined,
      components: (() => {
        const existing = (c as { components?: ComponentInstance[] }).components;
        if (existing?.length) {
          return existing.map((component) => normalizeComponent(component)).filter(Boolean) as ComponentInstance[];
        }
        const legacy = (c as {
          transform?: {
            scale?: number;
            offsetX?: number;
            offsetY?: number;
            keyframes?: Array<{ id: string; timeSec: number; scale: number; offsetX: number; offsetY: number }>;
          };
        }).transform;
        if (!legacy) return [];
        return [{
          id: 'legacy-transform',
          type: 'transform',
          data: {
            scale: legacy.scale ?? 1,
            offsetX: legacy.offsetX ?? 0,
            offsetY: legacy.offsetY ?? 0,
            keyframes: {
              scale: (legacy.keyframes ?? []).map((k) => ({ id: k.id, timeSec: k.timeSec, value: k.scale })),
              offsetX: (legacy.keyframes ?? []).map((k) => ({ id: k.id, timeSec: k.timeSec, value: k.offsetX })),
              offsetY: (legacy.keyframes ?? []).map((k) => ({ id: k.id, timeSec: k.timeSec, value: k.offsetY })),
            },
          },
        }] as ComponentInstance[];
      })(),
    }));
    return parsed;
  } catch {
    return createInitialProject();
  }
}

function normalizeComponent(component: ComponentInstance): ComponentInstance | null {
  if (component.type === 'colorCorrection') {
    return {
      ...component,
      data: normalizeColorCorrectionData(component.data),
    };
  }

  if (component.type === 'transform') {
    return {
      ...component,
      data: {
        scale: component.data?.scale ?? 1,
        offsetX: component.data?.offsetX ?? 0,
        offsetY: component.data?.offsetY ?? 0,
        keyframes: {
          scale: component.data?.keyframes?.scale ?? [],
          offsetX: component.data?.keyframes?.offsetX ?? [],
          offsetY: component.data?.keyframes?.offsetY ?? [],
        },
      },
    };
  }

  return null;
}

type ProjectState = {
  project: Project;
  _past: Project[];
  _future: Project[];
  /** Push fn(project) to history and update project. Clears redo stack. */
  update: (fn: (p: Project) => Project) => void;
  /** Update project without touching history (use during a drag gesture). */
  updateSilent: (fn: (p: Project) => Project) => void;
  /** Snapshot current project into _past before starting a gesture. */
  beginTx: () => void;
  /** Revert to the snapshot pushed by beginTx (cancel a gesture). */
  cancelTx: () => void;
  undo: () => void;
  redo: () => void;
  rename: (name: string) => void;
  reset: () => void;
};

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSave(p: Project) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
    } catch {
      // ignore quota errors
    }
  }, 400);
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  project: loadProject(),
  _past: [],
  _future: [],

  update: (fn) => {
    const { project, _past } = get();
    const next = fn(project);
    const past = [..._past.slice(-(MAX_HISTORY - 1)), project];
    scheduleSave(next);
    set({ project: next, _past: past, _future: [] });
  },

  updateSilent: (fn) => {
    const next = fn(get().project);
    scheduleSave(next);
    set({ project: next });
  },

  beginTx: () => {
    const { project, _past } = get();
    set({ _past: [..._past.slice(-(MAX_HISTORY - 1)), project], _future: [] });
  },

  cancelTx: () => {
    const { _past } = get();
    if (_past.length === 0) return;
    const prev = _past[_past.length - 1]!;
    scheduleSave(prev);
    set({ project: prev, _past: _past.slice(0, -1) });
  },

  undo: () => {
    const { project, _past, _future } = get();
    if (_past.length === 0) return;
    const prev = _past[_past.length - 1]!;
    scheduleSave(prev);
    set({ project: prev, _past: _past.slice(0, -1), _future: [project, ..._future] });
  },

  redo: () => {
    const { project, _past, _future } = get();
    if (_future.length === 0) return;
    const next = _future[0]!;
    scheduleSave(next);
    set({ project: next, _past: [..._past.slice(-(MAX_HISTORY - 1)), project], _future: _future.slice(1) });
  },

  rename: (name) => {
    get().update((p) => ({ ...p, name }));
  },

  reset: () => {
    const fresh = createInitialProject();
    scheduleSave(fresh);
    set({ project: fresh, _past: [], _future: [] });
  },
}));

export const projectOps = ops;
