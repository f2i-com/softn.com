/**
 * A guest stylesheet (or a `style` attribute) rewritten so that it fetches nothing the app was
 * not granted and styles nothing outside the app.
 *
 * It is read as CSS reads it, token by token, because the things that matter can be spelled in
 * ways no pattern over the text sees: `u\72l(…)` is `url(…)`, a `)` inside a quoted address
 * ends a pattern's match early and leaves the real `url()` standing, and `image-set("…")` takes
 * an address as a bare string. v0.0.43 matched `url(` and `@import` as text, and all three of
 * those reached another origin from an app that had been granted no network.
 *
 * What is rewritten:
 *   - every address — `url(…)`, `src(…)`, and a string inside `image-set()`, `image()` or
 *     `cross-fade()` — goes through the host's rule and comes back as the address to use (a
 *     file of the app's, or one its grant covers), or as `about:blank`;
 *   - `@import` is removed whole: a sheet fetched from elsewhere cannot be read here;
 *   - `:host`, `:host()` and `:host-context()` never match. The sheet sits inside the
 *     element's shadow root, where `:host` is the element in the embedding page: an app that
 *     wrote `:host { position: fixed; inset: 0 }` laid itself over that page;
 *   - `expression(…)`, which only a dead browser ran, is `none`.
 *
 * Comments are dropped. Everything else is passed through as written.
 */

/** Functions whose bare strings are addresses. */
const IMAGE_FUNCTIONS = new Set(['image-set', '-webkit-image-set', 'image', 'cross-fade', '-webkit-cross-fade']);

const isHex = (c: string): boolean => {
  const code = c.charCodeAt(0);
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102);
};
const isSpace = (c: string): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
const isNameStart = (c: string): boolean => {
  const code = c.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95 || code > 127;
};
const isNameChar = (c: string): boolean => {
  const code = c.charCodeAt(0);
  return (
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    (code >= 48 && code <= 57) ||
    code === 95 ||
    code === 45 ||
    code > 127
  );
};

/** The character a backslash at `at` stands for, and where reading goes on. */
function readEscape(css: string, at: number): { char: string; end: number } {
  let i = at + 1;
  if (i >= css.length) return { char: '�', end: i };
  if (isHex(css[i])) {
    let hex = '';
    while (i < css.length && hex.length < 6 && isHex(css[i])) hex += css[i++];
    // One whitespace character after the digits belongs to the escape.
    if (css[i] === '\r' && css[i + 1] === '\n') i += 2;
    else if (i < css.length && isSpace(css[i])) i++;
    const code = parseInt(hex, 16);
    const valid = code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
    return { char: valid ? String.fromCodePoint(code) : '�', end: i };
  }
  return { char: css[i], end: i + 1 };
}

/** Whether an identifier starts at `at` (a `-` may lead one; so may an escape). */
function startsName(css: string, at: number): boolean {
  const c = css[at];
  if (c === undefined) return false;
  if (isNameStart(c)) return true;
  if (c === '\\') return css[at + 1] !== undefined && css[at + 1] !== '\n';
  if (c === '-') {
    const next = css[at + 1];
    return next !== undefined && (isNameStart(next) || next === '-' || (next === '\\' && css[at + 2] !== '\n'));
  }
  return false;
}

/** The identifier at `at`, with its escapes resolved. */
function readName(css: string, at: number): { name: string; end: number } {
  let i = at;
  let name = '';
  while (i < css.length) {
    const c = css[i];
    if (isNameChar(c)) {
      name += c;
      i++;
    } else if (c === '\\' && css[i + 1] !== undefined && css[i + 1] !== '\n') {
      const escaped = readEscape(css, i);
      name += escaped.char;
      i = escaped.end;
    } else break;
  }
  return { name, end: i };
}

/** The string whose opening quote is at `at`: its value, and where it ends (after the closing quote, or at an unescaped line end). */
function readString(css: string, at: number): { value: string; end: number } {
  const quote = css[at];
  let i = at + 1;
  let value = '';
  while (i < css.length) {
    const c = css[i];
    if (c === quote) return { value, end: i + 1 };
    if (c === '\n' || c === '\r' || c === '\f') return { value, end: i };
    if (c === '\\') {
      if (i + 1 >= css.length) return { value, end: i + 1 };
      const next = css[i + 1];
      // A backslash before a line end continues the string on the next line.
      if (next === '\n' || next === '\f') i += 2;
      else if (next === '\r') i += css[i + 2] === '\n' ? 3 : 2;
      else {
        const escaped = readEscape(css, i);
        value += escaped.char;
        i = escaped.end;
      }
    } else {
      value += c;
      i++;
    }
  }
  return { value, end: i };
}

/** `text` as a CSS string, so that nothing in it ends the string or the declaration. */
function cssString(text: string): string {
  let out = '"';
  for (const c of text) {
    if (c === '"' || c === '\\') out += `\\${c}`;
    else if (c < ' ' || c === '\u007f') out += `\\${c.codePointAt(0)!.toString(16)} `;
    else out += c;
  }
  return `${out}"`;
}

/** Where the bracket opened at `at` closes (after it), strings and nested brackets read as such. */
function skipBalanced(css: string, at: number): number {
  let depth = 0;
  let i = at;
  while (i < css.length) {
    const c = css[i];
    if (c === '"' || c === "'") i = readString(css, i).end;
    else if (c === '\\') i = readEscape(css, i).end;
    else if (c === '/' && css[i + 1] === '*') {
      const close = css.indexOf('*/', i + 2);
      i = close < 0 ? css.length : close + 2;
    } else {
      if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth === 0) return i + 1;
      }
      i++;
    }
  }
  return css.length;
}

/**
 * Rewrite `css`. `mapUrl` is given each address as CSS resolved it and answers the address to
 * put in its place, or null for one the app may not load.
 */
