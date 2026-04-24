import {
  ChevronFirst,
  ChevronLast,
  ChevronLeft,
  ChevronRight,
  Maximize2,
  Minimize2,
  Pause,
  Play,
} from 'lucide-react';
import { usePlaybackStore } from '@/state/playbackStore';
import { useProjectStore } from '@/state/projectStore';
import { projectDurationSec } from '@/lib/timeline/operations';
import { formatTimecode } from '@/lib/timeline/geometry';

type Props = {
  isFullscreen: boolean;
  aspectPreset: string;
  aspectOptions: readonly { value: string; label: string }[];
  onAspectPresetChange: (value: string) => void;
  onToggleFullscreen: () => void;
};

export function PlayerControls({
  isFullscreen,
  aspectPreset,
  aspectOptions,
  onAspectPresetChange,
  onToggleFullscreen,
}: Props) {
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
      <div className="flex items-center gap-3">
        <select
          className="rounded border border-surface-600 bg-surface-800 px-2 py-1 text-[11px] text-slate-200 outline-none hover:border-surface-500 focus:border-brand-400"
          value={aspectPreset}
          onChange={(e) => onAspectPresetChange(e.target.value)}
          title="Preview aspect ratio"
        >
          {aspectOptions.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
        <div className="font-mono text-xs tabular-nums text-slate-300">
          {formatTimecode(currentTime, fps)} <span className="text-slate-500">/</span>{' '}
          {formatTimecode(duration, fps)}
        </div>
        <button
          className="rounded p-1.5 text-slate-300 hover:bg-surface-700"
          onClick={onToggleFullscreen}
          title={isFullscreen ? 'Exit fullscreen (F)' : 'Fullscreen (F)'}
        >
          {isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </button>
      </div>
    </div>
  );
}
