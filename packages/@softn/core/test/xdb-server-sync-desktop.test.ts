/**
 * Server sync on the desktop, where the store's records are kept by the native database and
 * loaded into the page's cache after the store starts: live records alone (`get_collection`
 * reads `deleted = 0`), each stamped as the native store wrote it.
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

const WS_URL = 'wss://sync.example.test/sync';

type Row = { id: string; collection: string; data: Record<string, unknown>; created_at: string; updated_at: string; deleted: boolean };

/** As the native store writes a stamp (chrono's `to_rfc3339`): `+00:00`, not `Z`. */
const nativeStamp = (at: number) => new Date(at).toISOString().replace('Z', '+00:00');

/** The native store's clock as a call reaches it: a moment after the page made the call. */
let nativeLag = 0;
const nativeNow = () => Date.now() + ++nativeLag;

/** As XDB's `edit_stamp`: the page's stamp when after the copy edited, else this clock's time, or just after a copy ahead of it. */
function nativeEditStamp(previous: string, asked: string | undefined): string {
  const now = nativeNow();
  const before = Date.parse(previous);
  const wanted = asked === undefined ? NaN : Date.parse(asked);
  if (Number.isFinite(wanted) && wanted <= now + 86_400_000 && !(wanted <= before)) return nativeStamp(wanted);
  return nativeStamp(before >= now && before - now <= 86_400_000 ? before + 1 : now);
}

let rows: Map<string, Row>;
/** Held back until released: the native store still loading. */
let loading: Promise<void> | null;
/** Collections the native store fails to read. */
let unreadable: Set<string>;
/** Held back until released, a collection at a time. */
let loadingOf: Map<string, Promise<void>>;

function storage() {
  const kept = new Map<string, string>();
  return {
    kept,
    getItem: (key: string) => kept.get(key) ?? null,
    setItem: (key: string, value: string) => { kept.set(key, value); },
    removeItem: (key: string) => { kept.delete(key); },
  };
}

const invoke = vi.fn(async (cmd: string, args: Record<string, unknown> = {}) => {
  switch (cmd) {
    case 'get_collections':
      return [...new Set([...rows.values()].map((row) => row.collection))];
    case 'get_collection': {
      if (loading) await loading;
      await loadingOf.get(String(args.collection));
      if (unreadable.has(String(args.collection))) throw new Error('database disk image is malformed');
      // As XDB's command: live records, or with `includeDeleted` the tombstones too.
      return [...rows.values()].filter((row) => row.collection === args.collection && (args.includeDeleted === true || !row.deleted));
    }
    case 'create_record': {
      const payload = args.payload as { collection: string; data: Record<string, unknown> };
      const at = nativeStamp(nativeNow());
      const row = { id: `native-${rows.size + 1}`, collection: payload.collection, data: payload.data, created_at: at, updated_at: at, deleted: false };
      rows.set(row.id, row);
      return row;
    }
    case 'update_record': {
      const payload = args.payload as { id: string; data: Record<string, unknown>; updated_at?: string };
      const row = rows.get(payload.id);
      if (!row || row.deleted) throw new Error(`Record not found: ${payload.id}`);
      const next = { ...row, data: { ...row.data, ...payload.data }, updated_at: nativeEditStamp(row.updated_at, payload.updated_at) };
      rows.set(row.id, next);
      return next;
    }
    case 'delete_record': {
      const row = rows.get(String(args.id));
      if (!row) throw new Error(`Record not found: ${String(args.id)}`);
      rows.set(row.id, { ...row, deleted: true, updated_at: nativeEditStamp(row.updated_at, args.updatedAt as string | undefined) });
      return true;
    }
    case 'upsert_record': {
      const record = args.record as Row;
      rows.set(record.id, record);
      return record;
    }
    case 'upsert_records': {
      for (const record of args.records as Row[]) rows.set(record.id, record);
      return [];
    }
    default:
      throw new Error(`Unexpected command: ${cmd}`);
  }
});

const page = (backing: ReturnType<typeof storage>) => new XDBService(backing, 'xdb:app', 'app');
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function client(store: XDBService) {
  return new XDBServerSync(store, { wsUrl: WS_URL, appVersion: '1', collections: ['notes'], reconnectDelay: 60_000 });
}