/** Characters / constructs that require token-level CSS rewriting in `rewriteCss`. */
const REWRITE_TRIGGER_RE = /\/\*|["'@\\]/;
const REWRITE_FUNC_RE = /(?:url|src|image|image-set|cross-fade|expression)\s*\(/i;
const HOST_PSEUDO_RE = /host/i;
const MAX_CSS_NESTING_DEPTH = 64;

export function rewriteCss(css: string, mapUrl: (address: string) => string | null, options: { keepHost?: boolean } = {}): string {
  // CSS Syntax Level 3 input stream preprocessing: normalize CR/CRLF/FF and replace NUL.
  if (css.indexOf('\r') >= 0 || css.indexOf('\f') >= 0) {
    css = css.replace(/\r\n?|\f/g, '\n');
  }
  if (css.indexOf('\0') >= 0) {
    css = css.replace(/\0/g, '\uFFFD');
  }
  // Fast exit: if the CSS contains no comments, strings, `@`, `\`, `:host`, or URL/image/expression
  // functions, every branch in the tokenizer below would copy the input verbatim (covering hot
  // animated inline styles such as `transform: translate3d(...)` and `color: rgba(...)`).
  if (
    !REWRITE_TRIGGER_RE.test(css) &&
    (css.indexOf('(') < 0 || !REWRITE_FUNC_RE.test(css)) &&
    (css.indexOf(':') < 0 || !HOST_PSEUDO_RE.test(css))
  ) {
    return css;
  }
  const address = (raw: string): string => cssString(mapUrl(raw.trim()) ?? 'about:blank');
  let out = '';
  let i = 0;
  let depth = 0;
  // Bracket depths at which a bare string is an address (inside image-set() and its like).
  const imageDepths: number[] = [];
  // Bracket depths inside image-set(... type("image/webp")) where a string is a MIME type, not a URL.
  const typeDepths: number[] = [];

  while (i < css.length) {
    const c = css[i];

    if (c === '/' && css[i + 1] === '*') {
      const close = css.indexOf('*/', i + 2);
      i = close < 0 ? css.length : close + 2;
      out += ' ';
      continue;
    }

    if (c === '"' || c === "'") {
      const str = readString(css, i);
      out += imageDepths.length > 0 && typeDepths.length === 0 ? address(str.value) : cssString(str.value);
      i = str.end;
      continue;
    }

    if (c === '@' && startsName(css, i + 1)) {
      const rule = readName(css, i + 1);
      if (rule.name.toLowerCase() === 'import') {
        // To the end of the rule: its `;`, or wherever a block would begin or the sheet ends.
        let end = rule.end;
        while (end < css.length && css[end] !== ';' && css[end] !== '{' && css[end] !== '}') {
          if (css[end] === '"' || css[end] === "'") end = readString(css, end).end;
          else if (css[end] === '(') end = skipBalanced(css, end);
          else if (css[end] === '\\') end = readEscape(css, end).end;
          else end++;
        }
        if (css[end] === ';') end++;
        out += ' ';
        i = end;
        continue;
      }
      out += css.slice(i, rule.end);
      i = rule.end;
      continue;
    }

    if (c === ':') {
      // `:host`, `::host` as some write it, and the functional forms.
      let at = i + 1;
      if (css[at] === ':') at++;
      if (startsName(css, at)) {
        const pseudo = readName(css, at);
        const lower = pseudo.name.toLowerCase();
        // In a stylesheet of a shadow tree the app attached, `:host` is the app's own element
        // and is left as written. `:host-context()` asks about what is around the host, all
        // the way out to the embedding page, and never matches.
        if ((lower === 'host' && !options.keepHost) || lower === 'host-context') {
          let end = pseudo.end;
          if (css[end] === '(') end = skipBalanced(css, end);
          out += ':not(*)';
          i = end;
          continue;
        }
      }
      out += c;
      i++;
      continue;
    }

    if (startsName(css, i)) {
      const ident = readName(css, i);
      const lower = ident.name.toLowerCase();
      if (css[ident.end] !== '(') {
        out += css.slice(i, ident.end);
        i = ident.end;
        continue;
      }
      if (lower === 'url' || lower === 'src') {
        // url( <string> ) or url( <unquoted> ): either way one address.
        let at = ident.end + 1;
        while (at < css.length && isSpace(css[at])) at++;
        let value = '';
        if (css[at] === '"' || css[at] === "'") {
          const str = readString(css, at);
          value = str.value;
        } else {
          while (at < css.length && css[at] !== ')') {
            if (css[at] === '\\') {
              const escaped = readEscape(css, at);
              value += escaped.char;
              at = escaped.end;
            } else value += css[at++];
          }
        }
        out += `url(${address(value)})`;
        i = skipBalanced(css, ident.end);
        continue;
      }
      if (lower === 'expression') {
        out += 'none';
        i = skipBalanced(css, ident.end);
        continue;
      }
      // Inside image-set() / image() / cross-fade(), CSS variable/env/attr substitution can
      // smuggle an unsanitized URL string (e.g. `image-set(var(--u) 1x)` or fallback strings).
      if (imageDepths.length > 0 && (lower === 'var' || lower === 'env' || lower === 'attr')) {
        out += 'url("about:blank")';
        i = skipBalanced(css, ident.end);
        continue;
      }
      out += `${css.slice(i, ident.end)}(`;
      depth++;
      if (IMAGE_FUNCTIONS.has(lower)) imageDepths.push(depth);
      else if (imageDepths.length > 0 && lower === 'type') typeDepths.push(depth);
      i = ident.end + 1;
      continue;
    }

    if (c === '\\') {
      // An escape outside a name or a string: kept as written.
      const escaped = readEscape(css, i);
      out += css.slice(i, escaped.end);
      i = escaped.end;
      continue;
    }

    if (c === '(') depth++;
    else if (c === ')') {
      if (typeDepths.length > 0 && typeDepths[typeDepths.length - 1] === depth) typeDepths.pop();
      if (imageDepths.length > 0 && imageDepths[imageDepths.length - 1] === depth) imageDepths.pop();
      if (depth > 0) depth--;
    }
    out += c;
    i++;
  }
  return out;
}

const isDigit = (c: string): boolean => c >= '0' && c <= '9';

/** Grouping at-rules whose `{ ... }` body contains nested rules (selectors or further at-rules). */
const GROUPING_AT_RULES = new Set([
  'media',
  'supports',
  'layer',
  'container',
  'document',
  '-moz-document',
  'scope',
  'starting-style',
]);

const KEYFRAMES_AT_RULES = new Set(['keyframes', '-webkit-keyframes', '-moz-keyframes']);

/** Functional pseudo-classes whose argument is a selector list. */
const SELECTOR_PSEUDOS = new Set(['is', 'where', 'not', 'has', 'matches', '-webkit-any', '-moz-any', 'slotted']);

function skipBrackets(css: string, at: number, limit: number): number {
  let depth = 0;
  let i = at;
  while (i < limit) {
    const c = css[i];
    if (c === '"' || c === "'") i = Math.min(limit, readString(css, i).end);
    else if (c === '\\') i = Math.min(limit, readEscape(css, i).end);
    else if (c === '/' && css[i + 1] === '*') {
      const close = css.indexOf('*/', i + 2);
      i = close < 0 || close + 2 > limit ? limit : close + 2;
    } else {
      if (c === '[') depth++;
      else if (c === ']') {
        depth--;
        if (depth === 0) return i + 1;
      }
      i++;
    }
  }
  return limit;
}

function findMatchingBrace(css: string, openAt: number, limit: number): number {
  let depth = 0;
  let i = openAt;
  while (i < limit) {
    const c = css[i];
    if (c === '"' || c === "'") i = Math.min(limit, readString(css, i).end);
    else if (c === '\\') i = Math.min(limit, readEscape(css, i).end);
    else if (c === '/' && css[i + 1] === '*') {
      const close = css.indexOf('*/', i + 2);
      i = close < 0 || close + 2 > limit ? limit : close + 2;
    } else {
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) return i;
      }
      i++;
    }
  }
  return limit;
}

