// @vitest-environment jsdom
/**
 * Every entry into the worker's engine has the database as it is now: a
 * callback that waited on a host call, and a window event, had the records
 * from before them. And a worker's update the page cannot keep is said.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConsoleModule, createMockNavModule, createMockXDBModule, type ScriptContext } from '../src/runtime/script-runtime';
import { createWorkerScriptRuntime } from '../src/runtime/script-worker-runtime';
import { getXDB } from '../src/runtime/xdb-registry';

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
const loc = { line: 1, column: 0, start: 0, end: 0 };
const empty = { state: {}, hostCalls: [], eventTypes: [], dbMutations: [], lsMutations: [], faults: [] };

afterEach(() => vi.unstubAllGlobals());

/** script-worker.ts answering each entry with `answer(type)`; what was posted, by type and payload keys. */
function stubWorker(answer: (type: string) => Record<string, unknown>) {
  const posted: Array<{ type: string; keys: string[] }> = [];
  class FakeWorker {
    onmessage: ((e: MessageEvent) => void) | null = null;
    onerror = null;
    onmessageerror = null;
    postMessage(msg: { id?: number; type?: string; payload?: Record<string, unknown> }) {
      const type = msg?.type;
      if (!type || type === 'engine') return;
      posted.push({ type, keys: Object.keys(msg.payload ?? {}) });
      setTimeout(() => this.onmessage?.({ data: { id: msg.id, ok: true, result: { ...empty, ...answer(type) } } } as MessageEvent), 0);
    }
    terminate() {}
  }
  vi.stubGlobal('Worker', FakeWorker);
  return posted;
}

describe('an entry into the worker', () => {
  it('a host call\'s callback has the records written while the call was out', async () => {
    const posted = stubWorker((type) =>
      type === 'init'
        ? { functionNames: ['load'], syncFunctionNames: [], computedNames: [] }
        : type === 'call_fn'
          ? { result: null, hostCalls: [{ id: 1, kind: 'net.fetch', args: ['https://api.test/x', '{}'] }] }
          : {}
    );
    let release!: () => void;
    const out = new Promise<void>((r) => (release = r));
    const runtime = createWorkerScriptRuntime(makeContext(), undefined, 'fresh-callback', undefined, undefined, {
      permissionConfig: { permissions: { net: { enabled: true } } } as never,
      netFetchHandler: async () => {
        await out;
        return { ok: true, status: 200, body: '', headers: {} };
      },
    });
    const loaded = await runtime.loadScript({ type: 'ScriptBlock', loc, code: '' });
    await loaded.functions.load();
    await new Promise((r) => setTimeout(r, 10));
    getXDB('fresh-callback').create('notes', { text: 'arrived while the fetch was out' });
    release();
    await new Promise((r) => setTimeout(r, 30));
    runtime.cleanup();
    const resolve = posted.find((p) => p.type === 'resolve_host_call');
    expect(resolve, JSON.stringify(posted)).toBeDefined();
    expect(resolve!.keys.some((k) => k === 'dbDelta' || k === 'dbSnapshot'), resolve!.keys.join(',')).toBe(true);
  });

  it('an update of a record the page no longer has is reported, not dropped', async () => {
    const xdb = getXDB('gone-record');
    stubWorker((type) => (type === 'init' ? { functionNames: [], syncFunctionNames: [], computedNames: [], dbMutations: [{ type: 'update', id: 'no-such-record', data: { text: 'edited' } }] } : {}));
    const failures: string[] = [];
    const runtime = createWorkerScriptRuntime(makeContext(), undefined, 'gone-record', undefined, undefined, {
      permissionConfig: { permissions: {} } as never,
      onPersistenceFailure: (f) => failures.push(`${f.operation} ${f.key}`),
    });
    const quiet = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await runtime.loadScript({ type: 'ScriptBlock', loc, code: '' });
    await new Promise((r) => setTimeout(r, 20));
    quiet.mockRestore();
    runtime.cleanup();
    expect(xdb.get('notes', 'no-such-record')).toBeNull();
    expect(failures).toEqual(['update no-such-record']);
  });
});
