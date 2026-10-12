/**
 * The order a sortable column puts its rows in, for a Table or a DataGrid
 * that sorts them itself (one given no `onSort`).
 *
 * Cells are compared as what they hold, not as the text they are drawn as:
 * a number, or text that is a number ("10" from a form), by its value, so 9
 * comes before 10; a date, or text that is an ISO date, by its time; a
 * yes/no with no before yes; anything else as text in the reader's own
 * order, with the digits in it read as numbers ("item 9" before "item 10")
 * and no difference made for case. An empty cell (nothing, or blank text)
 * goes last whichever way the column is sorted. Rows that tie keep the order
 * they were given in.
 */

const collator = typeof Intl !== 'undefined' ? new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }) : null;

const NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;

type Key = { kind: 0; value: boolean } | { kind: 1; value: number } | { kind: 2; value: number } | { kind: 3; value: string };

function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '') || (typeof value === 'number' && Number.isNaN(value));
}

/** What a cell is compared as. Kinds that differ are put in this order: yes/no, numbers, dates, text. */
function keyOf(value: unknown): Key {
  if (typeof value === 'boolean') return { kind: 0, value };
  if (typeof value === 'number') return { kind: 1, value };
  if (typeof value === 'bigint') return { kind: 1, value: Number(value) };
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? { kind: 3, value: '' } : { kind: 2, value: value.getTime() };
  const text = typeof value === 'string' ? value.trim() : String(value);
  if (NUMBER.test(text)) return { kind: 1, value: Number(text) };
  if (ISO_DATE.test(text)) {
    const time = Date.parse(text);
    if (!Number.isNaN(time)) return { kind: 2, value: time };
  }
  return { kind: 3, value: text };
}

/** Two cells in ascending order; empty cells after everything else. */
export function compareCells(a: unknown, b: unknown): number {
  const emptyA = isEmpty(a);
  const emptyB = isEmpty(b);
  if (emptyA || emptyB) return emptyA === emptyB ? 0 : emptyA ? 1 : -1;
  return compareKeys(keyOf(a), keyOf(b));
}

function compareKeys(a: Key, b: Key): number {
  if (a.kind !== b.kind) return a.kind - b.kind;
  if (a.kind === 3) return collator ? collator.compare(a.value, b.value as string) : a.value < (b.value as string) ? -1 : a.value > (b.value as string) ? 1 : 0;
  const x = Number(a.value);
  const y = Number(b.value);
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * The rows sorted by `valueOf`, as a new list. Descending turns the order of
 * the values over but still puts empty cells last and keeps ties as given.
 */
export function sortRows<T>(rows: readonly T[], valueOf: (row: T) => unknown, direction: 'asc' | 'desc'): T[] {
  const sign = direction === 'desc' ? -1 : 1;
  return rows
    .map((row, index) => {
      const value = valueOf(row);
      return { row, index, value, empty: isEmpty(value) };
    })
    .sort((a, b) => {
      if (a.empty || b.empty) return a.empty === b.empty ? a.index - b.index : a.empty ? 1 : -1;
      return sign * compareCells(a.value, b.value) || a.index - b.index;
    })
    .map((entry) => entry.row);
}
