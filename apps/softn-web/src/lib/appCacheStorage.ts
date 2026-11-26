/**
 * An app's stored data in localStorage, its records and its script's own
 * keys, counted, copied, moved and removed as one unit per build.
 * Re-exported by ./appCache.
 */

// ── Stored data ──────────────────────────────────────────────────────
//
// An app's state lives in localStorage under two prefixes, both keyed by its
// origin (computeAppOrigin, ./appCacheIdentity): `xdb:<origin>:<collection>` holds its records, and
// `softn:<origin>:<key>` holds what its script keeps through `localStorage`
// itself — a save slot, a cartridge's battery, the ticket for a seat at an
// online table — and, under `softn:<origin>:v2:`, everything a web container
// keeps (containerStoragePrefix). Everything that counts, moves, exports, imports or removes
// an app's data goes through `appDataStores` below, the one place that knows
// there are two. Export, migration and removal used to know the first alone:
// a backup of Pocket carried its records and not the game it had saved, an
// update brought the records forward and stranded the saves, and removing a
// build left them behind for nothing to reach or clear.

/** The two places a build keeps state, by name. */
export type AppDataStore = 'xdb' | 'local';

/**
 * The notes XDB keeps beside a build's records (`xdb:<origin>::<name>`), as
 * what follows the prefix: its collections' list, peer and server sync's
 * marks and queues (xdb-service.ts, xdb-server-sync.ts) and a bundle's seeds
 * (bundle.ts). A new one is added here, or a move leaves it behind.
 */
const XDB_NOTE = /^:(?:collections|p2p-room|sync-queue|sync-pulled|sync-watched|sync-unheard|(?:removals|seeded):[^:]+)$/;

/** One store of a build: the prefix its keys are under, and which keys under it are its own. */
export interface AppDataStoreKeys {
  store: AppDataStore;
  prefix: string;
  owns: (rest: string) => boolean;
}

/**
 * The prefix a build's own localStorage keys are under. The bridge folds anything outside
 * [A-Za-z0-9_-] to `_` before it prefixes; a digest never has any, but the two spellings
 * must agree. Folded, the prefix has no ":" in it to run into another's.
 */
export function localStorePrefix(origin: string): string {
  return `softn:${origin.replace(/[^a-zA-Z0-9_-]/g, '_')}:`;
}

/**
 * Where a web container keeps a build's data: inside the build's own local store, under
 * `v2:`. So everything here that counts, copies, exports or removes a build's data covers
 * a container's as it does any other app's. The container's own default (`softn-v2:<id>:`)
 * is a prefix nothing here knew: removing such an app left its data behind, and an update
 * that brought the data forward brought none.
 */
export function containerStoragePrefix(origin: string): string {
  return `${localStorePrefix(origin)}v2:`;
}

/** The prefix each store keeps one build's keys under. */
export function appDataStores(origin: string): AppDataStoreKeys[] {
  return [
    // A key under `xdb:<origin>:` is the build's when what follows is one of
    // its collections (a collection name has no ":") or one of its store's
    // own notes (`xdb:<origin>::<name>`, XDB_NOTE). An identity an earlier
    // build had, the manifest's name, may begin another's: `xdb:Notes:` began
    // the records of an app called "Notes:Pro" (`xdb:Notes:Pro:tasks`), and of
    // one called "Notes:" (`xdb:Notes::tasks`), and moving Notes's data to its
    // digest took them too.
    { store: 'xdb', prefix: `xdb:${origin}:`, owns: (rest) => !rest.includes(':') || XDB_NOTE.test(rest) },
    // What the build's script kept through localStorage (localStorePrefix), a web
    // container's data among it (containerStoragePrefix).
    { store: 'local', prefix: localStorePrefix(origin), owns: () => true },
  ];
}

/**
 * The keys of one store of a build: under its prefix, and its own. `all`: every
 * stored key, read once already (`storedKeys`), for a caller asking of many builds.
 */
export function storeKeys({ prefix, owns }: Pick<AppDataStoreKeys, 'prefix' | 'owns'>, all?: readonly string[]): string[] {
  return keysWithPrefix(prefix, all).filter((key) => owns(key.slice(prefix.length)));
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

export function keysWithPrefix(prefix: string, all?: readonly string[]): string[] {
  if (all) return all.filter((key) => key.startsWith(prefix));
  // Snapshot the keys first: writing to localStorage while iterating its
  // indices is how you skip half of them.
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith(prefix)) keys.push(key);
  }
  return keys;
}

