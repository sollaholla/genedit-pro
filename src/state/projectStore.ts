import { create } from 'zustand';
import type { ComponentInstance, Project } from '@/types';
import * as ops from '@/lib/timeline/operations';
import { createInitialProject } from '@/lib/timeline/operations';
import { normalizeColorCorrectionData } from '@/lib/components/colorCorrection';
import { nextHistorySeq, notifyHistoryMutation, subscribeHistoryMutation } from './historyClock';

const STORAGE_KEY = 'genedit-pro:project';
const LEGACY_ASSETS_KEY = 'genedit-pro:assets';
const MAX_HISTORY = 500;

function loadProject(): Project {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return createInitialProject();
    const parsed = JSON.parse(raw) as Project;
    if (!parsed.tracks || !parsed.clips) return createInitialProject();
    const storedGenerationSpend = parsed.metadata?.aiGenerationSpendUsd;
    parsed.metadata = {
      ...parsed.metadata,
      aiGenerationSpendUsd: Number.isFinite(storedGenerationSpend)
        ? storedGenerationSpend
        : legacyGenerationSpendFromStoredAssets(),
    };
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
  _pastSeq: number[];
  _futureSeq: number[];
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
  peekUndoSeq: () => number | null;
  peekRedoSeq: () => number | null;
  rename: (name: string) => void;
  reset: () => void;
  recordGenerationCost: (amountUsd: number) => void;
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
  _pastSeq: [],
  _futureSeq: [],

  update: (fn) => {
    const { project, _past, _pastSeq } = get();
    const next = fn(project);
    const past = [..._past, project].slice(-MAX_HISTORY);
    const pastSeq = [..._pastSeq, nextHistorySeq()].slice(-MAX_HISTORY);
    scheduleSave(next);
    set({ project: next, _past: past, _pastSeq: pastSeq, _future: [], _futureSeq: [] });
    notifyHistoryMutation('project');
  },

  updateSilent: (fn) => {
    const next = fn(get().project);
    scheduleSave(next);
    set({ project: next });
  },

  beginTx: () => {
    const { project, _past, _pastSeq } = get();
    set({
      _past: [..._past, project].slice(-MAX_HISTORY),
      _pastSeq: [..._pastSeq, nextHistorySeq()].slice(-MAX_HISTORY),
      _future: [],
      _futureSeq: [],
    });
    notifyHistoryMutation('project');
  },

  cancelTx: () => {
    const { _past, _pastSeq } = get();
    if (_past.length === 0) return;
    const prev = _past[_past.length - 1]!;
    scheduleSave(prev);
    set({ project: prev, _past: _past.slice(0, -1), _pastSeq: _pastSeq.slice(0, -1) });
  },

  undo: () => {
    const { project, _past, _future, _pastSeq, _futureSeq } = get();
    if (_past.length === 0) return;
    const prev = _past[_past.length - 1]!;
    const seq = _pastSeq[_pastSeq.length - 1] ?? nextHistorySeq();
    scheduleSave(prev);
    set({
      project: prev,
      _past: _past.slice(0, -1),
      _pastSeq: _pastSeq.slice(0, -1),
      _future: [project, ..._future],
      _futureSeq: [seq, ..._futureSeq],
    });
  },

  redo: () => {
    const { project, _past, _future, _pastSeq, _futureSeq } = get();
    if (_future.length === 0) return;
    const next = _future[0]!;
    scheduleSave(next);
    set({
      project: next,
      _past: [..._past, project].slice(-MAX_HISTORY),
      _pastSeq: [..._pastSeq, nextHistorySeq()].slice(-MAX_HISTORY),
      _future: _future.slice(1),
      _futureSeq: _futureSeq.slice(1),
    });
  },

  peekUndoSeq: () => {
    const { _pastSeq } = get();
    return _pastSeq.length ? _pastSeq[_pastSeq.length - 1]! : null;
  },

  peekRedoSeq: () => {
    const { _futureSeq } = get();
    return _futureSeq.length ? _futureSeq[0]! : null;
  },

  rename: (name) => {
    get().update((p) => ({ ...p, name }));
  },

  reset: () => {
    const fresh = createInitialProject();
    scheduleSave(fresh);
    set({ project: fresh, _past: [], _pastSeq: [], _future: [], _futureSeq: [] });
  },

  recordGenerationCost: (amountUsd) => {
    if (!Number.isFinite(amountUsd) || amountUsd <= 0) return;
    const next = addGenerationSpend(get().project, amountUsd);
    scheduleSave(next);
    set({ project: next });
  },
}));

export const projectOps = ops;

subscribeHistoryMutation((domain) => {
  if (domain === 'project') return;
  useProjectStore.setState({ _future: [], _futureSeq: [] });
});

function addGenerationSpend(project: Project, amountUsd: number): Project {
  const current = project.metadata?.aiGenerationSpendUsd ?? 0;
  return {
    ...project,
    metadata: {
      ...project.metadata,
      aiGenerationSpendUsd: Number((current + amountUsd).toFixed(4)),
    },
  };
}

function legacyGenerationSpendFromStoredAssets(): number {
  try {
    const raw = localStorage.getItem(LEGACY_ASSETS_KEY);
    if (!raw) return 0;
    const assets = JSON.parse(raw) as Array<{
      kind?: string;
      generation?: {
        status?: string;
        actualCostUsd?: number;
        estimatedCostUsd?: number;
      };
    }>;
    const total = assets.reduce((sum, asset) => {
      if ((asset.kind !== 'video' && asset.kind !== 'image') || asset.generation?.status !== 'done') return sum;
      const cost = asset.generation.actualCostUsd ?? asset.generation.estimatedCostUsd ?? 0;
      return Number.isFinite(cost) ? sum + cost : sum;
    }, 0);
    return Number(total.toFixed(4));
  } catch {
    return 0;
  }
}
