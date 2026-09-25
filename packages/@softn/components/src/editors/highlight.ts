/**
 * Syntax highlighting as data: a scanner per language that walks the source
 * once, left to right, and returns tokens — plain strings with a kind. Nothing
 * here produces HTML; a view renders each token as a React text node, so a
 * `<script>` inside a string is text and stays text.
 *
 * A list of regular expressions tried at each offset cannot know where it is.
 * A `/` that starts a regular expression and one that divides look the same
 * to it, so `/"/` opens a string that runs to the next quote; a template
 * literal is one pattern, so a backtick inside `${ }` ends it early; Python's
 * f-, r- and b-prefixes and decorators go unrecognised. A scanner that knows
 * whether it is inside a string, a template or an expression gets those right
 * by construction. CodeEditor and Studio's code view both render from here.
 *
 * The one invariant every scanner keeps: the tokens' texts, joined, are the
 * source exactly. CodeEditor lays the highlighted text under a transparent
 * textarea, so a character dropped, added or escaped here would move every
 * character after it away from the caret the user is moving.
 */

export type TokenKind =
  | 'plain'
  | 'keyword'
  | 'string'
  | 'number'
  | 'literal'
  | 'comment'
  | 'function'
  | 'decorator'
  | 'regex'
  | 'punct'
  | 'property'
  | 'tag'
  | 'attr'
  | 'mark'
  | 'type';

export interface Token {
  kind: TokenKind;
  text: string;
}

/**
 * Every language the scanners read. `softn` is SoftN's `.ui` markup; the rest
 * are what CodeEditor's `language` prop offers.
 */
export type CodeLanguage =
  | 'javascript'
  | 'typescript'
  | 'python'
  | 'json'
  | 'html'
  | 'css'
  | 'sql'
  | 'markdown'
  | 'softn'
  | 'plain';

/** The language a file is highlighted as, from its name alone. */
export function languageForPath(path: string): CodeLanguage {
  const lower = path.toLowerCase();
  if (/\.(logic|js|mjs|cjs|jsx)$/.test(lower)) return 'javascript';
  if (/\.(ts|tsx|mts|cts)$/.test(lower)) return 'typescript';
  if (/\.py$/.test(lower)) return 'python';
  if (/\.(json|xdb)$/.test(lower)) return 'json';
  if (/\.(ui|softn)$/.test(lower)) return 'softn';
  if (/\.(html?|svg|xml)$/.test(lower)) return 'html';
  if (/\.css$/.test(lower)) return 'css';
  if (/\.sql$/.test(lower)) return 'sql';
  if (/\.(md|markdown)$/.test(lower)) return 'markdown';
  return 'plain';
}

/** What a person would call the language, for a view's label. */
export const LANGUAGE_LABEL: Record<CodeLanguage, string> = {
  javascript: 'JavaScript',
  typescript: 'TypeScript',
  python: 'Python',
  json: 'JSON',
  html: 'HTML',
  css: 'CSS',
  sql: 'SQL',
  markdown: 'Markdown',
  softn: 'SoftN markup',
  plain: 'Text',
};

class Scanner {
  readonly tokens: Token[] = [];
  pos = 0;
  /** JavaScript scanning adds TypeScript's keywords and types. */
  typescript = false;
  constructor(readonly src: string) {}

  get done(): boolean {
    return this.pos >= this.src.length;
  }

  peek(offset = 0): string {
    return this.src[this.pos + offset] ?? '';
  }

  startsWith(text: string): boolean {
    return this.src.startsWith(text, this.pos);
  }

  /** Push a token, merging it into the previous one when the kind is the same. */
  push(kind: TokenKind, text: string): void {
    if (!text) return;
    const last = this.tokens[this.tokens.length - 1];
    if (last && last.kind === kind && (kind === 'plain' || kind === 'string' || kind === 'comment')) {
      last.text += text;
      return;
    }
    this.tokens.push({ kind, text });
  }

  take(kind: TokenKind, length: number): string {
    const text = this.src.slice(this.pos, this.pos + length);
    this.pos += text.length;
    this.push(kind, text);
    return text;
  }

  /** The last token that is not whitespace or a comment. */
  lastSignificant(): Token | undefined {
    for (let i = this.tokens.length - 1; i >= 0; i--) {
      const token = this.tokens[i];
      if (token.kind === 'comment') continue;
      if (token.kind === 'plain' && !token.text.trim()) continue;
      return token;
    }
    return undefined;
  }

