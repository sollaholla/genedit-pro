#!/usr/bin/env node

import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_URL = 'http://127.0.0.1:5176/genedit-pro/';
const url = process.env.GENEDIT_DEBUG_URL ?? DEFAULT_URL;

const PROJECT_ID = 'debug-preview-jitter';
const VIDEO_WIDTH = Number(process.env.GENEDIT_DEBUG_WIDTH ?? 1920);
const VIDEO_HEIGHT = Number(process.env.GENEDIT_DEBUG_HEIGHT ?? 1080);
const TARGET_CLIP_START_SEC = 3;
const TARGET_CLIP_SPEED = Number(process.env.GENEDIT_DEBUG_SPEED ?? 0.5);
const NATURAL_START_SEC = Number(process.env.GENEDIT_DEBUG_NATURAL_START ?? 2.65);
const DIRECT_START_SEC = Number(process.env.GENEDIT_DEBUG_DIRECT_START ?? 8.0);
const SAMPLE_DURATION_MS = 2600;

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[index];
}

function mean(values) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function frameDiff(first, second) {
  if (!first?.canvas?.pixels || !second?.canvas?.pixels) return 0;
  const count = Math.min(first.canvas.pixels.length, second.canvas.pixels.length);
  if (count === 0) return 0;
  let total = 0;
  for (let index = 0; index < count; index += 1) {
    total += Math.abs(first.canvas.pixels[index] - second.canvas.pixels[index]);
  }
  return total / count;
}

function frameChecksum(sample) {
  const pixels = sample?.canvas?.pixels;
  if (!pixels?.length) return 'none';
  let hash = 2166136261;
  for (const pixel of pixels) {
    hash ^= pixel;
    hash = Math.imul(hash, 16777619);
  }
  return String(hash >>> 0);
}

function frameMean(sample) {
  return mean(sample?.canvas?.pixels ?? []);
}

function targetVideo(sample) {
  return sample?.videos?.find((video) => video.clipId === 'clip-target') ?? null;
}

function summarize(name, samples) {
  const pairs = [];
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    pairs.push({
      rafMs: current.now - previous.now,
      timelineDelta: current.currentTimeSec - previous.currentTimeSec,
      diff: frameDiff(previous, current),
      mediaDelta: (targetVideo(current)?.currentTime ?? 0) - (targetVideo(previous)?.currentTime ?? 0),
      mediaTimelineDrift: targetVideo(current)
        ? targetVideo(current).currentTime - Math.max(0, (current.currentTimeSec - TARGET_CLIP_START_SEC) * TARGET_CLIP_SPEED)
        : 0,
    });
  }

  const diffs = pairs.map((pair) => pair.diff);
  const rafs = pairs.map((pair) => pair.rafMs);
  const timelineDeltas = pairs.map((pair) => pair.timelineDelta).filter((value) => value > 0);
  const mediaDeltas = pairs.map((pair) => pair.mediaDelta).filter((value) => value > 0);
  const drifts = pairs.map((pair) => Math.abs(pair.mediaTimelineDrift));
  const repeated = pairs.filter((pair) => pair.diff < 0.75 && pair.timelineDelta > 0.005).length;
  const stalls = pairs.filter((pair) => pair.timelineDelta < 0.005 && pair.rafMs > 12).length;
  const longRafs = pairs.filter((pair) => pair.rafMs > 34).length;
  const targetVideos = samples.map(targetVideo).filter(Boolean);
  const uniqueFrameChecksums = new Set(samples.map(frameChecksum)).size;

  return {
    name,
    samples: samples.length,
    durationMs: samples.length > 1 ? samples[samples.length - 1].now - samples[0].now : 0,
    frameDiffMean: mean(diffs),
    frameDiffP10: percentile(diffs, 0.1),
    frameDiffP50: percentile(diffs, 0.5),
    frameDiffP90: percentile(diffs, 0.9),
    repeatedFramePct: pairs.length ? repeated / pairs.length : 0,
    timelineStallPct: pairs.length ? stalls / pairs.length : 0,
    longRafPct: pairs.length ? longRafs / pairs.length : 0,
    rafMeanMs: mean(rafs),
    rafP95Ms: percentile(rafs, 0.95),
    rafMaxMs: Math.max(0, ...rafs),
    timelineDeltaMean: mean(timelineDeltas),
    mediaDeltaMean: mean(mediaDeltas),
    mediaTimelineDriftP95: percentile(drifts, 0.95),
    uniqueFrameChecksums,
    firstCanvasMean: frameMean(samples[0]),
    lastCanvasMean: frameMean(samples[samples.length - 1]),
    videoPausedPct: targetVideos.length ? targetVideos.filter((video) => video.paused).length / targetVideos.length : 0,
    videoSeekingPct: targetVideos.length ? targetVideos.filter((video) => video.seeking).length / targetVideos.length : 0,
    videoReadyMin: targetVideos.length ? Math.min(...targetVideos.map((video) => video.readyState)) : 0,
    videoReadyMax: targetVideos.length ? Math.max(...targetVideos.map((video) => video.readyState)) : 0,
    firstVideoTime: targetVideos[0]?.currentTime ?? 0,
    lastVideoTime: targetVideos[targetVideos.length - 1]?.currentTime ?? 0,
  };
}

