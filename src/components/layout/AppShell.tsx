import type { ReactNode } from 'react';

type Props = {
  topBar: ReactNode;
  mediaPanel: ReactNode;
  preview: ReactNode;
  rightPanel?: ReactNode;
  timeline: ReactNode;
  statusBar: ReactNode;
};

export function AppShell({ topBar, mediaPanel, preview, rightPanel, timeline, statusBar }: Props) {
  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0">{topBar}</div>
      <div className="flex min-h-0 flex-1">
        <aside className="w-72 shrink-0 panel border-y-0 border-l-0">{mediaPanel}</aside>
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1">
            <div className="min-h-0 flex-1 bg-surface-950">{preview}</div>
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
      <div className="shrink-0">{statusBar}</div>
    </div>
  );
}
