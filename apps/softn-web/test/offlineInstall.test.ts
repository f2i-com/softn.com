/**
 * The per-app offline install: what it fetches, and when it is allowed to
 * say "ready".
 *
 * The rule under test is the negative one, mostly. An app is not installed
 * because its bundle is cached; it is installed when every lazy component
 * any of its routes names, the sync runtime it asked for and the worker
 * files its script needs have all been fetched through something that keeps
 * them. One missing piece, and the answer is no — with the piece named.
 * Everything reaches the world through an injectable host, so the registry
 * here is a real one with fake loaders and the "service worker" is a
 * function that says yes.
 */

import { describe, it, expect, vi } from 'vitest';
import { createRegistry, type ComponentRegistry, type SoftNComponent } from '@softn/core';
import {
  installAppOffline,
  moduleReferences,
  requiredFeatures,
  SYNC_RUNTIME,
  type OfflineInstallOptions,
} from '../src/lib/offlineInstall';
import { buildIdFromEntry, isOfflineReady } from '../src/lib/appCache';

const Fake = (() => null) as unknown as SoftNComponent;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A registry with the minimal names eager and two features by loader. */
function registryWith(loaders: Record<string, () => Promise<SoftNComponent>>): ComponentRegistry {
  const registry = createRegistry();
  registry.register('Stack', Fake);
  registry.register('Text', Fake);
  for (const [name, load] of Object.entries(loaders))
    registry.registerLazy(name, load, { feature: name.toLowerCase() });
  return registry;
}

const SOURCE = [
  '<Stack><Text>hi</Text></Stack>',
  "#if (page === 'game')",
  '<Scene3D />',
  '#else',
  '<div><LineChart /></div>',
  '#end',
].join('\n');

let nextId = 0;
const app = (extra: Partial<Parameters<typeof installAppOffline>[0]> = {}) => ({
  id: `app-${++nextId}`,
  source: SOURCE,
  ...extra,
});

const host = (
  registry: ComponentRegistry,
  extra: Partial<OfflineInstallOptions> = {}
): OfflineInstallOptions => ({
  registry,
  cacheHolder: async () => true,
  ...extra,
});

describe('requiredFeatures', () => {
  it('names every lazy component on every route, and nothing eager or unknown', () => {
    const registry = registryWith({ Scene3D: async () => Fake, LineChart: async () => Fake });
    expect(requiredFeatures(SOURCE, registry)).toEqual(['LineChart', 'Scene3D']);
  });

  it('is empty when the document names only what the shell already has', () => {
    const registry = registryWith({ Scene3D: async () => Fake });
    expect(requiredFeatures('<Stack><Text>x</Text></Stack>', registry)).toEqual([]);
  });
});