function printSummary(summary) {
  console.log(`\n${summary.name}`);
  console.log(`  samples: ${summary.samples} over ${summary.durationMs.toFixed(0)}ms`);
  console.log(`  frame diff mean/p50/p90: ${summary.frameDiffMean.toFixed(2)} / ${summary.frameDiffP50.toFixed(2)} / ${summary.frameDiffP90.toFixed(2)}`);
  console.log(`  repeated frame pct: ${(summary.repeatedFramePct * 100).toFixed(1)}%`);
  console.log(`  timeline stall pct: ${(summary.timelineStallPct * 100).toFixed(1)}%`);
  console.log(`  RAF mean/p95/max: ${summary.rafMeanMs.toFixed(1)} / ${summary.rafP95Ms.toFixed(1)} / ${summary.rafMaxMs.toFixed(1)}ms`);
  console.log(`  timeline/media delta mean: ${summary.timelineDeltaMean.toFixed(4)} / ${summary.mediaDeltaMean.toFixed(4)}s`);
  console.log(`  media drift p95: ${summary.mediaTimelineDriftP95.toFixed(4)}s`);
  console.log(`  unique frame checksums: ${summary.uniqueFrameChecksums}`);
  console.log(`  canvas mean first/last: ${summary.firstCanvasMean.toFixed(1)} / ${summary.lastCanvasMean.toFixed(1)}`);
  console.log(`  target video paused/seeking: ${(summary.videoPausedPct * 100).toFixed(1)}% / ${(summary.videoSeekingPct * 100).toFixed(1)}%`);
  console.log(`  target video ready min/max: ${summary.videoReadyMin} / ${summary.videoReadyMax}`);
  console.log(`  target video time first/last: ${summary.firstVideoTime.toFixed(4)} / ${summary.lastVideoTime.toFixed(4)}s`);
}

async function waitForDebugBridge(page) {
  await page.waitForFunction(() => Boolean(window.__GENEDIT_PREVIEW_DEBUG__), null, { timeout: 15000 });
}

function createMp4Payload() {
  const dir = mkdtempSync(join(tmpdir(), 'genedit-preview-jitter-'));
  const outputPath = join(dir, 'debug-source-video.mp4');
  try {
    execFileSync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `testsrc2=size=${VIDEO_WIDTH}x${VIDEO_HEIGHT}:rate=30:duration=6`,
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=6',
      '-map',
      '0:v:0',
      '-map',
      '1:a:0',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '18',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-movflags',
      '+faststart',
      outputPath,
    ], { stdio: 'ignore' });
    return {
      name: 'debug-source-video.mp4',
      mimeType: 'video/mp4',
      base64: readFileSync(outputPath).toString('base64'),
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    console.warn(`Could not generate MP4 with ffmpeg, falling back to browser WebM: ${error.message}`);
    return null;
  }
}

