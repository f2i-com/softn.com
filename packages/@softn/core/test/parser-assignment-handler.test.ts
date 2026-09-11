/**
 * What the engine does with `@click={() => count = count + 1}` now that the
 * parser reads it whole.
 *
 * Before, the handler reached the renderer as `() => count` and the element
 * carried a stray `count` attribute; the click evaluated an identifier and
 * threw nothing away visibly. Now the renderer receives an arrow whose body
 * is an AssignmentExpression, takes its ArrowFunctionExpression path, and
 * the click invokes that function.
 *
 * The renderer's evaluator resolves the target with getExpressionPath,
 * evaluates the right-hand side, applies a compound operator to the current
 * value, and writes through context.setState — the last case below pins the
 * write itself.
 */

import { describe, it, expect } from 'vitest';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { parse } from '../src/parser';
import { renderDocument, ComponentRegistry, evaluateExpression } from '../src/renderer';
import type { SoftNRenderContext } from '../src/types';

const SOURCE = '<App><Button @click={() => count = count + 1}>Add</Button></App>';

function contextFor(state: Record<string, unknown>) {
  const calls: Array<[string, unknown]> = [];
  const context = {
    state,
    setState: (path: string, value: unknown) => {
      calls.push([path, value]);
    },
    data: {},
    props: {},
    functions: {},
    asyncFunctions: {},
    computed: {},
  } as unknown as SoftNRenderContext;
  return { context, calls };
}

let container: HTMLDivElement;
let root: Root;

function mount(source: string, state: Record<string, unknown>) {
  const doc = parse(source);
  const { context, calls } = contextFor(state);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const registry = new ComponentRegistry();
  registry.register('App', ({ children }: { children?: React.ReactNode }) =>
    React.createElement('div', null, children)
  );
  registry.register(
    'Button',
    ({ onClick, children, ...rest }: { onClick?: () => void; children?: React.ReactNode }) =>
      React.createElement('button', { onClick, 'data-extra': Object.keys(rest).join(',') }, children)
  );
  act(() => {
    root.render(renderDocument(doc, context, registry) as React.ReactElement);
  });
  return {
    doc,
    calls,
    cleanup: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe('a one-line assignment handler in the engine', () => {
  it('reaches the renderer as an arrow whose body is the assignment, with no stray prop on the element', () => {
    const { doc, cleanup } = mount(SOURCE, { count: 0 });
    const app = doc.template.find((n) => n.type === 'Element');
    const button = app && app.type === 'Element' ? app.children.find((n) => n.type === 'Element') : undefined;
    expect(button && button.type === 'Element' ? button.props : null).toEqual([]);
    const handler = button && button.type === 'Element' ? button.events[0].handler : undefined;
    expect(handler?.type).toBe('ArrowFunctionExpression');
    if (handler?.type === 'ArrowFunctionExpression' && typeof handler.body !== 'string') {
      expect(handler.body.type).toBe('AssignmentExpression');
    }
    // The stray `count={true}` used to arrive at the component as a prop.
    const el = container.querySelector('button') as HTMLButtonElement;
    expect(el.getAttribute('data-extra')).toBe('');
    cleanup();
  });

  it('evaluates to a callable handler that a click invokes without throwing', () => {
    const { doc, cleanup } = mount(SOURCE, { count: 0 });
    const el = container.querySelector('button') as HTMLButtonElement;
    expect(el.textContent).toBe('Add');
    expect(() => {
      act(() => {
        el.click();
      });
    }).not.toThrow();

    // The same arrow, evaluated directly, is a function — the renderer's
    // ArrowFunctionExpression path, not the "not a function" no-op fallback.
    const app = doc.template.find((n) => n.type === 'Element');
    const button = app && app.type === 'Element' ? app.children.find((n) => n.type === 'Element') : undefined;
    const handler = button && button.type === 'Element' ? button.events[0].handler : undefined;
    const { context } = contextFor({ count: 0 });
    const fn = handler ? evaluateExpression(handler, context) : undefined;
    expect(typeof fn).toBe('function');
    cleanup();
  });

  // Pinned as a known gap outside the parser: see the file comment. When the
  // renderer evaluates AssignmentExpression this case starts failing — make
  // it a plain `it` then.
  it('writes the new value to state on click', () => {
    const { calls, cleanup } = mount(SOURCE, { count: 0 });
    const el = container.querySelector('button') as HTMLButtonElement;
    act(() => {
      el.click();
    });
    expect(calls).toContainEqual(['count', 1]);
    cleanup();
  });
});
