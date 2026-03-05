import type { AppPermissions } from '../bundle/types';
import type { DBMutation, LSMutation } from './formlogic-worker-bridges';

type ImportResolver = (path: string) => Promise<string | null>;
import type {
  CodeBlock,
  FormLogicContext,
  ScriptLoadResult,
  ScriptRuntimeHandle,
} from './formlogic';
import { getSyncModuleCache } from './formlogic';

type WorkerPayloadMap = {
  init: Record<string, unknown>;
  call_fn: Record<string, unknown>;
  update_context: { state: Record<string, unknown> };
};

type WorkerResponse = {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
};

type WorkerImportRequest = { type: 'import_request'; id: number; path: string };

function isWorkerResponse(msg: unknown): msg is WorkerResponse {
  return !!msg && typeof msg === 'object' && 'id' in (msg as Record<string, unknown>) && 'ok' in (msg as Record<string, unknown>);
}

function isImportRequest(msg: unknown): msg is WorkerImportRequest {
  return !!msg && typeof msg === 'object' && (msg as Record<string, unknown>).type === 'import_request';
}

/**
 * Extract serializable event properties from a native DOM Event.
 */
function extractEventProps(e: Event): Record<string, unknown> {
  const ev: Record<string, unknown> = { type: e.type };
  if (e instanceof MouseEvent) {
    ev.clientX = e.clientX;
    ev.clientY = e.clientY;
    ev.button = e.button;
  }
  if (e instanceof KeyboardEvent) {
    ev.key = e.key;
    ev.code = e.code;
    ev.altKey = e.altKey;
    ev.ctrlKey = e.ctrlKey;
    ev.shiftKey = e.shiftKey;
    ev.metaKey = e.metaKey;
    ev.repeat = e.repeat;
  }
  return ev;
}

/**
 * Sanitize a value for postMessage (structured clone). Strips DOM objects,
 * native Events, React SyntheticEvents, and other non-cloneable values.
 */
function sanitizeForPostMessage(a: unknown): unknown {
  if (a == null || typeof a !== 'object') return a;
  if (typeof a === 'function') return undefined;

  // Native DOM Event (PointerEvent, MouseEvent, KeyboardEvent, etc.)
  if (typeof Event !== 'undefined' && a instanceof Event) {
    return extractEventProps(a);
  }

  // React SyntheticEvent — wraps a native DOM Event in a plain object with
  // nativeEvent property. Not instanceof Event, but still not cloneable
  // because it holds references to DOM nodes (target, currentTarget).
  const obj = a as Record<string, unknown>;
  if ('nativeEvent' in obj && typeof Event !== 'undefined' && obj.nativeEvent instanceof Event) {
    return extractEventProps(obj.nativeEvent as Event);
  }

  // DOM Node
  if (typeof Node !== 'undefined' && a instanceof Node) return {};

  return a;
}

export class WorkerScriptRuntime implements ScriptRuntimeHandle {
  private worker: Worker;
  private workerUrl: URL;
  private context: FormLogicContext;
  private importResolver?: ImportResolver;
  private permissions?: AppPermissions;
  private appId?: string;
  private logicBasePath?: string;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  private static readonly RPC_TIMEOUT_MS = 15000;
  private safeAppId: string;
  /** Tracks the worker's last known state to avoid redundant update_context calls. */
  private lastKnownWorkerState: Record<string, unknown> = {};
  /** Dirty flag: true when DB data has changed and the worker needs a fresh snapshot. */
  private dbDirty = true;
  /** Set of collection names that have changed since the last snapshot sent to the worker.
   *  null means "all collections dirty" (full snapshot needed, e.g. initial load). */
  private dbDirtyCollections: Set<string> | null = null;
  /** Dirty flag: true when localStorage has changed and the worker needs a fresh snapshot. */
  private lsDirty = true;
  /** Maps worker-created temp IDs (_wk_*) to real XDB IDs. */
  private tempIdMap = new Map<string, string>();
  /** Performance tracking for worker RPC calls. */
  private perfCallCount = 0;
  private perfTotalMs = 0;
  private perfLastReport = 0;

