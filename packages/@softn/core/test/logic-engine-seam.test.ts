/**
 * The engine `.logic` runs on is a seam, and by default it is still ZIPP.
 *
 * `vm-adapter.ts` has always been the one place the engine is named, but it
 * named it at build time: `script-runtime.ts` imported the class and called its
 * constructor. A host that has to decide per page — one app on the WASM engine,
 * another on something else — could not do that by editing a re-export. So the
 * choice moved to a module-level factory, configured before the first engine is
 * created and frozen afterwards, exactly the way the engine's BYTES already
 * are (`configureZippWasmSource`).
 *
 * What is pinned here: nothing has changed for a host that configures nothing;
 * a configured factory is what the runtime actually builds and drives; the
 * choice cannot be changed underneath a running app; an engine that exists only
 * on the main thread takes the worker choice away from a bundle that asked for
 * one; and the Worker runtime is deliberately outside all of it.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  VmAdapter,
  configureLogicEngine,
  createLogicEngine,
  logicEngineThreads,
  type LogicEngine,
  type SymbolInfo,
} from '../src/runtime/vm-adapter';

/**
 * An engine that answers the surface `SoftNScriptRuntime` calls and nothing
 * more — the point being that nothing more is needed. `symbols` is what it
 * reports back from a compile; every global reads as its own index.
 */
function stubEngine(symbols: Record<string, SymbolInfo> = {}) {
  const globals = new Map<number, unknown>();
  const engine = {
    registerDBBridge: vi.fn(),
    registerLocalStorageBridge: vi.fn(),
    registerClipboardBridge: vi.fn(),
    onStorageFailure: null,
    initializeScript: vi.fn(async (_code: string) => new Map(Object.entries(symbols))),
    getGlobal: (index: number) => (globals.has(index) ? globals.get(index) : index),
    setGlobal: (index: number, value: unknown) => void globals.set(index, value),
    getGlobalsBatch: (indices: number[]) => indices.map((i) => engine.getGlobal(i)),
    setGlobalsBatch: (indices: number[], values: unknown[]) =>
      indices.forEach((index, i) => globals.set(index, values[i])),
    callFunction: vi.fn(() => undefined),
    callFunctionSync: vi.fn(() => undefined),
    evalSync: vi.fn(() => undefined),
    getEventListenerTypes: () => [] as string[],
    dispatchEvent: () => 0,
    drainPendingHostCalls: () => [],
    resolveHostCallback: vi.fn(),
    dispose: vi.fn(),
    terminated: false,
  };
  return engine satisfies LogicEngine;
}

describe('the default logic engine', () => {
  it('is the ZIPP adapter, on any thread, with nothing configured', async () => {
    expect(logicEngineThreads()).toBe('any');
    const engine = await createLogicEngine();
    try {
      expect(engine).toBeInstanceOf(VmAdapter);
    } finally {
      engine.dispose();
    }
  });

  it('cannot be changed once an engine has been created', async () => {
    const engine = await createLogicEngine();
    engine.dispose();
    expect(() => configureLogicEngine({ create: async () => stubEngine() })).toThrow(
      /before the first engine is created/
    );
    // The refusal leaves the choice as it was, rather than half-applied.
    expect(logicEngineThreads()).toBe('any');
  });

  it('refuses a factory that cannot make anything', async () => {
    vi.resetModules();
    const seam = await import('../src/runtime/vm-adapter');
    expect(() => seam.configureLogicEngine({} as never)).toThrow(TypeError);
    expect(() => seam.configureLogicEngine(undefined as never)).toThrow(TypeError);
    // A refusal leaves the seam usable rather than half-applied.
    const engine = stubEngine();
    seam.configureLogicEngine({ create: async () => engine });
    expect(await seam.createLogicEngine()).toBe(engine);
  });
});

describe('a configured logic engine', () => {
  it('is what the script runtime compiles and drives', async () => {
    vi.resetModules();
    const seam = await import('../src/runtime/vm-adapter');
    const engine = stubEngine({ total: { index: 3, scope: 'variable' } });
    seam.configureLogicEngine({ create: async () => engine });

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
    const code = 'let total = 41';
    const result = await handle.loadScript({
      type: 'ScriptBlock',
      code,
      loc: { line: 1, column: 0, start: 0, end: code.length },
    });

    // The stub compiled the script, wired the bridges and reported the state.
    expect(engine.initializeScript).toHaveBeenCalledOnce();
    expect(engine.initializeScript.mock.calls[0][0]).toContain(code);
    expect(engine.registerDBBridge).toHaveBeenCalledOnce();
    expect(result.state).toEqual({ total: 3 });
    handle.cleanup();
    expect(engine.dispose).toHaveBeenCalled();
  });

  it('that runs only on this thread takes the worker choice away', async () => {
    const source = '<logic>\nlet n = 1\n</logic>\n<div class="n">{n}</div>';
    const symbols = { n: { index: 1, scope: 'variable' as const } };

    /** Render one app on an engine with the given thread hint. */
    const renderOn = async (threads: 'any' | 'main-only') => {
      vi.resetModules();
      const createWorkerScriptRuntime = vi.fn(() => ({
        loadScript: async () => ({ state: {}, functions: {}, syncFunctions: {}, computed: {} }),
        updateContext: () => {},
        cleanup: () => {},
      }));
      vi.doMock('../src/runtime/script-worker-runtime', () => ({ createWorkerScriptRuntime }));
      const seam = await import('../src/runtime/vm-adapter');
      const engine = stubEngine(symbols);
      seam.configureLogicEngine({ create: async () => engine, threads });
      expect(seam.logicEngineThreads()).toBe(threads);

      const { SoftNRenderer } = await import('../src/loader/SoftNRenderer');
      const { createRoot } = await import('react-dom/client');
      const { act } = await import('react');
      const React = (await import('react')).default;
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      await act(async () => {
        root.render(
          React.createElement(SoftNRenderer, {
            source,
            appId: 'EngineThreads',
            executionPreference: 'worker',
            permissions: { storage: true },
            permissionConfig: { permissions: {} },
            preIncludedLogicPaths: [],
            onError: () => {},
          })
        );
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 200));
      });
      await act(async () => root.unmount());
      container.remove();
      vi.doUnmock('../src/runtime/script-worker-runtime');
      return { createWorkerScriptRuntime, engine };
    };

    // The control: the same bundle, the same request, an engine that says
    // nothing about threads — the worker runtime is used, as it is today.
    const any = await renderOn('any');
    expect(any.createWorkerScriptRuntime).toHaveBeenCalled();
    expect(any.engine.initializeScript).not.toHaveBeenCalled();

    // main-only: the worker runtime is never built and the engine runs here.
    const mainOnly = await renderOn('main-only');
    expect(mainOnly.createWorkerScriptRuntime).not.toHaveBeenCalled();
    expect(mainOnly.engine.initializeScript).toHaveBeenCalled();
  }, 60_000);
});

describe('the Worker script runtime', () => {
  it('names the ZIPP adapter itself and is outside the seam', () => {
    const worker = readFileSync(resolve(__dirname, '../src/runtime/script-worker.ts'), 'utf8');
    // Deliberate: a worker cannot reach a host document's engine, and the
    // module-level choice made on the main thread is not its realm's. E3's
    // main-only hint is what keeps a bundle from landing here on one.
    expect(worker).toMatch(/VmAdapter\.create\(\)/);
    expect(worker).not.toMatch(/createLogicEngine|configureLogicEngine/);
  });
});
