// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const glue = vi.hoisted(() => ({ initialize: vi.fn(), installPanicHook: vi.fn(), profile: vi.fn(), seen: [] as unknown[] }));
vi.mock('../wasm-zipp/zipp_wasm.js', () => ({
  default: glue.initialize,
  zipp_install_panic_hook: glue.installPanicHook,
  zippProfile: glue.profile,
}));

const emptyModuleBytes = () => new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);

/** The glue as it behaves: it reads the source it was handed (a thenable here) and instantiates it. */
function glueInstantiates(result: unknown = {}) {
  glue.initialize.mockImplementation(async ({ module_or_path }: { module_or_path: unknown }) => {
    glue.seen.push(await module_or_path);
    return result;
  });
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  glue.initialize.mockReset();
  glue.profile.mockReset();
  glue.seen.length = 0;
});
afterEach(() => vi.unstubAllGlobals());

describe('shared ZIPP initialization', () => {
  it('shares one initialization and compiles a snapshot of supplied bytes without fetching', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const loader = await import('../src/runtime/zipp-wasm-loader');
    const bytes = emptyModuleBytes();
    loader.configureZippWasmSource(bytes);
    // A copy was taken: zeroed, these bytes are not a module any more.
    bytes.fill(0);
    const exports = { memory: new WebAssembly.Memory({ initial: 1 }) };
    glueInstantiates(exports);
    const first = loader.ensureZippWasm();
    const second = loader.ensureZippWasm();
    expect(first).toBe(second);
    expect(await first).toBe(exports);
    expect(glue.initialize).toHaveBeenCalledOnce();
    expect(glue.seen[0]).toBeInstanceOf(WebAssembly.Module);
    expect(glue.installPanicHook).toHaveBeenCalledTimes(1);
    expect(await loader.ensureZippWasm()).toBe(exports);
    expect(glue.initialize).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('compiles nothing when the glue already holds an engine', async () => {
    const loader = await import('../src/runtime/zipp-wasm-loader');
    loader.configureZippWasmSource(new Uint8Array(8));
    // An initialized glue returns at once, without reading its argument.
    glue.initialize.mockResolvedValue({});
    await expect(loader.ensureZippWasm()).resolves.toEqual({});
  });

  it('fetches the engine from beside its chunk when no source was configured, and freezes the source first', async () => {
    const fetch = vi.fn(async () => new Response(emptyModuleBytes(), { headers: { 'Content-Type': 'application/wasm' } }));
    vi.stubGlobal('fetch', fetch);
    const loader = await import('../src/runtime/zipp-wasm-loader');
    glueInstantiates();
    const ready = loader.ensureZippWasm();
    expect(() => loader.configureZippWasmSource(emptyModuleBytes())).toThrow(/before initialization/);
    await ready;
    expect(String((fetch.mock.calls[0] as unknown[])[0])).toMatch(/\/zipp_wasm_bg\.wasm$/);
    expect(glue.seen[0]).toBeInstanceOf(WebAssembly.Module);
  });

  it('says which file failed when the engine cannot be fetched', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('missing', { status: 404 })));
    const loader = await import('../src/runtime/zipp-wasm-loader');
    glueInstantiates();
    await expect(loader.ensureZippWasm()).rejects.toThrow(/zipp_wasm_bg\.wasm\) answered 404/);
  });

  it('retries a failed load using the same configured source', async () => {
    const loader = await import('../src/runtime/zipp-wasm-loader');
    loader.configureZippWasmSource(emptyModuleBytes().buffer);
    glue.initialize
      .mockImplementationOnce(async ({ module_or_path }: { module_or_path: unknown }) => {
        glue.seen.push(await module_or_path);
        throw new Error('temporary startup failure');
      })
      .mockImplementationOnce(async ({ module_or_path }: { module_or_path: unknown }) => {
        glue.seen.push(await module_or_path);
        return {};
      });
    await expect(loader.ensureZippWasm()).rejects.toThrow('temporary startup failure');
    expect(() => loader.configureZippWasmSource(emptyModuleBytes())).toThrow(/before initialization/);
    await loader.ensureZippWasm();
    expect(glue.initialize).toHaveBeenCalledTimes(2);
    // Compiled once: the retry instantiates the same module.
    expect(glue.seen[1]).toBe(glue.seen[0]);
    expect(glue.installPanicHook).toHaveBeenCalledTimes(1);
  });

  it('copies only the selected byte range of a view', async () => {
    const loader = await import('../src/runtime/zipp-wasm-loader');
    const padded = new Uint8Array(12);
    padded.set(emptyModuleBytes(), 2);
    // Read whole, the buffer starts with two zero bytes and is no module.
    loader.configureZippWasmSource(new DataView(padded.buffer, 2, 8));
    glueInstantiates();
    await loader.ensureZippWasm();
    expect(glue.seen[0]).toBeInstanceOf(WebAssembly.Module);
  });

  it('accepts immutable compiled modules and rejects non-byte sources', async () => {
    const loader = await import('../src/runtime/zipp-wasm-loader');
    expect(() => loader.configureZippWasmSource('untrusted-url' as never)).toThrow(/module or engine bytes/);
    expect(() => loader.configureZippWasmSource(new ArrayBuffer(0))).toThrow(/module or engine bytes/);
    const module = new WebAssembly.Module(emptyModuleBytes());
    loader.configureZippWasmSource(module);
    glueInstantiates();
    await loader.ensureZippWasm();
    expect(glue.seen[0]).toBe(module);
  });
});

