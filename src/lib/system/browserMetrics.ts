import { useEffect, useState } from 'react';

type BrowserMemoryInfo = {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
};

type PerformanceWithMemory = Performance & {
  memory?: BrowserMemoryInfo;
};

export type BrowserMetrics = {
  storageUsageBytes: number | null;
  storageQuotaBytes: number | null;
  memoryUsedBytes: number | null;
  memoryTotalBytes: number | null;
};

const EMPTY_METRICS: BrowserMetrics = {
  storageUsageBytes: null,
  storageQuotaBytes: null,
  memoryUsedBytes: null,
  memoryTotalBytes: null,
};

export function useBrowserMetrics(pollMs = 5000): BrowserMetrics {
  const [metrics, setMetrics] = useState<BrowserMetrics>(EMPTY_METRICS);

  useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      const next = await readBrowserMetrics();
      if (!cancelled) setMetrics(next);
    };

    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, pollMs);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [pollMs]);

  return metrics;
}

export async function readBrowserMetrics(): Promise<BrowserMetrics> {
  const storageEstimate = await readStorageEstimate();
  const memory = readMemoryInfo();

  return {
    storageUsageBytes: storageEstimate.usage,
    storageQuotaBytes: storageEstimate.quota,
    memoryUsedBytes: memory?.usedJSHeapSize ?? null,
    memoryTotalBytes: memory?.jsHeapSizeLimit ?? null,
  };
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes)) return 'n/a';
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** exponent;
  const digits = value >= 10 || exponent === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[exponent]}`;
}

async function readStorageEstimate(): Promise<{ usage: number | null; quota: number | null }> {
  try {
    if (!navigator.storage?.estimate) return { usage: null, quota: null };
    const estimate = await navigator.storage.estimate();
    return {
      usage: typeof estimate.usage === 'number' ? estimate.usage : null,
      quota: typeof estimate.quota === 'number' ? estimate.quota : null,
    };
  } catch {
    return { usage: null, quota: null };
  }
}

function readMemoryInfo(): BrowserMemoryInfo | null {
  const memory = (performance as PerformanceWithMemory).memory;
  if (!memory) return null;
  if (!Number.isFinite(memory.usedJSHeapSize) || !Number.isFinite(memory.jsHeapSizeLimit)) return null;
  return memory;
}
