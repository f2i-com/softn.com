/**
 * The components under a finger and on a phone, from the review of
 * 2026-11-12.
 *
 *  - A Slider took a press only on a track 6 pixels tall, made room for its
 *    value whenever it was hovered (so the page under it jumped), and kept a
 *    finger from scrolling the page.
 *  - A popup (a Select's list, a calendar, a palette, a menu) was laid out
 *    inside its control's box: cut off in a dialog, and off the screen's edge.
 *  - A Table too wide for a phone only scrolled sideways.
 *  - Small controls: a calendar's days, a Drawer's close button, a Select's
 *    clear button.
 *  - A FileChooser kept showing a file after it was sent, could not be turned
 *    off, and took from the picker what it refused from a drop.
 */

import React, { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { click, mount, type Mounted } from './dom';
import { Slider } from '../src/form/Slider';
import { Select } from '../src/form/Select';
import { DatePicker } from '../src/form/DatePicker';
import { ColorPicker } from '../src/form/ColorPicker';
import { FileChooser, type FileInfo } from '../src/form/FileChooser';
import { Menu } from '../src/navigation/Menu';
import { Table } from '../src/data/Table';
import { Drawer } from '../src/feedback/Drawer';
import { Modal } from '../src/feedback/Modal';

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

const rulesOf = (view: Mounted) => Array.from(view.container.querySelectorAll('style')).map((style) => style.textContent ?? '').join('\n');
const box = (left: number, top: number, width: number, height: number): DOMRect =>
  ({ x: left, y: top, left, top, width, height, right: left + width, bottom: top + height, toJSON: () => ({}) }) as DOMRect;

/** A pointer event as jsdom can make one. */
function pointer(target: EventTarget, type: string, init: { clientX?: number; clientY?: number; pointerType?: string; pointerId?: number } = {}): void {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: init.clientX ?? 0, clientY: init.clientY ?? 0 });
  Object.assign(event, { pointerId: init.pointerId ?? 1, pointerType: init.pointerType ?? 'mouse' });
  act(() => {
    target.dispatchEvent(event);
  });
}

