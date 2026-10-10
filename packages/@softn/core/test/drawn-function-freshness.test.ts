/**
 * What a drawn function answers after a listener changed the state under it,
 * and what a `$:` value follows when the state it names is not ASCII.
 *
 * Two small holes beside the one drawn-function-state.test.tsx holds, each
 * showing a first value that is no longer true.
 *
 * A function asked from the page is answered once in a drawing, and the
 * answer is kept for the rest of it: what is kept is let go when a function
 * of the script is called, and otherwise once two milliseconds have passed.
 * A listener the script put on the window (a key, a pointer) is neither, so
 * a page drawn again straight after a key was answered from before the key.
 *
 * And `$: shown = "x" + café` was read for the names it follows with a
 * pattern that knew only ASCII: it found `caf`, `café` stayed in the engine,
 * and `shown` stood at its first value. The engine reads `café` as a name,
 * and so does the scan of the page.
 */
import { describe, it, expect, vi } from 'vitest';
import { parse } from '../src/parser';
import { namesReadBy } from '../src/runtime/computed-declarations';
import {
  collectDrawnNames,
  collectObservedStateNames,
  createConsoleModule,
  createMockNavModule,
  createMockXDBModule,
  createScriptRuntime,
  type ScriptContext,
} from '../src/runtime/script-runtime';

function makeContext(): ScriptContext {
  const state: Record<string, unknown> = {};
  return {
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
}

function runtimeFor(source: string) {
  const doc = parse(source);
  const context = makeContext();
  const runtime = createScriptRuntime(context, undefined, 'drawn-freshness', undefined, undefined, {
    mode: 'main',
    observedStateNames: collectObservedStateNames(doc) ?? undefined,
    drawnNames: collectDrawnNames(doc) ?? undefined,
  });
  return { doc, context, runtime };
}

describe('a drawn function, asked straight after a listener changed its state', () => {
  it('answers from the state as it is now', async () => {
    const { doc, context, runtime } = runtimeFor(`<logic>
let tally = 1
window.addEventListener("keydown", function (event) { tally = tally + 1 })
function label() { return "tally is " + tally }
function ready() { return true }
</logic>
<p>{label()}</p>`);
    try {
      const loaded = await runtime.loadScript(doc.logic!);
      Object.assign(context.state, loaded.state);
      // A call of the script's is what puts its listeners on the real window.
      await loaded.functions.ready();

      // The key, and the drawing it causes, inside the two milliseconds an
      // answer is kept for: the clock is held still so that this is so
      // however long the engine takes here.
      const clock = vi.spyOn(performance, 'now').mockReturnValue(performance.now());
      try {
        expect(loaded.syncFunctions.label()).toBe('tally is 1');
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
        expect(loaded.syncFunctions.label()).toBe('tally is 2');
      } finally {
        clock.mockRestore();
      }
    } finally {
      runtime.cleanup();
    }
  });
});

describe('a $: value over state whose name is not ASCII', () => {
  it('is read for the whole name', () => {
    expect([...namesReadBy('"x" + café + счётчик.length')]).toEqual(['café', 'счётчик']);
  });

  it('has that state mirrored, so the page is told when it changes', async () => {
    const { doc, runtime } = runtimeFor(`<logic>
let café = 1
let other = 2
$: shown = "x" + café
function bump() { café = café + 1 }
</logic>
<div><button @click={() => bump()}>a</button><p>{shown}</p></div>`);
    try {
      await runtime.loadScript(doc.logic!);
      const inner = runtime as unknown as { stateVarNames: string[]; vmOwnedStateNames: string[] };
      expect(inner.stateVarNames).toContain('café');
      expect(inner.vmOwnedStateNames).toEqual(['other']);
    } finally {
      runtime.cleanup();
    }
  });
});
