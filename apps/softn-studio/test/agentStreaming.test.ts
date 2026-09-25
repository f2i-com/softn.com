/**
 * Streamed replies: the SSE reader, both assemblers against scripted event
 * streams (split UTF-8, argument JSON cut mid-token, usage in the last event,
 * errors mid-stream), and the loop around them — the live reply the timeline
 * shows, the fallback to a whole reply (remembered per provider and model),
 * and Stop in the middle of a stream.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AIProviderError, SSEParser } from '../src/lib/aiProvider';
import { sendAgentRequest, streamFallback } from '../src/lib/agent/protocol';
import { liveSubject, liveTextCalls } from '../src/lib/agent/stream';
import { continueAgentRun, startAgentRun, stopAgentRun } from '../src/lib/agent/runAgent';
import { useAIStore } from '../src/stores/aiStore';
import { ANTHROPIC, assertScriptsPassed, byteStream, fakeProvider, lastRun, LOCAL, resetAgent, say, seedApp, sseEvents, text } from './helpers/agentHarness';

beforeEach(() => resetAgent());
afterEach(() => {
  assertScriptsPassed();
  resetAgent();
});

/** Answer every fetch with `respond(body, init)`; keeps the bodies. */
function stubFetch(respond: (body: Record<string, unknown>, init: RequestInit, n: number) => Response | Promise<Response>) {
  const bodies: Array<Record<string, unknown>> = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    bodies.push(body);
    init.signal?.throwIfAborted();
    return respond(body, init, bodies.length - 1);
  }));
  return bodies;
}

