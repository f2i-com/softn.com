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
    openDB.mockRejectedValueOnce(failure('AbortError')).mockResolvedValue(fakeDb([{ id: 'a', lastOpened: 1 }]));
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
    openDB.mockImplementation(async (_name: string, _version: number, opts: { terminated?: () => void }) => {
      options = opts;
      return fakeDb();
    });
    const cache = await freshCache();
    await cache.getCachedApps();
    options?.terminated?.();
    await cache.getCachedApps();
    expect(openDB).toHaveBeenCalledTimes(2);
  });
});
