/**
 * A page the parser warns about is still a page the canvas can edit.
 *
 * The parser's diagnostics were all errors until it learned to join the
 * `<data>` blocks of one page: a second block that gives a name already
 * taken to another collection is left out and said, as a warning. Nothing
 * in the Builder was written with a warning in mind. What is held here:
 *
 *  - such a page is not "source-only", wherever its second block stands:
 *    before the template, or after it, where the block was inside the
 *    stretch the canvas writes and went when the page was first edited;
 *  - a visual edit keeps both blocks byte for byte;
 *  - the warning goes with the verdict, in words and with its line, for the
 *    canvas and the Code view to show.
 */

import { describe, expect, it } from 'vitest';
import { parse } from '@softn/core';
import { parseSource, assessSourceFidelity } from './sourceParser';
import { writeBack } from './sourceFrame';

const FIRST = '<data>\n  <collection name="tasks" as="items" />\n</data>\n';
const SECOND = '<data>\n  <collection name="people" as="items" />\n  <collection name="notes" as="notes" />\n</data>\n';
const TEMPLATE = '<App>\n  <Text>Hello</Text>\n</App>\n';
const WARNING = '<collection name="people" as="items"> is not declared, because this page already reads "tasks" as items.';

/** The page written back from the canvas with one word changed. */
function edited(source: string): string {
  const parsed = parseSource(source);
  const text = [...parsed.elements.values()].find((element) => element.props.children === 'Hello')!;
  text.props.children = 'Goodbye';
  return writeBack(source, parse(source), parsed.elements, parsed.rootId);
}

describe('a page with two <data> blocks that give one name to two collections', () => {
  it('is warned about by the parser, and that is all', () => {
    const diagnostics = parse(`${FIRST}${SECOND}${TEMPLATE}`).diagnostics ?? [];
    expect(diagnostics.map((d) => d.severity)).toEqual(['warning']);
  });

  it('is edited in Design when both blocks stand before the template, and says the warning with its line', () => {
    const source = `${FIRST}${SECOND}${TEMPLATE}`;
    expect(assessSourceFidelity(source)).toEqual({ lossless: true, reasons: [], warnings: [`Line 5: ${WARNING}`] });
    expect(edited(source)).toBe(`${FIRST}${SECOND}${TEMPLATE.replace('Hello', 'Goodbye')}`);
  });

  it('is edited in Design when the second block stands after the template', () => {
    // Only the first block's place is in the parsed page, so the second was
    // taken for part of the template and written over.
    const source = `${FIRST}${TEMPLATE}\n${SECOND}`;
    expect(assessSourceFidelity(source)).toEqual({ lossless: true, reasons: [], warnings: [`Line 9: ${WARNING}`] });
    expect(edited(source)).toBe(`${FIRST}${TEMPLATE.replace('Hello', 'Goodbye')}\n${SECOND}`);
  });

  it('is edited in Design when both blocks stand after the template', () => {
    const source = `${TEMPLATE}\n${FIRST}${SECOND}`;
    expect(assessSourceFidelity(source)).toEqual({ lossless: true, reasons: [], warnings: [`Line 9: ${WARNING}`] });
    expect(edited(source)).toBe(`${TEMPLATE.replace('Hello', 'Goodbye')}\n${FIRST}${SECOND}`);
  });

  it('has no warning where the parser has none', () => {
    expect(assessSourceFidelity(`${FIRST}${TEMPLATE}`)).toEqual({ lossless: true, reasons: [] });
    expect('warnings' in assessSourceFidelity(`${FIRST}${TEMPLATE}`)).toBe(false);
  });

  it('is still source-only for a block that stands between two parts of the template', () => {
    // The model writes the template as one piece: this one it cannot hold.
    const source = `<Text>One</Text>\n${SECOND}<Text>Two</Text>\n`;
    expect(assessSourceFidelity(source).lossless).toBe(false);
    expect(assessSourceFidelity(source).reasons.join(' ')).toContain('a <data> block stands between parts of the template');
  });
});

describe('a page with two <style> blocks', () => {
  it('is edited in Design when the second stands after the template, and keeps both', () => {
    const one = '<style>\n.a { color: red; }\n</style>\n';
    const two = '<style>\n.b { color: blue; }\n</style>\n';
    const source = `${one}${TEMPLATE}\n${two}`;
    expect(assessSourceFidelity(source)).toEqual({ lossless: true, reasons: [] });
    expect(edited(source)).toBe(`${one}${TEMPLATE.replace('Hello', 'Goodbye')}\n${two}`);
  });
});
