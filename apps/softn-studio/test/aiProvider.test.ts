/**
 * What the provider adapter says about a reply, beyond its text.
 *
 * The adapter used to return content and usage and nothing else: a reply cut
 * off at the output limit looked like a finished one, so a half-written
 * file batch was applied; the Anthropic path read only the first content
 * block, so text after a non-text block was lost; malformed usage numbers
 * went straight into the session's accounting; and a request that hung,
 * was rate-limited, or was cancelled all surfaced as the same thrown
 * string. STU-05 returns a discriminated result and typed failures. Every
 * case here runs against a stubbed fetch; nothing leaves the process.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AIProviderError, sendAIRequest } from '../src/lib/aiProvider';
import type { ProviderConfig } from '../src/types/studio';

const anthropic: ProviderConfig = { id: 'a', type: 'anthropic', name: 'A', apiKey: 'sk-test-not-real' };
const openai: ProviderConfig = { id: 'o', type: 'openai', name: 'O', apiKey: 'sk-test-not-real' };

const request = { messages: [{ id: '1', role: 'user' as const, content: 'hi', timestamp: 1 }], system: 'sys' };

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers: { 'content-type': 'application/json', ...init.headers } });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function failure(promise: Promise<unknown>): Promise<AIProviderError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(AIProviderError);
    return err as AIProviderError;
  }
  throw new Error('expected the request to fail');
}

describe('Anthropic replies', () => {
  it('is complete when the model stopped on its own, with every text block concatenated in order', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        content: [
          { type: 'text', text: 'Alpha ' },
          { type: 'tool_use', id: 't', name: 'x', input: {} },
          { type: 'text', text: 'Beta' },
        ],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    );
    const result = await sendAIRequest(anthropic, request);
    expect(result.status).toBe('complete');
    expect(result.content).toBe('Alpha Beta');
    expect(result.blocks.map((b) => b.type)).toEqual(['text', 'other', 'text']);
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(result.stopReason).toBe('end_turn');
  });

  it('is not discarded when the first block is not text', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        content: [{ type: 'thinking', thinking: '...' }, { type: 'text', text: 'the answer' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
    const result = await sendAIRequest(anthropic, request);
    expect(result.content).toBe('the answer');
    expect(result.status).toBe('complete');
  });

  it('is truncated when the output limit stopped it, and still carries the partial text', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ content: [{ type: 'text', text: '<softn-file path="ui/main.ui">half' }], stop_reason: 'max_tokens', usage: { input_tokens: 1, output_tokens: 16384 } }),
    );
    const result = await sendAIRequest(anthropic, request);
    expect(result.status).toBe('truncated');
    expect(result.content).toContain('half');
  });

  it('is empty when there is no text, and refused when the model declined', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ content: [], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 0 } }));
    expect((await sendAIRequest(anthropic, request)).status).toBe('empty');
    fetchMock.mockResolvedValueOnce(jsonResponse({ content: [{ type: 'text', text: '' }], stop_reason: 'refusal', usage: { input_tokens: 1, output_tokens: 0 } }));
    expect((await sendAIRequest(anthropic, request)).status).toBe('refused');
  });

  it('sanitises malformed usage to zero rather than corrupting the accounting', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ content: [{ type: 'text', text: 'x' }], stop_reason: 'end_turn', usage: { input_tokens: 'ten', output_tokens: -3 } }),
    );
    expect((await sendAIRequest(anthropic, request)).usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    fetchMock.mockResolvedValueOnce(jsonResponse({ content: [{ type: 'text', text: 'x' }], stop_reason: 'end_turn', usage: null }));
    expect((await sendAIRequest(anthropic, request)).usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    fetchMock.mockResolvedValueOnce(jsonResponse({ content: [{ type: 'text', text: 'x' }], stop_reason: 'end_turn', usage: { input_tokens: 2.9, output_tokens: Infinity } }));
    expect((await sendAIRequest(anthropic, request)).usage).toEqual({ inputTokens: 2, outputTokens: 0 });
  });

  it('sends the caller\'s output allowance as max_tokens', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ content: [{ type: 'text', text: 'x' }], stop_reason: 'end_turn', usage: {} }));
    await sendAIRequest(anthropic, { ...request, maxOutputTokens: 4096 });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.max_tokens).toBe(4096);
  });
});

describe('OpenAI-compatible replies', () => {
  it('is complete on a normal stop and truncated on a length stop', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 4 } }));
    const done = await sendAIRequest(openai, request);
    expect(done).toMatchObject({ status: 'complete', content: 'hello', usage: { inputTokens: 3, outputTokens: 4 } });
    fetchMock.mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: 'hel' }, finish_reason: 'length' }], usage: { prompt_tokens: 3, completion_tokens: 4 } }));
    expect((await sendAIRequest(openai, request)).status).toBe('truncated');
  });

  it('reads content given as typed parts, and reports a content-filter stop as refused', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ choices: [{ message: { content: [{ type: 'text', text: 'part one ' }, { type: 'image_url', image_url: {} }, { type: 'text', text: 'part two' }] }, finish_reason: 'stop' }], usage: {} }),
    );
    expect((await sendAIRequest(openai, request)).content).toBe('part one part two');
    fetchMock.mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: null, refusal: 'no' }, finish_reason: 'content_filter' }], usage: {} }));
    expect((await sendAIRequest(openai, request)).status).toBe('refused');
    fetchMock.mockResolvedValueOnce(jsonResponse({ choices: [], usage: {} }));
    expect((await sendAIRequest(openai, request)).status).toBe('empty');
  });
});

describe('failures are distinct and recoverable', () => {
  it('reports a rate limit with the time to wait', async () => {
    fetchMock.mockResolvedValueOnce(new Response('slow down', { status: 429, headers: { 'retry-after': '7' } }));
    const err = await failure(sendAIRequest(anthropic, request));
    expect(err.kind).toBe('rate-limited');
    expect(err.status).toBe(429);
    expect(err.retryAfterMs).toBe(7000);
  });

  it('reports another HTTP failure with its status, and an unparseable body as an invalid response', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"error":"boom"}', { status: 500 }));
    const err = await failure(sendAIRequest(anthropic, request));
    expect(err.kind).toBe('http');
    expect(err.status).toBe(500);
    fetchMock.mockResolvedValueOnce(new Response('<html>not json</html>', { status: 200 }));
    expect((await failure(sendAIRequest(anthropic, request))).kind).toBe('invalid-response');
  });

  it('times out on its own clock, and distinguishes that from the user cancelling', async () => {
    const hang = (_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
      });
    fetchMock.mockImplementationOnce(hang);
    const timedOut = await failure(sendAIRequest(anthropic, { ...request, timeoutMs: 20 }));
    expect(timedOut.kind).toBe('timeout');

    fetchMock.mockImplementationOnce(hang);
    const controller = new AbortController();
    const pending = failure(sendAIRequest(anthropic, { ...request, signal: controller.signal, timeoutMs: 10_000 }));
    controller.abort();
    expect((await pending).kind).toBe('cancelled');
  });

  it('reports a network failure as such', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect((await failure(sendAIRequest(openai, request))).kind).toBe('network');
  });

  // A real fetch resolves on headers, but its body can keep streaming.
  // Model that separately: aborting fetch must still stop the body reader.
  function delayedBody(status = 200) {
    fetchMock.mockImplementationOnce((_url: string, init: RequestInit) => new Response(new ReadableStream({
      start(stream) {
        stream.enqueue(new TextEncoder().encode(status === 200 ? '{"choices":' : 'provider error'));
        init.signal!.addEventListener('abort', () => stream.error(new DOMException('Aborted', 'AbortError')), { once: true });
      },
    }), { status }));
  }

  it.each([200, 429, 500])('times out while reading a stalled %s response body', async (status) => {
    delayedBody(status);
    expect((await failure(sendAIRequest(openai, { ...request, timeoutMs: 20 }))).kind).toBe('timeout');
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it('keeps Stop connected after response headers arrive', async () => {
    delayedBody();
    const controller = new AbortController();
    const pending = failure(sendAIRequest(openai, { ...request, signal: controller.signal }));
    await Promise.resolve(); // fetch has returned its headers; body is still pending
    controller.abort();
    expect((await pending).kind).toBe('cancelled');
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it('does not send a request when the caller has already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    expect((await failure(sendAIRequest(openai, { ...request, signal: controller.signal }))).kind).toBe('cancelled');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports a dropped body connection as a network failure, not invalid JSON', async () => {
    fetchMock.mockResolvedValueOnce(new Response(new ReadableStream({
      start(stream) { stream.error(new TypeError('Connection reset')); },
    })));
    expect((await failure(sendAIRequest(openai, request))).kind).toBe('network');
  });
});
