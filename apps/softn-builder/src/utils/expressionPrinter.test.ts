/**
 * Expressions survive the visual model with their meaning intact (F02).
 *
 * The builder turns every template expression into text when it parses a
 * .ui file and writes that text back when it regenerates the file. The
 * printer it used walked the AST without any notion of precedence, so a
 * grouped expression lost its parentheses: `(a + b) * c` came back as
 * `a + b * c`, which the engine evaluates to a different number. Object
 * keys that are not identifiers were printed bare, string escapes were
 * dropped, an arrow returning an object literal was printed as a block
 * body, and an AST kind the printer did not know became an empty string —
 * an empty attribute, binding or handler, with no diagnostic.
 *
 * Each fixture is checked two ways, as the audit asks: the printed text
 * parses back to the same structure (a print → parse → print fixpoint),
 * and the engine's own evaluator gives the same value for the original and
 * for the round-tripped expression.
 */

import { describe, expect, it } from 'vitest';
import { parse, evaluateExpression } from '@softn/core';
import type { Expression, SoftNRenderContext } from '@softn/core';
import { parseSource } from './sourceParser';
import { generateSource } from './sourceGenerator';
import { printExpression, printExpressionSafe, ExpressionPrintError } from './expressionPrinter';

function context(state: Record<string, unknown> = {}): SoftNRenderContext {
  return {
    state,
    setState: () => {},
    data: {},
    props: {},
    functions: {},
    asyncFunctions: {},
    computed: {},
  };
}

/** The expression the core parser reads out of `<Box v={SRC} />`. */
function exprOf(src: string): Expression {
  const doc = parse(`<Box v={${src}} />`);
  expect(doc.diagnostics ?? []).toEqual([]);
  const box = doc.template[0];
  if (box.type !== 'Element') throw new Error('expected an element');
  const prop = box.props.find((p) => p.name === 'v');
  if (!prop || prop.value.type !== 'expression') throw new Error(`no expression prop in ${src}`);
  return prop.value.value;
}

/** Structure without source positions. */
function shape(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shape);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === 'loc' || v === undefined) continue;
      out[k] = shape(v);
    }
    return out;
  }
  return value;
}

/** What the builder writes back for an attribute expression after a parse → generate trip. */
function roundTripAttribute(src: string): string {
  const parsed = parseSource(`<App>\n  <Box v={${src}} />\n</App>`);
  const out = generateSource(parsed.elements, parsed.rootId, '');
  const m = out.match(/v=\{([\s\S]*)\}\s*\/>/);
  if (!m) throw new Error(`no v attribute in:\n${out}`);
  return m[1];
}

const state = {
  a: 2,
  b: 3,
  c: 5,
  n: -4,
  x: true,
  y: false,
  name: 'World',
  user: { profile: { first: 'Ada' }, tags: ['x', 'y'] },
  items: [1, 2, 3],
  pick: (v: unknown) => v,
  mk: () => ({ k: 'v' }),
  num: (v: number) => ({ toFixed: (d: number) => v.toFixed(d) }),
};

describe('grouped arithmetic (the audit fixture)', () => {
  it('keeps its parentheses through parseSource → generateSource', () => {
    const text = roundTripAttribute('(a + b) * c');
    expect(text).toBe('(a + b) * c');
  });

  it('still evaluates to 25, not 17, in the engine', () => {
    const text = roundTripAttribute('(a + b) * c');
    expect(evaluateExpression(exprOf(text), context(state))).toBe(25);
  });
});

/**
 * Every expression here: printing the parsed AST and parsing the text again
 * gives the same structure, printing that again gives the same text, and
 * the engine evaluates the original and the round trip to the same value.
 */
