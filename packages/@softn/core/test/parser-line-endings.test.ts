import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from '../src/parser/parser';
import type { SoftNDocument } from '../src/parser/ast';

/**
 * The tree and the diagnostics' words, without places. A `<logic>` or
 * `<style>` block is handed on as written, line endings and all, to the
 * engine that runs it, which reads either; so is the text of a handler's
 * body, which is only quoted in a message.
 */
const shape = (doc: SoftNDocument) =>
  JSON.stringify(
    { template: doc.template, logic: doc.logic, style: doc.style, said: (doc.diagnostics ?? []).map((d) => `${d.severity}: ${d.message}`) },
    function (this: { type?: string }, key, value) {
      if (key === 'loc') return undefined;
      const block =
        this.type === 'LogicBlock' || this.type === 'StyleBlock' || this.type === 'ScriptBlock' || (this.type === 'ArrowFunctionExpression' && key === 'body');
      return block && typeof value === 'string' ? value.replace(/\r\n/g, '\n') : value;
    }
  );

const elementAt = (doc: SoftNDocument, index = 0) => {
  const node = doc.template[index];
  if (node?.type !== 'Element') throw new Error(`expected an element, got ${node?.type}`);
  return node;
};

describe('a page saved with Windows line endings', () => {
  it('reads its text, a <pre> and a <textarea> with LF line breaks', () => {
    const doc = parse('<p>one\r\ntwo</p>\r\n<pre>\r\na\r\nb</pre>\r\n<textarea>\r\nx\ry\r\n</textarea>');
    expect(JSON.stringify(doc.template)).not.toContain('\\r');
    expect(elementAt(doc, 1).children).toMatchObject([{ type: 'Text', content: 'a\nb' }]);
    expect(elementAt(doc, 2).children).toMatchObject([{ type: 'Text', content: 'x\ny\n' }]);
  });

  it('reads an attribute value over lines as one value', () => {
    // A value cut at its first line break read the rest as attributes, and the
    // element lost its children.
    for (const source of ['<p title="a\nb">x</p>', '<p title="a\r\nb">x</p>', "<Text title='a\r\nb'>x</Text>"]) {
      const doc = parse(source);
      expect(doc.diagnostics ?? []).toEqual([]);
      expect(elementAt(doc)).toMatchObject({ props: [{ name: 'title', value: { type: 'static', value: 'a\nb' } }], children: [{ type: 'Text', content: 'x' }] });
    }
    const path = parse('<svg><path d="M0 0\r\n  L10 10\r\n  Z" fill="red"/></svg>');
    expect(path.diagnostics ?? []).toEqual([]);
    expect(elementAt(path).children[0]).toMatchObject({ props: [{ name: 'd', value: { value: 'M0 0\n  L10 10\n  Z' } }, { name: 'fill' }] });
  });

  it('still ends a string in code at a line break', () => {
    const doc = parse('<p>{"a\nb"}</p>');
    expect(doc.diagnostics?.length).toBeGreaterThan(0);
  });

  it('reads a template literal over lines as JavaScript does, with LF', () => {
    const doc = parse('<p>{`a\r\nb${1}\rc`}</p>');
    expect(doc.diagnostics ?? []).toEqual([]);
    const literal = elementAt(doc).children[0];
    expect(literal).toMatchObject({ type: 'Expression', expression: { type: 'TemplateLiteral' } });
    if (literal.type !== 'Expression' || literal.expression.type !== 'TemplateLiteral') return;
    expect(literal.expression.quasis.map((q) => q.value.cooked)).toEqual(['a\nb', '\nc']);
  });

  it('parses each page as it does with LF', () => {
    for (const source of corpus()) expect(shape(parse(source.replace(/\n/g, '\r\n')))).toBe(shape(parse(source)));
  });
});

