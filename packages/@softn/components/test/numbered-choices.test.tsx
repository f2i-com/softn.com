/**
 * Select and Radio given choices that are numbers.
 *
 * A list of records is the usual source of options, and a record's id is
 * usually a number: `options={users.map((u) => ({ value: u.id, label: u.name }))}`.
 * A number also comes the other way, from state, when the options are
 * written as text (`options={[1, 2, 3]}` is read as "1", "2", "3"). The
 * value and the option that reads the same are the same choice, as
 * SegmentedControl already treats them.
 */

import { useState } from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { act } from 'react';
import { parse, renderDocument, ComponentRegistry } from '@softn/core';
import type { SoftNRenderContext, SoftNComponent } from '@softn/core';
import { mount, click, type, check } from './dom';
import { Select } from '../src/form/Select';
import { Radio } from '../src/form/Radio';

beforeEach(() => {
  document.body.innerHTML = '';
});

function press(element: Element | null | undefined, key: string): void {
  if (!element) throw new Error('press: element not found');
  act(() => {
    element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
}

/** A page of `.ui` source over real state, as the runtime keeps it. */
function App({ source, initial }: { source: string; initial: Record<string, unknown> }) {
  const [state, setState] = useState(initial);
  const registry = new ComponentRegistry();
  registry.registerAll({ Select, Radio } as unknown as Record<string, SoftNComponent>);
  const context = {
    state,
    setState: (path: string, value: unknown) => setState((previous) => ({ ...previous, [path]: value })),
    data: {},
    props: {},
    functions: {},
    asyncFunctions: {},
    computed: {},
  } as unknown as SoftNRenderContext;
  const doc = parse(source);
  if (doc.diagnostics?.length) throw new Error(doc.diagnostics.map((d) => d.message).join('; '));
  return <>{renderDocument(doc, context, registry)}</>;
}

const PEOPLE = [
  { value: 7, label: 'Ada' },
  { value: 12, label: 'Grace' },
];

const trigger = (container: HTMLElement) => container.querySelector<HTMLElement>('[role="combobox"]')!;
const radios = (container: HTMLElement) => Array.from(container.querySelectorAll<HTMLInputElement>('input[type="radio"]'));

describe('Select with numbers for values', () => {
  it('shows the label of the option whose value is the number in state', () => {
    const { container } = mount(<Select options={[1, 2, 3] as never} value={2 as unknown as string} />);
    expect(trigger(container).textContent).toBe('2');
    click(trigger(container));
    const selected = Array.from(container.querySelectorAll('[role="option"]')).map((o) => o.getAttribute('aria-selected'));
    expect(selected).toEqual(['false', 'true', 'false']);
  });

  it('shows the option chosen when the state holds the number as text', () => {
    const { container } = mount(<Select options={PEOPLE as never} value="12" />);
    expect(trigger(container).textContent).toBe('Grace');
  });

  it('can be searched when the options are numbered', () => {
    const { container } = mount(<Select searchable options={PEOPLE as never} />);
    click(trigger(container));
    const search = container.querySelector<HTMLInputElement>('input[type="text"]')!;
    type(search, 'gr');
    expect(Array.from(container.querySelectorAll('[role="option"]')).map((o) => o.textContent)).toEqual(['Grace']);
    type(search, '12');
    expect(Array.from(container.querySelectorAll('[role="option"]')).map((o) => o.textContent)).toEqual(['Grace']);
  });

  it('takes a typed letter on the trigger when a label is a number', () => {
    const { container } = mount(<Select options={[{ value: 2024, label: 2024 }, { value: 2025, label: 2025 }] as never} />);
    trigger(container).focus();
    press(trigger(container), '2');
    expect(container.querySelectorAll('[role="option"]')).toHaveLength(2);
  });

  it('binds: a numbered option is shown chosen, and stays chosen once picked', () => {
    const { container } = mount(<App source="<Select :bind={owner} options={people} />" initial={{ owner: 7, people: PEOPLE }} />);
    expect(trigger(container).textContent).toBe('Ada');
    click(trigger(container));
    click(Array.from(container.querySelectorAll('[role="option"]'))[1]);
    expect(trigger(container).textContent).toBe('Grace');
  });
});

describe('Radio with numbers for values', () => {
  it('checks the option that reads the same as the number in state', () => {
    const { container } = mount(<Radio name="size" options={[1, 2, 3] as unknown as never} value={2 as unknown as string} />);
    expect(radios(container).map((r) => r.checked)).toEqual([false, true, false]);
  });

  it('binds: a numbered option stays checked once picked', () => {
    const { container } = mount(<App source="<Radio :bind={owner} options={people} />" initial={{ owner: 7, people: PEOPLE }} />);
    expect(radios(container).map((r) => r.checked)).toEqual([true, false]);
    check(radios(container)[1]);
    expect(radios(container).map((r) => r.checked)).toEqual([false, true]);
  });
});
