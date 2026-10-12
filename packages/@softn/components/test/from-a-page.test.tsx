/**
 * Two components that did what they say when written in JSX and not when
 * written in a page.
 *
 * Both reached their children with `cloneElement`. From a page each child
 * arrives inside the renderer's error boundary, so what was cloned in went
 * to the boundary, which draws nothing of its own, and never reached the
 * element. A List drew no dividers and none of its spacing; a Tooltip never
 * told the control it describes that it does.
 */

import React, { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ComponentRegistry, parse, renderDocument, type SoftNComponent, type SoftNRenderContext } from '@softn/core';
import { mount, type Mounted } from './dom';
import { builtinComponents } from '../src/registry';
import { List, ListItem } from '../src/data/List';

const registry = new ComponentRegistry();
registry.registerAll(builtinComponents as unknown as Record<string, SoftNComponent>);
const context = { state: {}, setState: () => {}, data: {}, props: {}, computed: {}, functions: {}, asyncFunctions: {} } as unknown as SoftNRenderContext;

function drawn(source: string): React.ReactElement {
  const doc = parse(source);
  expect(doc.diagnostics ?? [], source).toEqual([]);
  return <>{renderDocument(doc, context, registry)}</>;
}

const mounted: Mounted[] = [];
afterEach(() => {
  for (const view of mounted.splice(0)) view.unmount();
});

/** Each item's own style, and the rules the list writes for its items. */
function items(element: React.ReactElement) {
  const view = mount(element);
  mounted.push(view);
  const list = view.container.querySelector('ul')!;
  const rules = Array.from(view.container.querySelectorAll('style')).map((s) => s.textContent ?? '').join('\n');
  return { list, rules, lis: Array.from(list.querySelectorAll<HTMLElement>(':scope > li')) };
}

describe('a List', () => {
  it.each(['divided', 'bordered'])('%s, from a page, draws a line between its items and none above the first', (variant) => {
    const { list, rules, lis } = items(drawn(`<List variant="${variant}"><ListItem>A</ListItem><ListItem>B</ListItem><ListItem>C</ListItem></List>`));
    expect(lis).toHaveLength(3);
    // The line is a rule for every item after another, written for this list.
    const mark = list.getAttribute('data-softn-list');
    expect(mark).toBeTruthy();
    expect(rules).toContain(`[data-softn-list="${mark}"] > li + li`);
    expect(rules).toMatch(/border-top:\s*1px solid/);
    expect(lis[0].style.borderTop).toBe('');
  });

  it('draws no lines when it is not divided or bordered', () => {
    const { rules } = items(drawn('<List><ListItem>A</ListItem><ListItem>B</ListItem></List>'));
    expect(rules).not.toMatch(/border-top/);
  });

  it('gives its items its spacing from a page, as it does in JSX', () => {
    for (const element of [
      drawn('<List spacing="lg"><ListItem>A</ListItem><ListItem>B</ListItem></List>'),
      <List key="jsx" spacing="lg">
        <ListItem>A</ListItem>
        <ListItem>B</ListItem>
      </List>,
    ]) {
      const { lis } = items(element);
      expect(lis.map((li) => li.style.padding)).toEqual(['1rem', '1rem']);
    }
  });

  it('lets an item keep a padding of its own', () => {
    const { lis } = items(drawn('<List spacing="lg"><ListItem style={{ padding: "2px" }}>A</ListItem></List>'));
    expect(lis[0].style.padding).toBe('2px');
  });

  it('is hoverable from a page', () => {
    const { lis } = items(drawn('<List hoverable><ListItem>A</ListItem></List>'));
    expect(lis[0].style.cursor).toBe('pointer');
  });

  it('draws the same markup for its items in JSX as from a page', () => {
    const fromPage = renderToStaticMarkup(drawn('<List variant="divided" spacing="sm"><ListItem>A</ListItem><ListItem>B</ListItem></List>'));
    const inJsx = renderToStaticMarkup(
      <List variant="divided" spacing="sm">
        <ListItem>A</ListItem>
        <ListItem>B</ListItem>
      </List>
    );
    // The list's own mark is made up where it is drawn; everything else is the same.
    const strip = (html: string) => html.replace(/softn-list-\w+/g, 'softn-list');
    expect(strip(fromPage)).toBe(strip(inJsx));
  });
});

describe('a Tooltip', () => {
  it('from a page, is the description of the control it is on while it shows', () => {
    const view = mount(drawn('<Tooltip content="Saves a copy"><Button>Save</Button></Tooltip>'));
    mounted.push(view);
    const button = view.container.querySelector('button')!;
    act(() => button.focus());
    const tooltip = view.container.querySelector('[role="tooltip"]')!;
    expect(tooltip.getAttribute('aria-hidden')).toBe('false');
    expect((button.getAttribute('aria-describedby') ?? '').split(' ')).toContain(tooltip.id);
    act(() => button.blur());
    expect(button.getAttribute('aria-describedby')).toBeNull();
  });

  it('keeps a description the control already had', () => {
    const view = mount(drawn('<Tooltip content="Saves a copy"><button aria-describedby="hint">Save</button></Tooltip><p id="hint">Ctrl+S</p>'));
    mounted.push(view);
    const button = view.container.querySelector('button')!;
    act(() => button.focus());
    const tooltip = view.container.querySelector('[role="tooltip"]')!;
    expect((button.getAttribute('aria-describedby') ?? '').split(' ')).toEqual(['hint', tooltip.id]);
    act(() => button.blur());
    expect(button.getAttribute('aria-describedby')).toBe('hint');
  });
});
