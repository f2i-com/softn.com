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
import { AIProviderError, sendAIRequest, testProvider } from '../src/lib/aiProvider';
import type { ProviderConfig } from '../src/types/studio';

const anthropic: ProviderConfig = { id: 'a', type: 'anthropic', name: 'A', apiKey: 'sk-test-not-real', modelId: 'test-model-a' };
const openai: ProviderConfig = { id: 'o', type: 'openai', name: 'O', apiKey: 'sk-test-not-real', modelId: 'test-model-o' };

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

describe('no model, no request', () => {
  it.each([
    ['Anthropic', { ...anthropic, modelId: undefined }],
    ['OpenAI', { ...openai, modelId: undefined }],
    ['a local server', { id: 'l', type: 'local' as const, name: 'Ollama', apiKey: '' }],
    ['a blank model id', { ...openai, modelId: '   ' }],
  ])('refuses %s with no chosen model instead of sending a guessed name', async (_name, provider) => {
    const err = await failure(sendAIRequest(provider, request));
    expect(err.kind).toBe('no-model');
    expect(err.message).toMatch(/no model chosen.*AI setup/s);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses a per-request override when the provider has none', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: {} }));
    await sendAIRequest({ ...openai, modelId: undefined }, { ...request, modelOverride: 'override-model' });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).model).toBe('override-model');
  });
});

describe('request shape per provider', () => {
  const ok = () => jsonResponse({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: {} });

  it('sends OpenAI its output cap as max_completion_tokens, with the organization header', async () => {
    fetchMock.mockResolvedValueOnce(ok());
    await sendAIRequest({ ...openai, orgId: 'org-test' }, { ...request, maxOutputTokens: 2048 });
    const [url, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(body).toMatchObject({ model: 'test-model-o', max_completion_tokens: 2048 });
    expect(body.max_tokens).toBeUndefined();
    expect(init.headers).toMatchObject({ Authorization: 'Bearer sk-test-not-real', 'OpenAI-Organization': 'org-test' });
  });

  it('sends max_tokens to an OpenAI-compatible gateway saved as openai by an older Studio', async () => {
    fetchMock.mockResolvedValueOnce(ok());
    await sendAIRequest({ ...openai, baseUrl: 'https://gateway.example/api/v1/chat/completions' }, { ...request, maxOutputTokens: 1024 });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(fetchMock.mock.calls[0][0]).toBe('https://gateway.example/api/v1/chat/completions');
    expect(body.max_tokens).toBe(1024);
    expect(body.max_completion_tokens).toBeUndefined();
  });

  it('sends a local server max_tokens at its chat endpoint, from a bare address or an old full one', async () => {
    fetchMock.mockImplementation(async () => ok());
    await sendAIRequest({ id: 'l', type: 'local', name: 'Ollama', apiKey: '', baseUrl: 'http://localhost:11434', modelId: 'm' }, { ...request, maxOutputTokens: 512 });
    await sendAIRequest({ id: 'c', type: 'custom', name: 'Old', apiKey: '', baseUrl: 'http://127.0.0.1:9999/v1/chat/completions', modelId: 'm' }, request);
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:11434/v1/chat/completions');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).max_tokens).toBe(512);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
    expect(fetchMock.mock.calls[1][0]).toBe('http://127.0.0.1:9999/v1/chat/completions');
  });

  it('keeps an Anthropic provider saved with the full messages URL working', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ content: [{ type: 'text', text: 'x' }], stop_reason: 'end_turn', usage: {} }));
    await sendAIRequest({ ...anthropic, baseUrl: 'https://api.anthropic.com/v1/messages' }, request);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.anthropic.com/v1/messages');
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({ 'anthropic-dangerous-direct-browser-access': 'true', 'x-api-key': 'sk-test-not-real' });
  });

  it('explains an HTTP failure in words, keeping the status', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: 'Incorrect API key provided' } }, { status: 401 }));
    const err = await failure(sendAIRequest(openai, request));
    expect(err).toMatchObject({ kind: 'http', status: 401 });
    expect(err.message).toMatch(/did not accept this API key \(401\).*Incorrect API key provided/s);
  });
});

describe('test connection', () => {
  it('lists the models, then asks the chosen model for a short reply', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: 'test-model-o', created: 1 }] }))
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }], usage: {} }));
    const result = await testProvider(openai);
    expect(result).toMatchObject({ ok: true, replied: true, modelListed: true });
    const body = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    expect(body.model).toBe('test-model-o');
    expect(body.max_completion_tokens).toBeLessThanOrEqual(16);
  });

  it('says so when the key is refused, without sending a message', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: 'bad key' } }, { status: 401 }));
    const result = await testProvider(openai);
    expect(result).toMatchObject({ ok: false, kind: 'auth' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports a model the provider will not serve', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: 'other' }] }))
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'The model does not exist' } }, { status: 404 }));
    const result = await testProvider(openai);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.message).toMatch(/404.*The model does not exist/s);
  });
});
