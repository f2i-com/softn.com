/**
 * The sync runtime is not fetched to find out that nothing needs it.
 *
 * SoftNWithXDB used to close, at mount, the adapter of a room a previous
 * mount had left open. First it imported xdb-sync to ask for the saved room,
 * so every app on both hosts fetched the sync chunk — 195 KB, yjs included —
 * on every cold visit (audit item X07); then it read the key first and
 * imported only when a room was saved, so an app that had ever synced still
 * fetched it on every open. An app's rooms close with the app now
 * (sync-activity.ts), and mounting closes nothing and imports nothing.
 *
 * The probe is the mock factory: vitest runs it the first time the module is
 * imported, so its call count is whether `import('../runtime/xdb-sync')`
 * happened. Nothing in core imports xdb-sync statically, so a count of zero
 * is a chunk that was not requested.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SoftNWithXDB } from '../src/loader/xdb-bindings';
import { getSyncRoomKey } from '../src/runtime/xdb-sync-key';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { syncModuleLoads } = vi.hoisted(() => ({ syncModuleLoads: { count: 0 } }));

vi.mock('../src/runtime/xdb-sync', () => {
  syncModuleLoads.count += 1;
  return {
    closeSyncRoom: vi.fn(() => true),
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
  // An import, were one made, settles over a few microtasks.
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
}

beforeEach(() => {
  localStorage.clear();
  syncModuleLoads.count = 0;
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
  });

  it('does not import xdb-sync for the default scope either', async () => {
    await mount(undefined);
    expect(syncModuleLoads.count).toBe(0);
  });

  it('does not import xdb-sync for a saved room, and leaves the room saved', async () => {
    localStorage.setItem(getSyncRoomKey(APP), 'lobby');
    await mount(APP);
    expect(syncModuleLoads.count).toBe(0);
    // The room is still there for the app to offer back.
    expect(localStorage.getItem(getSyncRoomKey(APP))).toBe('lobby');
  });
});
