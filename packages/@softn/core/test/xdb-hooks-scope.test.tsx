/**
 * useCollection and useRecord find the store of the app they are rendered in.
 *
 * Both hooks used to fall back to the no-argument getXDB(), which followed a
 * module-level pointer the loader no longer moves. A component in app A that
 * asked for `items` therefore subscribed to the shared `_default` store while
 * A's own logic wrote to `xdb:A:items`, and the list never showed what the app
 * had just saved. The hooks now read the scope the renderer publishes, the
 * same one SmartForm writes through, so the two agree.
 */

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppScopeProvider, type AppScope } from '../src/loader/app-scope';
import { getXDB, useCollection, useRecord, type XDBService } from '../src/runtime/xdb';
import type { XDBRecord } from '../src/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Items({ xdb }: { xdb?: XDBService }): React.ReactElement {
  const { records } = useCollection('items', xdb ? { xdb } : {});
  return (
    <ul>
      {records.map((r) => (
        <li key={r.id}>{String(r.data.label)}</li>
      ))}
    </ul>
  );
}

function One({ id, xdb }: { id: string; xdb?: XDBService }): React.ReactElement {
  const { record } = useRecord('items', id, xdb ? { xdb } : {});
  return <span className="one">{record ? String(record.data.label) : 'none'}</span>;
}

function scopeFor(appId: string): AppScope {
  return { appId, xdb: getXDB(appId), active: true };
}

function record(id: string, label: string): XDBRecord {
  const timestamp = '2026-09-08T00:00:00.000Z';
  return {
    id,
    collection: 'items',
    data: { label },
    created_at: timestamp,
    updated_at: timestamp,
    deleted: false,
  };
}

function labels(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('li')).map((li) => li.textContent ?? '');
}

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  // Instances are memoised per app and cache in memory, so clearing storage
  // alone leaves the records of the previous test in place.
  for (const id of ['hooks-a', 'hooks-b']) getXDB(id).clear('items');
  getXDB().clear('items');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function mount(element: React.ReactElement): Promise<void> {
  await act(async () => {
    root.render(element);
  });
}

describe('useCollection', () => {
  it('reads the store of the app it is rendered in, and follows it', async () => {
    getXDB('hooks-a').create('items', { label: 'before' });
    getXDB('hooks-b').create('items', { label: 'elsewhere' });
    await mount(
      <AppScopeProvider value={scopeFor('hooks-a')}>
        <Items />
      </AppScopeProvider>
    );
    expect(labels(container)).toEqual(['before']);

    await act(async () => {
      getXDB('hooks-a').create('items', { label: 'after' });
      getXDB('hooks-b').create('items', { label: 'elsewhere too' });
    });
    expect(labels(container)).toEqual(['before', 'after']);
  });

  it('reads the shared default below no provider', async () => {
    getXDB('hooks-a').create('items', { label: 'scoped' });
    getXDB().create('items', { label: 'shared' });
    await mount(<Items />);
    expect(labels(container)).toEqual(['shared']);
  });

  it('lets an explicit xdb option win over the scope', async () => {
    getXDB('hooks-a').create('items', { label: 'scoped' });
    getXDB('hooks-b').create('items', { label: 'explicit' });
    await mount(
      <AppScopeProvider value={scopeFor('hooks-a')}>
        <Items xdb={getXDB('hooks-b')} />
      </AppScopeProvider>
    );
    expect(labels(container)).toEqual(['explicit']);
  });
});

describe('useRecord', () => {
  it('follows bulk edits and collection clears as well as single-record events', async () => {
    const xdb = getXDB('hooks-a');
    xdb.writeRecord('items', record('same-id', 'before'));
    await mount(
      <AppScopeProvider value={scopeFor('hooks-a')}>
        <One id="same-id" />
      </AppScopeProvider>
    );
    await act(async () => {
      xdb.suppressNotifications();
      xdb.updateInCollection('items', 'same-id', { label: 'after batch' });
      xdb.resumeNotifications();
    });
    expect(container.querySelector('.one')?.textContent).toBe('after batch');
    await act(async () => xdb.clear('items'));
    expect(container.querySelector('.one')?.textContent).toBe('none');
  });

  it('reads the store of the app it is rendered in, and follows it', async () => {
    // The same id in both stores, so a wrong store shows as a wrong label
    // rather than as nothing.
    getXDB('hooks-a').writeRecord('items', record('same-id', 'mine'));
    getXDB('hooks-b').writeRecord('items', record('same-id', 'theirs'));
    await mount(
      <AppScopeProvider value={scopeFor('hooks-a')}>
        <One id="same-id" />
      </AppScopeProvider>
    );
    expect(container.querySelector('.one')?.textContent).toBe('mine');

    await act(async () => {
      getXDB('hooks-b').writeRecord('items', record('same-id', 'theirs, changed'));
    });
    expect(container.querySelector('.one')?.textContent).toBe('mine');
    await act(async () => {
      getXDB('hooks-a').writeRecord('items', record('same-id', 'mine, changed'));
    });
    expect(container.querySelector('.one')?.textContent).toBe('mine, changed');
  });

  it('reads the shared default below no provider', async () => {
    getXDB('hooks-a').writeRecord('items', record('same-id', 'scoped'));
    getXDB().writeRecord('items', record('same-id', 'shared'));
    await mount(<One id="same-id" />);
    expect(container.querySelector('.one')?.textContent).toBe('shared');
  });

  it('lets an explicit xdb option win over the scope', async () => {
    getXDB('hooks-a').writeRecord('items', record('same-id', 'scoped'));
    getXDB('hooks-b').writeRecord('items', record('same-id', 'explicit'));
    await mount(
      <AppScopeProvider value={scopeFor('hooks-a')}>
        <One id="same-id" xdb={getXDB('hooks-b')} />
      </AppScopeProvider>
    );
    expect(container.querySelector('.one')?.textContent).toBe('explicit');
  });
});
