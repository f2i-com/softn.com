/**
 * A Softn app whose logic is Python, on the engine it will actually run on.
 *
 * Nothing here is mocked: the ZIPP web-python release the repository vendors
 * compiles the app's modules, and the runtime drives them through the same
 * `SoftNScriptRuntime` a JavaScript app uses. What is being pinned is that a
 * Python app is an ordinary Softn app — state the host mirrors, functions the
 * template calls, `softn.*` capabilities through the same permission checks,
 * the same budget, the same failure modes — and that the places Python cannot
 * be an ordinary Softn app say so rather than misbehaving.
 *
 * This file is excluded from `vitest.host-js.config.ts`: the host-JavaScript
 * engine cannot run Python at all, which is not a gap to work around but the
 * property `python-engine-choice.test.ts` asserts in both runs.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { SoftNRenderer } from '../src/loader/SoftNRenderer';
import {
  createConsoleModule,
  createMockNavModule,
  createMockXDBModule,
  createScriptRuntime,
  type PermissionConfig,
  type ScriptContext,
  type ScriptRuntimeOptions,
} from '../src/runtime/script-runtime';
import { composeBundleSource } from '../src/bundle/source-composer';
import type { ScriptBlock } from '../src/parser/ast';

/** The empty `<logic>` block a Python composition leaves in the markup. */
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

/** A runtime over one Python module named `app`. */
function pythonRuntime(source: string, options?: Partial<ScriptRuntimeOptions>) {
  return createScriptRuntime(makeContext(), undefined, 'python-logic-test', undefined, undefined, {
    mode: 'main',
    pythonProject: { files: { app: source }, modules: ['app'] },
    ...options,
  });
}

/** Nothing granted: the shape a hosted app is actually run with. */
const NOTHING_GRANTED: PermissionConfig = { permissions: {} };

describe('a Python app is an ordinary Softn app', () => {
  it('exposes its top-level names as state and its functions as functions', async () => {
    const runtime = pythonRuntime(`count = 0
title = "hello"
items = [1, 2]

def increment(step):
    global count
    count = count + step
    return count

def read_title():
    return title
`);
    const loaded = await runtime.loadScript(EMPTY_LOGIC);

    expect(loaded.state).toEqual({ count: 0, title: 'hello', items: [1, 2] });
    expect(Object.keys(loaded.functions).sort()).toEqual(['increment', 'read_title']);
    expect(await loaded.functions.increment(5)).toBe(5);
    expect(await loaded.functions.increment(2)).toBe(7);
    expect(loaded.syncFunctions.read_title()).toBe('hello');
    runtime.cleanup();
  });

  it('lets the host write state back, which is what a template binding does', async () => {
    const runtime = pythonRuntime(`count = 0

def bump():
    global count
    count = count + 1
    return count
`);
    const loaded = await runtime.loadScript(EMPTY_LOGIC);
    expect(loaded.state.count).toBe(0);

    // What the renderer does when React state moved: push it in, then call.
    runtime.updateContext({ count: 40 } as never);
    expect(await loaded.functions.bump()).toBe(41);
    runtime.cleanup();
  });

  it('does not offer a class instance as state, because nothing could mirror it', async () => {
    const runtime = pythonRuntime(`class Thing:
    def __init__(self):
        self.n = 1

thing = Thing()
plain = {"n": 1}
`);
    const loaded = await runtime.loadScript(EMPTY_LOGIC);
    expect(loaded.state).toEqual({ plain: { n: 1 } });
    expect('thing' in loaded.state).toBe(false);
    runtime.cleanup();
  });

  it('mirrors state too deep for the engine’s boundary without losing the rest', async () => {
    // The engine's own boundary carries 32 levels and refuses the 33rd. State
    // is read as one batch, so a single over-deep variable would take the whole
    // read down with it — and the app would show nothing, with nothing said.
    // The projection cuts at a depth the boundary can carry instead, which is
    // why it has its own cap and does not borrow the normalizer's 64.
    const runtime = pythonRuntime(`deep = 1
for _i in range(40):
    deep = [deep]

shallow = "still here"
`);
    const loaded = await runtime.loadScript(EMPTY_LOGIC);

    expect(loaded.state.shallow).toBe('still here');
    // Everything down to the cut is real; past it the value is None, the same
    // answer the JavaScript engine's projection gives for anything it cannot
    // carry.
    let depth = 0;
    let node: unknown = loaded.state.deep;
    while (Array.isArray(node)) {
      depth += 1;
      node = node[0];
    }
    expect(depth).toBeGreaterThan(0);
    expect(node).toBeNull();
    runtime.cleanup();
  });

  it('projects an integer too large to be a JavaScript number as its digits', async () => {
    const runtime = pythonRuntime(`big = 9007199254740993
nested = [9007199254740993]
small = 9007199254740991
ratio = 1.5
`);
    const loaded = await runtime.loadScript(EMPTY_LOGIC);
    expect(loaded.state.big).toBe('9007199254740993');
    expect(loaded.state.nested).toEqual(['9007199254740993']);
    expect(loaded.state.small).toBe(9007199254740991);
    expect(loaded.state.ratio).toBe(1.5);
    runtime.cleanup();
  });
});

