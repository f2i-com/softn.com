/**
 * R2-SN-01 / R2-SN-02: a restore is decided before anything is mutated; a
 * browser replacement never deletes the old value before the new one is
 * written; replacement intent means the same thing on every backend.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { XDBService, XDBStorageError } from '../src/runtime/xdb';

type Rec = { id: string; collection: string; data: Record<string, unknown>; created_at: string; updated_at: string; deleted: boolean };
const rec = (id: string, collection: string, title: string): Rec => ({ id, collection, data: { title }, created_at: 't', updated_at: 't', deleted: false });
const ids = (xdb: XDBService, collection: string) => xdb.getAll(collection).map(r => r.id).sort();

function storageWith(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  const failing = new Set<string>();
  return {
    store,
    failWritesTo: (key: string) => failing.add(key),
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { if (failing.has(key)) throw new DOMException('QuotaExceededError', 'QuotaExceededError'); store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
  };
}

describe('restore ordering (browser backend)', () => {
  it('rejects a partial restore BEFORE changing cache or storage', async () => {
    const storage = storageWith({ 'xdb:notes': JSON.stringify([rec('n1', 'notes', 'original')]) });
    const xdb = new XDBService(storage, 'xdb');
    const before = new Map(storage.store);
    await expect(xdb.restoreAsync({ version: 1, exportedAt: '', collections: { notes: [rec('n2', 'notes', 'replacement'), { broken: true } as unknown as Rec] } }))
      .rejects.toThrow(/nothing was changed/);
    expect(ids(xdb, 'notes')).toEqual(['n1']);
    expect(storage.store).toEqual(before);

    // Explicit acceptance is intentional and durable.
    const accepted = await xdb.restoreAsync({ version: 1, exportedAt: '', collections: { notes: [rec('n2', 'notes', 'replacement'), { broken: true } as unknown as Rec] } }, { acceptPartial: true });
    expect(accepted.skipped).toBe(1);
    expect(accepted.persisted.imported).toBe(1);
    expect(ids(xdb, 'notes')).toEqual(['n2']);
    expect(JSON.parse(storage.store.get('xdb:notes')!).map((r: Rec) => r.id)).toEqual(['n2']);
  });

  it('refuses the whole import when a LATER collection fails its preflight, touching nothing', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const storage = storageWith({ 'xdb:notes': JSON.stringify([rec('n1', 'notes', 'kept')]), 'xdb:tasks': 'garbage' });
    const xdb = new XDBService(storage, 'xdb');
    expect(() => xdb.import({ version: 1, exportedAt: '', collections: { notes: [rec('n2', 'notes', 'new')], tasks: [rec('t1', 'tasks', 'x')] } }, { merge: false }))
      .toThrow(XDBStorageError);
    expect(ids(xdb, 'notes')).toEqual(['n1']);
    expect(storage.store.get('xdb:notes')).toBe(JSON.stringify([rec('n1', 'notes', 'kept')]));
    vi.restoreAllMocks();
  });

  it('keeps the previous value when the replacement write fails (no eager clear)', () => {
    const storage = storageWith({ 'xdb:notes': JSON.stringify([rec('n1', 'notes', 'survivor')]) });
    storage.failWritesTo('xdb:notes');
    const xdb = new XDBService(storage, 'xdb');
    let error: unknown;
    try { xdb.import({ version: 1, exportedAt: '', collections: { notes: [rec('n2', 'notes', 'never lands')] } }, { clearFirst: true }); }
    catch (e) { error = e; }
    expect(error).toBeInstanceOf(XDBStorageError);
    expect(String((error as Error).message)).toMatch(/previous contents are unchanged/);
    expect(storage.store.get('xdb:notes')).toBe(JSON.stringify([rec('n1', 'notes', 'survivor')]));
    expect(ids(xdb, 'notes')).toEqual(['n1']);
  });

  it('restores earlier collections when a later browser write fails, and says which', () => {
    const storage = storageWith({ 'xdb:notes': JSON.stringify([rec('n1', 'notes', 'old')]) });
    storage.failWritesTo('xdb:tasks');
    const xdb = new XDBService(storage, 'xdb');
    let error: unknown;
    try {
      xdb.import({ version: 1, exportedAt: '', collections: { notes: [rec('n2', 'notes', 'new')], tasks: [rec('t1', 'tasks', 'x')] } }, { merge: false });
    } catch (e) { error = e; }
    expect(String((error as Error).message)).toMatch(/stopped at "tasks"/);
    expect(String((error as Error).message)).toMatch(/restored to their previous contents: notes/);
    expect(storage.store.get('xdb:notes')).toBe(JSON.stringify([rec('n1', 'notes', 'old')]));
    expect(storage.store.has('xdb:tasks')).toBe(false);
    expect(ids(xdb, 'notes')).toEqual(['n1']);
  });

  it('clearFirst without merge replaces on the browser backend', () => {
    const storage = storageWith({ 'xdb:notes': JSON.stringify([rec('a', 'notes', 'A')]) });
    const xdb = new XDBService(storage, 'xdb');
    xdb.import({ version: 1, exportedAt: '', collections: { notes: [rec('b', 'notes', 'B')] } }, { clearFirst: true });
    expect(ids(xdb, 'notes')).toEqual(['b']);
  });
});

describe('restore ordering (native backend)', () => {
  let backend: Map<string, Rec[]>;
  let invoke: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    backend = new Map();
    invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
      switch (cmd) {
        case 'get_collections': return [...backend.keys()];
        case 'get_collection': return backend.get(String(args?.collection)) ?? [];
        case 'import_records': {
          const batches = args?.batches as Array<{ collection: string; replace: boolean; records: Rec[] }>;
          for (const b of batches) backend.set(b.collection, b.replace ? [...b.records] : [...(backend.get(b.collection) ?? []).filter(r => !b.records.some(x => x.id === r.id)), ...b.records]);
          return { imported: batches.reduce((n, b) => n + b.records.length, 0), tombstoned: 0, collections: batches.map(b => ({ collection: b.collection, replaced: b.replace, imported: b.records.length, tombstoned: 0, epoch: 0 })) };
        }
        default: throw new Error(`Unexpected command: ${cmd}`);
      }
    });
    Object.assign(window, { __TAURI__: { core: { invoke }, event: { listen: vi.fn(async () => () => {}) } } });
  });
  afterEach(() => { delete (window as unknown as Record<string, unknown>).__TAURI__; vi.restoreAllMocks(); });

  it('sends no native batch and leaves the cache unchanged when the restore is refused', async () => {
    backend.set('notes', [rec('n1', 'notes', 'original')]);
    const xdb = new XDBService(undefined, 'test-xdb');
    await xdb.isReady;
    invoke.mockClear();
    await expect(xdb.restoreAsync({ version: 1, exportedAt: '', collections: { notes: [rec('n2', 'notes', 'x')], bad: 'not a list' as unknown as Rec[] } }))
      .rejects.toThrow(/nothing was changed/);
    expect(invoke).not.toHaveBeenCalledWith('import_records', expect.anything());
    expect(ids(xdb, 'notes')).toEqual(['n1']);
    expect(backend.get('notes')!.map(r => r.id)).toEqual(['n1']);
  });

  it('clearFirst without merge replaces on the native backend too (parity with the browser)', async () => {
    backend.set('notes', [rec('a', 'notes', 'A')]);
    const xdb = new XDBService(undefined, 'test-xdb');
    await xdb.isReady;
    const { persisted } = await xdb.importAsync({ version: 1, exportedAt: '', collections: { notes: [rec('b', 'notes', 'B')] } }, { clearFirst: true });
    expect(persisted.backend).toBe('native');
    expect(ids(xdb, 'notes')).toEqual(['b']);
    expect(backend.get('notes')!.map(r => r.id)).toEqual(['b']);
    expect(invoke).toHaveBeenCalledWith('import_records', { batches: [{ collection: 'notes', replace: true, records: [rec('b', 'notes', 'B')] }] });
  });

  it('a later collection failing preflight sends no batch and changes no earlier collection', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    backend.set('notes', [rec('n1', 'notes', 'kept')]);
    const original = invoke.getMockImplementation() as (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
    invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'get_collection' && args?.collection === 'tasks') throw new Error('IPC failure');
      return original(cmd, args);
    });
    backend.set('tasks', [rec('t0', 'tasks', 'unhydrated')]);
    const xdb = new XDBService(undefined, 'test-xdb');
    await xdb.isReady;
    expect(xdb.isHydrated('tasks')).toBe(false);
    invoke.mockClear();
    expect(() => xdb.import({ version: 1, exportedAt: '', collections: { notes: [rec('n2', 'notes', 'new')], tasks: [] } }, { merge: false }))
      .toThrow(/has not been loaded/);
    expect(invoke).not.toHaveBeenCalledWith('import_records', expect.anything());
    expect(ids(xdb, 'notes')).toEqual(['n1']);
  });
});
