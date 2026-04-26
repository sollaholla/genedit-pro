import type { Clip, Project, Track } from '@/types';
import { clipSpeed, clipTimelineDurationSec } from '@/lib/timeline/operations';

const CLIP_BOUNDARY_EPSILON_SEC = 0.001;

export type ActiveLayer = {
  track: Track;
  clip: Clip;
  sourceTimeSec: number;
};

export type ResolvedFrame = {
  video: ActiveLayer | null;
  /** All active visible video/image sources, ordered from top track to bottom track. */
  videos: ActiveLayer[];
  /** All active audio sources across all non-muted/non-hidden tracks. */
  audios: ActiveLayer[];
};

export function resolveFrame(project: Project, t: number): ResolvedFrame {
  const sorted = [...project.tracks].sort((a, b) => a.index - b.index);
  let video: ActiveLayer | null = null;
  const videos: ActiveLayer[] = [];
  const audios: ActiveLayer[] = [];

  for (const track of sorted) {
    const clip = activeClipOnTrack(project.clips, track.id, t);
    if (!clip) continue;
    const timelineLocalSec = Math.max(0, Math.min(clipTimelineDurationSec(clip), t - clip.startSec));
    const layer: ActiveLayer = {
      track,
      clip,
      sourceTimeSec: clip.inSec + timelineLocalSec * clipSpeed(clip),
    };

    if (track.kind === 'video' && !track.hidden) {
      if (!video) video = layer;
      videos.push(layer);
      // Video tracks contribute their embedded audio to the mix.
      audios.push(layer);
    } else if (track.kind === 'audio' && !track.muted) {
      audios.push(layer);
    }
  }

  return { video, videos, audios };
}

function activeClipOnTrack(clips: Clip[], trackId: string, t: number): Clip | null {
  let active: Clip | null = null;
  for (const clip of clips) {
    if (clip.trackId !== trackId) continue;
    const end = clip.startSec + clipTimelineDurationSec(clip);
    if (t + CLIP_BOUNDARY_EPSILON_SEC >= clip.startSec && t < end - CLIP_BOUNDARY_EPSILON_SEC) {
      if (!active || clip.startSec > active.startSec) active = clip;
    }
  }
  if (active) return active;
  for (const clip of clips) {
    if (clip.trackId !== trackId) continue;
    const end = clip.startSec + clipTimelineDurationSec(clip);
    if (t >= clip.startSec && t < end) {
      if (!active || clip.startSec > active.startSec) active = clip;
    }
  }
  return active;
}

/** Clips whose start lies within (t, t + lookaheadSec]. Used to preroll decoders. */
export function upcomingClips(project: Project, t: number, lookaheadSec: number): Clip[] {
  const out: Clip[] = [];
  const horizon = t + lookaheadSec;
  for (const c of project.clips) {
    if (c.startSec > t && c.startSec <= horizon) out.push(c);
  }
  return out;
}
