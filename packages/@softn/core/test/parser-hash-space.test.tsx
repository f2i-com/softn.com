/**
 * The space before a `#` that begins no block.
 *
 *     <p>Ticket {name} #{id}</p>        "Ticket Ada#12"
 *     <b>x</b> #1 seller                "x#1 seller"
 *
 * Whitespace after an expression or an element belongs to the words that
 * follow it, and is layout before a block (`#if`, `#each`, `#end`…). Which of
 * the two was decided by the `#` alone, so the space before any `#` was
 * dropped: an order number, a hashtag, a hex colour, a "# of items". The
 * text itself has long told a `#` that opens a block from one that is a
 * character; the whitespace before it asks the same question now.
 */

import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { parse } from '../src/parser';
import { renderDocument, ComponentRegistry } from '../src/renderer';
import type { TemplateNode } from '../src/parser/ast';
import type { SoftNRenderContext } from '../src/types';

/** The children of the first element, text as text and anything else as its tag or kind. */
function childrenOf(source: string): string[] {
  const doc = parse(source);
  expect(doc.diagnostics ?? [], source).toEqual([]);
  const first = doc.template[0];
  if (first.type !== 'Element') throw new Error('expected an element first');
  return first.children.map(show);
}
function show(node: TemplateNode): string {
  if (node.type === 'Text') return JSON.stringify(node.content);
  if (node.type === 'Element') return `<${node.tag}>`;
  if (node.type === 'Expression') return '{}';
  return node.type;
}

function html(source: string, state: Record<string, unknown> = {}): string {
  const doc = parse(source);
  expect(doc.diagnostics ?? [], source).toEqual([]);
  const context = { state, setState: () => {}, data: {}, props: {}, functions: {}, asyncFunctions: {}, computed: {} } as unknown as SoftNRenderContext;
  return renderToStaticMarkup(React.createElement(React.Fragment, null, renderDocument(doc, context, new ComponentRegistry())));
}

describe('a space before a # that begins no block', () => {
  it('is kept after an expression', () => {
    expect(childrenOf('<p>Ticket {name} #{id}</p>')).toEqual(['"Ticket "', '{}', '" #"', '{}']);
    expect(childrenOf('<p>{count} #hashtags</p>')).toEqual(['{}', '" #hashtags"']);
    expect(childrenOf('<p>{name} #ff8800</p>')).toEqual(['{}', '" #ff8800"']);
    expect(childrenOf('<p>{n} # of items</p>')).toEqual(['{}', '" # of items"']);
  });

  it('is kept after an element', () => {
    expect(childrenOf('<p><b>x</b> #1 seller</p>')).toEqual(['<b>', '" #1 seller"']);
    expect(childrenOf('<p><img src="a.png" /> #2</p>')).toEqual(['<img>', '" #2"']);
    expect(childrenOf('<p><b>Order</b>   #{id}</p>')).toEqual(['<b>', '" #"', '{}']);
  });

  it('is kept after an opening tag', () => {
    expect(childrenOf('<b> #1</b>')).toEqual(['" #1"']);
    expect(childrenOf('<span> #{id}</span>')).toEqual(['" #"', '{}']);
  });

  it('is kept before a word that only starts like a block’s', () => {
    expect(childrenOf('<p>{verb} #endpoint</p>')).toEqual(['{}', '" #endpoint"']);
    expect(childrenOf('<p><b>a</b> #iffy</p>')).toEqual(['<b>', '" #iffy"']);
    expect(childrenOf('<p><b>a</b> #eachOther</p>')).toEqual(['<b>', '" #eachOther"']);
  });

  it('is one space where the # is on the next line, as before any other word', () => {
    expect(childrenOf('<p>\n  {name}\n  #1 pick\n</p>')).toEqual(['{}', '" #1 pick "']);
    expect(childrenOf('<p>\n  <b>Name</b>\n  #1 pick\n</p>')).toEqual(['<b>', '" #1 pick "']);
  });

  it('is nothing where the source has none', () => {
    expect(childrenOf('<p>{name}#{id}</p>')).toEqual(['{}', '"#"', '{}']);
    expect(childrenOf('<p><b>x</b>#1</p>')).toEqual(['<b>', '"#1"']);
  });

  it('is drawn', () => {
    expect(html('<p>Ticket {name} #{id}</p>', { name: 'Ada', id: 12 })).toBe('<p>Ticket Ada #12</p>');
    expect(html('<p><b>x</b> #1 seller</p>')).toBe('<p><b>x</b> #1 seller</p>');
    expect(html('<p>Order<b> #{id}</b></p>', { id: 7 })).toBe('<p>Order<b> #7</b></p>');
  });
});

describe('a # that begins a block, after a space', () => {
  it('still begins it, and takes no space with it', () => {
    expect(childrenOf('<div><b>a</b> #if (ok)\n<i>b</i>\n#end</div>')).toEqual(['<b>', 'IfBlock']);
    expect(childrenOf('<div>{a} #each (x in xs)\n<i>{x}</i>\n#end</div>')).toEqual(['{}', 'EachBlock']);
    expect(childrenOf('<div> #if (ok)\n<i>b</i>\n#end</div>')).toEqual(['IfBlock']);
    expect(childrenOf('<div><b>a</b> #IF (ok)\n<i>b</i>\n#END</div>')).toEqual(['<b>', 'IfBlock']);
  });

  it('still ends and divides one', () => {
    const doc = parse('<div>\n#if (ok)\n<b>a</b> #else <i>b</i> #end\n</div>');
    expect(doc.diagnostics ?? []).toEqual([]);
    const div = doc.template[0];
    if (div.type !== 'Element') throw new Error('expected an element first');
    expect(div.children.map(show)).toEqual(['IfBlock']);
    const block = div.children[0];
    if (block.type !== 'IfBlock' || !Array.isArray(block.alternate)) throw new Error('expected an #if with an #else');
    expect(block.consequent.map(show)).toEqual(['<b>']);
    expect(block.alternate.map(show)).toEqual(['<i>']);
  });

  it('is a character when it is written with a backslash, as it was', () => {
    expect(childrenOf('<p><b>a</b> \\#if it rains</p>')).toEqual(['<b>', '" #if it rains"']);
  });
});