/**
 * One engine file per app: the page compiles it once and posts the module to
 * every worker it starts, which has no copy of its own to fetch.
 */
describe('the engine a worker is handed', () => {
  it('is the module this realm runs, compiled once, and fixes the source', async () => {
    const loader = await import('../src/runtime/zipp-wasm-loader');
    loader.configureZippWasmSource(emptyModuleBytes());
    const forWorker = await loader.zippEngineForWorker();
    expect(forWorker).toBeInstanceOf(WebAssembly.Module);
    expect(await loader.zippEngineForWorker()).toBe(forWorker);
    expect(() => loader.configureZippWasmSource(emptyModuleBytes())).toThrow(/before initialization/);
    glueInstantiates();
    await loader.ensureZippWasm();
    expect(glue.seen[0]).toBe(forWorker);
  });

  it('is what a worker runs, unless its realm already started an engine', async () => {
    const loader = await import('../src/runtime/zipp-wasm-loader');
    const posted = new WebAssembly.Module(emptyModuleBytes());
    loader.adoptZippWasmSource(posted);
    glueInstantiates();
    await loader.ensureZippWasm();
    expect(glue.seen[0]).toBe(posted);
    // A worker's code run in the page's realm (tests): the engine is running, and stays.
    expect(() => loader.adoptZippWasmSource(new WebAssembly.Module(emptyModuleBytes()))).not.toThrow();
    await loader.ensureZippWasm();
    expect(glue.initialize).toHaveBeenCalledOnce();
  });
});

/**
 * ZIPP builds as a JavaScript-only engine and as a JavaScript-and-Python one,
 * from the same glue and with the same exports. A host handed the wrong one
 * cannot tell from its own records which it has, so it asks the engine.
 */
describe('the loaded engine’s languages', () => {
  it('come from the engine itself, after it has been initialized', async () => {
    const loader = await import('../src/runtime/zipp-wasm-loader');
    glue.initialize.mockResolvedValue({});
    glue.profile.mockReturnValue(JSON.stringify({ version: '0.0.18', languages: ['javascript', 'python'] }));
    await expect(loader.zippLanguages()).resolves.toEqual(['javascript', 'python']);
    expect(glue.initialize).toHaveBeenCalledOnce();
    // Asking loaded the engine, so the source is frozen from here on.
    expect(() => loader.configureZippWasmSource(emptyModuleBytes())).toThrow(/before initialization/);
  });

  it('are empty when the engine reports none it can be believed about', async () => {
    const loader = await import('../src/runtime/zipp-wasm-loader');
    glue.initialize.mockResolvedValue({});
    glue.profile.mockReturnValueOnce('not json');
    await expect(loader.zippLanguages()).resolves.toEqual([]);
    glue.profile.mockReturnValueOnce(JSON.stringify({ version: '0.0.18' }));
    await expect(loader.zippLanguages()).resolves.toEqual([]);
    glue.profile.mockReturnValueOnce(JSON.stringify({ languages: ['javascript', 7, null] }));
    await expect(loader.zippLanguages()).resolves.toEqual(['javascript']);
  });
});
