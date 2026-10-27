/**
 * An engine a runaway loop stopped is known to have stopped.
 *
 * ZIPP throws strings, not Errors: the first failure of a runaway is
 * "RangeError: script exceeded its instruction budget", and every call after
 * it "zipp: engine is disposed". The adapter looked for an Error whose message
 * said "disposed", which never matched, so `terminated` stayed false and every
 * guard on it did nothing: each later window event threw out of the browser's
 * own listener, and each call logged the same error again, for good.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createConsoleModule,
  createMockNavModule,
  createMockXDBModule,
  createScriptRuntime,
  type ScriptContext,
} from '../src/runtime/script-runtime';

afterEach(() => {
  vi.restoreAllMocks();
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

describe('an engine a runaway listener stopped', () => {
  it('is known to have stopped: later events and calls are ignored, said once, and nothing is thrown out of a listener', async () => {
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    });
    const uncaught: unknown[] = [];
    const onError = (event: ErrorEvent) => {
      uncaught.push(event.error ?? event.message);
      event.preventDefault();
    };
    window.addEventListener('error', onError);
    const runtime = createScriptRuntime(context());
    try {
      const code = `
        let n = 0
        function listen() { window.addEventListener("keydown", function () { while (true) { n++ } }) }
        function fine() { return 1 }
      `;
      const loaded = await runtime.loadScript({ type: 'LogicBlock', code, loc: { line: 1, column: 0, start: 0, end: code.length } });
      await loaded.functions.listen();
      for (let i = 0; i < 3; i++) window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
      await loaded.functions.fine();
      await loaded.functions.fine();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(uncaught).toEqual([]);
      // The budget, once; the engine having stopped, once; nothing about a disposed engine.
      expect(errors.filter((line) => /instruction budget/.test(line))).toHaveLength(1);
      expect(errors.filter((line) => /engine has stopped/.test(line))).toHaveLength(1);
      expect(errors.filter((line) => /engine is disposed/.test(line))).toEqual([]);
    } finally {
      window.removeEventListener('error', onError);
      runtime.cleanup();
    }
  }, 30_000);
});

describe('a worker whose engine stopped', () => {
  // The worker sent every later call on, each failing, and the app sat frozen with no word.
  it('is stopped, and the host told, as a worker whose script hung is', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const empty = { state: {}, functionNames: ['spin'], syncFunctionNames: [], computedNames: [], hostCalls: [], eventTypes: [], dbMutations: [], lsMutations: [], faults: [] };
    class StoppingWorker {
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror = null;
      onmessageerror = null;
      terminated = false;
      postMessage(msg: { id?: number; type?: string }) {
        const result =
          msg?.type === 'init'
            ? empty
            : msg?.type === 'call_fn'
              ? { result: undefined, ...empty, failure: 'RangeError: script exceeded its instruction budget', stopped: true }
              : true;
        setTimeout(() => this.onmessage?.({ data: { id: msg.id, ok: true, result } } as MessageEvent), 0);
      }
      terminate() {
        this.terminated = true;
      }
    }
    vi.stubGlobal('Worker', StoppingWorker);
    const { createWorkerScriptRuntime } = await import('../src/runtime/script-worker-runtime');
    const fatal: Error[] = [];
    const runtime = createWorkerScriptRuntime(context(), undefined, 'stopped-worker', undefined, undefined, {
      onFatal: (error: Error) => fatal.push(error),
    } as never);
    try {
      const loaded = await runtime.loadScript({ type: 'LogicBlock', code: 'function spin() { while (true) {} }', loc: { line: 1, column: 0, start: 0, end: 0 } });
      await loaded.functions.spin?.().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(fatal.map((e) => e.message)).toEqual(['worker_engine_stopped']);
    } finally {
      runtime.cleanup();
      vi.unstubAllGlobals();
    }
  });
});
