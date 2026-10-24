/**
 * A peer that cannot keep a record of the room (its store refuses it: the 3 MB
 * browser budget, a quota) leaves it in the room. Its next write is a
 * `refresh`, which lists what the peer holds and takes out of the room what it
 * lacks: the records it could not keep went out with it, off every other
 * peer, the one that wrote them included.
 */
import { describe, it, expect, vi } from 'vitest';
import * as Y from 'yjs';

vi.mock('y-webrtc', () => ({ WebrtcProvider: class {} }));
vi.mock('y-indexeddb', () => ({ IndexeddbPersistence: class {} }));

import { XDBService } from '../src/runtime/xdb';
import { XDBSyncAdapter } from '../src/runtime/xdb-sync';

function storage(limit = Infinity) {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (v.length > limit) throw new DOMException('full', 'QuotaExceededError');
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
  };
}

/** Two peers whose documents pass every update to each other, as a room does. */
function link(a: XDBSyncAdapter, b: XDBSyncAdapter): void {
  a.doc.on('update', (u: Uint8Array, origin: unknown) => {
    if (origin !== 'peer') Y.applyUpdate(b.doc, u, 'peer');
  });
  b.doc.on('update', (u: Uint8Array, origin: unknown) => {
    if (origin !== 'peer') Y.applyUpdate(a.doc, u, 'peer');
  });
}

function quiet<T>(run: () => T): T {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    return run();
  } finally {
    warn.mockRestore();
    error.mockRestore();
  }
}

describe('a peer whose store refused records of the room', () => {
  it('leaves a record it could not keep in the room when it next writes', () =>
    quiet(() => {
      const xa = new XDBService(storage(), 'pa', undefined, { backend: 'storage' });
      // B holds about 2,000 characters a collection: a browser near its quota.
      const xb = new XDBService(storage(2000), 'pb', undefined, { backend: 'storage' });
      const a = new XDBSyncAdapter(xa, { room: 'r', signaling: [], persist: false });
      const b = new XDBSyncAdapter(xb, { room: 'r', signaling: [], persist: false });
      link(a, b);
      a.attachLocal();
      b.attachLocal();

      const small = xa.create('notes', { text: 'hello' });
      const big = xa.create('notes', { text: 'x'.repeat(5000) });
      expect(xb.getAllRaw('notes').map((r) => r.id)).toEqual([small.id]);

      // A write of B's in a script call, which every VM call is: a refresh.
      xb.suppressNotifications();
      xb.create('notes', { text: 'tiny' });
      xb.resumeNotifications();

      expect(xa.get('notes', big.id)).not.toBeNull();
      expect(a.doc.getMap('notes').has(big.id)).toBe(true);
    }));

  it('with the real per-app budget, a delete of one note takes no other off the peer that wrote them', () =>
    quiet(() => {
      localStorage.clear();
      // A: a store without the browser budget (the desktop app, another browser with room).
      const xa = new XDBService(storage(), 'xdb:a', 'a', { backend: 'storage' });
      // B: an ordinary tab, its records in localStorage under the 3 MB budget.
      const xb = new XDBService(undefined, 'xdb:b', 'b', { backend: 'storage' });
      const a = new XDBSyncAdapter(xa, { room: 'r', signaling: [], persist: false });
      const b = new XDBSyncAdapter(xb, { room: 'r', signaling: [], persist: false });
      link(a, b);
      a.attachLocal();
      b.attachLocal();

      const ids: string[] = [];
      for (let i = 0; i < 40; i++) ids.push(xa.create('notes', { n: i, body: 'x'.repeat(100_000) }).id);
      expect(xb.getAllRaw('notes').length).toBeLessThan(40);

      xb.suppressNotifications();
      xb.delete(ids[0]);
      xb.resumeNotifications();

      // B's soft delete reaches A as a tombstone; the notes B could not keep stay.
      expect(xa.getAllRaw('notes').length).toBe(40);
      expect(xa.get('notes', ids[0])).toBeNull();
      expect(xa.get('notes', ids[39])).not.toBeNull();
      localStorage.clear();
    }));
});

describe('what peers send', () => {
  it('leaves room in the browser budget for the app\'s own writes', () =>
    quiet(() => {
      localStorage.clear();
      const xa = new XDBService(storage(), 'xdb:a', 'a', { backend: 'storage' });
      const xb = new XDBService(undefined, 'xdb:b', 'b', { backend: 'storage' });
      const a = new XDBSyncAdapter(xa, { room: 'r', signaling: [], persist: false });
      const b = new XDBSyncAdapter(xb, { room: 'r', signaling: [], persist: false });
      link(a, b);
      a.attachLocal();
      b.attachLocal();

      const ids: string[] = [];
      for (let i = 0; i < 40; i++) ids.push(xa.create('notes', { n: i, body: 'x'.repeat(100_000) }).id);
      const kept = xb.getAllRaw('notes').length;
      // Some 2.5 MB of the 3: the notes past it are not kept here.
      expect(kept).toBeGreaterThan(20);
      expect(kept).toBeLessThan(27);
      expect(xb.getStorageStatus().issues.some((i) => i.kind === 'quota' && i.collection === 'notes')).toBe(true);

      // The person's own note fits in what peers could not take, where the
      // room's had filled the budget and refused it.
      let own: { id: string } | undefined;
      expect(() => {
        own = xb.create('notes', { mine: true, body: 'y'.repeat(100_000) });
      }).not.toThrow();
      expect(xa.get('notes', own!.id)).not.toBeNull();

      // And what B could not keep stays in the room, and on the peer that wrote it.
      expect(a.doc.getMap('notes').size).toBe(41);
      expect(xa.getAllRaw('notes').length).toBe(41);
      localStorage.clear();
    }));

  it('is written once at the opening, however much of it does not fit', () =>
    quiet(() => {
      localStorage.clear();
      const xa = new XDBService(storage(), 'xdb:a', 'a', { backend: 'storage' });
      for (let i = 0; i < 40; i++) xa.create('notes', { n: i, body: 'x'.repeat(100_000) });
      const a = new XDBSyncAdapter(xa, { room: 'r', signaling: [], persist: false });
      a.attachLocal();

      const xb = new XDBService(undefined, 'xdb:b', 'b', { backend: 'storage' });
      const b = new XDBSyncAdapter(xb, { room: 'r', signaling: [], persist: false });
      const setItem = vi.spyOn(Storage.prototype, 'setItem');
      try {
        Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc), 'peer');
        b.attachLocal();
        const notesWrites = setItem.mock.calls.filter(([key]) => String(key).endsWith('notes')).length;
        // One write of the collection, not one for each record that fitted.
        expect(notesWrites).toBe(1);
      } finally {
        setItem.mockRestore();
      }
      expect(xb.getAllRaw('notes').length).toBeGreaterThan(20);
      expect(xb.getAllRaw('notes').length).toBeLessThan(27);
      localStorage.clear();
    }));
});
