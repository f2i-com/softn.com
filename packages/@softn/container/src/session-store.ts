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

import { VIRTUAL_ORIGIN } from './archive';

const SESSION_IDB_NAME = 'softn-container-session';
const SESSION_IDB_STORE = 'sessions';
// v2 upgrades any pre-existing empty v1 DB that an older reader opened without onupgradeneeded.
const SESSION_IDB_VERSION = 2;

let cachedDbPromise: Promise<IDBDatabase | null> | null = null;
let cachedIdbGlobal: IDBFactory | null = null;

export function isSafeVirtualRoute(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 4096 || !raw.startsWith('/') || raw.startsWith('//')) {
    return false;
  }
  if (/[\u0000-\u001f\u007f]/.test(raw)) return false;
  try {
    return new URL(raw, `${VIRTUAL_ORIGIN}/`).origin === VIRTUAL_ORIGIN;
  } catch {
    return false;
  }
}

function openSessionIdbFresh(version = SESSION_IDB_VERSION, retried = false): Promise<IDBDatabase | null> {
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
          cachedDbPromise = null;
          try { db.close(); } catch { /* ignore */ }
        };
        db.onclose = () => {
          cachedDbPromise = null;
        };
        if (!db.objectStoreNames.contains(SESSION_IDB_STORE)) {
          const nextVersion = (typeof db.version === 'number' && db.version >= 1 ? db.version : version) + 1;
          try { db.close(); } catch { /* ignore */ }
          if (!retried) {
            void openSessionIdbFresh(nextVersion, true).then(resolve);
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

function openSessionIdb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  if (cachedIdbGlobal !== indexedDB) {
    cachedIdbGlobal = indexedDB;
    cachedDbPromise = null;
  }
  if (!cachedDbPromise) {
    cachedDbPromise = openSessionIdbFresh().then((db) => {
      if (!db) cachedDbPromise = null;
      return db;
    });
  }
  return cachedDbPromise;
}

function sanitizeStringRecord(raw: unknown): Record<string, string> {
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

function clonePlainRecord(src: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [k, v] of Object.entries(src)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

export async function loadContainerSession(storageBase: string): Promise<PersistedContainerSession | null> {
  const idb = await openSessionIdb();
  if (!idb) return null;
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
          urlPath: isSafeVirtualRoute(rec.urlPath) ? rec.urlPath : undefined,
          sessionStorage: sanitizeStringRecord(rec.sessionStorage),
          localStorage: sanitizeStringRecord(rec.localStorage),
          updatedAt: typeof rec.updatedAt === 'number' ? rec.updatedAt : Date.now(),
        });
      };
      req.onerror = () => resolve(null);
      tx.onerror = () => resolve(null);
      tx.onabort = () => resolve(null);
    } catch {
      cachedDbPromise = null;
      resolve(null);
    }
  });
}

type PendingOp =
  | { kind: 'put'; snapshot: PersistedContainerSession }
  | { kind: 'delete' };

interface CoalescedQueue {
  running: Promise<boolean>;
  pending: PendingOp | null;
  waiters: Array<(ok: boolean) => void>;
}

const activeQueues = new Map<string, CoalescedQueue>();

async function executeSessionOp(storageBase: string, op: PendingOp): Promise<boolean> {
  const idb = await openSessionIdb();
  if (!idb) return false;
  return await new Promise<boolean>((resolve) => {
    try {
      const tx = idb.transaction(SESSION_IDB_STORE, 'readwrite');
      const store = tx.objectStore(SESSION_IDB_STORE);
      if (op.kind === 'put') store.put(op.snapshot, storageBase);
      else store.delete(storageBase);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    } catch {
      cachedDbPromise = null;
      resolve(false);
    }
  });
}

function enqueueCoalesced(storageBase: string, op: PendingOp): Promise<boolean> {
  const existing = activeQueues.get(storageBase);
  if (existing) {
    // Coalesce: keep only the latest snapshot/delete while the current IDB write is in flight,
    // preventing unbounded main-thread memory growth during rapid storage/history updates.
    existing.pending = op;
    return new Promise<boolean>((resolve) => {
      existing.waiters.push(resolve);
    });
  }
  const entry: CoalescedQueue = {
    running: Promise.resolve(false),
    pending: null,
    waiters: [],
  };
  const run = async (initial: PendingOp): Promise<boolean> => {
    let ok = await executeSessionOp(storageBase, initial);
    while (entry.pending !== null) {
      const next = entry.pending;
      const batchWaiters = entry.waiters.splice(0, entry.waiters.length);
      entry.pending = null;
      ok = await executeSessionOp(storageBase, next);
      for (const w of batchWaiters) w(ok);
    }
    if (activeQueues.get(storageBase) === entry) activeQueues.delete(storageBase);
    return ok;
  };
  entry.running = run(op);
  activeQueues.set(storageBase, entry);
  return entry.running;
}

export function saveContainerSession(
  storageBase: string,
  session: PersistedContainerSession
): Promise<boolean> {
  const snapshot: PersistedContainerSession = {
    urlPath: isSafeVirtualRoute(session.urlPath) ? session.urlPath : undefined,
    sessionStorage: clonePlainRecord(session.sessionStorage),
    localStorage: clonePlainRecord(session.localStorage),
    updatedAt: session.updatedAt,
  };
  return enqueueCoalesced(storageBase, { kind: 'put', snapshot });
}

export async function clearContainerSession(storageBase: string): Promise<void> {
  await enqueueCoalesced(storageBase, { kind: 'delete' });
}
