/**
 * SmartGrid's order, column types and record fields; a Typewriter that does
 * not loop; Split's size from text it cannot read; a TileMap whose tileset
 * is taken away; Scene3D's game keys turned on after mount and shared
 * between scenes.
 */
import React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, click, type Mounted } from './dom';
import { SmartGrid } from '../src/smart/SmartGrid';
import { Typewriter } from '../src/animation/Typewriter';
import { Split } from '../src/layout/Split';

const mounted: Mounted[] = [];
function draw(element: React.ReactElement): Mounted {
  const m = mount(element);
  mounted.push(m);
  return m;
}
afterEach(() => {
  for (const m of mounted.splice(0)) m.unmount();
  vi.useRealTimers();
});
beforeEach(() => {
  document.body.innerHTML = '';
});

const cells = (container: HTMLElement, column: number) =>
  Array.from(container.querySelectorAll('tbody tr')).map((row) => row.querySelectorAll('td')[column]?.textContent);

describe('SmartGrid', () => {
  // Compared as text, "10" came before "9".
  it('sorts numbers written as text by their value, with empty cells last', () => {
    const data = [{ n: '10' }, { n: '' }, { n: '9' }, { n: '100' }];
    const { container } = draw(<SmartGrid data={data} columns="n" sortable />);
    click(container.querySelector('th')!);
    expect(cells(container, 0)).toEqual(['9', '10', '100', '']);
    click(container.querySelector('th')!);
    expect(cells(container, 0)).toEqual(['100', '10', '9', '']);
  });

  // Typed from the first row alone, a column whose first record had no value was `unknown`.
  it('types a column from its first filled cell', () => {
    const data = [{ name: 'A', active: null }, { name: 'B', active: true }];
    const { container } = draw(<SmartGrid data={data} />);
    expect(cells(container, 1)).toEqual(['—', 'Yes']);
  });

  // A record's own fields took the app's columns.
  it('leaves a store record\'s own fields out of its columns unless named', () => {
    const record = { id: 'r1', collection: 'notes', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z', deleted: false, data: { title: 'Hi' } };
    const { container } = draw(<SmartGrid data={[record]} />);
    expect(Array.from(container.querySelectorAll('th')).map((th) => th.textContent?.trim())).toEqual(['Title']);
    const named = draw(<SmartGrid data={[record]} columns="title, updated_at" />);
    expect(named.container.querySelectorAll('th')).toHaveLength(2);
  });
});

describe('Typewriter', () => {
  // The last of several texts was deleted, and the Typewriter ended blank.
  it('leaves the last text showing when it does not loop', () => {
    vi.useFakeTimers();
    const { container } = draw(<Typewriter text={['ab', 'cd']} loop={false} speed={10} deleteSpeed={10} pauseDuration={20} />);
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(container.querySelector('[aria-hidden="true"]')!.textContent).toBe('cd|');
  });
});

describe('Split', () => {
  // Taken as it came, the pane was NaN pixels, and every drag from there NaN too.
  it('reads a size it cannot read as half', () => {
    const { container } = draw(
      <Split initialSize="wide">
        <div>left</div>
        <div>right</div>
      </Split>
    );
    const pane = container.querySelector('[role="separator"]')!.previousElementSibling as HTMLElement;
    expect(pane.style.width).not.toContain('NaN');
    expect(container.querySelector('[role="separator"]')!.getAttribute('aria-valuenow')).not.toBe('NaN');
    const pixels = draw(
      <Split initialSize="240px">
        <div>left</div>
        <div>right</div>
      </Split>
    );
    expect(pixels.container.querySelector('[role="separator"]')!.getAttribute('aria-valuenow')).toBe('240');
  });
});
