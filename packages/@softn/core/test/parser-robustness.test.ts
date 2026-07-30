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

import { describe, it, expect, vi } from 'vitest';
import { parse, Lexer, tokenize, TokenType, createToken, SoftNParseError } from '../src/parser';
import type { Token } from '../src/parser';

/** Messages the parser attached, as plain strings. */
function diagnostics(source: string): string[] {
  const doc = parse(source) as unknown as { diagnostics?: { message: string }[] };
  return (doc.diagnostics ?? []).map((d) => d.message);
}

/**
 * Token types the lexer emits, giving up after `cap` calls.
 *
 * A lexer that never reaches EOF is the failure under test, so this has to
 * count calls itself: `tokenize()` would either throw on its own backstop or,
 * before that existed, take the process down with it.
 */
function drainTokenTypes(source: string, cap = 64): TokenType[] {
  const lexer = new Lexer(source);
  const types: TokenType[] = [];
  for (let i = 0; i < cap; i++) {
    const token = lexer.nextToken();
    types.push(token.type);
    if (token.type === TokenType.EOF) break;
  }
  return types;
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

  it('reaches EOF on a template literal that is never closed', () => {
    // At end of input `readTemplateContent` returned its last chunk but left
    // template mode set, and `nextToken` dispatches on that flag before it
    // checks for EOF — so every later call returned another empty
    // TEMPLATE_STRING and `tokenize()` grew its array until the heap was gone.
    // An out-of-memory abort is not an exception, so no caller could catch it.
    expect(drainTokenTypes('<Text>{`abc}</Text>')).toContain(TokenType.EOF);
    expect(diagnostics('<Text>{`abc}</Text>')).toEqual(['Unterminated template literal']);
  });

  it('reaches EOF on an unclosed literal cut off inside an interpolation', () => {
    expect(drainTokenTypes('<Text>{`a${b}c</Text>')).toContain(TokenType.EOF);
    expect(drainTokenTypes('<Text>{`a${b</Text>')).toContain(TokenType.EOF);
    expect(diagnostics('<Text>{`a${b}c</Text>')).toContain('Unterminated template literal');
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

describe('stuck-lexer backstop', () => {
  // The stall is simulated one level below the guard, on the private reader
  // nextToken() wraps. Mocking nextToken itself would replace the guard rather
  // than exercise it, and the test would then be the unbounded loop it exists
  // to prove impossible — it took the whole vitest worker down with an
  // out-of-memory abort, losing every other result in this file.
  const stall = () =>
    vi.spyOn(Lexer.prototype as unknown as { readNextToken(): Token }, 'readNextToken')
      .mockReturnValue(createToken(TokenType.TEMPLATE_STRING, '', 1, 3, 3, 3));

  it('throws out of tokenize instead of growing the array', () => {
    const spy = stall();
    try {
      expect(() => tokenize('<p>')).toThrow(SoftNParseError);
      expect(() => tokenize('<p>')).toThrow(/made no progress at offset 3/);
    } finally {
      spy.mockRestore();
    }
  });

  it('throws out of the parser too, which is the path a bundle takes', () => {
    // `tokenize` has no callers outside these tests; a .softn reaches the lexer
    // through the parser, so that is the loop that has to be protected.
    const spy = stall();
    try {
      expect(() => parse('<p>')).toThrow(/made no progress at offset 3/);
    } finally {
      spy.mockRestore();
    }
  });

  it('leaves the empty tokens a valid document produces alone', () => {
    // An empty script, logic or style block legitimately yields a zero-length
    // content token; only one that also fails to advance is stuck.
    expect(() => tokenize('<script></script>')).not.toThrow();
    expect(() => tokenize('<style></style>')).not.toThrow();
    expect(() => tokenize('<div>{``}</div>')).not.toThrow();
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
