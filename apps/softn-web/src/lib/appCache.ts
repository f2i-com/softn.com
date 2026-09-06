/**
 * IndexedDB App Cache — stores .softn bundles for offline/instant reload.
 * Uses the `idb` library for type-safe IndexedDB access.
 */

import { openDB, type IDBPDatabase, type IDBPObjectStore } from 'idb';

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
   * manifest name; see adoptLegacyRecord below. Sixteen hex characters on
   * records written before the full digest was kept; see adoptShortOrigin.
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
}

interface SoftNAppDB {
  'softn-apps': {
    key: string;
    value: CachedApp;
    indexes: { 'by-name': string; 'by-origin': string };
  };
}

// ── Identity ─────────────────────────────────────────────────────────

/** Length of the truncated digest earlier records were keyed by. */
const SHORT_ORIGIN_LENGTH = 16;
/** What an identity computed without a cryptographic hash is prefixed with. */
const INSECURE_ORIGIN_PREFIX = 'insecure-';

/**
 * Derive an app's identity from its contents.
 *
 * Identity used to be `manifest.name`, a string the bundle chooses for itself.
 * The cache upserted on it, permission grants hung off the record it found, and
 * the runtime used it to namespace the app's database — so a bundle that called
 * itself "Notes" was handed the real Notes' stored data, inherited whatever the
 * user had already granted it, and replaced its cached copy. None of that
 * required a flaw to exploit; it was the intended path, taken by an impostor.
 *
 * A digest cannot be claimed, only earned by being the bytes. The whole
 * SHA-256 is kept: it used to be cut to sixteen hex characters, which is
 * short enough that "same identity" and "same bytes" were no longer the same
 * claim, for a saving of forty-eight characters in a key. Display can
 * abbreviate; identity does not.
 */
export async function computeAppOrigin(bundleData: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    // Copy into a plain ArrayBuffer: a Uint8Array view over a larger buffer
    // would otherwise hash the whole buffer rather than the bundle.
    const bytes = new Uint8Array(bundleData);
    const digest = await subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
  // crypto.subtle needs a secure context. Without one this keeps apps isolated
  // from each other, which is the point, but it is NOT collision-resistant —
  // someone able to choose bundle bytes could aim at another app's namespace.
  // The prefix says so to everything that reads it: no grant is persisted
  // under such an identity (see recordPermissionGrant), and it can never
  // collide with a real digest's namespace. Serve the runtime over HTTPS or
  // localhost and this branch never runs.
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < bundleData.length; i++) {
    h1 = Math.imul(h1 ^ bundleData[i], 0x01000193) >>> 0;
    h2 = Math.imul(h2 + bundleData[i], 0x85ebca6b) >>> 0;
  }
  return INSECURE_ORIGIN_PREFIX + h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/**
 * Whether an identity was computed cryptographically, and so may carry
 * durable trust: a persisted permission grant, in particular.
 */
export function isSecureAppOrigin(origin: string | undefined): boolean {
  return Boolean(origin) && !origin!.startsWith(INSECURE_ORIGIN_PREFIX);
}

