/**
 * What a drag from the palette comes to when it is let go on the page being
 * edited.
 *
 * A component is its own name. A page of the project is a file: the name it
 * is used by is the one this page already gives it, or its file's, and is
 * refused where the page cannot use it (utils/pageImports.ts). That is
 * known only for the page it lands on, so it is worked out here, at the
 * drop, by everything that puts a dragged thing on the canvas.
 */

import { useCanvasStore } from '../stores/canvasStore';
import { useFilesStore } from '../stores/filesStore';
import { draggedPageId, importableFor } from './pageImports';

/** What to add for a dragged type, or why nothing is. */
export type Dropped =
  | { type: string; page?: { source: string; existing: boolean } }
  | { refused: string };

export function droppedType(type: string): Dropped {
  const fileId = draggedPageId(type);
  if (fileId === null) return { type };
  const files = useFilesStore.getState();
  const pageId = files.activeFileId;
  const found = pageId
    ? importableFor(pageId, files.uiFiles, useCanvasStore.getState().imports).find((entry) => entry.file.id === fileId)
    : undefined;
  if (!found) return { refused: 'That page is not in the project any more.' };
  if (found.refused) return { refused: found.refused };
  return { type: found.name, page: { source: found.source, existing: found.existing } };
}

/**
 * Add what was dragged at the place given, or say why not and add nothing.
 * `before` runs once it is known that something will be added: the caller's
 * step for Undo, which a refusal must not leave behind.
 */
export function addDropped(
  dragged: string,
  parentId: string,
  index: number | undefined,
  side: 'start' | 'end' | undefined,
  before: () => void
): string | null {
  const what = droppedType(dragged);
  const canvas = useCanvasStore.getState();
  if ('refused' in what) {
    canvas.announce(what.refused);
    return null;
  }
  before();
  return canvas.addElement(what.type, parentId, index, { starter: true, side, page: what.page });
}

/** What the thing being dragged is called, for the chip that follows the pointer. */
export function draggedLabel(type: string): string {
  const fileId = draggedPageId(type);
  if (fileId === null) return type;
  const path = useFilesStore.getState().uiFiles.get(fileId)?.path ?? '';
  return path.split('/').pop() ?? type;
}
