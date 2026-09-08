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
