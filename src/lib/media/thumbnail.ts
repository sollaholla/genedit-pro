import type { MediaKind } from '@/types';

const THUMB_MAX_WIDTH = 240;

function drawScaled(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
): string {
  const ratio = sourceHeight === 0 ? 9 / 16 : sourceHeight / sourceWidth;
  const w = Math.min(THUMB_MAX_WIDTH, sourceWidth || THUMB_MAX_WIDTH);
  const h = Math.round(w * ratio);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  ctx.drawImage(source, 0, 0, w, h);
  return canvas.toDataURL('image/jpeg', 0.78);
}

function audioPlaceholder(): string {
  const canvas = document.createElement('canvas');
  canvas.width = 240;
  canvas.height = 135;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  ctx.fillStyle = '#1fa27a';
  ctx.fillRect(0, 0, 240, 135);
  ctx.strokeStyle = 'rgba(255,255,255,0.75)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  const mid = 135 / 2;
  for (let x = 0; x < 240; x += 4) {
    const amp = 30 + Math.sin(x * 0.15) * 20 + Math.sin(x * 0.42) * 12;
    ctx.moveTo(x, mid - amp);
    ctx.lineTo(x, mid + amp);
  }
  ctx.stroke();
  return canvas.toDataURL('image/jpeg', 0.7);
}

export async function generateThumbnail(file: File, kind: MediaKind): Promise<string> {
  if (kind === 'audio') return audioPlaceholder();

  const url = URL.createObjectURL(file);

  if (kind === 'image') {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const out = drawScaled(img, img.naturalWidth, img.naturalHeight);
        URL.revokeObjectURL(url);
        resolve(out);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        resolve('');
      };
      img.src = url;
    });
  }

  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    video.crossOrigin = 'anonymous';

    let settled = false;
    const done = (dataUrl: string) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      video.src = '';
      resolve(dataUrl);
    };

    video.onloadeddata = () => {
      const seekTime = Math.min(0.2, (video.duration || 1) / 2);
      try {
        video.currentTime = seekTime;
      } catch {
        done('');
      }
    };
    video.onseeked = () => {
      const out = drawScaled(video, video.videoWidth, video.videoHeight);
      done(out);
    };
    video.onerror = () => done('');
    video.src = url;
  });
}
