// @vitest-environment node
/**
 * The limits a module runs under, held where a review of 2026-11-15 found
 * each could be got round: a module fetched through a redirect, memories and
 * tables past the ceiling, objects of the GC proposal, the files' byte limit
 * through negative sizes and unlinked open files, loads and runs started
 * together, a module still starting when the app closes, a call stopped for
 * the time it waited behind another, a console flooded in one call, import
 * names looked up through Object.prototype, an app with no identity reaching
 * every program, exit in a start function, fd_renumber onto itself, offsets
 * past 2^63, a listing that skipped entries as they were deleted, and NaN.
 * A second review the same day found more, held at the end of the file: one
 * write of millions of lines, files truncated to keep their buffers,
 * exceptions kept outside the memory, a program's exit told twice, a folder
 * removed while open, stdout a C program buffers whole, and more.
 * The worker runs on real Node threads, from the text a browser runs.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { capWasmMemory, capWasmModule, checkRunnable, readWasmModule } from '../src/runtime/wasm/wasm-binary';
import { WasmHost, startWasmProgram, type WasmLimits, type WasmWorkerLike } from '../src/runtime/wasm/wasm-host';
import { wasmWorkerMain } from '../src/runtime/wasm/wasm-worker';
import { AppWasm } from '../src/runtime/host-calls/wasm';
import type { HostGate } from '../src/runtime/host-calls/permissions';
import type { PendingHostCall } from '../src/runtime/script-runtime-types';
import { buildModule, op, wasiPassThrough } from './helpers/wasm-builder';
import { trackedWorkers } from './helpers/wasm-node-worker';

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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const encode = (s: string) => new TextEncoder().encode(s);
const MB = 1 << 20;

/** A module whose `_initialize` never returns. */
const NEVER_STARTS = buildModule({
  types: [{ params: [], results: [] }],
  funcs: [{ type: 0, code: [0x03, 0x40, 0x0c, 0x00, 0x0b] }],
  exports: [{ name: '_initialize', kind: 'func', index: 0 }],
});

/** spin(ms: f64) waits by softn.now() for so long; noop() returns at once. */
const SPINNER = buildModule({
  types: [{ params: [], results: ['f64'] }, { params: ['f64'], results: [] }, { params: [], results: [] }, { params: ['f64'], results: [] }],
  imports: [{ module: 'softn', name: 'now', kind: 'func', type: 0 }],
  funcs: [
    {
      type: 1,
      locals: ['f64'],
      code: [...op.call(0), ...op.localSet(1), ...op.loop([...op.call(0), ...op.localGet(1), ...op.f64Sub, ...op.localGet(0), ...op.f64Lt, ...op.brIf(0)])],
    },
    { type: 2, code: [] },
    // frame(time): nothing to draw.
    { type: 3, code: [] },
  ],
  exports: [
    { name: 'spin', kind: 'func', index: 1 },
    { name: 'noop', kind: 'func', index: 2 },
    { name: 'frame', kind: 'func', index: 3 },
  ],
});

describe('a module from an address', () => {
  it('is fetched with no redirect, no referrer and no cookies, as softn.net.fetch fetches', async () => {
    const seen: RequestInit[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        seen.push(init);
        throw new TypeError('Failed to fetch');
      })
    );
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const gate: HostGate = {
      checkPermission: () => {},
      checkNetHost: () => {},
      permissionConfig: () => ({ permissions: { net: { enabled: true } } }),
      disposed: () => false,
      pressedHere: () => true,
    };
    const app = new AppWasm(gate, async () => null, () => 'app-1');
    const answer = (await app.load({ args: ['https://cdn.example/redirect?to=elsewhere', '{}'] } as unknown as PendingHostCall)) as { error: string };
    expect(answer.error).toMatch(/not fetched through a redirect/);
    expect(seen[0]).toMatchObject({ redirect: 'error', referrerPolicy: 'no-referrer', credentials: 'omit' });
    expect(seen[0].signal).toBeInstanceOf(AbortSignal);
  });
});