describe('installAppOffline', () => {
  it('is ready only once every feature has loaded', async () => {
    const scene = vi.fn(async () => Fake);
    const chart = vi.fn(async () => Fake);
    const registry = registryWith({ Scene3D: scene, LineChart: chart });
    const result = await installAppOffline(app(), host(registry));
    expect(result).toEqual({
      ready: true,
      features: ['LineChart', 'Scene3D'],
      missing: [],
      workerAssets: 'not-needed',
      optionalOnline: [],
    });
    expect(scene).toHaveBeenCalledTimes(1);
    expect(chart).toHaveBeenCalledTimes(1);
    expect(registry.getLoadState('Scene3D')).toBe('loaded');
  });

  it('names the feature that failed and is not ready', async () => {
    const registry = registryWith({
      Scene3D: async () => Fake,
      LineChart: async () => {
        throw new TypeError('Failed to fetch dynamically imported module');
      },
    });
    const result = await installAppOffline(app(), host(registry));
    expect(result.ready).toBe(false);
    expect(result.missing).toEqual(['LineChart']);
    expect(registry.getLoadState('Scene3D')).toBe('loaded');
    expect(registry.getLoadState('LineChart')).toBe('error');
  });

  it('retries a load that failed earlier rather than trusting the cached rejection', async () => {
    let attempts = 0;
    const registry = registryWith({
      Scene3D: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('offline at the time');
        return Fake;
      },
      LineChart: async () => Fake,
    });
    await registry.load('Scene3D').catch(() => undefined);
    expect(registry.getLoadState('Scene3D')).toBe('error');
    const result = await installAppOffline(app(), host(registry));
    expect(attempts).toBe(2);
    expect(result.ready).toBe(true);
  });

  it('does nothing for a signal that has already fired', async () => {
    const scene = vi.fn(async () => Fake);
    const registry = registryWith({ Scene3D: scene, LineChart: async () => Fake });
    const controller = new AbortController();
    controller.abort();
    const result = await installAppOffline(app(), host(registry, { signal: controller.signal }));
    expect(result.ready).toBe(false);
    expect(result.error).toMatch(/cancelled/);
    expect(scene).not.toHaveBeenCalled();
  });

  it('stops waiting when aborted mid-load and does not start the loader again', async () => {
    const pending = deferred<SoftNComponent>();
    const scene = vi.fn(() => pending.promise);
    const registry = registryWith({ Scene3D: scene, LineChart: async () => Fake });
    const controller = new AbortController();
    const run = installAppOffline(app(), host(registry, { signal: controller.signal }));
    await Promise.resolve();
    controller.abort();
    const result = await run;
    expect(result.ready).toBe(false);
    expect(result.error).toMatch(/cancelled/);
    expect(scene).toHaveBeenCalledTimes(1);
    // The load that was in flight finishes on its own; nothing here reports
    // it, and nothing here started a second one.
    pending.resolve(Fake);
    await pending.promise;
    expect(scene).toHaveBeenCalledTimes(1);
  });

  it('runs once for one record however many times it is asked while running', async () => {
    const pending = deferred<SoftNComponent>();
    const scene = vi.fn(() => pending.promise);
    const registry = registryWith({ Scene3D: scene, LineChart: async () => Fake });
    const target = app();
    const first = installAppOffline(target, host(registry));
    const second = installAppOffline(target, host(registry));
    expect(second).toBe(first);
    // The loader runs after the cache-holder check, one tick in.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(scene).toHaveBeenCalledTimes(1);
    pending.resolve(Fake);
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(a.ready).toBe(true);
    // Finished: the next ask is a new run, which finds everything loaded.
    const third = installAppOffline(target, host(registry));
    expect(third).not.toBe(first);
    expect((await third).ready).toBe(true);
    expect(scene).toHaveBeenCalledTimes(1);
  });

  it('fetches the sync runtime for an app that asked for sync, and misses it when that fails', async () => {
    const registry = registryWith({ Scene3D: async () => Fake, LineChart: async () => Fake });
    const preloadSync = vi.fn(async () => undefined);
    const ok = await installAppOffline(
      app({ capabilities: ['sync'] }),
      host(registry, { preloadSync })
    );
    expect(preloadSync).toHaveBeenCalledTimes(1);
    expect(ok.features).toEqual(['LineChart', 'Scene3D', SYNC_RUNTIME]);
    expect(ok.ready).toBe(true);

    const failing = vi.fn(async () => {
      throw new Error('no network');
    });
    const bad = await installAppOffline(
      app({ capabilities: ['sync'] }),
      host(registry, { preloadSync: failing })
    );
    expect(bad.ready).toBe(false);
    expect(bad.missing).toEqual([SYNC_RUNTIME]);
  });

  it('does not fetch the sync runtime for an app that did not ask', async () => {
    const registry = registryWith({ Scene3D: async () => Fake, LineChart: async () => Fake });
    const preloadSync = vi.fn(async () => undefined);
    const result = await installAppOffline(
      app({ capabilities: ['net'] }),
      host(registry, { preloadSync })
    );
    expect(preloadSync).not.toHaveBeenCalled();
    expect(result.features).toEqual(['LineChart', 'Scene3D']);
  });

  it('leaves AI online by design and says so', async () => {
    const registry = registryWith({ Scene3D: async () => Fake, LineChart: async () => Fake });
    const result = await installAppOffline(app({ capabilities: ['ai'] }), host(registry));
    expect(result.ready).toBe(true);
    expect(result.optionalOnline).toEqual(['ai']);
  });

  it('refuses to count a fetch nothing would keep', async () => {
    const scene = vi.fn(async () => Fake);
    const registry = registryWith({ Scene3D: scene, LineChart: async () => Fake });
    const result = await installAppOffline(
      app(),
      host(registry, { cacheHolder: async () => false })
    );
    expect(result.ready).toBe(false);
    expect(result.error).toMatch(/service worker/);
    expect(scene).not.toHaveBeenCalled();
  });

  describe('worker assets', () => {
    const ROOT = 'http://localhost/web/assets/core-runtime/';
    const files: Record<string, string> = {
      [`${ROOT}runtime/script-worker.js`]:
        'import{a as b}from"../chunk-A.js";import"../chunk-B.js";const later=()=>import("../lazy.js");',
      [`${ROOT}chunk-A.js`]:
        'import React from "react";const wasm=new URL("engine.wasm", import.meta.url);export const a=1;',
      [`${ROOT}chunk-B.js`]: 'export * from "./chunk-A.js";',
      [`${ROOT}engine.wasm`]: '\0asm',
    };

    function serve(missing: string[] = []) {
      return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
        const href = String(input);
        const text = files[href];
        if (text === undefined || missing.includes(href)) {
          return { ok: false, status: 404, text: async () => '' } as unknown as Response;
        }
        return { ok: true, status: 200, text: async () => text } as unknown as Response;
      });
    }

    it('fetches the worker entry, what it imports statically and its wasm through the service worker', async () => {
      const registry = registryWith({ Scene3D: async () => Fake, LineChart: async () => Fake });
      const fetch = serve();
      const result = await installAppOffline(
        app({ execution: 'worker' }),
        host(registry, { fetch: fetch as unknown as typeof globalThis.fetch, baseUrl: '/web/' })
      );
      expect(result.workerAssets).toBe('installed');
      expect(result.ready).toBe(true);
      const fetched = fetch.mock.calls.map(([input]) => String(input)).sort();
      expect(fetched).toEqual(Object.keys(files).sort());
      for (const [, init] of fetch.mock.calls) expect((init as RequestInit).cache).toBe('reload');
    });

    it('is unavailable, and the app not ready, when any file of the graph is missing', async () => {
      const registry = registryWith({ Scene3D: async () => Fake, LineChart: async () => Fake });
      const fetch = serve([`${ROOT}chunk-B.js`]);
      const result = await installAppOffline(
        app({ execution: 'worker' }),
        host(registry, { fetch: fetch as unknown as typeof globalThis.fetch, baseUrl: '/web/' })
      );
      expect(result.workerAssets).toBe('unavailable');
      expect(result.ready).toBe(false);
      expect(result.missing).toEqual([]);
    });

    it('is not needed for an app that runs on the main thread', async () => {
      const registry = registryWith({ Scene3D: async () => Fake, LineChart: async () => Fake });
      const fetch = serve();
      const result = await installAppOffline(
        app({ execution: 'main' }),
        host(registry, { fetch: fetch as unknown as typeof globalThis.fetch, baseUrl: '/web/' })
      );
      expect(result.workerAssets).toBe('not-needed');
      expect(fetch).not.toHaveBeenCalled();
    });
  });
});

