/**
 * A room's cache is deleted only where no other tab has the room open.
 *
 * `destroySync`, a room left for outgrowing what a room holds, and a host
 * removing an app (`forgetAppSync`) each deleted the room's IndexedDB
 * database at once. Another tab of the app with the room open then lost its
 * connection to it: a browser asks every open connection to close for a
 * deletion, and y-indexeddb's does (lib0's openDB closes on `versionchange`).
 * From then on y-indexeddb's handler threw on every change to that tab's
 * document. It runs before y-webrtc's, so the room in that tab stopped
 * sending, and every change the app made there threw.
 *
 * Two tabs are two loads of the sync modules (vi.resetModules), on one
 * IndexedDB, one lock manager and one localStorage, with the real
 * y-indexeddb. The provider stands in for y-webrtc's room, which sends every
 * change to the document; it counts them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeLocks } from './helpers/fake-locks';

const sent = vi.hoisted(() => ({ providers: [] as Array<{ room: string; sent: number }> }));

vi.mock('y-webrtc', () => ({
  WebrtcProvider: class {
    connected = true;
    shouldConnect = true;
    signalingConns: unknown[] = [];
    awareness = { getStates: () => new Map(), setLocalStateField() {}, getLocalState: () => null, setLocalState() {} };
    sent = 0;
    constructor(readonly room: string, doc: { on(event: 'update', handler: () => void): void }) {
      sent.providers.push(this);
      doc.on('update', () => {
        this.sent++;
      });
    }
    connect() {}
    disconnect() {}
    destroy() {}
  },
}));

import { destroySync, startSync, stopAllSync, stopSync, type XDBSyncAdapter } from '../src/runtime/xdb-sync';
import { forgetAppSync } from '../src/runtime/sync-app-state';
import { persistenceNameFor } from '../src/runtime/xdb-sync-key';
import { MAX_KEPT_ROOM_CACHES_PER_APP, keptRoomCaches } from '../src/runtime/sync-room-caches';

const APP = 'cache-holders-app';
const CACHE = persistenceNameFor(APP, 'lobby');

// ── An IndexedDB with connections, as y-indexeddb uses one ────────────────

type Handler = ((event: { target: unknown }) => void) | null;

class Request<T> {
  result: T | undefined;
  error: DOMException | null = null;
  onsuccess: Handler = null;
  onerror: Handler = null;
  onblocked: Handler = null;
  onupgradeneeded: Handler = null;
  succeed(result: T): void {
    this.result = result;
    this.onsuccess?.({ target: this });
  }
}

const later = (step: () => void): void => void setTimeout(step, 0);

/** The two bounds y-indexeddb asks for: from a key up, and below one. */
class KeyRange {
  private constructor(
    private readonly lower: number | null,
    private readonly upper: number | null,
    private readonly lowerOpen: boolean,
    private readonly upperOpen: boolean,
  ) {}
  static lowerBound(lower: number, open = false): KeyRange {
    return new KeyRange(lower, null, open, false);
  }
  static upperBound(upper: number, open = false): KeyRange {
    return new KeyRange(null, upper, false, open);
  }
  includes(key: number): boolean {
    if (this.lower !== null && (this.lowerOpen ? key <= this.lower : key < this.lower)) return false;
    if (this.upper !== null && (this.upperOpen ? key >= this.upper : key > this.upper)) return false;
    return true;
  }
}

