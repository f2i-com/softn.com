// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const glue = vi.hoisted(() => ({ initialize: vi.fn(), installPanicHook: vi.fn(), profile: vi.fn() }));
vi.mock('../wasm-zipp/zipp_wasm.js', () => ({
  default: glue.initialize,
  zipp_install_panic_hook: glue.installPanicHook,
  zippProfile: glue.profile,
}));

const emptyModuleBytes = () => new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  glue.initialize.mockReset();
  glue.profile.mockReset();
});

describe('shared ZIPP initialization', () => {
  it('shares one initialization and snapshots supplied bytes without fetching', async () => {
    const loader = await import('../src/runtime/zipp-wasm-loader');
    const bytes = emptyModuleBytes();
    loader.configureZippWasmSource(bytes);
    bytes.fill(0);
    const exports = { memory: new WebAssembly.Memory({ initial: 1 }) };
    glue.initialize.mockResolvedValue(exports);
    const first = loader.ensureZippWasm();
    const second = loader.ensureZippWasm();
    expect(first).toBe(second);
    expect(await first).toBe(exports);
    expect(glue.initialize).toHaveBeenCalledExactlyOnceWith({ module_or_path: emptyModuleBytes() });
    expect(glue.installPanicHook).toHaveBeenCalledTimes(1);
    expect(await loader.ensureZippWasm()).toBe(exports);
    expect(glue.initialize).toHaveBeenCalledTimes(1);
  });

  it('freezes the source before the initialization microtask can run', async () => {
    const loader = await import('../src/runtime/zipp-wasm-loader');
    glue.initialize.mockResolvedValue({});
    const ready = loader.ensureZippWasm();
    expect(() => loader.configureZippWasmSource(emptyModuleBytes())).toThrow(/before initialization/);
    await ready;
    expect(glue.initialize).toHaveBeenCalledWith();
  });

  it('retries a failed load using the same configured source', async () => {
    const loader = await import('../src/runtime/zipp-wasm-loader');
    loader.configureZippWasmSource(emptyModuleBytes().buffer);
    glue.initialize.mockRejectedValueOnce(new Error('temporary startup failure')).mockResolvedValueOnce({});
    await expect(loader.ensureZippWasm()).rejects.toThrow('temporary startup failure');
    expect(() => loader.configureZippWasmSource(emptyModuleBytes())).toThrow(/before initialization/);
    await loader.ensureZippWasm();
    expect(glue.initialize).toHaveBeenCalledTimes(2);
    expect(glue.initialize.mock.calls[0][0]).toEqual(glue.initialize.mock.calls[1][0]);
    expect(glue.installPanicHook).toHaveBeenCalledTimes(1);
  });

  it('copies only the selected byte range of a view', async () => {
    const loader = await import('../src/runtime/zipp-wasm-loader');
    const padded = new Uint8Array(12);
    padded.set(emptyModuleBytes(), 2);
    loader.configureZippWasmSource(new DataView(padded.buffer, 2, 8));
    glue.initialize.mockResolvedValue({});
    await loader.ensureZippWasm();
    expect(glue.initialize).toHaveBeenCalledWith({ module_or_path: emptyModuleBytes() });
  });

  it('accepts immutable compiled modules and rejects non-byte sources', async () => {
    const loader = await import('../src/runtime/zipp-wasm-loader');
    expect(() => loader.configureZippWasmSource('untrusted-url' as never)).toThrow(/module or engine bytes/);
    expect(() => loader.configureZippWasmSource(new ArrayBuffer(0))).toThrow(/module or engine bytes/);
    const module = new WebAssembly.Module(emptyModuleBytes());
    loader.configureZippWasmSource(module);
    glue.initialize.mockResolvedValue({});
    await loader.ensureZippWasm();
    expect(glue.initialize).toHaveBeenCalledWith({ module_or_path: module });
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
