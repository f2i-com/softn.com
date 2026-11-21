/**
 * Universal ES Module Linker & Specifier Resolver for ZIPP Container Workers.
 *
 * Transforms standard ES module syntax (`import`, `export`, `import()`,
 * `import.meta`) — including minified Vite / Rollup / ESBuild chunks and
 * TypeScript modules — into async module factories registered on
 * `globalThis.__softnModules`.
 *
 * Why a lexical token scanner rather than regexes or Acorn?
 * - Regexes corrupt strings, template literals, comments, and regex literals in minified bundles.
 * - Bundling Acorn adds ~120 KB and fails on TypeScript syntax (`interface`, `type`, `: Type`).
 * - The scanner handles minified JavaScript and TypeScript without adding a parser to the worker.
 */

import { generatedFrameworkPath } from '@softn/bundle-format/source-modules';
import { resolveVfsPath, VIRTUAL_ORIGIN } from './archive';

export type ResolvedSpecifier =
  | { kind: 'vfs'; path: string; url: string }
  | { kind: 'builtin'; name: string; url: string }
  | { kind: 'vendor'; name: string; url: string }
  | { kind: 'remote'; url: string };

/** Built-in hosted vendor libraries available without bundling. */
export const DEFAULT_VENDOR_IMPORT_MAP: Readonly<Record<string, string>> = {
  three: 'softn-vendor:three',
  'three/addons/': 'softn-vendor:three/addons/',
  marked: 'softn-vendor:marked',
  htm: 'softn-vendor:htm',
  preact: 'softn-vendor:preact',
  'preact/hooks': 'softn-vendor:preact/hooks',
  'preact/jsx-runtime': 'softn-vendor:preact/jsx-runtime',
  'preact/jsx-dev-runtime': 'softn-vendor:preact/jsx-dev-runtime',
  react: 'softn-vendor:react',
  'react-dom': 'softn-vendor:react-dom',
  'react-dom/client': 'softn-vendor:react-dom/client',
  'react/jsx-runtime': 'softn-vendor:react/jsx-runtime',
  'react/jsx-dev-runtime': 'softn-vendor:react/jsx-dev-runtime',
};

/**
 * Whether a hosted vendor library's name may be asked for: segments of letters, digits and
 * `._@-`, none starting with a dot. The name becomes a path under the runtime's own folder,
 * on the embedding site: `x/../../../api/me#` asked that site for /api/me.
 */
export function safeVendorName(name: string): boolean {
  if (!name || name.length > 200) return false;
  return name.split('/').every((segment) => /^[A-Za-z0-9@][A-Za-z0-9._@-]*$/.test(segment));
}

/** Resolve an ES module specifier from `importerPath` using importMap, VFS, `softn:*`, and `/runtime/vendor/`. */
export function resolveModuleSpecifier(
  specifier: string,
  importerPath: string,
  importMap: Readonly<Record<string, string>> = {},
  hasVfsFile?: (path: string) => boolean
): ResolvedSpecifier {
  const raw = specifier.trim();

  // 1. Check user/HTML importmap exact match or prefix match (`pkg/` -> `./vendor/pkg/`)
  let mapped = importMap[raw];
  if (!mapped) {
    for (const [prefix, target] of Object.entries(importMap)) {
      if (prefix.endsWith('/') && raw.startsWith(prefix)) {
        mapped = target + raw.slice(prefix.length);
        break;
      }
    }
  }
  // An editor export carries these libraries locally, including for imported component
  // sources that use npm names. Explicit project import maps always take precedence.
  if (!mapped && hasVfsFile && (raw === 'react' || raw === 'react-dom/client' || raw === 'vue')) {
    const framework = raw === 'vue' ? 'vue' : 'react';
    const local = 'vendor/' + framework + '.js';
    const generated = generatedFrameworkPath(framework);
    if (hasVfsFile(local)) mapped = '/' + local;
    else if (hasVfsFile(generated)) mapped = '/' + generated;
  }
  // 2. Check SoftN default hosted vendor catalog
  if (!mapped) {
    mapped = DEFAULT_VENDOR_IMPORT_MAP[raw];
    if (!mapped) {
      for (const [prefix, target] of Object.entries(DEFAULT_VENDOR_IMPORT_MAP)) {
        if (prefix.endsWith('/') && raw.startsWith(prefix)) {
          mapped = target + raw.slice(prefix.length);
          break;
        }
      }
    }
  }

  const effective = mapped ?? raw;

  if (effective.startsWith('softn:')) {
    const name = effective.slice('softn:'.length);
    return { kind: 'builtin', name, url: effective };
  }

  if (effective.startsWith('softn-vendor:')) {
    const name = effective.slice('softn-vendor:'.length);
    return { kind: 'vendor', name, url: effective };
  }

  // Relative (`./`, `../`), root-relative (`/`), or virtual-origin VFS path
  const isRelativeOrVfsUrl =
    effective.startsWith('./') ||
    effective.startsWith('../') ||
    effective.startsWith('/') ||
    effective.startsWith(VIRTUAL_ORIGIN + '/');

  if (isRelativeOrVfsUrl) {
    const vfsCandidate = resolveVfsPath(effective, importerPath);
    if (vfsCandidate) {
      let finalPath = vfsCandidate;
      if (hasVfsFile && !hasVfsFile(finalPath)) {
        for (const ext of ['.js', '.mjs', '.ts', '.tsx', '.jsx', '/index.js', '/index.ts', '/index.tsx', '/index.jsx', '.vue', '/index.vue']) {
          if (hasVfsFile(finalPath + ext)) {
            finalPath = finalPath + ext;
            break;
          }
        }
      }
      return { kind: 'vfs', path: finalPath, url: `${VIRTUAL_ORIGIN}/${finalPath}` };
    }
  }

  if (/^https?:\/\//i.test(effective)) {
    return { kind: 'remote', url: effective };
  }

  // Bare specifier not in default map -> treat as hosted `/runtime/vendor/<specifier>`
  return { kind: 'vendor', name: effective, url: `softn-vendor:${effective}` };
}

// ============================================================================
// Lexical Scanner & ESM Transformer
// ============================================================================

interface Token {
  type: 'ident' | 'keyword' | 'punct' | 'string' | 'other';
  value: string;
  start: number;
  end: number;
}

const REGEX_PRECEDING_KEYWORDS = new Set([
  'return', 'throw', 'case', 'delete', 'void', 'typeof', 'instanceof', 'in', 'of', 'new', 'yield', 'await', 'else', 'do',
]);
const REGEX_PRECEDING_PUNCT = new Set([
  '(', '[', '{', ',', ';', ':', '=', '!', '&', '|', '?', '+', '-', '*', '%', '^', '~', '<', '>',
]);

function isIdentStart(ch: number): boolean {
  return (ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122) || ch === 95 || ch === 36 || ch > 127;
}
function isIdentPart(ch: number): boolean {
  return isIdentStart(ch) || (ch >= 48 && ch <= 57);
}

