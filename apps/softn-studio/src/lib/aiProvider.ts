import { isHostedEditor, requestHostedAI } from '@softn/editor-shared/hostedEditor';
import type { ProviderConfig, ChatMessage } from '../types/studio';
import {
  describeConnectionError,
  isBlockedMixedContent,
  kindForStatus,
  listModels,
  ProviderConnectionError,
  providerEndpoints,
  providerHeaders,
  type ModelInfo,
} from './providerConnection';

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

/** How long one provider request may take before Studio gives up on it. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
/**
 * The output allowance reserved for each request, sent as the provider's
 * max_tokens. It is also what the budget check reserves before sending: a
 * reply cannot be longer than this, so a request the remaining budget
 * cannot cover at this size is refused before it costs anything.
 *
 * A reasoning model spends output tokens thinking before it answers, from
 * the same allowance: a real run's reply was cut at 16,384 after about 12k
 * of reasoning. Hence 32k, settable in Settings → Agent runs.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 32_768;
/** The default before it was raised; a saved setting still at it is read as the new default (projectSession.ts). */
export const PREVIOUS_DEFAULT_MAX_OUTPUT_TOKENS = 16_384;

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

export type AIFailureKind = 'timeout' | 'cancelled' | 'rate-limited' | 'http' | 'network' | 'invalid-response' | 'no-model';

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
  /** The provider's own words for an HTTP failure, when it gave any: what tells a rejected `tools` field apart. */
  readonly detail?: string;
  /** A streamed reply that could not be read as a stream: the request is worth sending again without streaming. */
  readonly streamFault?: boolean;

  constructor(kind: AIFailureKind, message: string, extra: { status?: number; retryAfterMs?: number; detail?: string; streamFault?: boolean } = {}) {
    super(message);
    this.name = 'AIProviderError';
    this.kind = kind;
    this.status = extra.status;
    this.retryAfterMs = extra.retryAfterMs;
    this.detail = extra.detail;
    this.streamFault = extra.streamFault;
  }
}

