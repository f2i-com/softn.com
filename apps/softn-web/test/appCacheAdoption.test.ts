/** @vitest-environment jsdom */
/**
 * A record cached under an earlier identity (a manifest name, a short digest)
 * is adopted by the bundle that is the same app: its records move to the new
 * identity. Its sync rooms' keys stayed behind, so the app no longer went back
 * to the room it was in, and a shared room started again without options
 * opened private, away from its peers.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyAdoption, type Adoption, type AppStore } from '../src/lib/appCacheAdoption';
import type { CachedApp } from '../src/lib/appCacheDb';

const SHORT = '0123456789abcdef';
const NEW = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function adopt(from: string, carryGrants: boolean) {
  const record = { id: 'pocket', name: 'Pocket', version: '1.0.0', origin: carryGrants ? from : undefined, bundleData: new Uint8Array(), cachedAt: 1, lastOpened: 1 } as unknown as CachedApp;
  const store = { get: async () => record } as unknown as AppStore;
  const adoption: Adoption = { record, fromAppId: from, carryGrants, why: carryGrants ? 'kept under its full digest' : 'adopted its content identity' };
  return applyAdoption(store, adoption, NEW);
}

describe('adopting a record under its new identity', () => {
  it("moves the app's sync rooms with its records", async () => {
    const deleted: string[] = [];
    vi.stubGlobal('indexedDB', {
      databases: async () => [{ name: `xdb-sync:${SHORT}:lobby` }],
      deleteDatabase: (name: string) => { deleted.push(name); return { onsuccess: null, onerror: null, onblocked: null }; },
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    localStorage.setItem(`xdb:${SHORT}:notes`, '[]');
    localStorage.setItem(`xdb-sync-active-room:${SHORT}`, 'lobby');
    localStorage.setItem(`xdb-sync-shared:${SHORT}:lobby`, 'true');

    const adopted = await adopt(SHORT, true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(adopted?.origin).toBe(NEW);
    expect(localStorage.getItem(`xdb:${NEW}:notes`)).toBe('[]');
    expect(localStorage.getItem(`xdb-sync-active-room:${NEW}`)).toBe('lobby');
    expect(localStorage.getItem(`xdb-sync-shared:${NEW}:lobby`)).toBe('true');
    expect(localStorage.getItem(`xdb-sync-active-room:${SHORT}`)).toBeNull();
    expect(localStorage.getItem(`xdb-sync-shared:${SHORT}:lobby`)).toBeNull();
    expect(deleted).toEqual([`xdb-sync:${SHORT}:lobby`]);
  });

  // A record from before identity was keyed by its manifest's name, which may begin another
  // app's: what was found by `Notes:` was Notes:Pro's too, and went with Notes.
  it("takes nothing of another app's whose name the old one begins", async () => {
    const deleted: string[] = [];
    vi.stubGlobal('indexedDB', {
      databases: async () => [{ name: 'xdb-sync:Notes:lobby' }, { name: 'xdb-sync:Notes:Pro:club' }],
      deleteDatabase: (name: string) => { deleted.push(name); return { onsuccess: null, onerror: null, onblocked: null }; },
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    localStorage.setItem('xdb:Notes:notes', '[1]');
    localStorage.setItem('xdb:Notes::collections', '["notes"]');
    localStorage.setItem('xdb:Notes:Pro:tasks', '[2]');
    localStorage.setItem('xdb:Notes:Pro::collections', '["tasks"]');
    localStorage.setItem('xdb-sync-active-room:Notes', 'lobby');
    localStorage.setItem('xdb-sync-shared:Notes:Pro:club', 'true');

    const adopted = await adopt('Notes', false);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(adopted?.origin).toBe(NEW);
    // Notes's records and its store's note move; Notes:Pro's stay where they were.
    expect(localStorage.getItem(`xdb:${NEW}:notes`)).toBe('[1]');
    expect(localStorage.getItem(`xdb:${NEW}::collections`)).toBe('["notes"]');
    expect(localStorage.getItem('xdb:Notes:Pro:tasks')).toBe('[2]');
    expect(localStorage.getItem('xdb:Notes:Pro::collections')).toBe('["tasks"]');
    expect(Object.keys(localStorage).filter((key) => key.startsWith(`xdb:${NEW}:`)).sort()).toEqual([`xdb:${NEW}::collections`, `xdb:${NEW}:notes`]);
    // Its room goes with it; Notes:Pro's room keys and caches are left.
    expect(localStorage.getItem(`xdb-sync-active-room:${NEW}`)).toBe('lobby');
    expect(localStorage.getItem('xdb-sync-shared:Notes:Pro:club')).toBe('true');
    expect(deleted).toEqual([]);
  });
});
