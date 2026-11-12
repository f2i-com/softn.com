/**
 * What a SmartForm that saves to a collection does once it has saved.
 *
 * It said nothing and kept what was typed. On the web the save is finished
 * within the press, so the button was never seen disabled, and a second
 * press saved the same record again: the guide's own example, pressed twice,
 * made two clients. A new record now leaves the form started again and
 * saying "Saved"; `afterSave="keep"` is the other case, and the page's own
 * `data` is still what the form starts from.
 */

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppScopeProvider, getXDB } from '@softn/core';
import { mount, type, type Mounted } from './dom';
import { SmartForm, type SmartFormProps } from '../src/smart/SmartForm';

const xdb = getXDB('form-after-save');
const scope = { appId: 'form-after-save', xdb, active: true };
const GUIDE = { collection: 'clients', fields: 'name:text:required, email:email:required, phone:text', submitText: 'Add Client' };

const mounted: Mounted[] = [];
function form(props: SmartFormProps): Mounted {
  const view = mount(
    <AppScopeProvider value={scope}>
      <SmartForm {...props} />
    </AppScopeProvider>
  );
  mounted.push(view);
  return view;
}
const rerender = (view: Mounted, props: SmartFormProps) =>
  view.rerender(
    <AppScopeProvider value={scope}>
      <SmartForm {...props} />
    </AppScopeProvider>
  );

