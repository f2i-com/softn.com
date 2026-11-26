/**
 * An app keeps the caches of the rooms it joined last, and no more.
 *
 * Every room an app joins keeps an IndexedDB database of its own, a copy of the records the
 * room carries, and leaving the room keeps it (a removal made with no peer there is in it and
 * nowhere else). Nothing counted them: an app that joined a new name each time and left grew
 * the site's IndexedDB by one copy of its records for every name it had ever used.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const opened: string[] = [];

vi.mock('y-webrtc', () => ({
  WebrtcProvider: class {
    connected = true;
    awareness = { getStates: () => new Map(), setLocalStateField() {} };
    destroy() {}
  },
}));

vi.mock('y-indexeddb', () => ({
  IndexeddbPersistence: class {
    constructor(readonly name: string) {
      opened.push(name);
    }
    on() {}
    off() {}
    destroy() {}
  },
}));

import * as Y from 'yjs';
import { XDBService } from '../src/runtime/xdb';
import { XDBSyncAdapter, closeSyncRoom, destroySync, getSyncAdapter, startSync, stopAllSync, stopSync } from '../src/runtime/xdb-sync';
import { getSyncRoomKey, persistenceNameFor } from '../src/runtime/xdb-sync-key';
import { MAX_OPEN_SYNC_ROOMS_PER_APP } from '../src/runtime/sync-room-security';
import { MAX_KEPT_ROOM_CACHES_PER_APP, keptRoomCaches, noteRoomCache, roomCachesKey } from '../src/runtime/sync-room-caches';
import { fakeLocks } from './helpers/fake-locks';

const APP = 'room-caches-app';
const OTHER = 'room-caches-other-app';

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

/** An IndexedDB with only what deleting a cache uses. */
function fakeIndexedDB() {
  const factory = {
    deleted: [] as string[],
    deleteDatabase(name: string) {
      const request: Record<string, (() => void) | null> = { onsuccess: null, onerror: null, onblocked: null };
      factory.deleted.push(name);
      setTimeout(() => request.onsuccess?.(), 0);
      return request;
    },
  };
  return factory;
}

function memoryStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
}

function joinAndLeave(rooms: string[], appId = APP): void {
  for (const room of rooms) {
    startSync({ room, appId, signaling: [] });
    stopSync(room, appId);
  }
}

const names = (rooms: string[], appId = APP) => rooms.map((room) => persistenceNameFor(appId, room));
const numbered = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => `room-${from + i}`);

let idb: ReturnType<typeof fakeIndexedDB>;

beforeEach(() => {
  localStorage.clear();
  opened.length = 0;
  idb = fakeIndexedDB();
  vi.stubGlobal('indexedDB', idb);
});

afterEach(() => {
  stopAllSync();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, 'locks');
});

