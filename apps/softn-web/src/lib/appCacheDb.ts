/**
 * The app cache's IndexedDB: the record it keeps for each cached build, and
 * the one connection every read and write shares (getDB), with the rule for
 * when an open that failed is tried again. Re-exported by ./appCache.
 */

import { openDB, type IDBPDatabase } from 'idb';

// ── Types ────────────────────────────────────────────────────────────

export interface CachedApp {
  id: string;
  name: string;
  version: string;
  description?: string;
  bundleData: Uint8Array;
  cachedAt: number;
  lastOpened: number;
  icon?: string; // Data URL
  grantedPermissions?: Record<string, boolean>;
  permissionsPromptedAt?: number;
  /**
   * What this app IS, as opposed to what it calls itself: a digest of the
   * bundle's bytes. Absent on records written before identity moved off the
   * manifest name; see findLegacyAdoption in ./appCacheAdoption. Sixteen hex
   * characters on records written before the full digest was kept; see
   * findShortOriginAdoption there.
   */
  origin?: string;
  /**
   * The app's slug in the site's directory, when it was opened from there.
   * Opening it again from Home then still knows its page, its bundle URL and
   * its server storage.
   */
  directorySlug?: string;
  /**
   * What the bundle's permission.json asked for, as cached. Kept so an
   * update's consent bar can say what it asks for that the build before it
   * did not, without unpacking the older bundle again.
   */
  requestedCapabilities?: string[];
  /**
   * Whether this app can be opened without a network, as last established by
   * lib/offlineInstall.ts. Absent until an install has run. The bundle's own
   * bytes are on this record and never in doubt; what is in doubt is the code
   * that renders them — the feature chunks, the sync runtime, a worker's
   * files — which the service worker only holds once something fetched them.
   */
  offline?: OfflineState;
}

/** What the last offline install of a record established. */
export interface OfflineState {
  /** Everything the app can reach was fetched through the service worker. */
  ready: boolean;
  /** The lazy component names the install covered, plus the sync runtime when the app asked for it. */
  features: string[];
  /** Capabilities whose runtime stays online by design (`ai`: models are downloads). */
  optionalOnline?: string[];
  /** The shell build the install was made against; see currentBuildId. */
  build: string;
  at: number;
  /** Why an install that ran did not finish, in words Home can show. */
  reason?: string;
}

export interface SoftNAppDB {
  'softn-apps': {
    key: string;
    value: CachedApp;
    indexes: { 'by-name': string; 'by-origin': string };
  };
}

// ── Database ─────────────────────────────────────────────────────────

const DB_NAME = 'softn-web';
const DB_VERSION = 2;

let dbPromise: Promise<IDBPDatabase<SoftNAppDB>> | null = null;
/** Set once an open has failed in a way that no retry can mend. */
let dbPermanentlyUnavailable: Error | null = null;
/** After a transient failure, no new open is attempted before this time. */
let dbRetryAfter = 0;

/** How long a transient open failure keeps the cache off before it is tried again. */
const DB_RETRY_BACKOFF_MS = 5_000;

/**
 * Whether an open failure is worth retrying.
 *
 * One failed open used to switch the cache off for the rest of the session:
 * every later call rejected without asking the browser again. That is the
 * right answer for a browser that refuses storage outright — a sandboxed
 * frame, a policy, no IndexedDB at all — and the wrong one for everything
 * else. Firefox reports a private window as a transient failure; a version
 * upgrade blocked by another tab clears when that tab goes; a quota error
 * clears when space does. A Home that showed no apps until reload, after a
 * hiccup that had already passed, was the visible result.
 */
export function classifyIndexedDBFailure(err: unknown): 'permanent' | 'transient' {
  if (typeof indexedDB === 'undefined') return 'permanent';
  const name = typeof err === 'object' && err !== null ? (err as { name?: unknown }).name : undefined;
  switch (name) {
    case 'SecurityError':
    case 'InvalidStateError':
    case 'NotSupportedError':
      return 'permanent';
    default:
      return 'transient';
  }
}

/**
 * Forget an earlier failure so the next call opens the database again — for a
 * "Try again" the user presses, and for tests. Not called on a timer: the
 * transient case retries by itself once its backoff has passed.
 */
export function resetAppCacheAvailability(): void {
  dbPermanentlyUnavailable = null;
  dbRetryAfter = 0;
  dbPromise = null;
}

export function getDB(): Promise<IDBPDatabase<SoftNAppDB>> {
  if (dbPermanentlyUnavailable) {
    return Promise.reject(dbPermanentlyUnavailable);
  }
  if (!dbPromise) {
    if (Date.now() < dbRetryAfter) {
      return Promise.reject(new Error('IndexedDB is not available right now; retrying shortly'));
    }
    dbPromise = openDB<SoftNAppDB>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion, _newVersion, tx) {
        if (oldVersion < 1) {
          const store = db.createObjectStore('softn-apps', { keyPath: 'id' });
          store.createIndex('by-name', 'name');
        }
        if (oldVersion < 2) {
          // Records written before this version have no origin. They are not
          // back-filled here — hashing every cached bundle inside an upgrade
          // transaction would block startup — but lazily, the first time each
          // app is opened again. See findLegacyAdoption (./appCacheAdoption).
          tx.objectStore('softn-apps').createIndex('by-origin', 'origin');
        }
      },
      blocked(currentVersion, blockedVersion) {
        // Another tab still holds an older schema open. The open completes
        // when that tab closes its connection — see `blocking` below, which is
        // the other side of the same handshake.
        console.warn(
          `[SoftN Web] IndexedDB upgrade to v${blockedVersion} is waiting on a tab still using v${currentVersion}`
        );
      },
      blocking(_currentVersion, _blockedVersion, event) {
        // A newer build in another tab wants to upgrade. Holding the
        // connection open would block it forever; closing lets it through,
        // and the next call here reopens at whatever version it left.
        (event.target as IDBDatabase | null)?.close();
        dbPromise = null;
      },
      terminated() {
        // The browser closed the connection underneath us (storage cleared,
        // a crash in the storage process). Reopen on the next call.
        dbPromise = null;
      },
    }).catch((err) => {
      dbPromise = null;
      if (classifyIndexedDBFailure(err) === 'permanent') {
        console.warn('[SoftN Web] IndexedDB unavailable, caching disabled:', err);
        dbPermanentlyUnavailable = err instanceof Error ? err : new Error(String(err));
      } else {
        console.warn(
          `[SoftN Web] IndexedDB open failed; retrying in ${DB_RETRY_BACKOFF_MS / 1000}s:`,
          err
        );
        dbRetryAfter = Date.now() + DB_RETRY_BACKOFF_MS;
      }
      throw err;
    });
  }
  return dbPromise;
}
