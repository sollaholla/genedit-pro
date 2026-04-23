import { Eye, EyeOff, Trash2, Volume2, VolumeX } from 'lucide-react';
import type { Track } from '@/types';
import { TRACK_HEIGHT_PX } from '@/lib/timeline/geometry';
import { useProjectStore } from '@/state/projectStore';
import { removeTrack, setTrackProp } from '@/lib/timeline/operations';

type Props = {
  track: Track;
  label: string;
};

export function TrackHeader({ track, label }: Props) {
  const update = useProjectStore((s) => s.update);

  return (
    <div
      className="flex shrink-0 flex-col justify-between border-b border-surface-800 border-r border-r-surface-700 bg-surface-900 px-2 py-1 text-[11px]"
      style={{ height: TRACK_HEIGHT_PX }}
    >
      <div className="flex items-center justify-between">
        <span className="font-mono font-semibold text-slate-300">{label}</span>
        <div className="flex items-center gap-1">
          {track.kind === 'video' ? (
            <button
              className="rounded p-0.5 text-slate-400 hover:bg-surface-700 hover:text-slate-200"
              title={track.hidden ? 'Show' : 'Hide'}
              onClick={() => update((p) => setTrackProp(p, track.id, 'hidden', !track.hidden))}
            >
              {track.hidden ? <EyeOff size={12} /> : <Eye size={12} />}
            </button>
          ) : (
            <button
              className="rounded p-0.5 text-slate-400 hover:bg-surface-700 hover:text-slate-200"
              title={track.muted ? 'Unmute' : 'Mute'}
              onClick={() => update((p) => setTrackProp(p, track.id, 'muted', !track.muted))}
            >
              {track.muted ? <VolumeX size={12} /> : <Volume2 size={12} />}
            </button>
          )}
          <button
            className="rounded p-0.5 text-slate-500 hover:bg-surface-700 hover:text-red-400"
            title="Remove track"
            onClick={() => update((p) => removeTrack(p, track.id))}
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>
      <div className="text-[10px] uppercase tracking-wider text-slate-500">{track.kind}</div>
    </div>
  );
}
