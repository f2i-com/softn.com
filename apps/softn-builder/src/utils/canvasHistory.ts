/**
 * Undo and redo of the canvas, in one place.
 *
 * The toolbar's buttons and the canvas's own key handler each stepped the
 * history and put the snapshot back with `loadState`, which is what opening
 * a file calls: it also emptied the clipboard and forgot the page's
 * imports, so something copied could not be pasted after an undo, and a
 * component imported from another page was drawn as an unknown one. And the
 * keys were heard only while the canvas held the focus: after picking an
 * element in the hierarchy, or adding one from the palette, Ctrl+Z did
 * nothing at all. What is here steps the history and puts back the elements
 * alone, for whoever asks.
 */

import { useCanvasStore } from '../stores/canvasStore';
import { useHistoryStore } from '../stores/historyStore';

function current() {
  const canvas = useCanvasStore.getState();
  return { elements: canvas.elements, rootId: canvas.rootId, timestamp: Date.now() };
}

/** Step the canvas back. False when there is nothing to undo. */
export function undoCanvas(): boolean {
  const entry = useHistoryStore.getState().undo(current());
  if (!entry) return false;
  useCanvasStore.getState().restoreElements(entry.elements, entry.rootId);
  return true;
}

/** Step the canvas forward again. False when there is nothing to redo. */
export function redoCanvas(): boolean {
  const entry = useHistoryStore.getState().redo(current());
  if (!entry) return false;
  useCanvasStore.getState().restoreElements(entry.elements, entry.rootId);
  return true;
}

/**
 * Whether a key pressed with the focus in `target` is that element's own to
 * handle as text: a field being typed in, or the code editor, each of which
 * has an undo of its own. A checkbox, a list of choices and a button have
 * none.
 */
export function ownsTextKeys(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest('textarea, [contenteditable="true"], [role="textbox"]')) return true;
  if (target instanceof HTMLInputElement) {
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes(target.type);
  }
  return false;
}