describe('memory and tables', () => {
  it('refuses a second memory, defined or imported', async () => {
    const two = buildModule({ memories: [{ min: 1 }, { min: 1 }] });
    await expect(host().load(two, { name: 'two.wasm' })).rejects.toThrow(/has 2 memories; SoftN runs a module with one/);
    const imported = buildModule({ imports: [{ module: 'env', name: 'memory', kind: 'memory', min: 1 }], memory: { min: 1 } });
    await expect(host().load(imported, { name: 'imported.wasm' })).rejects.toThrow(/has 2 memories/);
  });

  it('gives a table no more entries than a module may have, and shares them between its tables', async () => {
    // grow(n): table.grow on table 0 → the old size, or -1.
    const growable = buildModule({
      types: [{ params: ['i32'], results: ['i32'] }],
      funcs: [{ type: 0, code: [...op.refNullFunc, ...op.localGet(0), ...op.tableGrow(0)] }],
      tables: [{ min: 1 }],
      exports: [{ name: 'grow', kind: 'func', index: 0 }],
    });
    const h = host({ maxTableEntries: 100 });
    const { handle } = await h.load(growable, { name: 'tables.wasm' });
    expect(await h.call(handle, 'grow', [99])).toBe(1);
    expect(await h.call(handle, 'grow', [1])).toBe(-1);
    const two = buildModule({ tables: [{ min: 10 }, { min: 10, max: 30 }, { min: 10 }] });
    expect(readWasmModule(capWasmModule(two, { maxPages: 1, maxTableEntries: 100 })).tables).toEqual([
      { min: 10, max: 33 },
      { min: 10, max: 30 },
      { min: 10, max: 33 },
    ]);
    await expect(host({ maxTableEntries: 5 }).load(two, { name: 'big.wasm' })).rejects.toThrow(/tables start with 30 entries, more than the 5/);
  });

  it('makes an imported table with its share of the entries', async () => {
    const imported = buildModule({
      types: [{ params: ['i32'], results: ['i32'] }],
      imports: [{ module: 'env', name: 'table', kind: 'table', min: 1 }],
      funcs: [{ type: 0, code: [...op.refNullFunc, ...op.localGet(0), ...op.tableGrow(0)] }],
      exports: [{ name: 'grow', kind: 'func', index: 0 }],
    });
    const h = host({ maxTableEntries: 50 });
    const { handle } = await h.load(imported, { name: 'imported-table.wasm' });
    expect(await h.call(handle, 'grow', [49])).toBe(1);
    expect(await h.call(handle, 'grow', [1])).toBe(-1);
  });

  it('refuses objects of the GC proposal, and types it cannot read', () => {
    // One struct type: (struct (field (mut i32))).
    const gc = buildModule({ typesRaw: [1, 0x5f, 1, 0x7f, 1] });
    expect(() => checkRunnable(readWasmModule(gc))).toThrow(/WebAssembly GC/);
    const unknown = buildModule({ typesRaw: [1, 0x5d, 0] });
    expect(() => checkRunnable(readWasmModule(unknown))).toThrow(/types SoftN cannot read/);
  });
});

