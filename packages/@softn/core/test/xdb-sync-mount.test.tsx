/**
 * The sync runtime is not fetched to find out that nothing needs it.
 *
 * SoftNWithXDB's mount-time cleanup closes the adapter of a room a previous
 * mount left open. It used to do so by importing xdb-sync and asking it for
 * the saved room, so every app on both hosts fetched the sync chunk — 195 KB,
 * yjs included — on every cold visit, whether or not it had ever synced
 * (audit item X07). Now it reads the saved-room key first, through
 * runtime/xdb-sync-key.ts, which imports nothing, and only imports the sync
 * module when there is a room to close.
 *
 * The probe is the mock factory: vitest runs it the first time the module is
 * imported, so its call count is whether `import('../runtime/xdb-sync')`
 * happened. Nothing in core imports xdb-sync statically, so a count of zero
 * is a chunk that was not requested.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SoftNWithXDB } from '../src/loader/SoftNRenderer';
import { getSyncRoomKey } from '../src/runtime/xdb-sync-key';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { syncModuleLoads, closeSyncRoom } = vi.hoisted(() => ({
  syncModuleLoads: { count: 0 },
  closeSyncRoom: vi.fn<(room: string, appId?: string) => boolean>(() => true),
}));

vi.mock('../src/runtime/xdb-sync', () => {
  syncModuleLoads.count += 1;
  return {
    closeSyncRoom,
    getSavedSyncRoom: () => null,
    startSync: vi.fn(),
    stopSync: vi.fn(),
    getSyncAdapter: () => null,
  };
});

const APP = 'app-under-test';

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function mount(appId?: string): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container!);
    root.render(<SoftNWithXDB source="<div>probe</div>" appId={appId} />);
  });
  // The import, when it happens, settles over a few microtasks.
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
}

beforeEach(() => {
  localStorage.clear();
  syncModuleLoads.count = 0;
  closeSyncRoom.mockClear();
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('SoftNWithXDB and the sync runtime at mount', () => {
  it('does not import xdb-sync when no room is saved', async () => {
    await mount(APP);
    expect(syncModuleLoads.count).toBe(0);
    expect(closeSyncRoom).not.toHaveBeenCalled();
  });

  it('does not import xdb-sync for the default scope either', async () => {
    await mount(undefined);
    expect(syncModuleLoads.count).toBe(0);
  });

  it("ignores another app's saved room", async () => {
    localStorage.setItem(getSyncRoomKey('some-other-app'), 'lobby');
    await mount(APP);
    expect(syncModuleLoads.count).toBe(0);
  });

  it('imports xdb-sync once and closes the saved room when one is saved', async () => {
    localStorage.setItem(getSyncRoomKey(APP), 'lobby');
    await mount(APP);
    expect(syncModuleLoads.count).toBe(1);
    expect(closeSyncRoom).toHaveBeenCalledWith('lobby', APP);
    // Closing is not forgetting: the room is still there for the app to offer back.
    expect(localStorage.getItem(getSyncRoomKey(APP))).toBe('lobby');
  });
});
