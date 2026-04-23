import { useEffect, useState } from 'react';
import { MediaBin } from '@/components/media/MediaBin';
import { ClipInspector } from '@/components/inspector/ClipInspector';
import { usePlaybackStore } from '@/state/playbackStore';

type Props = {
  onImportClick: () => void;
};

type Tab = 'media' | 'inspector';

export function LeftPanel({ onImportClick }: Props) {
  const [tab, setTab] = useState<Tab>('media');
  const selection = usePlaybackStore((s) => s.selection);
  const hasSelection = selection.kind === 'clip';

  // Auto-switch to inspector when a clip is selected.
  useEffect(() => {
    if (hasSelection) setTab('inspector');
  }, [hasSelection]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 border-b border-surface-700">
        <TabButton active={tab === 'media'} onClick={() => setTab('media')}>Media</TabButton>
        <TabButton active={tab === 'inspector'} onClick={() => setTab('inspector')}>
          Inspector{hasSelection ? <span className="ml-1.5 h-1.5 w-1.5 rounded-full bg-brand-400 inline-block" /> : null}
        </TabButton>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {tab === 'media' ? (
          <MediaBin onImportClick={onImportClick} />
        ) : (
          <ClipInspector />
        )}
      </div>
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      className={`flex-1 px-3 py-2 text-xs font-medium transition-colors ${
        active
          ? 'border-b-2 border-brand-500 text-slate-100'
          : 'border-b-2 border-transparent text-slate-400 hover:text-slate-200'
      }`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
