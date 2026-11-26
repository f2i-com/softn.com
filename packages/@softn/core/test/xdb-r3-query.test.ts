/**
 * What `query` answers (audit round 3).
 */
import { describe, expect, it } from 'vitest';
import { XDBService } from '../src/runtime/xdb';

function memoryStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
}

function storeWith(values: unknown[]): XDBService {
  const xdb = new XDBService(memoryStorage(), 'r3-query', undefined, { backend: 'storage' });
  for (const p of values) xdb.create('items', p === undefined ? {} : { p });
  return xdb;
}

const sorted = (xdb: XDBService, order: 'asc' | 'desc') =>
  xdb.query('items', { sort: { field: 'p', order } }).map((r) => (r.data as { p?: unknown }).p);

describe('query sorted by a field that holds values of more than one type', () => {
  // `a < b` between a number and a word is false both ways, so the comparison
  // said each was after the other: a list whose field held numbers for some
  // records and text for others (a price typed in one form and imported as
  // text from another) came back in the order it was stored, not sorted at all.
  it('orders numbers, then text, each in order, whatever order the records were stored in', () => {
    const inputs: unknown[][] = [
      [3, 'b', 1, 'a', 2, 'c'],
      ['c', 2, 'a', 1, 'b', 3],
      [1, 'a', 2, 'b', 3, 'c'],
      ['a', 'b', 'c', 3, 2, 1],
    ];
    for (const values of inputs) {
      const xdb = storeWith(values);
      expect(sorted(xdb, 'asc')).toEqual([1, 2, 3, 'a', 'b', 'c']);
      expect(sorted(xdb, 'desc')).toEqual(['c', 'b', 'a', 3, 2, 1]);
    }
  });

  it('keeps records without the field last, in either order, and true or false and lists in a fixed place', () => {
    const xdb = storeWith([true, 'x', undefined, [2], 5, null, false, { k: 1 }, [1]]);
    expect(sorted(xdb, 'asc')).toEqual([5, 'x', { k: 1 }, [1], [2], false, true, undefined, null]);
    expect(sorted(xdb, 'desc')).toEqual([true, false, [2], [1], { k: 1 }, 'x', 5, undefined, null]);
  });

  it('sorts a field of one type as before', () => {
    expect(sorted(storeWith([10, 9, 100, -1]), 'asc')).toEqual([-1, 9, 10, 100]);
    expect(sorted(storeWith(['b', 'B', 'a', 'é']), 'asc')).toEqual(['B', 'a', 'b', 'é']);
    expect(sorted(storeWith([true, false, true]), 'desc')).toEqual([true, true, false]);
  });
});
