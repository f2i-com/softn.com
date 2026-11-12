/**
 * Defects a review of 2026-11-12 found by drawing the components at phone
 * width and by using them as a page does.
 *
 *  - A DataGrid too narrow for its columns drew its cells outside the rows
 *    that carry the background and the lines.
 *  - Seven tabs on a phone made the page scroll sideways.
 *  - Tabs bound to a variable that starts as "" opened with no tab chosen.
 *  - A ColorPicker bound to an unset variable showed "#"; `red` was #RREEDD.
 *  - Two toasts at one corner were drawn on top of each other.
 *  - A NumberInput with a range sent the number from before on Enter.
 *
 * (The Sidebar on a phone and the SmartForm after a save have files of
 * their own.)
 */

import React, { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { click, mount, type, type Mounted } from './dom';
import { DataGrid } from '../src/data/DataGrid';
import { Tabs } from '../src/navigation/Tabs';
import { ColorPicker } from '../src/form/ColorPicker';
import { Toast } from '../src/feedback/Toast';
import { NumberInput } from '../src/form/NumberInput';

const mounted: Mounted[] = [];
function draw(element: React.ReactElement): Mounted {
  const view = mount(element);
  mounted.push(view);
  return view;
}
afterEach(() => {
  for (const view of mounted.splice(0)) view.unmount();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('a DataGrid in a box too narrow for its columns', () => {
  const people = [
    { id: 1, name: 'Ada', email: 'ada@example.com', city: 'London' },
    { id: 2, name: 'Grace', email: 'grace@example.com', city: 'New York' },
  ];
  /** The min-width of each row drawn, the header's first. */
  const rowFloors = (element: React.ReactElement) => {
    const view = draw(element);
    return Array.from(view.container.querySelectorAll<HTMLElement>('[role="row"]')).map((row) => row.style.minWidth);
  };

  it('keeps every row as wide as its cells at their narrowest, the header’s too', () => {
    // Three columns that stop shrinking at 80 pixels each.
    expect(rowFloors(<DataGrid data={people} columns={['name', 'email', 'city']} />)).toEqual(['240px', '240px', '240px']);
  });

  it('counts a column’s own minimum, a frozen column’s width, and the columns the grid adds', () => {
    const floors = rowFloors(
      <DataGrid
        data={people}
        selectionMode="multiple"
        onFilterChange={() => {}}
        columns={[
          { key: 'name', header: 'Name', frozen: true, width: 200 },
          { key: 'email', header: 'Email', minWidth: 160, filterable: true },
          { key: 'city', header: 'City' },
        ]}
      />
    );
    // 40 for the tick boxes, 200 frozen, 160, 80, and 44 for the filter button.
    expect(floors).toEqual(['524px', '524px', '524px']);
  });

  it('adds up widths that are not pixels as CSS can', () => {
    const floors = rowFloors(
      <DataGrid data={people} columns={[{ key: 'name', header: 'Name', frozen: true, width: '12rem' }, { key: 'city', header: 'City' }]} />
    );
    expect(floors[0]).toBe('calc(80px + max(12rem, 80px))');
  });

  it('holds the box the rows are placed in to the same width, and the filter row', () => {
    const view = draw(
      <DataGrid data={people} onFilterChange={() => {}} columns={[{ key: 'name', header: 'Name', filterable: true }, 'email']} />
    );
    click(view.container.querySelector('[aria-label="Show filters"]'));
    const groups = view.container.querySelectorAll<HTMLElement>('[role="rowgroup"]');
    const filterRow = groups[0].children[1] as HTMLElement;
    expect(filterRow.style.minWidth).toBe('204px');
    expect((groups[1].firstElementChild as HTMLElement).style.minWidth).toBe('204px');
  });

  it('does not let the browser’s scroll anchoring undo the first scroll', () => {
    // In Chromium a first scroll of 130 pixels ended at 10: the box that
    // holds the rows moves down as rows are swapped, which reads as content
    // arriving above the reader.
    expect(renderToStaticMarkup(<DataGrid data={people} />)).toContain('overflow-anchor:none');
  });
});

describe('Tabs', () => {
  const seven = ['Overview', 'Tasks', 'Files', 'People', 'Billing', 'Activity', 'Settings'].map((label) => ({
    key: label.toLowerCase(),
    label,
    content: `${label} panel`,
  }));
  const selected = (view: Mounted) => Array.from(view.container.querySelectorAll('[role="tab"][aria-selected="true"]')).map((tab) => tab.textContent);
  const panel = (view: Mounted) => view.container.querySelector('[role="tabpanel"]')?.textContent ?? null;

  it('scroll in their own row, with no scrollbar, and each tab keeps its width', () => {
    const view = draw(<Tabs tabs={seven} />);
    const list = view.container.querySelector<HTMLElement>('[role="tablist"]')!;
    expect(list.style.overflowX).toBe('auto');
    expect(list.className).toBe('softn-tabs-list');
    const rules = Array.from(view.container.querySelectorAll('style')).map((style) => style.textContent ?? '').join('\n');
    expect(rules).toContain('.softn-tabs-list::-webkit-scrollbar { display: none; }');
    expect(rules).toContain('scrollbar-width: none');
    for (const tab of Array.from(list.querySelectorAll<HTMLElement>('[role="tab"]'))) {
      expect(tab.style.flex).toBe('0 0 auto');
      expect(tab.style.whiteSpace).toBe('nowrap');
    }
  });

  it('share a full-width row equally, and still never shrink under their labels', () => {
    const view = draw(<Tabs tabs={seven} fullWidth />);
    expect(view.container.querySelector<HTMLElement>('[role="tab"]')!.style.flex).toBe('1 0 0%');
  });

  it('bring the chosen tab into view in the row, and scroll nothing else', () => {
    // A row 300 wide holding seven tabs of 100: jsdom lays nothing out.
    const place = (element: HTMLElement) => Array.from(element.parentElement?.children ?? []).indexOf(element);
    vi.spyOn(HTMLElement.prototype, 'offsetLeft', 'get').mockImplementation(function (this: HTMLElement) {
      return this.getAttribute('role') === 'tab' ? place(this) * 100 : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.getAttribute('role') === 'tab' ? 100 : 300;
    });
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => 300);
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.getAttribute('role') === 'tablist' ? 700 : 300;
    });
    const intoView = vi.fn();
    HTMLElement.prototype.scrollIntoView = intoView;

    const view = draw(<Tabs tabs={seven} defaultActiveKey="billing" />);
    const list = view.container.querySelector<HTMLElement>('[role="tablist"]')!;
    // Billing is the fifth: 400 to 500, in a row that shows 300.
    expect(list.scrollLeft).toBe(216);
    click(list.querySelectorAll('[role="tab"]')[0]);
    expect(list.scrollLeft).toBe(0);
    click(list.querySelectorAll('[role="tab"]')[6]);
    expect(list.scrollLeft).toBe(416);
    expect(intoView).not.toHaveBeenCalled();
    // The person scrolls the row back to look, and the page is drawn again
    // with a new list of the same tabs: the row stays where they left it.
    list.scrollLeft = 0;
    view.rerender(<Tabs tabs={seven.map((tab) => ({ ...tab }))} defaultActiveKey="billing" />);
    expect(list.scrollLeft).toBe(0);
  });

  it.each([[''], [null], ['nowhere']])('given %j as the chosen key, open on the first tab', (activeKey) => {
    const view = draw(<Tabs tabs={seven} activeKey={activeKey as unknown as string} />);
    expect(selected(view)).toEqual(['Overview']);
    expect(panel(view)).toBe('Overview panel');
    expect(view.container.querySelector('[role="tab"]')!.getAttribute('tabindex')).toBe('0');
  });

  it('given a key that names no tab, fall back to the default the page named', () => {
    const view = draw(<Tabs tabs={seven} activeKey="" defaultActiveKey="files" />);
    expect(selected(view)).toEqual(['Files']);
  });

  it('bound to a variable that starts empty, follow the person and then the variable', () => {
    const changes: string[] = [];
    const tabs = (activeKey: string) => <Tabs tabs={seven} activeKey={activeKey} onChange={(key) => changes.push(key)} />;
    const view = draw(tabs(''));
    click(view.container.querySelectorAll('[role="tab"]')[2]);
    expect(changes).toEqual(['files']);
    // The page has not written the variable yet: the choice shows all the same.
    expect(selected(view)).toEqual(['Files']);
    view.rerender(tabs('files'));
    expect(selected(view)).toEqual(['Files']);
    // Now the variable decides, as it always did.
    click(view.container.querySelectorAll('[role="tab"]')[4]);
    expect(selected(view)).toEqual(['Files']);
    view.rerender(tabs('billing'));
    expect(selected(view)).toEqual(['Billing']);
  });

  it('compare keys as text: tabs keyed by number, the chosen key written in a page', () => {
    const numbered = [
      { key: 1 as unknown as string, label: 'First', content: 'The first panel' },
      { key: 2 as unknown as string, label: 'Second', content: 'The second panel' },
    ];
    const changes: unknown[] = [];
    const view = draw(<Tabs tabs={numbered} activeKey="2" onChange={(key) => changes.push(key)} />);
    expect(selected(view)).toEqual(['Second']);
    expect(panel(view)).toBe('The second panel');
    // The page is told the tab's own key, a number as it wrote it.
    click(view.container.querySelectorAll('[role="tab"]')[0]);
    expect(changes).toEqual([1]);
  });
});