/** Tokenize JS/TS code skipping comments, strings, template literals, and regex literals accurately. */
function tokenizeTopLevel(code: string): Token[] {
  const tokens: Token[] = [];
  const len = code.length;
  let i = 0;
  let prevSig: Token | null = null;

  const canStartRegex = (): boolean => {
    if (!prevSig) return true;
    if (prevSig.type === 'keyword') return REGEX_PRECEDING_KEYWORDS.has(prevSig.value);
    if (prevSig.type === 'punct') return REGEX_PRECEDING_PUNCT.has(prevSig.value);
    return false;
  };

  const skipTemplate = (): void => {
    i++; // opening `
    while (i < len) {
      const ch = code.charCodeAt(i);
      if (ch === 92 /* \ */) {
        i += 2;
        continue;
      }
      if (ch === 96 /* ` */) {
        i++;
        return;
      }
      if (ch === 36 /* $ */ && code.charCodeAt(i + 1) === 123 /* { */) {
        i += 2;
        let depth = 1;
        let prevKind: 'punct' | 'kw' | 'other' = 'punct';
        let prevVal = '{';
        while (i < len && depth > 0) {
          const c = code.charCodeAt(i);
          if (c <= 32) { i++; continue; }
          if (c === 92) { i += 2; prevKind = 'other'; prevVal = ''; continue; }
          if (c === 39 || c === 34) { skipString(c); prevKind = 'other'; prevVal = ''; continue; }
          if (c === 96) { skipTemplate(); prevKind = 'other'; prevVal = ''; continue; }
          if (c === 47) {
            const nxt = code.charCodeAt(i + 1);
            if (nxt === 47) { skipLineComment(); continue; }
            if (nxt === 42) { skipBlockComment(); continue; }
            if (
              (prevKind === 'punct' && REGEX_PRECEDING_PUNCT.has(prevVal)) ||
              (prevKind === 'kw' && REGEX_PRECEDING_KEYWORDS.has(prevVal))
            ) {
              skipRegex();
              prevKind = 'other';
              prevVal = '';
              continue;
            }
            i++;
            prevKind = 'punct';
            prevVal = '/';
            continue;
          }
          if (isIdentStart(c)) {
            const st = i;
            i++;
            while (i < len && isIdentPart(code.charCodeAt(i))) i++;
            const w = code.slice(st, i);
            prevKind = REGEX_PRECEDING_KEYWORDS.has(w) ? 'kw' : 'other';
            prevVal = w;
            continue;
          }
          if (c === 123) { depth++; prevKind = 'punct'; prevVal = '{'; i++; continue; }
          if (c === 125) { depth--; prevKind = 'punct'; prevVal = '}'; i++; continue; }
          prevKind = 'punct';
          prevVal = code[i];
          i++;
        }
        continue;
      }
      i++;
    }
  };

  const skipString = (quote: number): void => {
    i++;
    while (i < len) {
      const ch = code.charCodeAt(i);
      if (ch === 92) { i += 2; continue; }
      i++;
      if (ch === quote) return;
    }
  };

  const skipLineComment = (): void => {
    i += 2;
    while (i < len && code.charCodeAt(i) !== 10 && code.charCodeAt(i) !== 13) i++;
  };

  const skipBlockComment = (): void => {
    i += 2;
    while (i < len) {
      if (code.charCodeAt(i) === 42 && code.charCodeAt(i + 1) === 47) {
        i += 2;
        return;
      }
      i++;
    }
  };

  const skipRegex = (): void => {
    i++; // opening /
    let inClass = false;
    while (i < len) {
      const ch = code.charCodeAt(i);
      if (ch === 92) { i += 2; continue; }
      if (ch === 91 /* [ */) inClass = true;
      else if (ch === 93 /* ] */) inClass = false;
      else if (ch === 47 /* / */ && !inClass) {
        i++;
        while (i < len && isIdentPart(code.charCodeAt(i))) i++;
        return;
      } else if (ch === 10 || ch === 13) {
        return;
      }
      i++;
    }
  };

  while (i < len) {
    const ch = code.charCodeAt(i);
    if (ch <= 32 || ch === 0xfeff) {
      i++;
      continue;
    }
    if (ch === 47 /* / */) {
      const next = code.charCodeAt(i + 1);
      if (next === 47) { skipLineComment(); continue; }
      if (next === 42) { skipBlockComment(); continue; }
      if (canStartRegex()) {
        const start = i;
        skipRegex();
        const tok: Token = { type: 'other', value: code.slice(start, i), start, end: i };
        tokens.push(tok);
        prevSig = tok;
        continue;
      }
    }
    if (ch === 39 || ch === 34) {
      const start = i;
      skipString(ch);
      const tok: Token = { type: 'string', value: code.slice(start, i), start, end: i };
      tokens.push(tok);
      prevSig = tok;
      continue;
    }
    if (ch === 96) {
      const start = i;
      skipTemplate();
      const tok: Token = { type: 'string', value: code.slice(start, i), start, end: i };
      tokens.push(tok);
      prevSig = tok;
      continue;
    }
    if (isIdentStart(ch)) {
      const start = i;
      i++;
      while (i < len && isIdentPart(code.charCodeAt(i))) i++;
      const word = code.slice(start, i);
      const isKw =
        word === 'import' || word === 'export' || word === 'from' || word === 'as' ||
        word === 'default' || word === 'function' || word === 'class' || word === 'const' ||
        word === 'let' || word === 'var' || word === 'async' || word === 'type' ||
        word === 'interface' || word === 'enum' || REGEX_PRECEDING_KEYWORDS.has(word);
      const tok: Token = { type: isKw ? 'keyword' : 'ident', value: word, start, end: i };
      tokens.push(tok);
      prevSig = tok;
      continue;
    }
    // Numbers
    if (ch >= 48 && ch <= 57) {
      const start = i;
      i++;
      while (i < len && (isIdentPart(code.charCodeAt(i)) || code.charCodeAt(i) === 46)) i++;
      const tok: Token = { type: 'other', value: code.slice(start, i), start, end: i };
      tokens.push(tok);
      prevSig = tok;
      continue;
    }
    // Punctuation
    const start = i;
    const chStr = code[i];
    i++;
    const tok: Token = { type: 'punct', value: chStr, start, end: i };
    tokens.push(tok);
    prevSig = tok;
  }

  return tokens;
}

/**
 * A dynamic `import(...)` at `tokens[i]`: where its call closes, its first comma at its own
 * level (a second argument of the script's own, `import(spec, { with: { type: 'json' } })`, is
 * dropped for the importer's address: appended after one, the address landed in a third place
 * the loader never reads), and the module it names as text when that is all its first argument
 * is. None for `obj.import(`, none for a method of that name (`import(url) { … }` in a class
 * or an object), and none for a TypeScript type (`let api: import('./api').Api`, `typeof
 * import('./api')`): each was rewritten as a call, and the script then did not parse (a
 * TypeScript module with such a type stopped the whole app). As values neither means anything.
 */
/** What may come before the name of a member of a class (TypeScript's among them). */
const MEMBER_MODIFIERS = new Set(['public', 'private', 'protected', 'static', 'readonly', 'async', 'abstract', 'override', 'declare', 'get', 'set', 'accessor']);