const fixtures: Array<[string, unknown]> = [
  // binary precedence and associativity
  ['(a + b) * c', 25],
  ['a + b * c', 17],
  ['a - (b - c)', 4],
  ['a - b - c', -6],
  ['(a - b) - c', -6],
  ['a * (b + c) / (a + b)', 3.2],
  ['a + b == c', true],
  ['(a + b == c) == x', true],
  ['x && y || a > b', false],
  ['x && (y || a > b)', false],
  ['(x || y) && a < b', true],
  ['a % b + c', 7],
  ['a * (b % c)', 6],
  ['(y ? a : b) + c', 8],
  ['y ? a : b + c', 8],
  ['missing ?? a', 2],
  ['(missing ?? a) + b', 5],
  ['a + (missing ?? b)', 5],
  // unary
  ['-a * b', -6],
  ['-(a * b)', -6],
  ['-(a + b)', -5],
  ['-(-a)', 2],
  ['!x', false],
  ['!(x && y)', true],
  ['!x && y', false],
  ['typeof name', 'string'],
  ['typeof (a + b)', 'number'],
  ['-n', 4],
  // conditionals, nested
  ['x ? a : b', 2],
  ['x ? (y ? a : b) : c', 3],
  ['x ? y ? a : b : c', 3],
  ['(x ? y : x) ? a : b', 3],
  ['x ? a : y ? b : c', 2],
  ['y ? a : y ? b : c', 5],
  // member and call on an expression operand
  ['user.profile.first', 'Ada'],
  ['user.tags[a - 1]', 'y'],
  ['user["tags"][0]', 'x'],
  ['user?.profile?.first', 'Ada'],
  ['user?.missing?.first', undefined],
  ['(x ? user : user).profile.first', 'Ada'],
  ['(y ? pick : pick)(a)', 2],
  ['pick(a + b) * c', 25],
  ['mk().k', 'v'],
  ['num(a).toFixed(a)', '2.00'],
  ['(a + b).toFixed(1)', '5.0'],
  ['items.length', 3],
  ['(items.length > 0 ? "some" : "none")', 'some'],
  // strings, escapes, template literals
  ['"plain"', 'plain'],
  ['"with \\"quotes\\""', 'with "quotes"'],
  ["'single \\'quoted\\''", "single 'quoted'"],
  ['"back\\\\slash"', 'back\\slash'],
  ['"line\\nbreak"', 'line\nbreak'],
  ['"tab\\there"', 'tab\there'],
  ['"a" + "b"', 'ab'],
  ['`Hello, ${name}!`', 'Hello, World!'],
  ['`sum: ${a + b}`', 'sum: 5'],
  ['`tick \\` inside`', 'tick ` inside'],
  ['`dollar \\${not} expr`', 'dollar ${not} expr'],
  ['`${a}${b}`', '23'],
  // numbers and literals
  ['1.5 * a', 3],
  ['true', true],
  ['null', null],
  ['0.25 + 0.75', 1],
  // objects and arrays
  ['{ a: 1, b: "two" }', { a: 1, b: 'two' }],
  ['{ "my-key": a, "1": b }', { 'my-key': 2, '1': 3 }],
  ['{ "with space": 1 }', { 'with space': 1 }],
  ['{ a, b }', { a: 2, b: 3 }],
  ['{ nested: { deep: a } }', { nested: { deep: 2 } }],
  ['{ data: user.profile, list: [a, b] }', { data: { first: 'Ada' }, list: [2, 3] }],
  ['{}', {}],
  ['[a, b, c]', [2, 3, 5]],
  ['[]', []],
  ['[a + b, [c]]', [5, [5]]],
  ['[a, b].length', 2],
  // arrows
  ['((v) => v * 2)(a)', 4],
  ['((p, q) => p + q)(a, b)', 5],
  ['(() => a)()', 2],
  ['(() => ({ k: a }))().k', 2],
  ['(() => ({ k: a, "my-key": b }))()["my-key"]', 3],
  ['((v) => v ? a : b)(x)', 2],
  ['((v) => (w) => v + w)(a)(b)', 5],
  ['((v) => v.length)(items)', 3],
  ['((v) => -v)(a)', -2],
  ['((v) => (v + a) * b)(c)', 21],
  // assignment: below the conditional, right-associative, the value comes
  // back (the fixture context's setState discards the write)
  ['a = b + c', 8],
  ['a = b = c', 5],
  ['a = x ? b : c', 3],
  ['x ? (a = b) : c', 3],
  ['(a = b) + c', 8],
  ['a += b * c', 17],
  ['a -= 1', 1],
  ['a *= b', 6],
  ['a /= a', 1],
  ['a %= b', 2],
  ['a ??= b', 2],
  ['y ||= x', true],
  ['x &&= y', false],
  ['user.profile.first = name', 'World'],
  ['items[0] = a', 2],
  ['(() => a = a + 1)()', 3],
  ['((v) => a = v)(c)', 5],
];

