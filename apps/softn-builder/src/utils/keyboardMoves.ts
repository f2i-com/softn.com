/**
 * Where a new element goes when it is not dragged, and how the selected
 * element is moved from the keyboard.
 *
 * Enter on a palette item, a double-click there, and Ctrl+V each put what
 * they made at the end of the page, whatever was selected; and nothing but
 * a drag moved an element. A page of any depth could not be made without
 * a mouse, and with one every new element was a drag back from the bottom.
 *
 * Both go through the rules a drop obeys (utils/blocks.ts: `canDropInto`,
 * `takesInline`, `branchEnd`) and the store's own handling of words, so
 * what the keyboard can do is exactly what a drag can.
 */

import { useCanvasStore } from '../stores/canvasStore';
import { useHistoryStore } from '../stores/historyStore';
import type { CanvasElement, DropIndicator } from '../types/builder';
import { acceptsChildren, branchEnd, canDropInto, elementLabel, isContinuationType, isTextNode, takesInline } from './blocks';

type Elements = Map<string, CanvasElement>;

/** What an element is called when it is spoken of: its type, or "the words". */
function nameOf(element: CanvasElement): string {
  return isTextNode(element) ? `the words ${elementLabel(element)}` : element.componentType;
}

/** What holds `element` for the purpose of standing beside it: its parent, or for a branch of a block the block itself. */
function standsIn(element: CanvasElement, elements: Elements): CanvasElement | undefined {
  return element.parentId ? elements.get(element.parentId) : undefined;
}

/**
 * Where something of these types goes with the canvas as it is: into the
 * selected element when it takes it (beside its words, when its content is
 * words), otherwise after it in the nearest thing around it that takes it,
 * and at the end of the page when nothing is selected. Null when nothing on
 * the way out takes it.
 *
 * Several types are several things going in together (a paste of more than
 * one element): the place is one that takes them all. Placed by the first
 * alone, a Badge copied with a Card went into a Heading's words and the
 * Card was pasted nowhere.
 *
 * With `beside`, never into the selection itself: what was just pasted is
 * selected, and pasting again is another beside it, not one inside it.
 * With `besideWords`, into the selection when it is a container and never
 * among its words: see `insertFromPalette`.
 */
export function placeBySelection(types: string | readonly string[], options: { beside?: boolean; besideWords?: boolean } = {}): DropIndicator | null {
  const { elements, rootId, selectedIds } = useCanvasStore.getState();
  const context = { elements };
  const all = typeof types === 'string' ? [types] : types;
  const page = elements.get(rootId);
  if (!page || all.length === 0) return null;
  const takesAll = (target: CanvasElement) => all.every((type) => canDropInto(target, type, context));
  const selected = selectedIds.length > 0 ? elements.get(selectedIds[selectedIds.length - 1]) : undefined;

  if (selected && selected.id !== rootId) {
    if (!options.beside) {
      if (acceptsChildren(selected) && takesAll(selected)) {
        return { parentId: selected.id, index: branchEnd(selected, elements) };
      }
      if (!options.besideWords && all.every((type) => takesInline(selected, type))) return { parentId: selected.id, index: 0, side: 'end' };
    }

    // After it; and where what holds it does not take this, after that.
    let beside: CanvasElement | undefined = selected;
    while (beside && beside.id !== rootId) {
      // A branch of a block is left by standing after the whole block.
      while (beside && isContinuationType(beside.componentType)) beside = standsIn(beside, elements);
      const holder: CanvasElement | undefined = beside ? standsIn(beside, elements) : undefined;
      if (!beside || !holder) break;
      if (takesAll(holder)) {
        const at = holder.children.indexOf(beside.id);
        return { parentId: holder.id, index: Math.min(at + 1, branchEnd(holder, elements)) };
      }
      beside = holder;
    }
  }

  return takesAll(page) ? { parentId: rootId, index: branchEnd(page, elements) } : null;
}

/** What the last paste put on the canvas, while it is still what is selected. */
let pastedLast: string[] = [];

/** Paste what was copied where the selection is, as one step. False when there is nothing to paste or nowhere for it. */
export function pasteBySelection(): boolean {
  const canvas = useCanvasStore.getState();
  if (canvas.clipboard.length === 0) return false;
  const types = canvas.clipboard.map((element) => element.componentType);
  // Pasted again with the last paste still selected: another beside it.
  const again = pastedLast.length > 0 && pastedLast.length === canvas.selectedIds.length && pastedLast.every((id) => canvas.selectedIds.includes(id));
  // A place for all of it; failing that, for the first of it, and the rest is said to have been left out.
  const place = placeBySelection(types, { beside: again }) ?? placeBySelection(types[0], { beside: again });
  if (!place) {
    canvas.announce(`Nothing here takes ${nameOf(canvas.clipboard[0])}.`);
    return false;
  }
  useHistoryStore.getState().push(canvas.elements, canvas.rootId);
  canvas.paste(place.parentId, place.index, place.side);
  const after = useCanvasStore.getState();
  if (after.elements === canvas.elements) {
    // Nothing was taken after all: the step recorded for it is taken back out.
    pastedLast = [];
    useHistoryStore.setState((state) => ({ past: state.past.slice(0, -1) }));
    canvas.announce(`Nothing here takes ${nameOf(canvas.clipboard[0])}.`);
    return false;
  }
  pastedLast = [...after.selectedIds];
  if (pastedLast.length < canvas.clipboard.length) {
    canvas.announce(`Pasted ${pastedLast.length} of ${canvas.clipboard.length}: the rest has no place there.`);
  }
  return true;
}

