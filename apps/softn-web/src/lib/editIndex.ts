/**
 * Which saved apps carry changes the person made with the runtime's editor
 * (src/edit/).
 *
 * Read when a bundle is opened, so that only an app that has changes pays
 * for reading them: the changes themselves are in the editor's own store
 * (edit/drafts.ts), which is loaded when this says there are some. Kept in
 * the host's own keys, which no app's `localStorage` reaches (an app's are
 * under `softn:<its identity>:`).
 */

const EDITED_KEY = 'softn.web.edited';

function editedApps(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(EDITED_KEY) ?? '[]');
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

/** Whether the app with this identity has changes of the person's to lay over its files. */
export function hasDraft(origin: string): boolean {
  return editedApps().includes(origin);
}

/**
 * Forget everything the editor keeps for an app that is being removed: the
 * changes laid over it, and what was typed in it and never shown, which the
 * index above does not count. Always asked of the store itself, so nothing
 * typed outlives the app it was typed in.
 */
export async function forgetEdits(origin: string): Promise<void> {
  noteDraft(origin, false);
  try {
    await (await import('../edit/drafts')).dropDraft(origin);
  } catch {
    // The store's own code could not be fetched (no network): nothing is laid
    // over an app the index does not name, and the next removal asks again.
  }
}

export function noteDraft(origin: string, has: boolean): void {
  const edited = editedApps();
  if (edited.includes(origin) === has) return;
  try {
    localStorage.setItem(EDITED_KEY, JSON.stringify(has ? [...edited, origin] : edited.filter((entry) => entry !== origin)));
  } catch {
    // Storage refused: the editor's store still has the changes, and opening the editor finds them.
  }
}