/** The socket the client opened, answered as the host does, the pull of `notes` empty; the host's clock `lead` ms ahead. */
async function answer(lead = 0) {
  const socket = FakeSocket.made[FakeSocket.made.length - 1];
  socket.open();
  socket.receive({ type: 'auth_ok', clientId: 'c1', serverTime: new Date(Date.now() + lead).toISOString() });
  socket.receive({ type: 'sync_state', collection: 'notes', records: [] });
  await settle();
  return socket;
}

const pushed = (socket: FakeSocket) =>
  socket.sent.filter((m) => m.type === 'sync_push').flatMap((m) => m.ops as Array<{ operation: string; recordId: string; timestamp: string; data?: { title?: string } }>);

/** A store a client has synced with: n1 is the host's, and the mark of where listening stopped is a minute back. */
function synced(backing: ReturnType<typeof storage>) {
  const at = nativeStamp(Date.now() - 120_000);
  rows.set('n1', { id: 'n1', collection: 'notes', data: { title: 'v1' }, created_at: at, updated_at: at, deleted: false });
  backing.setItem('xdb:app::sync-watched', String(Date.now() - 60_000));
}

beforeEach(() => {
  rows = new Map();
  loading = null;
  unreadable = new Set();
  loadingOf = new Map();
  nativeLag = 0;
  FakeSocket.made = [];
  invoke.mockClear();
  vi.stubGlobal('WebSocket', FakeSocket);
  (globalThis as unknown as { window: unknown }).window = globalThis;
  (globalThis as unknown as { __TAURI__: unknown }).__TAURI__ = {
    core: { invoke },
    event: { listen: vi.fn(async () => () => {}) },
  };
});

afterEach(() => {
  delete (globalThis as unknown as { __TAURI__?: unknown }).__TAURI__;
  vi.unstubAllGlobals();
});

describe('a deletion made on the desktop while no client listened', () => {
  // Its tombstone is not loaded with the store's records: the note's delete was taken for
  // stale, forgotten, and the host's copy came back with the next pull.
  it('is sent by the next page, which never loaded the tombstone', async () => {
    const backing = storage();
    synced(backing);
    const closed = page(backing);
    await closed.isReady;
    closed.delete('n1');
    await settle();
    expect(rows.get('n1')?.deleted).toBe(true);

    const next = page(backing);
    await next.isReady;
    const sync = client(next);
    sync.connect();
    await settle();
    const socket = await answer();
    expect(pushed(socket).filter((op) => op.recordId === 'n1').map((op) => op.operation)).toEqual(['delete']);
    sync.disconnect();
  });
});

describe("an edit made on the desktop while no client listened, its stamp written by the native store", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-03-01T00:00:00Z'), toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // The note's stamp (`Z`) never matched the record's (`+00:00`): the edit went at its own
  // stamp, without the host's lead, and on a device behind the host lost to edits made between.
  it("goes in the host's time from the next page", async () => {
    const backing = storage();
    synced(backing);
    const closed = page(backing);
    await closed.isReady;
    const editedAt = Date.now();
    closed.update('n1', { title: 'closed page' });
    await settle();
    expect(rows.get('n1')?.updated_at).toBe(nativeStamp(editedAt));

    const next = page(backing);
    await next.isReady;
    const sync = client(next);
    sync.connect();
    const socket = await answer(60_000);
    const op = pushed(socket).find((o) => o.recordId === 'n1');
    expect(op?.data?.title).toBe('closed page');
    expect(Date.parse(op!.timestamp)).toBe(editedAt + 60_000);
    sync.disconnect();
  });

  // SQLite stamped the update the create's callback sends with its own later time, and the
  // record here kept the create's stamp: the two never named one time again.
  it('made before its create landed, leaves the page and the native store holding one stamp', async () => {
    const store = page(storage());
    await store.isReady;
    const made = store.create('notes', { title: 'new' });
    store.update(made.id, { title: 'edited at once' });
    await settle();
    await settle();
    const [id] = [...rows.keys()];
    expect(rows.get(id)?.data.title).toBe('edited at once');
    expect(Date.parse(store.get('notes', id)!.updated_at)).toBe(Date.parse(rows.get(id)!.updated_at));
  });

  it("goes in the host's time from the page that made it, once the native store has answered", async () => {
    // A store never synced: no note, and the scan of stamps asks whose stamp each record has.
    const backing = storage();
    const at = nativeStamp(Date.now() - 120_000);
    rows.set('n1', { id: 'n1', collection: 'notes', data: { title: 'v1' }, created_at: at, updated_at: at, deleted: false });
    const store = page(backing);
    await store.isReady;
    const editedAt = Date.now();
    store.update('n1', { title: 'mine' });
    await settle();
    expect(store.get('notes', 'n1')?.updated_at).toBe(nativeStamp(editedAt));

    const sync = client(store);
    sync.connect();
    const socket = await answer(60_000);
    const op = pushed(socket).find((o) => o.recordId === 'n1');
    expect(op?.data?.title).toBe('mine');
    expect(Date.parse(op!.timestamp)).toBe(editedAt + 60_000);
    sync.disconnect();
  });
});

