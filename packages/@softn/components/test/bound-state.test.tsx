/**
 * `:bind` on the components that hold a state of their own name, drawn from
 * a page with the real components.
 *
 * The renderer binds a Modal by `open` and `onClose`, Tabs by `activeKey`
 * and `onChange`, and so on (core's renderer-bind-state.test.tsx holds the
 * table). This holds the other half: that those are the props these
 * components read and the callbacks they call, by doing what a person does.
 */

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ComponentRegistry, parse, renderDocument, type SoftNComponent, type SoftNRenderContext } from '@softn/core';
import { act } from 'react';
import { click, mount } from './dom';
import { builtinComponents } from '../src/registry';

const registry = new ComponentRegistry();
registry.registerAll(builtinComponents as unknown as Record<string, SoftNComponent>);

/** A page of `source` over `state`, mounted; `write` is told every write to state. */
function page(source: string, state: Record<string, unknown>, functions: Record<string, (...args: unknown[]) => unknown> = {}) {
  const doc = parse(source);
  expect(doc.diagnostics ?? [], source).toEqual([]);
  const write = vi.fn();
  const context = { state, setState: write, data: {}, props: {}, computed: {}, functions, asyncFunctions: {} } as unknown as SoftNRenderContext;
  return { write, ...mount(<>{renderDocument(doc, context, registry)}</>) };
}

function press(key: string): void {
  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

const button = (root: ParentNode, label: string | RegExp) =>
  Array.from(root.querySelectorAll('button')).find((b) =>
    typeof label === 'string' ? (b.textContent ?? '').trim() === label || b.getAttribute('aria-label') === label : label.test(b.getAttribute('aria-label') ?? b.textContent ?? '')
  ) as HTMLButtonElement | undefined;

describe('a dialog bound to a variable', () => {
  it('a Modal is open while it is true, and Escape writes false', () => {
    const { write, unmount } = page('<Modal :bind={adding} title="New task"><Text>Fields</Text></Modal>', { adding: true });
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    press('Escape');
    expect(write).toHaveBeenCalledWith('adding', false);
    unmount();
  });

  it('a Modal is not drawn while it is false', () => {
    const { unmount } = page('<Modal :bind={adding} title="New task"><Text>Fields</Text></Modal>', { adding: false });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    unmount();
  });

  it('a Confirm is shut by Cancel, and by the answer after the answer is told', () => {
    const order: string[] = [];
    const remove = () => order.push('removed');
    const { write, unmount } = page('<Confirm :bind={asking} title="Delete this?" confirmText="Delete" @confirm={remove} />', { asking: true }, { remove });
    write.mockImplementation(() => order.push('shut'));
    click(button(document, 'Cancel')!);
    expect(order).toEqual(['shut']);
    order.length = 0;
    click(button(document, 'Delete')!);
    expect(order).toEqual(['shut', 'removed']);
    expect(write).toHaveBeenLastCalledWith('asking', false);
    unmount();
  });
});

describe('a choice bound to a variable', () => {
  it('Tabs show the tab it names and write the tab that is picked', () => {
    const { write, container, unmount } = page(
      '<Tabs :bind={tab} tabs={[{ key: "profile", label: "Profile" }, { key: "billing", label: "Billing" }]} />',
      { tab: 'billing' }
    );
    const tabs = Array.from(container.querySelectorAll('[role="tab"]')) as HTMLElement[];
    expect(tabs.map((t) => [t.textContent, t.getAttribute('aria-selected')])).toEqual([['Profile', 'false'], ['Billing', 'true']]);
    click(tabs[0]);
    expect(write).toHaveBeenCalledWith('tab', 'profile');
    unmount();
  });

  it('a Pagination is on the page it holds and writes the page that is picked', () => {
    const { write, container, unmount } = page('<Pagination :bind={page} totalPages={5} />', { page: 2 });
    expect(container.querySelector('[aria-current="page"]')?.textContent).toBe('2');
    click(button(container, /next/i)!);
    expect(write).toHaveBeenCalledWith('page', 3);
    unmount();
  });
});
