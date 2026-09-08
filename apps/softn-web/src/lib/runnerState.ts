/**
 * The state a tab's app starts from, before its script runs.
 *
 * Two things are seeded. `currentPage` is the page the tab was opened at, so
 * a deep link lands where it points. `syncRoom` is the room this app was last
 * in, so its own sync control comes up filled in and reconnecting is one
 * press rather than a paste.
 *
 * No connection flag is seeded with the room. `syncConnecting` belongs to the
 * app's own sync control — it sets the flag when it calls startSync and
 * clears it when a status comes back — and nothing in the runtime touches
 * it. Nothing in the runtime makes that connection either: softn-web never
 * hands the renderer resumeSavedSyncRoom, so a saved room is not rejoined on
 * open, and while the consent bar is unanswered startSync is refused
 * outright. Seeding the flag here therefore claimed a connection nothing was
 * attempting, and the only code that would have cleared it was the code that
 * never ran: an app with a saved room came up saying "connecting" and stayed
 * there.
 *
 * Pure, so the web workspace's node-environment tests can pin it: the caller
 * reads localStorage and passes what it found.
 */

export interface RunnerInitialStateInput {
  initialPage?: string;
  savedRoom?: string | null;
}

export function buildRunnerInitialState({
  initialPage,
  savedRoom,
}: RunnerInitialStateInput): Record<string, unknown> | undefined {
  const state: Record<string, unknown> = {};
  if (initialPage) state.currentPage = initialPage;
  if (savedRoom) state.syncRoom = savedRoom;
  return Object.keys(state).length > 0 ? state : undefined;
}

/**
 * Where xdb-sync saves an app's active room: the same key core's
 * getSyncRoomKey writes. Namespaced by app, because the bare key is written
 * only by an app that runs without an id, and softn-web always runs with
 * one — reading the bare key here seeded a room this app had never joined,
 * or nothing.
 */
export function savedSyncRoomKey(appId?: string): string {
  return appId ? `xdb-sync-active-room:${appId}` : 'xdb-sync-active-room';
}
