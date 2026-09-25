/**
 * Streamed replies, read as they arrive: Anthropic's Messages events and the
 * OpenAI-compatible Chat Completions chunks (OpenAI, Ollama, LM Studio and
 * other servers that speak it). Each assembler takes the server-sent events
 * one by one, tells a sink what appeared — text, a tool call's name, a
 * fragment of its arguments — and at the end hands back the reply in the
 * same shape the non-streamed API returns, so one decoder (protocol.ts)
 * reads both and a streamed reply cannot be read differently from a whole one.
 *
 * Three kinds of trouble are kept apart. An event that is not JSON is a
 * fault in the stream itself (`streamFault`): the request is worth sending
 * again without streaming. An error event is the provider's own failure,
 * reported as any other. A stream that simply stops before its end is a
 * dropped connection (`network`), which pauses the run for Resume.
 */

import { AIProviderError, isRecord, type SSEEvent } from '../aiProvider';

/** Where a streamed reply's pieces go as they arrive. */
export interface StreamSink {
  text(delta: string): void;
  /** Reasoning the model shows (a thinking block, `reasoning_content`): not part of the reply's text. */
  thinking?(delta: string): void;
  /** A tool call began: its name is known. */
  toolStart(index: number, id: string, name: string): void;
  /** A fragment of a call's JSON arguments, exactly as it came. */
  toolArgs(index: number, delta: string): void;
}

function parseEvent(event: SSEEvent): Record<string, unknown> | null {
  const data = event.data.trim();
  if (data === '[DONE]') return null;
  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch {
    throw new AIProviderError('invalid-response', `The provider's stream carried an event that is not JSON: ${data.slice(0, 80)}`, { streamFault: true });
  }
  if (!isRecord(payload)) throw new AIProviderError('invalid-response', 'The provider\'s stream carried an event that is not an object.', { streamFault: true });
  return payload;
}

/** A provider's error, reported inside a stream that had already started. */
function streamError(error: unknown): AIProviderError {
  const record = isRecord(error) ? error : {};
  const type = typeof record.type === 'string' ? record.type : typeof record.code === 'string' ? record.code : '';
  const message = typeof record.message === 'string' && record.message ? record.message : typeof error === 'string' ? error : 'The provider reported an error mid-reply.';
  if (/overloaded|rate_limit/i.test(type)) return new AIProviderError('rate-limited', `The provider is overloaded: ${message}`);
  return new AIProviderError('http', `The provider stopped its reply with an error: ${message}`, { detail: message });
}

const closedEarly = () => new AIProviderError('network', 'The connection closed before the reply was complete.');

// ---------------------------------------------------------------------------
// Anthropic Messages
// ---------------------------------------------------------------------------

export class AnthropicStream {
  private blocks: Array<Record<string, unknown> | undefined> = [];
  private json = new Map<number, string>();
  private stopReason: string | null = null;
  private usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  private stopped = false;
  private delta = false;
  /** Per tool_use id, why its arguments could not be read. */
  readonly parseErrors = new Map<string, string>();

  constructor(private readonly sink?: StreamSink) {}

