import { nanoid } from 'nanoid';
import type { Clip, MediaAsset, Project, Track, TrackGroup } from '@/types';

export const MIN_CLIP_DURATION = 0.05; // 50ms floor to avoid zero-length clips
export const MIN_CLIP_SPEED = 0.25;
export const MAX_CLIP_SPEED = 4;

export function clipSpeed(clip: Clip): number {
  return Math.max(MIN_CLIP_SPEED, Math.min(MAX_CLIP_SPEED, clip.speed ?? 1));
}

/** Duration the clip occupies on the timeline, after speed is applied. */
export function clipTimelineDurationSec(clip: Clip): number {
  return Math.max(MIN_CLIP_DURATION, (clip.outSec - clip.inSec) / clipSpeed(clip));
}

export function clipFadeInSec(clip: Clip): number {
  return Math.max(0, Math.min(clipTimelineDurationSec(clip), clip.fadeInSec ?? 0));
}

export function clipFadeOutSec(clip: Clip): number {
  const durationSec = clipTimelineDurationSec(clip);
  return Math.max(0, Math.min(durationSec - clipFadeInSec(clip), clip.fadeOutSec ?? 0));
}

export function clipOpacityAtTimelineTime(clip: Clip, timelineTimeSec: number): number {
  const durationSec = clipTimelineDurationSec(clip);
  const localTimeSec = Math.max(0, Math.min(durationSec, timelineTimeSec - clip.startSec));
  const fadeIn = clipFadeInSec(clip);
  const fadeOut = clipFadeOutSec(clip);
  let opacity = 1;
  if (fadeIn > 1e-6) opacity = Math.min(opacity, localTimeSec / fadeIn);
  if (fadeOut > 1e-6) opacity = Math.min(opacity, (durationSec - localTimeSec) / fadeOut);
  return Math.max(0, Math.min(1, opacity));
}

export function withClampedClipFades(clip: Clip): Clip {
  return {
    ...clip,
    fadeInSec: clipFadeInSec(clip),
    fadeOutSec: clipFadeOutSec(clip),
  };
}

export function projectDurationSec(project: Project): number {
  let max = 0;
  for (const clip of project.clips) {
    const end = clip.startSec + clipTimelineDurationSec(clip);
    if (end > max) max = end;
  }
  for (const track of project.tracks) {
    if (!track.group) continue;
    const end = track.group.startSec + trackGroupDurationSec(track.group);
    if (end > max) max = end;
  }
  return max;
}

export function trackGroupDurationSec(group: TrackGroup): number {
  return projectDurationSec(projectFromTrackGroup(group));
}

export function groupTrackDurationSec(track: Track): number {
  return track.group ? trackGroupDurationSec(track.group) : 0;
}

export function groupTrackEndSec(track: Track): number {
  return track.group ? track.group.startSec + groupTrackDurationSec(track) : 0;
}

export function sortedTracks(project: Project): Track[] {
  return [...project.tracks].sort((a, b) => a.index - b.index);
}

export function projectFromTrackGroup(group: TrackGroup, base?: Project): Project {
  return {
    id: group.id,
    name: base?.name ?? 'Track Group',
    fps: base?.fps ?? 30,
    width: base?.width ?? 1920,
    height: base?.height ?? 1080,
    metadata: base?.metadata,
    tracks: group.tracks,
    clips: group.clips,
  };
}

export function timelineAtPath(project: Project, groupPath: string[]): Project {
  let timeline = project;
  for (const trackId of groupPath) {
    const track = timeline.tracks.find((candidate) => candidate.id === trackId);
    if (!track?.group) return timeline;
    timeline = projectFromTrackGroup(track.group, project);
  }
  return timeline;
}

export function timelineStartOffsetSec(project: Project, groupPath: string[]): number {
  let timeline = project;
  let offset = 0;
  for (const trackId of groupPath) {
    const track = timeline.tracks.find((candidate) => candidate.id === trackId);
    if (!track?.group) return offset;
    offset += track.group.startSec;
    timeline = projectFromTrackGroup(track.group, project);
  }
  return offset;
}

export function groupPathLabels(project: Project, groupPath: string[]): string[] {
  const labels: string[] = [];
  let timeline = project;
  for (const trackId of groupPath) {
    const track = timeline.tracks.find((candidate) => candidate.id === trackId);
    if (!track?.group) break;
    labels.push(track.name || 'Group');
    timeline = projectFromTrackGroup(track.group, project);
  }
  return labels;
}