describe('a Python app reaches softn.* through the same host calls', () => {
  it('calls the backend and the answer arrives in its callback', async () => {
    const seen: Array<{ action: string; input: Record<string, unknown> }> = [];
    const runtime = pythonRuntime(`import softn

saved = None

def save():
    softn.backend.call("store", {"n": 7}, on_saved)

def on_saved(response):
    global saved
    saved = response.get("result")
`, {
      permissionConfig: NOTHING_GRANTED,
      backendCall: async (action, input) => {
        seen.push({ action, input });
        return { result: { ok: true } };
      },
    });
    const loaded = await runtime.loadScript(EMPTY_LOGIC);

    await loaded.functions.save();
    expect(seen).toEqual([{ action: 'store', input: { n: 7 } }]);
    expect(loaded.syncFunctions).toBeTruthy();
    // The callback ran inside the guest, so the value is in the app's state.
    expect((await readState(runtime, loaded)).saved).toEqual({ ok: true });
    runtime.cleanup();
  });

  it('gives a denied capability to the callback as an error, not a crash', async () => {
    const runtime = pythonRuntime(`import softn

outcome = None

def shoot():
    softn.camera.capture_photo({}, done)

def done(response):
    global outcome
    outcome = response
`, { permissionConfig: NOTHING_GRANTED });
    const loaded = await runtime.loadScript(EMPTY_LOGIC);

    await loaded.functions.shoot();
    const outcome = (await readState(runtime, loaded)).outcome as { error?: string };
    expect(typeof outcome?.error).toBe('string');
    expect(outcome.error).toMatch(/permission\.json/);
    runtime.cleanup();
  });

  it('runs a listener the app registered with softn.on', async () => {
    const runtime = pythonRuntime(`import softn

last_key = ""

def on_key(event):
    global last_key
    last_key = event.get("key")

softn.on("keydown", on_key)
`);
    const loaded = await runtime.loadScript(EMPTY_LOGIC);
    const internals = runtime as unknown as {
      vmEngine: {
        getEventListenerTypes(): string[];
        dispatchEvent(type: string, event: Record<string, unknown>): number;
      };
    };

    expect(internals.vmEngine.getEventListenerTypes()).toEqual(['keydown']);
    expect(internals.vmEngine.dispatchEvent('keydown', { key: 'a' })).toBe(1);
    expect((await readState(runtime, loaded)).last_key).toBe('a');
    runtime.cleanup();
  });
});

