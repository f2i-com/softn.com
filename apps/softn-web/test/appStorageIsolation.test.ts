/**
 * Cross-app storage isolation in the runtime (QA-02 in the audit).
 *
 * An app's saved state lives in localStorage under prefixes keyed by its
 * identity, and identity is the SHA-256 of the bundle's bytes — not the
 * name the bundle gives itself. So two bundles that both call themselves
 * "Notes" are two apps: each has its own record in the cache, its own
 * prefixes, its own data, its own consent. Pinned here, against the same
 * in-memory IndexedDB and localStorage stand-ins appIdentity.test.ts uses:
 *
 * - Same name, different bytes: different origins, different prefixes,
 *   neither sees the other's keys, an export of one carries none of the
 *   other's, and removing one's data leaves the other's.
 * - A grant recorded for one is not a grant for the other.
 * - Data crosses identities only by an explicit copy, whole or not at all.
 * - The launcher's reading of a declaration cannot widen it: a manifest's
 *   legacy `permissions` flags map to `net`/`files` and nothing more, an
 *   empty permission.json beats those flags, and the withheld config the
 *   app runs with under the consent bar names no capability.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { extractPermissions, requestedCapabilities, withheldPermissions, type BundleManifest } from '../src/lib/bundleProcessor';

// ── The slice of `idb` the cache uses, in memory ────────────────────────

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

function fakeLocalStorage() {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => {
      map.set(k, String(v));
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
    clear: () => map.clear(),
    snapshot: () => Object.fromEntries([...map.entries()].sort()),
  };
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

describe('two bundles with the same name and different bytes', () => {
  const notesA = bytes('PK notes, the first');
  const notesB = bytes('PK notes, another app entirely');

  it('are two apps: different identities, records and storage prefixes', async () => {
    const { db, table } = fakeIdb();
    openDB.mockResolvedValue(db);
    vi.stubGlobal('localStorage', fakeLocalStorage());
    const cache = await freshCache();

    const a = await cache.cacheApp(notesA, manifest('Notes'));
    const b = await cache.cacheApp(notesB, manifest('Notes'));
    expect(a && b).toBeTruthy();
    expect(a!.origin).toMatch(/^[0-9a-f]{64}$/);
    expect(b!.origin).toMatch(/^[0-9a-f]{64}$/);
    expect(a!.origin).not.toBe(b!.origin);
    expect(a!.id).not.toBe(b!.id);
    expect(table.size).toBe(2);

    const prefixesA = cache.appDataStores(a!.origin!).map((s) => s.prefix);
    const prefixesB = cache.appDataStores(b!.origin!).map((s) => s.prefix);
    expect(prefixesA).toHaveLength(2);
    for (const pa of prefixesA) for (const pb of prefixesB) {
      expect(pa).not.toBe(pb);
      expect(pa.startsWith(pb)).toBe(false);
      expect(pb.startsWith(pa)).toBe(false);
    }
    // The name is in neither prefix: nothing keyed by "Notes" is shared.
    for (const p of [...prefixesA, ...prefixesB]) expect(p).not.toContain('Notes');
  });

  it('do not see, export or remove each other\'s data', async () => {
    const { db } = fakeIdb();
    openDB.mockResolvedValue(db);
    const ls = fakeLocalStorage();
    vi.stubGlobal('localStorage', ls);
    const cache = await freshCache();
    const a = (await cache.cacheApp(notesA, manifest('Notes')))!;
    const b = (await cache.cacheApp(notesB, manifest('Notes')))!;

    // A saves; B saves something else under the same key names.
    for (const { prefix } of cache.appDataStores(a.origin!)) ls.setItem(`${prefix}notes`, '["A"]');
    for (const { prefix } of cache.appDataStores(b.origin!)) ls.setItem(`${prefix}notes`, '["B"]');
    expect(cache.hasStoredData(a.origin)).toBe(true);
    expect(cache.hasStoredData(b.origin)).toBe(true);

    // Each export holds its own keys and none of the other's values.
    const exportA = cache.exportAppData(a)!;
    const exportB = cache.exportAppData(b)!;
    expect(exportA.app.origin).toBe(a.origin);
    expect(exportA.stores).toEqual({ xdb: { notes: '["A"]' }, local: { notes: '["A"]' } });
    expect(exportB.app.origin).toBe(b.origin);
    expect(exportB.stores).toEqual({ xdb: { notes: '["B"]' }, local: { notes: '["B"]' } });
    expect(JSON.stringify(exportA)).not.toContain(b.origin);
    expect(JSON.stringify(exportB)).not.toContain(a.origin);
    expect(cache.snapshotEntryCount(exportA)).toBe(2);

    // Removing A's data leaves B's exactly as it was.
    const before = ls.snapshot();
    const removed = cache.removeAppData(a.origin);
    expect(removed).toBe(2);
    expect(cache.hasStoredData(a.origin)).toBe(false);
    expect(cache.hasStoredData(b.origin)).toBe(true);
    const after = ls.snapshot();
    for (const { prefix } of cache.appDataStores(b.origin!)) expect(after[`${prefix}notes`]).toBe(before[`${prefix}notes`]);
  });

  it('carry their own consent: a grant for one is nothing for the other', async () => {
    const { db, table } = fakeIdb();
    openDB.mockResolvedValue(db);
    vi.stubGlobal('localStorage', fakeLocalStorage());
    const cache = await freshCache();
    const a = (await cache.cacheApp(notesA, manifest('Notes')))!;
    const b = (await cache.cacheApp(notesB, manifest('Notes')))!;

    expect(await cache.recordPermissionGrant(a.origin!, { net: true })).toBe(true);
    expect(table.get(a.id)!.grantedPermissions).toEqual({ net: true });
    expect(table.get(b.id)!.grantedPermissions).toBeUndefined();
    const byName = await cache.getCachedAppByName('Notes');
    // Looking an app up by its name is a label, never the basis of a grant.
    expect(byName === null || (await cache.getCachedAppByOrigin(b.origin!))!.grantedPermissions === undefined).toBe(true);
  });

  it('share data only through an explicit copy, which is whole or not at all', async () => {
    const { db } = fakeIdb();
    openDB.mockResolvedValue(db);
    const ls = fakeLocalStorage();
    vi.stubGlobal('localStorage', ls);
    const cache = await freshCache();
    const a = (await cache.cacheApp(notesA, manifest('Notes')))!;
    const b = (await cache.cacheApp(notesB, manifest('Notes')))!;
    for (const { prefix } of cache.appDataStores(a.origin!)) ls.setItem(`${prefix}notes`, '["A"]');

    expect(cache.hasStoredData(b.origin)).toBe(false);
    const result = cache.copyAppData(a.origin!, b.origin!);
    expect(result.copied).toBe(2);
    expect(cache.hasStoredData(b.origin)).toBe(true);
    // A copy, not a move: the source keeps its data.
    expect(cache.hasStoredData(a.origin)).toBe(true);
    for (const { prefix } of cache.appDataStores(b.origin!)) expect(ls.getItem(`${prefix}notes`)).toBe('["A"]');
  });
});

describe("the launcher's reading of a declaration cannot widen it", () => {
  const base = { name: 'T', version: '1.0.0', main: 'ui/main.ui' } as unknown as BundleManifest;
  const files = (permissionJson?: string) => {
    const m = new Map<string, string>();
    if (permissionJson !== undefined) m.set('permission.json', permissionJson);
    return m;
  };

  it('maps the legacy manifest flags to net and files only, and only when set', () => {
    const legacy = { ...base, permissions: { network: true, filesystem: false, camera: true, mic: true } } as unknown as BundleManifest;
    const config = extractPermissions(files(), legacy);
    expect(config).not.toBeNull();
    expect(requestedCapabilities(config!)).toEqual(['net']);
  });

  it('an empty permission.json beats the manifest flags', () => {
    const legacy = { ...base, permissions: { network: true, filesystem: true } } as unknown as BundleManifest;
    const config = extractPermissions(files('{"permissions":{}}'), legacy);
    expect(requestedCapabilities(config!)).toEqual([]);
  });

  it('a permission.json that does not parse requests nothing rather than everything', () => {
    const legacy = { ...base, permissions: { network: true } } as unknown as BundleManifest;
    const config = extractPermissions(files('{"permissions": {"net": {"enabled": true},}'), legacy);
    expect(config).not.toBeNull();
    expect(requestedCapabilities(config!)).toEqual([]);
  });

  it('the withheld config the app runs with under the consent bar names no capability', () => {
    const declared = extractPermissions(files(JSON.stringify({ permissions: { net: { enabled: true }, camera: { enabled: true } } })), base)!;
    expect(requestedCapabilities(declared)).toEqual(['net', 'camera']);
    const withheld = withheldPermissions(declared);
    expect(requestedCapabilities(withheld)).toEqual([]);
    expect(withheld.consentPending).toBe(true);
    expect(Object.isFrozen(withheld.permissions)).toBe(true);
    // And withholding does not alter the declaration it was made from.
    expect(requestedCapabilities(declared)).toEqual(['net', 'camera']);
  });
});