describe('a ColorPicker given what is not a hex colour', () => {
  const shown = (element: React.ReactElement) => {
    const view = draw(element);
    const button = view.container.querySelector('button')!;
    return {
      text: button.querySelector('[id$="-value"]')!.textContent,
      form: view.container.querySelector<HTMLInputElement>('input[type="hidden"]')!.value,
      view,
    };
  };

  it.each([[''], ['red'], ['#12'], ['#gggggg'], ['fff url(https://example.com/x)'], [42], [null]])('%j shows the usual colour', (value) => {
    const { text, form } = shown(<ColorPicker value={value as unknown as string} />);
    expect(text).toBe('#6366F1');
    expect(form).toBe('#6366F1');
  });

  it('shows the page’s own default when it has one', () => {
    expect(shown(<ColorPicker value="" defaultValue="#0af" />).text).toBe('#00AAFF');
    // A default that is no colour either is the usual one.
    expect(shown(<ColorPicker value="" defaultValue="blue" />).text).toBe('#6366F1');
  });

  it.each([
    ['#22c55e', '#22C55E'],
    ['22c55e', '#22C55E'],
    ['#0af', '#00AAFF'],
    [' #0AF ', '#00AAFF'],
  ])('still shows %j as %s', (value, expected) => {
    expect(shown(<ColorPicker value={value} />).text).toBe(expected);
  });

  it('follows a bound variable from unset to a colour and back', () => {
    const { view } = shown(<ColorPicker value="" />);
    const text = () => view.container.querySelector('[id$="-value"]')!.textContent;
    view.rerender(<ColorPicker value="#ff0000" />);
    expect(text()).toBe('#FF0000');
    view.rerender(<ColorPicker value="" />);
    expect(text()).toBe('#6366F1');
  });
});

