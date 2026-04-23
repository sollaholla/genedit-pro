import { create } from 'zustand';
import type { ExportProgress, ExportStatus } from '@/types';

type ExportState = ExportProgress & {
  setStatus: (status: ExportStatus, message?: string) => void;
  setProgress: (progress: number, message?: string) => void;
  setResult: (url: string) => void;
  setError: (error: string) => void;
  reset: () => void;
};

export const useExportStore = create<ExportState>((set) => ({
  status: 'idle',
  progress: 0,
  message: undefined,
  outputUrl: undefined,
  error: undefined,
  setStatus: (status, message) => set({ status, message }),
  setProgress: (progress, message) => set({ progress: Math.min(1, Math.max(0, progress)), message }),
  setResult: (outputUrl) => set({ status: 'done', progress: 1, outputUrl }),
  setError: (error) => set({ status: 'error', error }),
  reset: () =>
    set({ status: 'idle', progress: 0, message: undefined, outputUrl: undefined, error: undefined }),
}));
