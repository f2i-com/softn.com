import type { ProviderConfig, ChatMessage } from '../types/studio';

export interface AIRequest {
  messages: ChatMessage[];
  system: string;
  signal?: AbortSignal;
  onStream?: (chunk: string) => void;
  modelOverride?: string;
  /** How long to wait for the whole response; default DEFAULT_REQUEST_TIMEOUT_MS. */
  timeoutMs?: number;
  /** The provider's max_tokens; default DEFAULT_MAX_OUTPUT_TOKENS. */
  maxOutputTokens?: number;
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;

/**
 * How a reply ended. `complete` is the only status whose file blocks may be
 * applied: `truncated` means the provider stopped at the output limit and
 * the last file block is whatever was written before the cut; `empty` means
 * there was no text at all; `refused` means the model declined.
 */
export type AICompletionStatus = 'complete' | 'truncated' | 'empty' | 'refused';

export type AIContentBlock = { type: 'text'; text: string } | { type: 'other'; kind: string };

export interface AIResponse {
  /** Every text block, concatenated in order. */
  content: string;
  status: AICompletionStatus;
  /** The provider's own stop reason, for the record. */
  stopReason: string | null;
  blocks: AIContentBlock[];
  /** Counts the provider reported, or 0 where it reported something that is not a count. */
  usage: { inputTokens: number; outputTokens: number };
}

export type AIFailureKind = 'timeout' | 'cancelled' | 'rate-limited' | 'http' | 'network' | 'invalid-response';

/**
 * A request that did not produce a reply, and why. The kinds are distinct
 * because they are recovered from differently: a timeout is retried, a rate
 * limit is retried after `retryAfterMs`, a cancellation is nothing at all,
 * an HTTP failure is read.
 */
export class AIProviderError extends Error {
  readonly kind: AIFailureKind;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(kind: AIFailureKind, message: string, extra: { status?: number; retryAfterMs?: number } = {}) {
    super(message);
    this.name = 'AIProviderError';
    this.kind = kind;
    this.status = extra.status;
    this.retryAfterMs = extra.retryAfterMs;
  }
}

// Default endpoints per provider type
const DEFAULT_ENDPOINTS: Record<string, string> = {
  anthropic: 'https://api.anthropic.com/v1/messages',
  openai: 'https://api.openai.com/v1/chat/completions',
};

const DEFAULT_MODELS: Record<string, string> = {
  anthropic: 'claude-sonnet-4-6',
  openai: 'gpt-5.4',
};

/** A reported count, or 0: usage that is not a finite non-negative number must not reach the accounting. */
function sanitizeCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/** The wait a Retry-After header asks for, in milliseconds, if it is readable. */
function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(header);
  if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** The text of a content block list, and a typed record of what each block was. */
function readBlocks(content: unknown): { text: string; blocks: AIContentBlock[] } {
  const blocks: AIContentBlock[] = [];
  if (typeof content === 'string') {
    blocks.push({ type: 'text', text: content });
    return { text: content, blocks };
  }
  if (!Array.isArray(content)) return { text: '', blocks };
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
      blocks.push({ type: 'text', text: block.text });
      parts.push(block.text);
    } else {
      blocks.push({ type: 'other', kind: isRecord(block) && typeof block.type === 'string' ? block.type : typeof block });
    }
  }
  return { text: parts.join(''), blocks };
}

