/**
 * Where an app's saved sync room lives, and nothing else.
 *
 * The rule is one line, and it used to be spelled in five places: here, in
 * xdb-sync.ts and three times inside SoftNRenderer.tsx — each of which read
 * the key by hand rather than import the function, because importing anything
 * from xdb-sync.ts brings yjs, y-webrtc and y-indexeddb with it, and the
 * renderer must not carry those for an app that never syncs. The renderer's
 * mount-time cleanup went the other way and did `import('../runtime/xdb-sync')`
 * just to ask whether a room was saved, so every app on both hosts fetched the
 * 195 KB sync chunk on every cold visit, `sync` or not (audit item X07).
 *
 * This module imports nothing. The renderer asks it before deciding whether
 * the sync module is worth loading, and xdb-sync.ts uses the same function,
 * so the two cannot disagree about the key.
 */

const SYNC_ROOM_KEY_PREFIX = 'xdb-sync-active-room';

/** The localStorage key for an app's active sync room, namespaced by appId. */
export function getSyncRoomKey(appId?: string): string {
  return appId ? `${SYNC_ROOM_KEY_PREFIX}:${appId}` : SYNC_ROOM_KEY_PREFIX;
}

/**
 * Where the offline CRDT cache for an app's room lives (an IndexedDB database).
 *
 * Named by app and room. The default instance keeps the name it always had,
 * so a document that only ever ran one app finds its cache where it left it;
 * an app-scoped adapter never reads a cache it cannot prove is its own — a
 * legacy `xdb-sync-<room>` store may belong to any app that used that label.
 * Here rather than in xdb-sync.ts so that a host removing an app can name its
 * caches without loading the sync runtime.
 */
export function persistenceNameFor(appId: string | undefined, room: string): string {
  return appId ? `xdb-sync:${appId}:${room}` : `xdb-sync-${room}`;
}

/**
 * The room an app was last in, or null: none saved, or no localStorage (a
 * restricted context, a worker, Node). Never throws.
 */
export function readSavedSyncRoom(appId?: string): string | null {
  try {
    return localStorage.getItem(getSyncRoomKey(appId));
  } catch {
    return null;
  }
}
