/**
 * Audit round 3 (2026-11-27): the form, data, feedback, navigation, layout
 * and display components.
 *
 * Each test below failed before the fix beside it. They are about what a
 * person does (a drag that ends outside a dialog, a press on the calendar's
 * heading, a list from a store with a hole in it) and what an app is told.
 */

import React, { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { click, mount, type, type Mounted } from './dom';
import { Modal } from '../src/feedback/Modal';
import { DatePicker } from '../src/form/DatePicker';
import { TreeView, type TreeNode } from '../src/data/TreeView';
import { Slider } from '../src/form/Slider';
import { Select } from '../src/form/Select';
import { Accordion } from '../src/utility/Accordion';
import { Table } from '../src/data/Table';
import { DataGrid } from '../src/data/DataGrid';
import { Toast } from '../src/feedback/Toast';
import { Button } from '../src/form/Button';
import { Input } from '../src/form/Input';
import { NumberInput } from '../src/form/NumberInput';
import { Text } from '../src/display/Text';
import { TextArea } from '../src/form/TextArea';
import { Pagination } from '../src/data/Pagination';
import { Tabs } from '../src/navigation/Tabs';
import { Avatar } from '../src/display/Avatar';
import { Tooltip } from '../src/utility/Tooltip';

const mounted: Mounted[] = [];
function draw(element: React.ReactElement): Mounted {
  const view = mount(element);
  mounted.push(view);
  return view;
}
afterEach(() => {
  for (const view of mounted.splice(0)) view.unmount();
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

const FOCUSABLE = 'button, input, select, textarea, a[href], [tabindex], [contenteditable="true"]';

/**
 * A press of the mouse as a browser makes one: mousedown, then (unless the
 * page prevented it) focus moves to the nearest focusable thing under the
 * pointer, or off whatever had it when there is none; then mouseup and a
 * click on the element both were on. jsdom moves no focus on a press.
 */
function press(down: Element, up: Element = down, clickOn: Element = up): void {
  act(() => {
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 });
    down.dispatchEvent(event);
    if (!event.defaultPrevented) {
      const focusable = down.closest<HTMLElement>(FOCUSABLE);
      if (focusable) focusable.focus();
      else (document.activeElement as HTMLElement | null)?.blur?.();
    }
    up.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
    clickOn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
  });
}

function key(target: Element | null, name: string, init: KeyboardEventInit = {}): void {
  if (!target) throw new Error(`key ${name}: no target`);
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init }));
  });
}

/** A pointer event as jsdom can make one (it has no PointerEvent). */
function pointer(target: EventTarget, type: string, init: { clientX?: number; clientY?: number; pointerType?: string } = {}): void {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: init.clientX ?? 0, clientY: init.clientY ?? 0 });
  Object.assign(event, { pointerId: 1, pointerType: init.pointerType ?? 'mouse' });
  act(() => {
    target.dispatchEvent(event);
  });
}

const rect = (left: number, top: number, width: number, height: number): DOMRect =>
  ({ x: left, y: top, left, top, width, height, right: left + width, bottom: top + height, toJSON: () => ({}) }) as DOMRect;

