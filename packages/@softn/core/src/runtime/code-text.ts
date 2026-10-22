/**
 * Code with its comments taken out and its string literals emptied, in one
 * pass: for a check that looks for names in a page's code and must not find
 * them in a comment or a string (`detectWorkerIncompatibilities`).
 *
 * Read as the regular expressions it replaces read it, roughly: `//` to the
 * end of the line, `/* … *\/` (one left open runs to the end), and strings in
 * '', "" or `` (a template's `${…}` is inside its string), each emptied to
 * `""`. A regular-expression literal is read as code. Linear in the length:
 * the expressions scanned to the end again from every `/*` that never
 * closed, so a page's logic of `/* ` repeated held the main thread for
 * seconds before it ran.
 */
export function blankCommentsAndStrings(code: string): string {
  let out = '';
  let kept = 0;
  let i = 0;
  const n = code.length;
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
    } else if (c === 34 /* " */ || c === 39 /* ' */ || c === 96 /* ` */) {
      out += code.slice(kept, i) + '""';
      const quote = code[i];
      i++;
      while (i < n && code[i] !== quote) i += code[i] === '\\' ? 2 : 1;
      i = Math.min(n, i + 1);
      kept = i;
    } else {
      i++;
    }
  }
  return out + code.slice(kept);
}
