import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Volume2, VolumeX } from 'lucide-react';
import { isKlingModel, isSeedanceModel, isVeoModel, type VideoModelDefinition } from '@/lib/videoModels/capabilities';
import seedanceLogo from '@/assets/model-logos/seedance-logo.png';
import klingLogo from '@/assets/model-logos/kling-logo.png';
import googleVeoLogo from '@/assets/model-logos/google-veo-logo.png';

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
  if (isSeedanceModel(model)) return <LogoImage src={seedanceLogo} alt="Seedance" size={size} />;
  if (isKlingModel(model)) return <LogoImage src={klingLogo} alt="Kling" size={size} />;
  if (isVeoModel(model)) return <LogoImage src={googleVeoLogo} alt="Google Veo" size={size} />;
  return <GenericLogo size={size} />;
}

function LogoImage({ src, alt, size }: { src: string; alt: string; size: number }) {
  return (
    <img
      src={src}
      alt={alt}
      width={size}
      height={size}
      className="shrink-0 object-contain"
      draggable={false}
    />
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