describe('moduleReferences', () => {
  it('finds static imports, re-exports, bare imports and import.meta.url files; skips dynamic and bare', () => {
    const text = [
      'import{a as b}from"../chunk-A.js";',
      "import x from './x.js';",
      'import"../side.js";',
      'export * from "./chunk-B.js";',
      'import React from "react";',
      'const later=()=>import("../lazy.js");',
      'const wasm=new URL("engine.wasm", import.meta.url);',
      "const abs=new URL('https://cdn.example/x.wasm', import.meta.url);",
    ].join('\n');
    expect(moduleReferences(text)).toEqual([
      '../chunk-A.js',
      './x.js',
      './chunk-B.js',
      '../side.js',
      'engine.wasm',
    ]);
  });
});

describe('what the launcher reads', () => {
  it('takes the build id from the hashed entry script and nothing else', () => {
    expect(buildIdFromEntry('/assets/index-D_9ohh3J.js')).toBe('D_9ohh3J');
    expect(buildIdFromEntry('/web/assets/index-D_9ohh3J.js?v=2')).toBe('D_9ohh3J');
    expect(buildIdFromEntry('/src/main.tsx')).toBeNull();
    expect(buildIdFromEntry(null)).toBeNull();
  });

  it('calls a record offline-ready only for a successful install against this build', () => {
    const state = { ready: true, features: ['Scene3D'], build: 'abc123', at: 1 };
    expect(isOfflineReady({ offline: state }, 'abc123')).toBe(true);
    expect(isOfflineReady({ offline: state }, 'def456')).toBe(false);
    expect(isOfflineReady({ offline: { ...state, ready: false } }, 'abc123')).toBe(false);
    expect(isOfflineReady({}, 'abc123')).toBe(false);
  });
});
