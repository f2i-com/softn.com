/**
 * What the canvas holds is what the file it writes reads back as.
 *
 * Two things the model holds were written so that the file read back as
 * something else.
 *
 * A property written `open=false` is read as the boolean false, and the
 * generator wrote a false boolean as nothing at all: the property was gone
 * from the file, so the check that the canvas can write a page back found it
 * missing, and every page that had one could only be edited as source.
 *
 * Words are one string in the model with their expressions inline, `Total:
 * {total}`, and were written as they stood. A brace typed into the words that
 * opens no expression the parser can read to its end — `Press { to open`, or
 * a half-finished `{a b}` — was written as the start of an expression: the
 * parser read on through the closing tag, and the file came back with the
 * page after it swallowed into one broken expression.
 */

import { describe, expect, it } from 'vitest';
import { parse } from '@softn/core/authoring';
import type { CanvasElement } from '../types/builder';
import { generateSource } from './sourceGenerator';
import { parseSource } from './sourceParser';
import { writeBack } from './sourceFrame';

function errorsOf(source: string): string[] {
  return (parse(source).diagnostics ?? []).filter((d) => d.severity === 'error').map((d) => d.message);
}

/** A page of a Text with `words`, and a Button after it. */
function pageWith(words: string): Map<string, CanvasElement> {
  return new Map<string, CanvasElement>([
    ['root', { id: 'root', componentType: 'App', props: {}, children: ['text', 'after'], parentId: null }],
    ['text', { id: 'text', componentType: 'Text', props: { children: words }, children: [], parentId: 'root' }],
    ['after', { id: 'after', componentType: 'Button', props: { children: 'Next' }, children: [], parentId: 'root' }],
  ]);
}

function wordsRead(source: string): { words: unknown; types: string[] } {
  const parsed = parseSource(source);
  const elements = [...parsed.elements.values()];
  return {
    words: elements.find((element) => element.componentType === 'Text')?.props.children,
    types: elements.map((element) => element.componentType).sort(),
  };
}

describe('a property written `=false`', () => {
  const page = '<App>\n  <Modal open=false title="Settings" />\n</App>\n';

  it('leaves the page one the canvas can write back', () => {
    expect(parseSource(page).fidelity).toMatchObject({ lossless: true });
  });

  it('is in the file after an edit beside it', () => {
    const parsed = parseSource(page);
    const modal = [...parsed.elements.values()].find((element) => element.componentType === 'Modal')!;
    const edited = new Map(parsed.elements).set(modal.id, { ...modal, props: { ...modal.props, title: 'Options' } });
    const written = writeBack(page, parse(page), edited, parsed.rootId);
    expect(written).toBe('<App>\n  <Modal open=false title="Options" />\n</App>\n');
    expect(errorsOf(written)).toEqual([]);
  });
});

describe('words with a brace typed into them', () => {
  it.each(['Press { to open', 'a {b} and {', 'x {a b} y', '{', '{ and so } and {', 'C: {', 'a {b {c} d'])('%j are read back as they were typed, with the page after them', (words) => {
    const source = generateSource(pageWith(words), 'root', '');
    expect(errorsOf(source)).toEqual([]);
    const read = wordsRead(source);
    expect(read.words).toBe(words);
    expect(read.types).toEqual(['App', 'Button', 'Text']);
    // And written again, they are the same file.
    const again = parseSource(source);
    expect(again.fidelity).toMatchObject({ lossless: true });
    expect(generateSource(again.elements, again.rootId, '')).toBe(source);
  });

  it.each([
    ['Total: {total}', '<Text>Total: {total}</Text>'],
    ['{items.length > 0 ? "some" : "none"}', '<Text>{items.length > 0 ? "some" : "none"}</Text>'],
    // A brace inside a string of an expression is the string's.
    ['{"{" + name + "}"}', '<Text>{"{" + name + "}"}</Text>'],
    ['{open ? "{" : ""}', '<Text>{open ? "{" : ""}</Text>'],
    ['a } b', '<Text>a } b</Text>'],
  ])('%j, whose braces are expressions or stand alone, are written as they were', (words, line) => {
    const source = generateSource(pageWith(words), 'root', '');
    expect(source.split('\n')[1].trim()).toBe(line);
    expect(errorsOf(source)).toEqual([]);
    expect(wordsRead(source).words).toBe(words);
  });

  it.each(['#end', 'a #else b', '#empty list', 'see #if (x) docs', 'tag #each', '#elseif (y) z', 'The #END.', 'C# and F#', '#endpoint #elsewhere'])(
    '%j, with a word that opens a block after a #, are read back as they were typed',
    (words) => {
      const source = generateSource(pageWith(words), 'root', '');
      expect(errorsOf(source)).toEqual([]);
      const read = wordsRead(source);
      expect(read.words).toBe(words);
      expect(read.types).toEqual(['App', 'Button', 'Text']);
      const again = parseSource(source);
      expect(again.fidelity).toMatchObject({ lossless: true });
      expect(generateSource(again.elements, again.rootId, '')).toBe(source);
    }
  );

  it('keeps an expression that reads beside a brace that does not', () => {
    const source = generateSource(pageWith('Hi {name}, press {'), 'root', '');
    expect(errorsOf(source)).toEqual([]);
    const doc = parse(source);
    const app = doc.template.find((node) => node.type === 'Element')!;
    const text = app.type === 'Element' ? app.children.find((node) => node.type === 'Element') : undefined;
    // The name is still shown from the logic; the lone brace is a brace.
    expect(text && text.type === 'Element' ? text.children.map((node) => node.type) : []).toContain('Expression');
    expect(wordsRead(source).words).toBe('Hi {name}, press {');
  });
});
