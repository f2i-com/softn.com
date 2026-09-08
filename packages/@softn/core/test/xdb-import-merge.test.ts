/**
 * XDB import: one row per id, on every path.
 *
 * Ported from the audit's isolated reproduction (softn-xdb-merge-repro.mjs,
 * 2026-09-08). The browser merge captured the set of stored ids once, before
 * its loop, and appended every incoming row whose id was missing from that
 * snapshot — so two rows sharing a previously unseen id both landed, and the
 * collection could never be deduplicated again. The Tauri branch never had
 * the bug (a Map keyed by id cannot hold an id twice), which is the policy
 * both branches now share: last value wins, first insertion keeps its place.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { XDBService, type XDBExportData } from '../src/runtime/xdb';
import type { XDBRecord } from '../src/types';

function createTestStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) || null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
    keys: () => [...store.keys()],
  };
}

function row(id: string, collection: string, value: unknown): XDBRecord {
  const now = new Date().toISOString();
  return { id, collection, data: { value }, created_at: now, updated_at: now, deleted: false };
}

// Import takes whatever a JSON file held, so the fixtures deliberately carry
// rows that are not records at all.
function exportOf(collections: Record<string, unknown>): XDBExportData {
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    collections: collections as Record<string, XDBRecord[]>,
  };
}

const values = (records: XDBRecord[]) => records.map((r) => [r.id, r.data.value]);

describe('XDB import merge (browser storage)', () => {
  let storage: ReturnType<typeof createTestStorage>;
  let xdb: XDBService;

  beforeEach(() => {
    storage = createTestStorage();
    xdb = new XDBService(storage, 'test-xdb');
  });

  it('keeps one row, holding the later value, for an id that appears twice in one import', () => {
    const result = xdb.import(
      exportOf({ notes: [row('record-a', 'notes', 'first'), row('record-a', 'notes', 'second')] })
    );

    expect(values(xdb.getAll('notes'))).toEqual([['record-a', 'second']]);
    expect(result).toEqual({ imported: 2, skipped: 0, collections: ['notes'] });
  });

  it('replaces an existing id in place and keeps the collection order', () => {
    xdb.import(exportOf({ notes: [row('a', 'notes', 'old'), row('b', 'notes', 'keep')] }));

    xdb.import(exportOf({ notes: [row('a', 'notes', 'first'), row('a', 'notes', 'second')] }));

    expect(values(xdb.getAll('notes'))).toEqual([
      ['a', 'second'],
      ['b', 'keep'],
    ]);
  });

  it('appends unseen ids after the existing rows, in arrival order', () => {
    xdb.import(exportOf({ notes: [row('a', 'notes', 1), row('b', 'notes', 2)] }));

    xdb.import(
      exportOf({
        notes: [row('d', 'notes', 4), row('a', 'notes', 10), row('c', 'notes', 3)],
      })
    );

    expect(values(xdb.getAll('notes'))).toEqual([
      ['a', 10],
      ['b', 2],
      ['d', 4],
      ['c', 3],
    ]);
  });

  it('skips rows without a usable id, counts them, and still imports the rest', () => {
    const result = xdb.import(
      exportOf({
        notes: [
          { collection: 'notes', data: { value: 'no id' } },
          row('', 'notes', 'empty id'),
          { id: 7, collection: 'notes', data: {} },
          null,
          'a string',
          42,
          row('good', 'notes', 'kept'),
        ],
      })
    );

    expect(values(xdb.getAll('notes'))).toEqual([['good', 'kept']]);
    expect(result).toEqual({ imported: 1, skipped: 6, collections: ['notes'] });
  });

  it('skips a collection whose value is not an array and goes on to the next', () => {
    const result = xdb.import(
      exportOf({
        broken: { id: 'x' },
        notes: [row('a', 'notes', 1)],
      })
    );

    expect(result).toEqual({ imported: 1, skipped: 1, collections: ['notes'] });
    expect(storage.keys()).toEqual(['test-xdb:notes']);
  });

  it('merge: false writes one row for a duplicated id and drops what was there', () => {
    xdb.import(exportOf({ notes: [row('z', 'notes', 'previous')] }));

    const result = xdb.import(
      exportOf({
        notes: [row('a', 'notes', 'first'), { id: '' }, row('a', 'notes', 'second')],
      }),
      { merge: false }
    );

    expect(values(xdb.getAll('notes'))).toEqual([['a', 'second']]);
    expect(result).toEqual({ imported: 2, skipped: 1, collections: ['notes'] });
  });

  it('persists each collection once and notifies its subscribers exactly once', () => {
    const notes = vi.fn();
    const tags = vi.fn();
    const everything = vi.fn();
    xdb.subscribe('notes', notes);
    xdb.subscribe('tags', tags);
    xdb.subscribeAll(everything);
    const setItem = vi.spyOn(storage, 'setItem');

    xdb.import(
      exportOf({
        notes: [row('a', 'notes', 1), row('a', 'notes', 2), row('b', 'notes', 3)],
        tags: [row('t', 'tags', 'x')],
      })
    );

    expect(notes).toHaveBeenCalledTimes(1);
    expect(tags).toHaveBeenCalledTimes(1);
    expect(everything).toHaveBeenCalledTimes(2);
    expect(notes.mock.calls[0][0]).toMatchObject({ type: 'refresh', collection: 'notes' });
    expect(values(notes.mock.calls[0][0].records)).toEqual([
      ['a', 2],
      ['b', 3],
    ]);
    expect(setItem.mock.calls.map(([key]) => key)).toEqual(['test-xdb:notes', 'test-xdb:tags']);
  });

  it('importFromJSON reports the same counts', () => {
    const json = JSON.stringify(
      exportOf({ notes: [row('a', 'notes', 1), row('a', 'notes', 2), { id: null }] })
    );

    expect(xdb.importFromJSON(json)).toEqual({ imported: 2, skipped: 1, collections: ['notes'] });
    expect(xdb.count('notes')).toBe(1);
  });
});

describe('XDB import merge (localStorage under an app prefix)', () => {
  beforeEach(() => {
    localStorage.clear();
    // XDB memoises instances per app in a module-level map; a fresh registry
    // is the only way to prove the rows came back from storage, not the cache.
    vi.resetModules();
  });

  it('writes the deduplicated rows under the app key, and a fresh instance reads them back', async () => {
    const { getXDB } = await import('../src/runtime/xdb');
    getXDB('import-test').import(
      exportOf({ notes: [row('record-a', 'notes', 'first'), row('record-a', 'notes', 'second')] })
    );

    const stored = JSON.parse(localStorage.getItem('xdb:import-test:notes') ?? '[]');
    expect(values(stored)).toEqual([['record-a', 'second']]);

    vi.resetModules();
    const fresh = await import('../src/runtime/xdb');
    expect(values(fresh.getXDB('import-test').getAll('notes'))).toEqual([['record-a', 'second']]);
  });
});

describe('XDB import merge (Tauri backend)', () => {
  let backend: Map<string, XDBRecord[]>;
  let invoke: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    backend = new Map();
    invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
      switch (cmd) {
        case 'get_collections':
          return [...backend.keys()];
        case 'get_collection':
          return backend.get(String(args?.collection)) ?? [];
        case 'upsert_record':
          return args?.record;
        case 'clear_collection':
          return true;
        default:
          throw new Error(`Unexpected command: ${cmd}`);
      }
    });
    // isTauri() looks for the global on `window`, and jsdom's window is not
    // globalThis here.
    Object.assign(window, {
      __TAURI__: { core: { invoke }, event: { listen: vi.fn(async () => () => {}) } },
    });
  });

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI__;
  });

  it('applies the same policy: last value wins, existing rows keep their place', async () => {
    backend.set('notes', [row('a', 'notes', 'old'), row('b', 'notes', 'keep')]);
    const xdb = new XDBService(undefined, 'test-xdb');
    await xdb.isReady;

    const result = xdb.import(
      exportOf({
        notes: [row('a', 'notes', 'first'), { id: '' }, row('a', 'notes', 'second')],
      })
    );

    expect(values(xdb.getAll('notes'))).toEqual([
      ['a', 'second'],
      ['b', 'keep'],
    ]);
    expect(result).toEqual({ imported: 2, skipped: 1, collections: ['notes'] });
  });

  it('persists the deduplicated rows, never the skipped ones', async () => {
    const xdb = new XDBService(undefined, 'test-xdb');
    await xdb.isReady;

    xdb.import(
      exportOf({
        notes: [row('a', 'notes', 'first'), null, row('a', 'notes', 'second')],
      }),
      { merge: false }
    );

    const upserts = invoke.mock.calls.filter(([cmd]) => cmd === 'upsert_record');
    expect(upserts).toHaveLength(1);
    expect((upserts[0][1] as { record: XDBRecord }).record.data.value).toBe('second');
  });
});
