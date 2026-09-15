/**
 * The `@event` key a component's `onX` callback is written as in `.ui`.
 *
 * A component declares `onRemove`; the file says `@remove={drop(item)}`; the
 * runtime turns `@remove` back into the `onRemove` prop (`on` + capitalised
 * key, with a table of DOM names whose React spelling differs, see core's
 * renderer). The panel used to write these callbacks as ordinary string
 * props (`onRemove="drop(item)"`), which reached the component as a string
 * and did nothing. Every registry prop of type `event` now goes through the
 * element's event map under this key, and a file that still carries the
 * string form is migrated on open (propMigrations).
 *
 * `onPageChange` → `pageChange` and `onKeyDown` → `keyDown`: the key keeps
 * its inner capitals, which is what the runtime's reverse mapping expects
 * (`@keyDown` resolves to `onKeyDown`; a lowercase `keydown` would only work
 * through the DOM-name table).
 */
export function eventKeyFor(propName: string): string {
  const match = /^on([A-Z][A-Za-z0-9]*)$/.exec(propName);
  if (!match) return propName;
  return match[1][0].toLowerCase() + match[1].slice(1);
}
