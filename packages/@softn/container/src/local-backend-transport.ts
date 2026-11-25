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
  ZippEngineSource,
} from './types';

const SQLITE_IDB_NAME = 'softn-container-sqlite';
const SQLITE_IDB_STORE = 'blobs';
// v2 upgrades any pre-existing empty v1 DB that an older reader opened without onupgradeneeded.
const SQLITE_IDB_VERSION = 2;
const MAX_PERSISTED_SQLITE_DBS = 8;
const MAX_SINGLE_SQLITE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_PERSISTED_SQLITE_BYTES = 64 * 1024 * 1024;
const DEFAULT_LOCAL_FETCH_TIMEOUT_MS = 30_000;
const LOCAL_ENCODER = new TextEncoder();
const HEX_TABLE: readonly string[] = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

let cachedSqliteIdbPromise: Promise<IDBDatabase | null> | null = null;
let cachedSqliteIdbGlobal: IDBFactory | null = null;
const coalescedBlobWrites = new Map<string, { inFlight: boolean; pending?: Uint8Array | string; explicitStorage?: Storage }>();

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
  ovKey: string,
  rustOvKey: string,
  cookiesKey: string
): {
  dbs: Record<string, Uint8Array>;
  phpOverlay?: string;
  rustOverlay?: string;
  cookies?: string;
} {
  const dbs: Record<string, Uint8Array> = Object.create(null);
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
  return { dbs, phpOverlay, rustOverlay, cookies };
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
  phpOverlay?: string;
  rustOverlay?: string;
  cookies?: string;
}> {
  const dbs: Record<string, Uint8Array> = Object.create(null);
  let phpOverlay: string | undefined;
  let rustOverlay: string | undefined;
  let cookies: string | undefined;
  const sqlPrefix = `${storagePrefix}sqlite:`;
  const ovKey = `${storagePrefix}php-overlay`;
  const rustOvKey = `${storagePrefix}rust-overlay`;
  const cookiesKey = `${storagePrefix}cookies`;

  if (explicitStorage) {
    return readFallbackStorage(explicitStorage, sqlPrefix, ovKey, rustOvKey, cookiesKey);
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
            const val = cur.value;
            if (val instanceof Uint8Array) dbs[k.slice(sqlPrefix.length)] = val;
            else if (val instanceof ArrayBuffer) dbs[k.slice(sqlPrefix.length)] = new Uint8Array(val);
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
    return { dbs, phpOverlay, rustOverlay, cookies };
  }

  // Fallback for environments with localStorage only (e.g. JSDOM tests or opaque-origin iframes)
  const fallback = defaultWebStorage();
  if (fallback) {
    return readFallbackStorage(fallback, sqlPrefix, ovKey, rustOvKey, cookiesKey);
  }
  return { dbs, phpOverlay, rustOverlay, cookies };
}

