/**
 * What is drawn the same is handed to React as the element it already has.
 *
 * The renderer made every element of a page again whenever anything in the
 * app's state changed, and React runs a component again for a new element
 * whatever its props are: one keystroke in a filter ran every component on
 * the page. A host that keeps a render cache now gets the last element back
 * wherever the component, the props and the children came out the same, and
 * React leaves that part of the page alone.
 *
 * These hold what "the same" means, and above all where it must not be
 * claimed: a list that was changed in place, a handler that has to see the
 * new state, two rows drawn under one key.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { parse } from '../src/parser';
import { renderDocument, ComponentRegistry, createRenderCache, type SoftNRenderCache } from '../src/renderer';
import { beginPass, keep, recall, sameProps, settleProps } from '../src/renderer/reuse';
import type { SoftNDocument } from '../src/parser';
import type { SoftNRenderContext } from '../src/types';

type State = Record<string, unknown>;

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  vi.restoreAllMocks();
});

/** How often each component function has run, by a name the markup gives it. */
let runs: Record<string, number> = {};

function makeRegistry(): ComponentRegistry {
  const registry = new ComponentRegistry();
  registry.register('Probe', (props: { name?: string; label?: unknown; children?: React.ReactNode; style?: React.CSSProperties; onPress?: () => void }) => {
    const name = String(props.name);
    runs[name] = (runs[name] ?? 0) + 1;
    return (
      <div data-probe={name} style={props.style} onClick={() => props.onPress?.()}>
        {props.label === undefined ? null : String(props.label)}
        {props.children}
      </div>
    );
  });
  registry.register('Items', (props: { name?: string; items?: unknown[]; format?: (item: unknown) => string }) => {
    const name = String(props.name);
    runs[name] = (runs[name] ?? 0) + 1;
    return <ul data-items={name}>{(props.items ?? []).map((item, i) => <li key={i}>{props.format ? props.format(item) : String(item)}</li>)}</ul>;
  });
  return registry;
}

interface App {
  container: HTMLElement;
  set: (change: State | ((state: State) => State)) => void;
  /** Draw again without changing anything. */
  redraw: () => void;
  writes: Array<[string, unknown]>;
  cache: SoftNRenderCache | undefined;
  doc: SoftNDocument;
  text: (selector: string) => string[];
}

