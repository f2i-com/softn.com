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
import {
  BackendWorkerSession,
  type BackendToHostMsg,
  type HostToBackendMsg,
} from './backend-runtime';
import { statusTextFor, VirtualCookieJar } from './backend-transport';
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

function openSqliteIdb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(SQLITE_IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(SQLITE_IDB_STORE)) {
          db.createObjectStore(SQLITE_IDB_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function loadPersistedBlobs(
  storagePrefix: string
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

  const idb = await openSqliteIdb();
  if (idb) {
    try {
      await new Promise<void>((resolve) => {
        const tx = idb.transaction(SQLITE_IDB_STORE, 'readonly');
        const store = tx.objectStore(SQLITE_IDB_STORE);
        const curReq = store.openCursor();
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
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      });
    } finally {
      try { idb.close(); } catch { /* ignore */ }
    }
    return { dbs, phpOverlay, rustOverlay, cookies };
  }

  // Fallback for environments with localStorage only (e.g. JSDOM tests)
  if (typeof localStorage !== 'undefined') {
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k) continue;
        if (k.startsWith(sqlPrefix)) {
          const b64 = localStorage.getItem(k);
          if (b64) dbs[k.slice(sqlPrefix.length)] = base64ToBytes(b64);
        } else if (k === ovKey) {
          const val = localStorage.getItem(k);
          if (val) phpOverlay = val;
        } else if (k === rustOvKey) {
          const val = localStorage.getItem(k);
          if (val) rustOverlay = val;
        } else if (k === cookiesKey) {
          const val = localStorage.getItem(k);
          if (val) cookies = val;
        }
      }
    } catch {
      // ignore restricted storage
    }
  }
  return { dbs, phpOverlay, rustOverlay, cookies };
}

export async function clearBackendPersistedBlobs(storagePrefix: string): Promise<void> {
  const idb = await openSqliteIdb();
  if (idb) {
    try {
      await new Promise<void>((resolve) => {
        const tx = idb.transaction(SQLITE_IDB_STORE, 'readwrite');
        const store = tx.objectStore(SQLITE_IDB_STORE);
        const curReq = store.openCursor();
        curReq.onsuccess = () => {
          const cur = curReq.result;
          if (!cur) return;
          if (String(cur.key).startsWith(storagePrefix)) cur.delete();
          cur.continue();
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      });
    } finally {
      try { idb.close(); } catch { /* ignore */ }
    }
  }
  if (typeof localStorage !== 'undefined') {
    try {
      const toRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(storagePrefix)) toRemove.push(k);
      }
      for (const k of toRemove) localStorage.removeItem(k);
    } catch {
      // ignore
    }
  }
}

async function savePersistedBlob(key: string, value: Uint8Array | string): Promise<void> {
  const idb = await openSqliteIdb();
  if (idb) {
    try {
      await new Promise<void>((resolve) => {
        const tx = idb.transaction(SQLITE_IDB_STORE, 'readwrite');
        tx.objectStore(SQLITE_IDB_STORE).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      });
    } finally {
      try { idb.close(); } catch { /* ignore */ }
    }
    return;
  }
  if (typeof localStorage !== 'undefined') {
    try {
      if (typeof value === 'string') {
        localStorage.setItem(key, value);
      } else {
        localStorage.setItem(key, bytesToBase64(value));
      }
    } catch {
      // ignore quota/storage errors
    }
  }
}

export interface LocalBackendTransportOptions {
  appId: string;
  storagePrefix: string;
  persistStorage?: boolean;
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
  onConsole?: (level: 'log' | 'info' | 'warn' | 'error', text: string) => void;
  onStatus?: (status: ContainerBootStatus) => void;
}

export class LocalBackendTransport implements BackendTransport {
  readonly kind: 'local-worker' | 'local-inline';
  readonly ready: Promise<void>;
  readonly cookieJar = new VirtualCookieJar();

  private readonly storagePrefix: string;
  private readonly persistStorage: boolean;
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
  private resolveReady!: () => void;
  private rejectReady!: (err: Error) => void;
  private isReady = false;
  private disposed = false;

