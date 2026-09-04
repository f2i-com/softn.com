import type { AppPermissions } from '../bundle/types';
import type { DBMutation, LSMutation } from './script-worker-bridges';

type ImportResolver = (path: string) => Promise<string | null>;
import type {
  BundleFileProvider,
  CodeBlock,
  HostCallExecutor,
  PendingHostCall,
  PermissionConfig,
  ScriptContext,
  ScriptLoadResult,
  ScriptRuntimeHandle,
} from './script-runtime';
import {
  buildExternalValuesPreamble,
  createHostCallExecutor,
  getSyncModuleCache,
} from './script-runtime';

type WorkerPayloadMap = {
  init: Record<string, unknown>;
  call_fn: Record<string, unknown>;
  resolve_host_call: Record<string, unknown>;
  dispatch_event: Record<string, unknown>;
  update_context: { state: Record<string, unknown> };
};

/** What every entry into the worker's VM hands back; `afterEntry` in script-worker.ts. */
type EntryResult = {
  state?: Record<string, unknown>;
  hostCalls?: PendingHostCall[];
  eventTypes?: string[];
  dbMutations?: DBMutation[];
  lsMutations?: LSMutation[];
};

export interface WorkerRuntimeOptions {
  /** The state variables the template can observe; the rest stay VM-owned. */
  observedStateNames?: ReadonlySet<string>;
  /** Logic files the shell already inlined; their `import` lines are satisfied. */
  preIncludedLogicPaths?: readonly string[];
  /** The bundle's `permission.json`, for the host calls run on this thread. */
  permissionConfig?: PermissionConfig;
  bundleFileProvider?: BundleFileProvider;
  /**
   * Functions the host injects into the script. The worker is handed the same
   * snapshot of primitive getter values the main-thread runtime compiles; the
   * host calls run here keep the live functions (`asset`, for audio sources).
   */
  externalFunctions?: Record<string, (...args: unknown[]) => unknown>;
  /** Where `softn.storage.*` sends its operations; see ScriptRuntimeOptions. */
  storageEndpoint?: string;
}

/**
 * Events the browser fires faster than a script can use them. Delivered at
 * most once a frame, as the main-thread runtime does.
 */
const THROTTLED_EVENTS = new Set(['mousemove', 'pointermove', 'scroll', 'resize', 'touchmove', 'wheel']);
const THROTTLE_MS = 16;

