/**
 * Removing an app removes what peer sync kept for it.
 *
 * A host that removed an app took its records (`xdb:<app>:`) and its script's
 * storage (`softn:<app>:`) and left its saved room, its rooms' shared marks
 * and collection lists, and its rooms' offline caches: IndexedDB databases
 * holding a copy of every record the rooms carried.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { carryAppSync, forgetAppSync } from '../src/runtime/sync-app-state';
import { legacySharedFlagKey, roomCollectionsKey, sharedRoomFlagKey } from '../src/runtime/sync-room-security';
import { getSyncRoomKey, persistenceNameFor } from '../src/runtime/xdb-sync-key';
import { keptRoomCaches, noteRoomCache, roomCachesKey } from '../src/runtime/sync-room-caches';

const APP = 'sha256-app-going';
const OTHER = 'sha256-app-staying';

/** An IndexedDB with only what forgetAppSync uses: its databases by name, and deletion. */
function fakeIndexedDB(names: string[], { listable = true, blocked = [] as string[] } = {}) {
  const live = new Set(names);
  const factory = {
    deleted: [] as string[],
    has: (name: string) => live.has(name),
    deleteDatabase(name: string) {
      const request: Record<string, (() => void) | null> = { onsuccess: null, onerror: null, onblocked: null };
      setTimeout(() => {
        // A connection still open holds the deletion: the request says
        // blocked and never succeeds while it stays open.
        if (blocked.includes(name)) {
          request.onblocked?.();
          return;
        }
        live.delete(name);
        factory.deleted.push(name);
        request.onsuccess?.();
      }, 0);
      return request;
    },
    ...(listable ? { databases: async () => [...live].map((name) => ({ name, version: 1 })) } : {}),
  };
  return factory;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

function seedKeys() {
  localStorage.setItem(getSyncRoomKey(APP), 'lobby');
  localStorage.setItem(legacySharedFlagKey(APP), 'true');
  localStorage.setItem(sharedRoomFlagKey(APP, 'lobby'), 'true');
  localStorage.setItem(roomCollectionsKey(APP, 'match-7'), '["scores"]');
  // Another app's, and the app's own records, which are not sync's to remove.
  localStorage.setItem(getSyncRoomKey(OTHER), 'lobby');
  localStorage.setItem(sharedRoomFlagKey(OTHER, 'lobby'), 'true');
  localStorage.setItem(roomCollectionsKey(OTHER, 'lobby'), '["scores"]');
  localStorage.setItem(`xdb:${APP}:notes`, '{}');
}

describe('carryAppSync', () => {
  const NEXT = 'sha256-app-next-build';

  it("copies the app's saved room, shared marks and collection lists, keeping the destination's own", async () => {
    seedKeys();
    localStorage.setItem(roomCollectionsKey(NEXT, 'match-7'), '["its own"]');
    vi.stubGlobal('indexedDB', fakeIndexedDB([persistenceNameFor(APP, 'lobby')]));

    expect(await carryAppSync(APP, NEXT, { move: false })).toBe(3);
    expect(localStorage.getItem(getSyncRoomKey(NEXT))).toBe('lobby');
    expect(localStorage.getItem(legacySharedFlagKey(NEXT))).toBe('true');
    expect(localStorage.getItem(sharedRoomFlagKey(NEXT, 'lobby'))).toBe('true');
    expect(localStorage.getItem(roomCollectionsKey(NEXT, 'match-7'))).toBe('["its own"]');
    // A copy: the older build keeps what it had.
    expect(localStorage.getItem(getSyncRoomKey(APP))).toBe('lobby');
    expect(localStorage.getItem(sharedRoomFlagKey(OTHER, 'lobby'))).toBe('true');
    expect(localStorage.getItem(getSyncRoomKey(OTHER))).toBe('lobby');
  });

  it("moves them, and lets the old identity's room caches go", async () => {
    seedKeys();
    const idb = fakeIndexedDB([persistenceNameFor(APP, 'lobby'), persistenceNameFor(OTHER, 'lobby')]);
    vi.stubGlobal('indexedDB', idb);

    await carryAppSync(APP, NEXT, { move: true });
    expect(localStorage.getItem(getSyncRoomKey(NEXT))).toBe('lobby');
    expect(localStorage.getItem(roomCollectionsKey(NEXT, 'match-7'))).toBe('["scores"]');
    expect(localStorage.getItem(getSyncRoomKey(APP))).toBeNull();
    expect(localStorage.getItem(sharedRoomFlagKey(APP, 'lobby'))).toBeNull();
    expect(idb.has(persistenceNameFor(APP, 'lobby'))).toBe(false);
    expect(idb.has(persistenceNameFor(OTHER, 'lobby'))).toBe(true);
  });
});

describe('forgetAppSync', () => {
  it("removes the app's sync keys and its rooms' caches, and no other app's", async () => {
    seedKeys();
    const idb = fakeIndexedDB([
      persistenceNameFor(APP, 'lobby'),
      persistenceNameFor(APP, 'match-7'),
      persistenceNameFor(APP, 'stopped-long-ago'),
      persistenceNameFor(OTHER, 'lobby'),
      'softn-web-cache',
    ]);
    vi.stubGlobal('indexedDB', idb);

    await forgetAppSync(APP);

    expect(localStorage.getItem(getSyncRoomKey(APP))).toBeNull();
    expect(localStorage.getItem(legacySharedFlagKey(APP))).toBeNull();
    expect(localStorage.getItem(sharedRoomFlagKey(APP, 'lobby'))).toBeNull();
    expect(localStorage.getItem(roomCollectionsKey(APP, 'match-7'))).toBeNull();
    expect(idb.deleted.sort()).toEqual([
      persistenceNameFor(APP, 'lobby'),
      persistenceNameFor(APP, 'match-7'),
      persistenceNameFor(APP, 'stopped-long-ago'),
    ].sort());

    expect(localStorage.getItem(getSyncRoomKey(OTHER))).toBe('lobby');
    expect(localStorage.getItem(sharedRoomFlagKey(OTHER, 'lobby'))).toBe('true');
    expect(localStorage.getItem(roomCollectionsKey(OTHER, 'lobby'))).toBe('["scores"]');
    expect(localStorage.getItem(`xdb:${APP}:notes`)).toBe('{}');
    expect(idb.has(persistenceNameFor(OTHER, 'lobby'))).toBe(true);
    expect(idb.has('softn-web-cache')).toBe(true);
  });

  it('finds the caches of the rooms its keys name where the browser cannot list databases', async () => {
    seedKeys();
    const idb = fakeIndexedDB([persistenceNameFor(APP, 'lobby'), persistenceNameFor(APP, 'match-7'), persistenceNameFor(OTHER, 'lobby')], { listable: false });
    vi.stubGlobal('indexedDB', idb);

    await forgetAppSync(APP);

    expect(idb.has(persistenceNameFor(APP, 'lobby'))).toBe(false);
    expect(idb.has(persistenceNameFor(APP, 'match-7'))).toBe(false);
    expect(idb.has(persistenceNameFor(OTHER, 'lobby'))).toBe(true);
  });

  it("removes the app's list of room caches, and the cache of a room it stopped where databases cannot be listed", async () => {
    seedKeys();
    // A room the app left: stopSync forgot its keys, and its cache is on the list alone.
    noteRoomCache(APP, 'stopped-long-ago');
    noteRoomCache(OTHER, 'stopped-long-ago');
    const idb = fakeIndexedDB([persistenceNameFor(APP, 'stopped-long-ago'), persistenceNameFor(OTHER, 'stopped-long-ago')], { listable: false });
    vi.stubGlobal('indexedDB', idb);

    await forgetAppSync(APP);

    expect(idb.has(persistenceNameFor(APP, 'stopped-long-ago'))).toBe(false);
    expect(localStorage.getItem(roomCachesKey(APP))).toBeNull();
    expect(idb.has(persistenceNameFor(OTHER, 'stopped-long-ago'))).toBe(true);
    expect(keptRoomCaches(OTHER)).toEqual(['stopped-long-ago']);
  });

  it('does not wait on a cache whose connection is still open', async () => {
    localStorage.setItem(getSyncRoomKey(APP), 'lobby');
    const idb = fakeIndexedDB([persistenceNameFor(APP, 'lobby')], { blocked: [persistenceNameFor(APP, 'lobby')] });
    vi.stubGlobal('indexedDB', idb);

    await expect(forgetAppSync(APP)).resolves.toBeUndefined();
    expect(localStorage.getItem(getSyncRoomKey(APP))).toBeNull();
  });

  it('removes the keys where there is no IndexedDB at all', async () => {
    seedKeys();
    vi.stubGlobal('indexedDB', undefined);

    await forgetAppSync(APP);

    expect(localStorage.getItem(getSyncRoomKey(APP))).toBeNull();
    expect(localStorage.getItem(sharedRoomFlagKey(APP, 'lobby'))).toBeNull();
    expect(localStorage.getItem(sharedRoomFlagKey(OTHER, 'lobby'))).toBe('true');
  });
});

describe('forgetAppSync, for an app whose identity begins another’s', () => {
  // A cache is `xdb-sync:<app>:<room>` and a mark `xdb-sync-shared:<app>:<room>`, and an identity
  // can hold a colon: a page's in the single shell is `page:<path>:<id>`, and the web host keeps
  // what it cached before identities were digests under the manifest's name. So what follows
  // `Notes:` may be a room of Notes's (`team:red`) or the rest of another app's identity and its
  // room (`Notes:Pro`, `club`), and removing Notes took Notes:Pro's caches and marks, found by
  // what their names begin with.
  const SHORT = 'Notes';
  const LONG = 'Notes:Pro';

  function seedBoth() {
    // Notes:Pro is in its room `club`.
    localStorage.setItem(getSyncRoomKey(LONG), 'club');
    localStorage.setItem(sharedRoomFlagKey(LONG, 'club'), 'true');
    localStorage.setItem(roomCollectionsKey(LONG, 'club'), '["scores"]');
    noteRoomCache(LONG, 'club');
    // Notes is in `lobby`, has been in a room whose own name has a colon, and kept, from a build
    // before the list of caches, a cache and a mark of a room it stopped long ago, and of one named `Pro:archive`.
    localStorage.setItem(getSyncRoomKey(SHORT), 'lobby');
    localStorage.setItem(sharedRoomFlagKey(SHORT, 'lobby'), 'true');
    noteRoomCache(SHORT, 'lobby');
    noteRoomCache(SHORT, 'team:red');
    localStorage.setItem(roomCollectionsKey(SHORT, 'team:red'), '["moves"]');
    localStorage.setItem(sharedRoomFlagKey(SHORT, 'old'), 'true');
    localStorage.setItem(sharedRoomFlagKey(SHORT, 'Pro:archive'), 'true');
    return fakeIndexedDB([
      persistenceNameFor(LONG, 'club'),
      persistenceNameFor(SHORT, 'lobby'),
      persistenceNameFor(SHORT, 'team:red'),
      persistenceNameFor(SHORT, 'old'),
      persistenceNameFor(SHORT, 'Pro:archive'),
    ]);
  }

  it('removes what is the app’s and leaves what the other app kept', async () => {
    const idb = seedBoth();
    vi.stubGlobal('indexedDB', idb);

    await forgetAppSync(SHORT);

    // Its own: the rooms on its list, a colon in a name or not, and the old room no other identity could have.
    expect(idb.deleted.sort()).toEqual([persistenceNameFor(SHORT, 'lobby'), persistenceNameFor(SHORT, 'old'), persistenceNameFor(SHORT, 'team:red')].sort());
    expect(localStorage.getItem(getSyncRoomKey(SHORT))).toBeNull();
    expect(localStorage.getItem(sharedRoomFlagKey(SHORT, 'lobby'))).toBeNull();
    expect(localStorage.getItem(roomCollectionsKey(SHORT, 'team:red'))).toBeNull();
    expect(localStorage.getItem(sharedRoomFlagKey(SHORT, 'old'))).toBeNull();
    expect(keptRoomCaches(SHORT)).toEqual([]);
    // Notes:Pro's, all of it.
    expect(idb.has(persistenceNameFor(LONG, 'club'))).toBe(true);
    expect(localStorage.getItem(getSyncRoomKey(LONG))).toBe('club');
    expect(localStorage.getItem(sharedRoomFlagKey(LONG, 'club'))).toBe('true');
    expect(localStorage.getItem(roomCollectionsKey(LONG, 'club'))).toBe('["scores"]');
    expect(keptRoomCaches(LONG)).toEqual(['club']);
    // An old room of its own named `Pro:archive` cannot be told from a room `archive` of Notes:Pro's, and is left.
    expect(idb.has(persistenceNameFor(SHORT, 'Pro:archive'))).toBe(true);
    expect(localStorage.getItem(sharedRoomFlagKey(SHORT, 'Pro:archive'))).toBe('true');
  });

  it('and removing the other app leaves the first one’s', async () => {
    const idb = seedBoth();
    vi.stubGlobal('indexedDB', idb);

    await forgetAppSync(LONG);

    expect(idb.deleted).toEqual([persistenceNameFor(LONG, 'club')]);
    expect(localStorage.getItem(getSyncRoomKey(LONG))).toBeNull();
    expect(localStorage.getItem(sharedRoomFlagKey(LONG, 'club'))).toBeNull();
    expect(localStorage.getItem(roomCollectionsKey(LONG, 'club'))).toBeNull();
    expect(keptRoomCaches(LONG)).toEqual([]);
    // `Pro:archive` is Notes's here, though its name begins with Notes:Pro's.
    for (const room of ['lobby', 'team:red', 'old', 'Pro:archive']) expect(idb.has(persistenceNameFor(SHORT, room)), room).toBe(true);
    expect(localStorage.getItem(sharedRoomFlagKey(SHORT, 'Pro:archive'))).toBe('true');
    expect(keptRoomCaches(SHORT)).toEqual(['lobby', 'team:red']);
  });
});
