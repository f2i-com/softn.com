/**
 * Lightweight Lexical JSX / TSX -> `globalThis.__softnJsx` Transpiler.
 *
 * Allows SoftN containers to execute uncompiled React `.tsx` and `.jsx` source
 * apps directly inside ZIPP WASM without requiring a Vite/Webpack build step,
 * while preserving TypeScript type annotations/generics for `zipp-typescript.wasm`.
 *
 * Emits calls to `globalThis.__softnJsx(tag, props, ...children)` and
 * `globalThis.__softnFragment` so both classic (`import React from 'react'`)
 * and automatic React 17/18/19 JSX (`jsx: "react-jsx"`) work identically.
 */

const JSX_EXPR_KEYWORDS = new Set([
  'return',
  'yield',
  'await',
  'throw',
  'case',
  'default',
  'else',
  'do',
  'in',
  'of',
  'typeof',
  'void',
  'delete',
  'new',
]);

const JSX_EXPR_PUNCT = new Set([
  '(',
  '[',
  '{',
  ',',
  ';',
  ':',
  '=',
  '=>',
  '?',
  '&&',
  '||',
  '??',
  '!',
  '+',
  '-',
  '*',
  '/',
  '%',
  '|',
  '&',
  '^',
  '~',
]);

const REGEX_PRECEDING_KEYWORDS = new Set([
  'return',
  'throw',
  'case',
  'default',
  'delete',
  'void',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'yield',
  'await',
  'else',
  'do',
]);

const REGEX_PRECEDING_PUNCT = new Set([
  '(',
  '[',
  '{',
  ',',
  ';',
  ':',
  '=',
  '=>',
  '!',
  '&',
  '&&',
  '|',
  '||',
  '??',
  '?',
  '+',
  '-',
  '*',
  '%',
  '^',
  '~',
  '<',
  '>',
]);

function isIdentStart(ch: number): boolean {
  return (ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122) || ch === 95 || ch === 36 || ch > 127;
}

function isIdentPart(ch: number): boolean {
  return isIdentStart(ch) || (ch >= 48 && ch <= 57);
}

function isJsxNamePart(ch: number): boolean {
  return isIdentPart(ch) || ch === 45 || ch === 46 || ch === 58; // - . :
}

function isWs(ch: number): boolean {
  return ch === 32 || ch === 9 || ch === 10 || ch === 13 || ch === 12 || ch === 160;
}

/**
 * The named character references JSX reads (XHTML's 253, as Babel, esbuild and TypeScript
 * read them), as runs of names of consecutive code points. Only six were read, and text with
 * `&copy;`, `&mdash;`, `&times;` or `&hellip;` in it showed the reference itself.
 */
