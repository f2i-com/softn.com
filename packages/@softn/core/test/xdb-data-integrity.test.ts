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

import * as Y from 'yjs';
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

  it('saves a collection once for a whole seed, keeping the first of a repeated id', () => {
    const storage = memory();
    const saves: string[] = [];
    const counted = { ...storage, setItem: (k: string, v: string) => { saves.push(k); storage.setItem(k, v); } };
    const xdb = new XDBService(counted, 'xdb:seedapp3', 'seedapp3', { backend: 'storage' });
    const records = Array.from({ length: 60 }, (_, i) => ({ id: `n${i}`, title: `Note ${i}` }));
    const seed = JSON.stringify({ collection: 'notes', records: [...records, { id: 'n0', title: 'Repeated' }] });
    expect(seedXDBBundleData(xdb, parseXDBFile('notes.xdb', seed))).toBe(60);
    expect(xdb.getAll('notes')).toHaveLength(60);
    expect(xdb.get('notes', 'n0')?.data.title).toBe('Note 0');
    // One save of the collection, where there was one a record, beside the list of collections
    // and the seed's mark.
    expect(saves).toEqual(['xdb:seedapp3:notes', 'xdb:seedapp3::collections', 'xdb:seedapp3::seeded:notes']);
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

describe('a change the sync host could not read', () => {
  // The host parses a push whole. A change it could not read (half an emoji,
  // or data nested past its 64 levels) had the whole push refused, every op
  // in it was sent again later, and every change made after it with them:
  // nothing more from this device ever reached the host.
  beforeEach(() => {
    FakeSocket.made = [];
    vi.stubGlobal('WebSocket', FakeSocket);
  });
  afterEach(() => vi.unstubAllGlobals());

  const connected = (name: string) => {
    const xdb = new XDBService(memory(), `xdb:${name}`, name, { backend: 'storage' });
    const sync = new XDBServerSync(xdb, { wsUrl: 'wss://sync.example.test/sync', appVersion: '1' });
    sync.connect();
    const socket = FakeSocket.made[FakeSocket.made.length - 1];
    socket.open();
    socket.receive({ type: 'auth_ok', clientId: 'c1', serverTime: '2026-10-24T10:00:00.000Z' });
    socket.receive({ type: 'sync_state', collection: 'notes', records: [] });
    return { xdb, sync, socket };
  };
  /** The deepest the host's reader goes into a message's text, as util.rs counts it. */
  const depthOf = (text: string) => {
    let depth = 0;
    let deepest = 0;
    let inString = false;
    let escape = false;
    for (const ch of text) {
      if (escape) escape = false;
      else if (ch === '\\' && inString) escape = true;
      else if (ch === '"') inString = !inString;
      else if (!inString && (ch === '{' || ch === '[')) deepest = Math.max(deepest, ++depth);
      else if (!inString && (ch === '}' || ch === ']')) depth--;
    }
    return deepest;
  };

  it('sends half an emoji as U+FFFD, and the changes after it with it', async () => {
    const { xdb, sync, socket } = connected('wellformed');
    const cut = 'Party 🎉 time'.slice(0, 7);
    const first = xdb.create('notes', { excerpt: cut, [cut]: 'a key cut too' });
    const second = xdb.create('notes', { excerpt: 'fine' });
    await new Promise((r) => setTimeout(r, 0));
    const pushed = socket.ops();
    sync.disconnect();
    const sent = pushed.find((o) => o.recordId === first.id)!;
    expect(JSON.stringify(sent.data)).not.toMatch(/\\ud[89ab]/i);
    expect((sent.data as Record<string, string>).excerpt).toBe('Party �');
    expect((sent.data as Record<string, string>)['Party �']).toBe('a key cut too');
    expect(pushed.some((o) => o.recordId === second.id)).toBe(true);
  });

  it('keeps a change nested deeper than the host reads, says so, and sends the changes after it', async () => {
    const { xdb, sync, socket } = connected('toodeep');
    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 70; i++) deep = { child: deep };
    const nested = xdb.create('notes', { outline: deep });
    let fine: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 50; i++) fine = { child: fine };
    const ok = xdb.create('notes', { outline: fine });
    await new Promise((r) => setTimeout(r, 0));
    const pushes = socket.sent.filter((m) => m.type === 'sync_push');
    const issue = xdb.getStorageStatus().issues.find((i) => i.kind === 'sync-refused');
    sync.disconnect();
    expect(socket.ops().some((o) => o.recordId === nested.id)).toBe(false);
    expect(socket.ops().some((o) => o.recordId === ok.id)).toBe(true);
    for (const push of pushes) expect(depthOf(JSON.stringify(push))).toBeLessThanOrEqual(64);
    expect(issue?.message).toContain('nested more than 61 levels deep');
    // Kept on this device as it was.
    expect(xdb.get('notes', nested.id)).toBeTruthy();
  });
});

