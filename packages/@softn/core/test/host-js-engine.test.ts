/**
 * The host-JavaScript engine: `.logic` run as the host document's own
 * JavaScript, behind the same `LogicEngine` seam ZIPP sits behind.
 *
 * What is pinned here: it satisfies the surface the main-thread runtime calls,
 * including through the real `SoftNScriptRuntime`; it says it runs on the main
 * thread only, which is what stops a bundle asking for a Worker it could not
 * exist in; a top-level `const` is writable from the host, because the runtime's
 * state sync depends on that; host writes merge over what they could only read
 * as null; values cross with ZIPP's projection; and `accel` is not available.
 *
 * What is NOT pinned here, deliberately: the frame this engine is only safe
 * inside. The opaque origin and the `'unsafe-eval'` document are the FormLogic
 * shell's to check (`apps/formlogic-host/src/hostEngine.ts`), which is exactly
 * why they are not in the adapter — so this suite can drive it untouched.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HOST_JS_ENGINE_MARK, HostJsAdapter, HostJsEngine } from '../src/runtime/host-js';

/** Compile `code` on a fresh engine and answer it with its symbol map. */
async function compile(code: string) {
  const engine = await HostJsAdapter.create();
  const symbols = await engine.initializeScript(code);
  return { engine, symbols };
}

/** The slot index of a top-level name, or a failed expectation. */
function slotOf(symbols: Map<string, { index: number }>, name: string): number {
  const symbol = symbols.get(name);
  expect(symbol, `${name} has a slot`).toBeDefined();
  return symbol!.index;
}

