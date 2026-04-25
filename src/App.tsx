import { useEffect, useRef, useState } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { TopBar } from '@/components/layout/TopBar';
import { StatusBar } from '@/components/layout/StatusBar';
import { LeftPanel } from '@/components/layout/LeftPanel';
import { MediaImporter, type MediaImporterHandle } from '@/components/media/MediaImporter';
import { Timeline } from '@/components/timeline/Timeline';
import { PreviewPlayer } from '@/components/preview/PreviewPlayer';
import { ExportDialog } from '@/components/export/ExportDialog';
import { MasterBussPanel } from '@/components/audio/MasterBussPanel';
import { SettingsModal } from '@/components/settings/SettingsModal';
import { GenerateVideoModal } from '@/components/media/GenerateVideoModal';
import { useProjectStore } from '@/state/projectStore';
import type { MediaAsset } from '@/types';
import { usePiApiGenerationResume } from '@/lib/videoGeneration/usePiApiGenerationResume';

export default function App() {
  usePiApiGenerationResume();
  const importerRef = useRef<MediaImporterHandle | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [generateOpen, setGenerateOpen] = useState(false);
  const [recipeToOpen, setRecipeToOpen] = useState<MediaAsset | null>(null);
  const [highlightedMediaAssetId, setHighlightedMediaAssetId] = useState<string | null>(null);
  const reset = useProjectStore((s) => s.reset);
  const undo = useProjectStore((s) => s.undo);
  const redo = useProjectStore((s) => s.redo);

  useEffect(() => {
    if (!highlightedMediaAssetId) return undefined;
    const timeout = window.setTimeout(() => setHighlightedMediaAssetId(null), 5000);
    return () => window.clearTimeout(timeout);
  }, [highlightedMediaAssetId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (!mod) return;

      const key = event.key.toLowerCase();
      const isUndo = key === 'z' && !event.shiftKey;
      const isRedo = key === 'y' || (key === 'z' && event.shiftKey);
      if (!isUndo && !isRedo) return;
      if (isTextEditingTarget(event.target)) return;

      event.preventDefault();
      event.stopPropagation();
      if (isUndo) undo();
      else redo();
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [redo, undo]);

  const openImport = () => importerRef.current?.openPicker();

  const handleNewProject = () => {
    if (window.confirm('Start a new project? This will clear the timeline (media is preserved).')) {
      reset();
    }
  };

  return (
    <>
      <AppShell
        topBar={
          <TopBar
            onImportClick={openImport}
            onExportClick={() => setExportOpen(true)}
            onNewProject={handleNewProject}
            onSettingsClick={() => setSettingsOpen(true)}
          />
        }
        mediaPanel={
          <LeftPanel
            onImportClick={openImport}
            onGenerateClick={() => {
              setRecipeToOpen(null);
              setGenerateOpen(true);
            }}
            onOpenRecipe={(asset) => {
              setRecipeToOpen(asset);
              setGenerateOpen(true);
            }}
            highlightedAssetId={highlightedMediaAssetId}
          />
        }
        preview={<PreviewPlayer />}
        rightPanel={<MasterBussPanel />}
        timeline={<Timeline />}
        statusBar={<StatusBar />}
      />
      <MediaImporter ref={importerRef} />
      <ExportDialog open={exportOpen} onClose={() => setExportOpen(false)} />
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <GenerateVideoModal
        open={generateOpen}
        onClose={() => setGenerateOpen(false)}
        onOpenSettings={() => {
          setGenerateOpen(false);
          setSettingsOpen(true);
        }}
        onGenerationQueued={(assetId) => setHighlightedMediaAssetId(assetId)}
        initialRecipeAsset={recipeToOpen}
      />
    </>
  );
}

function isTextEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement) return true;
  if (!(target instanceof HTMLInputElement)) return false;
  return ['email', 'password', 'search', 'tel', 'text', 'url'].includes(target.type);
}
