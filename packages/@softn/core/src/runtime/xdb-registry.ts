/**
 * Which XDBService an app gets: the per-app instance registry, the
 * memory-only scopes editor previews use, the legacy-key migration that
 * runs the first time an app's namespaced store is opened, the sync
 * signaling defaults, and the plain-object module scripts call `db` on.
 */

import { XDBService } from './xdb-service';
import type { XDBStorage } from './xdb-types';

// ── Sync signaling configuration ──────────────────────────

/** Default signaling server URLs for XDB sync.
 *  Stored here (in xdb.ts) so it's accessible without importing the heavy
 *  xdb-sync.ts module. The sync module reads this when it connects. */
let _defaultSignalingUrls: string[] | undefined;

/** Set default signaling server URLs for all XDB sync adapters.
 *  Call this at app startup to prevent connections to public signaling servers. */
export function setDefaultSignaling(urls: string[]): void {
  _defaultSignalingUrls = urls;
}

/** Get the configured default signaling URLs (used by xdb-sync.ts). */
export function getDefaultSignaling(): string[] | undefined {
  return _defaultSignalingUrls;
}

/** Cached reference to xdb-sync module (set after first dynamic import). */
let _syncModuleRef: { getAllSyncStatus: () => { connected: boolean; peers: number; room: string; peerId: string }[] } | null = null;

/** Register the sync module reference (called from xdb-sync.ts or script-runtime.ts). */
export function _setSyncModuleRef(mod: typeof _syncModuleRef): void {
  _syncModuleRef = mod;
}

/** Get sync status of all active rooms. Returns empty array if sync module not loaded. */
export function getSyncStatuses(): { connected: boolean; peers: number; room: string; peerId: string }[] {
  return _syncModuleRef?.getAllSyncStatus() ?? [];
}

// Per-app XDB instances
const xdbInstances = new Map<string, XDBService>();

const EPHEMERAL_XDB_PREFIX = '__softn_preview__';
let ephemeralXDBSequence = 0;

export interface EphemeralXDBScope {
  /** Pass to the renderer so scripts, data blocks and components share this store. */
  appId: string;
  xdb: XDBService;
  /** Call after unmounting the preview. Idempotent; discards its data, registry entry and script storage. */
  dispose: () => void;
}

/**
 * Remove what a preview's script kept in localStorage under its scope's id
 * (`softn:<id>:…`, the prefix the engines' storage bridges use). The id is never
 * used again, so nothing reads those keys once the scope is gone: left, they
 * counted against the storage every app shares, one set for every preview.
 */
function forgetScriptStorage(appId: string): void {
  const prefix = `softn:${appId.replace(/[^a-zA-Z0-9_-]/g, '_')}:`;
  try {
    const storage = globalThis.localStorage;
    if (!storage) return;
    for (let i = storage.length - 1; i >= 0; i--) {
      const key = storage.key(i);
      if (key?.startsWith(prefix)) storage.removeItem(key);
    }
  } catch {
    // Storage refused: what is there stays.
  }
}

/** How long a scope may go unseen before its script storage, left by a page that closed, is swept. */
const STALE_SCOPE_MS = 24 * 60 * 60 * 1000;
/** How often a live scope says so (`ALIVE_PREFIX`). */
const ALIVE_EVERY_MS = 60 * 60 * 1000;
/** Where a live scope keeps the time it last said it was open: `softn-preview-alive:<id>`. */
const ALIVE_PREFIX = 'softn-preview-alive:';
let staleScopesSwept = false;

function markAlive(appId: string, at: number | null): void {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return;
    if (at === null) storage.removeItem(`${ALIVE_PREFIX}${appId}`);
    else storage.setItem(`${ALIVE_PREFIX}${appId}`, String(at));
  } catch {
    // Storage refused: the sweep goes by when the scope was made.
  }
}

/**
 * The browser's Web Locks, where it has them: a live scope holds one named for it
 * (`softn-preview:<id>`) until it is let go, and the page's, asleep or frozen,
 * holds it as long as the page lives.
 */
