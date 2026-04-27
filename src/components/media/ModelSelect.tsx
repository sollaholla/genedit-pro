import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Volume2, VolumeX } from 'lucide-react';
import { isKlingModel, isSeedanceModel, isVeoModel, type VideoModelDefinition } from '@/lib/videoModels/capabilities';

type Props = {
  value: string;
  options: VideoModelDefinition[];
  onChange: (value: string) => void;
  loading?: boolean;
  disabled?: boolean;
  emptyLabel?: string;
  showInlineLabel?: boolean;
  className?: string;
};

export function ModelSelect({
  value,
  options,
  onChange,
  loading = false,
  disabled = false,
  emptyLabel = 'No options',
  showInlineLabel = true,
  className,
}: Props) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const [popupPosition, setPopupPosition] = useState<{ left: number; top: number; width: number; placeAbove: boolean } | null>(null);
  const selected = options.find((option) => option.id === value) ?? null;
  const isDisabled = disabled || loading || options.length === 0;

  useEffect(() => {
    if (!open) return;
    const onDocPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (popupRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', onDocPointerDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDocPointerDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) {
      setPopupPosition(null);
      return;
    }
    const updatePosition = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const margin = 8;
      const desiredWidth = Math.min(320, window.innerWidth - margin * 2);
      const estimatedHeight = popupRef.current?.offsetHeight ?? 360;
      const spaceBelow = window.innerHeight - rect.bottom - margin;
      const spaceAbove = rect.top - margin;
      const placeAbove = spaceBelow < estimatedHeight && spaceAbove > spaceBelow;
      const left = Math.min(Math.max(margin, rect.left), window.innerWidth - desiredWidth - margin);
      const top = placeAbove
        ? Math.max(margin, rect.top - estimatedHeight - 4)
        : Math.min(rect.bottom + 4, window.innerHeight - estimatedHeight - margin);
      setPopupPosition({ left, top, width: desiredWidth, placeAbove });
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open]);

  const popupMaxHeight = (() => {
    const trigger = triggerRef.current;
    if (!trigger || !popupPosition) return 360;
    const rect = trigger.getBoundingClientRect();
    const margin = 8;
    const room = popupPosition.placeAbove ? rect.top - margin - 4 : window.innerHeight - rect.bottom - margin - 4;
    return Math.max(180, Math.min(room, 480));
  })();

  return (
    <div className={`relative inline-flex max-w-full ${className ?? ''}`}>
      <button
        ref={triggerRef}
        type="button"
        disabled={isDisabled}
        onClick={() => setOpen((current) => !current)}
        className="flex h-8 w-full max-w-full items-center gap-2 rounded-md border border-surface-700 bg-surface-950 px-2 text-xs text-slate-200 transition hover:border-surface-500 disabled:cursor-not-allowed disabled:opacity-50"
        aria-haspopup="listbox"
        aria-expanded={open ? 'true' : 'false'}
        aria-label={selected ? `Model: ${selected.label}` : 'Select model'}
      >
        {showInlineLabel && (
          <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Models</span>
        )}
        {selected ? (
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            <ProviderLogo model={selected} size={18} />
            <span className="min-w-0 flex-1 truncate text-left font-medium text-slate-100">{selected.label}</span>
          </span>
        ) : (
          <span className="min-w-0 flex-1 truncate text-left text-slate-400">{loading ? 'Loading…' : emptyLabel}</span>
        )}
        <ChevronDown size={12} className={`shrink-0 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && popupPosition && typeof document !== 'undefined' && createPortal(
        <div
          ref={popupRef}
          className="fixed z-[200] overflow-hidden rounded-md border border-surface-700 bg-surface-900 shadow-2xl"
          style={{ left: popupPosition.left, top: popupPosition.top, width: popupPosition.width }}
          role="listbox"
          aria-label="Models"
        >
          <div className="border-b border-surface-700 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Models
          </div>
          <div className="overflow-auto p-1.5" style={{ maxHeight: popupMaxHeight }}>
            {options.length === 0 ? (
              <div className="px-3 py-4 text-center text-xs text-slate-500">{emptyLabel}</div>
            ) : (
              options.map((option) => {
                const active = option.id === value;
                const resolutions = option.capabilities.resolutions;
                const durations = option.capabilities.durations;
                const topResolution = resolutions[resolutions.length - 1] ?? '';
                const durationRange = durations.length > 1
                  ? `${durations[0]}-${durations[durations.length - 1]}`
                  : durations[0] ?? '';
                return (
                  <button
                    key={option.id}
                    type="button"
                    role="option"
                    aria-selected={active ? 'true' : 'false'}
                    className={`flex w-full items-center gap-2.5 rounded px-2 py-1.5 text-left transition ${active ? 'bg-surface-700' : 'hover:bg-surface-800'}`}
                    onClick={() => {
                      onChange(option.id);
                      setOpen(false);
                    }}
                  >
                    <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md ${active ? 'bg-surface-800' : 'bg-surface-950'}`}>
                      <ProviderLogo model={option} size={22} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className={`truncate text-sm font-medium ${active ? 'text-slate-100' : 'text-slate-200'}`}>{option.label}</div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[10px] text-slate-400">
                        {topResolution && <span className="rounded bg-surface-800 px-1.5 py-0.5">{topResolution}</span>}
                        {durationRange && <span className="rounded bg-surface-800 px-1.5 py-0.5">{durationRange}</span>}
                        {option.capabilities.audio ? (
                          <span className="inline-flex items-center gap-1 rounded bg-emerald-500/10 px-1.5 py-0.5 text-emerald-300">
                            <Volume2 size={10} />
                            Audio
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 rounded bg-surface-800 px-1.5 py-0.5 text-slate-500">
                            <VolumeX size={10} />
                            Mute
                          </span>
                        )}
                      </div>
                    </div>
                    {active && <Check size={14} className="shrink-0 text-brand-300" />}
                  </button>
                );
              })
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

