/**
 * A way to ask the preview to start the app again, from outside the canvas.
 *
 * The preview keeps a running app's state across an edit, which is what a
 * person changing a label wants. It is wrong when the project's files are
 * replaced whole: the plan review writes the scaffold again when a page is
 * added or removed, and the app on the canvas went on with the list of pages
 * it had started with, so a plan of three pages showed a nav of one until
 * "Refresh preview" was pressed. Whoever replaces the files asks for a
 * restart here; the canvas listens (components/canvas/VisualCanvas.tsx).
 */

const listeners = new Set<() => void>();

/** Start the previewed app again, as "Refresh preview" does. Nothing happens when no canvas is mounted. */
export function restartPreview(): void {
  for (const listener of [...listeners]) listener();
}

/** Listen for restarts; returns the way to stop listening. */
export function onPreviewRestart(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
