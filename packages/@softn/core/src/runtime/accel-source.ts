/**
 * The closed language an `accel` function is written in, and the only text of
 * it that ever reaches `new Function`.
 *
 * The first validator was a token filter: it restricted which identifiers
 * could appear and refused `.`, but it let `[` `]` `{` `}` `!` and `+` through
 * in any arrangement, and those alone are enough to spell any string (the
 * "JSFuck" encoding: `[]`, `![]`, `+[]` and concatenation). A string used as a
 * computed key reaches `constructor` on anything, and from there `Function`
 * and the worker's globals — `fetch`, IndexedDB, `postMessage` — with no `net`
 * grant. Tightening the filter would have been another list of shapes to
 * forget, so the source is now parsed against a grammar and the function that
 * runs is re-emitted from the parse:
 *
 * - The grammar has statements (`let`/`const`/`var`, `if`, `for(;;)`,
 *   `while`, `do`, `break`/`continue` with labels, `return`, blocks, labels),
 *   and expressions over numbers only: numeric literals, `true`, `false`,
 *   `null`, `undefined`, arithmetic, bitwise, comparison, logical and
 *   conditional operators, assignment, calls, anonymous function expressions,
 *   and `Math.<pure>(…)`. There are no string, template or regular-expression
 *   literals, no array or object literals, no `this`, `arguments`, `new`,
 *   `typeof`, `delete`, `in`, `instanceof`, no comma operator outside a
 *   `for(;;)` header, and no `.` other than `Math.<pure>(`.
 * - Every identifier is resolved against the real lexical scopes — parameters,
 *   `var`s hoisted to their function, `let`/`const` to their block. A flat
 *   list of every name declared anywhere would let `fetch`, declared as a
 *   local in one function, name the global in another.
 * - A computed access `A[i]` needs a parameter as `A` — the typed arrays, the
 *   function table and the callbacks the host binds — and its key is emitted
 *   as `A[+(i)]`. Without literals no string should be reachable, but `+` on a
 *   function yields its source text, so the key is forced to a number rather
 *   than trusting that argument: a numeric key reads an element or nothing,
 *   never a named property such as `constructor` or `__proto__`.
 * - What runs is the emitted text, fully parenthesised and with explicit
 *   semicolons, not the author's. Automatic semicolon insertion, comment forms
 *   and any other corner where this parser and the engine's could disagree
 *   stop mattering: the engine only ever sees text this module wrote from
 *   nodes it accepted.
 */

export class AccelValidationError extends Error {}

/** Words usable as keywords of the grammar, never as names. */
const KEYWORDS = new Set([
  'let',
  'var',
  'const',
  'if',
  'else',
  'for',
  'while',
  'do',
  'break',
  'continue',
  'return',
  'function',
  'true',
  'false',
  'undefined',
  'null',
]);

/**
 * Words that may appear nowhere: neither as a name in an expression nor as a
 * name a `let` or a parameter list would otherwise admit.
 */
const RESERVED = new Set([
  'this',
  'new',
  'typeof',
  'instanceof',
  'in',
  'of',
  'delete',
  'void',
  'class',
  'extends',
  'super',
  'import',
  'export',
  'with',
  'yield',
  'await',
  'async',
  'try',
  'catch',
  'finally',
  'throw',
  'switch',
  'case',
  'default',
  'debugger',
  'enum',
  'arguments',
  'eval',
  'Math',
  'globalThis',
  'self',
  'window',
  'constructor',
  'prototype',
  '__proto__',
  'Function',
]);

/** The `Math` functions a body may call: pure, and numbers in and out. */
const MATH_PURE = new Set(['imul', 'floor', 'ceil', 'trunc', 'round', 'abs', 'min', 'max', 'clz32', 'sqrt', 'fround']);