function mount(
  source: string,
  initial: State,
  options: { cache?: boolean; registry?: ComponentRegistry; functions?: SoftNRenderContext['functions']; context?: (state: State) => Partial<SoftNRenderContext> } = {}
): App {
  runs = {};
  const doc = parse(source);
  expect(doc.diagnostics ?? [], source).toEqual([]);
  const registry = options.registry ?? makeRegistry();
  const cache = options.cache === false ? undefined : createRenderCache();
  const writes: Array<[string, unknown]> = [];
  const functions = options.functions ?? {};
  let setState: (change: (state: State) => State) => void = () => {};
  let force: () => void = () => {};

  function Host(): React.ReactElement {
    const [state, set] = useState(initial);
    const [, setTick] = useState(0);
    setState = set;
    force = () => setTick((n) => n + 1);
    const context = {
      state,
      setState: (path: string, value: unknown) => {
        writes.push([path, value]);
        if (!/[.[]/.test(path)) set((s) => ({ ...s, [path]: value }));
      },
      data: {},
      props: {},
      computed: {},
      functions,
      asyncFunctions: functions,
      scriptLoaded: true,
      renderCache: cache,
      ...options.context?.(state),
    } as SoftNRenderContext;
    return <>{renderDocument(doc, context, registry)}</>;
  }

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  act(() => root.render(<Host />));
  return {
    container,
    set: (change) => act(() => setState(typeof change === 'function' ? change : (s) => ({ ...s, ...change }))),
    redraw: () => act(() => force()),
    writes,
    cache,
    doc,
    text: (selector) => Array.from(container.querySelectorAll(selector)).map((el) => el.textContent ?? ''),
  };
}

function click(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

const context = (state: State, cache?: SoftNRenderCache): SoftNRenderContext =>
  ({ state, setState: () => {}, data: {}, props: {}, computed: {}, functions: {}, asyncFunctions: {}, renderCache: cache }) as SoftNRenderContext;

describe('without a cache', () => {
  it('makes every element again, as it always did', () => {
    const doc = parse('<p>fixed</p>');
    const registry = new ComponentRegistry();
    const first = renderDocument(doc, context({}), registry) as React.ReactNode[];
    const second = renderDocument(doc, context({}), registry) as React.ReactNode[];
    expect(second[0]).not.toBe(first[0]);
  });

  it('runs every component on every change', () => {
    const app = mount('<Probe name="fixed" label="a" />\n<Probe name="live" label={n} />', { n: 1 }, { cache: false });
    app.set({ n: 2 });
    expect(runs).toEqual({ fixed: 2, live: 2 });
  });
});

describe('with a cache', () => {
  it('returns the element it returned, where nothing came out different', () => {
    const doc = parse('<section><p>fixed</p><b>{n}</b></section>');
    const registry = new ComponentRegistry();
    const cache = createRenderCache();
    const first = renderDocument(doc, context({ n: 1 }, cache), registry) as React.ReactElement[];
    const same = renderDocument(doc, context({ n: 1 }, cache), registry) as React.ReactElement[];
    expect(same[0]).toBe(first[0]);
    const changed = renderDocument(doc, context({ n: 2 }, cache), registry) as React.ReactElement[];
    expect(changed[0]).not.toBe(first[0]);
    // The part that did not change is still the element it was.
    const paragraph = (el: React.ReactElement) => (el.props.children as React.ReactElement[])[0];
    expect(paragraph(changed[0])).toBe(paragraph(first[0]));
  });

  it('runs a component again only when what it is given changed', () => {
    const app = mount(
      '<Probe name="outer">\n<Probe name="fixed" label="a" />\n<Probe name="live" label={n} />\n<Probe name="other" label={m} />\n</Probe>',
      { n: 1, m: 'x' }
    );
    expect(runs).toEqual({ outer: 1, fixed: 1, live: 1, other: 1 });
    app.set({ n: 2 });
    // The one whose label changed, and the one around it, whose child is new.
    expect(runs).toEqual({ outer: 2, fixed: 1, live: 2, other: 1 });
    expect(app.text('[data-probe="live"]')).toEqual(['2']);
    app.redraw();
    expect(runs).toEqual({ outer: 2, fixed: 1, live: 2, other: 1 });
  });

  it('shows text that changed, inside a component that did not', () => {
    const app = mount('<Probe name="box"><i>{n}</i></Probe>\n<Probe name="aside" label="x" />', { n: 1 });
    app.set({ n: 2 });
    expect(app.text('i')).toEqual(['2']);
    expect(runs.aside).toBe(1);
  });

  it('leaves the rows that did not change alone', () => {
    const rows = [
      { id: 'a', title: 'A' },
      { id: 'b', title: 'B' },
      { id: 'c', title: 'C' },
    ];
    const app = mount('#each (row in rows) key={row.id}\n<Probe name={row.id} label={row.title} />\n#end', { rows });
    app.set({ rows: [rows[0], { id: 'b', title: 'B2' }, rows[2]] });
    expect(runs).toEqual({ a: 1, b: 2, c: 1 });
    expect(app.text('[data-probe]')).toEqual(['A', 'B2', 'C']);
    // A row added and the order turned round: each is drawn where it now is.
    app.set({ rows: [{ id: 'd', title: 'D' }, rows[2], { id: 'b', title: 'B2' }, rows[0]] });
    expect(app.text('[data-probe]')).toEqual(['D', 'C', 'B2', 'A']);
    expect(runs).toEqual({ a: 1, b: 2, c: 1, d: 1 });
  });

  it('draws the other branch of an #if, and the first again', () => {
    const app = mount('#if (on)\n<Probe name="yes" label="on" />\n#else\n<Probe name="no" label="off" />\n#end', { on: true });
    expect(app.text('[data-probe]')).toEqual(['on']);
    app.set({ on: false });
    expect(app.text('[data-probe]')).toEqual(['off']);
    app.set({ on: true });
    expect(app.text('[data-probe]')).toEqual(['on']);
  });

  it('draws #empty when the list empties and the rows when it fills', () => {
    const app = mount('#each (row in rows)\n<i>{row}</i>\n#empty\n<b>none</b>\n#end', { rows: ['a'] });
    app.set({ rows: [] });
    expect(app.text('b')).toEqual(['none']);
    expect(app.text('i')).toEqual([]);
    app.set({ rows: ['x', 'y'] });
    expect(app.text('i')).toEqual(['x', 'y']);
    expect(app.text('b')).toEqual([]);
  });
});

describe('a handler on an element that was not made again', () => {
  it('sees the state as it is when it runs', () => {
    const seen: unknown[] = [];
    const app = mount('<Probe name="button" @press={() => note(n)} />\n<i>{n}</i>', { n: 1 }, { functions: { note: (value) => seen.push(value) } });
    app.set({ n: 2 });
    app.set({ n: 3 });
    // The element is the one from the first drawing...
    expect(runs.button).toBe(1);
    click(app.container.querySelector('[data-probe="button"]')!);
    // ...and its handler is the last one made.
    expect(seen).toEqual([3]);
  });

  it('writes with the value of the row it is on', () => {
    const rows = [{ id: 'a' }, { id: 'b' }];
    const app = mount('#each (row in rows) key={row.id}\n<button @click={() => chosen = row.id + suffix}>{row.id}</button>\n#end', {
      rows,
      suffix: '!',
      chosen: null,
    });
    app.set({ suffix: '?' });
    click(app.container.querySelectorAll('button')[1]);
    expect(app.writes).toEqual([['chosen', 'b?']]);
  });

  it('is the same function for the component from one drawing to the next', () => {
    const handlers: unknown[] = [];
    const registry = makeRegistry();
    registry.register('Keep', (props: { onPress?: unknown; label?: unknown }) => {
      handlers.push(props.onPress);
      return <span>{String(props.label)}</span>;
    });
    const app = mount('<Keep label={n} @press={() => n + 1} />', { n: 1 }, { registry });
    app.set({ n: 2 });
    expect(handlers).toHaveLength(2);
    expect(handlers[1]).toBe(handlers[0]);
  });

  it('keeps a control bound with :bind writing', () => {
    const app = mount('<input :bind={q} />\n<Probe name="aside" label="x" />', { q: 'a' });
    const input = app.container.querySelector('input')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'ab');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(app.writes).toContainEqual(['q', 'ab']);
    expect(input.value).toBe('ab');
    expect(runs.aside).toBe(1);
  });
});

describe('what is never taken to be the same', () => {
  it('a list, even the very list it was: it may have been changed in place', () => {
    const items = ['a', 'b'];
    const app = mount('<Items name="list" items={items} />\n<i>{n}</i>', { items, n: 1 });
    expect(app.text('li')).toEqual(['a', 'b']);
    // Changed in place, as a handler calling items.push(…) would, and then
    // something else makes the page draw again.
    items.push('c');
    app.set({ n: 2 });
    expect(app.text('li')).toEqual(['a', 'b', 'c']);
    expect(runs.list).toBe(2);
  });

  it('a record', () => {
    const who = { name: 'Ada' };
    const registry = makeRegistry();
    registry.register('Who', (props: { who?: { name: string } }) => <b>{props.who?.name}</b>);
    const app = mount('<Who who={who} />\n<i>{n}</i>', { who, n: 1 }, { registry });
    who.name = 'Grace';
    app.set({ n: 2 });
    expect(app.text('b')).toEqual(['Grace']);
  });

  it('a function that is not a handler: the component calls it while it draws', () => {
    const registry = makeRegistry();
    // Nothing else it is given could differ: text and a function.
    registry.register('Shown', (props: { value?: string; format?: (value: unknown) => string }) => (
      <b>{props.format ? props.format(props.value) : props.value}</b>
    ));
    const app = mount('<Shown value="a" format={(item) => item + suffix} />', { suffix: '!' }, { registry });
    expect(app.text('b')).toEqual(['a!']);
    app.set({ suffix: '?' });
    expect(app.text('b')).toEqual(['a?']);
  });

  it('what another node drew under the same key', () => {
    const pass = beginPass(createRenderCache(), {});
    const one = {};
    const other = {};
    keep(pass, 'k', { node: one, kind: 'element', result: 'one' });
    pass.prev = pass.next;
    pass.next = new Map();
    expect(recall(pass, 'k', other, 'element')).toBeUndefined();
    expect(recall(pass, 'k', one, 'text')).toBeUndefined();
    expect(recall(pass, 'k', one, 'element')?.result).toBe('one');
  });

  it('a style object that is the same object saying something else', () => {
    // Asked of the comparison itself: React's development build freezes the
    // style it is handed, so a page cannot be made to do this here, and its
    // production build does not, so an app can.
    const look: Record<string, unknown> = { color: 'red' };
    const first: Record<string, unknown> = { style: look };
    const made = settleProps(first, undefined);
    const entry = { node: {}, kind: 'element' as const, result: null, props: first, style: made.style };

    const unchanged: Record<string, unknown> = { style: look };
    const again = settleProps(unchanged, entry);
    expect(again.styleUnchanged).toBe(true);
    expect(sameProps(first, unchanged, again.styleUnchanged)).toBe(true);

    look.color = 'blue';
    const changed: Record<string, unknown> = { style: look };
    const after = settleProps(changed, entry);
    expect(after.styleUnchanged).toBe(false);
    expect(sameProps(first, changed, after.styleUnchanged)).toBe(false);
  });
});

describe('a style', () => {
  it('that says what it said is the same, though the object is new each time', () => {
    const app = mount('<Probe name="styled" style={{ color: tone, padding: 4 }} />\n<i>{n}</i>', { tone: 'red', n: 1 });
    app.set({ n: 2 });
    expect(runs.styled).toBe(1);
    app.set({ tone: 'blue' });
    expect(runs.styled).toBe(2);
    expect(app.container.querySelector<HTMLElement>('[data-probe="styled"]')!.style.color).toBe('blue');
  });

  it('written as text, or with style:, is compared the same way', () => {
    const app = mount('<Probe name="a" style="color: red" />\n<Probe name="b" style:opacity={dim ? 0.5 : 1} />\n<i>{n}</i>', { dim: false, n: 1 });
    app.set({ n: 2 });
    expect(runs).toEqual({ a: 1, b: 1 });
    app.set({ dim: true });
    expect(runs).toEqual({ a: 1, b: 2 });
  });
});

describe('two rows drawn under one key', () => {
  it('are each drawn, and each handler is its own row’s', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const seen: unknown[] = [];
    const rows = [
      { id: 'same', title: 'First' },
      { id: 'same', title: 'Second' },
    ];
    const app = mount(
      '#each (row in rows) key={row.id}\n<button @click={() => note(row.title)}>{row.title}</button>\n#end\n<i>{n}</i>',
      { rows, n: 1 },
      { functions: { note: (value) => seen.push(value) } }
    );
    app.set({ n: 2 });
    app.set({ n: 3 });
    const buttons = app.container.querySelectorAll('button');
    expect(Array.from(buttons).map((b) => b.textContent)).toEqual(['First', 'Second']);
    click(buttons[0]);
    click(buttons[1]);
    expect(seen).toEqual(['First', 'Second']);
  });
});