describe('the files a module holds', () => {
  const WASI = ['path_open', 'fd_close', 'fd_allocate', 'fd_filestat_set_size', 'path_unlink_file', 'fd_renumber', 'fd_pread', 'fd_readdir', 'path_create_directory', 'path_remove_directory'];

  async function files(maxFileBytes = MB) {
    const h = host({ maxFileBytes });
    const { handle } = await h.load(wasiPassThrough(WASI, 4), { name: 'files.wasm' });
    const errno = (name: string, args: unknown[]) => h.call(handle, name, args as never) as Promise<number>;
    /** path_open under the root (fd 3): the errno, and the descriptor. */
    const open = async (path: string, oflags = 1) => {
      const bytes = encode(path);
      await h.write(handle, 1024, bytes);
      const code = await errno('path_open', [3, 0, 1024, bytes.length, oflags, 0n, 0n, 0, 2048]);
      const [fd] = (await h.read(handle, 2048, 1, 'u32')) as number[];
      return { code, fd };
    };
    const unlink = async (path: string) => {
      const bytes = encode(path);
      await h.write(handle, 1024, bytes);
      return errno('path_unlink_file', [3, 1024, bytes.length]);
    };
    return { h, handle, errno, open, unlink };
  }

  it('reads sizes and offsets as unsigned: a negative one is a size no file may have', async () => {
    const { errno, open } = await files();
    const { fd } = await open('a.txt');
    expect(await errno('fd_filestat_set_size', [fd, -(2n ** 53n)])).toBe(22);
    expect(await errno('fd_allocate', [fd, 0n, 64n * BigInt(MB)])).toBe(22);
    expect(await errno('fd_allocate', [fd, -1n, 2n])).toBe(22);
  });

  it('counts an unlinked file still open until its last descriptor closes, once', async () => {
    const { errno, open, unlink } = await files();
    const a = await open('a.txt');
    expect(await errno('fd_allocate', [a.fd, 0n, 700_000n])).toBe(0);
    expect(await unlink('a.txt')).toBe(0);
    const b = await open('b.txt');
    // a's bytes are still held through its descriptor.
    expect(await errno('fd_allocate', [b.fd, 0n, 700_000n])).toBe(51);
    expect(await errno('fd_close', [a.fd])).toBe(0);
    expect(await errno('fd_allocate', [b.fd, 0n, 700_000n])).toBe(0);
    // Truncating an unlinked file through its descriptor counts it out once, not twice.
    const c = await open('c.txt');
    expect(await errno('fd_allocate', [c.fd, 0n, 200_000n])).toBe(0);
    expect(await unlink('c.txt')).toBe(0);
    expect(await errno('fd_filestat_set_size', [c.fd, 0n])).toBe(0);
    expect(await errno('fd_close', [c.fd])).toBe(0);
    const d = await open('d.txt');
    expect(await errno('fd_allocate', [d.fd, 0n, 300_000n])).toBe(0);
    const e = await open('e.txt');
    expect(await errno('fd_allocate', [e.fd, 0n, 100_000n])).toBe(51);
  });

  it('keeps fd_renumber onto itself a no-op, and reads nothing at an offset past 2^63', async () => {
    const { h, handle, errno, open } = await files();
    expect(await errno('fd_renumber', [3, 3])).toBe(0);
    const { code, fd } = await open('a.txt');
    expect(code).toBe(0);
    // One iovec at 3000: 16 bytes at 4000.
    const iov = new Uint8Array(8);
    new DataView(iov.buffer).setUint32(0, 4000, true);
    new DataView(iov.buffer).setUint32(4, 16, true);
    await h.write(handle, 3000, iov);
    expect(await errno('fd_pread', [fd, 3000, 1, 2n ** 63n, 3100])).toBe(0);
    expect(await h.read(handle, 3100, 1, 'u32')).toEqual([0]);
  });

  it('refuses a name longer than a file name may be', async () => {
    const { open } = await files();
    expect((await open('n'.repeat(300))).code).toBe(37);
  });

  it('lists every entry of a folder whose entries are deleted as it is read', async () => {
    const { h, handle, errno, open, unlink } = await files();
    await h.write(handle, 1024, encode('dir'));
    expect(await errno('path_create_directory', [3, 1024, 3])).toBe(0);
    for (let i = 0; i < 20; i++) {
      const made = await open(`dir/f${String(i).padStart(2, '0')}`);
      expect(made.code).toBe(0);
      await errno('fd_close', [made.fd]);
    }
    const dir = await open('dir', 2);
    expect(dir.code).toBe(0);
    // As Rust's remove_dir_all does it: read a little, delete what was read, read on from the cookie.
    // A buffer the listing does not fill is its end (WASI's fd_readdir).
    let cookie = 0n;
    const deleted: string[] = [];
    for (let rounds = 0; rounds < 100; rounds++) {
      expect(await errno('fd_readdir', [dir.fd, 8192, 128, cookie, 9000])).toBe(0);
      const [used] = (await h.read(handle, 9000, 1, 'u32')) as number[];
      const bytes = (await h.read(handle, 8192, used, 'bytes')) as Uint8Array;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (let at = 0; at + 24 <= used; ) {
        const next = view.getBigUint64(at, true);
        const length = view.getUint32(at + 16, true);
        // An entry cut off at the buffer's end is read again from its cookie.
        if (at + 24 + length > used) break;
        const name = new TextDecoder().decode(bytes.subarray(at + 24, at + 24 + length));
        if (name !== '.' && name !== '..') {
          expect(await unlink(`dir/${name}`)).toBe(0);
          deleted.push(name);
        }
        cookie = next;
        at += 24 + length;
      }
      if (used < 128) break;
    }
    expect(deleted.sort()).toEqual(Array.from({ length: 20 }, (_, i) => `f${String(i).padStart(2, '0')}`));
    await errno('fd_close', [dir.fd]);
    await h.write(handle, 1024, encode('dir'));
    expect(await errno('path_remove_directory', [3, 1024, 3])).toBe(0);
  });
});

