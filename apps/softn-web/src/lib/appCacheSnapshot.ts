/**
 * A build's stored data as a file: the export, the checked read of one, and
 * an import that is whole or not at all, across a crash as well.
 * Re-exported by ./appCache.
 */

import type { CachedApp } from './appCacheDb';
import { appDataStores, describeError, keysWithPrefix, type AppDataStore, type DataTransferResult } from './appCacheStorage';

// ── Portable data ────────────────────────────────────────────────────
//
// A build's state, as a file: to keep, to move to another browser, to put
// back after an update went wrong. The file names the build it came from,
// and importing it is whole or not at all — a corrupt file, or a write that
// fails part way, leaves the build's data exactly as it was, and so does a
// browser that dies part way, which the journal below is for. What must
// never happen is a failed import quietly turning into an empty app.

const APP_DATA_FORMAT = 'softn-app-data';
/**
 * Format 1 carried the XDB records alone, as `entries`. Format 2 carries both
 * stores, each under its name in `stores`; a format-1 file is read as records
 * with no saved keys, which is exactly what it was.
 */
const APP_DATA_VERSION = 2;

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
function replaceStorageRuns(runs: Array<{ prefix: string; entries: Record<string, string> }>): DataTransferResult {
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
