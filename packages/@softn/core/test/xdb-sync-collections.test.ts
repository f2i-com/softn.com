/**
 * A room limited to some collections (permission.json's
 * `sync.roomCollections`, or the script's option) carries those and no
 * other, both ways: this device sends no other collection, and writes none a
 * peer sends. A room carried every collection of the app whose name did not
 * start with `_`, and a peer of a shared room is anyone who knows its name.
 */
import { describe, it, expect, vi } from 'vitest';
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

/** Two peers whose documents pass every update to each other, as a room does. */
function link(a: XDBSyncAdapter, b: XDBSyncAdapter): void {
  a.doc.on('update', (u: Uint8Array, origin: unknown) => {
    if (origin !== 'peer') Y.applyUpdate(b.doc, u, 'peer');
  });
  b.doc.on('update', (u: Uint8Array, origin: unknown) => {
    if (origin !== 'peer') Y.applyUpdate(a.doc, u, 'peer');
  });
}

function peer(name: string, collections?: string[]) {
  const xdb = new XDBService(storage(), name, undefined, { backend: 'storage' });
  const adapter = new XDBSyncAdapter(xdb, { room: 'r', signaling: [], persist: false, collections });
  return { xdb, adapter };
}

describe('a room limited to some collections', () => {
  it('takes from a peer only the collections it carries, live and newly made', () => {
    const a = peer('every');
    const b = peer('scores-only', ['scores']);
    link(a.adapter, b.adapter);
    a.adapter.attachLocal();
    b.adapter.attachLocal();

    const score = a.xdb.create('scores', { points: 3 });
    a.xdb.create('secrets', { text: 'a peer writes into a collection this device never shares' });

    expect(b.xdb.get('scores', score.id)).not.toBeNull();
    expect(b.xdb.getAllRaw('secrets')).toEqual([]);
  });

  it('takes nothing at the opening from a collection it does not carry', () => {
    const room = new Y.Doc();
    room.getMap('secrets').set('s1', { id: 's1', collection: 'secrets', data: { text: 'in the room before' }, created_at: '', updated_at: '', deleted: false });
    room.getMap('scores').set('p1', { id: 'p1', collection: 'scores', data: { points: 1 }, created_at: '', updated_at: '', deleted: false });
    const b = peer('joining', ['scores']);
    Y.applyUpdate(b.adapter.doc, Y.encodeStateAsUpdate(room), 'peer');
    b.adapter.attachLocal();

    expect(b.xdb.get('scores', 'p1')).not.toBeNull();
    expect(b.xdb.getAllRaw('secrets')).toEqual([]);
  });

  it('sends only the collections it carries, at the opening and after', () => {
    const b = peer('sender', ['scores']);
    const before = b.xdb.create('secrets', { text: 'here before the room' });
    b.adapter.attachLocal();
    const after = b.xdb.create('secrets', { text: 'written in the room' });
    const score = b.xdb.create('scores', { points: 5 });
    // A refresh, which every script call is, sends nothing of it either.
    b.xdb.suppressNotifications();
    b.xdb.update(after.id, { text: 'changed' });
    b.xdb.resumeNotifications();

    expect(b.adapter.doc.getMap('secrets').size).toBe(0);
    expect(b.adapter.doc.getMap('secrets').has(before.id)).toBe(false);
    expect(b.adapter.doc.getMap('scores').has(score.id)).toBe(true);
  });

  it('is refused when its list is not one of names, rather than carrying everything', () => {
    const xdb = new XDBService(storage(), 'bad-list', undefined, { backend: 'storage' });
    for (const collections of [['_prefs'], [''], ['a:b'], 'scores']) {
      expect(() => new XDBSyncAdapter(xdb, { room: 'r', signaling: [], persist: false, collections: collections as string[] })).toThrow(/collections must be a list/);
    }
  });
});
