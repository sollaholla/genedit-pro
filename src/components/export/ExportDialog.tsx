import { useEffect, useState } from 'react';
import { Download, Loader2, X } from 'lucide-react';
import { useProjectStore } from '@/state/projectStore';
import { useMediaStore } from '@/state/mediaStore';
import { useExportStore } from '@/state/exportStore';
import { exportProject } from '@/lib/ffmpeg/export';
import { projectDurationSec } from '@/lib/timeline/operations';
import { formatTimecode } from '@/lib/timeline/geometry';

type Props = {
  open: boolean;
  onClose: () => void;
};

export function ExportDialog({ open, onClose }: Props) {
  const project = useProjectStore((s) => s.project);
  const assets = useMediaStore((s) => s.assets);
  const exportState = useExportStore();
  const [logTail, setLogTail] = useState<string[]>([]);
  const duration = projectDurationSec(project);

  useEffect(() => {
    if (!open) return;
    setLogTail([]);
    exportState.reset();
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleStart() {
    try {
      exportState.reset();
      exportState.setStatus('preparing', 'Loading encoder…');
      const blob = await exportProject(project, assets, {
        onStatus: (msg) => exportState.setStatus('encoding', msg),
        onProgress: (v) => exportState.setProgress(v),
        onLog: (line) => setLogTail((prev) => [...prev.slice(-40), line]),
      });
      const url = URL.createObjectURL(blob);
      exportState.setResult(url);
    } catch (err) {
      exportState.setError(err instanceof Error ? err.message : String(err));
    }
  }

  if (!open) return null;

  const busy = exportState.status === 'preparing' || exportState.status === 'encoding';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-lg rounded-lg border border-surface-700 bg-surface-900 shadow-2xl">
        <div className="flex items-center justify-between border-b border-surface-700 px-4 py-3">
          <div className="text-sm font-semibold">Export video</div>
          <button
            className="rounded p-1 text-slate-400 hover:bg-surface-700 hover:text-slate-200"
            onClick={onClose}
            disabled={busy}
            title="Close"
          >
            <X size={14} />
          </button>
        </div>

        <div className="space-y-4 px-4 py-4 text-sm">
          <div className="grid grid-cols-2 gap-2 rounded border border-surface-700 bg-surface-800 p-3 text-xs text-slate-300">
            <div className="flex items-center justify-between">
              <span className="text-slate-500">Resolution</span>
              <span className="font-mono">{project.width}×{project.height}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-slate-500">Framerate</span>
              <span className="font-mono">{project.fps} fps</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-slate-500">Duration</span>
              <span className="font-mono">{formatTimecode(duration, project.fps)}</span>
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
              <div className="h-2 overflow-hidden rounded bg-surface-700">
                <div
                  className="h-full bg-brand-500 transition-[width]"
                  style={{ width: `${Math.min(100, Math.max(0, exportState.progress * 100))}%` }}
                />
              </div>
            </div>
          )}

          {exportState.status === 'error' && (
            <div className="rounded border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-300">
              {exportState.error}
            </div>
          )}

          {logTail.length > 0 && (busy || exportState.status === 'error') && (
            <details className="text-[11px] text-slate-500">
              <summary className="cursor-pointer select-none">Encoder log</summary>
              <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px] leading-tight">
                {logTail.join('\n')}
              </pre>
            </details>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-surface-700 bg-surface-950/40 px-4 py-3">
          {exportState.status === 'done' && exportState.outputUrl ? (
            <>
              <button className="btn-ghost" onClick={onClose}>
                Close
              </button>
              <a
                className="btn-primary"
                href={exportState.outputUrl}
                download={`${project.name || 'export'}.mp4`}
                onClick={() => setTimeout(onClose, 200)}
              >
                <Download size={14} />
                Download MP4
              </a>
            </>
          ) : (
            <>
              <button className="btn-ghost" onClick={onClose} disabled={busy}>
                Cancel
              </button>
              <button className="btn-primary" onClick={handleStart} disabled={busy || duration <= 0}>
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                {busy ? 'Exporting…' : 'Start export'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
