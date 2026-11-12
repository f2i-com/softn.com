/**
 * A file put on the canvas by being chosen, told apart from the file that
 * was already there getting a new name or a new place.
 *
 * On a phone the canvas and the panels take turns, so a file chosen in Files
 * or Pages is shown by going to the canvas (App.tsx). That was done whenever
 * the path of the file on the canvas changed. A rename or a move of the file
 * that is showing changes its path too: the canvas goes on showing it under
 * the path it now has (lib/fileOps.ts), and nothing was chosen. The person
 * was in Files, typing a name, and was taken to the preview.
 *
 * The two are told apart by what was last done to the files. A rename or a
 * move is one step in which the file leaves its old path and arrives at its
 * new one; when the path on the canvas goes from the first to the second
 * and that is the newest step, the file was followed, not chosen.
 */

import { useEffect, useRef } from 'react';
import { useVFSStore } from '../stores/vfsStore';
import { useWorkspaceStore } from '../stores/workspaceStore';
import type { VFSEvent } from '../types/studio';

/** Whether the newest step in the history took the file at `from` to `to`: it left the one path and arrived at the other. */
export function movedByLastStep(history: readonly VFSEvent[], from: string | null, to: string | null): boolean {
  if (!from || !to || history.length === 0) return false;
  const step = history[history.length - 1].transactionId;
  if (step === undefined) return false;
  let left = false;
  let arrived = false;
  for (let at = history.length - 1; at >= 0 && history[at].transactionId === step; at--) {
    const event = history[at];
    if (event.type === 'delete' && event.path === from) left = true;
    else if (event.type === 'create' && event.path === to) arrived = true;
  }
  return left && arrived;
}

/**
 * Call `onChosen` when a file is put on the canvas by being chosen (in
 * Files, in Pages, on the canvas itself, or by being made). Not when the
 * file that is showing was renamed or moved, and not when the canvas is
 * left with no file of its own.
 */
export function useFileChosen(onChosen: () => void): void {
  const path = useWorkspaceStore((state) => state.activeFilePath);
  const shown = useRef(path);
  const chosen = useRef(onChosen);
  chosen.current = onChosen;
  useEffect(() => {
    const before = shown.current;
    if (path === before) return;
    shown.current = path;
    if (!path || movedByLastStep(useVFSStore.getState().history, before, path)) return;
    chosen.current();
  }, [path]);
}
