/**
 * What an independent review of XDB's browser data found removed, undone or
 * dropped without a word, each held here:
 * - bundled seed records came back at every opening after the person
 *   removed them (cleared, pruned, deleted for good), which leaves no record
 *   for seeding to find;
 * - a change the sync host refused was told only to `reject` listeners, which
 *   no host component has, so nothing showed it;
 * - an adapter disconnected and connected again stopped sending local writes
 *   to the room: it waited for the cache's `synced`, which is said once.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('y-webrtc', () => ({
  WebrtcProvider: class {
    shouldConnect = true;
    signalingConns: unknown[] = [];
    awareness = { setLocalStateField() {}, getLocalState: () => null, setLocalState() {}, getStates: () => new Map() };
    connect() {}
    disconnect() {}
    destroy() {}
  },
}));
// y-indexeddb says `synced` once per instance, after its first load.
vi.mock('y-indexeddb', () => ({
  IndexeddbPersistence: class {
    private handlers = new Map<string, Set<() => void>>();
    constructor() {
      setTimeout(() => {
        for (const h of this.handlers.get('synced') ?? []) h();
      }, 0);
    }
    on(e: string, h: () => void) {
      if (!this.handlers.has(e)) this.handlers.set(e, new Set());
      this.handlers.get(e)!.add(h);
    }
    off(e: string, h: () => void) {
      this.handlers.get(e)?.delete(h);
    }
    destroy() {}
  },
}));

import { XDBService, setDefaultXDB } from '../src/runtime/xdb';
import { XDBSyncAdapter } from '../src/runtime/xdb-sync';
import { XDBServerSync } from '../src/runtime/xdb-server-sync';
import { parseXDBFile, seedXDBBundleData } from '../src/bundle/bundle';
import { createDBNamespace } from '../src/runtime/script-modules';

function memory() {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
  };
}

const SEED = JSON.stringify({
  collection: 'todos',
  records: [
    { id: 'demo_1', text: 'Welcome', completed: false },
    { id: 'demo_2', text: 'Try adding', completed: false },
  ],
});

describe('bundled seed records', () => {
  for (const how of ['xdb.clear', 'db.clearCollection', 'db.prune', 'db.hardDelete', 'db.delete'] as const) {
    it(`stay removed after ${how} and a reopening`, async () => {
      const storage = memory();
      const data = parseXDBFile('todos.xdb', SEED);
      const first = new XDBService(storage, 'xdb:seedapp', 'seedapp', { backend: 'storage' });
      seedXDBBundleData(first, data);
      expect(first.getAll('todos')).toHaveLength(2);

      setDefaultXDB(first, 'seedapp');
      const db = createDBNamespace(undefined, 'seedapp');
      await db.ready();
      if (how === 'xdb.clear') first.clear('todos');
      if (how === 'db.clearCollection') db.clearCollection('todos');
      if (how === 'db.prune') db.prune('todos', 0);
      if (how === 'db.hardDelete') {
        db.hardDelete('todos', 'demo_1');
        db.hardDelete('todos', 'demo_2');
      }
      if (how === 'db.delete') {
        db.delete('demo_1');
        db.delete('demo_2');
      }
      expect(first.getAll('todos')).toHaveLength(0);

      // Opened again: the bundle seeds on every opening.
      const second = new XDBService(storage, 'xdb:seedapp', 'seedapp', { backend: 'storage' });
      expect(seedXDBBundleData(second, data)).toBe(0);
      expect(second.getAll('todos')).toHaveLength(0);
    });
  }

  it('a seed a later version of the app adds is still added', () => {
    const storage = memory();
    const first = new XDBService(storage, 'xdb:seedapp2', 'seedapp2', { backend: 'storage' });
    seedXDBBundleData(first, parseXDBFile('todos.xdb', SEED));
    first.clear('todos');
    const later = JSON.stringify({ collection: 'todos', records: [...JSON.parse(SEED).records, { id: 'demo_3', text: 'New in 2.0' }] });
    const second = new XDBService(storage, 'xdb:seedapp2', 'seedapp2', { backend: 'storage' });
    expect(seedXDBBundleData(second, parseXDBFile('todos.xdb', later))).toBe(1);
    expect(second.getAll('todos').map((r) => r.id)).toEqual(['demo_3']);
  });
});

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
  ops() {
    return this.sent.filter((m) => m.type === 'sync_push').flatMap((p) => p.ops as Array<Record<string, unknown>>);
  }
}

describe('a change the sync host refuses', () => {
  beforeEach(() => {
    FakeSocket.made = [];
    vi.stubGlobal('WebSocket', FakeSocket);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('is in the storage status the notice bar watches', async () => {
    const xdb = new XDBService(memory(), 'xdb:app3', 'app3', { backend: 'storage' });
    const sync = new XDBServerSync(xdb, { wsUrl: 'wss://sync.example.test/sync', appVersion: '1' });
    sync.connect();
    const socket = FakeSocket.made[FakeSocket.made.length - 1];
    socket.open();
    socket.receive({ type: 'auth_ok', clientId: 'c1', serverTime: '2026-10-24T10:00:00.000Z' });
    socket.receive({ type: 'sync_state', collection: 'notes', records: [] });
    const note = xdb.create('notes', { text: 'my note' });
    await new Promise((r) => setTimeout(r, 0));
    const op = socket.ops().find((o) => o.recordId === note.id)!;
    socket.receive({ type: 'sync_reject', opId: op.id, reason: 'Rejected by onBeforeSync hook' });
    await new Promise((r) => setTimeout(r, 0));
    const issue = xdb.getStorageStatus().issues.find((i) => i.kind === 'sync-refused');
    sync.disconnect();
    expect(issue?.collection).toBe('notes');
    expect(issue?.message).toContain('Rejected by onBeforeSync hook');
  });
});

it('an adapter disconnected and connected again still sends local writes to the room', async () => {
  const xdb = new XDBService(memory(), 'xdb:rc', 'rc', { backend: 'storage' });
  const adapter = new XDBSyncAdapter(xdb, { room: 'r', appId: 'rc', signaling: [] });
  adapter.connect();
  await new Promise((r) => setTimeout(r, 5));
  const first = xdb.create('notes', { n: 1 });
  expect(adapter.doc.getMap('notes').has(first.id)).toBe(true);
  adapter.disconnect();
  adapter.connect();
  await new Promise((r) => setTimeout(r, 5));
  const second = xdb.create('notes', { n: 2 });
  adapter.close();
  expect(adapter.doc.getMap('notes').has(second.id)).toBe(true);
});