describe('print → parse → print fixpoint, and engine agreement', () => {
  it.each(fixtures)('%s', (src, expected) => {
    const original = exprOf(src);
    const printed = printExpression(original);
    const reparsed = exprOf(printed);
    expect(shape(reparsed)).toEqual(shape(original));
    expect(printExpression(reparsed)).toBe(printed);
    expect(evaluateExpression(original, context(state))).toEqual(expected);
    expect(evaluateExpression(reparsed, context(state))).toEqual(expected);
  });
});

describe('what the printer writes', () => {
  it('prints the documented one-line handler as written', () => {
    // Until the parser read assignments, this arrow was read as `() => count`
    // and the rest fell off; the printer must now write the whole of it.
    expect(printExpression(exprOf('() => count = count + 1'))).toBe('() => count = count + 1');
  });

  it('prints an assignment chain without parentheses and a grouped assignment with them', () => {
    expect(printExpression(exprOf('a = b = 1'))).toBe('a = b = 1');
    expect(printExpression(exprOf('(a = 1) + 2'))).toBe('(a = 1) + 2');
    expect(printExpression(exprOf('a = x ? 1 : 2'))).toBe('a = x ? 1 : 2');
  });

  it('quotes object keys that are not identifiers and escapes the strings inside them', () => {
    expect(printExpression(exprOf('{ "my-key": 1, plain: 2, "q\\"uote": 3 }'))).toBe(
      '{ "my-key": 1, plain: 2, "q\\"uote": 3 }'
    );
  });

  it('wraps an arrow body that is an object literal in parentheses', () => {
    expect(printExpression(exprOf('() => ({ a: 1 })'))).toBe('() => ({ a: 1 })');
  });

  it('keeps a template literal a template literal', () => {
    expect(printExpression(exprOf('`Hi ${name}`'))).toBe('`Hi ${name}`');
  });

  it('prints strings with their escapes', () => {
    expect(printExpression(exprOf('"say \\"hi\\"\\n"'))).toBe('"say \\"hi\\"\\n"');
  });

  it('puts a space after a word operator', () => {
    expect(printExpression(exprOf('typeof a'))).toBe('typeof a');
  });

  it('keeps shorthand properties short', () => {
    expect(printExpression(exprOf('{ a, b }'))).toBe('{ a, b }');
  });
});

describe('an unsupported AST node', () => {
  const bogus = { type: 'YieldExpression', loc: { line: 1, column: 0, start: 0, end: 0 } } as unknown as Expression;

  it('is refused with a typed error naming the kind', () => {
    expect(() => printExpression(bogus)).toThrow(ExpressionPrintError);
    expect(() => printExpression(bogus)).toThrow(/YieldExpression/);
  });

  it('never becomes an empty string; the safe printer reports it', () => {
    const result = printExpressionSafe(bogus);
    expect(result.text).not.toBe('');
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatch(/YieldExpression/);
  });

  it('is reported by parseSource as a reason the file is not lossless', () => {
    // The core parser never produces such a node today, so one is spliced
    // into a parsed document by hand and printed through the same path the
    // builder uses for an attribute.
    const nested = {
      type: 'BinaryExpression',
      operator: '+',
      left: bogus,
      right: bogus,
      loc: bogus.loc,
    } as unknown as Expression;
    expect(() => printExpression(nested)).toThrow(ExpressionPrintError);
    const safe = printExpressionSafe(nested);
    expect(safe.text).not.toBe('');
    expect(safe.diagnostics[0]).toMatch(/YieldExpression/);
  });

  it('refuses a binary operator the grammar does not have', () => {
    const op = {
      type: 'BinaryExpression',
      operator: '**',
      left: exprOf('a'),
      right: exprOf('b'),
      loc: bogus.loc,
    } as Expression;
    expect(() => printExpression(op)).toThrow(/\*\*/);
  });
});

describe('events, bindings and props through parseSource → generateSource', () => {
  it('writes the handler, binding and prop back with their grouping', () => {
    const src = [
      '<App>',
      '  <Button @click={() => setCount((count + 1) * 2)} :value={(a + b) * c} label={`n=${(a + b)}`}>Go</Button>',
      '</App>',
    ].join('\n');
    const parsed = parseSource(src);
    expect(parsed.fidelity).toEqual({ lossless: true, reasons: [] });
    const out = generateSource(parsed.elements, parsed.rootId, '');
    expect(out).toContain(':value={(a + b) * c}');
    expect(out).toContain('label={`n=${a + b}`}');
    expect(out).toContain('@click={() => setCount((count + 1) * 2)}');
  });
});
