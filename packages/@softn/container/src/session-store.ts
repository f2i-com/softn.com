/**
 * IndexedDB Container Session Store (`softn-container-session`).
 *
 * Persists a container's live user session across browser page refreshes:
 * - Current virtual route (`urlPath`, e.g. `/map`, `/equipment?status=active#top`)
 * - Guest `sessionStorage` key-value entries
 * - Guest `localStorage` key-value entries (mirrored in IndexedDB so full session
 *   state survives refreshes cleanly without hitting small localStorage quotas)
 *
 * Strictly scoped per container `storageBase` so apps never see each other's sessions.
 * Gracefully degrades to a no-op when `indexedDB` is unavailable (e.g. Node/JSDOM).
 */

export interface PersistedContainerSession {
  urlPath?: string;
  sessionStorage: Record<string, string>;
  localStorage: Record<string, string>;
  updatedAt: number;
}

const SESSION_IDB_NAME = 'softn-container-session';
const SESSION_IDB_STORE = 'sessions';
// v2 upgrades any pre-existing empty v1 DB that an older reader opened without onupgradeneeded.
const SESSION_IDB_VERSION = 2;

function openSessionIdb(version = SESSION_IDB_VERSION, retried = false): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(SESSION_IDB_NAME, version);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(SESSION_IDB_STORE)) {
          db.createObjectStore(SESSION_IDB_STORE);
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => {
          try { db.close(); } catch { /* ignore */ }
        };
        if (!db.objectStoreNames.contains(SESSION_IDB_STORE)) {
          const nextVersion = (typeof db.version === 'number' && db.version >= 1 ? db.version : version) + 1;
          try { db.close(); } catch { /* ignore */ }
          if (!retried) {
            void openSessionIdb(nextVersion, true).then(resolve);
            return;
          }
          resolve(null);
          return;
        }
        resolve(db);
      };
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function sanitizeStringRecord(raw: unknown): Record<string, string> {
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

export async function loadContainerSession(storageBase: string): Promise<PersistedContainerSession | null> {
  const idb = await openSessionIdb();
  if (!idb) return null;
  try {
    return await new Promise<PersistedContainerSession | null>((resolve) => {
      try {
        const tx = idb.transaction(SESSION_IDB_STORE, 'readonly');
        const req = tx.objectStore(SESSION_IDB_STORE).get(storageBase);
        req.onsuccess = () => {
          const val = req.result;
          if (!val || typeof val !== 'object') {
            resolve(null);
            return;
          }
          const rec = val as Record<string, unknown>;
          resolve({
            urlPath: typeof rec.urlPath === 'string' && rec.urlPath.startsWith('/') ? rec.urlPath : undefined,
            sessionStorage: sanitizeStringRecord(rec.sessionStorage),
            localStorage: sanitizeStringRecord(rec.localStorage),
            updatedAt: typeof rec.updatedAt === 'number' ? rec.updatedAt : Date.now(),
          });
        };
        req.onerror = () => resolve(null);
        tx.onerror = () => resolve(null);
        tx.onabort = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  } finally {
    try {
      idb.close();
    } catch {
      // ignore
    }
  }
}

const writeChains = new Map<string, Promise<unknown>>();

function enqueueWrite<T>(storageBase: string, task: () => Promise<T>): Promise<T> {
  const prev = writeChains.get(storageBase) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(task);
  writeChains.set(storageBase, next);
  void next.finally(() => {
    if (writeChains.get(storageBase) === next) writeChains.delete(storageBase);
  });
  return next;
}

export function saveContainerSession(
  storageBase: string,
  session: PersistedContainerSession
): Promise<boolean> {
  // Snapshot synchronously so queued writes preserve the exact state at call time
  // and never race out-of-order against earlier/later saves.
  const plainSessionStorage: Record<string, string> = {};
  for (const [k, v] of Object.entries(session.sessionStorage)) plainSessionStorage[k] = v;
  const plainLocalStorage: Record<string, string> = {};
  for (const [k, v] of Object.entries(session.localStorage)) plainLocalStorage[k] = v;
  const snapshot = {
    urlPath: session.urlPath,
    sessionStorage: plainSessionStorage,
    localStorage: plainLocalStorage,
    updatedAt: session.updatedAt,
  };
  return enqueueWrite(storageBase, async () => {
    const idb = await openSessionIdb();
    if (!idb) return false;
    try {
      return await new Promise<boolean>((resolve) => {
        try {
          const tx = idb.transaction(SESSION_IDB_STORE, 'readwrite');
          tx.objectStore(SESSION_IDB_STORE).put(snapshot, storageBase);
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => resolve(false);
          tx.onabort = () => resolve(false);
        } catch {
          resolve(false);
        }
      });
    } finally {
      try {
        idb.close();
      } catch {
        // ignore
      }
    }
  });
}

export function clearContainerSession(storageBase: string): Promise<void> {
  return enqueueWrite(storageBase, async () => {
    const idb = await openSessionIdb();
    if (!idb) return;
    try {
      await new Promise<void>((resolve) => {
        try {
          const tx = idb.transaction(SESSION_IDB_STORE, 'readwrite');
          tx.objectStore(SESSION_IDB_STORE).delete(storageBase);
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
          tx.onabort = () => resolve();
        } catch {
          resolve();
        }
      });
    } finally {
      try {
        idb.close();
      } catch {
        // ignore
      }
    }
  });
}
