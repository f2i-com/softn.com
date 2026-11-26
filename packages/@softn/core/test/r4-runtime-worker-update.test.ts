/**
 * What the page holds reaches a worker's script even when one of its values
 * cannot be posted.
 *
 * The page's state is posted to the worker as it changes. A value that
 * cannot be cloned (a function the markup put in state) made `postMessage`
 * throw, the whole update was dropped without a word, and the values beside
 * it were never sent again: the worker's logic read `a` as it was while the
 * page showed 5. On the page's own thread the engine takes the same state as
 * plain data, and keeps its own value for the function.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConsoleModule, createMockNavModule, createMockXDBModule, type ScriptContext } from '../src/runtime/script-runtime';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a state update for a worker', () => {
  it('that holds a value that cannot be posted still hands over the rest', async () => {
    const updates: Array<Record<string, unknown>> = [];
    const empty = { state: {}, functionNames: [], syncFunctionNames: [], computedNames: [], hostCalls: [], eventTypes: [], dbMutations: [], lsMutations: [], faults: [] };
    class CloningWorker {
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror = null;
      onmessageerror = null;
      postMessage(msg: { id?: number; type?: string; payload?: { state?: Record<string, unknown> } }) {
        // As a real worker's postMessage: what cannot be cloned throws here.
        const sent = structuredClone(msg);
        if (sent.type === 'update_context') updates.push(sent.payload!.state!);
        setTimeout(() => this.onmessage?.({ data: { id: sent.id, ok: true, result: sent.type === 'init' ? empty : true } } as MessageEvent), 0);
      }
      terminate() {}
    }
    vi.stubGlobal('Worker', CloningWorker);
    const { createWorkerScriptRuntime } = await import('../src/runtime/script-worker-runtime');
    const context: ScriptContext = { state: {}, setState: () => {}, data: {}, xdb: createMockXDBModule(), nav: createMockNavModule(), console: createConsoleModule() };
    const runtime = createWorkerScriptRuntime(context, undefined, 'r4-worker-update');
    try {
      await runtime.loadScript({ type: 'LogicBlock', code: 'let a = 0; let next = null; let row = null;', loc: { line: 1, column: 0, start: 0, end: 0 } });
      runtime.updateContext({ a: 5, next: () => 1, row: { id: 1, open: () => 2 } });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(updates).toEqual([{ a: 5, row: { id: 1, open: null } }]);
    } finally {
      runtime.cleanup();
    }
  });
});
