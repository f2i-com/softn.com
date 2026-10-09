/**
 * What is typed into a property is what the app shows.
 *
 * A text property is written to the source as a quoted attribute, and the
 * engine reads that attribute back. The two did not agree on how a
 * character with a meaning of its own is spelled. The generator wrote `&`
 * as `&amp;` and `"` as `&quot;`, which the parser did not decode in an
 * attribute, so a Button labelled `Tom & Jerry` ran as `Tom &amp; Jerry`
 * and a placeholder with a quoted word in it showed `&quot;`. The parser
 * reads a backslash as the start of an escape, and the generator wrote one
 * as it was, so `C:\new` reached the app with a line break in it; and a
 * real line break ended the attribute where it stood.
 */

import { describe, expect, it } from 'vitest';
import { parse } from '@softn/core';
import type { CanvasElement } from '../types/builder';
import { generateSource } from './sourceGenerator';
import { parseSource } from './sourceParser';

const VALUES = [
  'Tom & Jerry',
  'e.g. "Milk"',
  "it's 5 > 3 and 2 < 4",
  'C:\\new\\table',
  'ends with a backslash\\',
  'line one\nline two',
  'tab\there',
  '&amp; meant as those five characters',
  '&quot;&#39;&lt;',
  '100% {not} an expression',
  '',
];

function elementsWith(value: string): Map<string, CanvasElement> {
  return new Map<string, CanvasElement>([
    ['root', { id: 'root', componentType: 'App', props: {}, children: ['input'], parentId: null }],
    ['input', { id: 'input', componentType: 'Input', props: { placeholder: value, label: 'x' }, children: [], parentId: 'root' }],
  ]);
}

function placeholderIn(source: string): unknown {
  const doc = parse(source);
  expect(doc.diagnostics ?? []).toEqual([]);
  const app = doc.template[0];
  if (app.type !== 'Element') throw new Error('expected <App>');
  const input = app.children.find((child) => child.type === 'Element');
  if (!input || input.type !== 'Element') throw new Error('expected <Input>');
  const prop = input.props.find((p) => p.name === 'placeholder');
  return prop?.value.value;
}

describe('a text property', () => {
  it.each(VALUES.filter((value) => value !== ''))('%j reaches the app as it was typed', (value) => {
    const source = generateSource(elementsWith(value), 'root', '');
    expect(placeholderIn(source)).toBe(value);
  });

  it.each(VALUES.filter((value) => value !== ''))('%j is the same after the file is read and written again', (value) => {
    const first = generateSource(elementsWith(value), 'root', '');
    const read = parseSource(first);
    expect(read.fidelity).toEqual({ lossless: true, reasons: [] });
    const second = generateSource(read.elements, read.rootId, '');
    expect(second).toBe(first);
    expect(placeholderIn(second)).toBe(value);
  });
});
