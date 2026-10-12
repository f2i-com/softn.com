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

  it.each(TAGS)('<%s> carries a class written as class, as it does one written as className', (tag, inner) => {
    // `class` reached a component as a prop it has no use for, so the element
    // had no class and the page's rule for it never applied; the renderer
    // hands it over as className now. Both spellings, on the same element.
    for (const word of ['class', 'className']) {
      const attributes = `${word}="mine" data-kind="wall"${EXTRA[tag] ?? ''}`;
      const source = inner === null ? `<${tag} ${attributes} />` : `<${tag} ${attributes}>${inner}</${tag}>`;
      const { container, unmount } = page(source);
      expect(container.querySelector('[data-kind="wall"]')?.classList.contains('mine'), `${tag} ${word}`).toBe(true);
      unmount();
    }
  });

  it('takes nothing else it does not know: an unknown prop is not written as an attribute', () => {
    const { container, unmount } = page('<Box data-kind="wall" madeUp="x" onclickk="y">x</Box>');
    const element = container.querySelector('[data-kind="wall"]')!;
    expect(element.getAttributeNames().filter((name) => name !== 'style' && name !== 'class')).toEqual(['data-kind']);
    unmount();
  });
});

/**
 * Each form control, with the element a person focuses and a screen reader
 * names. That element is where its `id` and `aria-…` belong: a field with no
 * label on screen (a search box, a checkbox in a table row) is named by
 * `aria-label`, and was not named at all. Its `data-…` go where its class
 * goes, so a rule the page writes for both finds one element.
 */
const CONTROLS: Array<[tag: string, extra: string, control: string]> = [
  ['Input', '', 'input'],
  ['TextArea', '', 'textarea'],
  ['Select', ' options={["a", "b"]}', '[role="combobox"]'],
  ['Checkbox', '', 'input[type="checkbox"]'],
  ['Switch', '', '[role="switch"]'],
  ['Radio', ' options={["a", "b"]}', '[role="radiogroup"]'],
  ['Slider', '', '[role="slider"]'],
  ['NumberInput', '', '[role="spinbutton"]'],
  ['DatePicker', '', 'input[type="text"]'],
  ['SegmentedControl', ' options={["a", "b"]}', '[role="radiogroup"]'],
  ['Rating', '', '[role="radiogroup"]'],
  ['ColorPicker', '', 'button[aria-haspopup="dialog"]'],
];

describe('a form control', () => {
  it.each(CONTROLS)('<%s> carries its id and aria attributes on the control, its data attributes with its class', (tag, extra, control) => {
    const { container, unmount } = page(
      `<${tag} id="given-${tag}" className="pick" data-kind="field" data-on={on} aria-label="Named" aria-describedby="hint"${extra} />`,
      { on: true }
    );
    const styled = container.querySelectorAll('[data-kind="field"]');
    expect(styled, `${tag}: one element carries the data attributes`).toHaveLength(1);
    expect(styled[0].classList.contains('pick'), `${tag}: with the class`).toBe(true);
    expect(styled[0].getAttribute('data-on')).toBe('true');
    expect(container.querySelectorAll('.pick[data-on="true"]')).toHaveLength(1);
    const named = container.querySelectorAll(`#given-${tag}`);
    expect(named, `${tag}: one element has the id`).toHaveLength(1);
    const element = named[0];
    expect(element.matches(control), `${tag}: on ${control}, not ${element.outerHTML.slice(0, 80)}`).toBe(true);
    expect(element.getAttribute('aria-label') ?? '').toMatch(/^Named\b/);
    expect((element.getAttribute('aria-describedby') ?? '').split(' ')).toContain('hint');
    unmount();
  });

  it('keeps the help a field points at itself beside the help the page points at', () => {
    const { container, unmount } = page('<Input aria-describedby="hint" helperText="Your work address" /><Select aria-describedby="hint" error="Pick one" options={["a"]} />');
    for (const field of [container.querySelector('input')!, container.querySelector('[role="combobox"]')!]) {
      const ids = (field.getAttribute('aria-describedby') ?? '').split(' ');
      expect(ids).toContain('hint');
      const own = ids.filter((id) => id !== 'hint');
      expect(own).toHaveLength(1);
      expect(document.getElementById(own[0])?.textContent).toMatch(/Your work address|Pick one/);
    }
    unmount();
  });

  it.each([
    ['Select', ' options={["a"]}', '[role="combobox"]'],
    ['Radio', ' options={["a"]}', '[role="radiogroup"]'],
    ['ColorPicker', '', 'button[aria-haspopup="dialog"]'],
  ])('<%s> with no label of its own is named by the element the page points at', (tag, extra, control) => {
    const { container, unmount } = page(`<h2 id="heading">Accent</h2><${tag} aria-labelledby="heading"${extra} />`);
    expect(container.querySelector(control)?.getAttribute('aria-labelledby')).toBe('heading');
    unmount();
  });

  it('is named by what the page writes over the name it gives itself', () => {
    const { container, unmount } = page('<Slider aria-label="Volume" /><Rating aria-label="Service" />');
    expect(container.querySelector('[role="slider"]')?.getAttribute('aria-label')).toBe('Volume');
    expect(container.querySelector('[role="radiogroup"]')?.getAttribute('aria-label')).toBe('Service');
    unmount();
  });
});

describe('a Split written on one line', () => {
  it('has the two panes it was given, not the space between them', () => {
    // A space on one line between two elements is a space on the page, so
    // it is one of the children a component is handed. Split takes its
    // first two children for its panes, and took the space for the second.
    const { container, unmount } = page('<Split><div id="left">Left</div> <div id="right">Right</div></Split>');
    expect(container.querySelector('#left')).not.toBeNull();
    expect(container.querySelector('#right')).not.toBeNull();
    unmount();
  });
});
