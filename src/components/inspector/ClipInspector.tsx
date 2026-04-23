import { Film, Image as ImageIcon, Music, Volume2 } from 'lucide-react';
import { useProjectStore } from '@/state/projectStore';
import { usePlaybackStore } from '@/state/playbackStore';
import { useMediaStore } from '@/state/mediaStore';
import { setClipProp } from '@/lib/timeline/operations';
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
              Volume
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

// Intentionally a named export so React DevTools show the component name.
export function VolumeSliderStyles() {
  return null;
}

