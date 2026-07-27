/**
 * SmartGrid edit-form regressions.
 *
 * The grid is how most SoftN apps write data, so a value it mangles is a value
 * the whole app is then wrong about.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mount, click, type, byText } from './dom';
import { SmartGrid } from '../src/smart/SmartGrid';

beforeEach(() => {
  document.body.innerHTML = '';
});

const SERVICES = [
  { id: '1', name: 'Cut', price: 65, duration: 45 },
  { id: '2', name: 'Colour', price: 120, duration: 90 },
];

/** Open the edit form for the first row. */
function openEditor(container: HTMLElement) {
  const edit = Array.from(container.querySelectorAll('button')).find((b) =>
    /edit|✏|✎/i.test(b.textContent ?? '') || b.getAttribute('title')?.toLowerCase().includes('edit')
  );
  click(edit);
}

describe('editing a numeric column', () => {
  it('reports a number, not the string the DOM handed back', () => {
    // `target.value` is always a string. Saving "50" for a price made the
    // grid's own numeric sort fall back to string compare ("100" before "50")
    // and left currency() rendering a blank cell — both silent.
    let saved: Record<string, unknown> | undefined;
    const { container } = mount(
      <SmartGrid
        data={SERVICES}
        columns="name, price, duration"
        editable
        onEdit={(_row, data) => {
          saved = data as Record<string, unknown>;
        }}
      />
    );

    openEditor(container);
    const numbers = container.querySelectorAll<HTMLInputElement>('input[type=number]');
    expect(numbers.length).toBeGreaterThan(0);

    type(numbers[0], '50');
    click(byText(container, /^Save$/i));

    expect(saved).toBeDefined();
    expect(saved!.price).toBe(50);
    expect(typeof saved!.price).toBe('number');
  });

  it('leaves a cleared numeric field empty rather than calling it zero', () => {
    let saved: Record<string, unknown> | undefined;
    const { container } = mount(
      <SmartGrid
        data={SERVICES}
        columns="name, price, duration"
        editable
        onEdit={(_row, data) => {
          saved = data as Record<string, unknown>;
        }}
      />
    );

    openEditor(container);
    const numbers = container.querySelectorAll<HTMLInputElement>('input[type=number]');
    type(numbers[0], '');
    click(byText(container, /^Save$/i));

    expect(saved).toBeDefined();
    expect(saved!.price).toBe('');
  });

  it('leaves a text column as text', () => {
    let saved: Record<string, unknown> | undefined;
    const { container } = mount(
      <SmartGrid
        data={SERVICES}
        columns="name, price, duration"
        editable
        onEdit={(_row, data) => {
          saved = data as Record<string, unknown>;
        }}
      />
    );

    openEditor(container);
    const text = container.querySelector<HTMLInputElement>('input[type=text]');
    type(text, 'Trim');
    click(byText(container, /^Save$/i));

    expect(saved!.name).toBe('Trim');
  });
});
