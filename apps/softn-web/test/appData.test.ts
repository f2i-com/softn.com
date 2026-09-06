/**
 * A build's records as a file, and back.
 *
 * Pinned: an export holds exactly the build's keys and names the build; a
 * file that is not an export, or is from a newer format, or is corrupt, is
 * refused by name and touches nothing; an import replaces the build's data
 * whole, and one that fails part way leaves what was there; a file from a
 * different build is refused until the person importing it says so.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('idb', () => ({ openDB: vi.fn() }));

/**
 * A localStorage with a quota the way a browser has one: a write that would
 * take the total past it throws, and removing keys makes room again. That
 * second half is what a rollback depends on.
 */
function fakeLocalStorage() {
  const map = new Map<string, string>();
  let quotaBytes = Infinity;
  const bytes = () => [...map.entries()].reduce((n, [k, v]) => n + k.length + v.length, 0);
  return {
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => {
      const value = String(v);
      const after = bytes() - (map.has(k) ? k.length + map.get(k)!.length : 0) + k.length + value.length;
      if (after > quotaBytes) {
        const err = new Error('QuotaExceededError');
        err.name = 'QuotaExceededError';
        throw err;
      }
      map.set(k, value);
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
    clear: () => map.clear(),
    snapshot: () => Object.fromEntries([...map.entries()].sort()),
    bytes,
    quota: (n: number) => {
      quotaBytes = n;
    },
  };
}

type Cache = typeof import('../src/lib/appCache');
async function fresh(): Promise<Cache> {
  vi.resetModules();
  return import('../src/lib/appCache');
}

const origin = 'a'.repeat(64);
const app = { name: 'Notes', version: '1.2.0', origin };

let ls: ReturnType<typeof fakeLocalStorage>;

beforeEach(() => {
  ls = fakeLocalStorage();
  vi.stubGlobal('localStorage', ls);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('exportAppData', () => {
  it('holds exactly the build\'s keys, with the prefix removed, and names the build', async () => {
    const { exportAppData } = await fresh();
    ls.setItem(`xdb:${origin}:notes`, '[{"id":1}]');
    ls.setItem(`xdb:${origin}:settings`, '{"theme":"dark"}');
    ls.setItem('xdb:someone-else:notes', 'not mine');
    ls.setItem('softn.web.chromeHidden', '1');
    const snapshot = exportAppData(app, 1234)!;
    expect(snapshot).toEqual({
      format: 'softn-app-data',
      version: 1,
      app: { name: 'Notes', version: '1.2.0', origin },
      exportedAt: 1234,
      entries: { notes: '[{"id":1}]', settings: '{"theme":"dark"}' },
    });
  });

  it('is null for a build with no identity', async () => {
    const { exportAppData } = await fresh();
    expect(exportAppData({ name: 'Notes', version: '1', origin: undefined })).toBeNull();
  });
});

describe('readAppDataSnapshot', () => {
  it('reads back what exportAppData wrote', async () => {
    const { exportAppData, readAppDataSnapshot } = await fresh();
    ls.setItem(`xdb:${origin}:notes`, '[1]');
    const text = JSON.stringify(exportAppData(app));
    const read = readAppDataSnapshot(text);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.snapshot.entries).toEqual({ notes: '[1]' });
  });

  it('refuses, by name, everything that is not a readable export', async () => {
    const { readAppDataSnapshot } = await fresh();
    const cases: Array<[string, RegExp]> = [
      ['{not json', /not JSON/],
      ['[]', /does not hold/],
      ['"text"', /does not hold/],
      [JSON.stringify({ format: 'something-else', version: 1 }), /not a SoftN data export/],
      [JSON.stringify({ format: 'softn-app-data' }), /which format/],
      [JSON.stringify({ format: 'softn-app-data', version: 2, app, entries: {} }), /newer runtime/],
      [JSON.stringify({ format: 'softn-app-data', version: 0, app, entries: {} }), /not one this runtime reads/],
      [JSON.stringify({ format: 'softn-app-data', version: 1, entries: {} }), /which app/],
      [JSON.stringify({ format: 'softn-app-data', version: 1, app: { name: 'N', version: '1', origin: '' }, entries: {} }), /which app/],
      [JSON.stringify({ format: 'softn-app-data', version: 1, app }), /holds no records/],
      [JSON.stringify({ format: 'softn-app-data', version: 1, app, entries: [] }), /holds no records/],
      [JSON.stringify({ format: 'softn-app-data', version: 1, app, entries: { notes: 42 } }), /not stored text/],
      [JSON.stringify({ format: 'softn-app-data', version: 1, app, entries: { '': 'x' } }), /unusable name/],
    ];
    for (const [text, why] of cases) {
      const read = readAppDataSnapshot(text);
      expect(read.ok, text).toBe(false);
      if (!read.ok) expect(read.error, text).toMatch(why);
    }
  });
});

describe('importAppData', () => {
  it('replaces the build\'s data with the file\'s, whole', async () => {
    const { importAppData } = await fresh();
    ls.setItem(`xdb:${origin}:notes`, 'old');
    ls.setItem(`xdb:${origin}:stale`, 'gone after import');
    ls.setItem('xdb:other:notes', 'untouched');
    const result = importAppData({ format: 'softn-app-data', version: 1, app, exportedAt: 0, entries: { notes: 'new', settings: '{}' } }, app);
    expect(result).toEqual({ ok: true, copied: 2, total: 2, skipped: 0 });
    expect(ls.snapshot()).toEqual({ 'xdb:other:notes': 'untouched', [`xdb:${origin}:notes`]: 'new', [`xdb:${origin}:settings`]: '{}' });
  });

  it('leaves the build\'s data as it was when a write fails part way', async () => {
    const { importAppData } = await fresh();
    ls.setItem(`xdb:${origin}:notes`, 'old');
    ls.setItem(`xdb:${origin}:settings`, 'old settings');
    // Room for the old data and a little more: the import's first two keys
    // fit, the third does not.
    ls.quota(ls.bytes() + 20);
    const result = importAppData({ format: 'softn-app-data', version: 1, app, exportedAt: 0, entries: { notes: 'new', settings: 'new', extra: 'new' } }, app);
    expect(result.ok).toBe(false);
    expect(result.copied).toBe(0);
    expect(result.error).toMatch(/QuotaExceeded/);
    // What was written is gone and what was there is back.
    expect(ls.snapshot()).toEqual({ [`xdb:${origin}:notes`]: 'old', [`xdb:${origin}:settings`]: 'old settings' });
  });

  it('refuses a file from a different build unless told the person knows', async () => {
    const { importAppData } = await fresh();
    ls.setItem(`xdb:${origin}:notes`, 'mine');
    const foreign = { format: 'softn-app-data' as const, version: 1 as const, app: { name: 'Notes', version: '2.0.0', origin: 'b'.repeat(64) }, exportedAt: 0, entries: { notes: 'theirs' } };
    const refused = importAppData(foreign, app);
    expect(refused.ok).toBe(false);
    expect(refused.code).toBe('DIFFERENT_APP');
    expect(refused.error).toMatch(/v2\.0\.0/);
    expect(ls.getItem(`xdb:${origin}:notes`)).toBe('mine');
    const allowed = importAppData(foreign, app, { allowDifferentApp: true });
    expect(allowed.ok).toBe(true);
    expect(ls.getItem(`xdb:${origin}:notes`)).toBe('theirs');
  });

  it('refuses a build with no identity', async () => {
    const { importAppData } = await fresh();
    const result = importAppData({ format: 'softn-app-data', version: 1, app, exportedAt: 0, entries: { notes: 'x' } }, { origin: undefined });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('NO_IDENTITY');
  });

  it('round-trips: export, wipe, import, same data', async () => {
    const { exportAppData, readAppDataSnapshot, importAppData, removeAppData } = await fresh();
    ls.setItem(`xdb:${origin}:notes`, '[{"id":1,"text":"hello"}]');
    ls.setItem(`xdb:${origin}:tags`, '["a","b"]');
    const before = ls.snapshot();
    const file = JSON.stringify(exportAppData(app));
    expect(removeAppData(origin)).toBe(2);
    expect(ls.snapshot()).toEqual({});
    const read = readAppDataSnapshot(file);
    expect(read.ok).toBe(true);
    if (read.ok) expect(importAppData(read.snapshot, app).ok).toBe(true);
    expect(ls.snapshot()).toEqual(before);
  });
});
