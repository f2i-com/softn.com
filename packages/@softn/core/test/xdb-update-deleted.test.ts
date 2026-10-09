/**
 * An update of a record that has been deleted.
 *
 * `db.delete` leaves the record in the browser's store marked deleted, so
 * sync can tell the other devices. Everything that reads it treats it as
 * gone: `get` answers null, `query` leaves it out, a second `delete` finds
 * nothing, and `updateInCollection`, which names the collection, finds
 * nothing to update. `update` by id alone did not ask, in the browser's
 * store only (the desktop's does): it patched the deleted record, announced
 * an update of it and answered with it, `deleted: true`, so a script was told
 * its write had landed on a record it could not then read, and sync was sent
 * new data for something deleted. An autosave that fires after its record is
 * deleted is the ordinary way to get there.
 *
 * A deleted record is not there to update. The script's `db.update` then
 * says what it says for any record that is not there.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { getXDB } from '../src/runtime/xdb';
import { createDBNamespace } from '../src/runtime/script-runtime';
import type { XDBEvent } from '../src/runtime/xdb-types';

const APP = 'update-deleted';

beforeEach(() => {
  localStorage.clear();
  getXDB(APP).clear('notes');
});

/** Everything the store has written, deleted records and all. */
function stored(): string {
  const entries: Array<[string, string | null]> = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)!;
    entries.push([key, localStorage.getItem(key)]);
  }
  return JSON.stringify(entries.sort(([a], [b]) => a.localeCompare(b)));
}

describe('the browser store, asked to update a deleted record', () => {
  it('finds nothing to update, changes nothing and announces nothing', () => {
    const xdb = getXDB(APP);
    const note = xdb.create('notes', { title: 'Draft', n: 1 });
    xdb.delete(note.id);
    const kept = stored();
    // The deleted record is still in what is stored: that is what sync reads.
    expect(kept).toContain(note.id);

    const events: XDBEvent[] = [];
    const stop = xdb.subscribe('notes', (event) => events.push(event));
    try {
      expect(xdb.update(note.id, { n: 2 })).toBeNull();
    } finally {
      stop();
    }
    expect(events).toEqual([]);
    expect(stored()).toBe(kept);
    expect(xdb.get('notes', note.id)).toBeNull();
  });

  it('still updates a record that is there, beside one that is not', () => {
    const xdb = getXDB(APP);
    const gone = xdb.create('notes', { title: 'Gone' });
    const here = xdb.create('notes', { title: 'Here', n: 1 });
    xdb.delete(gone.id);
    expect(xdb.update(here.id, { n: 2 })?.data).toEqual({ title: 'Here', n: 2 });
    expect(xdb.query('notes').map((record) => record.data.title)).toEqual(['Here']);
  });

  it('answers as updateInCollection does, which names the collection', () => {
    const xdb = getXDB(APP);
    const note = xdb.create('notes', { title: 'Draft' });
    xdb.delete(note.id);
    expect(xdb.updateInCollection('notes', note.id, { title: 'Changed' })).toBeNull();
    expect(xdb.update(note.id, { title: 'Changed' })).toBeNull();
  });
});

describe('a script that updates a record it has deleted', () => {
  it('is told what it is told for any record that is not there', async () => {
    const db = createDBNamespace(() => null, APP);
    await db.ready();
    const note = db.create('notes', { title: 'Draft' });
    db.delete(note.id);
    expect(() => db.update(note.id, { title: 'Changed' })).toThrow(`Record not found: ${note.id}`);
    expect(() => db.update('never-there', { title: 'Changed' })).toThrow('Record not found: never-there');
  });
});
