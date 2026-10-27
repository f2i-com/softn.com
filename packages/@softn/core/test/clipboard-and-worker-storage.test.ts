// @vitest-environment jsdom
/**
 * The clipboard is written from what the person did, and an app's
 * localStorage is held to its share in worker mode as on the main thread.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createConsoleModule,
  createMockNavModule,
  createMockXDBModule,
  createScriptRuntime,
  type ScriptContext,
} from '../src/runtime/script-runtime';
import { createWorkerScriptRuntime } from '../src/runtime/script-worker-runtime';
import { SnapshotLocalStorageBridge, SnapshotDBBridge } from '../src/runtime/script-worker-bridges';
import { VmAdapter, VM_BRIDGE_PREAMBLE } from '../src/runtime/vm-adapter';
import { SOFTN_BRIDGE_PREAMBLE } from '../src/runtime/softn-preamble';

function makeContext(): ScriptContext {
  const state: Record<string, unknown> = {};
  return {
    state,
    setState: (path, value) => {
      state[path] = value;
    },
    data: {},
    xdb: createMockXDBModule(),
    nav: createMockNavModule(),
    console: createConsoleModule(),
  };
}
const loc = { line: 1, column: 0, start: 0, end: 0 };
const ON_A_TIMER = `
  let n = 0;
  setInterval(function () { n++; navigator.clipboard.writeText("bc1q-attacker-" + n); }, 10);
`;

const writes: string[] = [];
let activation: { isActive: boolean } | undefined;
beforeEach(() => {
  writes.length = 0;
  activation = undefined;
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: (t: string) => { writes.push(t); return Promise.resolve(); } },
  });
  Object.defineProperty(navigator, 'userActivation', { configurable: true, get: () => activation });
});
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

async function runFor(ms: number, permissionConfig: Record<string, unknown>) {
  const runtime = createScriptRuntime(makeContext(), undefined, `clip-${Math.random()}`, undefined, undefined, { permissionConfig: permissionConfig as never });
  await runtime.loadScript({ type: 'ScriptBlock', loc, code: ON_A_TIMER });
  await new Promise((r) => setTimeout(r, ms));
  runtime.cleanup();
}

describe('the clipboard', () => {
  it('is not written while the permission bar is unanswered', async () => {
    activation = { isActive: true };
    await runFor(80, { permissions: {}, consentPending: true });
    expect(writes).toEqual([]);
  });

  it('is not written on a timer, with nothing the person did', async () => {
    activation = { isActive: false };
    await runFor(80, { permissions: {} });
    expect(writes).toEqual([]);
  });

  it('is written from a click or a key press', async () => {
    activation = { isActive: true };
    const runtime = createScriptRuntime(makeContext(), undefined, `clip-${Math.random()}`, undefined, undefined, { permissionConfig: { permissions: {} } as never });
    await runtime.loadScript({ type: 'ScriptBlock', loc, code: ON_A_TIMER });
    try {
      // The interval's first turn, however long a loaded machine takes to
      // give it one: 80 ms was not always enough in the full suite.
      await vi.waitFor(() => expect(writes.length).toBeGreaterThan(0), { timeout: 3000 });
    } finally {
      runtime.cleanup();
    }
  });

  it('is written from a press in this app, not from one in another app or the host', async () => {
    // SoftN Web keeps every open app running, one on screen; the browser's
    // activation follows a press anywhere on the page.
    activation = { isActive: true };
    const behind = document.createElement('div');
    const onScreen = document.createElement('div');
    const theirs = document.createElement('button');
    const own = document.createElement('button');
    const hostField = document.createElement('input');
    onScreen.appendChild(theirs);
    behind.appendChild(own);
    document.body.append(behind, onScreen, hostField);
    // A tab SoftN Web is not showing (display: none, which jsdom does not lay out).
    behind.checkVisibility = () => false;
    const runtime = createScriptRuntime(makeContext(), undefined, `clip-${Math.random()}`, undefined, undefined, { permissionConfig: { permissions: {} } as never });
    runtime.setAppRoot?.(behind);
    await runtime.loadScript({ type: 'ScriptBlock', loc, code: ON_A_TIMER });
    try {
      for (const pressed of [theirs, hostField, document.body]) {
        pressed.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 40));
        expect(writes, pressed.nodeName).toEqual([]);
      }
      own.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true }));
      await vi.waitFor(() => expect(writes.length).toBeGreaterThan(0), { timeout: 3000 });
    } finally {
      runtime.cleanup();
      behind.remove();
      onScreen.remove();
      hostField.remove();
    }
  });

  it('in a worker, is handed to the page, which holds it to the same rule', async () => {
    // The engine as script-worker.ts wires it: no throw, the copy recorded.
    const adapter = await VmAdapter.create();
    const copied: string[] = [];
    adapter.registerDBBridge(new SnapshotDBBridge() as never);
    adapter.registerClipboardBridge({ write: (text) => copied.push(text) });
    const symbols = await adapter.initializeScript(
      VM_BRIDGE_PREAMBLE + SOFTN_BRIDGE_PREAMBLE + `let outcome = "copied"; try { navigator.clipboard.writeText("for the page"); } catch (e) { outcome = "threw"; }`
    );
    expect(adapter.getGlobal(symbols.get('outcome')!.index)).toBe('copied');
    adapter.dispose();
    expect(copied).toEqual(['for the page']);

    // The page writes what the worker hands it, from a click, and not while consent is pending.
    for (const [consentPending, active, expected] of [[false, true, ['for the page']], [true, true, []], [false, false, []]] as const) {
      writes.length = 0;
      activation = { isActive: active };
      stubWorker({ clipboardWrites: copied });
      const runtime = createWorkerScriptRuntime(makeContext(), undefined, 'clip-worker', undefined, undefined, { permissionConfig: { permissions: {}, consentPending } as never });
      await runtime.loadScript({ type: 'ScriptBlock', loc, code: '' });
      await new Promise((r) => setTimeout(r, 20));
      runtime.cleanup();
      expect(writes, `consent pending ${consentPending}, active ${active}`).toEqual(expected);
    }
  });
});

/** script-worker.ts, answering `init` with `result`. */
function stubWorker(result: Record<string, unknown>) {
  class FakeWorker {
    onmessage: ((e: MessageEvent) => void) | null = null;
    onerror = null;
    onmessageerror = null;
    postMessage(msg: { id?: number; type?: string }) {
      if (msg?.type !== 'init') return;
      setTimeout(
        () =>
          this.onmessage?.({
            data: { id: msg.id, ok: true, result: { state: {}, functionNames: [], syncFunctionNames: [], computedNames: [], hostCalls: [], eventTypes: [], dbMutations: [], lsMutations: [], faults: [], ...result } },
          } as MessageEvent),
        0
      );
    }
    terminate() {}
  }
  vi.stubGlobal('Worker', FakeWorker);
}