  accept(event: SSEEvent): void {
    const payload = parseEvent(event);
    if (!payload) return;
    const type = typeof payload.type === 'string' ? payload.type : event.event;
    const index = typeof payload.index === 'number' ? payload.index : -1;
    switch (type) {
      case 'message_start': {
        const message = isRecord(payload.message) ? payload.message : {};
        this.readUsage(message.usage);
        break;
      }
      case 'content_block_start': {
        const block: Record<string, unknown> = isRecord(payload.content_block) ? { ...payload.content_block } : { type: 'unknown' };
        if (block.type === 'tool_use') {
          block.input = {};
          this.json.set(index, '');
          this.sink?.toolStart(index, typeof block.id === 'string' ? block.id : '', typeof block.name === 'string' ? block.name : '');
        } else if (block.type === 'text') {
          block.text = typeof block.text === 'string' ? block.text : '';
          if (block.text) this.sink?.text(block.text as string);
        }
        this.blocks[index] = block;
        break;
      }
      case 'content_block_delta': {
        const block = this.blocks[index];
        const delta = isRecord(payload.delta) ? payload.delta : {};
        if (!block) break;
        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          block.text = `${typeof block.text === 'string' ? block.text : ''}${delta.text}`;
          this.sink?.text(delta.text);
        } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          this.json.set(index, (this.json.get(index) ?? '') + delta.partial_json);
          this.sink?.toolArgs(index, delta.partial_json);
        } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          block.thinking = `${typeof block.thinking === 'string' ? block.thinking : ''}${delta.thinking}`;
          this.sink?.thinking?.(delta.thinking);
        } else if (delta.type === 'signature_delta' && typeof delta.signature === 'string') {
          block.signature = `${typeof block.signature === 'string' ? block.signature : ''}${delta.signature}`;
        }
        break;
      }
      case 'content_block_stop': {
        const block = this.blocks[index];
        if (block?.type === 'tool_use') {
          const raw = (this.json.get(index) ?? '').trim();
          try {
            const input: unknown = raw ? JSON.parse(raw) : {};
            block.input = isRecord(input) ? input : {};
          } catch (err) {
            block.input = {};
            this.parseErrors.set(String(block.id), `The arguments were not valid JSON (${err instanceof Error ? err.message : String(err)}). Send the call again with a JSON object.`);
          }
        }
        break;
      }
      case 'message_delta': {
        const delta = isRecord(payload.delta) ? payload.delta : {};
        if (typeof delta.stop_reason === 'string') this.stopReason = delta.stop_reason;
        this.readUsage(payload.usage);
        this.delta = true;
        break;
      }
      case 'message_stop':
        this.stopped = true;
        break;
      case 'error':
        throw streamError(payload.error);
      default:
        // ping, and event types added after this was written.
        break;
    }
  }

  /** The reply as the non-streamed API returns it. */
  result(): Record<string, unknown> {
    if (!this.stopped && !this.delta) throw closedEarly();
    return {
      type: 'message',
      role: 'assistant',
      content: this.blocks.filter((b): b is Record<string, unknown> => b !== undefined),
      stop_reason: this.stopReason,
      usage: { ...this.usage },
    };
  }

  private readUsage(usage: unknown): void {
    if (!isRecord(usage)) return;
    // output_tokens in message_delta is the running total, not an increment.
    // The cache counts come in message_start, and again (the same totals) in a later message_delta.
    for (const key of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'] as const) {
      if (typeof usage[key] === 'number') this.usage[key] = usage[key];
    }
  }
}

// ---------------------------------------------------------------------------
// OpenAI-compatible Chat Completions
// ---------------------------------------------------------------------------

interface CallInProgress {
  id: string;
  name: string;
  args: string;
  announced: boolean;
}

export class OpenAIStream {
  private text = '';
  private refusal = '';
  private calls: CallInProgress[] = [];
  private finishReason: string | null = null;
  private usage: Record<string, unknown> | null = null;
  private done = false;
  private lastIndex = -1;

  constructor(private readonly sink?: StreamSink) {}

  accept(event: SSEEvent): void {
    const payload = parseEvent(event);
    if (!payload) {
      this.done = true;
      return;
    }
    if (payload.error !== undefined) throw streamError(payload.error);
    // The usage chunk (stream_options.include_usage) has an empty choices list.
    if (isRecord(payload.usage)) this.usage = payload.usage;
    const choice = Array.isArray(payload.choices) ? payload.choices.find((c) => isRecord(c) && (c.index === undefined || c.index === 0)) : undefined;
    if (!isRecord(choice)) return;
    const delta = isRecord(choice.delta) ? choice.delta : isRecord(choice.message) ? choice.message : {};
    if (typeof delta.content === 'string' && delta.content) {
      this.text += delta.content;
      this.sink?.text(delta.content);
    }
    if (typeof delta.refusal === 'string') this.refusal += delta.refusal;
    const reasoning = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : typeof delta.reasoning === 'string' ? delta.reasoning : '';
    if (reasoning) this.sink?.thinking?.(reasoning);
    if (Array.isArray(delta.tool_calls)) {
      for (const raw of delta.tool_calls) if (isRecord(raw)) this.readCall(raw);
    }
    if (typeof choice.finish_reason === 'string' && choice.finish_reason) this.finishReason = choice.finish_reason;
  }