/**
 * Every stored key, read once, for a reader that asks the same of many builds
 * in one go: Home, which asks of each build on each card whether it holds
 * data, and walked every key for each question, six times for an older build
 * on every drawing. Undefined where storage cannot be read: each question then
 * reads, and fails, as it always has.
 */
export function storedKeys(): string[] | undefined {
  try {
    return keysWithPrefix('');
  } catch {
    return undefined;
  }
}

export function describeError(err: unknown): string {
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
  runs: Array<{ from: string; to: string; owns?: (rest: string) => boolean }>,
  options: { move: boolean; overwrite: boolean }
): DataTransferResult {
  const result: DataTransferResult = { ok: false, copied: 0, total: 0, skipped: 0 };
  let keys: Array<{ key: string; target: string }>;
  try {
    keys = runs.flatMap((run) =>
      storeKeys({ prefix: run.from, owns: run.owns ?? (() => true) }).map((key) => ({ key, target: run.to + key.slice(run.from.length) }))
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
    appDataStores(fromOrigin).map((from, i) => ({ from: from.prefix, to: to[i].prefix, owns: from.owns })),
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

/**
 * The notes among XDB_NOTE that are sync's: the room a build is in, what it
 * has queued to send, how far it has pulled, and the removals it has still
 * to tell others of.
 */
const SYNC_NOTE = /^:(?:p2p-room|sync-queue|sync-pulled|sync-watched|sync-unheard|removals:[^:]+)$/;

/**
 * Forget where a build stood with sync, and keep its records.
 *
 * For a copy a person makes of someone else's app (the runtime's editor):
 * their records come along, but the copy is no member of the original's room
 * and has nothing of the original's to send. Left in place, the copied queue
 * would be sent as the copy's the first time it synced.
 */
export function forgetSyncNotes(origin: string): void {
  const prefix = `xdb:${origin}:`;
  for (const key of keysWithPrefix(prefix)) {
    if (!SYNC_NOTE.test(key.slice(prefix.length))) continue;
    try {
      localStorage.removeItem(key);
    } catch {
      // Storage refused: the note stays, as it would have without this.
    }
  }
}

/**
 * Whether a build has any stored state of its own, in either store, i.e.
 * whether it has been used. `all`: every stored key, read once (`storedKeys`).
 */
export function hasStoredData(origin: string | undefined, all?: readonly string[]): boolean {
  if (!origin) return false;
  try {
    return appDataStores(origin).some((store) => storeKeys(store, all).length > 0);
  } catch {
    return false;
  }
}

/**
 * Whether a build holds nothing of its own: only the records its bundle
 * seeded, or nothing at all. Every record is one the bundle put there (its id
 * in its collection's `::seeded:` mark), none was deleted, its only notes are
 * its collections' list and those marks (a sync note means it has been
 * used), and its script kept nothing through localStorage.
 *
 * Opening an update seeds it before the person reaches Home, so by
 * hasStoredData every build of an app that seeds had data, and "Bring my data
 * forward" was never offered for one. Anything that cannot be read is taken
 * as data of its own, which only withholds the offer. Read during render, so
 * it reads each key once. `all`: every stored key, read once (`storedKeys`).
 */
export function holdsNothingOfItsOwn(origin: string | undefined, all?: readonly string[]): boolean {
  if (!origin) return true;
  try {
    for (const store of appDataStores(origin)) {
      const rests = storeKeys(store, all).map((key) => key.slice(store.prefix.length));
      if (store.store === 'local') {
        if (rests.length > 0) return false;
        continue;
      }
      const seeded = new Map<string, Set<unknown>>();
      for (const rest of rests) {
        if (!rest.startsWith(':')) continue;
        const mark = /^:seeded:(.+)$/.exec(rest);
        if (mark) {
          const ids: unknown = JSON.parse(localStorage.getItem(store.prefix + rest) ?? '[]');
          if (!Array.isArray(ids)) return false;
          seeded.set(mark[1], new Set(ids));
        } else if (rest !== ':collections') {
          return false;
        }
      }
      for (const rest of rests) {
        if (rest.startsWith(':')) continue;
        const records: unknown = JSON.parse(localStorage.getItem(store.prefix + rest) ?? '[]');
        if (!Array.isArray(records)) return false;
        const ids = seeded.get(rest);
        for (const record of records) {
          if (!record || typeof record !== 'object') return false;
          const { id, deleted } = record as { id?: unknown; deleted?: unknown };
          if (deleted || !ids?.has(id)) return false;
        }
      }
    }
    return true;
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
export function migrateAppStorage(fromAppId: string, toAppId: string): DataTransferResult {
  if (fromAppId === toAppId) return { ok: true, copied: 0, total: 0, skipped: 0 };
  return transferAppData(fromAppId, toAppId, { move: true, overwrite: false });
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
const CONTAINER_IDB_VERSION = 2;

/**
 * Open a container-owned IndexedDB store safely: always creates the object store
 * in `onupgradeneeded` so clearing or backing up an app before any container has
 * run can never leave behind a version-1 database with zero object stores.
 */
function openContainerStoreDb(name: string, storeName: string, version = CONTAINER_IDB_VERSION, retried = false): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined' || typeof indexedDB.open !== 'function') {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(name, version);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(storeName)) {
          db.createObjectStore(storeName);
        }
      };
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => {
          try { db.close(); } catch { /* ignore */ }
        };
        if (!db.objectStoreNames.contains(storeName)) {
          const nextVersion = (typeof db.version === 'number' && db.version >= 1 ? db.version : version) + 1;
          try { db.close(); } catch { /* ignore */ }
          if (!retried) {
            void openContainerStoreDb(name, storeName, nextVersion, true).then(resolve);
            return;
          }
          resolve(null);
          return;
        }
        resolve(db);
      };
    } catch {
      resolve(null);
    }
  });
}

