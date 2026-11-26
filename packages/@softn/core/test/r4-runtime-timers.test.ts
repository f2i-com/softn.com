/**
 * The script's timers go on while a host call one of them made is waiting.
 *
 * Due timers are answered in one entry into the engine, and the next due ones
 * waited for that entry to be over. It was over only when every host call the
 * callbacks had made was answered: a `softn.net.fetch` from a timer, an
 * `audio.whenEnded` on a long track. Until then no timer of the app fired, so
 * a clock or a game loop stood still for as long as a request took. The
 * worker runtime never held them so.
 */
import { afterEach, describe, it } from 'vitest';
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(test: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!test()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await sleep(5);
  }
}

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

const block = (code: string) => ({ type: 'LogicBlock' as const, code, loc: { line: 1, column: 0, start: 0, end: 0 } });

/** A clock, and one request made from a timer that the host takes a long time to answer. */
const CLOCK = `
  let ticks = 0;
  let answered = 0;
  setInterval(function () { ticks = ticks + 1 }, 10);
  setTimeout(function () {
    softn.net.fetch('https://api.test/slow', {}, function (response) { answered = response.status });
  }, 5);
`;

const runtimes: ScriptRuntimeHandle[] = [];
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.cleanup();
});

describe('a timer that makes a slow host call', () => {
  it('does not stop the other timers while the call waits, on the main thread', async () => {
    const { context, state } = makeContext();
    let answer!: () => void;
    const handler: NetFetchHandler = () =>
      new Promise((resolve) => {
        answer = () => resolve({ ok: true, status: 200, statusText: 'OK', body: '', headers: {} });
      });
    const runtime = createScriptRuntime(context, undefined, 'r4-timers-main', undefined, undefined, { mode: 'main', netFetchHandler: handler });
    runtimes.push(runtime);
    const loaded = await runtime.loadScript(block(CLOCK));
    Object.assign(state, loaded.state);
    await until(() => typeof answer === 'function');
    const before = Number(state.ticks ?? 0);
    // The request waits; the clock does not.
    await until(() => Number(state.ticks) >= before + 5, 1500);
    answer();
    await until(() => state.answered === 200);
  });

  it('nor in a worker', async () => {
    await withInProcessWorker(async () => {
      const { context, state } = makeContext();
      let answer!: () => void;
      const handler: NetFetchHandler = () =>
        new Promise((resolve) => {
          answer = () => resolve({ ok: true, status: 200, statusText: 'OK', body: '', headers: {} });
        });
      const runtime = new WorkerScriptRuntime(context, undefined, 'r4-timers-worker', undefined, undefined, { netFetchHandler: handler });
      runtimes.push(runtime);
      const loaded = await runtime.loadScript(block(CLOCK));
      Object.assign(state, loaded.state);
      await until(() => typeof answer === 'function');
      const before = Number(state.ticks ?? 0);
      await until(() => Number(state.ticks) >= before + 5, 1500);
      answer();
      await until(() => state.answered === 200);
    });
  });
});
