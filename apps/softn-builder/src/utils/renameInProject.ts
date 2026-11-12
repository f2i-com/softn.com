/**
 * Renaming a file or a folder from the Files panel, with the canvas and the
 * history kept in step.
 *
 * The file store makes every reference follow a rename: a page's imports,
 * its logic, and, for a picture or other asset, each `asset("…")` in the
 * pages and the logic (utils/assetReferences.ts). Two things are outside the
 * store and are seen to here.
 *
 * The canvas is ahead of the file it shows, so it is written into its file
 * first: the store then rewrites the page as it is now, and an edit not yet
 * flushed is not lost under the rewrite. And the page the canvas holds is
 * given its tree back as the store left it, the same tree and not a copy,
 * so the canvas is not loaded again from its file, which would drop the
 * selection and whatever was copied.
 *
 * The rename of an asset is one step of the history. The steps before it
 * hold the canvas as it was, asking for the old name: Undo past a rename
 * that was not itself a step would bring those back over a file that no
 * longer has that name. Stepping back over it gives the file its old name
 * again, and every reference with it (utils/canvasHistory.ts).
 */

import { useCanvasStore } from '../stores/canvasStore';
import { useFilesStore } from '../stores/filesStore';
import { useHistoryStore } from '../stores/historyStore';
import { followAssetMove } from './assetReferences';
import { flushCanvasToActiveFile } from './buildProjectBundle';
import type { ProjectFileNode } from '../types/builder';

export interface RenameOutcome {
  /** Where it was, and where it is now. The same when nothing was renamed. */
  from: string;
  to: string;
  /** The pages and logic files, by the path each has now, whose references followed an asset. */
  followed: string[];
}

/**
 * The page on the canvas, put into its file, so that the pages are read and
 * rewritten as they are now. Not a canvas that has not said whose page it
 * holds, which is flushed nowhere (hooks/useActiveFileOnCanvas.ts); and a
 * flush that fails leaves the files as they were last flushed.
 */
export function flushHeldPage(): void {
  if (useCanvasStore.getState().pageId === null) return;
  try {
    flushCanvasToActiveFile();
  } catch {
    // The files as they were last flushed are what is renamed in.
  }
}

/** Whether renaming this node moves a picture or other asset: it is one, or a folder with one in it. */
export function movesAnAsset(nodes: ReadonlyMap<string, ProjectFileNode>, node: ProjectFileNode): boolean {
  if (node.type === 'file') return node.fileType === 'asset';
  for (const other of nodes.values()) {
    if (other.type === 'file' && other.fileType === 'asset' && other.path.startsWith(`${node.path}/`)) return true;
  }
  return false;
}

/**
 * Put a file at `path`, or give a folder the name `path` ends in (a folder
 * is renamed where it is). Throws, changing nothing, as the store's own
 * rename does: the name is taken, or is one a bundle cannot hold.
 */
export function relocate(id: string, path: string): void {
  const files = useFilesStore.getState();
  const node = files.nodes.get(id);
  if (!node) throw new Error('That file is no longer in the project.');
  const cut = path.lastIndexOf('/');
  const name = path.slice(cut + 1);
  if (node.type === 'folder') files.renameFolder(id, name);
  else files.moveFile(id, cut < 0 ? '' : path.slice(0, cut), name);
}

/**
 * After the store has rewritten the page the canvas holds: the canvas takes
 * that tree, the very one the file has, so nothing reloads it.
 */
export function canvasTakesHeldPage(): void {
  const canvas = useCanvasStore.getState();
  if (canvas.pageId === null) return;
  const page = useFilesStore.getState().uiFiles.get(canvas.pageId);
  if (page && page.elements !== canvas.elements) canvas.restoreElements(page.elements, page.rootId);
}

/**
 * Rename the file or folder `id` to `newName`. Throws, with nothing changed,
 * when the store refuses the name. For a picture or other asset, or a folder
 * with one in it, the rename and the references that follow it are one step
 * of the history.
 */
export function renameInProject(id: string, newName: string): RenameOutcome {
  const node = useFilesStore.getState().nodes.get(id);
  if (!node) return { from: '', to: '', followed: [] };
  const asset = movesAnAsset(useFilesStore.getState().nodes, node);
  if (asset) flushHeldPage();

  const before = useFilesStore.getState();
  const canvas = useCanvasStore.getState();
  const held = { elements: canvas.elements, rootId: canvas.rootId };

  if (node.type === 'folder') before.renameFolder(id, newName);
  else before.renameFile(id, newName);

  const after = useFilesStore.getState();
  const to = after.nodes.get(id)?.path ?? node.path;
  if (!asset || to === node.path) return { from: node.path, to, followed: [] };

  // The pages and logic files that named it, as the store's own rewrite finds them, each by
  // the path it has now (a page inside a renamed folder has moved with it).
  const named = followAssetMove(before.uiFiles, before.logicFiles, { from: node.path, to, folder: node.type === 'folder' }).changed;
  const followed = named.map((fileId) => after.nodes.get(fileId)?.path).filter((path): path is string => path !== undefined);

  // The step: the canvas as it was, and the way back to the old name.
  useHistoryStore.getState().push(held.elements, held.rootId, undefined, undefined, { id, path: node.path, expects: to });
  canvasTakesHeldPage();
  return { from: node.path, to, followed: followed.sort() };
}
