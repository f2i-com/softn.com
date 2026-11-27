/**
 * Local In-Browser Backend Transport (`LocalBackendTransport`).
 *
 * Implements `BackendTransport` over either:
 * - A Dedicated Backend Web Worker (`/runtime/backend-worker.js`), completely
 *   isolated from both the host DOM and the Frontend Worker, OR
 * - An inline `BackendWorkerSession` (for Node/Vitest where Web Workers don't exist).
 *
 * Also manages container-scoped IndexedDB persistence for XDB SQLite `.db` images
 * and PHP VFS overlay snapshots, plus a container-scoped `VirtualCookieJar`.
 */

import { base64ToBytes, bytesToBase64 } from './archive';
import type {
  BackendWorkerSession,
  BackendToHostMsg,
  HostToBackendMsg,
} from './backend-runtime';
import {
  ALLOWED_BACKEND_METHODS,
  FORBIDDEN_FETCH_REQUEST_HEADERS,
  statusTextFor,
  VirtualCookieJar,
} from './backend-transport';
import { startModuleWorker } from './worker-start';
import type {
  BackendConfig,
  BackendHttpRequest,
  BackendHttpResponse,
  BackendTransport,
  BackendWsEvent,
  BackendWsHandle,
  ContainerBootStatus,
  DatabaseConfig,
  SqliteOpName,
  SqlitePersistenceState,
  SqlitePersistenceStatus,
  ZippEngineSource,
} from './types';