type PreviewLocks = {
  request: (name: string, callback: () => Promise<void>) => Promise<unknown>;
  query: () => Promise<{ held?: Array<{ name?: string }> }>;
};
const LOCK_PREFIX = 'softn-preview:';

function previewLocks(): PreviewLocks | null {
  try {
    const locks = (globalThis.navigator as { locks?: Partial<PreviewLocks> } | undefined)?.locks;
    return locks && typeof locks.request === 'function' && typeof locks.query === 'function' ? (locks as PreviewLocks) : null;
  } catch {
    return null;
  }
}

/** `count` random decimal digits, from the browser's random source where it has one. */
function randomDigits(count: number): string {
  const values = new Uint32Array(count);
  try {
    globalThis.crypto.getRandomValues(values);
  } catch {
    for (let i = 0; i < count; i++) values[i] = Math.floor(Math.random() * 10);
  }
  return [...values].map((value) => String(value % 10)).join('');
}

/** Hold the scope's lock while it lives; the returned function lets it go. */
function holdWhileOpen(appId: string): () => void {
  const locks = previewLocks();
  if (!locks) return () => {};
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  locks.request(`${LOCK_PREFIX}${appId}`, () => held).catch(() => {});
  return () => release();
}

/**
 * Remove, once a page, the script storage of scopes not seen for a day. A
 * preview whose page closed is never disposed, and what its script kept stayed
 * for good. A live scope says it is open every hour (`markAlive`), so one open
 * in another tab is left alone however long ago it was made; one that never
 * said (a page from before) goes by when it was made, which its id holds. And
 * one whose lock is held (`holdWhileOpen`) is open, however long its page has
 * slept: a laptop shut for two days missed its hourly marks, and another tab
 * swept a preview still open in it.
 */
function sweepStaleScopes(now: number): void {
  if (staleScopesSwept) return;
  staleScopesSwept = true;
  const locks = previewLocks();
  if (!locks) {
    sweepScopes(now, new Set());
    return;
  }
  locks.query().then(
    (state) => sweepScopes(now, new Set((state.held ?? []).flatMap((lock) => (lock.name?.startsWith(LOCK_PREFIX) ? [lock.name.slice(LOCK_PREFIX.length)] : [])))),
    () => sweepScopes(now, new Set()),
  );
}

/** `sweepStaleScopes`, the scopes in `open` passed over. */
function sweepScopes(now: number, open: ReadonlySet<string>): void {
  const head = `softn:${EPHEMERAL_XDB_PREFIX}`;
  try {
    const storage = globalThis.localStorage;
    if (!storage) return;
    const lastSeen = (id: string, made: number): number => {
      const alive = Number(storage.getItem(`${ALIVE_PREFIX}${id}`));
      return Number.isFinite(alive) && alive > 0 ? alive : made;
    };
    for (let i = storage.length - 1; i >= 0; i--) {
      const key = storage.key(i);
      if (key?.startsWith(ALIVE_PREFIX)) {
        if (!open.has(key.slice(ALIVE_PREFIX.length)) && !(now - Number(storage.getItem(key)) <= STALE_SCOPE_MS)) storage.removeItem(key);
        continue;
      }
      if (!key?.startsWith(head)) continue;
      const made = /^([0-9a-z]+)_(\d+):/.exec(key.slice(head.length));
      if (!made) continue;
      const id = `${EPHEMERAL_XDB_PREFIX}${made[1]}_${made[2]}`;
      if (!open.has(id) && now - lastSeen(id, parseInt(made[1], 36)) > STALE_SCOPE_MS) storage.removeItem(key);
    }
  } catch {
    // Storage refused: what is there stays.
  }
}

/**
 * Create a registered, memory-only database for an editor preview. Seed `xdb`
 * before mounting the renderer, then use this appId for the preview's lifetime.
 * It never hydrates or writes native SQLite, even inside the desktop Builder.
 */
