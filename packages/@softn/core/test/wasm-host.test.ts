// @vitest-environment node
/**
 * wasm-host.ts and wasm-worker.ts together, the worker on a real thread
 * started from the same source text a browser turns into a `blob:` worker:
 * commands run with WASI, libraries called, programs drawn, and the limits
 * a module runs under (memory, time, how many).
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import { WasmHost, startWasmProgram, wasmWorkerSource, type WasmLimits } from '../src/runtime/wasm/wasm-host';
import type { WasmInputEvent } from '../src/runtime/wasm/wasm-worker';
import { buildModule, op } from './helpers/wasm-builder';
import { trackedWorkers } from './helpers/wasm-node-worker';

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/wasm/${name}`, import.meta.url)));
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const bytesOf = (s: string) => new TextEncoder().encode(s);

const workers = trackedWorkers();
const hosts: WasmHost[] = [];
function host(limits: Partial<WasmLimits> = {}, appId?: string): WasmHost {
  const made = new WasmHost({ createWorker: workers.factory, limits, appId });
  hosts.push(made);
  return made;
}

afterEach(() => {
  for (const h of hosts.splice(0)) h.dispose();
  for (const w of workers.made.splice(0)) w.terminate();
});

describe('the worker’s source', () => {
  it('names nothing outside itself but the globals a worker has', () => {
    // What a browser runs is this text, not the function in this module: a
    // name it borrowed from around it (a constant, a helper, a bundler's
    // import) would be undefined there.
    const require = createRequire(import.meta.url);
    const espree = require('espree') as { parse: (code: string, options: object) => unknown };
    const scopes = require('eslint-scope') as { analyze: (ast: unknown, options: object) => { globalScope: { through: { identifier: { name: string } }[] } } };
    const ast = espree.parse(wasmWorkerSource(), { ecmaVersion: 2022, sourceType: 'script', range: true });
    const free = new Set(scopes.analyze(ast, { ecmaVersion: 2022 }).globalScope.through.map((r) => r.identifier.name));
    const WORKER_GLOBALS = [
      'self', 'WebAssembly', 'TextEncoder', 'TextDecoder', 'performance', 'crypto', 'ImageData',
      'Uint8Array', 'Uint8ClampedArray', 'Float32Array', 'DataView', 'Array', 'Object', 'Number', 'BigInt', 'String',
      'Math', 'Date', 'JSON', 'Map', 'Promise', 'Error', 'RangeError', 'Infinity', 'undefined',
    ];
    expect([...free].filter((name) => !WORKER_GLOBALS.includes(name))).toEqual([]);
  });
});

describe('softn.wasm.run: a WASI command, start to exit', () => {
  const tool = fixture('wasi_tool.wasm');
  const run = (args: string[], extra: object = {}) => host().run(tool, { name: 'wasi_tool.wasm', args, ...extra });

  it('gives the command its arguments, its name first', async () => {
    const result = await run(['args', 'a b', 'c']);
    expect(result.exitCode).toBe(0);
    expect(text(result.stdout)).toBe('wasi_tool.wasm|args|a b|c\n');
  });

  it('gives it the environment it is given, and nothing of the page’s', async () => {
    expect(text((await run(['env', 'GREETING'], { env: { GREETING: 'hi there' } })).stdout)).toBe('hi there\n');
    expect(text((await run(['env', 'PATH'])).stdout)).toBe('(unset)\n');
  });

  it('reads stdin and keeps stdout and stderr apart', async () => {
    const result = await run(['shout'], { stdin: bytesOf('hello, wasm') });
    expect(text(result.stdout)).toBe('HELLO, WASM');
    expect(text(result.stderr)).toBe('read 11 bytes\n');
  });

  it('works on the files it is given and hands back the ones it wrote, never leaving its folder', async () => {
    const result = await run(['files'], { files: [{ path: 'input.txt', bytes: bytesOf('abc') }] });
    expect(result.exitCode).toBe(0);
    expect(text(result.stdout).split('\n')).toEqual(['input.txt,out', '4', 'missing: NotFound', 'stayed inside', '']);
    const files = Object.fromEntries(result.files.map((f) => [f.path, f.bytes]));
    expect(Object.keys(files).sort()).toEqual(['out/deep/bytes.bin', 'out/result.txt']);
    expect(text(files['out/result.txt'])).toBe('ABC!');
    expect([...files['out/deep/bytes.bin']]).toEqual([0, 1, 2, 255]);
  });

  it('reports the code a command exits with', async () => {
    expect((await run(['exit', '7'])).exitCode).toBe(7);
    expect((await run(['nonsense'])).exitCode).toBe(2);
  });

  it('reports a panic as a stop, with what the command printed before it', async () => {
    const result = await run(['panic']);
    expect(result.exitCode).toBeNull();
    expect(result.error).toMatch(/^The module stopped: /);
    expect(text(result.stderr)).toMatch(/deliberately/);
  });

  it('has clocks, sleeps, and keys a hash with random numbers', async () => {
    const first = text((await run(['time'])).stdout).trim().split(' ');
    const second = text((await run(['time'])).stdout).trim().split(' ');
    expect(first.slice(0, 3)).toEqual(['true', 'true', 'true']);
    expect(first[3]).not.toBe(second[3]);
  });

  it('stops a command that runs past its time', async () => {
    await expect(run(['spin'], { timeoutMs: 300 })).rejects.toThrow(/took longer than 0\.3 seconds and was stopped/);
  });

  it('gives a command no more memory than it may have', async () => {
    const small = await run(['alloc', '64'], { memoryMB: 16 });
    expect(small.exitCode).toBeNull();
    expect(text(small.stderr)).toMatch(/memory allocation/);
    const enough = await run(['alloc', '32'], { memoryMB: 128 });
    expect(text(enough.stdout)).toBe('allocated 32\n');
  });

  it('refuses a library as a command, and memory beyond what an app may ask', async () => {
    await expect(host().run(fixture('calc.wasm'), { name: 'calc.wasm' })).rejects.toThrow(/it is a library\. Load it with softn\.wasm\.load/);
    await expect(run(['args'], { memoryMB: 4096 })).rejects.toThrow(/at most 1024 MB/);
  });
});

describe('softn.wasm.load and call: a library', () => {
  const calc = fixture('calc.wasm');

  it('says what the module exports, with what each function takes', async () => {
    const loaded = await host().load(calc, { name: 'calc.wasm' });
    expect(loaded.handle).toMatch(/^wasm-[0-9a-f]{24}$/);
    expect(loaded.kind).toBe('library');
    expect(loaded.exports).toContainEqual({ name: 'add', kind: 'function', params: ['i32', 'i32'], results: ['i32'] });
    expect(loaded.missing).toEqual([]);
    expect(loaded.maxMemoryMB).toBe(256);
  });

  it('calls with numbers, 64-bit numbers and floats, and keeps the module’s state between calls', async () => {
    const h = host();
    const { handle } = await h.load(calc, { name: 'calc.wasm' });
    expect(await h.call(handle, 'add', [2, 3])).toBe(5);
    expect(await h.call(handle, 'add64', [1, 2])).toBe(3);
    expect(await h.call(handle, 'add64', [9007199254740993n, 1])).toBe('9007199254740994');
    expect(await h.call(handle, 'scale', [1.5, 2])).toBe(3);
    expect(await h.call(handle, 'count', [])).toBe(1);
    expect(await h.call(handle, 'count', [])).toBe(2);
  });

  it('copies text and bytes in, and reads text, JSON and C strings out', async () => {
    const h = host();
    const { handle } = await h.load(calc, { name: 'calc.wasm' });
    expect(await h.call(handle, 'shout', [{ text: 'grüße' }], { returns: 'text' })).toBe('GRÜSSE');
    expect(await h.call(handle, 'stats', [{ text: '1, 2, 3.5' }], { returns: 'json' })).toEqual({ count: 3, sum: 6.5 });
    expect(await h.call(handle, 'repeat', [{ text: 'ab' }, 3], { returns: 'text', free: true })).toBe('ababab');
    expect(await h.call(handle, 'greeting', [], { returns: 'cstring' })).toBe('hello from calc');
    expect(await h.call(handle, 'checksum', [{ bytes: new Uint8Array([1, 2, 250]) }])).toBe(253);
    const bytes = await h.call(handle, 'shout', [{ text: 'ok' }], { returns: 'bytes' });
    expect([...(bytes as Uint8Array)]).toEqual([79, 75]);
  });

  it('reads and writes the module’s memory', async () => {
    const h = host();
    const { handle } = await h.load(calc, { name: 'calc.wasm' });
    const ptr = (await h.call(handle, 'alloc', [8])) as number;
    expect(await h.write(handle, ptr, new Uint8Array([9, 8, 7, 6, 0, 0, 128, 63]))).toBe(8);
    expect([...((await h.read(handle, ptr, 4, 'bytes')) as Uint8Array)]).toEqual([9, 8, 7, 6]);
    expect(await h.read(handle, ptr, 1, 'u32')).toEqual([0x06070809]);
    expect(await h.read(handle, ptr + 4, 1, 'f32')).toEqual([1]);
    await expect(h.read(handle, 0x7fffffff, 4, 'bytes')).rejects.toThrow(/past the end of its memory/);
  });

  it('says what is wrong with a call, and a trap leaves the module running', async () => {
    const h = host();
    const { handle } = await h.load(calc, { name: 'calc.wasm' });
    await expect(h.call(handle, 'add', [1])).rejects.toThrow(/add takes 2 numbers; the call gave 1/);
    await expect(h.call(handle, 'shout', [{ text: 'x' }, 1])).rejects.toThrow(/a text or bytes argument is two/);
    await expect(h.call(handle, 'nope', [])).rejects.toThrow(/exports no function "nope"; it exports .*add/);
    await expect(h.call(handle, 'divide', [1, 0])).rejects.toThrow(/^The module stopped: /);
    expect(await h.call(handle, 'divide', [9, 3])).toBe(3);
    await expect(h.call(handle, 'add', [1, 2], { returns: 'text' })).rejects.toThrow(/one 64-bit number/);
  });

  it('gives an import SoftN does not have, so the module starts, and stops it if it is called', async () => {
    // (func (export "safe") (result i32) i32.const 7) (func (export "risky") call $custom)
    const bytes = buildModule({
      types: [{ params: [], results: [] }, { params: [], results: ['i32'] }],
      imports: [{ module: 'env', name: 'custom_fn', kind: 'func', type: 0 }],
      funcs: [
        { type: 1, code: op.i32Const(7) },
        { type: 0, code: op.call(0) },
      ],
      exports: [
        { name: 'safe', kind: 'func', index: 1 },
        { name: 'risky', kind: 'func', index: 2 },
      ],
    });
    const h = host();
    const loaded = await h.load(bytes, { name: 'custom.wasm' });
    expect(loaded.missing).toEqual(['env.custom_fn']);
    expect(await h.call(loaded.handle, 'safe', [])).toBe(7);
    await expect(h.call(loaded.handle, 'risky', [])).rejects.toThrow(/called env\.custom_fn, which SoftN does not give a module/);
  });

  it('makes an imported memory with the ceiling, and lets an i64 pair come back as text', async () => {
    // Imports env.memory (1 page, no maximum) and exports grow(n) → old size or -1.
    const bytes = buildModule({
      types: [{ params: ['i32'], results: ['i32'] }],
      imports: [{ module: 'env', name: 'memory', kind: 'memory', min: 1 }],
      funcs: [{ type: 0, code: [...op.localGet(0), ...op.memoryGrow] }],
      exports: [{ name: 'grow', kind: 'func', index: 0 }],
    });
    const h = host();
    const { handle } = await h.load(bytes, { name: 'imported.wasm', memoryMB: 1 });
    expect(await h.call(handle, 'grow', [15])).toBe(1);
    expect(await h.call(handle, 'grow', [1])).toBe(-1);
  });

  it('keeps an app to its number of modules, and a released module takes no calls', async () => {
    const h = host({ maxModules: 2 });
    const first = await h.load(calc, { name: 'one' });
    await h.load(calc, { name: 'two' });
    await expect(h.load(calc, { name: 'three' })).rejects.toThrow(/at most 2 modules loaded at once/);
    expect(h.release(first.handle)).toBe(true);
    expect(h.release(first.handle)).toBe(false);
    await expect(h.call(first.handle, 'add', [1, 1])).rejects.toThrow(/No module is running under/);
    await h.load(calc, { name: 'three' });
  });

  it('stops a call that runs past its time; the module is gone after it', async () => {
    // (func (export "spin") (loop (br 0)))
    const bytes = buildModule({
      types: [{ params: [], results: [] }],
      funcs: [{ type: 0, code: [0x03, 0x40, 0x0c, 0x00, 0x0b] }],
      exports: [{ name: 'spin', kind: 'func', index: 0 }],
    });
    const h = host();
    const { handle } = await h.load(bytes, { name: 'spin.wasm' });
    await expect(h.call(handle, 'spin', [], { timeoutMs: 200 })).rejects.toThrow(/spin\(\) took longer than 0\.2 seconds and was stopped/);
    await expect(h.call(handle, 'spin', [])).rejects.toThrow(/No module is running/);
  });

  it('refuses what is no module before starting anything', async () => {
    await expect(host().load(bytesOf('not wasm at all'), { name: 'x' })).rejects.toThrow(/not a WebAssembly module/);
    expect(workers.made.length).toBe(0);
  });

  it('closes every module with the app', async () => {
    const h = host();
    const { handle } = await h.load(calc, { name: 'calc.wasm' });
    h.dispose();
    await expect(h.call(handle, 'add', [1, 1])).rejects.toThrow(/The app has closed/);
    await expect(h.load(calc, { name: 'again' })).rejects.toThrow(/The app has closed/);
  });
});

describe('a program that draws (<WasmApp>)', () => {
  const screen = fixture('screen.wasm');

  async function program(extra: Partial<Parameters<typeof startWasmProgram>[0]> = {}) {
    const seen = { posts: [] as string[], sizes: [] as string[], pixels: [] as number[], audio: [] as number[], console: [] as string[], crashes: [] as string[] };
    const started = await startWasmProgram({
      bytes: screen,
      name: 'screen.wasm',
      appId: 'app-1',
      canvas: null,
      createWorker: workers.factory,
      onPost: (t) => seen.posts.push(t),
      onSize: (w, h) => seen.sizes.push(`${w}x${h}`),
      onPixels: (_w, _h, buffer) => seen.pixels.push(buffer.byteLength),
      onAudio: (samples) => seen.audio.push(samples.length),
      onConsole: (stream, line) => seen.console.push(`${stream}:${line}`),
      onCrash: (message) => seen.crashes.push(message),
      ...extra,
    });
    return { started, seen };
  }

  it('draws frames, takes keys and the pointer, makes sound and talks to the app', async () => {
    const { started, seen } = await program();
    try {
      expect(started.drawsFrames).toBe(true);
      expect(started.makesSound).toBe(true);
      expect(started.handle).toMatch(/^wasmapp-/);
      await started.frame(16, [], 0);
      expect(seen.sizes).toEqual(['64x48']);
      expect(seen.pixels).toEqual([64 * 48 * 4]);
      const right: WasmInputEvent = { kind: 'key', code: 79, down: true };
      await started.frame(32, [right, { kind: 'key', code: 79, down: false }], 0);
      expect(seen.posts).toEqual(['at 11,10']);
      await started.frame(48, [{ kind: 'key', code: 44, down: true }, { kind: 'pointer', id: 0, phase: 1, x: 5, y: 6, buttons: 1 }], 0);
      expect(seen.posts).toEqual(['at 11,10', 'at 11,10', 'down 5.0,6.0', 'third frame']);
      expect(seen.audio).toEqual([(48000 / 20) * 2]);
      expect(await started.call('message', [{ text: 'hello' }])).toBeNull();
      expect(seen.posts.at(-1)).toBe('echo hello');
      expect(seen.console).toContain('out:got hello');
      expect(seen.crashes).toEqual([]);
    } finally {
      started.stop();
    }
  });

  it('is reached by its own app’s logic under its handle, and by no other app’s', async () => {
    const { started } = await program();
    try {
      await started.frame(0, [{ kind: 'key', code: 81, down: true }], 0);
      // position() gives back x << 32 | y.
      expect(await host({}, 'app-1').call(started.handle, 'position', [])).toBe(10 * 2 ** 32 + 11);
      await expect(host({}, 'app-2').call(started.handle, 'position', [])).rejects.toThrow(/No module is running under/);
    } finally {
      started.stop();
    }
    await expect(host({}, 'app-1').call(started.handle, 'position', [])).rejects.toThrow(/No module is running under/);
  });

  it('is stopped, and says so, when a frame never ends', async () => {
    const bytes = buildModule({
      types: [{ params: ['f64'], results: [] }],
      funcs: [{ type: 0, code: [0x03, 0x40, 0x0c, 0x00, 0x0b] }],
      exports: [{ name: 'frame', kind: 'func', index: 0 }],
    });
    const { started, seen } = await program({ bytes, name: 'stuck.wasm', limits: { frameTimeoutMs: 200 } });
    await started.frame(0, [], 0);
    expect(seen.crashes).toEqual(['stuck.wasm: a frame took longer than 0.2 seconds and was stopped; the module is no longer running']);
    await started.frame(16, [], 0);
    expect(seen.crashes.length).toBe(1);
  });
});