  constructor(options: LocalBackendTransportOptions) {
    this.storagePrefix = options.storagePrefix;
    this.persistStorage = options.persistStorage !== false;
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
      const persisted = this.persistStorage
        ? await loadPersistedBlobs(this.storagePrefix)
        : {
            dbs: Object.create(null) as Record<string, Uint8Array>,
            phpOverlay: undefined,
            rustOverlay: undefined,
            cookies: undefined,
          };

      if (this.disposed) return;
      if (persisted.cookies) {
        this.cookieJar.hydrate(persisted.cookies);
      }

      if (useWorker) {
        const base = options.runtimeUrl.replace(/\/?$/, '/');
        const workerUrl = `${base}backend-worker.js`;
        const w = startModuleWorker(workerUrl, { name: `softn-backend-${options.appId}` });
        w.addEventListener('message', (ev: MessageEvent<BackendToHostMsg>) => {
          this.handleBackendMessage(ev.data);
        });
        w.addEventListener('error', (ev) => {
          const err = new Error(ev.message || 'Backend Worker crashed');
          if (!this.isReady) this.rejectReady(err);
          this.rejectAllPending(err);
        });
        this.worker = w;
      } else {
        this.inlineSession = new BackendWorkerSession((msg) => {
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
        if (this.persistStorage) {
          void savePersistedBlob(`${this.storagePrefix}sqlite:${msg.dbKey}`, msg.bytes);
        }
        return;

      case 'php-overlay-persist':
        if (this.persistStorage) {
          void savePersistedBlob(`${this.storagePrefix}php-overlay`, msg.overlayJson);
        }
        return;

      case 'rust-overlay-persist':
        if (this.persistStorage) {
          void savePersistedBlob(`${this.storagePrefix}rust-overlay`, msg.overlayJson);
        }
        return;

      case 'response': {
        const pending = this.pendingFetch.get(msg.reqId);
        if (!pending) return;
        this.pendingFetch.delete(msg.reqId);
        if (this.cookieJar.ingestResponseHeaders(msg.headers) && this.persistStorage) {
          void savePersistedBlob(`${this.storagePrefix}cookies`, this.cookieJar.serialize());
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
    const reqId = this.nextReqId++;
    const path = req.path.startsWith('/') ? req.path : `/${req.path}`;
    const headers: Record<string, string> = { ...(req.headers ?? {}) };

    // Merge container-scoped cookies from VirtualCookieJar
    const hasCookieHeader = Object.keys(headers).some((k) => k.toLowerCase() === 'cookie');
    const jarCookie = this.cookieJar.getCookieHeader(path, true);
    if (jarCookie && !hasCookieHeader) {
      headers['cookie'] = jarCookie;
    }

    const bodyBytes =
      req.body === undefined
        ? undefined
        : typeof req.body === 'string'
          ? new TextEncoder().encode(req.body)
          : req.body;

    return new Promise<BackendHttpResponse>((resolve, reject) => {
      this.pendingFetch.set(reqId, { resolve, reject });
      this.post({
        type: 'fetch',
        reqId,
        method: (req.method || 'GET').toUpperCase(),
        path,
        query: req.query ?? '',
        headers,
        bodyBytes,
      });
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
      this.pendingRpc.set(reqId, {
        resolve: (v) => resolve((v ?? {}) as Record<string, unknown>),
        reject,
      });
      this.post({ type: 'seed-db', reqId, dbName, seedJson: payload });
    });
  }

  async exportDatabase(dbName: string): Promise<Uint8Array | null> {
    await this.ready;
    if (this.disposed) return null;
    const reqId = this.nextReqId++;
    return new Promise<Uint8Array | null>((resolve, reject) => {
      this.pendingRpc.set(reqId, {
        resolve: (v) => resolve(v instanceof Uint8Array ? v : null),
        reject,
      });
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
      this.pendingRpc.set(reqId, { resolve, reject });
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
          let hex = '';
          for (let i = 0; i < data.byteLength; i++) {
            hex += data[i].toString(16).padStart(2, '0');
          }
          this.post({ type: 'ws-send', wsId, data: hex, binary: true });
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
    this.disposed = true;
    try {
      this.worker?.postMessage({ type: 'dispose' } satisfies HostToBackendMsg);
      this.worker?.terminate();
    } catch {
      // ignore
    }
    try {
      this.inlineSession?.dispose();
    } catch {
      // ignore
    }
    this.worker = null;
    this.inlineSession = null;
    this.cookieJar.clear();
    this.rejectAllPending(new Error('LocalBackendTransport disposed'));
  }
}