/** Punctuators, longest first so the scan takes the longest match. */
const PUNCTUATORS = [
  '>>>=',
  '...',
  '===',
  '!==',
  '**=',
  '<<=',
  '>>=',
  '>>>',
  '&&=',
  '||=',
  '??=',
  '=>',
  '==',
  '!=',
  '<=',
  '>=',
  '&&',
  '||',
  '??',
  '?.',
  '++',
  '--',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '&=',
  '|=',
  '^=',
  '<<',
  '>>',
  '**',
  '{',
  '}',
  '(',
  ')',
  '[',
  ']',
  ';',
  ',',
  ':',
  '?',
  '.',
  '+',
  '-',
  '*',
  '/',
  '%',
  '&',
  '|',
  '^',
  '~',
  '!',
  '<',
  '>',
  '=',
];

const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '<<=', '>>=', '>>>=', '&=', '|=', '^=', '**=']);

const BINARY_PRECEDENCE: Record<string, number> = {
  '||': 1,
  '&&': 2,
  '|': 3,
  '^': 4,
  '&': 5,
  '==': 6,
  '!=': 6,
  '===': 6,
  '!==': 6,
  '<': 7,
  '>': 7,
  '<=': 7,
  '>=': 7,
  '<<': 8,
  '>>': 8,
  '>>>': 8,
  '+': 9,
  '-': 9,
  '*': 10,
  '/': 10,
  '%': 10,
  '**': 11,
};

/** How deep statements and expressions may nest before the parse gives up. */
const MAX_DEPTH = 1000;

/** A token: `nl` records a line break before it, which is what ASI reads. */
type Tok = { t: 'id' | 'num' | 'p' | 'eof'; v: string; i: number; nl: boolean };

type Expr = (
  | { k: 'num'; v: string }
  | { k: 'lit'; v: 'true' | 'false' | 'null' | 'undefined' }
  | { k: 'id'; name: string; at: number }
  | { k: 'fn'; params: string[]; body: Stmt[] }
  | { k: 'index'; obj: { name: string; at: number }; prop: Expr }
  | { k: 'math'; name: string; args: Expr[] }
  | { k: 'call'; callee: Expr; args: Expr[] }
  | { k: 'unary'; op: string; arg: Expr }
  | { k: 'update'; op: string; prefix: boolean; arg: Expr }
  | { k: 'bin'; op: string; l: Expr; r: Expr }
  | { k: 'assign'; op: string; target: Expr; value: Expr }
  | { k: 'cond'; test: Expr; then: Expr; other: Expr }
  | { k: 'seq'; exprs: Expr[] }
) & { paren?: boolean };

type Decl = { k: 'decl'; kind: 'let' | 'const' | 'var'; decls: Array<{ name: string; init: Expr | null }> };

type Stmt =
  | { k: 'block'; body: Stmt[] }
  | Decl
  | { k: 'expr'; e: Expr }
  | { k: 'if'; test: Expr; then: Stmt; other: Stmt | null }
  | { k: 'for'; init: Decl | Expr | null; test: Expr | null; update: Expr | null; body: Stmt }
  | { k: 'while'; test: Expr; body: Stmt }
  | { k: 'do'; body: Stmt; test: Expr }
  | { k: 'break' | 'continue'; label: string | null; at: number }
  | { k: 'return'; arg: Expr | null }
  | { k: 'empty' }
  | { k: 'label'; name: string; body: Stmt };

function fail(message: string): never {
  throw new AccelValidationError(message);
}

const isIdStart = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36;
const isIdPart = (c: number) => isIdStart(c) || (c >= 48 && c <= 57);
const isDigit = (c: number) => c >= 48 && c <= 57;

/**
 * Only printable ASCII and ordinary whitespace: no quotes, backticks,
 * backslashes, `#` or `@`. The parser would refuse all of these anyway; the
 * scan is a cheap first gate that also keeps its error messages specific.
 */
function checkCharacters(body: string): void {
  for (let i = 0; i < body.length; i++) {
    const c = body.charCodeAt(i);
    if (c === 34 || c === 39 || c === 96 || c === 92 || c === 35 || c === 64) {
      fail(`character ${JSON.stringify(body[i])} at ${i}`);
    }
    if (!(c === 9 || c === 10 || c === 13 || (c >= 32 && c <= 126))) {
      fail(`character code ${c} at ${i}`);
    }
  }
}

