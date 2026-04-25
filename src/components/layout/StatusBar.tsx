import { usePlaybackStore } from '@/state/playbackStore';
import { useProjectStore } from '@/state/projectStore';
import { formatTimecode } from '@/lib/timeline/geometry';
import { projectDurationSec } from '@/lib/timeline/operations';

export function StatusBar() {
  const pxPerSec = usePlaybackStore((s) => s.pxPerSec);
  const currentTime = usePlaybackStore((s) => s.currentTimeSec);
  const project = useProjectStore((s) => s.project);
  const duration = projectDurationSec(project);
  const generationCostUsd = project.metadata?.aiGenerationSpendUsd ?? 0;

  return (
    <footer className="flex h-7 items-center justify-between border-t border-surface-700 bg-surface-900 px-3 text-[11px] text-slate-400">
      <div className="flex items-center gap-4">
        <span>
          {project.width}×{project.height} · {project.fps}fps
        </span>
        <span>{project.tracks.length} tracks</span>
        <span>{project.clips.length} clips</span>
        <span>${generationCostUsd.toFixed(2)}</span>
      </div>
      <div className="flex items-center gap-4 font-mono tabular-nums">
        <span>
          {formatTimecode(currentTime, project.fps)} / {formatTimecode(duration, project.fps)}
        </span>
        <span>{pxPerSec.toFixed(0)} px/s</span>
      </div>
    </footer>
  );
}
