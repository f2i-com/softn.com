/**
 * `:bind` on a component whose state is not called `value`.
 *
 * `:bind` gives a control the variable as `value` and writes back what its
 * `onChange` reports, or `checked` for a checkbox. A Modal has neither: it is
 * `open`, and it says it wants to be shut through `onClose`. So
 * `<Modal :bind={showAdd}>` handed the Modal a `value` it does not read and
 * an `onChange` it never calls, and every page that opens a dialog carried a
 * function whose whole body was `showAdd = false`, to pass as `onClose`. The
 * same for the tab that is showing, the page of a Pagination, the panels of
 * an Accordion that are open.
 *
 * Each such component is bound by the prop that holds its state and the
 * callback that changes it, so `:bind` is the one way to say "this variable
 * is that component's state", whatever the component calls it.
 */

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { parse } from '../src/parser';
import { renderDocument, ComponentRegistry } from '../src/renderer';
import type { SoftNProps, SoftNRenderContext } from '../src/types';

/** What the component under each tag was last given. */
const given: Record<string, SoftNProps> = {};

function registry(): ComponentRegistry {
  const r = new ComponentRegistry();
  for (const tag of ['Modal', 'Drawer', 'Confirm', 'Popover', 'Tooltip', 'Tabs', 'Pagination', 'Accordion', 'Sidebar', 'Collapse', 'Input']) {
    r.register(tag, (props: SoftNProps) => {
      given[tag] = props;
      return null;
    });
  }
  return r;
}

function draw(source: string, state: Record<string, unknown>, functions: Record<string, (...args: unknown[]) => unknown> = {}) {
  const doc = parse(source);
  expect(doc.diagnostics ?? [], source).toEqual([]);
  const setState = vi.fn((path: string, value: unknown) => {
    state[path] = value;
  });
  const context = { state, setState, data: {}, props: {}, functions, asyncFunctions: {}, computed: {} } as unknown as SoftNRenderContext;
  // React runs each component, which records what it was given.
  renderToStaticMarkup(React.createElement(React.Fragment, null, renderDocument(doc, context, registry())));
  return setState;
}

type Callback = (...args: unknown[]) => unknown;
const call = (tag: string, name: string, ...args: unknown[]) => (given[tag][name] as Callback)(...args);

describe('something that is open or shut', () => {
  it.each(['Modal', 'Drawer'])('<%s :bind> is open while the variable is true, and closing it writes false', (tag) => {
    const state = { show: true };
    const setState = draw(`<${tag} :bind={show} title="Add" />`, state);
    expect(given[tag].open).toBe(true);
    expect(given[tag]).not.toHaveProperty('value');
    expect(given[tag]).not.toHaveProperty('onChange');
    call(tag, 'onClose');
    expect(setState).toHaveBeenCalledWith('show', false);

    draw(`<${tag} :bind={show} title="Add" />`, { show: false });
    expect(given[tag].open).toBe(false);
    draw(`<${tag} :bind={show} title="Add" />`, {});
    expect(given[tag].open).toBe(false);
  });

  it('<Confirm :bind> is shut by either answer, and the answer is still told', () => {
    const remove = vi.fn();
    const state = { asking: true };
    const setState = draw('<Confirm :bind={asking} @confirm={remove} title="Delete?" />', state, { remove });
    expect(given.Confirm.open).toBe(true);
    call('Confirm', 'onCancel');
    expect(setState).toHaveBeenLastCalledWith('asking', false);
    expect(remove).not.toHaveBeenCalled();

    setState.mockClear();
    call('Confirm', 'onConfirm');
    expect(setState).toHaveBeenCalledWith('asking', false);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it.each(['Popover', 'Tooltip'])('<%s :bind> is told when it opens and when it shuts', (tag) => {
    const setState = draw(`<${tag} :bind={hint} />`, { hint: false });
    expect(given[tag].open).toBe(false);
    call(tag, 'onOpenChange', true);
    expect(setState).toHaveBeenLastCalledWith('hint', true);
    call(tag, 'onOpenChange', false);
    expect(setState).toHaveBeenLastCalledWith('hint', false);
  });

  it('a handler written beside the binding runs as well, after the variable is written', () => {
    const order: string[] = [];
    const state: Record<string, unknown> = { show: true };
    const tidy = () => order.push(`tidy saw ${String(state.show)}`);
    draw('<Modal :bind={show} @close={tidy} />', state, { tidy });
    call('Modal', 'onClose');
    expect(order).toEqual(['tidy saw false']);

    // Given as a prop, the way the examples write it, it is kept too.
    order.length = 0;
    state.show = true;
    draw('<Modal :bind={show} onClose={tidy} />', state, { tidy });
    call('Modal', 'onClose');
    expect(order).toEqual(['tidy saw false']);
  });

  it('<Collapse :bind> shows while the variable is true', () => {
    draw('<Collapse :bind={more} />', { more: true });
    expect(given.Collapse.isOpen).toBe(true);
  });
});

describe('something that holds which one', () => {
  it('<Tabs :bind> shows the tab the variable names and writes the tab chosen', () => {
    const setState = draw('<Tabs :bind={tab} />', { tab: 'billing' });
    expect(given.Tabs.activeKey).toBe('billing');
    expect(given.Tabs).not.toHaveProperty('value');
    call('Tabs', 'onChange', 'team');
    expect(setState).toHaveBeenCalledWith('tab', 'team');
  });

  it('<Pagination :bind> is on the page the variable holds', () => {
    const setState = draw('<Pagination :bind={page} totalPages={9} />', { page: 3 });
    expect(given.Pagination.currentPage).toBe(3);
    call('Pagination', 'onPageChange', 4);
    expect(setState).toHaveBeenCalledWith('page', 4);
  });

  it('<Accordion :bind> has open the panels the variable lists', () => {
    const setState = draw('<Accordion :bind={openPanels} />', { openPanels: ['a'] });
    expect(given.Accordion.openKeys).toEqual(['a']);
    call('Accordion', 'onChange', ['a', 'b']);
    expect(setState).toHaveBeenCalledWith('openPanels', ['a', 'b']);
  });

  it('<Sidebar :bind> is collapsed while the variable is true', () => {
    const setState = draw('<Sidebar :bind={narrow} />', { narrow: false });
    expect(given.Sidebar.collapsed).toBe(false);
    call('Sidebar', 'onCollapse', true);
    expect(setState).toHaveBeenCalledWith('narrow', true);
  });

  it('a row of a list is written where it is', () => {
    const state = { panels: [{ open: false }, { open: true }] };
    const doc = '<div>#each (panel in panels)\n<Modal :bind={panel.open} />\n#end</div>';
    const setState = draw(doc, state);
    call('Modal', 'onClose');
    expect(setState).toHaveBeenCalledWith('panels[1].open', false);
  });
});

describe('a control that holds a value', () => {
  it('is bound as it was', () => {
    const setState = draw('<Input :bind={name} />', { name: 'Ada' });
    expect(given.Input.value).toBe('Ada');
    call('Input', 'onChange', 'Grace');
    expect(setState).toHaveBeenCalledWith('name', 'Grace');
  });

  it('keeps an onChange given as a prop beside the binding', () => {
    const note = vi.fn();
    const setState = draw('<Input :bind={name} onChange={note} />', { name: 'Ada' }, { note });
    call('Input', 'onChange', 'Grace');
    expect(setState).toHaveBeenCalledWith('name', 'Grace');
    expect(note).toHaveBeenCalledWith('Grace');
  });
});