  constructor(
    context: FormLogicContext,
    permissions?: AppPermissions,
    appId?: string,
    importResolver?: ImportResolver,
    logicBasePath?: string
  ) {
    this.context = context;
    this.importResolver = importResolver;
    this.permissions = permissions;
    this.appId = appId;
    this.logicBasePath = logicBasePath;
    this.safeAppId = (appId || '_default').replace(/[^a-zA-Z0-9_-]/g, '_');
    // Use a static URL reference so bundlers can emit and rewrite the worker asset path.
    this.workerUrl = new URL('./core-runtime/runtime/formlogic-worker.js', import.meta.url);
    this.worker = new Worker(this.workerUrl, { type: 'module' });
    this.worker.onmessage = (evt: MessageEvent) => this.onWorkerMessage(evt);
    this.worker.onerror = (evt: ErrorEvent) => {
      const details = [
        evt.message || 'worker_error',
        evt.filename ? `file=${evt.filename}` : '',
        evt.lineno ? `line=${evt.lineno}` : '',
        evt.colno ? `col=${evt.colno}` : '',
        `url=${this.workerUrl.toString()}`,
      ].filter(Boolean).join(' | ');
      const err = evt.error || new Error(details);
      console.error('[SoftN Worker] onerror', details, evt.error);
      for (const [, p] of this.pending) p.reject(err);
      this.pending.clear();
    };
    this.worker.onmessageerror = (evt: MessageEvent) => {
      const err = new Error(`worker_message_error | url=${this.workerUrl.toString()}`);
      console.error('[SoftN Worker] onmessageerror', evt);
      for (const [, p] of this.pending) p.reject(err);
      this.pending.clear();
    };
  }

  // ==========================================================================
  // Snapshot collection (main thread → worker)
  // ==========================================================================

  /**
   * Collect current XDB data as a serializable snapshot.
   * Uses context.data which is kept up-to-date by SoftNRenderer subscriptions.
   */
  private getDBSnapshot(): Record<string, unknown[]> {
    return (this.context.data || {}) as Record<string, unknown[]>;
  }

