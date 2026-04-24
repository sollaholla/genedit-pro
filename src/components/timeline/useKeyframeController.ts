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
    () => findSelectedKeyframe(selectedClip, selectedKeyframe),
    [selectedClip, selectedKeyframe],
  );

  const patchSelectedClip = useCallback((writer: (clip: Clip) => Clip, silent = false) => {
    if (!selectedClip) return;
    const apply = silent ? updateSilent : update;
    apply((project) => ({
      ...project,
      clips: project.clips.map((clip) => (clip.id === selectedClip.id ? writer(clip) : clip)),
    }));
  }, [selectedClip, update, updateSilent]);

  const deleteSelectedKeyframe = useCallback(() => {
    if (!selectedKeyframe) return;
    patchSelectedClip((clip) => removeTransformKeyframeGroup(clip, selectedKeyframe));
    setSelectedKeyframe(null);
  }, [patchSelectedClip, selectedKeyframe]);

  const setSelectedKeyframeValue = useCallback((value: number) => {
    if (!selectedKeyframe) return;
    patchSelectedClip((clip) => updateTransformKeyframe(clip, selectedKeyframe, { value }));
  }, [patchSelectedClip, selectedKeyframe]);

  const nudgeSelectedKeyframe = useCallback((property: 'time' | 'value', direction: -1 | 1) => {
    if (!selectedKeyframeData || !selectedClip) return;
    const frameStep = 1 / Math.max(1, fps);
    const valueStep = selectedKeyframeData.property === 'scale' ? 0.01 : 1;
    const durationSec = clipTimelineDurationSec(selectedClip);
    const patch = property === 'time'
      ? { timeSec: Math.max(0, Math.min(durationSec, selectedKeyframeData.timeSec + direction * frameStep)) }
      : { value: selectedKeyframeData.value + direction * valueStep };
    patchSelectedClip((clip) => updateTransformKeyframe(clip, selectedKeyframeData, patch));
    if (property === 'time') {
      const nextTime = patch.timeSec ?? selectedKeyframeData.timeSec;
      setCurrentTime(selectedClip.startSec + nextTime);
    }
  }, [fps, patchSelectedClip, selectedClip, selectedKeyframeData, setCurrentTime]);

  const beginKeyframeDrag = useCallback(() => {
    beginTx();
  }, [beginTx]);

  const moveKeyframe = useCallback((meta: KeyframeSelection & { timeSec: number; value: number }) => {
    patchSelectedClip(
      (clip) => updateTransformKeyframe(clip, meta, { timeSec: meta.timeSec, value: meta.value }),
      true,
    );
    setSelectedKeyframe({
      componentIndex: meta.componentIndex,
      componentId: meta.componentId,
      property: meta.property,
      keyframeId: meta.keyframeId,
    });
    if (selectedClip) setCurrentTime(selectedClip.startSec + meta.timeSec);
  }, [patchSelectedClip, selectedClip, setCurrentTime]);

  const moveKeyframeGroup = useCallback((meta: { members: KeyframeSelection[]; timeSec: number }) => {
    const first = meta.members[0];
    if (!first) return;
    const durationSec = selectedClip ? clipTimelineDurationSec(selectedClip) : 0;
    const nextTimeSec = Math.max(0, Math.min(durationSec, meta.timeSec));
    patchSelectedClip(
      (clip) => moveTransformKeyframeGroup(clip, meta.members, nextTimeSec),
      true,
    );
    setSelectedKeyframe(first);
    if (selectedClip) setCurrentTime(selectedClip.startSec + nextTimeSec);
  }, [patchSelectedClip, selectedClip, setCurrentTime]);

  const selectKeyframe = useCallback((meta: KeyframeSelection & { timeSec: number }) => {
    setSelectedKeyframe({
      componentIndex: meta.componentIndex,
      componentId: meta.componentId,
      property: meta.property,
      keyframeId: meta.keyframeId,
    });
    if (selectedClip) setCurrentTime(selectedClip.startSec + meta.timeSec);
  }, [selectedClip, setCurrentTime]);

  const selectKeyframeGroup = useCallback((meta: { members: KeyframeSelection[]; timeSec: number }) => {
    const first = meta.members[0];
    if (!first) return;
    setSelectedKeyframe(first);
    if (selectedClip) setCurrentTime(selectedClip.startSec + meta.timeSec);
  }, [selectedClip, setCurrentTime]);

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