describe('a collection that fails to load on a store syncing for the first time', () => {
  // The store's list of collections names only those it loaded, so one that failed was never
  // looked at and the mark moved past it; or, listed, the mark was held but the pull positions
  // were saved, and the next page took the store for an older client's and looked for nothing.
  for (const listed of [false, true]) {
    it(`is sent whole once it loads${listed ? ', listed' : ''}`, async () => {
      const backing = storage();
      const at = nativeStamp(Date.now() - 120_000);
      rows.set('n1', { id: 'n1', collection: 'notes', data: { title: 'never sent' }, created_at: at, updated_at: at, deleted: false });
      unreadable.add('notes');
      const first = page(backing);
      const make = (store: XDBService) => new XDBServerSync(store, { wsUrl: WS_URL, appVersion: '1', ...(listed ? { collections: ['notes'] } : {}), reconnectDelay: 60_000 });
      const sync = make(first);
      sync.connect();
      await first.isReady;
      await settle();
      await answer();
      sync.disconnect();

      unreadable.delete('notes');
      const next = page(backing);
      await next.isReady;
      const later = make(next);
      later.connect();
      await settle();
      const socket = await answer();
      expect(pushed(socket).filter((op) => op.recordId === 'n1').map((op) => op.operation)).toEqual(['create']);
      later.disconnect();
    });
  }
});

