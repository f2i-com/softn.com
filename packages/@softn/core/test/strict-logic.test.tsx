/**
 * An app's `"use strict"` is in force, and an app without one stays sloppy.
 *
 * The engine reads the directive off the start of the text it compiles, and
 * the runtime handed it SoftN's bridges first, so a script that opened with
 * `"use strict"` ran sloppy: `this` in a plain call was the global object and
 * assigning an undeclared name made a global. The runtime now reads the app's
 * prologue (directive-prologue.ts) and puts the directive first, on the first
 * line, so SoftN's bridges, timers and document run strict with it and no
 * line of the app moves.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { ScriptBlock } from '../src/parser/ast';
import { SoftNRenderer } from '../src/loader/SoftNRenderer';
import {
  createConsoleModule,
  createMockNavModule,
  createMockXDBModule,
  createScriptRuntime,
  type ScriptContext,
  type ScriptRuntimeHandle,
} from '../src/runtime/script-runtime';
import { WorkerScriptRuntime } from '../src/runtime/script-worker-runtime';
import { withInProcessWorker } from './helpers/in-process-worker';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PROBE = [
  'let plainThis = (function () { return this === undefined; })();',
  'let assigned = "none";',
  'try { undeclaredName = 1; assigned = "made a global"; } catch (e) { assigned = e.name; }',
].join('\n');

/** What the probe finds, by how the script opens. */
const CASES: Array<[string, string, boolean]> = [
  ['opens with "use strict"', `"use strict";\n${PROBE}`, true],
  ['opens with a comment and then the directive', `// The app.\n'use strict'\n${PROBE}`, true],
  ['opens with no directive', PROBE, false],
  ['has the string after a statement', `let first = 1;\n"use strict";\n${PROBE}`, false],
  ['has the string as an expression', `"use strict" + "";\n${PROBE}`, false],
];

function makeContext(): ScriptContext {
  return {
    state: {},
    setState: () => {},
    data: {},
    xdb: createMockXDBModule(),
    nav: createMockNavModule(),
    console: createConsoleModule(),
  };
}

const block = (code: string): ScriptBlock => ({ type: 'ScriptBlock', code, loc: { line: 1, column: 0, start: 0, end: code.length } });

const runtimes: ScriptRuntimeHandle[] = [];
let root: Root | null = null;
let container: HTMLElement | null = null;
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) runtime.cleanup();
  if (root) {
    const current = root;
    await act(async () => current.unmount());
    root = null;
  }
  container?.remove();
  container = null;
});

async function onMain(code: string) {
  const runtime = createScriptRuntime(makeContext(), undefined, 'strict-main', undefined, undefined, { mode: 'main' });
  runtimes.push(runtime);
  return runtime.loadScript(block(code));
}

describe('a script on the main thread', () => {
  it.each(CASES)('that %s is strict as the language says', async (_, code, strict) => {
    const { state } = await onMain(code);
    expect(state.plainThis).toBe(strict);
    expect(state.assigned).toBe(strict ? 'ReferenceError' : 'made a global');
  });

  it('keeps its line numbers: the directive goes on the first line', async () => {
    const body = 'function make() {\n  return new Error("x");\n}\nlet where = make().stack;';
    const strict = await onMain(`"use strict";\n${body}`);
    const sloppy = await onMain(`"not a directive that matters";\n${body}`);
    // The app's own two frames, `make` and its caller; on the host's engine
    // the frames after them are the test's and the runtime's.
    const lines = (stack: unknown) =>
      [...String(stack).matchAll(/:(\d+):(\d+)\)?$/gm)].map((match) => match.slice(1).join(':')).slice(0, 2);
    expect(lines(strict.state.where)).toHaveLength(2);
    expect(lines(strict.state.where)).toEqual(lines(sloppy.state.where));
  });
});

describe('a strict script’s $: values', () => {
  it('work, though strict code may not assign a name it never declared', async () => {
    const runtime = createScriptRuntime(makeContext(), undefined, 'strict-computed', undefined, undefined, { mode: 'main' });
    runtimes.push(runtime);
    const loaded = await runtime.loadScript(
      block(
        [
          '"use strict";',
          'let n = 2;',
          '$: quad = double * 2;',
          '$: double = n * 2;',
          'let own = 0;',
          '$: own = n + 1;',
          'function bump() { n = n + 1; }',
          'function later() { $: inner = n * 10; return inner; }',
        ].join('\n')
      )
    );
    expect([loaded.computed.double(), loaded.computed.quad(), loaded.computed.own()]).toEqual([4, 8, 3]);
    await loaded.functions.bump();
    expect([loaded.computed.double(), loaded.computed.quad(), loaded.computed.own()]).toEqual([6, 12, 4]);
    expect(await loaded.functions.later()).toBe(30);
    // As in a sloppy script, a `$:` value is not state.
    expect(Object.keys(loaded.state)).not.toContain('double');
    expect(Object.keys(loaded.state)).not.toContain('own');
  });
});

describe('a script in the worker', () => {
  it.each(CASES)('that %s is strict as the language says', async (_, code, strict) => {
    await withInProcessWorker(async () => {
      const runtime = new WorkerScriptRuntime(makeContext(), undefined, 'strict-worker', undefined, undefined);
      runtimes.push(runtime);
      const { state } = await runtime.loadScript(block(code));
      expect(state.plainThis).toBe(strict);
      expect(state.assigned).toBe(strict ? 'ReferenceError' : 'made a global');
    });
  });
});

describe('a page given its document', () => {
  const page = (directive: string) => `<!DOCTYPE html>
<html><body>
  <p id="out">waiting</p>
  <script>
    ${directive}
    var strictHere = (function () { return this === undefined; })();
    document.getElementById('out').textContent = strictHere ? 'strict' : 'sloppy';
  </script>
</body></html>`;

  it.each([
    ['"use strict";', 'strict'],
    ['', 'sloppy'],
  ])('with %j runs its code %s', async (directive, expected) => {
    container = document.createElement('div');
    document.body.appendChild(container);
    await act(async () => {
      root = createRoot(container!);
      root.render(<SoftNRenderer source={page(directive)} appId={`strict-page-${expected}`} scriptExecutionMode="main" />);
    });
    const out = () => container!.querySelector('#out')?.textContent;
    for (let i = 0; i < 100 && out() !== 'strict' && out() !== 'sloppy'; i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    }
    expect(out()).toBe(expected);
  });
});
