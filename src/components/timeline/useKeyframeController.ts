import { useCallback, useMemo, useState } from 'react';
import type { Clip, Project } from '@/types';
import {
  moveTransformKeyframeGroup,
  removeTransformKeyframeGroup,
  updateTransformKeyframe,
} from '@/lib/components/transform';
import { clipTimelineDurationSec } from '@/lib/timeline/operations';
import {
  findSelectedKeyframe,
  getKeyframeProperties,
  laneHeightForClip,
  type KeyframeSelection,
} from './keyframeModel';

type ProjectUpdater = (fn: (project: Project) => Project) => void;

type UseKeyframeControllerArgs = {
  clips: Clip[];
  selectedClip: Clip | null;
  currentTimeSec: number;
  fps: number;
  visibleKeyframeComponentKeys: string[];
  update: ProjectUpdater;
  updateSilent: ProjectUpdater;
  beginTx: () => void;
  setCurrentTime: (timeSec: number) => void;
};

export function useKeyframeController({
  clips,
  selectedClip,
  currentTimeSec,
  fps,
  visibleKeyframeComponentKeys,
  update,
  updateSilent,
  beginTx,
  setCurrentTime,
}: UseKeyframeControllerArgs) {
  const [selectedKeyframe, setSelectedKeyframe] = useState<KeyframeSelection | null>(null);
  const selectedKeyframeClip = selectedKeyframe
    ? clips.find((clip) => clip.id === selectedKeyframe.clipId) ?? null
    : null;

  const visibleKeyframeProperties = useMemo(() => {
    if (!selectedClip) return [];
    return getKeyframeProperties(selectedClip, new Set(visibleKeyframeComponentKeys));
  }, [selectedClip, visibleKeyframeComponentKeys]);

  const keyframeLaneHeight = selectedClip
    ? laneHeightForClip(
      visibleKeyframeProperties.length,
      countVisibleComponentsWithKeyframes(visibleKeyframeProperties),
    )
    : 0;

  const selectedKeyframeData = useMemo(
    () => findSelectedKeyframe(selectedKeyframeClip, selectedKeyframe),
    [selectedKeyframeClip, selectedKeyframe],
  );

  const patchClip = useCallback((clipId: string, writer: (clip: Clip) => Clip, silent = false) => {
    const apply = silent ? updateSilent : update;
    apply((project) => ({
      ...project,
      clips: project.clips.map((clip) => (clip.id === clipId ? writer(clip) : clip)),
    }));
  }, [update, updateSilent]);

  const deleteSelectedKeyframe = useCallback(() => {
    if (!selectedKeyframe) return;
    patchClip(selectedKeyframe.clipId, (clip) => removeTransformKeyframeGroup(clip, selectedKeyframe));
    setSelectedKeyframe(null);
  }, [patchClip, selectedKeyframe]);

  const setSelectedKeyframeValue = useCallback((value: number) => {
    if (!selectedKeyframe) return;
    patchClip(selectedKeyframe.clipId, (clip) => updateTransformKeyframe(clip, selectedKeyframe, { value }));
  }, [patchClip, selectedKeyframe]);

  const nudgeSelectedKeyframe = useCallback((property: 'time' | 'value', direction: -1 | 1) => {
    if (!selectedKeyframeData || !selectedKeyframeClip) return;
    const frameStep = 1 / Math.max(1, fps);
    const valueStep = selectedKeyframeData.property === 'scale' ? 0.01 : 1;
    const durationSec = clipTimelineDurationSec(selectedKeyframeClip);
    const patch = property === 'time'
      ? { timeSec: Math.max(0, Math.min(durationSec, selectedKeyframeData.timeSec + direction * frameStep)) }
      : { value: selectedKeyframeData.value + direction * valueStep };
    patchClip(selectedKeyframeClip.id, (clip) => updateTransformKeyframe(clip, selectedKeyframeData, patch));
    if (property === 'time') {
      const nextTime = patch.timeSec ?? selectedKeyframeData.timeSec;
      setCurrentTime(selectedKeyframeClip.startSec + nextTime);
    }
  }, [fps, patchClip, selectedKeyframeClip, selectedKeyframeData, setCurrentTime]);

  const beginKeyframeDrag = useCallback(() => {
    beginTx();
  }, [beginTx]);

  const moveKeyframe = useCallback((meta: KeyframeSelection & { timeSec: number; value: number }) => {
    patchClip(
      meta.clipId,
      (clip) => updateTransformKeyframe(clip, meta, { timeSec: meta.timeSec, value: meta.value }),
      true,
    );
    setSelectedKeyframe({
      componentIndex: meta.componentIndex,
      componentId: meta.componentId,
      clipId: meta.clipId,
      property: meta.property,
      keyframeId: meta.keyframeId,
    });
    const clip = clips.find((candidate) => candidate.id === meta.clipId);
    if (clip) setCurrentTime(clip.startSec + meta.timeSec);
  }, [clips, patchClip, setCurrentTime]);

  const moveKeyframeGroup = useCallback((meta: { members: KeyframeSelection[]; timeSec: number }) => {
    const first = meta.members[0];
    if (!first) return;
    const clip = clips.find((candidate) => candidate.id === first.clipId);
    if (!clip) return;
    const durationSec = clipTimelineDurationSec(clip);
    const nextTimeSec = Math.max(0, Math.min(durationSec, meta.timeSec));
    patchClip(
      first.clipId,
      (clip) => moveTransformKeyframeGroup(clip, meta.members, nextTimeSec),
      true,
    );
    setSelectedKeyframe(first);
    setCurrentTime(clip.startSec + nextTimeSec);
  }, [clips, patchClip, setCurrentTime]);

  const selectKeyframe = useCallback((meta: KeyframeSelection & { timeSec: number }) => {
    setSelectedKeyframe({
      componentIndex: meta.componentIndex,
      componentId: meta.componentId,
      clipId: meta.clipId,
      property: meta.property,
      keyframeId: meta.keyframeId,
    });
    const clip = clips.find((candidate) => candidate.id === meta.clipId);
    if (clip) setCurrentTime(clip.startSec + meta.timeSec);
  }, [clips, setCurrentTime]);

  const selectKeyframeGroup = useCallback((meta: { members: KeyframeSelection[]; timeSec: number }) => {
    const first = meta.members[0];
    if (!first) return;
    setSelectedKeyframe(first);
    const clip = clips.find((candidate) => candidate.id === first.clipId);
    if (clip) setCurrentTime(clip.startSec + meta.timeSec);
  }, [clips, setCurrentTime]);

  return {
    currentTimeSec,
    deleteSelectedKeyframe,
    keyframeLaneHeight,
    selectedKeyframe,
    selectedKeyframeData,
    setSelectedKeyframe,
    setSelectedKeyframeValue,
    beginKeyframeDrag,
    moveKeyframe,
    moveKeyframeGroup,
    nudgeSelectedKeyframe,
    selectKeyframe,
    selectKeyframeGroup,
    visibleKeyframeProperties,
  };
}

function countVisibleComponentsWithKeyframes(rows: Array<{ componentId: string }>): number {
  return new Set(rows.map((row) => row.componentId)).size;
}