export async function clearBackendPersistedBlobs(storagePrefix: string, explicitStorage?: Storage): Promise<void> {
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

async function writePersistedBlobOnce(key: string, value: Uint8Array | string, explicitStorage?: Storage): Promise<void> {
  if (!explicitStorage) {
    const idb = await openSqliteIdb();
    if (idb) {
      await new Promise<void>((resolve) => {
        try {
          const tx = idb.transaction(SQLITE_IDB_STORE, 'readwrite');
          tx.objectStore(SQLITE_IDB_STORE).put(value, key);
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
          tx.onabort = () => resolve();
        } catch {
          cachedSqliteIdbPromise = null;
          resolve();
        }
      });
      return;
    }
  }
  const store = explicitStorage ?? defaultWebStorage();
  if (store) {
    try {
      if (typeof value === 'string') {
        store.setItem(key, value);
      } else {
        store.setItem(key, bytesToBase64(value));
      }
    } catch {
      // ignore quota/storage errors
    }
  }
}

function savePersistedBlob(key: string, value: Uint8Array | string, explicitStorage?: Storage): Promise<void> {
  let slot = coalescedBlobWrites.get(key);
  if (slot) {
    slot.pending = value;
    slot.explicitStorage = explicitStorage;
    return Promise.resolve();
  }
  slot = { inFlight: true, pending: value, explicitStorage };
  coalescedBlobWrites.set(key, slot);
  return (async () => {
    try {
      while (slot.pending !== undefined) {
        const nextVal = slot.pending;
        const nextStore = slot.explicitStorage;
        slot.pending = undefined;
        await writePersistedBlobOnce(key, nextVal, nextStore);
      }
    } finally {
      coalescedBlobWrites.delete(key);
    }
  })();
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
  /** Maximum total persisted SQLite bytes across all DBs for this app (defaults to 64 MiB). */
  maxTotalSqliteBytes?: number;
  onConsole?: (level: 'log' | 'info' | 'warn' | 'error', text: string) => void;
  onStatus?: (status: ContainerBootStatus) => void;
}

export class LocalBackendTransport implements BackendTransport {
  readonly kind: 'local-worker' | 'local-inline';
  readonly ready: Promise<void>;
  readonly cookieJar = new VirtualCookieJar();

  private readonly storagePrefix: string;
  private readonly persistStorage: boolean;
  private readonly maxTotalSqliteBytes: number;
  private readonly storage?: Storage;
  private readonly onConsole?: (level: 'log' | 'info' | 'warn' | 'error', text: string) => void;
  private readonly onStatus?: (status: ContainerBootStatus) => void;
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
  private resolveReady!: () => void;
  private rejectReady!: (err: Error) => void;
  private isReady = false;
  private disposed = false;

  constructor(options: LocalBackendTransportOptions) {
    this.storagePrefix = options.storagePrefix;
    this.persistStorage = options.persistStorage !== false;
    this.maxTotalSqliteBytes =
      typeof options.maxTotalSqliteBytes === 'number' && Number.isFinite(options.maxTotalSqliteBytes) && options.maxTotalSqliteBytes > 0
        ? Math.min(options.maxTotalSqliteBytes, MAX_TOTAL_PERSISTED_SQLITE_BYTES)
        : MAX_TOTAL_PERSISTED_SQLITE_BYTES;
    this.storage = options.storage;
    this.onConsole = options.onConsole;
    this.onStatus = options.onStatus;
    const useWorker = options.isolation === 'worker' && typeof Worker === 'function';
    this.kind = useWorker ? 'local-worker' : 'local-inline';

    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });

    void this.boot(options, useWorker);
  }

  private post(msg: HostToBackendMsg): void {
    if (this.disposed) return;
    if (this.worker) {
      this.worker.postMessage(msg);
    } else if (this.inlineSession) {
      void this.inlineSession.handleMessage(msg);
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
              phpOverlay: undefined,
              rustOverlay: undefined,
              cookies: undefined,
            }),
        useWorker ? Promise.resolve(null) : import('./backend-runtime').then((m) => m.BackendWorkerSession),
      ]);

      if (this.disposed || workerFailed) return;
      this.persistedDbSizes.clear();
      for (const [dbKey, bytes] of Object.entries(persisted.dbs)) {
        if (bytes instanceof Uint8Array) this.persistedDbSizes.set(dbKey, bytes.byteLength);
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
        initialPhpOverlay: persisted.phpOverlay,
        initialRustOverlay: persisted.rustOverlay,
        runtimeUrl: options.runtimeUrl,
        engineModule: options.engineModule,
        xdbModule: options.xdbModule,
        xdbGlueUrl: options.xdbGlueUrl,
        instructionBudget: options.instructionBudget,
      });
    } catch (err) {
      this.rejectReady(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private handleBackendMessage(msg: BackendToHostMsg): void {
    if (this.disposed) return;
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

      case 'sqlite-persist':
        if (this.persistStorage && msg.bytes.byteLength <= Math.min(MAX_SINGLE_SQLITE_BYTES, this.maxTotalSqliteBytes)) {
          if (!this.persistedDbSizes.has(msg.dbKey) && this.persistedDbSizes.size >= MAX_PERSISTED_SQLITE_DBS) {
            return;
          }
          let totalBytes = msg.bytes.byteLength;
          for (const [k, sz] of this.persistedDbSizes) {
            if (k !== msg.dbKey) totalBytes += sz;
          }
          if (totalBytes > this.maxTotalSqliteBytes) {
            return;
          }
          this.persistedDbSizes.set(msg.dbKey, msg.bytes.byteLength);
          void savePersistedBlob(`${this.storagePrefix}sqlite:${msg.dbKey}`, msg.bytes, this.storage);
        }
        return;

      case 'php-overlay-persist':
        if (this.persistStorage && msg.overlayJson.length <= 16 * 1024 * 1024) {
          void savePersistedBlob(`${this.storagePrefix}php-overlay`, msg.overlayJson, this.storage);
        }
        return;

      case 'rust-overlay-persist':
        if (this.persistStorage && msg.overlayJson.length <= 16 * 1024 * 1024) {
          void savePersistedBlob(`${this.storagePrefix}rust-overlay`, msg.overlayJson, this.storage);
        }
        return;

      case 'response': {
        const pending = this.pendingFetch.get(msg.reqId);
        if (!pending) return;
        this.pendingFetch.delete(msg.reqId);
        if (this.cookieJar.ingestResponseHeaders(msg.headers) && this.persistStorage) {
          void savePersistedBlob(`${this.storagePrefix}cookies`, this.cookieJar.serialize(), this.storage);
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
    if (this.disposed) throw new Error('LocalBackendTransport is disposed');
    const method = (req.method || 'GET').toUpperCase();
    if (!ALLOWED_BACKEND_METHODS.has(method)) {
      throw new Error(`Disallowed HTTP method: ${method}`);
    }
    const path = req.path.startsWith('/') ? req.path : `/${req.path}`;
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
    if (this.disposed) throw new Error('LocalBackendTransport is disposed');
    const reqId = this.nextReqId++;
    const payload = typeof seedJson === 'string' ? seedJson : JSON.stringify(seedJson);
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      this.registerPendingRpc(reqId, (v) => resolve((v ?? {}) as Record<string, unknown>), reject);
      this.post({ type: 'seed-db', reqId, dbName, seedJson: payload });
    });
  }

  async exportDatabase(dbName: string): Promise<Uint8Array | null> {
    await this.ready;
    if (this.disposed) return null;
    const reqId = this.nextReqId++;
    return new Promise<Uint8Array | null>((resolve, reject) => {
      this.registerPendingRpc(reqId, (v) => resolve(v instanceof Uint8Array ? v : null), reject);
      this.post({ type: 'export-db', reqId, dbName });
    });
  }

  async sqliteOp(
    op: 'open' | 'execute' | 'query' | 'seed_json' | 'close',
    args: unknown[]
  ): Promise<unknown> {
    await this.ready;
    if (this.disposed) throw new Error('LocalBackendTransport is disposed');
    const reqId = this.nextReqId++;
    return new Promise<unknown>((resolve, reject) => {
      this.registerPendingRpc(reqId, resolve, reject);
      this.post({ type: 'sqlite-op', reqId, op, args });
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

    let closed = false;
    this.wsHandlers.set(wsId, onEvent);

    const openNow = () => {
      if (this.disposed || closed) return;
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
        if (closed) return;
        closed = true;
        this.wsHandlers.delete(wsId);
        onEvent({ type: 'error', message: err instanceof Error ? err.message : String(err) });
        onEvent({ type: 'close', code: 1006, reason: 'Backend failed to start', wasClean: false });
      });
    }

    return {
      send: (data: string | Uint8Array) => {
        if (this.disposed || closed) return;
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
        if (closed) return;
        closed = true;
        this.wsHandlers.delete(wsId);
        if (!this.disposed) {
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
    if (this.disposed) return;
    this.post({ type: 'flush' });
  }

  dispose(): void {
    if (this.disposed) return;
    // Flush inline session BEFORE marking disposed so final sqlite-persist messages save cleanly.
    try {
      this.inlineSession?.dispose();
    } catch {
      // ignore
    }
    this.disposed = true;
    try {
      this.worker?.postMessage({ type: 'dispose' } satisfies HostToBackendMsg);
      this.worker?.terminate();
    } catch {
      // ignore
    }
    this.worker = null;
    this.inlineSession = null;
    this.cookieJar.clear();
    this.rejectAllPending(new Error('LocalBackendTransport disposed'));
  }
}