  /**
   * Collect app-prefixed localStorage keys as a snapshot (unprefixed keys).
   */
  private getLocalStorageSnapshot(): Record<string, string> {
    const snapshot: Record<string, string> = {};
    const prefix = `softn:${this.safeAppId}:`;
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k?.startsWith(prefix)) {
          const v = localStorage.getItem(k);
          if (v !== null) {
            snapshot[k.slice(prefix.length)] = v;
          }
        }
      }
    } catch { /* localStorage may be unavailable */ }
    return snapshot;
  }

  /**
   * Get current sync status for the snapshot.
   */
  private getSyncStatus(): { connected: boolean; peers: number; room: string; peerId: string } {
    try {
      const mod = getSyncModuleCache();
      if (mod) {
        const adapter = mod.getSyncAdapter();
        return adapter ? adapter.getStatus() : { connected: false, peers: 0, room: '', peerId: '' };
      }
    } catch { /* ignore */ }
    return { connected: false, peers: 0, room: '', peerId: '' };
  }

  /**
   * Get saved sync room name.
   */
  private getSavedSyncRoom(): string | null {
    try { return localStorage.getItem('xdb-sync-active-room'); } catch { return null; }
  }

  // ==========================================================================
  // Mutation application (worker → main thread)
  // ==========================================================================

  /**
   * Apply DB mutations from the worker to the real XDB.
   */
  /**
   * Resolve a mutation ID — if it's a worker temp ID (_wk_*), look up the real XDB ID.
   */
  private resolveId(id: string): string {
    return this.tempIdMap.get(id) ?? id;
  }

  private async applyDBMutations(mutations: DBMutation[]): Promise<void> {
    if (!mutations || mutations.length === 0) return;
    // Worker mutations change DB state — track which collections are dirty
    // so the next call can send a delta instead of a full snapshot.
    this.dbDirty = true;
    try {
      const { getXDB } = await import('./xdb');
      const xdb = getXDB();
      for (const m of mutations) {
        switch (m.type) {
          case 'create': {
            const record = xdb.create(m.collection, m.data);
            if (this.dbDirtyCollections !== null) this.dbDirtyCollections.add(m.collection);
            // Map the worker's temp ID to the real XDB ID so future
            // update/delete mutations from the worker resolve correctly.
            if (m.tempId && record.id !== m.tempId) {
              this.tempIdMap.set(m.tempId, record.id);
            }
            break;
          }
          case 'update':
            xdb.update(this.resolveId(m.id), m.data);
            // update doesn't carry collection name, so mark all dirty
            this.dbDirtyCollections = null;
            break;
          case 'delete':
            xdb.delete(this.resolveId(m.id));
            this.dbDirtyCollections = null;
            break;
          case 'hardDelete': {
            const realId = this.resolveId(m.id);
            xdb.hardDelete(m.collection, realId);
            if (this.dbDirtyCollections !== null) this.dbDirtyCollections.add(m.collection);
            // Clean up the mapping once the record is gone
            if (realId !== m.id) this.tempIdMap.delete(m.id);
            break;
          }
          case 'startSync':
            import('./xdb-sync').then((mod) => {
              mod.startSync({ room: m.room, ...(m.options || {}) });
            }).catch((err) => console.error('[Worker Bridge] startSync error:', err));
            break;
          case 'stopSync':
            import('./xdb-sync').then(({ stopSync }) => {
              stopSync(m.room);
            }).catch((err) => console.error('[Worker Bridge] stopSync error:', err));
            break;
        }
      }
    } catch (err) {
      console.error('[Worker Bridge] applyDBMutations error:', err);
    }
  }

  /**
   * Apply localStorage mutations from the worker.
   */
  /**
   * Mark DB snapshot as dirty so the next worker call includes fresh data.
   * Called when external changes (e.g. P2P sync, React state) modify context.data.
   */
  markDbDirty(collection?: string): void {
    this.dbDirty = true;
    if (collection && this.dbDirtyCollections !== null) {
      this.dbDirtyCollections.add(collection);
    } else {
      // No collection specified or already in full-snapshot mode
      this.dbDirtyCollections = null;
    }
  }

  private applyLSMutations(mutations: LSMutation[]): void {
    if (!mutations || mutations.length === 0) return;
    // Worker mutations change LS state — mark dirty so next call sends a fresh snapshot
    this.lsDirty = true;
    const prefix = `softn:${this.safeAppId}:`;
    try {
      for (const m of mutations) {
        switch (m.type) {
          case 'setItem':
            localStorage.setItem(prefix + m.key, m.value);
            break;
          case 'removeItem':
            localStorage.removeItem(prefix + m.key);
            break;
          case 'clear': {
            const keysToRemove: string[] = [];
            for (let i = 0; i < localStorage.length; i++) {
              const k = localStorage.key(i);
              if (k?.startsWith(prefix)) keysToRemove.push(k);
            }
            for (const k of keysToRemove) localStorage.removeItem(k);
            break;
          }
        }
      }
    } catch (err) {
      console.error('[Worker Bridge] applyLSMutations error:', err);
    }
  }

  // ==========================================================================
  // RPC
  // ==========================================================================

  private onWorkerMessage(evt: MessageEvent) {
    const msg = evt.data as unknown;
    if (isImportRequest(msg)) {
      const path = msg.path;
      Promise.resolve(this.importResolver ? this.importResolver(path) : null)
        .then((source) => {
          this.worker.postMessage({ type: 'import_response', id: msg.id, source: source ?? null });
        })
        .catch(() => {
          this.worker.postMessage({ type: 'import_response', id: msg.id, source: null });
        });
      return;
    }
    if (!isWorkerResponse(msg)) return;
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    if (msg.ok) pending.resolve(msg.result);
    else pending.reject(new Error(msg.error || 'worker_rpc_failed'));
  }

  private call<T = unknown>(type: 'init', payload: WorkerPayloadMap['init']): Promise<T>;
  private call<T = unknown>(type: 'call_fn', payload: WorkerPayloadMap['call_fn']): Promise<T>;
  private call<T = unknown>(type: 'update_context', payload: WorkerPayloadMap['update_context']): Promise<T>;
  private call<T = unknown>(type: string, payload: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`worker_rpc_timeout:${type}`));
      }, WorkerScriptRuntime.RPC_TIMEOUT_MS);

      this.pending.set(id, {
        resolve: (v: unknown) => {
          clearTimeout(timeout);
          (resolve as (v: unknown) => void)(v);
        },
        reject: (e: unknown) => {
          clearTimeout(timeout);
          reject(e);
        }
      });
      this.worker.postMessage({ id, type, payload });
    });
  }

  // ==========================================================================
  // ScriptRuntimeHandle implementation
  // ==========================================================================

  async loadScript(script: CodeBlock): Promise<ScriptLoadResult> {
    const res = await this.call<{
      state: Record<string, unknown>;
      functionNames: string[];
      syncFunctionNames: string[];
      computedNames: string[];
      dbMutations: DBMutation[];
      lsMutations: LSMutation[];
    }>('init', {
      script,
      permissions: this.permissions,
      appId: this.appId,
      logicBasePath: this.logicBasePath,
      dbSnapshot: this.getDBSnapshot(),
      lsSnapshot: this.getLocalStorageSnapshot(),
      syncStatus: this.getSyncStatus(),
      savedSyncRoom: this.getSavedSyncRoom(),
    });

    Object.assign(this.context.state, res.state || {});
    // Track initial worker state for diffing in updateContext
    this.lastKnownWorkerState = { ...(res.state || {}) };

    // Apply any mutations from script initialization (_init, top-level code)
    void this.applyDBMutations(res.dbMutations || []);
    this.applyLSMutations(res.lsMutations || []);

    const applyState = (nextState: Record<string, unknown>) => {
      if (!nextState || Object.keys(nextState).length === 0) return;
      // Track what the worker reported so updateContext can skip redundant sends
      Object.assign(this.lastKnownWorkerState, nextState);
      // Update context.state immediately so template Identifier lookups (e.g. {pot})
      // resolve correctly. Also set _vmDirty so the main-thread WASM VM knows to
      // push these values on the next sync function call.
      Object.assign(this.context.state, nextState);
      (this.context as unknown as Record<string, unknown>)._vmDirty = true;
      if (this.context.batchSetState) {
        this.context.batchSetState(nextState);
      } else {
        for (const [k, v] of Object.entries(nextState)) {
          this.context.setState(k, v);
        }
      }
    };

    const makeAsyncFn = (name: string) => async (...args: unknown[]) => {
      const safeArgs = args.map(a => sanitizeForPostMessage(a));

      // Send DB/LS snapshots only when data has actually changed (dirty flag).
      // When only specific collections changed, send a delta instead of the
      // full snapshot to reduce structured-clone overhead across the worker boundary.
      const payload: Record<string, unknown> = { name, args: safeArgs };
      if (this.dbDirty) {
        const fullData = this.getDBSnapshot();
        if (this.dbDirtyCollections !== null && this.dbDirtyCollections.size > 0) {
          // Send only the changed collections as a delta
          const delta: Record<string, unknown[]> = {};
          for (const col of this.dbDirtyCollections) {
            delta[col] = fullData[col] || [];
          }
          payload.dbDelta = delta;
        } else {
          // Full snapshot (initial load or unknown which collections changed)
          payload.dbSnapshot = fullData;
        }
        this.dbDirty = false;
        this.dbDirtyCollections = new Set();
      }
      if (this.lsDirty) {
        payload.lsSnapshot = this.getLocalStorageSnapshot();
        this.lsDirty = false;
      }
      // syncStatus and savedSyncRoom are tiny — always send for correctness
      payload.syncStatus = this.getSyncStatus();
      payload.savedSyncRoom = this.getSavedSyncRoom();

      const t0 = performance.now();
      const out = await this.call<{
        result: unknown;
        state: Record<string, unknown>;
        dbMutations: DBMutation[];
        lsMutations: LSMutation[];
      }>('call_fn', payload);
      const elapsed = performance.now() - t0;
      this.perfCallCount++;
      this.perfTotalMs += elapsed;
      if (t0 - this.perfLastReport > 5000) {
        console.log(`[Worker RPC] ${this.perfCallCount} calls, avg ${(this.perfTotalMs / Math.max(1, this.perfCallCount)).toFixed(1)}ms, total ${this.perfTotalMs.toFixed(0)}ms (last 5s)`);
        this.perfCallCount = 0;
        this.perfTotalMs = 0;
        this.perfLastReport = t0;
      }

      // Apply mutations from worker to real storage (fire-and-forget for DB)
      void this.applyDBMutations(out.dbMutations || []);
      this.applyLSMutations(out.lsMutations || []);

      // Apply state changes to React
      applyState(out.state || {});
      return out.result;
    };

    const asyncFns: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
    for (const name of res.functionNames || []) {
      asyncFns[name] = makeAsyncFn(name);
    }

    const syncFns: Record<string, (...args: unknown[]) => unknown> = {};
    for (const name of res.syncFunctionNames || []) {
      syncFns[name] = makeAsyncFn(name) as unknown as (...args: unknown[]) => unknown;
    }

    const computed: Record<string, () => unknown> = {};
    for (const name of res.computedNames || []) {
      computed[name] = () => (this.context.state as Record<string, unknown>)[name];
    }

    return {
      state: res.state || {},
      functions: asyncFns,
      syncFunctions: syncFns,
      computed,
    };
  }

  updateContext(newState: Record<string, unknown>): void {
    Object.assign(this.context.state, newState);
    // Only send keys that differ from what the worker already has.
    // This avoids the expensive postMessage round-trip when state changes
    // originated from the worker itself (pollGameState, event handlers, etc.).
    const diff: Record<string, unknown> = {};
    let hasDiff = false;
    for (const key of Object.keys(newState)) {
      if (newState[key] !== this.lastKnownWorkerState[key]) {
        diff[key] = newState[key];
        hasDiff = true;
      }
    }
    if (!hasDiff) return;
    // Update tracking so subsequent calls don't re-send
    Object.assign(this.lastKnownWorkerState, diff);
    void this.call('update_context', { state: diff }).catch(() => {});
  }

  cleanup(): void {
    for (const [, p] of this.pending) p.reject(new Error('worker_terminated'));
    this.pending.clear();
    this.worker.terminate();
  }
}

export function createWorkerScriptRuntime(
  context: FormLogicContext,
  permissions?: AppPermissions,
  appId?: string,
  importResolver?: ImportResolver,
  logicBasePath?: string
): ScriptRuntimeHandle {
  return new WorkerScriptRuntime(context, permissions, appId, importResolver, logicBasePath);
}
