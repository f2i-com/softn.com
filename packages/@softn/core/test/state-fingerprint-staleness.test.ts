/**
 * The digest skip must never leave React holding a value the VM has moved on
 * from.
 *
 * syncVMStateToReact asks the engine which globals changed before reading any
 * of them, which is worth a lot — a scene description that has not moved costs
 * microseconds to fingerprint and milliseconds to read. But a digest answers
 * "has the VM changed since I last looked?", while the skip needs "does React's
 * copy still match the VM?". Those are the same question only while nothing
 * moves React's copy except the read itself, and updateContext does exactly
 * that on every :bind edit and every React-side state change.
 *
 * When the two come apart they stay apart, because the skip is what would have
 * repaired them. Pocket hit it in the field: a cartridge loaded and ran under
 * the words "Could not read that file."
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

function harness(code: string) {
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
  const script: ScriptBlock = {
    type: 'ScriptBlock',
    code,
    loc: { line: 1, column: 0, start: 0, end: code.length },
  };
  return { state, runtime: createScriptRuntime(context), script };
}

describe('state digests and React-side writes', () => {
  it('re-reads a global whose value returned to the digest React was last told about', async () => {
    // The round trip is the whole point. The VM ends on the value it started
    // on, so its digest is unchanged and the skip is entitled to fire — but
    // React's copy was moved in between and is now wrong.
    const { state, runtime, script } = harness(`
      let msg = "";
      let ticks = 0;
      function reset() { msg = ""; ticks = ticks + 1; }
    `);
    const loaded = await runtime.loadScript(script);
    // loadScript reports the initial state in its return value; context.state
    // is populated by the first sync, so prime it the way a first render does.
    await loaded.functions.reset();
    expect(state.msg).toBe('');

    // What SoftNRenderer does when React state changes underneath the runtime.
    runtime.updateContext({ msg: 'stale value from React' });
    expect(state.msg).toBe('stale value from React');

    // The call pushes React's copy into the VM, the VM puts it back to "", and
    // the digest of "" is the one the host recorded before any of this.
    await loaded.functions.reset();

    expect(state.msg).toBe('');
  });

  it('still repairs React after a full push, not just a granular one', async () => {
    const { state, runtime, script } = harness(`
      let label = "ready";
      let n = 0;
      function bump() { label = "ready"; n = n + 1; }
    `);
    const loaded = await runtime.loadScript(script);
    await loaded.functions.bump();
    expect(state.label).toBe('ready');

    runtime.updateContext({ label: 'wrong' });
    await loaded.functions.bump();

    expect(state.label).toBe('ready');
  });

  it('leaves an untouched global alone, so the skip still does its job', async () => {
    // The fix must not become "read everything always" — that would give the
    // digests up entirely.
    const { state, runtime, script } = harness(`
      let big = [1, 2, 3];
      let n = 0;
      function bump() { n = n + 1; }
    `);
    const loaded = await runtime.loadScript(script);
    await loaded.functions.bump();
    const first = state.big;
    await loaded.functions.bump();
    await loaded.functions.bump();

    expect(state.n).toBe(3);
    // Not merely equal — the identical object, never re-marshalled.
    expect(state.big).toBe(first);
  });
});
