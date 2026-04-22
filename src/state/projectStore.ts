import { create } from 'zustand';
import type { Project } from '@/types';
import * as ops from '@/lib/timeline/operations';
import { createInitialProject } from '@/lib/timeline/operations';

const STORAGE_KEY = 'genedit-pro:project';

function loadProject(): Project {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return createInitialProject();
    const parsed = JSON.parse(raw) as Project;
    if (!parsed.tracks || !parsed.clips) return createInitialProject();
    return parsed;
  } catch {
    return createInitialProject();
  }
}

type ProjectState = {
  project: Project;
  setProject: (p: Project) => void;
  update: (fn: (p: Project) => Project) => void;
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
  setProject: (p) => {
    scheduleSave(p);
    set({ project: p });
  },
  update: (fn) => {
    const next = fn(get().project);
    scheduleSave(next);
    set({ project: next });
  },
  rename: (name) => {
    const next = { ...get().project, name };
    scheduleSave(next);
    set({ project: next });
  },
  reset: () => {
    const fresh = createInitialProject();
    scheduleSave(fresh);
    set({ project: fresh });
  },
}));

export const projectOps = ops;