const ENTITY_RUNS: Array<[number, string]> = [
  [0x22, 'quot'], [0x26, 'amp apos'], [0x3c, 'lt'], [0x3e, 'gt'],
  [0xa0, 'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest ' +
    'Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig ' +
    'agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml'],
  [0x152, 'OElig oelig'], [0x160, 'Scaron scaron'], [0x178, 'Yuml'], [0x192, 'fnof'], [0x2c6, 'circ'], [0x2dc, 'tilde'],
  [0x391, 'Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa Lambda Mu Nu Xi Omicron Pi Rho'],
  [0x3a3, 'Sigma Tau Upsilon Phi Chi Psi Omega'],
  [0x3b1, 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigmaf sigma tau upsilon phi chi psi omega'],
  [0x3d1, 'thetasym upsih'], [0x3d6, 'piv'],
  [0x2002, 'ensp emsp'], [0x2009, 'thinsp'], [0x200c, 'zwnj zwj lrm rlm'], [0x2013, 'ndash mdash'], [0x2018, 'lsquo rsquo sbquo'],
  [0x201c, 'ldquo rdquo bdquo'], [0x2020, 'dagger Dagger bull'], [0x2026, 'hellip'], [0x2030, 'permil'], [0x2032, 'prime Prime'],
  [0x2039, 'lsaquo rsaquo'], [0x203e, 'oline'], [0x2044, 'frasl'], [0x20ac, 'euro'], [0x2111, 'image'], [0x2118, 'weierp'],
  [0x211c, 'real'], [0x2122, 'trade'], [0x2135, 'alefsym'], [0x2190, 'larr uarr rarr darr harr'], [0x21b5, 'crarr'],
  [0x21d0, 'lArr uArr rArr dArr hArr'], [0x2200, 'forall'], [0x2202, 'part exist'], [0x2205, 'empty'], [0x2207, 'nabla isin notin'],
  [0x220b, 'ni'], [0x220f, 'prod'], [0x2211, 'sum minus'], [0x2217, 'lowast'], [0x221a, 'radic'], [0x221d, 'prop infin'],
  [0x2220, 'ang'], [0x2227, 'and or cap cup int'], [0x2234, 'there4'], [0x223c, 'sim'], [0x2245, 'cong'], [0x2248, 'asymp'],
  [0x2260, 'ne equiv'], [0x2264, 'le ge'], [0x2282, 'sub sup nsub'], [0x2286, 'sube supe'], [0x2295, 'oplus'], [0x2297, 'otimes'],
  [0x22a5, 'perp'], [0x22c5, 'sdot'], [0x2308, 'lceil rceil lfloor rfloor'], [0x2329, 'lang rang'], [0x25ca, 'loz'],
  [0x2660, 'spades'], [0x2663, 'clubs'], [0x2665, 'hearts diams'],
];

let entities: Map<string, string> | null = null;

/** The character a named reference stands for, or undefined. */
function namedEntity(name: string): string | undefined {
  if (entities === null) {
    entities = new Map();
    for (const [first, names] of ENTITY_RUNS) {
      names.split(' ').forEach((n, k) => entities!.set(n, String.fromCharCode(first + k)));
    }
  }
  return entities.get(name);
}

function decodeHtmlEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(?:#x([0-9a-fA-F]+)|#([0-9]+)|([A-Za-z][A-Za-z0-9]*));/g, (m, hex, dec, named) => {
    if (hex) {
      const cp = parseInt(hex, 16);
      return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    if (dec) {
      const cp = parseInt(dec, 10);
      return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return namedEntity(named) ?? m;
  });
}

/** Line breaks in text as JS counts them (`\r\n` once). */
function lineBreaks(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 10) n++;
    else if (c === 13) {
      n++;
      if (text.charCodeAt(i + 1) === 10) i++;
    }
  }
  return n;
}

function newlines(n: number): string {
  return n > 0 ? '\n'.repeat(n) : '';
}

/**
 * Code with what surrounds it reduced to its line breaks, before it and after it: what the
 * element is turned into has as many lines as it had, so the lines after it (and inside it)
 * are where they were when an error names one. `.trim()` took them away, and every error
 * after a JSX element of more than one line was reported lines too early.
 */
function keepLines(code: string, empty = ''): string {
  const trimmed = code.trim();
  if (trimmed === code) return code || empty;
  const lead = code.length - code.trimStart().length;
  return newlines(lineBreaks(code.slice(0, lead))) + (trimmed || empty) + newlines(lineBreaks(code.slice(lead + trimmed.length)));
}

/** Collapse JSX child text lines following the standard JSX/Babel whitespace rule. */
function cleanJsxText(raw: string): string {
  if (!raw.includes('\n') && !raw.includes('\r')) {
    return decodeHtmlEntities(raw);
  }
  const lines = raw.split(/\r\n|\n|\r/);
  let lastNonEmpty = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/[^\t ]/.test(lines[i])) lastNonEmpty = i;
  }
  if (lastNonEmpty === -1) return '';
  const parts: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].replace(/\t/g, ' ');
    if (i > 0) line = line.replace(/^ +/, '');
    if (i < lines.length - 1) line = line.replace(/ +$/, '');
    if (line.length > 0) parts.push(line);
  }
  return decodeHtmlEntities(parts.join(' '));
}

