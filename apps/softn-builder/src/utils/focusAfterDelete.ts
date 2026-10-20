/**
 * Where the focus goes when elements are deleted on the canvas or in the
 * Hierarchy. The element that had it is gone, and the focus went with it to
 * the document's body: the next arrow or Delete was heard by nothing, and a
 * screen reader was left nowhere. It goes to what was beside it instead: the
 * next sibling, else the one before it, else the parent.
 */

import type { CanvasElement } from '../types/builder';

/**
 * Where the focus may go once `deleted` are gone, best first: the siblings
 * after the first of them, then those before it, nearest first, then its
 * parent and the parent's parents. An element that is deleted too is passed
 * over, and so is one the panel does not draw (words beside elements are not
 * a row of their own), which is why there is more than one.
 */
export function focusCandidatesAfterDelete(elements: ReadonlyMap<string, CanvasElement>, deleted: readonly string[]): string[] {
  const gone = new Set(deleted);
  for (const id of deleted) {
    let element = elements.get(id);
    // From inside a deleted element, it is the outermost one deleted that counts.
    while (element?.parentId && gone.has(element.parentId)) element = elements.get(element.parentId);
    if (!element?.parentId) continue;
    const parent = elements.get(element.parentId);
    if (!parent) continue;
    const at = parent.children.indexOf(element.id);
    const after = parent.children.slice(at + 1).filter((child) => !gone.has(child));
    const before = parent.children.slice(0, Math.max(at, 0)).reverse().filter((child) => !gone.has(child));
    const ancestors: string[] = [];
    for (let up: CanvasElement | undefined = parent; up; up = up.parentId ? elements.get(up.parentId) : undefined) ancestors.push(up.id);
    return [...after, ...before, ...ancestors];
  }
  return [];
}

/**
 * After the next frame, when the deletion has been drawn, focus the first of
 * `candidates` that `find` finds drawn. Nothing is done when the focus has
 * already gone somewhere of the person's choosing.
 */
export function focusFirstDrawn(candidates: readonly string[], find: (id: string) => HTMLElement | null): void {
  if (candidates.length === 0) return;
  requestAnimationFrame(() => {
    const now = document.activeElement;
    if (now instanceof HTMLElement && now !== document.body && now.isConnected) return;
    for (const id of candidates) {
      const target = find(id);
      if (target) {
        target.focus();
        return;
      }
    }
  });
}
