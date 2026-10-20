/**
 * Pages no one would write on purpose, which a page still may hold: values of
 * the wrong kind, blocks where only text goes, nesting thousands deep,
 * misnesting page after page, and random pieces of the language put together.
 * Each is read and drawn without throwing, and in time that grows with the
 * page, not faster.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { parse } from '../src/parser';
import { renderDocument, ComponentRegistry } from '../src/renderer';
import type { SoftNRenderContext, SoftNProps } from '../src/types';

const registry = new ComponentRegistry();
for (const name of ['Text', 'Button', 'Stack', 'DataTable', 'Input', 'Link']) {
  registry.register(name, ({ children }: SoftNProps) => React.createElement('span', { 'data-c': name }, children as React.ReactNode));
}
const context = {
  state: {
    x: 1, items: [1, 2], item: 1, a: true, b: false, busy: false, count: 2, c: 'red', text: 'abc',
    obj: { a: 1, deep: { b: [1, { c: 2 }] } }, nested: [[1, [2]], { k: 'v' }, null, undefined, true],
    fn: () => 1, sym: Symbol('s'),
  },
  setState: () => {},
  data: {},
  props: {},
  functions: { go: () => {}, f: (v: unknown) => v },
  asyncFunctions: {},
  computed: {},
} as unknown as SoftNRenderContext;

function drawn(source: string): string {
  return renderToStaticMarkup(React.createElement(React.Fragment, null, renderDocument(parse(source), context, registry)));
}

// The renderer says once that a page nests too deep; React says what it dislikes.
beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('a value of the wrong kind', () => {
  it.each([
    ['a style with no value', '<div style>x</div>'],
    ['a style that is false', '<div style={busy && { color: "red" }}>x</div>'],
    ['a style that is a number', '<div style={count}>x</div>'],
    ['a style that is a list', '<div style={items}>x</div>'],
  ])('%s draws the element without one', (_name, source) => {
    expect(drawn(source)).toBe('<div>x</div>');
  });
});

describe('a block in a textarea', () => {
  it('draws what the block gives as its text', () => {
    expect(drawn('<textarea>#if (a)\non\n#end</textarea>')).toMatch(/on\s*<\/textarea>$/);
    expect(drawn('<textarea>#each (i in items)\n{i}\n#end</textarea>')).toMatch(/1\s*2\s*<\/textarea>$/);
  });
});

describe('nesting thousands deep', () => {
  it('is read to 512 elements deep, with one warning, and the rest beside', () => {
    const doc = parse('<div>'.repeat(3000) + 'x' + '</div>'.repeat(3000));
    expect(doc.diagnostics).toHaveLength(1);
    expect(doc.diagnostics?.[0]).toMatchObject({ severity: 'warning' });
    let depth = 0;
    for (let node = doc.template[0]; node?.type === 'Element'; node = node.children[0]) depth++;
    expect(depth).toBe(512);
    expect(drawn('<div>'.repeat(3000) + 'x')).toContain('x');
  });

  it('is drawn to 512 levels of blocks and elements, and no deeper', () => {
    const source = '#if (a)\n'.repeat(2000) + 'deep\n' + '#end\n'.repeat(2000);
    expect(() => drawn(source)).not.toThrow();
    expect(drawn(source)).not.toContain('deep');
  });
});

describe('misnesting page after page', () => {
  it.each([
    ['unclosed formatting', (n: number) => '<b><i><u>'.repeat(n) + 'x' + '</b>'.repeat(n)],
    ['end tags out of order', (n: number) => '<b><i>x</b>y</i>'.repeat(n)],
    ['formatting around blocks', (n: number) => '<b><div>x</b>y'.repeat(n)],
    ['formatting around nested blocks', (n: number) => '<em><article><span><div>x</em>y'.repeat(n)],
    ['formatting left open in lists', (n: number) => '<ul><li><em>x</ul>y'.repeat(n)],
    ['formatting left open in paragraphs', (n: number) => '<p><b class={c}>x'.repeat(n)],
    ['formatting of its own left open in each paragraph', (n: number) => Array.from({ length: n }, (_, i) => `<p><b class={c${i}}>x`).join('')],
    ['links left open in paragraphs', (n: number) => '<p><a href=1>x'.repeat(n)],
  ])('%s is read in time that grows with the page', (_name, make) => {
    // Was a second for 500 unclosed `<b><i>`, copies opened inside copies,
    // and six for 1,000 paragraphs each leaving a `<b>` of its own open.
    const started = performance.now();
    const doc = parse(make(2000));
    expect(performance.now() - started).toBeLessThan(3000);
    expect(doc.template.length).toBeGreaterThan(0);
  });
});

describe('random pages', () => {
  const PIECES = [
    '<', '</', '>', '/>', '{', '}', '"', "'", '=', ' ', '\n', '\t', '(', ')', '[', ']', ',', '.', ';', ':', '@', '#', '\\', '`', '${', '/', '*', '-', '!', '?', '&',
    '#if (', '#IF (', '#else', '#Else If (', '#end', '#END', '#each (', '#empty', ' in ', ' IN ', 'key=',
    'x', 'items', 'item', 'a', 'b', 'count', 'true', '1', '"text"', 'x > 1', 'a && b', '() => x', 'f(x)', '{ a: 1 }', '[1, 2]',
    '<div', '<DIV', '<p', '<P', '<li', '<ul', '<table', '<tr', '<td', '<caption', '<colgroup', '<select', '<option',
    '<b', '<i', '<a', '<A', '<u', '<em', '<strong', '<span', '<h1', '<h2', '<br', '<BR', '<img', '<input', '<hr', '<image', '<form', '<button', '<pre',
    '<textarea>', '</textarea>', '<title>', '</title>', '<script>', '</script>', '<style>', '</style>', '<logic>', '</logic>',
    '<svg', '</svg>', '<path d="M0 0"/>', '<math>', '<foreignObject>', '<![CDATA[', ']]>', '<!--', '-->', '<!DOCTYPE html>', '<html>', '<body>', '</body>',
    '<Text', '<Button', '<Stack', '<datatable', '<slot', '<template', '<my-card', '</div>', '</p>', '</li>', '</b>', '</i>', '</em>', '</a>', '</table>',
    '</td>', '</Text>', '</Button>', '</br>', '</form>', '</span>', '</h2>', '</svg>', '<nobr', '</nobr>', '<a href=y>', '<b class={x}>',
    '<import X from="./x.ui" />', '<data>', '</data>', '<component name="C">', '</component>',
    ' class="c"', ' CLASS=c', ' id=x', ' href=/x/y', ' onclick="go()"', ' onClick={go}', ' @click={go}', ' :bind={x}', ' class:active={x}', ' style:color={c}',
    ' style="color:red"', ' style={b && { color: "red" }}', ' style={count}', ' style', ' value={obj}', ' title={obj}', ' if={x}', ' each={items}', ' as="it"', ' disabled',
    '{obj}', '{items}', '{nested}', '{fn}', '{undefined}', '{"<b>"}', '{sym}', '#each (k, v in obj)', '#each (n in count)',
    '&amp;', '&amp', '&copy', '&notit;', '&#169;', '&#0;', '&#x110000;', '&lt;', 'é', '漢', '😀', '\u0000', '​', '﻿',
  ];

  it('are read and drawn without throwing', () => {
    let seed = 20261020;
    const random = (): number => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let page = 0; page < 3000; page++) {
      let source = '';
      const length = 1 + Math.floor(random() * 50);
      for (let piece = 0; piece < length; piece++) source += PIECES[Math.floor(random() * PIECES.length)];
      expect(() => drawn(source), source).not.toThrow();
    }
  });
});