function quotePropKey(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
}

function isHtmlTag(tagName: string): boolean {
  if (!tagName || tagName.includes('.')) return false;
  const first = tagName.charCodeAt(0);
  return first >= 97 && first <= 122; // lowercase a-z -> intrinsic element
}

function stripLeadingComments(expr: string): string {
  let s = expr.trim();
  while (s.startsWith('/*') || s.startsWith('//')) {
    if (s.startsWith('/*')) {
      const end = s.indexOf('*/', 2);
      if (end < 0) return '';
      s = s.slice(end + 2).trim();
    } else {
      const nl = s.indexOf('\n');
      if (nl < 0) return '';
      s = s.slice(nl + 1).trim();
    }
  }
  return s;
}

const MAX_JSX_SCAN_DEPTH = 128;

class JsxScanner {
  private readonly src: string;
  private readonly len: number;
  private pos = 0;
  private depth = 0;

  constructor(src: string) {
    this.src = src;
    this.len = src.length;
  }

  transform(): string {
    return this.scanCode(false);
  }

  private skipWsAndComments(): string {
    const start = this.pos;
    while (this.pos < this.len) {
      const ch = this.src.charCodeAt(this.pos);
      if (isWs(ch)) {
        this.pos++;
        continue;
      }
      if (ch === 47 && this.pos + 1 < this.len) {
        const next = this.src.charCodeAt(this.pos + 1);
        if (next === 47) {
          this.pos += 2;
          while (this.pos < this.len && this.src.charCodeAt(this.pos) !== 10) this.pos++;
          continue;
        }
        if (next === 42) {
          this.pos += 2;
          while (this.pos + 1 < this.len && !(this.src.charCodeAt(this.pos) === 42 && this.src.charCodeAt(this.pos + 1) === 47)) {
            this.pos++;
          }
          this.pos = Math.min(this.len, this.pos + 2);
          continue;
        }
      }
      break;
    }
    return this.src.slice(start, this.pos);
  }

  /** Past whitespace and comments from p (without moving), to what comes next. */
  private pastWsAndComments(p: number): number {
    while (p < this.len) {
      const ch = this.src.charCodeAt(p);
      if (isWs(ch)) {
        p++;
        continue;
      }
      if (ch === 47 && this.src.charCodeAt(p + 1) === 47) {
        while (p < this.len && this.src.charCodeAt(p) !== 10) p++;
        continue;
      }
      if (ch === 47 && this.src.charCodeAt(p + 1) === 42) {
        const end = this.src.indexOf('*/', p + 2);
        p = end < 0 ? this.len : end + 2;
        continue;
      }
      break;
    }
    return p;
  }

  private scanString(quote: number): string {
    const start = this.pos;
    this.pos++;
    while (this.pos < this.len) {
      const ch = this.src.charCodeAt(this.pos);
      if (ch === 92) {
        this.pos += 2;
        continue;
      }
      if (ch === quote) {
        this.pos++;
        break;
      }
      this.pos++;
    }
    return this.src.slice(start, this.pos);
  }

  private scanRegex(): string {
    const start = this.pos;
    this.pos++; // /
    let inClass = false;
    while (this.pos < this.len) {
      const ch = this.src.charCodeAt(this.pos);
      if (ch === 92) {
        this.pos += 2;
        continue;
      }
      if (ch === 91) inClass = true;
      else if (ch === 93) inClass = false;
      else if (ch === 47 && !inClass) {
        this.pos++;
        while (this.pos < this.len && isIdentPart(this.src.charCodeAt(this.pos))) this.pos++;
        break;
      } else if (ch === 10 || ch === 13) {
        break;
      }
      this.pos++;
    }
    return this.src.slice(start, this.pos);
  }