describe('what an element is made from besides its props', () => {
  it('is made again when the component registered under its tag changes', () => {
    const registry = makeRegistry();
    const app = mount('<Probe name="it" label="x" />\n<i>{n}</i>', { n: 1 }, { registry });
    registry.register('Probe', () => <em>replaced</em>);
    app.set({ n: 2 });
    expect(app.text('em')).toEqual(['replaced']);
  });

  it('is made again when what the page may fetch changes', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = mount('<img src="https://example.com/a.png" alt="a" />\n<i>{n}</i>', { n: 1, held: true }, {
      context: (state) => ({ consentPending: state.held === true, egress: null }),
    });
    expect(app.container.querySelector('img')!.getAttribute('src')).toBeNull();
    app.set({ held: false });
    expect(app.container.querySelector('img')!.getAttribute('src')).toBe('https://example.com/a.png');
    app.set({ held: true });
    expect(app.container.querySelector('img')!.getAttribute('src')).toBeNull();
  });

  it('is made again after its component failed, so the component is tried again', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const registry = makeRegistry();
    let ready = false;
    registry.register('Late', (props: { label?: string }) => {
      if (!ready) throw new Error('not ready');
      return <b>{props.label}</b>;
    });
    const app = mount('<Late label="here" />\n<Probe name="aside" label="x" />\n<i>{n}</i>', { n: 1 }, { registry });
    expect(app.container.textContent).toContain('not ready');
    // (React draws a tree again itself when something in it throws.)
    const asideRuns = runs.aside;
    // What it lacked arrives, and something unrelated makes the page draw.
    ready = true;
    app.set({ n: 2 });
    expect(app.text('b')).toEqual(['here']);
    expect(app.container.textContent).not.toContain('not ready');
    // What did not fail was left alone throughout.
    expect(runs.aside).toBe(asideRuns);
  });

  it('follows what a slot holds', () => {
    const app = mount('<Probe name="card"><slot><i>{n}</i></slot></Probe>\n<Probe name="aside"><slot><b>fixed</b></slot></Probe>', { n: 1 });
    app.set({ n: 2 });
    expect(app.text('i')).toEqual(['2']);
    expect(runs).toEqual({ card: 2, aside: 1 });
  });
});

describe('two mounts of one document', () => {
  it('each keep their own elements and handlers', () => {
    const source = '<button @click={() => chosen = who}>{who}</button>';
    const one = mount(source, { who: 'one', chosen: null });
    const two = mount(source, { who: 'two', chosen: null });
    one.redraw();
    two.redraw();
    one.redraw();
    click(one.container.querySelector('button')!);
    click(two.container.querySelector('button')!);
    expect(one.writes).toEqual([['chosen', 'one']]);
    expect(two.writes).toEqual([['chosen', 'two']]);
  });
});

describe('what the cache holds', () => {
  it('is what the last drawing drew, and no more', () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ id: 'r' + i }));
    const app = mount('#each (row in rows) key={row.id}\n<p>{row.id}</p>\n#end', { rows });
    const held = () => app.cache!.passes.get(app.doc)!.next.size;
    const full = held();
    expect(full).toBeGreaterThan(100);
    app.set({ rows: rows.slice(0, 2) });
    expect(held()).toBeLessThan(full / 10);
    app.set({ rows: [] });
    expect(held()).toBeLessThanOrEqual(1);
  });
});
