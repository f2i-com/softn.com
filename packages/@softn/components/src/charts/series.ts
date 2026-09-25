/**
 * A chart's data as it may plot it.
 *
 * A chart is routinely bound to data that has not arrived — `series={stats}`
 * while `stats` is still undefined, or a record whose `data` field is not the
 * array the chart expects — and `.flatMap` of undefined threw into the error
 * boundary, so the page showed an error panel where an empty chart should
 * have been, for the second the fetch took. Nothing to plot is an empty
 * chart, not a crash; every chart normalises its props through here first.
 */

/** The array, or nothing: never `undefined`, never a value of another shape. */
export function normaliseArray<T>(value: T[] | undefined | null): T[] {
  return Array.isArray(value) ? value : [];
}

/** Every series present and an object, each with a `data` array of its own. */
export function normaliseSeries<S extends { data: unknown[] }>(series: S[] | undefined | null): S[] {
  return normaliseArray(series)
    .filter((s): s is S => s !== null && typeof s === 'object')
    .map((s) => (Array.isArray(s.data) ? s : { ...s, data: [] as unknown as S['data'] }));
}

/**
 * A plotted number, or null when there is none to plot.
 *
 * Chart data arrives from JSON and bindings: `"42"` where a number was meant,
 * `undefined` for a missing reading. Left as they were, a string was added
 * into a stacked total by concatenation and an `undefined` became a NaN in an
 * SVG attribute, which React warns about and the browser drops. Numeric
 * strings are numbers; anything else that is not finite is not a value.
 */
export function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Each series' points as objects whose `key` field is a finite number; points
 * with no value are left out rather than drawn at NaN.
 */
export function numericPoints<P extends object, K extends keyof P>(data: P[], key: K): P[] {
  const out: P[] = [];
  for (const point of data) {
    if (point === null || typeof point !== 'object') continue;
    const n = finiteNumber(point[key]);
    if (n !== null) out.push({ ...point, [key]: n });
  }
  return out;
}

/** Where each point of a line or area chart sits along the x axis. */
export interface XLayout {
  /** The x position (in domain units) of point `index` of series `seriesIndex`. */
  position: (seriesIndex: number, index: number) => number;
  min: number;
  max: number;
  /** The distinct x values in order, with their positions, for axis labels. */
  ticks: Array<{ value: number | string; position: number }>;
}

/**
 * The x layout for series of `{ x }` points.
 *
 * When every x is a number the axis is numeric. Otherwise the x values are
 * categories, placed by their order of first appearance across all series —
 * not by a point's index in the flattened list of every series, which put two
 * five-point series on a ten-slot axis and squeezed both lines into its left
 * half. A point with no x takes its index as its category.
 */
export function layoutX(series: Array<{ data: Array<{ x?: unknown }> }>): XLayout {
  const numeric = series.every((s) => s.data.every((p) => typeof p.x === 'number' && Number.isFinite(p.x)));
  if (numeric) {
    const values = series.flatMap((s) => s.data.map((p) => p.x as number));
    const ticks: XLayout['ticks'] = [];
    const seen = new Set<number>();
    for (const v of values) {
      if (!seen.has(v)) {
        seen.add(v);
        ticks.push({ value: v, position: v });
      }
    }
    return {
      position: (si, i) => (series[si]?.data[i]?.x as number | undefined) ?? i,
      min: values.length ? Math.min(...values) : 0,
      max: values.length ? Math.max(...values) : 1,
      ticks,
    };
  }
  const categories = new Map<unknown, number>();
  const ticks: XLayout['ticks'] = [];
  const positions = series.map((s) =>
    s.data.map((p, i) => {
      const key = p.x === undefined || p.x === null ? `\u0000${i}` : p.x;
      let at = categories.get(key);
      if (at === undefined) {
        at = categories.size;
        categories.set(key, at);
        ticks.push({ value: typeof p.x === 'number' || typeof p.x === 'string' ? p.x : i, position: at });
      }
      return at;
    })
  );
  return {
    position: (si, i) => positions[si]?.[i] ?? i,
    min: 0,
    max: Math.max(1, categories.size - 1),
    ticks,
  };
}

/** At most this many values are read out in a chart's generated description. */
const SUMMARY_LIMIT = 24;

/**
 * A text alternative for a chart: what it is and the values it draws, e.g.
 * "Bar chart. Revenue: Q1 100, Q2 -40." The SVG is `role="img"`, so this is
 * the whole of what a screen reader hears; an author's `ariaLabel` replaces
 * it.
 */
export function describeChart(
  kind: string,
  groups: Array<{ name?: string; values: string[] }>
): string {
  let remaining = SUMMARY_LIMIT;
  let omitted = 0;
  const parts: string[] = [];
  for (const group of groups) {
    const shown = group.values.slice(0, Math.max(0, remaining));
    omitted += group.values.length - shown.length;
    remaining -= shown.length;
    if (shown.length === 0 && group.values.length > 0) continue;
    const body = shown.length ? shown.join(', ') : 'no data';
    parts.push(group.name ? `${group.name}: ${body}` : body);
  }
  if (parts.length === 0) return `${kind}, no data.`;
  const more = omitted > 0 ? ` And ${omitted} more.` : '';
  return `${kind}. ${parts.join('; ')}.${more}`;
}