/** A reported count, or 0: usage that is not a finite non-negative number must not reach the accounting. */
export function sanitizeCount(value: unknown): number {
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

export function isRecord(value: unknown): value is Record<string, unknown> {
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
  if (isHostedEditor() && provider.id === 'formlogic') {
    try {
      const content = await requestHostedAI([{ role: 'system', content: request.system }, ...request.messages.map(({ role, content }) => ({ role, content }))], request.signal);
      return { content, status: content.trim() ? 'complete' : 'empty', stopReason: null, blocks: [{ type: 'text', text: content }], usage: { inputTokens: 0, outputTokens: 0 } };
    } catch (error) {
      throw new AIProviderError(request.signal?.aborted ? 'cancelled' : 'network', error instanceof Error ? error.message : 'FormLogic AI request failed.');
    }
  }
  const model = resolveModel(provider, request.modelOverride);
  if (!model) {
    // No model, no request. There used to be a default name per provider
    // here; model names change faster than Studio ships, so a guessed one
    // either failed with a confusing 404 or quietly ran something the
    // person never chose.
    throw new AIProviderError('no-model', `${provider.name} has no model chosen. Open AI setup and pick one of its models.`);
  }
  const maxTokens = request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const timeoutMs = request.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  // Anthropic uses a different API shape
  const isAnthropicFormat = provider.type === 'anthropic';
  const url = providerEndpoints(provider).chat;
  let body: unknown;

  if (isAnthropicFormat) {
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
    // OpenAI-compatible format (OpenAI, local servers, other endpoints).
    // OpenAI itself takes the output cap as max_completion_tokens — its
    // reasoning models reject max_tokens — while other servers still read
    // max_tokens. Decided by where the request goes, not the type: older
    // Studios saved gateways and local servers as `openai` too.
    body = {
      model,
      ...(isOpenAIHost(url) ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens }),
      messages: [
        { role: 'system', content: request.system },
        ...request.messages.map((m) => ({ role: m.role, content: m.content })),
      ],
    };
  }

  const data = await postProviderJSON(provider, url, body, { signal: request.signal, timeoutMs });

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

/**
 * POST a JSON body to a provider and answer its JSON reply, with the rules
 * every Studio request follows: no plain-HTTP call from an HTTPS page, the
 * caller's cancellation and this request's own clock on one signal, and
 * every failure as an AIProviderError of the kind it is. Shared by the chat
 * request above and the agent's tool-calling requests (lib/agent/protocol.ts).
 */
export async function postProviderJSON(
  provider: ProviderConfig,
  url: string,
  body: unknown,
  options: { signal?: AbortSignal; timeoutMs?: number },
): Promise<Record<string, unknown>> {
  return providerRequest(provider, url, body, options, false, async (resp, signal) => {
    const responseText = await resp.text();
    signal.throwIfAborted();
    return parseJSONBody(responseText);
  });
}

/** One server-sent event: its `event:` name (empty when it gave none) and its joined `data:` lines. */
export interface SSEEvent {
  event: string;
  data: string;
}

/**
 * A server-sent-events reader: text in as it arrives, whole events out.
 * Lines may end in \n, \r\n or \r, and a chunk may end anywhere — in the
 * middle of a line, or between the \r and \n of one line ending.
 */
export class SSEParser {
  private buffer = '';
  private data: string[] = [];
  private event = '';

  push(chunk: string): SSEEvent[] {
    this.buffer += chunk;
    const out: SSEEvent[] = [];
    for (;;) {
      const at = this.buffer.search(/[\r\n]/);
      if (at < 0) break;
      // A \r last in the buffer may be the first half of \r\n: wait for the next chunk.
      if (this.buffer[at] === '\r' && at === this.buffer.length - 1) break;
      const line = this.buffer.slice(0, at);
      this.buffer = this.buffer.slice(at + (this.buffer[at] === '\r' && this.buffer[at + 1] === '\n' ? 2 : 1));
      this.line(line, out);
    }
    return out;
  }

  /** The stream ended: whatever is left is the last event. */
  end(): SSEEvent[] {
    const out: SSEEvent[] = [];
    if (this.buffer) this.line(this.buffer.replace(/\r$/, ''), out);
    this.buffer = '';
    this.line('', out);
    return out;
  }

  private line(line: string, out: SSEEvent[]): void {
    if (line === '') {
      if (this.data.length > 0) out.push({ event: this.event, data: this.data.join('\n') });
      this.data = [];
      this.event = '';
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') this.data.push(value);
    else if (field === 'event') this.event = value;
  }
}

/**
 * POST a request that asks for a streamed reply, handing each server-sent
 * event to `onEvent` as it arrives. The clock here is an idle clock: it
 * restarts with every chunk, so a long reply that keeps arriving is never
 * cut off, and one that stalls is. A server that ignores `stream` and
 * answers with one JSON body is answered with that body (`streamed: false`).
 * A body that is neither is a stream fault (AIProviderError.streamFault),
 * which the caller answers by asking again without streaming.
 */
export async function postProviderStream(
  provider: ProviderConfig,
  url: string,
  body: unknown,
  options: { signal?: AbortSignal; timeoutMs?: number; onEvent(event: SSEEvent): void },
): Promise<{ streamed: true } | { streamed: false; data: Record<string, unknown> }> {
  return providerRequest(provider, url, body, options, true, async (resp, signal, touch) => {
    const type = resp.headers.get('content-type') ?? '';
    if (/json/i.test(type) && !/event-stream/i.test(type)) {
      const text = await resp.text();
      signal.throwIfAborted();
      return { streamed: false as const, data: parseJSONBody(text) };
    }
    if (!resp.body) throw new AIProviderError('invalid-response', 'The provider answered a streamed request with no body.', { streamFault: true });
    const reader = resp.body.getReader();
    const decoder = new TextDecoder('utf-8');
    const parser = new SSEParser();
    let events = 0;
    const cancel = () => void reader.cancel().catch(() => {});
    signal.addEventListener('abort', cancel, { once: true });
    let finished = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        signal.throwIfAborted();
        touch();
        if (done) break;
        // `stream: true` keeps a multi-byte character split across chunks whole.
        for (const event of parser.push(decoder.decode(value, { stream: true }))) {
          events++;
          options.onEvent(event);
        }
      }
      for (const event of [...parser.push(decoder.decode()), ...parser.end()]) {
        events++;
        options.onEvent(event);
      }
      finished = true;
    } finally {
      signal.removeEventListener('abort', cancel);
      if (!finished) cancel();
    }
    if (events === 0) throw new AIProviderError('invalid-response', 'The provider\'s streamed reply had no events.', { streamFault: true });
    return { streamed: true as const };
  });
}

function parseJSONBody(text: string): Record<string, unknown> {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new AIProviderError('invalid-response', 'AI response was not valid JSON');
  }
  if (!isRecord(data)) throw new AIProviderError('invalid-response', 'AI response was not an object');
  return data;
}

/**
 * The request both of the above make. `idle`: the clock restarts whenever
 * `touch` is called (a stream reports each chunk), instead of timing the
 * whole reply.
 */