class ObjectStore {
  readonly rows = new Map<number | string, unknown>();
  private next = 1;
  private keys(range?: KeyRange | null): Array<number | string> {
    return [...this.rows.keys()].filter((key) => !range || range.includes(key as number)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }
  private answer<T>(result: () => T): Request<T> {
    const request = new Request<T>();
    later(() => request.succeed(result()));
    return request;
  }
  add(value: unknown): Request<number> {
    return this.answer(() => {
      const key = this.next++;
      this.rows.set(key, value);
      return key;
    });
  }
  put(value: unknown, key: number | string): Request<number | string> {
    return this.answer(() => {
      this.rows.set(key, value);
      return key;
    });
  }
  get(key: number | string): Request<unknown> {
    return this.answer(() => this.rows.get(key));
  }
  delete(query: KeyRange | number | string): Request<undefined> {
    return this.answer(() => {
      for (const key of query instanceof KeyRange ? this.keys(query) : [query]) this.rows.delete(key);
      return undefined;
    });
  }
  count(range?: KeyRange | null): Request<number> {
    return this.answer(() => this.keys(range).length);
  }
  getAll(range?: KeyRange | null): Request<unknown[]> {
    return this.answer(() => this.keys(range).map((key) => this.rows.get(key)));
  }
  openKeyCursor(range: KeyRange | null, direction: 'next' | 'prev' = 'next'): Request<{ key: unknown; continue(): void } | null> {
    const keys = this.keys(range);
    if (direction === 'prev') keys.reverse();
    const request = new Request<{ key: unknown; continue(): void } | null>();
    let at = 0;
    const step = (): void => later(() => request.succeed(at < keys.length ? { key: keys[at], continue: () => { at++; step(); } } : null));
    step();
    return request;
  }
}

class Connection {
  closed = false;
  onversionchange: ((event: unknown) => void) | null = null;
  constructor(
    private readonly factory: ConnectionsIndexedDB,
    readonly name: string,
    private readonly stores: Map<string, ObjectStore>,
  ) {}
  createObjectStore(name: string): ObjectStore {
    const store = new ObjectStore();
    this.stores.set(name, store);
    return store;
  }
  transaction(_names: string | string[]): { objectStore(name: string): ObjectStore | undefined } {
    // A connection that has closed makes no more transactions: what y-indexeddb's handler ran into.
    if (this.closed) throw new DOMException('The database connection is closing.', 'InvalidStateError');
    return { objectStore: (name) => this.stores.get(name) };
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.factory.closed(this);
  }
}

class ConnectionsIndexedDB {
  private readonly stored = new Map<string, Map<string, ObjectStore>>();
  private readonly connections = new Set<Connection>();
  /** Deletions waiting for a database's connections to close. */
  private readonly waiting = new Map<string, Array<() => void>>();
  /** Every deletion asked for, by name, in order. */
  readonly deletions: string[] = [];

  has(name: string): boolean {
    return this.stored.has(name);
  }
  /** How many updates a room's cache holds. */
  updates(name: string): number {
    return this.stored.get(name)?.get('updates')?.rows.size ?? 0;
  }
  openConnections(name: string): number {
    return [...this.connections].filter((c) => c.name === name).length;
  }

  open(name: string): Request<Connection> {
    const request = new Request<Connection>();
    later(() => {
      let stores = this.stored.get(name);
      const created = !stores;
      if (!stores) {
        stores = new Map();
        this.stored.set(name, stores);
      }
      const connection = new Connection(this, name, stores);
      this.connections.add(connection);
      request.result = connection;
      if (created) request.onupgradeneeded?.({ target: request });
      request.succeed(connection);
    });
    return request;
  }

  /** As a browser deletes: every open connection is asked to close, and the deletion waits for the ones that do not. */
  deleteDatabase(name: string): Request<undefined> {
    const request = new Request<undefined>();
    this.deletions.push(name);
    later(() => {
      for (const connection of [...this.connections]) if (connection.name === name) connection.onversionchange?.({ target: connection });
      const finish = (): void => {
        this.stored.delete(name);
        request.succeed(undefined);
      };
      if (this.openConnections(name) === 0) finish();
      else {
        request.onblocked?.({ target: request });
        this.waiting.set(name, [...(this.waiting.get(name) ?? []), finish]);
      }
    });
    return request;
  }

  closed(connection: Connection): void {
    this.connections.delete(connection);
    if (this.openConnections(connection.name) > 0) return;
    for (const finish of this.waiting.get(connection.name) ?? []) finish();
    this.waiting.delete(connection.name);
  }

