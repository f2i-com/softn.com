/**
 * The rows a list component draws.
 *
 * A list from a store or an API has holes: a record that was deleted is
 * null in it, and `rows[i].id` of null threw in the component's render, so
 * one missing record took the whole table to the page's error box. The same
 * for a list that is not one yet (`data={items}` while `items` is null).
 */

/** The list without its holes; what is not a list is an empty one. */
export function presentRows<T>(data: unknown): T[] {
  if (!Array.isArray(data)) return [];
  return data.some((row) => row === null || row === undefined) ? data.filter((row) => row !== null && row !== undefined) : data;
}

/**
 * The entries that are records, for a component that reads fields by name.
 * `"name" in "Ann"` throws, so a list of plain strings or numbers has no
 * rows such a component can draw.
 */
export function recordRows<T>(data: unknown): T[] {
  if (!Array.isArray(data)) return [];
  return data.some((row) => row === null || typeof row !== 'object') ? data.filter((row) => row !== null && typeof row === 'object') : data;
}

/**
 * A comma-separated list a prop holds as text (`badges="status, team"`), as
 * its entries. A number is its digits; what is not text is no entries, where
 * `.split` of it threw.
 */
export function commaList(given: unknown): string[] {
  return commaSlots(given).filter((entry) => entry !== '');
}

/**
 * The same list with its empty places kept, for one that is matched to
 * another by position: in `icons="users,,cart"` the second stat has no icon
 * and the third has the cart.
 */
export function commaSlots(given: unknown): string[] {
  const text = typeof given === 'string' ? given : typeof given === 'number' ? String(given) : '';
  return text === '' ? [] : text.split(',').map((entry) => entry.trim());
}