describe('escapes in strings and template literals', () => {
  const valueOf = (expression: string) => {
    const doc = parse(`<p>{${expression}}</p>`);
    expect(doc.diagnostics ?? []).toEqual([]);
    const node = elementAt(doc).children[0];
    if (node.type !== 'Expression') throw new Error('expected an expression');
    const e = node.expression;
    if (e.type === 'TemplateLiteral') return e.quasis.map((q) => q.value.cooked).join('');
    if (e.type === 'Literal') return e.value;
    throw new Error(`expected a literal, got ${e.type}`);
  };

  it.each([
    ['`\\x41\\u0042\\u{43}`', 'ABC'],
    ['"\\x41\\u0042\\u{1F600}"', 'AB\u{1F600}'],
    ['`\\b\\f\\v\\0`', '\b\f\v\0'],
    ['`a\\`b\\${c}`', 'a`b${c}'],
    ['"a\\\nb"', 'ab'],
    ['"a\\\r\nb"', 'ab'],
    ["'a\\\rb'", 'ab'],
    ['`a\\\r\nb`', 'ab'],
    ['"\\q\\x4"', 'qx4'],
  ])('%s is %j, as JavaScript reads it', (expression, expected) => {
    expect(valueOf(expression)).toBe(expected);
  });
});

describe('a byte-order mark', () => {
  it('is no part of the page, and every place is still the file\'s', () => {
    for (const source of corpus()) expect(shape(parse(`\uFEFF${source}`))).toBe(shape(parse(source)));
    const doc = parse('\uFEFF#if (a)\n<p>x</p>\n#end');
    expect(doc.template[0]).toMatchObject({ type: 'IfBlock' });
    expect(parse('\uFEFF<!doctype html><p>x</p>').template.some((n) => n.type === 'Element' && n.tag === 'p')).toBe(true);
  });

  it('is not counted as a column', () => {
    const [first] = parse('\uFEFF<Stack></Text>').diagnostics ?? [];
    const [plain] = parse('<Stack></Text>').diagnostics ?? [];
    expect(first.loc).toMatchObject({ line: 1, column: plain.loc!.column, start: plain.loc!.start + 1 });
    const [second] = parse('\uFEFF\n<Stack></Text>').diagnostics ?? [];
    expect(second.loc).toMatchObject({ line: 2, column: plain.loc!.column });
  });
});

describe('a diagnostic\'s place', () => {
  it('agrees with its offset, on every page', () => {
    for (const source of corpus()) {
      for (const d of parse(source).diagnostics ?? []) {
        const loc = d.loc!;
        expect(loc.start).toBeGreaterThanOrEqual(0);
        expect(loc.start).toBeLessThanOrEqual(source.length);
        const before = source.slice(0, loc.start);
        const line = before.split('\n').length;
        expect({ line: loc.line, column: loc.column }).toEqual({ line, column: loc.start - (before.lastIndexOf('\n') + 1) + 1 });
      }
    }
  });
});

/**
 * The repository's examples and a few hundred pages made at random of pieces
 * that read the start of a line, raw text and code (seeded, so a failure
 * repeats), each with LF line breaks.
 */
function corpus(): string[] {
  if (pages) return pages;
  const roots = ['../../../../docs/examples', '../../../../examples'].map((p) => new URL(p, import.meta.url));
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== 'node_modules') walk(full);
      else if (/\.(ui|html)$/.test(entry.name)) found.push(readFileSync(full, 'utf8').replace(/\r\n?/g, '\n'));
    }
  };
  for (const root of roots) walk(root.pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  const pieces = [
    '<p>', '</p>', '<div class="a">', '</div>', '<b>', '</b>', '<a href=x>', '</a>', '<ul>', '<li>', '</ul>', '<table>', '<tr>', '<td>',
    '<textarea>', '</textarea>', '<pre>', '</pre>', '<svg>', '</svg>', '<!-- c -->', '<br>', '<input value="v">', '<p title="a\nb">',
    '<Text>', '</Text>', '<Button @click={() => {\n n++\n}}>', '</Button>', '<Stack>', '</Stack>', '{n}', '{`a\n${n}\nb`}', '{a ? b : c}',
    '\n#if (a)\n', '\n#else\n', '\n#end\n', '\n#each (item in items)\n', 'text', ' ', '\n', '\n  ', '&amp;', 'a\tb',
    '<style>\n.a { color: red }\n</style>', '<logic>\nlet n = 1\n</logic>',
  ];
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < 300; i++) {
    found.push(Array.from({ length: 2 + Math.floor(random() * 16) }, () => pieces[Math.floor(random() * pieces.length)]).join(''));
  }
  pages = found;
  return found;
}
let pages: string[] | undefined;