function tokenize(body: string): Tok[] {
  const toks: Tok[] = [];
  const n = body.length;
  let i = 0;
  let nl = false;
  while (i < n) {
    const c = body.charCodeAt(i);
    if (c === 32 || c === 9) {
      i++;
      continue;
    }
    if (c === 10 || c === 13) {
      nl = true;
      i++;
      continue;
    }
    if (isIdStart(c)) {
      let j = i + 1;
      while (j < n && isIdPart(body.charCodeAt(j))) j++;
      toks.push({ t: 'id', v: body.slice(i, j), i, nl });
      nl = false;
      i = j;
      continue;
    }
    if (isDigit(c) || (c === 46 && i + 1 < n && isDigit(body.charCodeAt(i + 1)))) {
      let j = i;
      if (c === 48 && (body[i + 1] === 'x' || body[i + 1] === 'X')) {
        j = i + 2;
        while (j < n && /[0-9A-Fa-f]/.test(body[j])) j++;
        if (j === i + 2) fail(`bad number at ${i}`);
      } else {
        // `01` is a legacy octal, a syntax error in strict mode; refuse it
        // here rather than hand the engine something it will reject.
        if (c === 48 && i + 1 < n && isDigit(body.charCodeAt(i + 1))) fail(`bad number at ${i}`);
        while (j < n && isDigit(body.charCodeAt(j))) j++;
        if (j < n && body[j] === '.') {
          j++;
          while (j < n && isDigit(body.charCodeAt(j))) j++;
        }
        if (j < n && (body[j] === 'e' || body[j] === 'E')) {
          j++;
          if (j < n && (body[j] === '+' || body[j] === '-')) j++;
          const digits = j;
          while (j < n && isDigit(body.charCodeAt(j))) j++;
          if (j === digits) fail(`bad number at ${i}`);
        }
      }
      if (j < n && (isIdPart(body.charCodeAt(j)) || body[j] === '.')) fail(`bad number at ${i}`);
      toks.push({ t: 'num', v: body.slice(i, j), i, nl });
      nl = false;
      i = j;
      continue;
    }
    if (c === 47 && (body[i + 1] === '/' || body[i + 1] === '*')) fail(`comment at ${i}`);
    let p: string | undefined;
    for (const candidate of PUNCTUATORS) {
      if (body.startsWith(candidate, i)) {
        p = candidate;
        break;
      }
    }
    if (p === undefined) fail(`character ${JSON.stringify(body[i])} at ${i}`);
    toks.push({ t: 'p', v: p as string, i, nl });
    nl = false;
    i += (p as string).length;
  }
  toks.push({ t: 'eof', v: '', i: n, nl: true });
  return toks;
}

class Parser {
  private k = 0;
  private depth = 0;

  constructor(private readonly toks: Tok[]) {}

  private get peek(): Tok {
    return this.toks[this.k];
  }

  private next(): Tok {
    return this.toks[this.k++];
  }

  private is(v: string): boolean {
    const t = this.peek;
    return (t.t === 'p' || t.t === 'id') && t.v === v;
  }

  private expect(v: string): Tok {
    const t = this.peek;
    if (!this.is(v)) this.unexpected(t, `expected ${v}`);
    return this.next();
  }

  private unexpected(t: Tok, why = ''): never {
    if (t.t === 'eof') return fail(`unexpected end of source${why ? ` (${why})` : ''}`);
    return fail(`unexpected ${t.v} at ${t.i}${why ? ` (${why})` : ''}`);
  }

  private enter(): void {
    if (++this.depth > MAX_DEPTH) fail('source nests too deeply');
  }

  private leave(): void {
    this.depth--;
  }

  /** A statement ends at `;`, or where ASI would end it: `}`, the end, or a line break. */
  private semicolon(): void {
    if (this.is(';')) {
      this.next();
      return;
    }
    const t = this.peek;
    if (t.t === 'eof' || t.nl || (t.t === 'p' && t.v === '}')) return;
    this.unexpected(t);
  }

  program(): Stmt[] {
    const body: Stmt[] = [];
    while (this.peek.t !== 'eof') body.push(this.statement());
    return body;
  }

