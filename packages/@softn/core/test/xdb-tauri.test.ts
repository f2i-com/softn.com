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
  /** Commands the backend refuses, for the write-failure cases. */
  let refuse: Set<string>;

  beforeEach(() => {
    backend = new Map();
    listeners = new Map();
    failNextImport = false;
    refuse = new Set();
    invokeMock = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
      if (refuse.has(cmd)) throw new Error('SQLITE_READONLY: attempt to write a readonly database');
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

  /**
   * The synchronous API answers before SQLite does (core audit 2.4). When
   * SQLite then refuses, the caller already has its optimistic answer; the
   * disagreement is reported through the storage status the host watches,
   * and server sync is told about a create only once it has really landed.
   */
  describe('a refused native write', () => {
    it('is reported in the storage status and cleared by the next acknowledged write', async () => {
      const xdb = new XDBService(undefined, 'refused-create', 'refused-create-app');
      await xdb.isReady;
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      const onMutation = vi.fn();
      const unsubscribe = xdb.onMutation(onMutation);
      try {
        refuse.add('create_record');
        const optimistic = xdb.create('tasks', { title: 'lost' });
        expect(optimistic.id).toBeTruthy();
        await flushPromises();
        const status = xdb.getStorageStatus();
        expect(status.state).toBe('degraded');
        expect(status.issues).toEqual([expect.objectContaining({ kind: 'write-failed', collection: 'tasks' })]);
        expect(status.issues[0].message).toMatch(/could not be saved/);
        // Rolled back locally, and never announced to server sync.
        expect(xdb.getAll('tasks')).toEqual([]);
        expect(onMutation).not.toHaveBeenCalled();

        refuse.delete('create_record');
        const record = xdb.create('tasks', { title: 'kept' });
        await flushPromises();
        expect(xdb.getStorageStatus().state).toBe('ready');
        expect(xdb.getStorageStatus().issues).toEqual([]);
        // Announced once, under the id SQLite gave it, not the optimistic one.
        expect(onMutation).toHaveBeenCalledTimes(1);
        const announced = onMutation.mock.calls[0][0];
        expect(announced.type).toBe('create');
        expect(announced.recordId).toBe(backend.get('tasks')![0].id);
        expect(announced.recordId).not.toBe(record.id);
      } finally {
        unsubscribe();
        errors.mockRestore();
      }
    });

    it('is a failure for an update or delete of a record that exists, and not for one still being created', async () => {
      backend.set('tasks', [makeRecord('stored', 'tasks', { title: 'before' })]);
      const xdb = new XDBService(undefined, 'refused-update', 'refused-update-app');
      await xdb.isReady;
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        // An update racing its own create is refused by SQLite ("Record not
        // found": the optimistic id is not there yet); the create callback
        // re-sends the merged data. Not a failure of the store.
        const pending = xdb.create('tasks', { title: 'new' });
        xdb.update(pending.id, { title: 'newer' });
        await flushPromises();
        await flushPromises();
        expect(xdb.getStorageStatus().issues.filter(i => i.kind === 'write-failed')).toEqual([]);

        refuse.add('update_record');
        expect(xdb.update('stored', { title: 'after' })?.data.title).toBe('after');
        await flushPromises();
        expect(xdb.getStorageStatus().issues).toEqual([expect.objectContaining({ kind: 'write-failed', collection: 'tasks' })]);

        refuse.delete('update_record');
        refuse.add('delete_record');
        xdb.update('stored', { title: 'again' });
        await flushPromises();
        expect(xdb.getStorageStatus().issues).toEqual([]);
        expect(xdb.delete('stored')).toBe(true);
        await flushPromises();
        expect(xdb.getStorageStatus().issues).toEqual([expect.objectContaining({ kind: 'write-failed', collection: 'tasks' })]);
        // A delete of something that never existed is not a failure of the store.
        xdb.delete('never-existed');
        await flushPromises();
        expect(xdb.getStorageStatus().issues).toHaveLength(1);
      } finally {
        errors.mockRestore();
      }
    });

    it('covers clear, hard delete and raw writes', async () => {
      backend.set('tasks', [makeRecord('one', 'tasks', { title: 'A' }), makeRecord('two', 'tasks', { title: 'B' })]);
      const xdb = new XDBService(undefined, 'refused-clear', 'refused-clear-app');
      await xdb.isReady;
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        refuse.add('delete_record');
        expect(xdb.hardDelete('tasks', 'one')).toBe(true);
        await flushPromises();
        expect(xdb.getStorageStatus().issues).toEqual([expect.objectContaining({ kind: 'write-failed', collection: 'tasks' })]);
        refuse.delete('delete_record');
        refuse.add('clear_collection');
        xdb.clear('tasks');
        await flushPromises();
        expect(xdb.getStorageStatus().issues).toEqual([expect.objectContaining({ kind: 'write-failed', collection: 'tasks' })]);
        refuse.delete('clear_collection');
        xdb.writeRecord('tasks', makeRecord('three', 'tasks', { title: 'C' }));
        await flushPromises();
        expect(xdb.getStorageStatus().state).toBe('ready');
      } finally {
        errors.mockRestore();
      }
    });
  });

  describe('writes that race their own create', () => {
    it('applies a delete issued while the create is in flight after it lands, and never brings the record back', async () => {
      const xdb = new XDBService(undefined, 'racing-delete', 'racing-delete-app');
      await xdb.isReady;
      const events: string[] = [];
      xdb.subscribe('tasks', (e) => events.push(`${e.type}:${e.record?.id ?? ''}`));
      const onMutation = vi.fn();
      const unsubscribe = xdb.onMutation(onMutation);
      try {
        const pending = xdb.create('tasks', { title: 'short-lived' });
        expect(xdb.delete(pending.id)).toBe(true);
        // Only the create reached SQLite so far; the delete waits for it.
        expect(invokeMock.mock.calls.map((c: unknown[]) => c[0])).not.toContain('delete_record');
        await flushPromises();
        await flushPromises();
        const stored = backend.get('tasks')!;
        expect(stored).toHaveLength(1);
        expect(stored[0].deleted).toBe(true);
        expect(xdb.getAll('tasks')).toEqual([]);
        expect(xdb.get('tasks', pending.id)).toBeNull();
        expect(xdb.get('tasks', stored[0].id)).toBeNull();
        expect(xdb.getStorageStatus().issues).toEqual([]);
        // The store never announced a create for it.
        expect(events.filter((e) => e.startsWith('create:'))).toEqual([]);
        expect(onMutation.mock.calls.map((c) => c[0].type)).toEqual(['delete']);
      } finally {
        unsubscribe();
      }
    });

    it('keeps a hard delete of a record still being created', async () => {
      const xdb = new XDBService(undefined, 'racing-hard-delete', 'racing-hard-delete-app');
      await xdb.isReady;
      const pending = xdb.create('tasks', { title: 'gone' });
      expect(xdb.hardDelete('tasks', pending.id)).toBe(true);
      await flushPromises();
      await flushPromises();
      expect(backend.get('tasks')![0].deleted).toBe(true);
      expect(xdb.getAll('tasks')).toEqual([]);
      expect(xdb.getAllRaw('tasks')).toEqual([]);
      expect(xdb.getStorageStatus().issues).toEqual([]);
    });

    it('applies an update and then a delete in order', async () => {
      const xdb = new XDBService(undefined, 'racing-both', 'racing-both-app');
      await xdb.isReady;
      const pending = xdb.create('tasks', { title: 'draft' });
      xdb.update(pending.id, { title: 'edited' });
      xdb.deleteFromCollection('tasks', pending.id);
      await flushPromises();
      await flushPromises();
      const commands = invokeMock.mock.calls.map((c: unknown[]) => c[0]);
      // Nothing was sent that could only fail: the row is created, then deleted.
      expect(commands.filter((c: string) => c === 'update_record')).toEqual([]);
      expect(commands.filter((c: string) => c === 'delete_record')).toHaveLength(1);
      expect(backend.get('tasks')![0].deleted).toBe(true);
      expect(xdb.getAll('tasks')).toEqual([]);
      expect(xdb.getStorageStatus().issues).toEqual([]);
    });

    it('still re-sends an update made while the create was in flight, under the stored id', async () => {
      const xdb = new XDBService(undefined, 'racing-update', 'racing-update-app');
      await xdb.isReady;
      const pending = xdb.create('tasks', { title: 'draft' });
      xdb.update(pending.id, { title: 'edited' });
      await flushPromises();
      await flushPromises();
      const stored = backend.get('tasks')!;
      expect(stored).toHaveLength(1);
      expect(stored[0].deleted).toBe(false);
      expect(stored[0].data.title).toBe('edited');
      expect(xdb.get('tasks', stored[0].id)?.data.title).toBe('edited');
    });

    it('uses a caller-chosen id as the optimistic id and maps it to the stored one', async () => {
      const xdb = new XDBService(undefined, 'chosen-id', 'chosen-id-app');
      await xdb.isReady;
      const record = xdb.create('tasks', { title: 'mine' }, { id: 'worker-chosen' });
      expect(record.id).toBe('worker-chosen');
      await flushPromises();
      const stored = backend.get('tasks')![0];
      expect(stored.id).not.toBe('worker-chosen');
      // The old id keeps resolving, as any optimistic id does.
      expect(xdb.get('tasks', 'worker-chosen')?.id).toBe(stored.id);
      xdb.update('worker-chosen', { title: 'renamed' });
      await flushPromises();
      expect(backend.get('tasks')![0].data.title).toBe('renamed');
      // An id already in use is not reused.
      const again = xdb.create('tasks', { title: 'other' }, { id: stored.id });
      expect(again.id).not.toBe(stored.id);
    });
  });
});
