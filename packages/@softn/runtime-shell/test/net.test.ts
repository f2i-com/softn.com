/**
 * The network rules every host shares (src/net.ts): a remote import is judged
 * by core's egress rule, the one `softn.net.fetch` is held to; a body is read
 * within a bound; and the manifest's sync server becomes one WebSocket
 * address, the same in every host.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeNetDestination, type PermissionConfig } from '@softn/core';
import { createImportResolver } from '../src/bundleProcessor';
import { judgeRemoteImport, readBoundedBody, resolveServerConfig } from '../src/net';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const net = (entry: Record<string, unknown>): PermissionConfig =>
  ({ permissions: { net: { enabled: true, ...entry } } }) as PermissionConfig;

/** A resolver whose fetch answers every request with a module, recording what was asked for. */
function resolverFor(config: PermissionConfig | null) {
  const asked: string[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    asked.push(String(input));
    return new Response('let loaded = true');
  }) as unknown as typeof fetch;
  return { resolve: createImportResolver(new Map(), config, { fetchImpl }), asked };
}

describe('remote imports and the local network', () => {
  // The audit's case: net with http allowed and no host list, and the import
  // aimed at a router. softn.net.fetch to the same host was refused by core;
  // the import went out.
  const cases: Array<[string, PermissionConfig, boolean]> = [
    ['https://192.168.1.1/x.js', net({ allow_http: true }), false],
    ['https://10.0.0.5/x.logic', net({}), false],
    ['http://localhost:8080/x.logic', net({ allow_http: true }), false],
    ['http://127.0.0.1:1420/x.logic', net({ allow_http: true }), false],
    ['https://printer.local/x.logic', net({}), false],
    ['https://[::1]/x.logic', net({}), false],
    // A bundle that names a host on the local network may reach it.
    ['http://localhost:8080/x.logic', net({ allow_http: true, allowed_hosts: ['localhost'] }), true],
    ['https://printer.local/x.logic', net({ allowed_hosts: ['printer.local'] }), true],
    ['https://cdn.example.com/x.logic', net({}), true],
  ];

  for (const [url, config, allowed] of cases) {
    it(`${allowed ? 'fetches' : 'refuses'} ${url} under ${JSON.stringify(config.permissions.net)}`, async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { resolve, asked } = resolverFor(config);
      const result = await resolve(url);
      expect(asked.length > 0, 'fetched').toBe(allowed);
      expect(result).toBe(allowed ? 'let loaded = true' : null);
      // The same answer as core's own rule for softn.net.fetch.
      expect(judgeRemoteImport(url, config).allowed).toBe(describeNetDestination(url, config.permissions.net).allowed);
    });
  }

  it('says why a destination was refused when the bundle has net, and stays quiet when it has none', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await resolverFor(net({})).resolve('https://192.168.1.1/x.js');
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/Remote import refused: Host not allowed: 192\.168\.1\.1 is on this computer or its local network/));
    warn.mockClear();
    await resolverFor({ permissions: {} }).resolve('https://cdn.example.com/x.js');
    expect(warn).not.toHaveBeenCalled();
  });

  it('requires net, declared and granted', async () => {
    for (const config of [null, { permissions: {} }, { permissions: { net: { enabled: false } } }, { permissions: {}, consentPending: true }] as PermissionConfig[]) {
      const { resolve, asked } = resolverFor(config);
      expect(await resolve('https://cdn.example.com/x.logic')).toBeNull();
      expect(asked).toEqual([]);
    }
  });

  it('holds the address a response reports to the same rule', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const moved = new Response('let x = 1');
    Object.defineProperty(moved, 'url', { value: 'https://192.168.1.1/x.logic' });
    const fetchImpl = vi.fn(async () => moved) as unknown as typeof fetch;
    const resolve = createImportResolver(new Map(), net({}), { fetchImpl });
    expect(await resolve('https://cdn.example.com/x.logic')).toBeNull();
  });

  it('asks the fetch not to follow redirects', async () => {
    const fetchImpl = vi.fn(async () => new Response('ok')) as unknown as typeof fetch;
    await createImportResolver(new Map(), net({}), { fetchImpl })('https://cdn.example.com/x.logic');
    expect(fetchImpl).toHaveBeenCalledWith('https://cdn.example.com/x.logic', expect.objectContaining({ redirect: 'error' }));
  });

  it('enforces protocol and host allowlists', async () => {
    const scoped = net({ allowed_hosts: ['modules.example'] });
    const { resolve, asked } = resolverFor(scoped);
    expect(await resolve('https://modules.example/ok.logic')).toBe('let loaded = true');
    expect(await resolve('https://other.example/no.logic')).toBeNull();
    expect(await resolve('http://modules.example/no.logic')).toBeNull();
    expect(asked).toEqual(['https://modules.example/ok.logic']);
    const withHttp = resolverFor(net({ allow_http: true, allowed_hosts: ['modules.example'] }));
    expect(await withHttp.resolve('http://modules.example/ok.logic')).toBe('let loaded = true');
  });

  it('stops a module past the size bound', async () => {
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4, 5]))) as unknown as typeof fetch;
    const resolve = createImportResolver(new Map(), net({}), { fetchImpl, maxRemoteBytes: 4 });
    expect(await resolve('https://modules.example/large.logic')).toBeNull();
  });

  it('abandons a slow module at the timeout and leaves no timer behind', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const fetchImpl = vi.fn(
      (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          signal = init?.signal ?? undefined;
          signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        })
    ) as unknown as typeof fetch;
    const resolve = createImportResolver(new Map(), net({}), { fetchImpl, timeoutMs: 25 });
    const result = resolve('https://modules.example/slow.logic');
    await vi.advanceTimersByTimeAsync(25);
    expect(await result).toBeNull();
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts a request in flight when disposed, and resolves nothing after', async () => {
    let signal: AbortSignal | undefined;
    const fetchImpl = vi.fn(
      (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          signal = init?.signal ?? undefined;
          signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        })
    ) as unknown as typeof fetch;
    const resolve = createImportResolver(new Map([['logic/a.logic', 'let a = 1']]), net({}), { fetchImpl });
    const pending = resolve('https://modules.example/x.logic');
    await Promise.resolve();
    resolve.dispose();
    expect(await pending).toBeNull();
    expect(signal?.aborted).toBe(true);
    expect(await resolve('logic/a.logic')).toBeNull();
  });
});