  private statement(): Stmt {
    this.enter();
    try {
      return this.statementInner();
    } finally {
      this.leave();
    }
  }

  private statementInner(): Stmt {
    const t = this.peek;
    if (t.t === 'p') {
      if (t.v === '{') return { k: 'block', body: this.block() };
      if (t.v === ';') {
        this.next();
        return { k: 'empty' };
      }
    }
    if (t.t === 'id') {
      switch (t.v) {
        case 'let':
        case 'const':
        case 'var': {
          const decl = this.declaration();
          this.semicolon();
          return decl;
        }
        case 'if': {
          this.next();
          this.expect('(');
          const test = this.expression();
          this.expect(')');
          const then = this.substatement();
          let other: Stmt | null = null;
          if (this.is('else')) {
            this.next();
            other = this.substatement();
          }
          return { k: 'if', test, then, other };
        }
        case 'for':
          return this.forStatement();
        case 'while': {
          this.next();
          this.expect('(');
          const test = this.expression();
          this.expect(')');
          return { k: 'while', test, body: this.substatement() };
        }
        case 'do': {
          this.next();
          const body = this.substatement();
          this.expect('while');
          this.expect('(');
          const test = this.expression();
          this.expect(')');
          if (this.is(';')) this.next();
          return { k: 'do', body, test };
        }
        case 'break':
        case 'continue': {
          this.next();
          let label: string | null = null;
          const at = this.peek;
          if (at.t === 'id' && !at.nl) {
            if (KEYWORDS.has(at.v) || RESERVED.has(at.v)) this.unexpected(at);
            label = this.next().v;
          }
          this.semicolon();
          return { k: t.v as 'break' | 'continue', label, at: at.i };
        }
        case 'return': {
          this.next();
          const after = this.peek;
          let arg: Expr | null = null;
          if (!(after.t === 'eof' || after.nl || (after.t === 'p' && (after.v === ';' || after.v === '}')))) {
            arg = this.expression();
          }
          this.semicolon();
          return { k: 'return', arg };
        }
        case 'function':
          // A declaration is a statement that starts with `function`; the
          // grammar has only anonymous function expressions, assigned to a name.
          return fail(`named function at ${t.i}`);
        default:
          break;
      }
      const after = this.toks[this.k + 1];
      if (after.t === 'p' && after.v === ':' && !KEYWORDS.has(t.v)) {
        if (RESERVED.has(t.v)) fail(`identifier ${t.v} at ${t.i}`);
        this.next();
        this.next();
        return { k: 'label', name: t.v, body: this.statement() };
      }
    }
    const e = this.expression();
    this.semicolon();
    return { k: 'expr', e };
  }

  /** The body of an `if` or a loop: a lexical declaration there is a syntax error in JavaScript. */
  private substatement(): Stmt {
    const t = this.peek;
    if (t.t === 'id' && (t.v === 'let' || t.v === 'const')) this.unexpected(t, 'declaration as a body');
    return this.statement();
  }

  private block(): Stmt[] {
    this.expect('{');
    const body: Stmt[] = [];
    while (!this.is('}')) {
      if (this.peek.t === 'eof') this.unexpected(this.peek, 'expected }');
      body.push(this.statement());
    }
    this.next();
    return body;
  }

  private declaration(): Decl {
    const kw = this.next();
    const decls: Decl['decls'] = [];
    for (;;) {
      const name = this.peek;
      if (name.t !== 'id' || KEYWORDS.has(name.v) || RESERVED.has(name.v)) {
        fail(`bad declaration at ${kw.i}${name.t !== 'eof' ? ` (${name.v})` : ''}`);
      }
      this.next();
      let init: Expr | null = null;
      if (this.is('=')) {
        this.next();
        init = this.assignment();
      } else if (kw.v === 'const') {
        fail(`bad declaration at ${kw.i} (${name.v} has no value)`);
      }
      decls.push({ name: name.v, init });
      if (!this.is(',')) break;
      this.next();
    }
    return { k: 'decl', kind: kw.v as Decl['kind'], decls };
  }

