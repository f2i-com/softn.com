/**
 * Cross-bundle storage isolation.
 *
 * Every bundle used to share the literal `xdb:` key prefix, so opening a second
 * `.softn` gave it read *and delete* access to the first one's records. Nothing
 * had to be guessed: the collection enumerator listed them.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// A fresh module registry per test — XDB memoises instances in a module-level
// map, and these tests are precisely about which instance you get.
async function freshXdb() {
  vi.resetModules();
  return import('../src/runtime/xdb');
}

beforeEach(() => {
  localStorage.clear();
});

describe('two apps in the same browser', () => {
  it('cannot see each other\'s records', async () => {
    const { getXDB } = await freshXdb();

    const a = getXDB('AppA');
    const b = getXDB('AppB');
    a.create('accounts', { holder: 'private' });

    expect(a.query('accounts')).toHaveLength(1);
    expect(b.query('accounts')).toHaveLength(0);
  });

  it('cannot destroy each other\'s records', async () => {
    const { getXDB } = await freshXdb();

    const a = getXDB('AppA');
    const b = getXDB('AppB');
    const record = a.create('accounts', { holder: 'private' });

    b.delete(record.id);

    expect(a.query('accounts')).toHaveLength(1);
  });

  it('cannot enumerate each other\'s collections', async () => {
    const { getXDB } = await freshXdb();

    getXDB('AppA').create('salaries', { amount: 1 });
    const b = getXDB('AppB');

    // `update` by id sweeps every collection it can enumerate, so a collection
    // B can list is one B can write into.
    expect(b.update('anything', { amount: 999 })).toBeNull();
    expect(getXDB('AppA').query('salaries')[0].data.amount).toBe(1);
  });

  it('keeps them in separate storage keys', async () => {
    const { getXDB } = await freshXdb();
    getXDB('AppA').create('notes', { body: 'hi' });

    const keys = Object.keys(localStorage);
    expect(keys).toContain('xdb:AppA:notes');
    expect(keys).not.toContain('xdb:notes');
  });
});

describe('callers that cannot reach an appId', () => {
  it('resolve to the active app, not a separate store', async () => {
    // SmartForm, the bundle seeder and the worker mutation path all call
    // getXDB() bare. If they landed on their own instance, a form would write
    // records the app itself could never read.
    const { getXDB, setActiveXDBApp } = await freshXdb();

    setActiveXDBApp('AppA');
    getXDB().create('notes', { body: 'from a component' });

    expect(getXDB('AppA').query('notes')).toHaveLength(1);
  });

  it('fall back to the shared default when no app is running', async () => {
    const { getXDB, setActiveXDBApp } = await freshXdb();

    setActiveXDBApp(undefined);
    getXDB().create('scratch', { n: 1 });

    expect(Object.keys(localStorage)).toContain('xdb:scratch');
  });
});

describe('data written before namespacing', () => {
  it('is adopted rather than orphaned', async () => {
    // Upgrading must not silently empty an existing install.
    localStorage.setItem(
      'xdb:notes',
      JSON.stringify([
        { id: 'r1', collection: 'notes', data: { body: 'old' }, created_at: '', updated_at: '' },
      ])
    );

    const { getXDB } = await freshXdb();
    expect(getXDB('AppA').query('notes')).toHaveLength(1);
  });

  it('is left in place for apps not yet opened', async () => {
    // The legacy keys may hold more than one app's records and there is no way
    // to tell whose is whose, so copy rather than move.
    localStorage.setItem(
      'xdb:notes',
      JSON.stringify([
        { id: 'r1', collection: 'notes', data: { body: 'old' }, created_at: '', updated_at: '' },
      ])
    );

    const { getXDB } = await freshXdb();
    getXDB('AppA');

    expect(localStorage.getItem('xdb:notes')).not.toBeNull();
  });

  it('does not overwrite an app that already has its own records', async () => {
    localStorage.setItem(
      'xdb:notes',
      JSON.stringify([
        { id: 'r1', collection: 'notes', data: { body: 'legacy' }, created_at: '', updated_at: '' },
      ])
    );
    localStorage.setItem(
      'xdb:AppA:notes',
      JSON.stringify([
        { id: 'r2', collection: 'notes', data: { body: 'current' }, created_at: '', updated_at: '' },
      ])
    );

    const { getXDB } = await freshXdb();
    const records = getXDB('AppA').query('notes');

    expect(records).toHaveLength(1);
    expect(records[0].data.body).toBe('current');
  });
});