function dynamicImportAt(tokens: Token[], i: number): { close: number; firstComma: number; named: string | null } | null {
  const tok = tokens[i];
  const prev = i > 0 ? tokens[i - 1] : null;
  if (tok.value !== 'import' || prev?.value === '.' || prev?.value === '#' || prev?.value === 'function' || prev?.value === 'typeof' || tokens[i + 1]?.value !== '(') return null;
  let depth = 1;
  let nested = 0;
  let firstComma = -1;
  let j = i + 2;
  while (j < tokens.length && depth > 0) {
    if (tokens[j].type === 'punct') {
      const value = tokens[j].value;
      if (value === '(') depth++;
      else if (value === ')') depth--;
      else if (value === '[' || value === '{') nested++;
      else if (value === ']' || value === '}') nested = Math.max(0, nested - 1);
      else if (value === ',' && depth === 1 && nested === 0 && firstComma < 0) firstComma = j;
    }
    if (depth === 0) break;
    j++;
  }
  if (j >= tokens.length || tokens[j + 1]?.value === '{') return null;
  // A member of TypeScript's with a return type (`import(id: string): Promise<T>;` in an
  // interface, a type or a class): where a member begins, its parentheses then a colon. (A
  // colon after a call is a ternary's, `c ? import(a) : import(b)`, where no member begins.)
  if (tokens[j + 1]?.value === ':' && (prev === null || prev.value === '{' || prev.value === ';' || prev.value === '}' || prev.value === ',' || MEMBER_MODIFIERS.has(prev.value))) return null;
  const member = tokens[j + 2];
  if (tokens[j + 1]?.value === '.' && member !== undefined && (member.type === 'ident' || member.type === 'keyword') && member.value !== 'then' && member.value !== 'catch' && member.value !== 'finally') return null;
  const named = tokens[i + 2];
  const after = tokens[i + 3];
  const isNamed = named?.type === 'string' && (named.value[0] === '"' || named.value[0] === "'") && after !== undefined && (after === tokens[j] || (firstComma >= 0 && after === tokens[firstComma]));
  return { close: j, firstComma, named: isNamed ? unquote(named.value) : null };
}

/**
 * A classic script's `import()` calls, made the container's: each asks the app's modules
 * (`__softnModules.import`) for its module, resolved against the script's own address, as a
 * browser resolves a classic script's. The engine's own `import()` refused every module with
 * no word of why, so a page that started itself with `<script>import('./app.js')</script>` ran
 * nothing. Returned with the modules it names as text, to be compiled with the program.
 */
export function classicImportsRewritten(code: string, importerUrl: string): { code: string; named: string[] } {
  if (!/\bimport\s*\(/.test(code)) return { code, named: [] };
  const tokens = tokenizeTopLevel(code);
  const edits: Array<{ start: number; end: number; replacement: string }> = [];
  const named: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const dynamic = dynamicImportAt(tokens, i);
    if (!dynamic) continue;
    edits.push({ start: tokens[i].start, end: tokens[i].end, replacement: '__softnModules.import' });
    edits.push({ start: tokens[dynamic.firstComma < 0 ? dynamic.close : dynamic.firstComma].start, end: tokens[dynamic.close].end, replacement: `, ${JSON.stringify(importerUrl)})` });
    if (dynamic.named !== null) named.push(dynamic.named);
  }
  if (edits.length === 0) return { code, named };
  edits.sort((a, b) => b.start - a.start);
  let body = code;
  for (const edit of edits) body = body.slice(0, edit.start) + edit.replacement + body.slice(edit.end);
  return { code: body, named };
}

/**
 * Whether code is a module's: an `import` or `export` statement at its top, which no classic
 * script can have (it would not parse). Such a file is never compiled as a classic script.
 */
export function looksLikeModule(code: string): boolean {
  if (!/\b(?:import|export)\b/.test(code)) return false;
  const tokens = tokenizeTopLevel(code);
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.type === 'punct') {
      if (tok.value === '{' || tok.value === '(' || tok.value === '[') depth++;
      else if (tok.value === '}' || tok.value === ')' || tok.value === ']') depth = Math.max(0, depth - 1);
      continue;
    }
    if ((depth !== 0 && tok.value !== 'import') || (tok.value !== 'import' && tok.value !== 'export')) continue;
    // import.meta anywhere: only a module has it.
    if (depth !== 0) {
      if (tokens[i + 1]?.value === '.' && tokens[i + 2]?.value === 'meta' && tokens[i - 1]?.value !== '.') return true;
      continue;
    }
    const prev = i > 0 ? tokens[i - 1].value : '';
    if (prev === '.' || prev === '#') continue;
    if (tok.value === 'export') return true;
    const next = tokens[i + 1]?.value;
    if (next !== undefined && next !== '(' && next !== '.') return true;
    // import.meta, which only a module has.
    if (next === '.' && tokens[i + 2]?.value === 'meta') return true;
  }
  return false;
}

function unquote(lit: string): string {
  if (lit.length >= 2 && (lit[0] === '"' || lit[0] === "'")) {
    try {
      if (lit[0] === '"') return JSON.parse(lit) as string;
      return lit.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, '\\');
    } catch {
      return lit.slice(1, -1);
    }
  }
  return lit;
}

/** Words the tokenizer reads as keywords that are still names where a binding is written (`const type = 1`). */
const NAME_KEYWORDS = new Set(['type', 'as', 'from', 'of', 'async', 'interface']);

/**
 * The names a JS/TS declaration list binds (`const a = 1, { b, c: d = e.f } = x, [g, ...h] = y`):
 * each declarator's binding read as a name or a pattern, and its type and its value skipped.
 * A default value inside a pattern is an expression, not a binding: its names were taken for
 * bindings (`{ a = defaults.size }` bound `size`), and a script's later read of that name
 * went round in a circle.
 */
function extractDeclaredNames(tokens: Token[], startIdx: number, endIdx: number): string[] {
  const names: string[] = [];
  const at = (k: number): Token | undefined => (k < endIdx ? tokens[k] : undefined);
  const punct = (k: number, value: string): boolean => at(k)?.type === 'punct' && at(k)?.value === value;
  const nameAt = (k: number): boolean => at(k)?.type === 'ident' || (at(k)?.type === 'keyword' && NAME_KEYWORDS.has(at(k)!.value));
  // To one of `stops` at this level, or to the bracket that closes it, past an expression or a type.
  const skip = (k: number, stops: string[], angles = false): number => {
    let depth = 0;
    let angle = 0;
    while (k < endIdx) {
      const t = tokens[k];
      if (t.type === 'punct') {
        if (depth === 0 && angle === 0 && stops.includes(t.value)) return k;
        if (t.value === '(' || t.value === '[' || t.value === '{') depth++;
        else if (t.value === ')' || t.value === ']' || t.value === '}') {
          if (depth === 0) return k;
          depth--;
        } else if (angles && t.value === '<') angle++;
        else if (angles && t.value === '>' && angle > 0) angle--;
      }
      k++;
    }
    return k;
  };
  const binding = (k: number): number => {
    if (nameAt(k)) {
      names.push(at(k)!.value);
      return k + 1;
    }
    if (punct(k, '{')) return objectPattern(k);
    if (punct(k, '[')) return arrayPattern(k);
    return k + 1;
  };
  const objectPattern = (k: number): number => {
    k++;
    while (k < endIdx && !punct(k, '}')) {
      if (punct(k, ',')) {
        k++;
        continue;
      }
      if (punct(k, '.')) {
        while (punct(k, '.')) k++;
        k = binding(k);
      } else {
        // A property's name (a word, a string, a number, or computed), then its binding or itself.
        const key = k;
        k = punct(k, '[') ? skip(k + 1, [']']) + 1 : k + 1;
        if (punct(k, ':')) k = binding(k + 1);
        else if (nameAt(key)) names.push(at(key)!.value);
      }
      if (punct(k, '=')) k = skip(k + 1, [',', '}']);
    }
    return k + 1;
  };
  const arrayPattern = (k: number): number => {
    k++;
    while (k < endIdx && !punct(k, ']')) {
      if (punct(k, ',')) {
        k++;
        continue;
      }
      while (punct(k, '.')) k++;
      k = binding(k);
      if (punct(k, '=')) k = skip(k + 1, [',', ']']);
    }
    return k + 1;
  };
  let i = startIdx;
  while (i < endIdx) {
    const before = i;
    i = binding(i);
    if (punct(i, '!')) i++;
    // A type (TypeScript), then the value, to the next declarator.
    if (punct(i, ':')) i = skip(i + 1, ['=', ','], true);
    if (punct(i, '=')) i = skip(i + 1, [',']);
    if (punct(i, ',') || i === before) i++;
  }
  return names;
}
/**
 * The most of a classic script that is handed to `eval`: the engine compiles 64 KB of code
 * at run time and no more, and a script past that stopped the whole app where it started
 * (jQuery is one; so is every library of any size shipped as one file).
 */