async function providerRequest<T>(
  provider: ProviderConfig,
  url: string,
  body: unknown,
  options: { signal?: AbortSignal; timeoutMs?: number },
  idle: boolean,
  read: (resp: Response, signal: AbortSignal, touch: () => void) => Promise<T>,
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const headers = providerHeaders(provider, true);
  if (typeof window !== 'undefined' && isBlockedMixedContent(url, window.location.protocol)) {
    throw new AIProviderError('network', describeConnectionError('mixed-content', { type: provider.type, serverKind: provider.serverKind, url }));
  }

  // One signal for the fetch, aborted by whichever comes first: the caller
  // cancelling, or this request's own clock running out. Which one it was
  // is remembered here, because fetch reports both as the same AbortError.
  const controller = new AbortController();
  let timedOut = false;
  const expire = () => {
    timedOut = true;
    controller.abort();
  };
  let timer = setTimeout(expire, timeoutMs);
  const touch = () => {
    if (!idle || timedOut) return;
    clearTimeout(timer);
    timer = setTimeout(expire, timeoutMs);
  };
  const onCallerAbort = () => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener('abort', onCallerAbort, { once: true });
  }

  try {
    // Cancellation also covers downloading the body, not just receiving
    // headers. Local models often send headers long before their reply.
    controller.signal.throwIfAborted();
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const text = (await resp.text()).slice(0, 500);
      controller.signal.throwIfAborted();
      if (resp.status === 429) {
        const retryAfterMs = parseRetryAfter(resp.headers.get('retry-after'));
        throw new AIProviderError(
          'rate-limited',
          `The provider is rate-limiting requests${retryAfterMs !== undefined ? `; it asked for a wait of ${Math.ceil(retryAfterMs / 1000)} s` : ''}. ${text}`.trim(),
          { status: 429, retryAfterMs },
        );
      }
      const detail = providerMessage(text);
      throw new AIProviderError(
        'http',
        describeConnectionError(kindForStatus(resp.status), { type: provider.type, serverKind: provider.serverKind, url, detail }, resp.status),
        { status: resp.status, detail: detail ?? text },
      );
    }
    touch();
    return await read(resp, controller.signal, touch);
  } catch (err) {
    if (options.signal?.aborted) throw new AIProviderError('cancelled', 'The request was cancelled.');
    if (timedOut) {
      throw new AIProviderError('timeout', idle
        ? `The provider sent nothing for ${Math.round(timeoutMs / 1000)} s.`
        : `The provider did not finish its reply within ${Math.round(timeoutMs / 1000)} s.`);
    }
    if (err instanceof AIProviderError) throw err;
    const pageOrigin = typeof window !== 'undefined' ? window.location.origin : undefined;
    throw new AIProviderError('network', describeConnectionError('network', { type: provider.type, serverKind: provider.serverKind, url, pageOrigin }));
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onCallerAbort);
  }
}

/** The message in a provider's error body, or a short plain body, for showing. */
function providerMessage(text: string): string | undefined {
  try {
    const body: unknown = JSON.parse(text);
    const error = isRecord(body) ? body.error : undefined;
    const message = isRecord(error) ? error.message : typeof error === 'string' ? error : undefined;
    if (typeof message === 'string' && message.trim()) return message.trim().slice(0, 240);
  } catch {
    // Not JSON.
  }
  const plain = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return plain && plain.length <= 240 ? plain : undefined;
}

/** Whether a URL is OpenAI's own API. */
export function isOpenAIHost(url: string): boolean {
  try {
    return new URL(url).hostname === 'api.openai.com';
  } catch {
    return false;
  }
}

/**
 * The model a request would use: the caller's override, else the one saved
 * with the provider. Empty when neither is set — which is refused, never
 * filled in.
 */
export function resolveModel(provider: Pick<ProviderConfig, 'modelId'>, override?: string): string {
  return (override?.trim() || provider.modelId?.trim() || '');
}

function statusFor(stop: string | null, text: string, reasons: { truncated: string[]; refused: string[] }): AICompletionStatus {
  if (stop !== null && reasons.refused.includes(stop)) return 'refused';
  if (stop !== null && reasons.truncated.includes(stop)) return 'truncated';
  if (text.length === 0) return 'empty';
  return 'complete';
}

export type ProviderTestResult =
  | { ok: true; models: ModelInfo[]; replied: boolean; modelListed: boolean | null }
  | { ok: false; message: string; kind: string; models: ModelInfo[] | null };

/**
 * Test a provider the way generation will use it: list its models, then —
 * when a model is chosen — ask that model for a reply a few tokens long.
 * The list proves the address and the key; the reply proves the model id
 * is one the provider will serve to this key. A server with no model list
 * is still tested by the reply alone.
 */
export async function testProvider(
  provider: ProviderConfig,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ProviderTestResult> {
  let models: ModelInfo[] | null = null;
  try {
    models = await listModels(provider, { signal: options.signal });
  } catch (err) {
    const error = err instanceof ProviderConnectionError ? err : null;
    // A local server may serve chat without a model list; the reply below
    // is then the whole test. Anything else fails here.
    const listless = error && (provider.type === 'local' || provider.type === 'custom') && error.kind === 'not-found';
    if (!listless || !resolveModel(provider)) {
      return { ok: false, message: error?.message ?? String(err), kind: error?.kind ?? 'network', models: null };
    }
  }
  const model = resolveModel(provider);
  if (!model) return { ok: true, models: models ?? [], replied: false, modelListed: null };
  try {
    await sendAIRequest(provider, {
      system: 'This is a connection test. Reply with one word.',
      messages: [{ id: 'test', role: 'user', content: 'Say OK.', timestamp: 0 }],
      maxOutputTokens: 16,
      timeoutMs: options.timeoutMs ?? 60_000,
      signal: options.signal,
    });
  } catch (err) {
    const error = err instanceof AIProviderError ? err : null;
    return { ok: false, message: error?.message ?? String(err), kind: error?.kind ?? 'network', models };
  }
  return { ok: true, models: models ?? [], replied: true, modelListed: models && models.length > 0 ? models.some((m) => m.id === model) : null };
}