/** The first characters of an identity, for a label; never for a lookup. */
export function abbreviateOrigin(origin: string | undefined, length = 12): string {
  if (!origin) return '';
  return origin.startsWith(INSECURE_ORIGIN_PREFIX) ? origin : origin.slice(0, length);
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

function getDB(): Promise<IDBPDatabase<SoftNAppDB>> {
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
          // app is opened again. See adoptLegacyRecord.
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

// ── Public API ───────────────────────────────────────────────────────

/** Get all cached apps, sorted by lastOpened (most recent first) */
export async function getCachedApps(): Promise<CachedApp[]> {
  try {
    const db = await getDB();
    const apps = await db.getAll('softn-apps');
    return apps.sort((a, b) => b.lastOpened - a.lastOpened);
  } catch {
    return [];
  }
}

/** One app, and every build of it the browser is still holding. */
export interface AppVersions {
  name: string;
  /** Most recently opened first; the one the launcher shows. */
  current: CachedApp;
  /** Every build, newest opened first. Length 1 is the ordinary case. */
  versions: CachedApp[];
}

/**
 * Group the cache into one entry per app.
 *
 * Identity is a digest of the bundle, which is what stops a bundle calling
 * itself Notes from reaching the real Notes' data. The cost is that rebuilding
 * an app produces a genuinely different app, so the launcher filled up with
 * cards that all had the same name — every build of a demo sitting beside every
 * other. Both facts are worth keeping: the isolation, and one card per app. So
 * grouping is a presentation decision made here, and says nothing about what any
 * of these builds may read.
 */
export function groupByApp(apps: CachedApp[]): AppVersions[] {
  const groups = new Map<string, CachedApp[]>();
  for (const app of apps) {
    const list = groups.get(app.name);
    if (list) list.push(app);
    else groups.set(app.name, [app]);
  }
  return [...groups.entries()]
    .map(([name, versions]) => {
      const ordered = [...versions].sort((a, b) => b.lastOpened - a.lastOpened);
      return { name, current: ordered[0], versions: ordered };
    })
    .sort((a, b) => b.current.lastOpened - a.current.lastOpened);
}

// ── Stored data ──────────────────────────────────────────────────────
//
// An app's state lives in localStorage under two prefixes, both keyed by the
// origin above: `xdb:<origin>:<collection>` holds its records, and
// `softn:<origin>:<key>` holds what its script keeps through `localStorage`
// itself — a save slot, a cartridge's battery, the ticket for a seat at an
// online table. Everything that counts, moves, exports, imports or removes
// an app's data goes through `appDataStores` below, the one place that knows
// there are two. Export, migration and removal used to know the first alone:
// a backup of Pocket carried its records and not the game it had saved, an
// update brought the records forward and stranded the saves, and removing a
// build left them behind for nothing to reach or clear.

/** The two places a build keeps state, by name. */
export type AppDataStore = 'xdb' | 'local';

/** The prefix each store keeps one build's keys under. */
export function appDataStores(origin: string): Array<{ store: AppDataStore; prefix: string }> {
  return [
    { store: 'xdb', prefix: `xdb:${origin}:` },
    // The bridge folds anything outside [A-Za-z0-9_-] to `_` before it
    // prefixes. A digest never has any, but the two spellings must agree.
    { store: 'local', prefix: `softn:${origin.replace(/[^a-zA-Z0-9_-]/g, '_')}:` },
  ];
}

/** The outcome of moving or copying one app's stored keys to another identity. */
export interface DataTransferResult {
  /** Every key was written (and, for a move, removed from its source). */
  ok: boolean;
  /** Keys written to the destination. Equal to `total` when `ok`. */
  copied: number;
  /** Keys found under the source. */
  total: number;
  /** Keys the destination already had, left as they were. */
  skipped: number;
  /** Why it stopped, when it did. */
  error?: string;
  /** A machine-readable reason, where a caller decides differently on it. */
  code?: string;
}

function keysWithPrefix(prefix: string): string[] {
  // Snapshot the keys first: writing to localStorage while iterating its
  // indices is how you skip half of them.
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith(prefix)) keys.push(key);
  }
  return keys;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Copy (or move) every key under one identity to another, whole or not at all.
 *
 * localStorage has no transactions, so this makes its own: every write is
 * recorded, and a write that fails — quota, most often, part way through a
 * large save — undoes the ones before it, restoring whatever the destination
 * held. The source is not touched until every destination key is in place, so
 * a move that fails is a copy that failed: nothing has been lost. Copying
 * used to stop at the first failure and report how far it got, and the
 * caller opened the updated app on top of a destination holding some of the
 * old records and none of the rest.
 *
 * Keys the destination already has are kept (`overwrite: false`): an update
 * that has been used has data of its own, and this must never write over it.
 */
export function transferStorageKeys(
  fromPrefix: string,
  toPrefix: string,
  options: { move: boolean; overwrite: boolean }
): DataTransferResult {
  return transferStorageRuns([{ from: fromPrefix, to: toPrefix }], options);
}

/**
 * The same, over several prefix pairs as one unit: both of a build's stores
 * move together, and the destination is as it was unless every key of every
 * pair was written.
 */
function transferStorageRuns(
  runs: Array<{ from: string; to: string }>,
  options: { move: boolean; overwrite: boolean }
): DataTransferResult {
  const result: DataTransferResult = { ok: false, copied: 0, total: 0, skipped: 0 };
  let keys: Array<{ key: string; target: string }>;
  try {
    keys = runs.flatMap((run) =>
      keysWithPrefix(run.from).map((key) => ({ key, target: run.to + key.slice(run.from.length) }))
    );
  } catch (err) {
    result.error = `Stored data could not be read: ${describeError(err)}`;
    return result;
  }
  result.total = keys.length;

  // What each destination key held before this transfer, so it can be put
  // back: `null` for a key that did not exist.
  const written: Array<{ key: string; previous: string | null }> = [];
  const rollback = (): void => {
    for (let i = written.length - 1; i >= 0; i--) {
      const { key, previous } = written[i];
      try {
        if (previous === null) localStorage.removeItem(key);
        else localStorage.setItem(key, previous);
      } catch {
        // Undoing a write that succeeded moments ago should not fail; if it
        // does there is nothing further to do about it here.
      }
    }
  };

  try {
    for (const { key, target } of keys) {
      const value = localStorage.getItem(key);
      if (value === null) continue;
      const previous = localStorage.getItem(target);
      if (previous !== null && !options.overwrite) {
        result.skipped += 1;
        continue;
      }
      if (previous === value) {
        // Already there, byte for byte. Nothing to write, nothing to undo.
        result.copied += 1;
        continue;
      }
      localStorage.setItem(target, value);
      written.push({ key: target, previous });
      result.copied += 1;
    }
  } catch (err) {
    rollback();
    result.copied = 0;
    result.error = `Stored data could not be written: ${describeError(err)}`;
    return result;
  }

  if (options.move) {
    // Every destination key is in place; only now does the source go. A
    // failure here leaves duplicates, which is recoverable, rather than a
    // gap, which is not.
    for (const { key } of keys) {
      try {
        localStorage.removeItem(key);
      } catch {
        // Leave it; the next migration will find it already copied.
      }
    }
  }
  result.ok = true;
  return result;
}

/** Both of one build's stores to another build's, as one transfer. */
function transferAppData(
  fromOrigin: string,
  toOrigin: string,
  options: { move: boolean; overwrite: boolean }
): DataTransferResult {
  const to = appDataStores(toOrigin);
  return transferStorageRuns(
    appDataStores(fromOrigin).map((from, i) => ({ from: from.prefix, to: to[i].prefix })),
    options
  );
}

/**
 * Copy one build's stored data onto another.
 *
 * This is the "bring my data with me" half of an update. Nothing can prove two
 * bundles share an author, so the runtime will not do this by itself — but the
 * person who chose to install the update can say so, and this is what carries
 * their records across. It copies rather than moves, so the older build still
 * has its own data to go back to if the update turns out to be wrong.
 *
 * All or nothing: on failure the destination is as it was, and `ok` is
 * false. The caller decides what to tell the user; it must not open the
 * update as though the data came with it.
 */
export function copyAppData(fromOrigin: string, toOrigin: string): DataTransferResult {
  if (!fromOrigin || !toOrigin || fromOrigin === toOrigin) {
    return { ok: false, copied: 0, total: 0, skipped: 0, error: 'Nothing to copy between these builds.' };
  }
  return transferAppData(fromOrigin, toOrigin, { move: false, overwrite: false });
}

/** Whether a build has any stored state of its own, in either store, i.e. whether it has been used. */
export function hasStoredData(origin: string | undefined): boolean {
  if (!origin) return false;
  try {
    return appDataStores(origin).some(({ prefix }) => keysWithPrefix(prefix).length > 0);
  } catch {
    return false;
  }
}

/**
 * Move an app's stored data from one identity to another.
 *
 * Keys are prefixed by appId, and appId used to be the manifest name, then a
 * truncated digest. Without this, everything a user had saved in an app would
 * be orphaned the moment identity changed — their notes would still be on
 * disk, under a prefix nothing reads any more. Copies first and removes the
 * source only once every key is in place, so an interrupted migration leaves
 * the original where it was.
 */
function migrateAppStorage(fromAppId: string, toAppId: string): DataTransferResult {
  if (fromAppId === toAppId) return { ok: true, copied: 0, total: 0, skipped: 0 };
  return transferAppData(fromAppId, toAppId, { move: true, overwrite: false });
}

// ── Portable data ────────────────────────────────────────────────────
//
// A build's state, as a file: to keep, to move to another browser, to put
// back after an update went wrong. The file names the build it came from,
// and importing it is whole or not at all — a corrupt file, or a write that
// fails part way, leaves the build's data exactly as it was, and so does a
// browser that dies part way, which the journal below is for. What must
// never happen is a failed import quietly turning into an empty app.

export const APP_DATA_FORMAT = 'softn-app-data';
/**
 * Format 1 carried the XDB records alone, as `entries`. Format 2 carries both
 * stores, each under its name in `stores`; a format-1 file is read as records
 * with no saved keys, which is exactly what it was.
 */
export const APP_DATA_VERSION = 2;

export interface AppDataSnapshot {
  format: typeof APP_DATA_FORMAT;
  version: typeof APP_DATA_VERSION;
  app: { name: string; version: string; origin: string };
  exportedAt: number;
  /** Every key of each store, with the store's prefix removed, and its value as stored. */
  stores: Record<AppDataStore, Record<string, string>>;
}

/** How many keys a snapshot holds, across its stores. */
export function snapshotEntryCount(snapshot: Pick<AppDataSnapshot, 'stores'>): number {
  return Object.values(snapshot.stores).reduce((n, entries) => n + Object.keys(entries).length, 0);
}

/** This build's state as a snapshot, or null where the build has no identity or storage is unreadable. */
export function exportAppData(app: Pick<CachedApp, 'name' | 'version' | 'origin'>, now = Date.now()): AppDataSnapshot | null {
  if (!app.origin) return null;
  const stores: AppDataSnapshot['stores'] = { xdb: {}, local: {} };
  try {
    for (const { store, prefix } of appDataStores(app.origin)) {
      for (const key of keysWithPrefix(prefix)) {
        const value = localStorage.getItem(key);
        if (value !== null) stores[store][key.slice(prefix.length)] = value;
      }
    }
  } catch {
    return null;
  }
  return {
    format: APP_DATA_FORMAT,
    version: APP_DATA_VERSION,
    app: { name: app.name, version: app.version, origin: app.origin },
    exportedAt: now,
    stores,
  };
}

export type SnapshotRead = { ok: true; snapshot: AppDataSnapshot } | { ok: false; error: string };

/** The keys of one store, checked: names that can be stored, values that are stored text. */
function readEntries(value: unknown, what: string): { ok: true; entries: Record<string, string> } | { ok: false; error: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: `The export holds no ${what}.` };
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!key || key.split('').some((c) => c.charCodeAt(0) < 32)) return { ok: false, error: 'The export has a record with an unusable name.' };
    if (typeof entry !== 'string') return { ok: false, error: `The export's record "${key}" is not stored text; the file is corrupt.` };
  }
  return { ok: true, entries: value as Record<string, string> };
}

