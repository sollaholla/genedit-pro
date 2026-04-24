type MockVideoOptions = {
  prompt: string;
  aspect: string;
  duration: string;
  resolution: string;
  audioEnabled: boolean;
  onProgress: (progress: number) => void;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function canvasSizeFor(aspect: string): { width: number; height: number } {
  if (aspect === '9:16') return { width: 360, height: 640 };
  if (aspect === '1:1') return { width: 512, height: 512 };
  return { width: 640, height: 360 };
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';

  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width <= maxWidth) {
      line = next;
      continue;
    }
    if (line) lines.push(line);
    line = word;
    if (lines.length >= 2) break;
  }

  if (line && lines.length < 3) lines.push(line);
  return lines.length ? lines : ['Untitled generation'];
}

function drawFrame(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  progress: number,
  options: Pick<MockVideoOptions, 'prompt' | 'resolution' | 'audioEnabled'>,
) {
  const hue = 222 + Math.sin(progress * Math.PI * 2) * 22;
  const bg = ctx.createLinearGradient(0, 0, width, height);
  bg.addColorStop(0, `hsl(${hue}, 58%, 12%)`);
  bg.addColorStop(0.48, 'hsl(228, 38%, 7%)');
  bg.addColorStop(1, 'hsl(196, 46%, 13%)');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);

  ctx.save();
  ctx.globalAlpha = 0.18;
  ctx.strokeStyle = '#b7c7ff';
  ctx.lineWidth = 1;
  const cell = Math.max(24, Math.round(width / 18));
  const drift = progress * cell;
  for (let x = -cell; x < width + cell; x += cell) {
    ctx.beginPath();
    ctx.moveTo(x + drift, 0);
    ctx.lineTo(x + drift - height * 0.35, height);
    ctx.stroke();
  }
  for (let y = 0; y < height; y += cell) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }
  ctx.restore();

  const safeW = width * 0.82;
  const panelX = (width - safeW) / 2;
  const panelH = Math.max(104, height * 0.34);
  const panelY = (height - panelH) / 2;
  ctx.fillStyle = 'rgba(6, 10, 24, 0.58)';
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.22)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(panelX, panelY, safeW, panelH, 12);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = '#a5b4fc';
  ctx.font = `600 ${Math.max(12, width * 0.022)}px Inter, system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillText('GENEDIT LOCAL AI PREVIEW', width / 2, panelY + 30);

  ctx.fillStyle = '#f8fafc';
  ctx.font = `700 ${Math.max(18, width * 0.045)}px Inter, system-ui, sans-serif`;
  const lines = wrapText(ctx, options.prompt, safeW - 42);
  const lineHeight = Math.max(22, width * 0.052);
  const firstLineY = panelY + panelH / 2 - ((lines.length - 1) * lineHeight) / 2 + 8;
  lines.forEach((line, index) => {
    ctx.fillText(line, width / 2, firstLineY + index * lineHeight);
  });

  const scanY = panelY + panelH - 28;
  ctx.strokeStyle = 'rgba(129, 140, 248, 0.8)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let x = panelX + 28; x <= panelX + safeW - 28; x += 8) {
    const normalized = (x - panelX) / safeW;
    const y = scanY + Math.sin((normalized + progress * 1.4) * Math.PI * 6) * 8;
    if (x === panelX + 28) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  ctx.fillStyle = '#94a3b8';
  ctx.font = `500 ${Math.max(10, width * 0.018)}px Inter, system-ui, sans-serif`;
  ctx.textAlign = 'left';
  ctx.fillText(`${options.resolution} / ${options.audioEnabled ? 'audio on' : 'silent'}`, 18, height - 18);
  ctx.textAlign = 'right';
  ctx.fillText(`${Math.round(progress * 100)}%`, width - 18, height - 18);
}

export async function createMockGeneratedVideo(options: MockVideoOptions): Promise<File> {
  if (typeof MediaRecorder === 'undefined') {
    throw new Error('Local demo generation is not supported in this browser.');
  }

  const seconds = Math.max(2, Math.min(8, Number(options.duration.replace('s', '')) || 4));
  const { width, height } = canvasSizeFor(options.aspect);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas rendering is unavailable.');

  const stream = canvas.captureStream(24);
  const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
    ? 'video/webm;codecs=vp9'
    : 'video/webm';
  const recorder = new MediaRecorder(stream, { mimeType });
  const chunks: BlobPart[] = [];
  const done = new Promise<Blob>((resolve, reject) => {
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.onerror = () => reject(new Error('Local demo generation failed.'));
    recorder.onstop = () => resolve(new Blob(chunks, { type: 'video/webm' }));
  });

  recorder.start();
  const frameCount = Math.max(48, Math.round(seconds * 24));
  for (let frame = 0; frame <= frameCount; frame += 1) {
    const progress = frame / frameCount;
    drawFrame(ctx, width, height, progress, options);
    options.onProgress(Math.min(96, Math.round(progress * 96)));
    await sleep(1000 / 24);
  }
  recorder.stop();
  stream.getTracks().forEach((track) => track.stop());

  const blob = await done;
  options.onProgress(100);
  return new File([blob], `generated_demo_${Date.now()}.webm`, { type: 'video/webm' });
}
