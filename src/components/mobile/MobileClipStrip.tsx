import { useCallback, useMemo } from 'react';
import { Film, Image as ImageIcon, Music2, Scissors, SlidersHorizontal, Sparkles, Trash2, Upload } from 'lucide-react';
import type { Clip, MediaAsset, Project, Track } from '@/types';
import { useMediaStore } from '@/state/mediaStore';
import { usePlaybackStore } from '@/state/playbackStore';
import { useProjectStore } from '@/state/projectStore';
import { formatTimecode } from '@/lib/timeline/geometry';
import {
  clipTimelineDurationSec,
  projectDurationSec,
  removeClip,
  sortedTracks,
  splitClipAt,
  timelineAtPath,
  timelineStartOffsetSec,
  updateTimelineAtPath,
} from '@/lib/timeline/operations';

type Props = {
  onImportClick?: () => void;
  onGenerateClick?: () => void;
  onOpenInspector?: () => void;
};

export function MobileClipStrip({ onImportClick, onGenerateClick, onOpenInspector }: Props) {
  const rootProject = useProjectStore((s) => s.project);
  const update = useProjectStore((s) => s.update);
  const assets = useMediaStore((s) => s.assets);
  const currentTime = usePlaybackStore((s) => s.currentTimeSec);
  const setCurrentTime = usePlaybackStore((s) => s.setCurrentTime);
  const pause = usePlaybackStore((s) => s.pause);
  const selectedClipIds = usePlaybackStore((s) => s.selectedClipIds);
  const selectClip = usePlaybackStore((s) => s.selectClip);
  const activeGroupPath = usePlaybackStore((s) => s.activeGroupPath);

  const project = useMemo(() => timelineAtPath(rootProject, activeGroupPath), [activeGroupPath, rootProject]);
  const timelineOffsetSec = useMemo(() => timelineStartOffsetSec(rootProject, activeGroupPath), [activeGroupPath, rootProject]);
  const localCurrentTime = Math.max(0, currentTime - timelineOffsetSec);
  const durationSec = projectDurationSec(project);
  const assetById = useMemo(() => new Map(assets.map((asset) => [asset.id, asset])), [assets]);
  const tracksById = useMemo(() => new Map(project.tracks.map((track) => [track.id, track])), [project.tracks]);
  const trackOrder = useMemo(() => {
    const order = new Map<string, number>();
    sortedTracks(project).forEach((track, index) => order.set(track.id, index));
    return order;
  }, [project]);
  const clips = useMemo(() => {
    return [...project.clips].sort((first, second) => {
      const timeDelta = first.startSec - second.startSec;
      if (Math.abs(timeDelta) > 1e-6) return timeDelta;
      return (trackOrder.get(first.trackId) ?? 0) - (trackOrder.get(second.trackId) ?? 0);
    });
  }, [project.clips, trackOrder]);
  const selectedClip = selectedClipIds.length === 1
    ? project.clips.find((clip) => clip.id === selectedClipIds[0]) ?? null
    : null;
  const selectedClipIdsInTimeline = selectedClipIds.filter((clipId) => project.clips.some((clip) => clip.id === clipId));
  const canSplit = Boolean(selectedClip && canSplitClipAt(selectedClip, localCurrentTime));

  const updateActive = useCallback((fn: (timeline: Project) => Project) => {
    update((nextProject) => updateTimelineAtPath(nextProject, activeGroupPath, fn));
  }, [activeGroupPath, update]);

  const handleScrub = (value: string) => {
    pause();
    setCurrentTime(Number(value) + timelineOffsetSec);
  };

  const handleSelectClip = (clip: Clip) => {
    pause();
    selectClip(clip.id);
    setCurrentTime(clip.startSec + timelineOffsetSec);
  };

  const handleSplit = () => {
    if (!selectedClip || !canSplit) return;
    pause();
    updateActive((nextProject) => splitClipAt(nextProject, selectedClip.id, localCurrentTime));
  };

  const handleDelete = () => {
    if (selectedClipIdsInTimeline.length === 0) return;
    pause();
    updateActive((nextProject) => (
      selectedClipIdsInTimeline.reduce((projectToUpdate, clipId) => removeClip(projectToUpdate, clipId), nextProject)
    ));
    selectClip(null);
  };

  if (clips.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-md border border-surface-600 bg-surface-800 text-slate-300">
          <Film size={20} />
        </div>
        <div className="text-sm font-semibold text-slate-100">No clips</div>
        <div className="grid w-full max-w-xs grid-cols-2 gap-2">
          <button type="button" className="mobile-editor-button" onClick={onImportClick}>
            <Upload size={14} />
            Import
          </button>
          <button type="button" className="mobile-editor-button-primary" onClick={onGenerateClick}>
            <Sparkles size={14} />
            Generate
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-surface-700 px-3 py-2">
        <div className="mb-1 flex items-center justify-between gap-3 font-mono text-[11px] tabular-nums text-slate-400">
          <span>{formatTimecode(localCurrentTime, project.fps)}</span>
          <span>{formatTimecode(durationSec, project.fps)}</span>
        </div>
        <input
          type="range"
          min={0}
          max={Math.max(durationSec, 0.001)}
          step={1 / Math.max(1, project.fps)}
          value={Math.min(durationSec, localCurrentTime)}
          onChange={(event) => handleScrub(event.currentTarget.value)}
          className="h-2 w-full cursor-pointer appearance-none rounded bg-surface-700 accent-brand-500"
          aria-label="Timeline position"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden">
        <div className="flex h-full min-w-max items-stretch gap-2 p-3">
          {clips.map((clip) => (
            <ClipTile
              key={clip.id}
              clip={clip}
              asset={assetById.get(clip.assetId)}
              track={tracksById.get(clip.trackId)}
              selected={selectedClipIds.includes(clip.id)}
              active={localCurrentTime >= clip.startSec && localCurrentTime <= clip.startSec + clipTimelineDurationSec(clip)}
              fps={project.fps}
              onClick={() => handleSelectClip(clip)}
            />
          ))}
        </div>
      </div>

      <div className="grid shrink-0 grid-cols-3 gap-2 border-t border-surface-700 p-2">
        <button
          type="button"
          className="mobile-editor-button"
          onClick={handleSplit}
          disabled={!canSplit}
        >
          <Scissors size={14} />
          Split
        </button>
        <button
          type="button"
          className="mobile-editor-button"
          onClick={onOpenInspector}
          disabled={!selectedClip}
        >
          <SlidersHorizontal size={14} />
          Inspect
        </button>
        <button
          type="button"
          className="mobile-editor-button-danger"
          onClick={handleDelete}
          disabled={selectedClipIdsInTimeline.length === 0}
        >
          <Trash2 size={14} />
          Delete
        </button>
      </div>
    </div>
  );
}

