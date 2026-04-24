import { useEffect, useState } from 'react';
import { Copy, ExternalLink, Eye, EyeOff, X } from 'lucide-react';
import {
  CONNECTION_SETTINGS_CHANGED_EVENT,
  PIAPI_API_KEY_STORAGE,
  PIAPI_KLING_API_KEY_STORAGE,
  PIAPI_VEO_API_KEY_STORAGE,
} from '@/lib/settings/connectionStorage';
import { decryptSecret, encryptSecret } from '@/lib/settings/crypto';

type Props = {
  open: boolean;
  onClose: () => void;
};

type Tab = 'connections' | 'general';

export function SettingsModal({ open, onClose }: Props) {
  const [tab, setTab] = useState<Tab>('connections');
  const [piapiKey, setPiapiKey] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    const load = async () => {
      setPiapiKey(await readFirstStoredSecret([
        PIAPI_API_KEY_STORAGE,
        PIAPI_VEO_API_KEY_STORAGE,
        PIAPI_KLING_API_KEY_STORAGE,
      ]));
    };
    void load();
  }, [open]);

  if (!open) return null;

  const savePiApiKey = async () => {
    setSaving(true);
    try {
      await storeSecret(PIAPI_API_KEY_STORAGE, piapiKey);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="flex h-[min(760px,90vh)] w-[min(980px,95vw)] overflow-hidden rounded-lg border border-surface-700 bg-surface-950 shadow-2xl">
        <aside className="w-56 border-r border-surface-700 bg-surface-900 p-3">
          <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-500">Settings</div>
          <button
            className={`mb-1 w-full rounded px-2 py-1.5 text-left text-sm ${tab === 'connections' ? 'bg-surface-700 text-slate-100' : 'text-slate-400 hover:bg-surface-800'}`}
            onClick={() => setTab('connections')}
          >
            Connections
          </button>
          <button
            className={`w-full rounded px-2 py-1.5 text-left text-sm ${tab === 'general' ? 'bg-surface-700 text-slate-100' : 'text-slate-400 hover:bg-surface-800'}`}
            onClick={() => setTab('general')}
          >
            General
          </button>
        </aside>

        <section className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center justify-between border-b border-surface-700 px-4 py-3">
            <div className="text-sm font-semibold text-slate-100">{tab === 'connections' ? 'Connections' : 'General'}</div>
            <button className="rounded p-1 text-slate-400 hover:bg-surface-800 hover:text-slate-200" onClick={onClose}>
              <X size={16} />
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-auto p-4">
            {tab === 'connections' ? (
              <div className="space-y-4">
                <p className="text-xs text-slate-500">Your API keys are encrypted in this browser.</p>
                <PiApiConnectionCard
                  value={piapiKey}
                  onChange={setPiapiKey}
                  saving={saving}
                  onSave={() => void savePiApiKey()}
                />
              </div>
            ) : (
              <div className="text-sm text-slate-400">General settings coming soon.</div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function PiApiConnectionCard({
  value,
  onChange,
  saving,
  onSave,
}: {
  value: string;
  onChange: (value: string) => void;
  saving: boolean;
  onSave: () => void;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="rounded border border-surface-700 bg-surface-900/60 p-3">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-slate-200">PiAPI</div>
          <div className="mt-0.5 text-[11px] text-slate-500">One key enables Veo 3.1, Veo 3.1 Fast, and Kling 3.0 Omni.</div>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
          <a
            href="https://piapi.ai/workspace/veo3"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 rounded border border-surface-600 px-2 py-1 text-[11px] text-slate-300 hover:border-brand-400 hover:text-slate-100"
          >
            Veo <ExternalLink size={11} />
          </a>
          <a
            href="https://piapi.ai/workspace/kling"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 rounded border border-surface-600 px-2 py-1 text-[11px] text-slate-300 hover:border-brand-400 hover:text-slate-100"
          >
            Kling <ExternalLink size={11} />
          </a>
        </div>
      </div>

      <div className="rounded-md border border-surface-700 bg-surface-950/50 p-3">
        <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
          <span className="rounded-full bg-brand-500/15 px-2 py-0.5 font-mono text-brand-200">X-API-KEY</span>
          <span>Header used for PiAPI requests</span>
        </div>
        <div className="flex overflow-hidden rounded border border-surface-600 bg-surface-800">
          <input
            type={visible ? 'text' : 'password'}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="Enter PiAPI API key"
            className="min-w-0 flex-1 bg-transparent px-3 py-2 text-sm text-slate-100 outline-none placeholder:text-slate-500"
          />
          <button
            type="button"
            className="flex h-10 w-10 items-center justify-center border-l border-surface-600 text-slate-300 hover:bg-surface-700 hover:text-slate-100"
            title={visible ? 'Hide API key' : 'Show API key'}
            onClick={() => setVisible((next) => !next)}
          >
            {visible ? <EyeOff size={17} /> : <Eye size={17} />}
          </button>
          <button
            type="button"
            className="flex h-10 w-10 items-center justify-center border-l border-surface-600 text-slate-300 hover:bg-surface-700 hover:text-slate-100"
            title="Copy API key"
            onClick={() => {
              if (value.trim()) void navigator.clipboard?.writeText(value.trim());
            }}
          >
            <Copy size={17} />
          </button>
        </div>
        <div className="mt-2 text-[11px] text-slate-500">Use the key shown in PiAPI's workspace under Header Params.</div>
      </div>

      <div className="mt-3 flex justify-end">
        <button
          className="btn-primary px-3 py-1.5 text-xs disabled:opacity-40"
          disabled={saving}
          onClick={onSave}
        >
          {saving ? 'Saving...' : 'Save Key'}
        </button>
      </div>
    </div>
  );
}

async function readStoredSecret(storageKey: string): Promise<string> {
  const encrypted = localStorage.getItem(storageKey);
  if (!encrypted) return '';
  try {
    return await decryptSecret(encrypted);
  } catch {
    return '';
  }
}

async function readFirstStoredSecret(storageKeys: string[]): Promise<string> {
  for (const storageKey of storageKeys) {
    const secret = await readStoredSecret(storageKey);
    if (secret.trim()) return secret;
  }
  return '';
}

async function storeSecret(storageKey: string, value: string): Promise<void> {
  const trimmed = value.trim();
  if (!trimmed) {
    localStorage.removeItem(storageKey);
    window.dispatchEvent(new Event(CONNECTION_SETTINGS_CHANGED_EVENT));
    return;
  }
  localStorage.setItem(storageKey, await encryptSecret(trimmed));
  window.dispatchEvent(new Event(CONNECTION_SETTINGS_CHANGED_EVENT));
}
