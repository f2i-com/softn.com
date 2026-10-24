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
      // As Tauri's IPC serialises a call's arguments (scripts/process-ipc-message-fn.js): an
      // object holding `__TAURI_TO_IPC_KEY__` has that value called, and the whole call fails.
      JSON.stringify(args ?? {}, (_key, value: unknown) =>
        typeof value === 'object' && value !== null && '__TAURI_TO_IPC_KEY__' in value
          ? (value as { __TAURI_TO_IPC_KEY__: () => unknown }).__TAURI_TO_IPC_KEY__()
          : value);
      if (refuse.has(cmd)) throw new Error('SQLITE_READONLY: attempt to write a readonly database');
      switch (cmd) {
        case 'get_collections':
          return Array.from(backend.keys());
        case 'get_collection': {
          const collection = String(args?.collection ?? '');
          // As XDB's command: live records alone (`deleted = 0`).
          return (backend.get(collection) ?? []).filter((r) => !r.deleted);
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
          const payload = args?.payload as { id: string; data: Record<string, unknown>; updated_at?: string };
          for (const [collection, records] of backend.entries()) {
            const index = records.findIndex((r) => r.id === payload.id);
            if (index !== -1) {
              const updated = {
                ...records[index],
                data: { ...records[index].data, ...payload.data },
                // As XDB's command: no earlier than the page's stamp for the edit.
                updated_at: payload.updated_at ?? new Date().toISOString(),
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
          // As XDB's command: a named collection is the only one deleted from.
          const named = args?.collection as string | undefined;
          for (const [collection, records] of backend.entries()) {
            if (named !== undefined && collection !== named) continue;
            const index = records.findIndex((r) => r.id === id);
            if (index !== -1) {
              records[index] = {
                ...records[index],
                deleted: true,
                updated_at: (args?.updatedAt as string | undefined) ?? new Date().toISOString(),
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
        case 'upsert_records': {
          const list = args?.records as XDBRecord[];
          for (const record of list) {
            const records = backend.get(record.collection) ?? [];
            const index = records.findIndex((r) => r.id === record.id);
            if (index !== -1) records[index] = record;
            else records.push(record);
            backend.set(record.collection, records);
          }
          return [];
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

  // One native call a record, and each rewrote the collection's whole stored
  // document: joining a room of a few thousand records cost gigabytes of writes.
  it('writes what a room brings in one native call', async () => {
    const xdb = new XDBService(undefined, 'test-xdb');
    await flushPromises();
    await flushPromises();
    const records = [1, 2, 3].map((n) => makeRecord(`p${n}`, 'notes', { n }));
    expect(xdb.writePeerRecords('notes', records)).toEqual([]);
    expect(xdb.getAll('notes')).toHaveLength(3);
    await flushPromises();
    const commands = invokeMock.mock.calls.map(([cmd]: [string]) => cmd);
    expect(commands.filter((cmd: string) => cmd === 'upsert_records')).toHaveLength(1);
    expect(commands).not.toContain('upsert_record');
    expect(backend.get('notes')).toHaveLength(3);
  });

  // The native store stamped an edit with its own clock, and its answer
  // replaced the record: the stamp the page chose, after a sync room's copy,
  // was lost, and the edit lost to the room's copy on every peer.
  it("sends the stamp it gave an edit and a deletion, after a room's copy too", async () => {
    backend.set('notes', [makeRecord('n1', 'notes', { text: 'a' })]);
    const xdb = new XDBService(undefined, 'test-xdb');
    await flushPromises();
    await flushPromises();
    const ahead = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    const stop = xdb.addStampSource((collection, id) => (collection === 'notes' && id === 'n1' ? ahead : undefined));
    try {
      xdb.update('n1', { text: 'b' });
      await flushPromises();
      const update = invokeMock.mock.calls.find(([cmd]: [string]) => cmd === 'update_record');
      expect(Date.parse(update[1].payload.updated_at)).toBe(Date.parse(ahead) + 1);
      expect(xdb.get('notes', 'n1')?.updated_at).toBe(update[1].payload.updated_at);

      xdb.delete('n1');
      await flushPromises();
      const remove = invokeMock.mock.calls.find(([cmd]: [string]) => cmd === 'delete_record');
      expect(Date.parse(remove[1].updatedAt)).toBeGreaterThan(Date.parse(update[1].payload.updated_at));
    } finally {
      stop();
    }
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

  it('keeps a record deleted in the same tick it was updated', async () => {
    backend.set('tasks', [makeRecord('doomed', 'tasks', { title: 'A' })]);
    const xdb = new XDBService(undefined, 'update-then-delete', 'update-then-delete-app');
    await xdb.isReady;
    // SQLite's answer to the update is stamped no earlier than the tombstone:
    // the same millisecond here, as it is in a quick tick.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      xdb.update('doomed', { title: 'B' });
      expect(xdb.delete('doomed')).toBe(true);
      await flushPromises();
      await flushPromises();
      expect(xdb.get('tasks', 'doomed')).toBeNull();
      expect(xdb.getAll('tasks')).toEqual([]);
      expect(backend.get('tasks')![0].deleted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
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

  it('notifies server sync of a hard delete, but not of one whose create it never announced', async () => {
    backend.set('tasks', [makeRecord('stored', 'tasks', { title: 'A' })]);
    const xdb = new XDBService(undefined, 'hard-delete-sync', 'hard-delete-sync-app');
    await xdb.isReady;
    const onMutation = vi.fn();
    const unsubscribe = xdb.onMutation(onMutation);
    try {
      expect(xdb.hardDelete('tasks', 'stored')).toBe(true);
      const pending = xdb.create('tasks', { title: 'never stored' });
      expect(xdb.hardDelete('tasks', pending.id)).toBe(true);
      await flushPromises();
      await flushPromises();
      expect(onMutation.mock.calls.map(([event]) => [event.type, event.recordId])).toEqual([['delete', 'stored']]);
    } finally {
      unsubscribe();
    }
  });

  /**
   * `delete(id)` announced the delete when the cache took it and again when
   * SQLite answered: every listener heard of each delete twice. And `clear`
   * told server sync nothing, so the next pull brought every record back.
   */
  it('announces a delete once, and tells server sync of each record a clear removes', async () => {
    backend.set('tasks', [makeRecord('t1', 'tasks', { title: 'A' }), makeRecord('t2', 'tasks', { title: 'B' })]);
    const xdb = new XDBService(undefined, 'delete-once', 'delete-once-app');
    await xdb.isReady;
    const events: string[] = [];
    const mutations: string[] = [];
    xdb.subscribe('tasks', (event) => events.push(`${event.type}:${event.record?.id ?? ''}`));
    const unsubscribe = xdb.onMutation((event) => mutations.push(`${event.type}:${event.recordId}`));
    try {
      expect(xdb.delete('t1')).toBe(true);
      await flushPromises();
      await flushPromises();
      expect(events).toEqual(['delete:t1']);
      expect(mutations).toEqual(['delete:t1']);

      xdb.clear('tasks');
      await flushPromises();
      expect(mutations).toEqual(['delete:t1', 'delete:t2']);
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

  it('removes a record a peer or the server names from that collection only', async () => {
    // SQLite keys records by id alone: a removal heard in one collection,
    // sent by id, reached the record of another collection that has the id.
    backend.set('private', [makeRecord('shared-id', 'private', { secret: 'kept' })]);
    backend.set('public', [makeRecord('mine', 'public', { title: 'Mine' })]);
    const xdb = new XDBService(undefined, 'remove-by-collection');
    await xdb.isReady;
    xdb.removeRecord('public', 'shared-id');
    xdb.deleteFromServer('public', 'shared-id');
    xdb.removeRecord('public', 'mine');
    await flushPromises();
    expect(backend.get('private')![0].deleted).toBe(false);
    expect(xdb.getAll('private').map((r) => r.id)).toEqual(['shared-id']);
    expect(backend.get('public')![0].deleted).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith('delete_record', expect.objectContaining({ id: 'shared-id', collection: 'public' }));
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

  // The native store refuses an import holding a record of another collection,
  // but answered after the cache had changed and peer sync had carried the
  // import into the room, which kept it.
  it('refuses, before changing anything, an import holding a record of another collection', async () => {
    backend.set('private', [makeRecord('shared-id', 'private', { secret: 1 })]);
    const xdb = new XDBService(undefined, 'test-xdb');
    await xdb.isReady;
    const heard: string[] = [];
    xdb.subscribeAll((event) => heard.push(`${event.type}:${event.collection}`));
    invokeMock.mockClear();
    const planted = makeRecord('shared-id', 'public', { planted: true });
    expect(() => xdb.import({ version: 1, exportedAt: '', collections: { public: [makeRecord('fine', 'public', {}), planted] } })).toThrow(/record of "private"/);
    expect(invokeMock).not.toHaveBeenCalledWith('import_records', expect.anything());
    expect(heard).toEqual([]);
    expect(xdb.getAll('public')).toEqual([]);
    expect(xdb.get('private', 'shared-id')?.data).toEqual({ secret: 1 });
  });

  // What the native store refuses of an import was refused after the cache
  // had changed and sync had been told: refused here first, by the native
  // rules. A record another collection deleted in an earlier session is not
  // in the cache, and the native store writes over it (db.rs).
  it('refuses up front what the native store would, and takes a record another collection deleted', async () => {
    backend.set('private', [makeRecord('gone-id', 'private', { old: true }, { deleted: true })]);
    backend.set('public', [makeRecord('keep1', 'public', {}), makeRecord('keep2', 'public', {})]);
    const xdb = new XDBService(undefined, 'test-xdb');
    await xdb.isReady;
    const heard: string[] = [];
    xdb.subscribeAll((event) => heard.push(`${event.type}:${event.collection}`));
    invokeMock.mockClear();
    for (const bad of [
      { ...makeRecord('named-private', 'public', {}), collection: 'private' },
      makeRecord('   ', 'public', {}),
      { id: 'half', collection: 'public', data: {} } as unknown as XDBRecord,
    ]) {
      expect(() => xdb.import({ version: 1, exportedAt: '', collections: { public: [bad] } }, { merge: false })).toThrow(/Import refused/);
    }
    expect(invokeMock).not.toHaveBeenCalledWith('import_records', expect.anything());
    expect(heard).toEqual([]);
    expect(xdb.getAll('public').map((r) => r.id).sort()).toEqual(['keep1', 'keep2']);

    const { persisted } = xdb.import({ version: 1, exportedAt: '', collections: { public: [makeRecord('gone-id', 'public', { imported: true })] } });
    await persisted;
    expect(invokeMock).toHaveBeenCalledWith('import_records', expect.anything());
    expect(xdb.get('public', 'gone-id')?.data).toEqual({ imported: true });
  });

  // What the up-front check missed, and the native store then refused after
  // sync had been told: a record of a collection that never loaded, an id of
  // U+0085 (white space to Rust's trim, not to JS's), and half of a surrogate
  // pair, which serde_json will not read.
  it('refuses up front an import the cache cannot vouch for, or the native store cannot read', async () => {
    backend.set('private', [makeRecord('shared-id', 'private', { secret: 1 })]);
    backend.set('public', [makeRecord('keep1', 'public', {})]);
    const answer = invokeMock.getMockImplementation()!;
    let privateLoads = false;
    invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'get_collection' && args?.collection === 'private' && !privateLoads) throw new Error('database is locked');
      return answer(cmd, args);
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const xdb = new XDBService(undefined, 'test-xdb');
    await xdb.isReady;
    const heard: string[] = [];
    xdb.subscribeAll((event) => heard.push(`${event.type}:${event.collection}`));
    const told: string[] = [];
    xdb.onMutation((event) => told.push(`${event.type}:${event.collection}`));

    const imports = [
      { public: [makeRecord('shared-id', 'public', { planted: true })] },
      { public: [makeRecord('\u0085', 'public', {})] },
      { public: [makeRecord('cut', 'public', { text: 'half an emoji \ud83d' })] },
    ];
    expect(() => xdb.import({ version: 1, exportedAt: '', collections: imports[0] }, { merge: false })).toThrow(/not finished loading/);
    expect(heard).toEqual([]);
    privateLoads = true;
    await xdb.retryHydration();
    // The reload's own refresh, not the import's.
    heard.length = 0;
    for (const collections of imports.slice(1)) {
      expect(() => xdb.import({ version: 1, exportedAt: '', collections }, { merge: false })).toThrow(/Import refused/);
    }
    expect(invokeMock).not.toHaveBeenCalledWith('import_records', expect.anything());
    expect(told).toEqual([]);
    expect(heard.filter((event) => event.endsWith(':public'))).toEqual([]);
    expect(xdb.getAll('public').map((r) => r.id)).toEqual(['keep1']);
    // A whole emoji is text like any other.
    xdb.import({ version: 1, exportedAt: '', collections: { public: [makeRecord('whole', 'public', { text: 'a whole emoji 😀' })] } });
    expect(invokeMock).toHaveBeenCalledWith('import_records', expect.anything());
    errors.mockRestore();
  });

  // More of what the check let through: a collection still loading (only a
  // failed one was refused), an id the cache holds live in two collections
  // (a peer's record the native store refused stays in the cache), a
  // collection named with half a surrogate pair, `data` JSON leaves out, a BigInt.
  it('refuses up front while loading, and what else the native store cannot take', async () => {
    backend.set('private', [makeRecord('shared-id', 'private', { secret: 1 })]);
    backend.set('public', [makeRecord('keep', 'public', {})]);
    const answer = invokeMock.getMockImplementation()!;
    let loaded!: () => void;
    const slow = new Promise<void>((resolve) => { loaded = resolve; });
    invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'get_collection' && args?.collection === 'private') await slow;
      return answer(cmd, args);
    });
    const xdb = new XDBService(undefined, 'test-xdb');
    await flushPromises();
    const told: string[] = [];
    xdb.onMutation((event) => told.push(`${event.type}:${event.collection}`));
    expect(() => xdb.import({ version: 1, exportedAt: '', collections: { public: [makeRecord('shared-id', 'public', {})] } }, { merge: false }))
      .toThrow(/not finished loading/);
    loaded();
    await xdb.isReady;

    // A peer's `shared-id` in `public`, which the native store would refuse, sits in the cache beside `private`'s.
    xdb.writePeerRecords('public', [makeRecord('shared-id', 'public', { from: 'a peer' }), makeRecord('other', 'public', {})]);
    told.length = 0;
    invokeMock.mockClear();
    const imports: Array<Record<string, XDBRecord[]>> = [
      { public: [makeRecord('shared-id', 'public', { mine: true })] },
      { public: [makeRecord('n', 'public', {})], '\ud800': [] },
      { public: [{ ...makeRecord('u', 'public', {}), data: undefined } as unknown as XDBRecord] },
      { public: [makeRecord('big', 'public', { n: BigInt(1) })] },
      // Tauri's IPC calls this key's value as a function on any object it sends.
      { public: [makeRecord('k', 'public', { words: { __TAURI_TO_IPC_KEY__: 'a word a person typed' } })] },
    ];
    for (const collections of imports) {
      expect(() => xdb.import({ version: 1, exportedAt: '', collections })).toThrow(/Import refused/);
    }
    expect(invokeMock).not.toHaveBeenCalledWith('import_records', expect.anything());
    expect(told).toEqual([]);
  });

  const storageStub = () => {
    const kept = new Map<string, string>();
    return {
      getItem: (key: string) => kept.get(key) ?? null,
      setItem: (key: string, value: string) => { kept.set(key, value); },
      removeItem: (key: string) => { kept.delete(key); },
    };
  };

  // A field Tauri's IPC reads as its own failed every desktop write of the
  // record after the cache and sync had taken it.
  it('refuses a record holding the key the IPC reserves, as every store does', async () => {
    const xdb = new XDBService(undefined, 'test-xdb');
    await xdb.isReady;
    invokeMock.mockClear();
    expect(() => xdb.create('words', { __TAURI_TO_IPC_KEY__: 'a word' })).toThrow(/IPC/);
    expect(() => xdb.create('words', { list: [{ __TAURI_TO_IPC_KEY__: 1 }] })).toThrow(/IPC/);
    expect(invokeMock).not.toHaveBeenCalledWith('create_record', expect.anything());
    const browser = new XDBService(storageStub(), 'browser-xdb', undefined, { backend: 'storage' });
    expect(() => browser.create('words', { __TAURI_TO_IPC_KEY__: 'a word' })).toThrow(/IPC/);
  });

  // A collection that failed to load and is then cleared away kept the store
  // unloaded through every retry, and every import refused.
  it('counts as loaded once a collection that failed is no longer there', async () => {
    backend.set('gone', [makeRecord('g', 'gone', {})]);
    backend.set('kept', [makeRecord('k', 'kept', {})]);
    const answer = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'get_collection' && args?.collection === 'gone') throw new Error('unreadable');
      return answer(cmd, args);
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const xdb = new XDBService(undefined, 'test-xdb');
    await xdb.isReady;
    expect(xdb.isHydrated()).toBe(false);
    backend.delete('gone');
    await xdb.retryHydration();
    expect(xdb.isHydrated()).toBe(true);
    errors.mockRestore();
  });

  // After the native store refused an import, the cache was reloaded over
  // the import: the merge kept what the import had deleted and what it had
  // stamped newer, neither of which the native store held.
  it('puts the cache back as it was when the native store refuses an import', async () => {
    backend.set('tasks', [makeRecord('a', 'tasks', { title: 'A' }), makeRecord('b', 'tasks', { title: 'B' })]);
    const xdb = new XDBService(undefined, 'test-xdb');
    await xdb.isReady;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    failNextImport = true;
    const later = new Date(Date.now() + 60_000).toISOString();
    const { persisted } = xdb.import({
      version: 1,
      exportedAt: '',
      collections: { tasks: [makeRecord('a', 'tasks', { title: 'A' }, { deleted: true, updated_at: later }), makeRecord('b', 'tasks', { title: 'B, imported' }, { updated_at: later })] },
    });
    await expect(persisted).rejects.toThrow(/SQLITE_FULL/);
    expect(xdb.get('tasks', 'a')?.data).toEqual({ title: 'A' });
    expect(xdb.get('tasks', 'b')?.data).toEqual({ title: 'B' });
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
        // The store never announced a create for it, and server sync hears nothing: the host
        // never had it (told a delete of the optimistic id, it refused it as not found).
        expect(events.filter((e) => e.startsWith('create:'))).toEqual([]);
        expect(onMutation).not.toHaveBeenCalled();
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

  // A record a peer or the sync host brings, holding the key Tauri's IPC takes for its own,
  // failed the native write it was in: one peer's record kept every record of its batch out of
  // SQLite (each was in the cache alone, gone at the next start), and the store said writes failed.
  describe("a record the native store cannot take, from a room or the host", () => {
    const bad = () => makeRecord('bad', 'notes', { text: { __TAURI_TO_IPC_KEY__: 'x' } });

    it('is passed over by a peer write, and the rest of the batch is stored', async () => {
      const xdb = new XDBService(undefined, 'peer-ipc', 'peer-ipc-app');
      await xdb.isReady;
      const passed = xdb.writePeerRecords('notes', [makeRecord('a', 'notes', { text: 'a' }), bad(), makeRecord('b', 'notes', { text: 'b' })]);
      expect(passed.map((record) => record.id)).toEqual(['bad']);
      await flushPromises();
      expect((backend.get('notes') ?? []).map((record) => record.id).sort()).toEqual(['a', 'b']);
      expect(xdb.getAll('notes').map((record) => record.id).sort()).toEqual(['a', 'b']);
      expect(xdb.getStorageStatus().issues).toEqual([]);
    });

    it('is not taken from the sync host', async () => {
      const xdb = new XDBService(undefined, 'server-ipc', 'server-ipc-app');
      await xdb.isReady;
      const record = bad();
      xdb.upsertFromServer('notes', { id: record.id, collection: 'notes', data: record.data, createdAt: record.created_at, updatedAt: record.updated_at });
      await flushPromises();
      expect(xdb.get('notes', 'bad')).toBeNull();
      expect(xdb.getStorageStatus().issues).toEqual([]);
    });
  });

  // An edit or a deletion of a record whose create was still with SQLite was told to server
  // sync under the optimistic id, which the host never hears of: it refused the change as not
  // found, and the person was told a change was not taken. The create's own answer tells the
  // record as it is by then, edits and all, under its stored id; one deleted first, not at all.
  describe('a record whose create is still with SQLite', () => {
    it('is told to server sync once, as it is when the create lands', async () => {
      const xdb = new XDBService(undefined, 'pending-sync', 'pending-sync-app');
      await xdb.isReady;
      const heard: Array<{ type: string; recordId: string; data?: Record<string, unknown> }> = [];
      xdb.onMutation((event) => heard.push({ type: event.type, recordId: event.recordId, data: event.data }));
      const kept = xdb.create('tasks', { title: 'draft' });
      xdb.update(kept.id, { title: 'edited' });
      xdb.updateInCollection('tasks', kept.id, { done: true });
      xdb.delete(xdb.create('tasks', { title: 'gone' }).id);
      xdb.deleteFromCollection('tasks', xdb.create('tasks', { title: 'gone too' }).id);
      expect(heard).toEqual([]);
      await flushPromises();
      await flushPromises();
      const stored = backend.get('tasks')!.find((r) => !r.deleted)!;
      expect(stored.data).toEqual({ title: 'edited', done: true });
      expect(heard).toEqual([{ type: 'create', recordId: stored.id, data: { title: 'edited', done: true } }]);
      // Edited once it has landed, it is told as any edit is.
      xdb.update(kept.id, { title: 'later' });
      expect(heard.at(-1)).toEqual({ type: 'update', recordId: stored.id, data: { title: 'later', done: true } });
    });
  });
});
