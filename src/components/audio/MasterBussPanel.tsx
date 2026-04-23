import { useEffect, useRef, useState } from 'react';
import { getAnalysers } from '@/lib/audio/context';
import { usePlaybackStore } from '@/state/playbackStore';

const DB_FLOOR = -60;
const PEAK_HOLD_MS = 1500;
const PEAK_DECAY_PER_FRAME = 0.008; // normalized units per RAF frame (~0.5 dB/s)

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

// Coloured fill: green → yellow → red as level climbs.
function meterGradient(norm: number): string {
  if (norm < 0.75) return 'bg-emerald-500';
  if (norm < 0.9) return 'bg-yellow-400';
  return 'bg-red-500';
}

type ChannelState = { level: number; peak: number; clipping: boolean };

function VuBar({ level, peak, clipping }: ChannelState) {
  const levelPct = level * 100;
  const peakPct = peak * 100;

  return (
    <div className="relative flex h-full w-5 flex-col justify-end overflow-hidden rounded-sm bg-surface-800">
      {/* Clip indicator at the very top */}
      <div
        className={`absolute top-0 left-0 right-0 h-1 rounded-t-sm transition-colors ${
          clipping ? 'bg-red-500' : 'bg-transparent'
        }`}
      />
      {/* Level bar (fills from bottom) */}
      <div
        className={`absolute bottom-0 left-0 right-0 rounded-b-sm transition-none ${meterGradient(level)}`}
        style={{ height: `${levelPct}%` }}
      />
      {/* Peak hold tick */}
      {peak > 0.02 && (
        <div
          className="absolute left-0 right-0 h-px bg-white/70"
          style={{ bottom: `${peakPct}%` }}
        />
      )}
    </div>
  );
}

const DB_MARKS = [0, -6, -12, -18, -30, -48];

function DbScale() {
  return (
    <div className="relative flex h-full flex-col justify-between py-px">
      {DB_MARKS.map((db) => {
        const norm = dbToNorm(db);
        return (
          <div
            key={db}
            className="absolute right-0 flex items-center"
            style={{ bottom: `${norm * 100}%`, transform: 'translateY(50%)' }}
          >
            <span className="text-[8px] leading-none text-slate-500">{db === 0 ? '0' : db}</span>
          </div>
        );
      })}
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

      const updatedChannels: [ChannelState, ChannelState] = [
        { level: 0, peak: 0, clipping: false },
        { level: 0, peak: 0, clipping: false },
      ];

      for (let ch = 0; ch < 2; ch++) {
        const norm = norms[ch]!;
        const buf = bufs[ch]!;

        // Peak hold with slow decay.
        if (norm >= peakRef.current[ch]!) {
          peakRef.current[ch] = norm;
          peakTsRef.current[ch] = ts;
        } else if (ts - peakTsRef.current[ch]! > PEAK_HOLD_MS) {
          peakRef.current[ch] = Math.max(0, peakRef.current[ch]! - PEAK_DECAY_PER_FRAME);
        }

        // Clipping: any sample reaching ±1.0 (0 dBFS).
        let isClipping = false;
        for (let i = 0; i < buf.length; i++) {
          if (Math.abs(buf[i]!) >= 0.999) { isClipping = true; break; }
        }
        if (isClipping) clipTsRef.current[ch] = ts;
        const showClip = ts - clipTsRef.current[ch]! < 2000;

        updatedChannels[ch] = {
          level: norm,
          peak: peakRef.current[ch]!,
          clipping: showClip,
        };
      }

      setChannels(updatedChannels);
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="flex h-full flex-col items-center gap-2 px-2 py-3">
      <div className="text-[9px] font-semibold uppercase tracking-widest text-slate-500">
        Master
      </div>

      {/* Meter area: L bar, dB scale, R bar */}
      <div className="flex min-h-0 flex-1 w-full items-end gap-1">
        <div className="flex flex-1 flex-col items-center gap-0.5">
          <div className="flex flex-1 w-full flex-col gap-0.5" style={{ minHeight: 0 }}>
            <div className="flex min-h-0 flex-1 items-end gap-1">
              <div className="flex h-full flex-1">
                <VuBar {...channels[0]} />
              </div>
              <div className="relative flex-none" style={{ width: 16, height: '100%' }}>
                <DbScale />
              </div>
              <div className="flex h-full flex-1">
                <VuBar {...channels[1]} />
              </div>
            </div>
            <div className="flex justify-between px-px text-[8px] text-slate-600">
              <span>L</span>
              <span>R</span>
            </div>
          </div>
        </div>
      </div>

      {/* Vertical master volume slider (rotated horizontal range input) */}
      <div className="flex flex-col items-center gap-1">
        <div className="relative flex h-28 w-6 items-center justify-center overflow-visible">
          <input
            type="range"
            min={0}
            max={200}
            step={1}
            value={Math.round(masterVolume * 100)}
            onChange={(e) => setMasterVolume(Number(e.target.value) / 100)}
            className="volume-slider"
            style={{ width: 96, transform: 'rotate(-90deg)', transformOrigin: 'center center' }}
            title={`Master volume: ${Math.round(masterVolume * 100)}%`}
          />
        </div>
        <div className="font-mono text-[10px] text-slate-400">{Math.round(masterVolume * 100)}%</div>
        <div className="text-[8px] text-slate-600">VOL</div>
      </div>

      {/* Clip indicator legend */}
      <div className="flex flex-col items-center gap-0.5">
        {(channels[0].clipping || channels[1].clipping) && (
          <div className="rounded bg-red-600 px-1 py-px text-[8px] font-bold text-white">CLIP</div>
        )}
      </div>
    </div>
  );
}
