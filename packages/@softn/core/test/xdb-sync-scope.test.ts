/**
 * The sync registry, scoped to the app that is syncing.
 *
 * It used to be keyed by room alone. Two bundles mounted in one document that
 * both chose the room "lobby" — an ordinary label — were handed one adapter:
 * the second got the first one's, on the first one's database, and either
 * one's `stopSync` cut the other off. The offline cache was named by room
 * too, so two apps that had never met shared a CRDT document on disk.
 *
 * The second half of this file runs two real Y.Docs against two real XDB
 * instances and exchanges their updates by hand, because the reconciliation
 * bugs — a stale local snapshot overwriting a newer shared record, a refresh
 * rewriting a whole collection, the first record of a new collection going
 * missing — are not visible to a mock that only checks "connected".
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as Y from 'yjs';
import { XDBService } from '../src/runtime/xdb';

const persistenceNames: string[] = [];
const persistenceInstances: Array<{ destroy: ReturnType<typeof vi.fn>; clearData: ReturnType<typeof vi.fn>; name: string }> = [];

vi.mock('y-webrtc', () => ({
  WebrtcProvider: class MockWebrtcProvider {
    connected = true;
    awareness = { getStates: () => new Map([[1, {}]]), setLocalStateField: vi.fn() };
    room = { webrtcConns: new Map() };
    destroy = vi.fn();
  },
}));

vi.mock('y-indexeddb', () => ({
  IndexeddbPersistence: class MockIndexeddbPersistence {
    private listeners = new Map<string, Set<() => void>>();
    destroy = vi.fn();
    clearData = vi.fn(() => Promise.resolve());
    name: string;
    constructor(dbName: string, _ydoc: unknown) {
      this.name = dbName;
      persistenceNames.push(dbName);
      persistenceInstances.push(this);
      setTimeout(() => {
        const handlers = this.listeners.get('synced');
        if (handlers) handlers.forEach((h) => h());
      }, 0);
    }
    on(event: string, handler: () => void) {
      if (!this.listeners.has(event)) this.listeners.set(event, new Set());
      this.listeners.get(event)!.add(handler);
    }
    off(event: string, handler: () => void) {
      this.listeners.get(event)?.delete(handler);
    }
  },
}));

import {
  XDBSyncAdapter,
  startSync,
  stopSync,
  stopAllSync,
  destroySync,
  getSyncAdapter,
  getAllSyncStatus,
  getSavedSyncRoom,
  persistenceNameFor,
} from '../src/runtime/xdb-sync';

function memoryStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
}

beforeEach(() => {
  localStorage.clear();
  persistenceNames.length = 0;
  persistenceInstances.length = 0;
});

afterEach(() => {
  stopAllSync();
});

describe('two apps that choose the same room label', () => {
  it('get two adapters, not one', () => {
    const a = startSync({ room: 'lobby', appId: 'AppA', signaling: [] });
    const b = startSync({ room: 'lobby', appId: 'AppB', signaling: [] });
    expect(a).not.toBe(b);
    expect(getSyncAdapter('lobby', 'AppA')).toBe(a);
    expect(getSyncAdapter('lobby', 'AppB')).toBe(b);
  });

  it('keep separate offline caches', () => {
    startSync({ room: 'lobby', appId: 'AppA', signaling: [] });
    startSync({ room: 'lobby', appId: 'AppB', signaling: [] });
    expect(new Set(persistenceNames).size).toBe(2);
    expect(persistenceNameFor('AppA', 'lobby')).not.toBe(persistenceNameFor('AppB', 'lobby'));
    // The default instance keeps the name it always had, so its cache is found.
    expect(persistenceNameFor(undefined, 'lobby')).toBe('xdb-sync-lobby');
  });

  it('are not stopped by each other', () => {
    startSync({ room: 'lobby', appId: 'AppA', signaling: [] });
    const b = startSync({ room: 'lobby', appId: 'AppB', signaling: [] });
    stopSync('lobby', 'AppA');
    expect(getSyncAdapter('lobby', 'AppA')).toBeNull();
    expect(getSyncAdapter('lobby', 'AppB')).toBe(b);
    expect(b.getStatus().connected).toBe(true);
  });

  it('are not stopped by each other\'s stop-everything either', () => {
    startSync({ room: 'lobby', appId: 'AppA', signaling: [] });
    startSync({ room: 'other', appId: 'AppA', signaling: [] });
    const b = startSync({ room: 'lobby', appId: 'AppB', signaling: [] });
    stopSync(undefined, 'AppA');
    expect(getAllSyncStatus('AppA')).toEqual([]);
    expect(getSyncAdapter(undefined, 'AppB')).toBe(b);
    expect(getSavedSyncRoom('AppA')).toBeNull();
    expect(getSavedSyncRoom('AppB')).toBe('lobby');
  });

  it('see only their own status', () => {
    startSync({ room: 'lobby', appId: 'AppA', signaling: [] });
    startSync({ room: 'lobby', appId: 'AppB', signaling: [] });
    startSync({ room: 'lobby', signaling: [] });
    expect(getAllSyncStatus('AppA')).toHaveLength(1);
    // The host's view is every app; an app's first adapter is its own.
    expect(getAllSyncStatus()).toHaveLength(3);
    expect(getSyncAdapter(undefined, 'AppA')?.getStatus().room).toBe('lobby');
    expect(getSyncAdapter()).not.toBe(getSyncAdapter(undefined, 'AppA'));
  });
});

describe('what stopping does to resources', () => {
  it('closes the cache connection without deleting the cache', () => {
    startSync({ room: 'keep', appId: 'AppA', signaling: [] });
    const persistence = persistenceInstances[0];
    stopSync('keep', 'AppA');
    expect(persistence.destroy).toHaveBeenCalledTimes(1);
    expect(persistence.clearData).not.toHaveBeenCalled();
  });

  it('deletes the cache only when asked to forget', async () => {
    startSync({ room: 'forget', appId: 'AppA', signaling: [] });
    const persistence = persistenceInstances[0];
    await destroySync('forget', 'AppA');
    expect(persistence.clearData).toHaveBeenCalledTimes(1);
    expect(persistence.destroy).toHaveBeenCalledTimes(1);
    expect(getSyncAdapter('forget', 'AppA')).toBeNull();
  });

  it('refuses to reconnect a closed adapter', () => {
    const adapter = startSync({ room: 'closed', appId: 'AppA', signaling: [] });
    stopSync('closed', 'AppA');
    expect(() => adapter.connect()).toThrow(/closed/);
    // A fresh start builds a fresh adapter on the same cache name.
    const again = startSync({ room: 'closed', appId: 'AppA', signaling: [] });
    expect(again).not.toBe(adapter);
    expect(persistenceNames.filter((n) => n === persistenceNameFor('AppA', 'closed'))).toHaveLength(2);
  });
});

/**
 * Two adapters whose documents exchange updates directly, standing in for
 * two peers in a room. Each side's `update` is applied to the other with a
 * non-null origin, which is what a provider does, so the inbound observers
 * treat it as remote.
 */
