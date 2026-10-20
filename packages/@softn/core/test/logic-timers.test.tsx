/**
 * `setTimeout`, `setInterval` and their clear functions in `.logic`.
 *
 * ZIPP's own `setTimeout` is for its command line. In a page, a callback set
 * inside a function was queued on an event loop nothing runs, so it never
 * fired and nothing said so; one set at the top level of a script made the
 * engine sleep until it was due, which WebAssembly in a page cannot do, and
 * the script failed to load ("unreachable"). `setInterval`, `clearTimeout` and
 * `clearInterval` did not exist. Authors write all four, and so does Studio's
 * AI, so the runtime declares them over `host.call` and keeps the clock
 * itself (logic-timers.ts).
 *
 * Real timers with short delays throughout: the callbacks run in the real
 * engine, behind the runtime's VM lock, which fake timers would fight.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SoftNRenderer } from '../src/loader/SoftNRenderer';
import type { ScriptBlock } from '../src/parser/ast';
import {
  createConsoleModule,
  createMockNavModule,
  createMockXDBModule,
  createScriptRuntime,
  type NetFetchHandler,
  type ScriptContext,
  type ScriptRuntimeHandle,
} from '../src/runtime/script-runtime';
import { WorkerScriptRuntime } from '../src/runtime/script-worker-runtime';
import { withInProcessWorker } from './helpers/in-process-worker';
import { VmAdapter, createLogicEngine } from '../src/runtime/vm-adapter';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait until `test` holds, or fail after `ms`. */
async function until(test: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!test()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await sleep(5);
  }
}

function makeContext() {
  const state: Record<string, unknown> = {};
  const writes: Array<Record<string, unknown>> = [];
  const context: ScriptContext = {
    state,
    setState: (path, value) => {
      state[path] = value;
      writes.push({ [path]: value });
    },
    batchSetState: (changes) => {
      Object.assign(state, changes);
      writes.push({ ...changes });
    },
    data: {},
    xdb: createMockXDBModule(),
    nav: createMockNavModule(),
    console: createConsoleModule(),
  };
  return { context, state, writes };
}

const script = (code: string): ScriptBlock => ({
  type: 'ScriptBlock',
  code,
  loc: { line: 1, column: 0, start: 0, end: 0 },
});

const runtimes: ScriptRuntimeHandle[] = [];

function makeRuntime(context: ScriptContext, options: Record<string, unknown> = {}) {
  const runtime = createScriptRuntime(context, undefined, 'logic-timers', undefined, undefined, {
    mode: 'main',
    ...options,
  });
  runtimes.push(runtime);
  return runtime;
}

afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.cleanup();
  vi.restoreAllMocks();
});