/**
 * Rewrite viewport-relative length units (`vh`, `dvh`, `svh`, `lvh`, `vw`, `dvw`, `svw`, `lvw`,
 * `vmin`, `vmax`) inside a CSS declaration value so `100dvh` / `100vh` / `100vw` size against
 * the container's live viewport (`--softn-vh` / `--softn-vw`) with safe fallback to `1vh`/`1vw`.
 */
export function rewriteViewportUnitsInValue(value: string): string {
  // Fast exit when no viewport unit letter exists in the value.
  if (!/[vV][hHwWmM]/.test(value)) return value;

  let out = '';
  let i = 0;
  let prevCh = '';
  const len = value.length;

  while (i < len) {
    const c = value[i];

    if (c === '/' && value[i + 1] === '*') {
      const close = value.indexOf('*/', i + 2);
      const end = close < 0 ? len : close + 2;
      out += value.slice(i, end);
      i = end;
      continue;
    }

    if (c === '"' || c === "'") {
      const str = readString(value, i);
      out += value.slice(i, str.end);
      prevCh = c;
      i = str.end;
      continue;
    }

    if (c === '\\') {
      const esc = readEscape(value, i);
      out += value.slice(i, esc.end);
      prevCh = 'a';
      i = esc.end;
      continue;
    }

    // Check for a numeric dimension before checking `startsName` so unary `-10vh` is not
    // misread as an identifier (startsName rejects `-1`, which also keeps them disjoint).
    const unaryBoundary =
      prevCh === '' || isSpace(prevCh) || prevCh === ':' || prevCh === ',' || prevCh === '(' || prevCh === '/';
    const startsSignedNum =
      (c === '+' || c === '-') &&
      unaryBoundary &&
      (isDigit(value[i + 1] ?? '') || (value[i + 1] === '.' && isDigit(value[i + 2] ?? '')));
    const startsUnsignedNum =
      (isDigit(c) || (c === '.' && isDigit(value[i + 1] ?? ''))) &&
      prevCh !== '.' &&
      !isNameChar(prevCh);

    if (startsSignedNum || startsUnsignedNum) {
      let j = i;
      if (value[j] === '+' || value[j] === '-') j++;
      while (j < len && isDigit(value[j])) j++;
      if (value[j] === '.' && isDigit(value[j + 1] ?? '')) {
        j++;
        while (j < len && isDigit(value[j])) j++;
      }
      if ((value[j] === 'e' || value[j] === 'E') && j < len) {
        let e = j + 1;
        if (value[e] === '+' || value[e] === '-') e++;
        if (isDigit(value[e] ?? '')) {
          while (e < len && isDigit(value[e])) e++;
          j = e;
        }
      }
      const numStr = value.slice(i, j);
      if (j < len && startsName(value, j)) {
        const unit = readName(value, j);
        const lower = unit.name.toLowerCase();
        if (lower === 'vh' || lower === 'dvh' || lower === 'svh' || lower === 'lvh') {
          out += `calc(${numStr} * var(--softn-vh, 1vh))`;
          prevCh = ')';
          i = unit.end;
          continue;
        }
        if (lower === 'vw' || lower === 'dvw' || lower === 'svw' || lower === 'lvw') {
          out += `calc(${numStr} * var(--softn-vw, 1vw))`;
          prevCh = ')';
          i = unit.end;
          continue;
        }
        if (lower === 'vmin' || lower === 'dvmin' || lower === 'svmin' || lower === 'lvmin') {
          out += `calc(${numStr} * min(var(--softn-vw, 1vw), var(--softn-vh, 1vh)))`;
          prevCh = ')';
          i = unit.end;
          continue;
        }
        if (lower === 'vmax' || lower === 'dvmax' || lower === 'svmax' || lower === 'lvmax') {
          out += `calc(${numStr} * max(var(--softn-vw, 1vw), var(--softn-vh, 1vh)))`;
          prevCh = ')';
          i = unit.end;
          continue;
        }
        out += value.slice(i, unit.end);
        prevCh = 'a';
        i = unit.end;
        continue;
      }
      out += numStr;
      prevCh = '0';
      i = j;
      continue;
    }

    if (startsName(value, i)) {
      const ident = readName(value, i);
      const lower = ident.name.toLowerCase();
      if (value[ident.end] === '(' && (lower === 'url' || lower === 'src')) {
        const end = skipBalanced(value, ident.end);
        out += value.slice(i, end);
        prevCh = ')';
        i = end;
        continue;
      }
      out += value.slice(i, ident.end);
      prevCh = 'a';
      i = ident.end;
      continue;
    }

    out += c;
    prevCh = c;
    i++;
  }

  return out;
}

/**
 * Scope top-level `html` / `:root` selectors to `[data-softn-docroot]` and `body` selectors
 * to `[data-softn-viewport]` inside a CSS selector list, without touching attribute selectors,
 * class/id names, or strings.
 */
