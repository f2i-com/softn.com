/**
 * Many changes at once, from the host or made here: each was written or pushed alone. A delta
 * carries another client's whole push, and each of its records read and wrote the collection
 * whole; a pull's deletions were removed one at a time the same way; and a script's loop of a
 * thousand writes went to the host as a thousand pushes.
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
}

/** A store whose writes of the `notes` collection are counted. */
function counted() {
  const kept = new Map<string, string>();
  const writes = { notes: 0 };
  const backing = {
    getItem: (key: string) => kept.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (key === 'xdb:app:notes') writes.notes++;
      kept.set(key, value);
    },
    removeItem: (key: string) => { kept.delete(key); },
  };
  return { store: new XDBService(backing, 'xdb:app', 'app', { backend: 'storage' }), writes };
}

function online(store: XDBService) {
  const sync = new XDBServerSync(store, { wsUrl: 'wss://sync.example.test/sync', appVersion: '1', collections: ['notes'], reconnectDelay: 60_000 });
  sync.connect();
  const socket = FakeSocket.made[FakeSocket.made.length - 1];
  socket.open();
  socket.receive({ type: 'auth_ok', clientId: 'c1', serverTime: new Date().toISOString() });
  return { sync, socket };
}

const at = '2026-02-01T00:00:00.000Z';
const row = (id: string, extra: Record<string, unknown> = {}) => ({ id, collection: 'notes', data: { title: id }, createdAt: at, updatedAt: at, serverReceivedAt: at, ...extra });
const ids = (n: number) => Array.from({ length: n }, (_, i) => `r${i}`);

beforeEach(() => {
  FakeSocket.made = [];
  vi.stubGlobal('WebSocket', FakeSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a delta of many records', () => {
  it('is written in one write of its collection, in order', () => {
    const { store, writes } = counted();
    const { sync, socket } = online(store);
    socket.receive({ type: 'sync_state', collection: 'notes', records: [] });
    const before = writes.notes;
    const ops = ids(50).map((id, i) => ({ id: `d${i}`, collection: 'notes', operation: 'create', recordId: id, data: { title: id }, timestamp: at, clientId: 'c9' }));
    // And an edit of one of them after its create, in the same delta.
    ops.push({ id: 'd50', collection: 'notes', operation: 'update', recordId: 'r0', data: { title: 'edited' }, timestamp: '2026-02-02T00:00:00.000Z', clientId: 'c9' });
    socket.receive({ type: 'sync_delta', ops });
    expect(writes.notes - before).toBe(1);
    expect(store.query('notes')).toHaveLength(50);
    expect(store.get('notes', 'r0')?.data).toEqual({ title: 'edited' });
    sync.disconnect();
  });

  it('keeps each record in order where deletions come between', () => {
    const { store, writes } = counted();
    const { sync, socket } = online(store);
    socket.receive({ type: 'sync_state', collection: 'notes', records: [] });
    const before = writes.notes;
    const op = (id: string, operation: string, recordId: string, title?: string) => ({ id, collection: 'notes', operation, recordId, ...(title ? { data: { title } } : {}), timestamp: at, clientId: 'c9' });
    socket.receive({ type: 'sync_delta', ops: [op('a', 'create', 'x', 'x'), op('b', 'create', 'y', 'y'), op('c', 'delete', 'x'), op('d', 'delete', 'y'), op('e', 'create', 'x2', 'x2')] });
    expect(store.query('notes').map((r) => r.id)).toEqual(['x2']);
    expect(writes.notes - before).toBe(3);
    sync.disconnect();
  });
});

describe("a pull's deletions", () => {
  it('are removed in one write of their collection', () => {
    const { store, writes } = counted();
    const { sync, socket } = online(store);
    socket.receive({ type: 'sync_state', collection: 'notes', records: ids(50).map((id) => row(id)) });
    expect(store.query('notes')).toHaveLength(50);
    const before = writes.notes;
    socket.receive({ type: 'sync_state', collection: 'notes', records: ids(50).map((id) => row(id, { deleted: true, updatedAt: '2026-02-02T00:00:00.000Z' })) });
    expect(store.query('notes')).toEqual([]);
    expect(writes.notes - before).toBe(1);
    sync.disconnect();
  });
});

describe('many changes made here in one task', () => {
  it('go to the host in a push or two, not one a change', async () => {
    const { store } = counted();
    const { sync, socket } = online(store);
    socket.receive({ type: 'sync_state', collection: 'notes', records: [] });
    for (let i = 0; i < 100; i++) store.create('notes', { n: i });
    await Promise.resolve();
    const pushes = socket.sent.filter((m) => m.type === 'sync_push');
    expect(pushes.flatMap((m) => m.ops as unknown[])).toHaveLength(100);
    expect(pushes.length).toBeLessThanOrEqual(2);
    sync.disconnect();
  });
});