  private forStatement(): Stmt {
    this.next();
    this.expect('(');
    let init: Decl | Expr | null = null;
    if (!this.is(';')) {
      const t = this.peek;
      init = t.t === 'id' && (t.v === 'let' || t.v === 'const' || t.v === 'var') ? this.declaration() : this.sequence();
    }
    // `for (x in …)` and `for (x of …)` fall out here: neither word is an
    // operator of the grammar, so the header must continue with `;`.
    this.expect(';');
    const test = this.is(';') ? null : this.expression();
    this.expect(';');
    const update = this.is(')') ? null : this.sequence();
    this.expect(')');
    return { k: 'for', init, test, update, body: this.substatement() };
  }

  /** The comma operator, admitted only in a `for(;;)` header. */
  private sequence(): Expr {
    const first = this.assignment();
    if (!this.is(',')) return first;
    const exprs = [first];
    while (this.is(',')) {
      this.next();
      exprs.push(this.assignment());
    }
    return { k: 'seq', exprs };
  }

  private expression(): Expr {
    const e = this.assignment();
    if (this.is(',')) fail(`comma expression at ${this.peek.i}`);
    return e;
  }

  private assignment(): Expr {
    this.enter();
    try {
      const target = this.conditional();
      const t = this.peek;
      if (t.t === 'p' && ASSIGN_OPS.has(t.v)) {
        this.checkTarget(target, t);
        this.next();
        return { k: 'assign', op: t.v, target, value: this.assignment() };
      }
      return target;
    } finally {
      this.leave();
    }
  }

  private checkTarget(target: Expr, at: Tok): void {
    if (target.k !== 'id' && target.k !== 'index') fail(`invalid assignment target at ${at.i}`);
  }

  private conditional(): Expr {
    const test = this.binary(1);
    if (!this.is('?')) return test;
    this.next();
    const then = this.assignment();
    this.expect(':');
    const other = this.assignment();
    return { k: 'cond', test, then, other };
  }

  private binary(minPrec: number): Expr {
    let left = this.unary();
    for (;;) {
      const t = this.peek;
      const prec = t.t === 'p' ? BINARY_PRECEDENCE[t.v] : undefined;
      if (prec === undefined || prec < minPrec) return left;
      this.next();
      if (t.v === '**') {
        // JavaScript refuses `-a ** b` as ambiguous; so does this.
        if ((left.k === 'unary' || (left.k === 'update' && left.prefix)) && !left.paren) {
          fail(`unparenthesised unary operand of ** at ${t.i}`);
        }
        const right = this.binary(prec); // right-associative
        left = { k: 'bin', op: t.v, l: left, r: right };
      } else {
        const right = this.binary(prec + 1);
        left = { k: 'bin', op: t.v, l: left, r: right };
      }
    }
  }

  private unary(): Expr {
    this.enter();
    try {
      const t = this.peek;
      if (t.t === 'p' && (t.v === '!' || t.v === '-' || t.v === '+' || t.v === '~')) {
        this.next();
        return { k: 'unary', op: t.v, arg: this.unary() };
      }
      if (t.t === 'p' && (t.v === '++' || t.v === '--')) {
        this.next();
        const arg = this.unary();
        this.checkTarget(arg, t);
        return { k: 'update', op: t.v, prefix: true, arg };
      }
      const e = this.callOrMember();
      const after = this.peek;
      if (after.t === 'p' && (after.v === '++' || after.v === '--') && !after.nl) {
        this.checkTarget(e, after);
        this.next();
        return { k: 'update', op: after.v, prefix: false, arg: e };
      }
      return e;
    } finally {
      this.leave();
    }
  }

  private callOrMember(): Expr {
    let e = this.primary();
    for (;;) {
      const t = this.peek;
      if (t.t !== 'p') return e;
      if (t.v === '[') {
        // Only a name may be indexed: the parameters are the typed arrays,
        // the function table and the callbacks the host binds, and nothing
        // else in the language is worth indexing. A call's result or an
        // element of an element is refused rather than reasoned about.
        if (e.k !== 'id' || e.paren) fail(`computed access on something other than a name at ${t.i}`);
        this.next();
        const prop = this.expression();
        this.expect(']');
        e = { k: 'index', obj: { name: e.name, at: e.at }, prop };
      } else if (t.v === '(') {
        e = { k: 'call', callee: e, args: this.args() };
      } else if (t.v === '.' || t.v === '?.') {
        fail(`member access at ${t.i}`);
      } else {
        return e;
      }
    }
  }

