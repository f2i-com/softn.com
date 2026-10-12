/**
 * The recovery copy: unsaved work, kept in the browser as it is made.
 *
 * The record a session is restored from was written by Save and by Export
 * and by nothing else. Everything since the last of those was in memory
 * only: a tab closed by mistake, a browser that fell over, a battery that
 * ran out, and it was gone, with the page saying "Unsaved" to the end.
 *
 * It is written now a moment after each change (hooks/useRecoveryCopy.ts),
 * and as the page is hidden or left, in the place and the shape Save writes
 * it, so the offer made on the next open is the one there always was. What
 * is different about a copy of unsaved work is marked on it:
 *
 *  - `recovery.unsaved`: the offer says the work was not saved, and the
 *    project comes back "Unsaved", which it is;
 *  - the project's pictures and other assets are not in it. A browser's
 *    store is a few megabytes and the copy is written again and again, so
 *    the copy is the project's text, naming each asset, and the assets are
 *    a record of their own that is written when they change
 *    (utils/storedAssets.ts). For a while they were inside the copy below a
 *    budget and left out above it: `recovery.assets` is that copy saying
 *    which, and is read only from a record of then;
 *  - `recovery.tab`: there is one copy, and two tabs. The one kept is the
 *    tab's that changed last. A tab whose copy has just been replaced by
 *    another's is told so, once: it is not silent, and nothing is merged.
 *
 * Work undone back to what the project was kept as is no longer unsaved
 * (utils/savedPoint.ts), and a copy of it would offer the undone edits
 * back on the next open as work that was not saved. The tab whose copy it
 * is writes the project again as it stands, unmarked: the record a Save of
 * it would have stored.
 *
 * A store that will not take the text is a failure handed back, for the
 * hook to say once; one that takes the text and not the assets has kept the
 * copy, and the offer says what is not in it. Nothing here throws.
 */

import { useFilesStore } from '../stores/filesStore';
import { useProjectStore } from '../stores/projectStore';
import { flushCanvasToActiveFile } from './buildProjectBundle';
import { captureSession, SESSION_STORAGE_KEY, type BuilderSession, type ViewMode } from './openProject';
import { notePersistedRevision } from './saveProject';
import { TAB_ID, captureAssets, missingAssetsSentence, storeAssets, type AssetStore, type AssetsKept } from './storedAssets';

/** A small record of which tab wrote the copy last, so another tab hears of it without reading the copy. */
export const RECOVERY_OWNER_KEY = 'softn.builder.session.owner.v1';

export { TAB_ID };

export interface RecoveryMark {
  tab: string;
  unsaved: true;
  assets: 'kept' | 'left-out';
}

export type RecoverySession = BuilderSession & { recovery?: RecoveryMark };

export type RecoveryWrite =
  | { kind: 'written'; projectId: string; revision: number; assets: 'kept' | 'left-out' }
  | { kind: 'failed'; error: unknown };

export interface RecoveryDeps {
  view: ViewMode;
  storage?: AssetStore;
  /** Put the canvas into its file first, as Save does; a test may leave it out. */
  flush?: () => void;
  /** False for a project that is again what it was kept as: written without the mark. */
  unsaved?: boolean;
}

/** Write the copy of the project as it stands. The outcome, never a throw. */
export function writeRecoveryCopy(deps: RecoveryDeps): RecoveryWrite {
  try {
    (deps.flush ?? flushCanvasToActiveFile)();
    const storage = deps.storage ?? window.localStorage;
    const assets = captureAssets(useFilesStore.getState().assetFiles);
    const session: RecoverySession = {
      ...captureSession(deps.view, { assets: 'apart' }),
      ...(deps.unsaved === false ? {} : { recovery: { tab: TAB_ID, unsaved: true, assets: 'kept' } }),
    };
    // The text first, which is what is typed: a store that refuses it has kept nothing, and that is the failure.
    try {
      storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
    } catch (error) {
      return { kind: 'failed', error };
    }
    // Then the assets, when they are not the set the store has. Refused, the
    // text is kept all the same, and the offer says what is not in it.
    const kept = storeAssets(storage, assets).kind === 'refused' ? 'left-out' : 'kept';
    try {
      storage.setItem(RECOVERY_OWNER_KEY, JSON.stringify({ tab: TAB_ID, savedAt: session.savedAt }));
    } catch {
      // The copy is kept; only another tab's hearing of it is not.
    }
    const project = useProjectStore.getState();
    // A save that began before this and ends after it leaves this copy alone (saveProject.ts).
    notePersistedRevision(session.projectId ?? project.projectId, session.revision ?? project.revision);
    return { kind: 'written', projectId: session.projectId ?? project.projectId, revision: session.revision ?? project.revision, assets: kept };
  } catch (error) {
    return { kind: 'failed', error };
  }
}

/** What a stored session says of itself as a copy of unsaved work, or null for one Save wrote. */
export function recoveryOf(raw: string): (RecoveryMark & { name: string; savedAt: string }) | null {
  try {
    const session = JSON.parse(raw) as { recovery?: Partial<RecoveryMark>; project?: { name?: unknown }; savedAt?: unknown };
    if (!session || typeof session !== 'object' || session.recovery?.unsaved !== true) return null;
    return {
      tab: typeof session.recovery.tab === 'string' ? session.recovery.tab : '',
      unsaved: true,
      assets: session.recovery.assets === 'left-out' ? 'left-out' : 'kept',
      name: typeof session.project?.name === 'string' && session.project.name ? session.project.name : 'Untitled App',
      savedAt: typeof session.savedAt === 'string' ? session.savedAt : '',
    };
  } catch {
    return null;
  }
}

/**
 * The question asked on the next open, for the session that is stored.
 * `assets` is what joining it with the record of its assets found
 * (utils/storedAssets.ts): how many it names, and how many are not there.
 */
export function restoreOffer(raw: string, assets?: AssetsKept): string {
  const copy = recoveryOf(raw);
  // A copy from before the assets were kept apart says of itself that it left them out.
  const without = assets && assets.missing > 0 ? missingAssetsSentence(assets) : copy?.assets === 'left-out' ? missingAssetsSentence({ total: 1, missing: 1 }) : '';
  if (!copy) return `Restore the last locally saved builder session?${without}`;
  const at = copy.savedAt ? new Date(copy.savedAt) : null;
  const when = at && !Number.isNaN(at.getTime()) ? `, as it was at ${at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} on ${at.toLocaleDateString([], { day: 'numeric', month: 'short' })}` : '';
  return `Restore “${copy.name}” with the changes that were not saved${when}?${without}`;
}
