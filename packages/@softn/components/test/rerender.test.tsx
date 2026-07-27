/**
 * Behaviour on re-render.
 *
 * These only appear once something *else* on the page changes, which is why
 * they survive a click-through: the component works perfectly until the
 * parent re-renders for an unrelated reason.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { act } from 'react';
import { mount } from './dom';
import { Table } from '../src/data/Table';
import { AnimatedBox } from '../src/animation/AnimatedBox';

/** Let queued animation frames and their follow-up work run. */
async function flushFrames(): Promise<void> {
  await act(async () => {
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('Table rows', () => {
  const rows = [
    { id: '1', name: 'a' },
    { id: '2', name: 'b' },
  ];
  const columns = [
    { key: 'name', header: 'Name' },
    {
      key: 'edit',
      header: 'Edit',
      render: () => <input type="text" data-testid="cell-input" />,
    },
  ];

  it('are not rebuilt from scratch on every parent render', () => {
    // `TableRow` was declared inside `Table`'s body, making it a new component
    // *type* on every render — so React unmounted and remounted every row
    // rather than updating it. A column rendering an input therefore lost its
    // caret and focus after each keystroke.
    const { container, rerender } = mount(<Table data={rows} columns={columns} />);

    const before = container.querySelector('[data-testid=cell-input]');
    expect(before).not.toBeNull();

    rerender(<Table data={rows} columns={columns} />);
    const after = container.querySelector('[data-testid=cell-input]');

    expect(after).toBe(before);
  });

  it('keeps focus across a parent render', () => {
    const { container, rerender } = mount(<Table data={rows} columns={columns} />);
    const input = container.querySelector<HTMLInputElement>('[data-testid=cell-input]');
    input!.focus();
    expect(document.activeElement).toBe(input);

    rerender(<Table data={rows} columns={columns} />);
    expect(document.activeElement).toBe(input);
  });

  it('still renders every row and column', () => {
    const { container } = mount(<Table data={rows} columns={columns} />);
    expect(container.querySelectorAll('tbody tr').length).toBe(2);
  });
});

describe('AnimatedBox when its animation prop changes', () => {
  it('does not leave the content permanently invisible', async () => {
    // The effect re-applied `preset.from` (opacity 0) but `doAnimate` bailed
    // out because `hasAnimatedRef` was already true — so switching animation
    // mid-life faded the content out and never faded it back.
    //
    // The "to" styles land inside a requestAnimationFrame callback, so the
    // assertion has to wait for one — reading straight after the rerender only
    // ever sees the "from" state, fixed or not.
    const { container, rerender } = mount(
      <AnimatedBox animation="fadeIn">
        <p>content</p>
      </AnimatedBox>
    );
    await flushFrames();

    rerender(
      <AnimatedBox animation="slideUp">
        <p>content</p>
      </AnimatedBox>
    );
    await flushFrames();

    const box = container.firstElementChild as HTMLElement;
    expect(box).not.toBeNull();
    expect(box.style.opacity).not.toBe('0');
  });

  it('animates on first mount', async () => {
    const { container } = mount(
      <AnimatedBox animation="fadeIn">
        <p>content</p>
      </AnimatedBox>
    );
    await flushFrames();

    const box = container.firstElementChild as HTMLElement;
    expect(box.style.opacity).not.toBe('0');
  });

  it('still renders its children', () => {
    const { container } = mount(
      <AnimatedBox animation="fadeIn">
        <p>content</p>
      </AnimatedBox>
    );
    expect(container.textContent).toContain('content');
  });
});
