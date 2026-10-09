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
import { useFilesStore } from '../stores/filesStore';
import { useHistoryStore } from '../stores/historyStore';
import { toast } from '../stores/notificationStore';
import type { HistoryEntry, LogicSnapshot } from '../types/builder';

/**
 * Step into the state `target` holds, in either direction.
 *
 * A step is the canvas, and the logic files it also wrote (a function made
 * from the panel): those go back with it, so the step is undone whole and
 * redone whole. But only a file that still holds what the step left. One
 * that has been written in since is not this step's to put back: the body
 * typed into the function it made went with the function, on the second
 * Undo after it. Such a file is left as it is, and that is said.
 */
function step(target: HistoryEntry | undefined, move: (leaving: HistoryEntry) => HistoryEntry | null): boolean {
  if (!target) return false;
  const canvas = useCanvasStore.getState();
  const files = useFilesStore.getState();
  const back: LogicSnapshot[] = [];
  const leaving: LogicSnapshot[] = [];
  const movedOn: string[] = [];
  for (const snapshot of target.logic ?? []) {
    // A file deleted since is not brought back by a step that only edited it.
    const file = files.logicFiles.get(snapshot.id);
    if (!file) continue;
    if (snapshot.expects !== undefined && file.content !== snapshot.expects) {
      movedOn.push(file.path);
      continue;
    }
    back.push(snapshot);
    // The way back from here: this text, over the text about to be written.
    leaving.push({ id: snapshot.id, content: file.content, expects: snapshot.content });
  }

  const entry = move({
    elements: canvas.elements,
    rootId: canvas.rootId,
    timestamp: Date.now(),
    ...(leaving.length > 0 ? { logic: leaving } : {}),
  });
  if (!entry) return false;
  canvas.restoreElements(entry.elements, entry.rootId);
  for (const { id, content } of back) files.updateLogicFile(id, content);
  if (movedOn.length > 0) {
    toast.info(`${movedOn.join(', ')} has been written in since that step, and was left as it is.`);
  }
  return true;
}

/** Step the canvas back. False when there is nothing to undo. */
export function undoCanvas(): boolean {
  const history = useHistoryStore.getState();
  return step(history.past[history.past.length - 1], history.undo);
}

/** Step the canvas forward again. False when there is nothing to redo. */
export function redoCanvas(): boolean {
  const history = useHistoryStore.getState();
  return step(history.future[0], history.redo);
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
