/**
 * A line diff small enough to keep on a chat message: the changed lines of
 * a write with a little context, not the files themselves. The common head
 * and tail are trimmed first, so an edit in a long file costs the edit; what
 * is left is aligned by longest common subsequence while that is cheap, and
 * shown as removed-then-added when it is not.
 */

export type DiffLine = [' ' | '+' | '-' | '…', string];

export interface LineDiff {
  path: string;
  added: number;
  removed: number;
  lines: DiffLine[];
  /** Lines were left out to keep the diff short. */
  truncated: boolean;
}

const CONTEXT = 2;
const MAX_LINES = 160;
const MAX_CELLS = 250_000;

function split(text: string | null): string[] {
  if (text === null || text.length === 0) return [];
  return text.replace(/\r\n/g, '\n').split('\n');
}

export function lineDiff(path: string, before: string | null, after: string | null): LineDiff {
  const a = split(before);
  const b = split(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);

  const ops: DiffLine[] = [];
  if (midA.length * midB.length <= MAX_CELLS) {
    // LCS table, then walk it.
    const n = midA.length;
    const m = midB.length;
    const table: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        table[i][j] = midA[i] === midB[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) {
        ops.push([' ', midA[i]]);
        i++;
        j++;
      } else if (j < m && (i === n || table[i][j + 1] >= table[i + 1][j])) {
        ops.push(['+', midB[j++]]);
      } else {
        ops.push(['-', midA[i++]]);
      }
    }
  } else {
    for (const line of midA) ops.push(['-', line]);
    for (const line of midB) ops.push(['+', line]);
  }

  const added = ops.filter((o) => o[0] === '+').length;
  const removed = ops.filter((o) => o[0] === '-').length;

  // Context around the change from the trimmed head and tail.
  const before_ = a.slice(Math.max(0, head - CONTEXT), head).map((l): DiffLine => [' ', l]);
  const after_ = a.slice(a.length - tail, Math.min(a.length, a.length - tail + CONTEXT)).map((l): DiffLine => [' ', l]);
  const all = [...(head > CONTEXT ? [['…', `${head - CONTEXT} unchanged line(s)`] as DiffLine] : []), ...before_, ...collapse(ops), ...after_];
  if (tail > CONTEXT) all.push(['…', `${tail - CONTEXT} unchanged line(s)`]);

  const truncated = all.length > MAX_LINES;
  const lines = truncated ? [...all.slice(0, MAX_LINES), ['…', `${all.length - MAX_LINES} more line(s) not shown`] as DiffLine] : all;
  return { path, added, removed, lines, truncated };
}

/** Long runs of unchanged lines inside the middle, folded to their context. */
function collapse(ops: DiffLine[]): DiffLine[] {
  const out: DiffLine[] = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i][0] !== ' ') {
      out.push(ops[i++]);
      continue;
    }
    let j = i;
    while (j < ops.length && ops[j][0] === ' ') j++;
    const run = ops.slice(i, j);
    if (run.length > CONTEXT * 2 + 1) {
      out.push(...run.slice(0, CONTEXT), ['…', `${run.length - CONTEXT * 2} unchanged line(s)`], ...run.slice(-CONTEXT));
    } else {
      out.push(...run);
    }
    i = j;
  }
  return out;
}
