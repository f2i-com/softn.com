/**
 * Round 4 (container host): the transports' own promises to the page.
 */
import { describe, it, expect, vi } from 'vitest';
import { LocalBackendTransport } from '../src/local-backend-transport';
import { RemoteBackendTransport, VirtualCookieJar, statusTextFor } from '../src/backend-transport';
import type { BackendWsEvent } from '../src/types';

function jsTransport() {
  return new LocalBackendTransport({
    appId: 'r4-transport',
    storagePrefix: 'r4-transport:',
    persistStorage: false,
    backend: { runtime: 'javascript', entry: 'backend/index.js', mode: 'api', routes: ['/api/'] },
    textFiles: { 'backend/index.js': 'function handleRequest(req) { return { status: 200, body: "ok" }; }' },
    binaryFiles: {},
    runtimeUrl: '/runtime/',
    isolation: 'inline',
  });
}

describe('r4 host: a backend WebSocket ends once', () => {
  it('closes a socket once when the transport is disposed before it started', async () => {
    const t = jsTransport();
    const events: BackendWsEvent[] = [];
    t.openWebSocket('/ws', [], (e) => events.push(e));
    t.dispose();
    await new Promise((r) => setTimeout(r, 50));
    expect(events.filter((e) => e.type === 'close')).toHaveLength(1);
    expect(events[events.length - 1].type).toBe('close');
  });

  it('closes a socket once when the transport is disposed as it becomes ready', async () => {
    const t = jsTransport();
    // Runs when the backend is ready, before the open the socket queued for then.
    void t.ready.then(() => t.dispose());
    const events: BackendWsEvent[] = [];
    t.openWebSocket('/ws', [], (e) => events.push(e));
    await t.ready.catch(() => undefined);
    await new Promise((r) => setTimeout(r, 50));
    expect(events.filter((e) => e.type === 'close')).toHaveLength(1);
  });

  it('sends nothing for a socket the backend has closed', async () => {
    const t = jsTransport();
    await t.ready;
    const events: BackendWsEvent[] = [];
    const handle = t.openWebSocket('/ws', [], (e) => events.push(e));
    t.dispose();
    handle.close();
    handle.send('late');
    expect(events.filter((e) => e.type === 'close')).toHaveLength(1);
  });
});

describe('r4 host: a remote backend that answers with a redirect', () => {
  it('fails the request rather than answering status 0', async () => {
    // What a browser hands `fetch(..., { redirect: 'manual' })` for a 3xx: no status, no headers.
    const opaque = {
      type: 'opaqueredirect',
      status: 0,
      statusText: '',
      ok: false,
      redirected: false,
      headers: new Headers(),
      body: null,
      arrayBuffer: async () => new ArrayBuffer(0),
    } as unknown as Response;
    const fetchMock = vi.fn(async () => opaque);
    vi.stubGlobal('fetch', fetchMock);
    try {
      const transport = new RemoteBackendTransport({ baseUrl: 'https://api.example.test/app' });
      await expect(transport.fetch({ method: 'POST', path: '/login', body: 'a=1' })).rejects.toThrow(/redirect/i);
      transport.dispose();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('r4 host: status text', () => {
  it('names each HTTP status as its reason phrase, and no other as OK', () => {
    expect(statusTextFor(200)).toBe('OK');
    expect(statusTextFor(206)).toBe('Partial Content');
    expect(statusTextFor(418)).toBe("I'm a teapot");
    expect(statusTextFor(504)).toBe('Gateway Timeout');
    expect(statusTextFor(299)).toBe('');
  });

  it('gives a backend answer its status text', async () => {
    const t = new LocalBackendTransport({
      appId: 'r4-status',
      storagePrefix: 'r4-status:',
      persistStorage: false,
      backend: { runtime: 'javascript', entry: 'b.js', mode: 'api', routes: ['/api/'] },
      textFiles: { 'b.js': 'function handleRequest(req) { return { status: 504, body: "slow" }; }' },
      binaryFiles: {},
      runtimeUrl: '/runtime/',
      isolation: 'inline',
    });
    await t.ready;
    const r = await t.fetch({ method: 'GET', path: '/api/x', headers: {} });
    expect([r.status, r.statusText]).toEqual([504, 'Gateway Timeout']);
    t.dispose();
  });
});

describe('r4 host: a database too large to keep', () => {
  it('says so once, instead of dropping its changes without a word', async () => {
    const said: string[] = [];
    const saved: string[] = [];
    const t = new LocalBackendTransport({
      appId: 'r4-quota',
      storagePrefix: 'r4-quota:',
      persistStorage: true,
      maxTotalSqliteBytes: 4096,
      storage: {
        length: 0,
        clear() {},
        getItem: () => null,
        key: () => null,
        removeItem() {},
        setItem: (k: string) => { saved.push(k); },
      } as Storage,
      backend: { runtime: 'javascript', entry: 'b.js', mode: 'api', routes: ['/api/'] },
      databases: [{ name: 'app', file: 'app.db', seedSql: 'CREATE TABLE a (x); CREATE TABLE b (y); CREATE TABLE c (z);' }],
      textFiles: { 'b.js': 'function handleRequest(req) { sqlite.open("app.db").execute("INSERT INTO a VALUES (1)"); return { status: 200, body: "ok" }; }' },
      binaryFiles: {},
      runtimeUrl: '/runtime/',
      isolation: 'inline',
      onConsole: (level, text) => said.push(`${level}: ${text}`),
    });
    await t.ready;
    await t.fetch({ method: 'POST', path: '/api/x', headers: {} });
    await t.fetch({ method: 'POST', path: '/api/x', headers: {} });
    await new Promise((r) => setTimeout(r, 300));
    expect(saved.filter((k) => k.includes('sqlite:'))).toEqual([]);
    const warnings = said.filter((s) => s.startsWith('warn:') && s.includes('app.db'));
    expect(warnings).toHaveLength(1);
    t.dispose();
  });
});

describe('r4 host: cookies as a browser keeps them', () => {
  it('ignores a Max-Age without a number, and keeps the cookie', () => {
    const jar = new VirtualCookieJar();
    jar.setCookieHeader('sid=1; Path=/');
    jar.setCookieHeader('sid=2; Path=/; Max-Age=');
    expect(jar.getCookieHeader('/')).toBe('sid=2');
    jar.setCookieHeader('sid=3; Path=/; Max-Age=soon');
    expect(jar.getCookieHeader('/')).toBe('sid=3');
    jar.setCookieHeader('sid=4; Path=/; Max-Age=0');
    expect(jar.getCookieHeader('/')).toBe('');
  });
});
