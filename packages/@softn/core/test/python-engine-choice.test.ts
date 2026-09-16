/**
 * Which engines can run Python, and what happens to an app that needs one when
 * the configured engine cannot.
 *
 * This is the safety property of Python app logic. `zipp-web` is ZIPP's
 * JavaScript-only build and `host-js` is the host document's own JavaScript
 * engine; neither can execute a line of Python. An app whose logic is `.py`
 * arriving on either of them is a decision that was already wrong when it was
 * made, and the only honest thing left is to say so by name — not to hand the
 * file to a JavaScript parser and show the author a syntax error about their
 * own correct code.
 *
 * It runs in BOTH suites on purpose. The default run has ZIPP configured and
 * the host-JavaScript run has `HostJsEngine`, so between them both sides of
 * the refusal are exercised against a real configured engine.
 */

import { describe, expect, it } from 'vitest';
import { ZippWasmAdapter } from '../src/runtime/zipp-wasm-adapter';
import { HostJsEngine } from '../src/runtime/host-js';
import {
  createPythonLogicEngine,
  logicEngineRunsPython,
  type LogicEngineFactory,
} from '../src/runtime/vm-adapter';
import {
  createConsoleModule,
  createMockNavModule,
  createMockXDBModule,
  createScriptRuntime,
  type ScriptContext,
} from '../src/runtime/script-runtime';
import type { ScriptBlock } from '../src/parser/ast';

const EMPTY_LOGIC: ScriptBlock = {
  type: 'ScriptBlock',
  code: '',
  loc: { line: 1, column: 0, start: 0, end: 0 },
};

function makeContext(): ScriptContext {
  const state: Record<string, unknown> = {};
  return {
    state,
    setState: (path, value) => {
      state[path] = value;
    },
    data: {},
    xdb: createMockXDBModule(),
    nav: createMockNavModule(),
    console: createConsoleModule(),
  };
}

describe('an engine says whether it can run Python by having a way to', () => {
  it('ZIPP can, and the host-JavaScript engine cannot', () => {
    // Presence is the whole declaration: a factory with no `createPython` is a
    // factory that runs JavaScript and only JavaScript, and nothing has to be
    // kept in step with a list somewhere else.
    expect(typeof (ZippWasmAdapter as LogicEngineFactory).createPython).toBe('function');
    expect((HostJsEngine as unknown as LogicEngineFactory).createPython).toBeUndefined();
  });

  it('and what the runtime reports matches what it will actually do', async () => {
    if (logicEngineRunsPython()) {
      const engine = await createPythonLogicEngine();
      expect(typeof engine.initializePythonProject).toBe('function');
      engine.dispose();
    } else {
      expect(() => createPythonLogicEngine()).toThrow(/runs only JavaScript/);
    }
  });

  it('refuses a Python app before compiling a line of it, when it cannot run one', async () => {
    const runtime = createScriptRuntime(makeContext(), undefined, 'python-refusal-test', undefined, undefined, {
      mode: 'main',
      pythonProject: { files: { app: 'count = 0\n' }, modules: ['app'] },
    });
    if (logicEngineRunsPython()) {
      // The other side of the same contract: where Python can run, it runs.
      const loaded = await runtime.loadScript(EMPTY_LOGIC);
      expect(loaded.state).toEqual({ count: 0 });
    } else {
      await expect(runtime.loadScript(EMPTY_LOGIC)).rejects.toThrow(
        /written in Python, and this app runtime runs only JavaScript/
      );
    }
    runtime.cleanup();
  });

  it('will not read Python source as JavaScript, whichever engine is configured', async () => {
    // The mirror of the refusal above: the Python engine will not be handed a
    // JavaScript source string either. Both directions are silent substitution
    // and both are refused by name.
    if (!logicEngineRunsPython()) return;
    const engine = await createPythonLogicEngine();
    await expect(engine.initializeScript('let a = 1;')).rejects.toThrow(
      /runs Python app logic, not JavaScript/
    );
    engine.dispose();
  });
});