describe('a timer in logic', () => {
  it('runs its callback, and what the callback writes reaches the page', async () => {
    const { context, state } = makeContext();
    const runtime = makeRuntime(context);
    const loaded = await runtime.loadScript(
      script(`
        let n = 0
        function go() { setTimeout(function () { n = n + 1 }, 10) }
      `)
    );
    Object.assign(state, loaded.state);
    await loaded.functions.go();
    expect(state.n).toBe(0);
    await until(() => state.n === 1);
    await sleep(40);
    expect(state.n).toBe(1);
  });

  it('passes the arguments given after the delay', async () => {
    const { context, state } = makeContext();
    const runtime = makeRuntime(context);
    const loaded = await runtime.loadScript(
      script(`
        let said = ''
        function go() { setTimeout(function (a, b) { said = a + b }, 0, 'tea', 2) }
      `)
    );
    Object.assign(state, loaded.state);
    await loaded.functions.go();
    await until(() => state.said === 'tea2');
  });

  // When what follows an `await` runs is the engine's to say. ZIPP runs it
  // before the timer's entry returns, and the page is told at once; the
  // host-JavaScript engine runs it afterwards, and the page sees it at the
  // next entry, as it does for any await (host-js-adapter.ts).
  it('resumes an async function that awaits it', async () => {
    const probe = await createLogicEngine();
    const zipp = probe instanceof VmAdapter;
    probe.dispose();
    const { context, state } = makeContext();
    const runtime = makeRuntime(context);
    const loaded = await runtime.loadScript(
      script(`
        let step = 'idle'
        function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms) }) }
        async function go() { step = 'waiting'; await sleep(10); step = 'done' }
        function look() {}
      `)
    );
    Object.assign(state, loaded.state);
    await loaded.functions.go();
    expect(state.step).toBe('waiting');
    if (zipp) {
      await until(() => state.step === 'done');
    } else {
      await sleep(60);
      await loaded.functions.look();
      expect(state.step).toBe('done');
    }
  });

  // ZIPP's own setTimeout ran, before the script finished loading, a timer
  // set at the top level that was already due by then (a delay of 0, say),
  // and only failed the load for one still in the future. Those are run as
  // they were: before the load returns, so what they write is in the state
  // the page starts with and an _init sees it. (On the host-JavaScript engine
  // the microtasks between them run after the load, as all of its do.)
  it('runs a top-level timer that is already due before the script has loaded, as before', async () => {
    const probe = await createLogicEngine();
    const zipp = probe instanceof VmAdapter;
    probe.dispose();
    const { context, state } = makeContext();
    const runtime = makeRuntime(context);
    const loaded = await runtime.loadScript(
      script(`
        let order = ''
        setTimeout(function () { order = order + 'a'; setTimeout(function () { order = order + 'c' }, 0) }, 0)
        setTimeout(function (x) { order = order + x }, 0, 'b')
        let start = Date.now()
        setTimeout(function () { order = order + 'd' }, 1)
        while (Date.now() - start < 15) {}
        setTimeout(function () { order = order + '!' }, 500)
      `)
    );
    // '!' is still in the future when the load returns, unless the load
    // itself takes longer than its delay: 60 ms did on a machine busy with
    // the other suites, and '!' was in the state the page starts with.
    if (zipp) expect(loaded.state.order).toBe('abdc');
    Object.assign(state, loaded.state);
    await until(() => state.order === 'abdc!');
  });

  it('can be set at the top level of the script, and fires with no _init', async () => {
    const { context, state } = makeContext();
    const runtime = makeRuntime(context);
    const loaded = await runtime.loadScript(
      script(`
        let ready = false
        setTimeout(function () { ready = true }, 10)
      `)
    );
    Object.assign(state, loaded.state);
    expect(state.ready).toBe(false);
    await until(() => state.ready === true);
  });

  it('is cancelled by clearTimeout, and the host lets its clock go', async () => {
    const { context, state } = makeContext();
    const runtime = makeRuntime(context);
    const loaded = await runtime.loadScript(
      script(`
        let n = 0
        let kept = 0
        function go() {
          let t = setTimeout(function () { n = 1 }, 20)
          clearTimeout(t)
          setTimeout(function () { kept = 1 }, 30)
        }
      `)
    );
    Object.assign(state, loaded.state);
    await loaded.functions.go();
    await until(() => state.kept === 1);
    expect(state.n).toBe(0);
    expect((runtime as unknown as { timers: { size: number } }).timers.size).toBe(0);
  });

  it('repeats as an interval past the limit on a chain of host calls, until it is cleared', async () => {
    const { context, state } = makeContext();
    const runtime = makeRuntime(context);
    const loaded = await runtime.loadScript(
      script(`
        let n = 0
        let id = 0
        function go() {
          id = setInterval(function () {
            n = n + 1
            if (n === 300) clearInterval(id)
          }, 0)
        }
      `)
    );
    Object.assign(state, loaded.state);
    const errors = vi.spyOn(console, 'error');
    await loaded.functions.go();
    await until(() => state.n === 300, 20000);
    await sleep(60);
    expect(state.n).toBe(300);
    expect(errors).not.toHaveBeenCalled();
  }, 30000);

  it('keeps an interval going when its callback throws, and says so', async () => {
    const { context, state } = makeContext();
    const runtime = makeRuntime(context);
    const loaded = await runtime.loadScript(
      script(`
        let n = 0
        let id = 0
        function go() {
          id = setInterval(function () {
            n = n + 1
            if (n === 3) clearInterval(id)
            throw new Error('tick ' + n)
          }, 5)
        }
      `)
    );
    Object.assign(state, loaded.state);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await loaded.functions.go();
    await until(() => state.n === 3);
    await sleep(40);
    expect(state.n).toBe(3);
    expect(errors.mock.calls.some((call) => String(call[0]).startsWith('[SoftN]'))).toBe(true);
  });

  it('does not hold up another host call made beside it', async () => {
    const { context, state } = makeContext();
    const handler: NetFetchHandler = async () => ({ ok: true, status: 200, body: '', headers: {} });
    const runtime = makeRuntime(context, { netFetchHandler: handler });
    const loaded = await runtime.loadScript(
      script(`
        let late = 0
        let status = 0
        function go() {
          setTimeout(function () { late = 1 }, 400)
          softn.net.fetch('https://api.test/x', {}, function (response) { status = response.status })
        }
      `)
    );
    Object.assign(state, loaded.state);
    await loaded.functions.go();
    await until(() => state.status === 200, 300);
    expect(state.late).toBe(0);
  });

  it('never fires after the runtime is cleaned up', async () => {
    const { context, state, writes } = makeContext();
    const runtime = makeRuntime(context);
    const loaded = await runtime.loadScript(
      script(`
        let n = 0
        function go() { setInterval(function () { n = n + 1 }, 5); setTimeout(function () { n = 100 }, 10) }
      `)
    );
    Object.assign(state, loaded.state);
    const errors = vi.spyOn(console, 'error');
    await loaded.functions.go();
    runtime.cleanup();
    const before = writes.length;
    await sleep(60);
    expect(writes.length).toBe(before);
    expect(errors).not.toHaveBeenCalled();
  });

  it('refuses code given as text, with a message that says why', async () => {
    const { context, state } = makeContext();
    const runtime = makeRuntime(context);
    const loaded = await runtime.loadScript(
      script(`
        let said = ''
        function go() { try { setTimeout("said = 'x'", 0) } catch (e) { said = String(e) } }
      `)
    );
    Object.assign(state, loaded.state);
    await loaded.functions.go();
    expect(String(state.said)).toMatch(/TypeError: setTimeout needs a function/);
  });

  it('adds nothing to what the page sees of the script', async () => {
    const { context } = makeContext();
    const runtime = makeRuntime(context);
    const loaded = await runtime.loadScript(script(`let n = 0\nfunction go() {}`));
    expect(Object.keys(loaded.state)).toEqual(['n']);
    expect(Object.keys(loaded.functions)).toEqual(['go']);
  });

  it('leaves a script its own declarations of these names', async () => {
    const { context, state } = makeContext();
    const runtime = makeRuntime(context);
    const loaded = await runtime.loadScript(
      script(`
        let setInterval = 'mine'
        function setTimeout(fn, ms) { return 'also mine' }
        let answer = setTimeout(function () {}, 1) + ' ' + setInterval
      `)
    );
    Object.assign(state, loaded.state);
    expect(state.answer).toBe('also mine mine');
  });
});

