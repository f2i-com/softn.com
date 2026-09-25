/**
 * How a run's conversation reaches a provider and how its reply comes back:
 * Anthropic's Messages API with `tools`, the OpenAI-compatible Chat
 * Completions API with `tools`, the hosted editor's bridge with `tools` (when
 * the host announced `aiTools`), and a text protocol for a provider, model or
 * host that carries none of them. Replies from the two HTTP APIs stream when
 * asked (stream.ts), and are read by the same decoders either way.
 *
 * Nothing here reads a store. The loop hands over the turns and the protocol
 * and gets back text and calls in the agent's own shape (types.ts).
 */

import {
  HostedAIError,
  hostedAIToolsVersion,
  isHostedEditor,
  requestHostedAI,
  requestHostedAIReply,
  type HostedAIMessage,
  type HostedAIReply,
} from '@softn/editor-shared/hostedEditor';
import type { ProviderConfig } from '../../types/studio';
import { AIProviderError, isOpenAIHost, isRecord, postProviderJSON, postProviderStream, sanitizeCount } from '../aiProvider';
import { providerEndpoints } from '../providerConnection';
import { AnthropicStream, OpenAIStream, type StreamSink } from './stream';
import { AGENT_TOOLS, anthropicTools, openAITools, TOOL_NAMES } from './tools';
import type { AgentToolCall, AgentTurn, ToolProtocol } from './types';

/**
 * How a request is streamed: `on` asks for a stream with usage in its last
 * event (`stream_options.include_usage` on the OpenAI-compatible API), `plain`
 * asks for a stream without that option (a server that refused it), `off`
 * asks for one whole reply (a server whose stream was refused or unreadable).
 */
export type StreamMode = 'on' | 'plain' | 'off';

export interface AgentRequest {
  system: string;
  turns: AgentTurn[];
  protocol: ToolProtocol;
  model: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputTokens: number;
  /** Default `off`. */
  stream?: StreamMode;
  /** Where a streamed reply's pieces go as they arrive. */
  sink?: StreamSink;
}

/**
 * What a request cost, the same way whatever the provider: `inputTokens` is
 * the whole prompt, and the cache counts are parts of it — read from the
 * provider's prompt cache, or written to it. (Anthropic reports the three
 * apart and its `input_tokens` excludes both; the OpenAI-compatible API
 * reports the whole prompt with the cached part inside it.)
 */
export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface AgentReply {
  text: string;
  calls: AgentToolCall[];
  status: 'complete' | 'truncated' | 'refused' | 'empty';
  stopReason: string | null;
  usage: AgentUsage;
  /** An Anthropic reply's content, to echo back unchanged. */
  anthropicContent?: unknown[];
  /** The native reply wrote its calls as text: the run should move to the text protocol. */
  wroteCallsAsText?: boolean;
}

/** Whether Studio is the hosted editor and this is the host's own provider. */
function isHosted(provider: Pick<ProviderConfig, 'id'>): boolean {
  return isHostedEditor() && provider.id === 'formlogic';
}

/**
 * The protocol a provider speaks natively, before anything is learned about
 * the model. The hosted editor's bridge carries tool calls only when the
 * host announced it can (`aiTools`); otherwise it carries text.
 */
export function nativeProtocol(provider: Pick<ProviderConfig, 'type' | 'id'>): ToolProtocol {
  if (isHosted(provider)) return hostedAIToolsVersion() >= 1 ? 'hosted' : 'text';
  return provider.type === 'anthropic' ? 'anthropic' : 'openai';
}

/** Whether a reply can stream at all on this provider: the hosted bridge answers whole. */
export function canStream(provider: Pick<ProviderConfig, 'id'>): boolean {
  return !isHosted(provider);
}

/**
 * Whether a failure is the provider refusing the `tools` field itself —
 * a model or server without tool support — rather than anything else a 400
 * can mean. Read from the provider's own words.
 */