function clearContainerIndexedDb(prefix: string): void {
  if (typeof indexedDB === 'undefined') return;
  void openContainerStoreDb('softn-container-session', 'sessions').then((db) => {
    if (!db) return;
    try {
      const tx = db.transaction('sessions', 'readwrite');
      tx.objectStore('sessions').delete(prefix);
      tx.oncomplete = () => { try { db.close(); } catch { /* ignore */ } };
      tx.onerror = () => { try { db.close(); } catch { /* ignore */ } };
      tx.onabort = () => { try { db.close(); } catch { /* ignore */ } };
    } catch {
      try { db.close(); } catch { /* ignore */ }
    }
  });
  void openContainerStoreDb('softn-container-sqlite', 'blobs').then((db) => {
    if (!db) return;
    try {
      const tx = db.transaction('blobs', 'readwrite');
      const store = tx.objectStore('blobs');
      const curReq = store.openCursor();
      curReq.onsuccess = () => {
        const cur = curReq.result;
        if (!cur) return;
        if (String(cur.key).startsWith(prefix)) cur.delete();
        cur.continue();
      };
      tx.oncomplete = () => { try { db.close(); } catch { /* ignore */ } };
      tx.onerror = () => { try { db.close(); } catch { /* ignore */ } };
      tx.onabort = () => { try { db.close(); } catch { /* ignore */ } };
    } catch {
      try { db.close(); } catch { /* ignore */ }
    }
  });
  void openContainerStoreDb('softn-container', 'idb').then((db) => {
    if (!db) return;
    try {
      const tx = db.transaction('idb', 'readwrite');
      const store = tx.objectStore('idb');
      const range =
        typeof IDBKeyRange !== 'undefined'
          ? IDBKeyRange.bound([prefix, ''], [prefix, '\uffff'])
          : undefined;
      const curReq = store.openCursor(range);
      curReq.onsuccess = () => {
        const cur = curReq.result;
        if (!cur) return;
        if (Array.isArray(cur.key) && cur.key[0] === prefix) cur.delete();
        cur.continue();
      };
      tx.oncomplete = () => { try { db.close(); } catch { /* ignore */ } };
      tx.onerror = () => { try { db.close(); } catch { /* ignore */ } };
      tx.onabort = () => { try { db.close(); } catch { /* ignore */ } };
    } catch {
      try { db.close(); } catch { /* ignore */ }
    }
  });
}