export function rewritePageSelectorList(selector: string): string {
  // Fast exit when none of `:root`, `html`, `body` can occur.
  if (!/(?::root|\bhtml\b|\bbody\b)/i.test(selector)) return selector;

  let out = '';
  let i = 0;
  let atBoundary = true;
  const len = selector.length;

  while (i < len) {
    const c = selector[i];

    if (c === '/' && selector[i + 1] === '*') {
      const close = selector.indexOf('*/', i + 2);
      const end = close < 0 ? len : close + 2;
      out += selector.slice(i, end);
      i = end;
      continue;
    }

    if (c === '"' || c === "'") {
      const str = readString(selector, i);
      out += selector.slice(i, str.end);
      atBoundary = false;
      i = str.end;
      continue;
    }

    if (c === '[') {
      const end = skipBrackets(selector, i, len);
      out += selector.slice(i, end);
      atBoundary = false;
      i = end;
      continue;
    }

    if (c === '\\') {
      const esc = readEscape(selector, i);
      out += selector.slice(i, esc.end);
      atBoundary = false;
      i = esc.end;
      continue;
    }

    if (c === ':') {
      if (selector[i + 1] === ':') {
        out += '::';
        i += 2;
        if (startsName(selector, i)) {
          const pseudo = readName(selector, i);
          out += selector.slice(i, pseudo.end);
          i = pseudo.end;
        }
        atBoundary = false;
        continue;
      }
      if (startsName(selector, i + 1)) {
        const pseudo = readName(selector, i + 1);
        const lower = pseudo.name.toLowerCase();
        if (lower === 'root' && selector[pseudo.end] !== '(') {
          out += '[data-softn-docroot]';
          atBoundary = false;
          i = pseudo.end;
          continue;
        }
        if (selector[pseudo.end] === '(') {
          const parenEnd = skipBalanced(selector, pseudo.end);
          if (SELECTOR_PSEUDOS.has(lower) && parenEnd > pseudo.end + 1) {
            const inner = selector.slice(pseudo.end + 1, parenEnd - 1);
            out += `${selector.slice(i, pseudo.end + 1)}${rewritePageSelectorList(inner)})`;
          } else {
            out += selector.slice(i, parenEnd);
          }
          atBoundary = false;
          i = parenEnd;
          continue;
        }
        out += selector.slice(i, pseudo.end);
        atBoundary = false;
        i = pseudo.end;
        continue;
      }
      out += c;
      atBoundary = false;
      i++;
      continue;
    }

    if (startsName(selector, i)) {
      const ident = readName(selector, i);
      const lower = ident.name.toLowerCase();
      if (atBoundary && selector[ident.end] !== '|') {
        if (lower === 'html') {
          out += '[data-softn-docroot]';
          atBoundary = false;
          i = ident.end;
          continue;
        }
        if (lower === 'body') {
          out += '[data-softn-viewport]';
          atBoundary = false;
          i = ident.end;
          continue;
        }
      }
      out += selector.slice(i, ident.end);
      atBoundary = false;
      i = ident.end;
      continue;
    }

    if (isSpace(c) || c === ',' || c === '>' || c === '+' || c === '~' || c === '(') {
      atBoundary = true;
    } else {
      atBoundary = false;
    }
    out += c;
    i++;
  }

  return out;
}

function transformCssBlock(
  css: string,
  start: number,
  end: number,
  mode: 'rules' | 'declarations' | 'keyframes',
  opts: { scopeSelectors: boolean; rewriteViewportUnits: boolean },
  depth = 0
): string {
  // Guard against deeply nested CSS blocks (`a{a{a{...`) causing host stack overflow or O(N^2) scans.
  if (depth >= MAX_CSS_NESTING_DEPTH) return '';
  let out = '';
  let i = start;

  while (i < end) {
    // Emit whitespace and stray semicolons verbatim
    if (isSpace(css[i]) || css[i] === ';') {
      out += css[i++];
      continue;
    }

    if (css[i] === '/' && css[i + 1] === '*') {
      const close = css.indexOf('*/', i + 2);
      const stop = close < 0 || close + 2 > end ? end : close + 2;
      out += css.slice(i, stop);
      i = stop;
      continue;
    }

    // At-rule (`@media`, `@layer`, `@supports`, `@keyframes`, `@font-face`, etc.)
    if (css[i] === '@' && startsName(css, i + 1)) {
      const ruleName = readName(css, i + 1);
      const lowerName = ruleName.name.toLowerCase();
      let j = ruleName.end;
      while (j < end && css[j] !== ';' && css[j] !== '{') {
        if (css[j] === '"' || css[j] === "'") j = Math.min(end, readString(css, j).end);
        else if (css[j] === '\\') j = Math.min(end, readEscape(css, j).end);
        else if (css[j] === '(') j = Math.min(end, skipBalanced(css, j));
        else if (css[j] === '[') j = skipBrackets(css, j, end);
        else if (css[j] === '/' && css[j + 1] === '*') {
          const close = css.indexOf('*/', j + 2);
          j = close < 0 || close + 2 > end ? end : close + 2;
        } else j++;
      }
      if (j >= end) {
        out += css.slice(i, end);
        break;
      }
      if (css[j] === ';') {
        out += css.slice(i, j + 1);
        i = j + 1;
        continue;
      }
      // Block at-rule `{ ... }`
      const closeBrace = findMatchingBrace(css, j, end);
      const prelude = css.slice(i, j);
      const childMode =
        mode === 'declarations'
          ? 'declarations'
          : GROUPING_AT_RULES.has(lowerName)
            ? 'rules'
            : KEYFRAMES_AT_RULES.has(lowerName)
              ? 'keyframes'
              : 'declarations';
      const inner = transformCssBlock(css, j + 1, closeBrace, childMode, opts, depth + 1);
      out += `${prelude}{${inner}${closeBrace < end ? '}' : ''}`;
      i = closeBrace < end ? closeBrace + 1 : end;
      continue;
    }

    if (mode === 'rules' || mode === 'keyframes') {
      let j = i;
      while (j < end && css[j] !== '{' && css[j] !== ';') {
        if (css[j] === '"' || css[j] === "'") j = Math.min(end, readString(css, j).end);
        else if (css[j] === '\\') j = Math.min(end, readEscape(css, j).end);
        else if (css[j] === '(') j = Math.min(end, skipBalanced(css, j));
        else if (css[j] === '[') j = skipBrackets(css, j, end);
        else if (css[j] === '/' && css[j + 1] === '*') {
          const close = css.indexOf('*/', j + 2);
          j = close < 0 || close + 2 > end ? end : close + 2;
        } else j++;
      }
      if (j >= end) {
        out += css.slice(i, end);
        break;
      }
      if (css[j] === ';') {
        out += css.slice(i, j + 1);
        i = j + 1;
        continue;
      }
      const closeBrace = findMatchingBrace(css, j, end);
      const rawSelector = css.slice(i, j);
      const selector = mode === 'rules' && opts.scopeSelectors ? rewritePageSelectorList(rawSelector) : rawSelector;
      const body = transformCssBlock(css, j + 1, closeBrace, 'declarations', opts, depth + 1);
      out += `${selector}{${body}${closeBrace < end ? '}' : ''}`;
      i = closeBrace < end ? closeBrace + 1 : end;
      continue;
    }

    // `mode === 'declarations'`: either a `prop: value;` declaration or a CSS-nested rule `sel { ... }`
    let j = i;
    let firstColon = -1;
    while (j < end && css[j] !== ';' && css[j] !== '{') {
      if (css[j] === '"' || css[j] === "'") j = Math.min(end, readString(css, j).end);
      else if (css[j] === '\\') j = Math.min(end, readEscape(css, j).end);
      else if (css[j] === '(') j = Math.min(end, skipBalanced(css, j));
      else if (css[j] === '[') j = skipBrackets(css, j, end);
      else if (css[j] === '/' && css[j + 1] === '*') {
        const close = css.indexOf('*/', j + 2);
        j = close < 0 || close + 2 > end ? end : close + 2;
      } else {
        if (css[j] === ':' && firstColon < 0) firstColon = j;
        j++;
      }
    }

    if (j < end && css[j] === '{') {
      // CSS Nesting: nested selector block inside a declaration list
      const closeBrace = findMatchingBrace(css, j, end);
      const rawNestedSel = css.slice(i, j);
      const nestedSel = opts.scopeSelectors ? rewritePageSelectorList(rawNestedSel) : rawNestedSel;
      const body = transformCssBlock(css, j + 1, closeBrace, 'declarations', opts, depth + 1);
      out += `${nestedSel}{${body}${closeBrace < end ? '}' : ''}`;
      i = closeBrace < end ? closeBrace + 1 : end;
      continue;
    }

    // Standard `property: value` declaration
    if (firstColon >= 0 && opts.rewriteViewportUnits) {
      const propPart = css.slice(i, firstColon + 1);
      const valPart = css.slice(firstColon + 1, j);
      out += propPart + rewriteViewportUnitsInValue(valPart);
    } else {
      out += css.slice(i, j);
    }
    if (j < end && css[j] === ';') {
      out += ';';
      i = j + 1;
    } else {
      i = j;
    }
  }

  return out;
}

