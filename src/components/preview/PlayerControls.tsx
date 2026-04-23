import { ChevronFirst, ChevronLast, ChevronLeft, ChevronRight, Pause, Play } from 'lucide-react';
import { usePlaybackStore } from '@/state/playbackStore';
import { useProjectStore } from '@/state/projectStore';
import { projectDurationSec } from '@/lib/timeline/operations';
import { formatTimecode } from '@/lib/timeline/geometry';

export function PlayerControls() {
  const playing = usePlaybackStore((s) => s.playing);
  const toggle = usePlaybackStore((s) => s.toggle);
  const currentTime = usePlaybackStore((s) => s.currentTimeSec);
  const setCurrentTime = usePlaybackStore((s) => s.setCurrentTime);
  const project = useProjectStore((s) => s.project);
  const duration = projectDurationSec(project);
  const fps = project.fps;

  const step = (dir: 1 | -1) => setCurrentTime(Math.max(0, Math.min(duration, currentTime + dir / fps)));

  return (
    <div className="flex items-center justify-between border-t border-surface-700 bg-surface-900 px-4 py-2">
      <div className="flex items-center gap-1">
        <button
          className="rounded p-1.5 text-slate-300 hover:bg-surface-700"
          onClick={() => setCurrentTime(0)}
          title="Go to start (Home)"
        >
          <ChevronFirst size={16} />
        </button>
        <button
          className="rounded p-1.5 text-slate-300 hover:bg-surface-700"
          onClick={() => step(-1)}
          title="Step back 1 frame (,)"
        >
          <ChevronLeft size={16} />
        </button>
        <button
          className="rounded p-2 text-slate-100 hover:bg-surface-700"
          onClick={toggle}
          title={playing ? 'Pause (Space)' : 'Play (Space)'}
        >
          {playing ? <Pause size={18} /> : <Play size={18} />}
        </button>
        <button
          className="rounded p-1.5 text-slate-300 hover:bg-surface-700"
          onClick={() => step(1)}
          title="Step forward 1 frame (.)"
        >
          <ChevronRight size={16} />
        </button>
        <button
          className="rounded p-1.5 text-slate-300 hover:bg-surface-700"
          onClick={() => setCurrentTime(duration)}
          title="Go to end (End)"
        >
          <ChevronLast size={16} />
        </button>
      </div>
      <div className="font-mono text-xs tabular-nums text-slate-300">
        {formatTimecode(currentTime, fps)} <span className="text-slate-500">/</span>{' '}
        {formatTimecode(duration, fps)}
      </div>
    </div>
  );
}
