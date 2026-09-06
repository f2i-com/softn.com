/**
 * The app cache after IndexedDB refuses to open.
 *
 * One failed open used to switch the cache off for the rest of the session.
 * What is pinned: a failure that cannot be mended stays off; one that can is
 * tried again once its backoff has passed, and at once when the user asks.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const openDB = vi.fn();
vi.mock('idb', () => ({ openDB: (...args: unknown[]) => openDB(...args) }));

type Cache = typeof import('../src/lib/appCache');

async function freshCache(): Promise<Cache> {
  vi.resetModules();
  return import('../src/lib/appCache');
}

function fakeDb(apps: unknown[] = []) {
  return { getAll: vi.fn(async () => apps), close: vi.fn() };
}

function failure(name: string): Error {
  const err = new Error(name);
  err.name = name;
  return err;
}

beforeEach(() => {
  openDB.mockReset();
  vi.useFakeTimers();
  vi.stubGlobal('indexedDB', {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('classifying an open failure', () => {
  it('treats a refusal by policy as permanent and everything else as transient', async () => {
    const { classifyIndexedDBFailure } = await freshCache();
    expect(classifyIndexedDBFailure(failure('SecurityError'))).toBe('permanent');
    expect(classifyIndexedDBFailure(failure('InvalidStateError'))).toBe('permanent');
    expect(classifyIndexedDBFailure(failure('AbortError'))).toBe('transient');
    expect(classifyIndexedDBFailure(failure('QuotaExceededError'))).toBe('transient');
    expect(classifyIndexedDBFailure(failure('UnknownError'))).toBe('transient');
    expect(classifyIndexedDBFailure(new Error('no name'))).toBe('transient');
  });

  it('is permanent when there is no IndexedDB at all', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const { classifyIndexedDBFailure } = await freshCache();
    expect(classifyIndexedDBFailure(failure('AbortError'))).toBe('permanent');
  });
});

describe('a transient open failure', () => {
  it('is tried again after the backoff, without a reload', async () => {
    openDB
      .mockRejectedValueOnce(failure('AbortError'))
      .mockResolvedValue(fakeDb([{ id: 'a', lastOpened: 1 }]));
    const cache = await freshCache();

    expect(await cache.getCachedApps()).toEqual([]);
    expect(openDB).toHaveBeenCalledTimes(1);

    // Inside the backoff: no new attempt, still empty.
    vi.advanceTimersByTime(1_000);
    expect(await cache.getCachedApps()).toEqual([]);
    expect(openDB).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5_000);
    expect(await cache.getCachedApps()).toEqual([{ id: 'a', lastOpened: 1 }]);
    expect(openDB).toHaveBeenCalledTimes(2);
  });

  it('is tried again at once when asked', async () => {
    openDB.mockRejectedValueOnce(failure('AbortError')).mockResolvedValue(fakeDb());
    const cache = await freshCache();
    await cache.getCachedApps();
    cache.resetAppCacheAvailability();
    await cache.getCachedApps();
    expect(openDB).toHaveBeenCalledTimes(2);
  });
});

describe('a permanent open failure', () => {
  it('stays off for the session', async () => {
    openDB.mockRejectedValue(failure('SecurityError'));
    const cache = await freshCache();
    await cache.getCachedApps();
    vi.advanceTimersByTime(60_000);
    await cache.getCachedApps();
    expect(openDB).toHaveBeenCalledTimes(1);
  });

  it('can still be lifted by an explicit reset', async () => {
    openDB.mockRejectedValueOnce(failure('SecurityError')).mockResolvedValue(fakeDb());
    const cache = await freshCache();
    await cache.getCachedApps();
    cache.resetAppCacheAvailability();
    await cache.getCachedApps();
    expect(openDB).toHaveBeenCalledTimes(2);
  });
});

describe('a connection the browser takes away', () => {
  it('is reopened on the next call', async () => {
    let options: { terminated?: () => void } | undefined;
    openDB.mockImplementation(
      async (_name: string, _version: number, opts: { terminated?: () => void }) => {
        options = opts;
        return fakeDb();
      }
    );
    const cache = await freshCache();
    await cache.getCachedApps();
    options?.terminated?.();
    await cache.getCachedApps();
    expect(openDB).toHaveBeenCalledTimes(2);
  });
});

// ── Both stores ──────────────────────────────────────────────────────
//
// An app keeps state under two prefixes: its XDB records and what its script
// keeps through localStorage itself. Export, import, copy and removal used
// to cover the first and not the second.

/** A localStorage that lives in a Map, with a way to make one write fail. */
function memoryStorage(failing: { setItem?: (key: string) => boolean } = {}) {
  const map = new Map<string, string>();
  return {
    map,
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (failing.setItem?.(k)) {
        const err = new Error('quota');
        err.name = 'QuotaExceededError';
        throw err;
      }
      map.set(k, String(v));
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
    clear: () => map.clear(),
  };
}

