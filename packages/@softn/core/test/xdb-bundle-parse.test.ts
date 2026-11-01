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

describe('seed records with ids that are not strings', () => {
  it('keeps a numeric id as its digits', () => {
    const data = parseXDBFile('notes.xdb', JSON.stringify({ records: [{ id: 1, title: 'one' }, { id: 2.5, title: 'two' }, { id: 0, title: 'zero' }] }));
    expect(data.records.map((record) => record.id)).toEqual(['1', '2.5', '0']);
    expect(data.records[0].data).toEqual({ title: 'one' });
    expect(data.warning).toBeUndefined();
  });

  it('says how many records it could not take', () => {
    const data = parseXDBFile('notes.xdb', JSON.stringify({ records: [{ id: 'a' }, { title: 'no id' }, { id: true }, { id: null }, 'text', { id: 'b', data: 5 }] }));
    expect(data.records.map((record) => record.id)).toEqual(['a']);
    expect(data.warning).toBe('notes.xdb: 5 of its 6 records were left out, for having no id or no object of data');
  });

  it('takes a blank id for no id: stored, it makes the whole collection read as damaged', () => {
    const data = parseXDBFile('notes.xdb', JSON.stringify({ records: [{ id: 'a' }, { id: '' }, { id: '  ' }, { id: '\u0085' }] }));
    expect(data.records.map((record) => record.id)).toEqual(['a']);
    expect(data.warning).toContain('3 of its 4 records were left out');
  });

  it('says one record in the singular, and nothing when all are read', () => {
    expect(parseXDBFile('n.xdb', JSON.stringify({ records: [{ id: 'a' }, {}] })).warning).toBe('n.xdb: 1 of its 2 records was left out, for having no id or no object of data');
    expect(parseXDBFile('n.xdb', JSON.stringify({ records: [{ id: 'a' }] })).warning).toBeUndefined();
    expect(parseXDBFile('n.xdb', JSON.stringify({ records: [] })).warning).toBeUndefined();
  });
});
