import { useState } from 'react';
import { Film, Image as ImageIcon, Music, RotateCcw, Volume2 } from 'lucide-react';
import { useProjectStore } from '@/state/projectStore';
import { usePlaybackStore } from '@/state/playbackStore';
import { useMediaStore } from '@/state/mediaStore';
import { setClipProp } from '@/lib/timeline/operations';
import { resetEnvelope, setEnvelopeEnabled } from '@/lib/timeline/envelope';
import { formatTimecode } from '@/lib/timeline/geometry';

const kindIcon = { video: Film, audio: Music, image: ImageIcon };

export function ClipInspector() {
  const selection = usePlaybackStore((s) => s.selection);
  const selectedId = selection.kind === 'clip' ? selection.id : null;
  const project = useProjectStore((s) => s.project);
  const update = useProjectStore((s) => s.update);
  const assets = useMediaStore((s) => s.assets);

  if (!selectedId) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-slate-500">
        Select a clip on the timeline to inspect it.
      </div>
    );
  }

  const clip = project.clips.find((c) => c.id === selectedId);
  if (!clip) return null;

  const asset = assets.find((a) => a.id === clip.assetId);
  const fps = project.fps;
  const clipDuration = clip.outSec - clip.inSec;
  const Icon = asset ? kindIcon[asset.kind] : Film;

  const setVolume = (v: number) => update((p) => setClipProp(p, selectedId, 'volume', v));
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
        <Row label="Duration">{formatTimecode(clipDuration, fps)}</Row>
        <Row label="In">{formatTimecode(clip.inSec, fps)}</Row>
        <Row label="Out">{formatTimecode(clip.outSec, fps)}</Row>
      </Section>

      <Divider />

      {/* Volume */}
      <Section label="Audio">
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
    <div className="mt-3 space-y-2 rounded border border-surface-700 bg-surface-900/60 p-2.5">
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

