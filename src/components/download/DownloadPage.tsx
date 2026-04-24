import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, FileWarning } from 'lucide-react';

type DownloadPayload = {
  blob: Blob;
  filename: string;
  objectUrl: string;
};

export function DownloadPage() {
  const [error, setError] = useState<string | null>(null);
  const [payload, setPayload] = useState<DownloadPayload | null>(null);
  const didStartDownloadRef = useRef(false);

  const params = useMemo(() => downloadParamsFromLocation(window.location), []);

  useEffect(() => {
    try {
      const decoded = buildDownloadPayload(params);
      setPayload(decoded);
      setError(null);
      return () => URL.revokeObjectURL(decoded.objectUrl);
    } catch (err) {
      setPayload(null);
      setError(err instanceof Error ? err.message : 'Could not prepare this download.');
    }
  }, [params]);

  useEffect(() => {
    if (!payload || didStartDownloadRef.current) return;
    const windowWithDownloadState = window as Window & { __geneditDownloadUrl?: string };
    if (windowWithDownloadState.__geneditDownloadUrl === window.location.href) return;
    windowWithDownloadState.__geneditDownloadUrl = window.location.href;
    didStartDownloadRef.current = true;
    triggerDownload(payload.objectUrl, payload.filename);
  }, [payload]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-surface-950 p-6 text-slate-100">
      <section className="w-full max-w-lg rounded-xl border border-surface-700 bg-surface-900 p-5 shadow-2xl">
        <div className="mb-4 flex items-center gap-3">
          <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${error ? 'bg-rose-500/15 text-rose-200' : 'bg-brand-500/15 text-brand-200'}`}>
            {error ? <FileWarning size={20} /> : <Download size={20} />}
          </div>
          <div>
            <h1 className="text-base font-semibold">{error ? 'Download unavailable' : 'Preparing download'}</h1>
            <p className="mt-0.5 text-xs text-slate-500">
              {error ? 'Check the URL parameters and try again.' : payload?.filename ?? 'Decoding file data...'}
            </p>
          </div>
        </div>

        {error ? (
          <div className="rounded-lg border border-rose-400/25 bg-rose-500/10 px-3 py-2 text-sm text-rose-100">
            {error}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="rounded-lg border border-surface-700 bg-surface-950/60 px-3 py-2 text-xs text-slate-400">
              If the download does not start automatically, use the button below.
            </div>
            {payload && (
              <a
                className="inline-flex h-9 items-center gap-2 rounded-md bg-brand-500 px-3 text-sm font-medium text-white hover:bg-brand-400"
                download={payload.filename}
                href={payload.objectUrl}
              >
                <Download size={15} />
                Download {payload.filename}
              </a>
            )}
          </div>
        )}
      </section>
    </main>
  );
}

function downloadParamsFromLocation(location: Location): URLSearchParams {
  const search = new URLSearchParams(location.search);
  if (!location.hash.includes('?')) return search;
  const hashParams = new URLSearchParams(location.hash.slice(location.hash.indexOf('?') + 1));
  hashParams.forEach((value, key) => {
    if (!search.has(key)) search.set(key, value);
  });
  return search;
}

function buildDownloadPayload(params: URLSearchParams): DownloadPayload {
  const rawBase64 = params.get('base64') ?? params.get('data');
  if (!rawBase64?.trim()) throw new Error('Missing required base64 parameter.');

  const extension = normalizeExtension(params.get('extension') ?? params.get('ext'));
  const filename = normalizeFilename(params.get('filename'), extension);
  const bytes = decodeBase64ToBytes(rawBase64);
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const blob = new Blob([arrayBuffer], { type: mimeTypeForExtension(extension) });
  return {
    blob,
    filename,
    objectUrl: URL.createObjectURL(blob),
  };
}

function decodeBase64ToBytes(value: string): Uint8Array {
  const encoded = normalizeBase64(value);
  let binary = '';
  try {
    binary = atob(encoded);
  } catch {
    throw new Error('The base64 parameter is not valid.');
  }

  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function normalizeBase64(value: string): string {
  const withoutDataUrl = value.includes(',') && value.slice(0, value.indexOf(',')).includes('base64')
    ? value.slice(value.indexOf(',') + 1)
    : value;
  const compact = withoutDataUrl.trim().replace(/\s/g, '+').replace(/-/g, '+').replace(/_/g, '/');
  const padding = compact.length % 4;
  return padding === 0 ? compact : compact.padEnd(compact.length + (4 - padding), '=');
}

function normalizeExtension(value: string | null): string {
  const extension = (value || 'bin').trim().replace(/^\.+/, '').toLowerCase();
  if (!/^[a-z0-9]{1,12}$/.test(extension)) throw new Error('The extension parameter must be 1-12 letters or numbers.');
  return extension;
}

function normalizeFilename(value: string | null, extension: string): string {
  const fallback = `download.${extension}`;
  if (!value?.trim()) return fallback;
  const safe = value.trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').slice(0, 96);
  if (!safe) return fallback;
  return safe.toLowerCase().endsWith(`.${extension}`) ? safe : `${safe}.${extension}`;
}

function mimeTypeForExtension(extension: string): string {
  const map: Record<string, string> = {
    gif: 'image/gif',
    jpeg: 'image/jpeg',
    jpg: 'image/jpeg',
    json: 'application/json',
    mp3: 'audio/mpeg',
    mp4: 'video/mp4',
    pdf: 'application/pdf',
    png: 'image/png',
    txt: 'text/plain',
    wav: 'audio/wav',
    webm: 'video/webm',
    webp: 'image/webp',
  };
  return map[extension] ?? 'application/octet-stream';
}

function triggerDownload(url: string, filename: string) {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}
