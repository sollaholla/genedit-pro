import type { MediaKind } from '@/types';

export type ProbeResult = {
  kind: MediaKind;
  durationSec: number;
  width?: number;
  height?: number;
};

export function inferKind(mimeType: string): MediaKind {
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('image/')) return 'image';
  // Fallback: treat unknowns as video so the browser tries to decode them.
  return 'video';
}

export function probe(file: File): Promise<ProbeResult> {
  const kind = inferKind(file.type);
  const url = URL.createObjectURL(file);

  if (kind === 'image') {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve({
          kind,
          durationSec: 5,
          width: img.naturalWidth,
          height: img.naturalHeight,
        });
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error(`Could not decode image: ${file.name}`));
      };
      img.src = url;
    });
  }

  return new Promise((resolve, reject) => {
    const el = document.createElement(kind === 'audio' ? 'audio' : 'video') as
      | HTMLVideoElement
      | HTMLAudioElement;
    el.preload = 'metadata';
    el.muted = true;
    const cleanup = () => {
      URL.revokeObjectURL(url);
      el.src = '';
    };
    el.onloadedmetadata = () => {
      const duration = Number.isFinite(el.duration) ? el.duration : 0;
      const width = 'videoWidth' in el ? el.videoWidth : undefined;
      const height = 'videoHeight' in el ? el.videoHeight : undefined;
      cleanup();
      resolve({ kind, durationSec: duration, width, height });
    };
    el.onerror = () => {
      cleanup();
      reject(new Error(`Could not probe media: ${file.name}`));
    };
    el.src = url;
  });
}
