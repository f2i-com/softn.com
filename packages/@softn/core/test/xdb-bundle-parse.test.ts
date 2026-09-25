/**
 * A bundled `.xdb` file that cannot be read.
 *
 * It used to open as an empty collection with nothing said: the app ran
 * without its seed rows and the author had no way to know the file was the
 * reason. The records are still empty — a half-read file is not seed data —
 * but the result now says why, and the bundle runtime logs it.
 */

import { describe, expect, it } from 'vitest';
import { parseXDBFile } from '../src/bundle/bundle';

describe('parseXDBFile', () => {
  it('names a file that is not JSON', () => {
    const data = parseXDBFile('xdb/notes.xdb', '{ "records": [ { "id": "a", }');
    expect(data.records).toEqual([]);
    expect(data.collection).toBe('xdb/notes');
    expect(data.warning).toMatch(/^xdb\/notes\.xdb: not valid JSON/);
    expect(data.warning).toMatch(/records were not loaded/);
  });

  it('names a file that is JSON but not a collection', () => {
    expect(parseXDBFile('notes.xdb', '[1, 2]').warning).toMatch(/not a JSON object/);
    expect(parseXDBFile('notes.xdb', 'null').warning).toMatch(/not a JSON object/);
    expect(parseXDBFile('notes.xdb', '{ "records": { "id": "a" } }').warning).toMatch(/"records" is not a list/);
  });

  it('says nothing about a file that reads', () => {
    const data = parseXDBFile('notes.xdb', JSON.stringify({ collection: 'notes', records: [{ id: 'a', title: 'x' }] }));
    expect(data.warning).toBeUndefined();
    expect(data.records).toHaveLength(1);
    expect(parseXDBFile('empty.xdb', '{ "collection": "empty" }').warning).toBeUndefined();
  });
});
