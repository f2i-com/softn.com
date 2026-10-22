/**
 * SmartGrid edit-form regressions.
 *
 * The grid is how most SoftN apps write data, so a value it mangles is a value
 * the whole app is then wrong about.
 */

import { act } from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, click, type, byText } from './dom';
import { SmartGrid } from '../src/smart/SmartGrid';

beforeEach(() => {
  document.body.innerHTML = '';
});

const SERVICES = [
  { id: '1', name: 'Cut', price: 65, duration: 45 },
  { id: '2', name: 'Colour', price: 120, duration: 90 },
];

/** Open the edit form for the first row. */
function openEditor(container: HTMLElement) {
  const edit = Array.from(container.querySelectorAll('button')).find(
    (b) =>
      /edit|✏|✎/i.test(b.textContent ?? '') ||
      b.getAttribute('title')?.toLowerCase().includes('edit')
  );
  click(edit);
}

describe('editing a numeric column', () => {
  it('reports a number, not the string the DOM handed back', () => {
    // `target.value` is always a string. Saving "50" for a price made the
    // grid's own numeric sort fall back to string compare ("100" before "50")
    // and left currency() rendering a blank cell — both silent.
    let saved: Record<string, unknown> | undefined;
    const { container } = mount(
      <SmartGrid
        data={SERVICES}
        columns="name, price, duration"
        editable
        onEdit={(_row, data) => {
          saved = data as Record<string, unknown>;
        }}
      />
    );

    openEditor(container);
    const numbers = container.querySelectorAll<HTMLInputElement>('input[type=number]');
    expect(numbers.length).toBeGreaterThan(0);

    type(numbers[0], '50');
    click(byText(container, /^Save$/i));

    expect(saved).toBeDefined();
    expect(saved!.price).toBe(50);
    expect(typeof saved!.price).toBe('number');
  });

  it('leaves a cleared numeric field empty rather than calling it zero', () => {
    let saved: Record<string, unknown> | undefined;
    const { container } = mount(
      <SmartGrid
        data={SERVICES}
        columns="name, price, duration"
        editable
        onEdit={(_row, data) => {
          saved = data as Record<string, unknown>;
        }}
      />
    );

    openEditor(container);
    const numbers = container.querySelectorAll<HTMLInputElement>('input[type=number]');
    type(numbers[0], '');
    click(byText(container, /^Save$/i));

    expect(saved).toBeDefined();
    expect(saved!.price).toBe('');
  });

  it('leaves a text column as text', () => {
    let saved: Record<string, unknown> | undefined;
    const { container } = mount(
      <SmartGrid
        data={SERVICES}
        columns="name, price, duration"
        editable
        onEdit={(_row, data) => {
          saved = data as Record<string, unknown>;
        }}
      />
    );

    openEditor(container);
    const text = container.querySelector<HTMLInputElement>('input[type=text]');
    type(text, 'Trim');
    click(byText(container, /^Save$/i));

    expect(saved!.name).toBe('Trim');
  });
});

describe('sorting missing values', () => {
  it('keeps nullish rows stable and last in both directions', () => {
    const rows = [
      { id: 'missing-a', name: 'Missing A', rank: null },
      { id: 'two', name: 'Two', rank: 2 },
      { id: 'missing-b', name: 'Missing B', rank: undefined },
      { id: 'one', name: 'One', rank: 1 },
    ];
    const { container } = mount(<SmartGrid data={rows} columns="name, rank" sortable />);
    const rankHeader = Array.from(container.querySelectorAll('th')).find((header) =>
      header.textContent?.includes('Rank')
    )!;
    const names = () =>
      Array.from(container.querySelectorAll('tbody tr')).map(
        (row) => row.querySelector('td')?.textContent
      );

    click(rankHeader);
    expect(names()).toEqual(['One', 'Two', 'Missing A', 'Missing B']);

    click(rankHeader);
    expect(names()).toEqual(['Two', 'One', 'Missing A', 'Missing B']);
  });
});