const ORIGIN = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);

function seed(store: ReturnType<typeof memoryStorage>, origin: string) {
  store.map.set(`xdb:${origin}:notes`, '[{"id":1}]');
  store.map.set(`softn:${origin}:pocket:battery:zelda`, 'AAAA');
  store.map.set(`softn:${origin}:pocket:state:zelda:1`, 'BBBB');
}

describe("an app's data in both of its stores", () => {
  it('is counted, exported, copied and removed together', async () => {
    const store = memoryStorage();
    vi.stubGlobal('localStorage', store);
    const cache = await freshCache();
    seed(store, ORIGIN);
    store.map.set(`xdb:${OTHER}:notes`, 'theirs');

    expect(cache.hasStoredData(ORIGIN)).toBe(true);
    const snapshot = cache.exportAppData({ name: 'Pocket', version: '1', origin: ORIGIN });
    expect(snapshot?.version).toBe(2);
    expect(snapshot?.stores.xdb).toEqual({ notes: '[{"id":1}]' });
    expect(snapshot?.stores.local).toEqual({
      'pocket:battery:zelda': 'AAAA',
      'pocket:state:zelda:1': 'BBBB',
    });
    expect(cache.snapshotEntryCount(snapshot!)).toBe(3);

    // Both stores come across; a key the destination already has is kept.
    const copied = cache.copyAppData(ORIGIN, OTHER);
    expect(copied).toMatchObject({ ok: true, copied: 2, total: 3, skipped: 1 });
    expect(store.map.get(`softn:${OTHER}:pocket:battery:zelda`)).toBe('AAAA');
    expect(store.map.get(`xdb:${OTHER}:notes`)).toBe('theirs');

    expect(cache.removeAppData(ORIGIN)).toBe(3);
    expect(cache.hasStoredData(ORIGIN)).toBe(false);
    expect(store.map.get(`xdb:${OTHER}:notes`)).toBe('theirs');
    expect(store.map.get(`softn:${OTHER}:pocket:battery:zelda`)).toBe('AAAA');
  });

  it("is seen by hasStoredData when only the script's own keys exist", async () => {
    const store = memoryStorage();
    vi.stubGlobal('localStorage', store);
    const cache = await freshCache();
    store.map.set(`softn:${ORIGIN}:save`, 'x');
    expect(cache.hasStoredData(ORIGIN)).toBe(true);
  });

  it('comes back whole from an export, into a clean browser', async () => {
    const store = memoryStorage();
    vi.stubGlobal('localStorage', store);
    const cache = await freshCache();
    seed(store, ORIGIN);
    const text = JSON.stringify(
      cache.exportAppData({ name: 'Pocket', version: '1', origin: ORIGIN })
    );
    store.map.clear();

    const read = cache.readAppDataSnapshot(text);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const result = cache.importAppData(read.snapshot, { origin: ORIGIN });
    expect(result).toMatchObject({ ok: true, copied: 3 });
    expect(store.map.get(`xdb:${ORIGIN}:notes`)).toBe('[{"id":1}]');
    expect(store.map.get(`softn:${ORIGIN}:pocket:battery:zelda`)).toBe('AAAA');
    expect([...store.map.keys()].some((k) => k.startsWith('softn-web:restore:'))).toBe(false);
  });

  it('still reads a format-1 export as records with no saved keys', async () => {
    vi.stubGlobal('localStorage', memoryStorage());
    const cache = await freshCache();
    const read = cache.readAppDataSnapshot(
      JSON.stringify({
        format: 'softn-app-data',
        version: 1,
        app: { name: 'N', version: '1', origin: ORIGIN },
        entries: { notes: '[]' },
      })
    );
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.snapshot.stores).toEqual({ xdb: { notes: '[]' }, local: {} });
  });
});