/**
 * Scope page root selectors (`:root`/`html` -> `[data-softn-docroot]`, `body` -> `[data-softn-viewport]`)
 * and rewrite viewport length units (`vh`/`dvh`/`vw`/`dvw`...) in declaration values.
 */
export function transformContainerCss(
  css: string,
  options: { scopeSelectors: boolean; rewriteViewportUnits: boolean; inline?: boolean }
): string {
  if (!css) return css;
  if (options.inline) {
    if (!options.rewriteViewportUnits) return css;
    // Inline `style="..."` has `prop: value;` pairs, while animation keyframe / SVG values
    // have no declaration colon — handle both without rewriting CSS property names.
    if (css.includes(':')) {
      return transformCssBlock(css, 0, css.length, 'declarations', { scopeSelectors: false, rewriteViewportUnits: true });
    }
    return rewriteViewportUnitsInValue(css);
  }
  return transformCssBlock(css, 0, css.length, 'rules', {
    scopeSelectors: options.scopeSelectors,
    rewriteViewportUnits: options.rewriteViewportUnits,
  });
}

const GENERIC_FONT_KEYWORDS = new Set([
  'normal', 'italic', 'oblique', 'bold', 'bolder', 'lighter', 'small-caps',
  'caption', 'icon', 'menu', 'message-box', 'small-caption', 'status-bar',
  'inherit', 'initial', 'unset', 'revert', 'revert-layer',
  'sans-serif', 'serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
  'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'math', 'emoji', 'fangsong',
  'xx-small', 'x-small', 'small', 'medium', 'large', 'x-large', 'xx-large', 'xxx-large',
  'smaller', 'larger',
]);

function parseSingleFontFamily(raw: string): { name: string; quoted: boolean } | null {
  const s = raw.trim();
  if (!s) return null;
  if (s[0] === '"' || s[0] === "'") {
    const parsed = readString(s, 0);
    if (parsed.end < s.length && s.slice(parsed.end).trim() !== '') return null;
    const name = parsed.value.trim();
    return name ? { name, quoted: true } : null;
  }
  const parts: string[] = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && isSpace(s[i])) i++;
    if (i >= s.length) break;
    if (!startsName(s, i)) return null;
    const ident = readName(s, i);
    parts.push(ident.name);
    i = ident.end;
  }
  const joined = parts.join(' ').trim();
  return joined ? { name: joined, quoted: false } : null;
}

function splitTopLevelCss(input: string, sep: string): string[] {
  const out: string[] = [];
  let start = 0;
  let i = 0;
  let depth = 0;
  while (i < input.length) {
    const c = input[i];
    if (c === '"' || c === "'") i = readString(input, i).end;
    else if (c === '\\') i = readEscape(input, i).end;
    else if (c === '/' && input[i + 1] === '*') {
      const close = input.indexOf('*/', i + 2);
      i = close < 0 ? input.length : close + 2;
    } else if (c === '(') {
      depth++;
      i++;
    } else if (c === ')') {
      depth = Math.max(0, depth - 1);
      i++;
    } else if (depth === 0 && c === sep) {
      out.push(input.slice(start, i));
      i++;
      start = i;
    } else {
      i++;
    }
  }
  out.push(input.slice(start));
  return out;
}

const ALLOWED_FONT_FACE_DESCRIPTORS = new Set([
  'font-family',
  'src',
  'font-style',
  'font-weight',
  'font-stretch',
  'font-display',
  'unicode-range',
  'ascent-override',
  'descent-override',
  'line-gap-override',
  'size-adjust',
  'font-feature-settings',
  'font-variation-settings',
]);

/**
 * Token-aware validator ensuring a `@font-face` body or descriptor value contains no
 * nested blocks (`{`/`}`), bracket blocks (`[`/`]`), unquoted `@`-rules, or unclosed
 * strings, comments, or parentheses. Prevents breaking out of `@font-face { ... }` into
 * host `document.head` rules via escaped quotes or unbalanced tokens.
 */