describe('an import or a restore', () => {
  // An import said only `refresh`, which server sync does not hear: what it
  // brought stayed on the device it was made on, and the next pull took it back.
  beforeEach(() => {
    FakeSocket.made = [];
    vi.stubGlobal('WebSocket', FakeSocket);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('reaches the sync host as the writes it amounts to', async () => {
    const xdb = new XDBService(memory(), 'xdb:imports', 'imports', { backend: 'storage' });
    const sync = new XDBServerSync(xdb, { wsUrl: 'wss://sync.example.test/sync', appVersion: '1' });
    sync.connect();
    const socket = FakeSocket.made[FakeSocket.made.length - 1];
    socket.open();
    socket.receive({ type: 'auth_ok', clientId: 'c1', serverTime: '2026-10-24T10:00:00.000Z' });
    socket.receive({ type: 'sync_state', collection: 'notes', records: [] });
    const kept = xdb.create('notes', { text: 'before' });
    const same = xdb.create('notes', { text: 'unchanged' });
    await new Promise((r) => setTimeout(r, 0));
    socket.receive({ type: 'sync_ack', opIds: socket.ops().map((o) => o.id) });
    const sentBefore = socket.ops().length;

    const at = '2026-10-24T10:00:00.000Z';
    xdb.import({ collections: { notes: [
      { id: kept.id, collection: 'notes', data: { text: 'from the backup' }, created_at: at, updated_at: at },
      { id: same.id, collection: 'notes', data: { text: 'unchanged' }, created_at: at, updated_at: at },
      { id: 'new-one', collection: 'notes', data: { text: 'new' }, created_at: at, updated_at: at },
    ] } } as never);
    await new Promise((r) => setTimeout(r, 0));
    const imported = socket.ops().slice(sentBefore).map((o) => [o.type ?? o.operation, o.recordId]);
    expect(imported).toEqual(expect.arrayContaining([['update', kept.id], ['create', 'new-one']]));
    expect(imported.some(([, id]) => id === same.id), 'an unchanged record is not sent').toBe(false);
    socket.receive({ type: 'sync_ack', opIds: socket.ops().map((o) => o.id) });
    const sentAfterImport = socket.ops().length;

    // A restore holds what the backup holds: the record it lacks is deleted.
    xdb.restore({ collections: { notes: [{ id: 'new-one', collection: 'notes', data: { text: 'new' }, created_at: at, updated_at: at }] } } as never);
    await new Promise((r) => setTimeout(r, 0));
    const restored = socket.ops().slice(sentAfterImport).map((o) => [o.type ?? o.operation, o.recordId]);
    sync.disconnect();
    expect(restored).toEqual(expect.arrayContaining([['delete', kept.id], ['delete', same.id]]));
    expect(restored.some(([, id]) => id === 'new-one')).toBe(false);
  });
});

it('a record the sync host sends for one collection is written to that collection, whatever it names', () => {
  FakeSocket.made = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  try {
    const xdb = new XDBService(memory(), 'xdb:named', 'named', { backend: 'storage' });
    const writes: Array<{ collection: string; record: { collection: string } }> = [];
    const write = (xdb as unknown as { writeRecord: (c: string, r: { collection: string }) => void }).writeRecord.bind(xdb);
    (xdb as unknown as { writeRecord: (c: string, r: { collection: string }) => void }).writeRecord = (collection, record) => {
      writes.push({ collection, record });
      write(collection, record);
    };
    const sync = new XDBServerSync(xdb, { wsUrl: 'wss://sync.example.test/sync', appVersion: '1', collections: ['notes'] });
    sync.connect();
    const socket = FakeSocket.made[FakeSocket.made.length - 1];
    socket.open();
    socket.receive({ type: 'auth_ok', clientId: 'c1', serverTime: '2026-10-24T10:00:00.000Z' });
    const record = { id: 'r1', collection: 'secrets', data: { text: 'in notes' }, createdAt: '2026-10-24T10:00:00.000Z', updatedAt: '2026-10-24T10:00:00.000Z', serverReceivedAt: '2026-10-24T10:00:00.000Z' };
    socket.receive({ type: 'sync_state', collection: 'notes', records: [record] });
    socket.receive({ type: 'sync_delta', ops: [{ id: 'op1', type: 'update', operation: 'update', collection: 'notes', recordId: 'r1', data: { text: 'again' }, timestamp: '2026-10-24T10:00:01.000Z', clientId: 'c2' }] });
    sync.disconnect();
    expect(writes.length).toBeGreaterThan(0);
    for (const w of writes) expect(w.record.collection).toBe('notes');
    expect(xdb.getAll('secrets')).toEqual([]);
  } finally {
    vi.unstubAllGlobals();
  }
});

describe('a record removed for good while the room was not open', () => {
  // Peer sync told the room of a removal as it was made, while it was open.
  // One made while it was not reached nobody, and at the next opening the
  // room's copy was written back into the store as a record it lacked.
  const roomWith = async (name: string, remove: (db: ReturnType<typeof createDBNamespace>, id: string, xdb: XDBService) => void = (db, id) => db.hardDelete('notes', id)) => {
    const storage = memory();
    const xdb = new XDBService(storage, `xdb:${name}`, name, { backend: 'storage' });
    const first = new XDBSyncAdapter(xdb, { room: 'r', appId: name, signaling: [] });
    first.connect();
    await new Promise((r) => setTimeout(r, 5));
    const note = xdb.create('notes', { text: 'to remove' });
    const kept = xdb.create('notes', { text: 'to keep' });
    const room = Y.encodeStateAsUpdate(first.doc);
    first.close();
    setDefaultXDB(xdb, name);
    const db = createDBNamespace(undefined, name);
    await db.ready();
    remove(db, note.id, xdb);
    await new Promise((r) => setTimeout(r, 0));
    return { xdb, note, kept, room };
  };

  // The store's clear kept no note of what it took, as hardDelete and a prune do (and so
  // clearCollection, which removes through them): every record came back from the room at its
  // next opening.
  it("is taken out of the room for each record the store's clear took", async () => {
    const { xdb, note, kept, room } = await roomWith('removed-cleared', (_db, _id, store) => store.clear('notes'));
    const next = new XDBSyncAdapter(xdb, { room: 'r', appId: 'removed-cleared', signaling: [] });
    Y.applyUpdate(next.doc, room, 'cache');
    next.connect();
    await new Promise((r) => setTimeout(r, 5));
    const notes = next.doc.getMap('notes');
    next.close();
    expect(notes.has(note.id)).toBe(false);
    expect(notes.has(kept.id)).toBe(false);
    expect(xdb.getAll('notes')).toEqual([]);
  });

  it('is taken out of the room at the next opening, where the room holds it', async () => {
    const { xdb, note, kept, room } = await roomWith('removed-open');
    const next = new XDBSyncAdapter(xdb, { room: 'r', appId: 'removed-open', signaling: [] });
    Y.applyUpdate(next.doc, room, 'cache');
    next.connect();
    await new Promise((r) => setTimeout(r, 5));
    const notes = next.doc.getMap('notes');
    next.close();
    expect(notes.has(note.id)).toBe(false);
    expect(notes.has(kept.id)).toBe(true);
    expect(xdb.get('notes', note.id)).toBeNull();
    expect(xdb.pendingRemovals('notes')).toEqual([]);
  });

  it('is taken out when a peer brings it later, and not written back', async () => {
    const { xdb, note, room } = await roomWith('removed-peer');
    const next = new XDBSyncAdapter(xdb, { room: 'r', appId: 'removed-peer', signaling: [] });
    next.connect();
    await new Promise((r) => setTimeout(r, 5));
    Y.applyUpdate(next.doc, room, 'peer');
    await new Promise((r) => setTimeout(r, 0));
    const notes = next.doc.getMap('notes');
    next.close();
    expect(xdb.get('notes', note.id)).toBeNull();
    expect(notes.has(note.id)).toBe(false);
  });

  it('is not the room’s to hear once the record is made here again', async () => {
    const { xdb, note, room } = await roomWith('removed-again');
    xdb.writeRecord('notes', { id: note.id, collection: 'notes', data: { text: 'back' }, created_at: '2026-10-24T11:00:00.000Z', updated_at: '2099-01-01T00:00:00.000Z', deleted: false });
    const next = new XDBSyncAdapter(xdb, { room: 'r', appId: 'removed-again', signaling: [] });
    Y.applyUpdate(next.doc, room, 'cache');
    next.connect();
    await new Promise((r) => setTimeout(r, 5));
    const notes = next.doc.getMap('notes');
    next.close();
    expect(notes.has(note.id)).toBe(true);
    expect(xdb.get('notes', note.id)?.data).toEqual({ text: 'back' });
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
