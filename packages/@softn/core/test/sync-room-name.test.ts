/**
 * A room's name is a name's length, and an app syncs a handful of rooms at a time.
 *
 * `db.startSync(room)` wrote the room's name to the page's storage as it was (the room an app
 * goes back to after a reload), under a key no app's storage is counted in. A name of a few
 * million characters filled the storage every app on the site shares, and each one's writes
 * failed after it. Nor was there a bound on the rooms an app had open, each a peer connection
 * and a kept copy of the app's records.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const started: string[] = [];
vi.mock('../src/runtime/xdb-sync', () => ({
  startSync: (options: { room: string }) => {
    started.push(options.room);
  },
  stopSync: () => {},
}));

import { createSyncControls } from '../src/runtime/db-sync-controls';
import { MAX_OPEN_SYNC_ROOMS_PER_APP, MAX_SYNC_ROOM_NAME_LEN, isSyncRoomName } from '../src/runtime/sync-room-security';
import type { PermissionConfig } from '../src/runtime/script-runtime';

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

beforeEach(() => {
  started.length = 0;
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a room’s name', () => {
  it('is text with something in it, no longer than a name is', () => {
    expect(isSyncRoomName('lobby')).toBe(true);
    expect(isSyncRoomName('x'.repeat(MAX_SYNC_ROOM_NAME_LEN))).toBe(true);
    expect(isSyncRoomName('x'.repeat(MAX_SYNC_ROOM_NAME_LEN + 1))).toBe(false);
    for (const room of ['', undefined, null, 7, {}, ['lobby']]) expect(isSyncRoomName(room), String(room)).toBe(false);
    expect(MAX_OPEN_SYNC_ROOMS_PER_APP).toBeGreaterThan(0);
  });

  it('is refused by the script’s own startSync before anything is started or kept', async () => {
    const said = vi.spyOn(console, 'error').mockImplementation(() => {});
    const refused: string[] = [];
    const controls = createSyncControls({
      appId: 'sync-room-name',
      getPermissionConfig: () => ({ permissions: { sync: { enabled: true } } }) as unknown as PermissionConfig,
      refuse: (reason) => refused.push(reason),
    });
    controls.startSync('A'.repeat(4_500_000));
    controls.startSync('');
    controls.startSync(42 as unknown as string);
    await settle();
    expect(started).toEqual([]);
    expect(refused).toEqual([]);
    expect(said).toHaveBeenCalledTimes(3);
    // Nothing of the name reached the page's storage.
    expect(Object.keys(localStorage).reduce((size, key) => size + key.length + (localStorage.getItem(key) ?? '').length, 0)).toBeLessThan(1024);

    // A name of a name's length still starts: once its secret is worked out, which takes
    // as long as the machine is busy, so the start is waited for, not a number of milliseconds.
    controls.startSync('lobby');
    await vi.waitFor(() => expect(started).toEqual(['lobby']), { timeout: 5000 });
  });
});
