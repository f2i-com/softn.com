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
 *  - `recovery.assets`: a browser's store is a few megabytes, and the copy
 *    is written again and again. A project's pictures and other assets go
 *    into it while they are small (ASSET_BUDGET, all together) and the
 *    store takes them; otherwise the copy is the project's text, which is
 *    what is typed, and the offer says its assets are not in it;
 *  - `recovery.tab`: there is one copy, and two tabs. The one kept is the
 *    tab's that changed last. A tab whose copy has just been replaced by
 *    another's is told so, once (the owner key below is how it hears): it is
 *    not silent, and nothing is merged.
 *
 * A store that will not take the copy at all is a failure handed back, for
 * the hook to say once. Nothing here throws.
 */

import { useFilesStore } from '../stores/filesStore';
import { useProjectStore } from '../stores/projectStore';
import { flushCanvasToActiveFile } from './buildProjectBundle';
import { captureSession, SESSION_STORAGE_KEY, type BuilderSession, type ViewMode } from './openProject';
import { notePersistedRevision } from './saveProject';

/** A small record of which tab wrote the copy last, so another tab hears of it without reading the copy. */
export const RECOVERY_OWNER_KEY = 'softn.builder.session.owner.v1';

/** The assets of a project, all together, above which they are left out of the copy. */
export const ASSET_BUDGET = 1_500_000;

/** This page, among the tabs the editor is open in. */
export const TAB_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

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
  storage?: Pick<Storage, 'setItem'>;
  assetBudget?: number;
  /** Put the canvas into its file first, as Save does; a test may leave it out. */
  flush?: () => void;
}

/** Write the copy of the project as it stands. The outcome, never a throw. */
export function writeRecoveryCopy(deps: RecoveryDeps): RecoveryWrite {
  try {
    (deps.flush ?? flushCanvasToActiveFile)();
    const storage = deps.storage ?? window.localStorage;
    let bytes = 0;
    for (const asset of useFilesStore.getState().assetFiles.values()) bytes += asset.data.byteLength;
    // With its assets while they are few; without them when they are many,
    // and when the store would not take the copy that had them.
    const attempts: Array<'kept' | 'left-out'> = bytes === 0 ? ['kept'] : bytes > (deps.assetBudget ?? ASSET_BUDGET) ? ['left-out'] : ['kept', 'left-out'];
    let refused: unknown;
    for (const assets of attempts) {
      const session: RecoverySession = {
        ...captureSession(deps.view, { assets: assets === 'kept' }),
        recovery: { tab: TAB_ID, unsaved: true, assets },
      };
      try {
        storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
      } catch (error) {
        refused = error;
        continue;
      }
      try {
        storage.setItem(RECOVERY_OWNER_KEY, JSON.stringify({ tab: TAB_ID, savedAt: session.savedAt }));
      } catch {
        // The copy is kept; only another tab's hearing of it is not.
      }
      const project = useProjectStore.getState();
      // A save that began before this and ends after it leaves this copy alone (saveProject.ts).
      notePersistedRevision(session.projectId ?? project.projectId, session.revision ?? project.revision);
      return { kind: 'written', projectId: session.projectId ?? project.projectId, revision: session.revision ?? project.revision, assets };
    }
    return { kind: 'failed', error: refused };
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

/** The question asked on the next open, for the session that is stored. */
export function restoreOffer(raw: string): string {
  const copy = recoveryOf(raw);
  if (!copy) return 'Restore the last locally saved builder session?';
  const at = copy.savedAt ? new Date(copy.savedAt) : null;
  const when = at && !Number.isNaN(at.getTime()) ? `, as it was at ${at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} on ${at.toLocaleDateString([], { day: 'numeric', month: 'short' })}` : '';
  const without =
    copy.assets === 'left-out'
      ? ' Its pictures and other assets were too large to keep in this browser and are not in it: add them again, or open the file you last saved.'
      : '';
  return `Restore “${copy.name}” with the changes that were not saved${when}?${without}`;
}
