/**
 * A web container is installed for offline use: the container's own files for the tiers its
 * pages start on, and what it draws with, fetched through the service worker and reported
 * `ready` only when all of it is held. Such an app's card used to say "Needs connection" for
 * good: no install was ever started for one.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ContainerRuntimeNeeds, ZippEngineTier } from '@softn/container';
import { installContainerOffline, type ContainerInstallModule, type ContainerInstallOptions } from '../src/lib/containerOfflineInstall';

const FOLDER = 'https://softn.test/shared/container-runtime/e03138f892dd/';
const ENGINES: Record<ZippEngineTier, string> = {
  lite: 'zipp-javascript-lite.wasm',
  javascript: 'zipp-javascript.wasm',
  typescript: 'zipp-typescript.wasm',
  python: 'zipp-python-base.wasm',
  'python-torch': 'zipp-python-base.wasm',
};

function container(needs: Partial<ContainerRuntimeNeeds>, absent: string[] = []): ContainerInstallModule & { preloaded: unknown[] } {
  const preloaded: unknown[] = [];
  return {
    preloaded,
    containerRuntimeNeeds: async () => ({ tiers: ['lite'], three: false, models: false, extensions: [], ...needs }),
    preloadContainerFeatures: async (wanted, options) => {
      preloaded.push({ wanted, hostThree: typeof options?.hostThree });
      return absent;
    },
    engineFileFor: (tier) => ENGINES[tier],
    // As the container has it: an engine that says what it is runs under that variant's bindings.
    glueFileFor: (tier, meta) => (meta?.variant === 'javascript-python-base' ? 'zipp-python-base.glue.js' : ENGINES[tier].replace(/\.wasm$/, '.glue.js')),
  };
}

function serve(missing: string[] = []) {
  return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const ok = !missing.some((name) => String(input).endsWith(name));
    return { ok, status: ok ? 200 : 404, arrayBuffer: async () => new ArrayBuffer(4) } as unknown as Response;
  });
}

function options(module: ContainerInstallModule, extra: Partial<ContainerInstallOptions> = {}): ContainerInstallOptions {
  return {
    cacheHolder: async () => true,
    container: async () => module,
    host: () => ({ runtimeUrl: FOLDER, hostThree: async () => ({}) }),
    ...extra,
  };
}

const app = (id: string) => ({ id, source: new Uint8Array([1, 2, 3]) });
const asked = (fetch: ReturnType<typeof serve>): string[] => fetch.mock.calls.map(([input]) => String(input).slice(FOLDER.length)).sort();

describe('installing a web container for offline use', () => {
  it('holds the Worker, and the lite engine with its bindings, for an app of plain script', async () => {
    const fetch = serve();
    const result = await installContainerOffline(app('plain'), options(container({}), { fetch: fetch as unknown as typeof globalThis.fetch }));
    expect(result).toMatchObject({ ready: true, missing: [], features: ['engine:lite'], workerAssets: 'not-needed', optionalOnline: [] });
    expect(asked(fetch)).toEqual(['container-worker.js', 'engines/zipp-javascript-lite.glue.js', 'engines/zipp-javascript-lite.wasm']);
    // Past the HTTP cache, so that each request reaches the service worker's route.
    for (const [, init] of fetch.mock.calls) expect(init).toMatchObject({ cache: 'reload', credentials: 'same-origin' });
  });

  it('fetches no engine for a tier that runs on the engine the shell already holds: its bindings alone', async () => {
    const fetch = serve();
    const result = await installContainerOffline(
      app('formats'),
      options(container({ tiers: ['javascript', 'python'] }), { fetch: fetch as unknown as typeof globalThis.fetch })
    );
    expect(result.ready).toBe(true);
    expect(asked(fetch)).toEqual(['container-worker.js', 'engines/zipp-python-base.glue.js']);
  });

  it('holds every tier a page of the app starts on', async () => {
    const fetch = serve();
    await installContainerOffline(app('two-tiers'), options(container({ tiers: ['lite', 'typescript'] }), { fetch: fetch as unknown as typeof globalThis.fetch }));
    expect(asked(fetch)).toEqual([
      'container-worker.js',
      'engines/zipp-javascript-lite.glue.js',
      'engines/zipp-javascript-lite.wasm',
      'engines/zipp-typescript.glue.js',
      'engines/zipp-typescript.wasm',
    ]);
  });

  it('loads what a 3D scene and the built-in elements need, with the host’s own Three.js', async () => {
    const module = container({ three: true, models: true, extensions: ['softn-chart'] });
    const result = await installContainerOffline(app('scene'), options(module, { fetch: serve() as unknown as typeof globalThis.fetch }));
    expect(result.ready).toBe(true);
    expect(result.features).toEqual(['engine:lite', 'softn-chart', 'three']);
    expect(module.preloaded).toEqual([{ wanted: { tiers: ['lite'], three: true, models: true, extensions: ['softn-chart'] }, hostThree: 'function' }]);
  });

  it('is not ready, and says what is missing, when a file or a part did not arrive', async () => {
    const lost = await installContainerOffline(
      app('lost-engine'),
      options(container({}), { fetch: serve(['zipp-javascript-lite.wasm']) as unknown as typeof globalThis.fetch })
    );
    expect(lost.ready).toBe(false);
    expect(lost.missing).toEqual(['engines/zipp-javascript-lite.wasm']);

    const noThree = await installContainerOffline(
      app('lost-three'),
      options(container({ three: true }, ['Three.js']), { fetch: serve() as unknown as typeof globalThis.fetch })
    );
    expect(noThree.ready).toBe(false);
    expect(noThree.missing).toEqual(['Three.js']);

    // A request that fails outright is a file not held.
    const down = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const offline = await installContainerOffline(app('down'), options(container({}), { fetch: down as unknown as typeof globalThis.fetch }));
    expect(offline.ready).toBe(false);
    expect(offline.missing).toHaveLength(3);
  });

  it('fetches nothing when nothing would keep it', async () => {
    const fetch = serve();
    const load = vi.fn(async () => container({}));
    const result = await installContainerOffline(app('no-worker'), {
      cacheHolder: async () => false,
      container: load,
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    expect(result.ready).toBe(false);
    expect(result.error).toMatch(/service worker/);
    expect(fetch).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  });

  it('runs once for two opens of one app, and says so when its tab was closed', async () => {
    const fetch = serve();
    const opts = options(container({}), { fetch: fetch as unknown as typeof globalThis.fetch });
    const [first, second] = await Promise.all([installContainerOffline(app('twice'), opts), installContainerOffline(app('twice'), opts)]);
    expect(first).toBe(second);
    expect(fetch).toHaveBeenCalledTimes(3);

    const closed = new AbortController();
    closed.abort();
    const cancelled = await installContainerOffline(app('closed'), options(container({}), { signal: closed.signal, fetch: serve() as unknown as typeof globalThis.fetch }));
    expect(cancelled).toMatchObject({ ready: false, error: 'The install was cancelled.' });
  });

  it('an archive that cannot be read is an install that did not finish, not an exception', async () => {
    const broken: ContainerInstallModule = {
      ...container({}),
      containerRuntimeNeeds: async () => {
        throw new Error('not a zip');
      },
    };
    const result = await installContainerOffline(app('broken'), options(broken, { fetch: serve() as unknown as typeof globalThis.fetch }));
    expect(result.ready).toBe(false);
    expect(result.error).toMatch(/could not be read: not a zip/);
  });
});