describe('a deletion or an edit on the desktop of a record the store has not loaded', () => {
  // SQLite took it alone, and nothing told server sync: a deletion came undone with the next
  // pull. The loader starts an app before its records are in, so a script's change of a record
  // it knows is made once the store has loaded, as any change is.
  for (const kind of ['update', 'delete'] as const) {
    it(`made while it loads, goes once it has, and server sync hears of it (${kind})`, async () => {
      const backing = storage();
      synced(backing);
      let release!: () => void;
      loading = new Promise((resolve) => { release = resolve; });
      const store = page(backing);
      const sync = client(store);
      sync.connect();
      if (kind === 'update') expect(store.update('n1', { title: 'early' })).toBeNull();
      else expect(store.delete('n1')).toBe(true);
      release();
      await store.isReady;
      await settle();
      await settle();
      if (kind === 'update') expect(rows.get('n1')?.data.title).toBe('early');
      else expect(rows.get('n1')?.deleted).toBe(true);
      const socket = await answer();
      expect(pushed(socket).filter((op) => op.recordId === 'n1').map((op) => op.operation)).toEqual([kind]);
      sync.disconnect();
    });
  }

  it('made with deleteAsync while it loads, goes once it has, and server sync hears of it', async () => {
    const backing = storage();
    synced(backing);
    let release!: () => void;
    loading = new Promise((resolve) => { release = resolve; });
    const store = page(backing);
    const sync = client(store);
    sync.connect();
    const done = store.deleteAsync('n1');
    release();
    expect(await done).toBe(true);
    await settle();
    expect(rows.get('n1')?.deleted).toBe(true);
    const socket = await answer();
    expect(pushed(socket).filter((op) => op.recordId === 'n1').map((op) => op.operation)).toEqual(['delete']);
    sync.disconnect();
  });

  // Made once the whole store had loaded, it undid an edit made since in a collection that
  // loaded first.
  it('made while its collection loads, goes as soon as that collection has, before a later edit there', async () => {
    const at = nativeStamp(Date.now() - 120_000);
    rows.set('t1', { id: 't1', collection: 'tasks', data: { title: 'v1' }, created_at: at, updated_at: at, deleted: false });
    rows.set('n1', { id: 'n1', collection: 'notes', data: { title: 'v1' }, created_at: at, updated_at: at, deleted: false });
    let releaseTasks!: () => void;
    let releaseNotes!: () => void;
    loadingOf.set('tasks', new Promise((resolve) => { releaseTasks = resolve; }));
    loadingOf.set('notes', new Promise((resolve) => { releaseNotes = resolve; }));
    const store = page(storage());
    store.update('t1', { title: 'from the script, early' });
    releaseTasks();
    await settle();
    expect(store.get('tasks', 't1')?.data.title).toBe('from the script, early');
    store.update('t1', { title: 'the person, later' });
    releaseNotes();
    await store.isReady;
    await settle();
    expect(store.get('tasks', 't1')?.data.title).toBe('the person, later');
    expect(rows.get('t1')?.data.title).toBe('the person, later');
  });

  it('loaded without it, is refused, as in browser storage', async () => {
    const backing = storage();
    synced(backing);
    const store = page(backing);
    await store.isReady;
    expect(store.delete('missing')).toBe(false);
    expect(store.update('missing', { title: 'blind' })).toBeNull();
    expect(invoke.mock.calls.map(([cmd]) => cmd)).not.toContain('delete_record');
  });
});

describe('a record deleted on the desktop before the app moved to another host', () => {
  // The native store loaded live records alone: after a reload the page knew of no deletion,
  // and a host seeded before it wrote the record back, here and in SQLite.
  it('is not brought back by the new host, and its deletion is sent there', async () => {
    const backing = storage();
    synced(backing);
    const at = nativeStamp(Date.now() - 120_000);
    rows.set('n2', { id: 'n2', collection: 'notes', data: { title: 'v2' }, created_at: at, updated_at: at, deleted: false });
    const first = page(backing);
    await first.isReady;
    const sync = client(first);
    sync.connect();
    await settle();
    const socket = await answer();
    first.deleteFromCollection('notes', 'n1');
    await settle();
    socket.receive({ type: 'sync_ack', opIds: pushed(socket).map((op) => (op as unknown as { id: string }).id) });
    await settle();
    sync.disconnect();

    const next = page(backing);
    await next.isReady;
    const moved = new XDBServerSync(next, { wsUrl: 'wss://elsewhere.example.test/sync', appVersion: '1', collections: ['notes'], reconnectDelay: 60_000 });
    moved.connect();
    await settle();
    const there = FakeSocket.made[FakeSocket.made.length - 1];
    there.open();
    there.receive({ type: 'auth_ok', clientId: 'c2', serverTime: new Date().toISOString() });
    const seeded = new Date(Date.now() - 600_000).toISOString();
    there.receive({ type: 'sync_state', collection: 'notes', records: ['n1', 'n2'].map((id) => ({ id, collection: 'notes', data: { title: 'seeded' }, createdAt: seeded, updatedAt: seeded, serverReceivedAt: seeded })) });
    await settle();
    expect(next.get('notes', 'n1')).toBeNull();
    expect(rows.get('n1')?.deleted).toBe(true);
    expect(pushed(there).filter((op) => op.recordId === 'n1').map((op) => op.operation)).toEqual(['delete']);
    moved.disconnect();
  });

  // The cache holds every tombstone now: kept whatever SQLite said, a record a peer brought
  // back there stayed hidden for good.
  it('comes back here when a peer brings it back natively after it', async () => {
    const at = nativeStamp(Date.now() - 120_000);
    rows.set('n1', { id: 'n1', collection: 'notes', data: { title: 'v1' }, created_at: at, updated_at: at, deleted: true });
    const store = page(storage());
    await store.isReady;
    expect(store.get('notes', 'n1')).toBeNull();
    rows.set('n1', { ...rows.get('n1')!, deleted: false, data: { title: 'back from a peer' }, updated_at: nativeStamp(Date.now()) });
    await store.getAllAsync('notes');
    expect(store.get('notes', 'n1')?.data.title).toBe('back from a peer');
  });
});

