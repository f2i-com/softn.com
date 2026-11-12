/**
 * What the runtime's editor is given of the runtime around it (App.tsx makes
 * one): the tab it edits, a way to write on it, and a way to open the app
 * afresh in the same tab. Types alone, so the runtime's start-up code names
 * the editor without carrying any of it.
 */

import type { AppUpdateResult } from '@softn/core';
import type { OpenTab } from '../lib/openBundle';

export interface EditHost {
  /** The tab as it is now; undefined once it is closed. */
  tab(tabId: string): OpenTab | undefined;
  /** Write these fields on the tab. What asks next is answered with them. */
  patch(tabId: string, fields: Partial<OpenTab>): void;
  /**
   * Open the app afresh from the person's library, in the same tab, with
   * their changes laid over it: for a change the running app cannot take
   * where it stands. False when it did not open.
   */
  reopen(tabId: string): Promise<boolean>;
  /** Put the editor away. */
  close(): void;
  /**
   * Have the runtime ask before it puts the editor away from outside it (Edit
   * pressed again on the bar): `mayClose` answers false where something is
   * still waiting on the person, and brings it to their attention. Returns
   * how to stop being asked.
   */
  guardClose(mayClose: () => boolean): () => void;
  /** The person's library changed (a copy was made); Home lists it. */
  libraryChanged(): void;
  /** Hear what an app answered to a newer version handed to it through its page. Returns how to stop. */
  onAppUpdate(listener: (tabId: string, result: AppUpdateResult) => void): () => void;
}