export function updateTimelineAtPath(
  project: Project,
  groupPath: string[],
  updater: (timeline: Project) => Project,
): Project {
  if (groupPath.length === 0) return updater(project);

  const updateNested = (timeline: Project, depth: number): Project => {
    if (depth >= groupPath.length) return updater(timeline);
    const trackId = groupPath[depth];
    let changed = false;
    const tracks = timeline.tracks.map((track) => {
      if (track.id !== trackId || !track.group) return track;
      const child = updateNested(projectFromTrackGroup(track.group, project), depth + 1);
      changed = true;
      return {
        ...track,
        group: {
          ...track.group,
          tracks: child.tracks.map((candidate, index) => ({ ...candidate, index })),
          clips: child.clips,
        },
      };
    });
    return changed ? { ...timeline, tracks } : timeline;
  };

  return updateNested(project, 0);
}

export function flattenTimeline(project: Project): Pick<Project, 'tracks' | 'clips'> {
  const tracks: Track[] = [];
  const clips: Clip[] = [];

  const visitTimeline = (
    sourceTracks: Track[],
    sourceClips: Clip[],
    timeOffsetSec: number,
    indexBase: number,
    indexSpan: number,
    idPrefix: string,
    hiddenByParent: boolean,
    mutedByParent: boolean,
  ) => {
    const ordered = [...sourceTracks].sort((first, second) => first.index - second.index);
    const denominator = Math.max(1, ordered.length + 1);

    ordered.forEach((track, trackIndex) => {
      const effectiveIndex = indexBase + ((trackIndex + 1) / denominator) * indexSpan;
      const effectiveId = `${idPrefix}${track.id}`;
      if (track.group) {
        const childHidden = hiddenByParent || track.hidden;
        const childMuted = mutedByParent || track.hidden || track.muted;
        visitTimeline(
          track.group.tracks,
          track.group.clips,
          timeOffsetSec + track.group.startSec,
          effectiveIndex,
          indexSpan / denominator,
          `${effectiveId}/`,
          childHidden,
          childMuted,
        );
        return;
      }

      const effectiveTrack: Track = {
        ...track,
        id: effectiveId,
        index: effectiveIndex,
        hidden: hiddenByParent || track.hidden,
        muted: mutedByParent || track.muted,
      };
      tracks.push(effectiveTrack);
      for (const clip of sourceClips) {
        if (clip.trackId !== track.id) continue;
        clips.push({
          ...clip,
          trackId: effectiveId,
          startSec: clip.startSec + timeOffsetSec,
        });
      }
    });
  };

  visitTimeline(project.tracks, project.clips, 0, 0, Math.max(1, project.tracks.length), '', false, false);
  return { tracks, clips };
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
    speed: 1,
    scale: 1,
    components: [],
    volume: 1,
    fadeInSec: 0,
    fadeOutSec: 0,
  };
  return { ...project, clips: [...project.clips, clip] };
}

export function removeClip(project: Project, clipId: string): Project {
  return { ...project, clips: project.clips.filter((c) => c.id !== clipId) };
}

/**
 * Move a group of clips by the same deltaSec. The group's leftmost clip is
 * clamped so it doesn't go below t=0; the delta is uniformly reduced so the
 * group preserves its relative spacing.
 */
