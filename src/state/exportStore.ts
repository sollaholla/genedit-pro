import { create } from 'zustand';
import type { ExportProgress, ExportStatus } from '@/types';

export type ExportJobSummary = {
  projectName: string;
  width: number;
  height: number;
  fps: number;
  durationSec: number;
  startedAt: number;
  completedAt?: number;
};

type ExportState = ExportProgress & {
  job?: ExportJobSummary;
  logTail: string[];
  beginJob: (job: ExportJobSummary, message?: string) => void;
  setStatus: (status: ExportStatus, message?: string) => void;
  setProgress: (progress: number, message?: string) => void;
  appendLog: (line: string) => void;
  setResult: (url: string) => void;
  setError: (error: string) => void;
  reset: () => void;
};

const initialProgress: ExportProgress = {
  status: 'idle',
  progress: 0,
  message: undefined,
  outputUrl: undefined,
  error: undefined,
};

export const useExportStore = create<ExportState>((set) => ({
  ...initialProgress,
  job: undefined,
  logTail: [],
  beginJob: (job, message = 'Loading encoder...') => set((state) => {
    if (state.outputUrl) URL.revokeObjectURL(state.outputUrl);
    return {
      ...initialProgress,
      status: 'preparing',
      message,
      job,
      logTail: [],
    };
  }),
  setStatus: (status, message) => set({ status, message }),
  setProgress: (progress, message) => set((state) => ({
    progress: Math.min(1, Math.max(0, progress)),
    message: message ?? state.message,
  })),
  appendLog: (line) => set((state) => ({ logTail: [...state.logTail.slice(-80), line] })),
  setResult: (outputUrl) => set((state) => {
    if (state.outputUrl) URL.revokeObjectURL(state.outputUrl);
    return {
      status: 'done',
      progress: 1,
      message: 'Done',
      outputUrl,
      error: undefined,
      job: state.job ? { ...state.job, completedAt: Date.now() } : state.job,
    };
  }),
  setError: (error) => set((state) => ({
    status: 'error',
    error,
    message: 'Export failed',
    job: state.job ? { ...state.job, completedAt: Date.now() } : state.job,
  })),
  reset: () => set((state) => {
    if (state.outputUrl) URL.revokeObjectURL(state.outputUrl);
    return { ...initialProgress, job: undefined, logTail: [] };
  }),
}));
