/**
 * Choosing a row of a SmartGrid from a page, the way that works today:
 * `@select` with an assignment. (`selectTo="name"`, which its props list,
 * needs the renderer to write the row; components cannot write state.)
 */

import { describe, expect, it } from 'vitest';
import { ComponentRegistry, parse, renderDocument, type SoftNComponent, type SoftNRenderContext } from '@softn/core';
import { mount, click } from './dom';
import { builtinComponents } from '../src/registry';

const registry = new ComponentRegistry();
registry.registerAll(builtinComponents as unknown as Record<string, SoftNComponent>);

describe('a SmartGrid row chosen from a page', () => {
  it('is written to state by @select', () => {
    const writes: Array<[string, unknown]> = [];
    const rows = [{ id: 1, name: 'Ada' }, { id: 2, name: 'Grace' }];
    const doc = parse('<SmartGrid data={rows} columns="name" @select={(row) => picked = row} />');
    expect(doc.diagnostics ?? []).toEqual([]);
    const context = { state: { rows, picked: null }, setState: (path: string, value: unknown) => writes.push([path, value]), data: {}, props: {}, computed: {}, functions: {}, asyncFunctions: {} } as unknown as SoftNRenderContext;
    const { container, unmount } = mount(<>{renderDocument(doc, context, registry)}</>);
    const grace = Array.from(container.querySelectorAll<HTMLElement>('tr[tabindex="0"], [role="button"]')).find((row) => (row.textContent ?? '').includes('Grace'));
    expect(grace).toBeTruthy();
    click(grace);
    expect(writes).toEqual([['picked', rows[1]]]);
    unmount();
  });
});