/** Snapshot of one build's localStorage and container IndexedDB state for Undo after removal. */
export interface AppStorageBackup {
  origin: string;
  localEntries: Array<[string, string]>;
  containerSession?: unknown;
  containerSqliteBlobs: Array<[IDBValidKey, unknown]>;
  containerIdbParts?: Array<[IDBValidKey, unknown]>;
}

const SYNC_KEY_PREFIXES = [
  'xdb-sync-active-room:',
  'xdb-sync-shared:',
  'xdb-sync-collections:',
  'xdb-sync-peer:',
  'xdb-sync-room-key:',
];

function syncKeysForOrigin(origin: string): string[] {
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key) continue;
    for (const prefix of SYNC_KEY_PREFIXES) {
      if (key === `${prefix}${origin}` || key.startsWith(`${prefix}${origin}:`)) {
        keys.push(key);
        break;
      }
    }
  }
  return keys;
}

function readContainerIndexedDb(prefix: string): Promise<{
  session?: unknown;
  blobs: Array<[IDBValidKey, unknown]>;
  idbParts: Array<[IDBValidKey, unknown]>;
}> {
  const readSession = openContainerStoreDb('softn-container-session', 'sessions').then(
    (db) =>
      new Promise<unknown>((resolve) => {
        if (!db) {
          resolve(undefined);
          return;
        }
        try {
          const tx = db.transaction('sessions', 'readonly');
          const getReq = tx.objectStore('sessions').get(prefix);
          getReq.onsuccess = () => {
            try { db.close(); } catch { /* ignore */ }
            resolve(getReq.result);
          };
          getReq.onerror = () => {
            try { db.close(); } catch { /* ignore */ }
            resolve(undefined);
          };
        } catch {
          try { db.close(); } catch { /* ignore */ }
          resolve(undefined);
        }
      })
  );
  const readBlobs = openContainerStoreDb('softn-container-sqlite', 'blobs').then(
    (db) =>
      new Promise<Array<[IDBValidKey, unknown]>>((resolve) => {
        if (!db) {
          resolve([]);
          return;
        }
        const found: Array<[IDBValidKey, unknown]> = [];
        try {
          const tx = db.transaction('blobs', 'readonly');
          const curReq = tx.objectStore('blobs').openCursor();
          curReq.onerror = () => {
            try { db.close(); } catch { /* ignore */ }
            resolve(found);
          };
          curReq.onsuccess = () => {
            const cur = curReq.result;
            if (!cur) {
              try { db.close(); } catch { /* ignore */ }
              resolve(found);
              return;
            }
            if (String(cur.key).startsWith(prefix)) found.push([cur.key, cur.value]);
            cur.continue();
          };
        } catch {
          try { db.close(); } catch { /* ignore */ }
          resolve(found);
        }
      })
  );
  const readIdbParts = openContainerStoreDb('softn-container', 'idb').then(
    (db) =>
      new Promise<Array<[IDBValidKey, unknown]>>((resolve) => {
        if (!db) {
          resolve([]);
          return;
        }
        const found: Array<[IDBValidKey, unknown]> = [];
        try {
          const tx = db.transaction('idb', 'readonly');
          const range =
            typeof IDBKeyRange !== 'undefined'
              ? IDBKeyRange.bound([prefix, ''], [prefix, '\uffff'])
              : undefined;
          const curReq = tx.objectStore('idb').openCursor(range);
          curReq.onerror = () => {
            try { db.close(); } catch { /* ignore */ }
            resolve(found);
          };
          curReq.onsuccess = () => {
            const cur = curReq.result;
            if (!cur) {
              try { db.close(); } catch { /* ignore */ }
              resolve(found);
              return;
            }
            if (Array.isArray(cur.key) && cur.key[0] === prefix) found.push([cur.key, cur.value]);
            cur.continue();
          };
        } catch {
          try { db.close(); } catch { /* ignore */ }
          resolve(found);
        }
      })
  );
  return Promise.all([readSession, readBlobs, readIdbParts]).then(([session, blobs, idbParts]) => ({
    session,
    blobs,
    idbParts,
  }));
}