/**
 * A file that claims to be an export, checked before anything is touched.
 * Every refusal says what was wrong; none of them is silent.
 */
export function readAppDataSnapshot(text: string): SnapshotRead {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: 'The file is not JSON, so it is not a SoftN data export.' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'The file does not hold a SoftN data export.' };
  }
  const s = parsed as Record<string, unknown>;
  if (s.format !== APP_DATA_FORMAT) return { ok: false, error: 'The file is not a SoftN data export.' };
  if (typeof s.version !== 'number') return { ok: false, error: 'The export does not say which format it is in.' };
  if (s.version > APP_DATA_VERSION) {
    return { ok: false, error: `This export was made by a newer runtime (format ${s.version}) and cannot be read here.` };
  }
  if (s.version !== 1 && s.version !== APP_DATA_VERSION) {
    return { ok: false, error: `This export's format (${s.version}) is not one this runtime reads.` };
  }
  const app = s.app as Record<string, unknown> | undefined;
  if (!app || typeof app !== 'object' || typeof app.name !== 'string' || typeof app.version !== 'string' || typeof app.origin !== 'string' || !app.origin) {
    return { ok: false, error: 'The export does not say which app it came from.' };
  }
  let stores: AppDataSnapshot['stores'];
  if (s.version === 1) {
    const xdb = readEntries(s.entries, 'records');
    if (!xdb.ok) return xdb;
    stores = { xdb: xdb.entries, local: {} };
  } else {
    const holder = s.stores;
    if (!holder || typeof holder !== 'object' || Array.isArray(holder)) return { ok: false, error: 'The export holds no records.' };
    const xdb = readEntries((holder as Record<string, unknown>).xdb ?? {}, 'records');
    if (!xdb.ok) return xdb;
    const local = readEntries((holder as Record<string, unknown>).local ?? {}, 'saved keys');
    if (!local.ok) return local;
    stores = { xdb: xdb.entries, local: local.entries };
  }
  return {
    ok: true,
    snapshot: {
      format: APP_DATA_FORMAT,
      version: APP_DATA_VERSION,
      app: { name: app.name, version: app.version, origin: app.origin },
      exportedAt: typeof s.exportedAt === 'number' ? s.exportedAt : 0,
      stores,
    },
  };
}