  private scanTemplate(): string {
    if (this.depth >= MAX_JSX_SCAN_DEPTH) {
      throw new SyntaxError('JSX template nesting depth exceeded maximum limit');
    }
    this.depth++;
    try {
      let out = '`';
      this.pos++; // `
      while (this.pos < this.len) {
        const ch = this.src.charCodeAt(this.pos);
        if (ch === 92) {
          out += this.src.slice(this.pos, this.pos + 2);
          this.pos += 2;
          continue;
        }
        if (ch === 96) {
          out += '`';
          this.pos++;
          break;
        }
        if (ch === 36 && this.pos + 1 < this.len && this.src.charCodeAt(this.pos + 1) === 123) {
          out += '${';
          this.pos += 2;
          out += this.scanCode(true);
          out += '}';
          continue;
        }
        out += this.src[this.pos++];
      }
      return out;
    } finally {
      this.depth--;
    }
  }

  /** Scan a JSX string attribute (`"..."` or `'...'`): backslashes are literal in JSX attributes. */
  private scanJsxAttrString(quote: number): string {
    const start = this.pos;
    this.pos++;
    while (this.pos < this.len) {
      if (this.src.charCodeAt(this.pos) === quote) {
        this.pos++;
        break;
      }
      this.pos++;
    }
    return this.src.slice(start, this.pos);
  }

  /** Skip balanced TypeScript generic type arguments `<...>` starting at `startPos`, or return -1 if unbalanced. */
  private skipBalancedAngle(startPos: number): number {
    if (startPos >= this.len || this.src.charCodeAt(startPos) !== 60) return -1;
    let p = startPos + 1;
    let depth = 1;
    while (p < this.len && depth > 0) {
      const c = this.src.charCodeAt(p);
      if (c === 34 || c === 39) {
        const q = c;
        p++;
        while (p < this.len) {
          if (this.src.charCodeAt(p) === 92) { p += 2; continue; }
          if (this.src.charCodeAt(p) === q) { p++; break; }
          p++;
        }
        continue;
      }
      if (c === 60) depth++;
      else if (c === 62) {
        // Ignore `=>` arrow inside generic function type `<(x: number) => void>`
        if (p > startPos && this.src.charCodeAt(p - 1) === 61) {
          p++;
          continue;
        }
        depth--;
      }
      p++;
    }
    return depth === 0 ? p : -1;
  }

