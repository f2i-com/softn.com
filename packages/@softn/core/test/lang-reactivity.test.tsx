/**
 * The reactive primitives (runtime/reactivity.ts), which `@softn/core`
 * exports for hosts.
 *
 * - One write runs each effect it touches once, and the effect sees every
 *   computed value as of that write. The write ran an effect as soon as the
 *   first computed it read was marked, before the second was: with
 *   `b = a * 2` and `c = a * 3` an effect over both ran twice for one write,
 *   the first time with a new `b` and an old `c` (4 + 3, a value that was
 *   never true). Only `batch()` held effects back until all were marked.
 * - `useReactiveState` keeps working under StrictMode. Its cleanup threw the
 *   store away, and the effect StrictMode runs again found none: no effect
 *   was set up, the next render made a new store with nothing listening, and
 *   `setState` changed a value that was never drawn.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { batch, createComputed, createEffect, createSignal, useReactiveState } from '../src/runtime/reactivity';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('one write', () => {
  it('runs an effect over two computed values once, with both new', () => {
    const [a, setA] = createSignal(1);
    const b = createComputed(() => a() * 2);
    const c = createComputed(() => a() * 3);
    const seen: string[] = [];
    createEffect(() => {
      seen.push(`${b()}+${c()}`);
    });
    setA(2);
    expect(seen).toEqual(['2+3', '4+6']);
  });

  it('runs an effect that reads a signal and a computed over it once, in step', () => {
    const [x, setX] = createSignal(1);
    const y = createComputed(() => x() + 1);
    const seen: string[] = [];
    createEffect(() => {
      seen.push(`x=${x()} y=${y()}`);
    });
    setX(5);
    expect(seen).toEqual(['x=1 y=2', 'x=5 y=6']);
  });

  it('runs a chain of computed values through to the effect once', () => {
    const [n, setN] = createSignal(1);
    const double = createComputed(() => n() * 2);
    const quad = createComputed(() => double() * 2);
    const seen: number[] = [];
    createEffect(() => {
      seen.push(quad() + double() + n());
    });
    setN(2);
    setN(3);
    expect(seen).toEqual([7, 14, 21]);
  });

  it('still runs an effect that writes another signal, and settles', () => {
    const [a, setA] = createSignal(1);
    const [b, setB] = createSignal(0);
    const seen: number[] = [];
    createEffect(() => setB(a() * 10));
    createEffect(() => {
      seen.push(b());
    });
    setA(2);
    expect(b()).toBe(20);
    expect(seen).toEqual([10, 20]);
  });

  it('is still held back by batch() until it ends', () => {
    const [a, setA] = createSignal(1);
    const [b, setB] = createSignal(1);
    const seen: number[] = [];
    createEffect(() => {
      seen.push(a() + b());
    });
    batch(() => {
      setA(2);
      setB(3);
    });
    expect(seen).toEqual([2, 5]);
  });
});

describe('useReactiveState under StrictMode', () => {
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

  it('draws what setState writes', async () => {
    let set: ((name: string, value: unknown) => void) | null = null;
    function Counter(): React.ReactElement {
      const { state, setState, computed } = useReactiveState({ count: 1 }, { double: () => 0 });
      set = setState;
      return <span>{`${String(state.count)} ${String(computed.double)}`}</span>;
    }
    await act(async () => {
      root.render(
        <React.StrictMode>
          <Counter />
        </React.StrictMode>
      );
    });
    expect(container.textContent).toBe('1 0');
    await act(async () => {
      set!('count', 5);
    });
    expect(container.textContent).toBe('5 0');
  });

  it('keeps state named like an object’s own machinery as state', async () => {
    let seen: { state: Record<string, unknown>; computed: Record<string, unknown> } | null = null;
    function Names(): React.ReactElement {
      const { state, computed } = useReactiveState({ toString: 'a', constructor: 'b', valueOf: 'c' });
      seen = { state, computed };
      return <span />;
    }
    await act(async () => {
      root.render(<Names />);
    });
    expect(seen!.state).toEqual({ toString: 'a', constructor: 'b', valueOf: 'c' });
    expect(Object.keys(seen!.computed)).toEqual([]);
  });
});
