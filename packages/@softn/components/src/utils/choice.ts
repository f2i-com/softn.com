/**
 * A look-up by a prop that names one of a fixed set: `size`, `variant`.
 *
 * `sizeStyles[size]` is undefined for a name that is not in the table, and
 * the next line read a property of it: `<Button variant="primay">` (a
 * mistyped name), or `variant={kind}` while `kind` is still null, threw in
 * the component's render and the page showed an error box where a button
 * belonged. A default parameter does not help with either: it stands in for
 * undefined, and neither of these is. A name that is not one of the table's
 * own is the default instead. Own names only, so `variant="constructor"` is
 * not an answer.
 */
export function choice<T>(table: Record<string, T>, name: unknown, fallback: string): T {
  return named(table, name) ?? table[fallback];
}

/** The table's own entry of that name, or nothing: for a prop with a value that means "none". */
export function named<T>(table: Record<string, T>, name: unknown): T | undefined {
  return typeof name === 'string' && Object.prototype.hasOwnProperty.call(table, name) ? table[name] : undefined;
}