export type KeyboardMove = 'up' | 'down' | 'in' | 'out';

/** Where the element stands among what holds it, as it is said: "2 of 3 in Card". */
function standing(id: string, elements: Elements, rootId: string): string {
  const element = elements.get(id);
  const holder = element?.parentId ? elements.get(element.parentId) : undefined;
  if (!element || !holder) return '';
  const where = holder.id === rootId ? 'the page' : nameOf(holder);
  return `${holder.children.indexOf(id) + 1} of ${holder.children.length} in ${where}`;
}

/**
 * Move the one selected element a step: up or down among its siblings,
 * into the container just before it, or out of what holds it to just
 * after that. Returns what to say of it, having said it; the page is left
 * as it was, with no step recorded, when the move is not one a drop could
 * make.
 */
export function moveSelected(direction: KeyboardMove): string {
  const canvas = useCanvasStore.getState();
  const { elements, rootId, selectedIds } = canvas;
  const say = (text: string) => {
    canvas.announce(text);
    return text;
  };
  if (selectedIds.length !== 1) return say(selectedIds.length === 0 ? 'Pick an element to move it.' : 'Pick one element to move it.');
  const element = elements.get(selectedIds[0]);
  const holder = element?.parentId ? elements.get(element.parentId) : undefined;
  if (!element || !holder || element.id === rootId) return say('The page itself does not move.');
  if (isContinuationType(element.componentType)) return say(`${element.componentType} stays with its block.`);

  const name = nameOf(element);
  const context = { elements, draggedId: element.id };
  const at = holder.children.indexOf(element.id);
  let target: { parentId: string; index: number; side?: 'start' | 'end' } | null = null;
  let done = '';
  let refused = '';

  if (direction === 'up') {
    if (at > 0) target = { parentId: holder.id, index: at - 1 };
    else refused = `${name} is first in ${holder.id === rootId ? 'the page' : nameOf(holder)}.`;
    done = 'moved up';
  } else if (direction === 'down') {
    // Its own branch ends where the block's next branch begins.
    if (at + 1 < branchEnd(holder, elements)) target = { parentId: holder.id, index: at + 2 };
    else refused = `${name} is last in ${holder.id === rootId ? 'the page' : nameOf(holder)}.`;
    done = 'moved down';
  } else if (direction === 'in') {
    const before = at > 0 ? elements.get(holder.children[at - 1]) : undefined;
    if (!before) refused = `Nothing stands before ${name} to move it into.`;
    else if (acceptsChildren(before) && canDropInto(before, element.componentType, context)) {
      target = { parentId: before.id, index: branchEnd(before, elements) };
    } else if (takesInline(before, element.componentType)) {
      target = { parentId: before.id, index: 0, side: 'end' };
    } else refused = `${nameOf(before)} does not take ${name}.`;
    done = before ? `moved into ${nameOf(before)}` : '';
  } else {
    // Out of a branch of a block is out of the block.
    let around: CanvasElement = holder;
    while (isContinuationType(around.componentType)) {
      const head = standsIn(around, elements);
      if (!head) break;
      around = head;
    }
    const outer = standsIn(around, elements);
    if (around.id === rootId || !outer) refused = `${name} is on the page itself: there is nothing to move it out of.`;
    else if (!canDropInto(outer, element.componentType, context)) refused = `${nameOf(outer)} does not take ${name}.`;
    else target = { parentId: outer.id, index: outer.children.indexOf(around.id) + 1 };
    done = `moved out of ${nameOf(around)}`;
  }

  if (!target) return say(refused);

  const before = elements;
  useHistoryStore.getState().push(elements, rootId);
  canvas.moveElement(element.id, target.parentId, target.index, target.side);
  const after = useCanvasStore.getState();
  if (after.elements === before) {
    // Refused by the store: take the step back out, nothing happened.
    useHistoryStore.setState((state) => ({ past: state.past.slice(0, -1) }));
    return say(`${name} cannot go there.`);
  }
  // What it went into has just been named; where it stands there is enough.
  const where = standing(element.id, after.elements, after.rootId);
  return say(`${name} ${done}: ${direction === 'in' ? where.replace(/ in .*$/, '') : where}.`);
}