export function isToolsRejection(err: unknown): boolean {
  if (!(err instanceof AIProviderError) || err.kind !== 'http') return false;
  if (err.status !== undefined && ![400, 404, 422, 500, 501].includes(err.status)) return false;
  const words = `${err.detail ?? ''} ${err.message}`;
  return /\b(tools?|tool_choice|tool[_ ]calls?|function[_ ]?call(ing|s)?|functions)\b/i.test(words) &&
    /(not support|unsupported|does not|doesn't|unknown|unrecognized|unexpected|invalid|not allowed|not available|extra (inputs|fields))/i.test(words);
}

/**
 * What to do after a streamed request failed: `plain` when the server refused
 * only `stream_options`, `off` when it refused streaming or sent a stream
 * that could not be read, null when the failure has nothing to do with
 * streaming. Checked before isToolsRejection: "streaming is not supported
 * with tools" is answered by not streaming, not by giving up native tools.
 */
export function streamFallback(err: unknown): 'plain' | 'off' | null {
  if (!(err instanceof AIProviderError)) return null;
  if (err.streamFault) return 'off';
  if (err.kind !== 'http' || (err.status !== undefined && ![400, 404, 422, 500, 501].includes(err.status))) return null;
  const words = `${err.detail ?? ''} ${err.message}`;
  if (!/(not support|unsupported|does not|doesn't|unknown|unrecognized|unexpected|invalid|not allowed|not available|extra (inputs|fields)|not permitted)/i.test(words)) return null;
  if (/\bstream_options\b|\binclude_usage\b/i.test(words)) return 'plain';
  if (/\bstream(ing)?\b/i.test(words)) return 'off';
  return null;
}

export async function sendAgentRequest(provider: ProviderConfig, request: AgentRequest): Promise<AgentReply> {
  if (isHosted(provider)) return sendHosted(request);
  const url = providerEndpoints(provider).chat;
  const protocol = request.protocol;
  const anthropicWire = provider.type === 'anthropic';
  const outputCap = isOpenAIHost(url) ? { max_completion_tokens: request.maxOutputTokens } : { max_tokens: request.maxOutputTokens };

  let body: Record<string, unknown>;
  if (protocol === 'anthropic') {
    body = { model: request.model, max_tokens: request.maxOutputTokens, system: cachedSystem(request.system), tools: cachedTools(anthropicTools()), messages: withCacheBreakpoints(encodeAnthropic(request.turns)) };
  } else if (protocol === 'openai') {
    body = { model: request.model, ...outputCap, tools: openAITools(), messages: [{ role: 'system', content: request.system }, ...encodeOpenAI(request.turns)] };
  } else if (anthropicWire) {
    // Text protocol over the provider's plain chat shape.
    body = { model: request.model, max_tokens: request.maxOutputTokens, system: cachedSystem(request.system), messages: withCacheBreakpoints(encodeText(request.turns)) };
  } else {
    body = { model: request.model, ...outputCap, messages: [{ role: 'system', content: request.system }, ...encodeText(request.turns)] };
  }

  const { data, parseErrors } = await post(provider, url, body, request, anthropicWire);
  const reply = anthropicWire ? decodeAnthropic(data, parseErrors) : decodeOpenAI(data);
  return protocol === 'text' ? withTextCalls(reply) : reply;
}

/** Send `body`, streamed when the request asks for it, and answer the reply in the non-streamed shape. */
async function post(
  provider: ProviderConfig,
  url: string,
  body: Record<string, unknown>,
  request: AgentRequest,
  anthropicWire: boolean,
): Promise<{ data: Record<string, unknown>; parseErrors?: Map<string, string> }> {
  const mode = request.stream ?? 'off';
  if (mode === 'off') return { data: await postProviderJSON(provider, url, body, { signal: request.signal, timeoutMs: request.timeoutMs }) };
  const streamed = { ...body, stream: true, ...(!anthropicWire && mode === 'on' ? { stream_options: { include_usage: true } } : {}) };
  if (anthropicWire) {
    const assembler = new AnthropicStream(request.sink);
    const result = await postProviderStream(provider, url, streamed, { signal: request.signal, timeoutMs: request.timeoutMs, onEvent: (e) => assembler.accept(e) });
    return result.streamed ? { data: assembler.result(), parseErrors: assembler.parseErrors } : { data: result.data };
  }
  const assembler = new OpenAIStream(request.sink);
  const result = await postProviderStream(provider, url, streamed, { signal: request.signal, timeoutMs: request.timeoutMs, onEvent: (e) => assembler.accept(e) });
  return { data: result.streamed ? assembler.result() : result.data };
}

// ---------------------------------------------------------------------------
// The hosted editor's bridge
// ---------------------------------------------------------------------------

async function sendHosted(request: AgentRequest): Promise<AgentReply> {
  try {
    if (request.protocol !== 'hosted') {
      const content = await requestHostedAI([{ role: 'system', content: request.system }, ...encodeText(request.turns)], request.signal);
      return withTextCalls({ text: content, calls: [], status: content.trim() ? 'complete' : 'empty', stopReason: null, usage: { inputTokens: 0, outputTokens: 0 } });
    }
    const reply = await requestHostedAIReply(
      {
        messages: [{ role: 'system', content: request.system }, ...encodeHosted(request.turns)],
        tools: AGENT_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        maxOutputTokens: request.maxOutputTokens,
      },
      request.signal,
    );
    // A plain string back means the host passed the request on without its
    // tools: say so the way a provider would, and the run carries on in text.
    if (!reply.structured) throw new AIProviderError('http', 'FormLogic answered without tool calls: tools are not supported by its AI provider.', { detail: 'tools not supported' });
    return decodeHosted(reply);
  } catch (error) {
    if (error instanceof AIProviderError) throw error;
    if (request.signal?.aborted) throw new AIProviderError('cancelled', 'The request was cancelled.');
    if (error instanceof HostedAIError && error.code === 'tools-unsupported') {
      throw new AIProviderError('http', error.message, { detail: 'tools not supported' });
    }
    throw new AIProviderError('network', error instanceof Error ? error.message : 'FormLogic AI request failed.');
  }
}

/** The conversation in the bridge's neutral shape: assistant tool calls and tool results as they are. */
export function encodeHosted(turns: AgentTurn[]): HostedAIMessage[] {
  const out: HostedAIMessage[] = [];
  for (const turn of turns) {
    if (turn.role === 'user') out.push({ role: 'user', content: turn.text });
    else if (turn.role === 'tool') {
      for (const r of turn.results) out.push({ role: 'tool', toolCallId: r.id, name: r.name, content: r.content, ...(r.isError ? { isError: true } : {}) });
    } else {
      if (!turn.text && turn.calls.length === 0) continue;
      out.push({ role: 'assistant', content: turn.text, ...(turn.calls.length > 0 ? { toolCalls: turn.calls.map((c) => ({ id: c.id, name: c.name, arguments: c.input })) } : {}) });
    }
  }
  return out;
}

export function decodeHosted(reply: HostedAIReply): AgentReply {
  const calls: AgentToolCall[] = reply.toolCalls.map((call) => {
    if (typeof call.arguments !== 'string') return { id: call.id, name: call.name, input: call.arguments };
    try {
      const parsed: unknown = call.arguments.trim() ? JSON.parse(call.arguments) : {};
      return { id: call.id, name: call.name, input: isRecord(parsed) ? parsed : {} };
    } catch (err) {
      return { id: call.id, name: call.name, input: {}, parseError: `The arguments were not valid JSON (${err instanceof Error ? err.message : String(err)}). Send the call again with a JSON object.` };
    }
  });
  const stop = reply.stopReason;
  return markTextCalls({
    text: reply.text,
    calls,
    status: stop === 'refusal' || stop === 'content_filter' ? 'refused' : stop === 'max_tokens' || stop === 'length' ? 'truncated' : reply.text.length === 0 && calls.length === 0 ? 'empty' : 'complete',
    stopReason: stop,
    usage: reply.usage ?? { inputTokens: 0, outputTokens: 0 },
  });
}

function withTextCalls(reply: AgentReply): AgentReply {
  const parsed = parseTextToolCalls(reply.text);
  return { ...reply, text: parsed.text, calls: parsed.calls, status: reply.status === 'empty' && parsed.calls.length > 0 ? 'complete' : reply.status };
}

// ---------------------------------------------------------------------------
// Anthropic Messages API
// ---------------------------------------------------------------------------

type AnthropicMessage = { role: 'user' | 'assistant'; content: string | unknown[] };

/**
 * Prompt caching. Every request of a run repeats the one before it and adds a
 * step, so the prefix — tools, then the system prompt, then the conversation
 * so far — is marked with cache_control breakpoints and each request pays
 * cache-read rates for what the last one already sent. Four breakpoints, the
 * most a request may carry: the tools, the system prompt (the same across
 * runs; see prompt.ts), the last message of the previous request (what this
 * request is sure to find cached), and this request's last message (what the
 * next one will find). The loop keeps the conversation append-only between
 * compactions (runAgent.ts) so the prefix really does repeat byte for byte.
 */
const EPHEMERAL = { type: 'ephemeral' } as const;

export function cachedSystem(system: string): unknown[] {
  return [{ type: 'text', text: system, cache_control: EPHEMERAL }];
}

function cachedTools<T extends object>(tools: T[]): T[] {
  return tools.map((tool, i) => (i === tools.length - 1 ? { ...tool, cache_control: EPHEMERAL } : tool));
}

/** Mark a message's last block. The block is copied: an echoed reply's blocks are the run's own record. */
function markLast(message: AnthropicMessage): AnthropicMessage {
  const blocks: unknown[] = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
  if (blocks.length === 0) return message;
  const last = blocks[blocks.length - 1];
  if (!isRecord(last) || (last.type === 'text' && !last.text)) return message;
  return { ...message, content: [...blocks.slice(0, -1), { ...last, cache_control: EPHEMERAL }] };
}

/**
 * The conversation with its two message breakpoints: the last message, and
 * the last person-side message before the latest reply — the end of what the
 * previous request sent.
 */
export function withCacheBreakpoints(messages: AnthropicMessage[]): AnthropicMessage[] {
  // One shape for every message, marked or not, so a message reads the same from request to request.
  const out = messages.map((m) => (typeof m.content === 'string' ? { ...m, content: [{ type: 'text', text: m.content }] } : m));
  const last = out.length - 1;
  if (last < 0) return out;
  if (out[last].role === 'user') out[last] = markLast(out[last]);
  let previous = -1;
  for (let i = last - 1; i >= 0; i--) {
    if (out[i].role === 'assistant') {
      for (let j = i - 1; j >= 0; j--) {
        if (out[j].role === 'user') {
          previous = j;
          break;
        }
      }
      break;
    }
  }
  if (previous >= 0) out[previous] = markLast(out[previous]);
  return out;
}

export function encodeAnthropic(turns: AgentTurn[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];
  const pushUser = (blocks: unknown[]) => {
    const last = out[out.length - 1];
    // Consecutive user content is one message: tool results first, then any text.
    if (last && last.role === 'user') {
      const existing = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content;
      last.content = [...existing, ...blocks];
    } else {
      out.push({ role: 'user', content: blocks });
    }
  };
  for (const turn of turns) {
    if (turn.role === 'user') {
      pushUser([{ type: 'text', text: turn.text }]);
    } else if (turn.role === 'tool') {
      pushUser(turn.results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.content, ...(r.isError ? { is_error: true } : {}) })));
    } else {
      const content: unknown[] = turn.anthropicContent ?? [
        ...(turn.text ? [{ type: 'text', text: turn.text }] : []),
        ...turn.calls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.input })),
      ];
      if (content.length === 0) continue;
      out.push({ role: 'assistant', content });
    }
  }
  return out;
}

