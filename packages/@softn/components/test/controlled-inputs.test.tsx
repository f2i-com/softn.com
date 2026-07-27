/**
 * Controlled-component regressions.
 *
 * Each of these let the widget and the app disagree about what is selected.
 * That is worse than a crash: the screen shows one thing, the data says
 * another, and nothing reports a problem.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mount, check } from './dom';
import { Radio } from '../src/form/Radio';
import { Checkbox } from '../src/form/Checkbox';

beforeEach(() => {
  document.body.innerHTML = '';
});

const OPTIONS = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta' },
];

describe('Radio as a controlled component', () => {
  it('honours a parent that rejects the change', () => {
    // The parent keeps `value` at 'a'. Selecting 'Beta' used to overwrite
    // internal state unconditionally, and the resync effect only fires when
    // `value` itself *changes* — so 'b' stayed visually selected forever while
    // the app's state still said 'a'.
    const seen: string[] = [];
    const { container } = mount(
      <Radio name="t" options={OPTIONS} value="a" onChange={(v) => seen.push(v)} />
    );

    const radios = container.querySelectorAll<HTMLInputElement>('input[type=radio]');
    check(radios[1]);

    expect(seen).toEqual(['b']);
    expect(radios[0].checked).toBe(true);
    expect(radios[1].checked).toBe(false);
  });

  it('follows the parent when it accepts the change', () => {
    const { container, rerender } = mount(
      <Radio name="t" options={OPTIONS} value="a" onChange={() => {}} />
    );
    rerender(<Radio name="t" options={OPTIONS} value="b" onChange={() => {}} />);

    const radios = container.querySelectorAll<HTMLInputElement>('input[type=radio]');
    expect(radios[1].checked).toBe(true);
  });

  it('still manages its own selection when uncontrolled', () => {
    const { container } = mount(<Radio name="t" options={OPTIONS} defaultValue="a" />);
    const radios = container.querySelectorAll<HTMLInputElement>('input[type=radio]');

    check(radios[1]);
    expect(radios[1].checked).toBe(true);
  });
});

describe('Checkbox as a controlled component', () => {
  it('honours a parent that rejects the change', () => {
    // Note the signature difference from Radio, which reports `(value, event)`
    // while Checkbox reports `(event)`.
    const seen: boolean[] = [];
    const { container } = mount(
      <Checkbox checked={false} label="Agree" onChange={(e) => seen.push(e.target.checked)} />
    );

    const box = container.querySelector<HTMLInputElement>('input[type=checkbox]');
    check(box, true);

    expect(seen).toEqual([true]);
    expect(box!.checked).toBe(false);
  });

  it('still manages its own state when uncontrolled', () => {
    const { container } = mount(<Checkbox label="Agree" />);
    const box = container.querySelector<HTMLInputElement>('input[type=checkbox]');

    check(box, true);
    expect(box!.checked).toBe(true);
  });
});