describe('a Python app fails the way a Softn app fails', () => {
  it('names the author’s own line when their module will not compile', async () => {
    const runtime = pythonRuntime(`x = 1
y = (
`);
    // The generated setter is appended, so the author's line numbers are their
    // own and the end-of-file the parser reports is folded back onto the last
    // line they wrote rather than pointing into generated code.
    await expect(runtime.loadScript(EMPTY_LOGIC)).rejects.toThrow(/app\.py:2/);
    await expect(runtime.loadScript(EMPTY_LOGIC)).rejects.not.toThrow(/__softn_main__\.py|softn\.py/);
    runtime.cleanup();
  });

  it('stops a runaway loop and does not keep driving a dead engine', async () => {
    const runtime = pythonRuntime(`def spin():
    while True:
        pass
`);
    const loaded = await runtime.loadScript(EMPTY_LOGIC);
    const internals = runtime as unknown as {
      vmEngine: { terminated: boolean; callFunction(name: string, args: unknown[]): unknown };
    };
    expect(internals.vmEngine.terminated).toBe(false);

    // The engine is what stops it, and it says why in the engine's own words:
    // a budget is not something the author set, so it is not rewritten in
    // their terms.
    expect(() => internals.vmEngine.callFunction('spin', [])).toThrow(/budget/i);
    // And it records that the engine is gone, so the runtime stops driving a
    // corpse instead of logging the same line every frame.
    expect(internals.vmEngine.terminated).toBe(true);
    // What the app sees is what a JavaScript app sees when its function throws:
    // the call answers undefined and the page keeps working.
    await expect(loaded.functions.spin()).resolves.toBeUndefined();
    runtime.cleanup();
  }, 30_000);

  it('renews the budget before every entry, or an app dies of being used', async () => {
    // ZIPP's instruction budget is a LIFETIME total, and on a Python state
    // reading a variable is an entry into the guest rather than a slot read.
    // An app that merely ran for long enough would therefore spend the budget
    // on its own state reads and be disposed mid-frame. Renewing before each
    // entry keeps the property that matters — no single entry can run away —
    // while letting an app be used for as long as the host drives it.
    const runtime = pythonRuntime(`def work(n):
    i = 0
    while i < n:
        i = i + 1
    return i
`);
    const loaded = await runtime.loadScript(EMPTY_LOGIC);
    const internals = runtime as unknown as {
      vmEngine: { callFunction(name: string, args: unknown[]): unknown; terminated: boolean };
    };
    // Deliberately on the engine's OWN default budget, not one this test
     // sets: six of these calls cost more than one lifetime's worth of it, so
     // without renewal the third or fourth dies. Measured, not guessed.
    for (let i = 0; i < 6; i++) {
      expect(internals.vmEngine.callFunction('work', [800_000])).toBe(800_000);
    }
    expect(internals.vmEngine.terminated).toBe(false);
    expect(loaded.state).toEqual({});
    runtime.cleanup();
  }, 30_000);

  it('says so rather than guessing when an expression string is asked for', async () => {
    const runtime = pythonRuntime('n = 1\n');
    await runtime.loadScript(EMPTY_LOGIC);
    const internals = runtime as unknown as { vmEngine: { evalSync(e: string): unknown } };
    expect(() => internals.vmEngine.evalSync('n + 1')).toThrow(/call a function instead/);
    runtime.cleanup();
  });
});

