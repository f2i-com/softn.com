/**
 * Rating, SegmentedControl and NumberInput: the three controls that hold
 * one value.
 *
 * Each is tested twice. As a component: what it draws, what the keyboard
 * does, what `onChange` is given, and that a parent which keeps the old
 * value is believed. And through `.ui` source with core's own renderer,
 * because that is how an app meets them: `:bind` hands the state in as
 * `value` (an unset one as ""), and writes back whatever `onChange` is
 * called with. A control that handed back an event, or the text of a
 * number, would bind without complaint and store the wrong thing.
 */

import { useState } from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { act } from 'react';
import { parse, renderDocument, ComponentRegistry } from '@softn/core';
import type { SoftNRenderContext, SoftNComponent } from '@softn/core';
import { mount, click, type } from './dom';
import { Rating } from '../src/form/Rating';
import { SegmentedControl } from '../src/form/SegmentedControl';
import { NumberInput } from '../src/form/NumberInput';

beforeEach(() => {
  document.body.innerHTML = '';
});

function press(element: Element | null | undefined, key: string): void {
  if (!element) throw new Error('press: element not found');
  act(() => {
    element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
}

function blur(element: HTMLElement | null | undefined): void {
  if (!element) throw new Error('blur: element not found');
  act(() => {
    element.focus();
    element.blur();
  });
}

/**
 * A page of `.ui` source over real state: what `setState` is called with
 * becomes the state the next render reads, as in the runtime.
 */
function App({ source, initial, seen }: { source: string; initial: Record<string, unknown>; seen: unknown[][] }) {
  const [state, setState] = useState(initial);
  const registry = new ComponentRegistry();
  registry.registerAll({ Rating, SegmentedControl, NumberInput } as unknown as Record<string, SoftNComponent>);
  const context: SoftNRenderContext = {
    state,
    setState: (path, value) => {
      seen.push([path, value]);
      setState((previous) => ({ ...previous, [path]: value }));
    },
    data: {},
    props: {},
    functions: {
      note: (...args: unknown[]) => {
        seen.push(['note', ...args]);
      },
    },
    asyncFunctions: {},
    computed: {},
  };
  const doc = parse(source);
  if (doc.diagnostics?.length) throw new Error(doc.diagnostics.map((d) => d.message).join('; '));
  return <>{renderDocument(doc, context, registry)}</>;
}

function mountSource(source: string, initial: Record<string, unknown> = {}) {
  const seen: unknown[][] = [];
  const mounted = mount(<App source={source} initial={initial} seen={seen} />);
  return { ...mounted, seen };
}

// ---------------------------------------------------------------------------
// Rating
// ---------------------------------------------------------------------------

describe('Rating', () => {
  const stars = (container: HTMLElement) => [...container.querySelectorAll<HTMLButtonElement>('[role=radio]')];

  it('is a radio group with one star checked and one tab stop', () => {
    const { container } = mount(<Rating value={3} ariaLabel="Quality" />);
    const group = container.querySelector('[role=radiogroup]')!;
    expect(group.getAttribute('aria-label')).toBe('Quality');
    const all = stars(container);
    expect(all).toHaveLength(5);
    expect(all.map((s) => s.getAttribute('aria-checked'))).toEqual(['false', 'false', 'true', 'false', 'false']);
    expect(all.map((s) => s.tabIndex)).toEqual([-1, -1, 0, -1, -1]);
    expect(all.map((s) => s.getAttribute('aria-label'))).toEqual(['1 star', '2 stars', '3 stars', '4 stars', '5 stars']);
  });

  it('keeps a tab stop when nothing is chosen', () => {
    const { container } = mount(<Rating />);
    expect(stars(container).map((s) => s.tabIndex)).toEqual([0, -1, -1, -1, -1]);
  });

  it('gives onChange the score, as a number', () => {
    const seen: unknown[] = [];
    const { container } = mount(<Rating onChange={(v) => seen.push(v)} />);
    click(stars(container)[3]);
    expect(seen).toEqual([4]);
    expect(stars(container)[3].getAttribute('aria-checked')).toBe('true');
  });

  it('clears on the chosen star again, unless told not to', () => {
    const seen: unknown[] = [];
    const first = mount(<Rating defaultValue={2} onChange={(v) => seen.push(v)} />);
    click(stars(first.container)[1]);
    expect(seen).toEqual([0]);
    first.unmount();

    const kept: unknown[] = [];
    const second = mount(<Rating defaultValue={2} allowClear={false} onChange={(v) => kept.push(v)} />);
    click(stars(second.container)[1]);
    expect(kept).toEqual([]);
    expect(stars(second.container)[1].getAttribute('aria-checked')).toBe('true');
  });

  it('moves with the arrow keys, Home and End, and stops at the ends', () => {
    const seen: unknown[] = [];
    const { container } = mount(<Rating defaultValue={2} onChange={(v) => seen.push(v)} />);
    const group = container.querySelector('[role=radiogroup]')!;
    press(group, 'ArrowRight');
    press(group, 'ArrowUp');
    press(group, 'End');
    press(group, 'ArrowRight');
    press(group, 'ArrowLeft');
    press(group, 'Home');
    expect(seen).toEqual([3, 4, 5, 4, 0]);
  });

  it('believes a parent that keeps the old score', () => {
    const seen: unknown[] = [];
    const { container } = mount(<Rating value={2} onChange={(v) => seen.push(v)} />);
    click(stars(container)[4]);
    expect(seen).toEqual([5]);
    expect(stars(container).map((s) => s.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false', 'false', 'false']);
  });

  it('reads a score out of range, or one that is not a number, as the nearest it can show', () => {
    expect(stars(mount(<Rating value={9} />).container).at(-1)!.getAttribute('aria-checked')).toBe('true');
    expect(stars(mount(<Rating value={'3'} />).container)[2].getAttribute('aria-checked')).toBe('true');
    const none = stars(mount(<Rating value={'many'} />).container);
    expect(none.some((s) => s.getAttribute('aria-checked') === 'true')).toBe(false);
  });

  it('is an image with its score in words when read-only', () => {
    const { container } = mount(<Rating value={3} max={5} readOnly ariaLabel="Average rating" />);
    const image = container.querySelector('[role=img]')!;
    expect(image.getAttribute('aria-label')).toBe('Average rating: 3 out of 5');
    expect(container.querySelector('button')).toBeNull();
  });

  it('does nothing when disabled', () => {
    const seen: unknown[] = [];
    const { container } = mount(<Rating disabled onChange={(v) => seen.push(v)} />);
    click(stars(container)[2]);
    press(container.querySelector('[role=radiogroup]'), 'ArrowRight');
    expect(seen).toEqual([]);
  });

  it('does not put a url() written as its colour into the page', () => {
    const { container } = mount(<Rating value={1} color="url(https://tracker.example/x.png)" />);
    expect(container.innerHTML).not.toContain('tracker.example');
  });

  it('binds: the state arrives as the score and the score is written back', () => {
    const { container, seen } = mountSource('<Rating :bind={score} @change={(value) => note(value)} />', {});
    // Unset state reaches the control as "", which is no score, not an error.
    expect(stars(container).some((s) => s.getAttribute('aria-checked') === 'true')).toBe(false);
    click(stars(container)[3]);
    expect(seen).toEqual([['score', 4], ['note', 4]]);
    expect(stars(container)[3].getAttribute('aria-checked')).toBe('true');
  });

  it('binds: an app that clears its state clears the stars', () => {
    // The first click happened while the state was unset. A control that
    // took the empty state as leave to keep its own score went on showing
    // four stars after the app had set the score back to nothing.
    const { container } = mountSource(
      '<Rating :bind={score} /><button id="reset" @click={() => score = null}>Reset</button>',
      {}
    );
    click(stars(container)[3]);
    expect(stars(container)[3].getAttribute('aria-checked')).toBe('true');
    click(container.querySelector('#reset'));
    expect(stars(container).some((s) => s.getAttribute('aria-checked') === 'true')).toBe(false);
    // And it can be scored again from nothing.
    click(stars(container)[1]);
    expect(stars(container).map((s) => s.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false', 'false', 'false']);
  });
});

// ---------------------------------------------------------------------------
// SegmentedControl
// ---------------------------------------------------------------------------

describe('SegmentedControl', () => {
  const VIEWS = [
    { value: 'day', label: 'Day' },
    { value: 'week', label: 'Week' },
    { value: 'month', label: 'Month', disabled: true },
    { value: 'year', label: 'Year' },
  ];
  const options = (container: HTMLElement) => [...container.querySelectorAll<HTMLButtonElement>('[role=radio]')];
  const checked = (container: HTMLElement) => options(container).map((o) => o.getAttribute('aria-checked') === 'true');

  it('is a radio group whose chosen option is the tab stop', () => {
    const { container } = mount(<SegmentedControl options={VIEWS} value="week" ariaLabel="Range" />);
    expect(container.querySelector('[role=radiogroup]')!.getAttribute('aria-label')).toBe('Range');
    expect(options(container).map((o) => o.textContent)).toEqual(['Day', 'Week', 'Month', 'Year']);
    expect(checked(container)).toEqual([false, true, false, false]);
    expect(options(container).map((o) => o.tabIndex)).toEqual([-1, 0, -1, -1]);
    expect(options(container)[2].disabled).toBe(true);
  });

  it('takes plain values as options and shows them as their own labels', () => {
    const { container } = mount(<SegmentedControl options={['List', 'Board', 7]} defaultValue="Board" />);
    expect(options(container).map((o) => o.textContent)).toEqual(['List', 'Board', '7']);
    expect(checked(container)).toEqual([false, true, false]);
  });

  it('gives onChange the value of the option, not its label or an event', () => {
    const seen: unknown[] = [];
    const { container } = mount(<SegmentedControl options={VIEWS} defaultValue="day" onChange={(v) => seen.push(v)} />);
    click(options(container)[3]);
    expect(seen).toEqual(['year']);
    expect(checked(container)).toEqual([false, false, false, true]);
  });

  it('says nothing for the option already chosen, or a disabled one', () => {
    const seen: unknown[] = [];
    const { container } = mount(<SegmentedControl options={VIEWS} defaultValue="day" onChange={(v) => seen.push(v)} />);
    click(options(container)[0]);
    click(options(container)[2]);
    expect(seen).toEqual([]);
  });

  it('moves the choice with the arrow keys, past a disabled option and around the ends', () => {
    const seen: unknown[] = [];
    const { container } = mount(<SegmentedControl options={VIEWS} defaultValue="week" onChange={(v) => seen.push(v)} />);
    const group = container.querySelector('[role=radiogroup]')!;
    press(group, 'ArrowRight'); // over Month
    press(group, 'ArrowRight'); // around to Day
    press(group, 'ArrowLeft'); // back around to Year
    press(group, 'Home');
    press(group, 'End');
    expect(seen).toEqual(['year', 'day', 'year', 'day', 'year']);
    expect(document.activeElement).toBe(options(container)[3]);
  });

  it('believes a parent that keeps the old choice', () => {
    const { container } = mount(<SegmentedControl options={VIEWS} value="day" onChange={() => {}} />);
    click(options(container)[1]);
    expect(checked(container)).toEqual([true, false, false, false]);
  });

  it('matches a number in state to the option that reads the same', () => {
    const { container } = mount(<SegmentedControl options={[{ value: 1, label: 'One' }, { value: 2, label: 'Two' }]} value="2" />);
    expect(checked(container)).toEqual([false, true]);
  });

  it('survives options that are not a list', () => {
    const { container } = mount(<SegmentedControl options={undefined} />);
    expect(container.querySelector('[role=radiogroup]')).not.toBeNull();
    expect(options(container)).toEqual([]);
  });

  it('binds: the state arrives as the choice and the value is written back', () => {
    const { container, seen } = mountSource(
      '<SegmentedControl :bind={view} options={["List", "Board"]} @change={(value) => note(value)} />',
      {}
    );
    expect(checked(container)).toEqual([false, false]);
    click(options(container)[1]);
    expect(seen).toEqual([['view', 'Board'], ['note', 'Board']]);
    expect(checked(container)).toEqual([false, true]);
  });

  it('binds: an app that clears its state clears the choice', () => {
    const { container } = mountSource(
      '<SegmentedControl :bind={view} options={["List", "Board"]} /><button id="reset" @click={() => view = null}>Reset</button>',
      {}
    );
    click(options(container)[1]);
    expect(checked(container)).toEqual([false, true]);
    click(container.querySelector('#reset'));
    expect(checked(container)).toEqual([false, false]);
  });
});

// ---------------------------------------------------------------------------
// NumberInput
// ---------------------------------------------------------------------------

describe('NumberInput', () => {
  const field = (container: HTMLElement) => container.querySelector<HTMLInputElement>('input')!;
  const button = (container: HTMLElement, name: string) =>
    container.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!;

  it('is a spinbutton that says its value and range', () => {
    const { container } = mount(<NumberInput value={4} min={1} max={10} ariaLabel="Quantity" />);
    const input = field(container);
    expect(input.getAttribute('role')).toBe('spinbutton');
    expect(input.getAttribute('aria-label')).toBe('Quantity');
    expect(input.getAttribute('aria-valuenow')).toBe('4');
    expect(input.getAttribute('aria-valuemin')).toBe('1');
    expect(input.getAttribute('aria-valuemax')).toBe('10');
    expect(input.value).toBe('4');
  });

  it('gives onChange a number, and null for an emptied field', () => {
    const seen: unknown[] = [];
    const { container } = mount(<NumberInput defaultValue={1} onChange={(v) => seen.push(v)} />);
    type(field(container), '12');
    type(field(container), '');
    expect(seen).toEqual([12, null]);
  });

  it('leaves text that is on the way to a number alone, and sends nothing for it', () => {
    const seen: unknown[] = [];
    const { container } = mount(<NumberInput defaultValue={1} onChange={(v) => seen.push(v)} />);
    type(field(container), '-');
    expect(field(container).value).toBe('-');
    type(field(container), '1.');
    expect(field(container).value).toBe('1.');
    type(field(container), '1.5');
    // "1." is already the number 1, the value the field held: nothing to say.
    expect(seen).toEqual([1.5]);
  });

  it('steps with the buttons and stops at the ends', () => {
    const seen: unknown[] = [];
    const { container } = mount(<NumberInput defaultValue={9} min={0} max={10} onChange={(v) => seen.push(v)} />);
    click(button(container, 'Increase'));
    expect(seen).toEqual([10]);
    expect(button(container, 'Increase').disabled).toBe(true);
    click(button(container, 'Decrease'));
    expect(seen).toEqual([10, 9]);
  });

  it('steps with the arrow keys and pages by ten, to the ends with Home and End', () => {
    const seen: unknown[] = [];
    const { container } = mount(<NumberInput defaultValue={50} min={0} max={100} step={5} onChange={(v) => seen.push(v)} />);
    const input = field(container);
    press(input, 'ArrowUp');
    press(input, 'ArrowDown');
    press(input, 'PageUp');
    press(input, 'End');
    press(input, 'Home');
    expect(seen).toEqual([55, 50, 100, 0]);
  });

  it('keeps decimal steps exact', () => {
    const seen: unknown[] = [];
    const { container } = mount(<NumberInput defaultValue={0.1} step={0.1} onChange={(v) => seen.push(v)} />);
    press(field(container), 'ArrowUp');
    press(field(container), 'ArrowUp');
    // 0.1 + 0.1 + 0.1 is 0.30000000000000004 without the rounding.
    expect(seen).toEqual([0.2, 0.3]);
  });

  it('starts from the minimum, or counts from zero, when stepped from empty', () => {
    const withMin: unknown[] = [];
    const first = mount(<NumberInput min={5} onChange={(v) => withMin.push(v)} />);
    press(field(first.container), 'ArrowUp');
    expect(withMin).toEqual([5]);
    first.unmount();

    const free: unknown[] = [];
    const second = mount(<NumberInput onChange={(v) => free.push(v)} />);
    press(field(second.container), 'ArrowDown');
    expect(free).toEqual([-1]);
  });

  it('does not drag a number being typed up to the minimum, and settles it on leaving', () => {
    const seen: unknown[] = [];
    const { container } = mount(<NumberInput defaultValue={20} min={10} max={99} onChange={(v) => seen.push(v)} />);
    type(field(container), '1');
    // "1" may be the start of "15": kept as typed, not sent, not rewritten.
    expect(field(container).value).toBe('1');
    expect(seen).toEqual([]);
    blur(field(container));
    expect(seen).toEqual([10]);
    expect(field(container).value).toBe('10');
  });

  it('rounds what was typed to the precision on leaving', () => {
    const seen: unknown[] = [];
    const { container } = mount(<NumberInput defaultValue={1} precision={2} onChange={(v) => seen.push(v)} />);
    type(field(container), '3.14159');
    blur(field(container));
    expect(seen).toEqual([3.14159, 3.14]);
    expect(field(container).value).toBe('3.14');
  });

  it('believes a parent that keeps the old number', () => {
    const { container } = mount(<NumberInput value={5} onChange={() => {}} />);
    type(field(container), '8');
    expect(field(container).value).toBe('5');
  });

  it('shows the number the app sets while the field holds typed text', () => {
    const { container, rerender } = mount(<NumberInput value={5} onChange={() => {}} />);
    rerender(<NumberInput value={42} onChange={() => {}} />);
    expect(field(container).value).toBe('42');
  });

  it('does not change when read-only or disabled', () => {
    const seen: unknown[] = [];
    const readOnly = mount(<NumberInput defaultValue={3} readOnly onChange={(v) => seen.push(v)} />);
    press(field(readOnly.container), 'ArrowUp');
    expect(button(readOnly.container, 'Increase').disabled).toBe(true);
    readOnly.unmount();
    const disabled = mount(<NumberInput defaultValue={3} disabled onChange={(v) => seen.push(v)} />);
    expect(field(disabled.container).disabled).toBe(true);
    expect(seen).toEqual([]);
  });

  it('can be shown without its buttons', () => {
    const { container } = mount(<NumberInput defaultValue={3} hideControls />);
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  it('binds: an unset state is an empty field, and what is typed is stored as a number', () => {
    const { container, seen } = mountSource('<NumberInput :bind={qty} min={0} max={99} />', {});
    expect(field(container).value).toBe('');
    type(field(container), '7');
    expect(seen).toEqual([['qty', 7]]);
    expect(typeof seen[0][1]).toBe('number');
    click(button(container, 'Increase'));
    expect(seen.at(-1)).toEqual(['qty', 8]);
    expect(field(container).value).toBe('8');
  });

  it('binds: emptying the field stores null, not an empty string', () => {
    const { container, seen } = mountSource('<NumberInput :bind={qty} />', { qty: 3 });
    expect(field(container).value).toBe('3');
    type(field(container), '');
    expect(seen).toEqual([['qty', null]]);
    expect(field(container).value).toBe('');
  });
});
