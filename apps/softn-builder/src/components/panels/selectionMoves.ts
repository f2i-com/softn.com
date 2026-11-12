/**
 * What the property panel's buttons do to the selection: move it up or down
 * among its siblings, duplicate it, delete it.
 *
 * Each of these was a key and nothing else (Alt+Shift with an arrow, Ctrl+D,
 * Delete), so on a phone, where the panel is a sheet and there is no
 * keyboard, an element could not be moved, copied or removed at all. The
 * buttons make the calls the keys make, with the step for Undo recorded the
 * same way: the moves are utils/keyboardMoves.ts itself, and the other two
 * are what the canvas does on its keys (components/canvas/Canvas.tsx).
 */

import { useCanvasStore } from '../../stores/canvasStore';
import { useHistoryStore } from '../../stores/historyStore';
import type { CanvasElement } from '../../types/builder';
import { branchEnd, canDropInto, elementLabel, isContinuationType, isTextNode } from '../../utils/blocks';
import { focusCandidatesAfterDelete, focusFirstDrawn } from '../../utils/focusAfterDelete';

type Elements = Map<string, CanvasElement>;

/** Which of the four the selection as it stands can take. */
export interface SelectionMoves {
  up: boolean;
  down: boolean;
  duplicate: boolean;
  remove: boolean;
}

/** What an element is called when it is spoken of: its type, or "the words". */
function nameOf(element: CanvasElement): string {
  return isTextNode(element) ? `the words ${elementLabel(element)}` : element.componentType;
}

/** Whether a copy of `element` has a place beside it: what the store asks before it makes one. */
function takesCopy(element: CanvasElement, elements: Elements): boolean {
  const holder = element.parentId ? elements.get(element.parentId) : undefined;
  return !holder || canDropInto(holder, element.componentType, { elements });
}

/**
 * What can be done to the selection. The moves are for one element, by the
 * rules `moveSelected` goes by: not the page, not a branch of a block, and
 * not past the first or last place of what holds it. Duplicate and delete
 * act on every selected element but the page.
 */
export function selectionMoves(elements: Elements, rootId: string, selectedIds: readonly string[]): SelectionMoves {
  const picked = selectedIds
    .filter((id) => id !== rootId)
    .map((id) => elements.get(id))
    .filter((element): element is CanvasElement => element !== undefined);
  const moves: SelectionMoves = {
    up: false,
    down: false,
    duplicate: picked.some((element) => takesCopy(element, elements)),
    remove: picked.length > 0,
  };
  if (selectedIds.length !== 1 || picked.length !== 1) return moves;
  const [element] = picked;
  const holder = element.parentId ? elements.get(element.parentId) : undefined;
  if (!holder || isContinuationType(element.componentType)) return moves;
  const at = holder.children.indexOf(element.id);
  moves.up = at > 0;
  moves.down = at !== -1 && at + 1 < branchEnd(holder, elements);
  return moves;
}

/** How the selection is named in what is said of it. */
function said(picked: CanvasElement[]): string {
  return picked.length === 1 ? nameOf(picked[0]) : `${picked.length} elements`;
}

/** The selected elements that are not the page. */
function pickedNow(): CanvasElement[] {
  const { elements, rootId, selectedIds } = useCanvasStore.getState();
  return selectedIds
    .filter((id) => id !== rootId)
    .map((id) => elements.get(id))
    .filter((element): element is CanvasElement => element !== undefined);
}

/**
 * Duplicate what is selected, each copy after its original, as one step for
 * Undo: Ctrl+D on the canvas. False, with the reason said and no step
 * recorded, when nothing selected can be copied where it stands.
 */
export function duplicateSelection(): boolean {
  const canvas = useCanvasStore.getState();
  const picked = pickedNow();
  if (picked.length === 0) {
    canvas.announce(canvas.selectedIds.length > 0 ? 'The page itself is not duplicated.' : 'Pick an element to duplicate it.');
    return false;
  }
  // Asked before the step is recorded: a step that changed nothing would
  // still be one for Undo, and would empty what Redo had.
  if (!picked.some((element) => takesCopy(element, canvas.elements))) {
    canvas.announce(`There is no room for another ${said(picked)} here.`);
    return false;
  }
  useHistoryStore.getState().push(canvas.elements, canvas.rootId);
  // Each in turn, as the key does: the store leaves out one that has no room.
  for (const element of picked) useCanvasStore.getState().duplicateElement(element.id);
  canvas.announce(picked.length === 1 ? `Duplicated ${said(picked)}. The copy is selected.` : `Duplicated ${said(picked)}.`);
  return true;
}

/**
 * Delete what is selected, as one step for Undo: Delete on the canvas. The
 * focus goes to what stood beside it on the canvas, where the canvas can
 * take it. False, with no step recorded, when only the page is selected.
 */
export function deleteSelection(): boolean {
  const canvas = useCanvasStore.getState();
  const picked = pickedNow();
  if (picked.length === 0) {
    canvas.announce(canvas.selectedIds.length > 0 ? 'The page itself is not deleted.' : 'Pick an element to delete it.');
    return false;
  }
  const ids = picked.map((element) => element.id);
  useHistoryStore.getState().push(canvas.elements, canvas.rootId);
  const candidates = focusCandidatesAfterDelete(canvas.elements, ids);
  for (const id of ids) useCanvasStore.getState().deleteElement(id);
  canvas.announce(`Deleted ${said(picked)}.`);
  if (typeof document !== 'undefined') {
    focusFirstDrawn(candidates, (id) => document.querySelector<HTMLElement>(`[data-canvas-element-id="${id}"]`));
  }
  return true;
}
