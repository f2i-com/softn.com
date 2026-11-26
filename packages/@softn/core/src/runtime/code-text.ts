import { regExpEnd, startsRegExp } from './computed-declarations';

/**
 * Code with its comments taken out and its string literals emptied, in one
 * pass: for a check that looks for names in a page's code and must not find
 * them in a comment or a string (`detectWorkerIncompatibilities`).
 *
 * Read as the regular expressions it replaces read it, roughly: `//` to the
 * end of the line, `/* … *\/` (one left open runs to the end), and strings in
 * '', "" or `` (a template's `${…}` is inside its string), each emptied to
 * `""`. A regular-expression literal is read as code, kept as written, and
 * passed over whole (by the rule computed-declarations.ts reads `/` by): a
 * quote inside one (`s.replace(/"/g, "")`) began a string that emptied the
 * code after it to the next quote, `db.` and `window.__…` uses and all.
 * Linear in the length: the expressions scanned to the end again from every
 * `/*` that never closed, so a page's logic of `/* ` repeated held the main
 * thread for seconds before it ran.
 */
export function blankCommentsAndStrings(code: string): string {
  let out = '';
  let kept = 0;
  let i = 0;
  const n = code.length;
  // The last character neither space nor comment, and whether it closed a
  // string or a pattern: what a `/` is read by.
  let last = -1;
  let closedLiteral = false;
  while (i < n) {
    const c = code.charCodeAt(i);
    if (c === 47 /* / */ && code.charCodeAt(i + 1) === 42 /* * */) {
      out += code.slice(kept, i);
      const end = code.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      kept = i;
    } else if (c === 47 && code.charCodeAt(i + 1) === 47) {
      out += code.slice(kept, i);
      while (i < n && code[i] !== '\n' && code[i] !== '\r') i++;
      kept = i;
    } else if (c === 47 && startsRegExp(code, last, closedLiteral)) {
      i = regExpEnd(code, i);
      last = i - 1;
      closedLiteral = true;
    } else if (c === 34 /* " */ || c === 39 /* ' */ || c === 96 /* ` */) {
      out += code.slice(kept, i) + '""';
      const quote = code[i];
      i++;
      while (i < n && code[i] !== quote) i += code[i] === '\\' ? 2 : 1;
      i = Math.min(n, i + 1);
      kept = i;
      last = i - 1;
      closedLiteral = true;
    } else {
      // Space: 9–13 and 32, and past ASCII as `\s` reads it.
      if (!(c === 32 || (c >= 9 && c <= 13) || (c > 127 && /\s/.test(code[i])))) {
        last = i;
        closedLiteral = false;
      }
      i++;
    }
  }
  return out + code.slice(kept);
}