  /** Is `pos` at the start of its line, ignoring indentation? */
  atLineStart(): boolean {
    for (let i = this.pos - 1; i >= 0; i--) {
      const ch = this.src[i];
      if (ch === '\n') return true;
      if (ch !== ' ' && ch !== '\t') return false;
    }
    return true;
  }

  /** Scan `text` with another scanner and append its tokens here. */
  embed(text: string, scan: (sub: Scanner) => void): void {
    const sub = new Scanner(text);
    sub.typescript = this.typescript;
    scan(sub);
    for (const token of sub.tokens) this.push(token.kind, token.text);
    this.pos += text.length;
  }
}

// Letters beyond ASCII, written as escapes: a bundle served without a
// charset must not read the range as mojibake.
const IDENT_START = new RegExp('[A-Za-z_$\\u00C0-\\uFFFF]');
const IDENT_PART = new RegExp('[\\w$\\u00C0-\\uFFFF]');

function readIdentifier(s: Scanner, at = s.pos): string {
  let end = at;
  while (end < s.src.length && IDENT_PART.test(s.src[end])) end++;
  return s.src.slice(at, end);
}

/**
 * The text a sticky pattern matches at `at`, or null. Sticky, so the source is
 * never sliced: slicing the rest of a large file at every token is quadratic.
 */
function matchAt(s: Scanner, re: RegExp, at = s.pos): string | null {
  re.lastIndex = at;
  const match = re.exec(s.src);
  return match && match[0].length > 0 ? match[0] : null;
}

const NUMBER = /(?:0[xX][\da-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?)[njJ]?/y;

function readNumber(s: Scanner): number {
  return matchAt(s, NUMBER)?.length ?? 1;
}

/** The next non-space character after `from`, on any line. */
function nextNonSpace(src: string, from: number): string {
  let i = from;
  while (i < src.length && /\s/.test(src[i])) i++;
  return src[i] ?? '';
}

/** The end of the line `from` is on (the index of its newline, or the end). */
function lineEnd(src: string, from: number): number {
  const end = src.indexOf('\n', from);
  return end < 0 ? src.length : end;
}

// --- JavaScript and TypeScript ---------------------------------------------------

const JS_KEYWORDS = new Set([
  'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete',
  'do', 'else', 'export', 'extends', 'finally', 'for', 'from', 'function', 'if', 'import', 'in', 'instanceof',
  'let', 'new', 'of', 'return', 'static', 'super', 'switch', 'this', 'throw', 'try', 'typeof', 'var', 'void',
  'while', 'with', 'yield',
]);
const TS_KEYWORDS = new Set([
  'abstract', 'as', 'asserts', 'declare', 'enum', 'implements', 'infer', 'interface', 'is', 'keyof', 'module',
  'namespace', 'override', 'private', 'protected', 'public', 'readonly', 'satisfies', 'type', 'unique',
]);
const TS_TYPES = new Set([
  'any', 'bigint', 'boolean', 'never', 'number', 'object', 'string', 'symbol', 'unknown',
]);
const JS_LITERALS = new Set(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity']);
/** After these, a `/` begins a regular expression rather than dividing. */
const JS_REGEX_AFTER_WORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await',
]);

function regexAllowed(s: Scanner): boolean {
  const last = s.lastSignificant();
  if (!last) return true;
  if (last.kind === 'keyword') return JS_REGEX_AFTER_WORDS.has(last.text);
  if (last.kind === 'punct' || last.kind === 'mark') {
    const ch = last.text[last.text.length - 1];
    return ch !== ')' && ch !== ']' && ch !== '}';
  }
  return false;
}

function scanQuoted(s: Scanner, quote: string, kind: TokenKind = 'string'): void {
  let end = s.pos + 1;
  while (end < s.src.length) {
    const ch = s.src[end];
    if (ch === '\\') { end += 2; continue; }
    if (ch === quote) { end++; break; }
    if (ch === '\n') break;
    end++;
  }
  s.take(kind, Math.min(end, s.src.length) - s.pos);
}

