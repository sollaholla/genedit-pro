export type PiApiUsage = {
  type?: string | null;
  frozen?: number | string | null;
  consume?: number | string | null;
};

export type PiApiUsageCarrier = {
  meta?: {
    usage?: PiApiUsage | null;
  } | null;
  usage?: PiApiUsage | null;
};

export const PIAPI_USAGE_UNITS_PER_USD = 10_000_000;

export function piApiUsageCostUsd(task: PiApiUsageCarrier | null | undefined): number | undefined {
  const consume = finiteNumber(task?.meta?.usage?.consume ?? task?.usage?.consume);
  if (consume === undefined) return undefined;
  if (consume <= 0) return 0;
  return Number((consume / PIAPI_USAGE_UNITS_PER_USD).toFixed(6));
}

function finiteNumber(value: number | string | null | undefined): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const normalized = value.replaceAll(',', '').trim();
  if (!normalized) return undefined;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}