  databases(): Promise<Array<{ name: string; version: number }>> {
    return Promise.resolve([...this.stored.keys()].map((name) => ({ name, version: 1 })));
  }
}

// ── Tabs ──────────────────────────────────────────────────────────────────

/** Another tab: the sync modules loaded again, on the same IndexedDB, lock manager and storage. */
async function anotherTab(): Promise<{ startSync: typeof startSync; stopSync: typeof stopSync; stopAllSync: typeof stopAllSync }> {
  vi.resetModules();
  return import('../src/runtime/xdb-sync');
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

/** The stand-in provider of the adapter started last. */
const lastProvider = () => sent.providers[sent.providers.length - 1];

/** A change the app makes to the room's document in a tab: kept in that tab's cache and sent to the room. */
function writeIn(adapter: XDBSyncAdapter, provider: { sent: number }, key: string): { threw: unknown; sent: boolean } {
  const before = provider.sent;
  let threw: unknown = null;
  try {
    adapter.doc.getMap('notes').set(key, { body: key });
  } catch (err) {
    threw = err;
  }
  return { threw, sent: provider.sent > before };
}

let idb: ConnectionsIndexedDB;
let locks: ReturnType<typeof fakeLocks>;
const tabs: Array<{ stopAllSync: () => void }> = [];

beforeEach(() => {
  localStorage.clear();
  sent.providers.length = 0;
  idb = new ConnectionsIndexedDB();
  vi.stubGlobal('indexedDB', idb);
  vi.stubGlobal('IDBKeyRange', KeyRange);
  locks = fakeLocks();
  Object.defineProperty(navigator, 'locks', { value: locks, configurable: true });
  // Two loads of Yjs in one page, as two tabs are; it says so on the console.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  for (const tab of tabs.splice(0)) tab.stopAllSync();
  stopAllSync();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, 'locks');
});

/** Tab B with `lobby` open and its cache loaded, then this tab (A) in the same room. */
async function bothInTheRoom() {
  const other = await anotherTab();
  tabs.push(other);
  const b = other.startSync({ room: 'lobby', appId: APP, signaling: [] });
  const bProvider = lastProvider();
  await settle();
  const a = startSync({ room: 'lobby', appId: APP, signaling: [] });
  await settle();
  expect(idb.openConnections(CACHE)).toBe(2);
  expect(writeIn(b, bProvider, 'before')).toEqual({ threw: null, sent: true });
  await settle();
  return { other, a, b, bProvider };
}

/** What tab B can still do once tab A has done away with its copy of the room. */
async function tabBGoesOn(b: XDBSyncAdapter, bProvider: { sent: number }) {
  await settle();
  expect(idb.has(CACHE)).toBe(true);
  expect(idb.openConnections(CACHE)).toBe(1);
  const kept = idb.updates(CACHE);
  expect(writeIn(b, bProvider, 'after')).toEqual({ threw: null, sent: true });
  await settle();
  expect(idb.updates(CACHE)).toBe(kept + 1);
}

describe('a room’s cache that another tab has open', () => {
  it('is not deleted by destroySync, and the other tab’s room goes on; it stays on the app’s list', async () => {
    const { b, bProvider } = await bothInTheRoom();
    await destroySync('lobby', APP);
    await tabBGoesOn(b, bProvider);
    expect(idb.deletions).toEqual([]);
    expect(keptRoomCaches(APP)).toContain('lobby');
  });

  it('is not deleted for a room this tab left for outgrowing what a room holds', async () => {
    const { a, b, bProvider } = await bothInTheRoom();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    a.onOvergrown?.();
    await settle();
    await tabBGoesOn(b, bProvider);
    expect(idb.deletions).toEqual([]);
    expect(keptRoomCaches(APP)).toContain('lobby');
  });

  it('is not deleted by a host removing the app here, and is still listed afterwards', async () => {
    const { b, bProvider } = await bothInTheRoom();
    // The host stops the app in this tab, then removes it.
    stopSync(undefined, APP);
    await forgetAppSync(APP);
    await tabBGoesOn(b, bProvider);
    expect(idb.deletions).toEqual([]);
    // Not lost track of: the app's list names it, though the rest of what sync kept for the app is gone.
    expect(keptRoomCaches(APP)).toEqual(['lobby']);
  });

  it('is deleted once the other tab has left the room', async () => {
    const { other, b, bProvider } = await bothInTheRoom();
    await destroySync('lobby', APP);
    await tabBGoesOn(b, bProvider);
    other.stopSync('lobby', APP);
    await settle();
    // Kept as the one joined longest ago, it is the first to go when the app has more than it keeps.
    expect(keptRoomCaches(APP)[0]).toBe('lobby');
    for (let i = 0; i < MAX_KEPT_ROOM_CACHES_PER_APP; i++) {
      startSync({ room: `room-${i}`, appId: APP, signaling: [] });
      stopSync(`room-${i}`, APP);
    }
    await settle();
    expect(idb.deletions).toEqual([CACHE]);
    expect(idb.has(CACHE)).toBe(false);
    expect(keptRoomCaches(APP)).not.toContain('lobby');
  });

  it('is deleted at once where no other tab has the room', async () => {
    startSync({ room: 'lobby', appId: APP, signaling: [] });
    await settle();
    await destroySync('lobby', APP);
    await settle();
    expect(idb.deletions).toEqual([CACHE]);
    expect(idb.has(CACHE)).toBe(false);
    expect(keptRoomCaches(APP)).toEqual([]);
  });

  it('is deleted at once, as before, in a browser with no locks to tell', async () => {
    Reflect.deleteProperty(navigator, 'locks');
    const { b, bProvider } = await bothInTheRoom();
    await destroySync('lobby', APP);
    await settle();
    expect(idb.deletions).toEqual([CACHE]);
    expect(idb.has(CACHE)).toBe(false);
    expect(keptRoomCaches(APP)).toEqual([]);
    // What a browser with no locks leaves the other tab with: its cache is gone under it.
    expect(writeIn(b, bProvider, 'after')).toEqual({ threw: expect.any(DOMException), sent: false });
  });
});
