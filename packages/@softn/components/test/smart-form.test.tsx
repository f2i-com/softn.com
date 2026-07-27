/**
 * SmartForm seeding.
 *
 * An edit form whose record is fetched from XDB or the server gets its `data`
 * prop on a later render than the first. Ignoring that meant the form opened
 * blank over a record that had loaded perfectly — and saving it wrote the
 * blanks back.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mount, type } from './dom';
import { SmartForm } from '../src/smart/SmartForm';

beforeEach(() => {
  document.body.innerHTML = '';
});

const FIELDS = [
  { name: 'title', label: 'Title', type: 'text' as const },
  { name: 'notes', label: 'Notes', type: 'text' as const },
];

function valuesOf(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('input')).map((i) => (i as HTMLInputElement).value);
}

describe('data arriving after the first render', () => {
  it('populates the form', () => {
    const { container, rerender } = mount(<SmartForm fields={FIELDS} />);
    expect(valuesOf(container)).toEqual(['', '']);

    rerender(<SmartForm fields={FIELDS} data={{ title: 'Loaded', notes: 'Body' }} />);

    expect(valuesOf(container)).toEqual(['Loaded', 'Body']);
  });

  it('follows a switch to a different record', () => {
    const { container, rerender } = mount(
      <SmartForm fields={FIELDS} data={{ title: 'First', notes: 'A' }} />
    );
    expect(valuesOf(container)).toEqual(['First', 'A']);

    rerender(<SmartForm fields={FIELDS} data={{ title: 'Second', notes: 'B' }} />);
    expect(valuesOf(container)).toEqual(['Second', 'B']);
  });

  it('does not discard what the user typed on an unrelated re-render', () => {
    const data = { title: 'Loaded', notes: '' };
    const { container, rerender } = mount(<SmartForm fields={FIELDS} data={data} />);

    const notes = container.querySelectorAll('input')[1] as HTMLInputElement;
    type(notes, 'typed by hand');
    expect(valuesOf(container)).toEqual(['Loaded', 'typed by hand']);

    // Same `data` object — a re-render caused by something else entirely.
    rerender(<SmartForm fields={FIELDS} data={data} />);
    expect(valuesOf(container)).toEqual(['Loaded', 'typed by hand']);
  });

  it('still applies field defaults', () => {
    const withDefault = [
      { name: 'title', label: 'Title', type: 'text' as const, defaultValue: 'Untitled' },
    ];
    const { container } = mount(<SmartForm fields={withDefault} />);
    expect(valuesOf(container)).toEqual(['Untitled']);
  });

  it('lets loaded data win over a field default', () => {
    const withDefault = [
      { name: 'title', label: 'Title', type: 'text' as const, defaultValue: 'Untitled' },
    ];
    const { container, rerender } = mount(<SmartForm fields={withDefault} />);
    rerender(<SmartForm fields={withDefault} data={{ title: 'Real' }} />);
    expect(valuesOf(container)).toEqual(['Real']);
  });

  it('renders without a data prop at all', () => {
    const { container } = mount(<SmartForm fields={FIELDS} />);
    expect(valuesOf(container)).toEqual(['', '']);
  });
});
