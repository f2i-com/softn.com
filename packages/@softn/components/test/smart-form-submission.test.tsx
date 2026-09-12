import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppScopeProvider, getXDB } from '@softn/core';
import { mount } from './dom';
import { SmartForm } from '../src/smart/SmartForm';

const FIELDS = [{ name: 'title', type: 'text' as const }];
const xdb = getXDB('form-submit-lifecycle');
const scope = { appId: 'form-submit-lifecycle', xdb, active: true };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function submit(container: HTMLElement) {
  container
    .querySelector('form')!
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

beforeEach(() => {
  xdb.clear('items');
  xdb.clear('other');
});

afterEach(() => vi.restoreAllMocks());

describe('SmartForm submission', () => {
  it('requires agreement for a required checkbox', async () => {
    const onSubmit = vi.fn();
    const form = mount(
      <SmartForm
        fields={[{ name: 'agree', type: 'checkbox', required: true }]}
        data={{ agree: false }}
        onSubmit={onSubmit}
      />
    );
    try {
      await act(async () => submit(form.container));
      expect(onSubmit).not.toHaveBeenCalled();
      expect(form.container.querySelector('[role="alert"]')?.textContent).toContain('required');
    } finally {
      form.unmount();
    }
  });

  it('keeps an old desktop save from completing callbacks or resetting a newer form', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(xdb, 'isP2PAvailable').mockReturnValue(true);
    const first = deferred<ReturnType<typeof xdb.create>>();
    const second = deferred<ReturnType<typeof xdb.create>>();
    vi.spyOn(xdb, 'createAsync')
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const onSaved = vi.fn();
    const form = mount(
      <AppScopeProvider value={scope}>
        <SmartForm fields={FIELDS} collection="items" onSaved={onSaved} />
      </AppScopeProvider>
    );
    try {
      act(() => submit(form.container));
      form.rerender(
        <AppScopeProvider value={scope}>
          <SmartForm fields={FIELDS} collection="other" onSaved={onSaved} />
        </AppScopeProvider>
      );
      act(() => submit(form.container));
      await act(async () => {
        first.reject(new Error('Old failure'));
        await first.promise.catch(() => {});
      });
      expect(form.container.querySelector('[role="alert"]')).toBeNull();
      expect(form.container.querySelector<HTMLButtonElement>('[type="submit"]')?.disabled).toBe(
        true
      );
      const stamp = '2026-09-12T00:00:00.000Z';
      const record = {
        id: 'new',
        collection: 'other',
        data: { title: 'new' },
        created_at: stamp,
        updated_at: stamp,
        deleted: false,
      };
      await act(async () => {
        second.resolve(record);
        await second.promise;
      });
      expect(onSaved).toHaveBeenCalledExactlyOnceWith(record);
      expect(form.container.querySelector<HTMLButtonElement>('[type="submit"]')?.disabled).toBe(
        false
      );
    } finally {
      form.unmount();
    }
  });

  it('allows only one in-flight submit even before the disabled state renders', async () => {
    const pending = deferred<void>();
    const onSubmit = vi.fn(() => pending.promise);
    const form = mount(<SmartForm fields={FIELDS} onSubmit={onSubmit} />);
    try {
      act(() => {
        submit(form.container);
        submit(form.container);
      });
      expect(onSubmit).toHaveBeenCalledTimes(1);
      await act(async () => {
        pending.resolve();
        await pending.promise;
      });
      await act(async () => submit(form.container));
      expect(onSubmit).toHaveBeenCalledTimes(2);
    } finally {
      form.unmount();
    }
  });

  it.each(['disabled', 'loading'] as const)('does not submit while %s', async (flag) => {
    const onSubmit = vi.fn();
    const form = mount(<SmartForm fields={FIELDS} onSubmit={onSubmit} {...{ [flag]: true }} />);
    try {
      await act(async () => submit(form.container));
      expect(onSubmit).not.toHaveBeenCalled();
    } finally {
      form.unmount();
    }
  });

  it('shows a save failure and clears it after a successful retry', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const onSubmit = vi
      .fn()
      .mockRejectedValueOnce(new Error('Storage is unavailable'))
      .mockResolvedValue(undefined);
    const form = mount(<SmartForm fields={FIELDS} onSubmit={onSubmit} />);
    try {
      await act(async () => submit(form.container));
      expect(form.container.querySelector('[role="alert"]')?.textContent).toContain(
        'Storage is unavailable'
      );
      await act(async () => submit(form.container));
      expect(form.container.querySelector('[role="alert"]')).toBeNull();
    } finally {
      form.unmount();
    }
  });

  it('edits only the named collection when another collection has the same record ID', async () => {
    const stamp = '2026-09-12T00:00:00.000Z';
    for (const collection of ['other', 'items']) {
      xdb.writeRecord(collection, {
        id: 'shared',
        collection,
        data: { title: collection },
        created_at: stamp,
        updated_at: stamp,
        deleted: false,
      });
    }
    const form = mount(
      <AppScopeProvider value={scope}>
        <SmartForm
          fields={FIELDS}
          collection="items"
          recordId="shared"
          data={{ title: 'updated' }}
        />
      </AppScopeProvider>
    );
    try {
      await act(async () => submit(form.container));
      expect(xdb.get('items', 'shared')?.data.title).toBe('updated');
      expect(xdb.get('other', 'shared')?.data.title).toBe('other');
    } finally {
      form.unmount();
    }
  });

  it('reports a missing edit record instead of calling onSaved with null', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const onSaved = vi.fn();
    const form = mount(
      <AppScopeProvider value={scope}>
        <SmartForm fields={FIELDS} collection="items" recordId="missing" onSaved={onSaved} />
      </AppScopeProvider>
    );
    try {
      await act(async () => submit(form.container));
      expect(onSaved).not.toHaveBeenCalled();
      expect(form.container.querySelector('[role="alert"]')?.textContent).toContain('not found');
    } finally {
      form.unmount();
    }
  });

  it('waits for desktop persistence and exposes a rejected write', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(xdb, 'isP2PAvailable').mockReturnValue(true);
    const pending = deferred<ReturnType<typeof xdb.create>>();
    const createAsync = vi.spyOn(xdb, 'createAsync').mockReturnValue(pending.promise);
    const optimisticCreate = vi.spyOn(xdb, 'create');
    const onSaved = vi.fn();
    const form = mount(
      <AppScopeProvider value={scope}>
        <SmartForm fields={FIELDS} collection="items" onSaved={onSaved} />
      </AppScopeProvider>
    );
    try {
      act(() => submit(form.container));
      expect(createAsync).toHaveBeenCalledOnce();
      expect(optimisticCreate).not.toHaveBeenCalled();
      expect(onSaved).not.toHaveBeenCalled();
      await act(async () => {
        pending.reject(new Error('Desktop write failed'));
        await pending.promise.catch(() => {});
      });
      expect(form.container.querySelector('[role="alert"]')?.textContent).toContain(
        'Desktop write failed'
      );
    } finally {
      form.unmount();
    }
  });
});
