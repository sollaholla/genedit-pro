import { nanoid } from 'nanoid';
import type { Clip, MediaAsset, Project, Track } from '@/types';

export const MIN_CLIP_DURATION = 0.05; // 50ms floor to avoid zero-length clips

export function projectDurationSec(project: Project): number {
  let max = 0;
  for (const clip of project.clips) {
    const end = clip.startSec + (clip.outSec - clip.inSec);
    if (end > max) max = end;
  }
  return max;
}

export function sortedTracks(project: Project): Track[] {
  return [...project.tracks].sort((a, b) => a.index - b.index);
}

export function clipsOnTrack(project: Project, trackId: string): Clip[] {
  return project.clips
    .filter((c) => c.trackId === trackId)
    .sort((a, b) => a.startSec - b.startSec);
}

export function addClip(
  project: Project,
  asset: MediaAsset,
  trackId: string,
  startSec: number,
): Project {
  const track = project.tracks.find((t) => t.id === trackId);
  if (!track) return project;
  if (!isAssetCompatibleWithTrack(asset, track)) return project;
  const duration = Math.max(MIN_CLIP_DURATION, asset.durationSec);
  const clip: Clip = {
    id: nanoid(8),
    assetId: asset.id,
    trackId,
    startSec: Math.max(0, startSec),
    inSec: 0,
    outSec: duration,
    volume: 1,
  };
  return { ...project, clips: [...project.clips, clip] };
}

export function removeClip(project: Project, clipId: string): Project {
  return { ...project, clips: project.clips.filter((c) => c.id !== clipId) };
}

export function moveClip(
  project: Project,
  clipId: string,
  newStartSec: number,
  newTrackId?: string,
): Project {
  const clip = project.clips.find((c) => c.id === clipId);
  if (!clip) return project;
  const targetTrackId = newTrackId ?? clip.trackId;
  const targetTrack = project.tracks.find((t) => t.id === targetTrackId);
  if (!targetTrack) return project;

  // Require kind compatibility when moving across tracks.
  if (targetTrackId !== clip.trackId) {
    // We cannot check asset kind here without mediaStore; callers should enforce.
    // Still allow the move; UI enforces kind at drop time.
  }

  return {
    ...project,
    clips: project.clips.map((c) =>
      c.id === clipId ? { ...c, startSec: Math.max(0, newStartSec), trackId: targetTrackId } : c,
    ),
  };
}

export function trimClipLeft(
  project: Project,
  clipId: string,
  newStartSec: number,
): Project {
  const clip = project.clips.find((c) => c.id === clipId);
  if (!clip) return project;
  const delta = newStartSec - clip.startSec;
  const nextInSec = Math.max(0, clip.inSec + delta);
  const nextStart = Math.max(0, clip.startSec + delta);
  if (clip.outSec - nextInSec < MIN_CLIP_DURATION) return project;
  return {
    ...project,
    clips: project.clips.map((c) =>
      c.id === clipId ? { ...c, startSec: nextStart, inSec: nextInSec } : c,
    ),
  };
}

export function trimClipRight(
  project: Project,
  clipId: string,
  newEndSec: number,
): Project {
  const clip = project.clips.find((c) => c.id === clipId);
  if (!clip) return project;
  const onTimelineDuration = Math.max(MIN_CLIP_DURATION, newEndSec - clip.startSec);
  const nextOutSec = clip.inSec + onTimelineDuration;
  if (nextOutSec - clip.inSec < MIN_CLIP_DURATION) return project;
  return {
    ...project,
    clips: project.clips.map((c) =>
      c.id === clipId ? { ...c, outSec: nextOutSec } : c,
    ),
  };
}

export function splitClipAt(
  project: Project,
  clipId: string,
  timeSec: number,
): Project {
  const clip = project.clips.find((c) => c.id === clipId);
  if (!clip) return project;
  const clipEnd = clip.startSec + (clip.outSec - clip.inSec);
  if (timeSec <= clip.startSec + MIN_CLIP_DURATION) return project;
  if (timeSec >= clipEnd - MIN_CLIP_DURATION) return project;
  const offset = timeSec - clip.startSec;
  const splitInSec = clip.inSec + offset;
  const left: Clip = { ...clip, outSec: splitInSec };
  const right: Clip = {
    ...clip,
    id: nanoid(8),
    startSec: timeSec,
    inSec: splitInSec,
  };
  return {
    ...project,
    clips: [...project.clips.filter((c) => c.id !== clipId), left, right],
  };
}

export function addTrack(project: Project, kind: 'video' | 'audio'): Project {
  const track: Track = {
    id: nanoid(8),
    kind,
    index: project.tracks.length,
    muted: false,
    hidden: false,
  };
  const reindexed = [...project.tracks, track].map((t, i) => ({ ...t, index: i }));
  return { ...project, tracks: reindexed };
}

