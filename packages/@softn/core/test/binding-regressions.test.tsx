/**
 * Two-way binding regressions.
 *
 * Both of these left a control that looked fine and silently refused to record
 * what the user did — the worst shape of bug in a form, because nothing on
 * screen says the answer was not kept.
 */

import { describe, it, expect } from 'vitest';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { parse } from '../src/parser';
import { renderDocument, ComponentRegistry } from '../src/renderer';

let container: HTMLDivElement;
let root: Root;

function mountSource(source: string, state: Record<string, unknown>) {
  const doc = parse(source);
  const setState = (path: string, value: unknown) => {
    calls.push([path, value]);
  };
  const calls: Array<[string, unknown]> = [];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const registry = new ComponentRegistry();
  registry.register('App', ({ children }: { children?: React.ReactNode }) => <div>{children}</div>);
  act(() => {
    root.render(
      renderDocument(
        doc,
        {
          state,
          setState,
          data: {},
          props: {},
          functions: {},
          asyncFunctions: {},
          computed: {},
        } as never,
        registry
      ) as React.ReactElement
    );
  });
  return { calls, cleanup: () => { act(() => root.unmount()); container.remove(); } };
}

describe(':bind alongside an @change handler', () => {
  it('keeps writing the bound variable', () => {
    // The events loop assigned over the onChange the bindings loop had just
    // installed, so the binding was lost: every keystroke was discarded and the
    // field sat frozen on its initial value, while the author's handler ran
    // perfectly — so nothing looked wrong except the typing.
    const { calls, cleanup } = mountSource(
      '<App><input :bind={q} @change={noop()} /></App>',
      { q: '', noop: () => {} }
    );
    const input = container.querySelector('input') as HTMLInputElement;
    expect(input).not.toBeNull();

    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'hello');
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(calls.some(([path, value]) => path === 'q' && value === 'hello')).toBe(true);
    cleanup();
  });
});

describe(':bind on a radio', () => {
  it('checks the option matching the bound value', () => {
    // Radios were treated as checkboxes: `checked` was `value === true`, never
    // true for a real choice, so every option in the group rendered unchecked.
    const { cleanup } = mountSource(
      '<App><input type="radio" value="b" :bind={choice} /></App>',
      { choice: 'b' }
    );
    const input = container.querySelector('input') as HTMLInputElement;
    expect(input.checked).toBe(true);
    cleanup();
  });

  it('writes the option chosen, not true', () => {
    const { calls, cleanup } = mountSource(
      '<App><input type="radio" value="b" :bind={choice} /></App>',
      { choice: 'a' }
    );
    const input = container.querySelector('input') as HTMLInputElement;
    expect(input.checked).toBe(false);

    // click(), not a bare change event: selecting a radio is what sets `checked`,
    // and React listens for the click.
    act(() => {
      input.click();
    });

    // `true` here would destroy the answer the radio group exists to record.
    expect(calls.some(([path, value]) => path === 'choice' && value === 'b')).toBe(true);
    expect(calls.some(([, value]) => value === true)).toBe(false);
    cleanup();
  });
});
