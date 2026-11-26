/**
 * What peer sync keeps on this device for one app, found, removed and
 * carried in one place, for a host removing the app or bringing its data to
 * another identity.
 *
 * Sync keeps its own things beside the app's records and its script's
 * storage: the saved room (`xdb-sync-active-room:<appId>`), each room's
 * shared mark (`xdb-sync-shared:<appId>:<room>`, and the per-app flag older
 * builds wrote), each room's collection list
 * (`xdb-sync-collections:<appId>:<room>`), each room's offline CRDT
 * cache, an IndexedDB database of its own (`xdb-sync:<appId>:<room>`), and
 * the list of the rooms that have one (`xdb-sync-caches:<appId>`). A
 * host that removed an app took its records and left all of these, the
 * caches holding a copy of every record the app's rooms had carried, for
 * nothing to reach or clear again. The names are spelled where they are
 * written (xdb-sync-key.ts, sync-room-security.ts, sync-room-caches.ts);
 * this module only reads them, and imports neither the sync runtime nor yjs.
 */

import { getSyncRoomKey, persistenceNameFor } from './xdb-sync-key';
import { legacySharedFlagKey, roomCollectionsKey, sharedRoomFlagKey } from './sync-room-security';
import { deleteRoomCache, keptRoomCaches, restoreRoomCache, roomCachesKey } from './sync-room-caches';

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
 * Whether `rest`, what follows an app's prefix in one of sync's keys or in a
 * cache's name (`<what>:<appId>:<rest>`), is surely the app's own room: one
 * it is known to have (`known`: its list of caches, its saved room), or one
 * no other identity's names could spell.
 *
 * An identity can hold a colon (a page's in the single shell is
 * `page:<path>:<id>`; the web host keeps what it cached before identities
 * were digests under the manifest's name), and so can a room's name. What
 * follows `Notes:` in `xdb-sync:Notes:Pro:club` may be a room of Notes's
 * named `Pro:club`, or the rest of the identity `Notes:Pro` and its room
 * `club`; and where the app's own identity has a colon, any name it begins
 * may be a shorter one's (`Notes:Pro`'s `x` is Notes's `Pro:x`). Every name
 * that began with the app's prefix was taken for the app's, and removing
 * `Notes` deleted `Notes:Pro`'s caches and marks with its own.
 */
function ownRoom(appId: string, rest: string, known: ReadonlySet<string>): boolean {
  return known.has(rest) || (!appId.includes(':') && !rest.includes(':'));
}

/**
 * Remove the sync keys of an app and name the rooms they spoke of: each one
 * on the app's list of room caches, which names the rooms it stopped too, its
 * saved room, and what follows the app's prefix in a shared mark or a
 * collection list (the key functions with an empty room give the prefixes)
 * where that is surely the app's room (ownRoom). A key that may be another
 * app's is left.
 */
function forgetSyncKeys(appId: string): Set<string> {
  const rooms = new Set<string>(keptRoomCaches(appId));
  const store = storage();
  if (!store) return rooms;
  try {
    const gone: string[] = [roomCachesKey(appId)];
    const savedKey = getSyncRoomKey(appId);
    const saved = store.getItem(savedKey);
    if (saved !== null) {
      rooms.add(saved);
      gone.push(savedKey);
    }
    if (store.getItem(legacySharedFlagKey(appId)) !== null) gone.push(legacySharedFlagKey(appId));
    const known = new Set(rooms);
    const prefixes = [sharedRoomFlagKey(appId, ''), roomCollectionsKey(appId, '')];
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      const prefix = key === null ? undefined : prefixes.find((p) => key.startsWith(p));
      if (key === null || prefix === undefined) continue;
      const room = key.slice(prefix.length);
      if (!ownRoom(appId, room, known)) continue;
      rooms.add(room);
      gone.push(key);
    }
    for (const key of gone) store.removeItem(key);
  } catch {
    // Storage that refuses reads holds nothing of the app's to remove.
  }
  return rooms;
}

/**
 * The app's room caches: those of the rooms its keys named, and, where the
 * browser can list databases (`indexedDB.databases()`), each one whose name
 * has the app's prefix and is surely the app's (ownRoom). Where it cannot
 * list them, the cache of a room the app stopped (stopSync forgets that
 * room's keys) is found by the app's list of caches, or not at all where a
 * build before that list made it.
 */
async function roomCaches(idb: IDBFactory, appId: string, rooms: Set<string>): Promise<string[]> {
  const names = new Set([...rooms].map((room) => persistenceNameFor(appId, room)));
  const prefix = persistenceNameFor(appId, '');
  try {
    const listed = typeof idb.databases === 'function' ? await idb.databases() : [];
    for (const { name } of listed) {
      if (name?.startsWith(prefix) && ownRoom(appId, name.slice(prefix.length), rooms)) names.add(name);
    }
  } catch {
    // A browser that cannot list them: the named rooms' caches are still removed.
  }
  return [...names];
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
 *
 * `exact`: only the saved room's keys, each named in full, for an identity
 * that may begin another's (a manifest's name: `Notes` begins `Notes:Pro`,
 * whose rooms' marks a search by beginning found as Notes's). Not with `move`.
 */
export async function carryAppSync(from: string, to: string, options: { move: boolean; exact?: boolean }): Promise<number> {
  if (!from || !to || from === to) return 0;
  let carried = 0;
  const store = storage();
  if (store) {
    try {
      const pairs: Array<[string, string]> = [
        [getSyncRoomKey(from), getSyncRoomKey(to)],
        [legacySharedFlagKey(from), legacySharedFlagKey(to)],
      ];
      if (options.exact) {
        const saved = store.getItem(getSyncRoomKey(from));
        if (saved !== null) {
          pairs.push([sharedRoomFlagKey(from, saved), sharedRoomFlagKey(to, saved)]);
          pairs.push([roomCollectionsKey(from, saved), roomCollectionsKey(to, saved)]);
        }
      }
      const prefixes: Array<[string, string]> = options.exact ? [] : [
        [sharedRoomFlagKey(from, ''), sharedRoomFlagKey(to, '')],
        [roomCollectionsKey(from, ''), roomCollectionsKey(to, '')],
      ];
      for (let i = 0; i < store.length && prefixes.length > 0; i++) {
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
  if (options.move && !options.exact) await forgetAppSync(from);
  return carried;
}

/**
 * Remove everything peer sync keeps on this device for an app: its saved
 * room, its rooms' shared marks and collection lists, and their offline
 * caches. For a host removing the app, once it has stopped: a room still open
 * would write its cache again. Never throws.
 *
 * A cache is deleted only where no tab has its room open (deleteRoomCache):
 * the app may still be open in another tab, whose room's cache this deleted
 * under it, and from then on every change there threw and the room stopped
 * sending. One that is held is left, and is put back on the app's list of
 * caches, so that it is found again: by the next removal, or by the app,
 * should it be opened again, as one of its old caches. Where the browser has
 * no locks to ask, each is deleted at once, as before.
 *
 * Only what is surely the app's is removed (ownRoom): another app's name can
 * begin with this one's. A room of a build before the list of caches whose
 * name cannot be told from another identity's is left where it is.
 */
export async function forgetAppSync(appId: string): Promise<void> {
  if (!appId) return;
  const rooms = forgetSyncKeys(appId);
  const idb = indexedDBFactory();
  if (!idb) return;
  const caches = await roomCaches(idb, appId, rooms);
  const prefix = persistenceNameFor(appId, '');
  await Promise.all(caches.map(async (name) => {
    if (!(await deleteRoomCache(name, () => true))) restoreRoomCache(appId, name.slice(prefix.length));
  }));
}
