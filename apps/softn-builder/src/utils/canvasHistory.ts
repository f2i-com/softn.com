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
import type { HistoryEntry, LogicSnapshot, RenameSnapshot } from '../types/builder';
import { followInElements, followInText, movedAssetPath, type AssetMove } from './assetReferences';
import { flushHeldPage, relocate } from './renameInProject';

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
function step(target: HistoryEntry | undefined, move: (leaving: HistoryEntry) => HistoryEntry | null, side: 'past' | 'future'): boolean {
  if (!target) return false;

  // A step that renamed a picture (utils/renameInProject.ts): the file is given the name it
  // had in the state being stepped into, and the store makes every reference follow it, as
  // it did the first time. The canvas goes into its file before that, so the page is
  // rewritten as it is now. `way` is the way back from here, for the other direction.
  let way: RenameSnapshot | undefined;
  // The rename could not be taken back (the file is gone, or its old name is another file's
  // now): the move the states beyond this step have to be read through, so they name the
  // file as it still is.
  let kept: AssetMove | null = null;
  const renamed = target.rename;
  if (renamed) {
    flushHeldPage();
    const node = useFilesStore.getState().nodes.get(renamed.id);
    const folder = node?.type === 'folder';
    try {
      if (!node || node.path !== renamed.expects) throw new Error('It is not where the step left it.');
      relocate(renamed.id, renamed.path);
      way = { id: renamed.id, path: renamed.expects, expects: renamed.path };
      toast.info(`${renamed.expects} is ${renamed.path} again.`);
    } catch {
      kept = { from: renamed.path, to: renamed.expects, folder };
      if (node) toast.info(`${node.path} keeps its name: it could not be given ${renamed.path} again.`);
    }
  }

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
    ...(way ? { rename: way } : {}),
  });
  if (!entry) return false;
  let elements = entry.elements;
  if (kept) {
    // This state, and every one beyond it on this side, as it reads with the file where it is.
    const through = kept;
    elements = followInElements(elements, through);
    useHistoryStore.getState().rewrite(side, (other) => entryFollowing(other, through));
  }
  canvas.restoreElements(elements, entry.rootId);
  // The store rewrote the page the canvas holds when the file was renamed back; the page
  // takes the canvas's own tree, so the canvas is not loaded again from its file.
  if (way && canvas.pageId !== null) files.syncUIFileElements(canvas.pageId, elements, entry.rootId);
  for (const { id, content } of back) files.updateLogicFile(id, content);
  if (movedOn.length > 0) {
    toast.info(`${movedOn.join(', ')} has been written in since that step, and was left as it is.`);
  }
  return true;
}

/** A state of the history read through a move its step could not take back: what it holds names the file where it is. */
function entryFollowing(entry: HistoryEntry, move: AssetMove): HistoryEntry {
  const elements = followInElements(entry.elements, move);
  const logic = entry.logic?.map((snapshot) => ({
    ...snapshot,
    content: followInText(snapshot.content, move),
    ...(snapshot.expects !== undefined ? { expects: followInText(snapshot.expects, move) } : {}),
  }));
  // An earlier rename of the same file expects it where this one would have put it back.
  const rename = entry.rename && { ...entry.rename, expects: movedPath(entry.rename.expects, move), path: movedPath(entry.rename.path, move) };
  return { ...entry, elements, ...(logic ? { logic } : {}), ...(rename ? { rename } : {}) };
}

/** A path through a move of a file, or of a folder and what is under it. */
function movedPath(path: string, move: AssetMove): string {
  if (path === move.from) return move.to;
  return move.folder ? movedAssetPath(path, move) : path;
}

/** Step the canvas back. False when there is nothing to undo. */
export function undoCanvas(): boolean {
  const history = useHistoryStore.getState();
  return step(history.past[history.past.length - 1], history.undo, 'past');
}

/** Step the canvas forward again. False when there is nothing to redo. */
export function redoCanvas(): boolean {
  const history = useHistoryStore.getState();
  return step(history.future[0], history.redo, 'future');
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
