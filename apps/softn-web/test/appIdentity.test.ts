/**
 * Identity, adoption and data transfer in the app cache.
 *
 * Pinned here, against an in-memory IndexedDB and localStorage:
 *
 * - A name is not migration authority. A pre-identity record is adopted only
 *   by the bytes it holds; different bytes under the same name get their own
 *   record, no data and no grants, and the old record keeps everything.
 * - Identity is the whole digest. A record keyed by the sixteen-character
 *   digest earlier versions kept is recognised by hashing its bytes, and
 *   carries its data and its grants across.
 * - Copying saves between builds is whole or not at all: a failure part way
 *   through leaves the destination as it was and says so.
 * - An identity computed without a secure context remembers no grant.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── An in-memory stand-in for the slice of `idb` the cache uses ──────────

interface Row {
  id: string;
  name: string;
  origin?: string;
  bundleData: Uint8Array;
  [k: string]: unknown;
}

function fakeIdb(rows: Row[] = []) {
  const table = new Map<string, Row>(rows.map((r) => [r.id, structuredClone(r)]));
  const byIndex = (index: string, key: string) => {
    const field = index === 'by-name' ? 'name' : 'origin';
    return [...table.values()].filter((r) => r[field] === key).map((r) => structuredClone(r));
  };
  const store = {
    get: async (id: string) => (table.has(id) ? structuredClone(table.get(id)!) : undefined),
    put: async (row: Row) => {
      table.set(row.id, structuredClone(row));
      return row.id;
    },
    add: async (row: Row) => {
      if (table.has(row.id)) throw new Error('ConstraintError');
      table.set(row.id, structuredClone(row));
      return row.id;
    },
    delete: async (id: string) => {
      table.delete(id);
    },
    index: (name: string) => ({
      get: async (key: string) => byIndex(name, key)[0],
      getAll: async (key: string) => byIndex(name, key),
    }),
  };
  const db = {
    getAll: async () => [...table.values()].map((r) => structuredClone(r)),
    get: store.get,
    put: store.put,
    delete: store.delete,
    getFromIndex: async (_s: string, index: string, key: string) => byIndex(index, key)[0],
    getAllFromIndex: async (_s: string, index: string, key: string) => byIndex(index, key),
    transaction: () => ({ objectStore: () => store, done: Promise.resolve() }),
    close: () => {},
  };
  return { db, table };
}

const openDB = vi.fn();
vi.mock('idb', () => ({ openDB: (...args: unknown[]) => openDB(...args) }));

/** A localStorage that can be told to refuse the Nth write from now. */
function fakeLocalStorage() {
  const map = new Map<string, string>();
  let writesUntilFailure = Infinity;
  const api = {
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => {
      writesUntilFailure -= 1;
      if (writesUntilFailure < 0) {
        const err = new Error('QuotaExceededError');
        err.name = 'QuotaExceededError';
        throw err;
      }
      map.set(k, String(v));
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
    clear: () => map.clear(),
    snapshot: () => Object.fromEntries([...map.entries()].sort()),
    /** Accept `n` more writes, then throw QuotaExceededError on every write after. */
    failAfterWrites: (n: number) => {
      writesUntilFailure = n;
    },
  };
  return api;
}

type Cache = typeof import('../src/lib/appCache');
async function freshCache(): Promise<Cache> {
  vi.resetModules();
  return import('../src/lib/appCache');
}

const bytes = (text: string) => new TextEncoder().encode(text);
const manifest = (name: string, version = '1.0.0') => ({ name, version });

beforeEach(() => {
  openDB.mockReset();
  vi.stubGlobal('indexedDB', {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('computeAppOrigin', () => {
  it('is the whole SHA-256 of the bytes, and the same for the same bytes', async () => {
    const { computeAppOrigin, isSecureAppOrigin, abbreviateOrigin } = await freshCache();
    const a = await computeAppOrigin(bytes('hello'));
    const b = await computeAppOrigin(bytes('hello'));
    const c = await computeAppOrigin(bytes('hellp'));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(b);
    expect(c).not.toBe(a);
    expect(isSecureAppOrigin(a)).toBe(true);
    expect(abbreviateOrigin(a)).toBe(a.slice(0, 12));
  });

  it('hashes the view, not the buffer behind it', async () => {
    const { computeAppOrigin } = await freshCache();
    const whole = bytes('xxhelloxx');
    const view = whole.subarray(2, 7);
    expect(await computeAppOrigin(view)).toBe(await computeAppOrigin(bytes('hello')));
  });

  it('marks an identity computed without crypto.subtle as insecure', async () => {
    const realCrypto = globalThis.crypto;
    vi.stubGlobal('crypto', { randomUUID: () => realCrypto.randomUUID() });
    const { computeAppOrigin, isSecureAppOrigin } = await freshCache();
    const origin = await computeAppOrigin(bytes('hello'));
    expect(origin.startsWith('insecure-')).toBe(true);
    expect(isSecureAppOrigin(origin)).toBe(false);
    expect(await computeAppOrigin(bytes('hello'))).toBe(origin);
  });
});

describe('adopting a pre-identity record', () => {
  it('goes to the same bytes, with their data, without their grants', async () => {
    const legacyBytes = bytes('the real notes');
    const { db, table } = fakeIdb([
      { id: 'legacy', name: 'Notes', bundleData: legacyBytes, version: '1.0.0', cachedAt: 1, lastOpened: 1, grantedPermissions: { net: true }, permissionsPromptedAt: 1 },
    ]);
    openDB.mockResolvedValue(db);
    const ls = fakeLocalStorage();
    ls.setItem('xdb:Notes:notes', '[{"id":1}]');
    vi.stubGlobal('localStorage', ls);

    const cache = await freshCache();
    const origin = await cache.computeAppOrigin(legacyBytes);
    const record = await cache.cacheApp(legacyBytes, manifest('Notes', '1.0.0'));

    expect(record?.id).toBe('legacy');
    expect(record?.origin).toBe(origin);
    expect(record?.grantedPermissions).toBeUndefined();
    expect(record?.permissionsPromptedAt).toBeUndefined();
    expect(table.size).toBe(1);
    expect(ls.snapshot()).toEqual({ [`xdb:${origin}:notes`]: '[{"id":1}]' });
  });

  it('is refused to different bytes under the same name, which get a record of their own', async () => {
    const legacyBytes = bytes('the real notes');
    const impostorBytes = bytes('something else calling itself notes');
    const { db, table } = fakeIdb([
      { id: 'legacy', name: 'Notes', bundleData: legacyBytes, version: '1.0.0', cachedAt: 1, lastOpened: 1, grantedPermissions: { net: true }, permissionsPromptedAt: 1 },
    ]);
    openDB.mockResolvedValue(db);
    const ls = fakeLocalStorage();
    ls.setItem('xdb:Notes:notes', '[{"id":1}]');
    vi.stubGlobal('localStorage', ls);

    const cache = await freshCache();
    const legacyOrigin = await cache.computeAppOrigin(legacyBytes);
    const impostorOrigin = await cache.computeAppOrigin(impostorBytes);
    const record = await cache.cacheApp(impostorBytes, manifest('Notes', '1.0.0'));

    // The newcomer: its own record, no data, no grants.
    expect(record?.id).not.toBe('legacy');
    expect(record?.origin).toBe(impostorOrigin);
    expect(record?.grantedPermissions).toBeUndefined();
    expect(cache.hasStoredData(impostorOrigin)).toBe(false);

    // The legacy record: still here, now under its own digest, data moved with it, grants dropped.
    expect(table.size).toBe(2);
    const legacy = table.get('legacy')!;
    expect(legacy.origin).toBe(legacyOrigin);
    expect(legacy.grantedPermissions).toBeUndefined();
    expect(ls.snapshot()).toEqual({ [`xdb:${legacyOrigin}:notes`]: '[{"id":1}]' });

    // And the real bytes, arriving later, find their record by identity.
    const real = await cache.cacheApp(legacyBytes, manifest('Notes', '1.0.0'));
    expect(real?.id).toBe('legacy');
    expect(table.size).toBe(2);
  });

  it('leaves the original data recoverable when the move fails part way', async () => {
    const legacyBytes = bytes('the real notes');
    const { db, table } = fakeIdb([{ id: 'legacy', name: 'Notes', bundleData: legacyBytes, version: '1.0.0', cachedAt: 1, lastOpened: 1 }]);
    openDB.mockResolvedValue(db);
    const ls = fakeLocalStorage();
    ls.setItem('xdb:Notes:a', '1');
    ls.setItem('xdb:Notes:b', '2');
    vi.stubGlobal('localStorage', ls);

    const cache = await freshCache();
    const origin = await cache.computeAppOrigin(legacyBytes);
    // The first write of the migration lands; the second is refused.
    ls.failAfterWrites(1);
    const record = await cache.cacheApp(legacyBytes, manifest('Notes', '1.0.0'));

    // The bundle still opens, as a record of its own; the legacy one is untouched
    // and will be tried again next time, when there may be room.
    expect(record).not.toBeNull();
    expect(record?.id).not.toBe('legacy');
    expect(table.get('legacy')!.origin).toBeUndefined();
    expect(ls.getItem('xdb:Notes:a')).toBe('1');
    expect(ls.getItem('xdb:Notes:b')).toBe('2');
    // Nothing partial under the new identity.
    expect(ls.getItem(`xdb:${origin}:a`)).toBeNull();
    expect(cache.hasStoredData(origin)).toBe(false);
  });
});

describe('a record keyed by the truncated digest', () => {
  it('is recognised by its bytes and carries its data and its grants across', async () => {
    const appBytes = bytes('an app cached last month');
    const cache0 = await freshCache();
    const full = await cache0.computeAppOrigin(appBytes);
    const short = full.slice(0, 16);
    const { db, table } = fakeIdb([
      { id: 'old', name: 'Pocket', origin: short, bundleData: appBytes, version: '2.0.0', cachedAt: 1, lastOpened: 1, grantedPermissions: { files: true }, permissionsPromptedAt: 5 },
    ]);
    openDB.mockResolvedValue(db);
    const ls = fakeLocalStorage();
    ls.setItem(`xdb:${short}:saves`, '[1,2,3]');
    vi.stubGlobal('localStorage', ls);

    const cache = await freshCache();
    const record = await cache.cacheApp(appBytes, manifest('Pocket', '2.0.0'));
    expect(record?.id).toBe('old');
    expect(record?.origin).toBe(full);
    expect(record?.grantedPermissions).toEqual({ files: true });
    expect(record?.permissionsPromptedAt).toBe(5);
    expect(table.size).toBe(1);
    expect(ls.snapshot()).toEqual({ [`xdb:${full}:saves`]: '[1,2,3]' });
    expect((await cache.getCachedAppByOrigin(full))?.id).toBe('old');
  });

  it('is not claimed by other bytes that merely share the prefix', async () => {
    const appBytes = bytes('an app cached last month');
    const cache0 = await freshCache();
    const full = await cache0.computeAppOrigin(appBytes);
    const short = full.slice(0, 16);
    const other = bytes('different bytes');
    const { db, table } = fakeIdb([{ id: 'old', name: 'Pocket', origin: short, bundleData: other, version: '2.0.0', cachedAt: 1, lastOpened: 1, grantedPermissions: { files: true } }]);
    openDB.mockResolvedValue(db);
    vi.stubGlobal('localStorage', fakeLocalStorage());

    const cache = await freshCache();
    const record = await cache.cacheApp(appBytes, manifest('Pocket', '2.0.0'));
    expect(record?.id).not.toBe('old');
    expect(record?.grantedPermissions).toBeUndefined();
    expect(table.get('old')!.origin).toBe(short);
    expect(table.size).toBe(2);
  });
});

describe('copyAppData', () => {
  it('copies every key, or none, and says which', async () => {
    const ls = fakeLocalStorage();
    ls.setItem('xdb:from:a', '1');
    ls.setItem('xdb:from:b', '2');
    ls.setItem('xdb:from:c', '3');
    ls.setItem('xdb:to:existing', 'keep');
    vi.stubGlobal('localStorage', ls);
    const { copyAppData } = await freshCache();

    const ok = copyAppData('from', 'to');
    expect(ok).toEqual({ ok: true, copied: 3, total: 3, skipped: 0 });
    expect(ls.snapshot()).toEqual({
      'xdb:from:a': '1',
      'xdb:from:b': '2',
      'xdb:from:c': '3',
      'xdb:to:a': '1',
      'xdb:to:b': '2',
      'xdb:to:c': '3',
      'xdb:to:existing': 'keep',
    });
  });

  it('keeps what the destination already has', async () => {
    const ls = fakeLocalStorage();
    ls.setItem('xdb:from:a', 'theirs');
    ls.setItem('xdb:from:b', '2');
    ls.setItem('xdb:to:a', 'mine');
    vi.stubGlobal('localStorage', ls);
    const { copyAppData } = await freshCache();
    expect(copyAppData('from', 'to')).toEqual({ ok: true, copied: 1, total: 2, skipped: 1 });
    expect(ls.getItem('xdb:to:a')).toBe('mine');
    expect(ls.getItem('xdb:to:b')).toBe('2');
  });

  it('restores the destination when a write part way through fails', async () => {
    const ls = fakeLocalStorage();
    ls.setItem('xdb:from:a', '1');
    ls.setItem('xdb:from:b', '2');
    ls.setItem('xdb:from:c', '3');
    ls.setItem('xdb:to:b', 'older');
    vi.stubGlobal('localStorage', ls);
    const { copyAppData, transferStorageKeys } = await freshCache();

    // `a` writes, `b` is kept, `c` is refused.
    ls.failAfterWrites(1);
    const result = copyAppData('from', 'to');
    expect(result.ok).toBe(false);
    expect(result.copied).toBe(0);
    expect(result.total).toBe(3);
    expect(result.error).toMatch(/QuotaExceeded/);
    // Destination exactly as before: its own `b`, and none of the source's.
    expect(ls.snapshot()).toEqual({ 'xdb:from:a': '1', 'xdb:from:b': '2', 'xdb:from:c': '3', 'xdb:to:b': 'older' });

    // A move that fails is a copy that failed: the source is intact too.
    ls.failAfterWrites(1);
    const moved = transferStorageKeys('xdb:from:', 'xdb:to:', { move: true, overwrite: true });
    expect(moved.ok).toBe(false);
    expect(ls.snapshot()).toEqual({ 'xdb:from:a': '1', 'xdb:from:b': '2', 'xdb:from:c': '3', 'xdb:to:b': 'older' });
  });

  it('refuses a copy onto itself or from nothing', async () => {
    vi.stubGlobal('localStorage', fakeLocalStorage());
    const { copyAppData } = await freshCache();
    expect(copyAppData('same', 'same').ok).toBe(false);
    expect(copyAppData('', 'to').ok).toBe(false);
  });
});

describe('recordPermissionGrant', () => {
  it('writes nothing for an identity computed without a secure context', async () => {
    const { db, table } = fakeIdb([{ id: 'x', name: 'App', origin: 'insecure-0123456789abcdef', bundleData: bytes('x'), version: '1', cachedAt: 1, lastOpened: 1 }]);
    openDB.mockResolvedValue(db);
    const { recordPermissionGrant } = await freshCache();
    expect(await recordPermissionGrant('insecure-0123456789abcdef', { net: true })).toBe(false);
    expect(table.get('x')!.grantedPermissions).toBeUndefined();
  });

  it('records a grant against a secure identity', async () => {
    const origin = 'a'.repeat(64);
    const { db, table } = fakeIdb([{ id: 'x', name: 'App', origin, bundleData: bytes('x'), version: '1', cachedAt: 1, lastOpened: 1 }]);
    openDB.mockResolvedValue(db);
    const { recordPermissionGrant } = await freshCache();
    expect(await recordPermissionGrant(origin, { net: true })).toBe(true);
    expect(table.get('x')!.grantedPermissions).toEqual({ net: true });
  });
});

describe('getCachedAppByName', () => {
  it('returns the most recently opened of several with one name', async () => {
    const { db } = fakeIdb([
      { id: 'older', name: 'Notes', origin: 'a', bundleData: bytes('a'), version: '1', cachedAt: 1, lastOpened: 10 },
      { id: 'newer', name: 'Notes', origin: 'b', bundleData: bytes('b'), version: '2', cachedAt: 2, lastOpened: 20 },
    ]);
    openDB.mockResolvedValue(db);
    const { getCachedAppByName } = await freshCache();
    expect((await getCachedAppByName('Notes'))?.id).toBe('newer');
    expect(await getCachedAppByName('Nope')).toBeNull();
  });
});