function hasSafeFontFaceTokens(text: string): boolean {
  let i = 0;
  let parenDepth = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      if (close < 0) return false;
      i = close + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      let j = i + 1;
      let closed = false;
      while (j < text.length) {
        const sc = text[j];
        if (sc === quote) {
          j++;
          closed = true;
          break;
        }
        if (sc === '\n' || sc === '\r' || sc === '\f') return false;
        if (sc === '\\') {
          if (j + 1 >= text.length) return false;
          const next = text[j + 1];
          if (next === '\r' && text[j + 2] === '\n') j += 3;
          else if (next === '\n' || next === '\r' || next === '\f') j += 2;
          else j = readEscape(text, j).end;
        } else {
          j++;
        }
      }
      if (!closed) return false;
      i = j;
      continue;
    }
    if (c === '\\') {
      const esc = readEscape(text, i);
      // Reject escaped structural/quote tokens outside strings inside @font-face descriptors
      // so host-page CSS parsers and serializers cannot diverge on string parity or braces.
      if (esc.char === '{' || esc.char === '}' || esc.char === '"' || esc.char === "'" || esc.char === ';' || esc.char === '@') {
        return false;
      }
      i = esc.end;
      continue;
    }
    if (c === '{' || c === '}' || c === '[' || c === ']' || c === '@') return false;
    if (c === '(') {
      parenDepth++;
      i++;
      continue;
    }
    if (c === ')') {
      if (parenDepth === 0) return false;
      parenDepth--;
      i++;
      continue;
    }
    i++;
  }
  return parenDepth === 0;
}

function findTopLevelColon(decl: string): number {
  let i = 0;
  let depth = 0;
  while (i < decl.length) {
    const c = decl[i];
    if (c === '"' || c === "'") i = readString(decl, i).end;
    else if (c === '\\') i = readEscape(decl, i).end;
    else if (c === '/' && decl[i + 1] === '*') {
      const close = decl.indexOf('*/', i + 2);
      i = close < 0 ? decl.length : close + 2;
    } else if (c === '(') {
      depth++;
      i++;
    } else if (c === ')') {
      depth = Math.max(0, depth - 1);
      i++;
    } else if (depth === 0 && c === ':') {
      return i;
    } else {
      i++;
    }
  }
  return -1;
}

function stripCssCommentsAndSpace(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      i = close < 0 ? text.length : close + 2;
      continue;
    }
    out += text[i++];
  }
  return out.trim();
}

function rewriteFontFaceDescriptors(
  body: string,
  scopePrefix: string | undefined,
  collected?: Set<string>
): { css: string; hasFamily: boolean } {
  if (!hasSafeFontFaceTokens(body)) {
    return { css: '', hasFamily: false };
  }
  const decls = splitTopLevelCss(body, ';');
  const out: string[] = [];
  let hasFamily = false;
  for (const rawDecl of decls) {
    const trimmed = rawDecl.trim();
    if (!trimmed) continue;
    const colon = findTopLevelColon(trimmed);
    if (colon < 0) {
      // Never pass malformed non-declaration fragments through into @font-face / document.head.
      continue;
    }
    const rawProp = stripCssCommentsAndSpace(trimmed.slice(0, colon));
    if (!rawProp || !startsName(rawProp, 0)) continue;
    const parsedProp = readName(rawProp, 0);
    if (parsedProp.end !== rawProp.length) continue;
    const propName = parsedProp.name.toLowerCase();
    if (!ALLOWED_FONT_FACE_DESCRIPTORS.has(propName)) {
      continue;
    }
    const rawVal = trimmed.slice(colon + 1).trim();
    if (!rawVal || !hasSafeFontFaceTokens(rawVal)) {
      continue;
    }
    if (propName !== 'font-family') {
      out.push(`${propName}: ${rawVal}`);
      continue;
    }
    const cleanVal = rawVal.replace(/\s*!important\s*$/i, '').trim();
    const parsed = parseSingleFontFamily(cleanVal);
    if (!parsed) {
      // Never emit an unparseable/un-namespaced font-family descriptor into document.head.
      continue;
    }
    hasFamily = true;
    if (scopePrefix) {
      const name = parsed.name.startsWith(scopePrefix) ? parsed.name : `${scopePrefix}${parsed.name}`;
      const original = parsed.name.startsWith(scopePrefix) ? parsed.name.slice(scopePrefix.length) : parsed.name;
      if (original) collected?.add(original.toLowerCase());
      out.push(`font-family: ${cssString(name)}`);
    } else {
      collected?.add(parsed.name.toLowerCase());
      out.push(`font-family: ${cssString(parsed.name)}`);
    }
  }
  return { css: out.join('; '), hasFamily };
}

function rewriteFontFamilyList(
  value: string,
  scopePrefix: string,
  declaredLower: ReadonlySet<string>
): string {
  if (declaredLower.size === 0) return value;
  const impMatch = /(\s*!important\s*)$/i.exec(value);
  const suffix = impMatch ? impMatch[1] : '';
  const core = impMatch ? value.slice(0, impMatch.index) : value;
  const items = splitTopLevelCss(core, ',');
  let changed = false;
  const rewritten = items.map((item) => {
    const parsed = parseSingleFontFamily(item);
    if (!parsed) return item;
    if (parsed.name.startsWith(scopePrefix)) return item;
    const lower = parsed.name.toLowerCase();
    if (!declaredLower.has(lower)) return item;
    if (!parsed.quoted && GENERIC_FONT_KEYWORDS.has(lower)) return item;
    changed = true;
    return ` ${cssString(`${scopePrefix}${parsed.name}`)}`;
  });
  return changed ? `${rewritten.join(',')}${suffix}` : value;
}

function rewriteFontOrVarValue(
  value: string,
  scopePrefix: string,
  declaredLower: ReadonlySet<string>
): string {
  if (declaredLower.size === 0) return value;
  let out = '';
  let i = 0;
  let changed = false;
  while (i < value.length) {
    const c = value[i];
    if (c === '"' || c === "'") {
      const str = readString(value, i);
      const lower = str.value.trim().toLowerCase();
      if (lower && !str.value.startsWith(scopePrefix) && declaredLower.has(lower)) {
        out += cssString(`${scopePrefix}${str.value.trim()}`);
        changed = true;
      } else {
        out += value.slice(i, str.end);
      }
      i = str.end;
      continue;
    }
    if (startsName(value, i)) {
      const ident = readName(value, i);
      const lower = ident.name.toLowerCase();
      if (
        lower &&
        !ident.name.startsWith(scopePrefix) &&
        !GENERIC_FONT_KEYWORDS.has(lower) &&
        declaredLower.has(lower) &&
        value[ident.end] !== '('
      ) {
        out += cssString(`${scopePrefix}${ident.name}`);
        changed = true;
      } else {
        out += value.slice(i, ident.end);
      }
      i = ident.end;
      continue;
    }
    out += c;
    i++;
  }
  return changed ? out : value;
}

