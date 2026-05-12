import { useMemo, useState, type ReactNode } from 'react';
import { Download, Film, Library, Rows3, Sparkles, Upload, type LucideIcon } from 'lucide-react';
import { useProjectStore } from '@/state/projectStore';
import { inferProjectAspectPreset } from '@/lib/project/dimensions';
import { MobileClipStrip } from '@/components/mobile/MobileClipStrip';

type MobileTab = 'clips' | 'media' | 'timeline';

type Props = {
  mediaPanel: ReactNode;
  preview: ReactNode;
  timeline: ReactNode;
  actions?: {
    onImportClick: () => void;
    onGenerateClick: () => void;
    onExportClick: () => void;
  };
};

export function MobileEditorShell({ mediaPanel, preview, timeline, actions }: Props) {
  const [tab, setTab] = useState<MobileTab>('clips');
  const project = useProjectStore((s) => s.project);
  const aspectPreset = inferProjectAspectPreset(project.width, project.height);
  const previewWeight = aspectPreset === '9:16' ? 'flex-[1.35]' : 'flex-1';
  const tabItems = useMemo(() => ([
    { id: 'clips' as const, label: 'Clips', icon: Film },
    { id: 'media' as const, label: 'Media', icon: Library },
    { id: 'timeline' as const, label: 'Timeline', icon: Rows3 },
  ]), []);

  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-hidden bg-surface-950 pb-[env(safe-area-inset-bottom)]">
      <section className={`min-h-0 ${previewWeight} bg-black`}>
        {preview}
      </section>

      <div className="shrink-0 border-y border-surface-700 bg-surface-900 px-2 py-2">
        <div className="grid grid-cols-3 gap-2">
          <MobileActionButton icon={Upload} label="Import" onClick={actions?.onImportClick} />
          <MobileActionButton icon={Sparkles} label="Generate" onClick={actions?.onGenerateClick} primary />
          <MobileActionButton icon={Download} label="Export" onClick={actions?.onExportClick} />
        </div>
      </div>

      <section className="flex min-h-[230px] flex-[0.85] flex-col overflow-hidden bg-surface-900">
        <div className="grid shrink-0 grid-cols-3 border-b border-surface-700">
          {tabItems.map((item) => {
            const Icon = item.icon;
            const active = tab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                className={`flex h-10 items-center justify-center gap-1.5 border-b-2 text-xs font-medium transition-colors ${
                  active
                    ? 'border-brand-500 text-slate-100'
                    : 'border-transparent text-slate-400 hover:bg-surface-800 hover:text-slate-200'
                }`}
                onClick={() => setTab(item.id)}
              >
                <Icon size={14} />
                {item.label}
              </button>
            );
          })}
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">
          {tab === 'clips' && (
            <MobileClipStrip
              onImportClick={actions?.onImportClick}
              onGenerateClick={actions?.onGenerateClick}
              onOpenInspector={() => setTab('media')}
            />
          )}
          {tab === 'media' && mediaPanel}
          {tab === 'timeline' && timeline}
        </div>
      </section>
    </main>
  );
}

function MobileActionButton({
  icon: Icon,
  label,
  onClick,
  primary = false,
}: {
  icon: LucideIcon;
  label: string;
  onClick?: () => void;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      className={`flex h-11 items-center justify-center gap-2 rounded-md text-xs font-semibold transition-colors disabled:opacity-50 ${
        primary
          ? 'bg-brand-500 text-white hover:bg-brand-400'
          : 'bg-surface-800 text-slate-100 hover:bg-surface-700'
      }`}
      onClick={onClick}
      disabled={!onClick}
    >
      <Icon size={15} />
      <span className="truncate">{label}</span>
    </button>
  );
}