function link(a: XDBSyncAdapter, b: XDBSyncAdapter): void {
  a.doc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin !== 'peer') Y.applyUpdate(b.doc, update, 'peer');
  });
  b.doc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin !== 'peer') Y.applyUpdate(a.doc, update, 'peer');
  });
}

describe('reconciliation between two real documents', () => {
  let xdbA: XDBService;
  let xdbB: XDBService;

  beforeEach(() => {
    xdbA = new XDBService(memoryStorage(), 'xdb:A', 'A');
    xdbB = new XDBService(memoryStorage(), 'xdb:B', 'B');
  });

  it('does not let a stale local snapshot overwrite a newer shared record', () => {
    // B is the room: it has the current version of the record.
    const b = new XDBSyncAdapter(xdbB, { room: 'r', appId: 'B', persist: false });
    const created = xdbB.create('tasks', { title: 'current' });
    b.attachLocal();

    // A has an older copy of the same record — it was offline for a while.
    xdbA.writeRecord('tasks', {
      ...created,
      data: { title: 'stale' },
      updated_at: '2000-01-01T00:00:00.000Z',
    });

    // A joins: its document already carries the room's state (persisted, or
    // from a fast peer), and then it reconciles.
    const a = new XDBSyncAdapter(xdbA, { room: 'r', appId: 'A', persist: false });
    Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc), 'peer');
    link(a, b);
    a.attachLocal();

    expect(xdbA.get('tasks', created.id)?.data.title).toBe('current');
    expect(xdbB.get('tasks', created.id)?.data.title).toBe('current');
    expect((a.doc.getMap('tasks').get(created.id) as { data: { title: string } }).data.title).toBe('current');
  });

  it('pushes a local record the room lacks, and one that is genuinely newer', () => {
    const b = new XDBSyncAdapter(xdbB, { room: 'r', appId: 'B', persist: false });
    const shared = xdbB.create('tasks', { title: 'old' });
    b.attachLocal();

    const mine = xdbA.create('tasks', { title: 'mine' });
    xdbA.writeRecord('tasks', {
      ...shared,
      data: { title: 'newer' },
      updated_at: '2999-01-01T00:00:00.000Z',
    });

    const a = new XDBSyncAdapter(xdbA, { room: 'r', appId: 'A', persist: false });
    Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc), 'peer');
    link(a, b);
    a.attachLocal();

    expect(xdbB.get('tasks', mine.id)?.data.title).toBe('mine');
    expect(xdbB.get('tasks', shared.id)?.data.title).toBe('newer');
  });

  it('generates no CRDT write for a record the room already has, verbatim', () => {
    const b = new XDBSyncAdapter(xdbB, { room: 'r', appId: 'B', persist: false });
    const created = xdbB.create('tasks', { title: 'same' });
    b.attachLocal();

    xdbA.writeRecord('tasks', created);
    const a = new XDBSyncAdapter(xdbA, { room: 'r', appId: 'A', persist: false });
    Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc), 'peer');
    const updates = vi.fn();
    a.doc.on('update', updates);
    a.attachLocal();

    expect(updates).not.toHaveBeenCalled();
  });

  it('turns a refresh into writes for what changed, not the whole collection', () => {
    const a = new XDBSyncAdapter(xdbA, { room: 'r', appId: 'A', persist: false });
    const b = new XDBSyncAdapter(xdbB, { room: 'r', appId: 'B', persist: false });
    link(a, b);
    a.attachLocal();
    b.attachLocal();

    const one = xdbA.create('tasks', { n: 1 });
    xdbA.create('tasks', { n: 2 });
    xdbA.create('tasks', { n: 3 });

    const changedKeys: string[][] = [];
    b.doc.getMap('tasks').observe((event) => {
      changedKeys.push(Array.from(event.changes.keys.keys()));
    });

    // A batched mutation ends in one 'refresh' event carrying every record.
    xdbA.suppressNotifications();
    xdbA.update(one.id, { n: 10 });
    xdbA.resumeNotifications();

    expect(changedKeys).toEqual([[one.id]]);
    expect(xdbB.get('tasks', one.id)?.data.n).toBe(10);
    expect(xdbB.query('tasks')).toHaveLength(3);
  });

  it('delivers the first record of a collection nobody had seen before', () => {
    const a = new XDBSyncAdapter(xdbA, { room: 'r', appId: 'A', persist: false });
    const b = new XDBSyncAdapter(xdbB, { room: 'r', appId: 'B', persist: false });
    link(a, b);
    a.attachLocal();
    b.attachLocal();

    // The transaction that creates the map is the one that fills it; an
    // observer attached on discovery, after it, was never told.
    const fresh = xdbB.create('fresh', { first: true });

    expect(xdbA.get('fresh', fresh.id)?.data.first).toBe(true);
    // And later records in the same collection keep arriving.
    const second = xdbB.create('fresh', { first: false });
    expect(xdbA.query('fresh')).toHaveLength(2);
    expect(xdbA.get('fresh', second.id)?.data.first).toBe(false);
  });

  it('propagates ordinary creates, updates and deletes both ways', () => {
    const a = new XDBSyncAdapter(xdbA, { room: 'r', appId: 'A', persist: false });
    const b = new XDBSyncAdapter(xdbB, { room: 'r', appId: 'B', persist: false });
    link(a, b);
    a.attachLocal();
    b.attachLocal();

    const rec = xdbA.create('notes', { body: 'hi' });
    expect(xdbB.get('notes', rec.id)?.data.body).toBe('hi');
    xdbB.update(rec.id, { body: 'edited' });
    expect(xdbA.get('notes', rec.id)?.data.body).toBe('edited');
    xdbA.hardDelete('notes', rec.id);
    expect(xdbB.get('notes', rec.id)).toBeNull();
  });
});