describe('the host JavaScript engine as a logic engine', () => {
  it('runs on the main thread only, and says so before it is created', async () => {
    expect(HostJsEngine.threads).toBe('main-only');
    vi.resetModules();
    const seam = await import('../src/runtime/vm-adapter');
    expect(seam.logicEngineThreads()).toBe('any');
    seam.configureLogicEngine(HostJsEngine);
    // The renderer reads this while it mounts, to take the Worker away from a
    // bundle that asked for one: the Worker names the ZIPP adapter itself and
    // this engine is the host document's, which no worker realm has.
    expect(seam.logicEngineThreads()).toBe('main-only');
    const engine = await seam.createLogicEngine();
    expect(engine).toBeInstanceOf(HostJsAdapter);
    engine.dispose();
  });

  it('is what the script runtime compiles and drives', async () => {
    vi.resetModules();
    const seam = await import('../src/runtime/vm-adapter');
    seam.configureLogicEngine(HostJsEngine);
    const runtime = await import('../src/runtime/script-runtime');
    const state: Record<string, unknown> = {};
    const handle = runtime.createScriptRuntime({
      state,
      setState: (path: string, value: unknown) => void (state[path] = value),
      data: {},
      xdb: runtime.createMockXDBModule(),
      nav: runtime.createMockNavModule(),
      console: runtime.createConsoleModule(),
    });
    const code = 'let total = 41;\nfunction bump() { total = total + 1; return total; }';
    const result = await handle.loadScript({
      type: 'ScriptBlock',
      code,
      loc: { line: 1, column: 0, start: 0, end: code.length },
    });
    // The script's own top-level state, read back out of the engine.
    expect(result.state).toMatchObject({ total: 41 });
    expect(typeof result.functions.bump).toBe('function');
    await result.functions.bump();
    handle.cleanup();
  }, 30_000);

  it('reports the script’s top-level declarations, and the preamble names', async () => {
    const { engine, symbols } = await compile(
      'var a = 1; let b = 2; const c = 3; function f() {} class K {}\n' +
        'if (a) { var hoisted = 9; let blockOnly = 1; void blockOnly; }\n' +
        'for (const item of [1]) { void item; }'
    );
    expect([...symbols.keys()].sort()).toEqual(
      ['K', 'a', 'b', 'c', 'f', 'hoisted', 'host', 'navigator', 'window'].sort()
    );
    expect(symbols.get('f')!.scope).toBe('function');
    expect(symbols.get('K')!.scope).toBe('function');
    expect(symbols.get('b')!.scope).toBe('variable');
    expect(engine.getGlobal(slotOf(symbols, 'a'))).toBe(1);
    expect(engine.getGlobal(slotOf(symbols, 'c'))).toBe(3);
    // `var` inside a block hoists to the top level; `let` inside one does not,
    // and neither does a `for (const …)` head.
    expect(engine.getGlobal(slotOf(symbols, 'hoisted'))).toBe(9);
    engine.dispose();
  });

  it('lets the host write a top-level const, because the runtime’s state sync does', async () => {
    const { engine, symbols } = await compile('const counter = { n: 1 };\nfunction read() { return counter.n; }');
    const slot = slotOf(symbols, 'counter');
    engine.setGlobal(slot, { n: 7 });
    expect(engine.getGlobal(slot)).toEqual({ n: 7 });
    // The script sees the write, not a copy of it.
    expect(engine.callFunction('read', [])).toBe(7);
    engine.dispose();
  });

  it('merges a host write over what the host could only read as null', async () => {
    const { engine, symbols } = await compile(
      'let rows = [{ id: "a", when: new Date(0), tags: ["x"] }];\n' +
        'function whenIsDate() { return rows[0].when instanceof Date; }'
    );
    const slot = slotOf(symbols, 'rows');
    // The host reads the Date as null, the way ZIPP projects it.
    expect(engine.getGlobal(slot)).toEqual([{ id: 'a', when: null, tags: ['x'] }]);
    // …and writing that back must not destroy it.
    engine.setGlobal(slot, [{ id: 'b', when: null, tags: ['x', 'y'] }]);
    expect(engine.callFunction('whenIsDate', [])).toBe(true);
    expect(engine.getGlobal(slot)).toEqual([{ id: 'b', when: null, tags: ['x', 'y'] }]);
    engine.dispose();
  });

  it('projects values the way ZIPP does, in both directions', async () => {
    const { engine, symbols } = await compile(
      'let plain = { n: 1, s: "t", b: true, nil: null, list: [1, [2]] };\n' +
        'let fn = function () {};\nlet map = new Map();\nlet big = 10n;\nlet cyclic = {};\ncyclic.self = cyclic;'
    );
    expect(engine.getGlobal(slotOf(symbols, 'plain'))).toEqual({
      n: 1,
      s: 't',
      b: true,
      nil: null,
      list: [1, [2]],
    });
    for (const name of ['fn', 'map', 'big']) {
      expect(engine.getGlobal(slotOf(symbols, name)), name).toBeNull();
    }
    expect(engine.getGlobal(slotOf(symbols, 'cyclic'))).toEqual({ self: null });
    // A host write over a function is not a write at all: the host only ever
    // saw null there.
    engine.setGlobal(slotOf(symbols, 'fn'), { replaced: true });
    expect(engine.getGlobal(slotOf(symbols, 'fn'))).toBeNull();
    engine.dispose();
  });

  it('calls functions, dispatches events and queues host calls', async () => {
    const { engine, symbols } = await compile(
      'let seen = [];\n' +
        'function add(a, b) { return a + b; }\n' +
        'window.addEventListener("keydown", function (e) { seen.push(e.key); });\n' +
        'function ask() { host.call("thing", [1, "two"], function (r) { seen.push(r); }); }'
    );
    expect(engine.callFunction('add', [2, 3])).toBe(5);
    expect(() => engine.callFunction('nope', [])).toThrow(/no such function/);
    expect(engine.getEventListenerTypes()).toEqual(['keydown']);
    expect(engine.dispatchEvent('keydown', { type: 'keydown', key: 'a' })).toBe(1);
    expect(engine.dispatchEvent('keyup', { type: 'keyup' })).toBe(0);
    engine.callFunction('ask', []);
    const queued = engine.drainPendingHostCalls();
    expect(queued).toEqual([{ id: 1, kind: 'thing', args: ['1', 'two'] }]);
    expect(engine.drainPendingHostCalls()).toEqual([]);
    engine.resolveHostCallback(queued[0].id, 'answered');
    expect(engine.getGlobal(slotOf(symbols, 'seen'))).toEqual(['a', 'answered']);
    // A completion for a call already settled does nothing.
    engine.resolveHostCallback(queued[0].id, 'again');
    expect(engine.getGlobal(slotOf(symbols, 'seen'))).toEqual(['a', 'answered']);
    engine.dispose();
  });

  it('denies a synchronous capability the host never wired, and has no accel at all', async () => {
    const { engine, symbols } = await compile(
      'function save() { localStorage.setItem("k", "v"); }\n' +
        'function accelerate() { return accel.compile([], "return 1"); }'
    );
    expect(() => engine.callFunction('save', [])).toThrow(/capability denied: ls.setItem/);
    // accel compiles numeric functions over views of the VM's memory. There is
    // no VM memory here, so it is unavailable however the host is configured.
    engine.registerAccelBridge();
    expect(() => engine.callFunction('accelerate', [])).toThrow(/accel is not available/);
    expect(slotOf(symbols, 'window')).toBeGreaterThanOrEqual(0);
    engine.dispose();
  });

  it('stores through a wired localStorage bridge, app-scoped', async () => {
    const written = new Map<string, string>();
    const engine = await HostJsAdapter.create();
    engine.registerLocalStorageBridgeCustom({
      getItem: (key) => written.get(key) ?? null,
      setItem: (key, value) => void written.set(key, value),
      removeItem: (key) => void written.delete(key),
      clear: () => written.clear(),
    });
    const symbols = await engine.initializeScript(
      'function save(v) { localStorage.setItem("k", v); }\nfunction load() { return localStorage.getItem("k"); }'
    );
    expect(symbols.has('window')).toBe(true);
    engine.callFunction('save', ['kept']);
    expect(written.get('k')).toBe('kept');
    expect(engine.callFunction('load', [])).toBe('kept');
    engine.dispose();
  });

  it('stops only when a script fails to compile, and stays usable otherwise', async () => {
    const engine = await HostJsAdapter.create();
    await expect(engine.initializeScript('let = ;')).rejects.toThrow();
    // The runtime answers a failed compile by building a fresh engine, so this
    // one says it is finished — the same thing a terminated ZIPP engine says.
    expect(engine.terminated).toBe(true);

    const good = await HostJsAdapter.create();
    const symbols = await good.initializeScript('let n = 1;\nfunction boom() { throw new Error("from the app"); }');
    expect(() => good.callFunction('boom', [])).toThrow(/from the app/);
    // A script error is the script's, not the engine's: nothing was torn down
    // and the next call still works.
    expect(good.terminated).toBe(false);
    expect(good.getGlobal(slotOf(symbols, 'n'))).toBe(1);
    good.dispose();
  });

  it("honours a leading 'use strict', which the prologue must not demote", async () => {
    // The generated prologue runs before the author's first statement, so a
    // directive left where the author wrote it would be an ordinary string
    // expression. Repeated ahead of the prologue, it is a directive again.
    const { engine, symbols } = await compile(
      [
        "'use strict';",
        'function f() { return this === undefined; }',
        'var fThis = f();',
        'var topThis = this === globalThis;',
        'var arity = arguments.length;',
      ].join('\n')
    );
    expect(engine.getGlobal(slotOf(symbols, 'fThis'))).toBe(true);
    // Top-level `this` is the global object under strict mode too, as it is in
    // a classic script.
    expect(engine.getGlobal(slotOf(symbols, 'topThis'))).toBe(true);
    // `arguments` is the script's own function's, which takes none — not the
    // compiled closure's six facades and export callback.
    expect(engine.getGlobal(slotOf(symbols, 'arity'))).toBe(0);
    engine.dispose();

    // An undeclared assignment throws under strict mode and creates nothing.
    const strict = await HostJsAdapter.create();
    await expect(strict.initializeScript(["'use strict';", 'hostJsUndeclaredLeak = 42;'].join('\n'))).rejects.toThrow(
      ReferenceError
    );
    expect((globalThis as Record<string, unknown>).hostJsUndeclaredLeak).toBeUndefined();

    // The same spelling the author used, so an escaped string — which is not a
    // directive by the language's own rule — is not turned into one.
    const escaped = await HostJsAdapter.create();
    const map = await escaped.initializeScript(
      ['"use\\x20strict";', 'hostJsSloppyLeak = 1;', 'var leaked = typeof globalThis.hostJsSloppyLeak;'].join('\n')
    );
    expect(escaped.getGlobal(slotOf(map, 'leaked'))).toBe('number');
    delete (globalThis as Record<string, unknown>).hostJsSloppyLeak;
    escaped.dispose();
  });

  it('gives the script an empty arguments object, not the engine’s facades', async () => {
    const { engine, symbols } = await compile(
      'var n = arguments.length; var kinds = Array.from(arguments, (x) => typeof x);'
    );
    expect(engine.getGlobal(slotOf(symbols, 'n'))).toBe(0);
    expect(engine.getGlobal(slotOf(symbols, 'kinds'))).toEqual([]);
    engine.dispose();
  });

  it('refuses a script that declares a preamble name, as ZIPP does', async () => {
    // A `var window = 1` would rebind the closure's parameter and give the
    // script a value of its own where ZIPP refuses the redeclaration; the
    // refusal here is the same sentence, for every declaration kind.
    for (const code of [
      'var window = 1;',
      'function host() {}',
      'let navigator = 1;',
      'if (1) { var db = 2; }',
      'const accel = 0;',
      'var localStorage;',
    ]) {
      const engine = await HostJsAdapter.create();
      await expect(engine.initializeScript(code), code).rejects.toThrow(/Identifier '\w+' has already been declared/);
      expect(engine.terminated, code).toBe(true);
    }
    // Using one is what a script does, and is untouched.
    const { engine, symbols } = await compile('var w = typeof window; var h = typeof host.call;');
    expect(engine.getGlobal(slotOf(symbols, 'w'))).toBe('object');
    expect(engine.getGlobal(slotOf(symbols, 'h'))).toBe('function');
    engine.dispose();
  });

  it('evaluates an expression in the script’s own scope', async () => {
    const { engine } = await compile('let a = 2;\nlet b = 3;\nfunction f() { return 1; }');
    expect(engine.evalSync('a * b')).toBe(6);
    // Whatever will not JSON crosses as nothing rather than by reference.
    expect(engine.evalSync('f')).toBeUndefined();
    engine.dispose();
  });
});