/** Anthropic's usage, whose input_tokens leaves out what was read from or written to the cache. */
export function anthropicUsage(usage: Record<string, unknown>): AgentUsage {
  const read = sanitizeCount(usage.cache_read_input_tokens);
  const write = sanitizeCount(usage.cache_creation_input_tokens);
  return {
    inputTokens: sanitizeCount(usage.input_tokens) + read + write,
    outputTokens: sanitizeCount(usage.output_tokens),
    ...(read > 0 ? { cacheReadTokens: read } : {}),
    ...(write > 0 ? { cacheWriteTokens: write } : {}),
  };
}

/**
 * The OpenAI-compatible usage, whose prompt_tokens includes the cached part:
 * `prompt_tokens_details.cached_tokens` (OpenAI, and servers that copy it),
 * or `prompt_cache_hit_tokens` (servers that name it so).
 */
export function openAIUsage(usage: Record<string, unknown>): AgentUsage {
  const details = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {};
  const input = sanitizeCount(usage.prompt_tokens);
  const read = Math.min(input, sanitizeCount(details.cached_tokens) || sanitizeCount(usage.prompt_cache_hit_tokens));
  return { inputTokens: input, outputTokens: sanitizeCount(usage.completion_tokens), ...(read > 0 ? { cacheReadTokens: read } : {}) };
}

