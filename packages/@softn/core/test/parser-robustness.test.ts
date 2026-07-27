/**
 * Parser robustness regressions.
 *
 * Every case here once hung `parse()` outright — an unguarded list loop or a
 * lexer state that never returned to EOF — at 100% CPU with no error. `parse()`
 * runs on every render and on every keystroke in the live preview, so each of
 * these took the tab with it.
 *
 * A regression therefore shows up as this file never finishing rather than as a
 * failing assertion: a synchronous infinite loop cannot be interrupted from
 * inside the process. That is still a loud failure, and the cases are worth
 * pinning down regardless.
 */

import { describe, it, expect } from 'vitest';
import { parse } from '../src/parser';

/** Messages the parser attached, as plain strings. */
function diagnostics(source: string): string[] {
  const doc = parse(source) as unknown as { diagnostics?: { message: string }[] };
  return (doc.diagnostics ?? []).map((d) => d.message);
}

describe('parser termination', () => {
  it('parses a template literal containing an interpolation', () => {
    // Template mode was only restored when the expression depth reached zero,
    // which never happens for a literal inside `{...}` — so the closing
    // backtick was lexed as an opening one and the lexer never reached EOF.
    expect(() => parse('<div>{`Hi ${name}`}</div>')).not.toThrow();
    expect(diagnostics('<div>{`Hi ${name}`}</div>')).toEqual([]);
  });

  it('parses interpolations in an attribute, repeated, and nested', () => {
    expect(diagnostics('<div title={`a${n}`}/>')).toEqual([]);
    expect(diagnostics('<div>{`${a} and ${b}`}</div>')).toEqual([]);
    expect(diagnostics('<div>{`${ {k:1}.k }`}</div>')).toEqual([]);
  });

  it('reports, rather than hangs on, an argument it cannot parse', () => {
    // `parsePrimary` falls back to a synthetic `undefined` without consuming
    // anything, so an unsupported argument used to loop forever.
    expect(diagnostics('<div>{items.map(x => x.name)}</div>').join(' ')).toMatch(/ARROW|RPAREN/);
    expect(diagnostics('<div>{fn(...args)}</div>').length).toBeGreaterThan(0);
  });

  it('reports, rather than hangs on, an unsupported arrow parameter', () => {
    // Only identifiers and commas advanced this loop, so a default, rest or
    // destructured parameter never terminated. One parameter already errored;
    // adding a second turned it into a hang.
    expect(diagnostics('<div><Button @click={(e, n = 1) => f(n)}>x</Button></div>').length)
      .toBeGreaterThan(0);
    expect(diagnostics('<div><Button @click={(a, ...rest) => f(a)}>x</Button></div>').length)
      .toBeGreaterThan(0);
  });

  it('reports, rather than hangs on, a malformed braced import', () => {
    expect(diagnostics('<import { A-B } from "./x.ui" />').length).toBeGreaterThan(0);
  });

  it('still accepts the supported forms', () => {
    expect(diagnostics('<div>{items.map((x) => x.name)}</div>')).toEqual([]);
    expect(diagnostics('<div>{fmt(a, b, c)}</div>')).toEqual([]);
    expect(diagnostics('<import { Card } from "./x.ui" />')).toEqual([]);
  });
});

describe('comparison operators in expressions', () => {
  // `>` was guarded against being read as a tag close; `<` was not, so
  // `{count < limit}` lexed as a tag open and swallowed the rest of the line.
  const firstExpression = (source: string): unknown => {
    const doc = parse(source) as unknown as {
      template: { children?: { type: string; expression?: unknown }[] }[];
    };
    return doc.template[0].children?.find((c) => c.type === 'Expression')?.expression;
  };

  it('reads `<` as a comparison, not a tag', () => {
    const expr = firstExpression('<p>{count < limit}</p>') as { type: string; operator?: string };
    expect(expr.type).toBe('BinaryExpression');
    expect(expr.operator).toBe('<');
  });

  it('reads `<=` as a comparison', () => {
    const expr = firstExpression('<p>{count <= limit}</p>') as { type: string; operator?: string };
    expect(expr.operator).toBe('<=');
  });

  it('leaves `>` working', () => {
    const expr = firstExpression('<p>{count > limit}</p>') as { type: string; operator?: string };
    expect(expr.operator).toBe('>');
  });

  it('still treats `<` as a tag outside an expression', () => {
    const doc = parse('<div><span>hi</span></div>') as unknown as {
      template: { tag: string; children?: { tag?: string }[] }[];
    };
    expect(doc.template[0].tag).toBe('div');
    expect(doc.template[0].children?.[0].tag).toBe('span');
  });
});

describe('each blocks and imports', () => {
  const findEach = (source: string): { keyExpression?: { type: string } } | undefined => {
    let found: { keyExpression?: { type: string } } | undefined;
    const walk = (n: Record<string, unknown> | undefined): void => {
      if (!n) return;
      if (n.type === 'EachBlock') found = n as { keyExpression?: { type: string } };
      for (const k of ['template', 'body', 'children']) {
        const kids = n[k];
        if (Array.isArray(kids)) kids.forEach((c) => walk(c as Record<string, unknown>));
      }
    };
    walk(parse(source) as unknown as Record<string, unknown>);
    return found;
  };

  it('parses `key=` on an each block', () => {
    // The renderer always had a branch for this and the dev warning recommended
    // writing it, but nothing parsed it — so `key=7` rendered as page text.
    const each = findEach('<div>#each (row in rows) key={row.id}<Text>{row.n}</Text>#end</div>');
    expect(each?.keyExpression?.type).toBe('MemberExpression');
  });

  it('leaves an each block without a key alone', () => {
    const each = findEach('<div>#each (row in rows)<Text>{row.n}</Text>#end</div>');
    expect(each?.keyExpression).toBeUndefined();
  });

  it('does not mistake body text beginning with "key" for a key', () => {
    const each = findEach('<div>#each (row in rows)key facts<Text>{row.n}</Text>#end</div>');
    expect(each?.keyExpression).toBeUndefined();
  });

  it('resolves an aliased named import to one name', () => {
    // `{ Card as C }` used to yield ["Card", "as", "C"] — three imports, one of
    // them literally called "as".
    const doc = parse('<import { A, Card as C, B } from "./x.ui" />') as unknown as {
      imports: { namedImports?: string[] }[];
    };
    expect(doc.imports[0].namedImports).toEqual(['A', 'C', 'B']);
  });
});
