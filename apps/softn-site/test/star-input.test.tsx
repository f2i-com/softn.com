/**
 * The rating stars by keyboard.
 *
 * The five stars are a radio group to a screen reader, and a radio group is
 * one stop in the tab order that the arrow keys move within. These were five
 * tab stops that ignored the arrows. Rating sends a vote (and replaces the
 * last one), so an arrow only moves to a star and shows it; Enter, Space or
 * a click gives it. While a vote is on its way the stars refuse another
 * without being disabled, because disabling the star that has focus throws
 * the focus out of the group.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { StarInput } from '../src/components/directory/Stars';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(mine: number | null, onRate: (n: number) => void, busy = false): HTMLButtonElement[] {
  act(() => root.render(<StarInput mine={mine} onRate={onRate} busy={busy} />));
  return [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
}

function press(el: HTMLElement, key: string): void {
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
}

describe('StarInput', () => {
  it('is one tab stop: the star given, or the first when none is', () => {
    let stars = render(null, () => {});
    expect(stars.map((s) => s.tabIndex)).toEqual([0, -1, -1, -1, -1]);
    stars = render(3, () => {});
    expect(stars.map((s) => s.tabIndex)).toEqual([-1, -1, 0, -1, -1]);
    expect(stars.map((s) => s.getAttribute('aria-checked'))).toEqual(['false', 'false', 'true', 'false', 'false']);
  });

  it('moves between the stars with the arrow keys, Home and End, without voting', () => {
    const onRate = vi.fn();
    const stars = render(null, onRate);
    act(() => stars[0].focus());
    press(stars[0], 'ArrowRight');
    expect(document.activeElement).toBe(stars[1]);
    press(stars[1], 'ArrowDown');
    expect(document.activeElement).toBe(stars[2]);
    press(stars[2], 'ArrowLeft');
    expect(document.activeElement).toBe(stars[1]);
    press(stars[1], 'ArrowUp');
    expect(document.activeElement).toBe(stars[0]);
    // The ends wrap, as a radio group's do.
    press(stars[0], 'ArrowLeft');
    expect(document.activeElement).toBe(stars[4]);
    press(stars[4], 'ArrowRight');
    expect(document.activeElement).toBe(stars[0]);
    press(stars[0], 'End');
    expect(document.activeElement).toBe(stars[4]);
    press(stars[4], 'Home');
    expect(document.activeElement).toBe(stars[0]);
    expect(onRate).not.toHaveBeenCalled();
    // The star moved to is the tab stop from then on, and is shown lit.
    press(stars[0], 'ArrowRight');
    expect(stars.map((s) => s.tabIndex)).toEqual([-1, 0, -1, -1, -1]);
    expect(stars.map((s) => s.classList.contains('on'))).toEqual([true, true, false, false, false]);
  });

  it('votes on a press of the star', () => {
    const onRate = vi.fn();
    const stars = render(null, onRate);
    act(() => stars[3].click());
    expect(onRate).toHaveBeenCalledWith(4);
  });

  it('keeps focus on the star while a vote is on its way, and takes no second vote', () => {
    const onRate = vi.fn();
    let stars = render(null, onRate);
    act(() => stars[2].focus());
    stars = render(null, onRate, true);
    expect(stars.every((s) => !s.disabled)).toBe(true);
    expect(stars.every((s) => s.getAttribute('aria-disabled') === 'true')).toBe(true);
    expect(document.activeElement).toBe(stars[2]);
    act(() => stars[2].click());
    expect(onRate).not.toHaveBeenCalled();
    press(stars[2], 'ArrowRight');
    expect(document.activeElement).toBe(stars[3]);
  });
});