/** `parseErrors`: per tool_use id, why a streamed call's arguments could not be read. */
export function decodeAnthropic(data: Record<string, unknown>, parseErrors?: Map<string, string>): AgentReply {
  const blocks = Array.isArray(data.content) ? data.content : [];
  const texts: string[] = [];
  const calls: AgentToolCall[] = [];
  for (const block of blocks) {
    if (!isRecord(block)) continue;
    if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
    if (block.type === 'tool_use' && typeof block.name === 'string') {
      const id = typeof block.id === 'string' ? block.id : `call_${calls.length}`;
      const parseError = parseErrors?.get(id);
      calls.push({ id, name: block.name, input: isRecord(block.input) ? block.input : {}, ...(parseError ? { parseError } : {}) });
    }
  }
  const stopReason = typeof data.stop_reason === 'string' ? data.stop_reason : null;
  const usage = isRecord(data.usage) ? data.usage : {};
  const text = texts.join('');
  const reply: AgentReply = {
    text,
    calls,
    status: stopReason === 'refusal' ? 'refused' : stopReason === 'max_tokens' ? 'truncated' : text.length === 0 && calls.length === 0 ? 'empty' : 'complete',
    stopReason,
    usage: anthropicUsage(usage),
    anthropicContent: blocks,
  };
  return markTextCalls(reply);
}

