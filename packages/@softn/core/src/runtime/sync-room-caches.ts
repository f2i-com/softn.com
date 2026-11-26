/**
 * The offline caches an app's sync rooms leave on a device, counted.
 *
 * Every room an app joins keeps a cache of its own: an IndexedDB database
 * (`xdb-sync:<appId>:<room>`, xdb-sync-key.ts) holding the room's document,
 * a copy of every record the room carries. Leaving a room keeps it, and has
 * to: a record removed for good while the room was open and no peer was
 * there is told to the document and to nothing else (the store forgets the
 * removal once the document has it, xdb-service.ts), so a cache deleted on
 * leaving brought that record back from the first peer met afterwards. But
 * nothing counted the caches. An app that joined a new name each time and
 * left grew the site's IndexedDB by a copy of its records for every name,
 * out of every app's reach, its own included, until the app was removed.
 *
 * So each app has a list of the rooms it has a cache of, in the order they
 * were last joined (`xdb-sync-caches:<appId>`, in the page's storage), and
 * past MAX_KEPT_ROOM_CACHES_PER_APP the caches of the rooms joined longest
 * ago are deleted (xdb-sync.ts decides which: never one of a room that is
 * open, nor of the saved room an app goes back to when it starts). A room
 * whose cache went is joined again as a new room is: its records come from
 * the store and from its peers.
 *
 * A cache is held while its room is open (`navigator.locks`), so another
 * tab of the app does not delete it as one long left: y-indexeddb closes its
 * connection when its database is deleted, and every write of the open room
 * threw after that. Every deletion asks (deleteRoomCache): an old one's, one
 * a room is left with for good (destroySync, a room that outgrew what a room
 * holds) and an app's removal (sync-app-state.ts). One that is held stays,
 * and stays on the list. A cache made by a build before this one is on no list
 * until its room is joined again; removing the app finds those where the
 * browser lists databases (sync-app-state.ts).
 *
 * This module imports no sync runtime (no yjs), so a host removing an app
 * reads the list without it.
 */

import { isSyncRoomName } from './sync-room-security';

/** Prefix of every list of room caches; the exact strings are an on-disk contract. */
const ROOM_CACHES_KEY_PREFIX = 'xdb-sync-caches';

/**
 * The most room caches an app keeps on a device: as many as the rooms it may
 * have open (MAX_OPEN_SYNC_ROOMS_PER_APP). Each is a copy of the records its
 * room carries, within what a room's document holds (MAX_ROOM_DOC_BYTES).
 */
export const MAX_KEPT_ROOM_CACHES_PER_APP = 8;

/** The localStorage key of an app's list of room caches, namespaced by appId as its saved room is. */
export function roomCachesKey(appId?: string): string {
  return appId ? `${ROOM_CACHES_KEY_PREFIX}:${appId}` : ROOM_CACHES_KEY_PREFIX;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function indexedDBFactory(): IDBFactory | null {
  try {
    return typeof indexedDB === 'undefined' ? null : indexedDB;
  } catch {
    return null;
  }
}

function lockManager(): LockManager | null {
  try {
    return typeof navigator === 'undefined' ? null : (navigator.locks ?? null);
  } catch {
    return null;
  }
}

/** The list as it is kept: room names, the one joined longest ago first. What is no list of names is an empty one. */
function readList(store: Storage, appId: string | undefined): string[] {
  const raw = store.getItem(roomCachesKey(appId));
  if (!raw) return [];
  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  return [...new Set(list.filter(isSyncRoomName))];
}

function writeList(store: Storage, appId: string | undefined, rooms: string[]): void {
  if (rooms.length === 0) store.removeItem(roomCachesKey(appId));
  else store.setItem(roomCachesKey(appId), JSON.stringify(rooms));
}

/** The rooms an app has a cache of, the one joined longest ago first. Never throws. */
export function keptRoomCaches(appId: string | undefined): string[] {
  const store = storage();
  if (!store) return [];
  try {
    return readList(store, appId);
  } catch {
    return [];
  }
}

/**
 * Put `room` on the app's list as the one joined last, before its cache is
 * opened. False where the list could not be kept (no storage, or a full
 * one): a cache nothing lists is one nothing would ever delete, so the room
 * is then opened without one.
 */
export function noteRoomCache(appId: string | undefined, room: string): boolean {
  const store = storage();
  if (!store) return false;
  try {
    const rooms = readList(store, appId).filter((kept) => kept !== room);
    rooms.push(room);
    writeList(store, appId, rooms);
    return true;
  } catch {
    return false;
  }
}

/** Take rooms off the app's list: their caches are deleted, or about to be. */
export function forgetRoomCaches(appId: string | undefined, rooms: readonly string[]): void {
  const store = storage();
  if (!store || rooms.length === 0) return;
  try {
    const kept = readList(store, appId);
    const left = kept.filter((room) => !rooms.includes(room));
    if (left.length !== kept.length) writeList(store, appId, left);
  } catch {
    // Storage that refuses: the list is as it was, and the room is tried again at the next join.
  }
}

/**
 * Put back a room whose cache was to be deleted and was not (deleteRoomCache
 * found it in use), as the one joined longest ago, so it is the first tried
 * again. Left alone where the room is on the list: it was joined since.
 */
export function restoreRoomCache(appId: string | undefined, room: string): void {
  const store = storage();
  if (!store) return;
  try {
    const kept = readList(store, appId);
    if (!kept.includes(room)) writeList(store, appId, [room, ...kept]);
  } catch {
    // Not listed again: removing the app still finds the cache where databases can be listed.
  }
}

/**
 * Settles when the database is gone, or could not be, or is held open: a
 * room that is closing may still have its connection open, and the deletion
 * then waits in the browser until it closes, without this waiting.
 */
function deleteCacheDatabase(idb: IDBFactory, name: string): Promise<void> {
  return new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = idb.deleteDatabase(name);
    } catch {
      resolve();
      return;
    }
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}

