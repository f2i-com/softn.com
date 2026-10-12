/**
 * Where in the logic a syntax error is.
 *
 * ZIPP reports a script that does not compile as `SyntaxError: unexpected
 * token Semi` and nothing more: no line, no column. The page showed that, and
 * Studio's check handed it to the AI, which then had the whole of the logic
 * to search. So a failed compile is read once more by acorn, which core ships
 * for the host-JavaScript engine, and the line it stops at is quoted with the
 * engine's message.
 *
 * Quoted, not numbered: what is compiled is the app's logic files joined, with
 * their imports inlined, so a line number would count lines of a text the
 * author never wrote. acorn is loaded only when a compile fails, so a page
 * whose logic compiles never loads it; where it cannot be loaded, the message
 * stays as the engine wrote it. The script worker does not use this: its copy
 * of core is served as it is built, where `acorn` is a name no browser can
 * resolve.
 */

/** The longest line quoted whole. */
const MAX_QUOTED = 120;

/**
 * `error` as the engine threw it, with the line of `code` that does not
 * compile quoted after its message. Anything that is not a syntax error, or
 * that acorn finds no fault with, is returned as it was. The thrown value
 * keeps its kind: the engine throws its message as a string, and a host may
 * show it as one.
 */
export async function placeSyntaxError(error: unknown, code: string): Promise<unknown> {
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : '';
  if (!/SyntaxError/.test(`${name} ${message}`)) return error;
  let at: { pos?: number; loc?: { line?: number } } | undefined;
  try {
    const acorn = await import('acorn');
    acorn.parse(code, {
      ecmaVersion: 'latest',
      sourceType: 'script',
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      allowHashBang: true,
    });
  } catch (fault) {
    at = fault as typeof at;
  }
  const line = at?.loc?.line;
  if (line === undefined) return error;
  // The host-JavaScript engine's message carries a position of its own, in
  // the script with its preamble: a line the author cannot find.
  const said = message.replace(/ \(\d+:\d+\)$/, '');
  let placed: string;
  if ((at?.pos ?? 0) >= code.trimEnd().length) {
    placed = `${said}, at the end of the logic: a brace, bracket or string opened before it is never closed`;
  } else {
    const text = code.split('\n')[line - 1]?.trim();
    if (!text) return error;
    const quoted = text.length > MAX_QUOTED ? `${text.slice(0, MAX_QUOTED - 1)}…` : text;
    placed = `${said}, at this line of the logic: ${quoted}`;
  }
  if (!(error instanceof Error)) return placed;
  const replacement = new Error(placed);
  replacement.name = error.name;
  return replacement;
}
