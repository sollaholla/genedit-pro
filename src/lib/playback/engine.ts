import type { Clip, Project, Track } from '@/types';

export type ActiveLayer = {
  track: Track;
  clip: Clip;
  sourceTimeSec: number; // where to seek inside the asset
};

export type ResolvedFrame = {
  video: ActiveLayer | null;
  audio: ActiveLayer | null;
};

/**
 * Phase-1 compositor: returns the top-most visible video layer and the
 * top-most non-muted audio layer at time `t`. Phase 2 will return the full
 * stack so a canvas compositor can blend them.
 */
export function resolveFrame(project: Project, t: number): ResolvedFrame {
  const sorted = [...project.tracks].sort((a, b) => a.index - b.index);
  let video: ActiveLayer | null = null;
  let audio: ActiveLayer | null = null;

  // Iterate top-to-bottom so earlier matches win for video.
  for (const track of sorted) {
    if (track.kind === 'video' && !track.hidden && !video) {
      const clip = activeClipOnTrack(project.clips, track.id, t);
      if (clip) {
        video = { track, clip, sourceTimeSec: clip.inSec + (t - clip.startSec) };
      }
    }
    if (track.kind === 'audio' && !track.muted && !audio) {
      const clip = activeClipOnTrack(project.clips, track.id, t);
      if (clip) {
        audio = { track, clip, sourceTimeSec: clip.inSec + (t - clip.startSec) };
      }
    }
  }

  return { video, audio };
}

function activeClipOnTrack(clips: Clip[], trackId: string, t: number): Clip | null {
  for (const c of clips) {
    if (c.trackId !== trackId) continue;
    const end = c.startSec + (c.outSec - c.inSec);
    if (t >= c.startSec && t < end) return c;
  }
  return null;
}
