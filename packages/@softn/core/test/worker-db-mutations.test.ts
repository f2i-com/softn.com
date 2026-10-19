/**
 * A worker's db writes land on the main thread as one batch after each call.
 *
 * `db.prune` and `db.clearCollection` are applied through the script's db
 * namespace, whose store loads lazily and throws until it has. The batch was
 * applied inside one try, so the first batch carrying either threw at that
 * mutation and every write after it was dropped with nothing but a console
 * line: the worker's snapshot had the records, the store never did.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkerScriptRuntime } from '../src/runtime/script-worker-runtime';
import type { DBMutation } from '../src/runtime/script-worker-bridges';
import { createEphemeralXDBScope, getXDB, type EphemeralXDBScope } from '../src/runtime/xdb';
import {
  createMockXDBModule,
  createMockNavModule,
  createConsoleModule,
  type ScriptContext,
} from '../src/runtime/script-runtime';

class FakeWorker {
  onmessage: ((evt: MessageEvent) => void) | null = null;
  onerror: ((evt: ErrorEvent) => void) | null = null;
  onmessageerror: ((evt: MessageEvent) => void) | null = null;
  postMessage(): void {}
  terminate(): void {}
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

type Internals = { applyDBMutations(mutations: DBMutation[]): Promise<void> };

let scope: EphemeralXDBScope;

beforeEach(() => {
  vi.stubGlobal('Worker', FakeWorker);
  scope = createEphemeralXDBScope();
});

afterEach(() => {
  scope.dispose();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a worker's db batch", () => {
  it('applies a prune and every write after it, on the first batch', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const runtime = new WorkerScriptRuntime(makeContext(), undefined, scope.appId);
    for (let i = 0; i < 3; i++) {
      scope.xdb.create('log', { n: i }, { id: `old-${i}` });
    }

    await (runtime as unknown as Internals).applyDBMutations([
      { type: 'prune', collection: 'log', maxRecords: 1 },
      { type: 'create', collection: 'log', data: { n: 99 }, tempId: 'fresh' },
      { type: 'clearCollection', collection: 'scratch' },
      { type: 'create', collection: 'notes', data: { title: 'kept' }, tempId: 'note-1' },
    ]);

    const log = scope.xdb.getAll('log').map((r) => r.id).sort();
    expect(log).toHaveLength(2);
    expect(log).toContain('fresh');
    expect(scope.xdb.get('notes', 'note-1')?.data).toEqual({ title: 'kept' });
    expect(console.error).not.toHaveBeenCalled();
    runtime.cleanup();
  });

  it('reports a mutation that fails and still applies the rest', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const onPersistenceFailure = vi.fn();
    const runtime = new WorkerScriptRuntime(makeContext(), undefined, scope.appId, undefined, undefined, {
      onPersistenceFailure,
    });
    scope.xdb.create('log', { n: 1 }, { id: 'a' });
    vi.spyOn(scope.xdb, 'hardDelete').mockImplementationOnce(() => {
      throw new Error('disk full');
    });

    await (runtime as unknown as Internals).applyDBMutations([
      { type: 'hardDelete', collection: 'log', id: 'a' },
      { type: 'create', collection: 'log', data: { n: 2 }, tempId: 'b' },
    ]);

    expect(onPersistenceFailure).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'hardDelete', key: 'log/a', error: expect.any(Error) })
    );
    expect(scope.xdb.get('log', 'b')).not.toBeNull();
    runtime.cleanup();
  });
});

/**
 * What a worker's script reads is the app's store, as on the main thread.
 *
 * The snapshot the worker was sent was `context.data`, which the renderer
 * hands over empty and nothing fills: `db.query` answered `[]` on every
 * load, and after the script's own `db.create` the next call's delta for the
 * collection, read from that same empty object, took the new record away.
 */
describe("what a worker's script reads", () => {
  type Posted = { id: number; type: string; payload: Record<string, unknown> };
  type Row = { id: string; data: Record<string, unknown> };

  class AnsweringWorker {
    static last: AnsweringWorker;
    onmessage: ((evt: MessageEvent) => void) | null = null;
    onerror: ((evt: ErrorEvent) => void) | null = null;
    onmessageerror: ((evt: MessageEvent) => void) | null = null;
    posted: Posted[] = [];
    constructor() {
      AnsweringWorker.last = this;
    }
    postMessage(message: Posted): void {
      this.posted.push(message);
    }
    terminate(): void {}
    /** The last request of a type, answered with `result`. */
    answerLast(type: string, result: unknown): Posted {
      const request = this.posted.filter((m) => m.type === type).at(-1)!;
      this.onmessage?.({ data: { id: request.id, ok: true, result } } as MessageEvent);
      return request;
    }
  }

  /** A call left unanswered: the runtime's cleanup rejects it. */
  function unanswered(call: Promise<unknown>): void {
    call.catch(() => {});
  }

  /** The records of a collection the request carried to the worker, whole or as a delta. */
  function sent(request: Posted, collection: string): string[] {
    const snapshot = (request.payload.dbDelta ?? request.payload.dbSnapshot) as Record<string, Row[]> | undefined;
    return (snapshot?.[collection] ?? []).map((r) => `${r.id}:${String(r.data.title)}`);
  }

  const stamp = '2026-01-01T00:00:00.000Z';
  const stored = (id: string, title: string, deleted = false) => ({ id, collection: 'todos', data: { title }, created_at: stamp, updated_at: stamp, deleted });
  let appId: string;
  let runtime: WorkerScriptRuntime;

  beforeEach(() => {
    vi.stubGlobal('Worker', AnsweringWorker);
    appId = `worker-reads-${Math.random().toString(36).slice(2)}`;
    // In storage before the app's store is opened, as after a reload: the
    // store knows no collection until it lists them.
    localStorage.setItem(`xdb:${appId}:todos`, JSON.stringify([stored('a', 'stored'), stored('old', 'deleted', true)]));
  });

  afterEach(() => {
    runtime.cleanup();
    localStorage.removeItem(`xdb:${appId}:todos`);
  });

  async function load(): Promise<Record<string, (...args: unknown[]) => Promise<unknown>>> {
    runtime = new WorkerScriptRuntime(makeContext(), undefined, appId);
    const loading = runtime.loadScript({ type: 'script', code: '' } as never);
    const init = AnsweringWorker.last.answerLast('init', { state: {}, functionNames: ['add', 'list'], syncFunctionNames: [], computedNames: [] });
    expect(sent(init, 'todos')).toEqual(['a:stored']);
    return (await loading).functions;
  }

  it('is what was stored before it loaded, and what it wrote itself, on the very next call', async () => {
    const fns = await load();
    const adding = fns.add();
    AnsweringWorker.last.answerLast('call_fn', {
      result: null,
      dbMutations: [{ type: 'create', collection: 'todos', data: { title: 'new' }, tempId: 'b' }],
    });
    await adding;
    unanswered(fns.list());
    expect(sent(AnsweringWorker.last.posted.at(-1)!, 'todos')).toEqual(['a:stored', 'b:new']);
  });

  it('follows what changes in the store outside the worker', async () => {
    const fns = await load();
    const first = fns.list();
    AnsweringWorker.last.answerLast('call_fn', { result: null });
    await first;
    // Another part of the page, or sync, writes to the app's store.
    getXDB(appId).create('todos', { title: 'from elsewhere' }, { id: 'c' });
    unanswered(fns.list());
    expect(sent(AnsweringWorker.last.posted.at(-1)!, 'todos')).toEqual(['a:stored', 'c:from elsewhere']);
  });
});
