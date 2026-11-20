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

function decodeHtmlEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(?:#x([0-9a-fA-F]+)|#(\d+)|(amp|lt|gt|quot|apos|nbsp));/g, (m, hex, dec, named) => {
    if (hex) return String.fromCodePoint(parseInt(hex, 16));
    if (dec) return String.fromCodePoint(parseInt(dec, 10));
    switch (named) {
      case 'amp': return '&';
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return "'";
      case 'nbsp': return '\u00a0';
      default: return m;
    }
  });
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

class JsxScanner {
  private readonly src: string;
  private readonly len: number;
  private pos = 0;

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
  }

  /**
   * Peek ahead from a `<` in expression position to determine whether it begins
   * a JSX element/fragment or a TypeScript generic parameter list (`<T,>`, `<T extends X>`).
   */
  private looksLikeJsxStart(): boolean {
    const len = this.len;
    let p = this.pos + 1;
    if (p >= len) return false;
    // Fragment: `<>` (optionally whitespace between `<` and `>` is invalid JSX, must be `<>`)
    if (this.src.charCodeAt(p) === 62) return true;
    if (!isIdentStart(this.src.charCodeAt(p))) return false;
    const nameStart = p;
    p++;
    while (p < len && isJsxNamePart(this.src.charCodeAt(p))) p++;
    const tagName = this.src.slice(nameStart, p);
    // Skip whitespace after tag name
    while (p < len && isWs(this.src.charCodeAt(p))) p++;
    if (p >= len) return false;
    const nextCh = this.src.charCodeAt(p);
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
          // Check if there is NO closing `</TagName>` ahead
          if (!this.src.includes(`</${tagName}`)) return false;
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
        if (JSX_EXPR_KEYWORDS.has(word) || REGEX_PRECEDING_KEYWORDS.has(word)) {
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

      // Multi-char operators relevant to expression start (`=>`, `&&`, `||`, `??`)
      const two = this.src.slice(this.pos, this.pos + 2);
      if (two === '=>' || two === '&&' || two === '||' || two === '??' || two === '==' || two === '!=' || two === '<=' || two === '>=') {
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

  private parseJsxElement(): string {
    // Expect `<`
    this.pos++;

    // Fragment: `<> ... </>`
    if (this.pos < this.len && this.src.charCodeAt(this.pos) === 62) {
      this.pos++; // consume `>`
      const children = this.parseJsxChildren('');
      const args = ['globalThis.__softnFragment', 'null', ...children];
      return `globalThis.__softnJsx(${args.join(', ')})`;
    }

    // Parse tag name
    const tagStart = this.pos;
    while (this.pos < this.len && isJsxNamePart(this.src.charCodeAt(this.pos))) this.pos++;
    const tagName = this.src.slice(tagStart, this.pos);
    const tagExpr = isHtmlTag(tagName) ? JSON.stringify(tagName) : tagName;

    // Parse attributes / props
    type PropChunk = { kind: 'spread'; expr: string } | { kind: 'entry'; key: string; val: string };
    const propChunks: PropChunk[] = [];
    let selfClosing = false;

    while (this.pos < this.len) {
      this.skipWsAndComments();
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
        const inner = this.scanCode(true).trim();
        if (inner.startsWith('...')) {
          propChunks.push({ kind: 'spread', expr: inner.slice(3).trim() });
        }
        continue;
      }
      // Attribute name
      if (isIdentStart(ch)) {
        const aStart = this.pos;
        this.pos++;
        while (this.pos < this.len && isJsxNamePart(this.src.charCodeAt(this.pos))) this.pos++;
        const attrName = this.src.slice(aStart, this.pos);
        this.skipWsAndComments();
        if (this.pos < this.len && this.src.charCodeAt(this.pos) === 61) {
          this.pos++; // `=`
          this.skipWsAndComments();
          const vCh = this.pos < this.len ? this.src.charCodeAt(this.pos) : 0;
          if (vCh === 34 || vCh === 39) {
            const rawStr = this.scanString(vCh);
            const inner = rawStr.slice(1, -1);
            propChunks.push({ kind: 'entry', key: attrName, val: JSON.stringify(decodeHtmlEntities(inner)) });
          } else if (vCh === 123) {
            this.pos++; // `{`
            const expr = this.scanCode(true).trim();
            propChunks.push({ kind: 'entry', key: attrName, val: expr || 'undefined' });
          } else if (vCh === 60) {
            const elemExpr = this.parseJsxElement();
            propChunks.push({ kind: 'entry', key: attrName, val: elemExpr });
          } else {
            propChunks.push({ kind: 'entry', key: attrName, val: 'true' });
          }
        } else {
          // Boolean shorthand attribute (`disabled`, `checked`)
          propChunks.push({ kind: 'entry', key: attrName, val: 'true' });
        }
        continue;
      }
      // Skip unexpected char defensively to avoid infinite loops on malformed input
      this.pos++;
    }

    const propsExpr = this.formatProps(propChunks);
    const children = selfClosing ? [] : this.parseJsxChildren(tagName);
    const args = [tagExpr, propsExpr, ...children];
    return `globalThis.__softnJsx(${args.join(', ')})`;
  }

  private formatProps(chunks: Array<{ kind: 'spread'; expr: string } | { kind: 'entry'; key: string; val: string }>): string {
    if (chunks.length === 0) return 'null';
    const hasSpread = chunks.some((c) => c.kind === 'spread');
    if (!hasSpread) {
      const pairs = chunks.map((c) =>
        c.kind === 'entry' ? `${quotePropKey(c.key)}: ${c.val}` : ''
      );
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
        assignArgs.push(c.expr);
      } else {
        pendingEntries.push(`${quotePropKey(c.key)}: ${c.val}`);
      }
    }
    flushEntries();
    return `Object.assign(${assignArgs.join(', ')})`;
  }

  private parseJsxChildren(expectedClosingTag: string): string[] {
    const children: string[] = [];
    while (this.pos < this.len) {
      const ch = this.src.charCodeAt(this.pos);
      if (ch === 60) {
        // Closing tag `</Tag>` or `</>`
        if (this.pos + 1 < this.len && this.src.charCodeAt(this.pos + 1) === 47) {
          this.pos += 2; // `</`
          while (this.pos < this.len && this.src.charCodeAt(this.pos) !== 62) this.pos++;
          if (this.pos < this.len) this.pos++; // `>`
          break;
        }
        children.push(this.parseJsxElement());
        continue;
      }
      if (ch === 123) {
        this.pos++; // `{`
        const expr = this.scanCode(true);
        const meaningful = stripLeadingComments(expr);
        if (meaningful.length > 0) {
          children.push(expr.trim());
        }
        continue;
      }
      // Plain text until `<` or `{`
      const tStart = this.pos;
      while (this.pos < this.len) {
        const c = this.src.charCodeAt(this.pos);
        if (c === 60 || c === 123) break;
        this.pos++;
      }
      const cleaned = cleanJsxText(this.src.slice(tStart, this.pos));
      if (cleaned.length > 0) {
        children.push(JSON.stringify(cleaned));
      }
    }
    void expectedClosingTag;
    return children;
  }
}

/**
 * Transform JSX/TSX syntax in `code` to `globalThis.__softnJsx(...)` calls.
 * Safe to run on `.jsx` and `.tsx` source files; leaves TypeScript types intact
 * for `zipp-typescript.wasm` to strip.
 */
export function transformJsx(code: string): string {
  if (!code || !code.includes('<')) return code;
  return new JsxScanner(code).transform();
}