describe("a pull's deletions on the desktop", () => {
  // One native call a record, each rewriting the collection's stored document.
  it('go to the native store in one call', async () => {
    const at = nativeStamp(Date.now() - 120_000);
    for (const id of ['a', 'b', 'c']) rows.set(id, { id, collection: 'notes', data: { title: id }, created_at: at, updated_at: at, deleted: false });
    const store = page(storage());
    await store.isReady;
    const sync = client(store);
    sync.connect();
    const socket = FakeSocket.made[FakeSocket.made.length - 1];
    socket.open();
    socket.receive({ type: 'auth_ok', clientId: 'c1', serverTime: new Date().toISOString() });
    invoke.mockClear();
    const gone = new Date().toISOString();
    socket.receive({
      type: 'sync_state',
      collection: 'notes',
      records: ['a', 'b', 'c'].map((id) => ({ id, collection: 'notes', data: {}, createdAt: at, updatedAt: gone, serverReceivedAt: gone, deleted: true })),
    });
    await settle();
    const commands = invoke.mock.calls.map(([cmd]) => cmd);
    expect(commands.filter((cmd) => cmd === 'upsert_records')).toHaveLength(1);
    expect(commands).not.toContain('delete_record');
    expect(['a', 'b', 'c'].map((id) => rows.get(id)?.deleted)).toEqual([true, true, true]);
    expect(store.query('notes')).toEqual([]);
    sync.disconnect();
  });
});

describe('a client that starts before the store has loaded', () => {
  // It read an empty store: the note's changes were skipped and forgotten, and the mark of
  // where listening stopped moved past them.
  it('waits for the load, and sends what the note holds', async () => {
    const backing = storage();
    synced(backing);
    const closed = page(backing);
    await closed.isReady;
    closed.update('n1', { title: 'closed page' });
    await settle();
    expect(closed.readUnheardNote().edits.map((edit) => edit.id)).toEqual(['n1']);

    let release!: () => void;
    loading = new Promise((resolve) => { release = resolve; });
    const next = page(backing);
    const sync = client(next);
    sync.connect();
    await settle();
    release();
    await next.isReady;
    await settle();
    const socket = await answer();
    expect(pushed(socket).filter((op) => op.recordId === 'n1').map((op) => op.data?.title)).toEqual(['closed page']);
    sync.disconnect();
  });

  it('opens nothing while it waits, and starts nothing once disconnected meanwhile', async () => {
    const backing = storage();
    synced(backing);
    let release!: () => void;
    loading = new Promise((resolve) => { release = resolve; });
    const next = page(backing);
    const sync = client(next);
    sync.connect();
    await settle();
    expect(FakeSocket.made).toHaveLength(0);
    sync.disconnect();
    release();
    await next.isReady;
    await settle();
    expect(FakeSocket.made).toHaveLength(0);
  });

  it('leaves what it could not load to a later client: its note, and the mark of where listening stopped', async () => {
    const backing = storage();
    synced(backing);
    const closed = page(backing);
    await closed.isReady;
    closed.update('n1', { title: 'closed page' });
    await settle();
    const mark = backing.getItem('xdb:app::sync-watched');

    unreadable.add('notes');
    const next = page(backing);
    const sync = client(next);
    sync.connect();
    await next.isReady;
    await settle();
    await answer();
    await settle();
    expect(next.readUnheardNote().edits.map((edit) => edit.id)).toEqual(['n1']);
    sync.disconnect();
    // Kept as it was, for this host.
    expect(JSON.parse(backing.getItem('xdb:app::sync-watched')!).marks[WS_URL]).toBe(Number(mark));
  });
});