// ---------------------------------------------------------------------------
// OpenAI-compatible Chat Completions
// ---------------------------------------------------------------------------

export function encodeOpenAI(turns: AgentTurn[]): unknown[] {
  const out: unknown[] = [];
  for (const turn of turns) {
    if (turn.role === 'user') out.push({ role: 'user', content: turn.text });
    else if (turn.role === 'tool') {
      for (const r of turn.results) out.push({ role: 'tool', tool_call_id: r.id, content: r.isError ? `Error: ${r.content}` : r.content });
    } else {
      if (!turn.text && turn.calls.length === 0) continue;
      out.push({
        role: 'assistant',
        content: turn.text || null,
        ...(turn.calls.length > 0
          ? { tool_calls: turn.calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input) } })) }
          : {}),
      });
    }
  }
  return out;
}

export function decodeOpenAI(data: Record<string, unknown>): AgentReply {
  const choice = Array.isArray(data.choices) && isRecord(data.choices[0]) ? data.choices[0] : {};
  const message = isRecord(choice.message) ? choice.message : {};
  const text = typeof message.content === 'string'
    ? message.content
    : Array.isArray(message.content)
      ? message.content.map((b) => (isRecord(b) && typeof b.text === 'string' ? b.text : '')).join('')
      : '';
  const calls: AgentToolCall[] = [];
  if (Array.isArray(message.tool_calls)) {
    for (const [index, raw] of message.tool_calls.entries()) {
      if (!isRecord(raw)) continue;
      const fn = isRecord(raw.function) ? raw.function : {};
      const name = typeof fn.name === 'string' ? fn.name : '';
      const id = typeof raw.id === 'string' && raw.id ? raw.id : `call_${index}`;
      const args = fn.arguments;
      if (isRecord(args)) {
        calls.push({ id, name, input: args });
        continue;
      }
      try {
        const parsed: unknown = typeof args === 'string' && args.trim() ? JSON.parse(args) : {};
        calls.push({ id, name, input: isRecord(parsed) ? parsed : {} });
      } catch (err) {
        calls.push({ id, name, input: {}, parseError: `The arguments were not valid JSON (${err instanceof Error ? err.message : String(err)}). Send the call again with a JSON object.` });
      }
    }
  }
  const finishReason = typeof choice.finish_reason === 'string' ? choice.finish_reason : null;
  const refused = typeof message.refusal === 'string' && message.refusal.length > 0;
  const usage = isRecord(data.usage) ? data.usage : {};
  const reply: AgentReply = {
    text,
    calls,
    status: refused || finishReason === 'content_filter' ? 'refused' : finishReason === 'length' ? 'truncated' : text.length === 0 && calls.length === 0 ? 'empty' : 'complete',
    stopReason: finishReason,
    usage: openAIUsage(usage),
  };
  return markTextCalls(reply);
}

/** A native reply with no calls whose text is full of text-protocol calls: the model does not use `tools`. */
function markTextCalls(reply: AgentReply): AgentReply {
  if (reply.calls.length > 0) return reply;
  if (/<tool_call\s+name=/i.test(reply.text) || /<softn-file\s+path=/i.test(reply.text)) return { ...reply, wroteCallsAsText: true };
  return reply;
}

// ---------------------------------------------------------------------------
// The text protocol
// ---------------------------------------------------------------------------

export function encodeText(turns: AgentTurn[]): Array<{ role: 'user' | 'assistant'; content: string }> {
  const out: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  const push = (role: 'user' | 'assistant', content: string) => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.content = `${last.content}\n\n${content}`;
    else out.push({ role, content });
  };
  for (const turn of turns) {
    if (turn.role === 'user') push('user', turn.text);
    else if (turn.role === 'tool') {
      push('user', turn.results.map((r) => `<tool_result name="${r.name}" status="${r.isError ? 'error' : 'ok'}">\n${r.content}\n</tool_result>`).join('\n\n'));
    } else {
      const calls = turn.calls.map((c) => `<tool_call name="${c.name}">\n${JSON.stringify(c.input)}\n</tool_call>`);
      const content = [turn.text, ...calls].filter(Boolean).join('\n\n');
      if (content) push('assistant', content);
    }
  }
  // A conversation must start with the person.
  if (out[0]?.role === 'assistant') out.unshift({ role: 'user', content: 'Continue.' });
  return out;
}

