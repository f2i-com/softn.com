/**
 * Whose records a store's share of the browser's storage counts (audit round 3).
 *
 * A store's budget counted every key that began with its prefix and a colon.
 * The default store's prefix is `xdb`, so its budget took in every app's
 * records (`xdb:<app>:<collection>`), and once the apps on the site held its
 * budget between them, the default store's first write was refused as a full
 * store though it held almost nothing. An app whose id another app's begins
 * (`page:/a` and `page:/a:2`) counted that app's records as its own the same way.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { XDBService } from '../src/runtime/xdb-service';
import { RECORD_STORAGE_BUDGET } from '../src/runtime/storage-budget';

afterEach(() => localStorage.clear());

/** About `chars` characters of records in one collection of `xdb`. */
function fill(xdb: XDBService, chars: number): void {
  xdb.create('notes', { text: 'x'.repeat(chars) });
}

describe('a store\'s share of the browser\'s storage', () => {
  it('counts the default store\'s own records, not every app\'s', () => {
    const app = new XDBService(undefined, 'xdb:big', 'big');
    fill(app, RECORD_STORAGE_BUDGET - 200_000);
    const fallback = new XDBService(undefined, 'xdb');
    expect(() => fallback.create('notes', { text: 'y'.repeat(300_000) })).not.toThrow();
    expect(fallback.getAll('notes')).toHaveLength(1);
    // And what it holds of its own is still held to the budget.
    expect(() => fallback.create('notes', { text: 'z'.repeat(RECORD_STORAGE_BUDGET) })).toThrow(/Could not save/);
    app.destroy();
    fallback.destroy();
  });

  it('counts an app\'s own records, not those of an app whose id begins with its own', () => {
    const longer = new XDBService(undefined, 'xdb:page:/a:2', 'page:/a:2');
    fill(longer, RECORD_STORAGE_BUDGET - 200_000);
    const shorter = new XDBService(undefined, 'xdb:page:/a', 'page:/a');
    expect(() => shorter.create('notes', { text: 'y'.repeat(300_000) })).not.toThrow();
    longer.destroy();
    shorter.destroy();
  });
});
