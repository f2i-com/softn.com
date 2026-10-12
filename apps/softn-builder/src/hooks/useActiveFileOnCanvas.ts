/**
 * The file that is open, put onto the canvas.
 *
 * The canvas is ahead of the file it shows: an edit is in the canvas at
 * once and reaches the file when the canvas is flushed (a save, an export,
 * a change of view or of tab). So the canvas must be loaded from the file
 * when the file is opened and when the file's own tree is replaced under
 * it, and at no other time.
 *
 * It used to be loaded whenever the map of files changed at all. Renaming a
 * logic file makes a new map; so does deleting an asset, or moving another
 * page. Each of those put the file's last flushed tree back over the canvas
 * and the edits made since were gone, with nothing to undo to. A flush made
 * a new map too, and reloading after it cleared the selection: saving
 * deselected whatever was being worked on.
 *
 * The page the canvas holds is not always the file that is open. With a
 * logic file or an asset open in the middle, the Hierarchy, the Properties
 * and the palette still hold the last page, and an edit made there is an
 * edit of that page: the canvas says which page it holds
 * (canvasStore, pageId), it is flushed into that page, and it stays on the
 * canvas until another page is opened.
 *
 * Every effect here reads the stores as they are when it runs, and not
 * what it was drawn with. A session restored as the page starts replaces
 * the workspace in an effect that runs before these: they went on with the
 * empty project of a moment before, put its page on the canvas, and
 * flushed that into the restored `main.ui`, which has the same id in every
 * project made here. The first page of a restored project came back empty
 * whenever another file had been left open.
 */

import { useEffect, useRef } from 'react';
import { useCanvasStore } from '../stores/canvasStore';
import { useFilesStore } from '../stores/filesStore';
import { useHistoryStore } from '../stores/historyStore';
import { useProjectStore } from '../stores/projectStore';
import { flushCanvasToActiveFile } from '../utils/buildProjectBundle';
import { debug } from '../utils/debug';
import type { UIFileState } from '../types/builder';

/** The page that belongs on the canvas: the file that is open, or the page the canvas held before a file that is no page was opened. */
function pageFor(files: Pick<ReturnType<typeof useFilesStore.getState>, 'activeFileId' | 'uiFiles'>, heldId: string | null): UIFileState | undefined {
  const open = files.activeFileId ? files.uiFiles.get(files.activeFileId) : undefined;
  return open ?? (heldId ? files.uiFiles.get(heldId) : undefined);
}

export function useActiveFileOnCanvas(): void {
  const activeFileId = useFilesStore((state) => state.activeFileId);
  const heldId = useCanvasStore((state) => state.pageId);
  const page = useFilesStore((state) => pageFor(state, heldId));

  const pageId = page?.id;
  const elements = page?.elements;
  const rootId = page?.rootId;
  const imports = page?.imports;
  // A refused edit leaves the file's tree as it was and says why; the canvas,
  // which made the edit, has to be put back to what the file holds.
  const refused = page?.visualEditBlocked;

  /** The file that was open when the effect below last ran; undefined before it has. */
  const left = useRef<string | null | undefined>(undefined);

  // Another file is opened: the page the canvas holds goes into its file
  // first, so preview and reopen stay in sync.
  useEffect(() => {
    const fileId = useFilesStore.getState().activeFileId;
    const before = left.current;
    left.current = fileId;
    if (before === undefined || before === fileId) return;
    // The page the canvas holds, which is not the file left when that was a
    // logic file. It was the file left that was written, with whatever the
    // canvas held: once that was another project's page. A canvas that
    // holds a page nobody has named is flushed nowhere: the file now open
    // is not the one it holds.
    if (useCanvasStore.getState().pageId !== null) flushCanvasToActiveFile();
    // The history is a stack of canvas snapshots with no idea which file each
    // came from, and undo loads one unconditionally. Left in place across a
    // switch, one Ctrl+Z would drop the previous file's element tree into the
    // file now open — and the flush above would then write it there.
    useHistoryStore.getState().clear();
  }, [activeFileId]);

  // After the flush above, so a file is left with what the canvas held
  // before the next one is put on it. Not when a file that is no page is
  // opened or left: the page on the canvas is the same one then.
  useEffect(() => {
    const canvas = useCanvasStore.getState();
    const opened = pageFor(useFilesStore.getState(), canvas.pageId);
    if (!opened || opened.elements.size === 0 || !opened.rootId) return;
    // The canvas already holds this tree: it was opened with it, or flushed into it.
    if (canvas.elements === opened.elements) {
      canvas.holdPage(opened.id);
      return;
    }
    debug('[canvas] loading file', opened.id, { elements: opened.elements.size, rootId: opened.rootId });
    canvas.loadState(opened.elements, opened.rootId, opened.imports ?? [], opened.writtenImports ?? [], opened.id);
    // The page left was flushed while the canvas still held it, and the
    // page opened was judged by it then (utils/savedPoint.ts): judged again
    // now that the canvas holds it.
    useProjectStore.getState().settle();
  }, [pageId, elements, rootId, refused]);

  // What the file imports can change without its tree changing (a component
  // it uses was renamed), and is not a reason to reload the tree.
  useEffect(() => {
    const canvas = useCanvasStore.getState();
    const opened = pageFor(useFilesStore.getState(), canvas.pageId);
    if (opened?.imports && canvas.pageId === opened.id) canvas.setImports(opened.imports);
  }, [pageId, imports]);
}
