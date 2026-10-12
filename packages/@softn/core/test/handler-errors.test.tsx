/**
 * An exception from logic a handler runs is said on the console, as a line
 * that begins "[SoftN]" and names the function, and the app keeps running.
 *
 * That line is how a host learns a script failed: Studio reads it to tell the
 * person and the AI (previewFaults.ts), and a developer reads it in devtools.
 * The renderer's `onError` is not used: it is the app-failed signal (FormLogic
 * reports it to its parent as a failed load), and the runtime keeps an app
 * running after a handler throws.
 *
 * A function that threw as it was called was already said. These were not:
 * - an `async` function that threw, before or after an await: ZIPP hands the
 *   host no promise, so the rejection went nowhere;
 * - a listener the logic put on the window that threw: the exception left
 *   the browser's event listener as an uncaught error that named no part of
 *   the app, and what the listener had changed before it threw was not drawn;
 * - in the worker, any function that threw: the rejection went to a caller
 *   that does not wait on it, and surfaced as an uncaught promise rejection
 *   that named no function. A worker's `async` rejection was printed in the
 *   worker's own console, which no host reads.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createConsoleModule,
  createMockNavModule,
  createMockXDBModule,
  createScriptRuntime,
  type ScriptContext,
  type ScriptRuntimeHandle,
} from '../src/runtime/script-runtime';
import { WorkerScriptRuntime } from '../src/runtime/script-worker-runtime';
import { logicEngineRunsPython } from '../src/runtime/vm-adapter';
import type { ScriptBlock } from '../src/parser/ast';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

const script = (code: string): ScriptBlock => ({ type: 'ScriptBlock', code, loc: { line: 1, column: 0, start: 0, end: 0 } });

const runtimes: ScriptRuntimeHandle[] = [];
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.cleanup();
  vi.restoreAllMocks();
});

/**
 * Every console.error line, its arguments joined as the console shows them.
 * A line about a function is kept only when its first argument is exactly
 * "[SoftN] Error executing function <name>:", with what went wrong after it:
 * that is the shape the Builder's preview reads for whose function failed
 * (apps/softn-builder/src/utils/previewProblems.ts).
 */
function errorLines() {
  const lines: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    const [first] = args;
    if (typeof first === 'string' && first.startsWith('[SoftN] Error executing function') && !/^\[SoftN\] Error executing function [\w$]+:$/.test(first)) {
      return;
    }
    lines.push(args.map((arg) => (arg instanceof Error ? `${arg.name}: ${arg.message}` : String(arg))).join(' '));
  });
  return lines;
}

/** What the browser would call an uncaught error, caught here instead of failing the run. */
function uncaughtErrors() {
  const seen: string[] = [];
  const onError = (event: ErrorEvent) => {
    seen.push(event.message || String(event.error));
    event.preventDefault();
  };
  window.addEventListener('error', onError);
  const onRejection = (reason: unknown) => seen.push(`rejection: ${String(reason)}`);
  process.on('unhandledRejection', onRejection);
  afterEach(() => {
    window.removeEventListener('error', onError);
    process.off('unhandledRejection', onRejection);
  });
  return seen;
}

const LOGIC = `
let saved = 0
function sync() { saved = 1; throw new Error('boom sync') }
async function before() { saved = 2; throw new Error('boom before') }
async function after() { await Promise.resolve(); saved = 3; throw new Error('boom after') }
function listen() { window.addEventListener('keydown', function () { saved = 4; throw new Error('boom key') }) }
function fine() { saved = 5 }
`;

