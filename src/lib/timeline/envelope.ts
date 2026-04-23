import type { Clip, EnvelopePoint, Project, VolumeEnvelope } from '@/types';

/** Default envelope: two endpoints at full volume, disabled. */
export function defaultEnvelope(): VolumeEnvelope {
  return {
    enabled: false,
    points: [
      { t: 0, v: 1, curvature: 0 },
      { t: 1, v: 1, curvature: 0 },
    ],
  };
}

/** Evaluate the envelope at localT (0..1 normalized within the clip). */
export function evalEnvelopeAt(env: VolumeEnvelope | undefined, localT: number): number {
  if (!env || !env.enabled) return 1;
  const pts = env.points;
  if (pts.length === 0) return 1;
  if (pts.length === 1) return pts[0]!.v;
  if (localT <= pts[0]!.t) return pts[0]!.v;
  if (localT >= pts[pts.length - 1]!.t) return pts[pts.length - 1]!.v;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i]!;
    const p1 = pts[i + 1]!;
    if (localT >= p0.t && localT <= p1.t) {
      const dt = p1.t - p0.t;
      if (dt < 1e-9) return p1.v;
      const s = (localT - p0.t) / dt;
      const c = p0.curvature;
      // Quadratic bezier with control-point y = midY + curvature * 0.5.
      // This lets curvature bend segments even when v0 === v1.
      const midV = (p0.v + p1.v) / 2;
      const ctrlY = Math.max(0, Math.min(1, midV + c * 0.5));
      const u = 1 - s;
      return u * u * p0.v + 2 * u * s * ctrlY + s * s * p1.v;
    }
  }
  return pts[pts.length - 1]!.v;
}

/** Quadratic bezier control-point y value for SVG rendering of a segment. */
export function segmentControlY(p0: EnvelopePoint, p1: EnvelopePoint): number {
  const midV = (p0.v + p1.v) / 2;
  return Math.max(0, Math.min(1, midV + p0.curvature * 0.5));
}

function updateClipEnvelope(
  project: Project,
  clipId: string,
  fn: (env: VolumeEnvelope) => VolumeEnvelope,
): Project {
  return {
    ...project,
    clips: project.clips.map((c) => {
      if (c.id !== clipId) return c;
      const current = c.volumeEnvelope ?? defaultEnvelope();
      return { ...c, volumeEnvelope: fn(current) } satisfies Clip;
    }),
  };
}

export function setEnvelopeEnabled(project: Project, clipId: string, enabled: boolean): Project {
  return updateClipEnvelope(project, clipId, (env) => ({ ...env, enabled }));
}

/** Reset the envelope to the default (flat 100%) but preserve its enabled state. */
export function resetEnvelope(project: Project, clipId: string): Project {
  return updateClipEnvelope(project, clipId, (env) => ({
    ...defaultEnvelope(),
    enabled: env.enabled,
  }));
}

/** Insert a new point at the given (t, v). Endpoints (t=0 and t=1) are never added. */
export function addEnvelopePoint(
  project: Project,
  clipId: string,
  t: number,
  v: number,
): Project {
  const tClamped = Math.max(0, Math.min(1, t));
  const vClamped = Math.max(0, Math.min(1, v));
  if (tClamped <= 0 || tClamped >= 1) return project;
  return updateClipEnvelope(project, clipId, (env) => {
    const pts = env.points.slice();
    // Insert sorted by t; inherit curvature from the segment we're splitting.
    let insertIdx = pts.length;
    for (let i = 0; i < pts.length; i++) {
      if (pts[i]!.t > tClamped) { insertIdx = i; break; }
    }
    const prev = pts[insertIdx - 1];
    const newPoint: EnvelopePoint = {
      t: tClamped,
      v: vClamped,
      curvature: prev?.curvature ?? 0,
    };
    pts.splice(insertIdx, 0, newPoint);
    return { ...env, points: pts };
  });
}

/** Remove a point at the given index. Endpoints (first and last) cannot be removed. */
export function removeEnvelopePoint(
  project: Project,
  clipId: string,
  index: number,
): Project {
  return updateClipEnvelope(project, clipId, (env) => {
    if (index <= 0 || index >= env.points.length - 1) return env;
    const pts = env.points.slice();
    pts.splice(index, 1);
    return { ...env, points: pts };
  });
}

export function updateEnvelopePoint(
  project: Project,
  clipId: string,
  index: number,
  patch: Partial<EnvelopePoint>,
): Project {
  return updateClipEnvelope(project, clipId, (env) => {
    const pts = env.points.slice();
    if (index < 0 || index >= pts.length) return env;
    const current = pts[index]!;
    const isFirst = index === 0;
    const isLast = index === pts.length - 1;
    let nextT = patch.t ?? current.t;
    if (isFirst) nextT = 0;
    else if (isLast) nextT = 1;
    else {
      // Clamp strictly between neighbors (leave a tiny gap so sort order is stable).
      const prev = pts[index - 1]!;
      const next = pts[index + 1]!;
      const eps = 1e-4;
      nextT = Math.max(prev.t + eps, Math.min(next.t - eps, nextT));
    }
    const nextV = Math.max(0, Math.min(1, patch.v ?? current.v));
    const nextC = Math.max(-1, Math.min(1, patch.curvature ?? current.curvature));
    pts[index] = { t: nextT, v: nextV, curvature: nextC };
    return { ...env, points: pts };
  });
}

/** Set curvature of the segment starting at `index` to 0 (flatten). */
export function flattenEnvelopeSegmentAt(
  project: Project,
  clipId: string,
  index: number,
): Project {
  return updateClipEnvelope(project, clipId, (env) => {
    if (index < 0 || index >= env.points.length - 1) return env;
    const pts = env.points.slice();
    pts[index] = { ...pts[index]!, curvature: 0 };
    return { ...env, points: pts };
  });
}