/** Host calls resolved per chain before it is judged a runaway. */
const MAX_HOST_CALL_ROUNDS = 256;

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
  private context: ScriptContext;
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
  /**
   * The state variables the template can observe. The worker mirrors only
   * these; everything else stays VM-owned — the same partition the main-thread
   * runtime makes, for the same reason (see its `partitionStateVars`): a
   * variable nothing reads must not be pulled out of the VM on every call, and
   * one that is never read out must never be written back either.
   */
  private observedStateNames: ReadonlySet<string> | null = null;
  /**
   * Logic files the shell inlined before handing the script over; their
   * `import` lines are already satisfied and must not be resolved again.
   */
  private preIncludedLogicPaths: string[] = [];
  /** Performance tracking for worker RPC calls. */
  private perfCallCount = 0;
  private perfTotalMs = 0;
  private perfLastReport = 0;
  /**
   * Runs the script's `softn.*` calls on this thread. The worker reports what
   * the script queued after every entry; each result goes back as a
   * `resolve_host_call`.
   */
  private hostExecutor: HostCallExecutor;
  private externalFunctions: Record<string, (...args: unknown[]) => unknown> | null = null;
  /** Event types with a DOM listener forwarding into the worker. */
  private bridgedEventTypes = new Set<string>();
  private nativeListeners: Array<[string, (e: Event) => void]> = [];
  private disposed = false;
  /** State changes not yet handed to React; flushed once a frame. */
  private pendingReactState: Record<string, unknown> = {};
  private reactFlushScheduled = false;

  constructor(
    context: ScriptContext,
    permissions?: AppPermissions,
    appId?: string,
    importResolver?: ImportResolver,
    logicBasePath?: string,
    options?: WorkerRuntimeOptions
  ) {
    this.context = context;
    this.importResolver = importResolver;
    this.permissions = permissions;
    this.appId = appId;
    this.logicBasePath = logicBasePath;
    this.observedStateNames = options?.observedStateNames ?? null;
    this.preIncludedLogicPaths = options?.preIncludedLogicPaths ? [...options.preIncludedLogicPaths] : [];
    this.externalFunctions = options?.externalFunctions ?? null;
    this.hostExecutor = createHostCallExecutor(
      context,
      permissions,
      appId,
      importResolver,
      logicBasePath,
      { mode: 'main', permissionConfig: options?.permissionConfig, storageEndpoint: options?.storageEndpoint },
      options?.bundleFileProvider,
      options?.externalFunctions
    );
    this.safeAppId = (appId || '_default').replace(/[^a-zA-Z0-9_-]/g, '_');
    // Use a static URL reference so bundlers can emit and rewrite the worker asset path.
    // The worker lives in the copy of core's dist that the web app ships as
    // assets/core-runtime/ (see coreWorkerAssetPlugin), next to the chunk it
    // imports and the engine .wasm it loads relative to itself. The path is
    // built from a variable on purpose: a literal here is rewritten by Vite
    // into a lone hashed copy under assets/, whose `../chunk-*.js` import
    // then 404s and the worker dies with a bare `worker_error`.
    const workerPath = './core-runtime/runtime/script-worker.js';
    this.workerUrl = new URL(workerPath, import.meta.url);
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
  private call<T = unknown>(type: 'resolve_host_call', payload: WorkerPayloadMap['resolve_host_call']): Promise<T>;
  private call<T = unknown>(type: 'dispatch_event', payload: WorkerPayloadMap['dispatch_event']): Promise<T>;
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
      observedStateNames: this.observedStateNames ? [...this.observedStateNames] : null,
      preIncludedLogicPaths: this.preIncludedLogicPaths,
      externalPreamble: buildExternalValuesPreamble(this.externalFunctions),
      dbSnapshot: this.getDBSnapshot(),
      lsSnapshot: this.getLocalStorageSnapshot(),
      syncStatus: this.getSyncStatus(),
      savedSyncRoom: this.getSavedSyncRoom(),
    });

    Object.assign(this.context.state, res.state || {});
    // Track initial worker state for diffing in updateContext
    this.lastKnownWorkerState = { ...(res.state || {}) };

    // Whatever top-level code queued or registered. The initial state is the
    // caller's to merge, so it is not re-applied here.
    void this.applyEntry({ ...res, state: {} });

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
      const out = await this.call<EntryResult & { result: unknown }>('call_fn', payload);
      const elapsed = performance.now() - t0;
      this.perfCallCount++;
      this.perfTotalMs += elapsed;
      if (t0 - this.perfLastReport > 5000) {
        console.debug(`[Worker RPC] ${this.perfCallCount} calls, avg ${(this.perfTotalMs / Math.max(1, this.perfCallCount)).toFixed(1)}ms, total ${this.perfTotalMs.toFixed(0)}ms (last 5s)`);
        this.perfCallCount = 0;
        this.perfTotalMs = 0;
        this.perfLastReport = t0;
      }

      // State, storage and listeners are applied before the first await in
      // applyEntry, so the caller sees them; the host calls it queued resolve
      // on their own time and must not hold a frame source's promise.
      void this.applyEntry(out);
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

  // ==========================================================================
  // After every entry into the VM
  // ==========================================================================

  /**
   * Hand the worker's state changes to the template and to React.
   *
   * `context.state` is updated at once, so a template lookup made in the same
   * tick sees the new value. React is told once a frame rather than once an
   * entry: a frame source and an audio source together make ~130 entries a
   * second, and each one that moved a counter was a re-render of the whole
   * tree — measured as the difference between 46 and 60 painted fps on a
   * main thread throttled 2x. A hidden tab has no frames, so it flushes on a
   * timer instead.
   */
  private applyState(nextState: Record<string, unknown>): void {
    if (!nextState || Object.keys(nextState).length === 0) return;
    Object.assign(this.lastKnownWorkerState, nextState);
    Object.assign(this.context.state, nextState);
    (this.context as unknown as Record<string, unknown>)._vmDirty = true;
    Object.assign(this.pendingReactState, nextState);
    if (this.reactFlushScheduled) return;
    this.reactFlushScheduled = true;
    const flush = () => {
      this.reactFlushScheduled = false;
      const batch = this.pendingReactState;
      this.pendingReactState = {};
      if (this.disposed || Object.keys(batch).length === 0) return;
      if (this.context.batchSetState) {
        this.context.batchSetState(batch);
      } else {
        for (const [k, v] of Object.entries(batch)) this.context.setState(k, v);
      }
    };
    const hidden = typeof document !== 'undefined' && document.hidden;
    if (!hidden && typeof requestAnimationFrame === 'function') requestAnimationFrame(flush);
    else setTimeout(flush, 0);
  }

  /**
   * Everything an entry into the VM produced. The synchronous part — state,
   * storage, new listeners — is applied before the first await; the host
   * calls the script queued are then executed here, on this thread, and each
   * result is handed back to the script as another entry, whose own result is
   * applied in turn. `rounds` is shared down a chain so a callback that queues
   * a call that queues a call cannot run forever.
   */
  private async applyEntry(out: EntryResult, rounds = { n: 0 }): Promise<void> {
    if (this.disposed) return;
    void this.applyDBMutations(out.dbMutations || []);
    this.applyLSMutations(out.lsMutations || []);
    this.applyState(out.state || {});
    if (Array.isArray(out.eventTypes)) this.bridgeEventTypes(out.eventTypes);
    const calls = Array.isArray(out.hostCalls) ? out.hostCalls : [];
    for (const call of calls) {
      if (++rounds.n > MAX_HOST_CALL_ROUNDS) {
        console.error(
          `[SoftN] Host call limit exceeded (${MAX_HOST_CALL_ROUNDS}) — aborting to prevent runaway callback chains`
        );
        return;
      }
      let result: unknown;
      try {
        result = await this.hostExecutor.executeHostCall(call);
      } catch (err) {
        result = { error: String(err) };
        console.warn(`[SoftN] ${call.kind} failed: ${String(err)}`);
      }
      if (this.disposed) return;
      let next: EntryResult;
      try {
        next = await this.call<EntryResult>('resolve_host_call', {
          callId: call.id,
          result,
          lsSnapshot: this.takeLocalStorageSnapshotIfDirty(),
          syncStatus: this.getSyncStatus(),
          savedSyncRoom: this.getSavedSyncRoom(),
        });
      } catch (err) {
        console.error('[SoftN] Error resolving host callback:', err);
        return;
      }
      await this.applyEntry(next, rounds);
    }
  }

  private takeLocalStorageSnapshotIfDirty(): Record<string, string> | undefined {
    if (!this.lsDirty) return undefined;
    this.lsDirty = false;
    return this.getLocalStorageSnapshot();
  }

  /**
   * A DOM listener for every event type the script has registered through
   * the engine's `window.addEventListener`, forwarding what a handler can use
   * into the worker. The engine runs the script's handlers there, exactly as
   * it does on the main thread; only the DOM side lives here. Types are
   * reported after every entry, so a listener added in `_init` or in any
   * later handler is bridged by the time the entry's result is applied.
   */
  private bridgeEventTypes(types: string[]): void {
    if (typeof window === 'undefined') return;
    for (const eventType of types) {
      if (this.bridgedEventTypes.has(eventType)) continue;
      this.bridgedEventTypes.add(eventType);
      const dispatch = (event: Event) => {
        if (this.disposed) return;
        this.call<EntryResult>('dispatch_event', {
          eventType,
          event: extractEventProps(event),
          lsSnapshot: this.takeLocalStorageSnapshotIfDirty(),
          syncStatus: this.getSyncStatus(),
          savedSyncRoom: this.getSavedSyncRoom(),
        })
          .then((out) => this.applyEntry(out))
          .catch((err) => console.warn(`[SoftN Worker] ${eventType} handler failed: ${String(err)}`));
      };
      let listener: (event: Event) => void = dispatch;
      if (THROTTLED_EVENTS.has(eventType)) {
        let lastCall = 0;
        let pendingFrame: number | null = null;
        listener = (event: Event) => {
          const now = performance.now();
          if (now - lastCall >= THROTTLE_MS) {
            lastCall = now;
            dispatch(event);
          } else if (pendingFrame === null) {
            pendingFrame = requestAnimationFrame(() => {
              pendingFrame = null;
              lastCall = performance.now();
              dispatch(event);
            });
          }
        };
      }
      window.addEventListener(eventType, listener);
      this.nativeListeners.push([eventType, listener]);
    }
  }

  cleanup(): void {
    this.disposed = true;
    if (typeof window !== 'undefined') {
      for (const [type, listener] of this.nativeListeners) window.removeEventListener(type, listener);
    }
    this.nativeListeners = [];
    this.bridgedEventTypes.clear();
    this.hostExecutor.cleanup();
    for (const [, p] of this.pending) p.reject(new Error('worker_terminated'));
    this.pending.clear();
    this.worker.terminate();
  }
}

export function createWorkerScriptRuntime(
  context: ScriptContext,
  permissions?: AppPermissions,
  appId?: string,
  importResolver?: ImportResolver,
  logicBasePath?: string,
  options?: WorkerRuntimeOptions
): ScriptRuntimeHandle {
  return new WorkerScriptRuntime(context, permissions, appId, importResolver, logicBasePath, options);
}