describe('what the top level of a script leaves, with no _init', () => {
  // Run once the script has loaded, timers and `softn.*` calls alike, as the
  // worker runtime runs them: on the main thread a call waited for the first
  // call into the script, which for an app without `_init` was a click.
  it('is run once the script has loaded, before the first call, in order', async () => {
    const { context, state } = makeContext();
    const asked: string[] = [];
    const handler: NetFetchHandler = async (url) => {
      asked.push(url);
      return { ok: true, status: 200, body: '', headers: {} };
    };
    const runtime = makeRuntime(context, { netFetchHandler: handler });
    const loaded = await runtime.loadScript(
      script(`
        let answered = 0
        softn.net.fetch('https://api.test/top', {}, function (response) { answered = response.status })
        function go() { softn.net.fetch('https://api.test/go', {}, function () {}) }
      `)
    );
    Object.assign(state, loaded.state);
    await until(() => state.answered === 200, 500);
    expect(asked).toEqual(['https://api.test/top']);
    await loaded.functions.go();
    await until(() => asked.length === 2);
    expect(asked).toEqual(['https://api.test/top', 'https://api.test/go']);
  });

  it('has a listener it put on the window heard from the start, before the first call', async () => {
    const { context, state } = makeContext();
    const runtime = makeRuntime(context);
    const loaded = await runtime.loadScript(
      script(`
        let keys = 0
        window.addEventListener('keydown', function () { keys = keys + 1 })
      `)
    );
    Object.assign(state, loaded.state);
    await sleep(20);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    expect(state.keys).toBe(1);
  });

  it('is run after an _init the host calls straight away, which drains it first, as before', async () => {
    const { context, state } = makeContext();
    const asked: string[] = [];
    const handler: NetFetchHandler = async (url) => {
      asked.push(url);
      return { ok: true, status: 200, body: '', headers: {} };
    };
    const runtime = makeRuntime(context, { netFetchHandler: handler });
    const loaded = await runtime.loadScript(
      script(`
        softn.net.fetch('https://api.test/top', {}, function () {})
        function _init() { softn.net.fetch('https://api.test/init', {}, function () {}) }
      `)
    );
    Object.assign(state, loaded.state);
    void loaded.functions._init();
    await until(() => asked.length === 2);
    await sleep(20);
    expect(asked).toEqual(['https://api.test/top', 'https://api.test/init']);
  });
});

