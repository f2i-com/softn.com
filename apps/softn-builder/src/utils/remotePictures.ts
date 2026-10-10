/**
 * The pictures at an address that a person has asked the canvas to show.
 *
 * Nothing on the canvas is fetched because a file was opened: a picture at
 * an address is drawn as a place that names the address, with a "Show"
 * beside it (components/canvas/CanvasElement.tsx). What has been asked for
 * is kept here, by address, for as long as the project is open in this
 * editor: it is not saved with the project, so the next person to open the
 * file is asked again, and it is forgotten when another project is opened.
 */

import { useSyncExternalStore } from 'react';
import { useProjectStore } from '../stores/projectStore';

const shown = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

function changed(): void {
  version += 1;
  for (const listener of listeners) listener();
}

/** Whether the browser would go to another host for `address`: `http:`, `https:`, or `//host/…`. */
export function isRemoteAddress(address: string): boolean {
  return /^\s*(?:https?:)?\/\//i.test(address);
}

/** Whether this address has been asked for. */
export function remoteShown(address: string): boolean {
  return shown.has(address.trim());
}

/** Show the picture at this address, here and wherever else on the canvas it is. */
export function showRemotePicture(address: string): void {
  const key = address.trim();
  if (key === '' || shown.has(key)) return;
  shown.add(key);
  changed();
}

/** Forget what was asked for. */
export function forgetShownPictures(): void {
  if (shown.size === 0) return;
  shown.clear();
  changed();
}

// Another project is another answer: what was shown for the last one says
// nothing of this one's addresses.
let workspace = useProjectStore.getState().workspaceGeneration;
useProjectStore.subscribe((state) => {
  if (state.workspaceGeneration === workspace) return;
  workspace = state.workspaceGeneration;
  forgetShownPictures();
});

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** How many pictures have been asked for: what draws one reads it, to be drawn again when one more is. */
export function useShownPictures(): number {
  return useSyncExternalStore(subscribe, () => version);
}
