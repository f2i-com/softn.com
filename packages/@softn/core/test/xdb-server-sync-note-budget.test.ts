/**
 * The note of changes made while no server sync client listened is kept in the browser's
 * storage beside the app's records, and counted against the same budget of it. Without a
 * bound of its own, a large import's note took the room the app's next writes needed, and
 * they were refused until a client started and sent it.
 */
import { afterEach, expect, it } from 'vitest';
import { XDBService } from '../src/runtime/xdb';
import { RECORD_STORAGE_BUDGET } from '../src/runtime/storage-budget';

afterEach(() => localStorage.clear());

/** Characters of key and value held under `prefix`, as the budget counts them. */
function used(prefix: string): number {
  let total = 0;
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)!;
    if (key.startsWith(prefix)) total += key.length + (localStorage.getItem(key) ?? '').length;
  }
  return total;
}

it("takes no more than half the room the app's budget leaves, and the app's next write goes in", async () => {
  // A store a client has synced.
  localStorage.setItem('xdb:app::sync-watched', JSON.stringify({ at: Date.now() - 60_000, url: 'wss://sync.example.test/sync' }));
  const store = new XDBService(undefined, 'xdb:app', 'app', { backend: 'storage' });
  const older = '2026-02-15T00:00:00.000Z';
  // About 2.8M characters of the budget's 3M: an entry a record would leave the app too little.
  const records = Array.from({ length: 3000 }, (_, i) => ({ id: `i${i}`, collection: 'notes', data: { title: 'x'.repeat(800) }, created_at: older, updated_at: older, deleted: false }));
  store.import({ version: 1, exportedAt: older, collections: { notes: records } }, { merge: true });
  await Promise.resolve();

  const key = 'xdb:app::sync-unheard';
  const note = localStorage.getItem(key) ?? '';
  const rest = used('xdb:app:') - key.length - note.length;
  expect(note.length).toBeGreaterThan(0);
  expect(note.length).toBeLessThanOrEqual((RECORD_STORAGE_BUDGET - rest) / 2);
  // All of the import is still in it, as lists of ids.
  const kept = store.readUnheardNote();
  expect(kept.edits).toEqual([]);
  expect(kept.imports.flatMap((list) => list.creates)).toHaveLength(3000);
  expect(() => store.create('notes', { body: 'y'.repeat(200_000) })).not.toThrow();
});