describe('a timer in a drawn page', () => {
  let root: Root | null = null;

  afterEach(async () => {
    if (root) {
      const current = root;
      await act(async () => {
        current.unmount();
      });
      root = null;
    }
  });

  it('redraws the page with what its callback wrote, and stops when the page goes', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const source = `<logic>
let n = 0
function start() { setInterval(function () { n = n + 1 }, 10) }
</logic>
<div><button @click={() => start()}>go</button><p id="count">{n}</p></div>`;
    await act(async () => {
      root = createRoot(container);
      root.render(<SoftNRenderer source={source} appId="LogicTimersRenderer" scriptExecutionMode="main" />);
    });
    await act(async () => {
      await sleep(20);
    });
    const button = container.querySelector('button')!;
    expect(container.querySelector('#count')!.textContent).toBe('0');
    await act(async () => {
      button.click();
      await sleep(5);
    });
    // React draws what act queued when act ends, so each look is its own act.
    const shown = () => Number(container.querySelector('#count')!.textContent);
    for (let i = 0; i < 200 && shown() < 3; i++) {
      await act(async () => {
        await sleep(10);
      });
    }
    expect(shown()).toBeGreaterThanOrEqual(3);

    const errors = vi.spyOn(console, 'error');
    await act(async () => {
      root!.unmount();
    });
    root = null;
    await sleep(50);
    expect(errors).not.toHaveBeenCalled();
  });
});

// ── Worker mode ─────────────────────────────────────────────────────────────

describe('a timer in logic run by the worker', () => {
  it('runs its callback there, and what it writes reaches the page', async () => {
    await withInProcessWorker(async () => {
      const { context, state } = makeContext();
      const runtime = new WorkerScriptRuntime(context, undefined, 'logic-timers-worker');
      runtimes.push(runtime);
      const loaded = await runtime.loadScript(
        script(`
          let n = 0
          let ready = false
          setTimeout(function () { ready = true }, 5)
          function go() {
            let id = setInterval(function () { n = n + 1; if (n === 3) clearInterval(id) }, 5)
          }
        `)
      );
      Object.assign(state, loaded.state);
      await until(() => state.ready === true);
      await loaded.functions.go();
      await until(() => state.n === 3);
      await sleep(40);
      expect(state.n).toBe(3);
      runtime.cleanup();
    });
  });
});
