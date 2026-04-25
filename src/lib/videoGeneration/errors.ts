export type GenerationErrorType = 'NSFW' | 'GuidelinesViolation' | 'Billing' | 'InternalError';

export class VideoGenerationProviderError extends Error {
  readonly type: GenerationErrorType;

  constructor(type: GenerationErrorType, message: string) {
    super(message);
    this.name = 'VideoGenerationProviderError';
    this.type = type;
  }
}

export function classifyProviderErrorText(text: string): GenerationErrorType {
  const normalized = text.toLowerCase();
  if (isBillingErrorText(normalized)) return 'Billing';
  if (/\b(nsfw|sexual|explicit|nudity|nude|porn|adult)\b/.test(normalized)) return 'NSFW';
  if (
    normalized.includes('policy') ||
    normalized.includes('safety') ||
    normalized.includes('guardrail') ||
    normalized.includes('guideline') ||
    normalized.includes('risk control') ||
    normalized.includes('content security') ||
    normalized.includes('content moderation') ||
    normalized.includes('platform strategy')
  ) {
    return 'GuidelinesViolation';
  }
  return 'InternalError';
}

export function isBillingErrorText(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    normalized.includes('failed to freeze credit') ||
    normalized.includes('account credit not enough') ||
    normalized.includes('credit not enough') ||
    normalized.includes('insufficient credit') ||
    normalized.includes('insufficient balance') ||
    normalized.includes('not enough balance') ||
    normalized.includes('auto exchange point quota') ||
    normalized.includes('point quota') ||
    normalized.includes('quota not enough')
  );
}
