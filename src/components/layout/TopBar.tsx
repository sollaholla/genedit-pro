import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, ChevronDown, Clapperboard, Clock3, Cog, DollarSign, Download, FilePlus2, Film, Layers3, Loader2, Upload } from 'lucide-react';
import { useProjectStore, type ProjectSummary } from '@/state/projectStore';
import { useExportStore } from '@/state/exportStore';
import { readProjectMediaAssets, useMediaStore } from '@/state/mediaStore';
import type { MediaAsset } from '@/types';

type Props = {
  onImportClick: () => void;
  onExportClick: () => void;
  onNewProject: () => void;
  onSettingsClick: () => void;
};

type ProjectCard = ProjectSummary & {
  thumbnailDataUrl?: string;
  mediaCount: number;
};

export function TopBar({ onImportClick, onExportClick, onNewProject, onSettingsClick }: Props) {
  const project = useProjectStore((s) => s.project);
  const projects = useProjectStore((s) => s.projects);
  const rename = useProjectStore((s) => s.rename);
  const switchProject = useProjectStore((s) => s.switchProject);
  const activeAssets = useMediaStore((s) => s.assets);
  const exportStatus = useExportStore((s) => s.status);
  const exportProgress = useExportStore((s) => s.progress);
  const exportBusy = exportStatus === 'preparing' || exportStatus === 'encoding';
  const exportReady = exportStatus === 'done';
  const exportLabel = exportBusy
    ? `Exporting ${Math.round(exportProgress * 100)}%`
    : exportReady
      ? 'Export Ready'
      : 'Export';
  const navRef = useRef<HTMLDivElement | null>(null);
  const titleRef = useRef<HTMLDivElement | null>(null);
  const naturalTitleWidthRef = useRef(0);
  const [titleVisible, setTitleVisible] = useState(true);
  const projectCards = useMemo(() => {
    return projects.map((summary) => {
      const assets = summary.id === project.id ? activeAssets : readProjectMediaAssets(summary.id);
      return {
        ...summary,
        thumbnailDataUrl: projectThumbnail(summary, assets),
        mediaCount: assets.length,
      };
    });
  }, [activeAssets, project.id, projects]);
  const activeCard = projectCards.find((candidate) => candidate.id === project.id) ?? projectCards[0] ?? null;

  useLayoutEffect(() => {
    if (titleRef.current) {
      const measured = titleRef.current.offsetWidth;
      if (measured > 0) naturalTitleWidthRef.current = measured;
    }
  }, [titleVisible]);

  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const evaluate = () => {
      setTitleVisible((current) => {
        if (current) return nav.scrollWidth <= nav.clientWidth;
        const titleWidth = naturalTitleWidthRef.current;
        if (titleWidth <= 0) return true;
        const freeSpace = nav.clientWidth - nav.scrollWidth;
        return freeSpace >= titleWidth + 16;
      });
    };
    evaluate();
    const observer = new ResizeObserver(evaluate);
    observer.observe(nav);
    return () => observer.disconnect();
  }, []);

  return (
    <header className="flex h-12 items-center justify-between border-b border-surface-700 bg-surface-900 px-4">
      <div ref={navRef} className="flex min-w-0 items-center gap-3">
        <button className="rounded p-1.5 text-slate-400 hover:bg-surface-800 hover:text-slate-100" onClick={onSettingsClick} title="Settings">
          <Cog size={14} />
        </button>
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-brand-500 text-white">
          <Clapperboard size={16} />
        </div>
        {titleVisible && (
          <div ref={titleRef} className="whitespace-nowrap text-sm font-semibold tracking-tight">GenEdit Pro</div>
        )}
        <div className="h-5 w-px shrink-0 bg-surface-700" />
        <ProjectSelector
          activeProjectId={project.id}
          projects={projectCards}
          activeProject={activeCard}
          onSelect={switchProject}
          onNewProject={onNewProject}
        />
        <input
          type="text"
          value={project.name}
          onChange={(e) => rename(e.target.value)}
          className="w-56 rounded bg-transparent px-2 py-1 text-sm text-slate-200 outline-none ring-1 ring-transparent transition-colors focus:bg-surface-800 focus:ring-surface-600"
          title="Project name"
          spellCheck={false}
        />
      </div>
      <div className="flex items-center gap-2">
        <button className="btn-ghost" onClick={onNewProject} title="New Project">
          <FilePlus2 size={14} />
          New
        </button>
        <button className="btn-ghost" onClick={onImportClick} title="Import media">
          <Upload size={14} />
          Import
        </button>
        <button className="btn-primary" onClick={onExportClick} title={exportBusy ? 'Show background export' : 'Export video'}>
          {exportBusy ? <Loader2 size={14} className="animate-spin" /> : exportReady ? <CheckCircle2 size={14} /> : <Download size={14} />}
          {exportLabel}
        </button>
      </div>
    </header>
  );
}

