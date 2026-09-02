/**
 * The React -> VM push must not echo back a value the host could not read.
 *
 * syncReactStateToVM does a read-modify-write of every *synced* global: the
 * host reads each one out of the VM as a plain JS value (loadScript step 6),
 * hands React the copy, and later pushes React's copy back in. That is only
 * safe while the round trip is lossless.
 *
 * For an object it very nearly is — the engine merges an incoming object over
 * the live one and keeps every property the host echoed back as `null` but
 * could not actually represent (a method, a Date, a typed array). For an ARRAY
 * it is not: the merge only walks object properties, so an array is rebuilt
 * wholesale from the host's lossy copy and every opaque value inside it becomes
 * `null` in the VM, permanently.
 *
 * `let rows = [{ at: new Date(...), ... }]` is an ordinary way to hold a list
 * in .logic, and the variable only has to be one the document names —
 * partitionStateVars holds unnamed ones back, which is why the control case
 * below still works.
 *
 * The symptom is silent: the VM function throws on the dead value, the
 * createVMFunction wrapper catches and logs it, and the state that function was
 * supposed to produce simply never appears on screen.
 */
import { describe, it, expect } from 'vitest';
import {
  createScriptRuntime,
  createMockXDBModule,
  createMockNavModule,
  createConsoleModule,
  type ScriptContext,
} from '../src/runtime/script-runtime';
import type { ScriptBlock } from '../src/parser/ast';

function harness(code: string, observed?: ReadonlySet<string>) {
  const state: Record<string, unknown> = {};
  const context: ScriptContext = {
    state,
    setState: (path: string, value: unknown) => {
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
  const script: ScriptBlock = {
    type: 'ScriptBlock',
    code,
    loc: { line: 1, column: 0, start: 0, end: code.length },
  };
  const runtime = createScriptRuntime(
    context,
    undefined,
    undefined,
    undefined,
    undefined,
    observed ? { observedStateNames: observed } : undefined
  );
  return { state, runtime, script };
}

const ROWS = `
  let rows = [{ at: new Date(0), label: "first" }];
  let stamp = "";
  function show() { stamp = "t=" + rows[0].at.getTime(); }
`;

describe('React -> VM push and array elements', () => {
  it('keeps a Date inside an array alive across the first full push', async () => {
    const { state, runtime, script } = harness(ROWS);
    const loaded = await runtime.loadScript(script);

    // SoftNRenderer.tsx does exactly this the moment loadScript resolves:
    //   Object.assign(scriptState, result.state)
    // so context.state now holds the lossy copy, `[{ at: null, ... }]`.
    expect(loaded.state.rows).toEqual([{ at: null, label: 'first' }]);
    Object.assign(state, loaded.state);

    await loaded.functions.show();

    expect(state.stamp).toBe('t=0');
  });

  it('breaks the same way through the granular (dirty-key) push', async () => {
    const { state, runtime, script } = harness(ROWS);
    const loaded = await runtime.loadScript(script);
    Object.assign(state, loaded.state);

    // A React-side edit marks `rows` dirty, which is the other push path.
    runtime.updateContext({ rows: [{ at: null, label: 'renamed' }] });
    await loaded.functions.show();

    expect(state.stamp).toBe('t=0');
  });

  it('the same object one level up survives, which is what makes this a gap', async () => {
    // Control: identical data, held as an object property instead of an array
    // element. The engine's object merge keeps the Date, so the push is safe.
    const { state, runtime, script } = harness(`
      let row = { at: new Date(0), label: "first" };
      let stamp = "";
      function show() { stamp = "t=" + row.at.getTime(); }
    `);
    const loaded = await runtime.loadScript(script);
    Object.assign(state, loaded.state);

    await loaded.functions.show();

    expect(state.stamp).toBe('t=0');
  });

  it('the array survives when the document never names it', async () => {
    // Control: partitionStateVars holds `rows` back, nothing pushes it.
    const { state, runtime, script } = harness(ROWS, new Set(['stamp']));
    const loaded = await runtime.loadScript(script);
    Object.assign(state, loaded.state);

    await loaded.functions.show();

    expect(state.stamp).toBe('t=0');
  });
});
