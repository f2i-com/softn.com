/**
 * A call the page stopped waiting for is still a call the script made.
 *
 * A caller waits fifteen seconds for a function (the soft deadline) and is then told to stop
 * waiting; the worker is left alone, because a heavy function legitimately takes longer. Its
 * answer, when it came, was dropped with the caller: the records it wrote, what it kept in
 * storage and the state it changed never reached the page, while the script had been told
 * each of them succeeded and the worker had counted them as handed over. And the script's own
 * start was held to the same fifteen seconds, counted from before the page had given the
 * worker its engine: on a first visit over a slow line the app was shown as failed while its
 * worker went on to start.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkerScriptRuntime } from '../src/runtime/script-worker-runtime';
import {
  createMockXDBModule,
  createMockNavModule,
  createConsoleModule,
  type ScriptContext,
  type CodeBlock,
} from '../src/runtime/script-runtime';

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((evt: MessageEvent) => void) | null = null;
  onerror: ((evt: ErrorEvent) => void) | null = null;
  onmessageerror: ((evt: MessageEvent) => void) | null = null;
  posted: Array<{ id: number; type: string }> = [];
  terminated = false;
  constructor(_url: URL, _opts?: WorkerOptions) {
    FakeWorker.instances.push(this);
  }
  postMessage(message: { id: number; type: string }): void {
    this.posted.push(message);
  }
  terminate(): void {
    this.terminated = true;
  }
  answer(id: number, result: unknown): void {
    this.onmessage?.({ data: { id, ok: true, result } } as MessageEvent);
  }
}

function makeContext(): ScriptContext & { changes: Array<Record<string, unknown>> } {
  const changes: Array<Record<string, unknown>> = [];
  return {
    changes,
    state: {},
    setState: (update: Record<string, unknown>) => {
      changes.push(update);
    },
    data: {},
    xdb: createMockXDBModule(),
    nav: createMockNavModule(),
    console: createConsoleModule(),
  } as unknown as ScriptContext & { changes: Array<Record<string, unknown>> };
}

const script = { type: 'script', code: '' } as unknown as CodeBlock;
const STARTED = { state: {}, functionNames: ['save'], syncFunctionNames: [], computedNames: [], dbMutations: [], lsMutations: [] };

beforeEach(() => {
  FakeWorker.instances = [];
  vi.stubGlobal('Worker', FakeWorker);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('a function that answers after its caller stopped waiting', () => {
  it('still has what it did applied: its storage and its state', async () => {
    const context = makeContext();
    const runtime = new WorkerScriptRuntime(context, undefined, 'late-app', undefined, undefined, { hardDeadlineMs: 120_000 });
    const worker = FakeWorker.instances[0];
    const load = runtime.loadScript(script);
    worker.answer(worker.posted[0].id, STARTED);
    const { functions } = await load;

    const call = functions.save();
    const request = worker.posted[worker.posted.length - 1];
    expect(request.type).toBe('call_fn');
    // The caller is released at the soft deadline; the worker is not touched.
    vi.advanceTimersByTime(15_001);
    await expect(call).resolves.toBeUndefined();
    expect(worker.terminated).toBe(false);
    expect(localStorage.getItem('softn:late-app:note')).toBeNull();

    // The function finishes a little later, with what it did.
    worker.answer(request.id, {
      result: 'done',
      state: { saved: 3 },
      lsMutations: [{ type: 'setItem', key: 'note', value: 'kept' }],
      dbMutations: [],
    });
    await Promise.resolve();
    expect(localStorage.getItem('softn:late-app:note')).toBe('kept');
    expect(context.state).toMatchObject({ saved: 3 });

    // The same answer a second time is nothing: it is applied once.
    worker.answer(request.id, { result: 'done', state: { saved: 99 }, lsMutations: [{ type: 'setItem', key: 'note', value: 'twice' }] });
    await Promise.resolve();
    expect(localStorage.getItem('softn:late-app:note')).toBe('kept');
    expect(context.state).toMatchObject({ saved: 3 });
    runtime.cleanup();
  });

  it('is nothing once the runtime is gone', async () => {
    const context = makeContext();
    const runtime = new WorkerScriptRuntime(context, undefined, 'late-gone', undefined, undefined, { hardDeadlineMs: 120_000 });
    const worker = FakeWorker.instances[0];
    const load = runtime.loadScript(script);
    worker.answer(worker.posted[0].id, STARTED);
    const { functions } = await load;
    const call = functions.save();
    const request = worker.posted[worker.posted.length - 1];
    vi.advanceTimersByTime(15_001);
    await call;
    runtime.cleanup();
    expect(() => worker.answer(request.id, { state: { saved: 1 }, lsMutations: [{ type: 'setItem', key: 'note', value: 'late' }] })).not.toThrow();
    await Promise.resolve();
    expect(localStorage.getItem('softn:late-gone:note')).toBeNull();
    expect(context.state).toEqual({});
  });
});

describe('a script whose start takes longer than a function is waited for', () => {
  it('is still started when the worker answers: the start is held to the hard deadline alone', async () => {
    const onFatal = vi.fn();
    const runtime = new WorkerScriptRuntime(makeContext(), undefined, 'slow-start', undefined, undefined, { hardDeadlineMs: 60_000, onFatal });
    const worker = FakeWorker.instances[0];
    let settled: 'no' | 'started' | 'failed' = 'no';
    const load = runtime.loadScript(script).then(
      (loaded) => {
        settled = 'started';
        return loaded;
      },
      (error) => {
        settled = 'failed';
        throw error;
      }
    );
    load.catch(() => {});
    // Past the fifteen seconds a function is waited for, with the engine still on its way.
    vi.advanceTimersByTime(30_000);
    await Promise.resolve();
    expect(settled).toBe('no');
    worker.answer(worker.posted[0].id, STARTED);
    const { functions } = await load;
    expect(settled).toBe('started');
    expect(typeof functions.save).toBe('function');
    expect(onFatal).not.toHaveBeenCalled();
    runtime.cleanup();
  });
});
