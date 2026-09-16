/**
 * An engine error in the author's terms.
 *
 * A Python app's project carries two files the author never wrote — `main.py`,
 * the entry the adapter calls, and `softn.py`, the capability module — and each
 * of the author's own modules has a generated setter appended to it. So a raw
 * engine message can name a file the author has never seen, or a line past the
 * end of the file they did write. Neither is something they can act on.
 *
 * This is the same treatment FormLogic's committed `formlogic-python/1`
 * contract gives its own driver files (`authorMessage` in `pythonContract.ts`),
 * with one difference that comes from Softn appending rather than prepending:
 * the author's line numbers are already right, so nothing is subtracted and
 * only the tail — the generated setter — has to be folded back onto the last
 * line the author actually wrote.
 */

/** Files the runtime generates. A frame in one of these is not the author's. */
export const DRIVER_MODULES: readonly string[] = ['__softn_main__', 'softn'];

/** How many lines the author wrote in each of their own module files. */
export type AuthorLineCounts = ReadonlyMap<string, number>;

/** Lines in a source, counting a trailing newline as ending the last line. */
export function lineCount(source: string): number {
  const lines = source.split(/\r\n?|\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return Math.max(1, lines.length);
}

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Rewrite `raw` so every location it names is one the author can open.
 *
 * - A frame in `main.py` or `softn.py` is dropped, with the
 *   `[Previous line repeated N more times]` that may follow it.
 * - A line number in one of the author's modules is clamped to that file's
 *   own length, so an unterminated bracket — which Python reports at the end
 *   of the file, and the file now ends with a generated setter — points at the
 *   last line the author wrote rather than at generated code.
 *
 * Everything else is left exactly as the engine said it.
 */
export function authorMessage(raw: string, authorLines: AuthorLineCounts): string {
  const clamp = (file: string, engineLine: number): number => {
    const limit = authorLines.get(file);
    if (limit === undefined) return engineLine;
    return Math.min(limit, Math.max(1, engineLine));
  };

  const driverFrame = new RegExp(`^\\s*File "(?:${DRIVER_MODULES.join('|')})\\.py", line \\d+`);
  const repeated = /^\s*\[Previous line repeated \d+ more times?\]$/;
  let droppedLast = false;
  const kept = raw.split('\n').filter((text) => {
    const driver = driverFrame.test(text) || (droppedLast && repeated.test(text));
    droppedLast = driver;
    return !driver;
  });

  const files = [...authorLines.keys()];
  let out = kept.join('\n');
  for (const file of files) {
    const name = escapeRegex(file);
    out = out
      // `(app.py:12:3)` and `Python: app.py:12:3:`
      .replace(new RegExp(`${name}\\.py:(\\d+)(?::(\\d+))?`, 'g'), (_m, n: string, col?: string) =>
        `${file}.py:${clamp(file, Number(n))}${col ? `:${col}` : ''}`
      )
      // `File "app.py", line 12`
      .replace(new RegExp(`File "${name}\\.py", line (\\d+)`, 'g'), (_m, n: string) =>
        `File "${file}.py", line ${clamp(file, Number(n))}`
      );
  }
  // A frame list whose every entry was the driver's leaves a bare header.
  return out.replace(/\nTraceback \(most recent call last\):$/, '');
}

/**
 * Drop the generated setter from a module's source, for counting the author's
 * lines. The setter is appended after two blank lines and is the only thing
 * this runtime adds, so the author's file is everything before it.
 */
export function authorLineCountsFor(
  sources: ReadonlyMap<string, string>
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const [module, source] of sources) counts.set(module, lineCount(source));
  return counts;
}
