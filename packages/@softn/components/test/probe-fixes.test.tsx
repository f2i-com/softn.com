/**
 * Faults a reviewer's probes found, each pinned by what a person meets: a
 * filter that would not take what was typed, Tab leaving a drawer through
 * its radios, tabs and a tree that arrived empty and stayed that way, a cell
 * that would not edit, an alert that stayed dismissed over a new message, an
 * avatar that kept its initials over a new picture, a direction left held,
 * a split pane drawn at nothing, and a form that saved without its defaults.
 */

import { act, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type, click } from './dom';
import { DataGrid } from '../src/data/DataGrid';
import { Drawer } from '../src/feedback/Drawer';
import { Radio } from '../src/form/Radio';
import { Tabs } from '../src/navigation/Tabs';
import { TreeView, type TreeNode } from '../src/data/TreeView';
import { Alert } from '../src/feedback/Alert';
import { Avatar } from '../src/display/Avatar';
import { DPad } from '../src/utility/DPad';
import { Split } from '../src/layout/Split';
import { SmartForm } from '../src/smart/SmartForm';

afterEach(() => {
  document.body.innerHTML = '';
});

const key = (target: Element, name: string, init: KeyboardEventInit = {}, kind = 'keydown'): KeyboardEvent => {
  const event = new KeyboardEvent(kind, { key: name, bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
};

describe('a DataGrid’s filters, when the page does not pass them back', () => {
  const columns = [
    { key: 'name', header: 'Name', filterable: true },
    { key: 'team', header: 'Team', filterable: true },
  ];
  const data = [{ id: 1, name: 'Ada', team: 'Core' }];

  it('keep what was typed, and report every column’s', () => {
    const onFilterChange = vi.fn();
    const { container } = mount(<DataGrid columns={columns} data={data} onFilterChange={onFilterChange} />);
    click(container.querySelector('button[aria-label="Show filters"]'));
    const name = container.querySelector<HTMLInputElement>('input[aria-label="Filter Name"]')!;
    type(name, 'A');
    type(name, 'Ad');
    expect(name.value).toBe('Ad');
    expect(onFilterChange).toHaveBeenLastCalledWith({ name: 'Ad' });
    type(container.querySelector<HTMLInputElement>('input[aria-label="Filter Team"]'), 'C');
    expect(onFilterChange).toHaveBeenLastCalledWith({ name: 'Ad', team: 'C' });
  });

  it('still show the page’s own when it passes them', () => {
    const onFilterChange = vi.fn();
    const { container } = mount(<DataGrid columns={columns} data={data} filters={{ name: 'Li' }} onFilterChange={onFilterChange} />);
    click(container.querySelector('button[aria-label="Show filters"]'));
    const name = container.querySelector<HTMLInputElement>('input[aria-label="Filter Name"]')!;
    expect(name.value).toBe('Li');
    type(name, 'Lin');
    expect(onFilterChange).toHaveBeenLastCalledWith({ name: 'Lin' });
    // The page did not take it, so the field shows what the page says.
    expect(name.value).toBe('Li');
  });
});

describe('a DataGrid column that is editable with no editor of its own', () => {
  const data = [{ id: 1, name: 'Ada', age: 36 }];
  const columns = [
    { key: 'name', header: 'Name', editable: true },
    { key: 'age', header: 'Age', editable: true },
  ];
  const cells = (container: HTMLElement) => container.querySelectorAll<HTMLElement>('[role="rowgroup"] [role="cell"]');

  it('opens a text field from Enter, saves on Enter, and gives focus back to the cell', () => {
    const onCellEdit = vi.fn();
    const { container } = mount(<DataGrid columns={columns} data={data} onCellEdit={onCellEdit} virtualized={false} />);
    const cell = cells(container)[0];
    expect(cell.tabIndex).toBe(0);
    cell.focus();
    key(cell, 'Enter');
    const field = container.querySelector<HTMLInputElement>('input[aria-label="Edit Name"]')!;
    expect(field).not.toBeNull();
    expect(field.value).toBe('Ada');
    expect(document.activeElement).toBe(field);
    type(field, 'Ada L');
    key(field, 'Enter');
    expect(onCellEdit).toHaveBeenCalledWith(1, 'name', 'Ada L');
    expect(container.querySelector('input[aria-label="Edit Name"]')).toBeNull();
    expect(document.activeElement).toBe(cells(container)[0]);
  });

  it('opens from a double click, and keeps a number a number', () => {
    const onCellEdit = vi.fn();
    const { container } = mount(<DataGrid columns={columns} data={data} onCellEdit={onCellEdit} virtualized={false} />);
    act(() => {
      cells(container)[1].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    const field = container.querySelector<HTMLInputElement>('input[aria-label="Edit Age"]')!;
    type(field, '40');
    key(field, 'Enter');
    expect(onCellEdit).toHaveBeenCalledWith(1, 'age', 40);
  });

  it('puts the cell back on Escape, without the page hearing of it or a dialog closing', () => {
    const onCellEdit = vi.fn();
    const { container } = mount(<DataGrid columns={columns} data={data} onCellEdit={onCellEdit} virtualized={false} />);
    const cell = cells(container)[0];
    cell.focus();
    key(cell, 'Enter');
    const field = container.querySelector<HTMLInputElement>('input[aria-label="Edit Name"]')!;
    type(field, 'nope');
    expect(key(field, 'Escape').defaultPrevented).toBe(true);
    expect(onCellEdit).not.toHaveBeenCalled();
    expect(cells(container)[0].textContent).toBe('Ada');
    expect(document.activeElement).toBe(cells(container)[0]);
  });

  it('does not select the row when the field is clicked', () => {
    const onSelectionChange = vi.fn();
    const { container } = mount(
      <DataGrid columns={columns} data={data} onCellEdit={() => {}} selectionMode="single" onSelectionChange={onSelectionChange} virtualized={false} />
    );
    const cell = cells(container)[0];
    key(cell, 'Enter');
    click(container.querySelector('input[aria-label="Edit Name"]'));
    expect(onSelectionChange).not.toHaveBeenCalled();
  });
});

describe('Tab in a Drawer that ends with a group of radios', () => {
  function open(defaultValue?: string) {
    mount(
      <Drawer open onClose={() => {}} title="Size">
        <Radio name="size" options={['S', 'M', 'L'].map((size) => ({ value: size, label: size }))} defaultValue={defaultValue} />
      </Drawer>
    );
    const radios = [...document.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    const close = document.querySelector<HTMLButtonElement>('button[aria-label="Close drawer"]')!;
    return { radios, close };
  }

  it('wraps from the checked radio, the group’s one stop, to the first control', () => {
    const { radios, close } = open('M');
    radios[1].focus();
    expect(key(radios[1], 'Tab').defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(close);
  });

  it('comes back with Shift+Tab to the checked radio, not the group’s last', () => {
    const { radios, close } = open('M');
    close.focus();
    key(close, 'Tab', { shiftKey: true });
    expect(document.activeElement).toBe(radios[1]);
  });

  it('takes the first radio as the stop when none is checked, wherever focus is in the group', () => {
    const { radios, close } = open();
    close.focus();
    key(close, 'Tab', { shiftKey: true });
    expect(document.activeElement).toBe(radios[0]);
    radios[2].focus();
    expect(key(radios[2], 'Tab').defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(close);
  });
});

describe('Tabs whose tabs arrive after the first draw', () => {
  const tabs = [
    { key: 'a', label: 'A', content: 'Panel A' },
    { key: 'b', label: 'B', content: 'Panel B' },
  ];
  const selected = (container: HTMLElement) =>
    [...container.querySelectorAll('[role="tab"]')].filter((t) => t.getAttribute('aria-selected') === 'true').map((t) => t.textContent);

  it('select the first and show its panel', () => {
    const onChange = vi.fn();
    const { container, rerender } = mount(<Tabs tabs={undefined as never} onChange={onChange} />);
    rerender(<Tabs tabs={tabs} onChange={onChange} />);
    expect(selected(container)).toEqual(['A']);
    expect(container.querySelector('[role="tabpanel"]')?.textContent).toBe('Panel A');
    // Nothing was chosen, so the page is not told of a change.
    expect(onChange).not.toHaveBeenCalled();
    click(container.querySelectorAll('[role="tab"]')[1]);
    expect(selected(container)).toEqual(['B']);
  });

  it('select the default the page named, once its tab is there', () => {
    const { container, rerender } = mount(<Tabs tabs={[]} defaultActiveKey="b" />);
    rerender(<Tabs tabs={tabs} defaultActiveKey="b" />);
    expect(selected(container)).toEqual(['B']);
    expect(container.querySelector('[role="tabpanel"]')?.textContent).toBe('Panel B');
  });

  it('pass over a first tab that is disabled', () => {
    const { container, rerender } = mount(<Tabs tabs={[]} />);
    rerender(<Tabs tabs={[{ key: 'x', label: 'X', disabled: true }, ...tabs]} />);
    expect(selected(container)).toEqual(['A']);
  });
});

describe('a TreeView with defaultExpandAll whose nodes arrive later', () => {
  const item = (c: HTMLElement, id: string) => c.querySelector<HTMLElement>(`[data-tree-id="${id}"]`);
  const first: TreeNode[] = [{ id: 'a', label: 'A', children: [{ id: 'a1', label: 'A1', children: [{ id: 'a2', label: 'A2' }] }] }];

  it('opens them, and leaves closed what the person closed', () => {
    const { container, rerender } = mount(<TreeView nodes={[]} defaultExpandAll />);
    rerender(<TreeView nodes={first} defaultExpandAll />);
    expect(item(container, 'a')?.getAttribute('aria-expanded')).toBe('true');
    expect(item(container, 'a1')?.getAttribute('aria-expanded')).toBe('true');
    expect(item(container, 'a2')).not.toBeNull();

    key(item(container, 'a')!, 'ArrowLeft');
    expect(item(container, 'a')?.getAttribute('aria-expanded')).toBe('false');

    // The same nodes again, with one more that has children of its own.
    const more: TreeNode[] = [
      { id: 'a', label: 'A', children: [{ id: 'a1', label: 'A1', children: [{ id: 'a2', label: 'A2' }] }] },
      { id: 'b', label: 'B', children: [{ id: 'b1', label: 'B1' }] },
    ];
    rerender(<TreeView nodes={more} defaultExpandAll />);
    expect(item(container, 'a')?.getAttribute('aria-expanded')).toBe('false');
    expect(item(container, 'b')?.getAttribute('aria-expanded')).toBe('true');
    expect(item(container, 'b1')).not.toBeNull();
  });

  it('leaves them closed without defaultExpandAll', () => {
    const { container, rerender } = mount(<TreeView nodes={[]} />);
    rerender(<TreeView nodes={first} />);
    expect(item(container, 'a')?.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('a dismissed Alert', () => {
  const dismiss = (container: HTMLElement) => click(container.querySelector('button'));

  it('comes back when its message changes, and only then', () => {
    const { container, rerender } = mount(<Alert dismissible title="Sync">Saved</Alert>);
    dismiss(container);
    expect(container.textContent).toBe('');
    // The page drawn again with the same message, written inline.
    rerender(<Alert dismissible title="Sync"><b>Saved</b></Alert>);
    expect(container.textContent).toBe('');
    rerender(<Alert dismissible title="Sync">Failed</Alert>);
    expect(container.textContent).toContain('Failed');
    dismiss(container);
    rerender(<Alert dismissible title="Sync again">Failed</Alert>);
    expect(container.textContent).toContain('Sync again');
  });
});

describe('an Avatar whose picture failed', () => {
  it('tries the next picture it is given', () => {
    const { container, rerender } = mount(<Avatar src="https://example.com/a.png" name="Ada Lovelace" />);
    act(() => {
      container.querySelector('img')!.dispatchEvent(new Event('error'));
    });
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('AL');
    rerender(<Avatar src="https://example.com/b.png" name="Ada Lovelace" />);
    expect(container.querySelector('img')?.getAttribute('src')).toBe('https://example.com/b.png');
  });
});

describe('a DPad hidden while a direction is held', () => {
  it('lets the direction go', () => {
    const onPress = vi.fn();
    const onRelease = vi.fn();
    const { container, rerender, unmount } = mount(<DPad onPress={onPress} onRelease={onRelease} />);
    // Held from the keyboard on a button that never had focus, so nothing
    // but the pad itself can send the release.
    key(container.querySelector('button[aria-label="Up"]')!, 'Enter');
    expect(onPress).toHaveBeenCalledWith('up');
    rerender(<DPad onPress={onPress} onRelease={onRelease} visible={false} />);
    expect(onRelease).toHaveBeenCalledTimes(1);
    expect(onRelease).toHaveBeenCalledWith('up');
    rerender(<DPad onPress={onPress} onRelease={onRelease} />);
    unmount();
    expect(onRelease).toHaveBeenCalledTimes(1);
  });
});

describe('a Split first drawn where it has no room', () => {
  let observers: Array<{ element: Element; notify: () => void; live: boolean }> = [];

  beforeEach(() => {
    observers = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        private entries: Array<{ element: Element; notify: () => void; live: boolean }> = [];
        constructor(private callback: () => void) {}
        observe(element: Element) {
          const entry = { element, notify: () => entry.live && this.callback(), live: true };
          this.entries.push(entry);
          observers.push(entry);
        }
        unobserve() {}
        disconnect() {
          for (const entry of this.entries) entry.live = false;
        }
      }
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('takes its share once it is shown, and keeps where it was moved to', () => {
    const { container } = mount(
      <Split minSize={50}>
        <div>left</div>
        <div>right</div>
      </Split>
    );
    const root = container.firstElementChild as HTMLElement;
    const pane = root.firstElementChild as HTMLElement;
    const separator = container.querySelector<HTMLElement>('[role="separator"]')!;
    // Hidden, it has no width: the pane is drawn at its share as written.
    expect(pane.style.width).toBe('50%');

    Object.defineProperty(root, 'offsetWidth', { configurable: true, value: 800 });
    act(() => {
      for (const observer of observers) if (observer.element === root) observer.notify();
    });
    expect(pane.style.width).toBe('400px');
    expect(separator.getAttribute('aria-valuenow')).toBe('400');

    key(separator, 'ArrowRight');
    Object.defineProperty(root, 'offsetWidth', { configurable: true, value: 1000 });
    act(() => {
      for (const observer of observers) observer.notify();
    });
    expect(pane.style.width).toBe('410px');
  });
});

describe('SmartForm’s defaults', () => {
  const submit = (container: HTMLElement) =>
    act(() => {
      container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

  it('go with a new record, under what the data and a field’s own default say', () => {
    const onSubmit = vi.fn();
    const { container } = mount(
      <SmartForm
        fields={[{ name: 'name', type: 'text' }, { name: 'tier', type: 'text', defaultValue: 'gold' }]}
        data={{ visits: 3 }}
        defaults={{ visits: 0, totalSpent: 0, vip: false, tier: 'basic' }}
        onSubmit={onSubmit}
      />
    );
    type(container.querySelector<HTMLInputElement>('input[name="name"]'), 'Ada');
    submit(container);
    expect(onSubmit).toHaveBeenCalledWith({ name: 'Ada', tier: 'gold', visits: 3, totalSpent: 0, vip: false });
  });

  it('written inline, do not put back what was typed when the page redraws', () => {
    const onSubmit = vi.fn();
    function Page() {
      const [, setSeen] = useState(0);
      return (
        <SmartForm fields="name:text" defaults={{ visits: 0 }} onChange={() => setSeen((n) => n + 1)} onSubmit={onSubmit} />
      );
    }
    const { container } = mount(<Page />);
    const field = container.querySelector<HTMLInputElement>('input[name="name"]')!;
    type(field, 'Ada');
    expect(field.value).toBe('Ada');
    submit(container);
    expect(onSubmit).toHaveBeenCalledWith({ visits: 0, name: 'Ada' });
  });

  it('are not written over a record being edited', () => {
    const onSubmit = vi.fn();
    const { container } = mount(
      <SmartForm fields="name:text" recordId="r1" data={{ name: 'Ada' }} defaults={{ visits: 0 }} onSubmit={onSubmit} />
    );
    submit(container);
    expect(onSubmit).toHaveBeenCalledWith({ name: 'Ada' });
  });
});
