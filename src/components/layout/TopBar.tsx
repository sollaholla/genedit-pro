import { useLayoutEffect, useRef, useState } from 'react';
import { CheckCircle2, Clapperboard, Cog, Download, FilePlus2, Loader2, Upload } from 'lucide-react';
import { useProjectStore } from '@/state/projectStore';
import { useExportStore } from '@/state/exportStore';

type Props = {
  onImportClick: () => void;
  onExportClick: () => void;
  onNewProject: () => void;
  onSettingsClick: () => void;
};

export function TopBar({ onImportClick, onExportClick, onNewProject, onSettingsClick }: Props) {
  const project = useProjectStore((s) => s.project);
  const projects = useProjectStore((s) => s.projects);
  const rename = useProjectStore((s) => s.rename);
  const switchProject = useProjectStore((s) => s.switchProject);
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
        <select
          value={project.id}
          onChange={(e) => switchProject(e.target.value)}
          className="max-w-44 rounded border border-surface-700 bg-surface-950 px-2 py-1 text-xs text-slate-200 outline-none focus:border-surface-500"
          title="Switch project"
        >
          {projects.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>{candidate.name}</option>
          ))}
        </select>
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