/**
 * Collect lowercase font-family names declared by `@font-face` rules in `sanitizedCss`.
 */
export function collectFontFaceFamilies(sanitizedCss: string): string[] {
  if (!/@(?:font-face|\\)/i.test(sanitizedCss)) return [];
  const names = new Set<string>();
  const extracted = extractFontFaces(sanitizedCss);
  let i = 0;
  while (i < extracted.length) {
    const brace = extracted.indexOf('{', i);
    if (brace < 0) break;
    const close = findMatchingBrace(extracted, brace, extracted.length);
    const body = extracted.slice(brace + 1, close);
    for (const rawDecl of splitTopLevelCss(body, ';')) {
      const trimmed = rawDecl.trim();
      const colon = findTopLevelColon(trimmed);
      if (colon < 0) continue;
      if (readName(trimmed, 0).name.toLowerCase() !== 'font-family') continue;
      const rawVal = trimmed.slice(colon + 1).replace(/\s*!important\s*$/i, '').trim();
      const parsed = parseSingleFontFamily(rawVal);
      if (parsed) names.add(parsed.name.toLowerCase());
    }
    i = close + 1;
  }
  return [...names];
}

/**
 * Namespace all `@font-face` family names in `sanitizedCss` with `scopePrefix` and rewrite
 * matching `font-family` / `font` / custom-property references so a container app can never
 * hijack or override the embedding host page's font families via `document.head`.
 */
export function namespaceContainerFonts(
  sanitizedCss: string,
  scopePrefix: string,
  declaredFamilies: Set<string>,
  inline = false
): string {
  if (!sanitizedCss || !scopePrefix) return sanitizedCss;
  if (inline && !/font|--|\\/i.test(sanitizedCss)) {
    return sanitizedCss;
  }
  for (const fam of collectFontFaceFamilies(sanitizedCss)) {
    declaredFamilies.add(fam);
  }
  if (declaredFamilies.size === 0 && !/@(?:font-face|\\)/i.test(sanitizedCss)) {
    return sanitizedCss;
  }

  const rewriteBlock = (start: number, end: number, mode: 'rules' | 'declarations' | 'keyframes', depth = 0): string => {
    if (depth >= MAX_CSS_NESTING_DEPTH) return '';
    let out = '';
    let i = start;
    while (i < end) {
      if (isSpace(sanitizedCss[i]) || sanitizedCss[i] === ';') {
        out += sanitizedCss[i++];
        continue;
      }
      if (sanitizedCss[i] === '/' && sanitizedCss[i + 1] === '*') {
        const close = sanitizedCss.indexOf('*/', i + 2);
        const stop = close < 0 || close + 2 > end ? end : close + 2;
        out += sanitizedCss.slice(i, stop);
        i = stop;
        continue;
      }
      if (sanitizedCss[i] === '@' && startsName(sanitizedCss, i + 1)) {
        const ruleName = readName(sanitizedCss, i + 1);
        const lowerName = ruleName.name.toLowerCase();
        let j = ruleName.end;
        while (j < end && sanitizedCss[j] !== ';' && sanitizedCss[j] !== '{') {
          if (sanitizedCss[j] === '"' || sanitizedCss[j] === "'") j = Math.min(end, readString(sanitizedCss, j).end);
          else if (sanitizedCss[j] === '\\') j = Math.min(end, readEscape(sanitizedCss, j).end);
          else if (sanitizedCss[j] === '(') j = Math.min(end, skipBalanced(sanitizedCss, j));
          else if (sanitizedCss[j] === '[') j = skipBrackets(sanitizedCss, j, end);
          else if (sanitizedCss[j] === '/' && sanitizedCss[j + 1] === '*') {
            const close = sanitizedCss.indexOf('*/', j + 2);
            j = close < 0 || close + 2 > end ? end : close + 2;
          } else j++;
        }
        if (j >= end) {
          out += sanitizedCss.slice(i, end);
          break;
        }
        if (sanitizedCss[j] === ';') {
          out += sanitizedCss.slice(i, j + 1);
          i = j + 1;
          continue;
        }
        const closeBrace = findMatchingBrace(sanitizedCss, j, end);
        const prelude = sanitizedCss.slice(i, j);
        if (lowerName === 'font-face') {
          const body = sanitizedCss.slice(j + 1, closeBrace);
          const rewritten = rewriteFontFaceDescriptors(body, scopePrefix, declaredFamilies);
          if (rewritten.hasFamily && rewritten.css) {
            out += `@font-face{${rewritten.css}}`;
          }
        } else {
          const childMode =
            mode === 'declarations'
              ? 'declarations'
              : GROUPING_AT_RULES.has(lowerName)
                ? 'rules'
                : KEYFRAMES_AT_RULES.has(lowerName)
                  ? 'keyframes'
                  : 'declarations';
          out += `${prelude}{${rewriteBlock(j + 1, closeBrace, childMode, depth + 1)}${closeBrace < end ? '}' : ''}`;
        }
        i = closeBrace < end ? closeBrace + 1 : end;
        continue;
      }
      if (mode === 'rules' || mode === 'keyframes') {
        let j = i;
        while (j < end && sanitizedCss[j] !== '{' && sanitizedCss[j] !== ';') {
          if (sanitizedCss[j] === '"' || sanitizedCss[j] === "'") j = Math.min(end, readString(sanitizedCss, j).end);
          else if (sanitizedCss[j] === '\\') j = Math.min(end, readEscape(sanitizedCss, j).end);
          else if (sanitizedCss[j] === '(') j = Math.min(end, skipBalanced(sanitizedCss, j));
          else if (sanitizedCss[j] === '[') j = skipBrackets(sanitizedCss, j, end);
          else if (sanitizedCss[j] === '/' && sanitizedCss[j + 1] === '*') {
            const close = sanitizedCss.indexOf('*/', j + 2);
            j = close < 0 || close + 2 > end ? end : close + 2;
          } else j++;
        }
        if (j >= end) {
          out += sanitizedCss.slice(i, end);
          break;
        }
        if (sanitizedCss[j] === ';') {
          out += sanitizedCss.slice(i, j + 1);
          i = j + 1;
          continue;
        }
        const closeBrace = findMatchingBrace(sanitizedCss, j, end);
        out += `${sanitizedCss.slice(i, j)}{${rewriteBlock(j + 1, closeBrace, 'declarations', depth + 1)}${closeBrace < end ? '}' : ''}`;
        i = closeBrace < end ? closeBrace + 1 : end;
        continue;
      }
      let j = i;
      let firstColon = -1;
      while (j < end && sanitizedCss[j] !== ';' && sanitizedCss[j] !== '{') {
        if (sanitizedCss[j] === '"' || sanitizedCss[j] === "'") j = Math.min(end, readString(sanitizedCss, j).end);
        else if (sanitizedCss[j] === '\\') j = Math.min(end, readEscape(sanitizedCss, j).end);
        else if (sanitizedCss[j] === '(') j = Math.min(end, skipBalanced(sanitizedCss, j));
        else if (sanitizedCss[j] === '[') j = skipBrackets(sanitizedCss, j, end);
        else if (sanitizedCss[j] === '/' && sanitizedCss[j + 1] === '*') {
          const close = sanitizedCss.indexOf('*/', j + 2);
          j = close < 0 || close + 2 > end ? end : close + 2;
        } else {
          if (sanitizedCss[j] === ':' && firstColon < 0) firstColon = j;
          j++;
        }
      }
      if (j < end && sanitizedCss[j] === '{') {
        const closeBrace = findMatchingBrace(sanitizedCss, j, end);
        out += `${sanitizedCss.slice(i, j)}{${rewriteBlock(j + 1, closeBrace, 'declarations', depth + 1)}${closeBrace < end ? '}' : ''}`;
        i = closeBrace < end ? closeBrace + 1 : end;
        continue;
      }
      if (firstColon >= 0) {
        const propPart = sanitizedCss.slice(i, firstColon + 1);
        const propName = readName(sanitizedCss.slice(i, firstColon).trim(), 0).name.toLowerCase();
        const valPart = sanitizedCss.slice(firstColon + 1, j);
        if (propName === 'font-family') {
          out += propPart + rewriteFontFamilyList(valPart, scopePrefix, declaredFamilies);
        } else if (propName === 'font' || propName.startsWith('--')) {
          out += propPart + rewriteFontOrVarValue(valPart, scopePrefix, declaredFamilies);
        } else {
          out += sanitizedCss.slice(i, j);
        }
      } else {
        out += sanitizedCss.slice(i, j);
      }
      if (j < end && sanitizedCss[j] === ';') {
        out += ';';
        i = j + 1;
      } else {
        i = j;
      }
    }
    return out;
  };

  if (inline) {
    return sanitizedCss.includes(':')
      ? rewriteBlock(0, sanitizedCss.length, 'declarations')
      : sanitizedCss;
  }
  return rewriteBlock(0, sanitizedCss.length, 'rules');
}