  /**
   * Peek ahead from a `<` in expression position to determine whether it begins
   * a JSX element/fragment or a TypeScript generic parameter list (`<T,>`, `<T extends X>`, `<const T>`).
   */
  private looksLikeJsxStart(): boolean {
    const len = this.len;
    let p = this.pos + 1;
    if (p >= len) return false;
    // Fragment: `<>`
    if (this.src.charCodeAt(p) === 62) return true;
    if (!isIdentStart(this.src.charCodeAt(p))) return false;
    const nameStart = p;
    p++;
    while (p < len && isJsxNamePart(this.src.charCodeAt(p))) p++;
    const tagName = this.src.slice(nameStart, p);
    // Optional TypeScript generic arguments on a JSX component: `<Comp<T> prop={1} />`
    if (!isHtmlTag(tagName) && p < len && this.src.charCodeAt(p) === 60) {
      const afterGeneric = this.skipBalancedAngle(p);
      if (afterGeneric > p) p = afterGeneric;
    }
    // Skip whitespace and comments after tag name (and optional type args): `<div /* … */ id="a">`
    // is an element (it was left as it was, and the module did not compile).
    p = this.pastWsAndComments(p);
    if (p >= len) return false;
    const nextCh = this.src.charCodeAt(p);
    // `<const T>` TypeScript 5.0 const type parameter
    if (tagName === 'const' && isIdentStart(nextCh)) return false;
    // `<T,>` or `<T = X>` -> TS generic parameter list
    if (nextCh === 44 || nextCh === 61) return false;
    // `<T extends ...>` -> TS generic constraint
    if (this.src.startsWith('extends', p) && (p + 7 >= len || !isIdentPart(this.src.charCodeAt(p + 7)))) {
      return false;
    }
    // `<Tag/>` or `<Tag>` or `<Tag attr...>` or `<Tag {...spread}>`
    if (nextCh === 47 && p + 1 < len && this.src.charCodeAt(p + 1) === 62) return true;
    if (nextCh === 62) {
      // Disambiguate rare `<T>(x) => ...` TS generic arrow (not standard in .tsx, but defensive):
      if (!isHtmlTag(tagName) && !tagName.includes('.') && !tagName.includes('-')) {
        let q = p + 1;
        while (q < len && isWs(this.src.charCodeAt(q))) q++;
        if (q < len && this.src.charCodeAt(q) === 40) {
          // Check for exact closing `</TagName>` (word boundary, zero slice/regex allocation).
          const needle = `</${tagName}`;
          let found = false;
          let at = this.src.indexOf(needle, q);
          while (at >= 0) {
            const afterIdx = at + needle.length;
            const afterCh = afterIdx < len ? this.src.charCodeAt(afterIdx) : -1;
            if (afterCh === 62 || (afterCh >= 0 && isWs(afterCh))) {
              found = true;
              break;
            }
            at = this.src.indexOf(needle, at + 2);
          }
          if (!found) return false;
        }
      }
      return true;
    }
    if (nextCh === 123 && p + 3 < len && this.src.slice(p + 1, p + 4) === '...') return true;
    if (isIdentStart(nextCh)) return true;
    return false;
  }

