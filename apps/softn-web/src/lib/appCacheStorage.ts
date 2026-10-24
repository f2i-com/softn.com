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
// online table. Everything that counts, moves, exports, imports or removes
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
const XDB_NOTE = /^:(?:collections|p2p-room|sync-queue|sync-pulled|sync-watched|(?:removals|seeded):[^:]+)$/;

/** One store of a build: the prefix its keys are under, and which keys under it are its own. */
export interface AppDataStoreKeys {
  store: AppDataStore;
  prefix: string;
  owns: (rest: string) => boolean;
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
    // The bridge folds anything outside [A-Za-z0-9_-] to `_` before it
    // prefixes. A digest never has any, but the two spellings must agree.
    // Folded, the prefix has no ":" in it to run into another's.
    { store: 'local', prefix: `softn:${origin.replace(/[^a-zA-Z0-9_-]/g, '_')}:`, owns: () => true },
  ];
}

/** The keys of one store of a build: under its prefix, and its own. */
export function storeKeys({ prefix, owns }: Pick<AppDataStoreKeys, 'prefix' | 'owns'>): string[] {
  return keysWithPrefix(prefix).filter((key) => owns(key.slice(prefix.length)));
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

export function keysWithPrefix(prefix: string): string[] {
  // Snapshot the keys first: writing to localStorage while iterating its
  // indices is how you skip half of them.
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith(prefix)) keys.push(key);
  }
  return keys;
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

/** Whether a build has any stored state of its own, in either store, i.e. whether it has been used. */
export function hasStoredData(origin: string | undefined): boolean {
  if (!origin) return false;
  try {
    return appDataStores(origin).some((store) => storeKeys(store).length > 0);
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
  } catch {
    // Storage unavailable; the cache record still goes.
  }
  return removed;
}
