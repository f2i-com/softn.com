/**
 * `query`'s paging options (audit round 4). `offset` and `limit` went straight
 * to `Array.prototype.slice`, which reads a negative number from the end and
 * null as 0: `offset: -2` answered the last two records, `limit: -1` all but
 * the last, and `limit: null` (what a caller passes for "no limit") nothing.
 * They now mean what the desktop's SQLite makes of them: an offset below 0 is
 * none, a limit below 0 is none, and null (or a value that is not a number at
 * all) is an option not given.
 */
import { describe, expect, it } from 'vitest';
import { XDBService } from '../src/runtime/xdb';
import type { XDBQueryOptions } from '../src/runtime/xdb-types';

function memoryStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
}

function storeOfFive(): XDBService {
  const xdb = new XDBService(memoryStorage(), 'r4-paging', undefined, { backend: 'storage' });
  for (const n of [1, 2, 3, 4, 5]) xdb.create('items', { n });
  return xdb;
}

const ns = (xdb: XDBService, options: unknown) =>
  xdb.query('items', options as XDBQueryOptions).map((r) => (r.data as { n: number }).n);

describe('query paging', () => {
  it('reads an offset below 0 as none, not as a count from the end', () => {
    const xdb = storeOfFive();
    expect(ns(xdb, { offset: -2 })).toEqual([1, 2, 3, 4, 5]);
    expect(ns(xdb, { offset: -2, limit: 2 })).toEqual([1, 2]);
  });

  it('reads a limit below 0 as no limit, as SQLite does, not as records to leave off the end', () => {
    const xdb = storeOfFive();
    expect(ns(xdb, { limit: -1 })).toEqual([1, 2, 3, 4, 5]);
    expect(ns(xdb, { offset: 3, limit: -1 })).toEqual([4, 5]);
  });

  it('reads null (or anything that is not a number) as an option not given', () => {
    const xdb = storeOfFive();
    expect(ns(xdb, { limit: null })).toEqual([1, 2, 3, 4, 5]);
    expect(ns(xdb, { offset: null, limit: 2 })).toEqual([1, 2]);
    expect(ns(xdb, { limit: Number.NaN })).toEqual([1, 2, 3, 4, 5]);
    // Text that is a number is still that number, as slice read it.
    expect(ns(xdb, { limit: '2' })).toEqual([1, 2]);
  });

  it('pages as before with counts of 0 and more', () => {
    const xdb = storeOfFive();
    expect(ns(xdb, { offset: 1, limit: 2 })).toEqual([2, 3]);
    expect(ns(xdb, { limit: 0 })).toEqual([]);
    expect(ns(xdb, { offset: 4 })).toEqual([5]);
    expect(ns(xdb, { offset: 9 })).toEqual([]);
    expect(ns(xdb, { limit: Infinity })).toEqual([1, 2, 3, 4, 5]);
  });
});