async function seedDebugProject(page, videoPayload) {
  await page.evaluate(async ({ projectId, targetClipStartSec, targetClipSpeed, videoPayload, videoWidth, videoHeight }) => {
    const deleteDatabase = (name) => new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve(undefined);
      request.onerror = () => reject(request.error);
      request.onblocked = () => resolve(undefined);
    });

    const openDatabase = (name) => new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('mediaBlobs')) {
          db.createObjectStore('mediaBlobs', { keyPath: 'key' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    const putBlob = (db, key, blob, name) => new Promise((resolve, reject) => {
      const tx = db.transaction('mediaBlobs', 'readwrite');
      tx.objectStore('mediaBlobs').put({
        key,
        blob,
        name,
        mimeType: blob.type,
        createdAt: Date.now(),
      });
      tx.oncomplete = () => resolve(undefined);
      tx.onerror = () => reject(tx.error);
    });

    const blobFromPayload = (payload) => {
      const binary = atob(payload.base64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      return new Blob([bytes], { type: payload.mimeType });
    };

    const createSyntheticWebM = () => new Promise((resolve, reject) => {
      const canvas = document.createElement('canvas');
      canvas.width = videoWidth;
      canvas.height = videoHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Could not create canvas context'));
        return;
      }

      const stream = canvas.captureStream(30);
      const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9' });
      const chunks = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      recorder.onerror = () => reject(recorder.error ?? new Error('MediaRecorder failed'));
      recorder.onstop = () => resolve(new Blob(chunks, { type: 'video/webm' }));
      recorder.start();

      let frame = 0;
      const totalFrames = 180;
      const draw = () => {
        const t = frame / 30;
        ctx.fillStyle = `rgb(${Math.round(40 + 35 * Math.sin(t * 2))}, ${Math.round(42 + 35 * Math.cos(t * 3))}, 58)`;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#f5f7ff';
        ctx.fillRect((frame * 9) % (videoWidth + 60) - 60, videoHeight * 0.2, videoWidth * 0.14, videoHeight * 0.58);
        ctx.fillStyle = '#ffb84d';
        ctx.fillRect((frame * 17) % (videoWidth + 90) - 90, videoHeight * 0.33, videoWidth * 0.12, videoHeight * 0.2);
        ctx.fillStyle = '#52ffc7';
        ctx.beginPath();
        ctx.arc(videoWidth / 2 + Math.sin(t * 2.8) * videoWidth * 0.28, videoHeight / 2 + Math.cos(t * 2.2) * videoHeight * 0.25, videoHeight * 0.105, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#111114';
        ctx.font = `700 ${Math.round(videoHeight * 0.15)}px monospace`;
        ctx.fillText(String(frame).padStart(3, '0'), videoWidth * 0.06, videoHeight * 0.9);

        frame += 1;
        if (frame <= totalFrames) {
          setTimeout(draw, 1000 / 30);
        } else {
          setTimeout(() => recorder.stop(), 120);
        }
      };
      draw();
    });

    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('genedit-pro:')) localStorage.removeItem(key);
    }
    await deleteDatabase('genedit-pro');
    const blob = videoPayload ? blobFromPayload(videoPayload) : await createSyntheticWebM();
    const db = await openDatabase('genedit-pro');
    await putBlob(db, 'debug-source-video', blob, videoPayload?.name ?? 'debug-source-video.webm');
    db.close();

    const now = Date.now();
    const project = {
      id: projectId,
      name: 'Preview Jitter Debug',
      fps: 30,
      width: videoWidth,
      height: videoHeight,
      tracks: [
        { id: 'track-video', name: 'Video 1', kind: 'video', index: 0, muted: false, hidden: false },
      ],
      clips: [
        {
          id: 'clip-leadin',
          assetId: 'asset-debug-video',
          trackId: 'track-video',
          startSec: 0,
          inSec: 0,
          outSec: 3,
          speed: 1,
          scale: 1,
          components: [],
          volume: 0,
          fadeInSec: 0,
          fadeOutSec: 0,
        },
        {
          id: 'clip-target',
          assetId: 'asset-debug-video',
          trackId: 'track-video',
          startSec: targetClipStartSec,
          inSec: 0,
          outSec: 6,
          speed: targetClipSpeed,
          scale: 1,
          components: [],
          volume: 0,
          fadeInSec: 0,
          fadeOutSec: 0,
        },
      ],
      metadata: { aiGenerationSpendUsd: 0 },
    };

    const asset = {
      id: 'asset-debug-video',
      name: 'Debug Motion Video',
      kind: 'video',
      durationSec: 6,
      width: videoWidth,
      height: videoHeight,
      mimeType: blob.type,
      blobKey: 'debug-source-video',
      createdAt: now,
    };
    const summary = { id: projectId, name: project.name, createdAt: now, updatedAt: now };
    localStorage.setItem('genedit-pro:projects:index', JSON.stringify([summary]));
    localStorage.setItem('genedit-pro:projects:active', projectId);
    localStorage.setItem(`genedit-pro:projects:project:${projectId}`, JSON.stringify(project));
    localStorage.setItem('genedit-pro:project', JSON.stringify(project));
    localStorage.setItem(`genedit-pro:projects:media:${projectId}:assets`, JSON.stringify([asset]));
    localStorage.setItem(`genedit-pro:projects:media:${projectId}:folders`, JSON.stringify([]));
    localStorage.setItem('genedit-pro:projects:media-migrated', 'true');
  }, {
    projectId: PROJECT_ID,
    targetClipStartSec: TARGET_CLIP_START_SEC,
    targetClipSpeed: TARGET_CLIP_SPEED,
    videoPayload,
    videoWidth: VIDEO_WIDTH,
    videoHeight: VIDEO_HEIGHT,
  });
}

