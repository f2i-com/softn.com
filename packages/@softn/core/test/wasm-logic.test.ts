// @vitest-environment node
/**
 * softn.wasm from an app's logic, the whole way: the script calls the
 * preamble's softn.wasm.*, the runtime's host call reads the module from the
 * app's files, the host starts a worker from a `blob:` address (a Node thread
 * here, running the same source), and the answer comes back to the script's
 * callback.
 */

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createConsoleModule,
  createMockNavModule,
  createMockXDBModule,
  createScriptRuntime,
  type PermissionConfig,
  type ScriptContext,
} from '../src/runtime/script-runtime';
import type { ScriptBlock } from '../src/parser/ast';
import type { WasmWorkerLike } from '../src/runtime/wasm/wasm-host';
import { logicEngineRunsPython } from '../src/runtime/vm-adapter';
import { nodeWasmWorker } from './helpers/wasm-node-worker';

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/wasm/${name}`, import.meta.url)));
const FILES: Record<string, Uint8Array> = {
  'assets/calc.wasm': fixture('calc.wasm'),
  'assets/wasi_tool.wasm': fixture('wasi_tool.wasm'),
  'data/words.txt': new TextEncoder().encode('one two three'),
};

let threads: WasmWorkerLike[] = [];
let urls: string[] = [];

/** The page's Worker, as the host constructs it from a blob: address: a Node thread running the same source. */
class ThreadWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message?: string }) => void) | null = null;
  readonly #inner = nodeWasmWorker();
  constructor(url: string) {
    urls.push(String(url));
    threads.push(this.#inner);
    this.#inner.onmessage = (event) => this.onmessage?.(event);
    this.#inner.onerror = (event) => this.onerror?.(event);
  }
  postMessage(message: unknown, transfer?: Transferable[]): void {
    this.#inner.postMessage(message, transfer);
  }
  terminate(): void {
    this.#inner.terminate();
  }
}

function script(code: string): ScriptBlock {
  return { type: 'ScriptBlock', code, loc: { line: 1, column: 0, start: 0, end: code.length } };
}

const runtimes: { cleanup(): void }[] = [];

function makeRuntime(permissionConfig: PermissionConfig | null = { permissions: {} } as PermissionConfig) {
  const state: Record<string, unknown> = {};
  const context: ScriptContext = {
    state,
    setState: (path: string, value: unknown) => {
      state[path] = value;
    },
    data: {},
    xdb: createMockXDBModule(),
    nav: createMockNavModule(),
    console: createConsoleModule(),
  };
  const files = {
    readFile: async (path: string) => (FILES[path] ? FILES[path].slice().buffer : null),
    hasFile: async (path: string) => path in FILES,
  };
  const runtime = createScriptRuntime(context, undefined, 'wasm-test-app', undefined, undefined, undefined, files as never);
  if (permissionConfig) (runtime as unknown as { setPermissionConfig(c: PermissionConfig): void }).setPermissionConfig(permissionConfig);
  runtimes.push(runtime as unknown as { cleanup(): void });
  return Object.assign(runtime, { state });
}

beforeEach(() => {
  threads = [];
  urls = [];
  vi.stubGlobal('Worker', ThreadWorker);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.cleanup();
  for (const thread of threads) thread.terminate();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('softn.wasm from an app’s logic', () => {
  it('loads a module from the app’s files and calls its functions', async () => {
    const runtime = makeRuntime();
    const result = await runtime.loadScript(
      script(`
        let sum = null
        let shouted = ""
        let stats = null
        let exportsSeen = 0
        let failure = ""
        function go() {
          softn.wasm.load("assets/calc.wasm", function (m) {
            if (m.error) { failure = m.error; return }
            exportsSeen = m.exports.length
            softn.wasm.call(m.handle, "add", [2, 40], function (r) { sum = r.value })
            softn.wasm.call(m.handle, "shout", ["quiet please"], { returns: "text" }, function (r) { shouted = r.value })
            softn.wasm.call(m.handle, "stats", [{ text: "4,5" }], { returns: "json" }, function (r) { stats = r.value })
          })
        }
      `)
    );
    await result.functions.go();
    expect(runtime.state.failure).toBe('');
    expect(runtime.state.sum).toBe(42);
    expect(runtime.state.shouted).toBe('QUIET PLEASE');
    expect(runtime.state.stats).toEqual({ count: 2, sum: 9 });
    expect(runtime.state.exportsSeen).toBeGreaterThan(5);
    expect(urls.length).toBe(1);
    expect(urls[0]).toMatch(/^blob:/);
  });

  it('runs a WASI command with stdin, arguments and the app’s own file', async () => {
    const runtime = makeRuntime();
    const result = await runtime.loadScript(
      script(`
        let out = ""
        let code = -1
        let wrote = ""
        function go() {
          softn.wasm.run("assets/wasi_tool.wasm", { args: ["shout"], stdin: "make it loud" }, function (r) {
            out = r.stdout
            code = r.exitCode
          })
          softn.wasm.run("assets/wasi_tool.wasm", { args: ["files"], files: { "input.txt": { bundle: "data/words.txt" } } }, function (r) {
            wrote = r.files["out/result.txt"].text
          })
        }
      `)
    );
    await result.functions.go();
    expect(runtime.state.out).toBe('MAKE IT LOUD');
    expect(runtime.state.code).toBe(0);
    expect(runtime.state.wrote).toBe('ONE TWO THREE!');
  });

  it('answers a failure as { error }, with what went wrong', async () => {
    const runtime = makeRuntime();
    const result = await runtime.loadScript(
      script(`
        let missing = ""
        let badCall = ""
        function go() {
          softn.wasm.load("assets/none.wasm", function (m) { missing = m.error })
          softn.wasm.load("assets/calc.wasm", function (m) {
            softn.wasm.call(m.handle, "add", [1], function (r) { badCall = r.error })
          })
        }
      `)
    );
    await result.functions.go();
    expect(runtime.state.missing).toBe('This app has no file "assets/none.wasm"');
    expect(runtime.state.badCall).toBe('add takes 2 numbers; the call gave 1');
  });

  it('gives a float parameter NaN and the infinities, which JSON alone would make null, and refuses them for an integer one', async () => {
    const runtime = makeRuntime();
    const result = await runtime.loadScript(
      script(`
        let big = null
        let nan = null
        let intError = ""
        function go() {
          softn.wasm.load("assets/calc.wasm", function (m) {
            softn.wasm.call(m.handle, "scale", [Infinity, 2], function (r) { big = r.value })
            softn.wasm.call(m.handle, "scale", [NaN, 2], function (r) { nan = r.value })
            softn.wasm.call(m.handle, "add", [-Infinity, 1], function (r) { intError = r.error })
          })
        }
      `)
    );
    await result.functions.go();
    expect(runtime.state.big).toBe('Infinity');
    expect(runtime.state.nan).toBe('NaN');
    expect(runtime.state.intError).toMatch(/-Infinity is no whole number for a 32-bit parameter/);
  });

  it('needs the net permission for a module fetched from an address, and asks before any fetch', async () => {
    const fetched = vi.fn();
    vi.stubGlobal('fetch', fetched);
    const runtime = makeRuntime();
    const result = await runtime.loadScript(
      script(`
        let failure = ""
        function go() {
          softn.wasm.load("https://example.test/module.wasm", function (m) { failure = m.error || "" })
        }
      `)
    );
    await result.functions.go();
    expect(String(runtime.state.failure)).toMatch(/Network access not permitted/);
    expect(fetched).not.toHaveBeenCalled();
    expect(threads.length).toBe(0);
  });

  it('writes NaN and the infinities where a float goes, and refuses them, and null, where a whole number does', async () => {
    const runtime = makeRuntime();
    const result = await runtime.loadScript(
      script(`
        let back = null
        let refused = ""
        let nullRefused = ""
        function go() {
          softn.wasm.load("assets/calc.wasm", function (m) {
            softn.wasm.call(m.handle, "alloc", [16], function (a) {
              softn.wasm.write(m.handle, a.value, { f64: [NaN, -Infinity] }, function () {
                softn.wasm.read(m.handle, a.value, 2, "f64", function (r) { back = r.value })
              })
              softn.wasm.write(m.handle, a.value, { i32: [NaN] }, function (r) { refused = r.error })
              softn.wasm.write(m.handle, a.value, { i32: [null] }, function (r) { nullRefused = r.error })
            })
          })
        }
      `)
    );
    await result.functions.go();
    expect(runtime.state.back).toEqual(['NaN', '-Infinity']);
    expect(runtime.state.refused).toBe('write: NaN is not a number an i32 can hold');
    expect(runtime.state.nullRefused).toBe('write: null is not a number an i32 can hold');
  });

  // The host-JavaScript engine (vitest.host-js.config.ts) runs no Python at all.
  it.skipIf(!logicEngineRunsPython())('is the same in a Python app: load, call and run, each answer in its callback', async () => {
    const files = {
      readFile: async (path: string) => (FILES[path] ? FILES[path].slice().buffer : null),
      hasFile: async (path: string) => path in FILES,
    };
    const runtime = createScriptRuntime(
      {
        state: {},
        setState: () => {},
        data: {},
        xdb: createMockXDBModule(),
        nav: createMockNavModule(),
        console: createConsoleModule(),
      },
      undefined,
      'wasm-python-app',
      undefined,
      undefined,
      {
        mode: 'main',
        pythonProject: {
          files: {
            app: [
              'import softn',
              '',
              'total = None',
              'loud = None',
              'out = None',
              'big = None',
              'back = None',
              'handle = None',
              'spot = None',
              '',
              'def go():',
              '    softn.wasm.load("assets/calc.wasm", {}, on_loaded)',
              '    softn.wasm.run("assets/wasi_tool.wasm", {"args": ["shout"], "stdin": "from python"}, on_ran)',
              '',
              'def on_loaded(m):',
              '    global handle',
              '    handle = m["handle"]',
              '    softn.wasm.call(m["handle"], "add", [20, 22], {}, on_added)',
              '    softn.wasm.call(m["handle"], "shout", ["snake"], {"returns": "text"}, on_shouted)',
              // An infinity reaches a float parameter as it is, and a NaN memory: every other call sends them as None.
              '    softn.wasm.call(m["handle"], "scale", [float("inf"), 2.0], {}, on_scaled)',
              '    softn.wasm.call(m["handle"], "alloc", [8], {}, on_alloc)',
              '',
              'def on_scaled(r):',
              '    global big',
              '    big = r["value"]',
              '',
              'def on_alloc(r):',
              '    global spot',
              '    spot = r["value"]',
              '    softn.wasm.write(handle, spot, {"f64": [float("nan")]}, on_written)',
              '',
              'def on_written(r):',
              '    softn.wasm.read(handle, spot, 1, "f64", on_read)',
              '',
              'def on_read(r):',
              '    global back',
              '    back = r["value"]',
              '',
              'def on_added(r):',
              '    global total',
              '    total = r["value"]',
              '',
              'def on_shouted(r):',
              '    global loud',
              '    loud = r["value"]',
              '',
              'def on_ran(r):',
              '    global out',
              '    out = r["stdout"]',
            ].join('\n'),
          },
          modules: ['app'],
        },
      },
      files as never
    );
    (runtime as unknown as { setPermissionConfig(c: PermissionConfig): void }).setPermissionConfig({ permissions: {} } as PermissionConfig);
    runtimes.push(runtime as unknown as { cleanup(): void });
    const loaded = await runtime.loadScript({ type: 'ScriptBlock', code: '', loc: { line: 1, column: 0, start: 0, end: 0 } });
    await loaded.functions.go();
    const internals = runtime as unknown as {
      symbolMap: Map<string, { index: number; scope: string }>;
      vmEngine: { getGlobalsBatch(indices: number[]): unknown[] };
    };
    const names = [...internals.symbolMap.entries()].filter(([name, s]) => s.scope !== 'function' && ['total', 'loud', 'out', 'big', 'back'].includes(name));
    const values = internals.vmEngine.getGlobalsBatch(names.map(([, s]) => s.index));
    const state = Object.fromEntries(names.map(([name], i) => [name, values[i]]));
    expect(state).toEqual({ total: 42, loud: 'SNAKE', out: 'FROM PYTHON', big: 'Infinity', back: ['NaN'] });
  });

  it('stops every module when the app closes', async () => {
    const runtime = makeRuntime();
    const result = await runtime.loadScript(
      script(`
        let handle = ""
        function go() { softn.wasm.load("assets/calc.wasm", function (m) { handle = m.handle }) }
      `)
    );
    await result.functions.go();
    expect(String(runtime.state.handle)).toMatch(/^wasm-/);
    const terminate = vi.spyOn(threads[0], 'terminate');
    runtime.cleanup();
    expect(terminate).toHaveBeenCalled();
  });
});