function ProjectSelector({
  activeProjectId,
  projects,
  activeProject,
  onSelect,
  onNewProject,
}: {
  activeProjectId: string;
  projects: ProjectCard[];
  activeProject: ProjectCard | null;
  onSelect: (id: string) => void;
  onNewProject: () => void;
}) {
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
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        className="flex h-9 w-72 items-center gap-2 rounded-md border border-surface-700 bg-surface-950 px-2 text-left text-slate-200 shadow-inner hover:border-surface-500 hover:bg-surface-800 focus:border-brand-400 focus:outline-none"
        title="Switch project"
        onClick={() => setOpen((next) => !next)}
      >
        <ProjectThumbnail project={activeProject} compact />
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-semibold text-slate-100">{activeProject?.name ?? 'Untitled Project'}</div>
          <div className="truncate text-[10px] text-slate-500">
            {activeProject ? compactProjectMeta(activeProject) : 'No project selected'}
          </div>
        </div>
        <ChevronDown size={14} className={`shrink-0 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute left-0 top-full z-40 mt-2 w-[520px] overflow-hidden rounded-md border border-surface-600 bg-surface-950 shadow-2xl">
          <div className="flex items-center justify-between border-b border-surface-700 bg-surface-900 px-3 py-2">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">Projects</div>
              <div className="mt-0.5 text-[11px] text-slate-500">{projects.length} available · {totalProjectCost(projects)}</div>
            </div>
            <button
              type="button"
              className="btn-ghost px-2 py-1 text-xs"
              onClick={() => {
                setOpen(false);
                onNewProject();
              }}
              title="New Project"
            >
              <FilePlus2 size={13} /> New
            </button>
          </div>

          <div className="max-h-[420px] overflow-auto p-2">
            {projects.map((candidate) => {
              const active = candidate.id === activeProjectId;
              return (
                <button
                  key={candidate.id}
                  type="button"
                  className={`group mb-1 flex w-full items-stretch gap-3 rounded-md border p-2 text-left transition-colors last:mb-0 ${
                    active
                      ? 'border-brand-400 bg-brand-500/10'
                      : 'border-transparent bg-surface-900/50 hover:border-surface-600 hover:bg-surface-800/80'
                  }`}
                  onClick={() => {
                    setOpen(false);
                    onSelect(candidate.id);
                  }}
                >
                  <ProjectThumbnail project={candidate} />
                  <div className="min-w-0 flex-1 py-0.5">
                    <div className="flex min-w-0 items-center gap-2">
                      <div className="truncate text-sm font-semibold text-slate-100">{candidate.name}</div>
                      {active && <CheckCircle2 size={14} className="shrink-0 text-brand-400" />}
                    </div>
                    <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-slate-400">
                      <ProjectMetric icon={<Clock3 size={12} />} label={formatDuration(candidate.durationSec)} />
                      <ProjectMetric icon={<Film size={12} />} label={`${candidate.width}x${candidate.height} · ${formatFps(candidate.fps)}`} />
                      <ProjectMetric icon={<Layers3 size={12} />} label={`${candidate.clipCount} clips · ${candidate.trackCount} tracks`} />
                      <ProjectMetric icon={<DollarSign size={12} />} label={formatCurrency(candidate.aiGenerationSpendUsd)} />
                    </div>
                    <div className="mt-1.5 flex items-center justify-between text-[10px] text-slate-500">
                      <span>{candidate.mediaCount} media assets</span>
                      <span>Updated {formatRelativeTime(candidate.updatedAt)}</span>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function ProjectThumbnail({ project, compact = false }: { project: ProjectCard | null; compact?: boolean }) {
  const size = compact ? 'h-6 w-10' : 'h-[58px] w-[104px]';
  return (
    <div className={`relative shrink-0 overflow-hidden rounded border border-surface-700 bg-surface-900 ${size}`}>
      {project?.thumbnailDataUrl ? (
        <img src={project.thumbnailDataUrl} alt="" className="h-full w-full object-cover" draggable={false} />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-slate-500">
          <Clapperboard size={compact ? 14 : 24} />
        </div>
      )}
      {!compact && (
        <div className="pointer-events-none absolute bottom-0 left-0 right-0 bg-black/55 px-1.5 py-0.5 text-[10px] font-mono text-slate-100">
          {formatDuration(project?.durationSec ?? 0)}
        </div>
      )}
    </div>
  );
}

function ProjectMetric({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <span className="shrink-0 text-slate-500">{icon}</span>
      <span className="min-w-0 truncate">{label}</span>
    </div>
  );
}

function projectThumbnail(summary: ProjectSummary, assets: MediaAsset[]): string | undefined {
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  const timelinePoster = summary.posterAssetId ? assetById.get(summary.posterAssetId) : undefined;
  if (timelinePoster?.thumbnailDataUrl) return timelinePoster.thumbnailDataUrl;
  return assets.find((asset) => asset.kind === 'video' && asset.thumbnailDataUrl)?.thumbnailDataUrl ??
    assets.find((asset) => asset.thumbnailDataUrl)?.thumbnailDataUrl;
}

function compactProjectMeta(project: ProjectCard): string {
  return `${formatDuration(project.durationSec)} · ${project.clipCount} clips · ${formatCurrency(project.aiGenerationSpendUsd)}`;
}

function totalProjectCost(projects: ProjectCard[]): string {
  const total = projects.reduce((sum, project) => sum + project.aiGenerationSpendUsd, 0);
  return `${formatCurrency(total)} total`;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

function formatFps(fps: number): string {
  if (!Number.isFinite(fps) || fps <= 0) return '30 fps';
  return `${Number(fps.toFixed(2)).toString()} fps`;
}

function formatCurrency(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '$0.00';
  return `$${value.toFixed(value < 1 ? 3 : 2)}`;
}

function formatRelativeTime(timestamp: number): string {
  if (!Number.isFinite(timestamp)) return 'just now';
  const deltaSec = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (deltaSec < 60) return 'just now';
  const deltaMin = Math.floor(deltaSec / 60);
  if (deltaMin < 60) return `${deltaMin}m ago`;
  const deltaHours = Math.floor(deltaMin / 60);
  if (deltaHours < 24) return `${deltaHours}h ago`;
  const deltaDays = Math.floor(deltaHours / 24);
  if (deltaDays < 7) return `${deltaDays}d ago`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
