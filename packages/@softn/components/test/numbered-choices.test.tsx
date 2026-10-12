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
import { SegmentedControl } from '../src/form/SegmentedControl';

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
function App({ source, initial, writes = [] }: { source: string; initial: Record<string, unknown>; writes?: unknown[] }) {
  const [state, setState] = useState(initial);
  const registry = new ComponentRegistry();
  registry.registerAll({ Select, Radio, SegmentedControl } as unknown as Record<string, SoftNComponent>);
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

/**
 * What each of the three hands back when an option is chosen: the option's
 * own value, as SegmentedControl always has. Radio handed back the text of a
 * numbered option ("12" for 12), and Select the text of a bare number ("2"
 * for `options={[1, 2, 3]}`), so `:bind` stored text where the options held
 * numbers and `count === 2` was false after a pick.
 */
describe('the value a choice hands back', () => {
  const pick = {
    Radio: (container: HTMLElement, index: number) => check(radios(container)[index]),
    Select: (container: HTMLElement, index: number) => {
      click(trigger(container));
      click(Array.from(container.querySelectorAll('[role="option"]'))[index]);
    },
    SegmentedControl: (container: HTMLElement, index: number) => click(Array.from(container.querySelectorAll('[role="radio"]'))[index]),
  };

  it.each(Object.keys(pick) as Array<keyof typeof pick>)('%s: a number for a numbered option, given as a record or bare', (tag) => {
    for (const options of ['people', '[1, 2, 3]']) {
      const writes: unknown[] = [];
      const { container, unmount } = mount(<App source={`<${tag} :bind={owner} options={${options}} />`} initial={{ owner: null, people: PEOPLE }} writes={writes} />);
      pick[tag](container, 1);
      expect(writes, `${tag} ${options}`).toEqual([options === 'people' ? 12 : 2]);
      unmount();
    }
  });

  it.each(Object.keys(pick) as Array<keyof typeof pick>)('%s: text for an option that is text', (tag) => {
    const writes: unknown[] = [];
    const { container, unmount } = mount(<App source={`<${tag} :bind={plan} options={["solo", "team"]} />`} initial={{ plan: null }} writes={writes} />);
    pick[tag](container, 1);
    expect(writes).toEqual(['team']);
    unmount();
  });

  it('Radio tells its own onChange the value too, with the event after it', () => {
    const seen: unknown[] = [];
    const { container } = mount(<Radio name="n" options={PEOPLE as never} onChange={(value) => seen.push(value)} />);
    check(radios(container)[0]);
    expect(seen).toEqual([7]);
  });
});

/**
 * Reading values as text is for telling 2 from "2", not for values that only
 * look alike as text. Every record reads "[object Object]", so with records
 * for values Radio handed back the first option's whichever was picked, and
 * Select showed every option chosen and, in a multiple one, took the first
 * record out when a second was picked. Two options that do read alike (1 and
 * "1", or the same value twice) are still two options: the one picked is the
 * one handed back, and one of them is shown chosen.
 */
describe('values that read alike as text', () => {
  const ADA = { id: 1 };
  const GRACE = { id: 2 };
  const RECORDS = [
    { value: ADA, label: 'Ada' },
    { value: GRACE, label: 'Grace' },
  ];
  const chosen = (container: HTMLElement) =>
    Array.from(container.querySelectorAll('[role="option"]')).map((option) => option.getAttribute('aria-selected'));

  it('Radio hands back the record of the option that was picked', () => {
    const seen: unknown[] = [];
    const { container } = mount(<Radio name="n" options={RECORDS as never} onChange={(value) => seen.push(value)} />);
    check(radios(container)[1]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(GRACE);
    expect(radios(container).map((r) => r.checked)).toEqual([false, true]);
  });

  it('Radio checks the record that is the value, not every record', () => {
    const { container } = mount(<Radio name="n" options={RECORDS as never} value={ADA as never} />);
    expect(radios(container).map((r) => r.checked)).toEqual([true, false]);
  });

  it('Radio tells 1 from "1" when both are options', () => {
    const seen: unknown[] = [];
    const { container } = mount(<Radio name="n" options={[1, '1'] as never} onChange={(value) => seen.push(value)} />);
    check(radios(container)[1]);
    expect(seen).toEqual(['1']);
    expect(radios(container).map((r) => r.checked)).toEqual([false, true]);
    check(radios(container)[0]);
    expect(seen).toEqual(['1', 1]);
    expect(radios(container).map((r) => r.checked)).toEqual([true, false]);
  });

  it('Radio checks one option when the same value is given twice', () => {
    const { container } = mount(<Radio name="n" options={['a', 'a', 'b'] as never} value="a" />);
    expect(radios(container).map((r) => r.checked)).toEqual([true, false, false]);
  });

  it('Radio still checks an option whose value is null when the value is null', () => {
    const options = [{ value: null, label: 'Nobody' }, { value: 7, label: 'Ada' }];
    const { container } = mount(<Radio name="n" options={options as never} value={null as never} />);
    expect(radios(container).map((r) => r.checked)).toEqual([true, false]);
  });

  it('Select shows the record that is the value chosen, not every record', () => {
    const { container } = mount(<Select options={RECORDS as never} value={ADA as never} />);
    click(trigger(container));
    expect(chosen(container)).toEqual(['true', 'false']);
  });

  it('a multiple Select adds a second record to the first', () => {
    const seen: unknown[] = [];
    const { container } = mount(
      <Select multiple options={RECORDS as never} defaultValue={[ADA] as never} onChange={(value) => seen.push(value)} />
    );
    click(trigger(container));
    click(Array.from(container.querySelectorAll('[role="option"]'))[1]);
    expect(seen).toEqual([[ADA, GRACE]]);
    expect(chosen(container)).toEqual(['true', 'true']);
  });
  it('Select shows one option chosen when 1 and "1" are both options', () => {
    for (const [value, expected] of [[1, ['true', 'false']], ['1', ['false', 'true']]] as const) {
      const { container, unmount } = mount(<Select options={[1, '1'] as never} value={value as never} />);
      click(trigger(container));
      expect(chosen(container), String(typeof value)).toEqual(expected);
      unmount();
    }
  });

  it('Select shows one option chosen when the same value is given twice', () => {
    const { container } = mount(<Select options={['a', 'a', 'b'] as never} value="a" />);
    click(trigger(container));
    expect(chosen(container)).toEqual(['true', 'false', 'false']);
  });

  it('a multiple Select adds "1" to 1 when both are options, and takes out only the one picked again', () => {
    const seen: unknown[] = [];
    const { container } = mount(<Select multiple options={[1, '1', 2] as never} defaultValue={[1] as never} onChange={(value) => seen.push(value)} />);
    click(trigger(container));
    expect(chosen(container)).toEqual(['true', 'false', 'false']);
    click(Array.from(container.querySelectorAll('[role="option"]'))[1]);
    expect(seen).toEqual([[1, '1']]);
    expect(chosen(container)).toEqual(['true', 'true', 'false']);
    click(Array.from(container.querySelectorAll('[role="option"]'))[1]);
    expect(seen[1]).toEqual([1]);
    expect(chosen(container)).toEqual(['true', 'false', 'false']);
  });

  it('a multiple Select still takes out a number held as text when its option is picked again', () => {
    const seen: unknown[] = [];
    const { container } = mount(<Select multiple options={[1, 2] as never} value={['2'] as never} onChange={(value) => seen.push(value)} />);
    click(trigger(container));
    expect(chosen(container)).toEqual(['false', 'true']);
    click(Array.from(container.querySelectorAll('[role="option"]'))[1]);
    expect(seen).toEqual([[]]);
  });

  const segments = (container: HTMLElement) => Array.from(container.querySelectorAll('[role="radio"]')).map((b) => b.getAttribute('aria-checked'));

  it('SegmentedControl checks the record that is the value, not the first record', () => {
    const { container } = mount(<SegmentedControl options={RECORDS as never} value={GRACE as never} />);
    expect(segments(container)).toEqual(['false', 'true']);
  });

  it('SegmentedControl hands back the record picked, and tells a second record from the first', () => {
    const seen: unknown[] = [];
    const { container } = mount(<SegmentedControl options={RECORDS as never} defaultValue={ADA as never} onChange={(value) => seen.push(value)} />);
    expect(segments(container)).toEqual(['true', 'false']);
    click(Array.from(container.querySelectorAll('[role="radio"]'))[1]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(GRACE);
    expect(segments(container)).toEqual(['false', 'true']);
  });

  it('SegmentedControl tells 1 from "1", and still matches 2 to "2"', () => {
    const { container, unmount } = mount(<SegmentedControl options={[1, '1'] as never} value="1" />);
    expect(segments(container)).toEqual(['false', 'true']);
    unmount();
    const other = mount(<SegmentedControl options={[1, 2] as never} value="2" />);
    expect(segments(other.container)).toEqual(['false', 'true']);
  });
});
