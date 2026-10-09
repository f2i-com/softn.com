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
 */

import { useEffect } from 'react';
import { useCanvasStore } from '../stores/canvasStore';
import { useFilesStore } from '../stores/filesStore';
import { debug } from '../utils/debug';

export function useActiveFileOnCanvas(): void {
  const activeFileId = useFilesStore((state) => state.activeFileId);
  const file = useFilesStore((state) => (state.activeFileId ? state.uiFiles.get(state.activeFileId) : undefined));
  const loadCanvasState = useCanvasStore((state) => state.loadState);
  const setImports = useCanvasStore((state) => state.setImports);

  const elements = file?.elements;
  const rootId = file?.rootId;
  const imports = file?.imports;
  // A refused edit leaves the file's tree as it was and says why; the canvas,
  // which made the edit, has to be put back to what the file holds.
  const refused = file?.visualEditBlocked;

  useEffect(() => {
    if (!activeFileId || !elements || elements.size === 0 || !rootId) return;
    // The canvas already holds this tree: it was flushed from it.
    if (useCanvasStore.getState().elements === elements) return;
    debug('[canvas] loading file', activeFileId, { elements: elements.size, rootId });
    loadCanvasState(elements, rootId, useFilesStore.getState().uiFiles.get(activeFileId)?.imports ?? []);
  }, [activeFileId, elements, rootId, refused, loadCanvasState]);

  // What the file imports can change without its tree changing (a component
  // it uses was renamed), and is not a reason to reload the tree.
  useEffect(() => {
    if (activeFileId && imports) setImports(imports);
  }, [activeFileId, imports, setImports]);
}
