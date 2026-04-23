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
import { useProjectStore } from '@/state/projectStore';

export default function App() {
  const importerRef = useRef<MediaImporterHandle | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
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
          />
        }
        mediaPanel={<LeftPanel onImportClick={openImport} />}
        preview={<PreviewPlayer />}
        rightPanel={<MasterBussPanel />}
        timeline={<Timeline />}
        statusBar={<StatusBar />}
      />
      <MediaImporter ref={importerRef} />
      <ExportDialog open={exportOpen} onClose={() => setExportOpen(false)} />
    </>
  );
}
