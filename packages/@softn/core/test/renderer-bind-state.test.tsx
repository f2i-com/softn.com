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
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { parse } from '../src/parser';
import { renderDocument, ComponentRegistry } from '../src/renderer';
import type { SoftNProps, SoftNRenderContext } from '../src/types';
import { click, drawPage, removeDrawnPages } from './helpers/drawn-page';

/** What the component under each tag was last given. */
const given: Record<string, SoftNProps> = {};

function registry(): ComponentRegistry {
  const r = new ComponentRegistry();
  for (const tag of ['Modal', 'Drawer', 'Confirm', 'Popover', 'Tooltip', 'Tabs', 'Pagination', 'Accordion', 'Sidebar', 'Collapse', 'Toast', 'FileChooser', 'Input', 'Controls', 'DPad']) {
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

  it('<Toast :bind> is shown while the variable is true, and its closing writes false', () => {
    const setState = draw('<Toast :bind={saved} message="Saved" />', { saved: true });
    expect(given.Toast.isVisible).toBe(true);
    expect(given.Toast).not.toHaveProperty('value');
    expect(given.Toast).not.toHaveProperty('onChange');
    // Its time is up, or it was dismissed: the toast says so with nothing.
    call('Toast', 'onClose');
    expect(setState).toHaveBeenCalledWith('saved', false);

    draw('<Toast :bind={saved} message="Saved" />', { saved: false });
    expect(given.Toast.isVisible).toBe(false);
    draw('<Toast :bind={saved} message="Saved" />', {});
    expect(given.Toast.isVisible).toBe(false);
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

  it('<FileChooser :bind> shows the files the variable holds and writes the files chosen', () => {
    const first = { name: 'a.txt', size: 1, type: 'text/plain', ref: 'r1' };
    const second = { name: 'b.txt', size: 2, type: 'text/plain', ref: 'r2' };
    const files = [first];
    const setState = draw('<FileChooser :bind={files} multiple />', { files });
    expect(given.FileChooser.value).toBe(files);
    expect(given.FileChooser).not.toHaveProperty('onChange');
    call('FileChooser', 'onSelect', [first, second]);
    expect(setState).toHaveBeenLastCalledWith('files', [first, second]);
    // The person takes them back: the chooser hands over what is left, none.
    call('FileChooser', 'onSelect', []);
    expect(setState).toHaveBeenLastCalledWith('files', []);

    // A variable not set yet gives no list, and the chooser shows its own.
    draw('<FileChooser :bind={files} />', {});
    expect(given.FileChooser.value).toBeUndefined();
  });
});

describe('what the player holds', () => {
  // One record for keys, a gamepad and touch: each component is handed the
  // record and hands back the next one.
  it.each(['Controls', 'DPad'])('<%s :bind> is handed the record, and writes the record it hands back', (tag) => {
    const pad = { left: false, presses: { left: 0 } };
    const setState = draw(`<${tag} :bind={pad} />`, { pad });
    expect(given[tag].value).toBe(pad);
    const next = { left: true, presses: { left: 1 } };
    call(tag, 'onChange', next);
    expect(setState).toHaveBeenLastCalledWith('pad', next);

    // A variable not set yet is nothing, not the empty text a field starts with.
    draw(`<${tag} :bind={pad} />`, {});
    expect(given[tag].value).toBeUndefined();
  });

  it('a handler written beside the binding still hears each press', () => {
    const heard = vi.fn();
    draw('<Controls :bind={pad} @press={heard} keys={{ fire: "Space" }} />', { pad: {} }, { heard });
    call('Controls', 'onPress', 'fire');
    expect(heard).toHaveBeenCalledWith('fire');
    expect(given.Controls.keys).toEqual({ fire: 'Space' });
  });
});

describe('a toast and a file chooser bound on a page that is drawn again', () => {
  afterEach(removeDrawnPages);

  // Stand-ins with the props the components take: `isVisible` and `onClose`;
  // `value` and `onSelect`.
  const standIns = (r: ComponentRegistry) => {
    r.register('Toast', ({ isVisible, onClose, message }: { isVisible?: boolean; onClose?: () => void; message?: string }) =>
      isVisible ? (
        <div role="status">
          {message}
          <button type="button" id="dismiss" onClick={() => onClose?.()}>
            dismiss
          </button>
        </div>
      ) : null
    );
    type Info = { name: string; ref: string };
    r.register('FileChooser', ({ value, onSelect }: { value?: Info[] | null; onSelect?: (files: Info[]) => void }) => (
      <div>
        <button type="button" id="choose" onClick={() => onSelect?.([{ name: 'a.txt', ref: 'r1' }, { name: 'b.txt', ref: 'r2' }])}>
          choose
        </button>
        <button type="button" id="remove" onClick={() => onSelect?.([])}>
          remove
        </button>
        <span id="chosen">{(value ?? []).map((info) => info.name).join(',')}</span>
      </div>
    ));
  };

  it('a Toast hides itself, writes false, and shows again the next time the variable is true', () => {
    const { writes, state, all, one } = drawPage('<button id="save" @click={saved = true}>save</button><Toast :bind={saved} message="Saved" />', { saved: false }, {
      register: standIns,
    });
    expect(all('[role=status]')).toHaveLength(0);
    click(one('#save'));
    expect(all('[role=status]')).toHaveLength(1);
    click(one('#dismiss'));
    expect(state().saved).toBe(false);
    expect(all('[role=status]')).toHaveLength(0);
    click(one('#save'));
    expect(all('[role=status]')).toHaveLength(1);
    expect(writes).toEqual([['saved', true], ['saved', false], ['saved', true]]);
  });

  it('a FileChooser keeps the chosen files in the variable, and none once they are removed', () => {
    const { state, text, one } = drawPage('<FileChooser :bind={files} multiple /><p>{files.length}</p>', { files: [] }, { register: standIns });
    expect(text('#chosen')).toBe('');
    click(one('#choose'));
    expect(state().files).toEqual([{ name: 'a.txt', ref: 'r1' }, { name: 'b.txt', ref: 'r2' }]);
    expect(text('#chosen')).toBe('a.txt,b.txt');
    expect(text('p')).toBe('2');
    click(one('#remove'));
    expect(state().files).toEqual([]);
    expect(text('#chosen')).toBe('');
    expect(text('p')).toBe('0');
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