  private readCall(raw: Record<string, unknown>): void {
    const id = typeof raw.id === 'string' ? raw.id : '';
    // Calls are told apart by `index`. A server that leaves it out sends each
    // call whole, or continues the last one: a new id is a new call.
    let index = typeof raw.index === 'number' ? raw.index : -1;
    if (index < 0) index = id && !this.calls.some((c) => c.id === id) ? this.calls.length : Math.max(this.lastIndex, 0);
    this.lastIndex = index;
    const call = (this.calls[index] ??= { id: '', name: '', args: '', announced: false });
    if (id) call.id = id;
    const fn = isRecord(raw.function) ? raw.function : {};
    // A name arrives whole, in the call's first fragment; later fragments carry arguments only.
    if (typeof fn.name === 'string' && fn.name && !call.name) call.name = fn.name;
    if (!call.announced && call.name) {
      call.announced = true;
      this.sink?.toolStart(index, call.id, call.name);
    }
    if (typeof fn.arguments === 'string' && fn.arguments) {
      call.args += fn.arguments;
      this.sink?.toolArgs(index, fn.arguments);
    } else if (isRecord(fn.arguments)) {
      const whole = JSON.stringify(fn.arguments);
      call.args = whole;
      this.sink?.toolArgs(index, whole);
    }
  }

  /** The reply as the non-streamed API returns it. */
  result(): Record<string, unknown> {
    if (!this.done && this.finishReason === null) throw closedEarly();
    const calls = this.calls.filter((c) => c && c.name);
    return {
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: this.text,
            ...(this.refusal ? { refusal: this.refusal } : {}),
            ...(calls.length > 0 ? { tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args } })) } : {}),
          },
          finish_reason: this.finishReason,
        },
      ],
      ...(this.usage ? { usage: this.usage } : {}),
    };
  }
}

/**
 * The text a live view shows of a reply that calls tools as text: the reply
 * with its <tool_call> blocks taken out — including one still being
 * written — and the names of the calls begun so far, in order.
 */
export function liveTextCalls(raw: string): { text: string; calls: Array<{ name: string; body: string }> } {
  const calls: Array<{ name: string; body: string }> = [];
  const opening = /<tool_call\s+name\s*=\s*["']([A-Za-z_][\w-]*)["']\s*>/g;
  let match: RegExpExecArray | null;
  while ((match = opening.exec(raw)) !== null) {
    const rest = raw.slice(match.index + match[0].length);
    const close = rest.search(/<\/tool_call\s*>/);
    calls.push({ name: match[1], body: close < 0 ? rest : rest.slice(0, close) });
  }
  let text = raw.replace(/<tool_call[\s\S]*?(<\/tool_call\s*>|$)/g, '');
  // A tag still being written ("<tool_c") is not text yet.
  text = text.replace(/<[A-Za-z_/][^>]*$/, '');
  return { text: text.replace(/\n{3,}/g, '\n\n').trim(), calls };
}

/**
 * What a call in progress is about — its path, name, page or topic — read
 * from arguments that may still be arriving: a JSON fragment, or the text
 * protocol's <arg> elements. Only a value that is already complete is read.
 */
export function liveSubject(args: string): string {
  const json = /"(path|from|name|page|topic|question)"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(args);
  if (json) {
    try {
      return String(JSON.parse(`"${json[2]}"`)).slice(0, 120);
    } catch {
      return json[2].slice(0, 120);
    }
  }
  const arg = /<arg\s+name\s*=\s*["'](path|from|name|page|topic|question)["']\s*>\s*([^<\n]+?)\s*<\/arg/.exec(args);
  return arg ? arg[2].slice(0, 120) : '';
}
