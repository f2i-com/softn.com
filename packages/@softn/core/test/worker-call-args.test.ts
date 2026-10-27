/**
 * A call into a worker's script passes its arguments as the main thread's
 * engine is given them (vm-args.ts), at any depth. Reduced at the top alone,
 * `{ value: 1, done: fn }` could not be cloned: postMessage threw, the
 * function never ran, and the call's entry waited out its timeout.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConsoleModule, createMockNavModule, createMockXDBModule, type ScriptContext } from '../src/runtime/script-runtime';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function context(): ScriptContext {
  const state: Record<string, unknown> = {};
  return {
    state,
    setState: (path: string, value: unknown) => {
      state[path] = value;
    },
    data: {},
    xdb: createMockXDBModule(),
    nav: createMockNavModule(),
    console: createConsoleModule(),
  };
}

describe('a call into a worker', () => {
  it('passes arguments holding functions and host objects below the top', async () => {
    const empty = { state: {}, functionNames: ['take'], syncFunctionNames: [], computedNames: [], hostCalls: [], eventTypes: [], dbMutations: [], lsMutations: [], faults: [] };
    const received: unknown[] = [];
    class CloningWorker {
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror = null;
      onmessageerror = null;
      postMessage(msg: { id?: number; type?: string; payload?: { args?: unknown[] } }) {
        // As a real worker's postMessage: what cannot be cloned throws here.
        const sent = structuredClone(msg);
        if (sent.type === 'call_fn') received.push(sent.payload?.args);
        const result = sent.type === 'init' ? empty : sent.type === 'call_fn' ? { result: 1, ...empty } : true;
        setTimeout(() => this.onmessage?.({ data: { id: sent.id, ok: true, result } } as MessageEvent), 0);
      }
      terminate() {}
    }
    vi.stubGlobal('Worker', CloningWorker);
    const { createWorkerScriptRuntime } = await import('../src/runtime/script-worker-runtime');
    const runtime = createWorkerScriptRuntime(context(), undefined, 'call-args-worker');
    try {
      const loaded = await runtime.loadScript({ type: 'LogicBlock', code: 'function take(a) { return 1 }', loc: { line: 1, column: 0, start: 0, end: 0 } });
      await expect(loaded.functions.take!({ value: 1, done: () => undefined }, [new Map([[1, 2]])])).resolves.toBe(1);
      expect(received).toEqual([[{ value: 1, done: null }, [null]]]);
    } finally {
      runtime.cleanup();
    }
  });
});