describe('toasts shown at once', () => {
  /** jsdom lays nothing out: every toast's place is 80 pixels tall here. */
  const laidOut = (heights: Record<string, number> = {}) =>
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const title = this.querySelector('.softn-toast')?.textContent ?? '';
      const height = this.classList.contains('softn-toast-place') ? (heights[title] ?? 80) : 0;
      return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: height, width: 300, height, toJSON: () => ({}) } as DOMRect;
    });
  /** How far from its edge a place stands, in pixels beyond the usual 1rem. */
  const beyond = (length: string) => (length === '' ? null : length === '1rem' ? 0 : Number(/(\d+)px/.exec(length)?.[1]));
  const places = (view: Mounted) =>
    Object.fromEntries(
      Array.from(view.container.querySelectorAll<HTMLElement>('.softn-toast-place')).map((place) => [
        place.querySelector('.softn-toast')!.textContent,
        { top: beyond(place.style.top), bottom: beyond(place.style.bottom) },
      ])
    );

  it('stand clear of each other at one corner, the newest nearest the edge', () => {
    laidOut({ Second: 120 });
    const toasts = (third: boolean) => (
      <>
        <Toast title="First" duration={0} />
        <Toast title="Second" duration={0} />
        {third && <Toast title="Third" duration={0} />}
      </>
    );
    const view = draw(toasts(false));
    // Shown in the same draw, the later one in the page is the newer.
    expect(places(view)).toEqual({
      First: { top: 132, bottom: null },
      Second: { top: 0, bottom: null },
    });
    view.rerender(toasts(true));
    expect(places(view)).toEqual({
      First: { top: 224, bottom: null },
      Second: { top: 92, bottom: null },
      Third: { top: 0, bottom: null },
    });
    // The newest goes: the others move back towards the edge.
    view.rerender(toasts(false));
    expect(places(view)).toEqual({
      First: { top: 132, bottom: null },
      Second: { top: 0, bottom: null },
    });
  });

  it('move back when one of them is closed', () => {
    laidOut();
    const view = draw(
      <>
        <Toast title="First" duration={0} />
        <Toast title="Second" duration={0} />
      </>
    );
    const second = Array.from(view.container.querySelectorAll('.softn-toast')).find((toast) => toast.textContent === 'Second')!;
    click(second.querySelector('[aria-label="Close"]'));
    expect(places(view)).toEqual({ First: { top: 0, bottom: null } });
  });

  it('stack from the bottom at a bottom corner, and each corner by itself', () => {
    laidOut();
    const view = draw(
      <>
        <Toast title="Top" duration={0} />
        <Toast title="Low one" position="bottom-center" duration={0} />
        <Toast title="Low two" position="bottom-center" duration={0} />
        <Toast title="Left" position="bottom-left" duration={0} />
      </>
    );
    expect(places(view)).toEqual({
      Top: { top: 0, bottom: null },
      'Low one': { top: null, bottom: 92 },
      'Low two': { top: null, bottom: 0 },
      Left: { top: null, bottom: 0 },
    });
  });

  it('take no room for a toast that is not on screen', () => {
    // An app the runtime is not showing: mounted, and no height.
    laidOut({ Hidden: 0 });
    const view = draw(
      <>
        <Toast title="Seen" duration={0} />
        <Toast title="Hidden" duration={0} />
      </>
    );
    expect(places(view).Seen).toEqual({ top: 0, bottom: null });
  });

  it('a toast shown again is the newest again', () => {
    laidOut();
    const toasts = (first: boolean) => (
      <>
        <Toast title="First" duration={0} isVisible={first} />
        <Toast title="Second" duration={0} />
      </>
    );
    const view = draw(toasts(true));
    expect(places(view).First.top).toBe(92);
    view.rerender(toasts(false));
    view.rerender(toasts(true));
    expect(places(view)).toEqual({
      First: { top: 0, bottom: null },
      Second: { top: 92, bottom: null },
    });
  });

  it('are still each a live region of their own, where the page drew them', () => {
    laidOut();
    const view = draw(
      <div id="app">
        <Toast title="Saved" variant="success" duration={0} />
        <Toast title="Could not sync" variant="error" duration={0} />
      </div>
    );
    const toasts = Array.from(view.container.querySelectorAll('#app .softn-toast'));
    expect(toasts.map((toast) => [toast.getAttribute('role'), toast.getAttribute('aria-atomic')])).toEqual([
      ['status', 'true'],
      ['alert', 'true'],
    ]);
  });

  it('a position that is not one of the six is the usual corner', () => {
    laidOut();
    const view = draw(<Toast title="Lost" position={'middle' as unknown as 'top-right'} duration={0} />);
    const place = view.container.querySelector<HTMLElement>('.softn-toast-place')!;
    expect(place.style.top).toBe('1rem');
    expect(place.style.right).toBe('1rem');
  });
});