const field = (view: Mounted, name: string) => view.container.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
const status = (view: Mounted) => view.container.querySelector('[role="status"]')!.textContent;
const alerts = (view: Mounted) => Array.from(view.container.querySelectorAll('[role="alert"]')).map((alert) => alert.textContent);
async function submit(view: Mounted) {
  await act(async () => {
    view.container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}
const saved = (collection = 'clients') => xdb.getAll(collection).map((record) => record.data as Record<string, unknown>);

beforeEach(() => {
  xdb.clear('clients');
  xdb.clear('orders');
});
afterEach(() => {
  for (const view of mounted.splice(0)) view.unmount();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('a SmartForm that has saved a new record', () => {
  it('starts again and says so, and a second press saves no second record', async () => {
    const view = form(GUIDE);
    type(field(view, 'name'), 'Ada Lovelace');
    type(field(view, 'email'), 'ada@example.com');
    type(field(view, 'phone'), '555 0100');
    expect(status(view)).toBe('');

    await submit(view);
    expect(saved()).toEqual([{ name: 'Ada Lovelace', email: 'ada@example.com', phone: '555 0100' }]);
    expect(field(view, 'name').value).toBe('');
    expect(field(view, 'email').value).toBe('');
    expect(field(view, 'phone').value).toBe('');
    expect(status(view)).toBe('Saved');
    expect(alerts(view)).toEqual([]);

    await submit(view);
    expect(saved()).toHaveLength(1);
    expect(alerts(view)).toEqual(['This field is required', 'This field is required']);
  });

  it('says it for a moment only, and not once the next record is being typed', async () => {
    vi.useFakeTimers();
    const view = form(GUIDE);
    type(field(view, 'name'), 'Ada');
    type(field(view, 'email'), 'ada@example.com');
    await submit(view);
    expect(status(view)).toBe('Saved');
    act(() => {
      vi.advanceTimersByTime(3900);
    });
    expect(status(view)).toBe('Saved');
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(status(view)).toBe('');

    type(field(view, 'name'), 'Grace');
    type(field(view, 'email'), 'grace@example.com');
    await submit(view);
    expect(status(view)).toBe('Saved');
    type(field(view, 'name'), 'A');
    expect(status(view)).toBe('');
  });

  it('starts again from the page’s own data and defaults, not from nothing', async () => {
    const props: SmartFormProps = {
      collection: 'orders',
      fields: [{ name: 'item' }, { name: 'quantity', type: 'number', defaultValue: 1 }, { name: 'status' }],
      data: { status: 'new' },
      defaults: { paid: false },
    };
    const view = form(props);
    type(field(view, 'item'), 'Tea');
    type(field(view, 'quantity'), '3');
    type(field(view, 'status'), 'rush');
    await submit(view);
    expect(saved('orders')).toEqual([{ item: 'Tea', quantity: 3, status: 'rush', paid: false }]);
    expect(field(view, 'item').value).toBe('');
    expect(field(view, 'quantity').value).toBe('1');
    expect(field(view, 'status').value).toBe('new');

    // And the record after it gets the defaults again.
    type(field(view, 'item'), 'Milk');
    await submit(view);
    expect(saved('orders')[1]).toEqual({ item: 'Milk', quantity: 1, status: 'new', paid: false });
  });

  it('shows the data the page gives in answer to the save', async () => {
    const drawn: { view?: Mounted } = {};
    const props = (data: Record<string, unknown>): SmartFormProps => ({
      collection: 'orders',
      fields: 'item, status',
      data,
      onSaved: () => rerender(drawn.view!, props({ status: 'after the first' })),
    });
    const view = (drawn.view = form(props({ status: 'new' })));
    type(field(view, 'item'), 'Tea');
    await submit(view);
    expect(field(view, 'item').value).toBe('');
    expect(field(view, 'status').value).toBe('after the first');
  });

  it('keeps what was typed with afterSave="keep", and still says it saved', async () => {
    const view = form({ ...GUIDE, afterSave: 'keep' });
    type(field(view, 'name'), 'Ada Lovelace');
    type(field(view, 'email'), 'ada@example.com');
    await submit(view);
    expect(saved()).toHaveLength(1);
    expect(field(view, 'name').value).toBe('Ada Lovelace');
    expect(field(view, 'email').value).toBe('ada@example.com');
    expect(status(view)).toBe('Saved');
  });

  it('says what the page tells it to say', async () => {
    const view = form({ ...GUIDE, savedText: 'Client added' });
    type(field(view, 'name'), 'Ada');
    type(field(view, 'email'), 'ada@example.com');
    await submit(view);
    expect(status(view)).toBe('Client added');
  });

  it('tells the page of the save with what was typed, though the form has started again', async () => {
    const onSaved = vi.fn();
    const onSubmit = vi.fn();
    const view = form({ ...GUIDE, onSaved, onSubmit });
    type(field(view, 'name'), 'Ada');
    type(field(view, 'email'), 'ada@example.com');
    await submit(view);
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect((onSaved.mock.calls[0][0] as { data: unknown }).data).toEqual({ name: 'Ada', email: 'ada@example.com' });
    expect(onSubmit).toHaveBeenCalledWith({ name: 'Ada', email: 'ada@example.com' });
  });

  it('starts again once a save that takes a while has finished, not before', async () => {
    vi.spyOn(xdb, 'isP2PAvailable').mockReturnValue(true);
    let finish!: (record: ReturnType<typeof xdb.create>) => void;
    vi.spyOn(xdb, 'createAsync').mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const view = form(GUIDE);
    type(field(view, 'name'), 'Ada');
    type(field(view, 'email'), 'ada@example.com');
    await submit(view);
    // Being saved: what was typed is still there, and the button is held.
    expect(field(view, 'name').value).toBe('Ada');
    expect(status(view)).toBe('');
    expect(view.container.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled).toBe(true);
    const stamp = '2026-11-12T00:00:00.000Z';
    await act(async () => {
      finish({ id: 'a', collection: 'clients', data: { name: 'Ada' }, created_at: stamp, updated_at: stamp, deleted: false } as ReturnType<typeof xdb.create>);
    });
    expect(field(view, 'name').value).toBe('');
    expect(status(view)).toBe('Saved');
    expect(view.container.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled).toBe(false);
  });

  it('keeps what was typed when the save fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(xdb, 'create').mockImplementation(() => {
      throw new Error('The disk is full');
    });
    const view = form(GUIDE);
    type(field(view, 'name'), 'Ada');
    type(field(view, 'email'), 'ada@example.com');
    await submit(view);
    expect(field(view, 'name').value).toBe('Ada');
    expect(status(view)).toBe('');
    expect(alerts(view)).toEqual(['The disk is full']);
  });
});

describe('a SmartForm that is not saving a new record to a collection', () => {
  it('keeps the values of a record being edited, and says it saved', async () => {
    const record = xdb.create('clients', { name: 'Ada', email: 'ada@example.com' });
    const view = form({ ...GUIDE, recordId: record.id, data: record.data as Record<string, unknown> });
    type(field(view, 'name'), 'Ada Lovelace');
    await submit(view);
    expect(saved()).toEqual([{ name: 'Ada Lovelace', email: 'ada@example.com' }]);
    expect(field(view, 'name').value).toBe('Ada Lovelace');
    expect(status(view)).toBe('Saved');
  });

  it('is left as it is when the page does the saving itself', async () => {
    const onSubmit = vi.fn();
    const view = form({ fields: 'name:text:required', onSubmit });
    type(field(view, 'name'), 'Ada');
    await submit(view);
    expect(onSubmit).toHaveBeenCalledWith({ name: 'Ada' });
    expect(field(view, 'name').value).toBe('Ada');
    expect(status(view)).toBe('');
  });
});

describe('a SmartForm under a finger', () => {
  it('has a rule that draws its fields at 16 pixels and 44 tall, so iOS does not zoom the page', () => {
    const view = form(GUIDE);
    const rules = Array.from(view.container.querySelectorAll('style')).map((style) => style.textContent ?? '').join('\n');
    expect(rules).toMatch(/@media \(pointer: coarse\) \{\s*\.softn-smart-form-field \{ font-size: 16px !important; min-height: 44px; \}/);
    for (const name of ['name', 'email', 'phone']) expect(field(view, name).className).toBe('softn-smart-form-field');
    expect(view.container.querySelector('[type="submit"]')!.className).toBe('softn-smart-form-button');
  });
});
