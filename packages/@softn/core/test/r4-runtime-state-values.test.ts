/**
 * A Set, a Map or a Date the page holds in its state reaches the logic as the
 * data it holds, and is not wiped from the page by the next call.
 *
 * The page's state is written into the engine as it is. A Set there, which a
 * page holds when a handler keeps DataGrid's selection (`@selectionChange=
 * {(keys) => selection = keys}`), reached the logic as `{}`, and the call read
 * that `{}` back over the page's copy: the grid lost its selection whenever any
 * function ran. A worker's script was handed the same `{}`.
 */
import { describe, expect, it } from 'vitest';
import {
  createConsoleModule,
  createMockNavModule,
  createMockXDBModule,
  createScriptRuntime,
  type ScriptContext,
} from '../src/runtime/script-runtime';
import { WorkerScriptRuntime } from '../src/runtime/script-worker-runtime';
import { stateForScript } from '../src/runtime/vm-args';
import { withInProcessWorker } from './helpers/in-process-worker';

function makeContext() {
  const state: Record<string, unknown> = {};
  const context: ScriptContext = {
    state,
    setState: (path, value) => {
      state[path] = value;
    },
    batchSetState: (changes) => {
      Object.assign(state, changes);
    },
    data: {},
    xdb: createMockXDBModule(),
    nav: createMockNavModule(),
    console: createConsoleModule(),
  };
  return { context, state };
}

const LOGIC = {
  type: 'LogicBlock' as const,
  code: `
    let selection = [];
    let filters = { picked: [] };
    let seen = "";
    function look() {
      seen = (Array.isArray(selection) ? selection.join("+") : typeof selection) + "|" + (Array.isArray(filters.picked) ? filters.picked.length : typeof filters.picked);
    }
  `,
  loc: { line: 1, column: 0, start: 0, end: 0 },
};

describe('the page state handed to the engine', () => {
  it('is the value itself where it is plain data', () => {
    const rows = [{ id: 1, tags: ['a'] }, { id: 2, tags: [] }];
    expect(stateForScript(rows)).toBe(rows);
    expect(stateForScript('text')).toBe('text');
    const nested = { picked: new Set([1, 2]), name: 'x' };
    const read = stateForScript(nested) as Record<string, unknown>;
    expect(read).toEqual({ picked: [1, 2], name: 'x' });
    expect(nested.picked).toBeInstanceOf(Set);
  });

  it('holds a Set as its members on the main thread, and the page keeps them', async () => {
    const { context, state } = makeContext();
    const runtime = createScriptRuntime(context, undefined, 'r4-state-values-main', undefined, undefined, { mode: 'main' });
    try {
      const loaded = await runtime.loadScript(LOGIC);
      Object.assign(state, loaded.state);
      await loaded.functions.look!();
      runtime.updateContext({ selection: new Set(['row-1', 'row-4']), filters: { picked: new Set([3]) } });
      await loaded.functions.look!();
      expect(state.seen).toBe('row-1+row-4|1');
      // What the page holds afterwards is still the selection, as a list.
      expect(state.selection).toEqual(['row-1', 'row-4']);
    } finally {
      runtime.cleanup();
    }
  });

  it('holds a Set as its members in a worker', async () => {
    await withInProcessWorker(async () => {
      const { context, state } = makeContext();
      const runtime = new WorkerScriptRuntime(context, undefined, 'r4-state-values-worker');
      try {
        const loaded = await runtime.loadScript(LOGIC);
        Object.assign(state, loaded.state);
        runtime.updateContext({ selection: new Set(['row-1', 'row-4']), filters: { picked: new Set([3]) } });
        await loaded.functions.look!();
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(state.seen).toBe('row-1+row-4|1');
      } finally {
        runtime.cleanup();
      }
    });
  });
});
