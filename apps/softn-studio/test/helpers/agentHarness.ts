/**
 * Scripted fake providers for agent runs: `fetch` answers each request with
 * the next step of a script, in the wire shape of the protocol under test —
 * Anthropic Messages with tool_use blocks, OpenAI-compatible Chat Completions
 * with tool_calls, or plain text carrying <tool_call> blocks — so a run
 * exercises the real protocol code, not a mock of it. Every request body is
 * kept for assertions.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { vi } from 'vitest';
import { configureZippWasmSource } from '@softn/core';
import { useAIStore } from '../../src/stores/aiStore';
import { useVFSStore } from '../../src/stores/vfsStore';
import { useWorkspaceStore } from '../../src/stores/workspaceStore';
import { discardAgentRuns, setAgentEnvironment, setAgentSleep } from '../../src/lib/agent/runAgent';
import { browserEnvironment, type AgentEnvironment } from '../../src/lib/agent/appCheck';
import type { ProviderConfig } from '../../src/types/studio';

export type Call = { name: string; input: Record<string, unknown> };

export interface Step {
  text?: string;
  calls?: Call[];
  /** Override the stop reason (e.g. 'max_tokens' to cut a reply). */
  stop?: string;
  /** `input` is the prompt read afresh; `cacheRead`/`cacheWrite` the parts read from and written to the provider's cache. */
  usage?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  /** Answer with an HTTP error instead. */
  error?: { status: number; body: unknown; headers?: Record<string, string> };
  /** Reject the fetch itself, as a dropped connection does. */
  networkError?: boolean;
  /** Answer a streamed request with one JSON body, as a server that ignores `stream` does. */
  noStream?: boolean;
}

export type Script = Array<Step | ((body: Record<string, unknown>) => Step)>;

export interface FakeProvider {
  bodies: Array<Record<string, unknown>>;
  /** Requests answered so far. */
  count(): number;
  /** Hold the next response until release() is called. */
  hold(): { release(): void };
}

type Shape = 'anthropic' | 'openai' | 'text-openai' | 'text-anthropic';

let callCounter = 0;

/** Assertions that failed inside a script step: surfaced by assertScriptsPassed, not lost as a "network error". */
const scriptFailures: unknown[] = [];

export function assertScriptsPassed(): void {
  const failures = scriptFailures.splice(0);
  if (failures.length > 0) throw failures[0];
}

function textCall(call: Call): string {
  return `<tool_call name="${call.name}">\n${JSON.stringify(call.input)}\n</tool_call>`;
}