const sse = (text: string, size = 7, signal?: AbortSignal | null) => new Response(byteStream(text, size, signal), { status: 200, headers: { 'content-type': 'text/event-stream' } });
const data = (payload: unknown) => `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
const chunk = (delta: Record<string, unknown>, finish: string | null = null) => data({ choices: [{ index: 0, delta, finish_reason: finish }] });

/** A stream the test writes to by hand, to look at the run between events. */
function manualStream(signal?: AbortSignal | null) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start: (c) => { controller = c; } });
  signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')), { once: true });
  const encoder = new TextEncoder();
  return {
    response: new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    write: (text: string) => controller.enqueue(encoder.encode(text)),
    close: () => controller.close(),
  };
}

const request = (protocol: 'openai' | 'anthropic' | 'text', sink?: Parameters<typeof sendAgentRequest>[1]['sink']) => ({
  system: 'sys',
  turns: [{ role: 'user' as const, text: 'Go' }],
  protocol,
  model: 'model-under-test',
  maxOutputTokens: 1000,
  stream: 'on' as const,
  sink,
});

describe('the SSE reader', () => {
  it('reads events whatever the line endings and wherever the chunks break', () => {
    const wire = ': comment\r\nevent: a\r\ndata: {"x":\r\ndata: 1}\r\n\r\ndata:no-space\n\ndata: tail';
    for (let size = 1; size <= wire.length; size++) {
      const parser = new SSEParser();
      const events = [];
      for (let i = 0; i < wire.length; i += size) events.push(...parser.push(wire.slice(i, i + size)));
      events.push(...parser.end());
      expect(events).toEqual([{ event: 'a', data: '{"x":\n1}' }, { event: '', data: 'no-space' }, { event: '', data: 'tail' }]);
    }
  });
});

describe('OpenAI-compatible streams', () => {
  it('assembles text split inside multi-byte characters and arguments split mid-token, with usage from the last chunk', async () => {
    const wire = [
      chunk({ role: 'assistant', content: '' }),
      chunk({ reasoning_content: 'thinking about it' }),
      chunk({ content: 'Héllo — 日本' }),
      chunk({ content: ' 🎉' }),
      chunk({ tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'write_file', arguments: '' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{"pa' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: 'th":"ui/ü.ui","content":"<Text>✓' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '</Text>"}' } }] }),
      chunk({ tool_calls: [{ index: 1, id: 'c2', type: 'function', function: { name: 'finish', arguments: '{"summary":"ok"}' } }] }),
      chunk({}, 'tool_calls'),
      data({ choices: [], usage: { prompt_tokens: 321, completion_tokens: 45 } }),
      data('[DONE]'),
    ].join('');
    // One byte at a time: every multi-byte character is split across reads.
    const bodies = stubFetch(() => sse(wire, 1));
    const seen: string[] = [];
    const reply = await sendAgentRequest(LOCAL, request('openai', {
      text: (d) => seen.push(`text:${d}`),
      thinking: () => seen.push('thinking'),
      toolStart: (i, id, name) => seen.push(`start:${i}:${id}:${name}`),
      toolArgs: (i) => seen.push(`args:${i}`),
    }));
    expect(bodies[0]).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    expect(reply.text).toBe('Héllo — 日本 🎉');
    expect(reply.calls).toEqual([
      { id: 'c1', name: 'write_file', input: { path: 'ui/ü.ui', content: '<Text>✓</Text>' } },
      { id: 'c2', name: 'finish', input: { summary: 'ok' } },
    ]);
    expect(reply.stopReason).toBe('tool_calls');
    expect(reply.usage).toEqual({ inputTokens: 321, outputTokens: 45 });
    // Reasoning is not reply text; the call row starts before its arguments.
    expect(seen.indexOf('thinking')).toBeLessThan(seen.indexOf('text:Héllo — 日本'));
    expect(seen.indexOf('start:0:c1:write_file')).toBeLessThan(seen.indexOf('args:0'));
  });

  it('reads a call sent whole in one chunk with no usage (Ollama without include_usage) and reports no counts', async () => {
    stubFetch(() => sse([chunk({ role: 'assistant', content: '', tool_calls: [{ id: 'call_x', index: 0, type: 'function', function: { name: 'list_files', arguments: '{}' } }] }), chunk({}, 'tool_calls'), data('[DONE]')].join('')));
    const reply = await sendAgentRequest(LOCAL, request('openai'));
    expect(reply.calls).toEqual([{ id: 'call_x', name: 'list_files', input: {} }]);
    expect(reply.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it('answers malformed argument JSON as a call with a parse error, not a failure', async () => {
    stubFetch(() => sse([chunk({ tool_calls: [{ index: 0, id: 'c', function: { name: 'read_file', arguments: '{"path": ' } }] }), chunk({}, 'tool_calls'), data('[DONE]')].join('')));
    const reply = await sendAgentRequest(LOCAL, request('openai'));
    expect(reply.calls[0]).toMatchObject({ name: 'read_file', input: {}, parseError: expect.stringMatching(/not valid JSON/) });
  });

  it('reports an error sent mid-stream as the provider\'s failure, not a stream fault', async () => {
    stubFetch(() => sse([chunk({ content: 'Starting' }), data({ error: { message: 'model crashed', type: 'server_error' } })].join('')));
    const error = await sendAgentRequest(LOCAL, request('openai')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AIProviderError);
    expect(error).toMatchObject({ kind: 'http', detail: 'model crashed' });
    expect(streamFallback(error)).toBeNull();
  });

  it('marks an event that is not JSON as a stream fault, and a stream cut before its end as a dropped connection', async () => {
    stubFetch(() => sse(`${chunk({ content: 'a' })}data: {not json\n\n`));
    const fault = await sendAgentRequest(LOCAL, request('openai')).catch((e: unknown) => e);
    expect(fault).toMatchObject({ kind: 'invalid-response', streamFault: true });
    expect(streamFallback(fault)).toBe('off');

    stubFetch(() => sse(chunk({ content: 'half a rep' })));
    await expect(sendAgentRequest(LOCAL, request('openai'))).rejects.toMatchObject({ kind: 'network' });
  });

  it('reads a JSON body from a server that ignores `stream`', async () => {
    stubFetch(() => new Response(JSON.stringify({ choices: [{ message: { content: 'whole' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const reply = await sendAgentRequest(LOCAL, request('openai'));
    expect(reply).toMatchObject({ text: 'whole', status: 'complete', usage: { inputTokens: 3, outputTokens: 1 } });
  });

  it('tells which refusals mean "stream less" and which mean nothing of the kind', () => {
    const http = (detail: string, status = 400) => new AIProviderError('http', 'x', { status, detail });
    expect(streamFallback(http("Unrecognized request argument supplied: stream_options"))).toBe('plain');
    expect(streamFallback(http('streaming is not supported with tools'))).toBe('off');
    expect(streamFallback(http('tools are not supported by this model'))).toBeNull();
    expect(streamFallback(http('stream is not supported', 401))).toBeNull();
    expect(streamFallback(new AIProviderError('network', 'down'))).toBeNull();
  });
});

describe('Anthropic streams', () => {
  it('assembles text, a thinking block with its signature, and a tool call from input_json_delta, with usage from start and delta', async () => {
    const ev = (type: string, payload: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
    const wire = [
      ev('message_start', { message: { id: 'm', content: [], usage: { input_tokens: 900, output_tokens: 1 } } }),
      ev('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } }),
      ev('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'Plan: é' } }),
      ev('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'sig==' } }),
      ev('content_block_stop', { index: 0 }),
      ev('ping', {}),
      ev('content_block_start', { index: 1, content_block: { type: 'text', text: '' } }),
      ev('content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'Writing – ' } }),
      ev('content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'ö' } }),
      ev('content_block_stop', { index: 1 }),
      ev('content_block_start', { index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'edit_file', input: {} } }),
      ev('content_block_delta', { index: 2, delta: { type: 'input_json_delta', partial_json: '{"path": "ui/main.ui", "old_str' } }),
      ev('content_block_delta', { index: 2, delta: { type: 'input_json_delta', partial_json: 'ing": "Tasks", "new_string": "Tâches"}' } }),
      ev('content_block_stop', { index: 2 }),
      ev('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 77 } }),
      ev('message_stop', {}),
    ].join('');
    const bodies = stubFetch(() => sse(wire, 5));
    const reply = await sendAgentRequest(ANTHROPIC, request('anthropic'));
    expect(bodies[0].stream).toBe(true);
    expect(bodies[0].stream_options).toBeUndefined();
    expect(reply.text).toBe('Writing – ö');
    expect(reply.calls).toEqual([{ id: 'toolu_1', name: 'edit_file', input: { path: 'ui/main.ui', old_string: 'Tasks', new_string: 'Tâches' } }]);
    expect(reply.usage).toEqual({ inputTokens: 900, outputTokens: 77 });
    // The content echoed back next time is the whole reply, thinking and signature included.
    expect(reply.anthropicContent).toEqual([
      { type: 'thinking', thinking: 'Plan: é', signature: 'sig==' },
      { type: 'text', text: 'Writing – ö' },
      { type: 'tool_use', id: 'toolu_1', name: 'edit_file', input: { path: 'ui/main.ui', old_string: 'Tasks', new_string: 'Tâches' } },
    ]);
  });

  it('turns an overloaded error event into a rate limit and another error event into a provider failure', async () => {
    const start = `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 5 } } })}\n\n`;
    stubFetch(() => sse(`${start}event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })}\n\n`));
    await expect(sendAgentRequest(ANTHROPIC, request('anthropic'))).rejects.toMatchObject({ kind: 'rate-limited' });
    stubFetch(() => sse(`${start}event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'Internal' } })}\n\n`));
    await expect(sendAgentRequest(ANTHROPIC, request('anthropic'))).rejects.toMatchObject({ kind: 'http', detail: 'Internal' });
  });
});

describe('the live reply', () => {
  it('reads text-protocol calls out of the live text and fills in their subjects when they arrive whole', () => {
    expect(liveTextCalls('Reading.\n<tool_call name="read_file">\n<arg name="path">ui/ma')).toEqual({ text: 'Reading.', calls: [{ name: 'read_file', body: '\n<arg name="path">ui/ma' }] });
    expect(liveTextCalls('Almost <tool_c').text).toBe('Almost');
    expect(liveSubject('{"path":"ui/ma')).toBe('');
    expect(liveSubject('{"path":"ui/main.ui","content":"<A')).toBe('ui/main.ui');
    expect(liveSubject('\n<arg name="path">logic/main.logic</arg>')).toBe('logic/main.logic');
  });

  it('shows text and a tool row while the reply streams, then the real rows once it is whole', async () => {
    resetAgent(LOCAL);
    seedApp();
    let stream!: ReturnType<typeof manualStream>;
    stubFetch((_body, init, n) => {
      if (n === 0) {
        stream = manualStream(init.signal);
        return stream.response;
      }
      return sse([chunk({ tool_calls: [{ index: 0, id: 'f', function: { name: 'finish', arguments: '{"summary":"Read it."}' } }] }), chunk({}, 'tool_calls'), data('[DONE]')].join(''));
    });
    say('Read the page');
    const running = startAgentRun();
    await vi.waitFor(() => expect(stream).toBeDefined());
    // A reasoning model thinks first: that shows as a running count, not as text.
    stream.write(chunk({ reasoning_content: 'x'.repeat(400) }));
    await vi.waitFor(() => expect(lastRun().run.live).toMatchObject({ text: '', thinking: true, thinkingTokens: 100 }));
    stream.write(chunk({ content: 'Let me look at ' }));
    stream.write(chunk({ content: 'the page.' }));
    stream.write(chunk({ tool_calls: [{ index: 0, id: 'r1', type: 'function', function: { name: 'read_file', arguments: '{"path":"ui/ma' } }] }));
    await vi.waitFor(() => expect(lastRun().run.live?.calls).toEqual([{ id: 'r1', name: 'read_file', subject: '' }]));
    expect(lastRun().run.live?.text).toBe('Let me look at the page.');
    expect(lastRun().run.entries).toEqual([]);
    stream.write(chunk({ tool_calls: [{ index: 0, function: { arguments: 'in.ui"}' } }] }));
    await vi.waitFor(() => expect(lastRun().run.live?.calls[0].subject).toBe('ui/main.ui'));
    stream.write(chunk({}, 'tool_calls'));
    stream.write(data('[DONE]'));
    stream.close();
    await running;
    const { run } = lastRun();
    expect(run.status).toBe('finished');
    expect(run.live).toBeUndefined();
    expect(run.entries.map((e) => (e.kind === 'text' ? `text:${e.text}` : `${e.name}:${e.status}`))).toEqual(['text:Let me look at the page.', 'read_file:ok', 'finish:ok']);
  });

  it('Stop mid-stream aborts it cleanly: the text so far stays, its tokens are counted, nothing late lands', async () => {
    resetAgent(LOCAL);
    seedApp();
    let stream!: ReturnType<typeof manualStream>;
    let signal: AbortSignal | null | undefined;
    stubFetch((_body, init) => {
      signal = init.signal;
      stream = manualStream(init.signal);
      return stream.response;
    });
    say('Change the title');
    const running = startAgentRun();
    await vi.waitFor(() => expect(stream).toBeDefined());
    stream.write(chunk({ content: 'I will rename the heading' }));
    stream.write(chunk({ tool_calls: [{ index: 0, id: 'w', function: { name: 'write_file', arguments: '{"path":"ui/main.ui","content":"<App>' } }] }));
    await vi.waitFor(() => expect(lastRun().run.live?.calls).toHaveLength(1));
    stopAgentRun();
    await running;
    expect(signal?.aborted).toBe(true);
    const { run } = lastRun();
    expect(run.status).toBe('stopped');
    expect(run.live).toBeUndefined();
    expect(run.entries).toEqual([expect.objectContaining({ kind: 'text', text: 'I will rename the heading …' })]);
    // Nothing from the half-written call was run.
    expect(text('ui/main.ui')).toContain('Tasks');
    expect(run.tokens.input).toBeGreaterThan(0);
    expect(run.tokens.output).toBeGreaterThan(0);
    expect(useAIStore.getState().tokensUsed).toBe(run.tokens.input + run.tokens.output);
  });
});

describe('falling back to a whole reply', () => {
  it('asks again without streaming when the stream cannot be read, and remembers it for that provider and model', async () => {
    resetAgent(LOCAL);
    const bodies = stubFetch((body) => {
      if (body.stream) return sse('data: <html>proxy error</html>\n\n');
      return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: 'f', type: 'function', function: { name: 'finish', arguments: '{"summary":"Done."}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 2 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    say('Go');
    await startAgentRun();
    expect(lastRun().run.status).toBe('finished');
    expect(bodies.map((b) => Boolean(b.stream))).toEqual([true, false]);
    expect(useAIStore.getState().streamModes['l:model-under-test']).toBe('off');
    // The protocol is not touched: the tools still travel natively.
    expect(lastRun().run.protocol).toBe('openai');

    say('Again');
    await startAgentRun();
    expect(bodies.slice(2).map((b) => Boolean(b.stream))).toEqual([false]);
  });

  it('drops only stream_options when that is what the server refused', async () => {
    resetAgent(LOCAL);
    const bodies = stubFetch((body) => {
      if (body.stream_options) return new Response(JSON.stringify({ error: { message: 'Unrecognized request argument supplied: stream_options' } }), { status: 400 });
      return sse([chunk({ tool_calls: [{ index: 0, id: 'f', function: { name: 'finish', arguments: '{"summary":"ok"}' } }] }), chunk({}, 'tool_calls'), data('[DONE]')].join(''));
    });
    say('Go');
    await startAgentRun();
    expect(lastRun().run.status).toBe('finished');
    expect(bodies.map((b) => [b.stream, 'stream_options' in b])).toEqual([[true, true], [true, false]]);
    expect(useAIStore.getState().streamModes['l:model-under-test']).toBe('plain');
    // No usage came back: the run is counted by estimate, so the budget still binds.
    expect(lastRun().run.tokens.input).toBeGreaterThan(0);
  });

  it('a stream cut off mid-reply pauses the run, and Resume sends the request again', async () => {
    resetAgent(LOCAL);
    let n = 0;
    stubFetch(() => (n++ === 0
      ? sse(chunk({ content: 'Half' }))
      : sse([chunk({ tool_calls: [{ index: 0, id: 'f', function: { name: 'finish', arguments: '{"summary":"ok"}' } }] }), chunk({}, 'tool_calls'), data('[DONE]')].join(''))));
    say('Go');
    await startAgentRun();
    expect(lastRun().run.status).toBe('paused');
    expect(lastRun().run.reason).toMatch(/connection closed before the reply was complete/);
    expect(useAIStore.getState().streamModes).toEqual({});
    await continueAgentRun(lastRun().run.id);
    expect(lastRun().run.status).toBe('finished');
  });

  it('streams every request of a scripted run, in both wire formats', async () => {
    const provider = fakeProvider('anthropic', [{ text: 'Å plan.', calls: [{ name: 'list_files', input: {} }] }, { calls: [{ name: 'finish', input: { summary: 'ok' } }] }]);
    say('Go');
    await startAgentRun();
    expect(provider.bodies.every((b) => b.stream === true)).toBe(true);
    expect(lastRun().run.entries[0]).toMatchObject({ kind: 'text', text: 'Å plan.' });
    expect(lastRun().run.tokens).toEqual({ input: 200, output: 40, effective: 240 });
    expect(sseEvents('openai', { choices: [{ message: { content: 'x' }, finish_reason: 'stop' }] })).toContain('data: [DONE]');
  });
});
