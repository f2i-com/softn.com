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
};

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
        for (const ext of ['.js', '.mjs', '.ts', '.tsx', '.jsx', '/index.js', '/index.ts', '.vue', '/index.jsx', '/index.vue']) {
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
        while (i < len && depth > 0) {
          const c = code.charCodeAt(i);
          if (c === 92) { i += 2; continue; }
          if (c === 39 || c === 34) { skipString(c); continue; }
          if (c === 96) { skipTemplate(); continue; }
          if (c === 47 && code.charCodeAt(i + 1) === 47) { skipLineComment(); continue; }
          if (c === 47 && code.charCodeAt(i + 1) === 42) { skipBlockComment(); continue; }
          if (c === 123) depth++;
          else if (c === 125) depth--;
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

/** Extract bound variable names from a JS/TS declaration list (`const a = 1, { b, c: d } = x`). */
function extractDeclaredNames(tokens: Token[], startIdx: number, endIdx: number): string[] {
  const names: string[] = [];
  let i = startIdx;
  let parenDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  let inInit = false;
  let inTypeAnnotation = false;

  while (i < endIdx) {
    const t = tokens[i];
    if (t.type === 'punct') {
      if (t.value === '(') parenDepth++;
      else if (t.value === ')') parenDepth = Math.max(0, parenDepth - 1);
      else if (t.value === '{') braceDepth++;
      else if (t.value === '}') braceDepth = Math.max(0, braceDepth - 1);
      else if (t.value === '[') bracketDepth++;
      else if (t.value === ']') bracketDepth = Math.max(0, bracketDepth - 1);
      else if (t.value === '=' && parenDepth === 0 && braceDepth === 0 && bracketDepth === 0) {
        inInit = true;
        inTypeAnnotation = false;
      } else if (t.value === ',' && parenDepth === 0 && braceDepth === 0 && bracketDepth === 0) {
        inInit = false;
        inTypeAnnotation = false;
      } else if (t.value === ':' && !inInit && braceDepth === 0 && parenDepth === 0 && bracketDepth === 0) {
        inTypeAnnotation = true;
      }
      i++;
      continue;
    }

    if (!inInit && !inTypeAnnotation && parenDepth === 0) {
      if (braceDepth > 0) {
        // Inside `{ a, b: c, d = 1 }`: if followed by `:`, the name after `:` is the bound binding
        if ((t.type === 'ident' || t.type === 'keyword') && tokens[i + 1]?.value === ':') {
          i += 2;
          continue;
        }
        if (t.type === 'ident' && tokens[i - 1]?.value !== '=') {
          names.push(t.value);
        }
      } else if (t.type === 'ident') {
        names.push(t.value);
      }
    }
    i++;
  }
  return names;
}

export interface TransformedModule {
  /** Transformed JS/TS factory registration code safe for `Engine.initSource` / `evalInContext`. */
  factoryCode: string;
  /** Static module specifiers discovered in this module. */
  staticImports: string[];
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

    // Handle dynamic `import(...)` anywhere (not preceded by `.` or `function`)
    if (
      tok.value === 'import' &&
      prev?.value !== '.' &&
      prev?.value !== 'function' &&
      tokens[i + 1]?.value === '('
    ) {
      // Find the matching closing `)`: the importer's address goes in as the second argument.
      // A second argument of the script's own (`import(spec, { with: { type: 'json' } })`) is
      // dropped for it: appended after one, the address landed in a third place the loader
      // never reads, and the specifier was resolved against the page instead of the module.
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
      if (j < tokens.length) {
        edits.push({ start: tok.start, end: tok.end, replacement: '__import' });
        edits.push({ start: tokens[firstComma < 0 ? j : firstComma].start, end: tokens[j].end, replacement: ', __meta.url)' });
      }
      continue;
    }

    // Top-level `import ...` statement
    if (tok.value === 'import' && braceDepth === 0 && parenDepth === 0 && bracketDepth === 0 && prev?.value !== '.') {
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

  return { factoryCode, staticImports };
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

  function loadFromHost(specifier, importerUrl) {
    return new Promise(function (resolve, reject) {
      host.call('esm.load', [String(specifier), String(importerUrl || '')], function (reply) {
        if (!reply || reply.error) {
          reject(new TypeError(reply && reply.error ? String(reply.error) : 'Failed to fetch dynamically imported module: ' + specifier));
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