describe('a NumberInput with a range, on Enter', () => {
  const enter = (field: HTMLInputElement) =>
    act(() => {
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });

  it('sends what it shows, settled into the range, before the form is sent', () => {
    const sent: Array<number | null> = [];
    function Order(): React.ReactElement {
      const [quantity, setQuantity] = React.useState<number | null>(5);
      return (
        <NumberInput
          value={quantity as number}
          min={1}
          max={10}
          onChange={(next) => {
            sent.push(next);
            setQuantity(next);
          }}
        />
      );
    }
    const view = draw(<Order />);
    const field = view.container.querySelector<HTMLInputElement>('input')!;
    type(field, '50');
    // Out of range: held while it is typed, as before.
    expect(sent).toEqual([]);
    expect(field.value).toBe('50');
    enter(field);
    expect(sent).toEqual([10]);
    expect(field.value).toBe('10');
  });

  it('does not keep Enter from the form', () => {
    const view = draw(<NumberInput defaultValue={5} min={1} max={10} />);
    const field = view.container.querySelector<HTMLInputElement>('input')!;
    type(field, '50');
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    act(() => {
      field.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
    expect(field.value).toBe('10');
  });

  it.each([
    ['0', 1],
    ['', null],
    ['7', 7],
  ])('typed %j and Enter is %j', (text, expected) => {
    const sent: Array<number | null> = [];
    const view = draw(<NumberInput defaultValue={5} min={1} max={10} onChange={(next) => sent.push(next)} />);
    const field = view.container.querySelector<HTMLInputElement>('input')!;
    type(field, text);
    enter(field);
    expect(sent[sent.length - 1]).toBe(expected);
  });

  it('sends nothing for text that is not a number, and shows the number it holds', () => {
    const sent: Array<number | null> = [];
    const view = draw(<NumberInput defaultValue={5} min={-10} max={10} onChange={(next) => sent.push(next)} />);
    const field = view.container.querySelector<HTMLInputElement>('input')!;
    type(field, '-');
    enter(field);
    expect(sent).toEqual([]);
    expect(field.value).toBe('5');
  });
});
