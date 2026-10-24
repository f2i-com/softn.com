/**
 * What peer sync keeps on this device for one app, found, removed and
 * carried in one place, for a host removing the app or bringing its data to
 * another identity.
 *
 * Sync keeps its own things beside the app's records and its script's
 * storage: the saved room (`xdb-sync-active-room:<appId>`), each room's
 * shared mark (`xdb-sync-shared:<appId>:<room>`, and the per-app flag older
 * builds wrote), each room's collection list
 * (`xdb-sync-collections:<appId>:<room>`), and each room's offline CRDT
 * cache, an IndexedDB database of its own (`xdb-sync:<appId>:<room>`). A
 * host that removed an app took its records and left all of these, the
 * caches holding a copy of every record the app's rooms had carried, for
 * nothing to reach or clear again. The names are spelled where they are
 * written (xdb-sync-key.ts, sync-room-security.ts); this module only reads
 * them, and imports neither the sync runtime nor yjs.
 */

import { getSyncRoomKey, persistenceNameFor } from './xdb-sync-key';
import { legacySharedFlagKey, roomCollectionsKey, sharedRoomFlagKey } from './sync-room-security';

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

/**
 * Remove the sync keys of an app and name the rooms they spoke of. The room
 * is what follows the app's prefix in a shared mark or a collection list
 * (the key functions with an empty room give the prefixes).
 */
function forgetSyncKeys(appId: string): Set<string> {
  const rooms = new Set<string>();
  const store = storage();
  if (!store) return rooms;
  try {
    const gone: string[] = [];
    const savedKey = getSyncRoomKey(appId);
    const saved = store.getItem(savedKey);
    if (saved !== null) {
      rooms.add(saved);
      gone.push(savedKey);
    }
    if (store.getItem(legacySharedFlagKey(appId)) !== null) gone.push(legacySharedFlagKey(appId));
    const prefixes = [sharedRoomFlagKey(appId, ''), roomCollectionsKey(appId, '')];
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      const prefix = key === null ? undefined : prefixes.find((p) => key.startsWith(p));
      if (key === null || prefix === undefined) continue;
      rooms.add(key.slice(prefix.length));
      gone.push(key);
    }
    for (const key of gone) store.removeItem(key);
  } catch {
    // Storage that refuses reads holds nothing of the app's to remove.
  }
  return rooms;
}

/**
 * The app's room caches: every database whose name has the app's prefix,
 * where the browser can list them (`indexedDB.databases()`), and the caches of
 * the rooms its keys named either way. Where it cannot list them, the cache of
 * a room the app stopped (stopSync forgets that room's keys) is not found.
 */
async function roomCaches(idb: IDBFactory, appId: string, rooms: Set<string>): Promise<string[]> {
  const names = new Set([...rooms].map((room) => persistenceNameFor(appId, room)));
  const prefix = persistenceNameFor(appId, '');
  try {
    const listed = typeof idb.databases === 'function' ? await idb.databases() : [];
    for (const { name } of listed) {
      if (name?.startsWith(prefix)) names.add(name);
    }
  } catch {
    // A browser that cannot list them: the named rooms' caches are still removed.
  }
  return [...names];
}

/**
 * Settles when the database is gone, or could not be, or is held open: a
 * room whose app is closing may still have its connection open, and the
 * deletion then waits in the browser until it closes, without this waiting.
 */
function deleteDatabase(idb: IDBFactory, name: string): Promise<void> {
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

/**
 * Carry what peer sync keeps for one identity of an app to another: its
 * saved room, and each room's shared mark and collection list. A host that
 * brought an app's records forward to a new build (copy), or moved them to
 * the identity it now knows the same bundle by (move), carried its records
 * and left these behind: the app no longer went back to its room, and a
 * shared room it started again without options opened private, where its
 * peers were not. What the destination has of its own is kept. The rooms'
 * offline caches are not carried (they are filled again from the room);
 * a move deletes the source's. Answers how many keys were carried.
 */
export async function carryAppSync(from: string, to: string, options: { move: boolean }): Promise<number> {
  if (!from || !to || from === to) return 0;
  let carried = 0;
  const store = storage();
  if (store) {
    try {
      const pairs: Array<[string, string]> = [
        [getSyncRoomKey(from), getSyncRoomKey(to)],
        [legacySharedFlagKey(from), legacySharedFlagKey(to)],
      ];
      const prefixes: Array<[string, string]> = [
        [sharedRoomFlagKey(from, ''), sharedRoomFlagKey(to, '')],
        [roomCollectionsKey(from, ''), roomCollectionsKey(to, '')],
      ];
      for (let i = 0; i < store.length; i++) {
        const key = store.key(i);
        if (key === null) continue;
        for (const [source, target] of prefixes) {
          if (key.startsWith(source)) pairs.push([key, target + key.slice(source.length)]);
        }
      }
      for (const [source, target] of pairs) {
        const value = store.getItem(source);
        if (value === null || store.getItem(target) !== null) continue;
        store.setItem(target, value);
        carried++;
      }
    } catch {
      // Storage that refuses: the rooms are joined afresh, as before.
    }
  }
  if (options.move) await forgetAppSync(from);
  return carried;
}

/**
 * Remove everything peer sync keeps on this device for an app: its saved
 * room, its rooms' shared marks and collection lists, and their offline
 * caches. For a host removing the app, once it has stopped: a room still open
 * would write its cache again. Never throws.
 */
export async function forgetAppSync(appId: string): Promise<void> {
  if (!appId) return;
  const rooms = forgetSyncKeys(appId);
  const idb = indexedDBFactory();
  if (!idb) return;
  const caches = await roomCaches(idb, appId, rooms);
  await Promise.all(caches.map((name) => deleteDatabase(idb, name)));
}
