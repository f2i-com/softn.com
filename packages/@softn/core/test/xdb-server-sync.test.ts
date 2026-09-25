/**
 * XDB server sync — what the client does with the socket and with the
 * mutations it makes while the socket is down.
 *
 * The server is driven by hand: a fake WebSocket records what was sent and
 * the test plays the server's answers back into it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { XDBService } from '../src/runtime/xdb';
import { XDBServerSync, backoffDelay, syncTicketUrl } from '../src/runtime/xdb-server-sync';

class FakeSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;
  static made: FakeSocket[] = [];

  readyState = FakeSocket.CONNECTING;
  sent: Array<Record<string, unknown>> = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public url: string) {
    FakeSocket.made.push(this);
  }

  send(raw: string): void {
    this.sent.push(JSON.parse(raw));
  }

  close(): void {
    this.readyState = FakeSocket.CLOSED;
  }

  /** The server accepted the connection. */
  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  /** The server said something. */
  receive(msg: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }

  /** The connection dropped. */
  drop(): void {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.();
  }

  ofType(type: string): Array<Record<string, unknown>> {
    return this.sent.filter((m) => m.type === type);
  }
}

function createTestStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) || null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
  };
}

function authOk(socket: FakeSocket): void {
  socket.receive({ type: 'auth_ok', clientId: 'c1', serverTime: '2026-01-01T00:00:00Z' });
}

let xdb: XDBService;