describe('the caches an app’s rooms leave behind', () => {
  it('are those of the rooms it joined last: a new name each time deletes the one joined longest ago', async () => {
    const rooms = numbered(0, 20);
    joinAndLeave(rooms);
    await settle();

    expect(opened).toEqual(names(rooms));
    const kept = rooms.slice(-MAX_KEPT_ROOM_CACHES_PER_APP);
    expect(keptRoomCaches(APP)).toEqual(kept);
    expect(idb.deleted).toEqual(names(rooms.slice(0, rooms.length - MAX_KEPT_ROOM_CACHES_PER_APP)));
    // The list is the size of a few names, whatever was joined.
    expect((localStorage.getItem(roomCachesKey(APP)) ?? '').length).toBeLessThan(1024);
  });

  it('are kept while there are no more than an app keeps, and a room joined again is the newest', async () => {
    const rooms = numbered(0, MAX_KEPT_ROOM_CACHES_PER_APP);
    joinAndLeave(rooms);
    // Joined again: the cache it left is opened, not deleted, and it is now the last to go.
    joinAndLeave(['room-0']);
    await settle();
    expect(idb.deleted).toEqual([]);
    expect(keptRoomCaches(APP)).toEqual([...rooms.slice(1), 'room-0']);

    joinAndLeave(['one-more']);
    await settle();
    expect(idb.deleted).toEqual(names(['room-1']));
  });

  it('never lose the cache of a room that is open', async () => {
    const open = startSync({ room: 'stays-open', appId: APP, signaling: [] });
    joinAndLeave(numbered(0, 20));
    await settle();

    expect(idb.deleted).not.toContain(persistenceNameFor(APP, 'stays-open'));
    expect(idb.deleted).toHaveLength(21 - MAX_KEPT_ROOM_CACHES_PER_APP);
    expect(keptRoomCaches(APP)).toContain('stays-open');
    expect(getSyncAdapter('stays-open', APP)).toBe(open);
  });

  it('never lose the cache of the saved room, which the app goes back to when it starts', async () => {
    startSync({ room: 'home', appId: APP, signaling: [] });
    // Closed by the host, as when the app closes: still the saved room.
    closeSyncRoom('home', APP);
    expect(localStorage.getItem(getSyncRoomKey(APP))).toBe('home');
    // The saved room stays what it is while others are joined (a store with no room for the write).
    const write = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === getSyncRoomKey(APP)) throw new DOMException('full', 'QuotaExceededError');
      write.call(this, key, value);
    });

    joinAndLeave(numbered(0, 20));
    await settle();

    expect(localStorage.getItem(getSyncRoomKey(APP))).toBe('home');
    expect(idb.deleted).not.toContain(persistenceNameFor(APP, 'home'));
    expect(keptRoomCaches(APP)).toContain('home');
  });

  it('are counted for each app on its own, and for an app with no id', async () => {
    joinAndLeave(numbered(0, MAX_KEPT_ROOM_CACHES_PER_APP));
    joinAndLeave(numbered(0, MAX_KEPT_ROOM_CACHES_PER_APP), OTHER);
    await settle();
    expect(idb.deleted).toEqual([]);

    for (const room of numbered(0, MAX_KEPT_ROOM_CACHES_PER_APP + 1)) {
      startSync({ room, signaling: [] });
      stopSync(room);
    }
    await settle();
    expect(idb.deleted).toEqual([persistenceNameFor(undefined, 'room-0')]);
    expect(keptRoomCaches(OTHER)).toHaveLength(MAX_KEPT_ROOM_CACHES_PER_APP);
  });

  it('are bounded with every room an app may have open at once', async () => {
    const rooms = numbered(0, MAX_OPEN_SYNC_ROOMS_PER_APP);
    for (const room of rooms) startSync({ room, appId: APP, signaling: [] });
    stopSync(undefined, APP);
    joinAndLeave(numbered(100, 110));
    await settle();
    expect(keptRoomCaches(APP)).toHaveLength(MAX_KEPT_ROOM_CACHES_PER_APP);
    expect(idb.deleted).toHaveLength(rooms.length + 10 - MAX_KEPT_ROOM_CACHES_PER_APP);
  });

  it('do not list a room that keeps no cache, and a room is opened without one where the list cannot be kept', () => {
    startSync({ room: 'unkept', appId: APP, signaling: [], persist: false });
    expect(opened).toEqual([]);
    expect(keptRoomCaches(APP)).toEqual([]);
    stopSync('unkept', APP);

    const write = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === roomCachesKey(APP)) throw new DOMException('full', 'QuotaExceededError');
      write.call(this, key, value);
    });
    // A cache nothing lists is one nothing would delete: the room is joined, with none, and the console says so.
    const said = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const adapter = startSync({ room: 'unlisted', appId: APP, signaling: [] });
    expect(getSyncAdapter('unlisted', APP)).toBe(adapter);
    expect(opened).toEqual([]);
    expect(said.mock.calls.filter((call) => String(call[0]).includes('"unlisted" is joined with no saved copy'))).toHaveLength(1);
  });

  it('leave the list when a room’s cache is deleted with it (destroySync)', async () => {
    startSync({ room: 'kept', appId: APP, signaling: [] });
    startSync({ room: 'wiped', appId: APP, signaling: [] });
    await destroySync('wiped', APP);
    expect(idb.deleted).toEqual(names(['wiped']));
    expect(keptRoomCaches(APP)).toEqual(['kept']);
  });

  it('are listed by name only: what is no list of room names is an empty one', () => {
    for (const raw of ['', 'not json', '{"room":1}', '7', 'null']) {
      localStorage.setItem(roomCachesKey(APP), raw);
      expect(keptRoomCaches(APP), raw).toEqual([]);
    }
    localStorage.setItem(roomCachesKey(APP), JSON.stringify(['a', 7, '', 'x'.repeat(257), null, 'a', 'b']));
    expect(keptRoomCaches(APP)).toEqual(['a', 'b']);
    expect(noteRoomCache(APP, 'a')).toBe(true);
    expect(keptRoomCaches(APP)).toEqual(['b', 'a']);
  });
});