describe('where the host JavaScript engine ships', () => {
  const src = resolve(__dirname, '../src');
  const read = (file: string) => readFileSync(resolve(src, file), 'utf8');

  it('is reachable only through its own entry, never the default one', () => {
    // The seam's default is still ZIPP, and nothing in the barrel reaches this
    // engine: a build that does not import @softn/core/host-js cannot contain
    // it. `scripts/host-js-isolation.test.mjs` checks the built bundles.
    for (const file of ['index.ts', 'runtime/index.ts', 'runtime/vm-adapter.ts', 'loader/SoftNRenderer.tsx']) {
      expect(read(file), file).not.toMatch(/host-js/);
    }
    expect(read('runtime/vm-adapter.ts')).toMatch(/let engineFactory: LogicEngineFactory = ZippWasmAdapter/);
  });

  it('carries a mark a bundle scan can look for', () => {
    expect(HOST_JS_ENGINE_MARK).toBe('softn.host-js.engine/1');
    expect(HostJsEngine.mark).toBe(HOST_JS_ENGINE_MARK);
    // The adapter names its own engine and not ZIPP's: a value import from the
    // seam would pull the ZIPP adapter into this entry.
    const adapter = read('runtime/host-js/host-js-adapter.ts');
    expect(adapter).toMatch(/import type \{[^}]*\} from '\.\.\/vm-adapter'/);
    expect(adapter).not.toMatch(/^import \{[^}]*\} from '\.\.\/vm-adapter'/m);
  });
});