describe('a handler that throws, on the main thread', () => {
  it('is said with the function it was in, for a function and for an async one before and after it waits', async () => {
    const lines = errorLines();
    const { context, state } = makeContext();
    const runtime = createScriptRuntime(context, undefined, 'handler-errors', undefined, undefined, { mode: 'main' });
    runtimes.push(runtime);
    const loaded = await runtime.loadScript(script(LOGIC));
    Object.assign(state, loaded.state);

    await expect(loaded.functions.sync()).resolves.toBeUndefined();
    await expect(loaded.functions.before()).resolves.toBeNull();
    await expect(loaded.functions.after()).resolves.toBeNull();
    await sleep(10);

    for (const [name, message] of [['sync', 'boom sync'], ['before', 'boom before'], ['after', 'boom after']]) {
      expect(lines.some((line) => line.startsWith(`[SoftN] Error executing function ${name}:`) && line.includes(message)), name).toBe(true);
    }
    // And the app goes on: the next call runs, and what it writes is drawn.
    await loaded.functions.fine();
    expect(state.saved).toBe(5);
  });

  it('is said for a listener the logic put on the window, and what it wrote before it threw is drawn', async () => {
    const uncaught = uncaughtErrors();
    const lines = errorLines();
    const { context, state } = makeContext();
    const runtime = createScriptRuntime(context, undefined, 'handler-errors-listener', undefined, undefined, { mode: 'main' });
    runtimes.push(runtime);
    const loaded = await runtime.loadScript(script(LOGIC));
    Object.assign(state, loaded.state);
    await loaded.functions.listen();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    await sleep(10);

    expect(uncaught).toEqual([]);
    expect(lines.some((line) => line.startsWith('[SoftN]') && line.includes('keydown') && line.includes('boom key'))).toBe(true);
    expect(state.saved).toBe(4);
  });
});

// ── Worker mode, with the real worker script run in this realm ──────────────

const workerScope = self as unknown as {
  postMessage: (message: unknown) => void;
  onmessage: ((event: { data: unknown }) => unknown) | null;
};

class InProcessWorker {
  onmessage: ((evt: MessageEvent) => void) | null = null;
  onerror: ((evt: ErrorEvent) => void) | null = null;
  onmessageerror: ((evt: MessageEvent) => void) | null = null;
  terminated = false;
  constructor() {
    workerScope.postMessage = (message: unknown) => {
      if (!this.terminated) setTimeout(() => this.onmessage?.({ data: message } as MessageEvent), 0);
    };
  }
  postMessage(message: unknown): void {
    if (this.terminated) return;
    setTimeout(() => void workerScope.onmessage?.({ data: message }), 0);
  }
  terminate(): void {
    this.terminated = true;
  }
}

describe('a handler that throws, in the worker', () => {
  it('is said on the page with the function it was in, and the app keeps running', async () => {
    const realPostMessage = workerScope.postMessage;
    vi.stubGlobal('Worker', InProcessWorker);
    await import('../src/runtime/script-worker');
    const uncaught = uncaughtErrors();
    const lines = errorLines();
    try {
      const { context, state } = makeContext();
      const runtime = new WorkerScriptRuntime(context, undefined, 'handler-errors-worker');
      runtimes.push(runtime);
      const loaded = await runtime.loadScript(script(LOGIC));
      Object.assign(state, loaded.state);

      await expect(loaded.functions.sync()).resolves.toBeUndefined();
      await loaded.functions.before();
      await loaded.functions.after();
      await sleep(20);

      for (const [name, message] of [['sync', 'boom sync'], ['before', 'boom before'], ['after', 'boom after']]) {
        expect(lines.some((line) => line.startsWith(`[SoftN] Error executing function ${name}:`) && line.includes(message)), name).toBe(true);
      }
      expect(uncaught).toEqual([]);
      await loaded.functions.fine();
      await sleep(20);
      expect(state.saved).toBe(5);
    } finally {
      vi.unstubAllGlobals();
      workerScope.postMessage = realPostMessage;
    }
  });
});

describe.skipIf(!logicEngineRunsPython())('a handler that raises, in Python', () => {
  it('is said with the function it was in', async () => {
    const lines = errorLines();
    const { context, state } = makeContext();
    const runtime = createScriptRuntime(context, undefined, 'handler-errors-python', undefined, undefined, {
      mode: 'main',
      pythonProject: {
        files: { app: ['saved = 0', '', 'def save():', '    raise ValueError("boom python")', ''].join('\n') },
        modules: ['app'],
      },
    });
    runtimes.push(runtime);
    const loaded = await runtime.loadScript(script(''));
    Object.assign(state, loaded.state);
    await expect(loaded.functions.save()).resolves.toBeUndefined();
    expect(lines.some((line) => line.startsWith('[SoftN] Error executing function save:') && line.includes('boom python'))).toBe(true);
  });
});
