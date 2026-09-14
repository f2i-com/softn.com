/**
 * Audit SN-02: storage corruption, quota exhaustion, inaccessible storage and
 * interrupted legacy migration are STATES the service reports and guards
 * against — never "an empty collection".
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { XDBService, XDBStorageError, getXDB } from '../src/runtime/xdb';

function storageWith(initial: Record<string, string> = {}, options: { failWrites?: boolean } = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (options.failWrites) throw new DOMException('QuotaExceededError', 'QuotaExceededError');
      store.set(key, value);
    },
    removeItem: (key: string) => { store.delete(key); },
  };
}

const record = (id: string, title: string) => ({ id, collection: 'notes', data: { title }, created_at: 't', updated_at: 't', deleted: false });

describe('XDB storage state (browser backend)', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('quarantines malformed JSON instead of treating it as an empty writable collection', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const storage = storageWith({ 'xdb:notes': '{"not": "an array"' });
    const xdb = new XDBService(storage, 'xdb');
    expect(xdb.getStorageStatus().state).toBe('ready');

    expect(xdb.getAll('notes')).toEqual([]);
    const status = xdb.getStorageStatus();
    expect(status.state).toBe('degraded');
    expect(status.issues).toHaveLength(1);
    expect(status.issues[0]).toMatchObject({ kind: 'corrupt', collection: 'notes' });
    expect(xdb.isCollectionReadable('notes')).toBe(false);
    // The original bytes are preserved under a recovery key AND exportable.
    expect(storage.store.get(status.issues[0].quarantineKey!)).toBe('{"not": "an array"');
    expect(xdb.exportQuarantined('notes')).toBe('{"not": "an array"');
    // Writes that would replace the damaged data are refused…
    expect(() => xdb.create('notes', { title: 'overwrite' })).toThrow(XDBStorageError);
    expect(() => xdb.clear('notes')).toThrow(/damaged/);
    expect(() => xdb.import({ version: 1, exportedAt: '', collections: { notes: [record('n1', 'x')] } })).toThrow(/damaged/);
    expect(storage.store.get('xdb:notes')).toBe('{"not": "an array"');
    // …other collections keep working.
    expect(xdb.create('tasks', { title: 'fine' }).id).toBeDefined();
    errors.mockRestore();
  });

  it('treats valid JSON with the wrong shape as corruption too', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const bad of ['{"id":"x"}', '[{"id":"ok","data":{}},{"no":"id"}]', '["just", "strings"]']) {
      const storage = storageWith({ 'xdb:notes': bad });
      const xdb = new XDBService(storage, 'xdb');
      expect(xdb.getAll('notes')).toEqual([]);
      expect(xdb.getStorageStatus().issues[0]).toMatchObject({ kind: 'corrupt', collection: 'notes' });
      expect(() => xdb.create('notes', { title: 'x' })).toThrow(XDBStorageError);
      expect(storage.store.get('xdb:notes')).toBe(bad);
    }
  });

  it('allows recovery: restore from a backup, or acknowledge discarding, both keeping the quarantine', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const storage = storageWith({ 'xdb:notes': 'garbage' });
    const xdb = new XDBService(storage, 'xdb');
    xdb.getAll('notes');
    const quarantineKey = xdb.getStorageStatus().issues[0].quarantineKey!;

    expect(() => xdb.restoreCollectionFromBackup('notes', [record('n1', 'ok'), { nope: true }])).toThrow(/not records/);
    expect(xdb.isCollectionReadable('notes')).toBe(false);

    expect(xdb.restoreCollectionFromBackup('notes', [record('n1', 'ok'), record('n2', 'also')])).toBe(2);
    expect(xdb.getAll('notes').map(r => r.id)).toEqual(['n1', 'n2']);
    expect(xdb.getStorageStatus().state).toBe('ready');
    expect(storage.store.get(quarantineKey)).toBe('garbage');

    const other = new XDBService(storageWith({ 'xdb:tasks': 'garbage' }), 'xdb');
    other.getAll('tasks');
    other.acknowledgeCorruption('tasks');
    expect(other.create('tasks', { title: 'after acknowledgement' }).id).toBeDefined();
    expect(other.getStorageStatus().state).toBe('ready');
  });

  it('keeps the previous data and reports quota exhaustion instead of claiming a save', () => {
    const storage = storageWith({ 'xdb:notes': JSON.stringify([record('n1', 'kept')]) }, { failWrites: true });
    const xdb = new XDBService(storage, 'xdb');
    expect(() => xdb.create('notes', { title: 'too big' })).toThrow(XDBStorageError);
    expect(xdb.getAll('notes').map(r => r.id)).toEqual(['n1']);
    const status = xdb.getStorageStatus();
    expect(status.state).toBe('degraded');
    expect(status.issues[0]).toMatchObject({ kind: 'quota', collection: 'notes' });
    expect(storage.store.get('xdb:notes')).toBe(JSON.stringify([record('n1', 'kept')]));
    // Import reports the same truth through its durable signal path (sync throw).
    expect(() => xdb.import({ version: 1, exportedAt: '', collections: { notes: [record('n2', 'x')] } })).toThrow(/Could not save/);
  });

  it('identifies memory-only operation when browser storage is unavailable', () => {
    // An opaque-origin sandbox throws on the property access itself.
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', { get() { throw new Error('SecurityError: localStorage is disabled'); }, configurable: true });
    let xdb: XDBService;
    try { xdb = new XDBService(undefined, 'xdb'); }
    finally { if (original) Object.defineProperty(globalThis, 'localStorage', original); else Reflect.deleteProperty(globalThis, 'localStorage'); }
    const status = xdb.getStorageStatus();
    expect(status.state).toBe('memory-only');
    expect(status.persistent).toBe(false);
    expect(status.issues[0].kind).toBe('inaccessible');
    // Still responsive.
    expect(xdb.create('notes', { title: 'in memory' }).id).toBeDefined();
    const browser = new XDBService(storageWith(), 'xdb');
    expect(browser.getStorageStatus()).toMatchObject({ state: 'ready', persistent: true, hydrated: true, pendingWrites: 0 });
    const persisted = browser.import({ version: 1, exportedAt: '', collections: { notes: [record('n1', 'x')] } }).persisted;
    return expect(persisted).resolves.toEqual({ backend: 'storage', collections: ['notes'], imported: 1, tombstoned: 0 });
  });

  it('notifies subscribers when the state changes', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const xdb = new XDBService(storageWith({ 'xdb:notes': 'garbage' }), 'xdb');
    const seen: string[] = [];
    const stop = xdb.subscribeStorage(status => seen.push(status.state));
    xdb.getAll('notes');
    xdb.acknowledgeCorruption('notes');
    stop();
    xdb.getAll('notes');
    expect(seen).toEqual(['degraded', 'ready']);
  });

  it('verifies the legacy migration and records an interrupted one without deleting old keys', () => {
    const store = new Map<string, string>([['xdb:notes', JSON.stringify([record('legacy', 'old')])]]);
    let quotaLeft = Number.POSITIVE_INFINITY;
    const fakeLocalStorage = {
      get length() { return store.size; },
      key: (i: number) => [...store.keys()][i] ?? null,
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { if (quotaLeft <= 0) throw new Error('quota'); quotaLeft -= 1; store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
      clear: () => store.clear(),
    };
    vi.stubGlobal('localStorage', fakeLocalStorage);

    // Interrupted: the copy fails, the legacy key survives, the issue is visible, no marker.
    quotaLeft = 0;
    const first = getXDB('app-migrate-a');
    expect(first.getStorageStatus().issues.map(i => i.kind)).toContain('migration-incomplete');
    expect(store.has('xdb:notes')).toBe(true);
    expect(store.get('xdb-meta:app-migrate-a:legacy-migration')).toBeUndefined();

    // Restartable: the next app open completes and verifies it.
    quotaLeft = Number.POSITIVE_INFINITY;
    const second = getXDB('app-migrate-b');
    expect(second.getStorageStatus().issues.map(i => i.kind)).not.toContain('migration-incomplete');
    expect(store.get('xdb:app-migrate-b:notes')).toBe(JSON.stringify([record('legacy', 'old')]));
    expect(store.get('xdb-meta:app-migrate-b:legacy-migration')).toBe('done');
    expect(store.has('xdb:notes')).toBe(true);
  });
});