export const MAX_EVAL_SCRIPT_BYTES = 65_000;

/** Whether a classic script is too long to be run by `eval`. */
export function tooLongForEval(code: string): boolean {
  if (code.length * 3 <= MAX_EVAL_SCRIPT_BYTES) return false;
  return new TextEncoder().encode(code).length > MAX_EVAL_SCRIPT_BYTES;
}

/**
 * A classic script written into the program as a function, for one too long for `eval`.
 *
 * A script's top level is the page's global scope: `this` is the global object, and what it
 * declares there the scripts after it can name. In the function standing in for it:
 *
 *   - `this` is the global object;
 *   - a `var` at its top is the global itself, as in a browser: the `var` is taken out, so
 *     its assignments are to the global, and a global that is not there yet is made first.
 *     A declared local was a new variable, undefined until assigned, over the global of that
 *     name: `var Module = typeof Module != 'undefined' ? Module : {}` (Emscripten) lost what
 *     the page had set up, and `var App = App || {}` across files lost what came before;
 *   - a `function`, `class`, `let` or `const` at its top stays the function's own, and the
 *     global of that name reads and writes it.
 *
 * Only a declaration that begins a statement is one (`x = async function f() {}` declares
 * nothing), and a `var` is taken out only where every one of its names is a plain name. The
 * names are found by reading the script's tokens; where brackets do not balance, nothing is
 * changed or made global and `trusted` says so.
 */
export function classicScriptAsFunction(code: string, name: string): { source: string; names: string[]; trusted: boolean } {
  const top = scanTopLevel(code);
  const { trusted } = top;
  // Its functions are the page's, replacing one the page has, as a declaration does in a browser.
  const functions = trusted ? [...top.functions].filter(validGlobalName) : [];
  // Its let, const and class (and a var of a pattern) are the page's where the page has no such name.
  const lexical = new Set<string>([...top.lexical, ...top.otherVars]);
  const names = trusted ? [...lexical].filter((n) => validGlobalName(n) && !top.functions.has(n)) : [];
  const all = new Set<string>([...functions, ...names]);
  const globals = trusted ? [...top.plainVars].filter((n) => validGlobalName(n) && !all.has(n)) : [];
  // Each `var` taken out is a `;`: the statement goes on as assignments (`; a = 1, b`).
  let body = code;
  if (trusted) for (const tok of [...top.takenVars].reverse()) body = `${body.slice(0, tok.start)};${body.slice(tok.end)}`;
  const prologue = [
    top.strict ? " 'use strict';" : '',
    globals.length > 0 ? ` __softnGlobalVars(${JSON.stringify(globals)});` : '',
    functions.length > 0 ? ` __softnGlobals({ ${accessorsFor(functions)} }, false);` : '',
    names.length > 0 ? ` __softnGlobals({ ${accessorsFor(names)} }, true);` : '',
  ].join('');
  const source = `function ${name}() {${prologue}\n${body}\n}`;
  return { source, names: [...functions, ...names, ...globals], trusted };
}

/**
 * A short classic script as eval is handed it, with what eval keeps to itself made the
 * page's globals first. Run by indirect eval, a script's `var`s and functions are the page's;
 * its `let`, `const` and `class` stayed the eval's own, so `<script>const API = '…'</script>`
 * and `<script>fetch(API)</script>` failed where a browser runs them. In a strict script
 * eval keeps everything to itself, so everything is published, after its directive (which
 * must come first for it to be strict). Each is read and written through the global of its
 * name; the script itself is as it was.
 *
 * A name the page has already is left as it is: in a browser, `let history = []` is the
 * script's own and `window.history` stays the page's, and `const requestAnimationFrame =
 * window.requestAnimationFrame || …` reads the page's. (Published over them, the first took
 * `window.history` from every router, and the second read its own uninitialized binding and
 * threw.) Read before its declaration has run, a name published here answers undefined, as
 * `window.X` does.
 */
export function scriptForEval(code: string): string {
  const top = scanTopLevel(code);
  return publishTopLevel(code, top, top.strict);
}

/**
 * A classic TypeScript script, with what it declares at its top made the page's. It is
 * compiled with the app's program (eval at run time would be handed it untranslated), written
 * into a function of the program's, where everything it declares is the function's own: a
 * page whose `<script type="text/typescript">` declared a function the next script called
 * found nothing there. Everything is published, as for a strict script handed to eval.
 */
export function typeScriptScriptPublished(code: string): string {
  return publishTopLevel(code, scanTopLevel(code), true);
}

/** `code` with its top-level names made the page's: let, const and class always; with `everything`, its functions and vars too. */
function publishTopLevel(code: string, top: TopLevel, everything: boolean): string {
  if (!top.trusted) return code;
  const functions = everything ? [...top.functions].filter(validGlobalName) : [];
  const names = new Set<string>(top.lexical);
  if (everything) for (const set of [top.plainVars, top.otherVars]) for (const n of set) if (!top.functions.has(n)) names.add(n);
  const published = [...names].filter(validGlobalName);
  if (published.length === 0 && functions.length === 0) return code;
  const call = [
    functions.length > 0 ? `__softnGlobals({ ${accessorsFor(functions)} }, false);` : '',
    published.length > 0 ? `__softnGlobals({ ${accessorsFor(published)} }, true);` : '',
  ].filter(Boolean).join(' ');
  if (!top.strict) return `${call} ${code}`;
  const directive = top.tokens[0];
  const ended = top.tokens[1]?.type === 'punct' && top.tokens[1].value === ';';
  const at = ended ? top.tokens[1].end : directive.end;
  return `${code.slice(0, at)}${ended ? '' : ';'} ${call}${code.slice(at)}`;
}

/** Names that may be made the page's globals: a plain name, and not one the page's own. */
function validGlobalName(n: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(n) && !RESERVED_GLOBALS.has(n);
}

/** The accessors that read and write each name's binding where the script declared it. */
function accessorsFor(names: string[]): string {
  return names.map((n) => `${JSON.stringify(n)}: [function () { return ${n}; }, function (__softnValue) { ${n} = __softnValue; }]`).join(', ');
}

