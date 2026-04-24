import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { decryptSecret, encryptSecret } from '@/lib/settings/crypto';

const STORAGE_KEY = 'genedit-pro:connections:google-veo';

type Props = {
  open: boolean;
  onClose: () => void;
};

type Tab = 'connections' | 'general';

export function SettingsModal({ open, onClose }: Props) {
  const [tab, setTab] = useState<Tab>('connections');
  const [googleKey, setGoogleKey] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    const load = async () => {
      const encrypted = localStorage.getItem(STORAGE_KEY);
      if (!encrypted) {
        setGoogleKey('');
        return;
      }
      try {
        setGoogleKey(await decryptSecret(encrypted));
      } catch {
        setGoogleKey('');
      }
    };
    void load();
  }, [open]);

  if (!open) return null;

  const saveKey = async () => {
    setSaving(true);
    try {
      const payload = await encryptSecret(googleKey.trim());
      localStorage.setItem(STORAGE_KEY, payload);
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
                      onClick={() => void saveKey()}
                    >
                      {saving ? 'Saving…' : 'Save Key'}
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
