import { useRef, useState } from 'react';
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

export default function App() {
  const importerRef = useRef<MediaImporterHandle | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [generateOpen, setGenerateOpen] = useState(false);
  const [recipeToOpen, setRecipeToOpen] = useState<MediaAsset | null>(null);
  const reset = useProjectStore((s) => s.reset);

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
        onOpenSettings={() => setSettingsOpen(true)}
        initialRecipeAsset={recipeToOpen}
      />
    </>
  );
}
