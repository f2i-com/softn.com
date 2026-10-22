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
  it('is counted, and the response fetched is the one compiled', async () => {
    vi.resetModules();
    const fetched = new Response(streamOf(8, 8), {
      headers: { 'Content-Type': 'application/wasm', 'Content-Length': '16' },
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fetched);
    let compiled: unknown;
    const module = {} as WebAssembly.Module;
    vi.spyOn(WebAssembly, 'compileStreaming').mockImplementation(async (source) => {
      compiled = await source;
      await (compiled as Response).arrayBuffer();
      return module;
    });
    const loader = await import('../src/runtime/zipp-wasm-loader');
    const progress = await import('../src/runtime/load-progress');
    await expect(loader.zippEngineForWorker()).resolves.toBe(module);
    expect(compiled).toBe(fetched);
    await frame();
    expect(progress.loadProgressItems().find((entry) => entry.id === 'engine')).toMatchObject({
      kind: 'engine',
      loaded: 16,
      total: 16,
      done: true,
    });
  });
});
