/**
 * A `.logic` file's imports are placed the same way whichever thread runs it.
 *
 * The worker kept a copy of the main thread's import resolution that had
 * drifted from it. A host's resolver hands back a file as it was written, so
 * the runtime resolves the imports inside it; in the worker a root-level file
 * importing "./b.logic" asked for "a.logic/b.logic", "../" was passed on
 * unresolved, an indented import was left in the code, and a cycle — which
 * the main thread places once and moves past — failed the whole load. Each
 * case below is one of those, run on both threads.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { ScriptBlock } from '../src/parser/ast';
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

/** The bundle's other logic files, as a host's resolver hands them back: as written. */
const FILES = new Map<string, string>([
  // A root-level file importing a sibling, which imports it back.
  ['a.logic', 'import "./b.logic"\nlet fromA = fromB + 1'],
  ['b.logic', 'import "./a.logic"\nlet fromB = 41'],
  // A file in a folder importing one a level up.
  ['lib/deep/c.logic', 'import "../util.logic"\nlet fromC = util * 2'],
  ['lib/util.logic', 'let util = 5'],
  // Two files importing a third, which imports the entry file.
  ['x.logic', 'import "shared.logic"\nlet fromX = shared'],
  ['y.logic', 'import "shared.logic"\nlet fromY = shared'],
  ['shared.logic', 'import "main.logic"\nlet shared = 100'],
  ['indented.logic', 'let indented = 1000'],
  // Already in the code the host put together, so not placed again.
  ['pre.logic', 'let pre = 7'],
]);

const ENTRY = [
  // What the host concatenated ahead of the entry file (preIncludedLogicPaths).
  'let pre = 7',
  'import "a.logic"',
  'import "lib/deep/c.logic"',
  'import "x.logic"',
  'import "y.logic"',
  '  import "indented.logic"',
  'import "pre.logic"',
  'let total = fromA + fromC + fromX + fromY + indented + pre',
].join('\n');

const EXPECTED = { fromA: 42, fromB: 41, util: 5, fromC: 10, shared: 100, fromX: 100, fromY: 100, indented: 1000, pre: 7, total: 1259 };

const resolver = async (path: string) => FILES.get(path) ?? null;
const script: ScriptBlock = { type: 'ScriptBlock', code: ENTRY, loc: { line: 1, column: 0, start: 0, end: 0 } };

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

const runtimes: ScriptRuntimeHandle[] = [];
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.cleanup();
});

/** The values the script's globals hold once it has loaded. */
function picked(state: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.keys(EXPECTED).map((name) => [name, state[name]]));
}

describe('a logic file’s imports', () => {
  it('are placed on the main thread', async () => {
    const runtime = createScriptRuntime(makeContext(), undefined, 'imports-main', resolver, 'main.logic', {
      mode: 'main',
      preIncludedLogicPaths: ['pre.logic'],
    });
    runtimes.push(runtime);
    const loaded = await runtime.loadScript(script);
    expect(picked(loaded.state)).toEqual(EXPECTED);
  });

  it('are placed the same way in the worker', async () => {
    await withInProcessWorker(async () => {
      const runtime = new WorkerScriptRuntime(makeContext(), undefined, 'imports-worker', resolver, 'main.logic', {
        preIncludedLogicPaths: ['pre.logic'],
      });
      runtimes.push(runtime);
      const loaded = await runtime.loadScript(script);
      expect(picked(loaded.state)).toEqual(EXPECTED);
    });
  });

  it('are placed in the worker when the entry file has no path, as on the main thread', async () => {
    const code = 'import "lib/util.logic"\nlet doubled = util * 2';
    const entry: ScriptBlock = { ...script, code };
    const main = createScriptRuntime(makeContext(), undefined, 'imports-main-nopath', resolver, undefined, { mode: 'main' });
    runtimes.push(main);
    const onMain = await main.loadScript(entry);
    expect(onMain.state.doubled).toBe(10);
    await withInProcessWorker(async () => {
      const worker = new WorkerScriptRuntime(makeContext(), undefined, 'imports-worker-nopath', resolver, undefined);
      runtimes.push(worker);
      const inWorker = await worker.loadScript(entry);
      expect(inWorker.state.doubled).toBe(10);
    });
  });
});