function scanRegex(s: Scanner): boolean {
  let end = s.pos + 1;
  let inClass = false;
  while (end < s.src.length) {
    const ch = s.src[end];
    if (ch === '\n') return false;
    if (ch === '\\') { end += 2; continue; }
    if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    else if (ch === '/' && !inClass) break;
    end++;
  }
  if (end >= s.src.length) return false;
  end++;
  while (end < s.src.length && /[a-z]/i.test(s.src[end])) end++;
  s.take('regex', end - s.pos);
  return true;
}

function scanTemplate(s: Scanner): void {
  s.take('string', 1);
  let chunk = s.pos;
  while (!s.done) {
    const ch = s.peek();
    if (ch === '\\') { s.pos += 2; continue; }
    if (ch === '`') {
      s.pos++;
      s.push('string', s.src.slice(chunk, s.pos));
      return;
    }
    if (ch === '$' && s.peek(1) === '{') {
      s.push('string', s.src.slice(chunk, s.pos));
      s.take('mark', 2);
      scanJs(s, true);
      if (s.peek() === '}') s.take('mark', 1);
      chunk = s.pos;
      continue;
    }
    s.pos++;
  }
  s.pos = Math.min(s.pos, s.src.length);
  s.push('string', s.src.slice(chunk, s.pos));
}

/**
 * JavaScript from `pos`. With `untilBrace`, stops (without consuming it) at a
 * `}` that closes nothing opened here — the end of a `${ }` or `{ }`
 * expression the caller is inside.
 */