export function removeTrack(project: Project, trackId: string): Project {
  return {
    ...project,
    tracks: project.tracks
      .filter((t) => t.id !== trackId)
      .map((t, i) => ({ ...t, index: i })),
    clips: project.clips.filter((c) => c.trackId !== trackId),
  };
}

export function setTrackProp<K extends keyof Track>(
  project: Project,
  trackId: string,
  key: K,
  value: Track[K],
): Project {
  return {
    ...project,
    tracks: project.tracks.map((t) => (t.id === trackId ? { ...t, [key]: value } : t)),
  };
}

export function setClipProp<K extends keyof Clip>(
  project: Project,
  clipId: string,
  key: K,
  value: Clip[K],
): Project {
  return {
    ...project,
    clips: project.clips.map((c) => (c.id === clipId ? { ...c, [key]: value } : c)),
  };
}

/** Place a duplicate of `clipId` immediately after the original on the same track. */
export function duplicateClip(project: Project, clipId: string): Project {
  const clip = project.clips.find((c) => c.id === clipId);
  if (!clip) return project;
  const duration = clip.outSec - clip.inSec;
  const newClip: Clip = {
    ...clip,
    id: nanoid(8),
    startSec: clip.startSec + duration,
    volumeEnvelope: clip.volumeEnvelope
      ? { ...clip.volumeEnvelope, points: clip.volumeEnvelope.points.map((p) => ({ ...p })) }
      : undefined,
  };
  return { ...project, clips: [...project.clips, newClip] };
}

/**
 * Paste a previously-copied clip onto `trackId` at `startSec`. The asset and
 * source trim points are preserved; envelope is deep-copied.
 */
export function pasteClipFrom(
  project: Project,
  source: Clip,
  trackId: string,
  startSec: number,
): Project {
  const track = project.tracks.find((t) => t.id === trackId);
  if (!track) return project;
  const newClip: Clip = {
    ...source,
    id: nanoid(8),
    trackId,
    startSec: Math.max(0, startSec),
    volumeEnvelope: source.volumeEnvelope
      ? { ...source.volumeEnvelope, points: source.volumeEnvelope.points.map((p) => ({ ...p })) }
      : undefined,
  };
  return { ...project, clips: [...project.clips, newClip] };
}

/** Replace a clip's underlying asset and source-trim points; timeline position unchanged. */
export function replaceClipAsset(
  project: Project,
  clipId: string,
  newAssetId: string,
  newInSec: number,
  newOutSec: number,
): Project {
  const clip = project.clips.find((c) => c.id === clipId);
  if (!clip) return project;
  const inClamped = Math.max(0, Math.min(newInSec, newOutSec - MIN_CLIP_DURATION));
  const outClamped = Math.max(inClamped + MIN_CLIP_DURATION, newOutSec);
  return {
    ...project,
    clips: project.clips.map((c) =>
      c.id === clipId ? { ...c, assetId: newAssetId, inSec: inClamped, outSec: outClamped } : c,
    ),
  };
}

/**
 * Creates an audio-only copy of a video clip on a target audio track,
 * keeping the original clip in place. Used when the user drags a video
 * clip onto an audio track.
 */
export function extractAudioFromClip(
  project: Project,
  clipId: string,
  targetTrackId: string,
): Project {
  const clip = project.clips.find((c) => c.id === clipId);
  if (!clip) return project;
  const targetTrack = project.tracks.find((t) => t.id === targetTrackId);
  if (!targetTrack || targetTrack.kind !== 'audio') return project;
  const newClip: Clip = {
    ...clip,
    id: nanoid(8),
    trackId: targetTrackId,
    volume: 1,
  };
  return { ...project, clips: [...project.clips, newClip] };
}

export function isAssetCompatibleWithTrack(asset: MediaAsset, track: Track): boolean {
  if (track.kind === 'video') return asset.kind === 'video' || asset.kind === 'image';
  return asset.kind === 'audio' || asset.kind === 'video';
}

export function createInitialProject(): Project {
  const v1: Track = { id: nanoid(8), kind: 'video', index: 0, muted: false, hidden: false };
  const v2: Track = { id: nanoid(8), kind: 'video', index: 1, muted: false, hidden: false };
  const a1: Track = { id: nanoid(8), kind: 'audio', index: 2, muted: false, hidden: false };
  const a2: Track = { id: nanoid(8), kind: 'audio', index: 3, muted: false, hidden: false };
  return {
    id: nanoid(12),
    name: 'Untitled Project',
    fps: 30,
    width: 1920,
    height: 1080,
    tracks: [v1, v2, a1, a2],
    clips: [],
  };
}
