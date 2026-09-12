// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const glue = vi.hoisted(() => ({ initialize: vi.fn(), execute: vi.fn() }));
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

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  workers.length = 0;
  glue.initialize.mockReset().mockResolvedValue({});
  glue.execute.mockReset().mockReturnValue('guest result');
});
afterEach(() => vi.unstubAllGlobals());

describe('configured source in sandbox workers', () => {
  it('sends immutable bytes once per worker and reuses them after a failed worker', async () => {
    const { configureZippWasmSource } = await import('../src/runtime/zipp-wasm-loader');
    configureZippWasmSource(engineBytes());
    const { SandboxHost } = await import('../src/runtime/sandbox-host');
    vi.stubGlobal('Worker', FakeWorker);
    const host = new SandboxHost();
    const first = host.run('source', '{}');
    const firstSource = workers[0].postMessage.mock.calls[0][0].zippWasm;
    expect(firstSource).toEqual(engineBytes());
    workers[0].onmessage({ data: { value: 1 } });
    await first;
    const second = host.run('source', '{}');
    expect(workers[0].postMessage.mock.calls[1][0]).not.toHaveProperty('zippWasm');
    workers[0].onmessage({ data: { error: 'guest failed' } });
    await second;
    firstSource.fill(0);
    const restarted = host.run('source', '{}');
    expect(workers).toHaveLength(2);
    expect(workers[1].postMessage.mock.calls[0][0].zippWasm).toEqual(engineBytes());
    host.dispose();
    await expect(restarted).resolves.toEqual({ error: 'Sandbox cancelled' });
  });

  it('initializes from the first supplied source and keeps later guest calls warm', async () => {
    const workerScope = { onmessage: null as unknown as (event: { data: unknown }) => Promise<void>, postMessage: vi.fn() };
    vi.stubGlobal('self', workerScope);
    await import('../src/runtime/sandbox-worker');
    await workerScope.onmessage({ data: { source: 'first', input: {}, zippWasm: engineBytes().buffer } });
    await workerScope.onmessage({ data: { source: 'second', input: {} } });
    expect(glue.initialize).toHaveBeenCalledExactlyOnceWith({ module_or_path: engineBytes() });
    expect(glue.execute).toHaveBeenCalledTimes(2);
    expect(workerScope.postMessage.mock.calls.map(([message]) => message)).toEqual([
      { ready: true }, { value: 'guest result' }, { ready: true }, { value: 'guest result' },
    ]);
    await workerScope.onmessage({ data: { source: 'third', input: {}, zippWasm: engineBytes() } });
    expect(workerScope.postMessage).toHaveBeenLastCalledWith({ error: 'Error: The sandbox engine is already initialized' });
    expect(glue.execute).toHaveBeenCalledTimes(2);
  });

  it('preserves the default loader when no host source was configured', async () => {
    const workerScope = { onmessage: null as unknown as (event: { data: unknown }) => Promise<void>, postMessage: vi.fn() };
    vi.stubGlobal('self', workerScope);
    await import('../src/runtime/sandbox-worker');
    await workerScope.onmessage({ data: { source: 'source', input: {} } });
    expect(glue.initialize).toHaveBeenCalledExactlyOnceWith();
  });
});
