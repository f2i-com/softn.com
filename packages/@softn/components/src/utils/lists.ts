/**
 * Props that hold several keys or names, read as a page can write them.
 *
 * A page cannot build a Set, so a prop typed as one is given the list a page
 * writes (`selectedKeys={[1, 2]}`), and `.has` on it threw. A prop typed as a
 * list is given one name as text (`hideColumns="email"`), and `.includes` on
 * text matched any part of it: `"nameLong"` hid `name` and `e` too; a number
 * there threw.
 */

/** Keys as a Set, from a Set, a list or one key; undefined for none. */
export function keySet<K>(value: unknown): Set<K> | undefined {
  if (value === undefined || value === null) return undefined;
  if (value instanceof Set) return value as Set<K>;
  if (Array.isArray(value)) return new Set(value as K[]);
  return new Set([value as K]);
}

/**
 * Names as a list, from a list, or from text written as one name or several
 * separated by commas (`fields="name, email"`); empty for anything else.
 */
export function nameList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((name) => name !== null && name !== undefined).map(String);
  if (typeof value === 'string') return value.split(',').map((name) => name.trim()).filter(Boolean);
  if (typeof value === 'number') return [String(value)];
  return [];
}
