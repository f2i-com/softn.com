/**
 * `@event` names and the React props they become.
 *
 * `@click` worked because React calls it `onClick`. `@keydown` did not: React
 * calls it `onKeyDown`, silently ignores `onKeydown`, and the handler was never
 * wired up — a control that looks normal and does nothing, next to an `@click`
 * on the same element that works.
 *
 * Reachable from this repo's own tools: the visual builder's event picker offers
 * 'keydown' and 'keyup', and @softn/core's demo bundle uses `@keydown` on its
 * edit field and `@dblclick` to open the editor.
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { parse } from '../src/parser';
import { renderDocument, ComponentRegistry } from '../src/renderer';
import { reactEventProp } from '../src/renderer/render';
import type { SoftNRenderContext, SoftNProps } from '../src/types';

/** Records the props a component is handed, so the prop NAME is observable. */
function probeRegistry(seen: Record<string, unknown>): ComponentRegistry {
  const r = new ComponentRegistry();
  r.register('Probe', (props: SoftNProps) => {
    for (const k of Object.keys(props)) seen[k] = props[k];
    return React.createElement('span', null, 'probe');
  });
  return r;
}

function context(overrides: Partial<SoftNRenderContext> = {}): SoftNRenderContext {
  return {
    state: {}, setState: () => {}, data: {}, props: {},
    functions: {}, asyncFunctions: {}, computed: {}, ...overrides,
  };
}

describe('reactEventProp', () => {
  it('maps the DOM names whose React prop is irregular', () => {
    expect(reactEventProp('keydown')).toBe('onKeyDown');
    expect(reactEventProp('keyup')).toBe('onKeyUp');
    expect(reactEventProp('dblclick')).toBe('onDoubleClick');
    expect(reactEventProp('mouseenter')).toBe('onMouseEnter');
    expect(reactEventProp('contextmenu')).toBe('onContextMenu');
    expect(reactEventProp('touchstart')).toBe('onTouchStart');
  });

  it('leaves regular DOM names alone', () => {
    expect(reactEventProp('click')).toBe('onClick');
    expect(reactEventProp('change')).toBe('onChange');
    expect(reactEventProp('submit')).toBe('onSubmit');
    expect(reactEventProp('focus')).toBe('onFocus');
  });

  it('leaves COMPONENT callbacks alone, which is why this is a table and not a rule', () => {
    // DPad hands `@press` the direction pressed; a bundle emits `@clearCompleted`.
    // Neither is a DOM event and neither must be rewritten.
    expect(reactEventProp('press')).toBe('onPress');
    expect(reactEventProp('clearCompleted')).toBe('onClearCompleted');
    expect(reactEventProp('somethingNobodyHasHeardOf')).toBe('onSomethingNobodyHasHeardOf');
  });

  it('does not disturb a name already written in camelCase', () => {
    // `@keyDown` resolved correctly before this existed, and still does.
    expect(reactEventProp('keyDown')).toBe('onKeyDown');
    expect(reactEventProp('doubleClick')).toBe('onDoubleClick');
  });
});

describe('@event names reach the component as React props', () => {
  it('gives Probe the props React actually recognises', () => {
    const seen: Record<string, unknown> = {};
    renderToStaticMarkup(
      renderDocument(
        parse('<Probe @keydown={a} @dblclick={b} @click={c} @press={d} />'),
        context({ functions: { a: () => {}, b: () => {}, c: () => {}, d: () => {} } }),
        probeRegistry(seen)
      ) as React.ReactElement
    );
    const names = Object.keys(seen).filter((k) => k.startsWith('on')).sort();
    expect(names).toEqual(['onClick', 'onDoubleClick', 'onKeyDown', 'onPress']);
    expect(names).not.toContain('onKeydown');
    expect(names).not.toContain('onDblclick');
  });

  it('still lets :bind and a handler share one event', () => {
    // The collision check reads the same prop name, so it has to use the same
    // mapping or a bound handler stops being seen.
    const seen: Record<string, unknown> = {};
    renderToStaticMarkup(
      renderDocument(
        parse('<Probe :bind={q} @change={note} />'),
        context({ state: { q: '' }, functions: { note: () => {} } }),
        probeRegistry(seen)
      ) as React.ReactElement
    );
    expect(typeof seen.onChange).toBe('function');
  });
});