  /**
   * Scan JS/TS code until EOF or (when `stopOnBrace` is true) the matching `}`.
   */
  private scanCode(stopOnBrace: boolean): string {
    let out = '';
    let braceDepth = 0;
    let prevSigType: 'ident' | 'keyword' | 'punct' | 'literal' | null = null;
    let prevSigVal = '';

    const canStartJsx = (): boolean => {
      if (prevSigType === null) return true;
      if (prevSigType === 'keyword') return JSX_EXPR_KEYWORDS.has(prevSigVal);
      if (prevSigType === 'punct') return JSX_EXPR_PUNCT.has(prevSigVal);
      return false;
    };

    const canStartRegex = (): boolean => {
      if (prevSigType === null) return true;
      if (prevSigType === 'keyword') return REGEX_PRECEDING_KEYWORDS.has(prevSigVal);
      if (prevSigType === 'punct') return REGEX_PRECEDING_PUNCT.has(prevSigVal);
      return false;
    };

    while (this.pos < this.len) {
      const ch = this.src.charCodeAt(this.pos);

      // Whitespace
      if (isWs(ch)) {
        out += this.src[this.pos++];
        continue;
      }

      // Comments or regex or `/`
      if (ch === 47) {
        const next = this.pos + 1 < this.len ? this.src.charCodeAt(this.pos + 1) : 0;
        if (next === 47) {
          const start = this.pos;
          this.pos += 2;
          while (this.pos < this.len && this.src.charCodeAt(this.pos) !== 10) this.pos++;
          out += this.src.slice(start, this.pos);
          continue;
        }
        if (next === 42) {
          const start = this.pos;
          this.pos += 2;
          while (this.pos + 1 < this.len && !(this.src.charCodeAt(this.pos) === 42 && this.src.charCodeAt(this.pos + 1) === 47)) {
            this.pos++;
          }
          this.pos = Math.min(this.len, this.pos + 2);
          out += this.src.slice(start, this.pos);
          continue;
        }
        if (canStartRegex()) {
          out += this.scanRegex();
          prevSigType = 'literal';
          prevSigVal = '/re/';
          continue;
        }
        out += '/';
        this.pos++;
        prevSigType = 'punct';
        prevSigVal = '/';
        continue;
      }

      // Strings
      if (ch === 34 || ch === 39) {
        out += this.scanString(ch);
        prevSigType = 'literal';
        prevSigVal = '""';
        continue;
      }

      // Template literal
      if (ch === 96) {
        out += this.scanTemplate();
        prevSigType = 'literal';
        prevSigVal = '``';
        continue;
      }

      // Braces
      if (ch === 123) {
        braceDepth++;
        out += '{';
        this.pos++;
        prevSigType = 'punct';
        prevSigVal = '{';
        continue;
      }
      if (ch === 125) {
        if (stopOnBrace && braceDepth === 0) {
          this.pos++; // consume matching `}`
          return out;
        }
        if (braceDepth > 0) braceDepth--;
        out += '}';
        this.pos++;
        prevSigType = 'punct';
        prevSigVal = '}';
        continue;
      }

      // Potential JSX element/fragment
      if (ch === 60 && canStartJsx() && this.looksLikeJsxStart()) {
        out += this.parseJsxElement();
        prevSigType = 'literal';
        prevSigVal = 'jsx';
        continue;
      }

      // Identifiers & keywords
      if (isIdentStart(ch)) {
        const start = this.pos;
        this.pos++;
        while (this.pos < this.len && isIdentPart(this.src.charCodeAt(this.pos))) this.pos++;
        const word = this.src.slice(start, this.pos);
        out += word;
        // A property's name is no keyword, however spelled: `x.default / 2` divides (taken for a
        // regular expression's start, it swallowed the line and the brackets on it).
        if ((JSX_EXPR_KEYWORDS.has(word) || REGEX_PRECEDING_KEYWORDS.has(word)) && !(prevSigType === 'punct' && prevSigVal === '.')) {
          prevSigType = 'keyword';
        } else {
          prevSigType = 'ident';
        }
        prevSigVal = word;
        continue;
      }

      // Numbers
      if (ch >= 48 && ch <= 57) {
        const start = this.pos;
        this.pos++;
        while (this.pos < this.len) {
          const c = this.src.charCodeAt(this.pos);
          if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 46) {
            this.pos++;
          } else {
            break;
          }
        }
        out += this.src.slice(start, this.pos);
        prevSigType = 'literal';
        prevSigVal = '0';
        continue;
      }

      // Multi-char operators (`++`, `--`, `=>`, `&&`, `||`, `??`, etc.): keeping `++`/`--`
      // intact ensures `a++ < b` and `a++ / b` never trigger JSX or regex scanning.
      const two = this.src.slice(this.pos, this.pos + 2);
      if (
        two === '++' ||
        two === '--' ||
        two === '=>' ||
        two === '&&' ||
        two === '||' ||
        two === '??' ||
        two === '==' ||
        two === '!=' ||
        two === '<=' ||
        two === '>='
      ) {
        out += two;
        this.pos += 2;
        prevSigType = 'punct';
        prevSigVal = two;
        continue;
      }

      // Single-char punctuation
      const single = this.src[this.pos++];
      out += single;
      prevSigType = 'punct';
      prevSigVal = single;
    }