describe('readBoundedBody', () => {
  it('reads a body within the bound', async () => {
    expect(await readBoundedBody(new Response(new Uint8Array([1, 2, 3])), 3)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('refuses a declared length past the bound without reading', async () => {
    const response = new Response(new Uint8Array(10), { headers: { 'content-length': '10' } });
    expect(await readBoundedBody(response, 4)).toBeNull();
  });

  it('refuses a streamed body that grows past the bound, whatever it declared', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(3));
        controller.enqueue(new Uint8Array(3));
        controller.close();
      },
    });
    expect(await readBoundedBody(new Response(stream), 4)).toBeNull();
  });

  it('stops when told to, and tells its owner about the reader', async () => {
    const released = vi.fn();
    const seen: unknown[] = [];
    const result = await readBoundedBody(new Response(new Uint8Array(3)), 10, {
      onChunk: () => false,
      onReader: (reader) => {
        seen.push(reader);
        return released;
      },
    });
    expect(result).toBeNull();
    expect(seen).toHaveLength(1);
    expect(released).toHaveBeenCalledOnce();
  });
});

describe('resolveServerConfig', () => {
  const quiet = () => {};

  it('turns an address with no path, or only a slash, into /sync', () => {
    expect(resolveServerConfig({ url: 'https://sync.example.com' }, quiet).serverUrl).toBe('wss://sync.example.com/sync');
    expect(resolveServerConfig({ url: 'https://sync.example.com/' }, quiet).serverUrl).toBe('wss://sync.example.com/sync');
    expect(resolveServerConfig({ url: 'http://localhost:8080' }, quiet).serverUrl).toBe('ws://localhost:8080/sync');
  });

  it('puts /sync after the path and keeps the query', () => {
    expect(resolveServerConfig({ url: 'https://h.example/api?t=a' }, quiet).serverUrl).toBe('wss://h.example/api/sync?t=a');
    expect(resolveServerConfig({ url: 'https://backend.example/app/?room=demo' }, quiet).serverUrl).toBe('wss://backend.example/app/sync?room=demo');
  });

  it('leaves a path that already ends in /sync, and drops a fragment', () => {
    expect(resolveServerConfig({ url: 'ws://localhost:8080/sync/' }, quiet).serverUrl).toBe('ws://localhost:8080/sync');
    expect(resolveServerConfig({ url: 'wss://h.example/sync' }, quiet).serverUrl).toBe('wss://h.example/sync');
    expect(resolveServerConfig({ url: 'https://h.example/#x' }, quiet).serverUrl).toBe('wss://h.example/sync');
    expect(resolveServerConfig({ url: 'HTTPS://H.example' }, quiet).serverUrl).toBe('wss://h.example/sync');
  });

  it('names no server for another scheme or a non-address, and says why', () => {
    for (const url of ['ftp://sync.example.com', 'file:///app', 'javascript:alert(1)', 'sync.example.com', '', 42]) {
      const warn = vi.fn();
      expect(resolveServerConfig({ url }, warn).serverUrl, String(url)).toBeUndefined();
      expect(warn, String(url)).toHaveBeenCalledWith(expect.stringMatching(/Server sync not started/));
    }
  });

  it('takes the token, else the older auth_token, and the collections', () => {
    expect(resolveServerConfig({ url: 'https://h.example', token: 'current', auth_token: 'old', collections: ['tasks', 7] }, quiet)).toEqual({
      serverUrl: 'wss://h.example/sync',
      serverToken: 'current',
      serverCollections: ['tasks'],
    });
    expect(resolveServerConfig({ url: 'https://h.example', auth_token: 'legacy' }, quiet).serverToken).toBe('legacy');
  });

  it('names nothing when there is no server', () => {
    expect(resolveServerConfig(undefined, quiet)).toEqual({});
    expect(resolveServerConfig({}, quiet).serverUrl).toBeUndefined();
  });
});
