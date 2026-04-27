import { useCallback, useMemo, useRef, useState } from 'react';
import type { Clip, Project } from '@/types';
import {
  moveTransformKeyframes,
  moveTransformKeyframeGroup,
  removeTransformKeyframes,
  removeTransformKeyframeGroup,
  updateTransformKeyframe,
} from '@/lib/components/transform';
import { clipTimelineDurationSec } from '@/lib/timeline/operations';
import {
  findSelectedKeyframe,
  getKeyframeProperties,
  keyframeSelectionKey,
  laneHeightForClip,
  type KeyframeSelection,
} from './keyframeModel';

type ProjectUpdater = (fn: (project: Project) => Project) => void;

type KeyframeDragBaseline = KeyframeSelection & { timeSec: number };

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
  const [selectedKeyframes, setSelectedKeyframesState] = useState<KeyframeSelection[]>([]);
  const keyframeDragRef = useRef<{ anchorKey: string; anchorTimeSec: number; baselines: KeyframeDragBaseline[] } | null>(null);
  const selectedKeyframe = selectedKeyframes[0] ?? null;
  const selectedKeyframeClip = selectedKeyframe
    ? clips.find((clip) => clip.id === selectedKeyframe.clipId) ?? null
    : null;

  const setSelectedKeyframe = useCallback((selection: KeyframeSelection | null) => {
    setSelectedKeyframesState(selection ? [selection] : []);
  }, []);

  const selectKeyframes = useCallback((selections: KeyframeSelection[]) => {
    setSelectedKeyframesState(dedupeKeyframeSelections(selections));
  }, []);

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
    const selections = dedupeKeyframeSelections(selectedKeyframes);
    const onlySelection = selections[0] ?? null;
    if (!onlySelection) return;
    if (selections.length === 1) {
      patchClip(onlySelection.clipId, (clip) => removeTransformKeyframeGroup(clip, onlySelection));
    } else {
      update((project) => ({
        ...project,
        clips: project.clips.map((clip) => {
          const clipSelections = selections.filter((selection) => selection.clipId === clip.id);
          return clipSelections.length > 0 ? removeTransformKeyframes(clip, clipSelections) : clip;
        }),
      }));
    }
    setSelectedKeyframesState([]);
    keyframeDragRef.current = null;
  }, [patchClip, selectedKeyframes, update]);

  const setSelectedKeyframeValue = useCallback((value: number) => {
    if (!selectedKeyframe) return;
    patchClip(selectedKeyframe.clipId, (clip) => updateTransformKeyframe(clip, selectedKeyframe, { value }));
  }, [patchClip, selectedKeyframe]);

  const nudgeSelectedKeyframe = useCallback((property: 'time' | 'value', direction: -1 | 1) => {
    if (selectedKeyframes.length > 1 && property === 'time') {
      const frameStep = direction / Math.max(1, fps);
      const baselines = resolveSelectedKeyframePoints(clips, selectedKeyframes);
      if (baselines.length === 0) return;
      update((project) => moveKeyframeBaselines(project, baselines, frameStep, fps));
      const first = baselines[0]!;
      const clip = clips.find((candidate) => candidate.id === first.clipId);
      if (clip) setCurrentTime(clip.startSec + quantizeKeyframeTime(first.timeSec + frameStep, fps, clipTimelineDurationSec(clip)));
      return;
    }
    if (!selectedKeyframeData || !selectedKeyframeClip) return;
    const frameStep = 1 / Math.max(1, fps);
    const valueStep = selectedKeyframeData.property === 'scale' ? 0.01 : 1;
    const durationSec = clipTimelineDurationSec(selectedKeyframeClip);
    const patch = property === 'time'
      ? { timeSec: quantizeKeyframeTime(selectedKeyframeData.timeSec + direction * frameStep, fps, durationSec) }
      : { value: selectedKeyframeData.value + direction * valueStep };
    patchClip(selectedKeyframeClip.id, (clip) => updateTransformKeyframe(clip, selectedKeyframeData, patch, {
      mergeEpsSec: keyframeFrameMergeEpsSec(fps),
    }));
    if (property === 'time') {
      const nextTime = patch.timeSec ?? selectedKeyframeData.timeSec;
      setCurrentTime(selectedKeyframeClip.startSec + nextTime);
    }
  }, [clips, fps, patchClip, selectedKeyframeClip, selectedKeyframeData, selectedKeyframes, setCurrentTime, update]);

  const beginKeyframeDrag = useCallback((anchor?: KeyframeSelection & { timeSec: number }) => {
    beginTx();
    keyframeDragRef.current = null;
    if (!anchor || selectedKeyframes.length <= 1) return;
    const anchorKey = keyframeSelectionKey(anchor);
    if (!selectedKeyframes.some((selection) => keyframeSelectionKey(selection) === anchorKey)) return;
    const baselines = resolveSelectedKeyframePoints(clips, selectedKeyframes);
    if (baselines.length <= 1) return;
    keyframeDragRef.current = {
      anchorKey,
      anchorTimeSec: anchor.timeSec,
      baselines,
    };
  }, [beginTx, clips, selectedKeyframes]);

  const moveKeyframe = useCallback((meta: KeyframeSelection & { timeSec: number; value: number }) => {
    const clip = clips.find((candidate) => candidate.id === meta.clipId);
    if (!clip) return;
    const durationSec = clipTimelineDurationSec(clip);
    const nextTimeSec = quantizeKeyframeTime(meta.timeSec, fps, durationSec);
    const dragState = keyframeDragRef.current;
    if (dragState?.anchorKey === keyframeSelectionKey(meta)) {
      updateSilent((project) => moveKeyframeBaselines(project, dragState.baselines, nextTimeSec - dragState.anchorTimeSec, fps));
      setCurrentTime(clip.startSec + nextTimeSec);
      return;
    }
    patchClip(
      meta.clipId,
      (clip) => updateTransformKeyframe(clip, meta, { timeSec: nextTimeSec, value: meta.value }, {
        mergeEpsSec: keyframeFrameMergeEpsSec(fps),
      }),
      true,
    );
    setSelectedKeyframe({
      componentIndex: meta.componentIndex,
      componentId: meta.componentId,
      clipId: meta.clipId,
      property: meta.property,
      keyframeId: meta.keyframeId,
    });
    setCurrentTime(clip.startSec + nextTimeSec);
  }, [clips, fps, patchClip, setCurrentTime, setSelectedKeyframe, updateSilent]);

  const moveKeyframeGroup = useCallback((meta: { members: KeyframeSelection[]; timeSec: number }) => {
    const first = meta.members[0];
    if (!first) return;
    const clip = clips.find((candidate) => candidate.id === first.clipId);
    if (!clip) return;
    const durationSec = clipTimelineDurationSec(clip);
    const nextTimeSec = quantizeKeyframeTime(meta.timeSec, fps, durationSec);
    patchClip(
      first.clipId,
      (clip) => moveTransformKeyframeGroup(clip, meta.members, nextTimeSec, {
        mergeEpsSec: keyframeFrameMergeEpsSec(fps),
      }),
      true,
    );
    setSelectedKeyframesState(dedupeKeyframeSelections(meta.members));
    setCurrentTime(clip.startSec + nextTimeSec);
  }, [clips, fps, patchClip, setCurrentTime]);

  const selectKeyframe = useCallback((meta: KeyframeSelection & { timeSec: number }) => {
    setSelectedKeyframesState([{
      componentIndex: meta.componentIndex,
      componentId: meta.componentId,
      clipId: meta.clipId,
      property: meta.property,
      keyframeId: meta.keyframeId,
    }]);
    const clip = clips.find((candidate) => candidate.id === meta.clipId);
    if (clip) setCurrentTime(clip.startSec + quantizeKeyframeTime(meta.timeSec, fps, clipTimelineDurationSec(clip)));
  }, [clips, fps, setCurrentTime]);

  const selectKeyframeGroup = useCallback((meta: { members: KeyframeSelection[]; timeSec: number }) => {
    const first = meta.members[0];
    if (!first) return;
    setSelectedKeyframesState(dedupeKeyframeSelections(meta.members));
    const clip = clips.find((candidate) => candidate.id === first.clipId);
    if (clip) setCurrentTime(clip.startSec + quantizeKeyframeTime(meta.timeSec, fps, clipTimelineDurationSec(clip)));
  }, [clips, fps, setCurrentTime]);

  return {
    currentTimeSec,
    deleteSelectedKeyframe,
    keyframeLaneHeight,
    selectedKeyframe,
    selectedKeyframes,
    selectedKeyframeData,
    setSelectedKeyframe,
    selectKeyframes,
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

function quantizeKeyframeTime(timeSec: number, fps: number, durationSec: number): number {
  const safeFps = Math.max(1, fps);
  const frame = Math.round(Math.max(0, timeSec) * safeFps);
  return Math.max(0, Math.min(durationSec, frame / safeFps));
}

function keyframeFrameMergeEpsSec(fps: number): number {
  return 0.5 / Math.max(1, fps) + 1e-6;
}

function dedupeKeyframeSelections(selections: KeyframeSelection[]): KeyframeSelection[] {
  const seen = new Set<string>();
  const deduped: KeyframeSelection[] = [];
  for (const selection of selections) {
    const key = keyframeSelectionKey(selection);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(selection);
  }
  return deduped;
}

function resolveSelectedKeyframePoints(clips: Clip[], selections: KeyframeSelection[]): KeyframeDragBaseline[] {
  const resolved: KeyframeDragBaseline[] = [];
  for (const selection of dedupeKeyframeSelections(selections)) {
    const clip = clips.find((candidate) => candidate.id === selection.clipId);
    if (!clip) continue;
    const row = getKeyframeProperties(clip).find((candidate) => (
      candidate.componentId === selection.componentId &&
      candidate.property === selection.property
    ));
    const point = row?.points.find((candidate) => candidate.id === selection.keyframeId);
    if (point) resolved.push({ ...selection, timeSec: point.timeSec });
  }
  return resolved;
}

function moveKeyframeBaselines(project: Project, baselines: KeyframeDragBaseline[], deltaSec: number, fps: number): Project {
  return {
    ...project,
    clips: project.clips.map((clip) => {
      const clipBaselines = baselines.filter((baseline) => baseline.clipId === clip.id);
      if (clipBaselines.length === 0) return clip;
      const durationSec = clipTimelineDurationSec(clip);
      const targets = clipBaselines.map((baseline) => ({
        ...baseline,
        timeSec: quantizeKeyframeTime(baseline.timeSec + deltaSec, fps, durationSec),
      }));
      return moveTransformKeyframes(clip, targets, { mergeEpsSec: keyframeFrameMergeEpsSec(fps) });
    }),
  };
}