function ProviderLogo({ model, size = 18 }: { model: VideoModelDefinition; size?: number }) {
  if (isSeedanceModel(model)) return <SeedanceLogo size={size} />;
  if (isKlingModel(model)) return <KlingLogo size={size} />;
  if (isVeoModel(model)) return <VeoLogo size={size} />;
  return <GenericLogo size={size} />;
}

function SeedanceLogo({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <defs>
        <linearGradient id="seedance-bar-1" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#3b56dc" />
          <stop offset="100%" stopColor="#2c46c0" />
        </linearGradient>
        <linearGradient id="seedance-bar-2" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#5b8cff" />
          <stop offset="100%" stopColor="#3b6dff" />
        </linearGradient>
        <linearGradient id="seedance-bar-3" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#1abfb1" />
          <stop offset="100%" stopColor="#0fa395" />
        </linearGradient>
        <linearGradient id="seedance-bar-4" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#7ee6d3" />
          <stop offset="100%" stopColor="#5dd5be" />
        </linearGradient>
      </defs>
      <g transform="skewX(-10)">
        <rect x="4.5" y="4" width="2.4" height="17" rx="0.4" fill="url(#seedance-bar-1)" />
        <rect x="9" y="11" width="2.4" height="10" rx="0.4" fill="url(#seedance-bar-2)" />
        <rect x="13.5" y="9" width="2.4" height="12" rx="0.4" fill="url(#seedance-bar-3)" />
        <rect x="18" y="3" width="2.4" height="18" rx="0.4" fill="url(#seedance-bar-4)" />
      </g>
    </svg>
  );
}

function KlingLogo({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <defs>
        <linearGradient id="kling-ring" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#3bc6ff" />
          <stop offset="50%" stopColor="#3bff97" />
          <stop offset="100%" stopColor="#fff04a" />
        </linearGradient>
      </defs>
      <g transform="rotate(-30 12 12)">
        <ellipse cx="12" cy="12" rx="9" ry="5.2" fill="none" stroke="url(#kling-ring)" strokeWidth="2.2" />
      </g>
    </svg>
  );
}

function VeoLogo({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <defs>
        <linearGradient id="veo-swirl" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#5a8aff" />
          <stop offset="100%" stopColor="#3b56dc" />
        </linearGradient>
      </defs>
      <path
        d="M 21 12 C 21 17 17 21 12 21 C 7 21 3 17 3 12 C 3 7 7 3 12 3 C 16 3 19 5.5 20 9 C 20.5 10.8 19.8 12.6 18 13 C 16.2 13.4 15 12 15 10.6 C 15 9.4 16 8.5 17.2 8.7"
        fill="none"
        stroke="url(#veo-swirl)"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function GenericLogo({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4" y="4" width="16" height="16" rx="3" fill="none" stroke="#7c8cff" strokeWidth="2" />
      <line x1="7" y1="17" x2="17" y2="7" stroke="#7c8cff" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
