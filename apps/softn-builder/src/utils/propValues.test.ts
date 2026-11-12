/**
 * A list or a record laid out with an entry to a line is the expression it
 * was (utils/propValues.ts, overLines).
 *
 * The property panel offers the layout as a button under a field. It is
 * offered only where it can be shown to change nothing but the space
 * between entries: every case here is held to `sameExpression`, which reads
 * both texts as the language does and compares what they are, and to the
 * characters themselves, which are the same once the space is taken out.
 */
import { describe, expect, it } from 'vitest';
import { isExpressionText, overLines, sameExpression, writtenValue } from './propValues';

const squeezed = (text: string) => text.replace(/\s+/g, '');

/** The layout of `text`, held to being the same expression in the same characters. */
function laid(text: string): string {
  const result = overLines(text);
  if (result === null) throw new Error(`no layout offered for ${text}`);
  expect(isExpressionText(result), result).toBe(true);
  expect(sameExpression(text, result), result).toBe(true);
  expect(squeezed(result)).toBe(squeezed(text));
  // Laid out once, it is as it will be: nothing more is offered.
  expect(overLines(result)).toBeNull();
  return result;
}

describe('one entry to a line', () => {
  it('lays out a list of records, each as it was written', () => {
    expect(laid('[{ title: "Write the brief", status: "Done" }, { title: "Send the invoice", status: "Overdue" }]')).toBe(
      '[\n  { title: "Write the brief", status: "Done" },\n  { title: "Send the invoice", status: "Overdue" }\n]'
    );
  });

  it('lays out a record, a key to a line', () => {
    expect(laid('{ wide: isWide, quiet: !loud, [kind]: true, ...rest }')).toBe('{\n  wide: isWide,\n  quiet: !loud,\n  [kind]: true,\n  ...rest\n}');
  });

  it('leaves the commas and brackets inside an entry where they are', () => {
    expect(laid('[sum(a, b), [1, 2, 3], { x: 1, y: [2, 3] }, "a, b", \'c, [d\', `e, ${f(g, h)}`]')).toBe(
      '[\n  sum(a, b),\n  [1, 2, 3],\n  { x: 1, y: [2, 3] },\n  "a, b",\n  \'c, [d\',\n  `e, ${f(g, h)}`\n]'
    );
  });

  it('keeps a quote that is written inside a string', () => {
    expect(laid('["say \\"a, b\\"", \'it\\\'s, so\', "]"]')).toBe('[\n  "say \\"a, b\\"",\n  \'it\\\'s, so\',\n  "]"\n]');
  });

  it('keeps an entry a person has already put on lines of their own', () => {
    expect(laid('[{\n    title: "A",\n    status: "Done"\n  }, { title: "B" }]')).toBe('[\n  {\n    title: "A",\n    status: "Done"\n  },\n  { title: "B" }\n]');
  });

  it('takes the space from around the whole, and from between entries, and nothing else', () => {
    expect(laid('  [ 1 ,2,   3 ]  ')).toBe('[\n  1,\n  2,\n  3\n]');
  });
});

describe('what is not laid out', () => {
  it.each([
    ['a name', 'tasks'],
    ['a call', 'tasks.filter((task) => task.open, extra)'],
    ['an empty list', '[]'],
    ['a list of one', '[{ title: "A", status: "Done" }]'],
    ['two lists added', '[1, 2] + [3, 4]'],
    ['a list with a member read from it', '[1, 2][0]'],
    ['a list with a gap in it', '[1, , 2]'],
    ['text that is not an expression', '[1, 2'],
    ['a list already laid out', '[\n  1,\n  2\n]'],
    ['nothing', ''],
  ])('%s', (_what, text) => {
    expect(overLines(text)).toBeNull();
  });

  // The brackets and quotes are counted by hand, which is not the whole of
  // the language. Where that count is wrong the result would not read as the
  // same expression, and nothing is offered.
  it('a template inside a template, where the entries are not what the count says', () => {
    const text = '[`a ${ok ? `x, y` : "z"}`, b]';
    expect(isExpressionText(text)).toBe(true);
    const result = overLines(text);
    if (result !== null) expect(sameExpression(text, result)).toBe(true);
  });
});

describe('the same expression', () => {
  it('is the same parts in the same order, however they are spaced', () => {
    expect(sameExpression('[1,2]', '[ 1,\n 2 ]')).toBe(true);
    expect(sameExpression('{a:1}', '{ a: 1 }')).toBe(true);
    expect(sameExpression('a+b', 'a + b')).toBe(true);
  });

  it('is not when a string, a name, a number or the order differs', () => {
    expect(sameExpression('["a b"]', '["a  b"]')).toBe(false);
    expect(sameExpression('["a b"]', '["a\nb"]')).toBe(false);
    expect(sameExpression('[`a b`]', '[`a\n  b`]')).toBe(false);
    expect(sameExpression('[a, b]', '[b, a]')).toBe(false);
    expect(sameExpression('[a, b]', '[a, c]')).toBe(false);
    expect(sameExpression('[1, 2]', '[1, 3]')).toBe(false);
    expect(sameExpression('{ a }', 'a')).toBe(false);
    expect(sameExpression('[1, 2', '[1, 2')).toBe(false);
  });
});

describe('a layout through a field', () => {
  // What the panel checks before it offers the button: the field would
  // write the layout as it stands. A record of one short name is read as
  // the braces a person puts around a name, so no layout of it is written.
  it('is written as it is laid out', () => {
    const prop = { name: 'data', type: 'expression' as const };
    const text = '[{ title: "Write the brief" }, { title: "Send the invoice" }]';
    const result = laid(text);
    expect(writtenValue(prop, { value: text, isExpression: true }, result)).toEqual({ value: result, isExpression: true });
  });
});