export function createEphemeralXDBScope(): EphemeralXDBScope {
  sweepStaleScopes(Date.now());
  let appId: string;
  do {
    // The time it was made (which the sweep reads), then digits of its own: the count alone
    // started at 1 on every page, and two tabs making a preview in one millisecond shared its
    // script storage, which the first to let go took from the other.
    appId = `${EPHEMERAL_XDB_PREFIX}${Date.now().toString(36)}_${++ephemeralXDBSequence}${randomDigits(9)}`;
  } while (xdbInstances.has(appId));

  const values = new Map<string, string>();
  let disposed = false;
  const storage: XDBStorage = {
    getItem: (key) => disposed ? null : values.get(key) ?? null,
    setItem: (key, value) => { if (!disposed) values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
  const xdb = new XDBService(storage, `xdb:${appId}`, appId, { backend: 'storage' });
  xdbInstances.set(appId, xdb);
  // Said while it lives, so another tab's sweep leaves its script storage alone.
  markAlive(appId, Date.now());
  const alive = setInterval(() => markAlive(appId, Date.now()), ALIVE_EVERY_MS);
  (alive as { unref?: () => void }).unref?.();
  const letGo = holdWhileOpen(appId);

  return {
    appId,
    xdb,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      clearInterval(alive);
      letGo();
      if (xdbInstances.get(appId) === xdb) xdbInstances.delete(appId);
      xdb.destroy();
      values.clear();
      forgetScriptStorage(appId);
      markAlive(appId, null);
    },
  };
}

/**
 * A module-level pointer that once named the running app.
 *
 * Before the app scope existed (loader/app-scope.tsx), SoftNRenderer set this
 * during render and every no-argument getXDB() resolved through it. It named
 * whichever app had rendered most recently, not the app a caller was in, and
 * softn-web keeps every open tab mounted, so a handler that yielded in tab A
 * could resume after tab B re-rendered and write A's record into B's store.
 * Nothing in the loader sets it any more. getXDB(undefined) still honours it
 * only so that a test, or a host written before the scope existed, keeps the
 * behaviour it had.
 */
let activeAppId: string | undefined;

/**
 * Point the no-argument callers at an app; undefined restores the shared
 * default.
 *
 * @deprecated The loader no longer calls this. React code reads the app it
 * is in from the scope — useAppXDB(), or useCollection/useRecord, which
 * consult it — and a non-React caller must pass its appId to getXDB()
 * explicitly. Setting this moves every bare getXDB() while AppScope.appId
 * still reports what the renderer was given, so the two disagree. It remains
 * for tests and for legacy hosts only.
 */
export function setActiveXDBApp(appId?: string): void {
  activeAppId = appId;
}

/**
 * Storage keys are namespaced per app.
 *
 * Every bundle used to share the literal `xdb:` prefix, so opening a second
 * `.softn` gave it read *and delete* access to the first one's records —
 * `getAllCollectionKeys()` even enumerates them, so nothing had to be guessed.
 * The sibling localStorage bridge already namespaces as `softn:<appId>:`, and
 * SoftNRenderer documents per-app isolation as the intended design.
 */
function prefixFor(appId?: string): string {
  return appId ? `xdb:${appId}` : 'xdb';
}

export function getXDB(appId?: string): XDBService {
  const resolved = appId ?? activeAppId;
  const key = resolved || '_default';
  let instance = xdbInstances.get(key);
  if (!instance) {
    // A late callback from a closed preview must never create a persistent
    // database merely because its ephemeral registry entry was released.
    if (key.startsWith(EPHEMERAL_XDB_PREFIX)) {
      throw new Error('The preview database scope has been disposed.');
    }
    const migration = resolved ? migrateLegacyKeys(resolved) : 'none';
    instance = new XDBService(undefined, prefixFor(resolved), resolved);
    if (migration === 'incomplete') {
      instance._noteIssue({ kind: 'migration-incomplete', message: 'Older records could not all be copied into this app\'s storage (out of space). The original records were kept; free storage and reopen the app to finish.' });
    }
    xdbInstances.set(key, instance);
  }
  return instance;
}

/**
 * Adopt records written before storage was namespaced.
 *
 * Without this, upgrading silently empties every existing app. The legacy keys
 * are copied rather than moved because they may hold more than one app's
 * records — there is no way to tell whose is whose after the fact, and deleting
 * them would destroy data belonging to an app that has not been opened yet.
 * Copying preserves exactly the access each app already had while making all
 * subsequent writes private.
 *
 * The old keys are never deleted, the copy is VERIFIED before the namespace is
 * marked migrated, and an interrupted run (quota) leaves no marker so the next
 * open restarts it (audit SN-02).
 *
 * @returns 'none' (nothing to migrate), 'done' (verified) or 'incomplete'
 */
function migrateLegacyKeys(appId: string): 'none' | 'done' | 'incomplete' {
  let storage: Storage;
  try {
    if (typeof localStorage === 'undefined') return 'none';
    storage = localStorage;
  } catch { return 'none'; }

  const marker = `xdb-meta:${appId}:legacy-migration`;
  if (storage.getItem(marker) === 'done') return 'done';

  const legacy: Array<[string, string]> = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    // Only bare `xdb:<collection>` keys — anything with a second colon is
    // already namespaced and belongs to some app.
    if (!key || !key.startsWith('xdb:') || key.indexOf(':', 4) !== -1) continue;
    const value = storage.getItem(key);
    if (value) legacy.push([key.slice(4), value]);
  }
  if (legacy.length === 0) return 'none';

  let complete = true;
  for (const [collection, value] of legacy) {
    const target = `xdb:${appId}:${collection}`;
    if (storage.getItem(target) === null) {
      try {
        storage.setItem(target, value);
      } catch {
        // Out of quota: stop, keep the legacy keys, and report it. The next
        // open resumes from here because no marker was written.
        complete = false;
        break;
      }
    }
    if (storage.getItem(target) !== value && storage.getItem(target) === null) complete = false;
  }
  if (complete) {
    try { storage.setItem(marker, 'done'); } catch { /* the copy is verified; the marker only saves a re-check */ }
    return 'done';
  }
  return 'incomplete';
}