async function collectScenario(page, name, startTimeSec) {
  await page.evaluate((timeSec) => {
    window.__GENEDIT_PREVIEW_DEBUG__.pause();
    window.__GENEDIT_PREVIEW_DEBUG__.setCurrentTime(timeSec);
  }, startTimeSec);
  await page.waitForTimeout(450);
  await page.evaluate(() => window.__GENEDIT_PREVIEW_DEBUG__.play());
  const samples = await page.evaluate(async (durationMs) => {
    const output = [];
    const end = performance.now() + durationMs;
    while (performance.now() < end) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      output.push(window.__GENEDIT_PREVIEW_DEBUG__.sampleFrame());
    }
    window.__GENEDIT_PREVIEW_DEBUG__.pause();
    return output;
  }, SAMPLE_DURATION_MS);
  return summarize(name, samples);
}

async function main() {
  const videoPayload = createMp4Payload();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  const page = await context.newPage();
  page.on('console', (message) => {
    if (message.type() === 'error') console.error(`[browser] ${message.text()}`);
  });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await seedDebugProject(page, videoPayload ? {
    name: videoPayload.name,
    mimeType: videoPayload.mimeType,
    base64: videoPayload.base64,
  } : null);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForDebugBridge(page);
  await page.waitForFunction(() => document.querySelector('canvas'));

  const natural = await collectScenario(page, 'natural entry from before target clip', NATURAL_START_SEC);
  const direct = await collectScenario(page, 'direct start inside target clip', DIRECT_START_SEC);
  printSummary(natural);
  printSummary(direct);

  const repeatedDeltaPct = direct.repeatedFramePct - natural.repeatedFramePct;
  const driftDelta = direct.mediaTimelineDriftP95 - natural.mediaTimelineDriftP95;
  console.log('\ncomparison');
  console.log(`  repeated frame delta: ${(repeatedDeltaPct * 100).toFixed(1)} percentage points`);
  console.log(`  media drift p95 delta: ${driftDelta.toFixed(4)}s`);

  await browser.close();
  videoPayload?.cleanup();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
