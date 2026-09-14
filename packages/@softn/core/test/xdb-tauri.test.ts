/**
 * XDB Tauri Compatibility Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { XDBService } from '../src/runtime/xdb';

type XDBRecord = {
  id: string;
  collection: string;
  data: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  deleted: boolean;
};

function makeRecord(
  id: string,
  collection: string,
  data: Record<string, unknown>,
  overrides: Partial<XDBRecord> = {}
): XDBRecord {
  const now = new Date().toISOString();
  return {
    id,
    collection,
    data,
    created_at: now,
    updated_at: now,
    deleted: false,
    ...overrides,
  };
}

async function flushPromises(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('XDB Service (Tauri mode)', () => {
  let backend: Map<string, XDBRecord[]>;
  let listeners: Map<string, (event: { payload: unknown }) => void>;
  let invokeMock: any;
  let failNextImport = false;

  beforeEach(() => {
    backend = new Map();
    listeners = new Map();
    failNextImport = false;
    invokeMock = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
      switch (cmd) {
        case 'get_collections':
          return Array.from(backend.keys());
        case 'get_collection': {
          const collection = String(args?.collection ?? '');
          return backend.get(collection) ?? [];
        }
        case 'create_record': {
          const payload = args?.payload as { collection: string; data: Record<string, unknown> };
          const record = makeRecord(
            `tauri-${Math.random().toString(36).slice(2)}`,
            payload.collection,
            payload.data
          );
          const records = backend.get(payload.collection) ?? [];
          records.push(record);
          backend.set(payload.collection, records);
          return record;
        }
        case 'update_record': {
          const payload = args?.payload as { id: string; data: Record<string, unknown> };
          for (const [collection, records] of backend.entries()) {
            const index = records.findIndex((r) => r.id === payload.id);
            if (index !== -1) {
              const updated = {
                ...records[index],
                data: { ...records[index].data, ...payload.data },
                updated_at: new Date().toISOString(),
              };
              records[index] = updated;
              backend.set(collection, records);
              return updated;
            }
          }
          throw new Error('Record not found');
        }
        case 'delete_record': {
          const id = String(args?.id ?? '');
          for (const [collection, records] of backend.entries()) {
            const index = records.findIndex((r) => r.id === id);
            if (index !== -1) {
              records[index] = {
                ...records[index],
                deleted: true,
                updated_at: new Date().toISOString(),
              };
              backend.set(collection, records);
              return true;
            }
          }
          return false;
        }
        case 'upsert_record': {
          const record = args?.record as XDBRecord;
          const records = backend.get(record.collection) ?? [];
          const index = records.findIndex((r) => r.id === record.id);
          if (index !== -1) {
            records[index] = record;
          } else {
            records.push(record);
          }
          backend.set(record.collection, records);
          return record;
        }
        case 'get_record': {
          const id = String(args?.id ?? '');
          for (const records of backend.values()) {
            const record = records.find((r) => r.id === id);
            if (record) return record;
          }
          throw new Error('Record not found');
        }
        case 'clear_collection': {
          backend.delete(String(args?.collection ?? ''));
          return true;
        }
        case 'import_records': {
          if (failNextImport) { failNextImport = false; throw new Error('SQLITE_FULL: database or disk is full'); }
          const batches = args?.batches as Array<{ collection: string; replace: boolean; records: XDBRecord[] }>;
          let imported = 0; let tombstoned = 0;
          const collections: Array<{ collection: string; replaced: boolean; imported: number; tombstoned: number; epoch: number }> = [];
          for (const batch of batches) {
            const existing = backend.get(batch.collection) ?? [];
            const incoming = new Set(batch.records.map((r) => r.id));
            let batchTombstoned = 0;
            const next = existing.map((r) => {
              if (batch.replace && !incoming.has(r.id) && !r.deleted) { batchTombstoned++; return { ...r, deleted: true, updated_at: new Date().toISOString() }; }
              return r;
            });
            for (const record of batch.records) {
              const index = next.findIndex((r) => r.id === record.id);
              if (index === -1) next.push(record); else next[index] = record;
            }
            backend.set(batch.collection, next);
            imported += batch.records.length; tombstoned += batchTombstoned;
            collections.push({ collection: batch.collection, replaced: batch.replace, imported: batch.records.length, tombstoned: batchTombstoned, epoch: 0 });
          }
          return { imported, tombstoned, collections };
        }
        default:
          throw new Error(`Unexpected command: ${cmd}`);
      }
    });

    (globalThis as unknown as { window: Window }).window = globalThis as unknown as Window;
    (globalThis as any).__TAURI__ = {
      core: { invoke: invokeMock },
      event: {
        listen: vi.fn(async (event: string, handler: (event: { payload: unknown }) => void) => {
          listeners.set(event, handler);
          return () => listeners.delete(event);
        }),
      },
    };
  });

  afterEach(() => {
    listeners.clear();
    backend.clear();
    delete (globalThis as any).__TAURI__;
  });

  it('hydrates from SQLite backend into in-memory cache', async () => {
    backend.set('tasks', [makeRecord('1', 'tasks', { title: 'A' })]);

    const xdb = new XDBService(undefined, 'test-xdb');
    await flushPromises();
    await flushPromises();

    const records = xdb.getAll('tasks');
    expect(records).toHaveLength(1);
    expect(records[0].data.title).toBe('A');
  });

  it('persists collection-scoped edits and deletes to the desktop backend', async () => {
    backend.set('tasks', [makeRecord('scoped-record', 'tasks', { title: 'before' })]);
    const xdb = new XDBService(undefined, 'scoped-write', 'scoped-write-app');
    await xdb.isReady;
    const onMutation = vi.fn();
    const unsubscribe = xdb.onMutation(onMutation);
    try {
      expect(xdb.updateInCollection('tasks', 'scoped-record', { title: 'after' })?.data.title).toBe(
        'after'
      );
      await flushPromises();
      expect(backend.get('tasks')?.[0].data.title).toBe('after');
      expect(xdb.deleteFromCollection('tasks', 'scoped-record')).toBe(true);
      await flushPromises();
      expect(backend.get('tasks')?.[0].deleted).toBe(true);
      expect(onMutation.mock.calls.map(([event]) => event.type)).toEqual(['update', 'delete']);
      expect(
        invokeMock.mock.calls
          .filter(([command]: [string]) => ['update_record', 'delete_record'].includes(command))
          .every(([, args]: [string, Record<string, unknown>]) => args.appId === 'scoped-write-app')
      ).toBe(true);
    } finally {
      unsubscribe();
    }
  });

  it('notifies server sync after acknowledged desktop creates, edits and deletes', async () => {
    const xdb = new XDBService(undefined, 'acknowledged-write', 'acknowledged-write-app');
    await xdb.isReady;
    const onMutation = vi.fn();
    const unsubscribe = xdb.onMutation(onMutation);
    try {
      const record = await xdb.createAsync('tasks', { title: 'before' });
      await xdb.updateAsync(record.id, { title: 'after' });
      await xdb.deleteAsync(record.id);
      expect(onMutation.mock.calls.map(([event]) => event.type)).toEqual([
        'create',
        'update',
        'delete',
      ]);
    } finally {
      unsubscribe();
    }
  });

  it('rehydrates collection on sync event', async () => {
    backend.set('tasks', [makeRecord('1', 'tasks', { title: 'A' })]);
    const xdb = new XDBService(undefined, 'test-xdb');
    await flushPromises();
    await flushPromises();

    backend.set('tasks', [
      makeRecord('1', 'tasks', { title: 'A' }),
      makeRecord('2', 'tasks', { title: 'B' }),
    ]);

    const handler = listeners.get('xdb-sync-event');
    expect(handler).toBeDefined();
    handler?.({ payload: { type: 'sync_update', collection: 'tasks' } });

    await flushPromises();
    await flushPromises();

    const records = xdb.getAll('tasks');
    expect(records).toHaveLength(2);
  });

  it('persists writeRecord via upsert_record', async () => {
    const xdb = new XDBService(undefined, 'test-xdb');
    await flushPromises();

    const record = makeRecord('1', 'tasks', { title: 'From Yjs' });
    xdb.writeRecord('tasks', record);

    expect(invokeMock).toHaveBeenCalledWith('upsert_record', { record });
  });

  // ── Audit SN-01: import/restore acknowledge committed data ──

  it('replaces through ONE native transaction that tombstones absent rows, and only then reports durable', async () => {
    backend.set('tasks', [makeRecord('stale', 'tasks', { title: 'Stale' })]);
    const xdb = new XDBService(undefined, 'test-xdb');
    await xdb.isReady;
    expect(xdb.getAll('tasks')).toHaveLength(1);

    invokeMock.mockClear();
    const fresh = makeRecord('fresh', 'tasks', { title: 'Fresh' });
    const result = xdb.import({ version: 1, exportedAt: '', collections: { tasks: [fresh] } }, { merge: false });
    expect(xdb.hasPendingWrites()).toBe(true);
    const persisted = await result.persisted;
    expect(persisted).toEqual({ backend: 'native', collections: ['tasks'], imported: 1, tombstoned: 1 });
    expect(xdb.hasPendingWrites()).toBe(false);

    // No per-record fire-and-forget, no local hard reset: one bulk command.
    const commands = invokeMock.mock.calls.map(([cmd]: [string]) => cmd);
    expect(commands).toEqual(['import_records']);
    expect(invokeMock).toHaveBeenCalledWith('import_records', { batches: [{ collection: 'tasks', replace: true, records: [fresh] }] });
    expect(backend.get('tasks')?.filter((r) => !r.deleted).map((r) => r.id)).toEqual(['fresh']);
    expect(backend.get('tasks')?.find((r) => r.id === 'stale')?.deleted).toBe(true);
    expect(xdb.getAll('tasks').map((r) => r.id)).toEqual(['fresh']);
  });

  it('merges through the same bulk command without tombstoning', async () => {
    backend.set('tasks', [makeRecord('kept', 'tasks', { title: 'Kept' })]);
    const xdb = new XDBService(undefined, 'test-xdb');
    await xdb.isReady;

    invokeMock.mockClear();
    const fresh = makeRecord('fresh', 'tasks', { title: 'Fresh' });
    const { persisted } = await xdb.importAsync({ version: 1, exportedAt: '', collections: { tasks: [fresh] } });
    expect(persisted.tombstoned).toBe(0);
    expect(invokeMock).toHaveBeenCalledWith('import_records', { batches: [{ collection: 'tasks', replace: false, records: [fresh] }] });
    expect(invokeMock).not.toHaveBeenCalledWith('clear_collection', expect.anything());
    expect(backend.get('tasks')?.map((r) => r.id)).toEqual(['kept', 'fresh']);
  });

  it('rejects the durable signal and reloads the cache when the native transaction fails', async () => {
    backend.set('tasks', [makeRecord('kept', 'tasks', { title: 'Kept' })]);
    const xdb = new XDBService(undefined, 'test-xdb');
    await xdb.isReady;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    failNextImport = true;
    const fresh = makeRecord('fresh', 'tasks', { title: 'Fresh' });
    const result = xdb.import({ version: 1, exportedAt: '', collections: { tasks: [fresh] } }, { merge: false });
    // Optimistic cache first…
    expect(xdb.getAll('tasks').map((r) => r.id)).toEqual(['fresh']);
    // …but the caller is told the truth, and the cache goes back to disk.
    await expect(result.persisted).rejects.toThrow(/SQLITE_FULL/);
    expect(xdb.getAll('tasks').map((r) => r.id)).toEqual(['kept']);
    expect(backend.get('tasks')?.map((r) => r.id)).toEqual(['kept']);
    await expect(xdb.restoreAsync({ version: 1, exportedAt: '', collections: { tasks: [fresh] } })).resolves.toMatchObject({ persisted: { backend: 'native' } });
    errors.mockRestore();
  });

  it('restoreAsync refuses a partial restore unless the caller accepts it', async () => {
    const xdb = new XDBService(undefined, 'test-xdb');
    await xdb.isReady;
    const backup = { version: 1, exportedAt: '', collections: { tasks: [makeRecord('t1', 'tasks', {}), { broken: true } as unknown as XDBRecord], notAList: 'x' as unknown as XDBRecord[] } };
    await expect(xdb.restoreAsync(backup)).rejects.toThrow(/2 row\(s\) or collection\(s\)/);
    const accepted = await xdb.restoreAsync(backup, { acceptPartial: true });
    expect(accepted.skipped).toBe(2);
    expect(accepted.persisted.imported).toBe(1);
  });

  it('whenIdle waits for every tracked native write', async () => {
    const xdb = new XDBService(undefined, 'test-xdb');
    await xdb.isReady;
    xdb.create('tasks', { title: 'a' });
    xdb.create('tasks', { title: 'b' });
    expect(xdb.getStorageStatus().pendingWrites).toBe(2);
    await xdb.whenIdle();
    expect(xdb.getStorageStatus().pendingWrites).toBe(0);
    expect(backend.get('tasks')).toHaveLength(2);
  });

  // ── Audit SN-02: hydration failure is a state, not empty data ──

  it('reports a failed native hydration and refuses resets until a retry succeeds', async () => {
    backend.set('tasks', [makeRecord('t1', 'tasks', { title: 'Unknown to the cache' })]);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const original = invokeMock.getMockImplementation();
    let failGetCollection = true;
    invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'get_collection' && failGetCollection) throw new Error('IPC failure');
      return original(cmd, args);
    });
    const xdb = new XDBService(undefined, 'test-xdb');
    await xdb.isReady; // liveness…
    const status = xdb.getStorageStatus();
    expect(status.state).toBe('degraded'); // …is not success
    expect(status.hydrated).toBe(false);
    expect(status.issues.map((i) => i.kind)).toContain('hydration-failed');
    expect(xdb.isHydrated('tasks')).toBe(false);
    expect(xdb.getAll('tasks')).toEqual([]);
    // A reset now would drop the record the cache never saw.
    expect(() => xdb.clear('tasks')).toThrow(/has not been loaded/);
    expect(() => xdb.import({ version: 1, exportedAt: '', collections: { tasks: [] } }, { merge: false })).toThrow(/has not been loaded/);
    expect(backend.get('tasks')).toHaveLength(1);
    // Non-destructive writes still work: the app stays responsive.
    xdb.create('tasks', { title: 'new while degraded' });
    await xdb.whenIdle();

    failGetCollection = false;
    const recovered = await xdb.retryHydration();
    expect(recovered.state).toBe('ready');
    expect(recovered.hydrated).toBe(true);
    expect(xdb.getAll('tasks').map((r) => r.data.title)).toEqual(expect.arrayContaining(['Unknown to the cache', 'new while degraded']));
    xdb.clear('tasks');
    await xdb.whenIdle();
    errors.mockRestore();
  });

  it('marks the whole store failed when the collection list cannot be read', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const original = invokeMock.getMockImplementation();
    invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'get_collections') throw new Error('database locked');
      return original(cmd, args);
    });
    const xdb = new XDBService(undefined, 'test-xdb');
    await xdb.isReady;
    expect(xdb.getStorageStatus().state).toBe('failed');
    expect(xdb.isHydrated()).toBe(false);
    expect(() => xdb.removeRecord('tasks', 'x')).toThrow(/has not been loaded/);
    errors.mockRestore();
  });

  it('createAsync uses Tauri backend and updates cache', async () => {
    const xdb = new XDBService(undefined, 'test-xdb');
    await flushPromises();

    const record = await xdb.createAsync('tasks', { title: 'Created' });
    expect(record.id).toBeDefined();
    expect(invokeMock).toHaveBeenCalledWith('create_record', {
      payload: { collection: 'tasks', data: { title: 'Created' } },
    });

    const records = xdb.getAll('tasks');
    expect(records).toHaveLength(1);
    expect(records[0].data.title).toBe('Created');
  });
});
