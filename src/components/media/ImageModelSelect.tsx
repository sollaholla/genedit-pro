import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';
import {
  CHARACTER_IMAGE_ASPECT_RATIO,
  CHARACTER_IMAGE_RESOLUTION,
  type ImageModelDefinition,
  type ImageModelProvider,
} from '@/lib/imageModels/capabilities';
import gptImageLogo from '@/assets/model-logos/gpt-image-logo.png';
import nanoBananaLogo from '@/assets/model-logos/nano-banana-logo.png';

type Props = {
  value: string;
  options: ImageModelDefinition[];
  onChange: (value: string) => void;
  label?: string;
};

export function ImageModelSelect({ value, options, onChange, label = 'Image Model' }: Props) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const selected = options.find((option) => option.id === value) ?? null;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || popupRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const updatePosition = () => {
      const trigger = triggerRef.current;
      const popup = popupRef.current;
      if (!trigger || !popup) return;
      const rect = trigger.getBoundingClientRect();
      const margin = 8;
      const width = Math.min(320, window.innerWidth - margin * 2);
      const estimatedHeight = popup.offsetHeight || 320;
      const spaceBelow = window.innerHeight - rect.bottom - margin;
      const spaceAbove = rect.top - margin;
      const placeAbove = spaceBelow < estimatedHeight && spaceAbove > spaceBelow;
      const left = Math.min(Math.max(margin, rect.left), window.innerWidth - width - margin);
      const top = placeAbove
        ? Math.max(margin, rect.top - estimatedHeight - 4)
        : Math.min(rect.bottom + 4, window.innerHeight - estimatedHeight - margin);
      popup.style.left = `${left}px`;
      popup.style.top = `${top}px`;
      popup.style.width = `${width}px`;
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open]);

  return (
    <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
      {label}
      <button
        ref={triggerRef}
        type="button"
        className="flex h-9 w-full items-center gap-2 rounded-md border border-surface-700 bg-surface-900 px-2 text-sm font-normal normal-case tracking-normal text-slate-100 transition hover:border-surface-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="listbox"
        aria-label={selected ? `Image model: ${selected.label}` : 'Select image model'}
      >
        {selected ? (
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-surface-950">
              <ImageProviderLogo provider={selected.provider} size={18} />
            </span>
            <span className="min-w-0 flex-1 truncate text-left font-medium">{selected.label}</span>
          </span>
        ) : (
          <span className="min-w-0 flex-1 truncate text-left text-slate-400">No image models</span>
        )}
        <ChevronDown size={13} className={`shrink-0 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && typeof document !== 'undefined' && createPortal(
        <div
          ref={popupRef}
          className="fixed z-[200] overflow-hidden rounded-md border border-surface-700 bg-surface-900 shadow-2xl"
          role="listbox"
          aria-label="Image models"
        >
          <div className="border-b border-surface-700 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Image Models</div>
          <div className="max-h-[360px] overflow-auto p-1.5">
            {options.map((option) => {
              const active = option.id === value;
              return (
                <button
                  key={option.id}
                  type="button"
                  role="option"
                  className={`flex w-full items-center gap-2.5 rounded px-2 py-1.5 text-left transition ${active ? 'bg-surface-700' : 'hover:bg-surface-800'}`}
                  onClick={() => {
                    onChange(option.id);
                    setOpen(false);
                  }}
                >
                  <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md ${active ? 'bg-surface-800' : 'bg-surface-950'}`}>
                    <ImageProviderLogo provider={option.provider} size={24} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className={`truncate text-sm font-medium ${active ? 'text-slate-100' : 'text-slate-200'}`}>{option.label}</div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[10px] text-slate-400">
                      <span className="rounded bg-surface-800 px-1.5 py-0.5">{CHARACTER_IMAGE_ASPECT_RATIO}</span>
                      <span className="rounded bg-surface-800 px-1.5 py-0.5">{CHARACTER_IMAGE_RESOLUTION}</span>
                      <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-emerald-300">${option.estimatedCostUsd.toFixed(3)}</span>
                    </div>
                  </div>
                  {active && <Check size={14} className="shrink-0 text-brand-300" />}
                </button>
              );
            })}
          </div>
        </div>,
        document.body,
      )}
    </label>
  );
}

function ImageProviderLogo({ provider, size }: { provider: ImageModelProvider; size: number }) {
  if (provider === 'piapi-gpt-image') return <LogoImage src={gptImageLogo} alt="GPT Image" size={size} />;
  return <LogoImage src={nanoBananaLogo} alt="Nano Banana" size={size} />;
}

function LogoImage({ src, alt, size }: { src: string; alt: string; size: number }) {
  return (
    <img src={src} alt={alt} width={size} height={size} className="shrink-0 object-contain" draggable={false} />
  );
}
