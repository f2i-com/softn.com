/**
 * What the page is downloading to run its apps, for a host's progress bar
 * (src/runtime/load-progress.ts), and the engine's download counted into it
 * without changing what is compiled.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  countResponse,
  loadProgressItems,
  resetLoadProgressForTests,
  responseBodyLength,
  subscribeLoadProgress,
  trackLoad,
} from '../src/runtime/load-progress';

const frame = () => new Promise((resolve) => setTimeout(resolve, 40));
const item = (id: string) => loadProgressItems().find((entry) => entry.id === id);

function streamOf(...chunks: number[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const size of chunks) controller.enqueue(new Uint8Array(size));
      controller.close();
    },
  });
}

beforeEach(() => resetLoadProgressForTests());
afterEach(() => vi.restoreAllMocks());

describe('a download', () => {
  it('counts its bytes, and is done when it finishes', () => {
    const handle = trackLoad('engine', 'engine', { total: 100 });
    handle.advance(40);
    expect(item('engine')).toMatchObject({ kind: 'engine', loaded: 40, total: 100, done: false });
    handle.finish();
    expect(item('engine')).toMatchObject({ loaded: 100, done: true, failed: false });
  });

  it('started again while in flight is joined, and done when every start is', () => {
    const first = trackLoad('components:charts', 'components', { name: 'charts' });
    const second = trackLoad('components:charts', 'components', { name: 'charts' });
    expect(loadProgressItems()).toHaveLength(1);
    first.finish();
    expect(item('components:charts')?.done).toBe(false);
    second.finish();
    expect(item('components:charts')?.done).toBe(true);
  });

  it('started again once done begins afresh, and the old start changes nothing', () => {
    const failed = trackLoad('components:media', 'components');
    failed.fail();
    expect(item('components:media')).toMatchObject({ done: true, failed: true });
    const retry = trackLoad('components:media', 'components');
    expect(item('components:media')).toMatchObject({ done: false, failed: false, loaded: 0 });
    failed.advance(10);
    failed.finish();
    expect(item('components:media')).toMatchObject({ done: false, loaded: 0 });
    retry.finish();
    expect(item('components:media')?.done).toBe(true);
  });

  it('forgets what finished longest ago in a long session', () => {
    for (let i = 0; i < 100; i++) trackLoad(`bundle:${i}`, 'bundle').finish();
    expect(loadProgressItems().length).toBeLessThanOrEqual(64);
    expect(item('bundle:99')).toBeDefined();
    expect(item('bundle:0')).toBeUndefined();
  });

  it('tells its listeners at most once a frame', async () => {
    const heard = vi.fn();
    const stop = subscribeLoadProgress(heard);
    const handle = trackLoad('engine', 'engine', { total: 1000 });
    for (let i = 0; i < 50; i++) handle.advance(10);
    await frame();
    expect(heard).toHaveBeenCalledTimes(1);
    stop();
    handle.finish();
    await frame();
    expect(heard).toHaveBeenCalledTimes(1);
  });
});

describe("a component's chunk", () => {
  it('is on the list when something asks for it to draw, and not when a host loads it quietly', async () => {
    const { ComponentRegistry } = await import('../src/renderer/registry');
    const registry = new ComponentRegistry();
    const Hello = () => null;
    registry.registerLazy('LineChart', async () => Hello, { feature: 'charts' });
    registry.registerLazy('Scene3D', async () => Hello, { feature: 'scene3d' });
    await registry.load('Scene3D', { quiet: true });
    await registry.retry('Scene3D', { quiet: true });
    expect(item('components:scene3d')).toBeUndefined();
    await registry.load('LineChart');
    expect(item('components:charts')).toMatchObject({ kind: 'components', name: 'charts', done: true });
  });
});

describe('counting a response', () => {
  it('reads a clone, so the response itself still has its whole body', async () => {
    const response = new Response(streamOf(3, 4, 5));
    countResponse(response, trackLoad('bundle:a', 'bundle', { total: 12 }));
    expect((await response.arrayBuffer()).byteLength).toBe(12);
    await frame();
    expect(item('bundle:a')).toMatchObject({ loaded: 12, done: true });
  });

  it('takes the length a server gives, unless the body is compressed in transit', () => {
    expect(responseBodyLength(new Response('x', { headers: { 'Content-Length': '1234' } }))).toBe(1234);
    expect(
      responseBodyLength(new Response('x', { headers: { 'Content-Length': '1234', 'Content-Encoding': 'br' } }))
    ).toBeUndefined();
    expect(responseBodyLength(new Response('x'))).toBeUndefined();
  });
});

describe("the engine's download", () => {
  /** A fresh loader whose fetch answers the engine, and says whether the browser already holds it. */
  async function engineLoader(onDevice: boolean) {
    vi.resetModules();
    const fetched = new Response(streamOf(8, 8), {
      headers: { 'Content-Type': 'application/wasm', 'Content-Length': '16' },
    });
    // As a browser answers it: a miss with `only-if-cached` is a network error.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      if (init?.cache !== 'only-if-cached') return fetched;
      if (onDevice) return new Response('held');
      throw new TypeError('Failed to fetch');
    });
    const seen: { compiled?: unknown } = {};
    const module = {} as WebAssembly.Module;
    vi.spyOn(WebAssembly, 'compileStreaming').mockImplementation(async (source) => {
      seen.compiled = await source;
      await (seen.compiled as Response).arrayBuffer();
      return module;
    });
    const loader = await import('../src/runtime/zipp-wasm-loader');
    const progress = await import('../src/runtime/load-progress');
    return { fetched, fetchSpy, seen, module, loader, progress };
  }

  it('is counted when it comes over the network, and the response fetched is the one compiled', async () => {
    const { fetched, seen, module, loader, progress } = await engineLoader(false);
    await expect(loader.zippEngineForWorker()).resolves.toBe(module);
    expect(seen.compiled).toBe(fetched);
    await frame();
    expect(progress.loadProgressItems().find((entry) => entry.id === 'engine')).toMatchObject({
      kind: 'engine',
      loaded: 16,
      total: 16,
      done: true,
    });
  });

  it('is not counted, nor read beside the compile, when the browser already holds it', async () => {
    const { fetched, fetchSpy, seen, module, loader, progress } = await engineLoader(true);
    await expect(loader.zippEngineForWorker()).resolves.toBe(module);
    expect(seen.compiled).toBe(fetched);
    // Asked of the cache alone, never of the network.
    expect(fetchSpy.mock.calls[0][1]).toMatchObject({ cache: 'only-if-cached', mode: 'same-origin' });
    await frame();
    expect(progress.loadProgressItems().find((entry) => entry.id === 'engine')).toBeUndefined();
  });
});