let textCallCounter = 0;

/**
 * Every `<tool_call>` block in a reply, in order, and the reply's text with
 * the blocks removed. The `<arg>` form is read with the next `<arg` or
 * `</tool_call>` as the end of a value, so a value that itself contains the
 * text `</arg>` survives; a JSON body is read as JSON, fenced or not. A
 * block that cannot be read is still a call — answered with why — so the
 * model is told rather than ignored.
 */
export function parseTextToolCalls(raw: string): { text: string; calls: AgentToolCall[] } {
  const calls: AgentToolCall[] = [];
  // A block, or the self-closing form some models write (`<tool_call name="list_files" prefix="ui/" />`);
  // either may carry arguments as attributes.
  const blockRe = /<tool_call\s+name\s*=\s*["']([A-Za-z_][\w-]*)["']((?:\s+[A-Za-z_][\w-]*\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(?:\/>|>([\s\S]*?)<\/tool_call\s*>)/g;
  let text = raw;
  let match: RegExpExecArray | null;
  while ((match = blockRe.exec(raw)) !== null) {
    // Every block read leaves the text, however its body turns out: a call
    // left in the text would be shown, and sent back, twice.
    text = text.replace(match[0], '');
    const name = match[1];
    const body = match[3] ?? '';
    const id = `call_t${++textCallCounter}`;
    const attributes = parseAttributes(name, match[2]);
    if (/<arg\s+name\s*=/.test(body)) {
      calls.push({ id, name, input: { ...attributes, ...parseArgs(name, body) } });
      continue;
    }
    const json = body.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    if (!json) {
      calls.push({ id, name, input: attributes });
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(json);
      calls.push({ id, name, input: { ...attributes, ...(isRecord(parsed) ? parsed : {}) } });
    } catch (err) {
      calls.push({ id, name, input: {}, parseError: `The call's body was neither <arg> elements nor a JSON object (${err instanceof Error ? err.message : String(err)}).` });
    }
  }
  // The single-shot format, from a model that learned it: a file block is a write.
  const fileRe = /<softn-file\s+path="([^"]+)">([\s\S]*?)<\/softn-file>/g;
  while ((match = fileRe.exec(raw)) !== null) {
    calls.push({ id: `call_t${++textCallCounter}`, name: 'write_file', input: { path: match[1].trim(), content: match[2].replace(/^\n/, '').replace(/\n$/, '') } });
    text = text.replace(match[0], '');
  }
  // A result the model wrote itself is not a result.
  text = text.replace(/<tool_result[\s\S]*?<\/tool_result>/g, '').replace(/\n{3,}/g, '\n\n').trim();
  return { text, calls };
}

/** Arguments written as attributes of the call's tag, typed by the schema. */
function parseAttributes(tool: string, raw: string | undefined): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const m of (raw ?? '').matchAll(/([A-Za-z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    input[m[1]] = coerce(tool, m[1], (m[2] ?? m[3]).replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
  }
  return input;
}

function parseArgs(tool: string, body: string): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  const starts = [...body.matchAll(/<arg\s+name\s*=\s*["']([A-Za-z_][\w-]*)["']\s*>/g)];
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i];
    const from = start.index + start[0].length;
    const to = i + 1 < starts.length ? starts[i + 1].index : body.length;
    let value = body.slice(from, to);
    value = value.replace(/\s*$/, '');
    value = value.replace(/<\/arg\s*>$/, '');
    // One newline straight after the tag and before the close is formatting.
    value = value.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
    input[start[1]] = coerce(tool, start[1], value);
  }
  return input;
}

/** A raw `<arg>` value as the schema's type, when the schema says it is not a string. */
function coerce(tool: string, name: string, value: string): unknown {
  if (!TOOL_NAMES.has(tool)) return value;
  const type = argType(tool, name);
  if (type === 'string' || type === undefined) return value;
  const trimmed = value.trim();
  if (type === 'boolean') return trimmed === 'true';
  if (type === 'integer' || type === 'number') {
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : value;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}


function argType(tool: string, name: string): string | undefined {
  return AGENT_TOOLS.find((t) => t.name === tool)?.inputSchema.properties[name]?.type;
}
