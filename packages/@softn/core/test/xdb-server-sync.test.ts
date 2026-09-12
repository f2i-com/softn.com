/**
 * XDB server sync — what the client does with the socket and with the
 * mutations it makes while the socket is down.
 *
 * The server is driven by hand: a fake WebSocket records what was sent and
 * the test plays the server's answers back into it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { XDBService } from '../src/runtime/xdb';
import { XDBServerSync } from '../src/runtime/xdb-server-sync';

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
