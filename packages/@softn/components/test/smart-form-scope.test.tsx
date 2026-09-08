/**
 * A form saves into the app it is in, not the app that rendered last.
 *
 * `<SmartForm collection="…">` has no appId: it is instantiated from a .ui
 * template, several levels below the renderer. Its submit handler used to
 * await an import and then ask a module-level pointer which store to use —
 * the pointer said whichever app had rendered most recently, and with every
 * softn-web tab mounted at once that was routinely another app by the time
 * the handler resumed. The store now comes from the app scope, read at render
 * and captured by the handler.
 */

import { act } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { AppScopeProvider, getXDB, type AppScope } from '@softn/core';
import { mount, type } from './dom';
import { SmartForm } from '../src/smart/SmartForm';

const FIELDS = [{ name: 'title', label: 'Title', type: 'text' as const }];

function scopeFor(appId: string): AppScope {
  return { appId, xdb: getXDB(appId), active: true };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Submit the way the browser does when Enter is pressed in a field. */
function submit(container: HTMLElement): void {
  const form = container.querySelector('form');
  if (!form) throw new Error('submit: form not found');
  act(() => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

function titlesIn(appId?: string): string[] {
  return getXDB(appId)
    .getAll('items')
    .map((r) => String(r.data.title));
}

beforeEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
  // Instances are memoised per app and cache in memory; clearing storage
  // alone leaves the previous test's records behind.
  for (const id of ['form-a', 'form-b']) getXDB(id).clear('items');
  getXDB().clear('items');
});

describe('SmartForm under an app scope', () => {
  it('saves into its own app while another app mounts and saves mid-submit', async () => {
    const holdA = deferred();
    const a = mount(
      <AppScopeProvider value={scopeFor('form-a')}>
        <SmartForm fields={FIELDS} collection="items" onSubmit={() => holdA.promise} />
      </AppScopeProvider>
    );
    type(a.container.querySelector('input'), 'from a');
    submit(a.container);

    // A's handler is now suspended in onSubmit. A second app arrives, renders
    // and saves — the point at which a global pointer would have moved.
    const b = mount(
      <AppScopeProvider value={scopeFor('form-b')}>
        <SmartForm fields={FIELDS} collection="items" />
      </AppScopeProvider>
    );
    type(b.container.querySelector('input'), 'from b');
    submit(b.container);

    holdA.resolve();
    await act(async () => {
      await holdA.promise;
    });

    expect(titlesIn('form-a')).toEqual(['from a']);
    expect(titlesIn('form-b')).toEqual(['from b']);
    expect(titlesIn()).toEqual([]);

    a.unmount();
    b.unmount();
  });

  it('edits through the same scope it creates through', async () => {
    const existing = getXDB('form-a').create('items', { title: 'before' });
    const form = mount(
      <AppScopeProvider value={scopeFor('form-a')}>
        <SmartForm fields={FIELDS} collection="items" recordId={existing.id} data={{ title: 'before' }} />
      </AppScopeProvider>
    );
    type(form.container.querySelector('input'), 'after');
    submit(form.container);
    await act(async () => {
      await Promise.resolve();
    });

    expect(titlesIn('form-a')).toEqual(['after']);
    expect(titlesIn('form-b')).toEqual([]);
    form.unmount();
  });

  it('falls back to the shared store outside any app', async () => {
    // The builder's palette and studio's preview mount components with no
    // renderer above them. They must land somewhere neutral, never in the
    // store of whatever app happens to be open elsewhere.
    const form = mount(<SmartForm fields={FIELDS} collection="items" />);
    type(form.container.querySelector('input'), 'unscoped');
    submit(form.container);
    await act(async () => {
      await Promise.resolve();
    });

    expect(titlesIn()).toEqual(['unscoped']);
    expect(titlesIn('form-a')).toEqual([]);
    expect(titlesIn('form-b')).toEqual([]);
    form.unmount();
  });
});
