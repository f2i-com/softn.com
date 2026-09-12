import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEphemeralXDBScope, getXDB, type EphemeralXDBScope } from '../src/runtime/xdb';

describe('ephemeral preview database scopes', () => {
  const scopes: EphemeralXDBScope[] = [];
  const createScope = () => {
    const scope = createEphemeralXDBScope();
    scopes.push(scope);
    return scope;
  };

  afterEach(() => {
    for (const scope of scopes.splice(0)) scope.dispose();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shares one reactive store with appId consumers without persisting browser data', () => {
    const before = { ...localStorage };
    const persist = vi.spyOn(Storage.prototype, 'setItem');
    const scope = createScope();
    const listener = vi.fn();
    scope.xdb.subscribe('tasks', listener);
    const record = scope.xdb.create('tasks', { title: 'Preview task' });

    expect(getXDB(scope.appId)).toBe(scope.xdb);
    expect(getXDB(scope.appId).getAll('tasks')).toEqual([record]);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ type: 'create' }));
    expect(persist).not.toHaveBeenCalled();
    expect({ ...localStorage }).toEqual(before);
  });

  it('keeps simultaneous previews and the default store separate', () => {
    const first = createScope();
    const second = createScope();
    const defaultStore = getXDB();
    const defaultRecords = defaultStore.getAll('tasks');
    first.xdb.create('tasks', { title: 'First preview' });
    second.xdb.create('tasks', { title: 'Second preview' });

    expect(first.appId).not.toBe(second.appId);
    expect(first.xdb.getAll('tasks').map((record) => record.data.title)).toEqual(['First preview']);
    expect(second.xdb.getAll('tasks').map((record) => record.data.title)).toEqual([
      'Second preview',
    ]);
    expect(defaultStore.getAll('tasks')).toEqual(defaultRecords);
  });

  it('bypasses native hydration, events and writes when a Tauri bridge is available', async () => {
    const invoke = vi.fn();
    const listen = vi.fn();
    vi.stubGlobal('__TAURI__', { core: { invoke }, event: { listen } });
    const scope = createScope();
    await scope.xdb.isReady;
    const record = await scope.xdb.createAsync('tasks', { title: 'Local sample' });
    await scope.xdb.updateAsync(record.id, { title: 'Edited sample' });
    expect(scope.xdb.get('tasks', record.id)?.data.title).toBe('Edited sample');
    await scope.xdb.deleteAsync(record.id);
    expect(scope.xdb.getAll('tasks')).toEqual([]);
    expect(scope.xdb.isP2PAvailable()).toBe(false);
    expect(await scope.xdb.getDbPath()).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
    expect(listen).not.toHaveBeenCalled();
  });

  it('drops records and listeners on disposal and rejects stale registry lookups', () => {
    const scope = createScope();
    scope.xdb.create('tasks', { title: 'Private sample' });
    const collectionListener = vi.fn();
    const globalListener = vi.fn();
    const mutationListener = vi.fn();
    scope.xdb.subscribe('tasks', collectionListener);
    scope.xdb.subscribeAll(globalListener);
    scope.xdb.onMutation(mutationListener);
    scope.dispose();
    scope.dispose();

    expect(() => getXDB(scope.appId)).toThrow(/preview database scope has been disposed/i);
    expect(scope.xdb.getAll('tasks')).toEqual([]);
    scope.xdb.create('tasks', { title: 'Late callback' });
    expect(scope.xdb.getAll('tasks')).toEqual([]);
    expect(collectionListener).not.toHaveBeenCalled();
    expect(globalListener).not.toHaveBeenCalled();
    expect(mutationListener).not.toHaveBeenCalled();
  });
});
