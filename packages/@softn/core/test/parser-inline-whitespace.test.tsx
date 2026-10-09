/**
 * A space between two things on one line of text is a space.
 *
 * Whitespace before a token is skipped, which is right between the lines of
 * a layout and wrong inside a line of words. After an expression it was
 * already read the way HTML reads inline text (`{n} days` keeps its space).
 * After a tag it was not, so the space that follows an element was lost:
 *
 *     <Text>Hello <b>bold</b> and more</Text>      "Hello boldand more"
 *     <Text><b>Total:</b> {total}</Text>            "Total:12"
 *     <Text>{count} <b>left</b></Text>              "3left"
 *     <span>Pine ridge</span> <span>•</span> ...   "Pine ridge•..."
 *
 * The last is a line of a shipped example, which ran with its separators
 * glued to the words on both sides. What is read now: whitespace after an
 * element or an expression belongs to the text that follows it, and on one
 * line between two elements, or an element and an expression, it is a single
 * space. A line break between two tags is still layout and no node at all,
 * so a column of elements has no text between them.
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
  const context = { state, setState: () => {}, data: {}, functions: {}, computed: {} } as unknown as SoftNRenderContext;
  return renderToStaticMarkup(React.createElement(React.Fragment, null, renderDocument(doc, context, new ComponentRegistry())));
}

describe('whitespace after an element, on a line of text', () => {
  it('belongs to the words that follow it', () => {
    expect(childrenOf('<p>Hello <b>bold</b> and more</p>')).toEqual(['"Hello "', '<b>', '" and more"']);
    expect(childrenOf('<p>Press <kbd>Ctrl</kbd> + <kbd>S</kbd> to save</p>')).toEqual([
      '"Press "', '<kbd>', '" + "', '<kbd>', '" to save"',
    ]);
    expect(childrenOf('<p><img src="a.png" /> Saved</p>')).toEqual(['<img>', '" Saved"']);
  });

  it('is nothing where the source has none', () => {
    expect(childrenOf('<p>one<b>two</b>three (<i>four</i>)</p>')).toEqual(['"one"', '<b>', '"three ("', '<i>', '")"']);
    expect(childrenOf('<p><b>a</b><i>b</i>{c}</p>')).toEqual(['<b>', '<i>', '{}']);
  });

  it('is one space between two elements, or an element and an expression', () => {
    expect(childrenOf('<p><b>a</b> <i>b</i></p>')).toEqual(['<b>', '" "', '<i>']);
    expect(childrenOf('<p><b>a</b>    <i>b</i></p>')).toEqual(['<b>', '" "', '<i>']);
    expect(childrenOf('<p><b>Total:</b> {total}</p>')).toEqual(['<b>', '" "', '{}']);
    expect(childrenOf('<p>{count} <b>left</b></p>')).toEqual(['{}', '" "', '<b>']);
    expect(childrenOf('<p><img src="a.png" /> <b>x</b></p>')).toEqual(['<img>', '" "', '<b>']);
  });

  it('is drawn', () => {
    expect(
      html('<p><span>Pine ridge</span> <span>•</span> <b>Dual needs:</b> Food + Water <span>•</span> Day {day}</p>', { day: 3 })
    ).toBe('<p><span>Pine ridge</span> <span>•</span> <b>Dual needs:</b> Food + Water <span>•</span> Day 3</p>');
    expect(html('<p><b>Total:</b> {total} <i>items</i></p>', { total: 12 })).toBe('<p><b>Total:</b> 12 <i>items</i></p>');
  });
});

describe('whitespace that is layout', () => {
  it('a line break between two tags is no node', () => {
    expect(childrenOf('<div>\n  <b>a</b>\n  <i>b</i>\n\n  <u>c</u>\n</div>')).toEqual(['<b>', '<i>', '<u>']);
    expect(childrenOf('<div><b>a</b>\n<i>b</i></div>')).toEqual(['<b>', '<i>']);
    expect(childrenOf('<div>{a}\n<b>b</b>\n{c}</div>')).toEqual(['{}', '<b>', '{}']);
  });

  it('the edges of what a tag holds are trimmed as they were', () => {
    expect(childrenOf('<p> hello</p>')).toEqual(['"hello"']);
    expect(childrenOf('<p>   <b>a</b>   </p>')).toEqual(['<b>']);
    expect(childrenOf('<p><b>a</b> </p>')).toEqual(['<b>']);
    expect(childrenOf('<p>{a} </p>')).toEqual(['{}']);
  });

  it('a comment after an element takes no space with it', () => {
    expect(childrenOf('<div><b>a</b> // why\n<i>b</i></div>')).toEqual(['<b>', '<i>']);
    expect(childrenOf('<div><b>a</b> <!-- why --> <i>b</i></div>')).toEqual(['<b>', '<i>']);
  });

  it('a block after an element starts on its own', () => {
    expect(childrenOf('<div><b>a</b> #if (ok)\n<i>b</i>\n#end</div>')).toEqual(['<b>', 'IfBlock']);
  });

  it('the top of a file has no text before its first element or after its last', () => {
    const doc = parse('<logic src="./main.logic" /> <App><b>a</b></App> <style>.a { color: red; }</style>');
    expect(doc.diagnostics ?? []).toEqual([]);
    expect(doc.template.map(show)).toEqual(['<App>']);
  });

  it('words that begin a template after a declaration have no space before them', () => {
    const doc = parse('<component name="Greeting">\n  <prop name="name" />\n</component>\n\nHello, <b>{name}</b>!\n');
    expect(doc.diagnostics ?? []).toEqual([]);
    expect(doc.template.map(show)).toEqual(['"Hello, "', '<b>', '"! "']);
  });

  it('the declarations of a data block are not text', () => {
    const doc = parse('<data><collection name="tasks" as="tasks" /> <collection name="people" as="people" /></data>\n<App />');
    expect(doc.diagnostics ?? []).toEqual([]);
    expect(doc.data?.collections.map((c) => c.name)).toEqual(['tasks', 'people']);
    expect(doc.template.map(show)).toEqual(['<App>']);
  });
});

describe('words after an element on the next line', () => {
  it('keep one space before them, as words after an expression do', () => {
    expect(childrenOf('<p>\n  <b>Name</b>\n  and the rest\n</p>')).toEqual(['<b>', '" and the rest "']);
    expect(childrenOf('<p>\n  {name}\n  and the rest\n</p>')).toEqual(['{}', '" and the rest "']);
  });
});