/**
 * Where an interrupted import leaves what it was replacing, so the next
 * start can put it back. One key per import in flight; see
 * recoverInterruptedImports.
 */
const RESTORE_JOURNAL_PREFIX = 'softn-web:restore:';

interface RestoreJournal {
  /** The prefixes being replaced: everything under them is the import's, or nothing is. */
  prefixes: string[];
  /** Every key under those prefixes before the import, with its value. */
  previous: Array<[string, string]>;
  at: number;
}

/**
 * Replace everything under each prefix with the given entries, whole or not
 * at all — including across a crash.
 *
 * Rolling back from an in-memory copy handles a write that throws, and
 * nothing else: a tab killed between removing the old keys and finishing
 * the new ones used to leave a build with some of neither. So the old keys
 * are written to a journal in storage first. If the journal cannot be
 * written — quota, usually — nothing has been touched and the import is
 * refused. If the browser dies after it, the next start finds the journal
 * and puts the old keys back (recoverInterruptedImports); if a write fails
 * here, the same is done at once. Only once every new key is in place does
 * the journal go, and with it the last way to see the old state.
 */
export function replaceStorageRuns(runs: Array<{ prefix: string; entries: Record<string, string> }>): DataTransferResult {
  const result: DataTransferResult = {
    ok: false,
    copied: 0,
    total: runs.reduce((n, run) => n + Object.keys(run.entries).length, 0),
    skipped: 0,
  };
  let previous: Array<[string, string]>;
  try {
    previous = runs.flatMap(({ prefix }) => keysWithPrefix(prefix).map((key) => [key, localStorage.getItem(key) ?? ''] as [string, string]));
  } catch (err) {
    result.error = `Stored data could not be read: ${describeError(err)}`;
    return result;
  }

  const journalKey = `${RESTORE_JOURNAL_PREFIX}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const journal: RestoreJournal = { prefixes: runs.map((run) => run.prefix), previous, at: Date.now() };
  try {
    localStorage.setItem(journalKey, JSON.stringify(journal));
  } catch (err) {
    result.error = `Nothing was changed: there is no room to keep a copy of the data being replaced, which an import needs so it can be undone. ${describeError(err)}`;
    return result;
  }

  const written: string[] = [];
  const restore = (): void => {
    for (const key of written) {
      try {
        localStorage.removeItem(key);
      } catch {
        // Nothing more to do for a key that will not go.
      }
    }
    for (const [key, value] of previous) {
      try {
        localStorage.setItem(key, value);
      } catch {
        // The old value fitted before the import began; if it does not now,
        // the journal still holds it for the next start.
        return;
      }
    }
    try {
      localStorage.removeItem(journalKey);
    } catch {
      // Left in place, the journal is replayed at the next start: harmless.
    }
  };
  try {
    for (const [key] of previous) localStorage.removeItem(key);
    for (const { prefix, entries } of runs) {
      for (const [suffix, value] of Object.entries(entries)) {
        const key = prefix + suffix;
        localStorage.setItem(key, value);
        written.push(key);
        result.copied += 1;
      }
    }
  } catch (err) {
    restore();
    result.copied = 0;
    result.error = `Stored data could not be written: ${describeError(err)}`;
    return result;
  }
  try {
    localStorage.removeItem(journalKey);
  } catch {
    // Removing frees space and does not fail in practice. If it ever did,
    // the next start would put the old keys back over the new ones, which
    // is the wrong answer but a complete one; see recoverInterruptedImports.
  }
  result.ok = true;
  return result;
}

/**
 * Replace everything under `prefix` with `entries`, whole or not at all.
 * The one-prefix form of replaceStorageRuns.
 */
export function replaceStorageKeys(prefix: string, entries: Record<string, string>): DataTransferResult {
  return replaceStorageRuns([{ prefix, entries }]);
}

/**
 * Finish what an interrupted import left, once, before any app opens: every
 * journal still in storage names an import that did not reach its end, and
 * the keys it holds are the state the build had before it. Those go back,
 * the import's partial keys go, and the journal goes. Returns how many
 * builds were put back.
 */
export function recoverInterruptedImports(): number {
  let recovered = 0;
  let journals: string[];
  try {
    journals = keysWithPrefix(RESTORE_JOURNAL_PREFIX);
  } catch {
    return 0;
  }
  for (const journalKey of journals) {
    try {
      const journal = JSON.parse(localStorage.getItem(journalKey) ?? 'null') as RestoreJournal | null;
      if (!journal || !Array.isArray(journal.prefixes) || !Array.isArray(journal.previous)) {
        localStorage.removeItem(journalKey);
        continue;
      }
      for (const prefix of journal.prefixes) {
        if (typeof prefix !== 'string' || !prefix) continue;
        for (const key of keysWithPrefix(prefix)) localStorage.removeItem(key);
      }
      for (const entry of journal.previous) {
        if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string') {
          localStorage.setItem(entry[0], entry[1]);
        }
      }
      localStorage.removeItem(journalKey);
      recovered += 1;
      console.warn('[SoftN Web] An import of app data was interrupted; the data it was replacing has been put back.');
    } catch (err) {
      console.warn('[SoftN Web] Could not finish recovering an interrupted import:', err);
    }
  }
  return recovered;
}

/**
 * Put a snapshot's state into a build, replacing what it has, in both
 * stores. A snapshot from a different build is refused unless the caller
 * says the person importing it knows — the file names the build it came
 * from, and the runtime cannot tell whether two builds are related; only
 * they can.
 */
export function importAppData(
  snapshot: AppDataSnapshot,
  app: Pick<CachedApp, 'origin'>,
  options: { allowDifferentApp?: boolean } = {}
): DataTransferResult {
  const total = snapshotEntryCount(snapshot);
  if (!app.origin) {
    return { ok: false, copied: 0, total, skipped: 0, code: 'NO_IDENTITY', error: 'This build has no identity to import data into.' };
  }
  if (snapshot.app.origin !== app.origin && !options.allowDifferentApp) {
    return {
      ok: false,
      copied: 0,
      total,
      skipped: 0,
      code: 'DIFFERENT_APP',
      error: `This data was exported from "${snapshot.app.name}" v${snapshot.app.version}, a different build.`,
    };
  }
  return replaceStorageRuns(appDataStores(app.origin).map(({ store, prefix }) => ({ prefix, entries: snapshot.stores[store] ?? {} })));
}

// ── Adoption of older records ────────────────────────────────────────

type AppStore = IDBPObjectStore<SoftNAppDB, ['softn-apps'], 'softn-apps', 'readwrite'>;

/**
 * What the pre-transaction look-around found: a record written under an
 * earlier identity scheme that these bytes may claim. Hashing is
 * asynchronous, and an IndexedDB transaction commits the moment nothing is
 * pending on it, so every digest is computed before the transaction opens
 * and the record is read again inside it before anything is written.
 */
interface Adoption {
  /** The record as it was when found; re-read and compared before use. */
  record: CachedApp;
  /** The identity its stored data lives under today. */
  fromAppId: string;
  /** Carry the consent record across? Only where the bytes are provably the same. */
  carryGrants: boolean;
  why: string;
}

function sameRecord(a: CachedApp, b: CachedApp | undefined): boolean {
  return Boolean(b) && a.id === b!.id && a.origin === b!.origin && a.cachedAt === b!.cachedAt && a.bundleData.byteLength === b!.bundleData.byteLength;
}

/**
 * A record from before identity existed, which these exact bytes may claim.
 *
 * A record with this name and no origin was cached before identity moved off
 * the manifest name. The user installed it themselves, so a bundle turning up
 * under that name afterwards is probably theirs — but "probably" was doing
 * too much work: adoption used to go to the first bundle to arrive with the
 * name, whatever its bytes, and it took the old record's stored data with it.
 * A name is not authority. Now the cached bytes are hashed and only the same
 * bytes adopt the record; different bytes are a different app, cached beside
 * it, and the legacy record is upgraded to its own digest identity so the
 * launcher can offer its data through the explicit "bring my data forward"
 * flow, where the person who installed both can say they are related.
 */
async function findLegacyAdoption(db: IDBPDatabase<SoftNAppDB>, name: string, origin: string): Promise<Adoption | null> {
  const sameName = await db.getAllFromIndex('softn-apps', 'by-name', name);
  const legacy = sameName.find((app) => !app.origin);
  if (!legacy) return null;
  const legacyOrigin = await computeAppOrigin(legacy.bundleData);
  if (legacyOrigin === origin) {
    return { record: legacy, fromAppId: name, carryGrants: false, why: 'adopted its content identity' };
  }
  return null;
}

/**
 * Give a name-keyed legacy record an identity of its own, without adopting it.
 *
 * Called when a different bundle has arrived under the legacy record's name:
 * the record cannot stay name-keyed, because the next bundle with that name
 * would try to adopt it too, and it cannot be handed to this bundle. Its data
 * moves from the name namespace to its own digest's, so it is reachable by
 * the launcher's version chips and its data-transfer flow. Grants are dropped
 * as they always were on adoption: they were keyed by a name.
 */
async function findLegacyUpgrade(db: IDBPDatabase<SoftNAppDB>, name: string): Promise<(Adoption & { toOrigin: string }) | null> {
  const sameName = await db.getAllFromIndex('softn-apps', 'by-name', name);
  const legacy = sameName.find((app) => !app.origin);
  if (!legacy) return null;
  const legacyOrigin = await computeAppOrigin(legacy.bundleData);
  return { record: legacy, fromAppId: name, carryGrants: false, why: 'was given its own identity', toOrigin: legacyOrigin };
}

/**
 * A record keyed by the sixteen-character digest earlier versions kept.
 *
 * The full digest of these bytes starts with that prefix, and the record's
 * own bytes hash to the full digest too, so this is the same app under a
 * shorter name for itself. Its data and its grants come across: the user
 * approved these bytes, and these are the bytes.
 */
async function findShortOriginAdoption(db: IDBPDatabase<SoftNAppDB>, origin: string): Promise<Adoption | null> {
  if (!isSecureAppOrigin(origin) || origin.length <= SHORT_ORIGIN_LENGTH) return null;
  const short = origin.slice(0, SHORT_ORIGIN_LENGTH);
  const candidate = await db.getFromIndex('softn-apps', 'by-origin', short);
  if (!candidate) return null;
  const full = await computeAppOrigin(candidate.bundleData);
  if (full !== origin) return null;
  return { record: candidate, fromAppId: short, carryGrants: true, why: 'kept under its full digest' };
}

/**
 * Apply an adoption inside the write transaction: re-read the record, make
 * sure it is the one that was examined, move its data, and return the record
 * to write under the new identity. Returns null if the record changed in the
 * meantime or its data could not be moved, in which case the caller treats
 * the bundle as new and the old record is left exactly as it was.
 */
async function applyAdoption(store: AppStore, adoption: Adoption, origin: string): Promise<CachedApp | null> {
  const current = await store.get(adoption.record.id);
  if (!sameRecord(adoption.record, current)) return null;
  const moved = migrateAppStorage(adoption.fromAppId, origin);
  if (!moved.ok) {
    console.warn(`[SoftN Web] "${current!.name}" keeps its earlier identity: ${moved.error}`);
    return null;
  }
  console.info(
    `[SoftN Web] "${current!.name}" ${adoption.why}${moved.copied ? `, moving ${moved.copied} stored keys` : ''}.`
  );
  if (adoption.carryGrants) return { ...current!, origin };
  // Everything on a name-keyed record was keyed by a name the bundle chose
  // for itself, so its consent record cannot be carried over: the spread
  // would hand whatever now claims that name the capabilities the user
  // approved for the old one. Data and icon move, approval does not — the
  // app asks again.
  const { grantedPermissions: _dropped, permissionsPromptedAt: _alsoDropped, ...carried } = current!;
  return { ...carried, origin };
}

/** Cache a new app, or update the one with these exact contents. */
export async function cacheApp(
  bundleData: Uint8Array,
  manifest: { name: string; version: string; description?: string },
  icon?: string,
  directorySlug?: string,
  requestedCapabilities?: string[]
): Promise<CachedApp | null> {
  try {
    const db = await getDB();
    const origin = await computeAppOrigin(bundleData);

    // Everything that hashes happens here, before the transaction: an
    // IndexedDB transaction commits as soon as nothing is pending on it, so
    // an `await` on crypto inside one would leave the later `put` with a
    // transaction that had already closed. Each candidate is re-read and
    // checked inside the transaction before it is acted on.
    let adoption: Adoption | null = null;
    let legacyUpgrade: (Adoption & { toOrigin: string }) | null = null;
    const already = await db.getFromIndex('softn-apps', 'by-origin', origin);
    if (!already) {
      adoption = (await findShortOriginAdoption(db, origin)) ?? (await findLegacyAdoption(db, manifest.name, origin));
      if (!adoption) legacyUpgrade = await findLegacyUpgrade(db, manifest.name);
    }

    // Read and write in one transaction. Split across two, this raced
    // recordPermissionGrant: opening the same app in a second tab read the
    // record before the grant landed, then wrote its stale spread back over
    // it — and the user's Allow was gone, with the bar up again next launch.
    // recordPermissionGrant was made atomic; this is its other half.
    const tx = db.transaction('softn-apps', 'readwrite');
    const store = tx.objectStore('softn-apps');

    // Same bytes as something already cached: the same app, opened again.
    // Matching on origin rather than name is the whole fix — an impostor no
    // longer lands on the record, the grants or the data of the app it names.
    let existing = await store.index('by-origin').get(origin);
    if (!existing && adoption) existing = (await applyAdoption(store, adoption, origin)) ?? undefined;

    if (existing) {
      const updated: CachedApp = {
        ...existing,
        origin,
        version: manifest.version,
        description: manifest.description,
        bundleData,
        lastOpened: Date.now(),
        icon: icon ?? existing.icon,
        directorySlug: directorySlug ?? existing.directorySlug,
        requestedCapabilities: requestedCapabilities ?? existing.requestedCapabilities,
      };
      await store.put(updated);
      await tx.done;
      return updated;
    }

    // A legacy record shares this name but not these bytes. It keeps its
    // data and gets an identity of its own; this bundle is cached beside it.
    if (legacyUpgrade) {
      const upgraded = await applyAdoption(store, legacyUpgrade, legacyUpgrade.toOrigin);
      if (upgraded) await store.put(upgraded);
    }

    // A different bundle that happens to share a name is a different app, and is
    // stored as one. Both appear in the launcher; neither can reach the other's
    // data or its granted permissions.
    const app: CachedApp = {
      id: crypto.randomUUID(),
      origin,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      bundleData,
      cachedAt: Date.now(),
      lastOpened: Date.now(),
      icon,
      directorySlug,
      requestedCapabilities,
    };
    await store.add(app);
    await tx.done;
    return app;
  } catch (err) {
    console.warn('[SoftN Web] Failed to cache app:', manifest.name, err);
    return null;
  }
}

/** Get a single cached app by ID */
export async function getCachedApp(id: string): Promise<CachedApp | null> {
  try {
    const db = await getDB();
    return (await db.get('softn-apps', id)) ?? null;
  } catch {
    return null;
  }
}

/**
 * Delete everything one build of an app has stored.
 *
 * Removing a cached app used to drop the record and leave its records behind:
 * keys under an origin nothing referenced any more, which no screen could show
 * and no action could clear. Every removal leaked, and versions accumulating
 * made it worse. Removing a build now removes what it saved, in both stores:
 * the records, and the keys its script kept through localStorage itself,
 * which the first version of this left behind.
 */
export function removeAppData(origin: string | undefined): number {
  if (!origin) return 0;
  let removed = 0;
  try {
    for (const { prefix } of appDataStores(origin)) {
      for (const key of keysWithPrefix(prefix)) {
        localStorage.removeItem(key);
        removed += 1;
      }
    }
  } catch {
    // Storage unavailable; the cache record still goes.
  }
  return removed;
}

export async function removeCachedApp(id: string): Promise<void> {
  try {
    const db = await getDB();
    await db.delete('softn-apps', id);
  } catch {
    console.warn('[SoftN Web] Failed to remove cached app:', id);
  }
}

/**
 * A cached app by name: the most recently opened of any that share it.
 *
 * For the one place a name is all there is — the address bar, offline, with
 * `/app/<name>` and no directory to ask. Never for anything that decides what
 * an app may read; that is getCachedAppByOrigin.
 */
export async function getCachedAppByName(name: string): Promise<CachedApp | null> {
  try {
    const db = await getDB();
    const matches = await db.getAllFromIndex('softn-apps', 'by-name', name);
    if (matches.length === 0) return null;
    return matches.sort((a, b) => b.lastOpened - a.lastOpened)[0];
  } catch {
    return null;
  }
}

/**
 * Find a cached app by what it is rather than what it is called.
 *
 * This is the lookup that anything security-relevant must use — a permission
 * grant belongs to the bundle the user approved, not to every bundle that
 * later adopts its name.
 */
export async function getCachedAppByOrigin(origin: string): Promise<CachedApp | null> {
  try {
    const db = await getDB();
    return (await db.getFromIndex('softn-apps', 'by-origin', origin)) ?? null;
  } catch {
    return null;
  }
}

/** Update the lastOpened timestamp */
export async function updateLastOpened(id: string): Promise<void> {
  try {
    const db = await getDB();
    const app = await db.get('softn-apps', id);
    if (app) {
      app.lastOpened = Date.now();
      await db.put('softn-apps', app);
    }
  } catch {
    // Non-critical, ignore
  }
}

/**
 * Record that the user granted these capabilities to the bundle with this origin.
 *
 * Keyed by origin and read-modify-written inside one transaction. Both matter
 * now that consent arrives from a bar the user may click minutes after the app
 * loaded: an `id` captured at load time can point at a record `cacheApp` has
 * since replaced, and a get/put pair in two transactions loses the grant to any
 * `cacheApp` for the same origin that interleaves — silently, so the user is
 * asked again next session having already agreed.
 *
 * Writes nothing if no record exists: the user removed the app from Home while
 * its tab was open, and resurrecting it would undo that. The running instance
 * keeps its grant in memory either way.
 *
 * Writes nothing for an identity computed without a cryptographic hash (an
 * insecure context). A grant is durable trust in exactly these bytes, and an
 * identity that other bytes could be made to share cannot carry it; the bar
 * asks again next session, which is the honest outcome.
 */
export async function recordPermissionGrant(origin: string, perms: Record<string, boolean>): Promise<boolean> {
  if (!isSecureAppOrigin(origin)) {
    console.warn('[SoftN Web] Not remembering a grant for an app identified without a secure context; it will be asked again next time.');
    return false;
  }
  try {
    const db = await getDB();
    const tx = db.transaction('softn-apps', 'readwrite');
    const store = tx.objectStore('softn-apps');
    const app = await store.index('by-origin').get(origin);
    if (app) {
      app.grantedPermissions = perms;
      // A grant was recorded. Never "a prompt was shown" — nothing about
      // displaying the consent bar is written down, so dismissing it leaves no
      // trace that could later be mistaken for an answer.
      app.permissionsPromptedAt = Date.now();
      await store.put(app);
    }
    await tx.done;
    return Boolean(app);
  } catch {
    console.warn('[SoftN Web] Failed to record permission grant for origin:', origin);
    return false;
  }
}
