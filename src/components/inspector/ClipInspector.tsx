import { useState } from 'react';
import { BookOpen, Film, Image as ImageIcon, Loader2, Music, RotateCcw, Volume2 } from 'lucide-react';
import { nanoid } from 'nanoid';
import { useProjectStore } from '@/state/projectStore';
import { usePlaybackStore } from '@/state/playbackStore';
import { useMediaStore } from '@/state/mediaStore';
import { clipSpeed, clipTimelineDurationSec, setClipProp } from '@/lib/timeline/operations';
import { resetEnvelope, setEnvelopeEnabled } from '@/lib/timeline/envelope';
import { formatTimecode } from '@/lib/timeline/geometry';

const kindIcon = { video: Film, audio: Music, image: ImageIcon, recipe: BookOpen };

export function ClipInspector() {
  const [applyingSpeed, setApplyingSpeed] = useState(false);
  const selectedClipIds = usePlaybackStore((s) => s.selectedClipIds);
  const currentTime = usePlaybackStore((s) => s.currentTimeSec);
  const selectedId = selectedClipIds.length === 1 ? selectedClipIds[0]! : null;
  const project = useProjectStore((s) => s.project);
  const update = useProjectStore((s) => s.update);
  const assets = useMediaStore((s) => s.assets);

  if (selectedClipIds.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-slate-500">
        Select a clip on the timeline to inspect it.
      </div>
    );
  }
  if (selectedClipIds.length > 1 || !selectedId) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-slate-400">
        <div className="font-semibold text-slate-200">{selectedClipIds.length} clips selected</div>
        <div className="text-[11px] text-slate-500">
          Select a single clip to edit its properties.
        </div>
      </div>
    );
  }

  const clip = project.clips.find((c) => c.id === selectedId);
  if (!clip) return null;

  const asset = assets.find((a) => a.id === clip.assetId);
  const fps = project.fps;
  const timelineDuration = clipTimelineDurationSec(clip);
  const speed = clipSpeed(clip);
  const Icon = asset ? kindIcon[asset.kind] : Film;

  const setVolume = (v: number) => update((p) => setClipProp(p, selectedId, 'volume', v));
  const setScale = (v: number) => update((p) => setClipProp(p, selectedId, 'scale', v));
  const setTransform = (next: NonNullable<typeof clip.transform>) =>
    update((p) => setClipProp(p, selectedId, 'transform', next));
  const setSpeedAsync = async (nextSpeed: number) => {
    setApplyingSpeed(true);
    // Keep speed updates async so any future time-stretch preprocessing
    // can happen off the immediate input event path.
    await new Promise<void>((resolve) => setTimeout(resolve, 120));
    update((p) => setClipProp(p, selectedId, 'speed', nextSpeed));
    setApplyingSpeed(false);
  };
  const envelopeEnabled = clip.volumeEnvelope?.enabled ?? false;
  const hasCustomEnvelope =
    !!clip.volumeEnvelope &&
    (clip.volumeEnvelope.points.length !== 2 ||
      clip.volumeEnvelope.points.some((p) => p.v !== 1 || p.curvature !== 0));

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* Asset info */}
      <div className="flex items-start gap-3">
        {asset?.thumbnailDataUrl ? (
          <img
            src={asset.thumbnailDataUrl}
            alt=""
            className="h-14 w-20 shrink-0 rounded object-cover"
          />
        ) : (
          <div className="flex h-14 w-20 shrink-0 items-center justify-center rounded bg-surface-700 text-slate-400">
            <Icon size={20} />
          </div>
        )}
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-slate-200">
            {asset?.name ?? 'Missing asset'}
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-[11px] text-slate-400">
            <Icon size={11} />
            <span>{asset?.kind ?? '—'}</span>
            {asset?.width && <span>{asset.width}×{asset.height}</span>}
          </div>
        </div>
      </div>

      <Divider />

      {/* Clip timing */}
      <Section label="Timing">
        <Row label="Start">{formatTimecode(clip.startSec, fps)}</Row>
        <Row label="Duration">{formatTimecode(timelineDuration, fps)}</Row>
        <Row label="In">{formatTimecode(clip.inSec, fps)}</Row>
        <Row label="Out">{formatTimecode(clip.outSec, fps)}</Row>
        <div className="mt-2 space-y-2 rounded border border-surface-700 bg-surface-900/50 p-2.5">
          <div className="flex items-center justify-between">
            <label className="text-xs text-slate-400">Speed</label>
            <div className="flex items-center gap-2">
              {applyingSpeed && <Loader2 size={12} className="animate-spin text-brand-400" />}
              <span className="font-mono text-xs text-slate-200">{speed.toFixed(2)}x</span>
            </div>
          </div>
          <input
            type="range"
            min={0.25}
            max={3}
            step={0.05}
            value={speed}
            disabled={applyingSpeed}
            onChange={(e) => {
              const next = Number(e.target.value);
              void setSpeedAsync(next);
            }}
            className="volume-slider w-full"
          />
          <div className="flex justify-between text-[10px] text-slate-500">
            <span>0.25x</span>
            <span>1.0x</span>
            <span>3.0x</span>
          </div>
          <p className="text-[10px] text-slate-500">
            Pitch is preserved during preview/export; slower rates are smoothed asynchronously.
          </p>
        </div>
      </Section>

      <Divider />

      {/* Volume */}
      <Section label="Audio">
        <div className="space-y-3 rounded border border-surface-700 bg-surface-900/50 p-2.5">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="flex items-center gap-1.5 text-xs text-slate-400">
                <Volume2 size={12} />
                Master Volume
              </label>
              <span className="font-mono text-xs text-slate-300">
                {Math.round((clip.volume ?? 1) * 100)}%
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={200}
              step={1}
              value={Math.round((clip.volume ?? 1) * 100)}
              onChange={(e) => setVolume(Number(e.target.value) / 100)}
              className="volume-slider w-full"
            />
            <div className="flex justify-between text-[10px] text-slate-500">
              <span>0%</span>
              <span>100%</span>
              <span>200%</span>
            </div>
          </div>
          <EnvelopeControls
            clipId={selectedId}
            enabled={envelopeEnabled}
            hasCustomEnvelope={hasCustomEnvelope}
          />
        </div>
      </Section>

      {/* Source asset info */}
      {asset && (
        <>
          <Divider />
          <Section label="Source">
            <Row label="Duration">{formatTimecode(asset.durationSec, fps)}</Row>
            {asset.mimeType && <Row label="Format">{asset.mimeType.split('/')[1]?.toUpperCase()}</Row>}
          </Section>
        </>
      )}

      <Divider />

      <Section label="Components">
        {!clip.transform ? (
          <div className="space-y-2 rounded border border-dashed border-surface-600 bg-surface-900/30 p-2.5">
            <p className="text-[11px] text-slate-500">
              No components on this clip yet.
            </p>
            <button
              type="button"
              className="rounded bg-surface-700 px-2 py-1 text-[11px] text-slate-200 hover:bg-surface-600 disabled:opacity-40"
              disabled={asset?.kind !== 'video'}
              onClick={() => update((p) => setClipProp(
                setClipProp(
                  p,
                  selectedId,
                  'transform',
                  { scale: clip.scale ?? 1, offsetX: 0, offsetY: 0, keyframes: [] },
                ),
                selectedId,
                'components',
                [...(clip.components ?? []), { id: nanoid(8), type: 'transform' }],
              ))}
            >
              Add Component
            </button>
          </div>
        ) : (
          <div className="space-y-3 rounded border border-surface-700 bg-surface-900/50 p-2.5">
            <div className="flex items-center justify-between">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-300">Transform</div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  className="rounded bg-surface-700 px-1.5 py-0.5 text-[10px] text-slate-200 hover:bg-surface-600"
                  title="Add keyframe"
                  onClick={() => {
                    const kf = {
                      id: nanoid(8),
                      timeSec: currentTime,
                      scale: clip.transform!.scale,
                      offsetX: clip.transform!.offsetX,
                      offsetY: clip.transform!.offsetY,
                    };
                    setTransform({ ...clip.transform!, keyframes: [...clip.transform!.keyframes, kf] });
                  }}
                >
                  + Keyframe
                </button>
                <button
                  type="button"
                  className="rounded bg-surface-700 px-1.5 py-0.5 text-[10px] text-red-300 hover:bg-surface-600"
                  onClick={() => update((p) =>
                    setClipProp(
                      setClipProp(p, selectedId, 'transform', undefined),
                      selectedId,
                      'components',
                      (clip.components ?? []).filter((c) => c.type !== 'transform'),
                    ))}
                >
                  Remove
                </button>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <label className="space-y-1">
                <span className="text-slate-400">Offset X</span>
                <input
                  type="number"
                  value={Math.round(clip.transform.offsetX)}
                  onChange={(e) => setTransform({ ...clip.transform!, offsetX: Number(e.target.value) || 0 })}
                  className="w-full rounded border border-surface-600 bg-surface-800 px-2 py-1 text-slate-200"
                />
              </label>
              <label className="space-y-1">
                <span className="text-slate-400">Offset Y</span>
                <input
                  type="number"
                  value={Math.round(clip.transform.offsetY)}
                  onChange={(e) => setTransform({ ...clip.transform!, offsetY: Number(e.target.value) || 0 })}
                  className="w-full rounded border border-surface-600 bg-surface-800 px-2 py-1 text-slate-200"
                />
              </label>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-400">Scale</span>
              <span className="font-mono text-slate-200">{Math.round(clip.transform.scale * 100)}%</span>
            </div>
            <input
              type="range"
              min={25}
              max={200}
              step={1}
              value={Math.round(clip.transform.scale * 100)}
              onChange={(e) => {
                const next = Number(e.target.value) / 100;
                setScale(next);
                setTransform({ ...clip.transform!, scale: next });
              }}
              className="volume-slider w-full"
            />
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="rounded bg-surface-700 px-2 py-1 text-[11px] text-slate-200 hover:bg-surface-600"
                onClick={() => {
                  setScale(1);
                  setTransform({ ...clip.transform!, scale: 1 });
                }}
              >
                Reset Scale
              </button>
              <button
                type="button"
                className="rounded bg-surface-700 px-2 py-1 text-[11px] text-slate-200 hover:bg-surface-600"
                onClick={() => setTransform({ ...clip.transform!, offsetX: 0, offsetY: 0 })}
              >
                Reset Position
              </button>
            </div>
            <div className="rounded border border-surface-700 bg-surface-900/70 p-2">
              <div className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">Keyframe Track</div>
              {clip.transform.keyframes.length === 0 ? (
                <div className="text-[10px] text-slate-500">No keyframes yet.</div>
              ) : (
                <div className="flex flex-wrap gap-1">
                  {clip.transform.keyframes.map((kf) => (
                    <span key={kf.id} className="rounded bg-brand-500/20 px-1.5 py-0.5 text-[10px] text-brand-200">
                      {formatTimecode(kf.timeSec, fps)}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </Section>
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">{label}</div>
      {children}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="text-slate-400">{label}</span>
      <span className="font-mono text-slate-200">{children}</span>
    </div>
  );
}

function Divider() {
  return <div className="h-px bg-surface-700" />;
}

function EnvelopeControls({
  clipId,
  enabled,
  hasCustomEnvelope,
}: {
  clipId: string;
  enabled: boolean;
  hasCustomEnvelope: boolean;
}) {
  const update = useProjectStore((s) => s.update);
  const [confirmingReset, setConfirmingReset] = useState(false);

  const toggle = () => update((p) => setEnvelopeEnabled(p, clipId, !enabled));
  const doReset = () => {
    update((p) => resetEnvelope(p, clipId));
    setConfirmingReset(false);
  };

  return (
    <div className="space-y-2">
      <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-300">
        <input
          type="checkbox"
          className="h-3.5 w-3.5 accent-brand-500"
          checked={enabled}
          onChange={toggle}
        />
        Enable Editable Curve
      </label>

      {enabled && (
        <>
          <p className="text-[10px] leading-tight text-slate-500">
            Click the curve to add a point, drag points to move them,
            drag segment midpoints to bend, and right-click for options.
          </p>
          {confirmingReset ? (
            <div className="flex items-center justify-between gap-2 rounded bg-surface-800 p-2">
              <span className="text-[11px] text-slate-300">Reset this curve?</span>
              <div className="flex gap-1.5">
                <button
                  type="button"
                  className="rounded bg-surface-700 px-2 py-0.5 text-[11px] text-slate-300 hover:bg-surface-600"
                  onClick={() => setConfirmingReset(false)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="rounded bg-brand-500 px-2 py-0.5 text-[11px] text-white hover:bg-brand-400"
                  onClick={doReset}
                >
                  Reset
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="flex items-center gap-1.5 text-[11px] text-slate-400 hover:text-slate-200 disabled:opacity-40"
              disabled={!hasCustomEnvelope}
              onClick={() => setConfirmingReset(true)}
            >
              <RotateCcw size={11} />
              Reset curve
            </button>
          )}
        </>
      )}
    </div>
  );
}

// Intentionally a named export so React DevTools show the component name.
export function VolumeSliderStyles() {
  return null;
}
