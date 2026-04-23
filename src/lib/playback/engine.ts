import type { Clip, Project, Track } from '@/types';

export type ActiveLayer = {
  track: Track;
  clip: Clip;
  sourceTimeSec: number;
};

export type ResolvedFrame = {
  video: ActiveLayer | null;
  /** All active audio sources across all non-muted/non-hidden tracks. */
  audios: ActiveLayer[];
};

export function resolveFrame(project: Project, t: number): ResolvedFrame {
  const sorted = [...project.tracks].sort((a, b) => a.index - b.index);
  let video: ActiveLayer | null = null;
  const audios: ActiveLayer[] = [];

  for (const track of sorted) {
    const clip = activeClipOnTrack(project.clips, track.id, t);
    if (!clip) continue;
    const layer: ActiveLayer = { track, clip, sourceTimeSec: clip.inSec + (t - clip.startSec) };

    if (track.kind === 'video' && !track.hidden) {
      if (!video) video = layer;
      // Video tracks contribute their embedded audio to the mix.
      audios.push(layer);
    } else if (track.kind === 'audio' && !track.muted) {
      audios.push(layer);
    }
  }

  return { video, audios };
}

function activeClipOnTrack(clips: Clip[], trackId: string, t: number): Clip | null {
  for (const c of clips) {
    if (c.trackId !== trackId) continue;
    const end = c.startSec + (c.outSec - c.inSec);
    if (t >= c.startSec && t < end) return c;
  }
  return null;
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
