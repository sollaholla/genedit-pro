import { Clapperboard, Cog, Download, FilePlus2, Upload } from 'lucide-react';
import { useProjectStore } from '@/state/projectStore';

type Props = {
  onImportClick: () => void;
  onExportClick: () => void;
  onNewProject: () => void;
  onSettingsClick: () => void;
};

export function TopBar({ onImportClick, onExportClick, onNewProject, onSettingsClick }: Props) {
  const project = useProjectStore((s) => s.project);
  const rename = useProjectStore((s) => s.rename);

  return (
    <header className="flex h-12 items-center justify-between border-b border-surface-700 bg-surface-900 px-4">
      <div className="flex items-center gap-3">
        <button className="rounded p-1.5 text-slate-400 hover:bg-surface-800 hover:text-slate-100" onClick={onSettingsClick} title="Settings">
          <Cog size={14} />
        </button>
        <div className="flex h-7 w-7 items-center justify-center rounded-md bg-brand-500 text-white">
          <Clapperboard size={16} />
        </div>
        <div className="text-sm font-semibold tracking-tight">GenEdit Pro</div>
        <div className="h-5 w-px bg-surface-700" />
        <input
          type="text"
          value={project.name}
          onChange={(e) => rename(e.target.value)}
          className="w-56 rounded bg-transparent px-2 py-1 text-sm text-slate-200 outline-none ring-1 ring-transparent transition-colors focus:bg-surface-800 focus:ring-surface-600"
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
        <button className="btn-primary" onClick={onExportClick} title="Export video">
          <Download size={14} />
          Export
        </button>
      </div>
    </header>
  );
}