  private args(): Expr[] {
    this.expect('(');
    const args: Expr[] = [];
    while (!this.is(')')) {
      args.push(this.assignment());
      if (this.is(')')) break;
      this.expect(',');
    }
    this.next();
    return args;
  }

  private primary(): Expr {
    const t = this.next();
    if (t.t === 'num') return { k: 'num', v: t.v };
    if (t.t === 'p' && t.v === '(') {
      const e = this.expression();
      this.expect(')');
      return { ...e, paren: true };
    }
    if (t.t !== 'id') return this.unexpected(t);
    switch (t.v) {
      case 'true':
      case 'false':
      case 'null':
      case 'undefined':
        return { k: 'lit', v: t.v };
      case 'function':
        return this.functionExpression(t);
      case 'Math': {
        const dot = this.peek;
        const name = this.toks[this.k + 1];
        const open = this.toks[this.k + 2];
        if (!(dot.v === '.' && name.t === 'id' && MATH_PURE.has(name.v) && open.v === '(')) {
          fail(`Math member other than a pure function call at ${t.i}`);
        }
        this.next();
        this.next();
        return { k: 'math', name: name.v, args: this.args() };
      }
      default:
        break;
    }
    if (RESERVED.has(t.v)) fail(`identifier ${t.v} at ${t.i}`);
    if (KEYWORDS.has(t.v)) this.unexpected(t);
    return { k: 'id', name: t.v, at: t.i };
  }

  private functionExpression(kw: Tok): Expr {
    if (!this.is('(')) fail(`named function at ${kw.i}`);
    this.next();
    const params: string[] = [];
    while (!this.is(')')) {
      const p = this.next();
      if (p.t !== 'id' || KEYWORDS.has(p.v) || RESERVED.has(p.v) || params.includes(p.v)) {
        fail(`bad function parameter at ${p.i}`);
      }
      params.push(p.v);
      if (this.is(')')) break;
      this.expect(',');
    }
    this.next();
    return { k: 'fn', params, body: this.block() };
  }
}

// ---------------------------------------------------------------------------
// Scope resolution
// ---------------------------------------------------------------------------

type Binding = 'param' | 'local';
type Scope = { names: Map<string, Binding>; parent: Scope | null };
type Label = { name: string; loop: boolean };

const lookup = (scope: Scope | null, name: string): Binding | undefined => {
  for (let s = scope; s; s = s.parent) {
    const b = s.names.get(name);
    if (b) return b;
  }
  return undefined;
};

/** `var`s belong to the enclosing function wherever they are written; function expressions are their own. */
function hoistVars(stmts: Stmt[], scope: Scope): void {
  const visit = (s: Stmt | null): void => {
    if (!s) return;
    switch (s.k) {
      case 'decl':
        if (s.kind === 'var') for (const d of s.decls) scope.names.set(d.name, 'local');
        break;
      case 'block':
        s.body.forEach(visit);
        break;
      case 'if':
        visit(s.then);
        visit(s.other);
        break;
      case 'for':
        if (s.init && s.init.k === 'decl') visit(s.init);
        visit(s.body);
        break;
      case 'while':
      case 'do':
      case 'label':
        visit(s.body);
        break;
      default:
        break;
    }
  };
  stmts.forEach(visit);
}

function declareLexical(stmts: Stmt[], scope: Scope): void {
  for (const s of stmts) {
    if (s.k === 'decl' && s.kind !== 'var') for (const d of s.decls) scope.names.set(d.name, 'local');
  }
}

function resolveFunction(params: string[], body: Stmt[], parent: Scope | null): void {
  const scope: Scope = { names: new Map(), parent };
  for (const p of params) scope.names.set(p, 'param');
  hoistVars(body, scope);
  declareLexical(body, scope);
  for (const s of body) resolveStmt(s, scope, []);
}

