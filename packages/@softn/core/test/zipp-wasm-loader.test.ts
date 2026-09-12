// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const glue = vi.hoisted(() => ({ initialize: vi.fn(), installPanicHook: vi.fn() }));
vi.mock('../wasm-zipp/zipp_wasm.js', () => ({
  default: glue.initialize,
  zipp_install_panic_hook: glue.installPanicHook,
}));

const emptyModuleBytes = () => new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  glue.initialize.mockReset();
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