async function writeContainerIndexedDb(
  prefix: string,
  session: unknown,
  blobs: Array<[IDBValidKey, unknown]>,
  idbParts: Array<[IDBValidKey, unknown]> = []
): Promise<void> {
  if (session !== undefined) {
    const db = await openContainerStoreDb('softn-container-session', 'sessions');
    if (db) {
      await new Promise<void>((resolve) => {
        try {
          const tx = db.transaction('sessions', 'readwrite');
          tx.objectStore('sessions').put(session, prefix);
          tx.oncomplete = () => { try { db.close(); } catch { /* ignore */ } resolve(); };
          tx.onerror = () => { try { db.close(); } catch { /* ignore */ } resolve(); };
          tx.onabort = () => { try { db.close(); } catch { /* ignore */ } resolve(); };
        } catch {
          try { db.close(); } catch { /* ignore */ }
          resolve();
        }
      });
    }
  }
  if (blobs.length > 0) {
    const db = await openContainerStoreDb('softn-container-sqlite', 'blobs');
    if (db) {
      await new Promise<void>((resolve) => {
        try {
          const tx = db.transaction('blobs', 'readwrite');
          const store = tx.objectStore('blobs');
          for (const [k, v] of blobs) store.put(v, k);
          tx.oncomplete = () => { try { db.close(); } catch { /* ignore */ } resolve(); };
          tx.onerror = () => { try { db.close(); } catch { /* ignore */ } resolve(); };
          tx.onabort = () => { try { db.close(); } catch { /* ignore */ } resolve(); };
        } catch {
          try { db.close(); } catch { /* ignore */ }
          resolve();
        }
      });
    }
  }
  if (idbParts.length > 0) {
    const db = await openContainerStoreDb('softn-container', 'idb');
    if (db) {
      await new Promise<void>((resolve) => {
        try {
          const tx = db.transaction('idb', 'readwrite');
          const store = tx.objectStore('idb');
          for (const [k, v] of idbParts) store.put(v, k);
          tx.oncomplete = () => { try { db.close(); } catch { /* ignore */ } resolve(); };
          tx.onerror = () => { try { db.close(); } catch { /* ignore */ } resolve(); };
          tx.onabort = () => { try { db.close(); } catch { /* ignore */ } resolve(); };
        } catch {
          try { db.close(); } catch { /* ignore */ }
          resolve();
        }
      });
    }
  }
}

/** Capture an app's localStorage and container IndexedDB state before removal so Undo can restore it. */
export async function captureAppStorageBackup(origin: string | undefined): Promise<AppStorageBackup | null> {
  if (!origin) return null;
  const localEntries: Array<[string, string]> = [];
  const seen = new Set<string>();
  try {
    for (const store of appDataStores(origin)) {
      for (const key of storeKeys(store)) {
        if (seen.has(key)) continue;
        seen.add(key);
        const value = localStorage.getItem(key);
        if (value !== null) localEntries.push([key, value]);
      }
    }
    for (const key of syncKeysForOrigin(origin)) {
      if (seen.has(key)) continue;
      seen.add(key);
      const value = localStorage.getItem(key);
      if (value !== null) localEntries.push([key, value]);
    }
  } catch {
    // Storage unavailable; return what we have.
  }
  const idb = await readContainerIndexedDb(containerStoragePrefix(origin));
  return {
    origin,
    localEntries,
    containerSession: idb.session,
    containerSqliteBlobs: idb.blobs,
    containerIdbParts: idb.idbParts,
  };
}

/** Restore a previously captured storage backup (used by Undo). */
export async function restoreAppStorageBackup(backup: AppStorageBackup | null): Promise<void> {
  if (!backup) return;
  try {
    for (const [key, value] of backup.localEntries) {
      localStorage.setItem(key, value);
    }
  } catch {
    // Storage quota or unavailable.
  }
  await writeContainerIndexedDb(
    containerStoragePrefix(backup.origin),
    backup.containerSession,
    backup.containerSqliteBlobs,
    backup.containerIdbParts ?? []
  );
}

export function removeAppData(origin: string | undefined): number {
  if (!origin) return 0;
  let removed = 0;
  try {
    for (const store of appDataStores(origin)) {
      for (const key of storeKeys(store)) {
        localStorage.removeItem(key);
        removed += 1;
      }
    }
    for (const key of syncKeysForOrigin(origin)) {
      localStorage.removeItem(key);
      removed += 1;
    }
  } catch {
    // Storage unavailable; the cache record still goes.
  }
  clearContainerIndexedDb(containerStoragePrefix(origin));
  return removed;
}