beforeEach(() => {
  FakeSocket.made = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  xdb = new XDBService(createTestStorage(), 'server-sync-test');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('XDBServerSync', () => {
  it('pushes collection-scoped edits and deletes with the original record identity', () => {
    const record = xdb.create('notes', { text: 'before' });
    const sync = new XDBServerSync(xdb, { wsUrl: 'wss://sync.example.test/sync', appVersion: '1' });
    sync.connect();
    const socket = FakeSocket.made[0];
    try {
      socket.open();
      authOk(socket);
      socket.receive({ type: 'sync_state', collection: 'notes', records: [] });
      xdb.updateInCollection('notes', record.id, { text: 'after' });
      xdb.deleteFromCollection('notes', record.id);
      const operations = socket
        .ofType('sync_push')
        .flatMap((push) => push.ops as Array<Record<string, unknown>>);
      expect(operations.map((op) => op.operation)).toEqual(['update', 'delete']);
      expect(operations.every((op) => op.collection === 'notes' && op.recordId === record.id)).toBe(
        true
      );
    } finally {
      sync.disconnect();
    }
  });

  it('refuses a plaintext socket whatever the case of the scheme', () => {
    const sync = new XDBServerSync(xdb, { wsUrl: 'WS://sync.example.test/sync', appVersion: '1' });
    const errors: string[] = [];
    sync.on('error', (err) => errors.push(String(err)));
    sync.connect();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/Insecure ws:/);
    expect(FakeSocket.made).toHaveLength(0);
  });

  it('queues what the app writes before the socket is up and pushes it after the pull', () => {
    xdb.create('notes', { text: 'seed' });
    const sync = new XDBServerSync(xdb, { wsUrl: 'wss://sync.example.test/sync', appVersion: '1' });
    sync.connect();
    const socket = FakeSocket.made[0];

    // Offline: the socket has not opened yet.
    xdb.create('notes', { text: 'written offline' });

    socket.open();
    expect(socket.ofType('auth')).toHaveLength(1);
    authOk(socket);
    expect(socket.ofType('sync_pull')).toHaveLength(1);
    // Not before the pull has answered.
    expect(socket.ofType('sync_push')).toHaveLength(0);

    socket.receive({ type: 'sync_state', collection: 'notes', records: [] });
    const pushes = socket.ofType('sync_push');
    expect(pushes).toHaveLength(1);
    const ops = pushes[0].ops as Array<Record<string, unknown>>;
    expect(ops).toHaveLength(1);
    expect(ops[0].operation).toBe('create');
    expect(ops[0].clientId).toBe('c1');

    sync.disconnect();
  });

  it('pushes straight away when there was nothing to pull', () => {
    // A fresh app: no collections yet, so no pull is sent and the pull is
    // done by definition. Its first record used to sit unpushed forever.
    const sync = new XDBServerSync(xdb, { wsUrl: 'wss://sync.example.test/sync', appVersion: '1' });
    sync.connect();
    const socket = FakeSocket.made[0];
    socket.open();
    authOk(socket);
    expect(socket.ofType('sync_pull')).toHaveLength(0);

    xdb.create('notes', { text: 'first' });
    expect(socket.ofType('sync_push')).toHaveLength(1);

    sync.disconnect();
  });

  it('does not replay the session on reconnect', () => {
    vi.useFakeTimers();
    const sync = new XDBServerSync(xdb, {
      wsUrl: 'wss://sync.example.test/sync',
      appVersion: '1',
      reconnectDelay: 10,
    });
    sync.connect();
    const first = FakeSocket.made[0];
    first.open();
    authOk(first);
    xdb.create('notes', { text: 'one' });
    xdb.create('notes', { text: 'two' });
    expect(first.ofType('sync_push')).toHaveLength(2);
    // The host stored both.
    for (const push of first.ofType('sync_push')) {
      first.receive({
        type: 'sync_ack',
        opIds: (push.ops as Array<{ id: string }>).map((op) => op.id),
      });
    }

    // Written while down: this one, and only this one, goes out after.
    first.drop();
    xdb.create('notes', { text: 'offline' });

    vi.advanceTimersByTime(20);
    const second = FakeSocket.made[1];
    expect(second).toBeDefined();
    second.open();
    authOk(second);
    second.receive({ type: 'sync_state', collection: 'notes', records: [] });
    const pushes = second.ofType('sync_push');
    expect(pushes).toHaveLength(1);
    const ops = pushes[0].ops as Array<Record<string, unknown>>;
    expect(ops.map((op) => (op.data as { text: string }).text)).toEqual(['offline']);

    sync.disconnect();
  });

  it('sends an op the host never answered again after a reconnect', () => {
    vi.useFakeTimers();
    const sync = new XDBServerSync(xdb, {
      wsUrl: 'wss://sync.example.test/sync',
      appVersion: '1',
      reconnectDelay: 10,
    });
    sync.connect();
    const first = FakeSocket.made[0];
    first.open();
    authOk(first);
    xdb.create('notes', { text: 'stored' });
    xdb.create('notes', { text: 'lost with the connection' });
    const [stored] = first.ofType('sync_push')[0].ops as Array<{ id: string }>;
    first.receive({ type: 'sync_ack', opIds: [stored.id] });
    first.drop();

    vi.advanceTimersByTime(20);
    const second = FakeSocket.made[1];
    second.open();
    authOk(second);
    second.receive({ type: 'sync_state', collection: 'notes', records: [] });
    const ops = second
      .ofType('sync_push')
      .flatMap((p) => p.ops as Array<{ data: { text: string } }>);
    expect(ops.map((op) => op.data.text)).toEqual(['lost with the connection']);
    sync.disconnect();
  });

  it('keeps an op the host asked to retry and pushes it again after a backoff', () => {
    vi.useFakeTimers();
    const sync = new XDBServerSync(xdb, {
      wsUrl: 'wss://sync.example.test/sync',
      appVersion: '1',
      reconnectDelay: 100,
    });
    sync.connect();
    const socket = FakeSocket.made[0];
    socket.open();
    authOk(socket);
    xdb.create('notes', { text: 'quota full' });
    const [op] = socket.ofType('sync_push')[0].ops as Array<{ id: string }>;
    socket.receive({ type: 'sync_retry', opIds: [op.id], reason: 'Storage quota exceeded' });
    // Not straight back into the same refusal.
    expect(socket.ofType('sync_push')).toHaveLength(1);
    vi.advanceTimersByTime(100);
    const pushes = socket.ofType('sync_push');
    expect(pushes).toHaveLength(2);
    expect((pushes[1].ops as Array<{ id: string }>).map((o) => o.id)).toEqual([op.id]);
    // Acknowledged, it is done: nothing more goes out.
    socket.receive({ type: 'sync_ack', opIds: [op.id] });
    vi.advanceTimersByTime(60_000);
    expect(socket.ofType('sync_push')).toHaveLength(2);
    sync.disconnect();
  });

  it('sends a long offline queue in pushes the host accepts', () => {
    const sync = new XDBServerSync(xdb, { wsUrl: 'wss://sync.example.test/sync', appVersion: '1' });
    sync.connect();
    const socket = FakeSocket.made[0];
    for (let i = 0; i < 1200; i++) xdb.create('notes', { text: `offline ${i}` });
    socket.open();
    authOk(socket);
    socket.receive({ type: 'sync_state', collection: 'notes', records: [] });
    const pushes = socket.ofType('sync_push');
    expect(pushes.length).toBeGreaterThan(2);
    for (const push of pushes) {
      expect((push.ops as unknown[]).length).toBeLessThanOrEqual(500);
      expect(JSON.stringify(push).length).toBeLessThan(4 * 1024 * 1024);
    }
    expect(pushes.reduce((n, p) => n + (p.ops as unknown[]).length, 0)).toBe(1200);
    sync.disconnect();
  });

  it('lets a socket closing late leave the one that replaced it alone', () => {
    vi.useFakeTimers();
    const sync = new XDBServerSync(xdb, {
      wsUrl: 'wss://sync.example.test/sync',
      appVersion: '1',
      reconnectDelay: 10,
    });
    sync.connect();
    const first = FakeSocket.made[0];
    first.open();
    authOk(first);
    expect(sync.status.connected).toBe(true);

    sync.disconnect();
    expect(sync.status.connected).toBe(false);
    sync.connect();
    const second = FakeSocket.made[1];
    second.open();
    authOk(second);

    // The browser fires the first socket's close after disconnect() asked
    // for it. It used to null out the second socket and schedule a third.
    first.onclose?.();
    expect(sync.status.connected).toBe(true);
    vi.advanceTimersByTime(50);
    expect(FakeSocket.made).toHaveLength(2);

    xdb.create('notes', { text: 'still routed' });
    expect(second.ofType('sync_push')).toHaveLength(1);
    expect(first.ofType('sync_push')).toHaveLength(0);

    sync.disconnect();
  });
});

describe('XDBServerSync with a token', () => {
  function ticketFetch(answer: () => Response) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchStub = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return answer();
    });
    vi.stubGlobal('fetch', fetchStub);
    return calls;
  }

  it('trades the token for a ticket and never puts the token on the socket', async () => {
    const calls = ticketFetch(
      () => new Response(JSON.stringify({ ticket: 'tkt-1' }), { status: 200 })
    );
    const sync = new XDBServerSync(xdb, {
      wsUrl: 'wss://sync.example.test/sync',
      appVersion: '1',
      token: 'long-lived-secret',
    });
    sync.connect();
    // The socket waits for the ticket: the host authenticates the handshake,
    // and a bare upgrade is refused before any message could carry a token.
    expect(FakeSocket.made).toHaveLength(0);
    await vi.waitFor(() => expect(FakeSocket.made).toHaveLength(1));

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://sync.example.test/sync/ticket');
    expect(calls[0].init.method).toBe('POST');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(
      'Bearer long-lived-secret'
    );

    const socket = FakeSocket.made[0];
    const url = new URL(socket.url);
    expect(url.searchParams.get('ticket')).toBe('tkt-1');
    expect(socket.url).not.toContain('long-lived-secret');

    socket.open();
    authOk(socket);
    xdb.create('notes', { text: 'hello' });
    expect(sync.status.connected).toBe(true);
    expect(JSON.stringify(socket.sent)).not.toContain('long-lived-secret');
    sync.disconnect();
  });

  it('reports a refused token once and does not hammer the host', async () => {
    vi.useFakeTimers();
    const calls = ticketFetch(() => new Response('Authentication failed', { status: 401 }));
    const sync = new XDBServerSync(xdb, {
      wsUrl: 'wss://sync.example.test/sync',
      appVersion: '1',
      token: 'wrong',
      reconnectDelay: 10,
    });
    const errors: string[] = [];
    sync.on('error', (err) => errors.push(String(err)));
    sync.connect();
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0]).toMatch(/401/);
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toHaveLength(1);
    expect(FakeSocket.made).toHaveLength(0);
    sync.disconnect();
  });

  it('retries a ticket request that failed in transit', async () => {
    vi.useFakeTimers();
    let fail = true;
    const calls = ticketFetch(() => {
      if (fail) throw new TypeError('network down');
      return new Response(JSON.stringify({ ticket: 'tkt-2' }), { status: 200 });
    });
    const sync = new XDBServerSync(xdb, {
      wsUrl: 'wss://sync.example.test/sync',
      appVersion: '1',
      token: 'secret',
      reconnectDelay: 10,
    });
    sync.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeSocket.made).toHaveLength(0);
    fail = false;
    await vi.advanceTimersByTimeAsync(20);
    expect(calls).toHaveLength(2);
    expect(FakeSocket.made).toHaveLength(1);
    expect(new URL(FakeSocket.made[0].url).searchParams.get('ticket')).toBe('tkt-2');
    sync.disconnect();
  });

  it('waits as long as a throttled host asks before asking again', async () => {
    vi.useFakeTimers();
    let throttled = true;
    const calls = ticketFetch(() =>
      throttled
        ? new Response(JSON.stringify({ error: 'Too many ticket requests' }), {
            status: 429,
            headers: { 'Retry-After': '30' },
          })
        : new Response(JSON.stringify({ ticket: 'tkt-3' }), { status: 200 })
    );
    const sync = new XDBServerSync(xdb, {
      wsUrl: 'wss://sync.example.test/sync',
      appVersion: '1',
      token: 'secret',
      reconnectDelay: 10,
    });
    sync.connect();
    await vi.advanceTimersByTimeAsync(29_000);
    expect(calls).toHaveLength(1);
    throttled = false;
    await vi.advanceTimersByTimeAsync(1_500);
    expect(calls).toHaveLength(2);
    expect(FakeSocket.made).toHaveLength(1);
    sync.disconnect();
  });

  it('backs off between failed attempts instead of retrying at a fixed pace', async () => {
    vi.useFakeTimers();
    const calls = ticketFetch(() => {
      throw new TypeError('network down');
    });
    const sync = new XDBServerSync(xdb, {
      wsUrl: 'wss://sync.example.test/sync',
      appVersion: '1',
      token: 'secret',
      reconnectDelay: 1_000,
    });
    sync.connect();
    // A fixed 1 s delay would have asked 60 times in this minute.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls.length).toBeGreaterThan(2);
    expect(calls.length).toBeLessThanOrEqual(7);
    sync.disconnect();
  });

  it('opens nothing when disconnected while the ticket is on its way', async () => {
    let release: (r: Response) => void = () => {};
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((resolve) => (release = resolve)))
    );
    const sync = new XDBServerSync(xdb, {
      wsUrl: 'wss://sync.example.test/sync',
      appVersion: '1',
      token: 't',
    });
    sync.connect();
    sync.disconnect();
    release(new Response(JSON.stringify({ ticket: 'late' }), { status: 200 }));
    await new Promise((r) => setTimeout(r, 0));
    expect(FakeSocket.made).toHaveLength(0);
  });

  it('spreads the backoff between half and all of a doubling ceiling', () => {
    expect(backoffDelay(1000, 0, () => 0)).toBe(500);
    expect(backoffDelay(1000, 0, () => 1)).toBe(1000);
    expect(backoffDelay(1000, 3, () => 1)).toBe(8000);
    expect(backoffDelay(1000, 50, () => 1)).toBe(60_000);
  });

  it('derives the ticket address from the sync address', () => {
    expect(syncTicketUrl('wss://h.example/sync')).toBe('https://h.example/sync/ticket');
    expect(syncTicketUrl('ws://localhost:3000/tenant-a/sync/?x=1')).toBe(
      'http://localhost:3000/tenant-a/sync/ticket'
    );
  });
});
