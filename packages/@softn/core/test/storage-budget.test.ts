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
import { SnapshotLocalStorageBridge } from '../src/runtime/script-worker-bridges';
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

  it('lets an app that already holds more than its budget write less, never more', () => {
    localStorage.setItem('xdb:old:notes', 'n'.repeat(3_500_000));
    const budget = new StorageBudget(localStorage, 'xdb:old:', 3 * 1024 * 1024);
    // A smaller rewrite of the same collection, and a new key in exchange for less.
    expect(() => budget.admit('xdb:old:notes', 'n'.repeat(3_000_000))).not.toThrow();
    expect(() => budget.admit('xdb:old:notes', 'n'.repeat(3_600_000))).toThrow();
    expect(() => budget.admit('xdb:old:other', 'x')).toThrow();
    localStorage.removeItem('xdb:old:notes');
    budget.removed('xdb:old:notes');
    expect(() => budget.admit('xdb:old:other', 'x')).not.toThrow();
  });

  // Each engine has a budget of its own. Each counted what was stored at its first write and
  // only its own writes after, so an app open twice kept a megabyte for each view, and five
  // views filled the store.
  it('is one share for an app open twice in a page: what one view writes, the other counts', () => {
    const half = 'h'.repeat(LOCAL_STORAGE_BUDGET / 2);
    const one = new StorageBudget(localStorage, 'softn:twice:', LOCAL_STORAGE_BUDGET);
    const other = new StorageBudget(localStorage, 'softn:twice:', LOCAL_STORAGE_BUDGET);
    const write = (budget: StorageBudget, key: string, value: string) => {
      budget.admit(key, value);
      localStorage.setItem(key, value);
      budget.wrote(key, value);
    };
    // Both have counted, and each then writes keys of its own.
    write(one, 'softn:twice:a', 'small');
    write(other, 'softn:twice:b', 'small');
    write(one, 'softn:twice:one', half);
    expect(() => write(other, 'softn:twice:other', half)).toThrow(/past that/);
    expect(localStorage.getItem('softn:twice:other')).toBeNull();

    // And what one removes, the other may use.
    localStorage.removeItem('softn:twice:one');
    one.removed('softn:twice:one');
    expect(() => write(other, 'softn:twice:other', half)).not.toThrow();
    expect(() => write(one, 'softn:twice:one', half)).toThrow(/past that/);
  });

  it.skipIf(!logicEngineIsSandboxed())('is one share for two engines of one app, each writing keys of its own', async () => {
    const filler = `
      let written = 0
      function fill(name, count) {
        const chunk = "x".repeat(200000)
        try {
          for (let i = 0; i < count; i++) { localStorage.setItem(name + i, chunk); written = written + 1 }
        } catch (e) {}
      }
    `;
    const open = async () => {
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
      const runtime = createScriptRuntime(context, undefined, 'twins');
      const result = await runtime.loadScript(script(filler));
      return { runtime, state, fill: result.functions.fill };
    };
    const first = await open();
    const second = await open();
    try {
      // Each writes once, so each has counted; then each fills what it believes is left.
      await first.fill('first-a', 1);
      await second.fill('second-a', 1);
      await first.fill('first-b', 40);
      await second.fill('second-b', 40);
      let stored = 0;
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)!;
        if (key.startsWith('softn:twins:')) stored += key.length + localStorage.getItem(key)!.length;
      }
      expect(stored).toBeLessThanOrEqual(LOCAL_STORAGE_BUDGET);
      // Five chunks fit in a megabyte, between them.
      expect(Number(first.state.written) + Number(second.state.written)).toBe(5);
    } finally {
      first.runtime.cleanup();
      second.runtime.cleanup();
    }
  });

  it('counts what another tab of the app wrote, and what it removed', () => {
    const most = 'm'.repeat(LOCAL_STORAGE_BUDGET - 1000);
    const budget = new StorageBudget(localStorage, 'softn:tabs:', LOCAL_STORAGE_BUDGET);
    expect(() => budget.admit('softn:tabs:mine', 'n'.repeat(5000))).not.toThrow();
    // Another tab writes: the browser stores it, and tells every tab but that one.
    const fromAnotherTab = (key: string | null, newValue: string | null) => {
      if (key === null) localStorage.clear();
      else if (newValue === null) localStorage.removeItem(key);
      else localStorage.setItem(key, newValue);
      window.dispatchEvent(new StorageEvent('storage', { key, newValue, storageArea: localStorage }));
    };
    fromAnotherTab('softn:tabs:theirs', most);
    expect(() => budget.admit('softn:tabs:mine', 'n'.repeat(5000))).toThrow(/past that/);
    // Another app's keys, written in another tab, are not this app's.
    fromAnotherTab('softn:tabs:theirs', null);
    fromAnotherTab('softn:other:theirs', most);
    expect(() => budget.admit('softn:tabs:mine', 'n'.repeat(5000))).not.toThrow();
    fromAnotherTab('softn:tabs:theirs', most);
    fromAnotherTab(null, null);
    expect(budget.room('softn:tabs:mine')).toBe(LOCAL_STORAGE_BUDGET - 'softn:tabs:mine'.length);
  });

  // The host removes a stopped app's data by the keys, in this page, where no event says so.
  // The app's records keep one budget for the life of the page, and refused every write after.
  it('counts again before it refuses, so keys the host removed are not held against the app', () => {
    const most = 'm'.repeat(LOCAL_STORAGE_BUDGET - 1000);
    const budget = new StorageBudget(localStorage, 'softn:cleared:', LOCAL_STORAGE_BUDGET);
    budget.admit('softn:cleared:data', most);
    localStorage.setItem('softn:cleared:data', most);
    budget.wrote('softn:cleared:data', most);
    expect(() => budget.admit('softn:cleared:more', most)).toThrow(/past that/);
    localStorage.removeItem('softn:cleared:data');
    expect(() => budget.admit('softn:cleared:more', most)).not.toThrow();
  });

  it('holds a worker’s own bridge to it write after write, a refused one included', () => {
    const bridge = new SnapshotLocalStorageBridge();
    bridge.setBudgetPrefix('softn:worker-fill:');
    bridge.updateSnapshot({ kept: 'k'.repeat(100_000) });
    const chunk = 'x'.repeat(200_000);
    let written = 0;
    const fill = () => {
      try {
        for (let i = 0; i < 40; i++) {
          bridge.setItem(`k${written}`, chunk);
          written++;
        }
      } catch {
        // Refused: the app's share is full.
      }
    };
    fill();
    expect(written).toBe(4);
    // Refused again, however often it asks: what it has written is counted each time.
    fill();
    expect(written).toBe(4);
    bridge.removeItem('kept');
    fill();
    expect(written).toBe(5);
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