describe('an import that does not reach its end', () => {
  it('leaves the data as it was when a write fails part way, and no journal behind', async () => {
    const store = memoryStorage({ setItem: (k) => k === `softn:${ORIGIN}:pocket:state:zelda:1` });
    vi.stubGlobal('localStorage', store);
    const cache = await freshCache();
    store.map.set(`xdb:${ORIGIN}:notes`, 'old');
    store.map.set(`softn:${ORIGIN}:old-save`, 'old');
    const snapshot = {
      format: 'softn-app-data' as const,
      version: 2 as const,
      app: { name: 'Pocket', version: '2', origin: ORIGIN },
      exportedAt: 0,
      stores: {
        xdb: { notes: 'new' },
        local: { 'pocket:battery:zelda': 'AAAA', 'pocket:state:zelda:1': 'BBBB' },
      },
    };
    const result = cache.importAppData(snapshot, { origin: ORIGIN });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/could not be written/);
    expect(store.map.get(`xdb:${ORIGIN}:notes`)).toBe('old');
    expect(store.map.get(`softn:${ORIGIN}:old-save`)).toBe('old');
    expect(store.map.has(`softn:${ORIGIN}:pocket:battery:zelda`)).toBe(false);
    expect([...store.map.keys()].some((k) => k.startsWith('softn-web:restore:'))).toBe(false);
  });

  it('is refused before anything is touched when the journal itself cannot be written', async () => {
    const store = memoryStorage({ setItem: (k) => k.startsWith('softn-web:restore:') });
    vi.stubGlobal('localStorage', store);
    const cache = await freshCache();
    store.map.set(`xdb:${ORIGIN}:notes`, 'old');
    const result = cache.replaceStorageKeys(`xdb:${ORIGIN}:`, { notes: 'new' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Nothing was changed/);
    expect(store.map.get(`xdb:${ORIGIN}:notes`)).toBe('old');
  });

  it('is put back at the next start from its journal', async () => {
    const store = memoryStorage();
    vi.stubGlobal('localStorage', store);
    const cache = await freshCache();
    // The browser died after the old keys were removed and one new key was
    // written: what is left is the journal and half an import.
    store.map.set(
      'softn-web:restore:abc',
      JSON.stringify({
        prefixes: [`xdb:${ORIGIN}:`, `softn:${ORIGIN}:`],
        previous: [
          [`xdb:${ORIGIN}:notes`, 'old'],
          [`softn:${ORIGIN}:old-save`, 'old'],
        ],
        at: 1,
      })
    );
    store.map.set(`xdb:${ORIGIN}:notes`, 'new');
    store.map.set(`xdb:${OTHER}:notes`, 'untouched');

    expect(cache.recoverInterruptedImports()).toBe(1);
    expect(store.map.get(`xdb:${ORIGIN}:notes`)).toBe('old');
    expect(store.map.get(`softn:${ORIGIN}:old-save`)).toBe('old');
    expect(store.map.get(`xdb:${OTHER}:notes`)).toBe('untouched');
    expect(store.map.has('softn-web:restore:abc')).toBe(false);
    expect(cache.recoverInterruptedImports()).toBe(0);
  });
});