/**
 * Extract already-sanitized `@font-face { ... }` rules from a stylesheet so the container host
 * can mirror them into `document.head` (Chromium does not register `@font-face` rules declared
 * solely inside a ShadowRoot). Only flat allowlisted `@font-face` descriptor blocks are returned.
 * When `scopePrefix` is given, every `font-family` descriptor is unconditionally namespaced.
 */
export function extractFontFaces(sanitizedCss: string, scopePrefix?: string): string {
  if (!/@(?:font-face|\\)/i.test(sanitizedCss)) return '';
  const blocks: string[] = [];

  const scan = (start: number, end: number, depth = 0) => {
    if (depth >= MAX_CSS_NESTING_DEPTH) return;
    let i = start;
    while (i < end) {
      const c = sanitizedCss[i];
      if (c === '"' || c === "'") {
        i = Math.min(end, readString(sanitizedCss, i).end);
        continue;
      }
      if (c === '\\') {
        i = Math.min(end, readEscape(sanitizedCss, i).end);
        continue;
      }
      if (c === '/' && sanitizedCss[i + 1] === '*') {
        const close = sanitizedCss.indexOf('*/', i + 2);
        i = close < 0 || close + 2 > end ? end : close + 2;
        continue;
      }
      if (c === '(') {
        i = Math.min(end, skipBalanced(sanitizedCss, i));
        continue;
      }
      if (c === '[') {
        i = skipBrackets(sanitizedCss, i, end);
        continue;
      }
      if (c === '@' && startsName(sanitizedCss, i + 1)) {
        const ruleName = readName(sanitizedCss, i + 1);
        const lower = ruleName.name.toLowerCase();
        let j = ruleName.end;
        while (j < end && sanitizedCss[j] !== ';' && sanitizedCss[j] !== '{') {
          if (sanitizedCss[j] === '"' || sanitizedCss[j] === "'") j = Math.min(end, readString(sanitizedCss, j).end);
          else if (sanitizedCss[j] === '\\') j = Math.min(end, readEscape(sanitizedCss, j).end);
          else if (sanitizedCss[j] === '(') j = Math.min(end, skipBalanced(sanitizedCss, j));
          else if (sanitizedCss[j] === '[') j = skipBrackets(sanitizedCss, j, end);
          else if (sanitizedCss[j] === '/' && sanitizedCss[j + 1] === '*') {
            const close = sanitizedCss.indexOf('*/', j + 2);
            j = close < 0 || close + 2 > end ? end : close + 2;
          } else j++;
        }
        if (j >= end) break;
        if (sanitizedCss[j] === ';') {
          i = j + 1;
          continue;
        }
        const closeBrace = findMatchingBrace(sanitizedCss, j, end);
        if (lower === 'font-face' && closeBrace < end) {
          // Ensure the prelude has no stray tokens (CSS `@font-face` takes no prelude).
          const preludeRemainder = stripCssCommentsAndSpace(sanitizedCss.slice(ruleName.end, j));
          if (!preludeRemainder) {
            const body = sanitizedCss.slice(j + 1, closeBrace);
            const sanitized = rewriteFontFaceDescriptors(body, scopePrefix);
            if (sanitized.css && (!scopePrefix || sanitized.hasFamily)) {
              blocks.push(`@font-face{${sanitized.css}}`);
            }
          }
        } else if (GROUPING_AT_RULES.has(lower)) {
          scan(j + 1, closeBrace, depth + 1);
        }
        i = closeBrace < end ? closeBrace + 1 : end;
        continue;
      }
      if (c === '{') {
        const closeBrace = findMatchingBrace(sanitizedCss, i, end);
        i = closeBrace < end ? closeBrace + 1 : end;
        continue;
      }
      i++;
    }
  };

  scan(0, sanitizedCss.length);
  return blocks.join('\n');
}
