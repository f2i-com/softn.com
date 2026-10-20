// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const glue = vi.hoisted(() => ({ initialize: vi.fn(), execute: vi.fn(), seen: [] as unknown[] }));
vi.mock('../wasm-zipp/zipp_wasm.js', () => ({
  default: glue.initialize,
  zipp_install_panic_hook: vi.fn(),
}));
vi.mock('../src/runtime/sandbox-execute', () => ({ executeSandbox: glue.execute }));

const engineBytes = () => new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
const workers: FakeWorker[] = [];
class FakeWorker {
  onmessage: (event: { data: unknown }) => void = () => {};
  onerror: () => void = () => {};
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() { workers.push(this); }
}

/** What a sandbox worker was posted first: its job, and the engine with it. */
async function firstMessage(worker: FakeWorker): Promise<{ source: string; zippWasm?: unknown }> {
  await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalled());
  return worker.postMessage.mock.calls[0][0];
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  workers.length = 0;
  glue.seen.length = 0;
  glue.initialize.mockReset().mockImplementation(async ({ module_or_path }: { module_or_path: unknown }) => {
    glue.seen.push(await module_or_path);
    return {};
  });
  glue.execute.mockReset().mockReturnValue('guest result');
});
afterEach(() => vi.unstubAllGlobals());

describe('the engine in sandbox workers', () => {
  it('is the page’s compiled module, posted once per worker and again to a replacement', async () => {
    const { configureZippWasmSource } = await import('../src/runtime/zipp-wasm-loader');
    configureZippWasmSource(engineBytes());
    const { SandboxHost } = await import('../src/runtime/sandbox-host');
    vi.stubGlobal('Worker', FakeWorker);
    const host = new SandboxHost();
    const first = host.run('source', '{}');
    // The worker exists at once; its first message waits for the engine.
    expect(workers).toHaveLength(1);
    const { zippWasm: engine } = await firstMessage(workers[0]);
    expect(engine).toBeInstanceOf(WebAssembly.Module);
    workers[0].onmessage({ data: { value: 1 } });
    await first;
    const second = host.run('source', '{}');
    expect(workers[0].postMessage.mock.calls[1][0]).not.toHaveProperty('zippWasm');
    workers[0].onmessage({ data: { error: 'guest failed' } });
    await second;
    const restarted = host.run('source', '{}');
    expect(workers).toHaveLength(2);
    expect((await firstMessage(workers[1])).zippWasm).toBe(engine);
    host.dispose();
    await expect(restarted).resolves.toEqual({ error: 'Sandbox cancelled' });
  });

  it('is an error the caller hears when the page cannot compile one', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('missing', { status: 404 })));
    const { SandboxHost } = await import('../src/runtime/sandbox-host');
    vi.stubGlobal('Worker', FakeWorker);
    const host = new SandboxHost();
    const result = (await host.run('source', '{}')) as { error: string };
    expect(result.error).toMatch(/^Sandbox engine unavailable: .*zipp_wasm_bg\.wasm\) answered 404/);
    expect(workers[0].terminate).toHaveBeenCalled();
    host.dispose();
  });

  it('initializes the worker from the first message and keeps later guest calls warm', async () => {
    const workerScope = { onmessage: null as unknown as (event: { data: unknown }) => Promise<void>, postMessage: vi.fn() };
    vi.stubGlobal('self', workerScope);
    await import('../src/runtime/sandbox-worker');
    const engine = new WebAssembly.Module(engineBytes());
    await workerScope.onmessage({ data: { source: 'first', input: {}, zippWasm: engine } });
    await workerScope.onmessage({ data: { source: 'second', input: {} } });
    expect(glue.initialize).toHaveBeenCalledOnce();
    expect(glue.seen).toEqual([engine]);
    expect(glue.execute).toHaveBeenCalledTimes(2);
    expect(workerScope.postMessage.mock.calls.map(([message]) => message)).toEqual([
      { ready: true }, { value: 'guest result' }, { ready: true }, { value: 'guest result' },
    ]);
    await workerScope.onmessage({ data: { source: 'third', input: {}, zippWasm: engine } });
    expect(workerScope.postMessage).toHaveBeenLastCalledWith({ error: 'Error: The sandbox engine is already initialized' });
    expect(glue.execute).toHaveBeenCalledTimes(2);
  });

  it('has no engine of its own to fall back on', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('missing', { status: 404 })));
    const workerScope = { onmessage: null as unknown as (event: { data: unknown }) => Promise<void>, postMessage: vi.fn() };
    vi.stubGlobal('self', workerScope);
    await import('../src/runtime/sandbox-worker');
    await workerScope.onmessage({ data: { source: 'source', input: {} } });
    expect(workerScope.postMessage).toHaveBeenLastCalledWith({ error: expect.stringMatching(/zipp_wasm_bg\.wasm\) answered 404/) });
    expect(glue.execute).not.toHaveBeenCalled();
  });
});
