/**
 * Minimal interaction harness.
 *
 * The components in this package are stateful, and the bugs worth pinning here
 * are about what happens *after* a click or a keystroke — so server rendering
 * (which is what @softn/core's tests use) cannot reach them. This is just
 * `react-dom/client` plus `act`, which is all those tests need; it avoids
 * adding a testing-library dependency for three helpers.
 */

import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

// React reads this to decide whether to warn about updates outside `act`.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export interface Mounted {
  container: HTMLElement;
  rerender: (next: React.ReactElement) => void;
  unmount: () => void;
}

export function mount(element: React.ReactElement): Mounted {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root: Root;

  act(() => {
    root = createRoot(container);
    root.render(element);
  });

  return {
    container,
    rerender: (next) => act(() => root.render(next)),
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

/** Click an element the way a user would, inside `act`. */
export function click(el: Element | null | undefined): void {
  if (!el) throw new Error('click: element not found');
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/**
 * Type into a controlled input.
 *
 * React installs its own value setter on the element, so assigning `.value`
 * directly is swallowed — the native setter has to be called explicitly for the
 * change event to carry the new value.
 */
export function type(el: HTMLInputElement | null | undefined, value: string): void {
  if (!el) throw new Error('type: element not found');
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

/** Tick a checkbox or select a radio the way a user would. */
export function check(el: HTMLInputElement | null | undefined, checked = true): void {
  if (!el) throw new Error('check: element not found');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')?.set;
  act(() => {
    setter?.call(el, checked);
    el.dispatchEvent(new Event('click', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

export function byText(container: HTMLElement, text: string | RegExp): HTMLElement | undefined {
  const match = (s: string) => (typeof text === 'string' ? s.trim() === text : text.test(s));
  return Array.from(container.querySelectorAll<HTMLElement>('*')).find(
    (el) => el.children.length === 0 && match(el.textContent ?? '')
  );
}
