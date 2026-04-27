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
import { CharacterEditor } from '@/components/media/CharacterEditor';
import { useProjectStore } from '@/state/projectStore';
import { usePlaybackStore } from '@/state/playbackStore';
import { useExportStore } from '@/state/exportStore';
import { useMediaStore } from '@/state/mediaStore';
import type { MediaAsset } from '@/types';
import { usePiApiGenerationResume } from '@/lib/videoGeneration/usePiApiGenerationResume';

export default function App() {
  usePiApiGenerationResume();
  const importerRef = useRef<MediaImporterHandle | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [generateOpen, setGenerateOpen] = useState(false);
  const [characterEditor, setCharacterEditor] = useState<{ assetId: string | null; folderId: string | null } | null>(null);
  const [recipeToOpen, setRecipeToOpen] = useState<MediaAsset | null>(null);
  const [sequenceToGenerate, setSequenceToGenerate] = useState<MediaAsset | null>(null);
  const [highlightedMediaAssetId, setHighlightedMediaAssetId] = useState<string | null>(null);
  const projectId = useProjectStore((s) => s.project.id);
  const createProject = useProjectStore((s) => s.createProject);
  const setActiveMediaProject = useMediaStore((s) => s.setActiveProject);
  const previousProjectIdRef = useRef(projectId);
  const exportStatus = useExportStore((s) => s.status);
  const exportInProgress = exportStatus === 'preparing' || exportStatus === 'encoding';

  useEffect(() => {
    if (!exportInProgress) return undefined;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [exportInProgress]);

  useEffect(() => {
    if (!highlightedMediaAssetId) return undefined;
    const timeout = window.setTimeout(() => setHighlightedMediaAssetId(null), 5000);
    return () => window.clearTimeout(timeout);
  }, [highlightedMediaAssetId]);

  useEffect(() => {
    setActiveMediaProject(projectId);
    if (previousProjectIdRef.current === projectId) return;
    previousProjectIdRef.current = projectId;
    const playback = usePlaybackStore.getState();
    playback.pause();
    playback.setCurrentTime(0);
    playback.setClipSelection([]);
    setExportOpen(false);
    setGenerateOpen(false);
    setCharacterEditor(null);
    setRecipeToOpen(null);
    setSequenceToGenerate(null);
    setHighlightedMediaAssetId(null);
  }, [projectId, setActiveMediaProject]);

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
      if (isUndo) undoLatestHistoryEntry();
      else redoNextHistoryEntry();
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  const openImport = () => importerRef.current?.openPicker();

  const handleNewProject = () => {
    const name = window.prompt('Project name', `Project ${useProjectStore.getState().projects.length + 1}`);
    if (name === null) return;
    createProject(name.trim() || undefined);
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
              setSequenceToGenerate(null);
              setGenerateOpen(true);
            }}
            onOpenRecipe={(asset) => {
              setRecipeToOpen(asset);
              setSequenceToGenerate(null);
              setGenerateOpen(true);
            }}
            onGenerateFromSequence={(asset) => {
              setRecipeToOpen(null);
              setSequenceToGenerate(asset);
              setGenerateOpen(true);
            }}
            onCreateCharacter={(folderId) => setCharacterEditor({ assetId: null, folderId })}
            onOpenCharacter={(asset) => setCharacterEditor({ assetId: asset.id, folderId: asset.folderId ?? null })}
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
        initialSequenceAsset={sequenceToGenerate}
      />
      {characterEditor && (
        <CharacterEditor
          assetId={characterEditor.assetId}
          folderId={characterEditor.folderId}
          onClose={() => setCharacterEditor(null)}
          onOpenSettings={() => {
            setCharacterEditor(null);
            setSettingsOpen(true);
          }}
          onGenerationQueued={(assetId) => setHighlightedMediaAssetId(assetId)}
        />
      )}
    </>
  );
}

function undoLatestHistoryEntry() {
  const projectState = useProjectStore.getState();
  const playbackState = usePlaybackStore.getState();
  const projectSeq = projectState.peekUndoSeq();
  const selectionSeq = playbackState.peekSelectionUndoSeq();
  if (selectionSeq !== null && (projectSeq === null || selectionSeq > projectSeq)) {
    playbackState.undoSelection();
    return;
  }
  projectState.undo();
}

function redoNextHistoryEntry() {
  const projectState = useProjectStore.getState();
  const playbackState = usePlaybackStore.getState();
  const projectSeq = projectState.peekRedoSeq();
  const selectionSeq = playbackState.peekSelectionRedoSeq();
  if (selectionSeq !== null && (projectSeq === null || selectionSeq < projectSeq)) {
    playbackState.redoSelection();
    return;
  }
  projectState.redo();
}

function isTextEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement) return true;
  if (!(target instanceof HTMLInputElement)) return false;
  return ['email', 'password', 'search', 'tel', 'text', 'url'].includes(target.type);
}
