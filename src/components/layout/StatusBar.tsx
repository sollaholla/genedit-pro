import { usePlaybackStore } from '@/state/playbackStore';
import { useProjectStore } from '@/state/projectStore';
import { useMediaStore } from '@/state/mediaStore';
import { formatTimecode } from '@/lib/timeline/geometry';
import { projectDurationSec } from '@/lib/timeline/operations';

export function StatusBar() {
  const pxPerSec = usePlaybackStore((s) => s.pxPerSec);
  const currentTime = usePlaybackStore((s) => s.currentTimeSec);
  const project = useProjectStore((s) => s.project);
  const assets = useMediaStore((s) => s.assets);
  const duration = projectDurationSec(project);
  const generationCostUsd = assets.reduce((total, asset) => {
    if ((asset.kind !== 'video' && asset.kind !== 'image') || asset.generation?.status !== 'done') return total;
    const cost = asset.generation.actualCostUsd ?? asset.generation.estimatedCostUsd ?? 0;
    return Number.isFinite(cost) ? total + cost : total;
  }, 0);

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
