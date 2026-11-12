/**
 * A page drawn by the renderer into a real React root, with state that is
 * written the way a host writes it: `setState(path, value)` makes a new state
 * and the page is drawn again. Every write and everything shared with the
 * logic is kept, so a test can say what was written, how many times, and what
 * the page showed afterwards.
 */
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { expect } from 'vitest';
import { parse } from '../../src/parser';
import { ComponentRegistry, renderDocument } from '../../src/renderer';
import { parseStatePath } from '../../src/runtime/state-path';
import type { SoftNProps, SoftNRenderContext } from '../../src/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Fn = (...args: unknown[]) => unknown;

export interface DrawnPage {
  /** Each `setState(path, value)` the page made, in order. */
  writes: Array<[string, unknown]>;
  /** Each record of changes handed to the logic ahead of React (`shareState`). */
  shared: Array<Record<string, unknown>>;
  /** The state as it is now. */
  state: () => Record<string, unknown>;
  all: <T extends HTMLElement = HTMLElement>(selector: string) => T[];
  one: <T extends HTMLElement = HTMLElement>(selector: string) => T;
  text: (selector: string) => string;
  container: HTMLElement;
}

export interface DrawnPageOptions {
  /** What the page calls while it is drawn. */
  functions?: Record<string, Fn>;
  /** What a handler calls; `functions` when left out. */
  handlers?: Record<string, Fn>;
  /** The functions the host says are its own, where it tells them from the app's. */
  hostFunctions?: Record<string, Fn>;
  props?: SoftNProps;
  data?: Record<string, unknown>;
  computed?: Record<string, unknown>;
  /** Components to register beside the page. */
  register?: (registry: ComponentRegistry) => void;
  /** Leave the page's diagnostics to the test. */
  anyDiagnostics?: boolean;
}

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

/** Take down every page drawn since the last call. For `afterEach`. */
export function removeDrawnPages(): void {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
}

/** `state` with `value` at `path`, every record and list on the way copied. */
function written(state: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const parts = parseStatePath(path);
  if (parts.length === 0) return state;
  const next: Record<string, unknown> = { ...state };
  let into: Record<string, unknown> | unknown[] = next;
  for (let i = 0; i < parts.length - 1; i++) {
    const held: unknown = (into as Record<string, unknown>)[parts[i]];
    const copy: Record<string, unknown> | unknown[] = Array.isArray(held)
      ? [...held]
      : held !== null && typeof held === 'object'
        ? { ...(held as Record<string, unknown>) }
        : {};
    (into as Record<string, unknown>)[parts[i]] = copy;
    into = copy;
  }
  (into as Record<string, unknown>)[parts[parts.length - 1]] = value;
  return next;
}

export function drawPage(source: string, initial: Record<string, unknown> = {}, options: DrawnPageOptions = {}): DrawnPage {
  const doc = parse(source);
  if (!options.anyDiagnostics) expect(doc.diagnostics ?? [], source).toEqual([]);
  const writes: Array<[string, unknown]> = [];
  const shared: Array<Record<string, unknown>> = [];
  const registry = new ComponentRegistry();
  options.register?.(registry);
  let current = initial;

  function Page(): React.ReactElement {
    const [state, setPageState] = useState(initial);
    current = state;
    const context: SoftNRenderContext = {
      state,
      setState: (path, value) => {
        writes.push([path, value]);
        setPageState((before) => written(before, path, value));
      },
      shareState: (changes) => {
        shared.push(changes);
      },
      data: (options.data ?? {}) as SoftNRenderContext['data'],
      props: options.props ?? {},
      computed: options.computed ?? {},
      functions: options.functions ?? {},
      asyncFunctions: options.handlers ?? options.functions ?? {},
      ...(options.hostFunctions ? { hostFunctions: options.hostFunctions } : {}),
    };
    return <>{renderDocument(doc, context, registry)}</>;
  }

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  act(() => {
    root.render(<Page />);
  });
  const all = <T extends HTMLElement = HTMLElement>(selector: string) => Array.from(container.querySelectorAll<T>(selector));
  return {
    writes,
    shared,
    state: () => current,
    all,
    one: <T extends HTMLElement = HTMLElement>(selector: string) => {
      const found = all<T>(selector);
      expect(found, selector).toHaveLength(1);
      return found[0];
    },
    text: (selector) => container.querySelector(selector)?.textContent ?? '',
    container,
  };
}

/** Type `text` into a field, as a person does: the browser's `input` event. */
export function typeInto(field: HTMLElement, text: string): void {
  act(() => {
    const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(field, text);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** Choose the options of a `<select>` whose values are `values`: `input`, then `change`, as a browser fires them. */
export function choose(select: HTMLSelectElement, ...values: string[]): void {
  // Each event in an act of its own: a browser draws the page between them.
  act(() => {
    for (const option of Array.from(select.options)) option.selected = values.includes(option.value);
    select.dispatchEvent(new Event('input', { bubbles: true }));
  });
  act(() => {
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

export function click(element: HTMLElement): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}