function scanJs(s: Scanner, untilBrace = false): void {
  let depth = 0;
  while (!s.done) {
    const ch = s.peek();
    if (ch === '}' && untilBrace && depth === 0) return;
    if (/\s/.test(ch)) { s.take('plain', 1); continue; }
    if (s.startsWith('//')) {
      s.take('comment', lineEnd(s.src, s.pos) - s.pos);
      continue;
    }
    if (s.startsWith('/*')) {
      const end = s.src.indexOf('*/', s.pos + 2);
      s.take('comment', (end < 0 ? s.src.length : end + 2) - s.pos);
      continue;
    }
    if (ch === '"' || ch === "'") { scanQuoted(s, ch); continue; }
    if (ch === '`') { scanTemplate(s); continue; }
    if (ch === '/' && regexAllowed(s) && scanRegex(s)) continue;
    if (/\d/.test(ch) || (ch === '.' && /\d/.test(s.peek(1)))) { s.take('number', readNumber(s)); continue; }
    if (s.typescript && ch === '@' && IDENT_START.test(s.peek(1))) {
      const decorator = matchAt(s, /@[\w$.]+/y);
      if (decorator) { s.take('decorator', decorator.length); continue; }
    }
    if (IDENT_START.test(ch)) {
      const word = readIdentifier(s);
      const previous = s.lastSignificant();
      const afterDot = previous?.kind === 'punct' && previous.text.endsWith('.');
      let kind: TokenKind = 'plain';
      if (!afterDot && JS_KEYWORDS.has(word)) kind = 'keyword';
      else if (!afterDot && JS_LITERALS.has(word)) kind = 'literal';
      else if (!afterDot && s.typescript && TS_KEYWORDS.has(word) && nextNonSpace(s.src, s.pos + word.length) !== ':') kind = 'keyword';
      else if (!afterDot && s.typescript && TS_TYPES.has(word)) kind = 'type';
      else if (nextNonSpace(s.src, s.pos + word.length) === '(') kind = 'function';
      else if (afterDot) kind = 'property';
      s.take(kind, word.length);
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') depth = Math.max(0, depth - 1);
    s.take('punct', 1);
  }
}

// --- Python -------------------------------------------------------------------

const PY_KEYWORDS = new Set([
  'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except',
  'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass',
  'raise', 'return', 'try', 'while', 'with', 'yield', 'match', 'case',
]);
const PY_LITERALS = new Set(['True', 'False', 'None']);

/** A string prefix (r, b, f, u, rb, fr …) directly followed by a quote. */
function pythonStringStart(s: Scanner): { prefix: string; quote: string } | null {
  const match = matchAt(s, /[rRbBuUfF]{0,2}(?:"""|'''|"|')/y);
  if (!match) return null;
  const prefix = /^[rRbBuUfF]*/.exec(match)![0];
  // An identifier that merely ends in r, b, f or u (`bar"`) is not a prefix.
  if (prefix && s.pos > 0 && IDENT_PART.test(s.src[s.pos - 1])) return null;
  if (prefix.length === 2 && !/^(rb|br|fr|rf)$/i.test(prefix)) return null;
  return { prefix, quote: match.slice(prefix.length) };
}

function scanPythonString(s: Scanner, prefix: string, quote: string): void {
  const isF = /f/i.test(prefix);
  const triple = quote.length === 3;
  s.take('string', prefix.length + quote.length);
  let chunk = s.pos;
  const flush = () => { s.push('string', s.src.slice(chunk, s.pos)); };
  while (!s.done) {
    const ch = s.peek();
    if (ch === '\\') { s.pos += 2; continue; }
    if (!triple && ch === '\n') break;
    if (s.startsWith(quote)) {
      s.pos += quote.length;
      flush();
      return;
    }
    if (isF && ch === '{') {
      if (s.peek(1) === '{') { s.pos += 2; continue; }
      flush();
      s.take('mark', 1);
      scanPython(s, true);
      if (s.peek() === '}') s.take('mark', 1);
      chunk = s.pos;
      continue;
    }
    if (isF && ch === '}' && s.peek(1) === '}') { s.pos += 2; continue; }
    s.pos++;
  }
  s.pos = Math.min(s.pos, s.src.length);
  flush();
}

function scanPython(s: Scanner, untilBrace = false): void {
  let depth = 0;
  while (!s.done) {
    const ch = s.peek();
    if (ch === '}' && untilBrace && depth === 0) return;
    if (/\s/.test(ch)) { s.take('plain', 1); continue; }
    if (ch === '#') {
      s.take('comment', lineEnd(s.src, s.pos) - s.pos);
      continue;
    }
    const str = pythonStringStart(s);
    if (str) { scanPythonString(s, str.prefix, str.quote); continue; }
    if (ch === '@' && s.atLineStart() && !untilBrace) {
      const decorator = matchAt(s, /@[\w.]+/y);
      if (decorator) { s.take('decorator', decorator.length); continue; }
    }
    if (/\d/.test(ch) || (ch === '.' && /\d/.test(s.peek(1)))) { s.take('number', readNumber(s)); continue; }
    if (IDENT_START.test(ch) && ch !== '$') {
      const word = readIdentifier(s);
      const previous = s.lastSignificant();
      const afterDot = previous?.kind === 'punct' && previous.text.endsWith('.');
      let kind: TokenKind = 'plain';
      if (!afterDot && PY_KEYWORDS.has(word)) kind = 'keyword';
      else if (!afterDot && PY_LITERALS.has(word)) kind = 'literal';
      else if (previous?.kind === 'keyword' && (previous.text === 'def' || previous.text === 'class')) kind = 'function';
      else if (nextNonSpace(s.src, s.pos + word.length) === '(') kind = 'function';
      else if (afterDot) kind = 'property';
      s.take(kind, word.length);
      continue;
    }
    if (ch === '{' || ch === '(' || ch === '[') depth++;
    else if (ch === '}' || ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    s.take('punct', 1);
  }
}

// --- JSON ---------------------------------------------------------------------

function scanJson(s: Scanner): void {
  while (!s.done) {
    const ch = s.peek();
    if (/\s/.test(ch)) { s.take('plain', 1); continue; }
    if (ch === '"') {
      const start = s.pos;
      scanQuoted(s, '"');
      // A string followed by a colon is a key.
      if (nextNonSpace(s.src, s.pos) === ':') s.tokens[s.tokens.length - 1] = { kind: 'property', text: s.src.slice(start, s.pos) };
      continue;
    }
    const number = /[-\d]/.test(ch) ? matchAt(s, /-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y) : null;
    if (number) { s.take('number', number.length); continue; }
    if (/[a-z]/.test(ch)) {
      const word = readIdentifier(s);
      s.take(word === 'true' || word === 'false' || word === 'null' ? 'literal' : 'plain', word.length);
      continue;
    }
    s.take('punct', 1);
  }
}

// --- CSS ----------------------------------------------------------------------

/** At-rules whose block holds rules rather than declarations. */
const CSS_RULE_BLOCKS = /^@(?:media|supports|layer|container|document|scope|starting-style|-moz-document)$/i;

/**
 * A stylesheet. What a word is depends on where it stands — `color` before a
 * colon is a property, `a` before a brace is a selector — so the scanner keeps
 * a stack of the blocks it is inside: a block of rules (the top level, an
 * `@media`) reads selectors, a block of declarations reads `property: value`.
 */
function scanCss(s: Scanner): void {
  const blocks: Array<'rules' | 'decls'> = [];
  /** The at-rule whose prelude is being read, until its `{` or `;`. */
  let atRule: string | null = null;
  /** Inside a declaration block: after the colon, reading a value. */
  let inValue = false;
  const inDecls = () => blocks[blocks.length - 1] === 'decls';

  while (!s.done) {
    const ch = s.peek();
    if (/\s/.test(ch)) { s.take('plain', 1); continue; }
    if (s.startsWith('/*')) {
      const end = s.src.indexOf('*/', s.pos + 2);
      s.take('comment', (end < 0 ? s.src.length : end + 2) - s.pos);
      continue;
    }
    if (ch === '"' || ch === "'") { scanQuoted(s, ch); continue; }
    if (ch === '{') {
      blocks.push(atRule !== null && CSS_RULE_BLOCKS.test(atRule) ? 'rules' : 'decls');
      atRule = null;
      inValue = false;
      s.take('punct', 1);
      continue;
    }
    if (ch === '}') {
      blocks.pop();
      inValue = false;
      s.take('punct', 1);
      continue;
    }
    if (ch === ';') {
      atRule = null;
      inValue = false;
      s.take('punct', 1);
      continue;
    }
    if (ch === '@') {
      const word = matchAt(s, /@[\w-]+/y);
      if (word) {
        atRule = word;
        s.take('keyword', word.length);
        continue;
      }
    }
    if (inDecls() && !inValue && atRule === null) {
      // A declaration, unless a `{` comes before the next `;` or `}` — then it
      // is a nested rule's selector (`&:hover { … }`).
      const rest = /[;{}]/g;
      rest.lastIndex = s.pos;
      const stop = rest.exec(s.src);
      if (stop?.[0] !== '{') {
        const property = matchAt(s, /-{0,2}[A-Za-z_][\w-]*/y);
        if (property && nextNonSpace(s.src, s.pos + property.length) === ':') {
          s.take('property', property.length);
          continue;
        }
        if (ch === ':') { inValue = true; s.take('punct', 1); continue; }
      }
    }
    if (inValue || atRule !== null) {
      if (ch === '#') {
        const hex = matchAt(s, /#[\da-fA-F]{3,8}\b/y);
        if (hex) { s.take('number', hex.length); continue; }
      }
      const number = matchAt(s, /[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?(?:%|[A-Za-z]+)?/y);
      if (number && /\d/.test(number)) { s.take('number', number.length); continue; }
      if (ch === '!') {
        const important = matchAt(s, /!\s*important\b/iy);
        if (important) { s.take('keyword', important.length); continue; }
      }
      const word = matchAt(s, /-{0,2}[A-Za-z_][\w-]*/y);
      if (word) {
        s.take(s.peek(word.length) === '(' ? 'function' : 'plain', word.length);
        continue;
      }
      s.take('punct', 1);
      continue;
    }
    // A selector: element names, classes, ids, pseudo-classes and attributes.
    const selector = matchAt(s, /(?:::?|[.#])?-?[A-Za-z_][\w-]*|\*|&/y);
    if (selector) { s.take('tag', selector.length); continue; }
    if (ch === '[') {
      const end = s.src.indexOf(']', s.pos);
      const close = end < 0 || end > lineEnd(s.src, s.pos) ? s.pos + 1 : end + 1;
      s.take('attr', close - s.pos);
      continue;
    }
    s.take('punct', 1);
  }
}

// --- SQL ----------------------------------------------------------------------

const SQL_KEYWORDS = new Set([
  'add', 'all', 'alter', 'and', 'any', 'as', 'asc', 'begin', 'between', 'by', 'cascade', 'case', 'check', 'column',
  'commit', 'conflict', 'constraint', 'create', 'cross', 'database', 'default', 'delete', 'desc', 'distinct', 'do',
  'drop', 'else', 'end', 'except', 'exists', 'explain', 'foreign', 'from', 'full', 'group', 'having', 'if', 'in',
  'index', 'inner', 'insert', 'intersect', 'into', 'is', 'join', 'key', 'left', 'like', 'limit', 'natural', 'not',
  'nothing', 'offset', 'on', 'or', 'order', 'outer', 'over', 'partition', 'pragma', 'primary', 'references',
  'replace', 'returning', 'right', 'rollback', 'select', 'set', 'table', 'then', 'transaction', 'trigger', 'union',
  'unique', 'update', 'upsert', 'using', 'values', 'view', 'when', 'where', 'window', 'with', 'autoincrement',
  'integer', 'int', 'text', 'real', 'blob', 'varchar', 'char', 'boolean', 'date', 'timestamp', 'numeric', 'float',
]);
const SQL_LITERALS = new Set(['null', 'true', 'false']);

function scanSql(s: Scanner): void {
  while (!s.done) {
    const ch = s.peek();
    if (/\s/.test(ch)) { s.take('plain', 1); continue; }
    if (s.startsWith('--')) {
      s.take('comment', lineEnd(s.src, s.pos) - s.pos);
      continue;
    }
    if (s.startsWith('/*')) {
      const end = s.src.indexOf('*/', s.pos + 2);
      s.take('comment', (end < 0 ? s.src.length : end + 2) - s.pos);
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      // SQL escapes a quote by doubling it: 'it''s' is one string.
      let end = s.pos + 1;
      while (end < s.src.length) {
        if (s.src[end] === ch) {
          if (s.src[end + 1] === ch) { end += 2; continue; }
          end++;
          break;
        }
        end++;
      }
      s.take(ch === "'" ? 'string' : 'property', Math.min(end, s.src.length) - s.pos);
      continue;
    }
    if (/\d/.test(ch) || (ch === '.' && /\d/.test(s.peek(1)))) { s.take('number', readNumber(s)); continue; }
    if ((ch === ':' || ch === '@' || ch === '$') && /[\w]/.test(s.peek(1))) {
      const param = matchAt(s, /[:@$][\w]+/y);
      if (param) { s.take('mark', param.length); continue; }
    }
    if (ch === '?') { s.take('mark', 1); continue; }
    if (/[A-Za-z_]/.test(ch)) {
      const word = readIdentifier(s);
      const lower = word.toLowerCase();
      let kind: TokenKind = 'plain';
      if (SQL_LITERALS.has(lower)) kind = 'literal';
      else if (nextNonSpace(s.src, s.pos + word.length) === '(' && !SQL_KEYWORDS.has(lower)) kind = 'function';
      else if (SQL_KEYWORDS.has(lower)) kind = 'keyword';
      s.take(kind, word.length);
      continue;
    }
    s.take('punct', 1);
  }
}

// --- Markup: SoftN and HTML -------------------------------------------------------

const DIRECTIVE = /#(?:if|elseif|else|each|empty|end|for|await|then|catch)\b/y;

/** `{ … }` in markup: the braces in coral, what is inside as JavaScript. */
function scanExpression(s: Scanner): void {
  s.take('mark', 1);
  scanJs(s, true);
  if (s.peek() === '}') s.take('mark', 1);
}

type Markup = 'softn' | 'html';

function scanTag(s: Scanner, markup: Markup): string | null {
  const open = s.peek(1) === '/' ? '</' : '<';
  const tagName = matchAt(s, /[A-Za-z][\w.:-]*/y, s.pos + open.length);
  if (!tagName) {
    s.take('plain', 1);
    return null;
  }
  s.take('punct', open.length);
  s.take('tag', tagName.length);
  const closing = open === '</';
  while (!s.done) {
    const ch = s.peek();
    if (s.startsWith('/>')) { s.take('punct', 2); return null; }
    if (ch === '>') { s.take('punct', 1); return closing ? null : tagName.toLowerCase(); }
    if (/\s/.test(ch)) { s.take('plain', 1); continue; }
    if (ch === '{' && markup === 'softn') { scanExpression(s); continue; }
    if (ch === '"' || ch === "'") {
      const end = s.src.indexOf(ch, s.pos + 1);
      s.take('string', (end < 0 ? s.src.length : end + 1) - s.pos);
      continue;
    }
    const attr = matchAt(s, /[@:]?[\w:.-]+/y);
    if (attr) {
      // `@click`, `:bind` are the language's own; a plain attribute is dim.
      s.take(markup === 'softn' && /^[@:]/.test(attr) ? 'mark' : 'attr', attr.length);
      continue;
    }
    if (ch === '<') return null; // an unclosed tag: let the caller start again
    s.take('punct', 1);
  }
  return null;
}

/** Raw element content up to its closing tag, scanned by `inner`. */
function scanRawContent(s: Scanner, name: string, inner: ((s: Scanner) => void) | null): void {
  const closer = new RegExp(`</${name}\\b`, 'ig');
  closer.lastIndex = s.pos;
  const close = closer.exec(s.src);
  const end = close ? close.index : s.src.length;
  if (!inner) {
    s.take('plain', end - s.pos);
    return;
  }
  s.embed(s.src.slice(s.pos, end), inner);
}

function scanMarkup(s: Scanner, markup: Markup): void {
  while (!s.done) {
    const ch = s.peek();
    if (s.startsWith('<!--')) {
      const end = s.src.indexOf('-->', s.pos + 4);
      s.take('comment', (end < 0 ? s.src.length : end + 3) - s.pos);
      continue;
    }
    if (ch === '<' && s.peek(1) === '!') {
      // <!DOCTYPE html>, <![CDATA[ … ]]>
      const end = s.src.indexOf('>', s.pos);
      s.take('keyword', (end < 0 ? s.src.length : end + 1) - s.pos);
      continue;
    }
    if (ch === '<' && /[A-Za-z/]/.test(s.peek(1))) {
      const opened = scanTag(s, markup);
      if (opened === 'style') scanRawContent(s, 'style', markup === 'html' ? scanCss : null);
      else if (opened === 'script' || (markup === 'softn' && opened === 'logic')) {
        scanRawContent(s, opened, (sub) => scanJs(sub));
      }
      continue;
    }
    if (markup === 'html' && ch === '&') {
      const entity = matchAt(s, /&(?:#\d+|#x[\da-fA-F]+|[A-Za-z][\w]*);/y);
      if (entity) { s.take('literal', entity.length); continue; }
    }
    if (markup === 'softn' && ch === '{') { scanExpression(s); continue; }
    if (markup === 'softn' && ch === '#' && s.atLineStart()) {
      const directive = matchAt(s, DIRECTIVE);
      if (directive) {
        s.take('mark', directive.length);
        // The rest of the line — `(item in books)` — is an expression.
        s.embed(s.src.slice(s.pos, lineEnd(s.src, s.pos)), (sub) => scanJs(sub));
        continue;
      }
    }
    s.take('plain', 1);
  }
}

// --- Markdown -----------------------------------------------------------------

/** The scanner for a fenced block's info string, when it names one we read. */
function fenceLanguage(info: string): CodeLanguage | null {
  const name = info.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  const aliases: Record<string, CodeLanguage> = {
    js: 'javascript', javascript: 'javascript', jsx: 'javascript', mjs: 'javascript',
    ts: 'typescript', typescript: 'typescript', tsx: 'typescript',
    py: 'python', python: 'python', json: 'json', html: 'html', xml: 'html', svg: 'html',
    css: 'css', sql: 'sql', softn: 'softn', ui: 'softn',
  };
  return aliases[name] ?? null;
}

/**
 * Markdown, a line at a time: headings, fences, quotes, list markers and rules
 * by what a line starts with; code spans, emphasis and links within a line.
 * Emphasis is coloured, never bolded or slanted — the text under CodeEditor's
 * textarea must keep the width of every character.
 */
function scanMarkdown(s: Scanner): void {
  while (!s.done) {
    const end = lineEnd(s.src, s.pos);
    const line = s.src.slice(s.pos, end);
    const fence = /^(\s{0,3})(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      s.take('plain', fence[1].length);
      s.take('mark', fence[2].length + fence[3].length);
      const marker = fence[2];
      // The block runs to a line that closes it with the same fence, or the end.
      let bodyStart = end < s.src.length ? end + 1 : end;
      if (end < s.src.length) s.take('plain', 1);
      let close = bodyStart;
      let closeLineEnd = s.src.length;
      let closed = false;
      while (close < s.src.length) {
        const nextEnd = lineEnd(s.src, close);
        const candidate = s.src.slice(close, nextEnd);
        if (new RegExp(`^\\s{0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`).test(candidate)) {
          closeLineEnd = nextEnd;
          closed = true;
          break;
        }
        close = nextEnd + 1;
      }
      const bodyEnd = closed ? close : s.src.length;
      bodyStart = Math.min(bodyStart, bodyEnd);
      const language = fenceLanguage(fence[3]);
      const body = s.src.slice(bodyStart, bodyEnd);
      if (language) s.embed(body, (sub) => scanInto(sub, language));
      else s.take('string', body.length);
      if (closed) s.take('mark', closeLineEnd - s.pos);
      continue;
    }
    const heading = /^\s{0,3}#{1,6}(?:\s.*)?$/.exec(line);
    if (heading) {
      s.take('keyword', line.length);
    } else if (/^\s{0,3}(?:[-*_]\s*){3,}$/.test(line)) {
      s.take('punct', line.length);
    } else {
      const lead = /^(\s*)((?:>\s?)+)?(\s*)((?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?)?/.exec(line)!;
      s.take('plain', lead[1].length);
      if (lead[2]) s.take('comment', lead[2].length);
      s.take('plain', lead[3].length);
      if (lead[4]) s.take('punct', lead[4].length);
      scanMarkdownInline(s, end);
    }
    if (!s.done) s.take('plain', 1); // the newline
  }
}

function scanMarkdownInline(s: Scanner, end: number): void {
  while (s.pos < end) {
    const ch = s.peek();
    if (ch === '\\' && s.pos + 1 < end) { s.take('plain', 2); continue; }
    if (ch === '`') {
      const ticks = matchAt(s, /`+/y)!;
      const close = s.src.indexOf(ticks, s.pos + ticks.length);
      if (close >= 0 && close < end) {
        s.take('string', close + ticks.length - s.pos);
        continue;
      }
      s.take('plain', ticks.length);
      continue;
    }
    if (ch === '!' || ch === '[') {
      const link = matchAt(s, /!?\[[^\]\n]*\]\([^)\n]*\)/y);
      if (link) { s.take('function', link.length); continue; }
    }
    if (ch === '<') {
      const auto = matchAt(s, /<(?:https?:\/\/|mailto:)[^>\s]+>/y);
      if (auto) { s.take('function', auto.length); continue; }
    }
    if (ch === '*' || ch === '_' || ch === '~') {
      const previous = s.pos > 0 ? s.src[s.pos - 1] : ' ';
      // `snake_case_name` is not emphasis; `*` may open mid-word.
      if (ch !== '_' || !/\w/.test(previous)) {
        const emphasis = ch === '~'
          ? matchAt(s, /~~(?!\s)[^~\n]+?~~/y)
          : matchAt(s, ch === '*' ? /(\*{1,3})(?!\s)[^*\n]+?\1(?!\*)/y : /(_{1,3})(?!\s)[^_\n]+?\1(?!\w)/y);
        if (emphasis && s.pos + emphasis.length <= end) { s.take('mark', emphasis.length); continue; }
      }
    }
    s.take('plain', 1);
  }
}

// --- Entry points -----------------------------------------------------------------

function scanInto(s: Scanner, language: CodeLanguage): void {
  switch (language) {
    case 'javascript': scanJs(s); break;
    case 'typescript': s.typescript = true; scanJs(s); break;
    case 'python': scanPython(s); break;
    case 'json': scanJson(s); break;
    case 'css': scanCss(s); break;
    case 'sql': scanSql(s); break;
    case 'html': scanMarkup(s, 'html'); break;
    case 'softn': scanMarkup(s, 'softn'); break;
    case 'markdown': scanMarkdown(s); break;
    default: s.push('plain', s.src.slice(s.pos)); s.pos = s.src.length;
  }
}

/** Whether `value` names a language the scanners read. */
export function isCodeLanguage(value: unknown): value is CodeLanguage {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(LANGUAGE_LABEL, value);
}

/**
 * The source as a flat list of tokens whose texts join back to it exactly.
 * An unknown language is read as plain text.
 */
export function tokenize(source: string, language: CodeLanguage): Token[] {
  const s = new Scanner(source);
  scanInto(s, isCodeLanguage(language) ? language : 'plain');
  // A scanner that stopped early (it never should) must still account for
  // every character: the rest is plain text rather than missing.
  if (s.pos < source.length) s.push('plain', source.slice(s.pos));
  return s.tokens;
}

/** The tokens split into lines, for a view with line numbers. A token spanning lines is cut at each newline. */
export function tokenizeLines(source: string, language: CodeLanguage): Token[][] {
  const lines: Token[][] = [[]];
  for (const token of tokenize(source, language)) {
    const parts = token.text.split('\n');
    parts.forEach((part, index) => {
      if (index > 0) lines.push([]);
      if (part) lines[lines.length - 1].push({ kind: token.kind, text: part });
    });
  }
  return lines;
}