describe('what a room’s cache holds that nothing else does', () => {
  /** A and B share a record; A removes it for good with the room open and B away, and leaves. */
  function removedWithNoPeerThere() {
    const xdbA = new XDBService(memoryStorage(), 'xdb:A', 'A');
    const xdbB = new XDBService(memoryStorage(), 'xdb:B', 'B');
    const a = new XDBSyncAdapter(xdbA, { room: 'r', appId: 'A', persist: false });
    const b = new XDBSyncAdapter(xdbB, { room: 'r', appId: 'B', persist: false });
    a.attachLocal();
    b.attachLocal();
    const record = xdbA.create('notes', { body: 'hi' });
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc), 'peer');
    expect(xdbB.get('notes', record.id)?.data.body).toBe('hi');

    xdbA.hardDelete('notes', record.id);
    // The cache is the document as the room was left.
    const cache = Y.encodeStateAsUpdate(a.doc);
    a.close();
    return { xdbA, xdbB, b, id: record.id, cache };
  }

  /** A joins the room again, with the cache it left or with none, and meets B. */
  function rejoin(xdbA: XDBService, b: XDBSyncAdapter, cache: Uint8Array | null): void {
    const a = new XDBSyncAdapter(xdbA, { room: 'r', appId: 'A', persist: false });
    if (cache) Y.applyUpdate(a.doc, cache, 'cache');
    a.attachLocal();
    Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc), 'peer');
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc), 'peer');
  }

  it('is a removal made with no peer there: with the cache the room hears of it, without it the record comes back', () => {
    const kept = removedWithNoPeerThere();
    rejoin(kept.xdbA, kept.b, kept.cache);
    expect(kept.xdbA.get('notes', kept.id)).toBeNull();
    expect(kept.xdbB.get('notes', kept.id)).toBeNull();

    // Why leaving a room keeps its cache, and only the ones joined longest ago are deleted.
    const lost = removedWithNoPeerThere();
    rejoin(lost.xdbA, lost.b, null);
    expect(lost.xdbA.get('notes', lost.id)?.data.body).toBe('hi');
    expect(lost.xdbB.get('notes', lost.id)?.data.body).toBe('hi');
  });
});

describe('a cache whose room another tab has open', () => {
  it('is held while its room is open, and let go when the room is left', async () => {
    const locks = fakeLocks();
    Object.defineProperty(navigator, 'locks', { value: locks, configurable: true });
    const held = `xdb-sync-cache:${persistenceNameFor(APP, 'lobby')}`;

    startSync({ room: 'lobby', appId: APP, signaling: [] });
    await settle();
    expect(locks.holders(held)).toBe(1);

    stopSync('lobby', APP);
    await settle();
    expect(locks.holders(held)).toBe(0);
  });

  it('is not deleted, and is deleted once that tab has left the room', async () => {
    const locks = fakeLocks();
    Object.defineProperty(navigator, 'locks', { value: locks, configurable: true });
    // Another tab of the app has `room-0` open: it holds the cache, as this one would.
    let leave = (): void => {};
    void locks.request(`xdb-sync-cache:${persistenceNameFor(APP, 'room-0')}`, { mode: 'shared' }, () => new Promise<void>((resolve) => (leave = resolve)));
    noteRoomCache(APP, 'room-0');

    joinAndLeave(numbered(1, MAX_KEPT_ROOM_CACHES_PER_APP + 2));
    await settle();

    // The next one in line went in its place; the held one is kept, first to be tried again.
    expect(idb.deleted).toEqual(names(['room-1']));
    expect(keptRoomCaches(APP)[0]).toBe('room-0');

    leave();
    await settle();
    joinAndLeave(['later']);
    await settle();
    expect(idb.deleted).toContain(persistenceNameFor(APP, 'room-0'));
    expect(keptRoomCaches(APP)).not.toContain('room-0');
    expect(keptRoomCaches(APP)).toHaveLength(MAX_KEPT_ROOM_CACHES_PER_APP);
  });

  it('is deleted all the same in a page the browser gives no locks, which holds none', async () => {
    const refusing = { request: () => Promise.reject(new DOMException('no locks here', 'SecurityError')) };
    Object.defineProperty(navigator, 'locks', { value: refusing, configurable: true });
    const rooms = numbered(0, MAX_KEPT_ROOM_CACHES_PER_APP + 2);
    joinAndLeave(rooms);
    await settle();
    expect(idb.deleted).toEqual(names(rooms.slice(0, 2)));
    expect(keptRoomCaches(APP)).toEqual(rooms.slice(2));
  });

  it('is not deleted where its room became the saved one before the deletion was made', async () => {
    const locks = fakeLocks();
    Object.defineProperty(navigator, 'locks', { value: locks, configurable: true });
    joinAndLeave(numbered(0, MAX_KEPT_ROOM_CACHES_PER_APP));
    await settle();

    // One more: `room-0` is to go. Before the browser answers, another tab starts it, and it is the saved room.
    startSync({ room: 'one-more', appId: APP, signaling: [] });
    localStorage.setItem(getSyncRoomKey(APP), 'room-0');
    await settle();

    expect(idb.deleted).toEqual([]);
    expect(keptRoomCaches(APP)).toContain('room-0');
  });
});
