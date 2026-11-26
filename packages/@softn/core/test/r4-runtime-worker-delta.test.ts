/**
 * What a worker's script is handed of the store before a call after a write:
 * the collections that changed, read alone.
 *
 * The store reads a collection from the page's storage, whole, each time it is
 * asked for one, and the delta sent for one changed collection read all of
 * them first: five collections of 1,500 records took 3 ms a call where the one
 * that changed takes 0.6.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConsoleModule, createMockNavModule, createMockXDBModule, type ScriptContext } from '../src/runtime/script-runtime';
import { getXDB } from '../src/runtime/xdb-registry';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('the store as a worker is handed it', () => {
  it('reads only the collections that changed for a delta, and hands over their records', async () => {
    class SilentWorker {
      onmessage = null;
      onerror = null;
      onmessageerror = null;
      postMessage() {}
      terminate() {}
    }
    vi.stubGlobal('Worker', SilentWorker);
    const { WorkerScriptRuntime } = await import('../src/runtime/script-worker-runtime');
    const appId = 'r4-worker-delta';
    const store = getXDB(appId);
    store.create('notes', { title: 'one' });
    store.create('tags', { name: 'red' });
    const context: ScriptContext = { state: {}, setState: () => {}, data: {}, xdb: createMockXDBModule(), nav: createMockNavModule(), console: createConsoleModule() };
    const runtime = new WorkerScriptRuntime(context, undefined, appId);
    const r = runtime as unknown as { storagePayload: () => Record<string, unknown>; markDbDirty: (collection?: string) => void };
    try {
      expect(Object.keys(r.storagePayload().dbSnapshot as object).sort()).toEqual(['notes', 'tags']);

      store.create('notes', { title: 'two' });
      const reads = vi.spyOn(store, 'export');
      r.markDbDirty('notes');
      const payload = r.storagePayload();
      expect(reads).toHaveBeenCalledTimes(1);
      expect(reads.mock.calls[0][0]).toEqual(['notes']);
      const delta = payload.dbDelta as Record<string, Array<{ data: { title: string } }>>;
      expect(Object.keys(delta)).toEqual(['notes']);
      expect(delta.notes.map((record) => record.data.title).sort()).toEqual(['one', 'two']);
    } finally {
      runtime.cleanup();
    }
  });
});