function ClipTile({
  clip,
  asset,
  track,
  selected,
  active,
  fps,
  onClick,
}: {
  clip: Clip;
  asset?: MediaAsset;
  track?: Track;
  selected: boolean;
  active: boolean;
  fps: number;
  onClick: () => void;
}) {
  const durationSec = clipTimelineDurationSec(clip);
  const isAudio = track?.kind === 'audio' || asset?.kind === 'audio';

  return (
    <button
      type="button"
      className={`flex w-32 shrink-0 flex-col overflow-hidden rounded-md border bg-surface-800 text-left transition-colors ${
        selected
          ? 'border-brand-400 ring-1 ring-brand-400/70'
          : active
            ? 'border-slate-400'
            : 'border-surface-600 hover:border-surface-500'
      }`}
      onClick={onClick}
      title={asset?.name ?? 'Missing media'}
    >
      <div className="relative aspect-[9/16] w-full overflow-hidden bg-surface-950">
        {asset?.thumbnailDataUrl ? (
          <img
            src={asset.thumbnailDataUrl}
            alt=""
            className="h-full w-full object-cover"
            draggable={false}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-slate-500">
            {isAudio ? <Music2 size={22} /> : asset?.kind === 'image' ? <ImageIcon size={22} /> : <Film size={22} />}
          </div>
        )}
        <span className={`absolute left-1 top-1 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
          isAudio ? 'bg-clip-audio/90 text-white' : asset?.kind === 'image' ? 'bg-clip-image/90 text-white' : 'bg-clip-video/90 text-white'
        }`}>
          {track?.kind ?? asset?.kind ?? 'clip'}
        </span>
      </div>
      <div className="min-w-0 p-2">
        <div className="truncate text-xs font-semibold text-slate-100">{asset?.name ?? 'Missing media'}</div>
        <div className="mt-1 flex items-center justify-between gap-2 font-mono text-[10px] tabular-nums text-slate-400">
          <span>{formatTimecode(clip.startSec, fps)}</span>
          <span>{durationSec.toFixed(1)}s</span>
        </div>
      </div>
    </button>
  );
}

function canSplitClipAt(clip: Clip, timeSec: number): boolean {
  const durationSec = clipTimelineDurationSec(clip);
  return timeSec > clip.startSec + 0.05 && timeSec < clip.startSec + durationSec - 0.05;
}
