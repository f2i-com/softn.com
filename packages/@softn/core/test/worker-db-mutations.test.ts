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
import { createEphemeralXDBScope, type EphemeralXDBScope } from '../src/runtime/xdb';
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