/**
 * Set a custom XDB instance as the default (or for a specific app)
 */
export function setDefaultXDB(xdb: XDBService, appId?: string): void {
  xdbInstances.set(appId || '_default', xdb);
}

/**
 * Create XDB module for script integration
 */
export function createXDBModule(xdb?: XDBService) {
  const db = xdb || getXDB();

  return {
    create: (collection: string, data: Record<string, unknown>) => {
      return db.create(collection, data);
    },
    createAsync: (collection: string, data: Record<string, unknown>) => {
      return db.createAsync(collection, data);
    },
    get: (collection: string, id: string) => {
      return db.get(collection, id);
    },
    getAsync: (collection: string, id: string) => {
      return db.getAsync(collection, id);
    },
    query: (collection: string, filter?: Record<string, unknown>) => {
      return db.query(collection, filter ? { filter } : undefined);
    },
    queryAsync: (collection: string, filter?: Record<string, unknown>) => {
      return db.queryAsync(collection, filter ? { filter } : undefined);
    },
    getAll: (collection: string) => {
      return db.getAll(collection);
    },
    getAllAsync: (collection: string) => {
      return db.getAllAsync(collection);
    },
    update: (id: string, data: Record<string, unknown>) => {
      return db.update(id, data);
    },
    updateAsync: (id: string, data: Record<string, unknown>) => {
      return db.updateAsync(id, data);
    },
    delete: (id: string) => {
      return db.delete(id);
    },
    deleteAsync: (id: string) => {
      return db.deleteAsync(id);
    },
    sync: (collection?: string) => {
      return db.sync(collection);
    },
    count: (collection: string) => {
      return db.count(collection);
    },
    clear: (collection: string) => {
      return db.clear(collection);
    },
    // P2P specific
    getNetworkStatus: () => {
      return db.getNetworkStatus();
    },
    isP2PAvailable: () => {
      return db.isP2PAvailable();
    },
  };
}
