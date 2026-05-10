const PIAPI_API_BASE_URL = 'https://api.piapi.ai';
const PIAPI_PROMPT_ASSIST_MODEL = 'gpt-4o';
const PIAPI_PROMPT_ASSIST_INPUT_USD_PER_1M_TOKENS = 1.25;
const PIAPI_PROMPT_ASSIST_OUTPUT_USD_PER_1M_TOKENS = 5;
const LOW_DETAIL_IMAGE_TOKEN_ESTIMATE = 85;
export const PIAPI_PROMPT_ASSIST_MAX_OUTPUT_TOKENS = 520;

type PiApiCredentials = {
  apiKey: string;
};

type PiApiChatCompletionUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
};

type PiApiChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string | Array<{ text?: string }>;
    };
  }>;
  usage?: PiApiChatCompletionUsage;
  error?: {
    message?: string;
    type?: string;
  };
};

export type PiApiPromptAssistImage = {
  label: string;
  url: string;
};

export type PiApiPromptAssistRequest = {
  systemPrompt: string;
  userText: string;
  images?: PiApiPromptAssistImage[];
  maxOutputTokens?: number;
};

export type PiApiPromptAssistResult = {
  text: string;
  usage?: PiApiChatCompletionUsage;
  actualCostUsd?: number;
};

type PiApiChatMessage = {
  role: 'system' | 'user';
  content: string | Array<
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string; detail: 'low' } }
  >;
};

export async function completePiApiPromptAssist(
  request: PiApiPromptAssistRequest,
  credentials: PiApiCredentials,
): Promise<PiApiPromptAssistResult> {
  const response = await fetch(`${PIAPI_API_BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${credentials.apiKey}`,
    },
    body: JSON.stringify({
      model: PIAPI_PROMPT_ASSIST_MODEL,
      messages: promptAssistMessages(request),
      max_tokens: request.maxOutputTokens ?? PIAPI_PROMPT_ASSIST_MAX_OUTPUT_TOKENS,
      temperature: 0.25,
      stream: false,
    }),
  });
  const text = await response.text().catch(() => '');
  const parsed = parseJson<PiApiChatCompletionResponse>(text);
  if (!response.ok || parsed?.error) {
    const message = parsed?.error?.message ?? (text || `PiAPI prompt assist failed (${response.status}).`);
    throw new Error(`PiAPI prompt assist failed (${response.status}): ${message}`);
  }

  const content = completionText(parsed);
  if (!content) throw new Error('PiAPI prompt assist returned no prompt text.');
  return {
    text: normalizePromptAssistText(content),
    usage: parsed?.usage,
    actualCostUsd: parsed?.usage ? piApiPromptAssistUsageCostUsd(parsed.usage) : undefined,
  };
}

export function estimatePiApiPromptAssistCostUsd(request: PiApiPromptAssistRequest): number {
  const messages = promptAssistMessages(request);
  const text = messages.map((message) => textFromMessageContent(message.content)).join('\n');
  const imageCount = request.images?.length ?? 0;
  const promptTokens = estimateTextTokens(text) + imageCount * LOW_DETAIL_IMAGE_TOKEN_ESTIMATE;
  const completionTokens = request.maxOutputTokens ?? PIAPI_PROMPT_ASSIST_MAX_OUTPUT_TOKENS;
  return tokensCostUsd(promptTokens, completionTokens);
}

function promptAssistMessages(request: PiApiPromptAssistRequest): PiApiChatMessage[] {
  return [
    { role: 'system', content: request.systemPrompt },
    { role: 'user', content: promptAssistUserContent(request) },
  ];
}

function promptAssistUserContent(request: PiApiPromptAssistRequest): PiApiChatMessage['content'] {
  const images = request.images ?? [];
  if (images.length === 0) return request.userText;
  const content: Exclude<PiApiChatMessage['content'], string> = [{ type: 'text', text: request.userText }];
  images.forEach((image, index) => {
    content.push({ type: 'text', text: `Reference image ${index + 1}: ${image.label}` });
    content.push({ type: 'image_url', image_url: { url: image.url, detail: 'low' } });
  });
  return content;
}

function piApiPromptAssistUsageCostUsd(usage: PiApiChatCompletionUsage): number {
  return tokensCostUsd(usage.prompt_tokens ?? usage.total_tokens ?? 0, usage.completion_tokens ?? 0);
}

function tokensCostUsd(inputTokens: number, outputTokens: number): number {
  return (inputTokens / 1_000_000) * PIAPI_PROMPT_ASSIST_INPUT_USD_PER_1M_TOKENS +
    (outputTokens / 1_000_000) * PIAPI_PROMPT_ASSIST_OUTPUT_USD_PER_1M_TOKENS;
}

function estimateTextTokens(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(words / 0.75));
}

function completionText(parsed: PiApiChatCompletionResponse | null): string {
  const content = parsed?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => part.text ?? '').join('\n');
  return '';
}

function normalizePromptAssistText(text: string): string {
  return text
    .trim()
    .replace(/^```(?:text)?/i, '')
    .replace(/```$/i, '')
    .replace(/^["']|["']$/g, '')
    .trim();
}

function textFromMessageContent(content: PiApiChatMessage['content']): string {
  if (typeof content === 'string') return content;
  return content.map((part) => (part.type === 'text' ? part.text : `Reference image: ${part.image_url.url}`)).join('\n');
}

function parseJson<T>(text: string): T | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}
