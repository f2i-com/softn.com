/**
 * What fails in a worker reaches the page's host as it does on the main thread.
 *
 * The script is in another thread, so a failure comes back as part of an
 * entry's answer, or as a line the engine wrote there. The console heard of
 * those; the person using the app was told by nothing. The worker here is a
 * stand-in that answers as the real one does (script-worker.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkerScriptRuntime } from '../src/runtime/script-worker-runtime';
import {
  createMockXDBModule,
  createMockNavModule,
  createConsoleModule,
  type CodeBlock,
  type ScriptContext,
  type ScriptFailure,
} from '../src/runtime/script-runtime';

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((evt: MessageEvent) => void) | null = null;
  onerror: ((evt: ErrorEvent) => void) | null = null;
  onmessageerror: ((evt: MessageEvent) => void) | null = null;
  posted: Array<{ id: number; type: string }> = [];
  constructor() {
    FakeWorker.instances.push(this);
  }
  postMessage(message: { id: number; type: string }): void {
    this.posted.push(message);
  }
  terminate(): void {}
  answer(id: number, result: unknown): void {
    this.onmessage?.({ data: { id, ok: true, result } } as MessageEvent);
  }
}

function context(): ScriptContext {
  return { state: {}, setState: () => {}, data: {}, xdb: createMockXDBModule(), nav: createMockNavModule(), console: createConsoleModule() };
}

const script = { type: 'script', code: 'function go() {}' } as unknown as CodeBlock;

async function loaded(failures: ScriptFailure[]) {
  const runtime = new WorkerScriptRuntime(context(), undefined, 'app', undefined, undefined, { onScriptFailure: (failure) => failures.push(failure) });
  const worker = FakeWorker.instances[0];
  const loading = runtime.loadScript(script);
  await vi.waitFor(() => expect(worker.posted.some((m) => m.type === 'init')).toBe(true));
  worker.answer(worker.posted.find((m) => m.type === 'init')!.id, { functionNames: ['go'], syncFunctionNames: [], computedNames: [], state: {} });
  return { worker, functions: (await loading).functions };
}

beforeEach(() => {
  FakeWorker.instances = [];
  vi.stubGlobal('Worker', FakeWorker);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('a worker’s script', () => {
  it('reports a handler that threw', async () => {
    const failures: ScriptFailure[] = [];
    const { worker, functions } = await loaded(failures);
    const call = functions.go();
    await vi.waitFor(() => expect(worker.posted.some((m) => m.type === 'call_fn')).toBe(true));
    worker.answer(worker.posted.find((m) => m.type === 'call_fn')!.id, { failure: 'Error: boom', result: undefined });
    await call;
    expect(failures).toEqual([{ where: 'go', message: 'Error: boom', stopped: false }]);
  });

  it('reports an async handler’s rejection, which arrives as the engine’s line', async () => {
    const failures: ScriptFailure[] = [];
    const { worker, functions } = await loaded(failures);
    const call = functions.go();
    await vi.waitFor(() => expect(worker.posted.some((m) => m.type === 'call_fn')).toBe(true));
    worker.answer(worker.posted.find((m) => m.type === 'call_fn')!.id, { faults: ['[SoftN] Error executing function go: Error: late'], result: undefined });
    await call;
    await vi.waitFor(() => expect(failures).toEqual([{ where: 'go', message: 'Error: late', stopped: false }]));
  });
});
