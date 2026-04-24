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

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function VuBar({ level, peak, clipping }: ChannelState) {
  const pct = Math.min(100, level * 100);
  const peakPct = Math.min(100, peak * 100);

  let barColor = 'bg-emerald-500';
  if (level > 0.9) barColor = 'bg-red-500';
  else if (level > 0.75) barColor = 'bg-yellow-400';

  return (
    <div className="relative h-full w-3 overflow-hidden rounded-sm bg-surface-800 ring-1 ring-surface-700">
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

function DbScale() {
  return (
    <div className="relative h-full w-5">
      {DB_MARKS.map((db) => (
        <div
          key={db}
          className="absolute left-0 right-0 flex items-center justify-start"
          style={{ bottom: `${dbToNorm(db) * 100}%`, transform: 'translateY(50%)' }}
        >
          <span className="select-none font-mono text-[7px] leading-none text-slate-500">{db}</span>
        </div>
      ))}
    </div>
  );
}

type MasterFaderProps = {
  value: number;
  onChange: (value: number) => void;
};

function MasterFader({ value, onChange }: MasterFaderProps) {
  const railRef = useRef<HTMLDivElement | null>(null);
  const pct = clamp(Math.round(value * 100), 0, 200);
  const norm = pct / 200;

  const commitFromPointer = (clientY: number) => {
    const rail = railRef.current;
    if (!rail) return;
    const rect = rail.getBoundingClientRect();
    const nextNorm = clamp((rect.bottom - clientY) / rect.height, 0, 1);
    onChange(Math.round(nextNorm * 200) / 100);
  };

  const commitPercent = (nextPct: number) => {
    onChange(clamp(nextPct, 0, 200) / 100);
  };

  return (
    <div
      className="relative h-full w-5 touch-none select-none rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
      role="slider"
      aria-label="Master volume"
      aria-valuemin={0}
      aria-valuemax={200}
      aria-valuenow={pct}
      aria-valuetext={`${pct}%`}
      tabIndex={0}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        commitFromPointer(event.clientY);
      }}
      onPointerMove={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        commitFromPointer(event.clientY);
      }}
      onPointerUp={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      }}
      onDoubleClick={() => commitPercent(100)}
      onKeyDown={(event) => {
        let nextPct = pct;
        if (event.key === 'ArrowUp' || event.key === 'ArrowRight') nextPct += 1;
        else if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') nextPct -= 1;
        else if (event.key === 'PageUp') nextPct += 10;
        else if (event.key === 'PageDown') nextPct -= 10;
        else if (event.key === 'Home') nextPct = 0;
        else if (event.key === 'End') nextPct = 200;
        else return;

        event.preventDefault();
        commitPercent(nextPct);
      }}
      title={`Master volume: ${pct}%`}
    >
      <div ref={railRef} className="absolute inset-y-0 left-1/2 w-1 -translate-x-1/2 rounded-full bg-surface-700">
        <div
          className="absolute inset-x-0 bottom-0 rounded-full bg-brand-500/65"
          style={{ height: `${norm * 100}%` }}
        />
      </div>
      <div
        className="absolute left-1/2 h-3 w-3 -translate-x-1/2 translate-y-1/2 rounded-full border border-brand-200 bg-brand-500 shadow-sm shadow-brand-950/50"
        style={{ bottom: `${norm * 100}%` }}
      />
      <div
        className="absolute left-1/2 h-px w-3 -translate-x-1/2 bg-white/30"
        style={{ bottom: '50%' }}
      />
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
  const clipTsRef = useRef<[number, number]>([-Infinity, -Infinity]);
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
    <div className="flex h-full flex-col px-2 pb-2 pt-2">
      <div className="shrink-0 pb-1 text-center text-[9px] font-semibold uppercase tracking-widest text-slate-500">
        Master
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[20px_14px_14px_22px] gap-1.5">
        <div className="flex min-h-0 flex-col items-center">
          <div className="relative min-h-0 flex-1">
            <MasterFader value={masterVolume} onChange={setMasterVolume} />
          </div>
          <div className="h-6 shrink-0 pt-1 text-center">
            <div className="font-mono text-[8px] leading-none text-slate-300">{Math.round(masterVolume * 100)}%</div>
            <div className="pt-0.5 text-[6px] uppercase leading-none tracking-wide text-slate-600">Vol</div>
          </div>
        </div>

        <div className="flex min-h-0 flex-col items-center">
          <div className="min-h-0 flex-1">
            <VuBar {...channels[0]} />
          </div>
          <div className="h-6 shrink-0 pt-1 text-center text-[8px] leading-none text-slate-500">L</div>
        </div>

        <div className="flex min-h-0 flex-col items-center">
          <div className="min-h-0 flex-1">
            <VuBar {...channels[1]} />
          </div>
          <div className="h-6 shrink-0 pt-1 text-center text-[8px] leading-none text-slate-500">R</div>
        </div>

        <div className="flex min-h-0 flex-col">
          <div className="relative min-h-0 flex-1">
            <DbScale />
          </div>
          <div className="flex h-6 shrink-0 items-start justify-start pt-1">
            {isClipping && (
              <span className="rounded bg-red-600 px-1 py-px text-[7px] font-bold text-white">
                CLIP
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
