/**
 * One app cannot fill the browser's storage for the host and every other app.
 *
 * The site has one store, about five megabytes, shared by the host and all
 * its apps. A bundle with no permissions wrote until it was full, and the
 * host's next write failed, and every other app's, until that app's data was
 * cleared. Each app now has a budget (runtime/storage-budget.ts).
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  createConsoleModule,
  createMockNavModule,
  createMockXDBModule,
  createScriptRuntime,
  type ScriptContext,
} from '../src/runtime/script-runtime';
import { StorageBudget, LOCAL_STORAGE_BUDGET } from '../src/runtime/storage-budget';
import { XDBService } from '../src/runtime/xdb-service';
import { logicEngineIsSandboxed } from '../src/runtime/vm-adapter';
import type { ScriptBlock } from '../src/parser/ast';

afterEach(() => localStorage.clear());

function script(code: string): ScriptBlock {
  return { type: 'ScriptBlock', code, loc: { line: 1, column: 0, start: 0, end: code.length } };
}

describe('an app’s share of the browser’s storage', () => {
  // The sandbox's localStorage bridge. Code on the host-JavaScript engine is
  // the host document's own (FormLogic's frame, an origin of its own), with
  // the page's own storage and no bridge between.
  it.skipIf(!logicEngineIsSandboxed())('refuses the write that would take the app past its budget, and the host can still write', async () => {
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
    const runtime = createScriptRuntime(context, undefined, 'filler');
    const result = await runtime.loadScript(
      script(`
        let refused = ""
        let written = 0
        function fill() {
          const chunk = "x".repeat(200000)
          try {
            for (let i = 0; i < 40; i++) { localStorage.setItem("k" + i, chunk); written = written + 1 }
          } catch (e) { refused = String(e) }
        }
      `)
    );
    try {
      await result.functions.fill();
      // Five chunks fit in a megabyte; the sixth is refused, and the app's code hears so.
      expect(state.written).toBe(5);
      expect(String(state.refused)).not.toBe('');
      expect(localStorage.getItem('softn:filler:k5')).toBeNull();
      expect(() => localStorage.setItem('host-setting', 'kept')).not.toThrow();
      expect(localStorage.getItem('host-setting')).toBe('kept');
    } finally {
      runtime.cleanup();
    }
  });

  it('counts what the app already had, and frees what it removes', () => {
    localStorage.setItem('softn:a:old', 'y'.repeat(LOCAL_STORAGE_BUDGET - 100));
    localStorage.setItem('softn:b:other', 'z'.repeat(1000));
    const budget = new StorageBudget(localStorage, 'softn:a:', LOCAL_STORAGE_BUDGET);
    expect(() => budget.admit('softn:a:new', 'n'.repeat(200))).toThrow(/QuotaExceededError|past that/);
    // Another app's keys are not this app's.
    expect(() => budget.admit('softn:a:new', 'n'.repeat(50))).not.toThrow();
    localStorage.removeItem('softn:a:old');
    budget.removed('softn:a:old');
    expect(() => budget.admit('softn:a:new', 'n'.repeat(200))).not.toThrow();
  });

  it('holds an app’s records to theirs', async () => {
    const xdb = new XDBService(undefined, 'xdb:records-app', 'records-app', { backend: 'storage' });
    await xdb.isReady;
    const big = 'r'.repeat(500_000);
    let thrown: unknown = null;
    try {
      for (let i = 0; i < 10; i++) xdb.create('notes', { body: big, n: i });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).not.toBeNull();
    expect(String((thrown as Error).message)).toMatch(/past that|Could not save/);
    expect(() => localStorage.setItem('host-setting', 'kept')).not.toThrow();
  });
});
