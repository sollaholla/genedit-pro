import { create } from 'zustand';
import { nanoid } from 'nanoid';
import type { ComponentInstance, Project } from '@/types';
import * as ops from '@/lib/timeline/operations';
import { createInitialProject } from '@/lib/timeline/operations';
import { normalizeColorCorrectionData } from '@/lib/components/colorCorrection';
import { nextHistorySeq, notifyHistoryMutation, subscribeHistoryMutation } from './historyClock';

const STORAGE_KEY = 'genedit-pro:project';
const LEGACY_ASSETS_KEY = 'genedit-pro:assets';
const PROJECTS_INDEX_KEY = 'genedit-pro:projects:index';
const ACTIVE_PROJECT_ID_KEY = 'genedit-pro:projects:active';
const PROJECT_STORAGE_PREFIX = 'genedit-pro:projects:project:';
const MAX_HISTORY = 500;

export type ProjectSummary = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
};

function projectStorageKey(projectId: string): string {
  return `${PROJECT_STORAGE_PREFIX}${projectId}`;
}

function readProjectSummaries(): ProjectSummary[] {
  try {
    const raw = localStorage.getItem(PROJECTS_INDEX_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ProjectSummary[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((summary) => summary?.id && summary.name)
      .map((summary) => ({
        id: summary.id,
        name: summary.name,
        createdAt: Number.isFinite(summary.createdAt) ? summary.createdAt : Date.now(),
        updatedAt: Number.isFinite(summary.updatedAt) ? summary.updatedAt : Date.now(),
      }));
  } catch {
    return [];
  }
}

function writeProjectSummaries(projects: ProjectSummary[]) {
  try {
    localStorage.setItem(PROJECTS_INDEX_KEY, JSON.stringify(projects));
  } catch {
    // ignore quota errors
  }
}

function summaryForProject(project: Project, existing?: ProjectSummary): ProjectSummary {
  const now = Date.now();
  return {
    id: project.id,
    name: project.name.trim() || 'Untitled Project',
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

function upsertProjectSummary(projects: ProjectSummary[], project: Project): ProjectSummary[] {
  const existing = projects.find((summary) => summary.id === project.id);
  const nextSummary = summaryForProject(project, existing);
  const next = existing
    ? projects.map((summary) => (summary.id === project.id ? nextSummary : summary))
    : [...projects, nextSummary];
  return next.sort((first, second) => second.updatedAt - first.updatedAt);
}

function saveProjectNow(project: Project, projects: ProjectSummary[]) {
  try {
    localStorage.setItem(projectStorageKey(project.id), JSON.stringify(project));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(project));
    localStorage.setItem(ACTIVE_PROJECT_ID_KEY, project.id);
  } catch {
    // ignore quota errors
  }
  writeProjectSummaries(projects);
}

function normalizeProject(input: Project): Project {
  const parsed = { ...input } as Project;
  parsed.id = (parsed as { id?: string }).id ?? nanoid(12);
  parsed.name = parsed.name || 'Untitled Project';
  parsed.fps = Number.isFinite(parsed.fps) && parsed.fps > 0 ? parsed.fps : 30;
  parsed.width = Number.isFinite(parsed.width) && parsed.width > 0 ? parsed.width : 1920;
  parsed.height = Number.isFinite(parsed.height) && parsed.height > 0 ? parsed.height : 1080;
  parsed.tracks = Array.isArray(parsed.tracks) ? parsed.tracks : [];
  parsed.clips = Array.isArray(parsed.clips) ? parsed.clips : [];
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
  parsed.clips = parsed.clips.map((c) => ops.withClampedClipFades({
    ...c,
    volume: (c as { volume?: number }).volume ?? 1,
    speed: (c as { speed?: number }).speed ?? 1,
    scale: (c as { scale?: number }).scale ?? 1,
    fadeInSec: Number.isFinite((c as { fadeInSec?: number }).fadeInSec) ? Math.max(0, (c as { fadeInSec: number }).fadeInSec) : 0,
    fadeOutSec: Number.isFinite((c as { fadeOutSec?: number }).fadeOutSec) ? Math.max(0, (c as { fadeOutSec: number }).fadeOutSec) : 0,
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
}

function loadLegacyProject(): Project {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return createInitialProject();
    const parsed = JSON.parse(raw) as Project;
    if (!parsed.tracks || !parsed.clips) return createInitialProject();
    return normalizeProject(parsed);
  } catch {
    return createInitialProject();
  }
}

function initializeProjectRegistry(): { projects: ProjectSummary[]; activeProjectId: string } {
  let projects = readProjectSummaries();
  let activeProjectId = localStorage.getItem(ACTIVE_PROJECT_ID_KEY);
  if (projects.length === 0) {
    const legacyProject = loadLegacyProject();
    projects = [summaryForProject(legacyProject)];
    activeProjectId = legacyProject.id;
    saveProjectNow(legacyProject, projects);
  }
  if (!activeProjectId || !projects.some((summary) => summary.id === activeProjectId)) {
    activeProjectId = projects[0]!.id;
    try { localStorage.setItem(ACTIVE_PROJECT_ID_KEY, activeProjectId); } catch { /* ignore */ }
  }
  return { projects, activeProjectId };
}

function loadProjectById(projectId: string, projects: ProjectSummary[]): Project {
  try {
    const raw = localStorage.getItem(projectStorageKey(projectId));
    if (raw) return normalizeProject(JSON.parse(raw) as Project);
  } catch {
    // fall through to fresh project
  }
  const summary = projects.find((candidate) => candidate.id === projectId);
  return { ...createInitialProject(), id: projectId, name: summary?.name ?? 'Untitled Project' };
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
  projects: ProjectSummary[];
  activeProjectId: string;
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
  createProject: (name?: string) => string;
  switchProject: (id: string) => void;
  reset: () => void;
  recordGenerationCost: (amountUsd: number) => void;
  recordGenerationCostForProject: (projectId: string, amountUsd: number) => void;
};

function persistProjectState(project: Project, projects: ProjectSummary[]) {
  saveProjectNow(project, projects);
}

const initialRegistry = initializeProjectRegistry();
const initialProject = loadProjectById(initialRegistry.activeProjectId, initialRegistry.projects);

export const useProjectStore = create<ProjectState>((set, get) => ({
  project: initialProject,
  projects: upsertProjectSummary(initialRegistry.projects, initialProject),
  activeProjectId: initialProject.id,
  _past: [],
  _future: [],
  _pastSeq: [],
  _futureSeq: [],

  update: (fn) => {
    const { project, projects, _past, _pastSeq } = get();
    const next = fn(project);
    const nextProjects = upsertProjectSummary(projects, next);
    const past = [..._past, project].slice(-MAX_HISTORY);
    const pastSeq = [..._pastSeq, nextHistorySeq()].slice(-MAX_HISTORY);
    persistProjectState(next, nextProjects);
    set({ project: next, projects: nextProjects, _past: past, _pastSeq: pastSeq, _future: [], _futureSeq: [] });
    notifyHistoryMutation('project');
  },

  updateSilent: (fn) => {
    const next = fn(get().project);
    const nextProjects = upsertProjectSummary(get().projects, next);
    persistProjectState(next, nextProjects);
    set({ project: next, projects: nextProjects });
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
    const nextProjects = upsertProjectSummary(get().projects, prev);
    persistProjectState(prev, nextProjects);
    set({ project: prev, projects: nextProjects, _past: _past.slice(0, -1), _pastSeq: _pastSeq.slice(0, -1) });
  },

  undo: () => {
    const { project, projects, _past, _future, _pastSeq, _futureSeq } = get();
    if (_past.length === 0) return;
    const prev = _past[_past.length - 1]!;
    const seq = _pastSeq[_pastSeq.length - 1] ?? nextHistorySeq();
    const nextProjects = upsertProjectSummary(projects, prev);
    persistProjectState(prev, nextProjects);
    set({
      project: prev,
      projects: nextProjects,
      _past: _past.slice(0, -1),
      _pastSeq: _pastSeq.slice(0, -1),
      _future: [project, ..._future],
      _futureSeq: [seq, ..._futureSeq],
    });
  },

  redo: () => {
    const { project, projects, _past, _future, _pastSeq, _futureSeq } = get();
    if (_future.length === 0) return;
    const next = _future[0]!;
    const nextProjects = upsertProjectSummary(projects, next);
    persistProjectState(next, nextProjects);
    set({
      project: next,
      projects: nextProjects,
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
    const current = get().project;
    const fresh = { ...createInitialProject(), id: current.id, name: current.name };
    const nextProjects = upsertProjectSummary(get().projects, fresh);
    persistProjectState(fresh, nextProjects);
    set({ project: fresh, projects: nextProjects, _past: [], _pastSeq: [], _future: [], _futureSeq: [] });
  },

  createProject: (name) => {
    const trimmedName = name?.trim();
    const fresh = {
      ...createInitialProject(),
      name: trimmedName || `Untitled Project ${get().projects.length + 1}`,
    };
    const nextProjects = upsertProjectSummary(get().projects, fresh);
    persistProjectState(fresh, nextProjects);
    set({
      project: fresh,
      projects: nextProjects,
      activeProjectId: fresh.id,
      _past: [],
      _pastSeq: [],
      _future: [],
      _futureSeq: [],
    });
    notifyHistoryMutation('project');
    return fresh.id;
  },

  switchProject: (id) => {
    const { project, projects } = get();
    if (id === project.id) return;
    const target = projects.find((summary) => summary.id === id);
    if (!target) return;
    persistProjectState(project, projects);
    const nextProject = loadProjectById(id, projects);
    const nextProjects = upsertProjectSummary(projects, nextProject);
    persistProjectState(nextProject, nextProjects);
    set({
      project: nextProject,
      projects: nextProjects,
      activeProjectId: nextProject.id,
      _past: [],
      _pastSeq: [],
      _future: [],
      _futureSeq: [],
    });
    notifyHistoryMutation('project');
  },

  recordGenerationCost: (amountUsd) => {
    if (!Number.isFinite(amountUsd) || amountUsd <= 0) return;
    const next = addGenerationSpend(get().project, amountUsd);
    const nextProjects = upsertProjectSummary(get().projects, next);
    persistProjectState(next, nextProjects);
    set({ project: next, projects: nextProjects });
  },

  recordGenerationCostForProject: (projectId, amountUsd) => {
    if (!Number.isFinite(amountUsd) || amountUsd <= 0) return;
    if (projectId === get().project.id) {
      get().recordGenerationCost(amountUsd);
      return;
    }
    const target = get().projects.find((summary) => summary.id === projectId);
    if (!target) return;
    const nextProject = addGenerationSpend(loadProjectById(projectId, get().projects), amountUsd);
    const nextProjects = upsertProjectSummary(get().projects, nextProject);
    persistProjectState(nextProject, nextProjects);
    set({ projects: nextProjects });
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
