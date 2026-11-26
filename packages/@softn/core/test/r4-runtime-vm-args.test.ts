/**
 * What a script is handed when a component or the page calls it with a value
 * that is not a plain object: the built-in data kinds cross as the data they
 * hold, on every engine and on both threads.
 *
 * DataGrid's `onSelectionChange` hands its selection as a Set. The boundary
 * let only plain objects and arrays through, so a `.logic` handler bound to it
 * (`@selectionChange={pick}`) was handed null, as it was for a Map, a Date or a
 * typed array. A key named `__proto__` was lost on the way, and a BigInt was
 * `undefined` to ZIPP where the host-JavaScript engine got the BigInt itself.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sanitizeArgs } from '../src/runtime/vm-args';
import {
  createConsoleModule,
  createMockNavModule,
  createMockXDBModule,
  createScriptRuntime,
  type ScriptContext,
} from '../src/runtime/script-runtime';

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

const block = (code: string) => ({ type: 'LogicBlock' as const, code, loc: { line: 1, column: 0, start: 0, end: 0 } });

describe('the values a script is handed', () => {
  it('reads a Set as the list of its members, and a Map as its [key, value] pairs', () => {
    const [set, map] = sanitizeArgs([new Set(['a', 2, 'a']), new Map<unknown, unknown>([['k', 1], [2, 'v']])]);
    expect(set).toEqual(['a', 2]);
    expect(map).toEqual([['k', 1], [2, 'v']]);
  });

  it('reads a Date as its ISO text, and an invalid one as null', () => {
    const [when, never] = sanitizeArgs([new Date(Date.UTC(2026, 0, 2, 3, 4, 5)), new Date(Number.NaN)]);
    expect(when).toBe('2026-01-02T03:04:05.000Z');
    expect(never).toBeNull();
  });

  it('reads a typed array, a DataView and an ArrayBuffer as the numbers they hold', () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const [u8, f32, view, buffer, big] = sanitizeArgs([
      bytes,
      new Float32Array([1.5, -2]),
      new DataView(bytes.buffer, 1, 2),
      bytes.buffer,
      new BigInt64Array([5n]),
    ]);
    expect(u8).toEqual([1, 2, 3, 4]);
    expect(f32).toEqual([1.5, -2]);
    expect(view).toEqual([2, 3]);
    expect(buffer).toEqual([1, 2, 3, 4]);
    expect(big).toEqual([5]);
  });

  it('keeps a key named __proto__ as an own key, and the copy plain', () => {
    const [record] = sanitizeArgs([JSON.parse('{"__proto__": {"a": 1}, "b": 2}')]) as Array<Record<string, unknown>>;
    expect(Object.keys(record)).toEqual(['__proto__', 'b']);
    expect(Object.getPrototypeOf(record)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(record, '__proto__')?.value).toEqual({ a: 1 });
  });

  it('hands a BigInt over as a number where one holds it, else as its digits, and a symbol as null', () => {
    expect(sanitizeArgs([10n, 2n ** 64n, Symbol('s')])).toEqual([10, '18446744073709551616', null]);
  });

  it('still hands over nothing of a host object, inside a Set or a Map too', () => {
    const node = document.createElement('div');
    class Point {
      x = 1;
    }
    const looped = new Set<unknown>();
    looped.add(looped);
    const [inSet, inMap, point, loop] = sanitizeArgs([new Set([node, 1]), new Map([[node, 1]]), new Point(), looped]);
    expect(inSet).toEqual([null, 1]);
    expect(inMap).toEqual([[null, 1]]);
    expect(point).toBeNull();
    expect(loop).toEqual([null]);
  });

  it('keeps -0, NaN and the infinities as they are', () => {
    const [negative, nan, inf] = sanitizeArgs([-0, Number.NaN, -Infinity]);
    expect(Object.is(negative, -0)).toBe(true);
    expect(nan).toBeNaN();
    expect(inf).toBe(-Infinity);
  });
});

describe('a handler on the engine', () => {
  it('is given the selection a component hands it as a Set, and can keep it', async () => {
    const ctx = context();
    const runtime = createScriptRuntime(ctx, undefined, 'r4-vm-args-main');
    try {
      const loaded = await runtime.loadScript(block(`
        let selection = [];
        let firstKey = null;
        function pick(keys) {
          selection = keys;
          firstKey = Array.isArray(keys) ? keys[0] : "not a list";
        }
        function whenAndWhat(when, pairs, record, big) {
          return [when, pairs.length, Object.keys(record).join(","), big];
        }
      `));
      await loaded.functions.pick!(new Set(['row-2', 'row-5']));
      expect(ctx.state.selection).toEqual(['row-2', 'row-5']);
      expect(ctx.state.firstKey).toBe('row-2');
      expect(await loaded.functions.whenAndWhat!(new Date(0), new Map([[1, 2]]), JSON.parse('{"__proto__": 1, "b": 2}'), 7n)).toEqual([
        '1970-01-01T00:00:00.000Z',
        1,
        '__proto__,b',
        7,
      ]);
    } finally {
      runtime.cleanup();
    }
  });

  it('is given the same in a worker', async () => {
    const empty = { state: {}, functionNames: ['pick'], syncFunctionNames: [], computedNames: [], hostCalls: [], eventTypes: [], dbMutations: [], lsMutations: [], faults: [] };
    const received: unknown[] = [];
    class CloningWorker {
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror = null;
      onmessageerror = null;
      postMessage(msg: { id?: number; type?: string; payload?: { args?: unknown[] } }) {
        const sent = structuredClone(msg);
        if (sent.type === 'call_fn') received.push(sent.payload?.args);
        const result = sent.type === 'init' ? empty : sent.type === 'call_fn' ? { result: 1, ...empty } : true;
        setTimeout(() => this.onmessage?.({ data: { id: sent.id, ok: true, result } } as MessageEvent), 0);
      }
      terminate() {}
    }
    vi.stubGlobal('Worker', CloningWorker);
    const { createWorkerScriptRuntime } = await import('../src/runtime/script-worker-runtime');
    const runtime = createWorkerScriptRuntime(context(), undefined, 'r4-vm-args-worker');
    try {
      const loaded = await runtime.loadScript(block('function pick(keys) { return 1 }'));
      await loaded.functions.pick!(new Set(['row-2', 'row-5']), new Uint8Array([7]));
      expect(received).toEqual([[['row-2', 'row-5'], [7]]]);
    } finally {
      runtime.cleanup();
    }
  });
});
