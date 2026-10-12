/**
 * Keeps the recovery copy as the project changes (utils/recoveryCopy.ts).
 *
 * A moment after the last change, not at each one: a property typed into is
 * a change at every key. And at once when the page is hidden or left, which
 * is the last a page hears before a tab is closed or a phone puts the
 * browser away. Nothing is written for a project with nothing unsaved, or a
 * second time for a revision already kept. A project whose work is undone
 * back to what it was kept as, while this tab's copy of that work is in the
 * store, is written once more as it stands, without the mark of unsaved
 * work (utils/recoveryCopy.ts).
 *
 * Two things are said, each once: that the copy could not be kept (the
 * store is full, or the browser will not let a page use it), and that
 * another tab has just kept its own work in place of this tab's.
 */

import { useEffect, useRef } from 'react';
import { useProjectStore } from '../stores/projectStore';
import { useNotificationStore } from '../stores/notificationStore';
import { SESSION_STORAGE_KEY, type ViewMode } from '../utils/openProject';
import { SESSION_ASSETS_HEAD_KEY, SESSION_ASSETS_KEY } from '../utils/storedAssets';
import { RECOVERY_OWNER_KEY, TAB_ID, writeRecoveryCopy } from '../utils/recoveryCopy';
import { persistedRevision } from '../utils/saveProject';

/** How long after the last change the copy is written. */
export const RECOVERY_DELAY_MS = 1500;

export const RECOVERY_FAILED = 'Your unsaved work could not be kept for recovery: this browser’s storage is full or blocked. Save the project to a file to keep it.';
export const RECOVERY_TAKEN =
  'Another Builder tab has just kept its own unsaved work as the recovery copy, in place of this tab’s. Only one is kept: this tab’s is kept again when you next change something. Save to a file to be sure of both.';

export function useRecoveryCopy(view: ViewMode, enabled = true): void {
  const viewRef = useRef(view);
  viewRef.current = view;

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let kept: { projectId: string; revision: number } | null = null;
    /** Whether the store holds this tab's copy of unsaved work, as far as this tab has heard. */
    let ownCopy = false;
    let toldFailure = false;
    let toldTaken = false;

    /**
     * Whether there is unsaved work that the copy does not have yet, or a
     * copy of work since undone that is still offered as unsaved. Not after
     * a save of this revision, which has stored its own record.
     */
    const due = (): boolean => {
      const project = useProjectStore.getState();
      if (kept !== null && kept.projectId === project.projectId && kept.revision === project.revision) return false;
      if (project.isDirty) return true;
      return ownCopy && kept?.projectId === project.projectId && persistedRevision(project.projectId) < project.revision;
    };
    const write = (): void => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      if (!due()) return;
      const unsaved = useProjectStore.getState().isDirty;
      const outcome = writeRecoveryCopy({ view: viewRef.current, unsaved });
      if (outcome.kind === 'written') {
        kept = { projectId: outcome.projectId, revision: outcome.revision };
        ownCopy = unsaved;
        toldFailure = false;
      } else if (unsaved && !toldFailure) {
        toldFailure = true;
        console.warn('[Builder] The recovery copy could not be written:', outcome.error);
        // Long enough to be read: it is said once.
        useNotificationStore.getState().addNotification({ type: 'error', message: RECOVERY_FAILED, duration: 15000 });
      }
    };
    const schedule = (): void => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(write, RECOVERY_DELAY_MS);
    };

    const unsubscribe = useProjectStore.subscribe((state, before) => {
      if (state.revision === before.revision && state.projectId === before.projectId && state.isDirty === before.isDirty) return;
      if (due()) schedule();
    });
    if (due()) schedule();

    const hidden = (): void => {
      if (document.visibilityState === 'hidden') write();
    };
    window.addEventListener('pagehide', write);
    document.addEventListener('visibilitychange', hidden);

    // Another tab writing the copy is heard here as a change to the store.
    const taken = (event: StorageEvent): void => {
      // The store is heard changing only when another tab changes it: its copy
      // of unsaved work, its Save, its assets. Each is this tab's replaced.
      if (event.newValue === null) return;
      if (event.key === RECOVERY_OWNER_KEY) {
        try {
          if ((JSON.parse(event.newValue) as { tab?: unknown }).tab === TAB_ID) return;
        } catch {
          return;
        }
      } else if (event.key !== SESSION_STORAGE_KEY && event.key !== SESSION_ASSETS_KEY && event.key !== SESSION_ASSETS_HEAD_KEY) {
        return;
      }
      // What is in the store is no longer this tab's to write over unasked.
      if (event.key === SESSION_STORAGE_KEY || event.key === RECOVERY_OWNER_KEY) ownCopy = false;
      // Only a tab that had a copy of its own unsaved work has lost one.
      if (toldTaken || kept === null || !useProjectStore.getState().isDirty) return;
      toldTaken = true;
      useNotificationStore.getState().addNotification({ type: 'warning', message: RECOVERY_TAKEN, duration: 15000 });
    };
    window.addEventListener('storage', taken);

    return () => {
      if (timer !== null) clearTimeout(timer);
      unsubscribe();
      window.removeEventListener('pagehide', write);
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('storage', taken);
    };
  }, [enabled]);
}