/** Send a chat completion request to the configured provider */
export async function sendAIRequest(
  provider: ProviderConfig,
  request: AIRequest,
): Promise<AIResponse> {
  const { type, apiKey, baseUrl, modelId } = provider;
  const model = request.modelOverride || modelId || DEFAULT_MODELS[type] || 'default';
  const maxTokens = request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const timeoutMs = request.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  // Anthropic uses a different API shape
  const isAnthropicFormat = type === 'anthropic';

  let url: string;
  let headers: Record<string, string>;
  let body: unknown;

  if (isAnthropicFormat) {
    url = baseUrl || DEFAULT_ENDPOINTS.anthropic;
    headers = {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    };
    body = {
      model,
      max_tokens: maxTokens,
      system: request.system,
      messages: request.messages.map((m) => ({
        role: m.role === 'system' ? 'user' : m.role,
        content: m.content,
      })),
    };
  } else {
    // OpenAI-compatible format (works with OpenAI, OpenRouter, Ollama, LM Studio, etc.)
    url = baseUrl || DEFAULT_ENDPOINTS[type] || 'http://localhost:11434/v1/chat/completions';
    headers = {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    };
    body = {
      model,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: request.system },
        ...request.messages.map((m) => ({ role: m.role, content: m.content })),
      ],
    };
  }

  // One signal for the fetch, aborted by whichever comes first: the caller
  // cancelling, or this request's own clock running out. Which one it was
  // is remembered here, because fetch reports both as the same AbortError.
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onCallerAbort = () => controller.abort();
  if (request.signal) {
    if (request.signal.aborted) controller.abort();
    else request.signal.addEventListener('abort', onCallerAbort, { once: true });
  }

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (request.signal?.aborted) throw new AIProviderError('cancelled', 'The request was cancelled.');
    if (timedOut) throw new AIProviderError('timeout', `The provider did not answer within ${Math.round(timeoutMs / 1000)} s.`);
    throw new AIProviderError('network', `The provider could not be reached: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener('abort', onCallerAbort);
  }

  if (!resp.ok) {
    const text = (await resp.text().catch(() => '')).slice(0, 500);
    if (resp.status === 429) {
      const retryAfterMs = parseRetryAfter(resp.headers.get('retry-after'));
      throw new AIProviderError(
        'rate-limited',
        `The provider is rate-limiting requests${retryAfterMs !== undefined ? `; it asked for a wait of ${Math.ceil(retryAfterMs / 1000)} s` : ''}. ${text}`.trim(),
        { status: 429, retryAfterMs },
      );
    }
    throw new AIProviderError('http', `AI request failed (${resp.status}): ${text}`, { status: resp.status });
  }

  let data: unknown;
  try {
    data = await resp.json();
  } catch {
    throw new AIProviderError('invalid-response', 'AI response was not valid JSON');
  }
  if (!isRecord(data)) throw new AIProviderError('invalid-response', 'AI response was not an object');

  if (isAnthropicFormat) {
    // Every text block counts, not only the first: a reply may carry a
    // non-text block first and its text after it. stop_reason is the
    // provider's word on whether the reply is whole: `max_tokens` means it
    // was cut at the output limit, `refusal` that the model declined.
    const { text, blocks } = readBlocks(data.content);
    const stopReason = typeof data.stop_reason === 'string' ? data.stop_reason : null;
    const usage = isRecord(data.usage) ? data.usage : {};
    return {
      content: text,
      status: statusFor(stopReason, text, { truncated: ['max_tokens'], refused: ['refusal'] }),
      stopReason,
      blocks,
      usage: { inputTokens: sanitizeCount(usage.input_tokens), outputTokens: sanitizeCount(usage.output_tokens) },
    };
  }

  const choice = Array.isArray(data.choices) && isRecord(data.choices[0]) ? data.choices[0] : {};
  const message = isRecord(choice.message) ? choice.message : {};
  const { text, blocks } = readBlocks(message.content);
  const finishReason = typeof choice.finish_reason === 'string' ? choice.finish_reason : null;
  const refused = typeof message.refusal === 'string' && message.refusal.length > 0;
  const usage = isRecord(data.usage) ? data.usage : {};
  return {
    content: text,
    status: refused ? 'refused' : statusFor(finishReason, text, { truncated: ['length'], refused: ['content_filter'] }),
    stopReason: finishReason,
    blocks,
    usage: { inputTokens: sanitizeCount(usage.prompt_tokens), outputTokens: sanitizeCount(usage.completion_tokens) },
  };
}

function statusFor(stop: string | null, text: string, reasons: { truncated: string[]; refused: string[] }): AICompletionStatus {
  if (stop !== null && reasons.refused.includes(stop)) return 'refused';
  if (stop !== null && reasons.truncated.includes(stop)) return 'truncated';
  if (text.length === 0) return 'empty';
  return 'complete';
}