describe('a Modal', () => {
  it('stays open when a press that began inside it ends on the overlay', () => {
    // Selecting the text of a field by dragging, and letting go past the
    // dialog's edge: the click lands on the overlay, the nearest element
    // the press and the release share, and the dialog closed with whatever
    // had been typed into it.
    const onClose = vi.fn();
    draw(
      <Modal open title="Edit" onClose={onClose} disableAnimation>
        <input aria-label="Name" defaultValue="Ada Lovelace" />
      </Modal>
    );
    const field = document.querySelector('input[aria-label="Name"]')!;
    const overlay = document.querySelector('.softn-modal-overlay')!;
    press(field, overlay, overlay);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('still closes on a press and release on the overlay', () => {
    const onClose = vi.fn();
    draw(
      <Modal open title="Edit" onClose={onClose} disableAnimation>
        <input aria-label="Name" />
      </Modal>
    );
    const overlay = document.querySelector('.softn-modal-overlay')!;
    press(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('a DatePicker', () => {
  it('stays open when the calendar is pressed somewhere that is not a button', () => {
    // Focus on a day, a press on the month's name or the gap between days:
    // the browser takes focus off the day and gives it to nothing, the field
    // took that for focus leaving it, and the calendar shut under the pointer.
    const { container } = draw(<DatePicker defaultValue="2024-03-15" />);
    const field = container.querySelector<HTMLInputElement>('input')!;
    act(() => field.focus());
    key(field, 'Enter');
    const dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog).not.toBeNull();
    expect(dialog.contains(document.activeElement)).toBe(true);

    const heading = dialog.querySelector('[aria-live="polite"]')!;
    press(heading);
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    // And the keyboard is where it was: the arrows still move through the days.
    key(document.activeElement, 'ArrowRight');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Saturday 16 March 2024');
  });

  it('still closes when focus leaves it', () => {
    const { container } = draw(
      <>
        <DatePicker defaultValue="2024-03-15" />
        <button type="button" data-after="">
          After
        </button>
      </>
    );
    const field = container.querySelector<HTMLInputElement>('input')!;
    act(() => field.focus());
    key(field, 'Enter');
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    act(() => container.querySelector<HTMLButtonElement>('[data-after]')!.focus());
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });
});

describe('a TreeView', () => {
  it('draws a branch whose children have a hole in them', () => {
    // A list from a store holds null where a record was deleted. The top
    // level was cleaned of them and a branch was not: `child.id` of null
    // threw in render, and the tree became the page's error box.
    const nodes = [
      { id: 'a', label: 'Animals', children: [null, { id: 'b', label: 'Bears' }] },
    ] as unknown as TreeNode[];
    const { container } = draw(<TreeView nodes={nodes} defaultExpandAll />);
    const items = Array.from(container.querySelectorAll('[role="treeitem"]'));
    expect(items.map((item) => item.textContent)).toEqual(['Animals', 'Bears']);
    // The hole is no place in the set either.
    expect(items[1].getAttribute('aria-setsize')).toBe('1');
    expect(items[1].getAttribute('aria-posinset')).toBe('1');
  });
});

describe('a Slider being dragged', () => {
  it('tells the page of a value once, not on every move that leaves it where it is', () => {
    // A 200-pixel track for 0 to 100 in steps of 10: twenty pixels a step.
    // Every pointermove sent onChange, so a slow drag across one step told
    // the page the same value twenty times over (each a write of state, or
    // a save, in the app).
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => rect(0, 100, 200, 6));
    const changes: number[] = [];
    const { container } = draw(<Slider defaultValue={0} step={10} onChange={(value) => changes.push(value)} />);
    const rail = container.querySelector('.softn-slider-rail')!;
    pointer(rail, 'pointerdown', { clientX: 0 });
    for (let x = 1; x <= 50; x++) pointer(document, 'pointermove', { clientX: x });
    pointer(document, 'pointerup', { clientX: 50 });
    expect(changes).toEqual([10, 20, 30]);
  });
});

describe('a searchable Select', () => {
  it('tells the page it was focused once, not again each time focus comes back from its search box', () => {
    const onFocus = vi.fn();
    const onBlur = vi.fn();
    const { container } = draw(
      <Select searchable options={['Red', 'Green', 'Blue']} onFocus={onFocus} onBlur={onBlur} />
    );
    const trigger = container.querySelector<HTMLElement>('[role="combobox"]')!;
    act(() => trigger.focus());
    expect(onFocus).toHaveBeenCalledTimes(1);
    click(trigger);
    const search = container.querySelector<HTMLInputElement>('input[type="text"]')!;
    expect(document.activeElement).toBe(search);
    key(search, 'Enter');
    // Focus is back on the trigger: it never left the Select.
    expect(document.activeElement).toBe(trigger);
    expect(onFocus).toHaveBeenCalledTimes(1);
    expect(onBlur).not.toHaveBeenCalled();
  });
});

describe('an Accordion whose open keys are not there yet', () => {
  it('opens what is pressed while `openKeys` is null', () => {
    // `openKeys={saved}` with nothing saved yet: drawn as an accordion that
    // keeps its own keys, while the press kept nothing, so nothing opened.
    const items = [
      { key: 'one', header: 'One', content: 'First' },
      { key: 'two', header: 'Two', content: 'Second' },
    ];
    const { container } = draw(<Accordion items={items} openKeys={null as unknown as string[]} />);
    const button = container.querySelector<HTMLButtonElement>('button')!;
    click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
  });
});

/**
 * Rows whose `name` counts how often it is read: once per row for a sort,
 * and once per row drawn.
 */
function countedRows(count: number): { rows: Array<Record<string, unknown>>; reads: () => number } {
  let reads = 0;
  const rows = Array.from({ length: count }, (_, i) => {
    const row: Record<string, unknown> = { id: i };
    const name = `item ${(i * 7919) % count}`;
    Object.defineProperty(row, 'name', {
      enumerable: true,
      get: () => {
        reads++;
        return name;
      },
    });
    return row;
  });
  return { rows, reads: () => reads };
}

describe('a sorted Table drawn again', () => {
  it('does not sort its rows again when only the columns list is new', () => {
    // A page writes `columns={[...]}` inline, a new list on every draw of
    // the page, and the order was worked out from it: every draw of the page,
    // for whatever reason, sorted every row again.
    const { rows, reads } = countedRows(50);
    const columns = () => [{ key: 'name', header: 'Name', sortable: true }];
    const view = draw(<Table data={rows} columns={columns()} sortColumn="name" />);
    const first = reads();
    // Fifty to sort and fifty to draw.
    expect(first).toBe(100);
    view.rerender(<Table data={rows} columns={columns()} sortColumn="name" />);
    // Fifty to draw, none to sort.
    expect(reads() - first).toBe(50);
  });

  it('sorts again when the rows or the sort change', () => {
    const { rows, reads } = countedRows(10);
    const columns = [{ key: 'name', header: 'Name', sortable: true }];
    const view = draw(<Table data={rows} columns={columns} sortColumn="name" />);
    const first = reads();
    view.rerender(<Table data={rows} columns={columns} sortColumn="name" sortDirection="desc" />);
    expect(reads() - first).toBe(20);
    const names = Array.from(view.container.querySelectorAll('tbody tr td:first-child')).map((cell) => cell.textContent);
    expect(names[0]).toBe('item 9');
  });
});

describe('a sorted DataGrid drawn again', () => {
  it('does not sort its rows again when only the columns list is new', () => {
    const { rows, reads } = countedRows(500);
    const columns = () => [{ key: 'name', header: 'Name', sortable: true }];
    const view = draw(<DataGrid data={rows} columns={columns()} sortKey="name" height={400} rowHeight={40} />);
    const first = reads();
    view.rerender(<DataGrid data={rows} columns={columns()} sortKey="name" height={400} rowHeight={40} />);
    // Only the dozen rows on screen are read; the five hundred are not sorted again.
    expect(reads() - first).toBeLessThan(20);
  });
});

describe('a DataGrid being scrolled', () => {
  it('draws again when the rows on screen change, not on every pixel of a scroll', () => {
    let renders = 0;
    const rows = Array.from({ length: 1000 }, (_, i) => ({ id: i, name: `Row ${i}` }));
    const { container } = draw(
      <React.Profiler id="grid" onRender={() => renders++}>
        <DataGrid data={rows} columns={['name']} height={400} rowHeight={40} />
      </React.Profiler>
    );
    const grid = container.querySelector<HTMLElement>('[role="table"]')!;
    const before = renders;
    // 400 pixels, 4 at a time: ten rows' worth.
    for (let top = 4; top <= 400; top += 4) {
      act(() => {
        grid.scrollTop = top;
        grid.dispatchEvent(new Event('scroll', { bubbles: true }));
      });
    }
    expect(renders - before).toBeLessThanOrEqual(10);
    // And it is the rows from there on that are drawn.
    const first = grid.querySelector('[role="rowgroup"] + [role="rowgroup"] [role="row"]');
    expect(first?.getAttribute('aria-rowindex')).toBe('12');
  });
});

describe('a Toast that shows no progress bar', () => {
  it('is not drawn again twenty times a second while it counts down', () => {
    // The countdown set the bar's width every 50 ms whether or not a bar was
    // shown: a toast with `showProgress={false}` was drawn a hundred times in
    // its five seconds, and still went when its time was up.
    vi.useFakeTimers();
    let renders = 0;
    const onClose = vi.fn();
    const { container } = draw(
      <React.Profiler id="toast" onRender={() => renders++}>
        <Toast message="Saved" duration={5000} showProgress={false} onClose={onClose} />
      </React.Profiler>
    );
    const before = renders;
    // A tick at a time, each drawn as it would be in a browser.
    for (let elapsed = 0; elapsed < 4900; elapsed += 50) {
      act(() => {
        vi.advanceTimersByTime(50);
      });
    }
    expect(renders - before).toBeLessThanOrEqual(1);
    expect(onClose).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it('still moves the bar it shows', () => {
    vi.useFakeTimers();
    const { container } = draw(<Toast message="Saved" duration={1000} />);
    const bar = () => container.querySelector<HTMLElement>('[role="status"] > div:last-child > div')!;
    expect(bar().style.width).toBe('100%');
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(parseFloat(bar().style.width)).toBeLessThan(60);
  });
});

describe('a page of Buttons and Inputs', () => {
  it('puts no stylesheet into the page for each one that does not need it', () => {
    // Every Button wrote the spinner's keyframes into the page and every
    // Input the clear button's hover rule: a table with a button on each of
    // its 500 rows put 500 copies of the same stylesheet into the document,
    // each one parsed and each one more for every style recalculation.
    const { container } = draw(
      <div>
        {Array.from({ length: 500 }, (_, i) => (
          <React.Fragment key={i}>
            <Button>Open</Button>
            <Input aria-label={`Row ${i}`} />
          </React.Fragment>
        ))}
      </div>
    );
    expect(container.querySelectorAll('button').length).toBe(500);
    expect(container.querySelectorAll('style').length).toBe(0);
  });

  it('still has the spinner turn while a Button is loading, and keeps its focus as it starts', () => {
    const { container, rerender } = draw(<Button>Save</Button>);
    const button = container.querySelector('button')!;
    act(() => button.focus());
    rerender(<Button loading>Save</Button>);
    expect(container.querySelector('button')).toBe(button);
    expect(document.activeElement).toBe(button);
    expect(container.querySelector('style')?.textContent).toContain('@keyframes softn-spin');
  });

  it('still styles the clear button of an Input that has one, and keeps the caret in the field', () => {
    const { container, rerender } = draw(<Input type="search" value="" onChange={() => {}} aria-label="Search" />);
    const field = container.querySelector('input')!;
    act(() => field.focus());
    rerender(<Input type="search" value="cats" onChange={() => {}} aria-label="Search" />);
    expect(container.querySelector('input')).toBe(field);
    expect(document.activeElement).toBe(field);
    expect(container.querySelector('.softn-input-clear')).not.toBeNull();
    expect(container.querySelector('style')?.textContent).toContain('.softn-input-clear:hover');
  });
});

describe('a NumberInput typed into with a decimal comma', () => {
  // A phone set to a region that writes 1,5 offers a comma on the decimal
  // keypad `inputMode="decimal"` asks for, and no point. "1,5" was text that
  // is not a number: nothing was sent, and the field went back to the number
  // from before when it was left. A decimal could not be typed at all.
  it('reads the comma as the decimal point it is', () => {
    const changes: Array<number | null> = [];
    const { container } = draw(<NumberInput step={0.1} defaultValue={1} onChange={(value) => changes.push(value)} ariaLabel="Weight" />);
    const field = container.querySelector<HTMLInputElement>('input')!;
    act(() => field.focus());
    type(field, '1,5');
    expect(changes).toEqual([1.5]);
    // Left, it shows the number it holds.
    act(() => field.blur());
    expect(field.value).toBe('1.5');
  });

  it('reads the full-width digits a Japanese or Chinese keyboard types', () => {
    // An input method in full-width mode types "１２．５": not a number to
    // `Number`, so nothing was sent and the field went back when left.
    const changes: Array<number | null> = [];
    const { container } = draw(<NumberInput step={0.1} onChange={(value) => changes.push(value)} ariaLabel="Weight" />);
    type(container.querySelector<HTMLInputElement>('input'), '１２．５');
    expect(changes).toEqual([12.5]);
  });

  it('leaves "1,000" alone where a comma groups thousands', () => {
    // In a locale that writes 1,000 for a thousand, that text is not 1.
    const changes: Array<number | null> = [];
    const { container } = draw(<NumberInput step={0.1} defaultValue={2} onChange={(value) => changes.push(value)} ariaLabel="Weight" />);
    type(container.querySelector<HTMLInputElement>('input'), '1,000');
    expect(changes).toEqual([]);
  });

  it('reads "1,000" as one where the comma is the decimal point', () => {
    const NumberFormat = Intl.NumberFormat;
    // The reader's locale is German: a constructor, so `new` works on it.
    vi.spyOn(Intl, 'NumberFormat').mockImplementation(function (locale?: string | string[], options?: Intl.NumberFormatOptions) {
      return new NumberFormat(locale ?? 'de-DE', options);
    } as unknown as typeof Intl.NumberFormat);
    const changes: Array<number | null> = [];
    const { container } = draw(<NumberInput step={0.001} defaultValue={2} onChange={(value) => changes.push(value)} ariaLabel="Weight" />);
    type(container.querySelector<HTMLInputElement>('input'), '1,000');
    expect(changes).toEqual([1]);
  });
});

describe('a Text that truncates', () => {
  it('is a box that can clip its line, wherever it is put', () => {
    // A span is inline, and an inline box neither clips nor draws an
    // ellipsis: in a Card, a Box or a ListItem (block boxes, not the flex
    // rows that make their children blocks) `truncate` only stopped the line
    // wrapping, and a long name ran out past the edge of what held it.
    const { container } = draw(
      <div style={{ width: 120 }}>
        <Text truncate>A name far too long for the card it is in</Text>
      </div>
    );
    const text = container.querySelector('span')!;
    expect(text.style.whiteSpace).toBe('nowrap');
    expect(text.style.textOverflow).toBe('ellipsis');
    expect(['block', 'inline-block']).toContain(text.style.display);
    expect(text.style.maxWidth).toBe('100%');
  });

  it('keeps the display it is given', () => {
    const { container } = draw(<Text truncate block>Long</Text>);
    expect(container.querySelector('span')!.style.display).toBe('block');
  });
});

describe('typing in an open Modal', () => {
  it('does not read the style of the page for keys the dialog does not answer', () => {
    // The dialog answers Escape and Tab. It asked whether it was the layer
    // on top, which reads the computed style of every element above it,
    // before it looked at the key: every letter typed into a field in a
    // dialog made the browser bring its styles up to date, there and then.
    draw(
      <Modal open title="Edit" onClose={() => {}} disableAnimation>
        <input aria-label="Name" />
      </Modal>
    );
    const field = document.querySelector<HTMLInputElement>('input[aria-label="Name"]')!;
    act(() => field.focus());
    const reads = vi.spyOn(window, 'getComputedStyle');
    for (const letter of 'Ada Lovelace') key(field, letter);
    expect(reads).not.toHaveBeenCalled();
  });

  it('still closes on Escape', () => {
    const onClose = vi.fn();
    draw(
      <Modal open title="Edit" onClose={onClose} disableAnimation>
        <input aria-label="Name" />
      </Modal>
    );
    const field = document.querySelector<HTMLInputElement>('input[aria-label="Name"]')!;
    act(() => field.focus());
    key(field, 'Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('a TextArea that grows with its text', () => {
  /** Count the reads of `scrollHeight`, each of which lays the page out. */
  function countLayout(): () => number {
    let reads = 0;
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
      reads++;
      return 40;
    });
    return () => reads;
  }

  function Bound() {
    const [text, setText] = React.useState('');
    return <TextArea autoResize value={text} onChange={(e) => setText(e.target.value)} aria-label="Notes" />;
  }

  it('measures itself once a keystroke when the page holds its text', () => {
    // It measured in its change handler and again when the value the page
    // handed back arrived: two layouts of the page for every key pressed.
    const reads = countLayout();
    const { container } = draw(<Bound />);
    const area = container.querySelector('textarea') as unknown as HTMLInputElement;
    const before = reads();
    type(area, 'a');
    type(area, 'ab');
    type(area, 'abc');
    expect(reads() - before).toBe(3);
    expect((area as unknown as HTMLTextAreaElement).style.height).not.toBe('');
  });

  it('still measures itself as it is typed into when it holds its own text', () => {
    const reads = countLayout();
    const { container } = draw(<TextArea autoResize aria-label="Notes" />);
    const area = container.querySelector('textarea') as unknown as HTMLInputElement;
    const before = reads();
    type(area, 'a');
    type(area, 'ab');
    expect(reads() - before).toBe(2);
  });
});

describe('a Pagination given its page sizes as text', () => {
  it('offers them, rather than taking the page to its error box', () => {
    // `pageSizeOptions="10, 25"`, as a page writes an attribute: `.map` of
    // text threw in render.
    const sizes: number[] = [];
    const { container } = draw(
      <Pagination
        currentPage={1}
        totalPages={5}
        onPageChange={() => {}}
        showPageSize
        pageSize={25}
        onPageSizeChange={(size) => sizes.push(size)}
        pageSizeOptions={'10, 25' as unknown as number[]}
      />
    );
    const options = Array.from(container.querySelectorAll('option')).map((option) => option.textContent);
    expect(options).toEqual(['10', '25']);
  });
});

describe('ids built from keys with spaces in them', () => {
  // `aria-controls` and `aria-labelledby` are lists of ids split at spaces:
  // a tab keyed "Billing info" pointed at "…-panel-Billing" and "info",
  // neither of them its panel, and the panel was named by nothing.
  const references = (element: Element, attribute: string): Array<HTMLElement | null> =>
    (element.getAttribute(attribute) ?? '').split(/\s+/).filter(Boolean).map((id) => document.getElementById(id));

  it('tie a tab to its panel', () => {
    const { container } = draw(
      <Tabs
        tabs={[
          { key: 'Billing info', label: 'Billing', content: 'Card on file' },
          { key: 'Plan', label: 'Plan', content: 'Pro' },
        ]}
      />
    );
    const tab = container.querySelector('[role="tab"]')!;
    const panel = container.querySelector('[role="tabpanel"]')!;
    expect(references(tab, 'aria-controls')).toEqual([panel]);
    expect(references(panel, 'aria-labelledby')).toEqual([tab]);
  });

  it('tie an accordion header to its panel', () => {
    const { container } = draw(<Accordion items={[{ key: 'Opening hours', header: 'Hours', content: '9 to 5' }]} defaultOpenKeys={['Opening hours']} />);
    const button = container.querySelector('button')!;
    const region = container.querySelector('[role="region"]')!;
    expect(references(button, 'aria-controls')).toEqual([region]);
    expect(references(region, 'aria-labelledby')).toEqual([button]);
  });
});

describe('an Avatar for a name that starts outside the basic plane', () => {
  it('shows the whole first character, not half of it', () => {
    // `charAt(0)` of an emoji or of many CJK names is half of a surrogate
    // pair, which draws as the replacement character.
    const { container } = draw(<Avatar name="🦊 Fox" />);
    expect(container.textContent).toContain('🦊F');
    expect(container.textContent).not.toContain('�');
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(container.textContent ?? '')).toBe(false);
  });
});

describe('a Tooltip telling the page whether it is open', () => {
  const enter = (target: Element) =>
    act(() => {
      target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: null }));
    });
  const leave = (target: Element) =>
    act(() => {
      target.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
    });

  it('says it closed only when it had opened', () => {
    // Passed over on the way somewhere else, before its delay was up: it
    // never opened, and the page was told it had closed.
    vi.useFakeTimers();
    const onOpenChange = vi.fn();
    const { container } = draw(
      <Tooltip content="Details" showDelay={300} onOpenChange={onOpenChange}>
        <button type="button">Help</button>
      </Tooltip>
    );
    const button = container.querySelector('button')!;
    enter(button);
    act(() => vi.advanceTimersByTime(100));
    leave(button);
    act(() => vi.advanceTimersByTime(500));
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('says it opened once while it stays open', () => {
    // Focused, then pointed at: it was open already, and the page was told
    // it had opened twice.
    const onOpenChange = vi.fn();
    const { container } = draw(
      <Tooltip content="Details" onOpenChange={onOpenChange}>
        <button type="button">Help</button>
      </Tooltip>
    );
    const button = container.querySelector('button')!;
    act(() => button.focus());
    enter(button);
    expect(onOpenChange.mock.calls).toEqual([[true]]);
    act(() => button.blur());
    leave(button);
    expect(onOpenChange.mock.calls).toEqual([[true], [false]]);
  });
});
