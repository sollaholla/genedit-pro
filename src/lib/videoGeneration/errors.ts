export type GenerationErrorType = 'NSFW' | 'GuidelinesViolation' | 'InternalError';

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