describe('a Slider', () => {
  /** A slider whose track is 200 pixels wide from x = 0, so a pixel is half a step of 100. */
  function slider(props: Record<string, unknown> = {}) {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => box(0, 100, 200, 6));
    const changes: number[] = [];
    const ends: number[] = [];
    const view = draw(<Slider defaultValue={40} onChange={(value) => changes.push(value)} onChangeEnd={(value) => ends.push(value)} {...props} />);
    const rail = view.container.querySelector<HTMLElement>('.softn-slider-rail')!;
    const thumb = view.container.querySelector<HTMLElement>('[role="slider"]')!;
    return { view, rail, thumb, changes, ends, value: () => Number(thumb.getAttribute('aria-valuenow')) };
  }

  it('takes a press on a rail taller than its track, in room it gives back to the page', () => {
    const { rail, view } = slider();
    // 16 pixel thumb, 6 pixel track: 9 above and 9 below, and as much taken back.
    expect(rail.style.paddingTop).toBe('9px');
    expect(rail.style.paddingBottom).toBe('9px');
    expect(rail.style.marginTop).toBe('-9px');
    expect(rail.style.marginBottom).toBe('-9px');
    expect(rulesOf(view)).toMatch(/@media \(pointer: coarse\) \{\s*\.softn-slider-rail \{ min-height: 44px;/);
  });

  it('lets a finger scroll the page from it', () => {
    // `touch-action: none` on the whole slider kept the page from scrolling
    // under a finger that landed on it. Up and down is the page's now.
    const markup = renderToStaticMarkup(<Slider />);
    expect(markup).toContain('touch-action:pan-y');
    expect(markup).not.toContain('touch-action:none');
  });

  it('makes no room for its value while it is hovered or dragged, so nothing under it moves', () => {
    const { view, rail } = slider();
    const root = view.container.firstElementChild as HTMLElement;
    expect(root.style.paddingTop).toBe('0px');
    act(() => {
      root.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    expect(root.style.paddingTop).toBe('0px');
    pointer(rail, 'pointerdown', { clientX: 100 });
    expect(root.style.paddingTop).toBe('0px');
    pointer(document, 'pointerup');
  });

  it('keeps the room when its value is always shown', () => {
    const markup = renderToStaticMarkup(<Slider tooltipAlwaysVisible />);
    expect(markup).toContain('padding-top:24px');
  });

  it('follows a mouse from the moment it is pressed, as before', () => {
    const { rail, changes, ends, value } = slider();
    pointer(rail, 'pointerdown', { clientX: 100 });
    expect(value()).toBe(50);
    pointer(document, 'pointermove', { clientX: 150 });
    expect(value()).toBe(75);
    pointer(document, 'pointerup', { clientX: 150 });
    expect(changes).toEqual([50, 75]);
    expect(ends).toEqual([75]);
  });

  it('goes to where a finger tapped, when it is lifted', () => {
    const { rail, changes, ends, value } = slider();
    pointer(rail, 'pointerdown', { clientX: 160, clientY: 110, pointerType: 'touch' });
    // Down, and nothing yet: it may be the start of a scroll.
    expect(value()).toBe(40);
    expect(changes).toEqual([]);
    pointer(document, 'pointerup', { clientX: 160, clientY: 110, pointerType: 'touch' });
    expect(value()).toBe(80);
    expect(changes).toEqual([80]);
    expect(ends).toEqual([80]);
  });

  it('follows a finger that moves along it', () => {
    const { rail, changes, ends, value } = slider();
    pointer(rail, 'pointerdown', { clientX: 80, clientY: 110, pointerType: 'touch' });
    pointer(document, 'pointermove', { clientX: 83, clientY: 110, pointerType: 'touch' });
    expect(changes).toEqual([]);
    pointer(document, 'pointermove', { clientX: 120, clientY: 112, pointerType: 'touch' });
    expect(value()).toBe(60);
    pointer(document, 'pointermove', { clientX: 140, clientY: 150, pointerType: 'touch' });
    expect(value()).toBe(70);
    pointer(document, 'pointerup', { clientX: 140, clientY: 150, pointerType: 'touch' });
    expect(changes).toEqual([60, 70]);
    expect(ends).toEqual([70]);
  });

  it('is left as it was by a finger that scrolls the page', () => {
    const { rail, changes, ends, value } = slider();
    pointer(rail, 'pointerdown', { clientX: 160, clientY: 110, pointerType: 'touch' });
    pointer(document, 'pointermove', { clientX: 162, clientY: 140, pointerType: 'touch' });
    // The browser takes the pointer for its scroll.
    pointer(document, 'pointercancel', { clientX: 162, clientY: 140, pointerType: 'touch' });
    expect(value()).toBe(40);
    expect(changes).toEqual([]);
    expect(ends).toEqual([]);
    // And the next press is heard.
    pointer(rail, 'pointerdown', { clientX: 100 });
    expect(value()).toBe(50);
    pointer(document, 'pointerup');
  });
});

describe('a popup is placed on the screen', () => {
  /**
   * A screen 360 by 640. `where` says where the control is, and every popup
   * is 300 by `popupHeight`. jsdom lays nothing out, so the boxes are given.
   */
  function screen(where: DOMRect, popupHeight = 300, popupWidth = 300) {
    vi.stubGlobal('innerHeight', 640);
    vi.stubGlobal('innerWidth', 360);
    vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(360);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => where);
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(popupHeight);
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(popupWidth);
  }
  // Bare strings, as a page gives them.
  const options = ['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight'];
  const listOf = (view: Mounted) => view.container.querySelector<HTMLElement>('[role="listbox"]')!.parentElement!;

  it('a Select’s list: fixed, under the trigger and as wide, when there is room', () => {
    screen(box(16, 100, 328, 40));
    const view = draw(<Select options={options} fullWidth />);
    click(view.container.querySelector('[role="combobox"]'));
    const list = listOf(view);
    expect(list.style.position).toBe('fixed');
    expect(list.style.top).toBe('146px');
    expect(list.style.left).toBe('16px');
    expect(list.style.width).toBe('328px');
    expect(list.style.maxHeight).toBe('300px');
    // Its own margin is the gap already counted.
    expect(list.style.marginTop).toBe('0px');
  });

  it('over the trigger when there is no room under it', () => {
    screen(box(16, 560, 328, 40));
    const view = draw(<Select options={options} fullWidth />);
    click(view.container.querySelector('[role="combobox"]'));
    const list = listOf(view);
    // 560 - 6 - 300.
    expect(list.style.top).toBe('254px');
    expect(list.style.maxHeight).toBe('300px');
  });

  it('on the side with more room, and no taller than it, when it fits on neither', () => {
    screen(box(16, 250, 328, 40));
    const view = draw(<Select options={options} fullWidth />);
    click(view.container.querySelector('[role="combobox"]'));
    const list = listOf(view);
    // Under: 640 - 290 - 6 - 8 = 336 of room, which the list's own 300 fits.
    expect(list.style.top).toBe('296px');
    expect(list.style.maxHeight).toBe('300px');
  });

  it('a calendar from a field at the right of a phone is moved in from the edge', () => {
    screen(box(186, 100, 158, 40), 315, 280);
    const view = draw(<DatePicker defaultValue="2026-11-12" />);
    click(view.container.querySelector('input'));
    const calendar = view.container.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(calendar.style.position).toBe('fixed');
    // 360 - 8 - 280, not the field's 186.
    expect(calendar.style.left).toBe('72px');
    expect(calendar.style.top).toBe('144px');
    expect(calendar.style.maxWidth).toBe('calc(100vw - 16px)');
  });

  it('a palette too tall for the room under its button opens over it', () => {
    screen(box(16, 500, 120, 44), 217, 252);
    const view = draw(<ColorPicker />);
    click(view.container.querySelector('button'));
    const palette = view.container.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(palette.style.position).toBe('fixed');
    // 500 - 4 - 217.
    expect(palette.style.top).toBe('279px');
  });

  it('a Menu at the right edge keeps to the screen, and goes back to its own place when shut', () => {
    screen(box(289, 20, 55, 24), 150, 192);
    const view = draw(<Menu trigger="More" items={[{ key: 'a', label: 'Print' }]} />);
    const menu = view.container.querySelector<HTMLElement>('[role="menu"]')!;
    expect(menu.style.position).toBe('absolute');
    click(view.container.querySelector('[aria-haspopup="menu"]'));
    expect(menu.style.position).toBe('fixed');
    // 360 - 8 - 192.
    expect(menu.style.left).toBe('160px');
    expect(menu.style.top).toBe('48px');
    act(() => {
      menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(menu.style.position).toBe('absolute');
    expect(menu.style.top).toBe('100%');
    expect(menu.style.marginTop).toBe('0.25rem');
  });

  it('a Menu placed "bottom-end" lines its right edge up with its trigger’s', () => {
    screen(box(200, 20, 60, 24), 150, 192);
    const view = draw(<Menu placement="bottom-end" trigger="More" items={[{ key: 'a', label: 'Print' }]} />);
    click(view.container.querySelector('[aria-haspopup="menu"]'));
    // 260 - 192.
    expect(view.container.querySelector<HTMLElement>('[role="menu"]')!.style.left).toBe('68px');
  });

  it('counts from the dialog it is in when that is what "fixed" counts from', () => {
    // An open Modal's panel is transformed: a fixed box inside it is placed from the panel, not the screen.
    screen(box(40, 60, 280, 40));
    const view = draw(
      <div style={{ transform: 'scale(1)' }}>
        <Select options={options} fullWidth />
      </div>
    );
    click(view.container.querySelector('[role="combobox"]'));
    const list = listOf(view);
    // Every box here is the mocked one, the panel's too: at 40, 60.
    expect(list.style.left).toBe('0px');
    expect(list.style.top).toBe('46px');
  });

  it('where nothing is laid out, a popup keeps the place its component gives it', () => {
    const view = draw(<Select options={options} />);
    click(view.container.querySelector('[role="combobox"]'));
    const list = listOf(view);
    expect(list.style.position).toBe('absolute');
    expect(list.style.top).toBe('100%');
  });
});

describe('a Table on a phone', () => {
  const people = [
    { id: 1, name: 'Ada', email: 'ada@example.com', city: 'London' },
    { id: 2, name: 'Grace', email: 'grace@example.com', city: 'New York' },
  ];
  const columns = [
    { key: 'name', header: 'Name', sortable: true },
    { key: 'email', header: 'Email' },
    { key: 'city', header: 'City' },
  ];
  function screen(width: number, tableWidth: number) {
    const listeners = new Set<() => void>();
    let current = width;
    vi.stubGlobal('matchMedia', (query: string) => ({
      get matches() {
        const max = /max-width:\s*(\d+)px/.exec(query);
        return max ? current <= Number(max[1]) : false;
      },
      media: query,
      addEventListener: (_: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
    }));
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(() => tableWidth);
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => current - 32);
    return {
      resize(next: number) {
        current = next;
        act(() => listeners.forEach((listener) => listener()));
      },
    };
  }
  const region = (view: Mounted) => view.container.querySelector<HTMLElement>('[role="region"]')!;

  it('draws each row as a card when it is too wide for its box', () => {
    screen(360, 683);
    const view = draw(<Table data={people} columns={columns} />);
    expect(region(view).className).toBe('softn-table-cards');
    const rules = rulesOf(view);
    expect(rules).toContain('@media (max-width: 640px)');
    expect(rules).toContain('.softn-table-cards > table > tbody > tr > td[data-label]::before');
    // Still the table's own rows and cells, with their roles.
    expect(view.container.querySelectorAll('tbody tr[role="row"]')).toHaveLength(2);
    expect(view.container.querySelectorAll('tbody td[role="cell"]')).toHaveLength(6);
  });

  it('names each cell by its column, for the card', () => {
    screen(360, 683);
    const view = draw(<Table data={people} columns={columns} />);
    const first = Array.from(view.container.querySelectorAll('tbody tr')[0].querySelectorAll('td'));
    expect(first.map((cell) => cell.getAttribute('data-label'))).toEqual(['Name', 'Email', 'City']);
  });

  it('stays a table when it fits', () => {
    screen(360, 328);
    const view = draw(<Table data={people} columns={columns} />);
    expect(region(view).className).toBe('');
    expect(view.container.querySelector('style')).toBeNull();
  });

  it('stays a table on a wide screen, however wide it is', () => {
    screen(1280, 2000);
    const view = draw(<Table data={people} columns={columns} />);
    expect(region(view).className).toBe('');
  });

  it('is cards whatever its width with mobileCards="always", and never with "never"', () => {
    screen(360, 328);
    expect(region(draw(<Table data={people} columns={columns} mobileCards="always" />)).className).toBe('softn-table-cards');
    vi.restoreAllMocks();
    screen(360, 683);
    expect(region(draw(<Table data={people} columns={columns} mobileCards="never" />)).className).toBe('');
  });

  it('is a table again when the screen is widened, and measured afresh when it is narrowed', () => {
    const display = screen(360, 683);
    const view = draw(<Table data={people} columns={columns} className="mine" />);
    expect(region(view).className).toBe('softn-table-cards mine');
    display.resize(1280);
    expect(region(view).className).toBe('mine');
    display.resize(360);
    expect(region(view).className).toBe('softn-table-cards mine');
  });

  it('keeps its sorting within reach: the header row is kept, as it was', () => {
    screen(360, 683);
    const view = draw(<Table data={people} columns={columns} />);
    click(view.container.querySelector('th[aria-sort] button'));
    click(view.container.querySelector('th[aria-sort] button'));
    expect(view.container.querySelector('tbody td')!.textContent).toBe('Grace');
    expect(rulesOf(view)).toContain('th:not([aria-sort])');
  });

  it('draws the same table as before where there is no screen to ask', () => {
    const markup = renderToStaticMarkup(<Table data={people} columns={columns} />);
    expect(markup).not.toContain('softn-table-cards');
    expect(markup).toContain('<td style="padding:0.75rem 1rem;text-align:left');
  });
});

describe('small controls under a finger', () => {
  it('a Drawer’s close button is 44 pixels', () => {
    const view = draw(<Drawer open onClose={() => {}} title="Details" />);
    expect(document.body.innerHTML).toMatch(/@media \(pointer: coarse\) \{\s*\.softn-drawer-close \{ width: 44px !important; height: 44px !important;/);
    expect(view.container.querySelector('.softn-drawer-close')).not.toBeNull();
  });

  it('a Modal’s close button is 44 pixels', () => {
    const view = draw(<Modal open onClose={() => {}} title="Details" />);
    expect(rulesOf(view)).toMatch(/@media \(pointer: coarse\) \{ \.softn-modal-close \{ min-width: 44px; min-height: 44px; \} \}/);
    expect(view.container.querySelector('.softn-modal-close')).not.toBeNull();
  });

  it('a calendar’s days, its arrows and its field are', () => {
    const view = draw(<DatePicker defaultValue="2026-11-12" />);
    click(view.container.querySelector('input'));
    const rules = rulesOf(view);
    expect(rules).toContain('.softn-date-day, .softn-date-blank { height: 44px !important; }');
    expect(rules).toContain('width: min(44px, calc((100vw - 46px) / 7)) !important;');
    expect(rules).toContain('.softn-date-nav { min-width: 40px; min-height: 44px; }');
    expect(rules).toContain('.softn-date-field { min-height: 44px; }');
    expect(view.container.querySelectorAll('button.softn-date-day')).toHaveLength(30);
    expect(view.container.querySelectorAll('button.softn-date-nav')).toHaveLength(5);
    expect(view.container.querySelector('.softn-date-clear')!.getAttribute('aria-label')).toBe('Clear date');
  });

  it('a Select’s trigger, its options and its clear button are', () => {
    const view = draw(<Select options={['One', 'Two']} defaultValue="One" clearable />);
    const rules = rulesOf(view);
    expect(rules).toContain('.softn-select-trigger { min-height: 44px !important; }');
    expect(rules).toContain('.softn-select-clear { width: 44px !important; height: 44px !important;');
    expect(view.container.querySelector('.softn-select-clear')!.getAttribute('aria-label')).toBe('Clear selection');
    click(view.container.querySelector('[role="combobox"]'));
    expect(rulesOf(view)).toContain('.softn-select-option { min-height: 44px; }');
    expect(view.container.querySelectorAll('.softn-select-option')).toHaveLength(2);
  });

  it('a DatePicker’s clear button stands at the end of its field, not of the row the field is in', () => {
    const view = draw(<DatePicker defaultValue="2026-11-12" />);
    const fieldBox = view.container.querySelector('input')!.parentElement as HTMLElement;
    expect(fieldBox.style.display).toBe('inline-block');
    const wide = draw(<DatePicker defaultValue="2026-11-12" fullWidth />);
    expect((wide.container.querySelector('input')!.parentElement as HTMLElement).style.display).toBe('block');
  });
});

describe('a FileChooser', () => {
  const file = (name: string, type: string) => new File(['x'], name, { type });
  /** Hand the chooser files as the picker does. */
  function pick(view: Mounted, files: File[]) {
    const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, 'files', { value: files, configurable: true });
    act(() => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }
  const names = (calls: FileInfo[][]) => calls.map((files) => files.map((info) => info.name));

  it('holds a picked file to `accept`, as it does a dropped one', () => {
    const calls: FileInfo[][] = [];
    const view = draw(<FileChooser accept="image/*,.pdf" multiple onSelect={(files) => calls.push(files)} />);
    pick(view, [file('holiday.png', 'image/png'), file('notes.txt', 'text/plain'), file('contract.pdf', 'application/pdf')]);
    expect(names(calls)).toEqual([['holiday.png', 'contract.pdf']]);
    expect(view.container.querySelector('[role="status"]')!.textContent).toBe('1 file was not an accepted type');
    // Nothing accepted: the page hears nothing, and the person is told.
    pick(view, [file('notes.txt', 'text/plain')]);
    expect(calls).toHaveLength(1);
  });

  it('takes a picked file whose type the browser does not know', () => {
    const calls: FileInfo[][] = [];
    const view = draw(<FileChooser accept="image/*" onSelect={(files) => calls.push(files)} />);
    pick(view, [file('photo.heic', '')]);
    expect(names(calls)).toEqual([['photo.heic']]);
  });

  it('lets the person take a choice back, and hands the page what is left', () => {
    const calls: FileInfo[][] = [];
    const view = draw(<FileChooser variant="dropzone" multiple onSelect={(files) => calls.push(files)} />);
    pick(view, [file('one.png', 'image/png'), file('two.png', 'image/png')]);
    click(view.container.querySelector('[aria-label="Remove one.png"]'));
    expect(names(calls)).toEqual([['one.png', 'two.png'], ['two.png']]);
    expect(view.container.textContent).not.toContain('one.png');
    expect(view.container.textContent).toContain('two.png');
  });

  it('on the button, removes what was chosen', () => {
    const calls: FileInfo[][] = [];
    const view = draw(<FileChooser onSelect={(files) => calls.push(files)} />);
    pick(view, [file('one.png', 'image/png')]);
    expect(view.container.querySelector('[aria-live="polite"]')!.textContent).toBe('one.png');
    click(view.container.querySelector('[aria-label="Remove one.png"]'));
    expect(view.container.querySelector('[aria-live="polite"]')!.textContent).toBe('');
    expect(names(calls)).toEqual([['one.png'], []]);
    expect(view.container.querySelector('.softn-file-remove')).toBeNull();
  });

  it('shows what the page says is chosen, and none once the page clears it', () => {
    const chosen: FileInfo[] = [{ name: 'sent.png', size: 2048, type: 'image/png', ref: 'r1' }];
    const view = draw(<FileChooser value={chosen} />);
    expect(view.container.querySelector('[aria-live="polite"]')!.textContent).toBe('sent.png');
    view.rerender(<FileChooser value={[]} />);
    expect(view.container.querySelector('[aria-live="polite"]')!.textContent).toBe('');
    // An unset variable arrives as null: none, not an error.
    view.rerender(<FileChooser value={null} />);
    expect(view.container.querySelector('[aria-live="polite"]')!.textContent).toBe('');
  });

  it('given `value`, shows only what the page accepts of what is picked', () => {
    const calls: FileInfo[][] = [];
    const view = draw(<FileChooser value={[]} onSelect={(files) => calls.push(files)} />);
    pick(view, [file('one.png', 'image/png')]);
    expect(names(calls)).toEqual([['one.png']]);
    expect(view.container.querySelector('[aria-live="polite"]')!.textContent).toBe('');
  });

  it('turned off, takes nothing', () => {
    const calls: FileInfo[][] = [];
    const chosen: FileInfo[] = [{ name: 'kept.png', size: 1, type: 'image/png', ref: 'r1' }];
    const view = draw(<FileChooser disabled value={chosen} onSelect={(files) => calls.push(files)} />);
    expect(view.container.querySelector<HTMLButtonElement>('button.softn-file-button')!.disabled).toBe(true);
    expect(view.container.querySelector<HTMLInputElement>('input[type="file"]')!.disabled).toBe(true);
    expect(view.container.querySelector('.softn-file-remove')).toBeNull();
    const zone = draw(<FileChooser disabled variant="dropzone" onSelect={(files) => calls.push(files)} />);
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.assign(drop, { dataTransfer: { files: [file('one.png', 'image/png')] } });
    act(() => {
      zone.container.querySelector('input[type="file"]')!.nextElementSibling!.dispatchEvent(drop);
    });
    expect(calls).toEqual([]);
  });

  it('is 44 pixels tall under a finger', () => {
    const view = draw(<FileChooser />);
    expect(rulesOf(view)).toContain('.softn-file-button { min-height: 44px; }');
  });
});
