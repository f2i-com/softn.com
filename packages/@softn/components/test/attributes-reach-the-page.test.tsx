/**
 * `id`, `data-…` and `aria-…` written on a component reach its element.
 *
 * A component takes the props it knows and drops the rest. For most props
 * that is right; for these three it is a surprise, because they are not the
 * component's business at all: they are how a page's own stylesheet finds an
 * element, how a link or a label points at it, and how it is described to a
 * screen reader. Two of the shipped examples mark their chosen tool with
 * `<Box className="tool" data-on={tool === "wall"}>` and style
 * `.tool[data-on="true"]`; the Box dropped `data-on`, and the chosen tool
 * was never shown as chosen (81 uses between them).
 *
 * The components a page is laid out and written with pass them through.
 */

import { describe, expect, it } from 'vitest';
import { ComponentRegistry, parse, renderDocument, type SoftNComponent, type SoftNRenderContext } from '@softn/core';
import { mount } from './dom';
import { builtinComponents } from '../src/registry';

const registry = new ComponentRegistry();
registry.registerAll(builtinComponents as unknown as Record<string, SoftNComponent>);

function page(source: string, state: Record<string, unknown> = {}) {
  const doc = parse(source);
  expect(doc.diagnostics ?? [], source).toEqual([]);
  const context = { state, setState: () => {}, data: {}, props: {}, computed: {}, functions: {}, asyncFunctions: {} } as unknown as SoftNRenderContext;
  return mount(<>{renderDocument(doc, context, registry)}</>);
}

/** Each tag, written with something inside it where it takes something. */
const TAGS: Array<[tag: string, inner: string | null]> = [
  ['Box', '<span>x</span>'],
  ['Stack', '<span>x</span>'],
  ['Grid', '<span>x</span>'],
  ['Card', '<span>x</span>'],
  ['Container', '<span>x</span>'],
  ['Center', '<span>x</span>'],
  ['Text', 'words'],
  ['Heading', 'words'],
  ['Button', 'Go'],
  ['Badge', 'New'],
  ['Tag', 'Label'],
  ['Icon', null],
  ['Image', null],
];

const EXTRA: Record<string, string> = { Icon: ' name="check"', Image: ' src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="dot"' };

describe('a component of the page', () => {
  it.each(TAGS)('<%s> carries its id and its data and aria attributes', (tag, inner) => {
    const attributes = `id="given-${tag}" data-kind="wall" data-on={on} data-count={count} aria-describedby="hint"${EXTRA[tag] ?? ''}`;
    const source = inner === null ? `<${tag} ${attributes} />` : `<${tag} ${attributes}>${inner}</${tag}>`;
    const { container, unmount } = page(source, { on: true, count: 3 });
    const found = container.querySelectorAll('[data-kind="wall"]');
    expect(found, `${tag}: one element carries them`).toHaveLength(1);
    const element = found[0];
    expect(element.id).toBe(`given-${tag}`);
    expect(element.getAttribute('data-on')).toBe('true');
    expect(element.getAttribute('data-count')).toBe('3');
    expect(element.getAttribute('aria-describedby')).toBe('hint');
    // On the component's own element, not on something put around it.
    expect(container.firstElementChild === element || container.firstElementChild?.tagName === 'STYLE' || element.parentElement === container).toBe(true);
    unmount();
  });

  it('is found by the page’s own stylesheet, which is what the examples rely on', () => {
    const { container, unmount } = page('<Box className="tool" data-on={tool === "wall"}>Wall</Box><Box className="tool" data-on={tool === "door"}>Door</Box>', { tool: 'wall' });
    expect(Array.from(container.querySelectorAll('.tool[data-on="true"]')).map((el) => el.textContent)).toEqual(['Wall']);
    unmount();
  });

  it('keeps the breakpoints of a Stack and a Grid that is given an id', () => {
    const { container, unmount } = page('<Stack id="row" direction="horizontal" mobileVertical><span>a</span></Stack><Grid id="cards" columns={3} collapseOnMobile><span>b</span></Grid>');
    // Their media rules used to be written against an id of the component's
    // own making, which left no id for the page to give. They find the
    // element by a mark of their own now.
    const rules = Array.from(container.querySelectorAll('style')).map((style) => style.textContent ?? '').join('\n');
    const row = container.querySelector('#row')!;
    const cards = container.querySelector('#cards')!;
    expect(rules).toContain(`[data-softn-stack="${row.getAttribute('data-softn-stack')}"]`);
    expect(rules).toContain(`[data-softn-grid="${cards.getAttribute('data-softn-grid')}"]`);
    expect(rules).not.toContain('#softn-');
    unmount();
  });

  it('takes nothing else it does not know: an unknown prop is not written as an attribute', () => {
    const { container, unmount } = page('<Box data-kind="wall" madeUp="x" onclickk="y">x</Box>');
    const element = container.querySelector('[data-kind="wall"]')!;
    expect(element.getAttributeNames().filter((name) => name !== 'style' && name !== 'class')).toEqual(['data-kind']);
    unmount();
  });
});
