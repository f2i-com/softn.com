/**
 * An engine error in the author's terms.
 *
 * A Python app's project carries two files the author never wrote —
 * `__softn_main__.py`, the entry the adapter calls, and `softn.py`, the
 * capability module. Their own modules go to the engine exactly as written.
 * So a raw engine message can name a file the author has never seen, or — for
 * a construct left open at the end of a file, which Python reports at the
 * position after the last line — a line past the end of the file they did
 * write. Neither is something they can act on.
 *
 * This is the same treatment FormLogic's committed `formlogic-python/1`
 * contract gives its own driver files (`authorMessage` in `pythonContract.ts`),
 * with one difference that comes from Softn adding nothing to the author's
 * files: their line numbers are already right, so nothing is subtracted and
 * only a location past the end is folded back onto the last line they wrote.
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
 *   own length, so an unterminated bracket — which Python reports at the
 *   position after the file's last line — points at the last line the author
 *   wrote rather than at a line their editor does not have.
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