const SQLITE_IDB_NAME = 'softn-container-sqlite';
const SQLITE_IDB_STORE = 'blobs';
// v2 upgrades any pre-existing empty v1 DB that an older reader opened without onupgradeneeded.
const SQLITE_IDB_VERSION = 2;
const DEFAULT_MAX_PERSISTED_SQLITE_DBS = 8;
const DEFAULT_MAX_SINGLE_SQLITE_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_PERSISTED_SQLITE_BYTES = 64 * 1024 * 1024;
export const PLATFORM_MAX_PERSISTED_SQLITE_DBS = 32;
export const PLATFORM_MAX_SINGLE_SQLITE_BYTES = 256 * 1024 * 1024;
export const PLATFORM_MAX_TOTAL_PERSISTED_SQLITE_BYTES = 256 * 1024 * 1024;
const DEFAULT_LOCAL_FETCH_TIMEOUT_MS = 30_000;
const LOCAL_ENCODER = new TextEncoder();
const HEX_TABLE: readonly string[] = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
const TAB_INSTANCE_ID = `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export interface PersistedSqliteRecord {
  format: 'softn-sqlite-v1';
  dbKey: string;
  revision: number;
  checksum: string;
  schemaVersion: number;
  updatedAt: number;
  tabId: string;
  bytes: Uint8Array;
}

export interface PersistedSqliteMeta {
  revision: number;
  checksum?: string;
  schemaVersion?: number;
  updatedAt?: number;
  tabId?: string;
}

export class SqlitePersistenceError extends Error {
  readonly state: SqlitePersistenceState;
  readonly code: 'quota-exceeded' | 'revision-conflict' | 'io-error' | 'aborted';
  constructor(
    state: SqlitePersistenceState,
    code: 'quota-exceeded' | 'revision-conflict' | 'io-error' | 'aborted',
    message: string
  ) {
    super(message);
    this.name = 'SqlitePersistenceError';
    this.state = state;
    this.code = code;
  }
}

function isQuotaError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = String((err as { name?: unknown }).name ?? '');
  const msg = String((err as { message?: unknown }).message ?? '');
  return name === 'QuotaExceededError' || /quota|storage.*full|exceeded/i.test(msg);
}

function isVersionedSqliteRecord(val: unknown): val is PersistedSqliteRecord {
  return (
    typeof val === 'object' &&
    val !== null &&
    (val as { format?: unknown }).format === 'softn-sqlite-v1' &&
    ((val as { bytes?: unknown }).bytes instanceof Uint8Array ||
      (val as { bytes?: unknown }).bytes instanceof ArrayBuffer)
  );
}

let cachedSqliteIdbPromise: Promise<IDBDatabase | null> | null = null;
let cachedSqliteIdbGlobal: IDBFactory | null = null;
const coalescedBlobWrites = new Map<
  string,
  {
    inFlight: boolean;
    pending?: Uint8Array | string | PersistedSqliteRecord;
    expectedRevision?: number;
    explicitStorage?: Storage;
    metaKey?: string;
    waiters: Array<{ resolve: () => void; reject: (err: Error) => void }>;
    done: Promise<void>;
  }
>();

async function drainCoalescedWritesForPrefix(storagePrefix: string, cancelPending = false): Promise<void> {
  const waiters: Promise<void>[] = [];
  for (const [key, slot] of coalescedBlobWrites) {
    if (!key.startsWith(storagePrefix)) continue;
    if (cancelPending) slot.pending = undefined;
    waiters.push(slot.done.catch(() => undefined));
  }
  if (waiters.length > 0) await Promise.all(waiters);
}

function openSqliteIdbFresh(version = SQLITE_IDB_VERSION, retried = false): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(SQLITE_IDB_NAME, version);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(SQLITE_IDB_STORE)) {
          db.createObjectStore(SQLITE_IDB_STORE);
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => {
          cachedSqliteIdbPromise = null;
          try { db.close(); } catch { /* ignore */ }
        };
        db.onclose = () => {
          cachedSqliteIdbPromise = null;
        };
        if (!db.objectStoreNames.contains(SQLITE_IDB_STORE)) {
          const nextVersion = (typeof db.version === 'number' && db.version >= 1 ? db.version : version) + 1;
          try { db.close(); } catch { /* ignore */ }
          if (!retried) {
            void openSqliteIdbFresh(nextVersion, true).then(resolve);
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

function openSqliteIdb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  if (cachedSqliteIdbGlobal !== indexedDB) {
    cachedSqliteIdbGlobal = indexedDB;
    cachedSqliteIdbPromise = null;
  }
  if (!cachedSqliteIdbPromise) {
    cachedSqliteIdbPromise = openSqliteIdbFresh().then((db) => {
      if (!db) cachedSqliteIdbPromise = null;
      return db;
    });
  }
  return cachedSqliteIdbPromise;
}

function readFallbackStorage(
  store: Storage,
  sqlPrefix: string,
  sqlMetaPrefix: string,
  ovKey: string,
  rustOvKey: string,
  cookiesKey: string
): {
  dbs: Record<string, Uint8Array>;
  dbMeta: Record<string, PersistedSqliteMeta>;
  phpOverlay?: string;
  rustOverlay?: string;
  cookies?: string;
} {
  const dbs: Record<string, Uint8Array> = Object.create(null);
  const dbMeta: Record<string, PersistedSqliteMeta> = Object.create(null);
  let phpOverlay: string | undefined;
  let rustOverlay: string | undefined;
  let cookies: string | undefined;
  try {
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i);
      if (!k) continue;
      if (k.startsWith(sqlPrefix)) {
        const b64 = store.getItem(k);
        if (b64) dbs[k.slice(sqlPrefix.length)] = base64ToBytes(b64);
      } else if (k.startsWith(sqlMetaPrefix)) {
        const rawMeta = store.getItem(k);
        if (rawMeta) {
          try {
            const parsed = JSON.parse(rawMeta) as PersistedSqliteMeta;
            if (parsed && typeof parsed === 'object') {
              dbMeta[k.slice(sqlMetaPrefix.length)] = parsed;
            }
          } catch {
            // ignore corrupt metadata
          }
        }
      } else if (k === ovKey) {
        const val = store.getItem(k);
        if (val) phpOverlay = val;
      } else if (k === rustOvKey) {
        const val = store.getItem(k);
        if (val) rustOverlay = val;
      } else if (k === cookiesKey) {
        const val = store.getItem(k);
        if (val) cookies = val;
      }
    }
  } catch {
    // ignore restricted storage
  }
  return { dbs, dbMeta, phpOverlay, rustOverlay, cookies };
}

function defaultWebStorage(): Storage | undefined {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : undefined;
  } catch {
    return undefined;
  }
}

async function loadPersistedBlobs(
  storagePrefix: string,
  explicitStorage?: Storage
): Promise<{
  dbs: Record<string, Uint8Array>;
  dbMeta: Record<string, PersistedSqliteMeta>;
  phpOverlay?: string;
  rustOverlay?: string;
  cookies?: string;
}> {
  await drainCoalescedWritesForPrefix(storagePrefix, false);
  const dbs: Record<string, Uint8Array> = Object.create(null);
  const dbMeta: Record<string, PersistedSqliteMeta> = Object.create(null);
  let phpOverlay: string | undefined;
  let rustOverlay: string | undefined;
  let cookies: string | undefined;
  const sqlPrefix = `${storagePrefix}sqlite:`;
  const sqlMetaPrefix = `${storagePrefix}sqlite-meta:`;
  const ovKey = `${storagePrefix}php-overlay`;
  const rustOvKey = `${storagePrefix}rust-overlay`;
  const cookiesKey = `${storagePrefix}cookies`;

  if (explicitStorage) {
    return readFallbackStorage(explicitStorage, sqlPrefix, sqlMetaPrefix, ovKey, rustOvKey, cookiesKey);
  }

  const idb = await openSqliteIdb();
  if (idb) {
    await new Promise<void>((resolve) => {
      try {
        const tx = idb.transaction(SQLITE_IDB_STORE, 'readonly');
        const store = tx.objectStore(SQLITE_IDB_STORE);
        const range =
          typeof IDBKeyRange !== 'undefined' && typeof IDBKeyRange.bound === 'function'
            ? IDBKeyRange.bound(storagePrefix, `${storagePrefix}\uffff`)
            : undefined;
        const curReq = range ? store.openCursor(range) : store.openCursor();
        curReq.onsuccess = () => {
          const cur = curReq.result;
          if (!cur) return;
          const k = String(cur.key);
          if (k.startsWith(sqlPrefix)) {
            const dbKey = k.slice(sqlPrefix.length);
            const val = cur.value;
            if (isVersionedSqliteRecord(val)) {
              const rawBytes = val.bytes instanceof Uint8Array ? val.bytes : new Uint8Array(val.bytes);
              dbs[dbKey] = rawBytes;
              dbMeta[dbKey] = {
                revision: typeof val.revision === 'number' ? val.revision : 0,
                checksum: typeof val.checksum === 'string' ? val.checksum : undefined,
                schemaVersion: typeof val.schemaVersion === 'number' ? val.schemaVersion : undefined,
                updatedAt: typeof val.updatedAt === 'number' ? val.updatedAt : undefined,
                tabId: typeof val.tabId === 'string' ? val.tabId : undefined,
              };
            } else if (val instanceof Uint8Array) {
              dbs[dbKey] = val;
            } else if (val instanceof ArrayBuffer) {
              dbs[dbKey] = new Uint8Array(val);
            }
          } else if (k === ovKey && typeof cur.value === 'string') {
            phpOverlay = cur.value;
          } else if (k === rustOvKey && typeof cur.value === 'string') {
            rustOverlay = cur.value;
          } else if (k === cookiesKey && typeof cur.value === 'string') {
            cookies = cur.value;
          }
          cur.continue();
        };
        curReq.onerror = () => resolve();
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      } catch {
        cachedSqliteIdbPromise = null;
        resolve();
      }
    });
    return { dbs, dbMeta, phpOverlay, rustOverlay, cookies };
  }

  // Fallback for environments with localStorage only (e.g. JSDOM tests or opaque-origin iframes)
  const fallback = defaultWebStorage();
  if (fallback) {
    return readFallbackStorage(fallback, sqlPrefix, sqlMetaPrefix, ovKey, rustOvKey, cookiesKey);
  }
  return { dbs, dbMeta, phpOverlay, rustOverlay, cookies };
}

export async function clearBackendPersistedBlobs(storagePrefix: string, explicitStorage?: Storage): Promise<void> {
  await drainCoalescedWritesForPrefix(storagePrefix, true);
  if (!explicitStorage) {
    const idb = await openSqliteIdb();
    if (idb) {
      await new Promise<void>((resolve) => {
        try {
          const tx = idb.transaction(SQLITE_IDB_STORE, 'readwrite');
          const store = tx.objectStore(SQLITE_IDB_STORE);
          const range =
            typeof IDBKeyRange !== 'undefined' && typeof IDBKeyRange.bound === 'function'
              ? IDBKeyRange.bound(storagePrefix, `${storagePrefix}\uffff`)
              : undefined;
          const curReq = range ? store.openCursor(range) : store.openCursor();
          curReq.onsuccess = () => {
            const cur = curReq.result;
            if (!cur) return;
            if (String(cur.key).startsWith(storagePrefix)) cur.delete();
            cur.continue();
          };
          curReq.onerror = () => resolve();
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
          tx.onabort = () => resolve();
        } catch {
          cachedSqliteIdbPromise = null;
          resolve();
        }
      });
    }
  }
  const store = explicitStorage ?? defaultWebStorage();
  if (store) {
    try {
      const toRemove: string[] = [];
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i);
        if (k && k.startsWith(storagePrefix)) toRemove.push(k);
      }
      for (const k of toRemove) store.removeItem(k);
    } catch {
      // ignore
    }
  }
}

async function writePersistedBlobOnce(
  key: string,
  value: Uint8Array | string | PersistedSqliteRecord,
  explicitStorage?: Storage,
  expectedRevision?: number,
  metaKey?: string
): Promise<void> {
  if (!explicitStorage) {
    const idb = await openSqliteIdb();
    if (idb) {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const fail = (err: Error) => {
          if (settled) return;
          settled = true;
          reject(err);
        };
        try {
          const tx = idb.transaction(SQLITE_IDB_STORE, 'readwrite');
          const store = tx.objectStore(SQLITE_IDB_STORE);
          const putNow = () => {
            try {
              store.put(value, key);
            } catch (putErr) {
              fail(
                new SqlitePersistenceError(
                  isQuotaError(putErr) ? 'storage-limit-reached' : 'unsaved-changes',
                  isQuotaError(putErr) ? 'quota-exceeded' : 'io-error',
                  putErr instanceof Error ? putErr.message : String(putErr)
                )
              );
            }
          };
          if (isVersionedSqliteRecord(value) && typeof expectedRevision === 'number') {
            const getReq = store.get(key);
            getReq.onsuccess = () => {
              const existing = getReq.result;
              if (
                isVersionedSqliteRecord(existing) &&
                existing.revision > expectedRevision &&
                existing.tabId !== value.tabId
              ) {
                try { tx.abort(); } catch { /* ignore */ }
                fail(
                  new SqlitePersistenceError(
                    'unsaved-changes',
                    'revision-conflict',
                    `Database "${value.dbKey}" was modified by another tab (stored revision ${existing.revision} > expected ${expectedRevision})`
                  )
                );
                return;
              }
              putNow();
            };
            getReq.onerror = () => {
              putNow();
            };
          } else {
            putNow();
          }
          tx.oncomplete = () => {
            if (!settled) {
              settled = true;
              resolve();
            }
          };
          tx.onerror = () => {
            const txErr = tx.error;
            fail(
              new SqlitePersistenceError(
                isQuotaError(txErr) ? 'storage-limit-reached' : 'unsaved-changes',
                isQuotaError(txErr) ? 'quota-exceeded' : 'io-error',
                txErr?.message || 'IndexedDB persistence transaction failed'
              )
            );
          };
          tx.onabort = () => {
            const txErr = tx.error;
            fail(
              new SqlitePersistenceError(
                isQuotaError(txErr) ? 'storage-limit-reached' : 'unsaved-changes',
                isQuotaError(txErr) ? 'quota-exceeded' : 'aborted',
                txErr?.message || 'IndexedDB persistence transaction aborted'
              )
            );
          };
        } catch (err) {
          cachedSqliteIdbPromise = null;
          fail(
            new SqlitePersistenceError(
              isQuotaError(err) ? 'storage-limit-reached' : 'unsaved-changes',
              isQuotaError(err) ? 'quota-exceeded' : 'io-error',
              err instanceof Error ? err.message : String(err)
            )
          );
        }
      });
      return;
    }
  }
  const store = explicitStorage ?? defaultWebStorage();
  if (!store) {
    throw new SqlitePersistenceError('unsaved-changes', 'io-error', 'No persistent browser storage is available');
  }
  try {
    if (isVersionedSqliteRecord(value)) {
      if (metaKey && typeof expectedRevision === 'number') {
        const rawExisting = store.getItem(metaKey);
        if (rawExisting) {
          try {
            const parsed = JSON.parse(rawExisting) as PersistedSqliteMeta;
            if (
              typeof parsed.revision === 'number' &&
              parsed.revision > expectedRevision &&
              parsed.tabId &&
              parsed.tabId !== value.tabId
            ) {
              throw new SqlitePersistenceError(
                'unsaved-changes',
                'revision-conflict',
                `Database "${value.dbKey}" was modified by another tab (stored revision ${parsed.revision} > expected ${expectedRevision})`
              );
            }
          } catch (e) {
            if (e instanceof SqlitePersistenceError) throw e;
          }
        }
      }
      store.setItem(key, bytesToBase64(value.bytes));
      if (metaKey) {
        store.setItem(
          metaKey,
          JSON.stringify({
            revision: value.revision,
            checksum: value.checksum,
            schemaVersion: value.schemaVersion,
            updatedAt: value.updatedAt,
            tabId: value.tabId,
          })
        );
      }
    } else if (typeof value === 'string') {
      store.setItem(key, value);
    } else {
      store.setItem(key, bytesToBase64(value));
    }
  } catch (err) {
    if (err instanceof SqlitePersistenceError) throw err;
    throw new SqlitePersistenceError(
      isQuotaError(err) ? 'storage-limit-reached' : 'unsaved-changes',
      isQuotaError(err) ? 'quota-exceeded' : 'io-error',
      err instanceof Error ? err.message : String(err)
    );
  }
}

function savePersistedBlob(
  key: string,
  value: Uint8Array | string | PersistedSqliteRecord,
  explicitStorage?: Storage,
  options?: { expectedRevision?: number; metaKey?: string }
): Promise<void> {
  const slot = coalescedBlobWrites.get(key);
  if (slot) {
    slot.pending = value;
    slot.explicitStorage = explicitStorage;
    slot.expectedRevision = options?.expectedRevision;
    slot.metaKey = options?.metaKey;
    return new Promise<void>((resolve, reject) => {
      slot.waiters.push({ resolve, reject });
    });
  }
  const entry: {
    inFlight: boolean;
    pending?: Uint8Array | string | PersistedSqliteRecord;
    expectedRevision?: number;
    explicitStorage?: Storage;
    metaKey?: string;
    waiters: Array<{ resolve: () => void; reject: (err: Error) => void }>;
    done: Promise<void>;
  } = {
    inFlight: true,
    pending: value,
    expectedRevision: options?.expectedRevision,
    explicitStorage,
    metaKey: options?.metaKey,
    waiters: [],
    done: Promise.resolve(),
  };
  const callerPromise = new Promise<void>((resolve, reject) => {
    entry.waiters.push({ resolve, reject });
  });
  coalescedBlobWrites.set(key, entry);
  entry.done = (async () => {
    try {
      while (entry.pending !== undefined) {
        const nextVal = entry.pending;
        const nextStore = entry.explicitStorage;
        const nextExpected = entry.expectedRevision;
        const nextMetaKey = entry.metaKey;
        const batchWaiters = entry.waiters.splice(0);
        entry.pending = undefined;
        try {
          await writePersistedBlobOnce(key, nextVal, nextStore, nextExpected, nextMetaKey);
          for (const w of batchWaiters) w.resolve();
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          for (const w of batchWaiters) w.reject(error);
        }
      }
    } finally {
      if (coalescedBlobWrites.get(key) === entry) coalescedBlobWrites.delete(key);
    }
  })();
  return callerPromise;
}

export interface LocalBackendTransportOptions {
  appId: string;
  storagePrefix: string;
  persistStorage?: boolean;
  /** Optional host-managed Web Storage backend (used in opaque-origin frames / tests). */
  storage?: Storage;
  backend?: BackendConfig;
  databases?: DatabaseConfig[];
  textFiles: Record<string, string>;
  binaryFiles: Record<string, Uint8Array>;
  runtimeUrl: string;
  isolation: 'worker' | 'inline';
  engineModule?: ZippEngineSource;
  xdbModule?: ZippEngineSource;
  xdbGlueUrl?: string;
  instructionBudget?: number;
  /** Host-configurable max persisted SQLite DB count (default 8, platform ceiling 32). */
  maxPersistedSqliteDbs?: number;
  /** Host-configurable max single persisted SQLite DB bytes (default 64 MiB, platform ceiling 256 MiB). */
  maxSingleSqliteBytes?: number;
  /** Host-configurable max total persisted SQLite bytes across all DBs (default 64 MiB, platform ceiling 256 MiB). */
  maxTotalSqliteBytes?: number;
  /** Host-configurable max temporary databases per SQLite workspace (default 8, platform ceiling 16). */
  maxWorkspaceDbs?: number;
  /** Host-configurable max SQLite import image size in bytes (default 64 MiB, platform ceiling 128 MiB). */
  maxImportBytes?: number;
  onConsole?: (level: 'log' | 'info' | 'warn' | 'error', text: string) => void;
  onStatus?: (status: ContainerBootStatus) => void;
  onPersistenceChange?: (status: SqlitePersistenceStatus) => void;
}

export class LocalBackendTransport implements BackendTransport {
  readonly kind: 'local-worker' | 'local-inline';
  readonly ready: Promise<void>;
  readonly cookieJar = new VirtualCookieJar();

  private readonly storagePrefix: string;
  private readonly persistStorage: boolean;
  private readonly maxPersistedSqliteDbs: number;
  private readonly maxSingleSqliteBytes: number;
  private readonly maxTotalSqliteBytes: number;
  private readonly storage?: Storage;
  private readonly onConsole?: (level: 'log' | 'info' | 'warn' | 'error', text: string) => void;
  private readonly onStatus?: (status: ContainerBootStatus) => void;
  private readonly onPersistenceChange?: (status: SqlitePersistenceStatus) => void;
  private worker: Worker | null = null;
  private inlineSession: BackendWorkerSession | null = null;
  private nextReqId = 1;
  private nextWsId = 1;
  private readonly pendingFetch = new Map<
    number,
    { resolve: (resp: BackendHttpResponse) => void; reject: (err: Error) => void }
  >();
  private readonly pendingRpc = new Map<
    number,
    { resolve: (val: unknown) => void; reject: (err: Error) => void }
  >();
  private readonly wsHandlers = new Map<string, (event: BackendWsEvent) => void>();
  private readonly persistedDbSizes = new Map<string, number>();
  private readonly persistedRevisions = new Map<string, number>();
  private readonly persistenceStatuses = new Map<string, SqlitePersistenceStatus>();
  private readonly pendingPersistWrites = new Map<string, Promise<SqlitePersistenceStatus>>();
  private readonly unsavedDbWarned = new Set<string>();
  private resolveReady!: () => void;
  private rejectReady!: (err: Error) => void;
  private isReady = false;
  private disposing = false;
  private disposed = false;
  private disposeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: LocalBackendTransportOptions) {
    this.storagePrefix = options.storagePrefix;
    this.persistStorage = options.persistStorage !== false;
    this.maxPersistedSqliteDbs =
      typeof options.maxPersistedSqliteDbs === 'number' && Number.isInteger(options.maxPersistedSqliteDbs) && options.maxPersistedSqliteDbs > 0
        ? Math.min(options.maxPersistedSqliteDbs, PLATFORM_MAX_PERSISTED_SQLITE_DBS)
        : DEFAULT_MAX_PERSISTED_SQLITE_DBS;
    this.maxTotalSqliteBytes =
      typeof options.maxTotalSqliteBytes === 'number' && Number.isFinite(options.maxTotalSqliteBytes) && options.maxTotalSqliteBytes > 0
        ? Math.min(Math.floor(options.maxTotalSqliteBytes), PLATFORM_MAX_TOTAL_PERSISTED_SQLITE_BYTES)
        : DEFAULT_MAX_TOTAL_PERSISTED_SQLITE_BYTES;
    const rawSingle =
      typeof options.maxSingleSqliteBytes === 'number' && Number.isFinite(options.maxSingleSqliteBytes) && options.maxSingleSqliteBytes > 0
        ? Math.min(Math.floor(options.maxSingleSqliteBytes), PLATFORM_MAX_SINGLE_SQLITE_BYTES)
        : DEFAULT_MAX_SINGLE_SQLITE_BYTES;
    this.maxSingleSqliteBytes = Math.min(rawSingle, this.maxTotalSqliteBytes);
    this.storage = options.storage;
    this.onConsole = options.onConsole;
    this.onStatus = options.onStatus;
    this.onPersistenceChange = options.onPersistenceChange;
    const useWorker = options.isolation === 'worker' && typeof Worker === 'function';
    this.kind = useWorker ? 'local-worker' : 'local-inline';

    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    // Prevent spurious unhandled rejections if disposed before any caller awaits `this.ready`.
    this.ready.catch(() => {});

    void this.boot(options, useWorker);
  }

  private post(msg: HostToBackendMsg, transfer?: Transferable[]): void {
    if (this.disposed || this.disposing) return;
    if (this.worker) {
      if (transfer && transfer.length > 0) this.worker.postMessage(msg, transfer);
      else this.worker.postMessage(msg);
    } else if (this.inlineSession) {
      void this.inlineSession.handleMessage(msg);
    }
  }

  private setPersistenceStatus(status: SqlitePersistenceStatus): void {
    this.persistenceStatuses.set(status.dbKey, status);
    try {
      this.onPersistenceChange?.(status);
    } catch {
      // Never let listener errors disrupt transport processing
    }
  }

  private async boot(options: LocalBackendTransportOptions, useWorker: boolean): Promise<void> {
    try {
      // Spawn the backend Worker immediately so its script downloads and parses
      // in parallel with loading persisted SQLite/overlay blobs from IndexedDB.
      let workerFailed = false;
      if (useWorker) {
        const base = options.runtimeUrl.replace(/\/?$/, '/');
        const workerUrl = `${base}backend-worker.js`;
        const w = startModuleWorker(workerUrl, { name: `softn-backend-${options.appId}` });
        w.addEventListener('message', (ev: MessageEvent<BackendToHostMsg>) => {
          this.handleBackendMessage(ev.data);
        });
        w.addEventListener('error', (ev) => {
          workerFailed = true;
          const err = new Error(ev.message || 'Backend Worker crashed');
          if (!this.isReady) {
            this.rejectReady(err);
          } else {
            this.isReady = false;
          }
          this.rejectAllPending(err);
          this.onConsole?.('error', `[backend] ${err.message}`);
        });
        this.worker = w;
      }

      const [persisted, inlineCtor] = await Promise.all([
        this.persistStorage
          ? loadPersistedBlobs(this.storagePrefix, this.storage)
          : Promise.resolve({
              dbs: Object.create(null) as Record<string, Uint8Array>,
              dbMeta: Object.create(null) as Record<string, PersistedSqliteMeta>,
              phpOverlay: undefined,
              rustOverlay: undefined,
              cookies: undefined,
            }),
        useWorker ? Promise.resolve(null) : import('./backend-runtime').then((m) => m.BackendWorkerSession),
      ]);

      if (this.disposed || this.disposing || workerFailed) return;
      this.persistedDbSizes.clear();
      this.persistedRevisions.clear();
      for (const [dbKey, bytes] of Object.entries(persisted.dbs)) {
        if (bytes instanceof Uint8Array) {
          this.persistedDbSizes.set(dbKey, bytes.byteLength);
          const meta = persisted.dbMeta[dbKey];
          const rev = meta?.revision ?? 0;
          this.persistedRevisions.set(dbKey, rev);
          this.persistenceStatuses.set(dbKey, {
            dbKey,
            state: 'saved',
            revision: rev,
            checksum: meta?.checksum,
            schemaVersion: meta?.schemaVersion,
            byteLength: bytes.byteLength,
            updatedAt: meta?.updatedAt,
          });
        }
      }
      if (persisted.cookies) {
        this.cookieJar.hydrate(persisted.cookies);
      }

      if (!useWorker && inlineCtor) {
        this.inlineSession = new inlineCtor((msg) => {
          this.handleBackendMessage(msg);
        });
      }

      this.post({
        type: 'init',
        appId: options.appId,
        backend: options.backend,
        databases: options.databases,
        textFiles: options.textFiles,
        binaryFiles: options.binaryFiles,
        initialPersistedDbs: persisted.dbs,
        initialPersistedMeta: persisted.dbMeta,
        initialPhpOverlay: persisted.phpOverlay,
        initialRustOverlay: persisted.rustOverlay,
        runtimeUrl: options.runtimeUrl,
        engineModule: options.engineModule,
        xdbModule: options.xdbModule,
        xdbGlueUrl: options.xdbGlueUrl,
        instructionBudget: options.instructionBudget,
        maxOpenDbs: this.maxPersistedSqliteDbs,
        maxWorkspaceDbs: options.maxWorkspaceDbs,
        maxImportBytes: options.maxImportBytes,
      });
    } catch (err) {
      this.rejectReady(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private finishWorkerDispose(): void {
    if (this.disposeTimer !== null) {
      clearTimeout(this.disposeTimer);
      this.disposeTimer = null;
    }
    this.disposed = true;
    this.rejectAllPending(new Error('LocalBackendTransport disposed'));
    try {
      this.worker?.terminate();
    } catch {
      // ignore
    }
    this.worker = null;
  }

  private handleBackendMessage(msg: BackendToHostMsg): void {
    if (this.disposed) return;
    if (this.disposing) {
      if (msg.type === 'disposed') {
        this.finishWorkerDispose();
        return;
      }
      // Still accept final SQLite/overlay persistence flushes emitted during graceful worker dispose.
      if (msg.type !== 'sqlite-persist' && msg.type !== 'php-overlay-persist' && msg.type !== 'rust-overlay-persist') {
        return;
      }
    }
    switch (msg.type) {
      case 'ready':
        this.isReady = true;
        this.resolveReady();
        return;

      case 'status':
        this.onStatus?.(msg.status);
        return;

      case 'ws-event': {
        const handler = this.wsHandlers.get(msg.wsId);
        if (!handler) return;
        if (msg.event.type === 'close') {
          this.wsHandlers.delete(msg.wsId);
        }
        handler(msg.event);
        return;
      }

      case 'error': {
        const err = new Error(msg.message);
        if (!this.isReady) this.rejectReady(err);
        this.onConsole?.('error', `[backend] ${msg.message}`);
        return;
      }

      case 'console':
        this.onConsole?.(msg.level, msg.text);
        return;

      case 'sqlite-persist': {
        if (!this.persistStorage) return;
        const dbKey = msg.dbKey;
        const prevRev = this.persistedRevisions.get(dbKey) ?? 0;
        const nextRev = Math.max(prevRev + 1, msg.meta?.revision ?? prevRev + 1);
        const checksum = msg.meta?.checksum ?? '';
        const schemaVersion = msg.meta?.schemaVersion ?? 1;
        const unsavedLimit = (why: string) => {
          const status: SqlitePersistenceStatus = {
            dbKey,
            state: 'storage-limit-reached',
            revision: prevRev,
            checksum: this.persistenceStatuses.get(dbKey)?.checksum,
            schemaVersion,
            byteLength: msg.bytes.byteLength,
            error: why,
          };
          this.setPersistenceStatus(status);
          this.pendingPersistWrites.set(dbKey, Promise.resolve(status));
          if (this.unsavedDbWarned.has(dbKey)) return;
          this.unsavedDbWarned.add(dbKey);
          this.onConsole?.('warn', `[backend] ${dbKey} is not saved for the next visit: ${why}`);
        };
        const maxOne = Math.min(this.maxSingleSqliteBytes, this.maxTotalSqliteBytes);
        if (msg.bytes.byteLength > maxOne) {
          unsavedLimit(`it is ${msg.bytes.byteLength} bytes, over the ${maxOne} kept`);
          return;
        }
        if (!this.persistedDbSizes.has(dbKey) && this.persistedDbSizes.size >= this.maxPersistedSqliteDbs) {
          unsavedLimit(`only ${this.maxPersistedSqliteDbs} databases are kept`);
          return;
        }
        let totalBytes = msg.bytes.byteLength;
        for (const [k, sz] of this.persistedDbSizes) {
          if (k !== dbKey) totalBytes += sz;
        }
        if (totalBytes > this.maxTotalSqliteBytes) {
          unsavedLimit(`the app's databases come to ${totalBytes} bytes, over the ${this.maxTotalSqliteBytes} kept`);
          return;
        }
        this.unsavedDbWarned.delete(dbKey);
        this.persistedDbSizes.set(dbKey, msg.bytes.byteLength);
        const updatedAt = Date.now();
        this.setPersistenceStatus({
          dbKey,
          state: 'saving',
          revision: prevRev,
          checksum,
          schemaVersion,
          byteLength: msg.bytes.byteLength,
          updatedAt,
        });
        const record: PersistedSqliteRecord = {
          format: 'softn-sqlite-v1',
          dbKey,
          revision: nextRev,
          checksum,
          schemaVersion,
          updatedAt,
          tabId: TAB_INSTANCE_ID,
          bytes: msg.bytes,
        };
        const writePromise = savePersistedBlob(`${this.storagePrefix}sqlite:${dbKey}`, record, this.storage, {
          expectedRevision: prevRev,
          metaKey: `${this.storagePrefix}sqlite-meta:${dbKey}`,
        }).then(
          (): SqlitePersistenceStatus => {
            this.persistedRevisions.set(dbKey, nextRev);
            const savedStatus: SqlitePersistenceStatus = {
              dbKey,
              state: 'saved',
              revision: nextRev,
              checksum,
              schemaVersion,
              byteLength: msg.bytes.byteLength,
              updatedAt,
            };
            this.setPersistenceStatus(savedStatus);
            return savedStatus;
          },
          (err: unknown): SqlitePersistenceStatus => {
            const pErr = err instanceof SqlitePersistenceError ? err : null;
            const errState: SqlitePersistenceState = pErr ? pErr.state : isQuotaError(err) ? 'storage-limit-reached' : 'unsaved-changes';
            const message = err instanceof Error ? err.message : String(err);
            const failedStatus: SqlitePersistenceStatus = {
              dbKey,
              state: errState,
              revision: prevRev,
              checksum: this.persistenceStatuses.get(dbKey)?.checksum,
              schemaVersion,
              byteLength: msg.bytes.byteLength,
              updatedAt,
              error: message,
            };
            this.setPersistenceStatus(failedStatus);
            this.onConsole?.('warn', `[backend] Failed to persist SQLite database "${dbKey}": ${message}`);
            return failedStatus;
          }
        );
        this.pendingPersistWrites.set(dbKey, writePromise);
        return;
      }

      case 'php-overlay-persist':
        if (this.persistStorage && msg.overlayJson.length <= 16 * 1024 * 1024) {
          void savePersistedBlob(`${this.storagePrefix}php-overlay`, msg.overlayJson, this.storage).catch(() => undefined);
        }
        return;

      case 'rust-overlay-persist':
        if (this.persistStorage && msg.overlayJson.length <= 16 * 1024 * 1024) {
          void savePersistedBlob(`${this.storagePrefix}rust-overlay`, msg.overlayJson, this.storage).catch(() => undefined);
        }
        return;

      case 'response': {
        const pending = this.pendingFetch.get(msg.reqId);
        if (!pending) return;
        this.pendingFetch.delete(msg.reqId);
        try {
          if (this.cookieJar.ingestResponseHeaders(msg.headers) && this.persistStorage) {
            void savePersistedBlob(`${this.storagePrefix}cookies`, this.cookieJar.serialize(), this.storage).catch(() => undefined);
          }
        } catch {
          // A request taken off the pending list is answered whatever its headers hold.
        }
        pending.resolve({
          status: msg.status,
          statusText: msg.statusText || statusTextFor(msg.status),
          headers: msg.headers,
          body: msg.bodyBytes,
        });
        return;
      }

      case 'rpc-reply': {
        const pending = this.pendingRpc.get(msg.reqId);
        if (!pending) return;
        this.pendingRpc.delete(msg.reqId);
        if (msg.ok) pending.resolve(msg.result);
        else pending.reject(new Error(msg.error || 'Backend RPC failed'));
        return;
      }
    }
  }

  async fetch(req: BackendHttpRequest): Promise<BackendHttpResponse> {
    await this.ready;
    if (this.disposed || this.disposing) throw new Error('LocalBackendTransport is disposed');
    const method = (req.method || 'GET').toUpperCase();
    if (!ALLOWED_BACKEND_METHODS.has(method)) {
      throw new Error(`Disallowed HTTP method: ${method}`);
    }
    const path = req.path.startsWith('/') ? req.path : `/${req.path}`;
    // eslint-disable-next-line no-control-regex
    if (path.includes('\0') || /[\u0000-\u001f\u007f]/.test(path)) {
      throw new Error('Invalid local backend request path');
    }
    const reqId = this.nextReqId++;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers ?? {})) {
      const lower = k.toLowerCase();
      // Filter forbidden/spoofed headers matching RemoteBackendTransport parity.
      if (
        !/^[a-z0-9-]+$/.test(lower) ||
        FORBIDDEN_FETCH_REQUEST_HEADERS.has(lower) ||
        lower.startsWith('sec-') ||
        lower.startsWith('proxy-') ||
        lower.startsWith('x-forwarded-') ||
        lower.startsWith('x-formlogic') ||
        /[\r\n\0]/.test(v)
      ) {
        continue;
      }
      headers[lower] = v;
    }

    // Attach container-scoped cookies strictly from VirtualCookieJar
    const jarCookie = this.cookieJar.getCookieHeader(path, true);
    if (jarCookie) {
      headers['cookie'] = jarCookie;
    }

    const bodyBytes =
      req.body === undefined
        ? undefined
        : typeof req.body === 'string'
          ? LOCAL_ENCODER.encode(req.body)
          : req.body;

    return new Promise<BackendHttpResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingFetch.delete(reqId)) {
          reject(new Error(`Local backend request timed out after ${DEFAULT_LOCAL_FETCH_TIMEOUT_MS}ms`));
        }
      }, DEFAULT_LOCAL_FETCH_TIMEOUT_MS);
      this.pendingFetch.set(reqId, {
        resolve: (resp) => {
          clearTimeout(timer);
          resolve(resp);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.post({
        type: 'fetch',
        reqId,
        method,
        path,
        query: req.query ?? '',
        headers,
        bodyBytes,
      });
    });
  }

  private registerPendingRpc(
    reqId: number,
    resolve: (v: unknown) => void,
    reject: (err: Error) => void,
    timeoutMs = 30_000
  ): void {
    const timer = setTimeout(() => {
      if (this.pendingRpc.delete(reqId)) {
        reject(new Error(`LocalBackendTransport RPC timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);
    this.pendingRpc.set(reqId, {
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      },
    });
  }

  async seedDatabase(
    dbName: string,
    seedJson: string | Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    await this.ready;
    if (this.disposed || this.disposing) throw new Error('LocalBackendTransport is disposed');
    const reqId = this.nextReqId++;
    const payload = typeof seedJson === 'string' ? seedJson : JSON.stringify(seedJson);
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      this.registerPendingRpc(reqId, (v) => resolve((v ?? {}) as Record<string, unknown>), reject);
      this.post({ type: 'seed-db', reqId, dbName, seedJson: payload });
    });
  }

  async exportDatabase(dbName: string): Promise<Uint8Array | null> {
    await this.ready;
    if (this.disposed || this.disposing) return null;
    const reqId = this.nextReqId++;
    return new Promise<Uint8Array | null>((resolve, reject) => {
      this.registerPendingRpc(reqId, (v) => resolve(v instanceof Uint8Array ? v : null), reject);
      this.post({ type: 'export-db', reqId, dbName });
    });
  }

  /** Return the latest acknowledged persistence status for a database (or all persisted DBs). */
  getPersistenceStatus(dbKey?: string): SqlitePersistenceStatus | Record<string, SqlitePersistenceStatus> | null {
    if (dbKey !== undefined) {
      return this.persistenceStatuses.get(dbKey) ?? null;
    }
    const out: Record<string, SqlitePersistenceStatus> = {};
    for (const [k, v] of this.persistenceStatuses) out[k] = v;
    return out;
  }

  /**
   * Flush dirty SQLite databases in the backend worker and await persistent storage
   * transaction acknowledgement (IndexedDB `tx.oncomplete` or Web Storage write).
   * Rejects if persistent storage fails, aborts, hits a revision conflict, or exceeds limits.
   */
  async flushAndAck(target?: { dbKey?: string; handleId?: number }): Promise<SqlitePersistenceStatus> {
    await this.ready;
    if (this.disposed || this.disposing) throw new Error('LocalBackendTransport is disposed');
    const reqId = this.nextReqId++;
    const ack = (await new Promise<{ dbKey: string | null; flushedKeys: string[] }>((resolve, reject) => {
      this.registerPendingRpc(
        reqId,
        (v) => resolve((v ?? { dbKey: null, flushedKeys: [] }) as { dbKey: string | null; flushedKeys: string[] }),
        reject
      );
      this.post({
        type: 'flush-ack',
        reqId,
        ...(target?.dbKey !== undefined ? { dbKey: target.dbKey } : {}),
        ...(typeof target?.handleId === 'number' ? { handleId: target.handleId } : {}),
      });
    }));

    const keysToAwait = new Set<string>(ack.flushedKeys);
    if (ack.dbKey) keysToAwait.add(ack.dbKey);
    if (keysToAwait.size === 0) {
      for (const k of this.pendingPersistWrites.keys()) keysToAwait.add(k);
    }

    let lastStatus: SqlitePersistenceStatus | null = null;
    for (const key of keysToAwait) {
      const pending = this.pendingPersistWrites.get(key);
      if (pending) {
        const st = await pending;
        lastStatus = st;
        if (st.state === 'storage-limit-reached' || st.state === 'unsaved-changes') {
          throw new SqlitePersistenceError(
            st.state,
            st.state === 'storage-limit-reached' ? 'quota-exceeded' : 'io-error',
            st.error || `Failed to persist database "${key}" (${st.state})`
          );
        }
      } else {
        const existing = this.persistenceStatuses.get(key);
        if (existing) {
          lastStatus = existing;
          if (existing.state === 'storage-limit-reached' || existing.state === 'unsaved-changes') {
            throw new SqlitePersistenceError(
              existing.state,
              existing.state === 'storage-limit-reached' ? 'quota-exceeded' : 'io-error',
              existing.error || `Failed to persist database "${key}" (${existing.state})`
            );
          }
        }
      }
    }

    const effectiveKey = ack.dbKey ?? ack.flushedKeys[0] ?? 'app.db';
    if (lastStatus) return lastStatus;
    return {
      dbKey: effectiveKey,
      state: 'saved',
      revision: this.persistedRevisions.get(effectiveKey) ?? 0,
      byteLength: this.persistedDbSizes.get(effectiveKey),
    };
  }

  async sqliteOp(
    op: SqliteOpName,
    args: unknown[]
  ): Promise<unknown> {
    await this.ready;
    if (this.disposed || this.disposing) throw new Error('LocalBackendTransport is disposed');
    if (op === 'flush') {
      const arg0 = args[0];
      return this.flushAndAck(
        typeof arg0 === 'number'
          ? { handleId: arg0 }
          : typeof arg0 === 'string' && arg0
            ? { dbKey: arg0 }
            : undefined
      );
    }
    if (op === 'persistence_status') {
      const arg0 = args[0];
      if (typeof arg0 === 'string' && arg0) return this.getPersistenceStatus(arg0);
      if (typeof arg0 === 'number') {
        const ack = await this.flushAndAck({ handleId: arg0 }).catch(() => null);
        return ack ?? this.getPersistenceStatus();
      }
      return this.getPersistenceStatus();
    }
    const reqId = this.nextReqId++;
    const transfer: Transferable[] = [];
    const preparedArgs = args.map((a) => {
      if (
        this.worker &&
        a instanceof Uint8Array &&
        a.buffer instanceof ArrayBuffer &&
        a.byteOffset === 0 &&
        a.byteLength === a.buffer.byteLength
      ) {
        const copy = a.slice();
        transfer.push(copy.buffer);
        return copy;
      }
      return a;
    });
    return new Promise<unknown>((resolve, reject) => {
      this.registerPendingRpc(reqId, resolve, reject);
      this.post({ type: 'sqlite-op', reqId, op, args: preparedArgs }, transfer);
    });
  }

  openWebSocket(
    rawPath: string,
    protocols: string[],
    onEvent: (event: BackendWsEvent) => void
  ): BackendWsHandle {
    const wsId = `ws-${this.nextWsId++}`;
    const qIdx = rawPath.indexOf('?');
    const pathname = (qIdx >= 0 ? rawPath.slice(0, qIdx) : rawPath) || '/';
    const cleanPath = pathname.startsWith('/') ? pathname : `/${pathname}`;
    const query = qIdx >= 0 ? rawPath.slice(qIdx + 1) : '';
    const headers: Record<string, string> = {};
    const jarCookie = this.cookieJar.getCookieHeader(cleanPath, true);
    if (jarCookie) headers['cookie'] = jarCookie;

    this.wsHandlers.set(wsId, onEvent);
    // A socket is open while its handler is registered: closed by the app, by the backend, or
    // with every other socket when the transport ends (`rejectAllPending`), it has had its
    // close, and is given no second one.
    const live = () => this.wsHandlers.get(wsId) === onEvent;

    const openNow = () => {
      if (!live()) return;
      if (this.disposed || this.disposing) {
        this.wsHandlers.delete(wsId);
        onEvent({ type: 'close', code: 1001, reason: 'LocalBackendTransport disposed', wasClean: false });
        return;
      }
      this.post({
        type: 'ws-open',
        wsId,
        path: cleanPath,
        query,
        headers,
        protocols: protocols.slice(),
      });
    };
    if (this.isReady) {
      openNow();
    } else {
      void this.ready.then(openNow, (err) => {
        if (!live()) return;
        this.wsHandlers.delete(wsId);
        onEvent({ type: 'error', message: err instanceof Error ? err.message : String(err) });
        onEvent({ type: 'close', code: 1006, reason: 'Backend failed to start', wasClean: false });
      });
    }

    return {
      send: (data: string | Uint8Array) => {
        if (this.disposed || this.disposing || !live()) return;
        if (typeof data === 'string') {
          this.post({ type: 'ws-send', wsId, data, binary: false });
        } else {
          // Encode in 32 KiB chunks to avoid allocating millions of single-byte strings on the main thread.
          const chunks: string[] = [];
          for (let off = 0; off < data.byteLength; off += 32768) {
            const end = Math.min(data.byteLength, off + 32768);
            let s = '';
            for (let i = off; i < end; i++) s += HEX_TABLE[data[i]];
            chunks.push(s);
          }
          this.post({ type: 'ws-send', wsId, data: chunks.join(''), binary: true });
        }
      },
      close: (code?: number, reason?: string) => {
        if (!live()) return;
        this.wsHandlers.delete(wsId);
        if (!this.disposed && !this.disposing) {
          this.post({ type: 'ws-close', wsId, code: code ?? 1000, reason: reason ?? '' });
        }
      },
    };
  }

  private rejectAllPending(err: Error): void {
    for (const p of this.pendingFetch.values()) p.reject(err);
    this.pendingFetch.clear();
    for (const p of this.pendingRpc.values()) p.reject(err);
    this.pendingRpc.clear();
    for (const handler of this.wsHandlers.values()) {
      try {
        handler({ type: 'close', code: 1001, reason: err.message, wasClean: false });
      } catch {
        // ignore
      }
    }
    this.wsHandlers.clear();
  }

  /** Request immediate flush of any debounced SQLite / VFS overlay writes to IndexedDB. */
  flush(): void {
    if (this.disposed || this.disposing) return;
    this.post({ type: 'flush' });
  }

  dispose(): void {
    if (this.disposed || this.disposing) return;
    const disposeErr = new Error('LocalBackendTransport disposed');
    // Flush inline session BEFORE marking disposed so final sqlite-persist messages save cleanly.
    try {
      this.inlineSession?.dispose();
    } catch {
      // ignore
    }
    this.inlineSession = null;
    this.disposing = true;
    if (!this.isReady) {
      this.rejectReady(disposeErr);
    }
    this.cookieJar.clear();
    this.rejectAllPending(disposeErr);
    if (this.worker) {
      // Give the backend worker a brief window to flush debounced SQLite/VFS writes
      // and reply with `{ type: 'disposed' }` before forcefully terminating it.
      try {
        this.worker.postMessage({ type: 'dispose' } satisfies HostToBackendMsg);
        this.disposeTimer = setTimeout(() => this.finishWorkerDispose(), 500);
      } catch {
        this.finishWorkerDispose();
      }
    } else {
      this.disposed = true;
    }
  }
}
