/**
 * What a peer writes into the room is checked before this device writes it:
 * the value's id is its key, its collection is the map's, its stamps are
 * times no later than the near future. A peer is anyone who knows the room.
 */
import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

vi.mock('y-webrtc', () => ({ WebrtcProvider: class {} }));
vi.mock('y-indexeddb', () => ({ IndexeddbPersistence: class {} }));

import { XDBService } from '../src/runtime/xdb';
import { XDBSyncAdapter } from '../src/runtime/xdb-sync';

function storage() {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
}

/** Every update a document makes goes to every other one, on flush(). */
class Net {
  docs = new Set<Y.Doc>();
  queue: Array<[Y.Doc, Uint8Array]> = [];
  join(d: Y.Doc): void {
    for (const o of this.docs) Y.applyUpdate(d, Y.encodeStateAsUpdate(o), this);
    this.docs.add(d);
    d.on('update', (u: Uint8Array) => {
      for (const o of this.docs) if (o !== d) this.queue.push([o, u]);
    });
  }
  leave(d: Y.Doc): void {
    this.docs.delete(d);
  }
  flush(): void {
    while (this.queue.length) {
      const [d, u] = this.queue.shift()!;
      if (this.docs.has(d)) Y.applyUpdate(d, u, this);
    }
  }
}

function quiet<T>(run: () => T): T {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    return run();
  } finally {
    warn.mockRestore();
  }
}

function peer(name: string) {
  const xdb = new XDBService(storage(), name, undefined, { backend: 'storage' });
  const adapter = new XDBSyncAdapter(xdb, { room: 'r', signaling: [], persist: false });
  return { xdb, adapter };
}

const text = (xdb: XDBService, id: string) => (xdb.get('notes', id)?.data as { text?: string } | undefined)?.text;

describe('a peer\'s values', () => {
  it('a null where this device holds a record does not stop its writes reaching the room', () =>
    quiet(() => {
      const { xdb, adapter } = peer('null-value');
      const mine = xdb.create('notes', { text: 'mine' });
      const hostile = new Y.Doc();
      hostile.getMap('notes').set(mine.id, null);
      Y.applyUpdate(adapter.doc, Y.encodeStateAsUpdate(hostile), 'peer');
      expect(() => adapter.attachLocal()).not.toThrow();
      const later = xdb.create('notes', { text: 'written after joining' });
      expect(adapter.doc.getMap('notes').has(later.id)).toBe(true);
      // And the room has this device's record back in place of the null.
      expect((adapter.doc.getMap('notes').get(mine.id) as { data?: { text?: string } }).data?.text).toBe('mine');
    }));

  it('a value under one key does not write the record of another', () =>
    quiet(() => {
      const net = new Net();
      const { xdb, adapter } = peer('other-key');
      net.join(adapter.doc);
      adapter.attachLocal();
      const kept = xdb.create('notes', { text: 'today' });
      net.flush();
      const hostile = new Y.Doc();
      net.join(hostile);
      hostile.getMap('notes').set('zz', { id: kept.id, collection: 'notes', data: { text: 'from 2000' }, updated_at: '2000-01-01T00:00:00.000Z' });
      net.flush();
      expect(text(xdb, kept.id)).toBe('today');
      expect(xdb.get('notes', 'zz')).toBeNull();
    }));

  it('a value with an empty id does not make the collection unreadable', () =>
    quiet(() => {
      const net = new Net();
      const { xdb, adapter } = peer('empty-id');
      net.join(adapter.doc);
      adapter.attachLocal();
      const note = xdb.create('notes', { text: 'still here' });
      net.flush();
      const hostile = new Y.Doc();
      net.join(hostile);
      hostile.getMap('notes').set('', { id: '', collection: 'notes', data: {} });
      net.flush();
      expect(xdb.getAll('notes').map((r) => r.id)).toEqual([note.id]);
      expect(() => xdb.create('notes', { text: 'another' })).not.toThrow();
    }));

  it('a value is written to the collection of its map, whatever it names', () =>
    quiet(() => {
      const net = new Net();
      const { xdb, adapter } = peer('collection');
      net.join(adapter.doc);
      adapter.attachLocal();
      const hostile = new Y.Doc();
      net.join(hostile);
      hostile.getMap('notes').set('settings', { id: 'settings', collection: '_prefs', data: { pin: 'attacker' }, updated_at: new Date().toISOString() });
      net.flush();
      expect(xdb.get('_prefs', 'settings')).toBeNull();
      expect(xdb.get('notes', 'settings')?.collection).toBe('notes');
    }));

  it('a stamp far in the future does not pin a record against later edits', () =>
    quiet(() => {
      const net = new Net();
      const a = peer('pin-a');
      const b = peer('pin-b');
      net.join(a.adapter.doc);
      net.join(b.adapter.doc);
      a.adapter.attachLocal();
      b.adapter.attachLocal();
      net.flush();
      const rec = a.xdb.create('notes', { text: 'v1' });
      net.flush();
      const hostile = new Y.Doc();
      net.join(hostile);
      hostile.getMap('notes').set(rec.id, { ...rec, data: { text: 'pinned' }, updated_at: '9999-01-01T00:00:00.000Z' });
      net.flush();
      net.leave(hostile);
      expect(text(a.xdb, rec.id)).toBe('v1');
      b.xdb.update(rec.id, { text: 'B edited' });
      net.flush();
      expect(text(a.xdb, rec.id)).toBe('B edited');
      expect(text(b.xdb, rec.id)).toBe('B edited');
      // A stamp that is not a time is no record either.
      const odd = new Y.Doc();
      net.join(odd);
      odd.getMap('notes').set(rec.id, { ...rec, data: { text: 'odd' }, updated_at: '{}' });
      net.flush();
      expect(text(a.xdb, rec.id)).toBe('B edited');
    }));

  it('a well-formed value from a peer is written, a near-future stamp included', () =>
    quiet(() => {
      const net = new Net();
      const { xdb, adapter } = peer('well-formed');
      net.join(adapter.doc);
      adapter.attachLocal();
      const other = new Y.Doc();
      net.join(other);
      const soon = new Date(Date.now() + 60_000).toISOString();
      other.getMap('notes').set('n1', { id: 'n1', collection: 'notes', data: { text: 'hello' }, created_at: soon, updated_at: soon, deleted: false });
      net.flush();
      expect(text(xdb, 'n1')).toBe('hello');
    }));
});
