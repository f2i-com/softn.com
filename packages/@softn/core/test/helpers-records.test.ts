/**
 * Key-based helpers over XDB records.
 *
 * A record is `{ id, collection, data, created_at, updated_at, deleted }`, and
 * templates address its own fields as readily as the ones inside `data`. Every
 * key-based helper except `find` indexed only `data`, so a record field
 * resolved to `undefined` — which sorts nothing, matches nothing, and collapses
 * every record into one. None of it errored; the page just said something
 * untrue. `sort`'s own docstring example was the broken case.
 */

import { describe, it, expect } from 'vitest';
import { sort, filter, unique, pluck, groupBy, find } from '../src/runtime/helpers';
import type { XDBRecord } from '../src/types';

const record = (
  id: string,
  createdAt: string,
  data: Record<string, unknown>,
  deleted = false
): XDBRecord =>
  ({
    id,
    collection: 'notes',
    data,
    created_at: createdAt,
    updated_at: createdAt,
    deleted,
  }) as XDBRecord;

const records: XDBRecord[] = [
  record('b', '2024-01-02', { title: 'B', tag: 'x' }),
  record('a', '2024-01-01', { title: 'A', tag: 'y' }),
  record('c', '2024-01-03', { title: 'C', tag: 'x' }, true),
];

describe('helpers over record fields', () => {
  it('sorts by a record field', () => {
    // The documented usage: {#each sort(notes, 'created_at') as note}
    expect(sort(records, 'created_at').map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(sort(records, 'created_at', 'desc').map((r) => r.id)).toEqual(['c', 'b', 'a']);
  });

  it('sorts by a field inside data', () => {
    expect(sort(records, 'title').map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('filters on a record field', () => {
    expect(filter(records, { deleted: false }).map((r) => r.id)).toEqual(['b', 'a']);
    expect(filter(records, { deleted: true }).map((r) => r.id)).toEqual(['c']);
  });

  it('filters on a data field', () => {
    expect(filter(records, { tag: 'x' }).map((r) => r.id)).toEqual(['b', 'c']);
  });

  it('treats distinct ids as distinct', () => {
    // Every record used to read `id: undefined`, so the whole set deduped to one.
    expect(unique(records, 'id')).toHaveLength(3);
  });

  it('plucks a record field', () => {
    expect(pluck(records, 'id')).toEqual(['b', 'a', 'c']);
  });

  it('plucks a data field', () => {
    expect(pluck(records, 'title')).toEqual(['B', 'A', 'C']);
  });

  it('groups by a record field', () => {
    expect(Object.keys(groupBy(records, 'collection'))).toEqual(['notes']);
  });

  it('groups by a data field', () => {
    expect(Object.keys(groupBy(records, 'tag')).sort()).toEqual(['x', 'y']);
  });

  it('finds by a record field, as it always did', () => {
    expect(find(records, { id: 'a' })?.id).toBe('a');
  });

  it('leaves plain objects alone', () => {
    const plain = [{ n: 2 }, { n: 1 }];
    expect(sort(plain, 'n').map((o) => o.n)).toEqual([1, 2]);
    expect(pluck(plain, 'n')).toEqual([2, 1]);
    expect(filter(plain, { n: 1 })).toEqual([{ n: 1 }]);
  });
});