describe('the composer is what decides an app is Python', () => {
  it('turns .py logic files into a project and leaves the logic block empty', () => {
    const files = new Map<string, string>([
      ['app.softn', '<logic src="./helpers.py" />\n<logic src="./app.py" />\n<div>hi</div>'],
      ['helpers.py', 'def double(x):\n    return x * 2\n'],
      ['app.py', 'count = 0\n'],
    ]);
    const composed = composeBundleSource(files, 'app.softn');

    expect(composed.languages).toEqual(['javascript', 'python']);
    expect(composed.python?.modules).toEqual(['helpers', 'app']);
    expect(composed.python?.files).toEqual({
      helpers: 'def double(x):\n    return x * 2\n',
      app: 'count = 0\n',
    });
    expect(composed.source).toMatch(/<logic>\n<\/logic>$/);
    expect(composed.preIncludedLogicPaths).toEqual([]);
  });

  it('runs the project the composer produced', async () => {
    const files = new Map<string, string>([
      ['app.softn', '<logic src="./helpers.py" />\n<logic src="./app.py" />\n<div>hi</div>'],
      ['helpers.py', 'def double(x):\n    return x * 2\n'],
      // Python modules import each other by name. A JavaScript bundle's
      // fragments share one scope; Python's do not, and giving them one would
      // mean editing the author's file — so the import is the author's, and
      // the module name is their own file name.
      [
        'app.py',
        'from helpers import double\n\ntotal = 0\n\ndef add(n):\n    global total\n    total = total + double(n)\n    return total\n',
      ],
    ]);
    const composed = composeBundleSource(files, 'app.softn');
    const runtime = createScriptRuntime(
      makeContext(),
      undefined,
      'python-composed-test',
      undefined,
      composed.logicBasePath,
      { mode: 'main', pythonProject: composed.python }
    );
    const loaded = await runtime.loadScript(EMPTY_LOGIC);

    // Both modules' functions are callable by their bare names, the way a
    // JavaScript bundle's concatenated helper is.
    expect(await loaded.functions.add(4)).toBe(8);
    expect(await loaded.functions.double(3)).toBe(6);
    expect(loaded.state.total).toBe(0);
    runtime.cleanup();
  });

  it('is the author’s own NameError when a module did not import a helper', async () => {
    const files = new Map<string, string>([
      ['app.softn', '<logic src="./helpers.py" />\n<logic src="./app.py" />\n<div>hi</div>'],
      ['helpers.py', 'def double(x):\n    return x * 2\n'],
      // Padded on purpose, with the failure on a line in the MIDDLE. In a
      // two-line file the clamp that folds an end-of-file location back onto
      // the author's last line would hide a line number the generated setter
      // had shifted; here a shift is visible.
      [
        'app.py',
        ['def add(n):', '    # the call below is the point', '    return double(n)', '', '', '', '', '', '', '', '', 'NOTE = "padding"'].join('\n'),
      ],
    ]);
    const composed = composeBundleSource(files, 'app.softn');
    const runtime = createScriptRuntime(makeContext(), undefined, 'python-nameerror-test', undefined, undefined, {
      mode: 'main',
      pythonProject: composed.python,
    });
    await runtime.loadScript(EMPTY_LOGIC);
    const internals = runtime as unknown as {
      vmEngine: { callFunction(name: string, args: unknown[]): unknown };
    };
    // Named for the author's file and line, with no frame from a file the
    // runtime generated.
    let message = '';
    try {
      internals.vmEngine.callFunction('add', [1]);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/double/);
    // The author's own line 3, not the line a prepended setter would move it to.
    expect(message).toMatch(/app\.py", line 3|app\.py:3/);
    expect(message).not.toMatch(/__softn_main__\.py|softn\.py/);
    runtime.cleanup();
  });
});

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('the path a real Python app takes', () => {
  let root: Root | null = null;

  it('is rendered, composed and run end to end, with the host answering its fetch', async () => {
    // Everything between a bundle on disk and a running app: the composer
    // routes the .py file, the renderer forwards the project it produced, the
    // runtime asks for an engine that can run Python, and the app's own
    // `softn.net.fetch` reaches the handler the host supplied instead of the
    // browser. Nothing else in this file covers the renderer's forwarding, and
    // it is the only path any hosted app uses.
    const fetchSpy = vi.fn(async () => {
      throw new Error('the browser fetch must not be reached');
    });
    vi.stubGlobal('fetch', fetchSpy);
    const seen: Array<{ url: string; options: Record<string, unknown> }> = [];

    const files = new Map<string, string>([
      ['app.softn', '<logic src="./app.py" />\n<p>hi</p>'],
      [
        'app.py',
        [
          'import softn',
          '',
          'def _init():',
          '    softn.net.fetch("https://api.test/probe", {"method": "GET"}, done)',
          '',
          'def done(response):',
          '    pass',
          '',
        ].join('\n'),
      ],
    ]);
    const composed = composeBundleSource(files, 'app.softn');
    expect(composed.python?.modules).toEqual(['app']);

    const container = document.createElement('div');
    document.body.appendChild(container);
    await act(async () => {
      root = createRoot(container);
      root.render(
        <SoftNRenderer
          source={composed.source}
          python={composed.python}
          logicBasePath={composed.logicBasePath}
          appId="PythonRendererEndToEnd"
          scriptExecutionMode="main"
          permissionConfig={NOTHING_GRANTED}
          netFetchHandler={async (url, options) => {
            seen.push({ url, options });
            return { ok: true, status: 200, body: '{}', headers: {} };
          }}
        />
      );
    });
    // The host call is drained after the script loads, so let the queue run.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // The options dict crossed as JSON and came back as an object, which is
    // the whole Python argument-encoding path in one assertion.
    expect(seen).toEqual([{ url: 'https://api.test/probe', options: { method: 'GET' } }]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(container.textContent).toContain('hi');

    const current = root;
    await act(async () => {
      current?.unmount();
    });
    root = null;
    vi.unstubAllGlobals();
  }, 30_000);
});

/** The app's state as the host would read it now, through the sync path. */
async function readState(
  runtime: ReturnType<typeof pythonRuntime>,
  loaded: { state: Record<string, unknown> }
): Promise<Record<string, unknown>> {
  const internals = runtime as unknown as {
    symbolMap: Map<string, { index: number; scope: string }>;
    vmEngine: { getGlobalsBatch(indices: number[]): unknown[] };
  };
  const names = [...internals.symbolMap.entries()].filter(([, s]) => s.scope !== 'function');
  const values = internals.vmEngine.getGlobalsBatch(names.map(([, s]) => s.index));
  const out: Record<string, unknown> = { ...loaded.state };
  names.forEach(([name], i) => {
    out[name] = values[i];
  });
  return out;
}