function resolveStmt(s: Stmt, scope: Scope, labels: Label[]): void {
  switch (s.k) {
    case 'block': {
      const inner: Scope = { names: new Map(), parent: scope };
      declareLexical(s.body, inner);
      for (const b of s.body) resolveStmt(b, inner, labels);
      return;
    }
    case 'decl':
      for (const d of s.decls) if (d.init) resolveExpr(d.init, scope);
      return;
    case 'expr':
      resolveExpr(s.e, scope);
      return;
    case 'return':
      if (s.arg) resolveExpr(s.arg, scope);
      return;
    case 'if':
      resolveExpr(s.test, scope);
      resolveStmt(s.then, scope, labels);
      if (s.other) resolveStmt(s.other, scope, labels);
      return;
    case 'for': {
      const inner: Scope = { names: new Map(), parent: scope };
      if (s.init) {
        if (s.init.k === 'decl') {
          if (s.init.kind !== 'var') declareLexical([s.init], inner);
          resolveStmt(s.init, inner, labels);
        } else {
          resolveExpr(s.init, inner);
        }
      }
      if (s.test) resolveExpr(s.test, inner);
      if (s.update) resolveExpr(s.update, inner);
      resolveStmt(s.body, inner, labels);
      return;
    }
    case 'while':
    case 'do':
      resolveExpr(s.test, scope);
      resolveStmt(s.body, scope, labels);
      return;
    case 'break':
    case 'continue': {
      if (s.label === null) return;
      const target = labels.find((l) => l.name === s.label);
      if (!target) fail(`unknown label ${s.label} at ${s.at}`);
      if (s.k === 'continue' && !target?.loop) fail(`continue to a label that is not a loop at ${s.at}`);
      return;
    }
    case 'label': {
      const loop = s.body.k === 'for' || s.body.k === 'while' || s.body.k === 'do';
      resolveStmt(s.body, scope, [...labels, { name: s.name, loop }]);
      return;
    }
    case 'empty':
      return;
  }
}

function resolveExpr(e: Expr, scope: Scope): void {
  switch (e.k) {
    case 'num':
    case 'lit':
      return;
    case 'id':
      if (!lookup(scope, e.name)) fail(`identifier ${e.name} at ${e.at}`);
      return;
    case 'fn':
      resolveFunction(e.params, e.body, scope);
      return;
    case 'index': {
      const binding = lookup(scope, e.obj.name);
      if (!binding) fail(`identifier ${e.obj.name} at ${e.obj.at}`);
      // A local can hold anything the language can make, including a
      // function's source text; a parameter holds what the host bound.
      if (binding !== 'param') fail(`computed access on ${e.obj.name}, which is not a parameter, at ${e.obj.at}`);
      resolveExpr(e.prop, scope);
      return;
    }
    case 'math':
      e.args.forEach((a) => resolveExpr(a, scope));
      return;
    case 'call':
      resolveExpr(e.callee, scope);
      e.args.forEach((a) => resolveExpr(a, scope));
      return;
    case 'unary':
    case 'update':
      resolveExpr(e.arg, scope);
      return;
    case 'bin':
      resolveExpr(e.l, scope);
      resolveExpr(e.r, scope);
      return;
    case 'assign':
      resolveExpr(e.target, scope);
      resolveExpr(e.value, scope);
      return;
    case 'cond':
      resolveExpr(e.test, scope);
      resolveExpr(e.then, scope);
      resolveExpr(e.other, scope);
      return;
    case 'seq':
      e.exprs.forEach((x) => resolveExpr(x, scope));
      return;
  }
}

// ---------------------------------------------------------------------------
// Emission
// ---------------------------------------------------------------------------

