let historySequence = 0;

export type HistoryDomain = 'project' | 'selection';

const listeners = new Set<(domain: HistoryDomain) => void>();

export function nextHistorySeq(): number {
  historySequence += 1;
  return historySequence;
}

export function notifyHistoryMutation(domain: HistoryDomain): void {
  for (const listener of listeners) listener(domain);
}

export function subscribeHistoryMutation(listener: (domain: HistoryDomain) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
