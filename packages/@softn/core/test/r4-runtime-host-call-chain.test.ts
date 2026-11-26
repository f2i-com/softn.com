/**
 * A chain of host calls, each made from the last one's callback, is answered
 * to its end however long it is.
 *
 * A chain was cut off at its 256th call, to keep one of calls that answer at
 * once from holding the page: the rest were never made and their callbacks
 * never ran, with a line in the console. A long poll (`fetch`, and fetch again
 * from its callback), records read a page at a time, a playlist that waits for
 * each track's end: each stopped for good at the 256th. The chain now lets the
 * page have its turn every 256 calls and goes on.
 */
import { afterEach, describe, expect, it } from 'vitest';
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(test: () => boolean, ms = 5000): Promise<void> {
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

/** 600 calls, each made from the callback of the one before. */
const CHAIN = `
  let answered = 0;
  function step() {
    softn.audio.setVolume(1, function () {
      answered = answered + 1;
      if (answered < 600) step();
    });
  }
`;

const runtimes: ScriptRuntimeHandle[] = [];
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.cleanup();
});

describe('a chain of host calls', () => {
  it('is answered to its end on the main thread, and lets the page have its turns', async () => {
    const { context, state } = makeContext();
    const runtime = createScriptRuntime(context, undefined, 'r4-chain-main', undefined, undefined, { mode: 'main' });
    runtimes.push(runtime);
    const loaded = await runtime.loadScript(block(CHAIN));
    Object.assign(state, loaded.state);
    let turns = 0;
    const tick = setInterval(() => {
      turns++;
    }, 0);
    try {
      await loaded.functions.step!();
      await until(() => state.answered === 600);
    } finally {
      clearInterval(tick);
    }
    expect(turns).toBeGreaterThan(0);
  });

  it('is answered to its end in a worker', async () => {
    await withInProcessWorker(async () => {
      const { context, state } = makeContext();
      const runtime = new WorkerScriptRuntime(context, undefined, 'r4-chain-worker');
      runtimes.push(runtime);
      const loaded = await runtime.loadScript(block(CHAIN));
      Object.assign(state, loaded.state);
      await loaded.functions.step!();
      await until(() => state.answered === 600, 20_000);
    });
  }, 30_000);
});
