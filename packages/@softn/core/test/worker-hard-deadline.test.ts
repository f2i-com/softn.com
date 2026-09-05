/**
 * A worker that stops answering is terminated, not waited on.
 *
 * The RPC timeout used to reject the caller and leave the worker running:
 * every later call queued behind the stuck one and timed out in turn, the
 * app sat frozen with no error, and closing the tab was the only way out.
 * The hard deadline is the wall-clock guarantee the engine's instruction
 * budget cannot give — a host call that never returns is not an instruction.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
  /** Answer one request the way the real worker would. */
  answer(id: number, result: unknown): void {
    this.onmessage?.({ data: { id, ok: true, result } } as MessageEvent);
  }
}

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

const script = { type: 'script', code: '' } as unknown as CodeBlock;

beforeEach(() => {
  FakeWorker.instances = [];
  vi.stubGlobal('Worker', FakeWorker);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('a worker that never answers', () => {
  it('is terminated at the hard deadline and the host is told', async () => {
    const onFatal = vi.fn();
    const runtime = new WorkerScriptRuntime(makeContext(), undefined, 'app', undefined, undefined, {
      hardDeadlineMs: 50,
      onFatal,
    });
    const worker = FakeWorker.instances[0];
    const load = runtime.loadScript(script);
    load.catch(() => {});
    vi.advanceTimersByTime(49);
    expect(worker.terminated).toBe(false);
    vi.advanceTimersByTime(2);
    await expect(load).rejects.toThrow('worker_hard_deadline:init');
    expect(worker.terminated).toBe(true);
    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(String(onFatal.mock.calls[0][0])).toMatch(/hard_deadline/);
  });

  it('rejects everything outstanding, once', async () => {
    const onFatal = vi.fn();
    const runtime = new WorkerScriptRuntime(makeContext(), undefined, 'app', undefined, undefined, {
      hardDeadlineMs: 50,
      onFatal,
    });
    const first = runtime.loadScript(script);
    first.catch(() => {});
    vi.advanceTimersByTime(20);
    // A second request while the first is still unanswered.
    runtime.updateContext({ a: 1 });
    vi.advanceTimersByTime(40);
    await expect(first).rejects.toThrow(/hard_deadline/);
    expect(FakeWorker.instances[0].terminated).toBe(true);
    // The second request's own deadline must not terminate twice or report twice.
    vi.advanceTimersByTime(100);
    expect(onFatal).toHaveBeenCalledTimes(1);
  });

  it('refuses later work instead of starting a replacement worker', async () => {
    const runtime = new WorkerScriptRuntime(makeContext(), undefined, 'app', undefined, undefined, {
      hardDeadlineMs: 10,
    });
    const load = runtime.loadScript(script);
    load.catch(() => {});
    vi.advanceTimersByTime(11);
    await expect(load).rejects.toThrow(/hard_deadline/);
    await expect(runtime.loadScript(script)).rejects.toThrow('worker_terminated:init');
    expect(FakeWorker.instances).toHaveLength(1);
  });

  it('drops a reply that arrives after the deadline rather than reviving state', async () => {
    const context = makeContext();
    const runtime = new WorkerScriptRuntime(context, undefined, 'app', undefined, undefined, {
      hardDeadlineMs: 10,
    });
    const worker = FakeWorker.instances[0];
    const load = runtime.loadScript(script);
    load.catch(() => {});
    vi.advanceTimersByTime(11);
    await expect(load).rejects.toThrow(/hard_deadline/);
    // The dead worker's answer to the init request, late.
    expect(() => worker.answer(worker.posted[0].id, { state: { revived: true } })).not.toThrow();
    expect(context.state).toEqual({});
  });
});

describe('a worker that answers', () => {
  it('disarms the hard deadline with each reply', async () => {
    const onFatal = vi.fn();
    const runtime = new WorkerScriptRuntime(makeContext(), undefined, 'app', undefined, undefined, {
      hardDeadlineMs: 50,
      onFatal,
    });
    const worker = FakeWorker.instances[0];
    const load = runtime.loadScript(script);
    vi.advanceTimersByTime(30);
    worker.answer(worker.posted[0].id, {
      state: { ready: true },
      functionNames: [],
      syncFunctionNames: [],
      computedNames: [],
      dbMutations: [],
      lsMutations: [],
    });
    const result = await load;
    expect(result.state).toEqual({ ready: true });
    vi.advanceTimersByTime(100);
    expect(onFatal).not.toHaveBeenCalled();
    expect(worker.terminated).toBe(false);
    runtime.cleanup();
    expect(worker.terminated).toBe(true);
    // Cleanup is the host's own decision; it is not reported as a failure.
    expect(onFatal).not.toHaveBeenCalled();
  });
});