/** What a classic script declares at its top, by kind. */
interface TopLevel {
  tokens: Token[];
  /** Function declarations (plain, async and generators). */
  functions: Set<string>;
  /** `let`, `const` and `class` declarations. */
  lexical: Set<string>;
  /** Names of a `var` of plain names only, and those `var` keywords. */
  plainVars: Set<string>;
  takenVars: Token[];
  /** Names of a `var` with a pattern in it. */
  otherVars: Set<string>;
  /** False where brackets do not balance: nothing read is trusted. */
  trusted: boolean;
  /** Whether it begins with the directive `'use strict'`. */
  strict: boolean;
}

/**
 * Read a classic script for what it declares at its top. Only a declaration that begins a
 * statement is one (`x = async function f() {}` declares nothing); a declaration that runs
 * over lines ends where a line break ends it.
 */
function scanTopLevel(code: string): TopLevel {
  const tokens = tokenizeTopLevel(code);
  const functions = new Set<string>();
  const lexical = new Set<string>();
  const plainVars = new Set<string>();
  const otherVars = new Set<string>();
  const taken: Token[] = [];
  // Where token k is: at the start of a statement of the script's own ('top'); the statement
  // an `if`, a loop, an `else` or a `do` runs ('nested': a `var` there is the script's too,
  // but taking its keyword out would change what runs); or inside an expression (null). A
  // statement starts after nothing, a `;` or a `}`, or a line break after what does not ask
  // for more (an operator, a word that takes what follows).
  const position = (k: number): 'top' | 'nested' | null => {
    const prev = tokens[k - 1];
    if (!prev) return 'top';
    if (prev.type === 'punct' && (prev.value === ';' || prev.value === '}')) return 'top';
    const broke = /[\r\n]/.test(code.slice(prev.end, tokens[k].start));
    if (prev.type === 'punct' && prev.value === ')') {
      // `foo()` ends a statement where its line ends; `if (x)` is the head of one.
      let open = 0;
      for (let m = k - 1; m >= 0; m--) {
        if (tokens[m].type !== 'punct') continue;
        if (tokens[m].value === ')') open++;
        else if (tokens[m].value === '(' && --open === 0) return STATEMENT_HEADS.has(tokens[m - 1]?.value ?? '') ? 'nested' : broke ? 'top' : null;
      }
      return null;
    }
    if (prev.type === 'keyword' && (prev.value === 'else' || prev.value === 'do')) return 'nested';
    if (!broke) return null;
    // A `++` or `--` after what it changes ends the line's statement.
    if (prev.type === 'punct' && (prev.value === '++' || prev.value === '--')) return 'top';
    const before = tokens[k - 2];
    if (prev.type === 'punct' && (prev.value === '+' || prev.value === '-') && before?.value === prev.value && before.end === prev.start) return 'top';
    if (prev.type === 'punct') return /^[,=:+\-*/%&|^<>?!~.([{]$/.test(prev.value) ? null : 'top';
    // A word that ends what it is in (`this`, `null`, a name the reader takes for a keyword:
    // `type`, `of`, `as`) ends the statement; one that takes what follows (`typeof`, `new`, `in`) does not.
    if (prev.type === 'keyword') return NAME_KEYWORDS.has(prev.value) || ENDING_WORDS.has(prev.value) ? 'top' : null;
    return 'top';
  };
  let depth = 0;
  let trusted = true;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.type === 'punct') {
      if (tok.value === '{' || tok.value === '(' || tok.value === '[') depth++;
      else if (tok.value === '}' || tok.value === ')' || tok.value === ']') {
        depth--;
        if (depth < 0) {
          trusted = false;
          break;
        }
      }
      continue;
    }
    if (depth !== 0) continue;
    const prev = tokens[i - 1];
    // A property or a member named like a keyword is no declaration.
    if (prev && prev.type === 'punct' && prev.value === '.') continue;
    // TypeScript's enum (and const enum) is a value of its name; an abstract class is a class.
    if (tok.value === 'enum' && tokens[i + 1]?.type === 'ident') {
      const head = prev?.value === 'const' ? i - 1 : i;
      if (position(head) === 'top') lexical.add(tokens[i + 1].value);
      i++;
      continue;
    }
    if (tok.value === 'const' && tokens[i + 1]?.value === 'enum') continue;
    if (tok.value === 'abstract' && tokens[i + 1]?.value === 'class' && tokens[i + 2]?.type === 'ident') {
      if (position(i) === 'top') lexical.add(tokens[i + 2].value);
      i += 2;
      continue;
    }
    if (tok.type !== 'keyword') continue;
    if (tok.value === 'async' && tokens[i + 1]?.value === 'function') {
      if (position(i) !== 'top') continue;
      let at = i + 2;
      if (tokens[at]?.value === '*') at++;
      if (tokens[at]?.type === 'ident') functions.add(tokens[at].value);
      i = at;
      continue;
    }
    if (tok.value === 'function' || tok.value === 'class') {
      if (position(i) !== 'top') continue;
      let at = i + 1;
      if (tokens[at]?.value === '*') at++;
      if (tokens[at]?.type === 'ident') (tok.value === 'function' ? functions : lexical).add(tokens[at].value);
      continue;
    }
    if (tok.value !== 'var' && tok.value !== 'let' && tok.value !== 'const') continue;
    const where = position(i);
    if (where === null || (where === 'nested' && tok.value !== 'var')) continue;
    // To the end of the declaration: a semicolon at this level, or the line end that ends it.
    let j = i + 1;
    let inner = 0;
    let plain = tokens[i + 1]?.type === 'ident';
    while (j < tokens.length) {
      const tj = tokens[j];
      if (tj.type === 'punct') {
        if (tj.value === '{' || tj.value === '(' || tj.value === '[') inner++;
        else if (tj.value === '}' || tj.value === ')' || tj.value === ']') {
          if (inner === 0) break;
          inner--;
        } else if (tj.value === ';' && inner === 0) break;
        else if (tj.value === ',' && inner === 0 && tokens[j + 1]?.type !== 'ident') plain = false;
      }
      if (inner === 0 && j > i + 1) {
        const before = tokens[j - 1];
        if (
          /[\r\n]/.test(code.slice(before.end, tj.start)) &&
          !(before.type === 'punct' && /^[,=:+\-*/%&|^<>?!~.([{]$/.test(before.value)) &&
          !(tj.type === 'punct' && /^[,=:+\-*/%&|^<>?.([]$/.test(tj.value)) &&
          !(tj.type === 'keyword' && (tj.value === 'in' || tj.value === 'of' || tj.value === 'instanceof'))
        ) {
          break;
        }
      }
      j++;
    }
    const found = extractDeclaredNames(tokens, i + 1, j);
    if (tok.value === 'var' && where === 'top' && plain && found.length > 0 && found.every((n) => !RESERVED_GLOBALS.has(n))) {
      for (const n of found) plainVars.add(n);
      taken.push(tok);
    } else {
      for (const n of found) (tok.value === 'var' ? otherVars : lexical).add(n);
    }
    i = j - 1;
  }
  if (depth !== 0) trusted = false;
  const strict = tokens[0]?.type === 'string' && /^(['"])use strict\1$/.test(tokens[0].value);
  return { tokens, functions, lexical, plainVars, takenVars: taken, otherVars, trusted, strict };
}

/** Words that end the expression they are in, where a line break after them ends the statement. */
const ENDING_WORDS = new Set(['this', 'null', 'true', 'false', 'super', 'return', 'break', 'continue', 'debugger']);

/** The words whose `( … )` is the head of a statement that goes on after it. */
const STATEMENT_HEADS = new Set(['if', 'while', 'for', 'with', 'switch', 'catch']);

/** Names a script may declare at its top that are not made properties of the global object here: its own, and the words of the language. */
const RESERVED_GLOBALS = new Set([
  'window', 'self', 'globalThis', 'document', 'location', 'undefined', 'NaN', 'Infinity', 'arguments', 'eval', 'this',
  'Object', 'Function', 'Array', 'Promise', 'Symbol', 'host',
]);

/**
 * The helpers a classic script names its top-level declarations with (classicScriptAsFunction,
 * scriptForEval): globals made for its `var`s, and the global of each of its own names read and
 * written through it. With `onlyNew`, a name the page has already is left as it is. A read
 * before the declaration has run answers undefined (a write throws, as assigning to a `const`
 * from another script does in a browser); one that comes back to the same name
 * before it is answered (a name that is not the script's after all) answers undefined, where
 * it went round until the stack ran out.
 */
export const CLASSIC_GLOBALS_HELPER = [
  'function __softnGlobalVars(names) { for (var i = 0; i < names.length; i++) { if (!(names[i] in globalThis)) { try { globalThis[names[i]] = undefined; } catch (e) {} } } }',
  'function __softnGlobals(accessors, onlyNew) { for (var name in accessors) (function (name, read, write) { if (onlyNew && name in globalThis) { if (!__softnGlobals.told) __softnGlobals.told = Object.create(null); if (!__softnGlobals.told[name] && typeof console !== "undefined" && typeof console.warn === "function") { __softnGlobals.told[name] = true; console.warn("[SoftN] A script declared " + name + " at its top, a name the page has already: the scripts after it read the page’s " + name + " here (in a browser they read the script’s). Give it another name to share it."); } return; } var busy = false; try { Object.defineProperty(globalThis, name, { configurable: true, enumerable: true, get: function () { if (busy) return undefined; busy = true; try { return read(); } catch (e) { return undefined; } finally { busy = false; } }, set: function (value) { if (busy) return; busy = true; try { write(value); } finally { busy = false; } } }); } catch (e) {} })(name, accessors[name][0], accessors[name][1]); }',
].join('\n');
export interface TransformedModule {
  /** Transformed JS/TS factory registration code safe for `Engine.initSource` / `evalInContext`. */
  factoryCode: string;
  /** Static module specifiers discovered in this module. */
  staticImports: string[];
  /** The specifiers of `import()` calls that name their module as text (`import('./part.js')`). */
  dynamicImports: string[];
}

/**
 * The most of a module's registration compiled while the app runs, in UTF-8 bytes: the engine
 * compiles 64 KB of code at once then, and past that it stops the app altogether.
 */
export const MAX_RUNTIME_MODULE_BYTES = 60_000;

/** A text's length in UTF-8 bytes. */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * Transform an ES module's source into a `__softnModules.define(url, async (__exports, __import, __meta) => { ... })`
 * registration, preserving line structure where practical and supporting all ES2025 import/export forms.
 */
export function transformEsModule(code: string, moduleUrl: string): TransformedModule {
  // Bundlers often emit a self-contained script even when the HTML uses type="module".
  // Only a keyword can require a rewrite. A match in a string or comment falls back to the scanner.
  const tokens = /\b(?:import|export)\b/.test(code) ? tokenizeTopLevel(code) : [];
  const edits: Array<{ start: number; end: number; replacement: string }> = [];
  const exportGetters = new Map<string, string>(); // exportedName -> localExpr
  const staticImports: string[] = [];
  const dynamicImports: string[] = [];

  let modCounter = 0;
  let braceDepth = 0;
  let parenDepth = 0;
  let bracketDepth = 0;

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const prev = i > 0 ? tokens[i - 1] : null;

    if (tok.type === 'punct') {
      if (tok.value === '{') braceDepth++;
      else if (tok.value === '}') braceDepth = Math.max(0, braceDepth - 1);
      else if (tok.value === '(') parenDepth++;
      else if (tok.value === ')') parenDepth = Math.max(0, parenDepth - 1);
      else if (tok.value === '[') bracketDepth++;
      else if (tok.value === ']') bracketDepth = Math.max(0, bracketDepth - 1);
      continue;
    }

    // Handle `import.meta` anywhere (not preceded by `.`)
    if (
      tok.value === 'import' &&
      prev?.value !== '.' &&
      tokens[i + 1]?.value === '.' &&
      tokens[i + 2]?.value === 'meta'
    ) {
      edits.push({ start: tok.start, end: tokens[i + 2].end, replacement: '__meta' });
      i += 2;
      continue;
    }

    // Handle dynamic `import(...)` anywhere: the importer's address goes in as its second argument.
    const dynamic = dynamicImportAt(tokens, i);
    if (dynamic) {
      edits.push({ start: tok.start, end: tok.end, replacement: '__import' });
      edits.push({ start: tokens[dynamic.firstComma < 0 ? dynamic.close : dynamic.firstComma].start, end: tokens[dynamic.close].end, replacement: ', __meta.url)' });
      if (dynamic.named !== null) dynamicImports.push(dynamic.named);
      continue;
    }

    // Top-level `import ...` statement
    // (Not `import (`: a type of TypeScript's that names a module, which is no statement.)
    if (tok.value === 'import' && braceDepth === 0 && parenDepth === 0 && bracketDepth === 0 && prev?.value !== '.' && tokens[i + 1]?.value !== '(') {
      // TypeScript `import type ...` -> strip completely
      if (tokens[i + 1]?.value === 'type' && tokens[i + 2]?.value !== 'from' && tokens[i + 2]?.value !== '=') {
        let j = i + 2;
        while (j < tokens.length && tokens[j].type !== 'string') j++;
        let endPos = j < tokens.length ? tokens[j].end : tok.end;
        if (tokens[j + 1]?.value === ';') { j++; endPos = tokens[j].end; }
        edits.push({ start: tok.start, end: endPos, replacement: '' });
        i = j;
        continue;
      }

      // Side-effect import: `import './foo.js'`
      if (tokens[i + 1]?.type === 'string') {
        const spec = unquote(tokens[i + 1].value);
        staticImports.push(spec);
        let j = i + 1;
        let endPos = tokens[j].end;
        if (tokens[j + 1]?.value === ';') { j++; endPos = tokens[j].end; }
        edits.push({
          start: tok.start,
          end: endPos,
          replacement: `await __import(${JSON.stringify(spec)}, __meta.url);`,
        });
        i = j;
        continue;
      }

      // Standard import bindings up to `from "spec"`
      let j = i + 1;
      let bDepth = 0;
      while (j < tokens.length) {
        if (tokens[j].value === '{') bDepth++;
        else if (tokens[j].value === '}') bDepth = Math.max(0, bDepth - 1);
        else if (bDepth === 0 && tokens[j].value === 'from' && tokens[j + 1]?.type === 'string') {
          break;
        }
        j++;
      }

      if (j < tokens.length && tokens[j + 1]?.type === 'string') {
        const specLit = tokens[j + 1];
        const spec = unquote(specLit.value);
        staticImports.push(spec);
        const clauseTokens = tokens.slice(i + 1, j);
        let endIdx = j + 1;
        // Optional import attributes `with { type: 'json' }` / `assert { ... }`
        if (tokens[endIdx + 1]?.value === 'with' || tokens[endIdx + 1]?.value === 'assert') {
          endIdx += 2;
          if (tokens[endIdx]?.value === '{') {
            let d = 1;
            endIdx++;
            while (endIdx < tokens.length && d > 0) {
              if (tokens[endIdx].value === '{') d++;
              else if (tokens[endIdx].value === '}') d--;
              endIdx++;
            }
            endIdx--;
          }
        }
        if (tokens[endIdx + 1]?.value === ';') endIdx++;

        const modVar = `__softn_m${modCounter++}`;
        const lines: string[] = [`const ${modVar} = await __import(${JSON.stringify(spec)}, __meta.url);`];

        // Parse clauseTokens: defaultIdent, `* as ns`, `{ a, b as c, type T }`
        let k = 0;
        if (clauseTokens[k] && (clauseTokens[k].type === 'ident' || clauseTokens[k].type === 'keyword') && clauseTokens[k].value !== '*') {
          const defName = clauseTokens[k].value;
          lines.push(`const ${defName} = ${modVar}.default;`);
          k++;
          if (clauseTokens[k]?.value === ',') k++;
        }
        if (clauseTokens[k]?.value === '*' && clauseTokens[k + 1]?.value === 'as' && clauseTokens[k + 2]) {
          const nsName = clauseTokens[k + 2].value;
          lines.push(`const ${nsName} = ${modVar};`);
        } else if (clauseTokens[k]?.value === '{') {
          k++;
          while (k < clauseTokens.length && clauseTokens[k].value !== '}') {
            if (clauseTokens[k].value === ',') { k++; continue; }
            if (clauseTokens[k].value === 'type' && clauseTokens[k + 1] && clauseTokens[k + 1].value !== ',' && clauseTokens[k + 1].value !== '}' && clauseTokens[k + 1].value !== 'as') {
              // `import { type Foo }` -> skip
              k += 2;
              if (clauseTokens[k]?.value === 'as') k += 2;
              continue;
            }
            const imported = clauseTokens[k].value;
            let local = imported;
            k++;
            if (clauseTokens[k]?.value === 'as' && clauseTokens[k + 1]) {
              local = clauseTokens[k + 1].value;
              k += 2;
            }
            lines.push(`const ${local} = ${modVar}[${JSON.stringify(imported)}];`);
          }
        }

        edits.push({ start: tok.start, end: tokens[endIdx].end, replacement: lines.join(' ') });
        i = endIdx;
        continue;
      }
    }

    // Top-level `export ...` statement
    if (tok.value === 'export' && braceDepth === 0 && parenDepth === 0 && bracketDepth === 0 && prev?.value !== '.') {
      const next = tokens[i + 1];
      if (!next) continue;

      // TypeScript `export type ...` or `export interface ...` -> drop `export` keyword (or whole re-export)
      if (next.value === 'interface') {
        edits.push({ start: tok.start, end: tok.end, replacement: '' });
        continue;
      }
      if (next.value === 'type' && tokens[i + 2]?.value === '{') {
        let j = i + 3;
        while (j < tokens.length && tokens[j].value !== '}') j++;
        if (tokens[j + 1]?.value === 'from' && tokens[j + 2]?.type === 'string') j += 2;
        if (tokens[j + 1]?.value === ';') j++;
        edits.push({ start: tok.start, end: tokens[Math.min(j, tokens.length - 1)].end, replacement: '' });
        i = j;
        continue;
      }
      if (next.value === 'type') {
        edits.push({ start: tok.start, end: tok.end, replacement: '' });
        continue;
      }

      // `export default ...`
      if (next.value === 'default') {
        const afterDef = tokens[i + 2];
        const isNamedDecl =
          (afterDef?.value === 'function' && tokens[i + 3]?.type === 'ident') ||
          (afterDef?.value === 'function' && tokens[i + 3]?.value === '*' && tokens[i + 4]?.type === 'ident') ||
          (afterDef?.value === 'async' && tokens[i + 3]?.value === 'function' && tokens[i + 4]?.type === 'ident') ||
          (afterDef?.value === 'class' && tokens[i + 3]?.type === 'ident');

        if (isNamedDecl) {
          let nameIdx = i + 3;
          if (afterDef.value === 'async' || tokens[i + 3]?.value === '*') nameIdx = i + 4;
          const declName = tokens[nameIdx].value;
          edits.push({ start: tok.start, end: next.end, replacement: '' });
          exportGetters.set('default', declName);
          i = i + 1;
          continue;
        } else {
          const defVar = `__softn_default`;
          edits.push({ start: tok.start, end: next.end, replacement: `const ${defVar} =` });
          exportGetters.set('default', defVar);
          i = i + 1;
          continue;
        }
      }

      // `export * from './mod'` or `export * as ns from './mod'`
      if (next.value === '*') {
        let j = i + 2;
        let asNs: string | null = null;
        if (tokens[j]?.value === 'as' && tokens[j + 1]) {
          asNs = tokens[j + 1].value;
          j += 2;
        }
        if (tokens[j]?.value === 'from' && tokens[j + 1]?.type === 'string') {
          const spec = unquote(tokens[j + 1].value);
          staticImports.push(spec);
          let endIdx = j + 1;
          if (tokens[endIdx + 1]?.value === ';') endIdx++;
          const modVar = `__softn_m${modCounter++}`;
          const rep = asNs
            ? `const ${modVar} = await __import(${JSON.stringify(spec)}, __meta.url); Object.defineProperty(__exports, ${JSON.stringify(asNs)}, { enumerable: true, configurable: true, get: () => ${modVar} });`
            : `const ${modVar} = await __import(${JSON.stringify(spec)}, __meta.url); __reexport(__exports, ${modVar});`;
          edits.push({ start: tok.start, end: tokens[endIdx].end, replacement: rep });
          i = endIdx;
          continue;
        }
      }

      // `export { a, b as c } [from './mod']`
      if (next.value === '{') {
        let j = i + 2;
        const specs: Array<{ local: string; exported: string }> = [];
        while (j < tokens.length && tokens[j].value !== '}') {
          if (tokens[j].value === ',') { j++; continue; }
          if (tokens[j].value === 'type' && tokens[j + 1] && tokens[j + 1].value !== ',' && tokens[j + 1].value !== '}' && tokens[j + 1].value !== 'as') {
            j += 2;
            if (tokens[j]?.value === 'as') j += 2;
            continue;
          }
          const local = tokens[j].value;
          let exported = local;
          j++;
          if (tokens[j]?.value === 'as' && tokens[j + 1]) {
            exported = tokens[j + 1].value;
            j += 2;
          }
          specs.push({ local, exported });
        }
        let endIdx = j;
        if (tokens[j + 1]?.value === 'from' && tokens[j + 2]?.type === 'string') {
          const spec = unquote(tokens[j + 2].value);
          staticImports.push(spec);
          endIdx = j + 2;
          if (tokens[endIdx + 1]?.value === ';') endIdx++;
          const modVar = `__softn_m${modCounter++}`;
          const defs = specs
            .map(
              (s) =>
                `Object.defineProperty(__exports, ${JSON.stringify(s.exported)}, { enumerable: true, configurable: true, get: () => ${modVar}[${JSON.stringify(s.local)}] });`
            )
            .join(' ');
          edits.push({
            start: tok.start,
            end: tokens[endIdx].end,
            replacement: `const ${modVar} = await __import(${JSON.stringify(spec)}, __meta.url); ${defs}`,
          });
          i = endIdx;
          continue;
        } else {
          if (tokens[endIdx + 1]?.value === ';') endIdx++;
          for (const s of specs) exportGetters.set(s.exported, s.local);
          edits.push({ start: tok.start, end: tokens[endIdx].end, replacement: '' });
          i = endIdx;
          continue;
        }
      }

      // `export function foo`, `export async function foo`, `export class Bar`, `export enum E`
      if (
        next.value === 'function' ||
        next.value === 'class' ||
        next.value === 'enum' ||
        (next.value === 'async' && tokens[i + 2]?.value === 'function')
      ) {
        let nameIdx = i + 2;
        if (next.value === 'async') nameIdx = i + 3;
        if (tokens[nameIdx]?.value === '*') nameIdx++;
        if (tokens[nameIdx]) {
          exportGetters.set(tokens[nameIdx].value, tokens[nameIdx].value);
        }
        edits.push({ start: tok.start, end: tok.end, replacement: '' });
        continue;
      }

      // `export const / let / var ...`
      if (next.value === 'const' || next.value === 'let' || next.value === 'var') {
        // Scan until statement end (`;` at depth 0, or newline before next statement keyword/ident when ASI applies)
        let j = i + 2;
        let pD = 0;
        let bD = 0;
        let kD = 0;
        while (j < tokens.length) {
          const tj = tokens[j];
          if (tj.type === 'punct') {
            if (tj.value === '(') pD++;
            else if (tj.value === ')') pD = Math.max(0, pD - 1);
            else if (tj.value === '{') bD++;
            else if (tj.value === '}') bD = Math.max(0, bD - 1);
            else if (tj.value === '[') kD++;
            else if (tj.value === ']') kD = Math.max(0, kD - 1);
            else if (tj.value === ';' && pD === 0 && bD === 0 && kD === 0) break;
          }
          // Check for ASI newline boundary when at depth 0
          if (pD === 0 && bD === 0 && kD === 0 && j > i + 2) {
            const prevTok = tokens[j - 1];
            const between = code.slice(prevTok.end, tj.start);
            if (
              /[\r\n]/.test(between) &&
              prevTok.value !== ',' &&
              prevTok.value !== '=' &&
              prevTok.value !== ':' &&
              tj.value !== ',' &&
              tj.value !== '=' &&
              tj.value !== '.' &&
              tj.value !== '(' &&
              tj.value !== '['
            ) {
              break;
            }
          }
          j++;
        }
        const names = extractDeclaredNames(tokens, i + 2, j);
        for (const n of names) exportGetters.set(n, n);
        edits.push({ start: tok.start, end: tok.end, replacement: '' });
        continue;
      }
    }
  }

  // Apply edits in reverse offset order
  edits.sort((a, b) => b.start - a.start);
  let body = code;
  for (const edit of edits) {
    body = body.slice(0, edit.start) + edit.replacement + body.slice(edit.end);
  }

  const getterLines: string[] = [];
  for (const [exported, local] of exportGetters) {
    getterLines.push(
      `Object.defineProperty(__exports, ${JSON.stringify(exported)}, { enumerable: true, configurable: true, get: function () { return ${local}; } });`
    );
  }

  const factoryCode =
    `__softnModules.define(${JSON.stringify(moduleUrl)}, async function (__exports, __import, __meta, __reexport) {\n` +
    (getterLines.length > 0 ? getterLines.join('\n') + '\n' : '') +
    body +
    `\n});\n`;

  return { factoryCode, staticImports, dynamicImports };
}

/**
 * Runtime registry preamble injected once into the ZIPP Worker before any ES module executes.
 */
export const ESM_REGISTRY_PREAMBLE = String.raw`
var __softnModules = (function () {
  var factories = Object.create(null);
  var evaluating = Object.create(null);
  var evaluated = Object.create(null);

  function reexport(target, source) {
    if (!source || typeof source !== 'object') return;
    var keys = Object.keys(source);
    for (var i = 0; i < keys.length; i++) {
      (function (k) {
        if (k === 'default' || Object.prototype.hasOwnProperty.call(target, k)) return;
        Object.defineProperty(target, k, {
          enumerable: true,
          configurable: true,
          get: function () { return source[k]; },
        });
      })(keys[i]);
    }
  }

  function makeNamespace() {
    var ns = Object.create(null);
    Object.defineProperty(ns, Symbol.toStringTag, { value: 'Module' });
    return ns;
  }

  // The engine's own eval, whatever the app makes of the global one later. Called this way
  // it is an indirect eval: what it compiles is compiled at the global scope.
  var compile = eval;
  function loadFromHost(specifier, importerUrl) {
    return new Promise(function (resolve, reject) {
      host.call('esm.load', [String(specifier), String(importerUrl || '')], function (reply) {
        if (!reply || reply.error) {
          reject(new TypeError(reply && reply.error ? String(reply.error) : 'Failed to fetch dynamically imported module: ' + specifier));
          return;
        }
        // The modules' registrations, each compiled on its own here: the host has held each to
        // what the engine compiles at once while the app runs.
        var blocks = reply.blocks || [];
        try {
          for (var i = 0; i < blocks.length; i++) compile(String(blocks[i]));
        } catch (e) {
          // Not compiled: the host lets go of them, so that asking again asks again (it kept
          // them, and every later import of them failed with nothing to say why).
          try { host.call('esm.forget', [JSON.stringify(reply.urls || [])], function () {}); } catch (ignored) {}
          reject(e);
          return;
        }
        resolve(reply.url);
      });
    });
  }

  function importModule(specifier, importerUrl) {
    var specStr = String(specifier);
    if (evaluated[specStr]) return Promise.resolve(evaluated[specStr]);
    if (evaluating[specStr]) return evaluating[specStr];
    if (factories[specStr]) return runFactory(specStr);

    var resolvedUrl = null;
    try {
      resolvedUrl = host.callSync('esm.resolve', specStr, String(importerUrl || ''));
    } catch (e) {}

    if (resolvedUrl && evaluated[resolvedUrl]) {
      return Promise.resolve(evaluated[resolvedUrl]);
    }
    if (resolvedUrl && evaluating[resolvedUrl]) {
      return evaluating[resolvedUrl];
    }
    if (resolvedUrl && factories[resolvedUrl]) {
      return runFactory(resolvedUrl);
    }
    return loadFromHost(specifier, importerUrl).then(function (url) {
      if (evaluated[url]) return evaluated[url];
      if (evaluating[url]) return evaluating[url];
      if (!factories[url]) throw new TypeError('Module did not register factory: ' + url);
      return runFactory(url);
    });
  }

  function runFactory(url) {
    var ns = makeNamespace();
    evaluated[url] = ns; // Pre-install namespace so circular live getters resolve cleanly
    var meta = {
      url: url,
      env: { MODE: 'production', PROD: true, DEV: false, BASE_URL: '/' },
    };
    var p = Promise.resolve()
      .then(function () {
        return factories[url](ns, importModule, meta, reexport);
      })
      .then(function () {
        delete evaluating[url];
        return ns;
      }, function (err) {
        delete evaluating[url];
        delete evaluated[url];
        throw err;
      });
    evaluating[url] = p;
    return p;
  }

  return {
    define: function (url, fn) { factories[url] = fn; },
    has: function (url) { return !!factories[url] || !!evaluated[url]; },
    import: importModule,
  };
})();
`;
