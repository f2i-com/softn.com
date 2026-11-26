/**
 * A call that finds no function to make is said once, for the call as it is
 * written in the page. It was said every time the call was worked out:
 * every drawing, and once for each row of a list, so
 * `{row.price.toFixed(2)}` over a list where some rows have no price wrote
 * that many warnings on every keystroke, each one the browser's console has
 * to format and keep.
 */
import React, { useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from '../src/parser';
import { renderDocument, ComponentRegistry, createRenderCache } from '../src/renderer';
import type { SoftNRenderContext } from '../src/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.restoreAllMocks();
});

function mount(source: string, initial: Record<string, unknown>) {
  const doc = parse(source);
  const registry = new ComponentRegistry();
  const cache = createRenderCache();
  let set: (change: Record<string, unknown>) => void = () => {};
  function Host(): React.ReactElement {
    const [state, setState] = useState(initial);
    set = (change) => setState((s) => ({ ...s, ...change }));
    const context = {
      state,
      setState: () => {},
      data: {},
      props: {},
      computed: {},
      functions: {},
      asyncFunctions: {},
      scriptLoaded: true,
      renderCache: cache,
    } as SoftNRenderContext;
    return <>{renderDocument(doc, context, registry)}</>;
  }
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container!);
    root.render(<Host />);
  });
  return { set: (change: Record<string, unknown>) => act(() => set(change)), container };
}

const notFound = (warn: { mock: { calls: unknown[][] } }) =>
  warn.mock.calls.filter((call) => String(call[0]).includes('not found')).length;

describe('a call that finds no function', () => {
  it('is said once, not once a row and a drawing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rows = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? { id: i, price: i } : { id: i }));
    const page = mount('#each (row in rows) key={row.id}\n<p>{row.price.toFixed(2)}</p>\n#end\n<i>{n}</i>', { rows, n: 0 });
    page.set({ n: 1 });
    page.set({ n: 2 });
    expect(notFound(warn)).toBe(1);
    // The rows that have one are drawn as ever.
    expect(page.container.querySelectorAll('p')[0].textContent).toBe('0.00');
    expect(page.container.querySelectorAll('p')[1].textContent).toBe('');
  });

  it('and each call written in the page is said for itself', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mount('<p>{format(a)}</p>\n<p>{shout(a)}</p>', { a: 1 });
    expect(notFound(warn)).toBe(2);
    expect(warn.mock.calls.map((call) => String(call[0])).filter((text) => text.includes('not found'))).toEqual([
      expect.stringContaining('"format"'),
      expect.stringContaining('"shout"'),
    ]);
  });
});