    return out;
  }

  private jsxDepth = 0;

  private parseJsxElement(): string {
    if (this.jsxDepth >= 256) {
      throw new Error('JSX nesting depth limit exceeded (max 256)');
    }
    this.jsxDepth++;
    try {
      return this.parseJsxElementInner();
    } finally {
      this.jsxDepth--;
    }
  }

  private parseJsxElementInner(): string {
    // Expect `<`
    this.pos++;

    // Fragment: `<> ... </>`
    if (this.pos < this.len && this.src.charCodeAt(this.pos) === 62) {
      this.pos++; // consume `>`
      const children = this.parseJsxChildren(0);
      const args = ['globalThis.__softnFragment', 'null', ...children.parts];
      return `globalThis.__softnJsx(${args.join(', ')}${newlines(children.owed)})`;
    }

    // The element's line breaks not yet in what it becomes: put in before the next of its
    // props or children, or at its end. (What it became was all on one line, and every line
    // after an element of more than one was reported that many lines too early.)
    let owed = 0;

    // Parse tag name (and skip optional TypeScript generic type arguments `<T>` on component tags)
    const tagStart = this.pos;
    while (this.pos < this.len && isJsxNamePart(this.src.charCodeAt(this.pos))) this.pos++;
    const tagName = this.src.slice(tagStart, this.pos);
    if (!isHtmlTag(tagName) && this.pos < this.len && this.src.charCodeAt(this.pos) === 60) {
      const afterGeneric = this.skipBalancedAngle(this.pos);
      if (afterGeneric > this.pos) {
        owed += lineBreaks(this.src.slice(this.pos, afterGeneric));
        this.pos = afterGeneric;
      }
    }
    const tagExpr = isHtmlTag(tagName) ? JSON.stringify(tagName) : tagName;

    // Parse attributes / props (each with the line breaks before it)
    const propChunks: PropChunk[] = [];
    let selfClosing = false;

    while (this.pos < this.len) {
      owed += lineBreaks(this.skipWsAndComments());
      if (this.pos >= this.len) break;
      const ch = this.src.charCodeAt(this.pos);
      if (ch === 47 && this.pos + 1 < this.len && this.src.charCodeAt(this.pos + 1) === 62) {
        selfClosing = true;
        this.pos += 2;
        break;
      }
      if (ch === 62) {
        this.pos++;
        break;
      }
      // Spread prop `{...expr}`
      if (ch === 123) {
        this.pos++; // `{`
        const raw = this.scanCode(true);
        const lead = raw.length - raw.trimStart().length;
        if (raw.startsWith('...', lead)) {
          propChunks.push({ kind: 'spread', pre: newlines(owed + lineBreaks(raw.slice(0, lead))), expr: keepLines(raw.slice(lead + 3)) });
          owed = 0;
        } else {
          owed += lineBreaks(raw);
        }
        continue;
      }
      // Attribute name
      if (isIdentStart(ch)) {
        const before = owed;
        owed = 0;
        const aStart = this.pos;
        this.pos++;
        while (this.pos < this.len && isJsxNamePart(this.src.charCodeAt(this.pos))) this.pos++;
        const attrName = this.src.slice(aStart, this.pos);
        let gap = lineBreaks(this.skipWsAndComments());
        let val = 'true';
        if (this.pos < this.len && this.src.charCodeAt(this.pos) === 61) {
          this.pos++; // `=`
          gap += lineBreaks(this.skipWsAndComments());
          const vCh = this.pos < this.len ? this.src.charCodeAt(this.pos) : 0;
          if (vCh === 34 || vCh === 39) {
            const rawStr = this.scanJsxAttrString(vCh);
            val = JSON.stringify(decodeHtmlEntities(rawStr.slice(1, -1)));
            owed += lineBreaks(rawStr);
          } else if (vCh === 123) {
            this.pos++; // `{`
            val = keepLines(this.scanCode(true), 'undefined');
          } else if (vCh === 60) {
            val = this.parseJsxElement();
          }
        } else {
          // Boolean shorthand attribute (`disabled`, `checked`): what followed it is before the next.
          owed += gap;
          gap = 0;
        }
        propChunks.push({ kind: 'entry', pre: newlines(before + gap), key: attrName, val });
        continue;
      }
      // Skip unexpected char defensively to avoid infinite loops on malformed input
      this.pos++;
    }

    const propsExpr = this.formatProps(propChunks);
    if (selfClosing) return `globalThis.__softnJsx(${tagExpr}, ${propsExpr}${newlines(owed)})`;
    const children = this.parseJsxChildren(owed);
    const args = [tagExpr, propsExpr, ...children.parts];
    return `globalThis.__softnJsx(${args.join(', ')}${newlines(children.owed)})`;
  }

  private formatProps(chunks: PropChunk[]): string {
    if (chunks.length === 0) return 'null';
    const entry = (c: Extract<PropChunk, { kind: 'entry' }>): string => `${c.pre}${quotePropKey(c.key)}: ${c.val}`;
    const hasSpread = chunks.some((c) => c.kind === 'spread');
    if (!hasSpread) {
      const pairs = chunks.map((c) => (c.kind === 'entry' ? entry(c) : ''));
      return `{ ${pairs.join(', ')} }`;
    }
    const assignArgs: string[] = ['{}'];
    let pendingEntries: string[] = [];
    const flushEntries = () => {
      if (pendingEntries.length > 0) {
        assignArgs.push(`{ ${pendingEntries.join(', ')} }`);
        pendingEntries = [];
      }
    };
    for (const c of chunks) {
      if (c.kind === 'spread') {
        flushEntries();
        assignArgs.push(`${c.pre}${c.expr}`);
      } else {
        pendingEntries.push(entry(c));
      }
    }
    flushEntries();
    return `Object.assign(${assignArgs.join(', ')})`;
  }

  /** The children up to the closing tag, each with the line breaks before it, and the breaks still owed after them. */
  private parseJsxChildren(owedBefore: number): { parts: string[]; owed: number } {
    const parts: string[] = [];
    let owed = owedBefore;
    const push = (text: string): void => {
      parts.push(newlines(owed) + text);
      owed = 0;
    };
    while (this.pos < this.len) {
      const ch = this.src.charCodeAt(this.pos);
      if (ch === 60) {
        // Closing tag `</Tag>` or `</>`
        if (this.pos + 1 < this.len && this.src.charCodeAt(this.pos + 1) === 47) {
          this.pos += 2; // `</`
          const nameStart = this.pos;
          while (this.pos < this.len && this.src.charCodeAt(this.pos) !== 62) this.pos++;
          owed += lineBreaks(this.src.slice(nameStart, this.pos));
          if (this.pos < this.len) this.pos++; // `>`
          break;
        }
        push(this.parseJsxElement());
        continue;
      }
      if (ch === 123) {
        this.pos++; // `{`
        const expr = this.scanCode(true);
        // A comment's own line breaks, and any after `{expr // note`, are kept: no `//` comment ends the call.
        if (stripLeadingComments(expr).length > 0) push(keepLines(expr));
        else owed += lineBreaks(expr);
        continue;
      }
      // Plain text until `<` or `{`
      const tStart = this.pos;
      while (this.pos < this.len) {
        const c = this.src.charCodeAt(this.pos);
        if (c === 60 || c === 123) break;
        this.pos++;
      }
      const raw = this.src.slice(tStart, this.pos);
      const cleaned = cleanJsxText(raw);
      if (cleaned.length > 0) {
        const lead = lineBreaks(raw.slice(0, raw.length - raw.trimStart().length));
        owed += lead;
        push(JSON.stringify(cleaned) + newlines(lineBreaks(raw) - lead));
      } else {
        owed += lineBreaks(raw);
      }
    }
    return { parts, owed };
  }
}

/** A prop of an element: a spread (`{...p}`) or a named one, with the line breaks before it. */
type PropChunk = { kind: 'spread'; pre: string; expr: string } | { kind: 'entry'; pre: string; key: string; val: string };

/**
 * Transform JSX/TSX syntax in `code` to `globalThis.__softnJsx(...)` calls.
 * Safe to run on `.jsx` and `.tsx` source files; leaves TypeScript types intact
 * for `zipp-typescript.wasm` to strip.
 */
export function transformJsx(code: string): string {
  if (!code || !code.includes('<')) return code;
  return new JsxScanner(code).transform();
}