/** The name a cache is held under while its room is open, in this tab or another. */
function cacheLockName(name: string): string {
  return `xdb-sync-cache:${name}`;
}

/** One hold of a cache by this page: whether its room has let it go, and when the browser has. */
interface CacheHold {
  released: boolean;
  gone: Promise<void>;
}

/**
 * This page's holds of each cache that the browser has not yet let go. A
 * room's hold outlives the room by a moment (the browser lets it go when it
 * hears), and a deletion asked for in that moment found the cache held, by
 * the room that had just left it.
 */
const ownHolds = new Map<string, Set<CacheHold>>();

/**
 * Hold a room's cache (the database named `name`) for as long as its room is
 * open; answers the function that lets it go. Shared, so every tab with the
 * room open holds it. Holds nothing where the browser has no locks (Safari
 * before 15.4, a page that is not a secure context).
 */
export function holdRoomCache(name: string): () => void {
  const locks = lockManager();
  if (!locks) return () => {};
  const hold: CacheHold = { released: false, gone: Promise.resolve() };
  let letGo: (() => void) | null = null;
  let asked: Promise<unknown>;
  try {
    asked = locks.request(cacheLockName(name), { mode: 'shared' }, () => new Promise<void>((resolve) => {
      if (hold.released) resolve();
      else letGo = resolve;
    }));
  } catch {
    // Not held: the cache is still kept from this page's own deletions by its room being open.
    return () => {};
  }
  const holds = ownHolds.get(name) ?? new Set<CacheHold>();
  ownHolds.set(name, holds);
  holds.add(hold);
  hold.gone = asked.catch(() => {}).then(() => {
    holds.delete(hold);
    if (holds.size === 0 && ownHolds.get(name) === holds) ownHolds.delete(name);
  });
  return () => {
    hold.released = true;
    letGo?.();
  };
}

/**
 * Delete a room's cache, unless a room has it open: one in another tab holds
 * it (holdRoomCache), and `unused` answers for this page, asked last, as the
 * deletion is made. Answers whether the cache is gone, or going. Where the
 * browser has no locks the deletion is asked for at once, before a start
 * that follows can open the database: the browser then deletes first and
 * opens a new one.
 */
export function deleteRoomCache(name: string, unused: () => boolean): Promise<boolean> {
  const idb = indexedDBFactory();
  // No IndexedDB, no cache.
  if (!idb) return Promise.resolve(true);
  const now = (): Promise<boolean> => {
    if (!unused()) return Promise.resolve(false);
    return deleteCacheDatabase(idb, name).then(() => true);
  };
  const locks = lockManager();
  if (!locks) return now();
  const mine = [...(ownHolds.get(name) ?? [])];
  if (mine.some((hold) => !hold.released)) return Promise.resolve(false);
  // The holds of rooms this page has just left are waited out; another tab's are not.
  return Promise.all(mine.map((hold) => hold.gone))
    .then(async () => await locks.request(cacheLockName(name), { mode: 'exclusive', ifAvailable: true }, (lock) => (lock ? now() : false)))
    // A browser that will not say who holds it (a page it gives no locks) is one with none.
    .catch(() => now());
}