describe('how many, and for how long', () => {
  it('counts loads still starting against an app’s modules', async () => {
    const h = host({ maxModules: 2 });
    const results = await Promise.allSettled([1, 2, 3, 4].map((i) => h.load(SPINNER, { name: `m${i}` })));
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(2);
    for (const refused of results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')) expect(String(refused.reason)).toMatch(/at most 2 modules/);
  });

  it('runs at most so many commands at once', async () => {
    const command = buildModule({
      types: [{ params: [], results: [] }],
      funcs: [{ type: 0, code: [] }],
      exports: [{ name: '_start', kind: 'func', index: 0 }],
    });
    const h = host({ maxRuns: 1 });
    const results = await Promise.allSettled([h.run(command, { name: 'a' }), h.run(command, { name: 'b' })]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(String((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason)).toMatch(/at most 1 commands at once/);
  });

  it('runs at most so many programs of an app at once, those starting included', async () => {
    const start = () => startWasmProgram({ bytes: SPINNER, name: 'p', appId: 'app-programs', canvas: null, createWorker: workers.factory, limits: { maxPrograms: 1 } });
    const results = await Promise.allSettled([start(), start()]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    for (const r of results) if (r.status === 'fulfilled') r.value.stop();
  });

  it('stops a module still starting when the app closes', async () => {
    const h = host();
    const began = Date.now();
    const loading = h.load(NEVER_STARTS, { name: 'never.wasm' });
    await new Promise((resolve) => setTimeout(resolve, 200));
    h.dispose();
    await expect(loading).rejects.toThrow(/The app has closed/);
    expect(Date.now() - began).toBeLessThan(3000);
  });

  it('stops a program still starting when its signal is aborted', async () => {
    const stopping = new AbortController();
    const began = Date.now();
    const starting = startWasmProgram({ bytes: NEVER_STARTS, name: 'never', appId: 'app-abort', canvas: null, createWorker: workers.factory, signal: stopping.signal });
    setTimeout(() => stopping.abort(), 200);
    await expect(starting).rejects.toThrow(/was stopped/);
    expect(Date.now() - began).toBeLessThan(3000);
  });

  it('says once why a program could not start, and reports no crash for one its signal stops', async () => {
    const crashes: string[] = [];
    const late = startWasmProgram({
      bytes: NEVER_STARTS,
      name: 'never',
      appId: 'app-once',
      canvas: null,
      createWorker: workers.factory,
      limits: { loadTimeoutMs: 200 },
      onCrash: (m) => crashes.push(m),
    });
    await expect(late).rejects.toThrow(/starting took longer than 0\.2 seconds/);
    const stopping = new AbortController();
    const program = await startWasmProgram({ bytes: SPINNER, name: 'p', appId: 'app-once', canvas: null, createWorker: workers.factory, signal: stopping.signal, onCrash: (m) => crashes.push(m) });
    stopping.abort();
    await expect(program.call('noop', [])).rejects.toThrow(/was stopped/);
    await expect(host({}, 'app-once').call(program.handle, 'noop', [])).rejects.toThrow(/No module is running/);
    expect(crashes).toEqual([]);
  });

  it('counts a call’s time from when the worker is given it, not while it waits behind another', async () => {
    const h = host();
    const { handle } = await h.load(SPINNER, { name: 'spinner.wasm' });
    const slow = h.call(handle, 'spin', [800], { timeoutMs: 5000 });
    const quick = h.call(handle, 'noop', [], { timeoutMs: 300 });
    await expect(slow).resolves.toBeNull();
    await expect(quick).resolves.toBeNull();
  });

  it('keeps a program’s frame waiting behind a long call, rather than stopping it', async () => {
    const crashes: string[] = [];
    const program = await startWasmProgram({
      bytes: SPINNER,
      name: 'spinner',
      appId: 'app-frames',
      canvas: null,
      createWorker: workers.factory,
      limits: { frameTimeoutMs: 300 },
      onCrash: (m) => crashes.push(m),
    });
    try {
      const slow = program.call('spin', [800], { timeoutMs: 5000 });
      await program.frame(16, [], 0);
      await slow;
      expect(crashes).toEqual([]);
    } finally {
      program.stop();
    }
  });
});

describe('what a module says, and what it is given', () => {
  it('shows at most 200 lines of one call in the console, and says how many more there were', async () => {
    const lines: string[] = [];
    const h = host();
    const { handle } = await h.load(wasiPassThrough(['fd_write'], 4), { name: 'loud.wasm', onConsole: (_s, text) => lines.push(text) });
    await h.write(handle, 65536, encode('x\n'.repeat(50_000)));
    const iov = new Uint8Array(8);
    new DataView(iov.buffer).setUint32(0, 65536, true);
    new DataView(iov.buffer).setUint32(4, 100_000, true);
    await h.write(handle, 1024, iov);
    expect(await h.call(handle, 'fd_write', [1, 1024, 1, 2000])).toBe(0);
    expect(lines.length).toBe(201);
    expect(lines.at(-1)).toBe('… 49800 more lines not shown');
  });

  it('gives an import named like Object.prototype’s members a stub, never the worker’s own', async () => {
    const bytes = buildModule({
      types: [{ params: [], results: [] }],
      imports: [
        { module: 'env', name: 'constructor', kind: 'func', type: 0 },
        { module: 'wasi_snapshot_preview1', name: 'valueOf', kind: 'func', type: 0 },
        { module: '__proto__', name: 'softnExit', kind: 'func', type: 0 },
      ],
      funcs: [
        { type: 0, code: op.call(0) },
        { type: 0, code: op.unreachable },
      ],
      exports: [
        { name: 'callConstructor', kind: 'func', index: 3 },
        { name: 'trap', kind: 'func', index: 4 },
      ],
    });
    const h = host();
    const loaded = await h.load(bytes, { name: 'proto.wasm' });
    expect(loaded.missing).toEqual(['env.constructor', 'wasi_snapshot_preview1.valueOf', '__proto__.softnExit']);
    await expect(h.call(loaded.handle, 'callConstructor', [])).rejects.toThrow(/called env\.constructor, which SoftN does not give/);
    await expect(h.call(loaded.handle, 'trap', [])).rejects.toThrow(/^The module stopped: /);
  });

  it('reaches a program from its own app only: an app with no identity is one of its own', async () => {
    const start = (appId: string | undefined) => startWasmProgram({ bytes: SPINNER, name: 'p', appId, canvas: null, createWorker: workers.factory });
    const owned = await start('app-1');
    const anonymous = await start(undefined);
    try {
      await expect(host({}, undefined).call(owned.handle, 'noop', [])).rejects.toThrow(/No module is running/);
      await expect(host({}, 'app-1').call(anonymous.handle, 'noop', [])).rejects.toThrow(/No module is running/);
      await expect(host({}, undefined).call(anonymous.handle, 'noop', [])).resolves.toBeNull();
      await expect(host({}, 'app-1').call(owned.handle, 'noop', [])).resolves.toBeNull();
    } finally {
      owned.stop();
      anonymous.stop();
    }
  });

  it('reports exit in a start function as an exit code', async () => {
    // (start: proc_exit(3)), and a _start that would never be reached.
    const bytes = buildModule({
      types: [{ params: ['i32'], results: [] }, { params: [], results: [] }],
      imports: [{ module: 'wasi_snapshot_preview1', name: 'proc_exit', kind: 'func', type: 0 }],
      funcs: [
        { type: 1, code: [...op.i32Const(3), ...op.call(0)] },
        { type: 1, code: [] },
      ],
      exports: [{ name: '_start', kind: 'func', index: 2 }],
      start: 1,
    });
    const run = await host().run(bytes, { name: 'exits.wasm' });
    expect(run.exitCode).toBe(3);
    expect(run.error).toBeUndefined();
    // Loaded, it has nothing to call: refused, and it keeps no place among the app's modules.
    const h = host({ maxModules: 1 });
    await expect(h.load(bytes, { name: 'exits.wasm' })).rejects.toThrow(/exits\.wasm exited \(code 3\) as it started/);
    await expect(h.load(SPINNER, { name: 'next.wasm' })).resolves.toMatchObject({ name: 'next.wasm' });
  });

  it('passes NaN and the infinities to a float parameter, refuses them for an integer one, and gives them back as text', async () => {
    const bytes = buildModule({
      types: [{ params: ['f64'], results: ['f64'] }, { params: ['i32'], results: ['i32'] }],
      funcs: [
        { type: 0, code: op.localGet(0) },
        { type: 1, code: op.localGet(0) },
      ],
      memory: { min: 1 },
      exports: [
        { name: 'same', kind: 'func', index: 0 },
        { name: 'sameInt', kind: 'func', index: 1 },
        { name: 'memory', kind: 'memory', index: 0 },
      ],
    });
    const h = host();
    const { handle } = await h.load(bytes, { name: 'nan.wasm' });
    expect(await h.call(handle, 'same', [NaN])).toBe('NaN');
    expect(await h.call(handle, 'same', [-Infinity])).toBe('-Infinity');
    await expect(h.call(handle, 'sameInt', [NaN])).rejects.toThrow(/NaN is no whole number for a 32-bit parameter/);
    const floats = new Uint8Array(16);
    new DataView(floats.buffer).setFloat64(0, NaN, true);
    new DataView(floats.buffer).setFloat64(8, Infinity, true);
    await h.write(handle, 0, floats);
    expect(await h.read(handle, 0, 2, 'f64')).toEqual(['NaN', 'Infinity']);
  });
});

// ------------------------------------------------------- the second review

setFlagsFromString('--expose_gc');
const gc = runInNewContext('gc') as () => void;

/** The worker in this thread, for a test that measures what it holds; nothing can stop it from outside, so only modules that end run here. */
function inThisThread(): WasmWorkerLike {
  const like: WasmWorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage: (message) => setTimeout(() => scope.onmessage?.({ data: message }), 0),
    terminate: () => {},
  };
  const scope = {
    postMessage: (message: unknown) => setTimeout(() => like.onmessage?.({ data: message }), 0),
    onmessage: null as ((event: { data: unknown }) => void) | null,
  };
  wasmWorkerMain(scope as unknown as Parameters<typeof wasmWorkerMain>[0]);
  return like;
}

/** fd_write(1, …) of the iovecs given, each [ptr, length], laid out at 1024. */
async function writeOut(h: WasmHost, handle: string, pieces: [number, number][]): Promise<number> {
  const iov = new Uint8Array(pieces.length * 8);
  const view = new DataView(iov.buffer);
  pieces.forEach(([ptr, length], i) => {
    view.setUint32(i * 8, ptr, true);
    view.setUint32(i * 8 + 4, length, true);
  });
  await h.write(handle, 1024, iov);
  return h.call(handle, 'fd_write', [1, 1024, pieces.length, 16]) as Promise<number>;
}

describe('what the second review found', () => {
  it('counts the lines past what a call shows one by one, however they are written', async () => {
    const lines: string[] = [];
    const h = host();
    const { handle } = await h.load(wasiPassThrough(['fd_write'], 4), { name: 'pieces.wasm', onConsole: (_s, text) => lines.push(text) });
    // "li", "ne" and "\n" at 40000: 300 lines written in 900 pieces.
    await h.write(handle, 40000, encode('line\n'));
    const pieces: [number, number][] = [];
    for (let i = 0; i < 300; i++) pieces.push([40000, 2], [40002, 2], [40004, 1]);
    expect(await writeOut(h, handle, pieces)).toBe(0);
    expect(lines.length).toBe(201);
    expect(lines[0]).toBe('line');
    expect(lines.at(-1)).toBe('… 100 more lines not shown');
  });

  it('takes one write of millions of lines without decoding them, in a worker with a small heap', async () => {
    const small = trackedWorkers(48);
    const lines: string[] = [];
    const h = new WasmHost({ createWorker: small.factory });
    hosts.push(h);
    try {
      const { handle } = await h.load(wasiPassThrough(['fd_write'], 400), { name: 'flood.wasm', onConsole: (_s, text) => lines.push(text) });
      const flood = new Uint8Array(16 * MB).fill(10);
      await h.write(handle, 65536, flood);
      expect(await writeOut(h, handle, [[65536, flood.length]])).toBe(0);
      expect(lines.length).toBe(201);
      expect(lines.at(-1)).toBe(`… ${16 * MB - 200} more lines not shown`);
    } finally {
      for (const w of small.made) w.terminate();
    }
  });

  it('writes the first 1,024 buffers of a longer list, a short write its caller goes on from', async () => {
    const h = host();
    const { handle } = await h.load(wasiPassThrough(['fd_write'], 4), { name: 'many.wasm', onConsole: () => {} });
    expect(await writeOut(h, handle, Array.from({ length: 1025 }, () => [40000, 1] as [number, number]))).toBe(0);
    expect(await h.read(handle, 16, 1, 'u32')).toEqual([1024]);
  });

  it('keeps a run’s output in one buffer, however many writes made it, in a worker with a small heap', async () => {
    // _start: put "x" at 0 and an iovec for it at 16, then fd_write(2, 16, 1, 24) 500,000 times.
    const bytes = buildModule({
      types: [{ params: ['i32', 'i32', 'i32', 'i32'], results: ['i32'] }, { params: [], results: [] }],
      imports: [{ module: 'wasi_snapshot_preview1', name: 'fd_write', kind: 'func', type: 0 }],
      funcs: [
        {
          type: 1,
          locals: ['i32'],
          code: [
            ...op.i32Const(0), ...op.i32Const(120), 0x3a, 0x00, 0x00, // i32.store8 "x" at 0
            ...op.i32Const(16), ...op.i32Const(0), 0x36, 0x02, 0x00, // the iovec: at 0,
            ...op.i32Const(20), ...op.i32Const(1), 0x36, 0x02, 0x00, // one byte
            ...op.loop([
              ...op.i32Const(2), ...op.i32Const(16), ...op.i32Const(1), ...op.i32Const(24), ...op.call(0), ...op.drop,
              ...op.localGet(0), ...op.i32Const(1), ...op.i32Add, 0x22, 0x00, // local.tee 0
              ...op.i32Const(500000), 0x49, // i32.lt_u
              ...op.brIf(0),
            ]),
          ],
        },
      ],
      memory: { min: 1 },
      exports: [
        { name: '_start', kind: 'func', index: 1 },
        { name: 'memory', kind: 'memory', index: 0 },
      ],
    });
    const small = trackedWorkers(48);
    const h = new WasmHost({ createWorker: small.factory });
    hosts.push(h);
    try {
      const run = await h.run(bytes, { name: 'chatty.wasm' });
      expect(run.exitCode).toBe(0);
      expect(run.stderr.length).toBe(500000);
      expect(run.stderr[499999]).toBe(120);
    } finally {
      for (const w of small.made) w.terminate();
    }
  });

  it('lets go of what a file no longer holds: files cut back to nothing keep no buffers', async () => {
    const h = new WasmHost({ createWorker: inThisThread, limits: { maxFileBytes: 4 * MB } });
    hosts.push(h);
    const { handle } = await h.load(wasiPassThrough(['path_open', 'fd_allocate', 'fd_filestat_set_size'], 4), { name: 'cut.wasm' });
    const errno = (name: string, args: unknown[]) => h.call(handle, name, args as never) as Promise<number>;
    gc();
    const before = process.memoryUsage().arrayBuffers;
    for (let i = 0; i < 32; i++) {
      const path = encode(`f${i}`);
      await h.write(handle, 1024, path);
      expect(await errno('path_open', [3, 0, 1024, path.length, 1, 0n, 0n, 0, 2048])).toBe(0);
      const [fd] = (await h.read(handle, 2048, 1, 'u32')) as number[];
      expect(await errno('fd_allocate', [fd, 0n, BigInt(4 * MB)])).toBe(0);
      expect(await errno('fd_filestat_set_size', [fd, 0n])).toBe(0);
    }
    gc();
    // Each of the 32 files kept its 4 MB buffer before: 128 MB.
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(16 * MB);
  });

  it('makes nothing in a folder removed while a descriptor held it', async () => {
    const h = host({ maxFileBytes: MB });
    const { handle } = await h.load(wasiPassThrough(['path_create_directory', 'path_open', 'path_remove_directory', 'fd_allocate'], 4), { name: 'gone.wasm' });
    const errno = (name: string, args: unknown[]) => h.call(handle, name, args as never) as Promise<number>;
    await h.write(handle, 1024, encode('dir'));
    expect(await errno('path_create_directory', [3, 1024, 3])).toBe(0);
    expect(await errno('path_open', [3, 0, 1024, 3, 2, 0n, 0n, 0, 2048])).toBe(0);
    const [dirFd] = (await h.read(handle, 2048, 1, 'u32')) as number[];
    expect(await errno('path_remove_directory', [3, 1024, 3])).toBe(0);
    await h.write(handle, 1100, encode('x.bin'));
    expect(await errno('path_open', [dirFd, 0, 1100, 5, 1, 0n, 0n, 0, 2048])).toBe(44);
    await h.write(handle, 1200, encode('sub'));
    expect(await errno('path_create_directory', [dirFd, 1200, 3])).toBe(44);
  });

  it('gives stdout a terminal’s rights where it goes to the console, and a pipe’s in a run', async () => {
    // _start: fd_fdstat_get(1, 0), then exit with the seek and tell bits of its rights (36 when both are there).
    const bytes = buildModule({
      types: [{ params: ['i32', 'i32'], results: ['i32'] }, { params: ['i32'], results: [] }, { params: [], results: [] }],
      imports: [
        { module: 'wasi_snapshot_preview1', name: 'fd_fdstat_get', kind: 'func', type: 0 },
        { module: 'wasi_snapshot_preview1', name: 'proc_exit', kind: 'func', type: 1 },
      ],
      funcs: [{ type: 2, code: [...op.i32Const(1), ...op.i32Const(0), ...op.call(0), ...op.drop, ...op.i32Const(8), 0x28, 0x02, 0x00, ...op.i32Const(36), 0x71, ...op.call(1)] }],
      memory: { min: 1 },
      exports: [
        { name: '_start', kind: 'func', index: 2 },
        { name: 'memory', kind: 'memory', index: 0 },
      ],
    });
    expect((await host().run(bytes, { name: 'pipe.wasm' })).exitCode).toBe(36);
    const h = host();
    const { handle } = await h.load(bytes, { name: 'tty.wasm' });
    await expect(h.call(handle, '_start', [])).rejects.toThrow(/exited with code 0/);
  });

  it('refuses exception references kept in a table or a global or carried by an exception, however the type is spelled', () => {
    const check = (spec: Parameters<typeof buildModule>[0]) => () => checkRunnable(readWasmModule(buildModule(spec)));
    const exceptionRefs = /keeps exception references \(exnref\) in a table or a global, or throws exceptions that carry one/;
    expect(check({ tables: [{ min: 1, element: 'exnref' }] })).toThrow(exceptionRefs);
    expect(check({ globals: [{ type: 'exnref', mutable: true }] })).toThrow(exceptionRefs);
    expect(check({ types: [{ params: ['exnref'], results: [] }], tags: [0] })).toThrow(exceptionRefs);
    // (ref null exn) as a heap type of one byte, and of two (0xE9 0x7F is -23 too, and an engine takes it).
    expect(check({ typesRaw: [1, 0x60, 1, 0x63, 0x69, 0], tags: [0] })).toThrow(exceptionRefs);
    expect(check({ typesRaw: [1, 0x60, 1, 0x63, 0xe9, 0x7f, 0], tags: [0] })).toThrow(exceptionRefs);
    expect(check({ raw: [[6, [1, 0x63, 0xe9, 0x7f, 0x01, 0xd0, 0x69, 0x0b]]] })).toThrow(exceptionRefs);
    expect(check({ raw: [[4, [1, 0x64, 0xe9, 0x7f, 0x00, 0x01]]] })).toThrow(exceptionRefs);
    // In locals, arguments and results an exception is on the stack, as bounded as the stack:
    // what a build with standard exception handling has.
    expect(check({ types: [{ params: ['exnref'], results: ['exnref'] }], funcs: [{ type: 0, locals: ['exnref'], code: op.localGet(0) }] })).not.toThrow();
    const nine = Array.from({ length: 9 }, () => 'i32' as const);
    expect(check({ types: [{ params: nine, results: [] }], tags: [0] })).toThrow(/carries 9 values; .* at most 8/);
    // A C++ exception: one pointer. And globals of numbers, which are read past.
    const cxx = buildModule({ types: [{ params: ['i32'], results: [] }], tags: [0], globals: [{ type: 'i32' }, { type: 'f64', mutable: true }, { type: 'funcref' }] });
    expect(() => checkRunnable(readWasmModule(cxx))).not.toThrow();
    expect(readWasmModule(cxx).largestException).toBe(1);
  });

  it('stops a program once it has exited, so it keeps no worker and no place among the app’s programs', async () => {
    // _start: proc_exit(3), or with a frame (no exit), quit(): proc_exit(5).
    const program = (exitAtStart: boolean) =>
      buildModule({
        types: [{ params: ['i32'], results: [] }, { params: [], results: [] }, { params: ['f64'], results: [] }],
        imports: [{ module: 'wasi_snapshot_preview1', name: 'proc_exit', kind: 'func', type: 0 }],
        funcs: [
          { type: 1, code: exitAtStart ? [...op.i32Const(3), ...op.call(0)] : [] },
          { type: 2, code: [] },
          { type: 1, code: [...op.i32Const(5), ...op.call(0)] },
        ],
        exports: [
          { name: '_start', kind: 'func', index: 1 },
          { name: 'frame', kind: 'func', index: 2 },
          { name: 'quit', kind: 'func', index: 3 },
        ],
      });
    const start = (exitAtStart: boolean) =>
      startWasmProgram({ bytes: program(exitAtStart), name: 'one', appId: 'app-one', canvas: null, createWorker: workers.factory, limits: { maxPrograms: 1 } });
    const ended = await start(true);
    expect(ended.exitCode).toBe(3);
    const quitting = await start(false);
    await expect(quitting.call('quit', [])).rejects.toThrow(/exited with code 5/);
    await expect(quitting.call('quit', [])).rejects.toThrow(/one has exited/);
    const next = await start(false);
    expect(next.exitCode).toBeNull();
    next.stop();
  });

  it('reports a program with no frame whose main returned as exited with 0', async () => {
    const bytes = buildModule({
      types: [{ params: [], results: [] }],
      funcs: [{ type: 0, code: [] }],
      exports: [{ name: '_start', kind: 'func', index: 0 }],
    });
    const program = await startWasmProgram({ bytes, name: 'once', appId: 'app-once-0', canvas: null, createWorker: workers.factory });
    expect(program.exitCode).toBe(0);
    expect(program.drawsFrames).toBe(false);
  });

  it('tells a program’s exit as it starts in its answer only, and an exit(0) of one that draws is no exit', async () => {
    const exits: number[] = [];
    // _start: proc_exit(code); frame(): nothing.
    const program = (code: number) =>
      buildModule({
        types: [{ params: ['i32'], results: [] }, { params: [], results: [] }, { params: ['f64'], results: [] }],
        imports: [{ module: 'wasi_snapshot_preview1', name: 'proc_exit', kind: 'func', type: 0 }],
        funcs: [
          { type: 1, code: [...op.i32Const(code), ...op.call(0)] },
          { type: 2, code: [] },
        ],
        exports: [
          { name: '_start', kind: 'func', index: 1 },
          { name: 'frame', kind: 'func', index: 2 },
        ],
      });
    const start = (code: number) => startWasmProgram({ bytes: program(code), name: `exit${code}`, appId: 'app-exits', canvas: null, createWorker: workers.factory, onExit: (c) => exits.push(c) });
    const failed = await start(3);
    expect(failed.exitCode).toBe(3);
    const drawing = await start(0);
    expect(drawing.exitCode).toBeNull();
    await drawing.frame(16, [], 0);
    expect(exits).toEqual([]);
    failed.stop();
    drawing.stop();
  });

  it('compiles a module again once the app that ran it has closed', async () => {
    const compile = vi.spyOn(WebAssembly, 'compile');
    const first = host();
    await first.load(SPINNER, { name: 'a.wasm' });
    await first.load(SPINNER, { name: 'b.wasm' });
    expect(compile).toHaveBeenCalledTimes(1);
    first.dispose();
    await host().load(SPINNER, { name: 'c.wasm' });
    expect(compile).toHaveBeenCalledTimes(2);
  });

  it('caps only the memory when asked to (capWasmMemory), leaving a table with no maximum valid', async () => {
    const bytes = buildModule({ tables: [{ min: 2 }], memory: { min: 1 } });
    const capped = capWasmMemory(bytes, 16);
    expect(readWasmModule(capped).tables).toEqual([{ min: 2 }]);
    expect(readWasmModule(capped).memories).toEqual([{ min: 1, max: 16 }]);
    await expect(WebAssembly.compile(capped as BufferSource)).resolves.toBeInstanceOf(WebAssembly.Module);
  });
});
