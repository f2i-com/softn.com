/**
 * Whitespace right after an expression in element content is text.
 *
 * The lexer skips whitespace before every token, and after `}` that swallowed
 * the space that belongs to the text that follows: `{streak} days` rendered
 * "12days", `{a} {b}` "xy". Inline whitespace is now read the way HTML reads
 * it; a line break between an expression and a tag is still layout, so no
 * whitespace node appears between elements that did not have one.
 */
import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { parse } from '../src/parser';
import { renderDocument, ComponentRegistry } from '../src/renderer';
import type { SoftNRenderContext } from '../src/types';

const context = { state: { n: 12, a: 'x', b: 'y' }, setState() {}, data: {}, functions: {}, computed: {} } as unknown as SoftNRenderContext;
const html = (source: string) =>
  renderToStaticMarkup(React.createElement(React.Fragment, null, renderDocument(parse(source), context, new ComponentRegistry())));

describe('text after an expression', () => {
  it.each([
    ['<p>{n} days</p>', '<p>12 days</p>'],
    ['<p>Count: {n} days left</p>', '<p>Count: 12 days left</p>'],
    ['<p>{a} {b}</p>', '<p>x y</p>'],
    ['<p>{a} and {b}</p>', '<p>x and y</p>'],
    ['<p>hello {a}</p>', '<p>hello x</p>'],
    ['<p>{a}{b}</p>', '<p>xy</p>'],
    ['<p>\n  {n}\n  days\n</p>', '<p>12 days </p>'],
  ])('%j renders %j', (source, expected) => {
    expect(html(source)).toBe(expected);
  });

  it('adds no whitespace node between an expression and an element on the next line', () => {
    const doc = parse('<div>{a}\n  <span>b</span>\n</div>');
    const div = doc.template[0] as { children: Array<{ type: string }> };
    expect(div.children.map((c) => c.type)).toEqual(['Expression', 'Element']);
  });

  it('leaves an attribute expression alone', () => {
    expect(html('<p title={a} class="c">t</p>')).toBe('<p title="x" class="c">t</p>');
  });
});
