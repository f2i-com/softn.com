/**
 * Which key a sync room is opened with, decided in one place.
 *
 * `db.startSync(room, options)` reaches the sync layer from four places: the
 * script runtime's db namespace, the renderer's xdb helpers (also the path
 * the saved-room resume and `<data>` blocks take), the worker runtime (which
 * delegates to the namespace) and the async host-call surface. Each used to
 * decide for itself whether the room was "shared" — a room-derived password
 * every peer can compute — or private, and two of them disagreed: the
 * namespace remembered a per-app flag (`xdb-sync-shared:<appId>`) that, once
 * any shared room had been started, silently made every later room in that
 * app shared for the life of the browser profile, while the renderer never
 * read it for an explicit call and never wrote it. Two peers of one app
 * could sit in the same room with different keys and never meet (core audit
 * 2.1 / 2.3).
 *
 * The rule now, applied by every path through `applyRoomSecurity`:
 *
 * 1. `options.sharedRoom` or the legacy `options.noEncrypt` makes the room
 *    shared for this call, as before.
 * 2. A room that was started shared stays shared when it is started again
 *    without options — after a reload, or by the host's saved-room resume —
 *    because the flag is now remembered PER ROOM
 *    (`xdb-sync-shared:<appId>:<room>`). `stopSync(room)` forgets it, so a
 *    room the app stops can be reopened private; stopping every room forgets
 *    all of them.
 * 3. The legacy per-app flag is still read, but it applies to the app's saved
 *    room only (`xdb-sync-active-room:<appId>`), which is the room it was
 *    written for by hosts that set up a shared room on the app's behalf. It
 *    no longer leaks onto other rooms. It is never written or removed here:
 *    it belongs to whoever wrote it.
 * 4. Otherwise the room is private and takes the host's per-user key when it
 *    offers one and the options name none.
 *
 * What stays exactly as it was, so peers on an older build still meet: the
 * shared password (`softn-shared:<room>`), the wire scope (the bundle's
 * declared `app.id`, else the host's app id), and which callers offer a
 * per-user key (the renderer's helpers do; the script runtime's namespace is
 * created without one and its rooms carry only the key the options name).
 */

import type { PermissionConfig } from './script-runtime';
import { readSavedSyncRoom } from './xdb-sync-key';

/** Prefix of every shared-room flag; the exact strings are an on-disk contract. */
const SHARED_FLAG_PREFIX = 'xdb-sync-shared';
/** The password every peer of a shared room derives; y-webrtc turns it into the AES key. */
export const SHARED_ROOM_PASSWORD_PREFIX = 'softn-shared:';

/** The per-app flag older builds wrote once any shared room had been started. */
export function legacySharedFlagKey(appId: string): string {
  return `${SHARED_FLAG_PREFIX}:${appId}`;
}

/** The flag that remembers one room of one app was started shared. */
export function sharedRoomFlagKey(appId: string, room: string): string {
  return `${SHARED_FLAG_PREFIX}:${appId}:${room}`;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * Whether `room` should open shared when the caller did not say: it was
 * started shared before and not stopped since, or it is the saved room of an
 * app whose host marked it shared with the legacy per-app flag.
 */
export function isRoomMarkedShared(appId: string | undefined, room: string): boolean {
  if (!appId) return false;
  const store = storage();
  if (!store) return false;
  try {
    if (store.getItem(sharedRoomFlagKey(appId, room)) === 'true') return true;
    if (store.getItem(legacySharedFlagKey(appId)) === 'true') return readSavedSyncRoom(appId) === room;
  } catch {
    // Storage that refuses reads (a restricted context) cannot mark anything.
  }
  return false;
}

/** Remember that `room` was started shared, so a start without options keeps its key. */
export function markRoomShared(appId: string | undefined, room: string): void {
  if (!appId) return;
  try {
    storage()?.setItem(sharedRoomFlagKey(appId, room), 'true');
  } catch {
    // Quota or a restricted context: the room is still shared for this session.
  }
}

/**
 * Forget the shared mark of `room`, or of every room of the app when no room
 * is named — the two shapes of `stopSync`. The legacy per-app flag is left
 * alone: it belongs to the host that wrote it and applies to the saved room,
 * which `stopSync` removes on its own.
 */
export function unmarkRoomShared(appId: string | undefined, room?: string): void {
  if (!appId) return;
  const store = storage();
  if (!store) return;
  try {
    if (room !== undefined) {
      store.removeItem(sharedRoomFlagKey(appId, room));
      return;
    }
    const prefix = `${SHARED_FLAG_PREFIX}:${appId}:`;
    const stale: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key && key.startsWith(prefix)) stale.push(key);
    }
    for (const key of stale) store.removeItem(key);
  } catch {
    // Nothing to forget in a context that cannot remember.
  }
}

export interface RoomSecurityContext {
  /** The room the script named — the first argument of `startSync`. */
  room: string;
  /** The host's identity for the app; scopes the flags and, failing a declared id, the wire room. */
  appId?: string;
  /** The bundle's permission.json; its `app.id` is the wire scope when declared. */
  permissionConfig?: PermissionConfig | null;
  /** The host's per-user key for private rooms, when the caller offers one. */
  syncEncryptionKeyHex?: string;
}

/**
 * Decide a room's wire scope and key on the bound options, in place, and say
 * whether it came out shared. `opts` is what `bindSyncOptions` returned; the
 * `sharedRoom` and `noEncrypt` requests are consumed here and removed.
 */
export function applyRoomSecurity(opts: Record<string, unknown>, context: RoomSecurityContext): boolean {
  const { room, appId, permissionConfig, syncEncryptionKeyHex } = context;
  // The room label is what peers agree on; the app is who is agreeing. On the
  // wire the two are joined, so two apps that both chose "lobby" are in two
  // rooms — by the stable identity the bundle declares, so that compatible
  // builds still meet, else by the host's identity for it.
  opts.roomScope = permissionConfig?.app?.id || appId || undefined;
  const shared = !!opts.sharedRoom || !!opts.noEncrypt || isRoomMarkedShared(appId, room);
  if (shared) {
    // Derive the key from the room name — all peers use the same key.
    // y-webrtc runs PBKDF2(password, roomName) to produce AES-256-GCM.
    opts.password = SHARED_ROOM_PASSWORD_PREFIX + room;
    delete opts.encryptionKey;
    markRoomShared(appId, room);
  } else if (syncEncryptionKeyHex && !opts.encryptionKey) {
    opts.encryptionKey = syncEncryptionKeyHex;
  }
  delete opts.noEncrypt;
  delete opts.sharedRoom;
  return shared;
}
