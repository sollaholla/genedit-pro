import { Download, Loader2, Minimize2, RefreshCw, X } from 'lucide-react';
import { useProjectStore } from '@/state/projectStore';
import { useMediaStore } from '@/state/mediaStore';
import { useExportStore } from '@/state/exportStore';
import { exportProject } from '@/lib/ffmpeg/export';
import { projectDurationSec } from '@/lib/timeline/operations';
import { formatTimecode } from '@/lib/timeline/geometry';
import type { MediaAsset, Project } from '@/types';

type Props = {
  open: boolean;
  onClose: () => void;
};

function cloneForExport<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function exportDownloadName(projectName: string): string {
  const safeName = projectName.trim().replace(/[\\/:*?"<>|]+/g, '-');
  return `${safeName || 'export'}.mp4`;
}

export function ExportDialog({ open, onClose }: Props) {
  const project = useProjectStore((s) => s.project);
  const assets = useMediaStore((s) => s.assets);
  const exportState = useExportStore();
  const duration = projectDurationSec(project);
  const busy = exportState.status === 'preparing' || exportState.status === 'encoding';
  const summary = exportState.job ?? {
    projectName: project.name,
    width: project.width,
    height: project.height,
    fps: project.fps,
    durationSec: duration,
    startedAt: Date.now(),
  };

  async function handleStart() {
    if (busy) return;
    const projectSnapshot: Project = cloneForExport(project);
    const assetsSnapshot: MediaAsset[] = cloneForExport(assets);
    const snapshotDuration = projectDurationSec(projectSnapshot);
    if (snapshotDuration <= 0) return;

    const store = useExportStore.getState();
    try {
      store.beginJob({
        projectName: projectSnapshot.name,
        width: projectSnapshot.width,
        height: projectSnapshot.height,
        fps: projectSnapshot.fps,
        durationSec: snapshotDuration,
        startedAt: Date.now(),
      });
      const blob = await exportProject(projectSnapshot, assetsSnapshot, {
        onStatus: (msg) => useExportStore.getState().setStatus('encoding', msg),
        onProgress: (value) => useExportStore.getState().setProgress(value),
        onLog: (line) => useExportStore.getState().appendLog(line),
      });
      const url = URL.createObjectURL(blob);
      useExportStore.getState().setResult(url);
    } catch (err) {
      useExportStore.getState().setError(err instanceof Error ? err.message : String(err));
    }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-lg rounded-lg border border-surface-700 bg-surface-900 shadow-2xl">
        <div className="flex items-center justify-between border-b border-surface-700 px-4 py-3">
          <div className="text-sm font-semibold">Export video</div>
          <button
            className="rounded p-1 text-slate-400 hover:bg-surface-700 hover:text-slate-200"
            onClick={onClose}
            title={busy ? 'Process in background' : 'Close'}
          >
            <X size={14} />
          </button>
        </div>

        <div className="space-y-4 px-4 py-4 text-sm">
          <div className="grid grid-cols-2 gap-2 rounded border border-surface-700 bg-surface-800 p-3 text-xs text-slate-300">
            <div className="flex items-center justify-between">
              <span className="text-slate-500">Resolution</span>
              <span className="font-mono">{summary.width}×{summary.height}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-slate-500">Framerate</span>
              <span className="font-mono">{summary.fps} fps</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-slate-500">Duration</span>
              <span className="font-mono">{formatTimecode(summary.durationSec, summary.fps)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-slate-500">Codec</span>
              <span className="font-mono">H.264 / AAC</span>
            </div>
          </div>

          {exportState.status !== 'idle' && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs text-slate-400">
                <span>{exportState.message ?? exportState.status}</span>
                <span className="font-mono">{Math.round(exportState.progress * 100)}%</span>
              </div>
              <progress
                className="export-progress"
                value={Math.min(1, Math.max(0, exportState.progress))}
                max={1}
                aria-label="Export progress"
              />
            </div>
          )}

          {exportState.status === 'error' && (
            <div className="rounded border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-300">
              {exportState.error}
            </div>
          )}

          {exportState.logTail.length > 0 && (busy || exportState.status === 'error') && (
            <details className="text-[11px] text-slate-500">
              <summary className="cursor-pointer select-none">Encoder log</summary>
              <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px] leading-tight">
                {exportState.logTail.join('\n')}
              </pre>
            </details>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-surface-700 bg-surface-950/40 px-4 py-3">
          {busy ? (
            <>
              <button className="btn-ghost" onClick={onClose}>
                <Minimize2 size={14} />
                Process in Background
              </button>
              <button className="btn-primary" disabled>
                <Loader2 size={14} className="animate-spin" />
                Exporting…
              </button>
            </>
          ) : exportState.status === 'done' && exportState.outputUrl ? (
            <>
              <button className="btn-ghost" onClick={onClose}>
                Close
              </button>
              <button className="btn-ghost" onClick={handleStart} disabled={duration <= 0}>
                <RefreshCw size={14} />
                Export Current Timeline
              </button>
              <a
                className="btn-primary"
                href={exportState.outputUrl}
                download={exportDownloadName(summary.projectName)}
                onClick={() => setTimeout(onClose, 200)}
              >
                <Download size={14} />
                Download MP4
              </a>
            </>
          ) : (
            <>
              <button className="btn-ghost" onClick={onClose}>
                Cancel
              </button>
              <button className="btn-primary" onClick={handleStart} disabled={duration <= 0}>
                <Download size={14} />
                Start export
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