describe('localStorage in worker mode', () => {
  const BIG = 2_000_000; // characters; an app's share is 1 MiB

  it('the worker\'s own bridge refuses a write past the app\'s share, as the page does', () => {
    const bridge = new SnapshotLocalStorageBridge();
    bridge.setBudgetPrefix('softn:ls-worker:');
    bridge.updateSnapshot({});
    expect(() => bridge.setItem('big', 'x'.repeat(BIG))).toThrow(/may keep 1 MB/);
    expect(bridge.flushMutations()).toEqual([]);
    bridge.setItem('small', 'fits');
    expect(bridge.getItem('small')).toBe('fits');
  });

  it('the page refuses one the worker sends past the share', async () => {
    const failures: string[] = [];
    stubWorker({ lsMutations: [{ type: 'setItem', key: 'big', value: 'x'.repeat(BIG) }, { type: 'setItem', key: 'small', value: 'fits' }] });
    const runtime = createWorkerScriptRuntime(makeContext(), undefined, 'ls-worker', undefined, undefined, {
      permissionConfig: { permissions: {} } as never,
      onPersistenceFailure: (f) => failures.push(f.key),
    });
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    await runtime.loadScript({ type: 'ScriptBlock', loc, code: '' });
    await new Promise((r) => setTimeout(r, 20));
    quiet.mockRestore();
    runtime.cleanup();
    expect(localStorage.getItem('softn:ls-worker:big')).toBeNull();
    expect(localStorage.getItem('softn:ls-worker:small')).toBe('fits');
    expect(failures).toEqual(['big']);
  });
});