function emitExpr(e: Expr): string {
  switch (e.k) {
    case 'num':
      return e.v;
    case 'lit':
      return e.v === 'undefined' ? '(void 0)' : e.v;
    case 'id':
      return e.name;
    case 'fn':
      return `(function(${e.params.join(',')}){${emitStmts(e.body)}})`;
    case 'index':
      // The key is forced to a number: see the module comment.
      return `${e.obj.name}[${e.prop.k === 'num' ? e.prop.v : `+(${emitExpr(e.prop)})`}]`;
    case 'math':
      return `Math.${e.name}(${e.args.map(emitExpr).join(',')})`;
    case 'call':
      return `(${emitExpr(e.callee)})(${e.args.map(emitExpr).join(',')})`;
    case 'unary':
      return `(${e.op}(${emitExpr(e.arg)}))`;
    case 'update':
      return e.prefix ? `(${e.op}${emitExpr(e.arg)})` : `(${emitExpr(e.arg)}${e.op})`;
    case 'bin':
      return `((${emitExpr(e.l)})${e.op}(${emitExpr(e.r)}))`;
    case 'assign':
      return `(${emitExpr(e.target)}${e.op}(${emitExpr(e.value)}))`;
    case 'cond':
      return `((${emitExpr(e.test)})?(${emitExpr(e.then)}):(${emitExpr(e.other)}))`;
    case 'seq':
      return `(${e.exprs.map(emitExpr).join(',')})`;
  }
}

function emitDecl(s: Decl): string {
  return `${s.kind} ${s.decls.map((d) => (d.init ? `${d.name}=(${emitExpr(d.init)})` : d.name)).join(',')}`;
}

function emitStmt(s: Stmt): string {
  switch (s.k) {
    case 'block':
      return `{${emitStmts(s.body)}}`;
    case 'decl':
      return `${emitDecl(s)};`;
    case 'expr':
      return `${emitExpr(s.e)};`;
    case 'if':
      return `if(${emitExpr(s.test)}){${emitStmt(s.then)}}${s.other ? `else{${emitStmt(s.other)}}` : ''}`;
    case 'for': {
      const init = s.init === null ? '' : s.init.k === 'decl' ? emitDecl(s.init) : emitExpr(s.init);
      return `for(${init};${s.test ? emitExpr(s.test) : ''};${s.update ? emitExpr(s.update) : ''}){${emitStmt(s.body)}}`;
    }
    case 'while':
      return `while(${emitExpr(s.test)}){${emitStmt(s.body)}}`;
    case 'do':
      return `do{${emitStmt(s.body)}}while(${emitExpr(s.test)});`;
    case 'break':
    case 'continue':
      return s.label ? `${s.k} ${s.label};` : `${s.k};`;
    case 'return':
      return s.arg ? `return ${emitExpr(s.arg)};` : 'return;';
    case 'empty':
      return ';';
    case 'label':
      // Not wrapped: `continue L` must name the loop itself, not a block round it.
      return `${s.name}:${emitStmt(s.body)}`;
  }
}

function emitStmts(stmts: Stmt[]): string {
  return stmts.map(emitStmt).join('');
}

/**
 * Parse a function body against the closed language and return the text to
 * compile in its place. Throws {@link AccelValidationError} with the reason on
 * the first violation.
 */
export function compileAccelSource(params: string[], body: string): string {
  const ident = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
  const seen = new Set<string>();
  for (const p of params) {
    if (!ident.test(p)) fail(`parameter ${JSON.stringify(p)} is not an identifier`);
    if (KEYWORDS.has(p) || RESERVED.has(p)) fail(`parameter ${p} shadows a keyword`);
    if (seen.has(p)) fail(`parameter ${p} is repeated`);
    seen.add(p);
  }
  if (body.length > 4 * 1024 * 1024) fail('body too long');
  checkCharacters(body);
  let program: Stmt[];
  try {
    program = new Parser(tokenize(body)).program();
    resolveFunction(params, program, null);
  } catch (err) {
    if (err instanceof AccelValidationError) throw err;
    // A stack overflow on pathological nesting is a refusal, not a crash.
    throw new AccelValidationError(`source could not be parsed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return emitStmts(program);
}

/**
 * Validate a function's parameter names and body against the closed language.
 * Throws {@link AccelValidationError} with the reason on the first violation.
 */
export function validateAccelSource(params: string[], body: string): void {
  compileAccelSource(params, body);
}
