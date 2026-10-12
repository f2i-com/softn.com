/**
 * A DatePicker hands back the day as text, "YYYY-MM-DD", which is what
 * `:bind` stores.
 *
 * It handed back a `Date`, so the state an app kept held an object that does
 * not survive JSON: written to storage or sent over sync it came back as a
 * moment in UTC, or as nothing. It still shows a `Date`, a timestamp, an ISO
 * string or the stored text it is given, so an app that stored any of them
 * still shows its day.
 */

import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { parse, renderDocument, ComponentRegistry } from '@softn/core';
import type { SoftNRenderContext, SoftNComponent } from '@softn/core';
import { mount } from './dom';
import { DatePicker } from '../src/form/DatePicker';

function App({ source, initial, writes }: { source: string; initial: Record<string, unknown>; writes: unknown[] }) {
  const [state, setState] = useState(initial);
  const registry = new ComponentRegistry();
  registry.registerAll({ DatePicker } as unknown as Record<string, SoftNComponent>);
  const context = {
    state,
    setState: (path: string, value: unknown) => {
      writes.push(value);
      setState((previous) => ({ ...previous, [path]: value }));
    },
    data: {},
    props: {},
    functions: {},
    asyncFunctions: {},
    computed: {},
  } as unknown as SoftNRenderContext;
  return <>{renderDocument(parse(source), context, registry)}</>;
}

function key(target: Element | null, name: string): void {
  if (!target) throw new Error(`key ${name}: no target`);
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
  });
}

/** Open the calendar from the field, move a day on, and choose it. */
function pickNextDay(container: HTMLElement): void {
  const input = container.querySelector('input')!;
  act(() => input.focus());
  key(input, 'Enter');
  key(document.activeElement, 'ArrowRight');
  key(document.activeElement, 'Enter');
}

describe('a DatePicker bound to state', () => {
  it('stores the day it was given the next day of as text', () => {
    const writes: unknown[] = [];
    const { container, unmount } = mount(<App source="<DatePicker :bind={due} />" initial={{ due: '2024-03-15' }} writes={writes} />);
    pickNextDay(container);
    expect(writes).toEqual(['2024-03-16']);
    expect(container.querySelector('input')!.value).toBe('2024-03-16');
    unmount();
  });

  it.each([
    ['a Date', new Date(2024, 2, 15)],
    ['a timestamp', new Date(2024, 2, 15, 9, 30).getTime()],
    ['an ISO date and time', new Date(2024, 2, 15, 9, 30).toISOString()],
    ['the stored text', '2024-03-15'],
  ])('shows %s in state as its day, and stores text when a day is chosen', (_, stored) => {
    const writes: unknown[] = [];
    const { container, unmount } = mount(<App source="<DatePicker :bind={due} />" initial={{ due: stored }} writes={writes} />);
    expect(container.querySelector('input')!.value).toBe('2024-03-15');
    pickNextDay(container);
    expect(writes).toEqual(['2024-03-16']);
    unmount();
  });

  it('stores nothing as null when the date is cleared', () => {
    const writes: unknown[] = [];
    const { container, unmount } = mount(<App source="<DatePicker :bind={due} />" initial={{ due: '2024-03-15' }} writes={writes} />);
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Clear date"]')!.click());
    expect(writes).toEqual([null]);
    unmount();
  });
});

describe('a DatePicker’s onChange', () => {
  it('is given the text the binding stores, and the same text after it', () => {
    const onChange = vi.fn();
    const { container, unmount } = mount(<DatePicker defaultValue="2024-01-15" onChange={onChange} />);
    pickNextDay(container);
    expect(onChange).toHaveBeenCalledWith('2024-01-16', '2024-01-16');
    unmount();
  });
});
