import { useEffect } from 'react';
import { FolderInput, FolderOpen, Ungroup } from 'lucide-react';

export type TrackMenuAction = 'group' | 'enter-group' | 'ungroup';

type Props = {
  x: number;
  y: number;
  canGroup: boolean;
  canEnterGroup: boolean;
  canUngroup: boolean;
  onPick: (action: TrackMenuAction) => void;
  onClose: () => void;
};

export function TrackContextMenu({
  x,
  y,
  canGroup,
  canEnterGroup,
  canUngroup,
  onPick,
  onClose,
}: Props) {
  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('[data-track-ctx]')) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const items = [
    { action: 'group' as const, label: 'Group', Icon: FolderInput, disabled: !canGroup },
    { action: 'enter-group' as const, label: 'Open Group', Icon: FolderOpen, disabled: !canEnterGroup },
    { action: 'ungroup' as const, label: 'Ungroup', Icon: Ungroup, disabled: !canUngroup },
  ];

  return (
    <div
      data-track-ctx
      className="fixed z-50 min-w-[160px] rounded-md border border-surface-600 bg-surface-800 py-1 text-xs text-slate-200 shadow-lg"
      style={{ left: x, top: y }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map(({ action, label, Icon, disabled }) => (
        <button
          key={action}
          type="button"
          disabled={disabled}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-surface-700 disabled:cursor-not-allowed disabled:text-slate-600 disabled:hover:bg-transparent"
          onClick={() => {
            if (disabled) return;
            onPick(action);
            onClose();
          }}
        >
          <Icon size={12} />
          {label}
        </button>
      ))}
    </div>
  );
}
