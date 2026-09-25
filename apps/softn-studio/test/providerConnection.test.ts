/**
 * Talking to a provider before generation: its endpoints from any saved
 * address shape, its model list (and nothing Studio made up), and the
 * sentences a failed connection is explained with. Every request goes to a
 * stubbed fetch; nothing leaves the process.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  chatModels,
  describeConnectionError,
  isBlockedMixedContent,
  listModels,
  providerEndpoints,
  ProviderConnectionError,
  sortModels,
} from '../src/lib/providerConnection';
import type { ProviderConfig } from '../src/types/studio';

const page = { protocol: 'http:', origin: 'http://localhost:1420' };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

let fetchMock: Mock<typeof fetch>;
beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function failure(promise: Promise<unknown>): Promise<ProviderConnectionError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(ProviderConnectionError);
    return err as ProviderConnectionError;
  }
  throw new Error('expected the listing to fail');
}

const openai: ProviderConfig = { id: 'o', type: 'openai', name: 'OpenAI', apiKey: 'sk-test-not-real' };
const anthropic: ProviderConfig = { id: 'a', type: 'anthropic', name: 'Anthropic', apiKey: 'sk-test-not-real' };
const ollama: ProviderConfig = { id: 'l', type: 'local', name: 'Ollama', apiKey: '', serverKind: 'ollama', baseUrl: 'http://localhost:11434' };

describe('endpoints from every address shape a provider may have been saved with', () => {
  it.each([
    [undefined, 'https://api.openai.com/v1/chat/completions', 'https://api.openai.com/v1/models'],
    ['https://api.openai.com/v1/chat/completions', 'https://api.openai.com/v1/chat/completions', 'https://api.openai.com/v1/models'],
    ['https://gateway.example/api/v1/', 'https://gateway.example/api/v1/chat/completions', 'https://gateway.example/api/v1/models'],
  ])('OpenAI from %s', (baseUrl, chat, models) => {
    expect(providerEndpoints({ type: 'openai', baseUrl })).toMatchObject({ chat, models });
    expect(providerEndpoints({ type: 'openai', baseUrl }).ollamaTags).toBeUndefined();
  });

  it.each([
    [undefined, 'https://api.anthropic.com/v1/messages', 'https://api.anthropic.com/v1/models'],
    ['https://api.anthropic.com/v1/messages', 'https://api.anthropic.com/v1/messages', 'https://api.anthropic.com/v1/models'],
    ['https://api.anthropic.com', 'https://api.anthropic.com/v1/messages', 'https://api.anthropic.com/v1/models'],
  ])('Anthropic from %s', (baseUrl, chat, models) => {
    expect(providerEndpoints({ type: 'anthropic', baseUrl })).toMatchObject({ chat, models });
  });

  it.each([
    ['http://localhost:11434', 'http://localhost:11434/v1/chat/completions'],
    ['http://localhost:11434/v1', 'http://localhost:11434/v1/chat/completions'],
    ['http://localhost:11434/v1/chat/completions', 'http://localhost:11434/v1/chat/completions'],
  ])('a local server from %s, with Ollama’s own list as the fallback', (baseUrl, chat) => {
    const endpoints = providerEndpoints({ type: 'local', baseUrl });
    expect(endpoints.chat).toBe(chat);
    expect(endpoints.models).toBe('http://localhost:11434/v1/models');
    expect(endpoints.ollamaTags).toBe('http://localhost:11434/api/tags');
  });

  it('gives each local server kind its usual address when none is saved', () => {
    expect(providerEndpoints({ type: 'local', serverKind: 'lmstudio' }).models).toBe('http://localhost:1234/v1/models');
    expect(providerEndpoints({ type: 'local', serverKind: 'ollama' }).models).toBe('http://localhost:11434/v1/models');
    // A local server saved before `local` existed, as `custom` with no address.
    expect(providerEndpoints({ type: 'custom' }).chat).toBe('http://localhost:11434/v1/chat/completions');
  });
});

describe('OpenAI model list', () => {
  const list = { object: 'list', data: [
    { id: 'text-embedding-small', created: 1_700_000_000 },
    { id: 'chat-b', created: 1_760_000_000 },
    { id: 'tts-voice', created: 1_750_000_000 },
    { id: 'chat-a', created: 1_760_000_000 },
    { id: 'omni-moderation', created: 1_740_000_000 },
    { id: 'whisper-transcriber', created: 1_730_000_000 },
    { id: 'image-maker', created: 1_720_000_000 },
    { id: 'chat-old', created: 1_600_000_000 },
  ] };

  it('asks GET /v1/models with the key and the organization, newest first, ties by name', async () => {
    fetchMock.mockResolvedValueOnce(json(list));
    const models = await listModels({ ...openai, orgId: 'org-test' }, { fetchImpl: fetchMock, page });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/models');
    expect(init?.method).toBe('GET');
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer sk-test-not-real', 'OpenAI-Organization': 'org-test' });
    expect(models.map((m) => m.id).slice(0, 3)).toEqual(['chat-a', 'chat-b', 'tts-voice']);
    expect(models.at(-1)?.id).toBe('chat-old');
  });

  it('offers only models whose ids do not name another capability, and counts the rest for "show all"', async () => {
    fetchMock.mockResolvedValueOnce(json(list));
    const { models, hidden } = chatModels(await listModels(openai, { fetchImpl: fetchMock, page }));
    expect(models.map((m) => m.id)).toEqual(['chat-a', 'chat-b', 'chat-old']);
    expect(hidden).toBe(5);
  });

  it('keeps an unknown new chat model, whatever it is called', () => {
    expect(chatModels([{ id: 'brand-new-thing-7' }]).models).toHaveLength(1);
  });

  it('sorts undated models after dated ones, by name', () => {
    expect(sortModels([{ id: 'b' }, { id: 'a' }, { id: 'z', created: 5 }]).map((m) => m.id)).toEqual(['z', 'a', 'b']);
  });
});

describe('Anthropic model list', () => {
  it('follows has_more/last_id across pages with the browser-access headers', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ data: [
        { type: 'model', id: 'model-new', display_name: 'New', created_at: '2026-08-01T00:00:00Z' },
        { type: 'model', id: 'model-mid', display_name: 'Mid', created_at: '2026-01-01T00:00:00Z' },
      ], has_more: true, first_id: 'model-new', last_id: 'model-mid' }))
      .mockResolvedValueOnce(json({ data: [
        { type: 'model', id: 'model-old', display_name: 'Old', created_at: '2025-01-01T00:00:00Z' },
      ], has_more: false, first_id: 'model-old', last_id: 'model-old' }));
    const models = await listModels(anthropic, { fetchImpl: fetchMock, page });
    expect(models.map((m) => m.id)).toEqual(['model-new', 'model-mid', 'model-old']);
    expect(models[0].label).toBe('New');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = new URL(String(fetchMock.mock.calls[0][0]));
    const second = new URL(String(fetchMock.mock.calls[1][0]));
    expect(first.origin + first.pathname).toBe('https://api.anthropic.com/v1/models');
    expect(first.searchParams.get('after_id')).toBeNull();
    expect(second.searchParams.get('after_id')).toBe('model-mid');
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({
      'x-api-key': 'sk-test-not-real',
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    });
  });

  it('stops when a page repeats its cursor instead of asking forever', async () => {
    fetchMock.mockImplementation(async () => json({ data: [{ id: 'same' }], has_more: true, last_id: 'same' }));
    const models = await listModels(anthropic, { fetchImpl: fetchMock, page });
    expect(models.map((m) => m.id)).toEqual(['same']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('local servers', () => {
  it('reads the OpenAI-style list from a local server', async () => {
    fetchMock.mockResolvedValueOnce(json({ object: 'list', data: [{ id: 'local-a' }, { id: 'local-b' }] }));
    const models = await listModels(ollama, { fetchImpl: fetchMock, page });
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:11434/v1/models');
    expect(fetchMock.mock.calls[0][1]?.headers).toEqual({});
    expect(models.map((m) => m.id)).toEqual(['local-a', 'local-b']);
  });

  it('falls back to Ollama’s /api/tags when /v1/models fails', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('not found', { status: 404 }))
      .mockResolvedValueOnce(json({ models: [
        { name: 'older:latest', model: 'older:latest', modified_at: '2025-01-01T00:00:00Z' },
        { name: 'newer:latest', model: 'newer:latest', modified_at: '2026-01-01T00:00:00Z' },
      ] }));
    const models = await listModels(ollama, { fetchImpl: fetchMock, page });
    expect(fetchMock.mock.calls[1][0]).toBe('http://localhost:11434/api/tags');
    expect(models.map((m) => m.id)).toEqual(['newer:latest', 'older:latest']);
  });

  it('reports the first failure when the fallback fails as well', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const err = await failure(listModels(ollama, { fetchImpl: fetchMock, page }));
    expect(err.kind).toBe('network');
    expect(err.message).toMatch(/not running|CORS/);
    expect(err.message).toContain('OLLAMA_ORIGINS');
    expect(err.message).toContain('http://localhost:1420');
  });

  it('tells an LM Studio user about its CORS switch', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const err = await failure(listModels({ ...ollama, serverKind: 'lmstudio', baseUrl: 'http://localhost:1234' }, { fetchImpl: fetchMock, page }));
    expect(err.message).toContain('Enable CORS');
  });
});

describe('failures a person can act on', () => {
  it.each([
    [401, 'auth', /did not accept this API key \(401\)/],
    [403, 'forbidden', /403.*permissions.*billing|403.*billing/s],
    [429, 'rate-limited', /429.*billing/s],
    [404, 'not-found', /404.*address/s],
    [500, 'server', /error of its own \(500\)/],
  ] as const)('%i is explained as %s', async (status, kind, text) => {
    fetchMock.mockResolvedValueOnce(json({ error: { message: 'provider words' } }, status));
    const err = await failure(listModels(openai, { fetchImpl: fetchMock, page }));
    expect(err.kind).toBe(kind);
    expect(err.status).toBe(status);
    expect(err.message).toMatch(text);
    expect(err.message).toContain('provider words');
  });

  it('does not try Ollama’s list after the server refused the key', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'bad key' }, 401));
    const err = await failure(listModels({ ...ollama, apiKey: 'wrong' }, { fetchImpl: fetchMock, page }));
    expect(err.kind).toBe('auth');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('explains a network failure to a cloud provider without local-server advice', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const err = await failure(listModels(anthropic, { fetchImpl: fetchMock, page }));
    expect(err.message).toContain('api.anthropic.com');
    expect(err.message).not.toContain('OLLAMA_ORIGINS');
  });

  it('calls a list that is not a list an invalid response', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>hello</html>', { status: 200 }));
    expect((await failure(listModels({ ...openai, type: 'custom', baseUrl: 'https://x.example/v1' }, { fetchImpl: fetchMock, page }))).kind).toBe('invalid-response');
  });

  it('refuses mixed content before calling, and allows plain http to this computer', async () => {
    const https = { protocol: 'https:', origin: 'https://softn.example' };
    const err = await failure(listModels({ ...ollama, baseUrl: 'http://192.168.1.20:11434' }, { fetchImpl: fetchMock, page: https }));
    expect(err.kind).toBe('mixed-content');
    expect(err.message).toMatch(/HTTPS.*http:\/\/localhost/s);
    expect(fetchMock).not.toHaveBeenCalled();

    expect(isBlockedMixedContent('http://localhost:11434/v1/models', 'https:')).toBe(false);
    expect(isBlockedMixedContent('http://127.0.0.1:1234/v1/models', 'https:')).toBe(false);
    expect(isBlockedMixedContent('http://[::1]:1234/v1/models', 'https:')).toBe(false);
    expect(isBlockedMixedContent('http://192.168.1.20/v1/models', 'http:')).toBe(false);
  });

  it('times out on its own clock', async () => {
    fetchMock.mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    expect((await failure(listModels(openai, { fetchImpl: fetchMock, page, timeoutMs: 20 }))).kind).toBe('timeout');
  });

  it('describes a local 401 as the server’s own key, not an account', () => {
    expect(describeConnectionError('auth', { type: 'local', url: 'http://localhost:1234' })).toMatch(/leave the key empty/);
  });
});
