import { useEffect, useRef, useState } from 'react';
import { getAnalysers } from '@/lib/audio/context';
import { usePlaybackStore } from '@/state/playbackStore';

const DB_FLOOR = -60;
const PEAK_HOLD_MS = 1500;
const PEAK_DECAY_PER_FRAME = 0.006;

function rmsToDb(rms: number): number {
  if (rms <= 0) return DB_FLOOR;
  return Math.max(DB_FLOOR, 20 * Math.log10(rms));
}

function dbToNorm(db: number): number {
  return Math.max(0, (db - DB_FLOOR) / -DB_FLOOR);
}

function computeRms(buf: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i]! * buf[i]!;
  return Math.sqrt(sum / buf.length);
}

type ChannelState = { level: number; peak: number; clipping: boolean };

// VuBar renders as a flex-1 column — parent MUST be a flex column with min-h-0.
function VuBar({ level, peak, clipping }: ChannelState) {
  const pct = Math.min(100, level * 100);
  const peakPct = Math.min(100, peak * 100);

  let barColor = 'bg-emerald-500';
  if (level > 0.9) barColor = 'bg-red-500';
  else if (level > 0.75) barColor = 'bg-yellow-400';

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden rounded-sm bg-surface-800 ring-1 ring-surface-700">
      {/* 0 dBFS clipping flash */}
      <div className={`absolute inset-x-0 top-0 h-1 transition-colors ${clipping ? 'bg-red-500' : 'bg-transparent'}`} />
      {/* Level bar filling from bottom */}
      <div
        className={`absolute inset-x-0 bottom-0 ${barColor}`}
        style={{ height: `${pct}%` }}
      />
      {/* Peak hold tick */}
      {peak > 0.01 && (
        <div
          className="absolute inset-x-0 h-px bg-white/60"
          style={{ bottom: `${peakPct}%` }}
        />
      )}
    </div>
  );
}

const DB_MARKS = [0, -6, -12, -18, -30, -48];

// DbScale must be inside a positioned container that has explicit height.
function DbScale() {
  return (
    <div className="relative min-h-0 flex-1">
      {DB_MARKS.map((db) => (
        <div
          key={db}
          className="absolute left-0 right-0 flex items-center justify-center"
          style={{ bottom: `${dbToNorm(db) * 100}%`, transform: 'translateY(50%)' }}
        >
          <span className="select-none text-[7px] leading-none text-slate-500">{db}</span>
        </div>
      ))}
    </div>
  );
}

export function MasterBussPanel() {
  const masterVolume = usePlaybackStore((s) => s.masterVolume);
  const setMasterVolume = usePlaybackStore((s) => s.setMasterVolume);

  const [channels, setChannels] = useState<[ChannelState, ChannelState]>([
    { level: 0, peak: 0, clipping: false },
    { level: 0, peak: 0, clipping: false },
  ]);

  const peakRef = useRef<[number, number]>([0, 0]);
  const peakTsRef = useRef<[number, number]>([0, 0]);
  const clipTsRef = useRef<[number, number]>([0, 0]);
  const bufLRef = useRef<Float32Array | null>(null);
  const bufRRef = useRef<Float32Array | null>(null);

  useEffect(() => {
    let raf = 0;
    const tick = (ts: number) => {
      const { left, right } = getAnalysers();

      if (!bufLRef.current || bufLRef.current.length !== left.fftSize) {
        bufLRef.current = new Float32Array(left.fftSize);
      }
      if (!bufRRef.current || bufRRef.current.length !== right.fftSize) {
        bufRRef.current = new Float32Array(right.fftSize);
      }

      const bufl = bufLRef.current as Float32Array<ArrayBuffer>;
      const bufr = bufRRef.current as Float32Array<ArrayBuffer>;
      left.getFloatTimeDomainData(bufl);
      right.getFloatTimeDomainData(bufr);

      const norms: [number, number] = [
        dbToNorm(rmsToDb(computeRms(bufl))),
        dbToNorm(rmsToDb(computeRms(bufr))),
      ];
      const bufs: [Float32Array<ArrayBuffer>, Float32Array<ArrayBuffer>] = [bufl, bufr];

      const updated: [ChannelState, ChannelState] = [
        { level: 0, peak: 0, clipping: false },
        { level: 0, peak: 0, clipping: false },
      ];

      for (let ch = 0; ch < 2; ch++) {
        const norm = norms[ch]!;
        const buf = bufs[ch]!;

        if (norm >= peakRef.current[ch]!) {
          peakRef.current[ch] = norm;
          peakTsRef.current[ch] = ts;
        } else if (ts - peakTsRef.current[ch]! > PEAK_HOLD_MS) {
          peakRef.current[ch] = Math.max(0, peakRef.current[ch]! - PEAK_DECAY_PER_FRAME);
        }

        let isClipping = false;
        for (let i = 0; i < buf.length; i++) {
          if (Math.abs(buf[i]!) >= 0.999) { isClipping = true; break; }
        }
        if (isClipping) clipTsRef.current[ch] = ts;

        updated[ch] = {
          level: norm,
          peak: peakRef.current[ch]!,
          clipping: ts - clipTsRef.current[ch]! < 2000,
        };
      }

      setChannels(updated);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const isClipping = channels[0].clipping || channels[1].clipping;

  return (
    <div className="flex h-full flex-col items-stretch gap-0 px-2 pt-2 pb-3">
      {/* Header */}
      <div className="shrink-0 pb-1 text-center text-[9px] font-semibold uppercase tracking-widest text-slate-500">
        Master
      </div>

      {/* ---- Meters: fills all remaining vertical space ---- */}
      {/* Outer row: L-bar | dB-scale | R-bar */}
      <div className="flex min-h-0 flex-1 flex-row gap-1">
        {/* L channel: bar + label stacked vertically */}
        <div className="flex min-h-0 flex-1 flex-col gap-0.5">
          <VuBar {...channels[0]} />
          <span className="shrink-0 text-center text-[8px] text-slate-500">L</span>
        </div>
        {/* dB scale */}
        <div className="flex min-h-0 w-5 flex-col">
          <DbScale />
          <div className="h-4 shrink-0" /> {/* spacer matching the L/R label row */}
        </div>
        {/* R channel */}
        <div className="flex min-h-0 flex-1 flex-col gap-0.5">
          <VuBar {...channels[1]} />
          <span className="shrink-0 text-center text-[8px] text-slate-500">R</span>
        </div>
      </div>

      {/* ---- Clip badge ---- */}
      <div className="shrink-0 flex justify-center py-1" style={{ minHeight: 16 }}>
        {isClipping && (
          <span className="rounded bg-red-600 px-1.5 py-px text-[8px] font-bold text-white">
            CLIP
          </span>
        )}
      </div>

      {/* ---- Vertical volume slider ---- */}
      <div className="shrink-0 flex flex-col items-center gap-1">
        <div className="relative flex h-24 w-6 items-center justify-center overflow-visible">
          <input
            type="range"
            min={0}
            max={200}
            step={1}
            value={Math.round(masterVolume * 100)}
            onChange={(e) => setMasterVolume(Number(e.target.value) / 100)}
            className="volume-slider"
            style={{ width: 88, transform: 'rotate(-90deg)', transformOrigin: 'center' }}
            title={`Master volume: ${Math.round(masterVolume * 100)}%`}
          />
        </div>
        <div className="font-mono text-[10px] text-slate-300">{Math.round(masterVolume * 100)}%</div>
        <div className="text-[8px] uppercase tracking-wide text-slate-600">Vol</div>
      </div>
    </div>
  );
}
