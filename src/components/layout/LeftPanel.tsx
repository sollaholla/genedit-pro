import { useEffect, useState } from 'react';
import { MediaBin } from '@/components/media/MediaBin';
import { ClipInspector } from '@/components/inspector/ClipInspector';
import { usePlaybackStore } from '@/state/playbackStore';
import type { MediaAsset } from '@/types';

type Props = {
  onImportClick: () => void;
  onGenerateClick: () => void;
  onCreateCharacter: (folderId: string | null) => void;
  onOpenCharacter: (asset: MediaAsset) => void;
  onOpenRecipe: (asset: MediaAsset) => void;
  onGenerateFromSequence: (asset: MediaAsset) => void;
  highlightedAssetId?: string | null;
};

type Tab = 'media' | 'inspector';

export function LeftPanel({ onImportClick, onGenerateClick, onCreateCharacter, onOpenCharacter, onOpenRecipe, onGenerateFromSequence, highlightedAssetId = null }: Props) {
  const [tab, setTab] = useState<Tab>('media');
  const selectedClipIds = usePlaybackStore((s) => s.selectedClipIds);
  const hasSelection = selectedClipIds.length > 0;

  // Auto-switch to inspector when a clip is selected.
  useEffect(() => {
    if (hasSelection) setTab('inspector');
  }, [hasSelection]);

  useEffect(() => {
    if (highlightedAssetId) setTab('media');
  }, [highlightedAssetId]);

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
          <MediaBin
            onImportClick={onImportClick}
            onGenerateClick={onGenerateClick}
            onCreateCharacter={onCreateCharacter}
            onOpenCharacter={onOpenCharacter}
            onOpenRecipe={onOpenRecipe}
            onGenerateFromSequence={onGenerateFromSequence}
            highlightedAssetId={highlightedAssetId}
          />
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
