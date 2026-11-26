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

const HOSTED_EXTERNAL_VENDOR_NAMES = new Set([
  'three',
  'three/addons/controls/OrbitControls',
  'three/addons/loaders/GLTFLoader',
  'three/addons/loaders/DRACOLoader',
  'three/addons/loaders/RGBELoader',
  'three/addons/environments/RoomEnvironment',
  'three/addons/postprocessing/EffectComposer',
  'three/addons/postprocessing/RenderPass',
  'three/addons/postprocessing/UnrealBloomPass',
  'gltf-loader',
  'marked',
  'htm',
  'preact',
  'preact/hooks',
  'preact/jsx-runtime',
  'preact/jsx-dev-runtime',
  'react',
  'react-dom',
  'react-dom/client',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
]);

/**
 * Whether a bare specifier may trigger a same-origin `/runtime/vendor/<name>.js` fetch.
 * Arbitrary unallowlisted bare specifiers must never issue network fetches from a zero-egress container.
 */
export function isAllowedExternalVendorModule(name: string): boolean {
  if (!safeVendorName(name)) return false;
  return HOSTED_EXTERNAL_VENDOR_NAMES.has(name);
}

/** Resolve an ES module specifier from `importerPath` using importMap, VFS, `softn:*`, and `/runtime/vendor/`. */
export function resolveModuleSpecifier(
  specifier: string,
  importerPath: string,
  importMap: Readonly<Record<string, string>> = {},
  hasVfsFile?: (path: string) => boolean
): ResolvedSpecifier {
  const raw = specifier.trim();

  // 1. Check user/HTML importmap exact match or longest-prefix match (`pkg/` -> `./vendor/pkg/`)
  let mapped = Object.hasOwn(importMap, raw) ? importMap[raw] : undefined;
  if (!mapped) {
    let bestPrefix = '';
    for (const [prefix, target] of Object.entries(importMap)) {
      if (prefix.endsWith('/') && raw.startsWith(prefix) && prefix.length > bestPrefix.length) {
        bestPrefix = prefix;
        mapped = target + raw.slice(prefix.length);
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
    mapped = Object.hasOwn(DEFAULT_VENDOR_IMPORT_MAP, raw) ? DEFAULT_VENDOR_IMPORT_MAP[raw] : undefined;
    if (!mapped) {
      let bestPrefix = '';
      for (const [prefix, target] of Object.entries(DEFAULT_VENDOR_IMPORT_MAP)) {
        if (prefix.endsWith('/') && raw.startsWith(prefix) && prefix.length > bestPrefix.length) {
          bestPrefix = prefix;
          mapped = target + raw.slice(prefix.length);
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

/**
 * What a `{` opens: an object (a literal, a pattern, a TypeScript type's), a block (a
 * statement's, a function's body), a class's body, the members of a TypeScript interface or
 * enum, a template's `${`, or the names of an `import { … }` or `export { … }`.
 */
type BraceKind = 'object' | 'block' | 'class' | 'members' | 'template' | 'clause';

interface Token {
  type: 'ident' | 'keyword' | 'punct' | 'string' | 'other';
  value: string;
  start: number;
  end: number;
  /** For a `{`: what it opens. */
  brace?: BraceKind;
  /** For a `)`, `]` or `}`: the place among the tokens of the bracket it closes. */
  open?: number;
}

/** The words the tokenizer reads as keywords (a name the code gives one of them is still read as one). */
function isKeywordWord(word: string): boolean {
  return (
    word === 'import' || word === 'export' || word === 'from' || word === 'as' ||
    word === 'default' || word === 'function' || word === 'class' || word === 'const' ||
    word === 'let' || word === 'var' || word === 'async' || word === 'type' ||
    word === 'interface' || word === 'enum' || CONTROL_HEAD_KEYWORDS.has(word) || REGEX_PRECEDING_KEYWORDS.has(word)
  );
}

const REGEX_PRECEDING_KEYWORDS = new Set([
  'return', 'throw', 'case', 'default', 'delete', 'void', 'typeof', 'instanceof', 'in', 'of', 'new', 'yield', 'await', 'else', 'do',
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

/** Apply non-overlapping source edits in a single O(N + M) forward pass (dropping any nested edit inside an earlier outer span). */
function applyEditsLinear(
  code: string,
  edits: Array<{ start: number; end: number; replacement: string }>,
  preserveLines = false
): string {
  if (edits.length === 0) return code;
  edits.sort((a, b) => a.start - b.start || b.end - a.end);
  const parts: string[] = [];
  let cursor = 0;
  for (const edit of edits) {
    if (edit.start < cursor) continue; // Skip nested/overlapping edit already covered by an outer edit
    parts.push(code.slice(cursor, edit.start));
    const rep = preserveLines
      ? preserveLineCount(code.slice(edit.start, edit.end), edit.replacement)
      : edit.replacement;
    parts.push(rep);
    cursor = edit.end;
  }
  parts.push(code.slice(cursor));
  return parts.join('');
}

const CONTROL_HEAD_KEYWORDS = new Set(['if', 'while', 'for', 'with']);

/** Tokenize JS/TS code skipping comments, strings, template literals (tokenizing `${...}` expressions), and regex literals accurately. */
function tokenizeTopLevel(code: string): Token[] {
  const tokens: Token[] = [];
  const len = code.length;
  let i = 0;
  let prevSig: Token | null = null;
  // Stack of brace depths for active template `${...}` expressions so closing `}` resumes template text.
  const templateBraceStack: number[] = [];
  // Track whether each open `(` belongs to a control-flow head (`if (...)`, `while (...)`, `for (...)`, `with (...)`)
  // so `if (cond) /pat/.test(s)` recognizes `/` after `)` as a regex literal rather than division.
  const parenIsControlHead: boolean[] = [];
  let lastClosedControlHead = false;
  let activeBraceDepth = 0;
  // The open brackets, by their places among the tokens: each closing one is told its opening one.
  const openers: number[] = [];
  // What the `{` the last `}` closed opened: a `/` after a block's (`if (a) {} /x/.test(s)`)
  // begins a regular expression, and one after an object's divides. Every `}` was taken for an
  // object's, and a module with such a line had all the code after it read as a pattern's: its
  // brackets were lost, and its exports were left in its registration, which did not compile.
  let lastClosedBrace: BraceKind | undefined;
  // A `class` (an `interface`, an `enum`) whose body is the next `{` at the depth of its head.
  let headDepth = -1;
  let headKind: BraceKind = 'class';
  let headAngles = 0;
  let headWord = -1;

  // A word after a `.` is a property's name (`x.default / 2`, `a?.in / b`), however it is spelled.
  const afterDot = (k: number): boolean => k > 0 && tokens[k - 1].type === 'punct' && tokens[k - 1].value === '.';

  const canStartRegex = (): boolean => {
    if (!prevSig) return true;
    if (prevSig.type === 'keyword') return REGEX_PRECEDING_KEYWORDS.has(prevSig.value) && !afterDot(tokens.length - 1);
    if (prevSig.type === 'punct') {
      if (prevSig.value === ')') return lastClosedControlHead;
      if (prevSig.value === '}') return lastClosedBrace !== undefined && lastClosedBrace !== 'object';
      return REGEX_PRECEDING_PUNCT.has(prevSig.value);
    }
    return false;
  };

  // A `{` after a colon opens a block after `case x:`, `default:` or a label, and an object (a
  // value, a conditional's other side, a TypeScript type) otherwise.
  const colonOpensBlock = (colon: number): boolean => {
    let words = 0;
    for (let m = colon - 1; m >= 0; m--) {
      const t = tokens[m];
      if (t.type === 'punct') {
        const v = t.value;
        if ((v === ')' || v === ']' || v === '}') && t.open !== undefined) {
          m = t.open;
          words += 2;
          continue;
        }
        if (v === '?' || v === ',') return false;
        if (v === ';' || v === '{' || v === '(' || v === '[') return words === 1 && (v === ';' || (v === '{' && t.brace !== 'object' && t.brace !== 'template'));
        words++;
        continue;
      }
      if (t.type === 'keyword' && (t.value === 'case' || t.value === 'default')) {
        // Unless it is a property's name (`{ default: { a } }`).
        const before = tokens[m - 1];
        if (!(before && before.type === 'punct' && (before.value === '.' || before.value === ',' || (before.value === '{' && before.brace === 'object')))) return true;
      }
      words++;
    }
    return words === 1;
  };

  // What the `{` about to be read opens, from what comes before it.
  const braceKind = (): BraceKind => {
    const k = tokens.length - 1;
    if (headWord === k) {
      // `class {`: an unnamed class's body.
      headWord = -1;
      return headKind;
    }
    if (headDepth === openers.length && headAngles <= 0) {
      headDepth = -1;
      return headKind;
    }
    const p = prevSig;
    if (!p) return 'block';
    if (p.type === 'punct') {
      switch (p.value) {
        // `>` for `=> {` (an arrow's body) and `): Promise<T> {` (a TypeScript return type).
        case ')': case ']': case '}': case ';': case '++': case '--': case '>':
          return 'block';
        case '{':
          return p.brace === 'template' ? 'object' : 'block';
        case ':':
          return colonOpensBlock(k) ? 'block' : 'object';
        default:
          return 'object';
      }
    }
    if (p.type === 'keyword' && !afterDot(k)) {
      switch (p.value) {
        case 'else': case 'do':
          return 'block';
        case 'import': case 'export':
          return 'clause';
        case 'return': case 'yield':
          // `return` and a line break end the statement there.
          return /[\r\n\u2028\u2029]/.test(code.slice(p.end, i)) ? 'block' : 'object';
        case 'const': case 'let': case 'var': case 'typeof': case 'instanceof': case 'in': case 'of': case 'new': case 'delete':
        case 'void': case 'throw': case 'case': case 'await': case 'default': case 'as':
          return 'object';
        default:
          return 'block';
      }
    }
    if (p.type === 'ident' && (p.value === 'satisfies' || p.value === 'keyof' || p.value === 'extends') && !afterDot(k)) return 'object';
    return 'block';
  };

  const scanTemplateChunk = (isHead: boolean): void => {
    const start = i;
    i++; // opening ` or resuming }
    while (i < len) {
      const ch = code.charCodeAt(i);
      if (ch === 92 /* \ */) {
        i += 2;
        continue;
      }
      if (ch === 96 /* ` */) {
        i++;
        const tok: Token = { type: isHead ? 'string' : 'other', value: code.slice(start, i), start, end: i };
        tokens.push(tok);
        prevSig = tok;
        return;
      }
      if (ch === 36 /* $ */ && code.charCodeAt(i + 1) === 123 /* { */) {
        // Emit template chunk up through `$`, then emit `{` as a normal punct token so `${...}`
        // expressions are tokenized (enabling `import.meta` and `import()` inside templates)
        // while keeping every `{`/`}` depth counter balanced.
        const chunkEnd = i + 1;
        const headTok: Token = { type: 'other', value: code.slice(start, chunkEnd), start, end: chunkEnd };
        tokens.push(headTok);
        const braceTok: Token = { type: 'punct', value: '{', start: i + 1, end: i + 2, brace: 'template' };
        openers.push(tokens.length);
        tokens.push(braceTok);
        prevSig = braceTok;
        activeBraceDepth++;
        templateBraceStack.push(activeBraceDepth);
        i += 2;
        return;
      }
      i++;
    }
    const tok: Token = { type: isHead ? 'string' : 'other', value: code.slice(start, i), start, end: i };
    tokens.push(tok);
    prevSig = tok;
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
      scanTemplateChunk(true);
      continue;
    }
    if (ch === 123 /* { */) {
      activeBraceDepth++;
      const tok: Token = { type: 'punct', value: '{', start: i, end: i + 1, brace: braceKind() };
      openers.push(tokens.length);
      tokens.push(tok);
      prevSig = tok;
      i++;
      continue;
    }
    if (ch === 125 /* } */) {
      const closingTemplate =
        templateBraceStack.length > 0 && templateBraceStack[templateBraceStack.length - 1] === activeBraceDepth;
      const open = openers.pop();
      const tok: Token = { type: 'punct', value: '}', start: i, end: i + 1, open };
      lastClosedBrace = open !== undefined ? tokens[open].brace : undefined;
      if (headDepth > openers.length) headDepth = -1;
      tokens.push(tok);
      prevSig = tok;
      if (activeBraceDepth > 0) activeBraceDepth--;
      if (closingTemplate) {
        templateBraceStack.pop();
        scanTemplateChunk(false);
        continue;
      }
      i++;
      continue;
    }
    if (isIdentStart(ch)) {
      const start = i;
      i++;
      while (i < len && isIdentPart(code.charCodeAt(i))) i++;
      const word = code.slice(start, i);
      const tok: Token = { type: isKeywordWord(word) ? 'keyword' : 'ident', value: word, start, end: i };
      // The word after `class` (`interface`, `enum`): a class's head when it is its name or what a
      // head goes on with, and the body is the next `{` at its depth (`{ class: 'x' }` has none).
      if (headWord === tokens.length - 1) {
        if (tok.type === 'ident' || word === 'extends' || word === 'implements') {
          headDepth = openers.length;
          headAngles = 0;
        }
        headWord = -1;
      }
      if ((word === 'class' || word === 'interface' || word === 'enum') && !afterDot(tokens.length)) {
        headWord = tokens.length;
        headKind = word === 'class' ? 'class' : 'members';
      }
      tokens.push(tok);
      prevSig = tok;
      lastClosedControlHead = false;
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
      lastClosedControlHead = false;
      continue;
    }
    // Keep `++` and `--` intact so `a++ / b` parses `/` as division instead of a regex literal.
    if ((ch === 43 && code.charCodeAt(i + 1) === 43) || (ch === 45 && code.charCodeAt(i + 1) === 45)) {
      const start = i;
      const op = ch === 43 ? '++' : '--';
      i += 2;
      const tok: Token = { type: 'punct', value: op, start, end: i };
      tokens.push(tok);
      prevSig = tok;
      lastClosedControlHead = false;
      continue;
    }
    // Punctuation
    const start = i;
    const chStr = code[i];
    i++;
    const tok: Token = { type: 'punct', value: chStr, start, end: i };
    if (chStr === '(') {
      // (Not `x.for(…)` or `a.with(i, v)`: a method's call.)
      parenIsControlHead.push(prevSig?.type === 'keyword' && CONTROL_HEAD_KEYWORDS.has(prevSig.value) && !afterDot(tokens.length - 1));
      lastClosedControlHead = false;
    } else if (chStr === ')') {
      lastClosedControlHead = parenIsControlHead.pop() === true;
    } else {
      lastClosedControlHead = false;
    }
    if (headWord === tokens.length - 1) {
      // `class<T> {` (TypeScript's): a class's head.
      if (chStr === '<') {
        headDepth = openers.length;
        headAngles = 0;
      }
      headWord = -1;
    }
    if (chStr === '(' || chStr === '[') {
      openers.push(tokens.length);
    } else if (chStr === ')' || chStr === ']') {
      tok.open = openers.pop();
      if (headDepth > openers.length) headDepth = -1;
    } else if (headDepth === openers.length) {
      // A class's head in TypeScript: its type parameters and arguments are between angles.
      if (chStr === '<') headAngles++;
      else if (chStr === '>' && !(prevSig?.value === '=' && prevSig.end === start)) headAngles--;
      else if (chStr === ';') headDepth = -1;
    }
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
  return { code: applyEditsLinear(code, edits, false), named };
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
  // What may follow a binding: its type, its value, the next one, the end of its pattern.
  const followsBinding = (t: Token | undefined): boolean =>
    t === undefined ||
    (t.type === 'punct' && (t.value === '=' || t.value === ',' || t.value === ':' || t.value === '!' || t.value === '}' || t.value === ']' || t.value === ';')) ||
    (t.type === 'keyword' && (t.value === 'in' || t.value === 'of'));
  // Whether the comma at k ends a value: what follows it is the next binding (a name or a
  // pattern, or a pattern's next property) and not more of a TypeScript type's arguments
  // (`new Map<string, number>()`, `<A, B>(a: A, b: B) => …`), whose names were taken for bindings:
  // a module exported a `number` that was not there, read as a ReferenceError.
  const endsValue = (k: number): boolean => {
    const t = at(k + 1);
    if (t === undefined) return true;
    if (t.type === 'punct') {
      if (t.value === ',' || t.value === '.' || t.value === ']' || t.value === '}') return true;
      if (t.value !== '{' && t.value !== '[') return false;
      return followsBinding(at(skip(k + 2, []) + 1));
    }
    if (nameAt(k + 1)) return followsBinding(at(k + 2));
    // A property's key in a pattern: a string or a number.
    return at(k + 2)?.type === 'punct' && at(k + 2)?.value === ':';
  };
  // To one of `stops` at this level, or to the bracket that closes it, past an expression or a type.
  const skip = (k: number, stops: string[], angles = false): number => {
    let depth = 0;
    let angle = 0;
    while (k < endIdx) {
      const t = tokens[k];
      if (t.type === 'punct') {
        if (depth === 0 && angle === 0 && stops.includes(t.value) && (t.value !== ',' || angles || endsValue(k))) return k;
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
  const MAX_PATTERN_DEPTH = 128;
  const binding = (k: number, depth = 0): number => {
    if (depth >= MAX_PATTERN_DEPTH) return endIdx;
    if (nameAt(k)) {
      names.push(at(k)!.value);
      return k + 1;
    }
    if (punct(k, '{')) return objectPattern(k, depth + 1);
    if (punct(k, '[')) return arrayPattern(k, depth + 1);
    return k + 1;
  };
  const objectPattern = (k: number, depth: number): number => {
    k++;
    while (k < endIdx && !punct(k, '}')) {
      if (punct(k, ',')) {
        k++;
        continue;
      }
      if (punct(k, '.')) {
        while (punct(k, '.')) k++;
        k = binding(k, depth);
      } else {
        // A property's name (a word, a string, a number, or computed), then its binding or itself.
        const key = k;
        k = punct(k, '[') ? skip(k + 1, [']']) + 1 : k + 1;
        if (punct(k, ':')) k = binding(k + 1, depth);
        else if (nameAt(key)) names.push(at(key)!.value);
      }
      if (punct(k, '=')) k = skip(k + 1, [',', '}']);
    }
    return k + 1;
  };
  const arrayPattern = (k: number, depth: number): number => {
    k++;
    while (k < endIdx && !punct(k, ']')) {
      if (punct(k, ',')) {
        k++;
        continue;
      }
      while (punct(k, '.')) k++;
      k = binding(k, depth);
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
  return utf8Length(code) > MAX_EVAL_SCRIPT_BYTES;
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
  const body =
    trusted && top.takenVars.length > 0
      ? applyEditsLinear(
          code,
          top.takenVars.map((tok) => ({ start: tok.start, end: tok.end, replacement: ';' })),
          false
        )
      : code;
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
  /** Synthetic wrapper lines prepended before the module body (`1 + exportGetters.size`). */
  headerLines?: number;
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

function preserveLineCount(originalSlice: string, replacement: string): string {
  let origLines = 0;
  for (let i = 0; i < originalSlice.length; i++) {
    const c = originalSlice.charCodeAt(i);
    if (c === 10) origLines++;
    else if (c === 13) {
      origLines++;
      if (originalSlice.charCodeAt(i + 1) === 10) i++;
    }
  }
  if (origLines === 0) return replacement;
  let repLines = 0;
  for (let i = 0; i < replacement.length; i++) {
    if (replacement.charCodeAt(i) === 10) repLines++;
  }
  return origLines > repLines ? replacement + '\n'.repeat(origLines - repLines) : replacement;
}

function skipImportAttributes(tokens: Token[], endIdx: number): number {
  let idx = endIdx;
  if (tokens[idx + 1]?.value === 'with' || tokens[idx + 1]?.value === 'assert') {
    idx += 2;
    if (tokens[idx]?.value === '{') {
      let d = 1;
      idx++;
      while (idx < tokens.length && d > 0) {
        if (tokens[idx].value === '{') d++;
        else if (tokens[idx].value === '}') d--;
        idx++;
      }
      idx--;
    }
  }
  return idx;
}

function readExportedIdent(tok: Token): string {
  return tok.type === 'string' ? unquote(tok.value) : tok.value;
}

/** Whether a line break comes between the end of one token and the start of the next. */
function breakBetween(code: string, from: number, to: number): boolean {
  for (let p = from; p < to; p++) {
    const c = code.charCodeAt(p);
    if (c === 10 || c === 13 || c === 0x2028 || c === 0x2029) return true;
  }
  return false;
}

/** A token a line may end with and ask for more on the next (an operator, a comma, an open bracket). */
function asksForMore(t: Token): boolean {
  if (t.type === 'punct') return t.value !== ')' && t.value !== ']' && t.value !== '}' && t.value !== ';' && t.value !== '++' && t.value !== '--';
  return t.type === 'keyword' && REGEX_PRECEDING_KEYWORDS.has(t.value);
}

/** A token a line may begin with and go on with the line before (no semicolon is put between them). */
function goesOn(t: Token): boolean {
  if (t.type === 'punct') return t.value !== '{' && t.value !== '}' && t.value !== ';' && t.value !== '!' && t.value !== '~' && t.value !== '++' && t.value !== '--' && t.value !== '#' && t.value !== '@';
  return (t.type === 'keyword' && (t.value === 'in' || t.value === 'of' || t.value === 'instanceof' || t.value === 'as')) || (t.type === 'ident' && t.value === 'satisfies');
}

/**
 * Where a `var`, `let` or `const` whose first binding is at `from` ends: a semicolon at its own
 * level, the bracket around it, a line break where a semicolon goes, or (in a `for`'s head) its `in` or `of`.
 */
function declarationEnd(tokens: Token[], code: string, from: number, forHead = false): number {
  let depth = 0;
  for (let j = from; j < tokens.length; j++) {
    const t = tokens[j];
    if (depth === 0 && j > from) {
      const before = tokens[j - 1];
      if (!asksForMore(before) && !goesOn(t) && breakBetween(code, before.end, t.start)) return j;
    }
    if (t.type === 'punct') {
      if (t.value === '(' || t.value === '[' || t.value === '{') depth++;
      else if (t.value === ')' || t.value === ']' || t.value === '}') {
        if (depth === 0) return j;
        depth--;
      } else if (t.value === ';' && depth === 0) return j;
    } else if (forHead && depth === 0 && t.type === 'keyword' && (t.value === 'in' || t.value === 'of')) return j;
  }
  return tokens.length;
}

/** Whether tokens[k] and tokens[k + 1] are an arrow's `=>`. */
function arrowAt(tokens: Token[], k: number): boolean {
  const a = tokens[k];
  const b = tokens[k + 1];
  return a !== undefined && b !== undefined && a.type === 'punct' && a.value === '=' && b.value === '>' && a.end === b.start;
}

/**
 * Where the `<` at k closes when it begins a TypeScript type's parameters or arguments
 * (`Map<string, T>`, `<T,>(x: T) =>`): the `>` that closes it, followed by what follows a type;
 * -1 where it is a comparison (`a < b`).
 */
function angleEnd(tokens: Token[], k: number): number {
  let depth = 1;
  let inner = 0;
  for (let m = k + 1; m < tokens.length && m < k + 256; m++) {
    const t = tokens[m];
    if (t.type !== 'punct') continue;
    const v = t.value;
    if (v === '(' || v === '[' || v === '{') inner++;
    else if (v === ')' || v === ']' || v === '}') {
      if (inner === 0) return -1;
      inner--;
    } else if (inner > 0) continue;
    else if (v === '<') depth++;
    else if (v === '>' && !(tokens[m - 1].value === '=' && tokens[m - 1].end === t.start)) {
      if (--depth > 0) continue;
      const after = tokens[m + 1];
      if (after === undefined || after.type === 'string' || (after.type === 'other' && after.value[0] === '`')) return m;
      return after.type === 'punct' && '()]},;=>[{|&?:.!'.indexOf(after.value) >= 0 && after.value.length === 1 ? m : -1;
    } else if (v === ';' || v === '+' || v === '*' || v === '/' || v === '%' || v === '^' || v === '~' || v === '!' || v === '++' || v === '--' || v === '@' || v === '#') return -1;
  }
  return -1;
}

/**
 * Where the module declares one of `names` again in a place of its own (a parameter, a
 * variable, a function or a class, a catch's binding, a TypeScript type's parameter): for each
 * such name, the spans (from, to) of the statements those declarations are in, read generously,
 * where the name is read through a binding of its own as before; null for a name the module
 * declares again at its top, which it never reads from its import.
 */
function declaredAgain(tokens: Token[], code: string, names: Set<string>, counted: (t: Token) => boolean): Map<string, Array<[number, number]> | null> {
  const found = new Map<string, Array<[number, number]> | null>();
  const openers: number[] = [];
  // The span of the statement a declaration at token k is in, from the outermost bracket it is
  // in (or, at the top, from the start of what declares it), to where that statement ends.
  const spans = new Map<number, [number, number]>();
  const spanFrom = (from: number): [number, number] => {
    let span = spans.get(from);
    if (span === undefined) {
      const end = declarationEnd(tokens, code, from);
      span = [tokens[from].start, end < tokens.length ? tokens[end].start : code.length];
      spans.set(from, span);
    }
    return span;
  };
  const add = (name: string, span: [number, number] | null): void => {
    const had = found.get(name);
    if (had === null) return;
    if (span === null) found.set(name, null);
    else if (had === undefined) found.set(name, [span]);
    else if (had[had.length - 1] !== span) had.push(span);
  };
  // A declaration of a name at token k (`top`: one that declares it in the module's own scope where at its top).
  const declare = (name: string, k: number, top: boolean): void => {
    if (!names.has(name)) return;
    if (openers.length > 0) add(name, spanFrom(openers[0]));
    else add(name, top ? null : spanFrom(k));
  };
  const take = (list: string[], k: number, top: boolean): void => {
    for (const n of list) declare(n, k, top);
  };
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    const prev = tokens[k - 1];
    const dotted = prev !== undefined && prev.type === 'punct' && prev.value === '.';
    if (t.type === 'punct') {
      if (t.value === '(' || t.value === '[' || t.value === '{') {
        openers.push(k);
        continue;
      }
      if (t.value === ')' || t.value === ']' || t.value === '}') openers.pop();
      if (t.value === ')' && t.open !== undefined && counted(t)) {
        // A parameter list: after `function` (and a name), before a body, an arrow or a return
        // type, or a member's in a class, an interface or a type (not an `if`'s or a loop's head).
        const open = t.open;
        const before = tokens[open - 1];
        const twoBefore = tokens[open - 2];
        if (before !== undefined && ((before.type === 'keyword' && CONTROL_HEAD_KEYWORDS.has(before.value)) || before.value === 'switch') && twoBefore?.value !== '.') continue;
        const next = tokens[k + 1];
        const around = openers.length > 0 ? tokens[openers[openers.length - 1]] : undefined;
        const member =
          around !== undefined &&
          (around.brace === 'members' || around.brace === 'class' ||
            (around.brace === 'object' && before !== undefined && (before.type === 'ident' || before.value === '?') &&
              (twoBefore === undefined || twoBefore.value === '{' || twoBefore.value === ',' || twoBefore.value === ';')));
        if (
          before?.value === 'function' || twoBefore?.value === 'function' || member ||
          (next !== undefined && (next.value === '{' || next.value === ':' || arrowAt(tokens, k + 1)))
        ) {
          take(extractDeclaredNames(tokens, open + 1, k), open, false);
        }
      } else if (t.value === '<' && counted(t)) {
        // A TypeScript type's parameters: after `function`, a declared name, or before a
        // parameter list (a generic method's or arrow's).
        const end = angleEnd(tokens, k);
        if (end < 0) continue;
        const declares =
          prev?.value === 'function' ||
          (prev?.type === 'ident' && (tokens[k - 2]?.value === 'function' || tokens[k - 2]?.value === 'class' || tokens[k - 2]?.value === 'interface' || tokens[k - 2]?.value === 'type' || tokens[k - 2]?.value === '*')) ||
          (tokens[end + 1]?.value === '(' && (() => {
            const close = closingParen(tokens, end + 1);
            const after = close >= 0 ? tokens[close + 1] : undefined;
            return after !== undefined && (after.value === '{' || after.value === ':' || arrowAt(tokens, close + 1));
          })());
        if (!declares) continue;
        let inner = 0;
        for (let m = k + 1; m < end; m++) {
          const tm = tokens[m];
          if (tm.type === 'punct') {
            if (tm.value === '(' || tm.value === '[' || tm.value === '{' || tm.value === '<') inner++;
            else if (tm.value === ')' || tm.value === ']' || tm.value === '}' || tm.value === '>') inner--;
            continue;
          }
          const before = tokens[m - 1];
          if (inner === 0 && names.has(tm.value) && (before.value === '<' || before.value === ',' || before.value === 'const' || before.value === 'in' || before.value === 'out')) declare(tm.value, k, false);
        }
      }
      continue;
    }
    if (!counted(t) || dotted) continue;
    if (t.type === 'keyword') {
      if (t.value === 'var' || t.value === 'let' || t.value === 'const') {
        const around = openers.length > 0 ? openers[openers.length - 1] : -1;
        const forHead = around >= 0 && tokens[around].value === '(' && tokens[around - 1]?.value === 'for';
        take(extractDeclaredNames(tokens, k + 1, declarationEnd(tokens, code, k + 1, forHead)), k, true);
      } else if (t.value === 'function' || t.value === 'class' || t.value === 'enum' || t.value === 'interface' || t.value === 'type') {
        let at = k + 1;
        if (tokens[at]?.value === '*') at++;
        const n = tokens[at];
        if (n !== undefined) declare(n.value, k, true);
      }
      continue;
    }
    if (t.type !== 'ident' || !names.has(t.value)) continue;
    // `x => …`, `namespace x`, `infer x`, `{ [x in Keys]: … }`, `catch` handled with its parentheses.
    if (arrowAt(tokens, k + 1)) declare(t.value, k, false);
    else if (prev !== undefined && (prev.value === 'namespace' || prev.value === 'module')) declare(t.value, k, true);
    else if (prev !== undefined && prev.value === 'infer') declare(t.value, k, false);
    else if (prev?.value === '[' && tokens[k + 1]?.value === 'in') declare(t.value, k, false);
  }
  return found;
}

/** The `)` that closes the `(` at k, or -1. */
function closingParen(tokens: Token[], k: number): number {
  let depth = 0;
  for (let m = k; m < tokens.length; m++) {
    const v = tokens[m].type === 'punct' ? tokens[m].value : '';
    if (v === '(' || v === '[' || v === '{') depth++;
    else if (v === ')' || v === ']' || v === '}') {
      if (--depth === 0) return v === ')' ? m : -1;
    }
  }
  return -1;
}

/** Words that may come before a member's name in a class, an interface or a type. */
const MEMBER_WORDS = new Set(['static', 'get', 'set', 'async', 'public', 'private', 'protected', 'readonly', 'abstract', 'override', 'declare', 'accessor']);

/** A token after which, in a class's body, an expression goes on (its value, its type, a computed key), so a name there is read, not declared. */
function readsOn(t: Token): boolean {
  if (t.type === 'punct') return t.value !== '{' && t.value !== '}' && t.value !== ';' && t.value !== ')' && t.value !== ']' && t.value !== '*';
  if (t.type === 'keyword') return REGEX_PRECEDING_KEYWORDS.has(t.value) || t.value === 'as';
  return t.type === 'ident' && (t.value === 'keyof' || t.value === 'satisfies' || t.value === 'extends' || t.value === 'is');
}

/**
 * How each name of an import is written where the module names it: read (`x`, `f(x)`), as an
 * object's property of its own name (`{ x }`), or not it at all (`o.x`, `{ x: 1 }`, a member's
 * name). A name written in a way not told for certain (a label, `delete x`, a pattern's
 * default) is `unsure`, and is read through a binding of its own, as it was before.
 */
function importUses(tokens: Token[], names: Set<string>, counted: (t: Token) => boolean): { refs: Map<string, Array<{ k: number; shorthand: boolean }>>; unsure: Set<string> } {
  const refs = new Map<string, Array<{ k: number; shorthand: boolean }>>();
  const unsure = new Set<string>();
  const openers: number[] = [];
  // A TypeScript type's arguments the name is written in (`Map<string, x>`), where commas part types.
  let typeArgsEnd = -1;
  let typeArgsDepth = -1;
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.type === 'punct') {
      if (t.value === '(' || t.value === '[' || t.value === '{') openers.push(k);
      else if (t.value === ')' || t.value === ']' || t.value === '}') openers.pop();
      else if (t.value === '<' && k > typeArgsEnd) {
        const end = angleEnd(tokens, k);
        if (end > 0) {
          typeArgsEnd = end;
          typeArgsDepth = openers.length;
        }
      }
      continue;
    }
    if (t.type !== 'ident' || !names.has(t.value) || !counted(t)) continue;
    const prev = tokens[k - 1];
    const next = tokens[k + 1];
    const pv = prev !== undefined && prev.type === 'punct' ? prev.value : undefined;
    // A member's or a private name: `o.x`, `o?.x`, `#x` (not a spread's `...x`).
    if (pv === '#' || (pv === '.' && !(tokens[k - 2]?.value === '.' && tokens[k - 3]?.value === '.'))) continue;
    let use: 'ref' | 'shorthand' | 'name' | null = 'ref';
    const around = openers.length > 0 ? tokens[openers[openers.length - 1]] : undefined;
    const kind = around === undefined ? 'block' : around.value !== '{' ? 'expression' : around.brace;
    const atStart = prev === undefined || pv === '{' || pv === ',' || pv === ';';
    if (prev !== undefined && prev.type !== 'punct' && (prev.value === 'delete' || prev.value === 'break' || prev.value === 'continue')) use = null;
    else if (k < typeArgsEnd && openers.length === typeArgsDepth) use = 'ref';
    else if (kind === 'object') {
      const nv = next?.value;
      const modified = prev !== undefined && prev.type !== 'punct' && MEMBER_WORDS.has(prev.value) && (tokens[k - 2] === undefined || ['{', ',', ';'].indexOf(tokens[k - 2].value) >= 0);
      const starred = pv === '*' && (tokens[k - 2]?.value === '{' || tokens[k - 2]?.value === ',' || tokens[k - 2]?.value === 'async');
      if (atStart || modified || starred) {
        if (nv === ':' || nv === '(' || nv === '<' || (nv === '?' && tokens[k + 2]?.value === ':')) use = 'name';
        else if (atStart && pv !== ';' && (nv === ',' || nv === '}')) use = 'shorthand';
        else if (atStart && (nv === '=' || nv === '?')) use = null;
        else if (modified || starred) use = 'name';
      }
    } else if (kind === 'class' || kind === 'members') {
      // A member's name where one begins; its value, its type or an enum member's value is read.
      if (prev === undefined || !readsOn(prev)) use = 'name';
      else if (kind === 'members' && pv === ',') use = next !== undefined && (next.value === ':' || next.value === '?' || next.value === '(') ? 'name' : next !== undefined && next.type === 'punct' && '>|&[.'.indexOf(next.value) >= 0 ? 'ref' : null;
      else if (pv === '*') use = 'name';
    } else if (kind === 'clause') {
      use = 'name';
    } else if (kind === 'block' && next?.value === ':' && (prev === undefined || pv === ';' || pv === '{' || pv === '}')) {
      // A label.
      use = null;
    }
    if (use === null) {
      unsure.add(t.value);
      continue;
    }
    if (use === 'name') continue;
    let list = refs.get(t.value);
    if (!list) refs.set(t.value, (list = []));
    list.push({ k, shorthand: use === 'shorthand' });
  }
  return { refs, unsure };
}

/** Whether a name is written `o.name` (an identifier, a reserved word among them). */
function dotName(name: string): boolean {
  if (!name || !isIdentStart(name.charCodeAt(0))) return false;
  for (let p = 1; p < name.length; p++) if (!isIdentPart(name.charCodeAt(p))) return false;
  return true;
}

/**
 * Whether the module assigns to a name anywhere (`x = …`, `x += …`, `x++`), read generously: a
 * function or a class it assigns to is not kept as a value once the module has run.
 */
function assignedTo(tokens: Token[], name: string): boolean {
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.type !== 'ident' || t.value !== name || tokens[k - 1]?.value === '.') continue;
    const prev = tokens[k - 1];
    const next = tokens[k + 1];
    if ((prev !== undefined && (prev.value === '++' || prev.value === '--')) || (next !== undefined && (next.value === '++' || next.value === '--'))) return true;
    // `x = …`, `x += …`, `x >>>= …`, `x ??= …` (not `x == …`, `x => …`, `x <= …`, `x >= …`).
    let m = k + 1;
    while (tokens[m] !== undefined && tokens[m].type === 'punct' && tokens[m].value.length === 1 && '+-*/%&|^<>?'.indexOf(tokens[m].value) >= 0 && (m === k + 1 || tokens[m].start === tokens[m - 1].end)) m++;
    const eq = tokens[m];
    if (eq === undefined || eq.value !== '=' || (m > k + 1 && eq.start !== tokens[m - 1].end)) continue;
    const after = tokens[m + 1];
    if (after !== undefined && after.start === eq.end && (after.value === '=' || after.value === '>')) continue;
    if (m === k + 2 && (tokens[k + 1].value === '<' || tokens[k + 1].value === '>')) continue;
    return true;
  }
  return false;
}

/**
 * Transform an ES module's source into a `__softnModules.define(url, async (__exports, __import, __meta) => { ... })`
 * registration, preserving line structure where practical and supporting all ES2025 import/export forms.
 */
export function transformEsModule(code: string, moduleUrl: string): TransformedModule {
  // A first line `#!…` is a comment at a module's very start, and only there: in the
  // registration it is not at the start, and the module did not compile.
  if (code.charCodeAt(0) === 35 && code.charCodeAt(1) === 33) code = `//${code.slice(2)}`;
  // Bundlers often emit a self-contained script even when the HTML uses type="module".
  // Only a keyword can require a rewrite. A match in a string or comment falls back to the scanner.
  const tokens = /\b(?:import|export)\b/.test(code) ? tokenizeTopLevel(code) : [];
  const edits: Array<{ start: number; end: number; replacement: string }> = [];
  const exportGetters = new Map<string, string>(); // exportedName -> localExpr
  const staticImports: string[] = [];
  const dynamicImports: string[] = [];
  // The module's imports (and its exports of other modules'), in their order, done before
  // anything of its own runs, as a browser does: each was done where it was written, so a
  // module's code above its imports ran before what it imports, and read its names before they
  // were there ("cannot access a lexical binding before initialization").
  const hoisted: Array<string | { mod: string; spec: string; names: Array<{ local: string; imported: string }>; namespaces: string[] }> = [];
  // What the statements taken out spanned (imports, `export { … }`), whose names are not the module's code.
  const dropped: Array<[number, number]> = [];
  // What each name the module exports is declared as: one that never changes once the module has
  // run (a `const`, a function's or a class's own name, a default value) is read from it then as a value.
  const kinds = new Map<string, 'const' | 'declared' | 'other'>();

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
      // TypeScript `import type ...` -> strip completely (but NOT `import type from ...` or `import type, { x } from ...`)
      if (
        tokens[i + 1]?.value === 'type' &&
        tokens[i + 2]?.value !== 'from' &&
        tokens[i + 2]?.value !== '=' &&
        tokens[i + 2]?.value !== ','
      ) {
        let j = i + 2;
        while (j < tokens.length && tokens[j].type !== 'string') j++;
        let endIdx = Math.min(j, tokens.length - 1);
        endIdx = skipImportAttributes(tokens, endIdx);
        if (tokens[endIdx + 1]?.value === ';') endIdx++;
        edits.push({ start: tok.start, end: tokens[endIdx].end, replacement: '' });
        dropped.push([tok.start, tokens[endIdx].end]);
        i = endIdx;
        continue;
      }

      // Side-effect import: `import './foo.js'`
      if (tokens[i + 1]?.type === 'string') {
        const spec = unquote(tokens[i + 1].value);
        staticImports.push(spec);
        let j = skipImportAttributes(tokens, i + 1);
        let endPos = tokens[j].end;
        if (tokens[j + 1]?.value === ';') { j++; endPos = tokens[j].end; }
        hoisted.push(`await __import(${JSON.stringify(spec)}, __meta.url);`);
        edits.push({ start: tok.start, end: endPos, replacement: '' });
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
        let endIdx = skipImportAttributes(tokens, j + 1);
        if (tokens[endIdx + 1]?.value === ';') endIdx++;

        const modVar = `__softn_m${modCounter++}`;
        const entry = { mod: modVar, spec, names: [] as Array<{ local: string; imported: string }>, namespaces: [] as string[] };

        // Parse clauseTokens: defaultIdent, `* as ns`, `{ a, b as c, "str" as d, type T }`
        let k = 0;
        if (clauseTokens[k] && (clauseTokens[k].type === 'ident' || clauseTokens[k].type === 'keyword') && clauseTokens[k].value !== '*') {
          entry.names.push({ local: clauseTokens[k].value, imported: 'default' });
          k++;
          if (clauseTokens[k]?.value === ',') k++;
        }
        if (clauseTokens[k]?.value === '*' && clauseTokens[k + 1]?.value === 'as' && clauseTokens[k + 2]) {
          entry.namespaces.push(clauseTokens[k + 2].value);
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
            const imported = readExportedIdent(clauseTokens[k]);
            let local = imported;
            k++;
            if (clauseTokens[k]?.value === 'as' && clauseTokens[k + 1]) {
              local = clauseTokens[k + 1].value;
              k += 2;
            }
            entry.names.push({ local, imported });
          }
        }

        hoisted.push(entry);
        edits.push({ start: tok.start, end: tokens[endIdx].end, replacement: '' });
        dropped.push([tok.start, tokens[endIdx].end]);
        i = endIdx;
        continue;
      }
    }

    // Top-level `export ...` statement
    if (tok.value === 'export' && braceDepth === 0 && parenDepth === 0 && bracketDepth === 0 && prev?.value !== '.') {
      const next = tokens[i + 1];
      if (!next) continue;

      // TypeScript `export type ...` or `export interface ...` -> drop `export` keyword (or whole re-export)
      // (`export declare …` too: what it declares is not there when the module runs, and with its
      // `export` left in, the registration did not compile.)
      if (next.value === 'interface' || next.value === 'declare') {
        edits.push({ start: tok.start, end: tok.end, replacement: '' });
        continue;
      }
      if (next.value === 'type' && tokens[i + 2]?.value === '*') {
        let j = i + 3;
        if (tokens[j]?.value === 'as' && tokens[j + 1]) j += 2;
        if (tokens[j]?.value === 'from' && tokens[j + 1]?.type === 'string') j += 1;
        j = skipImportAttributes(tokens, Math.min(j, tokens.length - 1));
        if (tokens[j + 1]?.value === ';') j++;
        edits.push({ start: tok.start, end: tokens[Math.min(j, tokens.length - 1)].end, replacement: '' });
        dropped.push([tok.start, tokens[Math.min(j, tokens.length - 1)].end]);
        i = j;
        continue;
      }
      if (next.value === 'type' && tokens[i + 2]?.value === '{') {
        let j = i + 3;
        while (j < tokens.length && tokens[j].value !== '}') j++;
        if (tokens[j + 1]?.value === 'from' && tokens[j + 2]?.type === 'string') j += 2;
        j = skipImportAttributes(tokens, Math.min(j, tokens.length - 1));
        if (tokens[j + 1]?.value === ';') j++;
        edits.push({ start: tok.start, end: tokens[Math.min(j, tokens.length - 1)].end, replacement: '' });
        dropped.push([tok.start, tokens[Math.min(j, tokens.length - 1)].end]);
        i = j;
        continue;
      }
      // TypeScript `export namespace N { … }` (and `export module N`): a value of that name.
      if ((next.value === 'namespace' || next.value === 'module') && tokens[i + 2]?.type === 'ident') {
        exportGetters.set(tokens[i + 2].value, tokens[i + 2].value);
        kinds.set(tokens[i + 2].value, 'other');
        edits.push({ start: tok.start, end: tok.end, replacement: '' });
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
          (afterDef?.value === 'async' && tokens[i + 3]?.value === 'function' && tokens[i + 4]?.value === '*' && tokens[i + 5]?.type === 'ident') ||
          (afterDef?.value === 'class' && tokens[i + 3]?.type === 'ident') ||
          (afterDef?.value === 'abstract' && tokens[i + 3]?.value === 'class' && tokens[i + 4]?.type === 'ident');

        if (isNamedDecl) {
          let nameIdx = i + 3;
          if (afterDef.value === 'async' || afterDef.value === 'abstract' || tokens[i + 3]?.value === '*') nameIdx = i + 4;
          if (afterDef.value === 'async' && tokens[i + 4]?.value === '*') nameIdx = i + 5;
          const declName = tokens[nameIdx].value;
          edits.push({ start: tok.start, end: next.end, replacement: '' });
          exportGetters.set('default', declName);
          kinds.set(declName, 'declared');
          i = i + 1;
          continue;
        } else if (
          (afterDef?.value === 'function' && (tokens[i + 3]?.value === '(' || (tokens[i + 3]?.value === '*' && tokens[i + 4]?.value === '('))) ||
          (afterDef?.value === 'async' && tokens[i + 3]?.value === 'function' && (tokens[i + 4]?.value === '(' || (tokens[i + 4]?.value === '*' && tokens[i + 5]?.value === '('))) ||
          (afterDef?.value === 'class' && (tokens[i + 3]?.value === '{' || tokens[i + 3]?.value === 'extends'))
        ) {
          // Anonymous default function/class declaration: keep it as a named declaration so
          // hoisting and ASI before `[...]`/`(...)` on the next line match ES spec.
          const defVar = `__softn_default`;
          let insertAt = afterDef.end;
          if (afterDef.value === 'async') {
            insertAt = tokens[i + 4]?.value === '*' ? tokens[i + 4].end : tokens[i + 3].end;
          } else if (afterDef.value === 'function' && tokens[i + 3]?.value === '*') {
            insertAt = tokens[i + 3].end;
          }
          edits.push({ start: tok.start, end: next.end, replacement: '' });
          edits.push({ start: insertAt, end: insertAt, replacement: ` ${defVar}` });
          exportGetters.set('default', defVar);
          kinds.set(defVar, 'const');
          i = i + 1;
          continue;
        } else {
          const defVar = `__softn_default`;
          edits.push({ start: tok.start, end: next.end, replacement: `const ${defVar} =` });
          exportGetters.set('default', defVar);
          kinds.set(defVar, 'const');
          i = i + 1;
          continue;
        }
      }

      // `export * from './mod'` or `export * as ns from './mod'`
      if (next.value === '*') {
        let j = i + 2;
        let asNs: string | null = null;
        if (tokens[j]?.value === 'as' && tokens[j + 1]) {
          asNs = readExportedIdent(tokens[j + 1]);
          j += 2;
        }
        if (tokens[j]?.value === 'from' && tokens[j + 1]?.type === 'string') {
          const spec = unquote(tokens[j + 1].value);
          staticImports.push(spec);
          let endIdx = skipImportAttributes(tokens, j + 1);
          if (tokens[endIdx + 1]?.value === ';') endIdx++;
          const modVar = `__softn_m${modCounter++}`;
          const rep = asNs
            ? `const ${modVar} = await __import(${JSON.stringify(spec)}, __meta.url); Object.defineProperty(__exports, ${JSON.stringify(asNs)}, { enumerable: true, configurable: true, get: () => ${modVar} });`
            : `const ${modVar} = await __import(${JSON.stringify(spec)}, __meta.url); __reexport(__exports, ${modVar});`;
          hoisted.push(rep);
          edits.push({ start: tok.start, end: tokens[endIdx].end, replacement: '' });
          dropped.push([tok.start, tokens[endIdx].end]);
          i = endIdx;
          continue;
        }
      }

      // `export { a, b as c, "str" as d } [from './mod']`
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
          const local = readExportedIdent(tokens[j]);
          let exported = local;
          j++;
          if (tokens[j]?.value === 'as' && tokens[j + 1]) {
            exported = readExportedIdent(tokens[j + 1]);
            j += 2;
          }
          specs.push({ local, exported });
        }
        let endIdx = j;
        if (tokens[j + 1]?.value === 'from' && tokens[j + 2]?.type === 'string') {
          const spec = unquote(tokens[j + 2].value);
          staticImports.push(spec);
          endIdx = skipImportAttributes(tokens, j + 2);
          if (tokens[endIdx + 1]?.value === ';') endIdx++;
          const modVar = `__softn_m${modCounter++}`;
          const defs = specs
            .map(
              (s) =>
                `Object.defineProperty(__exports, ${JSON.stringify(s.exported)}, { enumerable: true, configurable: true, get: () => ${modVar}[${JSON.stringify(s.local)}] });`
            )
            .join(' ');
          hoisted.push(`const ${modVar} = await __import(${JSON.stringify(spec)}, __meta.url); ${defs}`);
          edits.push({ start: tok.start, end: tokens[endIdx].end, replacement: '' });
          dropped.push([tok.start, tokens[endIdx].end]);
          i = endIdx;
          continue;
        } else {
          if (tokens[endIdx + 1]?.value === ';') endIdx++;
          for (const s of specs) exportGetters.set(s.exported, s.local);
          edits.push({ start: tok.start, end: tokens[endIdx].end, replacement: '' });
          dropped.push([tok.start, tokens[endIdx].end]);
          i = endIdx;
          continue;
        }
      }

      // `export function foo`, `export async function foo`, `export class Bar`, `export abstract class Bar`, `export enum E`
      if (
        next.value === 'function' ||
        next.value === 'class' ||
        next.value === 'enum' ||
        (next.value === 'abstract' && tokens[i + 2]?.value === 'class') ||
        (next.value === 'async' && tokens[i + 2]?.value === 'function')
      ) {
        let nameIdx = i + 2;
        if (next.value === 'async' || next.value === 'abstract') nameIdx = i + 3;
        if (tokens[nameIdx]?.value === '*') nameIdx++;
        if (tokens[nameIdx]) {
          exportGetters.set(tokens[nameIdx].value, tokens[nameIdx].value);
          kinds.set(tokens[nameIdx].value, next.value === 'enum' ? 'other' : 'declared');
        }
        edits.push({ start: tok.start, end: tok.end, replacement: '' });
        continue;
      }

      // `export const / let / var ...` (to its end: a `;` at its level, or a line break where one goes)
      if (next.value === 'const' || next.value === 'let' || next.value === 'var') {
        const names = extractDeclaredNames(tokens, i + 2, declarationEnd(tokens, code, i + 2));
        for (const n of names) {
          exportGetters.set(n, n);
          kinds.set(n, next.value === 'const' && tokens[i + 2]?.value !== 'enum' ? 'const' : 'other');
        }
        edits.push({ start: tok.start, end: tok.end, replacement: '' });
        continue;
      }
    }

    // The module's own top-level declarations, for what `export { … }` names.
    if (braceDepth === 0 && parenDepth === 0 && bracketDepth === 0 && prev?.value !== '.' && tok.type === 'keyword') {
      if (tok.value === 'const' && tokens[i + 1]?.value !== 'enum') {
        for (const n of extractDeclaredNames(tokens, i + 1, declarationEnd(tokens, code, i + 1))) if (!kinds.has(n)) kinds.set(n, 'const');
      } else if (tok.value === 'let' || tok.value === 'var') {
        for (const n of extractDeclaredNames(tokens, i + 1, declarationEnd(tokens, code, i + 1))) kinds.set(n, 'other');
      } else if ((tok.value === 'function' || tok.value === 'class') && (prev === null || !readsOn(prev) || prev.value === 'async')) {
        let at = i + 1;
        if (tokens[at]?.value === '*') at++;
        if (tokens[at]?.type === 'ident' && !kinds.has(tokens[at].value)) kinds.set(tokens[at].value, 'declared');
      }
    }
  }

  // Each name the module imports is read from its module where it is written (`count` becomes
  // `__softn_m0.count`), as a browser reads an import: the binding of the module that exports
  // it, as it is then. Each was a copy taken when the import ran: an `export let` the exporter
  // changed later was never seen by the modules that imported it, and in a cycle (a imports b, b
  // imports a) the copy was taken before the other module had made the value, and the app stopped
  // ("cannot access a lexical binding before initialization"). A name the module declares again
  // in a place of its own keeps a copy of its own as well, read in the statements that do so;
  // one it writes in a way not told for certain (a label, `delete x`) is read from the copy alone.
  const bindings = new Map<string, string>();
  // The names read from a copy where they are declared again: the spans of those statements.
  let again = new Map<string, Array<[number, number]> | null>();
  for (const entry of hoisted) {
    if (typeof entry === 'string') continue;
    for (const { local, imported } of entry.names) {
      if (!isKeywordWord(local) && dotName(local) && (imported === 'default' || dotName(imported))) bindings.set(local, `${entry.mod}.${imported}`);
    }
  }
  if (bindings.size > 0) {
    // Whether a token is the module's own code (not one of the statements taken out).
    const counted = (): ((t: Token) => boolean) => {
      let d = 0;
      return (t: Token): boolean => {
        while (d < dropped.length && dropped[d][1] <= t.start) d++;
        return !(d < dropped.length && dropped[d][0] <= t.start);
      };
    };
    // A direct `eval` reads the module's names by their names: it is handed the copies.
    if (tokens.some((t, k) => t.value === 'eval' && tokens[k + 1]?.value === '(' && tokens[k - 1]?.value !== '.')) bindings.clear();
    again = declaredAgain(tokens, code, new Set(bindings.keys()), counted());
    for (const [n, spans] of again) if (spans === null) bindings.delete(n);
    const { refs, unsure } = importUses(tokens, new Set(bindings.keys()), counted());
    for (const n of unsure) bindings.delete(n);
    for (const [n, list] of refs) {
      const read = bindings.get(n);
      if (read === undefined) continue;
      const spans = again.get(n);
      for (const { k, shorthand } of list) {
        const at = tokens[k].start;
        if (spans && spans.some(([from, to]) => from <= at && at < to)) continue;
        edits.push({ start: at, end: tokens[k].end, replacement: shorthand ? `${n}: ${read}` : read });
      }
    }
  }

  // Apply non-overlapping edits in one O(N + M) forward pass, preserving original line counts for exact source-map line numbers.
  const body = applyEditsLinear(code, edits, true);

  const getterLines: string[] = [];
  // What it exports that does not change once it has run (a `const`, a default value, a
  // function's or a class's own name it never assigns to): the registry keeps each as a value
  // then, so that reading one costs what reading a property does, not a call.
  const fixed: string[] = [];
  for (const [exported, local] of exportGetters) {
    getterLines.push(
      `Object.defineProperty(__exports, ${JSON.stringify(exported)}, { enumerable: true, configurable: true, get: function () { return ${bindings.get(local) ?? local}; } });`
    );
    const kind = bindings.has(local) ? undefined : kinds.get(local);
    if (kind === 'const' || (kind === 'declared' && !assignedTo(tokens, local))) fixed.push(exported);
  }
  const header = getterLines.slice();
  if (fixed.length > 0) header.push(`__softnFixed(${JSON.stringify(fixed)});`);
  if (hoisted.length > 0) {
    header.push(
      hoisted
        .map((entry) => {
          if (typeof entry === 'string') return entry;
          const parts = [`const ${entry.mod} = await __import(${JSON.stringify(entry.spec)}, __meta.url);`];
          for (const ns of entry.namespaces) parts.push(`const ${ns} = ${entry.mod};`);
          for (const { local, imported } of entry.names) {
            if (bindings.has(local) && !again.has(local)) continue;
            parts.push(imported === 'default' ? `const ${local} = ${entry.mod}.default;` : `const ${local} = ${entry.mod}[${JSON.stringify(imported)}];`);
          }
          return parts.join(' ');
        })
        .join(' ')
    );
  }

  const factoryCode =
    `__softnModules.define(${JSON.stringify(moduleUrl)}, async function (__exports, __import, __meta, __reexport, __softnFixed) {\n` +
    (header.length > 0 ? header.join('\n') + '\n' : '') +
    body +
    `\n});\n`;

  return { factoryCode, staticImports, dynamicImports, headerLines: 1 + header.length };
}

/**
 * Runtime registry preamble injected once into the ZIPP Worker before any ES module executes.
 */
export const ESM_REGISTRY_PREAMBLE = String.raw`
var __softnModules = (function () {
  var factories = Object.create(null);
  var evaluating = Object.create(null);
  var namespaces = Object.create(null);
  var evaluated = Object.create(null);
  // What each module being run waits for: the modules it has asked for that are still running.
  var waits = Object.create(null);

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

  // What a module exports that does not change once it has run (its registration names them),
  // kept as values then: an import read where it is written is a property's read, not a call.
  function keep(ns, names) {
    for (var i = 0; i < names.length; i++) {
      var d = Object.getOwnPropertyDescriptor(ns, names[i]);
      if (!d || !d.get) continue;
      try {
        Object.defineProperty(ns, names[i], { value: d.get.call(ns), enumerable: true, configurable: true, writable: false });
      } catch (e) {}
    }
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
        var urls = reply.urls || [];
        var failedAt = -1;
        try {
          for (var i = 0; i < blocks.length; i++) {
            failedAt = i;
            compile(String(blocks[i]));
          }
        } catch (e) {
          // Not compiled: the host lets go of them, so that asking again asks again (it kept
          // them, and every later import of them failed with nothing to say why).
          try { host.call('esm.forget', [JSON.stringify(urls)], function () {}); } catch (ignored) {}
          var failedUrl = (failedAt >= 0 && urls[failedAt]) ? String(urls[failedAt]) : String(specifier);
          var msg = (e && e.message) ? String(e.message) : String(e);
          if (msg.indexOf(failedUrl) < 0) {
            var wrapped = new SyntaxError(failedUrl + ': ' + msg);
            if (e && e.stack) wrapped.stack = e.stack;
            reject(wrapped);
          } else {
            reject(e);
          }
          return;
        }
        resolve(reply.url);
      });
    });
  }

  // Whether the module 'from' waits, through the modules it waits for, for the module 'to'.
  function waitsFor(from, to, seen) {
    if (from === to) return true;
    if (seen[from]) return false;
    seen[from] = true;
    var next = waits[from];
    if (next) {
      for (var k in next) {
        if (waitsFor(k, to, seen)) return true;
      }
    }
    return false;
  }

  // The module 'asker' waits for 'url' to have run (p), until it has.
  function waitOn(asker, url, p) {
    if (!asker) return p;
    var list = waits[asker] || (waits[asker] = Object.create(null));
    list[url] = (list[url] || 0) + 1;
    var done = function () {
      if (--list[url] <= 0) delete list[url];
    };
    p.then(done, done);
    return p;
  }

  function resolveKnown(url, asker) {
    if (evaluated[url]) return Promise.resolve(evaluated[url]);
    if (evaluating[url]) {
      // A module that waits, through what it imports, for the one asking (a cycle; the one
      // asking itself among them): its namespace as it is now, as a browser links a cycle. It
      // was that only for a module asking from inside the other's own chain of imports: two
      // modules of a cycle imported at once (Promise.all of two import()s) waited for each
      // other for good. Otherwise, wait for it to have run.
      if (asker && waitsFor(url, asker, Object.create(null))) return Promise.resolve(namespaces[url]);
      return waitOn(asker, url, evaluating[url]);
    }
    return null;
  }

  function importModule(specifier, importerUrl, asker) {
    var specStr = String(specifier);
    var known = resolveKnown(specStr, asker);
    if (known) return known;
    if (factories[specStr]) return runFactory(specStr, asker);

    var resolvedUrl = null;
    try {
      resolvedUrl = host.callSync('esm.resolve', specStr, String(importerUrl || ''));
    } catch (e) {}

    if (resolvedUrl) {
      var knownResolved = resolveKnown(resolvedUrl, asker);
      if (knownResolved) return knownResolved;
      if (factories[resolvedUrl]) return runFactory(resolvedUrl, asker);
    }
    return loadFromHost(specifier, importerUrl).then(function (url) {
      var knownLoaded = resolveKnown(url, asker);
      if (knownLoaded) return knownLoaded;
      if (!factories[url]) throw new TypeError('Module did not register factory: ' + url);
      return runFactory(url, asker);
    });
  }

  function runFactory(url, asker) {
    var ns = makeNamespace();
    namespaces[url] = ns;
    var childImport = function (spec, impUrl) {
      return importModule(spec, impUrl, url);
    };
    var meta = {
      url: url,
      env: { MODE: 'production', PROD: true, DEV: false, BASE_URL: '/' },
    };
    var fixed = null;
    var p = Promise.resolve()
      .then(function () {
        return factories[url](ns, childImport, meta, reexport, function (names) { fixed = names; });
      })
      .then(function () {
        if (fixed) keep(ns, fixed);
        evaluated[url] = ns;
        delete evaluating[url];
        return ns;
      }, function (err) {
        delete evaluating[url];
        delete namespaces[url];
        delete evaluated[url];
        throw err;
      });
    evaluating[url] = p;
    return waitOn(asker, url, p);
  }

  return {
    define: function (url, fn) { factories[url] = fn; },
    has: function (url) { return !!factories[url] || !!evaluated[url]; },
    import: function (specifier, importerUrl) { return importModule(specifier, importerUrl, null); },
  };
})();
`;