export function moveClipsBy(
  project: Project,
  clipIds: string[],
  deltaSec: number,
): Project {
  const idsSet = new Set(clipIds);
  const selected = project.clips.filter((c) => idsSet.has(c.id));
  if (selected.length === 0) return project;
  const minStart = Math.min(...selected.map((c) => c.startSec));
  const clampedDelta = Math.max(deltaSec, -minStart);
  if (clampedDelta === 0) return project;
  return {
    ...project,
    clips: project.clips.map((c) =>
      idsSet.has(c.id) ? { ...c, startSec: c.startSec + clampedDelta } : c,
    ),
  };
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

/**
 * Trim from the left. startSec and inSec slide together so the right edge
 * (startSec + outSec - inSec) stays put. Clamped so inSec >= 0 (can't expose
 * source earlier than its own start), startSec >= 0 (no timeline before 0),
 * and the clip stays at least MIN_CLIP_DURATION long.
 */
export function trimClipLeft(
  project: Project,
  clipId: string,
  newStartSec: number,
): Project {
  const clip = project.clips.find((c) => c.id === clipId);
  if (!clip) return project;
  const rawDelta = newStartSec - clip.startSec;
  const minDelta = Math.max(-clip.inSec, -clip.startSec);
  const maxDelta = clipTimelineDurationSec(clip) - MIN_CLIP_DURATION;
  const delta = Math.max(minDelta, Math.min(maxDelta, rawDelta));
  const nextInSec = clip.inSec + delta * clipSpeed(clip);
  const nextStart = clip.startSec + delta;
  return {
    ...project,
    clips: project.clips.map((c) =>
      c.id === clipId ? withClampedClipFades({ ...c, startSec: nextStart, inSec: nextInSec }) : c,
    ),
  };
}

/**
 * Trim from the right. startSec and inSec are fixed; outSec moves. Clamped
 * so the clip stays at least MIN_CLIP_DURATION long and outSec never exceeds
 * the underlying asset's duration (if provided).
 */
export function trimClipRight(
  project: Project,
  clipId: string,
  newEndSec: number,
  maxSourceSec?: number,
): Project {
  const clip = project.clips.find((c) => c.id === clipId);
  if (!clip) return project;
  const requestedDur = newEndSec - clip.startSec;
  const maxDurFromSource = maxSourceSec !== undefined
    ? Math.max(MIN_CLIP_DURATION, (maxSourceSec - clip.inSec) / clipSpeed(clip))
    : Infinity;
  const dur = Math.max(MIN_CLIP_DURATION, Math.min(maxDurFromSource, requestedDur));
  const nextOutSec = clip.inSec + dur * clipSpeed(clip);
  return {
    ...project,
    clips: project.clips.map((c) =>
      c.id === clipId ? withClampedClipFades({ ...c, outSec: nextOutSec }) : c,
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
  const clipEnd = clip.startSec + clipTimelineDurationSec(clip);
  if (timeSec <= clip.startSec + MIN_CLIP_DURATION) return project;
  if (timeSec >= clipEnd - MIN_CLIP_DURATION) return project;
  const offset = (timeSec - clip.startSec) * clipSpeed(clip);
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
  return insertTrack(project, kind, project.tracks.length);
}

export function insertTrack(
  project: Project,
  kind: 'video' | 'audio',
  insertIndex: number,
): Project {
  const sameKindCount = project.tracks.filter((t) => t.kind === kind).length + 1;
  const track: Track = {
    id: nanoid(8),
    name: `${kind === 'video' ? 'Video' : 'Audio'} ${sameKindCount}`,
    kind,
    index: project.tracks.length,
    muted: false,
    hidden: false,
  };
  const next = [...project.tracks];
  const at = Math.max(0, Math.min(insertIndex, next.length));
  next.splice(at, 0, track);
  return { ...project, tracks: next.map((t, i) => ({ ...t, index: i })) };
}

export function moveTrack(project: Project, trackId: string, targetIndex: number): Project {
  const tracks = sortedTracks(project);
  const from = tracks.findIndex((t) => t.id === trackId);
  if (from < 0) return project;
  const to = Math.max(0, Math.min(targetIndex, tracks.length - 1));
  if (from === to) return project;
  const next = [...tracks];
  const [track] = next.splice(from, 1);
  if (!track) return project;
  next.splice(to, 0, track);
  return { ...project, tracks: next.map((t, i) => ({ ...t, index: i })) };
}

export function moveTrackBy(project: Project, trackId: string, delta: number): Project {
  const tracks = sortedTracks(project);
  const idx = tracks.findIndex((t) => t.id === trackId);
  if (idx < 0) return project;
  return moveTrack(project, trackId, idx + delta);
}

export function groupTracks(
  project: Project,
  trackIds: string[],
  groupTrackId = nanoid(8),
  groupId = nanoid(8),
): Project {
  const selectedIds = new Set(trackIds);
  const orderedTracks = sortedTracks(project);
  const selectedTracks = orderedTracks.filter((track) => selectedIds.has(track.id));
  if (selectedTracks.length < 2) return project;

  const selectedTrackIds = new Set(selectedTracks.map((track) => track.id));
  const selectedClips = project.clips.filter((clip) => selectedTrackIds.has(clip.trackId));
  const groupStartSec = selectedClips.length > 0
    ? Math.min(...selectedClips.map((clip) => clip.startSec))
    : 0;
  const childTracks = selectedTracks.map((track, index) => ({ ...track, index }));
  const childClips = selectedClips.map((clip) => ({
    ...clip,
    startSec: Math.max(0, clip.startSec - groupStartSec),
  }));
  const firstSelectedIndex = selectedTracks[0]!.index;
  const remainingTracks = orderedTracks.filter((track) => !selectedTrackIds.has(track.id));
  const insertAt = remainingTracks.findIndex((track) => track.index > firstSelectedIndex);
  const groupTrack: Track = {
    id: groupTrackId,
    name: `Group ${project.tracks.filter((track) => track.group).length + 1}`,
    kind: 'video',
    index: firstSelectedIndex,
    muted: false,
    hidden: false,
    group: {
      id: groupId,
      startSec: groupStartSec,
      tracks: childTracks,
      clips: childClips,
    },
  };
  const nextTracks = [...remainingTracks];
  nextTracks.splice(insertAt < 0 ? nextTracks.length : insertAt, 0, groupTrack);

  return {
    ...project,
    tracks: nextTracks.map((track, index) => ({ ...track, index })),
    clips: project.clips.filter((clip) => !selectedTrackIds.has(clip.trackId)),
  };
}

export function ungroupTrack(project: Project, trackId: string): Project {
  const orderedTracks = sortedTracks(project);
  const groupTrack = orderedTracks.find((track) => track.id === trackId);
  if (!groupTrack?.group) return project;
  const insertIndex = groupTrack.index;
  const childTrackIds = new Set(groupTrack.group.tracks.map((track) => track.id));
  const childClips = groupTrack.group.clips.map((clip) => ({
    ...clip,
    startSec: clip.startSec + groupTrack.group!.startSec,
  }));
  const remainingTracks = orderedTracks.filter((track) => track.id !== trackId);
  const childTracks = groupTrack.group.tracks.map((track) => ({ ...track }));
  const nextTracks = [...remainingTracks];
  const insertAt = nextTracks.findIndex((track) => track.index > insertIndex);
  nextTracks.splice(insertAt < 0 ? nextTracks.length : insertAt, 0, ...childTracks);

  return {
    ...project,
    tracks: nextTracks.map((track, index) => ({ ...track, index })),
    clips: [
      ...project.clips.filter((clip) => !childTrackIds.has(clip.trackId)),
      ...childClips,
    ],
  };
}

export function moveGroupTrackStart(project: Project, trackId: string, startSec: number): Project {
  return {
    ...project,
    tracks: project.tracks.map((track) => (
      track.id === trackId && track.group
        ? { ...track, group: { ...track.group, startSec: Math.max(0, startSec) } }
        : track
    )),
  };
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
  const duration = clipTimelineDurationSec(clip);
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

/**
 * Paste a group of copied clips at `startSec`, preserving their relative
 * time offsets and original track assignments.
 */
export function pasteClipsFrom(
  project: Project,
  sources: Clip[],
  startSec: number,
): Project {
  if (sources.length === 0) return project;
  const minStart = Math.min(...sources.map((c) => c.startSec));
  const tracks = new Set(project.tracks.map((t) => t.id));
  const newClips: Clip[] = [];
  for (const source of sources) {
    if (!tracks.has(source.trackId)) continue;
    const offset = source.startSec - minStart;
    const pasted: Clip = {
      ...source,
      id: nanoid(8),
      startSec: Math.max(0, startSec + offset),
      volumeEnvelope: source.volumeEnvelope
        ? { ...source.volumeEnvelope, points: source.volumeEnvelope.points.map((p) => ({ ...p })) }
        : undefined,
    };
    newClips.push(pasted);
  }
  if (newClips.length === 0) return project;
  return { ...project, clips: [...project.clips, ...newClips] };
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
  const v1: Track = { id: nanoid(8), name: 'Video 1', kind: 'video', index: 0, muted: false, hidden: false };
  const v2: Track = { id: nanoid(8), name: 'Video 2', kind: 'video', index: 1, muted: false, hidden: false };
  const a1: Track = { id: nanoid(8), name: 'Audio 1', kind: 'audio', index: 2, muted: false, hidden: false };
  const a2: Track = { id: nanoid(8), name: 'Audio 2', kind: 'audio', index: 3, muted: false, hidden: false };
  return {
    id: nanoid(12),
    name: 'Untitled Project',
    fps: 30,
    width: 1920,
    height: 1080,
    metadata: {
      aiGenerationSpendUsd: 0,
    },
    tracks: [v1, v2, a1, a2],
    clips: [],
  };
}
