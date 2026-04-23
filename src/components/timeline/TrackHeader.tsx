import { Eye, EyeOff, GripVertical, Plus, Trash2, Volume2, VolumeX } from 'lucide-react';
import type { Track } from '@/types';
import { TRACK_HEIGHT_PX } from '@/lib/timeline/geometry';
import { useProjectStore } from '@/state/projectStore';
import { removeTrack, setTrackProp } from '@/lib/timeline/operations';

type Props = {
  track: Track;
  label: string;
  isDragging: boolean;
  showDropBefore: boolean;
  showDropAfter: boolean;
  onDragStart: () => void;
  onDragOver: (position: 'before' | 'after') => void;
  onDrop: () => void;
  onDragEnd: () => void;
  onInsertVideoBelow: () => void;
  onInsertAudioBelow: () => void;
};

export function TrackHeader({
  track,
  label,
  isDragging,
  showDropBefore,
  showDropAfter,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  onInsertVideoBelow,
  onInsertAudioBelow,
}: Props) {
  const update = useProjectStore((s) => s.update);

  return (
    <div
      className={`relative flex shrink-0 flex-col justify-between border-b border-surface-800 border-r border-r-surface-700 bg-surface-900 px-2 py-1 text-[11px] ${
        isDragging ? 'opacity-50' : ''
      }`}
      style={{ height: TRACK_HEIGHT_PX }}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        onDragStart();
      }}
      onDragOver={(e) => {
        e.preventDefault();
        const rect = e.currentTarget.getBoundingClientRect();
        const position = e.clientY - rect.top < rect.height / 2 ? 'before' : 'after';
        onDragOver(position);
      }}
      onDrop={(e) => {
        e.preventDefault();
        onDrop();
      }}
      onDragEnd={onDragEnd}
    >
      {showDropBefore && (
        <div className="pointer-events-none absolute left-0 right-0 top-0 h-0.5 bg-brand-400" />
      )}
      {showDropAfter && (
        <div className="pointer-events-none absolute bottom-0 left-0 right-0 h-0.5 bg-brand-400" />
      )}

      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1 font-mono font-semibold text-slate-300">
          <GripVertical size={12} className="text-slate-500" />
          {label}
        </span>
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

      <div className="flex items-center justify-between">
        <div className="text-[10px] uppercase tracking-wider text-slate-500">{track.kind}</div>
        <div className="flex items-center gap-1 text-[10px] text-slate-500">
          <button
            className="inline-flex items-center gap-0.5 rounded px-1 py-px hover:bg-surface-700 hover:text-slate-200"
            title="Insert video track below"
            onClick={onInsertVideoBelow}
          >
            <Plus size={10} />V
          </button>
          <button
            className="inline-flex items-center gap-0.5 rounded px-1 py-px hover:bg-surface-700 hover:text-slate-200"
            title="Insert audio track below"
            onClick={onInsertAudioBelow}
          >
            <Plus size={10} />A
          </button>
        </div>
      </div>
    </div>
  );
}
