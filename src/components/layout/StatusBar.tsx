import { usePlaybackStore } from '@/state/playbackStore';
import { useProjectStore } from '@/state/projectStore';
import { formatTimecode } from '@/lib/timeline/geometry';
import { projectDurationSec } from '@/lib/timeline/operations';
import { formatBytes, useBrowserMetrics } from '@/lib/system/browserMetrics';

export function StatusBar() {
  const pxPerSec = usePlaybackStore((s) => s.pxPerSec);
  const currentTime = usePlaybackStore((s) => s.currentTimeSec);
  const project = useProjectStore((s) => s.project);
  const duration = projectDurationSec(project);
  const generationCostUsd = project.metadata?.aiGenerationSpendUsd ?? 0;
  const metrics = useBrowserMetrics();
  const storageText = metrics.storageQuotaBytes === null
    ? formatBytes(metrics.storageUsageBytes)
    : `${formatBytes(metrics.storageUsageBytes)} / ${formatBytes(metrics.storageQuotaBytes)}`;
  const memoryText = metrics.memoryUsedBytes === null
    ? null
    : metrics.memoryTotalBytes === null
      ? formatBytes(metrics.memoryUsedBytes)
      : `${formatBytes(metrics.memoryUsedBytes)} / ${formatBytes(metrics.memoryTotalBytes)}`;

  return (
    <footer className="flex h-7 items-center justify-between gap-3 overflow-hidden border-t border-surface-700 bg-surface-900 px-2 text-[11px] text-slate-400 sm:px-3">
      <div className="flex min-w-0 items-center gap-3 sm:gap-4">
        <span>
          {project.width}×{project.height} · {project.fps}fps
        </span>
        <span className="hidden sm:inline">{project.tracks.length} tracks</span>
        <span>{project.clips.length} clips</span>
        <span className="hidden sm:inline">${generationCostUsd.toFixed(2)}</span>
      </div>
      <div className="flex min-w-0 items-center gap-3 font-mono tabular-nums sm:gap-4">
        <span className="hidden md:inline" title="Browser storage used by this app origin">
          Storage {storageText}
        </span>
        {memoryText && (
          <span className="hidden lg:inline" title="Current JavaScript heap usage reported by Chromium">
            Memory {memoryText}
          </span>
        )}
        <span className="hidden sm:inline">
          {formatTimecode(currentTime, project.fps)} / {formatTimecode(duration, project.fps)}
        </span>
        <span className="hidden md:inline">{pxPerSec.toFixed(0)} px/s</span>
      </div>
    </footer>
  );
}
