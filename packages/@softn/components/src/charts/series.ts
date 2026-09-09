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
