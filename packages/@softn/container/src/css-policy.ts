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

const isHex = (c: string): boolean => /^[0-9a-fA-F]$/.test(c);
const isSpace = (c: string): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
const isNameStart = (c: string): boolean => /^[A-Za-z_]$/.test(c) || c > '\u007f';
const isNameChar = (c: string): boolean => /^[A-Za-z0-9_-]$/.test(c) || c > '\u007f';

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
export function rewriteCss(css: string, mapUrl: (address: string) => string | null): string {
  const address = (raw: string): string => cssString(mapUrl(raw.trim()) ?? 'about:blank');
  let out = '';
  let i = 0;
  let depth = 0;
  // Bracket depths at which a bare string is an address (inside image-set() and its like).
  const imageDepths: number[] = [];

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
      out += imageDepths.length > 0 && imageDepths[imageDepths.length - 1] === depth ? address(str.value) : cssString(str.value);
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
        if (lower === 'host' || lower === 'host-context') {
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
      out += `${css.slice(i, ident.end)}(`;
      depth++;
      if (IMAGE_FUNCTIONS.has(lower)) imageDepths.push(depth);
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
      if (imageDepths.length > 0 && imageDepths[imageDepths.length - 1] === depth) imageDepths.pop();
      if (depth > 0) depth--;
    }
    out += c;
    i++;
  }
  return out;
}
