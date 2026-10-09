/**
 * A write to state belongs to a handler, not to the page while it is drawn.
 *
 * `{count++}` in the body of a page is evaluated every time the page is
 * drawn, and the write it makes causes the next drawing. Once the parser
 * read `++` (it used to be arithmetic on nothing, and harmless) that was a
 * loop from one keystroke, which React ends by tearing the document down.
 * These tests mount over real state, because a recording `setState` cannot
 * loop and so cannot see it.
 */

import React, { useState } from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { parse } from '../src/parser';
import type { ElementNode } from '../src/parser';
import { renderDocument, ComponentRegistry, evaluateExpression } from '../src/renderer';
import type { SoftNRenderContext, SoftNProps } from '../src/types';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.restoreAllMocks();
});

interface Mounted {
  writes: Array<[string, unknown]>;
  renders: { count: number };
  html: () => string;
  find: <T extends Element>(selector: string) => T;
}

/** A page of `.ui` over real state: what is written is what the next drawing reads. */
function mount(source: string, initial: Record<string, unknown>): Mounted {
  const doc = parse(source);
  expect(doc.diagnostics ?? []).toEqual([]);
  const writes: Array<[string, unknown]> = [];
  const renders = { count: 0 };
  const registry = new ComponentRegistry();
  registry.register('Text', ({ children }: SoftNProps) =>
    React.createElement('span', null, children as React.ReactNode)
  );
  registry.register('Panel', ({ onClose, children }: SoftNProps) =>
    React.createElement('button', { id: 'close', onClick: () => (onClose as () => void)?.() }, children as React.ReactNode)
  );

  function Page() {
    const [state, setState] = useState(initial);
    renders.count++;
    if (renders.count > 200) throw new Error('the page drew itself more than 200 times');
    const context: SoftNRenderContext = {
      state,
      setState: (path, value) => {
        writes.push([path, value]);
        setState((previous) => ({ ...previous, [path]: value }));
      },
      data: {},
      props: {},
      functions: {},
      asyncFunctions: {},
      computed: {},
    };
    return React.createElement(React.Fragment, null, renderDocument(doc, context, registry));
  }

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(React.createElement(Page));
  });
  return {
    writes,
    renders,
    html: () => container!.innerHTML,
    find: <T extends Element>(selector: string) => container!.querySelector<T>(selector)!,
  };
}

function click(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

describe('a write in the body of the page', () => {
  it('is worth its value and changes nothing', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const page = mount('<Text>[{count++}]</Text>', { count: 4 });
    expect(page.html()).toBe('<span>[4]</span>');
    expect(page.writes).toEqual([]);
    expect(page.renders.count).toBeLessThan(5);
    expect(error.mock.calls.flat().join(' ')).toMatch(/changes state while the page is being drawn/);
  });

  it('is said once, however many times the page is drawn', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const page = mount('<Text>{count++}</Text><button @click={() => other = other + 1}>again</button>', {
      count: 0,
      other: 0,
    });
    click(page.find('button'));
    click(page.find('button'));
    expect(page.renders.count).toBeGreaterThanOrEqual(3);
    const reports = error.mock.calls.filter((call) => /being drawn/.test(String(call[0])));
    expect(reports).toHaveLength(1);
  });

  it('holds for an assignment, a prefix update and a compound assignment', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const page = mount('<Text>{count = 9}|{--count}|{count += 5}</Text>', { count: 2 });
    expect(page.html()).toBe('<span>9|1|7</span>');
    expect(page.writes).toEqual([]);
  });

  it('holds in a condition, an iterable and a row of a loop', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const page = mount(
      '#if (seen++ >= 0)\n<Text>shown</Text>\n#end\n#each (row in rows)\n<Text>{n++}:{row}</Text>\n#end',
      { seen: 0, n: 0, rows: ['a', 'b'] }
    );
    expect(page.html()).toBe('<span>shown</span><span>0:a</span><span>0:b</span>');
    expect(page.writes).toEqual([]);
  });

  it('holds for an arrow the drawing itself calls', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const page = mount('<Text>{items.map((x) => total += x).join(",")}</Text>', { items: [1, 2, 3], total: 10 });
    // Each is worth what it would be; none was kept, so none sees the last.
    expect(page.html()).toBe('<span>11,12,13</span>');
    expect(page.writes).toEqual([]);
  });
});

describe('a write in a handler', () => {
  it('is made, by an arrow and by a bare expression', () => {
    const page = mount(
      '<button id="a" @click={() => count++}>a</button><button id="b" @click={count += 10}>b</button><Text>{count}</Text>',
      { count: 1 }
    );
    click(page.find('#a'));
    expect(page.html()).toContain('<span>2</span>');
    click(page.find('#b'));
    expect(page.html()).toContain('<span>12</span>');
    expect(page.writes).toEqual([['count', 2], ['count', 12]]);
  });

  it('is made by a callback prop written as an assignment, when the callback is called', () => {
    // `onClose={open = false}` used to assign while the page was drawn and
    // hand the component `false` for a callback.
    const page = mount('<Panel onClose={open = false}>panel</Panel><Text>{open ? "open" : "closed"}</Text>', {
      open: true,
    });
    expect(page.writes).toEqual([]);
    expect(page.html()).toContain('<span>open</span>');
    click(page.find('#close'));
    expect(page.writes).toEqual([['open', false]]);
    expect(page.html()).toContain('<span>closed</span>');
  });

  it('is made by an update written as a callback prop', () => {
    const page = mount('<Panel onClose={closed++}>panel</Panel><Text>{closed}</Text>', { closed: 0 });
    click(page.find('#close'));
    click(page.find('#close'));
    expect(page.html()).toContain('<span>2</span>');
  });
});

describe('an expression evaluated outside any drawing', () => {
  it('writes, as a host or a test that evaluates a handler directly expects', () => {
    const doc = parse('<Probe @go={count++} />');
    const writes: Array<[string, unknown]> = [];
    const context: SoftNRenderContext = {
      state: { count: 1 },
      setState: (path, value) => {
        writes.push([path, value]);
      },
      data: {},
      props: {},
      functions: {},
      asyncFunctions: {},
      computed: {},
    };
    evaluateExpression((doc.template[0] as ElementNode).events[0].handler, context);
    expect(writes).toEqual([['count', 2]]);
  });
});
