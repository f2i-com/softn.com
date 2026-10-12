/**
 * `selectTo` on a SmartGrid writes the row chosen to app state.
 *
 * `<SmartGrid rows={…} selectTo="picked" />` is the grid's way of saying
 * "keep the row the person chooses in `picked`". The grid accepted it and did
 * nothing with it: a component cannot write app state, only the renderer can.
 * So the renderer takes `selectTo` off the props and gives the grid an
 * `onSelect` that writes the row there, by the rules `:bind` writes by,
 * before the page's own `@select` runs.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { parse } from '../src/parser';
import { renderDocument, ComponentRegistry } from '../src/renderer';
import type { SoftNComponent } from '../src/renderer/registry';
import type { SoftNRenderContext } from '../src/types';

/** What the stand-in grid was handed, the last time it was drawn. */
let handed: Record<string, unknown> = {};

function StandInGrid(props: Record<string, unknown>) {
  handed = props;
  return React.createElement('div', null, 'grid');
}

function draw(source: string, extra: Partial<SoftNRenderContext> = {}) {
  const writes: Array<[string, unknown]> = [];
  const registry = new ComponentRegistry();
  registry.register('SmartGrid', StandInGrid as unknown as SoftNComponent);
  const context = {
    state: { rows: [{ id: 1 }, { id: 2 }], picked: null },
    setState: (path: string, value: unknown) => writes.push([path, value]),
    data: {},
    props: {},
    computed: {},
    functions: {},
    asyncFunctions: {},
    ...extra,
  } as unknown as SoftNRenderContext;
  const doc = parse(source);
  expect(doc.diagnostics ?? []).toEqual([]);
  renderToStaticMarkup(React.createElement(React.Fragment, null, renderDocument(doc, context, registry)));
  return writes;
}

describe('selectTo on a SmartGrid', () => {
  it('writes the row chosen to the path it names, before the page\'s own @select', () => {
    const order: string[] = [];
    const writes = draw('<SmartGrid rows={rows} selectTo="picked" @select={(row) => chose(row)} />', {
      functions: { chose: (row: unknown) => order.push(`chose ${JSON.stringify(row)} after ${writes.length} write`) },
    } as Partial<SoftNRenderContext>);
    expect(handed.selectTo).toBeUndefined();
    expect(typeof handed.onSelect).toBe('function');
    (handed.onSelect as (row: unknown) => void)({ id: 2 });
    expect(writes).toEqual([['picked', { id: 2 }]]);
    expect(order).toEqual(['chose {"id":2} after 1 write']);
  });

  it('writes with no @select at all', () => {
    const writes = draw('<SmartGrid rows={rows} selectTo="picked" />');
    (handed.onSelect as (row: unknown) => void)({ id: 1 });
    expect(writes).toEqual([['picked', { id: 1 }]]);
  });

  it('goes through the handler a page gives for that state, as :bind does', () => {
    const seen: Array<[string, unknown]> = [];
    const writes = draw('<SmartGrid rows={rows} selectTo="picked" />', {
      functions: { onPickedChange: (path: unknown, value: unknown) => seen.push([String(path), value]) },
    } as Partial<SoftNRenderContext>);
    (handed.onSelect as (row: unknown) => void)({ id: 1 });
    expect(seen).toEqual([['picked', { id: 1 }]]);
    expect(writes).toEqual([]);
  });

  it('leaves selectTo alone on any other component', () => {
    const registry = new ComponentRegistry();
    let other: Record<string, unknown> = {};
    registry.register('Table', ((props: Record<string, unknown>) => {
      other = props;
      return null;
    }) as unknown as SoftNComponent);
    const context = { state: {}, setState: () => {}, data: {}, props: {}, computed: {}, functions: {}, asyncFunctions: {} } as unknown as SoftNRenderContext;
    renderToStaticMarkup(React.createElement(React.Fragment, null, renderDocument(parse('<Table selectTo="picked" />'), context, registry)));
    expect(other.selectTo).toBe('picked');
    expect(other.onSelect).toBeUndefined();
  });
});
