import { useEffect } from 'react';
import { Copy, CopyPlus, Replace, Trash2 } from 'lucide-react';

export type ClipMenuAction = 'duplicate' | 'copy' | 'replace' | 'delete';

type Props = {
  x: number;
  y: number;
  onPick: (action: ClipMenuAction) => void;
  onClose: () => void;
};

export function ClipContextMenu({ x, y, onPick, onClose }: Props) {
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('[data-clip-ctx]')) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const items: { action: ClipMenuAction; label: string; Icon: typeof Copy; danger?: boolean }[] = [
    { action: 'duplicate', label: 'Duplicate', Icon: CopyPlus },
    { action: 'copy', label: 'Copy', Icon: Copy },
    { action: 'replace', label: 'Replace…', Icon: Replace },
    { action: 'delete', label: 'Delete', Icon: Trash2, danger: true },
  ];

  return (
    <div
      data-clip-ctx
      className="fixed z-50 min-w-[160px] rounded-md border border-surface-600 bg-surface-800 py-1 text-xs text-slate-200 shadow-lg"
      style={{ left: x, top: y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map(({ action, label, Icon, danger }) => (
        <button
          key={action}
          type="button"
          className={`flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-surface-700 ${
            danger ? 'text-red-300 hover:bg-red-900/40' : ''
          }`}
          onClick={() => { onPick(action); onClose(); }}
        >
          <Icon size={12} />
          {label}
        </button>
      ))}
    </div>
  );
}
