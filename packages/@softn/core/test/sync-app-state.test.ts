/**
 * Removing an app removes what peer sync kept for it.
 *
 * A host that removed an app took its records (`xdb:<app>:`) and its script's
 * storage (`softn:<app>:`) and left its saved room, its rooms' shared marks
 * and collection lists, and its rooms' offline caches: IndexedDB databases
 * holding a copy of every record the rooms carried.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forgetAppSync } from '../src/runtime/sync-app-state';
import { legacySharedFlagKey, roomCollectionsKey, sharedRoomFlagKey } from '../src/runtime/sync-room-security';
import { getSyncRoomKey, persistenceNameFor } from '../src/runtime/xdb-sync-key';

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
