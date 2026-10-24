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

const OLD = 'Pocket';
const NEW = 'sha256-pocket-full-digest';

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('adopting a record under its new identity', () => {
  it("moves the app's sync rooms with its records", async () => {
    vi.stubGlobal('indexedDB', { databases: async () => [], deleteDatabase: () => ({ onsuccess: null, onerror: null, onblocked: null }) });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    localStorage.setItem(`xdb:${OLD}:notes`, '[]');
    localStorage.setItem(`xdb-sync-active-room:${OLD}`, 'lobby');
    localStorage.setItem(`xdb-sync-shared:${OLD}:lobby`, 'true');
    const record = { id: 'pocket', name: OLD, version: '1.0.0', origin: OLD, bundleData: new Uint8Array(), cachedAt: 1, lastOpened: 1 } as unknown as CachedApp;
    const store = { get: async () => record } as unknown as AppStore;
    const adoption: Adoption = { record, fromAppId: OLD, carryGrants: true, why: 'kept under its full digest' };

    const adopted = await applyAdoption(store, adoption, NEW);

    expect(adopted?.origin).toBe(NEW);
    expect(localStorage.getItem(`xdb:${NEW}:notes`)).toBe('[]');
    expect(localStorage.getItem(`xdb-sync-active-room:${NEW}`)).toBe('lobby');
    expect(localStorage.getItem(`xdb-sync-shared:${NEW}:lobby`)).toBe('true');
    expect(localStorage.getItem(`xdb-sync-active-room:${OLD}`)).toBeNull();
    expect(localStorage.getItem(`xdb-sync-shared:${OLD}:lobby`)).toBeNull();
  });
});
