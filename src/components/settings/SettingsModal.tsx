import { useEffect, useState } from 'react';
import { ExternalLink, X } from 'lucide-react';
import {
  CONNECTION_SETTINGS_CHANGED_EVENT,
  GOOGLE_VEO_API_KEY_STORAGE,
  KLING_ACCESS_KEY_STORAGE,
  KLING_SECRET_KEY_STORAGE,
} from '@/lib/settings/connectionStorage';
import { decryptSecret, encryptSecret } from '@/lib/settings/crypto';

type Props = {
  open: boolean;
  onClose: () => void;
};

type Tab = 'connections' | 'general';

export function SettingsModal({ open, onClose }: Props) {
  const [tab, setTab] = useState<Tab>('connections');
  const [googleKey, setGoogleKey] = useState('');
  const [klingAccessKey, setKlingAccessKey] = useState('');
  const [klingSecretKey, setKlingSecretKey] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    const load = async () => {
      setGoogleKey(await readStoredSecret(GOOGLE_VEO_API_KEY_STORAGE));
      setKlingAccessKey(await readStoredSecret(KLING_ACCESS_KEY_STORAGE));
      setKlingSecretKey(await readStoredSecret(KLING_SECRET_KEY_STORAGE));
    };
    void load();
  }, [open]);

  if (!open) return null;

  const saveGoogleKey = async () => {
    setSaving(true);
    try {
      await storeSecret(GOOGLE_VEO_API_KEY_STORAGE, googleKey);
    } finally {
      setSaving(false);
    }
  };

  const saveKlingKeys = async () => {
    setSaving(true);
    try {
      await storeSecret(KLING_ACCESS_KEY_STORAGE, klingAccessKey);
      await storeSecret(KLING_SECRET_KEY_STORAGE, klingSecretKey);
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
                <p className="text-xs text-slate-500">🔐 Your API keys are encrypted.</p>
                <div className="rounded border border-surface-700 bg-surface-900/60 p-3">
                  <div className="mb-2 flex items-center gap-2">
                    <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-white text-sm font-bold text-[#4285F4]">G</span>
                    <div>
                      <div className="text-sm font-semibold text-slate-200">Google Veo</div>
                      <div className="text-[11px] text-slate-500">Google AI Studio API key</div>
                    </div>
                  </div>
                  <label className="mb-2 block text-[11px] text-slate-400">API Key</label>
                  <input
                    type="password"
                    value={googleKey}
                    onChange={(e) => setGoogleKey(e.target.value)}
                    placeholder="AIza..."
                    className="w-full rounded border border-surface-600 bg-surface-800 px-2 py-1.5 text-sm text-slate-200 outline-none focus:border-brand-500"
                  />
                  <div className="mt-3 flex justify-end">
                    <button
                      className="btn-primary px-3 py-1.5 text-xs disabled:opacity-40"
                      disabled={saving}
                      onClick={() => void saveGoogleKey()}
                    >
                      {saving ? 'Saving…' : 'Save Key'}
                    </button>
                  </div>
                </div>

                <div className="rounded border border-surface-700 bg-surface-900/60 p-3">
                  <div className="mb-3 flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-slate-100 text-xs font-bold text-slate-950">K</span>
                      <div>
                        <div className="text-sm font-semibold text-slate-200">Kling</div>
                        <div className="text-[11px] text-slate-500">Access Key + Secret Key</div>
                      </div>
                    </div>
                    <a
                      href="https://kling.ai/dev/api-key"
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 rounded border border-surface-600 px-2 py-1 text-[11px] text-slate-300 hover:border-brand-400 hover:text-slate-100"
                    >
                      Create key <ExternalLink size={11} />
                    </a>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="block">
                      <span className="mb-2 block text-[11px] text-slate-400">Access Key</span>
                      <input
                        type="password"
                        value={klingAccessKey}
                        onChange={(e) => setKlingAccessKey(e.target.value)}
                        placeholder="Kling Access Key"
                        className="w-full rounded border border-surface-600 bg-surface-800 px-2 py-1.5 text-sm text-slate-200 outline-none focus:border-brand-500"
                      />
                    </label>
                    <label className="block">
                      <span className="mb-2 block text-[11px] text-slate-400">Secret Key</span>
                      <input
                        type="password"
                        value={klingSecretKey}
                        onChange={(e) => setKlingSecretKey(e.target.value)}
                        placeholder="Kling Secret Key"
                        className="w-full rounded border border-surface-600 bg-surface-800 px-2 py-1.5 text-sm text-slate-200 outline-none focus:border-brand-500"
                      />
                    </label>
                  </div>
                  <div className="mt-3 flex justify-end">
                    <button
                      className="btn-primary px-3 py-1.5 text-xs disabled:opacity-40"
                      disabled={saving}
                      onClick={() => void saveKlingKeys()}
                    >
                      {saving ? 'Saving…' : 'Save Keys'}
                    </button>
                  </div>
                </div>
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

async function readStoredSecret(storageKey: string): Promise<string> {
  const encrypted = localStorage.getItem(storageKey);
  if (!encrypted) return '';
  try {
    return await decryptSecret(encrypted);
  } catch {
    return '';
  }
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