function respond(shape: Shape, step: Step): Record<string, unknown> {
  const usage = step.usage ?? { input: 100, output: 20 };
  // Anthropic reports the three parts apart; the OpenAI-compatible API reports the whole prompt with the cached part inside it.
  const anthropicUsage = { input_tokens: usage.input, output_tokens: usage.output, ...(usage.cacheRead ? { cache_read_input_tokens: usage.cacheRead } : {}), ...(usage.cacheWrite ? { cache_creation_input_tokens: usage.cacheWrite } : {}) };
  const openAIUsage = { prompt_tokens: usage.input + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0), completion_tokens: usage.output, ...(usage.cacheRead ? { prompt_tokens_details: { cached_tokens: usage.cacheRead } } : {}) };
  if (shape === 'anthropic') {
    const content: unknown[] = [];
    if (step.text) content.push({ type: 'text', text: step.text });
    for (const call of step.calls ?? []) content.push({ type: 'tool_use', id: `toolu_${++callCounter}`, name: call.name, input: call.input });
    return {
      id: `msg_${callCounter}`,
      type: 'message',
      role: 'assistant',
      content,
      stop_reason: step.stop ?? ((step.calls?.length ?? 0) > 0 ? 'tool_use' : 'end_turn'),
      usage: anthropicUsage,
    };
  }
  if (shape === 'openai') {
    const toolCalls = (step.calls ?? []).map((call) => ({ id: `call_${++callCounter}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.input) } }));
    return {
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: step.text ?? null, ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}) },
          finish_reason: step.stop ?? (toolCalls.length > 0 ? 'tool_calls' : 'stop'),
        },
      ],
      usage: openAIUsage,
    };
  }
  const text = [step.text ?? '', ...(step.calls ?? []).map(textCall)].filter(Boolean).join('\n\n');
  if (shape === 'text-anthropic') {
    return { content: [{ type: 'text', text }], stop_reason: step.stop ?? 'end_turn', usage: anthropicUsage };
  }
  return { choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: step.stop ?? 'stop' }], usage: openAIUsage };
}

/** Answer fetch from `script`, in `shape`. */
export function fakeProvider(shape: Shape, script: Script): FakeProvider {
  const bodies: Array<Record<string, unknown>> = [];
  let index = 0;
  let gate: Promise<void> | null = null;
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    bodies.push(body);
    const signal = init.signal;
    if (gate) {
      const waiting = gate;
      gate = null;
      await new Promise<void>((resolve, reject) => {
        waiting.then(resolve);
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
    }
    signal?.throwIfAborted();
    const entry = script[index++];
    if (!entry) {
      const err = new Error(`The script has no step ${index}`);
      scriptFailures.push(err);
      throw err;
    }
    let step: Step;
    try {
      step = typeof entry === 'function' ? entry(body) : entry;
    } catch (err) {
      scriptFailures.push(err);
      throw err;
    }
    if (step.networkError) throw new TypeError('Failed to fetch');
    if (step.error) {
      return new Response(JSON.stringify(step.error.body), { status: step.error.status, headers: step.error.headers });
    }
    const effective = shape === 'text-openai' || shape === 'text-anthropic' ? shape : 'tools' in body ? shape : shape === 'anthropic' ? 'text-anthropic' : 'text-openai';
    const json = respond(effective, step);
    // A request that asks for a stream gets the same reply as server-sent events.
    if (body.stream === true && !step.noStream) return sseResponse(effective === 'anthropic' || effective === 'text-anthropic' ? 'anthropic' : 'openai', json, body, signal);
    return new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    bodies,
    count: () => index,
    hold() {
      let release!: () => void;
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { release };
    },
  };
}

/** A string in `n` pieces of about equal length (fewer when it is short). */
function pieces(text: string, n: number): string[] {
  if (!text) return [];
  const size = Math.max(1, Math.ceil(text.length / n));
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

/**
 * A whole reply as the events its API streams: Anthropic's message_start /
 * content_block_* / message_delta / message_stop, or Chat Completions chunks
 * with `delta.content` and `delta.tool_calls[index]` fragments (JSON
 * arguments cut mid-token), a usage chunk when stream_options asked for one,
 * and [DONE]. With a keep-alive comment and a ping, as real servers send.
 */
export function sseEvents(wire: 'anthropic' | 'openai', json: Record<string, unknown>, body: Record<string, unknown> = {}): string {
  const lines: string[] = [': keep-alive\n\n'];
  const send = (payload: unknown, event?: string) => lines.push(`${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(payload)}\n\n`);
  if (wire === 'anthropic') {
    const usage = (json.usage ?? {}) as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
    const cache = { ...(usage.cache_read_input_tokens ? { cache_read_input_tokens: usage.cache_read_input_tokens } : {}), ...(usage.cache_creation_input_tokens ? { cache_creation_input_tokens: usage.cache_creation_input_tokens } : {}) };
    send({ type: 'message_start', message: { id: json.id ?? 'msg', type: 'message', role: 'assistant', content: [], usage: { input_tokens: usage.input_tokens ?? 0, output_tokens: 1, ...cache } } }, 'message_start');
    send({ type: 'ping' }, 'ping');
    const content = (json.content ?? []) as Array<Record<string, unknown>>;
    content.forEach((block, index) => {
      if (block.type === 'text') {
        send({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } }, 'content_block_start');
        for (const part of pieces(String(block.text), 3)) send({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: part } }, 'content_block_delta');
      } else if (block.type === 'tool_use') {
        send({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } }, 'content_block_start');
        for (const part of pieces(JSON.stringify(block.input), 4)) send({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: part } }, 'content_block_delta');
      }
      send({ type: 'content_block_stop', index }, 'content_block_stop');
    });
    send({ type: 'message_delta', delta: { stop_reason: json.stop_reason, stop_sequence: null }, usage: { output_tokens: usage.output_tokens ?? 0 } }, 'message_delta');
    send({ type: 'message_stop' }, 'message_stop');
    return lines.join('');
  }
  const choice = ((json.choices ?? []) as Array<Record<string, unknown>>)[0] ?? {};
  const message = (choice.message ?? {}) as { content?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> };
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) => send({ id: 'chunk', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] });
  chunk({ role: 'assistant', content: '' });
  for (const part of pieces(message.content ?? '', 3)) chunk({ content: part });
  (message.tool_calls ?? []).forEach((call, index) => {
    chunk({ tool_calls: [{ index, id: call.id, type: 'function', function: { name: call.function.name, arguments: '' } }] });
    for (const part of pieces(call.function.arguments, 4)) chunk({ tool_calls: [{ index, function: { arguments: part } }] });
  });
  chunk({}, (choice.finish_reason as string | null) ?? 'stop');
  const options = body.stream_options as { include_usage?: boolean } | undefined;
  if (options?.include_usage && json.usage) send({ id: 'chunk', object: 'chat.completion.chunk', choices: [], usage: json.usage });
  lines.push('data: [DONE]\n\n');
  return lines.join('');
}

/** Text as a byte stream cut every `size` bytes: through lines, JSON and multi-byte characters alike. */
export function byteStream(text: string, size = 13, signal?: AbortSignal | null): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let at = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (signal?.aborted) {
        controller.error(new DOMException('aborted', 'AbortError'));
        return;
      }
      if (at >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(at, at + size));
      at += size;
    },
  });
}

function sseResponse(wire: 'anthropic' | 'openai', json: Record<string, unknown>, body: Record<string, unknown>, signal?: AbortSignal | null): Response {
  return new Response(byteStream(sseEvents(wire, json, body), 13, signal), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

export const ANTHROPIC: ProviderConfig = { id: 'a', type: 'anthropic', name: 'Anthropic', apiKey: 'k', modelId: 'model-under-test' };
export const OPENAI: ProviderConfig = { id: 'o', type: 'openai', name: 'OpenAI', apiKey: 'k', modelId: 'model-under-test' };
export const LOCAL: ProviderConfig = { id: 'l', type: 'local', name: 'Local', apiKey: '', baseUrl: 'http://localhost:11434', modelId: 'model-under-test', serverKind: 'ollama' };

/** An environment with the real validator and composer and no document to render in. */
export const nodeEnvironment: AgentEnvironment = {
  checkApp: browserEnvironment.checkApp,
  inspectPreview: async () => ({ ok: true, text: 'ui/main.ui renders:\nheading 1: Tasks\nbutton "Add"' }),
  runFunction: async (_files, request) => ({ ok: true, text: `${request.name}() returned null\nState did not change.` }),
};

/**
 * The logic engine's bytes, given once, as Studio's shell gives them: the
 * check loads the app's logic to know its names, and without them the engine
 * would fetch its WebAssembly through the scripted fetch.
 */
let engineConfigured = false;
function configureEngine(): void {
  if (engineConfigured) return;
  configureZippWasmSource(readFileSync(resolve(process.cwd(), '../../packages/@softn/core/wasm-zipp/zipp_wasm_bg.wasm')));
  engineConfigured = true;
}

/** Fresh stores, the provider, fast retries. */
export function resetAgent(provider: ProviderConfig = ANTHROPIC, env: AgentEnvironment = nodeEnvironment): void {
  configureEngine();
  discardAgentRuns();
  vi.unstubAllGlobals();
  setAgentEnvironment(env);
  setAgentSleep(async () => {});
  useVFSStore.getState().reset();
  useWorkspaceStore.getState().reset();
  useAIStore.getState().resetSession();
  useAIStore.setState({
    providers: [provider],
    activeProviderId: provider.id,
    modelProfile: { architect: '', builder: '', repair: '', vision: '' },
    maxIterations: 50,
    tokenBudget: 5_000_000,
    maxOutputTokens: 4_096,
    requestTimeoutMs: 60_000,
    agentSettings: { maxSteps: 40, runTokenBudget: 2_000_000, autoCheck: true, confirmDeletes: true },
    toolProtocols: {},
    streamModes: {},
  });
}

/** Say something in the chat, as the composer does. */
export function say(text: string): void {
  useAIStore.getState().addMessage({ id: `u-${Math.random().toString(36).slice(2)}`, role: 'user', content: text, timestamp: Date.now() });
}

/** The latest run on the chat. */
export function lastRun() {
  const message = [...useAIStore.getState().messages].reverse().find((m) => m.run);
  if (!message?.run) throw new Error('There is no run in the chat.');
  return { message, run: message.run };
}

export function text(path: string): string {
  const content = useVFSStore.getState().readFile(path);
  if (typeof content !== 'string') throw new Error(`${path} is not a text file`);
  return content;
}

/** A small valid JavaScript app. */
export const APP = {
  manifest: JSON.stringify({ name: 'Tasks', version: '1.0.0', main: 'ui/main.ui', files: { ui: ['ui/main.ui'], logic: ['logic/main.logic'] } }, null, 2),
  ui: '<logic src="../logic/main.logic" />\n\n<App theme="dark">\n  <Stack direction="vertical" gap="md">\n    <Heading level={1}>Tasks</Heading>\n    <Text>{count} tasks</Text>\n    <Button @click={() => add()}>Add</Button>\n  </Stack>\n</App>',
  logic: 'let count = 0\n\nfunction add() {\n  count = count + 1\n}',
};

export function seedApp(): void {
  useVFSStore.getState().hydrateFiles([
    { path: 'manifest.json', content: APP.manifest },
    { path: 'ui/main.ui', content: APP.ui },
    { path: 'logic/main.logic', content: APP.logic },
  ]);
}

/** The tool results the model was sent in a request body, as text, whatever the protocol. */
export function resultsIn(body: Record<string, unknown>): string {
  return JSON.stringify(body.messages ?? []);
}