describe('dialog focus and keyboard behavior', () => {
  it('focuses and traps the add form, closes on Escape, and restores its trigger', () => {
    const { container } = mount(
      <SmartGrid data={SERVICES} columns="name, price" add onAdd={vi.fn()} />
    );
    const addButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Add New')
    )!;
    addButton.focus();
    click(addButton);

    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
    const firstInput = dialog.querySelector<HTMLInputElement>('input')!;
    const buttons = dialog.querySelectorAll<HTMLButtonElement>('button');
    const lastButton = buttons[buttons.length - 1];
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(firstInput);

    firstInput.focus();
    act(() =>
      firstInput.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Tab',
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        })
      )
    );
    expect(document.activeElement).toBe(lastButton);

    act(() =>
      lastButton.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
      )
    );
    expect(document.activeElement).toBe(firstInput);

    act(() =>
      firstInput.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      )
    );
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(addButton);
  });

  it('focuses the safe action in delete confirmation and restores the delete trigger', () => {
    const { container } = mount(
      <SmartGrid data={SERVICES} columns="name" delete onDelete={vi.fn()} />
    );
    const deleteButton = container.querySelector<HTMLButtonElement>('button[title="Delete"]')!;
    deleteButton.focus();
    click(deleteButton);

    const dialog = container.querySelector<HTMLElement>('[role="alertdialog"]')!;
    const cancelButton = Array.from(dialog.querySelectorAll('button')).find(
      (button) => button.textContent === 'Cancel'
    )!;
    expect(document.activeElement).toBe(cancelButton);

    act(() =>
      cancelButton.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      )
    );
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(document.activeElement).toBe(deleteButton);
  });
});

// A save closed whatever dialog was open when it came back: save row A,
// Cancel, Edit row B and type, and A's save shut B's dialog with the typing.
describe('a save that comes back late', () => {
  function pendingGrid() {
    const answer: Array<() => void> = [];
    const onEdit = vi.fn(() => new Promise<void>((resolve) => answer.push(resolve)));
    const view = mount(<SmartGrid data={SERVICES} columns="name, price" editable onEdit={onEdit} />);
    const editButtons = () =>
      Array.from(view.container.querySelectorAll('button')).filter(
        (b) => /edit|✏|✎/i.test(b.textContent ?? '') || b.getAttribute('title')?.toLowerCase().includes('edit')
      );
    const nameField = () => view.container.querySelector<HTMLInputElement>('[role="dialog"] input[type=text]');
    const settle = (index: number) =>
      act(async () => {
        answer[index]();
        await Promise.resolve();
        await Promise.resolve();
      });
    return { ...view, editButtons, nameField, settle };
  }

  it('leaves open the dialog opened after it', async () => {
    const grid = pendingGrid();
    click(grid.editButtons()[0]);
    click(byText(grid.container, /^Save$/i));
    click(byText(grid.container, /^Cancel$/i));
    click(grid.editButtons()[1]);
    type(grid.nameField(), 'Dye');
    await grid.settle(0);
    expect(grid.nameField()?.value).toBe('Dye');
  });

  it('stays open when more was typed in it while it saved', async () => {
    const grid = pendingGrid();
    click(grid.editButtons()[0]);
    click(byText(grid.container, /^Save$/i));
    type(grid.nameField(), 'Trim');
    await grid.settle(0);
    expect(grid.nameField()?.value).toBe('Trim');
  });

  it('leaves open an Add opened again while the last one saved', async () => {
    const answer: Array<() => void> = [];
    const onAdd = vi.fn(() => new Promise<void>((resolve) => answer.push(resolve)));
    const { container } = mount(<SmartGrid data={SERVICES} columns="name, price" add onAdd={onAdd} />);
    const addButton = () =>
      Array.from(container.querySelectorAll('button')).find((button) => /add/i.test(button.textContent ?? ''))!;
    click(addButton());
    type(container.querySelector<HTMLInputElement>('[role="dialog"] input[type=text]'), 'Wash');
    click(byText(container, /^Save$/i));
    click(byText(container, /^Cancel$/i));
    click(addButton());
    await act(async () => {
      answer[0]();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it('closes when nothing changed while it saved', async () => {
    const grid = pendingGrid();
    click(grid.editButtons()[0]);
    click(byText(grid.container, /^Save$/i));
    await grid.settle(0);
    expect(grid.container.querySelector('[role="dialog"]')).toBeNull();
  });
});
