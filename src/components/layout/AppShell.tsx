import { useEffect, useState, type ReactNode } from 'react';
import { MobileEditorShell } from './MobileEditorShell';

type Props = {
  topBar: ReactNode;
  mediaPanel: ReactNode;
  preview: ReactNode;
  rightPanel?: ReactNode;
  timeline: ReactNode;
  statusBar: ReactNode;
  mobileActions?: {
    onImportClick: () => void;
    onGenerateClick: () => void;
    onExportClick: () => void;
  };
};

export function AppShell({ topBar, mediaPanel, preview, rightPanel, timeline, statusBar, mobileActions }: Props) {
  const compactLayout = useCompactEditorLayout();

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="shrink-0">{topBar}</div>
      {compactLayout ? (
        <MobileEditorShell
          mediaPanel={mediaPanel}
          preview={preview}
          timeline={timeline}
          actions={mobileActions}
        />
      ) : (
        <div className="flex min-h-0 flex-1">
          <aside className="w-72 shrink-0 panel border-y-0 border-l-0">{mediaPanel}</aside>
          <main className="flex min-w-0 flex-1 flex-col">
            <div className="flex min-h-0 flex-1">
              <div className="min-h-0 min-w-0 flex-1 bg-surface-950">{preview}</div>
              {rightPanel && (
                <div className="w-24 shrink-0 border-l border-surface-700 bg-surface-900">
                  {rightPanel}
                </div>
              )}
            </div>
            <div className="h-[38%] min-h-[240px] shrink-0 border-t border-surface-700 bg-surface-900">
              {timeline}
            </div>
          </main>
        </div>
      )}
      <div className="shrink-0">{statusBar}</div>
    </div>
  );
}

function useCompactEditorLayout() {
  const [compact, setCompact] = useState(() => compactLayoutMatches());

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const query = window.matchMedia('(max-width: 767px)');
    const sync = () => setCompact(query.matches);
    sync();

    if (query.addEventListener) {
      query.addEventListener('change', sync);
      return () => query.removeEventListener('change', sync);
    }

    query.addListener(sync);
    return () => query.removeListener(sync);
  }, []);

  return compact;
}

function compactLayoutMatches() {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(max-width: 767px)').matches;
}
