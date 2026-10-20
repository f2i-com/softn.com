/**
 * The ids the Builder gives what it holds: elements, files, collections and
 * fields. None is written into a file; each only has to differ from every
 * other while the page is open. Each store had a function of its own for it.
 */

let counted = 0;

/** `prefix`, the time, and something random: two made in one millisecond differ. */
export function randomId(prefix = ''): string {
  return `${prefix}${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * `prefix`, the time, and a count that goes on for as long as the page is
 * open: what a page read or a bundle opened gives its elements and files, so
 * that the pages of a bundle read in one millisecond have no id in common.
 */
export function countedId(prefix: string): string {
  return `${prefix}${Date.now()}_${counted++}`;
}
