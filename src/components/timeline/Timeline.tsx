import { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Scissors } from 'lucide-react';
import {
  RULER_HEIGHT_PX,
  TRACK_HEADER_WIDTH_PX,
  TRACK_HEIGHT_PX,
  clampPxPerSec,
} from '@/lib/timeline/geometry';
import { TimelineRuler } from './TimelineRuler';
import { TimelineTrack } from './TimelineTrack';
import { TrackHeader } from './TrackHeader';
import { Playhead } from './Playhead';
import { useProjectStore } from '@/state/projectStore';
import { usePlaybackStore } from '@/state/playbackStore';
import {
  addTrack,
  projectDurationSec,
  removeClip,
  sortedTracks,
  splitClipAt,
} from '@/lib/timeline/operations';

export function Timeline() {
  const project = useProjectStore((s) => s.project);
  const update = useProjectStore((s) => s.update);
  const currentTime = usePlaybackStore((s) => s.currentTimeSec);
  const setCurrentTime = usePlaybackStore((s) => s.setCurrentTime);
  const pxPerSec = usePlaybackStore((s) => s.pxPerSec);
  const setPxPerSec = usePlaybackStore((s) => s.setPxPerSec);
  const selection = usePlaybackStore((s) => s.selection);
  const selectedClipId = selection.kind === 'clip' ? selection.id : null;
  const selectClip = usePlaybackStore((s) => s.selectClip);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [viewportWidth, setViewportWidth] = useState(1200);
  const [scrollLeft, setScrollLeft] = useState(0);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewportWidth(el.clientWidth));
    ro.observe(el);
    setViewportWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const durationSec = projectDurationSec(project);
  const visibleDuration = Math.max(durationSec + 5, viewportWidth / pxPerSec + 5);
  const contentWidth = Math.max(viewportWidth, visibleDuration * pxPerSec);

  const tracks = sortedTracks(project);

  const snapTargets = useMemo(() => {
    const s = new Set<number>();
    s.add(0);
    s.add(currentTime);
    for (const c of project.clips) {
      s.add(c.startSec);
      s.add(c.startSec + (c.outSec - c.inSec));
    }
    return [...s];
  }, [project.clips, currentTime]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const delta = -e.deltaY * 0.002;
      const rect = el.getBoundingClientRect();
      const anchorLocalX = e.clientX - rect.left + el.scrollLeft;
      const anchorTime = Math.max(0, anchorLocalX / pxPerSec);
      const nextPx = clampPxPerSec(pxPerSec * (1 + delta));
      setPxPerSec(nextPx);
      requestAnimationFrame(() => {
        const target = anchorTime * nextPx - (e.clientX - rect.left);
        el.scrollLeft = Math.max(0, target);
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [pxPerSec, setPxPerSec]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;

      if (e.key === 's' || e.key === 'S') {
        if (!selectedClipId) return;
        update((p) => splitClipAt(p, selectedClipId, currentTime));
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (!selectedClipId) return;
        update((p) => removeClip(p, selectedClipId));
        selectClip(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedClipId, currentTime, update, selectClip]);

  const labelForTrack = (trackId: string) => {
    const track = project.tracks.find((t) => t.id === trackId);
    if (!track) return '';
    const sameKind = tracks.filter((x) => x.kind === track.kind);
    const idx = sameKind.findIndex((x) => x.id === trackId);
    return `${track.kind === 'video' ? 'V' : 'A'}${idx + 1}`;
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-surface-700 px-3 py-1.5">
        <div className="flex items-center gap-2">
          <button
            className="btn-ghost px-2 py-1 text-xs"
            onClick={() => update((p) => addTrack(p, 'video'))}
          >
            <Plus size={12} /> Video track
          </button>
          <button
            className="btn-ghost px-2 py-1 text-xs"
            onClick={() => update((p) => addTrack(p, 'audio'))}
          >
            <Plus size={12} /> Audio track
          </button>
          <button
            className="btn-ghost px-2 py-1 text-xs disabled:opacity-50"
            disabled={!selectedClipId}
            onClick={() => selectedClipId && update((p) => splitClipAt(p, selectedClipId, currentTime))}
            title="Split at playhead (S)"
          >
            <Scissors size={12} /> Split
          </button>
        </div>
        <div className="text-[11px] text-slate-400">
          Cmd/Ctrl-scroll to zoom · S to split · Del to remove
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <div
          className="shrink-0"
          style={{ width: TRACK_HEADER_WIDTH_PX }}
        >
          <div
            className="border-b border-r border-surface-700 bg-surface-900"
            style={{ height: RULER_HEIGHT_PX }}
          />
          {tracks.map((t) => (
            <TrackHeader key={`h-${t.id}`} track={t} label={labelForTrack(t.id)} />
          ))}
        </div>

        <div
          ref={scrollRef}
          className="relative min-h-0 flex-1 overflow-auto"
          onScroll={(e) => setScrollLeft((e.currentTarget as HTMLDivElement).scrollLeft)}
        >
          <div className="relative" style={{ width: contentWidth, minHeight: RULER_HEIGHT_PX + tracks.length * TRACK_HEIGHT_PX }}>
            <TimelineRuler
              pxPerSec={pxPerSec}
              durationSec={durationSec}
              viewportWidth={viewportWidth}
              scrollLeft={scrollLeft}
              onScrub={setCurrentTime}
            />
            <div>
              {tracks.map((track) => (
                <TimelineTrack
                  key={track.id}
                  track={track}
                  clips={project.clips.filter((c) => c.trackId === track.id)}
                  pxPerSec={pxPerSec}
                  selectedClipId={selectedClipId}
                  snapTargets={snapTargets}
                  contentWidth={contentWidth}
                />
              ))}
            </div>
            <Playhead
              timeSec={currentTime}
              pxPerSec={pxPerSec}
              height={RULER_HEIGHT_PX + tracks.length * TRACK_HEIGHT_PX}
              offsetLeft={0}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
