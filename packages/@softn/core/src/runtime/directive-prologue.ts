/**
 * Whether a script asks for strict mode, as the language decides it: by a
 * `"use strict"` among the string-literal statements it opens with (its
 * directive prologue), spelled exactly so, with no escape in it.
 *
 * The engine reads this off the text it is handed, and SoftN hands it its
 * own bridges first and the app's code after them, so the app's directive
 * was an ordinary string and strict code ran sloppy. The runtime reads the
 * app's prologue here, as ZIPP's parser reads one (`script_prologue_is_strict`),
 * and puts {@link STRICT_DIRECTIVE} in front of everything when it asks.
 *
 * No parser is loaded for this: it reads the few tokens a prologue can be.
 * Comments, a byte-order mark and a hashbang before it are passed over; a
 * string followed by an operator (`"use strict" + x`, or one on the next line,
 * `"use strict"\n.length`) is an expression and ends the prologue, as
 * automatic semicolon insertion has it. Text that is not a script at all
 * reads as whatever its readable start says; the engine refuses it anyway.
 */

/** Put first, on the first line, so no line of the app moves. */
export const STRICT_DIRECTIVE = '"use strict";';

const LINE_TERMINATOR = /[\n\r\u2028\u2029]/;
// WhiteSpace as the language has it: tab, VT, FF, ZWNBSP and Space_Separator.
const WHITE_SPACE = /[\t\v\f \u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\ufeff]/;
const IDENTIFIER_PART = /[\p{ID_Continue}$\u200c\u200d]/u;

/** Past the white space, line terminators and comments from `at`, and whether a line ended on the way. */
function skip(code: string, at: number, lineStart: boolean): { at: number; newline: boolean } {
  let newline = false;
  while (at < code.length) {
    const c = code[at];
    if (LINE_TERMINATOR.test(c)) {
      newline = true;
      at++;
    } else if (WHITE_SPACE.test(c)) {
      at++;
    } else if (code.startsWith('//', at) || code.startsWith('<!--', at) || ((newline || lineStart) && code.startsWith('-->', at))) {
      // A line comment, HTML's `<!--` anywhere and its `-->` first on a line
      // (scripts, not modules, read both as line comments).
      while (at < code.length && !LINE_TERMINATOR.test(code[at])) at++;
    } else if (code.startsWith('/*', at)) {
      const end = code.indexOf('*/', at + 2);
      const body = code.slice(at + 2, end < 0 ? code.length : end);
      if (LINE_TERMINATOR.test(body)) newline = true;
      at = end < 0 ? code.length : end + 2;
    } else {
      break;
    }
  }
  return { at, newline };
}

/**
 * Whether what starts at `at`, after a line break, carries on the expression
 * before it, so that no semicolon is inserted there.
 */
function continuesExpression(code: string, at: number): boolean {
  const c = code[at];
  const next = code[at + 1] ?? '';
  if ('([`,?=*%&|^<>/'.includes(c)) return true;
  // `.5` is a number, which cannot follow a string: a new statement.
  if (c === '.') return !/[0-9]/.test(next);
  // `++` and `--` after a line break begin the next statement.
  if (c === '+' || c === '-') return next !== c;
  if (c === '!') return next === '=';
  for (const word of ['instanceof', 'in']) {
    if (code.startsWith(word, at) && !IDENTIFIER_PART.test(code[at + word.length] ?? '')) return true;
  }
  return false;
}

/** Whether `code`'s own directive prologue turns strict mode on. */
export function prologueIsStrict(code: string): boolean {
  let at = 0;
  if (code.charCodeAt(0) === 0xfeff) at = 1;
  if (code.startsWith('#!', at)) {
    while (at < code.length && !LINE_TERMINATOR.test(code[at])) at++;
  }
  let strict = false;
  let first = true;
  for (;;) {
    at = skip(code, at, first).at;
    first = false;
    const quote = code[at];
    if (quote !== '"' && quote !== "'") return strict;
    let end = at + 1;
    for (; end < code.length && code[end] !== quote; end++) {
      if (code[end] === '\\') {
        // An escape, or a line continuation (a backslash, then CR LF too).
        end += code[end + 1] === '\r' && code[end + 2] === '\n' ? 2 : 1;
      } else if (code[end] === '\n' || code[end] === '\r') {
        return strict;
      }
    }
    if (end >= code.length) return strict;
    const raw = code.slice(at + 1, end);
    const after = skip(code, end + 1, false);
    const next = code[after.at];
    const ends =
      after.at >= code.length || next === ';' || next === '}' || (after.newline && !continuesExpression(code, after.at));
    if (!ends) return strict;
    if (raw === 'use strict') strict = true;
    at = next === ';' ? after.at + 1 : after.at;
  }
}
