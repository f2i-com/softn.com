import { afterEach, describe, expect, it, vi } from 'vitest';
import { XDBService, type XDBExportData, type XDBStorage, type StoragePersistenceStatus, type StorageWriteReceipt, type StorageWriteState } from '../src/runtime/xdb';
import { installAppStorage } from '../../../../apps/formlogic-host/src/storage';
import { createBackendQueue, type BackendCallMessage } from '../../../../apps/formlogic-host/src/backendQueue';

const row = (id: string, collection = 'notes') => ({ id, collection, data: { title: id }, created_at: 't', updated_at: 't', deleted: false });
const backup = (collections: XDBExportData['collections']): XDBExportData => ({ version: 1, exportedAt: 't', collections });

/** Deferred parent persistence, deliberately distinct from the optimistic Storage cache. */
function hostedStorage(initial: Record<string, string> = {}) {
  const cache = new Map(Object.entries(initial));
  const parent = new Map(Object.entries(initial));
  const listeners = new Set<(status: StoragePersistenceStatus) => void>();
  let sequence = 0;
  let disposed = false;
  let admissionFailure = false;
  const operations: Array<{
    kind: 'set' | 'remove' | 'batch';
    replacements: readonly { key: string; value: string | null }[];
    receipt: StorageWriteReceipt;
    confirm(): void;
    fail(unknown?: boolean): void;
    lateConfirm(): void;
  }> = [];
  const status = (): StoragePersistenceStatus => ({
    protocol: 1, disposed,
    pendingWrites: operations.filter(op => op.receipt.state === 'pending').length,
    failedWrites: operations.filter(op => op.receipt.state === 'failed').length,
    unknownWrites: operations.filter(op => op.receipt.state === 'unknown').length,
  });
  const notify = () => { for (const listener of listeners) listener(status()); };
  const apply = (store: Map<string, string>, entries: readonly { key: string; value: string | null }[]) => {
    for (const { key, value } of entries) {
      if (value === null) store.delete(key);
      else store.set(key, value);
    }
  };
  const admit = (kind: 'set' | 'remove' | 'batch', replacements: readonly { key: string; value: string | null }[]) => {
    if (admissionFailure || disposed) throw new Error('Admission refused before cache mutation');
    // Exercise the existing actual-input units, particularly JSON escapes.
    if (JSON.stringify({ op: kind, replacements }).length > 32768) throw new Error('Serialized input is too large');
    const immutable = replacements.map(entry => Object.freeze({ ...entry }));
    let state: StorageWriteState = 'pending';
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const completion = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    const receipt: StorageWriteReceipt = Object.freeze({ generation: 'test-mount', sequence: ++sequence, completion, get state() { return state; } });
    apply(cache, immutable);
    const commit = () => { apply(parent, immutable); state = 'confirmed'; notify(); };
    operations.push({
      kind, replacements: immutable, receipt,
      confirm() { commit(); resolve(); },
      fail(unknown = false) {
        state = unknown ? 'unknown' : 'failed';
        notify();
        reject(Object.assign(new Error('Parent save was not acknowledged'), { state }));
      },
      lateConfirm() { commit(); },
    });
    notify();
    return receipt;
  };
  const acknowledgedPersistence = {
    protocol: 1 as const,
    setItem: (key: string, value: string) => admit('set', [{ key, value }]),
    removeItem: (key: string) => admit('remove', [{ key, value: null }]),
    replaceBatch: (replacements: readonly { key: string; value: string }[]) => admit('batch', replacements),
    getStatus: status,
    subscribe(listener: (status: StoragePersistenceStatus) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    whenIdle: async () => { await Promise.allSettled(operations.filter(op => op.receipt.state === 'pending').map(op => op.receipt.completion)); },
    captureBarrier: async () => { await Promise.all(operations.map(op => op.receipt.completion)); },
  };
  const storage: XDBStorage = {
    getItem: key => cache.get(key) ?? null,
    setItem: (key, value) => { acknowledgedPersistence.setItem(key, value).completion.catch(() => {}); },
    removeItem: key => { acknowledgedPersistence.removeItem(key).completion.catch(() => {}); },
    acknowledgedPersistence,
  };
  return { storage, cache, parent, operations, listeners, refuseAdmission: () => { admissionFailure = true; }, dispose: () => { disposed = true; notify(); } };
}

async function flush() { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }
function watched<T>(promise: Promise<T>) {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  return () => settled;
}
function warnsBeforeUnload() {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

describe('XDB acknowledged hosted persistence', () => {
  const services: XDBService[] = [];
  const service = (storage: XDBStorage) => { const xdb = new XDBService(storage); services.push(xdb); return xdb; };
  afterEach(() => { for (const xdb of services.splice(0)) xdb.destroy(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
  function realAdapterFixture() {
    const originalWindow = window;
    // installAppStorage owns its iframe's nonconfigurable localStorage property.
    // Use a separate surface so the jsdom test page keeps its ordinary storage.
    vi.stubGlobal('window', { addEventListener: originalWindow.addEventListener.bind(originalWindow), removeEventListener: originalWindow.removeEventListener.bind(originalWindow) });
    const posted: BackendCallMessage[] = [];
    const queue = createBackendQueue({ post: message => { posted.push(message); } });
    const adapter = installAppStorage({}, (input, lifecycle) => queue.call('nativeStorage', input, lifecycle), { acknowledged: true });
    const xdb = service(adapter.storage);
    return { queue, adapter, xdb, posted, close() { xdb.destroy(); adapter.dispose(); queue.dispose('test closed'); document.getElementById('app-storage-error')?.remove(); vi.unstubAllGlobals(); } };
  }

  it('integrates XDB with the real hosted adapter and queue: matched FIFO acknowledgments confirm one batch, not later writes', async () => {
    const f = realAdapterFixture();
    try {
      f.adapter.storage.setItem('session', 'synthetic-token');
      const pending = f.xdb.importAsync(backup({ notes: [row('n')], tasks: [row('t', 'tasks')] }));
      const settled = watched(pending);
      expect(f.posted.map(message => message.input.operation)).toEqual(['set']);
      expect(f.xdb.getStorageStatus().pendingWrites).toBe(2);
      expect(f.queue.settle(f.posted[0].id + 100, { result: { saved: true } })).toBe(false);
      await flush();
      expect(settled()).toBe(false);
      expect(f.adapter.confirmedSnapshot()).toEqual({});
      f.queue.settle(f.posted[0].id, { result: { saved: true } });
      expect(f.posted.map(message => message.input.operation)).toEqual(['set', 'batch']);
      expect(f.posted[1].input.replacements).toHaveLength(2);
      f.adapter.storage.setItem('later-session', 'not-part-of-import');
      f.queue.settle(f.posted[1].id, { result: { saved: true } });
      await expect(pending).resolves.toMatchObject({ persisted: { backend: 'storage', imported: 2, collections: ['notes', 'tasks'] } });
      expect(f.xdb.getStorageStatus().pendingWrites).toBe(1);
      expect(f.adapter.confirmedSnapshot()['later-session']).toBeUndefined();
      expect(JSON.parse(f.adapter.confirmedSnapshot()['xdb:notes'])[0].id).toBe('n');
      f.queue.settle(f.posted[2].id, { result: { saved: true } });
      await f.xdb.whenIdle();
    } finally { f.close(); }
  });

  it('integrates a real sent deadline and late matched reply without replaying or re-resolving the rejected async operation', async () => {
    vi.useFakeTimers();
    const f = realAdapterFixture();
    try {
      const pending = f.xdb.createAsync('notes', { title: 'uncertain' });
      const rejected = expect(pending).rejects.toThrow('unknown');
      vi.advanceTimersByTime(20000);
      await rejected;
      expect(f.queue.inFlight).toBe(1);
      expect(f.xdb.getStorageStatus().persistence!.unknownWrites).toBe(1);
      await expect(f.xdb.createAsync('notes', { title: 'refused while unknown' })).rejects.toThrow('unknown outcome');
      expect(f.posted).toHaveLength(1);
      expect(f.xdb.getAll('notes')).toHaveLength(1);
      f.queue.settle(f.posted[0].id, { result: { saved: true } });
      await flush();
      expect(f.queue.inFlight).toBe(0);
      expect(f.xdb.getStorageStatus().persistence!.unknownWrites).toBe(0);
      expect(f.xdb.getStorageStatus().issues.filter(issue => issue.kind === 'write-unknown')).toEqual([]);
      await expect(pending).rejects.toThrow('unknown');
      expect(f.posted).toHaveLength(1);
      expect(JSON.parse(f.adapter.confirmedSnapshot()['xdb:notes'])[0].data.title).toBe('uncertain');
    } finally { f.close(); vi.useRealTimers(); }
  });

  it('awaits create acknowledgment while preserving its optimistic synchronous result and unload warning', async () => {
    const host = hostedStorage();
    const xdb = service(host.storage);
    const pending = xdb.createAsync('notes', { title: 'session-like data' });
    const settled = watched(pending);
    await flush();
    expect(settled()).toBe(false);
    expect(xdb.getAll('notes')).toHaveLength(1);
    expect(host.parent.size).toBe(0);
    expect(xdb.getStorageStatus().pendingWrites).toBe(1);
    expect(xdb.hasPendingWrites()).toBe(true);
    expect(warnsBeforeUnload()).toBe(true);
    host.operations[0].confirm();
    const record = await pending;
    expect(JSON.parse(host.parent.get('xdb:notes')!)[0].id).toBe(record.id);
    expect(xdb.hasPendingWrites()).toBe(false);
    expect(warnsBeforeUnload()).toBe(false);
  });

  it('includes direct app Storage writes in pending status, finite idle settlement and unload signals', async () => {
    const host = hostedStorage();
    const xdb = service(host.storage);
    const statuses: number[] = [];
    xdb.subscribeStorage(status => { statuses.push(status.pendingWrites); });
    host.storage.setItem('session', 'synthetic-token');
    expect(xdb.hasPendingWrites()).toBe(true);
    expect(xdb.getStorageStatus().pendingWrites).toBe(1);
    expect(statuses).toContain(1);
    const idle = xdb.whenIdle();
    const settled = watched(idle);
    host.storage.setItem('later-session', 'later-value');
    await flush();
    expect(settled()).toBe(false);
    host.operations[0].fail();
    await idle;
    expect(xdb.hasPendingWrites()).toBe(true);
    expect(xdb.getStorageStatus().pendingWrites).toBe(1);
    host.operations[1].confirm();
    await xdb.whenIdle();
    expect(xdb.hasPendingWrites()).toBe(false);
    expect(warnsBeforeUnload()).toBe(true);
  });

  it('awaits only the exact update and delete write and rejects a refused parent mutation', async () => {
    const host = hostedStorage({ 'xdb:notes': JSON.stringify([row('n')]) });
    const xdb = service(host.storage);
    xdb.getAll('notes');
    const update = xdb.updateAsync('n', { title: 'edited' });
    const updated = watched(update);
    await flush();
    expect(updated()).toBe(false);
    expect(xdb.get('notes', 'n')!.data.title).toBe('edited');
    host.operations[0].confirm();
    await expect(update).resolves.toMatchObject({ data: { title: 'edited' } });
    const deletion = xdb.deleteAsync('n');
    const rejected = expect(deletion).rejects.toThrow('not acknowledged');
    expect(xdb.get('notes', 'n')).toBe(null);
    host.operations[1].fail();
    await rejected;
    expect(JSON.parse(host.parent.get('xdb:notes')!)[0].deleted).toBe(false);
    expect(xdb.getStorageStatus().issues.some(issue => issue.kind === 'write-failed')).toBe(true);
  });

  it('does not await a reentrant listener write as if it belonged to the original async create', async () => {
    const host = hostedStorage();
    const xdb = service(host.storage);
    let nested = false;
    xdb.subscribe('notes', event => {
      if (event.type === 'create' && !nested) { nested = true; xdb.create('notes', { title: 'later' }); }
    });
    const first = xdb.createAsync('notes', { title: 'first' });
    expect(host.operations).toHaveLength(2);
    host.operations[0].confirm();
    await expect(first).resolves.toMatchObject({ data: { title: 'first' } });
    expect(xdb.getStorageStatus().pendingWrites).toBe(1);
    host.operations[1].fail();
    await xdb.whenIdle();
  });

  it('uses one batch for multiple collections and exposes its deferred import persisted promise', async () => {
    const host = hostedStorage();
    const xdb = service(host.storage);
    const imported = xdb.import(backup({ notes: [row('n')], tasks: [row('t', 'tasks')] }));
    const settled = watched(imported.persisted);
    expect(host.operations).toHaveLength(1);
    expect(host.operations[0].kind).toBe('batch');
    expect(host.operations[0].replacements).toHaveLength(2);
    expect(xdb.getAll('notes').map(record => record.id)).toEqual(['n']);
    expect(host.parent.size).toBe(0);
    await flush();
    expect(settled()).toBe(false);
    host.operations[0].confirm();
    await expect(imported.persisted).resolves.toEqual({ backend: 'storage', imported: 2, collections: ['notes', 'tasks'], tombstoned: 0 });
    expect(host.parent.size).toBe(2);
  });

  it('keeps the admitted batch and durable summary independent of caller mutation', async () => {
    const host = hostedStorage();
    const xdb = service(host.storage);
    const data = backup({ notes: [row('original')] });
    const imported = xdb.import(data);
    imported.collections.push('never-admitted');
    data.collections.notes[0].id = 'changed-after-admission';
    host.operations[0].confirm();
    await expect(imported.persisted).resolves.toMatchObject({ collections: ['notes'], imported: 1 });
    expect(JSON.parse(host.parent.get('xdb:notes')!)[0].id).toBe('original');
  });

  it.each(['importAsync', 'restoreAsync', 'importFromJSON'] as const)('%s does not report completion before its own batch acknowledgment', async method => {
    const host = hostedStorage({ 'xdb:notes': JSON.stringify([row('old')]) });
    const xdb = service(host.storage);
    const data = backup({ notes: [row('new')] });
    const pending = method === 'importFromJSON' ? xdb.importFromJSON(JSON.stringify(data), { merge: false }).persisted
      : method === 'restoreAsync' ? xdb.restoreAsync(data) : xdb.importAsync(data, { merge: false });
    const settled = watched<unknown>(pending);
    await flush();
    expect(settled()).toBe(false);
    host.operations[0].confirm();
    await pending;
    expect(JSON.parse(host.parent.get('xdb:notes')!).map((record: { id: string }) => record.id)).toEqual(['new']);
  });

  it('refuses escaped oversized batch input before optimistic or parent changes', async () => {
    const host = hostedStorage({ 'xdb:notes': JSON.stringify([row('old')]) });
    const xdb = service(host.storage);
    const before = new Map(host.cache);
    const escaped = { ...row('n'), data: { title: '\n'.repeat(17000) } };
    await expect(xdb.importAsync(backup({ notes: [escaped], tasks: [row('t')] }), { merge: false })).rejects.toThrow('too large');
    expect(host.operations).toHaveLength(0);
    expect(host.cache).toEqual(before);
    expect(host.parent).toEqual(before);
  });

  it('rejects a known admission refusal without changing cache or claiming rollback of a parent write', async () => {
    const host = hostedStorage({ 'xdb:notes': JSON.stringify([row('old')]) });
    const xdb = service(host.storage);
    host.refuseAdmission();
    await expect(xdb.restoreAsync(backup({ notes: [row('new')] }))).rejects.toThrow('before cache mutation');
    expect(host.operations).toHaveLength(0);
    expect(host.parent.get('xdb:notes')).toBe(host.cache.get('xdb:notes'));
    expect(xdb.getAll('notes').map(record => record.id)).toEqual(['old']);
  });

  it.each(['importAsync', 'restoreAsync'] as const)('%s rejects a failed batch and leaves the prior parent map intact', async method => {
    const host = hostedStorage({ 'xdb:notes': JSON.stringify([row('old')]), 'xdb:tasks': JSON.stringify([row('old-task', 'tasks')]) });
    const xdb = service(host.storage);
    const before = new Map(host.parent);
    const data = backup({ notes: [row('new')], tasks: [row('new-task', 'tasks')] });
    const pending = method === 'restoreAsync' ? xdb.restoreAsync(data) : xdb.importAsync(data, { merge: false });
    const rejected = expect(pending).rejects.toThrow('not acknowledged');
    expect(host.operations).toHaveLength(1);
    host.operations[0].fail();
    await rejected;
    expect(host.parent).toEqual(before);
    expect(xdb.getStorageStatus().issues.some(issue => issue.kind === 'write-failed')).toBe(true);
  });

  it('does not compensate a failed batch by overwriting a subsequent edit, or erase failure after unrelated success', async () => {
    const host = hostedStorage({ 'xdb:notes': JSON.stringify([row('old')]), 'xdb:tasks': JSON.stringify([row('kept', 'tasks')]) });
    const xdb = service(host.storage);
    const originalParent = new Map(host.parent);
    const imported = xdb.import(backup({ notes: [row('new')], tasks: [row('new-task', 'tasks')] }), { merge: false });
    const rejected = expect(imported.persisted).rejects.toThrow('not acknowledged');
    xdb.updateInCollection('notes', 'new', { title: 'later edit' });
    host.operations[0].fail();
    await rejected;
    expect(host.parent).toEqual(originalParent);
    expect(host.operations).toHaveLength(2);
    expect(xdb.get('notes', 'new')!.data.title).toBe('later edit');
    host.operations[1].confirm();
    await xdb.whenIdle();
    expect(xdb.getStorageStatus().persistence!.failedWrites).toBe(1);
    expect(xdb.getStorageStatus().issues).toContainEqual(expect.objectContaining({ kind: 'write-failed', collection: 'notes' }));
    expect(warnsBeforeUnload()).toBe(true);
  });

  it('reports a sent timeout as unknown and accepts only its late matched status without re-resolving the rejected promise', async () => {
    const host = hostedStorage();
    const xdb = service(host.storage);
    const pending = xdb.createAsync('notes', { title: 'uncertain' });
    const rejected = expect(pending).rejects.toThrow('not acknowledged');
    host.operations[0].fail(true);
    await rejected;
    await xdb.whenIdle();
    expect(xdb.hasPendingWrites()).toBe(false);
    expect(xdb.getStorageStatus().persistence!.unknownWrites).toBe(1);
    expect(warnsBeforeUnload()).toBe(true);
    host.operations[0].lateConfirm();
    await flush();
    expect(xdb.getStorageStatus().issues.filter(issue => issue.kind === 'write-unknown')).toEqual([]);
    expect(xdb.getStorageStatus().persistence!.unknownWrites).toBe(0);
    await expect(pending).rejects.toThrow('not acknowledged');
    expect(host.operations).toHaveLength(1);
    expect(warnsBeforeUnload()).toBe(false);
  });

  it('captures a finite whenIdle set and treats failure settlement separately from saving', async () => {
    const host = hostedStorage();
    const xdb = service(host.storage);
    xdb.create('notes', { title: 'first' });
    const idle = xdb.whenIdle();
    xdb.create('notes', { title: 'future write' });
    host.operations[0].fail();
    await idle;
    expect(xdb.hasPendingWrites()).toBe(true);
    expect(xdb.getStorageStatus().persistence!.failedWrites).toBe(1);
    host.operations[1].confirm();
    await xdb.whenIdle();
  });

  it('tracks synchronous clear without claiming it changed parent data when acknowledgment fails', async () => {
    const host = hostedStorage({ 'xdb:notes': JSON.stringify([row('old')]) });
    const xdb = service(host.storage);
    xdb.clear('notes');
    expect(host.operations[0].kind).toBe('remove');
    expect(xdb.getAll('notes')).toEqual([]);
    expect(host.parent.has('xdb:notes')).toBe(true);
    host.operations[0].fail();
    await xdb.whenIdle();
    expect(host.parent.has('xdb:notes')).toBe(true);
    expect(xdb.getStorageStatus().state).toBe('degraded');
  });

  it('refuses partial restore before admitting a batch and preserves corrupt raw bytes', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const host = hostedStorage({ 'xdb:notes': 'broken raw data' });
    const xdb = service(host.storage);
    await expect(xdb.restoreAsync(backup({ tasks: [row('t', 'tasks'), { missing: 'id' } as never] }))).rejects.toThrow('nothing was changed');
    expect(host.operations).toHaveLength(0);
    expect(xdb.getAll('notes')).toEqual([]);
    expect(xdb.exportQuarantined('notes')).toBe('broken raw data');
    expect(host.parent.get('xdb:notes')).toBe('broken raw data');
    expect(() => xdb.create('notes', {})).toThrow('damaged');
    host.operations[0].fail();
    await xdb.whenIdle();
    expect(xdb.exportQuarantined('notes')).toBe('broken raw data');
  });

  it('rejects outstanding callers and drops its subscription on destroy; late replies never notify the released owner', async () => {
    const host = hostedStorage();
    const xdb = service(host.storage);
    const listener = vi.fn();
    xdb.subscribeStorage(listener);
    const pending = xdb.createAsync('notes', { title: 'before release' });
    const rejected = expect(pending).rejects.toThrow('owner was released');
    expect(host.listeners.size).toBe(1);
    xdb.destroy();
    await rejected;
    const calls = listener.mock.calls.length;
    expect(host.listeners.size).toBe(0);
    expect(xdb.hasPendingWrites()).toBe(false);
    expect(warnsBeforeUnload()).toBe(false);
    host.operations[0].confirm();
    await flush();
    expect(listener.mock.calls).toHaveLength(calls);
    expect(() => xdb.clear('notes')).toThrow('owner has been released');
  });

  it('keeps old-parent synchronous changes optimistic but refuses all durable claims and batch imports', async () => {
    const cache = new Map<string, string>();
    const storage: XDBStorage = {
      getItem: key => cache.get(key) ?? null,
      setItem: (key, value) => { cache.set(key, value); },
      removeItem: key => { cache.delete(key); },
      acknowledgedPersistence: {
        protocol: 0,
        getStatus: () => ({ protocol: 0, pendingWrites: 0, failedWrites: 0, unknownWrites: 0, disposed: false }),
        subscribe: () => () => {}, whenIdle: async () => {},
      },
    };
    const xdb = service(storage);
    const optimistic = xdb.create('notes', { title: 'cached' });
    expect(optimistic.id).toBeDefined();
    await expect(xdb.createAsync('notes', { title: 'also cached' })).rejects.toThrow('does not support');
    const before = new Map(cache);
    await expect(xdb.importAsync(backup({ tasks: [row('t')] }))).rejects.toThrow('nothing was changed');
    await expect(xdb.restoreAsync(backup({ notes: [row('new')] }))).rejects.toThrow('nothing was changed');
    expect(cache).toEqual(before);
    expect(xdb.getStorageStatus().persistent).toBe(false);
    expect(xdb.getStorageStatus().issues.some(issue => issue.kind === 'persistence-unsupported')).toBe(true);
    expect(warnsBeforeUnload()).toBe(true);
    await xdb.whenIdle();
  });

  it('preserves synchronous browser storage without requiring hosted capability negotiation', async () => {
    const cache = new Map<string, string>();
    const xdb = service({ getItem: key => cache.get(key) ?? null, setItem: (key, value) => { cache.set(key, value); }, removeItem: key => { cache.delete(key); } });
    const created = await xdb.createAsync('notes', { title: 'normal browser' });
    await expect(xdb.updateAsync(created.id, { title: 'changed' })).resolves.toMatchObject({ data: { title: 'changed' } });
    await expect(xdb.deleteAsync(created.id)).resolves.toBe(true);
    expect(xdb.getStorageStatus()).toMatchObject({ persistent: true, pendingWrites: 0, state: 'ready' });
    expect(xdb.getStorageStatus().persistence).toBeUndefined();
  });
});
