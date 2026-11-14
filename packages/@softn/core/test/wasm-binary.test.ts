// @vitest-environment node
/**
 * wasm-binary.ts: what a module's bytes say, and the memory ceiling written
 * into them. The ceiling is checked by the engine itself: a module limited
 * here is refused memory.grow past it.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { capWasmMemory, moduleKind, readWasmModule, WasmFormatError, WasmLimitError } from '../src/runtime/wasm/wasm-binary';
import { buildModule, op } from './helpers/wasm-builder';

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/wasm/${name}`, import.meta.url)));

describe('readWasmModule', () => {
  it('reads a library’s exports with their signatures', () => {
    const info = readWasmModule(fixture('calc.wasm'));
    const byName = Object.fromEntries(info.exports.map((e) => [e.name, e]));
    expect(byName.add).toEqual({ name: 'add', kind: 'function', type: { params: ['i32', 'i32'], results: ['i32'] } });
    expect(byName.add64.type).toEqual({ params: ['i64', 'i64'], results: ['i64'] });
    expect(byName.scale.type).toEqual({ params: ['f64', 'f64'], results: ['f64'] });
    expect(byName.shout.type).toEqual({ params: ['i32', 'i32'], results: ['i64'] });
    expect(byName.memory.kind).toBe('memory');
    expect(info.typesRead).toBe(true);
    expect(info.memories.length).toBe(1);
    expect(moduleKind(info)).toBe('library');
  });

  it('reads a WASI command’s imports and calls it a command', () => {
    const info = readWasmModule(fixture('wasi_tool.wasm'));
    const wasi = info.imports.filter((i) => i.module === 'wasi_snapshot_preview1').map((i) => i.name);
    expect(wasi).toEqual(expect.arrayContaining(['fd_write', 'proc_exit', 'args_get', 'path_open']));
    const fdWrite = info.imports.find((i) => i.name === 'fd_write');
    expect(fdWrite).toMatchObject({ kind: 'function', type: { params: ['i32', 'i32', 'i32', 'i32'], results: ['i32'] } });
    expect(moduleKind(info)).toBe('command');
  });

  it('reads a program’s softn imports', () => {
    const info = readWasmModule(fixture('screen.wasm'));
    const softn = info.imports.filter((i) => i.module === 'softn').map((i) => i.name).sort();
    expect(softn).toEqual(['audio', 'audio_rate', 'log', 'post', 'present']);
    expect(info.exports.find((e) => e.name === 'frame')?.type).toEqual({ params: ['f64'], results: [] });
  });

  it('reads imported memories, tables and globals with their limits and types', () => {
    const bytes = buildModule({
      types: [{ params: [], results: [] }],
      imports: [
        { module: 'env', name: 'memory', kind: 'memory', min: 2, max: 10 },
        { module: 'env', name: 'table', kind: 'table', min: 1, element: 'funcref' },
        { module: 'env', name: 'base', kind: 'global', type: 'i32' },
        { module: 'env', name: 'tick', kind: 'func', type: 0 },
      ],
    });
    const info = readWasmModule(bytes);
    expect(info.imports).toEqual([
      { module: 'env', name: 'memory', kind: 'memory', limits: { min: 2, max: 10 } },
      { module: 'env', name: 'table', kind: 'table', element: 'funcref', limits: { min: 1 } },
      { module: 'env', name: 'base', kind: 'global', type: 'i32', mutable: false },
      { module: 'env', name: 'tick', kind: 'function', type: { params: [], results: [] } },
    ]);
  });

  it('says plainly what is no module, a component, or a cut file', () => {
    expect(() => readWasmModule(new TextEncoder().encode('<html>not wasm</html>'))).toThrow(/not a WebAssembly module/);
    expect(() => readWasmModule(buildModule({ version: [0x0d, 0x00, 0x01, 0x00] }))).toThrow(/component model/);
    const whole = fixture('calc.wasm');
    expect(() => readWasmModule(whole.subarray(0, whole.length - 10))).toThrow(WasmFormatError);
  });

  it('leaves signatures unknown, rather than guessed, for a type it cannot read', () => {
    // A type section whose entry is an encoding the reader does not know (0x5d).
    const bytes = buildModule({ raw: [[1, [1, 0x5d, 0]]] });
    const info = readWasmModule(bytes);
    expect(info.typesRead).toBe(false);
  });
});

describe('capWasmMemory', () => {
  // Memory of `min` pages, at most `max`, and grow(n) → old size or -1.
  const growable = (min: number, max?: number) =>
    buildModule({
      types: [{ params: ['i32'], results: ['i32'] }],
      funcs: [{ type: 0, code: [...op.localGet(0), ...op.memoryGrow] }],
      memory: { min, max },
      exports: [
        { name: 'grow', kind: 'func', index: 0 },
        { name: 'memory', kind: 'memory', index: 0 },
      ],
    });

  async function grows(bytes: Uint8Array, pages: number): Promise<number> {
    const { instance } = await WebAssembly.instantiate(bytes as BufferSource);
    return (instance.exports.grow as (n: number) => number)(pages);
  }

  it('gives a memory with no maximum the ceiling, and the engine keeps to it', async () => {
    const capped = capWasmMemory(growable(1), 4);
    expect(readWasmModule(capped).memories).toEqual([{ min: 1, max: 4 }]);
    expect(await grows(capped, 3)).toBe(1);
    expect(await grows(capped, 4)).toBe(-1);
    // The uncapped module grows past it.
    expect(await grows(growable(1), 4)).toBe(1);
  });

  it('keeps a smaller maximum of the module’s own, and lowers a larger one', () => {
    expect(readWasmModule(capWasmMemory(growable(1, 2), 16)).memories).toEqual([{ min: 1, max: 2 }]);
    expect(readWasmModule(capWasmMemory(growable(1, 100), 16)).memories).toEqual([{ min: 1, max: 16 }]);
  });

  it('keeps every other byte of a real module, which still runs', async () => {
    const original = fixture('calc.wasm');
    const capped = capWasmMemory(original, 64);
    const info = readWasmModule(capped);
    expect(info.memories[0].max).toBe(64);
    expect(info.exports).toEqual(readWasmModule(original).exports);
    const { instance } = await WebAssembly.instantiate(capped as BufferSource, {});
    expect((instance.exports.add as (a: number, b: number) => number)(2, 3)).toBe(5);
  });

  it('refuses a memory that starts larger than the ceiling, and a shared one', () => {
    expect(() => capWasmMemory(growable(20), 16)).toThrow(WasmLimitError);
    expect(() => capWasmMemory(growable(20), 16)).toThrow(/starts with 1\.3 MB of memory, more than the 1 MB/);
    const shared = buildModule({ memory: { min: 1, max: 2, shared: true } });
    expect(() => capWasmMemory(shared, 16)).toThrow(/threads/);
  });

  it('passes a module with no memory of its own through unchanged', () => {
    const bytes = buildModule({ types: [{ params: [], results: [] }], funcs: [{ type: 0, code: [] }] });
    expect(capWasmMemory(bytes, 4)).toBe(bytes);
  });
});
