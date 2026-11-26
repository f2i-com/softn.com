/**
 * Peer sync's inbound side, as the data layer writes it (audit round 3).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

vi.mock('y-webrtc', () => ({ WebrtcProvider: class {} }));
vi.mock('y-indexeddb', () => ({ IndexeddbPersistence: class {} }));

import { XDBService, type XDBEvent } from '../src/runtime/xdb';
import { XDBSyncAdapter } from '../src/runtime/xdb-sync';

/** A storage that counts the writes of each key. */
function countingStorage() {
  const store = new Map<string, string>();
  const writes = new Map<string, number>();
  return {
    writes,
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      writes.set(k, (writes.get(k) ?? 0) + 1);
      store.set(k, v);
    },
    removeItem: (k: string) => void store.delete(k),
  };
}

describe('a peer\'s removal of many records at once', () => {
  // Each removal heard from the room was its own read and write of the whole
  // collection: a peer clearing a thousand of three thousand records held a
  // joining tab for two seconds, and the time grew with the square of the size.
  it('is written in one write of the collection, each record announced as removed', () => {
    const storage = countingStorage();
    const xdb = new XDBService(storage, 'r3-peer-removals', undefined, { backend: 'storage' });
    const adapter = new XDBSyncAdapter(xdb, { room: 'r', signaling: [], persist: false });
    const room = new Y.Doc();
    const map = room.getMap('notes');
    room.transact(() => {
      for (let i = 0; i < 100; i++) {
        map.set(`n${i}`, { id: `n${i}`, collection: 'notes', data: { i }, created_at: '2026-11-01T00:00:00.000Z', updated_at: '2026-11-01T00:00:00.000Z', deleted: false });
      }
    });
    Y.applyUpdate(adapter.doc, Y.encodeStateAsUpdate(room), 'peer');
    adapter.attachLocal();
    expect(xdb.getAll('notes')).toHaveLength(100);

    const heard: XDBEvent[] = [];
    const off = xdb.subscribe('notes', (event) => heard.push(event));
    const before = storage.writes.get('r3-peer-removals:notes') ?? 0;
    const sv = Y.encodeStateVector(adapter.doc);
    room.transact(() => {
      for (let i = 0; i < 60; i++) map.delete(`n${i}`);
    });
    Y.applyUpdate(adapter.doc, Y.encodeStateAsUpdate(room, sv), 'peer');
    off();

    expect((storage.writes.get('r3-peer-removals:notes') ?? 0) - before).toBe(1);
    expect(xdb.getAllRaw('notes').map((r) => r.id)).toEqual(Array.from({ length: 40 }, (_, i) => `n${i + 60}`));
    expect(heard.filter((e) => e.type === 'delete' && e.removed === true).map((e) => e.record?.id).sort())
      .toEqual(Array.from({ length: 60 }, (_, i) => `n${i}`).sort());
    // What this device holds and what the room holds agree.
    expect([...adapter.doc.getMap('notes').keys()].sort()).toEqual(xdb.getAllRaw('notes').map((r) => r.id).sort());
    adapter.close();
  });
});

describe('an adapter linked to its store more than once', () => {
  // attachLocal() again (or connect() after it) subscribed to the store again
  // without letting go of the first subscription: every write here went into
  // the room twice, and the first subscription, which close() never reached,
  // went on writing into the closed room's document for the life of the page.
  it('writes each change into the room once, and nothing after it is closed', () => {
    const memory = new Map<string, string>();
    const storage = {
      getItem: (k: string) => memory.get(k) ?? null,
      setItem: (k: string, v: string) => void memory.set(k, v),
      removeItem: (k: string) => void memory.delete(k),
    };
    const xdb = new XDBService(storage, 'r3-attach-twice', undefined, { backend: 'storage' });
    const adapter = new XDBSyncAdapter(xdb, { room: 'r', signaling: [], persist: false });
    adapter.attachLocal();
    adapter.attachLocal();
    let updates = 0;
    adapter.doc.on('update', () => updates++);
    xdb.create('notes', { text: 'one write' });
    expect(updates).toBe(1);
    adapter.close();
    xdb.create('notes', { text: 'after the room closed' });
    expect(updates).toBe(1);
  });
});

describe('a peer\'s removals in a desktop collection that did not load', () => {
  afterEach(() => {
    delete (globalThis as { __TAURI__?: unknown }).__TAURI__;
  });

  it('are made in the native store together, as one is', async () => {
    type Row = { id: string; collection: string; data: Record<string, unknown>; created_at: string; updated_at: string; deleted: boolean };
    const rows = new Map<string, Row>();
    for (const id of ['n1', 'n2', 'n3']) rows.set(id, { id, collection: 'notes', data: {}, created_at: 't', updated_at: 't', deleted: false });
    const invoke = vi.fn(async (cmd: string, args: Record<string, any> = {}) => {
      switch (cmd) {
        case 'get_collections':
          return ['notes'];
        case 'get_collection':
          throw new Error('IPC failure');
        case 'delete_record': {
          const row = rows.get(args.id);
          if (!row || (args.collection !== undefined && row.collection !== args.collection)) return false;
          rows.set(row.id, { ...row, deleted: true });
          return true;
        }
        case 'upsert_records':
          for (const record of args.records as Row[]) rows.set(record.id, record);
          return [];
        case 'remove_records':
          // For good, with no tombstone (db.rs remove_records).
          for (const id of args.ids as string[]) if (rows.get(id)?.collection === args.collection) rows.delete(id);
          return [];
        default:
          throw new Error(`Unexpected command: ${cmd}`);
      }
    });
    (globalThis as unknown as { window: unknown }).window = globalThis;
    (globalThis as { __TAURI__?: unknown }).__TAURI__ = { core: { invoke }, event: { listen: vi.fn(async () => () => {}) } };
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const xdb = new XDBService(undefined, 'r3-unloaded-peer');
      await xdb.isReady;
      expect(xdb.isHydrated('notes')).toBe(false);
      xdb.removeRecords('notes', ['n1', 'n2'], { fromPeer: true });
      for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
      // Removed for good (round 4), in one call: a tombstone kept each record's data.
      expect(invoke.mock.calls.filter(([cmd]) => cmd === 'remove_records')).toHaveLength(1);
      expect(rows.has('n1')).toBe(false);
      expect(rows.has('n2')).toBe(false);
      // The app's own removal still waits for the load.
      expect(() => xdb.removeRecords('notes', ['n3', 'n1'])).toThrow(/has not been loaded/);
      expect(rows.get('n3')?.deleted).toBe(false);
      xdb.destroy();
    } finally {
      quiet.mockRestore();
    }
  });
});
