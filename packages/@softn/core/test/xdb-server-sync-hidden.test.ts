/**
 * Server sync for an app its host is not showing. Every app open in SoftN
 * Web kept a socket to its sync host behind whichever tab was on screen. A
 * hidden app now keeps one only while it has something to send, and for
 * `restAfterMs` after; what it writes meanwhile is still queued, a hard
 * delete included, and opens the socket to be sent.
 *
 * The server is driven by hand, as in xdb-server-sync.test.ts.
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
  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  receive(msg: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  drop(): void {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.();
  }
  ofType(type: string): Array<Record<string, unknown>> {
    return this.sent.filter((m) => m.type === type);
  }
}

function memoryStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
}

const REST = 30_000;
let xdb: XDBService;
let sync: XDBServerSync | null = null;

/** Open the newest socket, authenticate it and answer its pull of `notes` with nothing new. */
function bringUp(): FakeSocket {
  const socket = FakeSocket.made[FakeSocket.made.length - 1];
  socket.open();
  socket.receive({ type: 'auth_ok', clientId: 'c1', serverTime: '2026-01-01T00:00:00.000Z' });
  socket.receive({ type: 'sync_state', collection: 'notes', records: [] });
  return socket;
}

/** Acknowledge every op the socket has pushed. */
function ackAll(socket: FakeSocket): void {
  const ids = socket.ofType('sync_push').flatMap((push) => (push.ops as Array<{ id: string }>).map((op) => op.id));
  socket.receive({ type: 'sync_ack', opIds: ids });
}

function start(shown: boolean): XDBServerSync {
  sync = new XDBServerSync(xdb, { wsUrl: 'wss://sync.example.test/sync', collections: ['notes'] });
  sync.setAppShown(shown);
  sync.connect();
  return sync;
}

beforeEach(() => {
  FakeSocket.made = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  xdb = new XDBService(memoryStorage(), 'server-sync-hidden');
});

afterEach(() => {
  sync?.disconnect();
  sync = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('server sync for an app behind another tab', () => {
  it('lets its socket go after a while with nothing to send, and does not come back', () => {
    const client = start(true);
    const socket = bringUp();
    client.setAppShown(false);
    vi.advanceTimersByTime(REST - 1);
    expect(socket.readyState).toBe(FakeSocket.OPEN);
    vi.advanceTimersByTime(1);
    expect(socket.readyState).toBe(FakeSocket.CLOSED);
    vi.advanceTimersByTime(10 * 60_000);
    expect(FakeSocket.made).toHaveLength(1);
  });

  it('keeps the socket when shown again within the while', () => {
    const client = start(true);
    const socket = bringUp();
    client.setAppShown(false);
    vi.advanceTimersByTime(REST / 2);
    client.setAppShown(true);
    vi.advanceTimersByTime(REST * 2);
    expect(socket.readyState).toBe(FakeSocket.OPEN);
    expect(FakeSocket.made).toHaveLength(1);
  });

  it('opens the socket for what it writes while hidden, and lets it go once that is answered', () => {
    const client = start(true);
    bringUp();
    client.setAppShown(false);
    vi.advanceTimersByTime(REST);

    xdb.create('notes', { text: 'written while hidden' });
    expect(FakeSocket.made).toHaveLength(2);
    // Many writes at once open one socket.
    xdb.create('notes', { text: 'and another' });
    expect(FakeSocket.made).toHaveLength(2);

    const socket = bringUp();
    const pushed = socket.ofType('sync_push').flatMap((push) => push.ops as Array<{ data: { text: string } }>);
    expect(pushed.map((op) => op.data.text)).toEqual(['written while hidden', 'and another']);
    ackAll(socket);
    vi.advanceTimersByTime(REST);
    expect(socket.readyState).toBe(FakeSocket.CLOSED);
    vi.advanceTimersByTime(10 * 60_000);
    expect(FakeSocket.made).toHaveLength(2);
  });

  it('opens nothing when started hidden with nothing to send, until it writes or is shown', () => {
    const client = start(false);
    vi.advanceTimersByTime(10 * 60_000);
    expect(FakeSocket.made).toHaveLength(0);

    xdb.create('notes', { text: 'first' });
    expect(FakeSocket.made).toHaveLength(1);
    const socket = bringUp();
    ackAll(socket);
    vi.advanceTimersByTime(REST);
    expect(socket.readyState).toBe(FakeSocket.CLOSED);

    client.setAppShown(true);
    expect(FakeSocket.made).toHaveLength(2);
  });

  it('connects when started hidden with changes the server has not had', () => {
    // Written before any client listened: found by its time and queued.
    xdb.create('notes', { text: 'made offline' });
    start(false);
    expect(FakeSocket.made).toHaveLength(1);
    const socket = bringUp();
    expect(socket.ofType('sync_push')).toHaveLength(1);
  });

  it('queues a hard delete made while resting, which no later scan would find', () => {
    const client = start(true);
    let socket = bringUp();
    const record = xdb.create('notes', { text: 'to go' });
    ackAll(socket);
    client.setAppShown(false);
    vi.advanceTimersByTime(REST);
    expect(socket.readyState).toBe(FakeSocket.CLOSED);

    xdb.hardDelete('notes', record.id);
    expect(FakeSocket.made).toHaveLength(2);
    socket = bringUp();
    const ops = socket.ofType('sync_push').flatMap((push) => push.ops as Array<{ operation: string; recordId: string }>);
    expect(ops).toEqual([expect.objectContaining({ operation: 'delete', recordId: record.id })]);
  });

  it('does not reconnect a socket dropped while hidden with nothing to send', () => {
    const client = start(true);
    const socket = bringUp();
    client.setAppShown(false);
    socket.drop();
    vi.advanceTimersByTime(10 * 60_000);
    expect(FakeSocket.made).toHaveLength(1);
    client.setAppShown(true);
    expect(FakeSocket.made).toHaveLength(2);
  });

  it('leaves a reconnect waiting out its backoff to it when shown again', () => {
    const client = start(true);
    const socket = bringUp();
    // Dropped while shown: a reconnect is scheduled after a backoff.
    socket.drop();
    client.setAppShown(false);
    client.setAppShown(true);
    expect(FakeSocket.made).toHaveLength(1);
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.made).toHaveLength(2);
  });

  it('is told by the renderer whether the app is on screen', async () => {
    vi.useRealTimers();
    const { createElement } = await import('react');
    const { act } = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { SoftNWithXDB } = await import('../src/loader/xdb-bindings');
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const permissionConfig = { app: { name: 'Probe' }, permissions: { net: { enabled: true }, sync: { enabled: true } } };
    const render = (active: boolean) =>
      act(async () =>
        root.render(
          createElement(SoftNWithXDB, {
            source: '<div>probe</div>',
            appId: 'hidden-server-sync',
            serverUrl: 'wss://sync.example.test/sync',
            serverCollections: ['notes'],
            permissionConfig: permissionConfig as never,
            active,
          })
        )
      );
    const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
    try {
      await render(false);
      await settle();
      // Opened behind another tab, with nothing to send: no socket.
      expect(FakeSocket.made).toHaveLength(0);
      await render(true);
      await settle();
      expect(FakeSocket.made).toHaveLength(1);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it('runs as before for a host that never says', () => {
    sync = new XDBServerSync(xdb, { wsUrl: 'wss://sync.example.test/sync', collections: ['notes'] });
    sync.connect();
    const socket = bringUp();
    vi.advanceTimersByTime(10 * 60_000);
    expect(socket.readyState).toBe(FakeSocket.OPEN);
  });
});
