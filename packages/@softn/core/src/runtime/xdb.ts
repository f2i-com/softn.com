/**
 * XDB - Local-First Database Service for SoftN
 *
 * Provides persistent storage with:
 * - Tauri backend with P2P sync (when running in SoftN Loader)
 * - localStorage fallback (browser standalone)
 * - Event-based reactivity for React hooks
 * - CRUD operations with automatic timestamps
 * - Automatic LAN peer discovery and CRDT-based sync
 */

import type { XDBRecord, UseCollectionResult } from '../types';

// ============================================================================
// Tauri Integration
// ============================================================================

/**
 * Check if running in Tauri environment
 */
function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI__' in window;
}

/**
 * Tauri invoke wrapper with type safety
 */
async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) {
    throw new Error('Not running in Tauri environment');
  }
  // @ts-expect-error - Tauri globals
  return window.__TAURI__.core.invoke(cmd, args);
}

/**
 * Listen to Tauri events
 */
function tauriListen(event: string, handler: (payload: unknown) => void): () => void {
  if (!isTauri()) {
    return () => {};
  }
  // @ts-expect-error - Tauri globals
  const unlisten = window.__TAURI__.event.listen(event, (e: { payload: unknown }) =>
    handler(e.payload)
  );
  // Return cleanup function (unlisten returns a promise)
  return () => {
    unlisten.then((fn: () => void) => fn());
  };
}

// ============================================================================
// Types
// ============================================================================

/**
 * Event types emitted by XDB
 */
export type XDBEventType = 'create' | 'update' | 'delete' | 'sync' | 'refresh';

/**
 * Event payload for XDB changes
 */
export interface XDBEvent {
  type: XDBEventType;
  collection: string;
  record?: XDBRecord;
  records?: XDBRecord[];
}

/**
 * Event listener callback
 */
export type XDBEventListener = (event: XDBEvent) => void;

/**
 * Query options for filtering collections
 */
export interface XDBQueryOptions {
  filter?: Record<string, unknown>;
  sort?: { field: string; order: 'asc' | 'desc' };
  limit?: number;
  offset?: number;
}

/**
 * XDB Storage interface (allows swapping localStorage for Tauri backend)
 */
export interface XDBStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface XDBServiceOptions {
  /** Use the supplied/browser storage even when a native Tauri bridge exists. */
  backend?: 'auto' | 'storage';
}

// ── Storage state (audit SN-02) ──────────────────────────────────────────
//
// Liveness and successful hydration are different facts. The service stays
// responsive on every failure, but it says which of these it is in:
//   loading      native hydration in progress
//   ready        every collection hydrated / storage readable
//   degraded     at least one collection is corrupt, failed to hydrate or a
//                write hit a quota error; other collections keep working
//   memory-only  browser storage is inaccessible; nothing survives a reload
//   failed       native hydration failed as a whole (retryable)

export type XDBStorageState = 'loading' | 'ready' | 'degraded' | 'memory-only' | 'failed';
export type XDBStorageIssueKind = 'inaccessible' | 'corrupt' | 'quota' | 'hydration-failed' | 'migration-incomplete';

export interface XDBStorageIssue {
  kind: XDBStorageIssueKind;
  collection?: string;
  message: string;
  /** Storage key holding the original (undamaged-by-us) bytes of a corrupt collection. */
  quarantineKey?: string;
  at: string;
}

export interface XDBStorageStatus {
  state: XDBStorageState;
  /** Whether writes reach durable storage (false for memory-only operation). */
  persistent: boolean;
  /** Whether every collection was read from the backend successfully. */
  hydrated: boolean;
  /** Native operations dispatched but not yet acknowledged by SQLite. */
  pendingWrites: number;
  issues: XDBStorageIssue[];
}

/** Thrown instead of silently replacing damaged or unloaded data. */
export class XDBStorageError extends Error {
  constructor(
    public readonly kind: XDBStorageIssueKind | 'unhydrated',
    message: string,
    public readonly collection?: string
  ) {
    super(message);
    this.name = 'XDBStorageError';
  }
}

/** An import result whose durable completion has already been awaited. */
export type XDBDurableImportResult = Omit<XDBImportResult, 'persisted'> & { persisted: XDBPersistResult };

/** One collection of an immutable import plan (R2-SN-01). */
interface ImportPlan {
  collection: string;
  replace: boolean;
  /** Deduplicated accepted rows (last value per id wins). */
  records: XDBRecord[];
  /** Rows accepted before duplicate ids collapsed. */
  accepted: number;
}

/** Durable-completion signal of an import (audit SN-01). */
export interface XDBPersistResult {
  backend: 'native' | 'storage' | 'memory';
  collections: string[];
  imported: number;
  tombstoned: number;
}

/** Honest native network status (audit XD-01/XD-02); see xdb.org docs/networking-and-restore-policy.md. */
export interface XDBNetworkStatus {
  peer_id: string;
  connected_peers: string[];
  is_running: boolean;
  mode?: 'local-only' | 'trusted-lan';
  enabled?: boolean;
  discovery?: boolean;
  listening?: boolean;
  sync_paused?: boolean;
  stats?: {
    publishes_sent: number;
    publishes_without_peers: number;
    publish_failures: number;
    updates_applied: number;
    updates_rejected_stale: number;
    updates_skipped_paused: number;
    resets_applied: number;
    sync_requests_sent: number;
    sync_responses_applied: number;
    last_announce_at: string | null;
    last_repair_at: string | null;
    last_update_applied_at: string | null;
  };
}

export interface XDBNetworkSettings { enabled: boolean; discovery: boolean; listen: boolean }

const OFFLINE_NETWORK_STATUS: XDBNetworkStatus = { peer_id: '', connected_peers: [], is_running: false, mode: 'local-only', enabled: false, discovery: false, listening: false, sync_paused: false };

// ============================================================================
// XDB Service Class
// ============================================================================

/**
 * XDB Service - Main database service
 *
 * When running in SoftN Loader (Tauri), uses the native XDB backend with:
 * - SQLite persistence
 * - P2P sync via libp2p
 * - CRDT conflict resolution
 * - mDNS peer discovery
 *
 * Falls back to localStorage when running standalone in browser.
 */
export class XDBService {
  private storage: XDBStorage;
  private prefix: string;
  private listeners: Map<string, Set<XDBEventListener>>;
  private globalListeners: Set<XDBEventListener>;
  private useTauri: boolean;
  private tauriUnlisteners: (() => void)[] = [];
  private knownCollections: Set<string> = new Set();
  private memoryStore: Map<string, Map<string, XDBRecord>> = new Map();
  private hydrateStarted = false;
  /** Maps optimistic (local) IDs → server IDs for in-flight creates */
  private optimisticIdMap: Map<string, string> = new Map();
  /** IDs of records with pending create callbacks (not yet confirmed by server) */
  private pendingCreateIds: Set<string> = new Set();
  /** App ID for per-app database isolation in Tauri */
  private appId: string | undefined;

  // Storage state (audit SN-02)
  private storageState: XDBStorageState = 'ready';
  private persistent = true;
  private hydrated = true;
  private issues: XDBStorageIssue[] = [];
  /** Collections whose stored bytes could not be read as records, with the original bytes. */
  private corrupt: Map<string, { quarantineKey: string | null; raw: string }> = new Map();
  /** Corrupt collections the user explicitly allowed to be overwritten. */
  private acknowledged: Set<string> = new Set();
  /** Native collections whose hydration failed (writes that could drop unknown records are blocked). */
  private hydrationFailed: Set<string> = new Set();
  private statusListeners: Set<(status: XDBStorageStatus) => void> = new Set();
  /** Native operations in flight (audit SN-01): the truthful "unsaved work" count. */
  private pendingNative: Set<Promise<unknown>> = new Set();
  private unloadGuard: ((event: BeforeUnloadEvent) => void) | null = null;

  /**
   * Notification batching: when > 0, emit() defers notifications.
   * Collections with pending changes are tracked in _batchDirty.
   * On resumeNotifications(), one 'refresh' event fires per dirty collection.
   * Supports nesting (increment/decrement counter).
   */
  private _batchDepth = 0;
  private _batchDirty = new Set<string>();

  /**
   * Resolves when the in-memory cache is fully hydrated from the backend.
   * In non-Tauri environments, resolves immediately.
   * UI code can `await xdb.isReady` before querying to avoid stale reads.
   */
  public isReady: Promise<void>;
  private _resolveReady!: () => void;

  constructor(storage?: XDBStorage, prefix = 'xdb', appId?: string, options: XDBServiceOptions = {}) {
    // Memory-only is a STATE, not a silent substitution (audit SN-02): the
    // service still works, but it must never advertise persistence it lacks.
    let memoryOnly = false;
    try {
      if (storage) {
        this.storage = storage;
      } else if (typeof localStorage !== 'undefined') {
        this.storage = localStorage;
      } else {
        this.storage = createMemoryStorage();
        memoryOnly = true;
      }
    } catch {
      // Accessing the property itself throws in an opaque-origin sandbox.
      this.storage = storage || createMemoryStorage();
      memoryOnly = !storage;
    }
    this.prefix = prefix;
    this.appId = appId;
    this.listeners = new Map();
    this.globalListeners = new Set();
    this.useTauri = options.backend !== 'storage' && isTauri();

    this.isReady = new Promise(resolve => {
      this._resolveReady = resolve;
    });

    // Setup Tauri event listeners for P2P sync
    if (this.useTauri) {
      this.storageState = 'loading';
      this.hydrated = false;
      this.setupTauriEventListeners();
      this.hydrateFromBackend();
    } else {
      if (memoryOnly) {
        this.persistent = false;
        this.storageState = 'memory-only';
        this.noteIssue({ kind: 'inaccessible', message: 'Browser storage is not available. Records are kept in memory only and are lost when this page closes.' });
      }
      // Non-Tauri environments (localStorage) are ready immediately
      this._resolveReady();
    }
  }

  /** Check if an ID is a pending optimistic ID (create callback hasn't resolved yet) */
  private isOptimisticId(id: string): boolean {
    return this.pendingCreateIds.has(id);
  }

  /** Build Tauri invoke args with appId included */
  private tauriArgs(args?: Record<string, unknown>): Record<string, unknown> {
    return { appId: this.appId, ...args };
  }

  /**
   * Setup listeners for Tauri XDB events (peer connections, sync updates)
   */
  private setupTauriEventListeners(): void {
    // Listen for sync events from network
    const unlistenSync = tauriListen('xdb-sync-event', (payload) => {
      const event = payload as { type: string; collection: string };
      if (event.collection) {
        // Re-hydrate the updated collection so JS cache + Yjs sync stay in sync
        this.getAllAsync(event.collection).catch((err) => {
          console.error('[XDB] Failed to rehydrate after sync event:', err);
        });
      }
    });
    this.tauriUnlisteners.push(unlistenSync);

    // Listen for peer connection events
    const unlistenPeer = tauriListen('xdb-peer-event', (payload) => {
      const event = payload as { type: string; peer_id: string };
      console.log(`[XDB] Peer ${event.type}: ${event.peer_id}`);
    });
    this.tauriUnlisteners.push(unlistenPeer);
  }

  /**
   * Hydrate in-memory cache from Tauri backend (SQLite)
   */
  private hydrateFromBackend(): void {
    if (!this.useTauri || this.hydrateStarted) return;
    this.hydrateStarted = true;
    this.hydrationPromise = this.runHydration();
  }

  private hydrationPromise: Promise<void> = Promise.resolve();

  /**
   * Hydrate the in-memory cache. Liveness (`isReady`) always resolves so the
   * app stays responsive, but a failed or partial hydration is RECORDED as
   * such (audit SN-02): destructive writes to an unhydrated collection are
   * refused until `retryHydration()` succeeds, and the status says why.
   */
  private async runHydration(): Promise<void> {
    this.storageState = 'loading';
    this.hydrated = false;
    this.notifyStatus();
    let collections: string[];
    try {
      collections = await tauriInvoke<string[]>('get_collections', this.tauriArgs());
    } catch (err) {
      console.error('[XDB] Failed to hydrate from Tauri backend:', err);
      this.hydrationFailed.add('*');
      this.storageState = 'failed';
      this.noteIssue({ kind: 'hydration-failed', message: `The native database could not be read: ${err instanceof Error ? err.message : String(err)}. Nothing was loaded; retry before making changes.` });
      // Resolve anyway to prevent the app from hanging permanently
      this._resolveReady();
      return;
    }
    this.hydrationFailed.delete('*');
    for (const collection of collections) {
      try {
        const records = await tauriInvoke<XDBRecord[]>('get_collection', this.tauriArgs({ collection }));
        // Merge instead of overwrite — preserve any optimistic records
        // created between constructor and hydration completion
        let coll = this.memoryStore.get(collection);
        if (!coll) {
          coll = new Map();
          this.memoryStore.set(collection, coll);
        }
        for (const r of records) {
          const existing = coll.get(r.id);
          // Never revive locally deleted records
          if (existing?.deleted) continue;
          // Server record wins if local doesn't exist or is older
          if (!existing || existing.updated_at <= r.updated_at) {
            coll.set(r.id, r);
          }
        }
        this.knownCollections.add(collection);
        this.hydrationFailed.delete(collection);
        this.emit({ type: 'refresh', collection, records: this.getCollectionData(collection) });
      } catch (err) {
        console.error('[XDB] Failed to hydrate collection:', collection, err);
        this.hydrationFailed.add(collection);
        this.noteIssue({ kind: 'hydration-failed', collection, message: `Collection "${collection}" could not be loaded from the native database: ${err instanceof Error ? err.message : String(err)}. Its records are not shown and cannot be cleared until it loads.` });
      }
    }
    this.hydrated = this.hydrationFailed.size === 0;
    this.storageState = this.hydrated ? (this.corrupt.size || this.issues.some(i => i.kind === 'quota') ? 'degraded' : 'ready') : 'degraded';
    if (this.hydrated) this.issues = this.issues.filter(i => i.kind !== 'hydration-failed');
    this.notifyStatus();
    this._resolveReady();
  }

  /** Re-run native hydration after a failure; resolves when the attempt finished. */
  async retryHydration(): Promise<XDBStorageStatus> {
    if (this.useTauri) {
      await this.hydrationPromise.catch(() => {});
      this.hydrationPromise = this.runHydration();
      await this.hydrationPromise;
    }
    return this.getStorageStatus();
  }

  /** Native operations dispatched from this service that SQLite has not acknowledged yet. */
  hasPendingWrites(): boolean {
    return this.pendingNative.size > 0;
  }

  /** Resolves once every in-flight native operation has settled (success or failure). */
  async whenIdle(): Promise<void> {
    while (this.pendingNative.size > 0) {
      await Promise.allSettled([...this.pendingNative]);
    }
  }

  /** Dispatch a native command and track it until SQLite answers (audit SN-01). */
  private native<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    const promise = tauriInvoke<T>(cmd, this.tauriArgs(args));
    this.pendingNative.add(promise);
    this.updateUnloadGuard();
    const settle = () => { this.pendingNative.delete(promise); this.updateUnloadGuard(); };
    promise.then(settle, settle);
    return promise;
  }

  /**
   * Warn before the page unloads while native work is unacknowledged or the
   * store is memory-only (audit SN-01/SN-02). A browser unload prompt is not
   * a persistence strategy; it is the last honest signal before data is lost.
   */
  private updateUnloadGuard(): void {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    const needed = this.pendingNative.size > 0 || this.storageState === 'memory-only';
    if (needed && !this.unloadGuard) {
      this.unloadGuard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
      window.addEventListener('beforeunload', this.unloadGuard);
    } else if (!needed && this.unloadGuard) {
      window.removeEventListener('beforeunload', this.unloadGuard);
      this.unloadGuard = null;
    }
  }

  // --------------------------------------------------------------------------
  // Storage status (audit SN-02)
  // --------------------------------------------------------------------------

  getStorageStatus(): XDBStorageStatus {
    return {
      state: this.storageState,
      persistent: this.persistent,
      hydrated: this.hydrated,
      pendingWrites: this.pendingNative.size,
      issues: [...this.issues],
    };
  }

  subscribeStorage(listener: (status: XDBStorageStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => { this.statusListeners.delete(listener); };
  }

  private notifyStatus(): void {
    this.updateUnloadGuard();
    const status = this.getStorageStatus();
    for (const listener of this.statusListeners) {
      try { listener(status); } catch { /* listener errors never break storage */ }
    }
  }

  private noteIssue(issue: Omit<XDBStorageIssue, 'at'>): void {
    this.issues = this.issues.filter(i => !(i.kind === issue.kind && i.collection === issue.collection));
    this.issues.push({ ...issue, at: new Date().toISOString() });
    if (this.storageState === 'ready') this.storageState = 'degraded';
    this.notifyStatus();
  }

  /** @internal Record an issue detected outside the service (legacy migration). */
  _noteIssue(issue: Omit<XDBStorageIssue, 'at'>): void {
    this.noteIssue(issue);
  }

  /** Whether the collection's stored bytes are readable (false = quarantined). */
  isCollectionReadable(collection: string): boolean {
    return !this.corrupt.has(collection);
  }

  /** Whether a native collection (or all of them) hydrated successfully. */
  isHydrated(collection?: string): boolean {
    if (!this.useTauri) return true;
    if (this.hydrationFailed.has('*')) return false;
    return collection ? !this.hydrationFailed.has(collection) : this.hydrated;
  }

  /** The original bytes of a corrupt collection, for export/recovery; null when readable. */
  exportQuarantined(collection: string): string | null {
    return this.corrupt.get(collection)?.raw ?? null;
  }

  /**
   * Explicitly allow writes to replace a corrupt collection. The quarantined
   * original bytes stay in storage; this only lifts the write block.
   */
  acknowledgeCorruption(collection: string): void {
    if (!this.corrupt.has(collection)) return;
    this.acknowledged.add(collection);
    this.corrupt.delete(collection);
    this.issues = this.issues.filter(i => !(i.kind === 'corrupt' && i.collection === collection));
    if (this.storageState === 'degraded' && this.corrupt.size === 0 && this.issues.length === 0) this.storageState = 'ready';
    this.notifyStatus();
  }

  /** Replace a corrupt collection with records from a backup (validated), lifting the block. */
  restoreCollectionFromBackup(collection: string, records: unknown[]): number {
    const valid = records.filter((r): r is XDBRecord => this.isImportableRecord(r));
    if (valid.length !== records.length) {
      throw new XDBStorageError('corrupt', `${records.length - valid.length} backup row(s) for "${collection}" are not records; nothing was restored.`, collection);
    }
    this.acknowledgeCorruption(collection);
    this.setCollectionData(collection, valid);
    this.emit({ type: 'refresh', collection, records: this.getCollectionData(collection) });
    return valid.length;
  }

  /**
   * Refuse a write that would replace data this service cannot vouch for:
   * a quarantined browser collection, or a native collection that never
   * hydrated (a replace/clear there would drop records it never saw).
   */
  private assertWritable(collection: string, destructive: boolean): void {
    const corrupt = this.corrupt.get(collection);
    if (corrupt && !this.acknowledged.has(collection)) {
      throw new XDBStorageError('corrupt', `Collection "${collection}" is damaged in storage. Recover it (export the original, restore a backup, or acknowledge discarding it) before writing.`, collection);
    }
    if (destructive && this.useTauri && !this.isHydrated(collection)) {
      throw new XDBStorageError('unhydrated', `Collection "${collection}" has not been loaded from the native database; a reset now could drop records that were never shown. Retry loading first.`, collection);
    }
  }

  private recordCorruption(collection: string, raw: string, reason: string): void {
    if (this.corrupt.has(collection)) return;
    let quarantineKey: string | null = `${this.collectionKey(collection)}.corrupt.${Date.now().toString(36)}`;
    try {
      this.storage.setItem(quarantineKey, raw);
    } catch {
      quarantineKey = null;
    }
    this.corrupt.set(collection, { quarantineKey, raw });
    this.acknowledged.delete(collection);
    this.noteIssue({
      kind: 'corrupt',
      collection,
      message: `Collection "${collection}" could not be read (${reason}). The original bytes were ${quarantineKey ? 'kept under a recovery key' : 'kept in memory only'}; writes are blocked until it is recovered.`,
      quarantineKey: quarantineKey ?? undefined,
    });
    console.error(`[XDB] Collection "${collection}" is corrupt: ${reason}`);
  }

  /**
   * Release event listeners when the service's owner is finished with it.
   */
  destroy(): void {
    for (const unlisten of this.tauriUnlisteners) {
      unlisten();
    }
    this.tauriUnlisteners = [];
    this.listeners.clear();
    this.globalListeners.clear();
    this.mutationListeners.clear();
    this.statusListeners.clear();
    this._batchDirty.clear();
    if (this.unloadGuard && typeof window !== 'undefined') {
      window.removeEventListener('beforeunload', this.unloadGuard);
      this.unloadGuard = null;
    }
  }

  // --------------------------------------------------------------------------
  // Storage Key Helpers
  // --------------------------------------------------------------------------

  private collectionKey(collection: string): string {
    return `${this.prefix}:${collection}`;
  }

  // --------------------------------------------------------------------------
  // Internal Storage Operations
  // --------------------------------------------------------------------------

  /** Get or create the inner Map for a collection (Tauri mode only). */
  private getOrCreateCollection(collection: string): Map<string, XDBRecord> {
    let coll = this.memoryStore.get(collection);
    if (!coll) {
      coll = new Map();
      this.memoryStore.set(collection, coll);
    }
    this.knownCollections.add(collection);
    return coll;
  }

  private getCollectionData(collection: string): XDBRecord[] {
    this.knownCollections.add(collection);
    const records = this.getAllCollectionData(collection);
    // Filter out deleted records
    return records.filter((r) => !r.deleted);
  }

  private getAllCollectionData(collection: string): XDBRecord[] {
    if (this.useTauri) {
      const coll = this.memoryStore.get(collection);
      return coll ? [...coll.values()] : [];
    }

    if (this.corrupt.has(collection)) return [];
    const key = this.collectionKey(collection);
    const data = this.storage.getItem(key);
    if (!data) return [];
    // The user chose to discard a damaged collection: read it as empty until
    // the next successful write replaces the bytes (the quarantine copy stays).
    if (this.acknowledged.has(collection)) {
      try {
        const parsed: unknown = JSON.parse(data);
        return Array.isArray(parsed) && parsed.every(r => this.isImportableRecord(r)) ? (parsed as XDBRecord[]) : [];
      } catch {
        return [];
      }
    }

    // Malformed JSON and valid JSON with the wrong shape are both CORRUPTION,
    // not an empty collection (audit SN-02): quarantine the bytes and refuse
    // writes rather than letting the next save replace them.
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch (err) {
      this.recordCorruption(collection, data, `invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
    if (!Array.isArray(parsed)) {
      this.recordCorruption(collection, data, 'stored value is not a list of records');
      return [];
    }
    const invalid = parsed.findIndex(r => !this.isImportableRecord(r));
    if (invalid !== -1) {
      this.recordCorruption(collection, data, `row ${invalid} is not a record`);
      return [];
    }
    return parsed as XDBRecord[];
  }

  private setCollectionData(collection: string, records: XDBRecord[]): void {
    this.assertWritable(collection, false);
    if (this.useTauri) {
      const coll = new Map<string, XDBRecord>();
      for (const r of records) coll.set(r.id, r);
      this.memoryStore.set(collection, coll);
      this.knownCollections.add(collection);
      return;
    }

    const key = this.collectionKey(collection);
    try {
      this.storage.setItem(key, JSON.stringify(records));
      this.acknowledged.delete(collection);
    } catch (err) {
      // localStorage.setItem is atomic: the previous value is intact. Say so
      // instead of pretending the write happened (audit SN-02).
      const message = err instanceof Error ? err.message : String(err);
      this.noteIssue({ kind: 'quota', collection, message: `Could not save "${collection}" (${message}). The previously saved records are unchanged; free storage or export your data.` });
      throw new XDBStorageError('quota', `Could not save "${collection}": ${message}`, collection);
    }
    this.knownCollections.add(collection);
  }

  // --------------------------------------------------------------------------
  // Event System
  // --------------------------------------------------------------------------

  /**
   * Subscribe to changes in a specific collection
   */
  subscribe(collection: string, listener: XDBEventListener): () => void {
    if (!this.listeners.has(collection)) {
      this.listeners.set(collection, new Set());
    }
    this.listeners.get(collection)!.add(listener);

    return () => {
      const set = this.listeners.get(collection);
      if (set) {
        set.delete(listener);
        if (set.size === 0) this.listeners.delete(collection);
      }
    };
  }

  /**
   * Subscribe to all changes across all collections
   */
  subscribeAll(listener: XDBEventListener): () => void {
    this.globalListeners.add(listener);
    return () => {
      this.globalListeners.delete(listener);
    };
  }

  /**
   * Suppress notifications — mutations still happen but listeners are NOT called
   * until resumeNotifications(). Supports nesting. Use this to batch multiple
   * mutations (e.g., an entire WASM function call) into a single notification
   * per affected collection, avoiding O(n) listener re-queries per mutation.
   */
  suppressNotifications(): void {
    this._batchDepth++;
  }

  /**
   * Resume notifications after a suppress block. Fires one 'refresh' event
   * per collection that was mutated during suppression.
   */
  resumeNotifications(): void {
    if (this._batchDepth <= 0) return;
    this._batchDepth--;
    if (this._batchDepth === 0 && this._batchDirty.size > 0) {
      const dirty = [...this._batchDirty];
      this._batchDirty.clear();
      for (const collection of dirty) {
        this.emitNow({ type: 'refresh', collection, records: this.getCollectionData(collection) });
      }
    }
  }

  /**
   * Emit an event to listeners (or defer if batching)
   */
  private emit(event: XDBEvent): void {
    if (this._batchDepth > 0) {
      // Batching: just track which collections changed
      this._batchDirty.add(event.collection);
      return;
    }
    this.emitNow(event);
  }

  /** Actually fire listeners (not deferred) */
  private emitNow(event: XDBEvent): void {
    // Snapshot listeners before iterating to prevent issues if a
    // listener unsubscribes itself (or others) during iteration
    const collectionListeners = this.listeners.get(event.collection);
    if (collectionListeners) {
      for (const listener of [...collectionListeners]) {
        try {
          listener(event);
        } catch (err) {
          console.error('[XDB] Error in listener:', err);
        }
      }
    }

    // Notify global listeners
    for (const listener of [...this.globalListeners]) {
      try {
        listener(event);
      } catch (err) {
        console.error('[XDB] Error in global listener:', err);
      }
    }
  }

  // --------------------------------------------------------------------------
  // CRUD Operations
  // --------------------------------------------------------------------------

  /**
   * Create a new record in a collection
   * When running in Tauri, uses native backend with P2P broadcast
   */
  create(collection: string, data: Record<string, unknown>): XDBRecord {
    if (this.useTauri) {
      this.knownCollections.add(collection);
      // Async create via Tauri - fire and forget, return optimistic result
      const optimisticRecord: XDBRecord = {
        id: generateId(),
        collection,
        data,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        deleted: false,
      };

      // Store optimistic record in cache immediately
      const coll = this.getOrCreateCollection(collection);
      coll.set(optimisticRecord.id, optimisticRecord);
      this.pendingCreateIds.add(optimisticRecord.id);
      this.notifyMutation('create', collection, optimisticRecord.id, data);

      // Create in backend asynchronously
      this.native<XDBRecord>('create_record', {
        payload: { collection, data },
      })
        .then((serverRecord) => {
          this.pendingCreateIds.delete(optimisticRecord.id);
          const c = this.getOrCreateCollection(collection);
          const currentOptimistic = c.get(optimisticRecord.id);
          c.delete(optimisticRecord.id);

          // Store ID mapping so in-flight updates/deletes can resolve the real ID
          this.optimisticIdMap.set(optimisticRecord.id, serverRecord.id);

          // Preserve any local data modifications made since creation (e.g. db.update()
          // calls that ran between create() and this callback resolving)
          let mergedRecord: XDBRecord;
          if (currentOptimistic && currentOptimistic.updated_at !== optimisticRecord.updated_at) {
            // Local data was modified — merge: local data wins over server's original data
            const mergedData = { ...serverRecord.data, ...currentOptimistic.data };
            mergedRecord = { ...serverRecord, data: mergedData };
            // Push merged data to server so it's persisted
            this.native('update_record', {
              payload: { id: serverRecord.id, data: mergedData },
            }).catch(() => {});
          } else {
            mergedRecord = serverRecord;
          }

          c.set(serverRecord.id, mergedRecord);
          this.emit({ type: 'create', collection, record: mergedRecord });
        })
        .catch((err) => {
          this.pendingCreateIds.delete(optimisticRecord.id);
          console.error('[XDB] Failed to create record, rolling back:', err);
          // Rollback: remove optimistic record from cache
          const c = this.memoryStore.get(collection);
          if (c) c.delete(optimisticRecord.id);
          this.emit({ type: 'refresh', collection, records: this.getCollectionData(collection) });
        });

      return optimisticRecord;
    }

    // localStorage fallback
    const records = this.getAllCollectionData(collection);
    const now = new Date().toISOString();

    const record: XDBRecord = {
      id: generateId(),
      collection,
      data,
      created_at: now,
      updated_at: now,
      deleted: false,
    };

    records.push(record);
    this.setCollectionData(collection, records);

    this.emit({ type: 'create', collection, record });
    this.notifyMutation('create', collection, record.id, data);

    return record;
  }

  /**
   * Create a record asynchronously (returns the actual server record)
   */
  async createAsync(collection: string, data: Record<string, unknown>): Promise<XDBRecord> {
    if (this.useTauri) {
      const record = await this.native<XDBRecord>('create_record', {
        payload: { collection, data },
      });
      this.getOrCreateCollection(collection).set(record.id, record);
      this.emit({ type: 'create', collection, record });
      this.notifyMutation('create', collection, record.id, record.data);
      return record;
    }

    // localStorage fallback
    return this.create(collection, data);
  }

  /**
   * Get a single record by ID
   */
  get(collection: string, id: string): XDBRecord | null {
    if (this.useTauri) {
      const coll = this.memoryStore.get(collection);
      if (!coll) return null;
      let record = coll.get(id);
      // Try resolved ID if optimistic ID not found
      if (!record) {
        const resolvedId = this.optimisticIdMap.get(id);
        if (resolvedId) record = coll.get(resolvedId);
      }
      return (record && !record.deleted) ? record : null;
    }
    const records = this.getCollectionData(collection);
    return records.find((r) => r.id === id) || null;
  }

  /**
   * Get a single record by ID asynchronously from backend.
   * When collection is provided, lookup is O(N) within that collection.
   * Without collection, falls back to searching all collections (O(N*M)).
   */
  async getAsync(collection: string, id: string): Promise<XDBRecord | null> {
    if (this.useTauri) {
      try {
        const record = await tauriInvoke<XDBRecord>('get_record', this.tauriArgs({ id }));
        this.getOrCreateCollection(record.collection).set(record.id, record);
        return record;
      } catch {
        return null;
      }
    }

    // localStorage - target the specific collection directly
    return this.get(collection, id);
  }

  /**
   * Get all records in a collection with optional filtering
   */
  query(collection: string, options?: XDBQueryOptions): XDBRecord[] {
    let records = this.getCollectionData(collection);

    // Apply filter (restricted to record.data to prevent access to internal metadata)
    if (options?.filter) {
      records = records.filter((record) => {
        return Object.entries(options.filter!).every(([key, value]) => {
          return key in record.data && record.data[key] === value;
        });
      });
    }

    // Apply sort (restricted to record.data fields)
    if (options?.sort) {
      const { field, order } = options.sort;
      records.sort((a, b) => {
        const aVal = a.data[field];
        const bVal = b.data[field];

        if (aVal === bVal) return 0;
        if (aVal === undefined || aVal === null) return 1;
        if (bVal === undefined || bVal === null) return -1;

        const comparison = aVal < bVal ? -1 : 1;
        return order === 'desc' ? -comparison : comparison;
      });
    }

    // Apply offset
    if (options?.offset !== undefined) {
      records = records.slice(options.offset);
    }

    // Apply limit
    if (options?.limit !== undefined) {
      records = records.slice(0, options.limit);
    }

    return records;
  }

  /**
   * Get all records in a collection
   */
  getAll(collection: string): XDBRecord[] {
    return this.getCollectionData(collection);
  }

  /**
   * Get all records from a collection asynchronously from backend
   */
  async getAllAsync(collection: string): Promise<XDBRecord[]> {
    if (this.useTauri) {
      try {
        const records = await tauriInvoke<XDBRecord[]>('get_collection', this.tauriArgs({ collection }));
        const coll = this.getOrCreateCollection(collection);
        // Build a set of server IDs for cleanup
        const serverIds = new Set(records.map(r => r.id));
        // Merge: server records update cache, but preserve optimistic records
        // (those with IDs not known to the server yet) and don't revive locally deleted records
        for (const r of records) {
          const existing = coll.get(r.id);
          // Never revive a record that was locally deleted (delete was async, backend is stale)
          if (existing?.deleted) continue;
          if (!existing || existing.updated_at <= r.updated_at) {
            coll.set(r.id, r);
          }
        }
        // Remove stale local records whose server-assigned IDs are no longer in backend
        // (but keep optimistic records that haven't been resolved yet)
        for (const localId of coll.keys()) {
          if (!serverIds.has(localId) && !this.isOptimisticId(localId)) {
            coll.delete(localId);
          }
        }
        this.emit({ type: 'refresh', collection, records: this.getCollectionData(collection) });
        return records;
      } catch {
        // Expected after webview reload when stale callbacks exist. Local cache is still valid.
        return this.getCollectionData(collection);
      }
    }

    return this.getCollectionData(collection);
  }

  /**
   * Query records with options, asynchronously from backend
   */
  async queryAsync(collection: string, options?: XDBQueryOptions): Promise<XDBRecord[]> {
    if (this.useTauri) {
      // Get all from backend then filter locally
      // (Future: could add filter/sort support to backend)
      let records = await this.getAllAsync(collection);

      // Apply filter
      if (options?.filter) {
        records = records.filter((record) => {
          return Object.entries(options.filter!).every(([key, value]) => {
            if (key in record.data) {
              return record.data[key] === value;
            }
            return false;
          });
        });
      }

      // Apply sort
      if (options?.sort) {
        const { field, order } = options.sort;
        records.sort((a, b) => {
          const aVal = a.data[field];
          const bVal = b.data[field];
          if (aVal === bVal) return 0;
          if (aVal === undefined || aVal === null) return 1;
          if (bVal === undefined || bVal === null) return -1;
          const comparison = aVal < bVal ? -1 : 1;
          return order === 'desc' ? -comparison : comparison;
        });
      }

      // Apply offset and limit
      if (options?.offset !== undefined) {
        records = records.slice(options.offset);
      }
      if (options?.limit !== undefined) {
        records = records.slice(0, options.limit);
      }

      return records;
    }

    return this.query(collection, options);
  }

  /**
   * Update a record by ID
   * When running in Tauri, broadcasts update to P2P network
   */
  update(id: string, data: Partial<Record<string, unknown>>): XDBRecord | null {
    if (this.useTauri) {
      // Resolve optimistic ID → server ID if the create callback has already fired
      const resolvedId = this.optimisticIdMap.get(id) || id;

      // Async update via Tauri - fire and forget
      this.native<XDBRecord>('update_record', {
        payload: { id: resolvedId, data },
      })
        .then((serverRecord) => {
          // Only apply server response if no newer local changes exist
          const c = this.getOrCreateCollection(serverRecord.collection);
          const current = c.get(serverRecord.id);
          if (!current || current.updated_at <= serverRecord.updated_at) {
            c.set(serverRecord.id, serverRecord);
            this.emit({ type: 'update', collection: serverRecord.collection, record: serverRecord });
          }
        })
        .catch(() => {
          // Expected when: optimistic ID not yet resolved, record deleted, or stale callback.
          // Local in-memory state is authoritative; backend will catch up via create callback re-sync.
        });

      // Return optimistic result — try both the original and resolved IDs
      for (const [collection, coll] of this.memoryStore) {
        let record = coll.get(id);
        if (!record && id !== resolvedId) record = coll.get(resolvedId);
        if (record && !record.deleted) {
          const updatedRecord: XDBRecord = {
            ...record,
            data: { ...record.data, ...data },
            updated_at: new Date().toISOString(),
          };
          coll.set(record.id, updatedRecord);
          this.emit({ type: 'update', collection, record: updatedRecord });
          this.notifyMutation('update', collection, record.id, updatedRecord.data);
          return updatedRecord;
        }
      }
      return null;
    }

    // localStorage fallback
    const allKeys = this.getAllCollectionKeys();

    for (const collection of allKeys) {
      const records = this.getAllCollectionData(collection);
      const index = records.findIndex((r) => r.id === id);

      if (index !== -1) {
        const record = records[index];
        const updatedRecord: XDBRecord = {
          ...record,
          data: { ...record.data, ...data },
          updated_at: new Date().toISOString(),
        };

        records[index] = updatedRecord;
        this.setCollectionData(collection, records);

        this.emit({ type: 'update', collection, record: updatedRecord });
        this.notifyMutation('update', collection, id, updatedRecord.data);

        return updatedRecord;
      }
    }

    return null;
  }

  /**
   * Update a record asynchronously
   */
  async updateAsync(id: string, data: Partial<Record<string, unknown>>): Promise<XDBRecord | null> {
    if (this.useTauri) {
      try {
        const record = await this.native<XDBRecord>('update_record', {
          payload: { id, data },
        });
        this.getOrCreateCollection(record.collection).set(record.id, record);
        this.emit({ type: 'update', collection: record.collection, record });
        this.notifyMutation('update', record.collection, record.id, record.data);
        return record;
      } catch (err) {
        console.error('[XDB] Failed to update record:', err);
        return null;
      }
    }

    return this.update(id, data);
  }

  /**
   * Update a record in a specific collection by ID
   */
  updateInCollection(
    collection: string,
    id: string,
    data: Partial<Record<string, unknown>>
  ): XDBRecord | null {
    if (this.useTauri) {
      const coll = this.memoryStore.get(collection);
      if (!coll) return null;
      let record = coll.get(id);
      // Try resolved ID if optimistic ID was swapped
      if (!record) {
        const resolvedId = this.optimisticIdMap.get(id);
        if (resolvedId) record = coll.get(resolvedId);
      }
      if (!record || record.deleted) return null;
      const updatedRecord: XDBRecord = {
        ...record,
        data: { ...record.data, ...data },
        updated_at: new Date().toISOString(),
      };
      coll.set(record.id, updatedRecord);
      this.emit({ type: 'update', collection, record: updatedRecord });
      this.notifyMutation('update', collection, record.id, updatedRecord.data);

      // A scoped edit is still a local mutation: persist it just like update(),
      // while keeping the optimistic cache change in the requested collection.
      this.native<XDBRecord>('update_record', {
        payload: { id: record.id, data },
      }).then((serverRecord) => {
        if (serverRecord.collection !== collection || serverRecord.id !== record.id) return;
        // A newer edit/deletion wins even if the older request finishes last.
        if (coll.get(record.id) === updatedRecord) {
          coll.set(record.id, serverRecord);
          this.emit({ type: 'update', collection, record: serverRecord });
        }
      }).catch((err) => {
        console.error('[XDB] Failed to persist collection update in Tauri:', err);
      });
      return updatedRecord;
    }

    const records = this.getAllCollectionData(collection);
    const index = records.findIndex((r) => r.id === id && !r.deleted);

    if (index === -1) return null;

    const record = records[index];
    const updatedRecord: XDBRecord = {
      ...record,
      data: { ...record.data, ...data },
      updated_at: new Date().toISOString(),
    };

    records[index] = updatedRecord;
    this.setCollectionData(collection, records);

    this.emit({ type: 'update', collection, record: updatedRecord });
    this.notifyMutation('update', collection, id, updatedRecord.data);

    return updatedRecord;
  }

  /**
   * Delete a record by ID (soft delete)
   * When running in Tauri, broadcasts delete to P2P network
   */
  delete(id: string): boolean {
    if (this.useTauri) {
      // Resolve optimistic ID → server ID
      const resolvedId = this.optimisticIdMap.get(id) || id;

      // Async delete via Tauri - fire and forget
      this.native<boolean>('delete_record', { id: resolvedId })
        .then(() => {
          for (const [collection, coll] of this.memoryStore) {
            const record = coll.get(resolvedId);
            if (record) {
              this.emit({ type: 'delete', collection, record });
              break;
            }
          }
          // Clean up ID mapping
          if (id !== resolvedId) this.optimisticIdMap.delete(id);
        })
        .catch(() => {
          // Expected when record was already deleted or ID is stale. Local state is authoritative.
        });

      // Optimistically update in-memory cache — try both original and resolved IDs
      for (const [collection, coll] of this.memoryStore) {
        const lookupId = coll.has(id) ? id : (id !== resolvedId && coll.has(resolvedId) ? resolvedId : null);
        if (!lookupId) continue;
        const record = coll.get(lookupId);
        if (record && !record.deleted) {
          const deletedRecord = {
            ...record,
            deleted: true,
            updated_at: new Date().toISOString(),
          };
          coll.set(lookupId, deletedRecord);
          this.emit({ type: 'delete', collection, record: deletedRecord });
          this.notifyMutation('delete', collection, lookupId);
          break;
        }
      }

      return true; // Optimistic
    }

    // localStorage fallback
    const allKeys = this.getAllCollectionKeys();

    for (const collection of allKeys) {
      const records = this.getAllCollectionData(collection);
      const index = records.findIndex((r) => r.id === id);

      if (index !== -1) {
        const record = records[index];
        record.deleted = true;
        record.updated_at = new Date().toISOString();

        this.setCollectionData(collection, records);

        this.emit({ type: 'delete', collection, record });
        this.notifyMutation('delete', collection, id);

        return true;
      }
    }

    return false;
  }

  /**
   * Delete a record asynchronously
   */
  async deleteAsync(id: string): Promise<boolean> {
    if (this.useTauri) {
      try {
        await this.native<boolean>('delete_record', { id });
        for (const [collection, coll] of this.memoryStore) {
          const record = coll.get(id);
          if (record) {
            const deleted = { ...record, deleted: true, updated_at: new Date().toISOString() };
            coll.set(id, deleted);
            this.emit({ type: 'delete', collection, record: deleted });
            this.notifyMutation('delete', collection, id);
            break;
          }
        }
        return true;
      } catch (err) {
        console.error('[XDB] Failed to delete record:', err);
        return false;
      }
    }

    return this.delete(id);
  }

  /**
   * Delete a record from a specific collection
   */
  deleteFromCollection(collection: string, id: string): boolean {
    if (this.useTauri) {
      const coll = this.memoryStore.get(collection);
      const resolvedId = this.optimisticIdMap.get(id) || id;
      const record = coll?.get(id) ?? coll?.get(resolvedId);
      if (!record || record.deleted) return false;
      const deleted = { ...record, deleted: true, updated_at: new Date().toISOString() };
      coll!.set(record.id, deleted);
      this.emit({ type: 'delete', collection, record: deleted });
      this.notifyMutation('delete', collection, record.id);
      this.native<boolean>('delete_record', { id: record.id }).catch((err) => {
        console.error('[XDB] Failed to persist collection deletion in Tauri:', err);
      });
      return true;
    }

    const records = this.getAllCollectionData(collection);
    const index = records.findIndex((r) => r.id === id && !r.deleted);

    if (index === -1) return false;

    const record = records[index];
    record.deleted = true;
    record.updated_at = new Date().toISOString();

    this.setCollectionData(collection, records);

    this.emit({ type: 'delete', collection, record });
    this.notifyMutation('delete', collection, id);

    return true;
  }

  /**
   * Hard delete - permanently remove a record
   */
  hardDelete(collection: string, id: string): boolean {
    this.assertWritable(collection, true);
    if (this.useTauri) {
      const coll = this.memoryStore.get(collection);
      const record = coll?.get(id);
      if (!record) return false;
      coll!.delete(id);

      if (this.useTauri) {
        this.native<boolean>('delete_record', { id }).catch((err) => {
          console.error('[XDB] Failed to hard delete record in Tauri:', err);
        });
      }

      this.emit({ type: 'delete', collection, record });
      return true;
    }

    const records = this.getAllCollectionData(collection);
    const index = records.findIndex((r) => r.id === id);

    if (index === -1) return false;

    const record = records[index];
    records.splice(index, 1);
    this.setCollectionData(collection, records);

    // Persist to Tauri backend (soft delete — hard delete not supported at backend level)
    if (this.useTauri) {
      this.native<boolean>('delete_record', { id }).catch((err) => {
        console.error('[XDB] Failed to hard delete record in Tauri:', err);
      });
    }

    this.emit({ type: 'delete', collection, record });

    return true;
  }

  // --------------------------------------------------------------------------
  // Sync Adapter API
  // --------------------------------------------------------------------------

  getCollections(): string[] {
    return Array.from(this.knownCollections);
  }

  getAllRaw(collection: string): XDBRecord[] {
    return this.getAllCollectionData(collection);
  }

  writeRecord(collection: string, record: XDBRecord): void {
    this.knownCollections.add(collection);
    if (this.useTauri) {
      const coll = this.getOrCreateCollection(collection);
      const isUpdate = coll.has(record.id);
      coll.set(record.id, record);
      this.native<XDBRecord>('upsert_record', { record }).catch((err) => {
        console.error('[XDB] Failed to upsert record in Tauri:', err);
      });
      this.emit({ type: isUpdate ? 'update' : 'create', collection, record });
      return;
    }
    const records = this.getAllCollectionData(collection);
    const index = records.findIndex(r => r.id === record.id);
    const isUpdate = index !== -1;
    if (isUpdate) {
      records[index] = record;
    } else {
      records.push(record);
    }
    this.setCollectionData(collection, records);
    this.emit({ type: isUpdate ? 'update' : 'create', collection, record });
  }

  removeRecord(collection: string, id: string): void {
    this.assertWritable(collection, true);
    if (this.useTauri) {
      const coll = this.memoryStore.get(collection);
      const removed = coll?.get(id);
      if (removed) {
        coll!.delete(id);
        this.emit({ type: 'delete', collection, record: removed });
      }
      this.native<boolean>('delete_record', { id }).catch((err) => {
        console.error('[XDB] Failed to delete record in Tauri:', err);
      });
      return;
    }
    const records = this.getAllCollectionData(collection);
    const index = records.findIndex(r => r.id === id);
    if (index !== -1) {
      const removed = records[index];
      records.splice(index, 1);
      this.setCollectionData(collection, records);
      this.emit({ type: 'delete', collection, record: removed });
    }
  }

  emitEvent(event: XDBEvent): void {
    this.emit(event);
  }

  // --------------------------------------------------------------------------
  // Server Sync API (used by XDBServerSync)
  // --------------------------------------------------------------------------

  /** Mutation listeners for server sync — called on local creates/updates/deletes. */
  private mutationListeners: Set<(event: {
    type: string;
    collection: string;
    recordId: string;
    data?: Record<string, unknown>;
    source?: string;
  }) => void> = new Set();

  /** Whether the current mutation originates from the server (to avoid re-push). */
  private _mutationSource: string | undefined;

  /**
   * Subscribe to all local mutations (create/update/delete).
   * Used by XDBServerSync to push local changes to the server.
   * Returns an unsubscribe function.
   */
  onMutation(listener: (event: {
    type: string;
    collection: string;
    recordId: string;
    data?: Record<string, unknown>;
    source?: string;
  }) => void): () => void {
    this.mutationListeners.add(listener);
    return () => { this.mutationListeners.delete(listener); };
  }

  /** Notify mutation listeners (called internally after create/update/delete). */
  private notifyMutation(type: string, collection: string, recordId: string, data?: Record<string, unknown>): void {
    if (this.mutationListeners.size === 0) return;
    const event = { type, collection, recordId, data, source: this._mutationSource };
    for (const listener of this.mutationListeners) {
      try { listener(event); } catch { /* ignore */ }
    }
  }

  /**
   * Upsert a record from the server (doesn't trigger push back to server).
   */
  upsertFromServer(collection: string, record: {
    id: string;
    collection: string;
    data: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
  }): void {
    // An update delta carries no creation time and says nothing about deletion,
    // so both come from the row already here. Without this, `created_at` was
    // restamped to now — a record edited on another device jumped position in
    // any list sorted by it — and `deleted: false` resurrected a record this
    // device had already deleted.
    // Deliberately not `get()`, which hides soft-deleted rows — the deleted
    // ones are exactly the case this has to see.
    const existing = this.getAllCollectionData(collection).find((r) => r.id === record.id);
    const xdbRecord: XDBRecord = {
      id: record.id,
      collection: record.collection,
      data: record.data,
      created_at: record.createdAt || existing?.created_at || new Date().toISOString(),
      updated_at: record.updatedAt || new Date().toISOString(),
      deleted: existing?.deleted ?? false,
    };
    this._mutationSource = 'server';
    this.writeRecord(collection, xdbRecord);
    this.notifyMutation('upsert', collection, record.id, record.data);
    this._mutationSource = undefined;
  }

  /**
   * Delete a record from the server (doesn't trigger push back to server).
   */
  deleteFromServer(collection: string, recordId: string): void {
    this._mutationSource = 'server';
    this.removeRecord(collection, recordId);
    this.notifyMutation('delete', collection, recordId);
    this._mutationSource = undefined;
  }

  // --------------------------------------------------------------------------
  // Utility Methods
  // --------------------------------------------------------------------------

  /**
   * Get all collection names
   * Works with any storage implementation that supports the XDBStorage interface
   */
  private getAllCollectionKeys(): string[] {
    const keys: string[] = [];
    const prefixWithColon = `${this.prefix}:`;

    // Try to enumerate keys from the storage
    // For localStorage (and compatible implementations)
    if (!this.useTauri && 'length' in this.storage && typeof (this.storage as Storage).key === 'function') {
      const storage = this.storage as Storage;
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (!key?.startsWith(prefixWithColon)) continue;
        const collection = key.slice(prefixWithColon.length);
        // A collection name never contains a colon, so anything that does is a
        // deeper namespace — some app's `xdb:<appId>:<collection>`. Without
        // this the unnamespaced default instance would enumerate, and through
        // `update`/`delete` by id also mutate, every app's records.
        if (collection.includes(':')) continue;
        keys.push(collection);
      }
      return keys;
    }

    // Fallback to tracked collections (for memory storage and other implementations)
    return Array.from(this.knownCollections);
  }

  /**
   * Clear all data in a collection
   */
  clear(collection: string): void {
    this.assertWritable(collection, true);
    if (this.useTauri) {
      this.memoryStore.delete(collection);
      this.knownCollections.delete(collection);
      this.emit({ type: 'refresh', collection, records: [] });
      // Persist to SQLite backend
      this.native<boolean>('clear_collection', { collection }).catch((err) => {
        console.error('[XDB] Failed to clear collection in Tauri:', err);
      });
      return;
    }
    this.storage.removeItem(this.collectionKey(collection));
    this.emit({ type: 'refresh', collection, records: [] });
  }

  /**
   * Clear all XDB data
   */
  clearAll(): void {
    const collections = this.getAllCollectionKeys();
    for (const collection of collections) {
      this.clear(collection);
    }
  }

  /**
   * Get count of records in a collection
   */
  count(collection: string): number {
    return this.getCollectionData(collection).length;
  }

  /**
   * Sync with P2P network
   * When running in Tauri, requests sync from connected peers
   */
  async sync(collection?: string): Promise<void> {
    if (this.useTauri) {
      try {
        if (collection) {
          // Sync specific collection
          await this.native<boolean>('request_sync', { collection });
          console.log(`[XDB] Requested P2P sync for collection: ${collection}`);
        } else {
          // Sync all collections in batches to avoid flooding IPC/network
          const collections = await tauriInvoke<string[]>('get_collections', this.tauriArgs());
          const BATCH_SIZE = 5;
          for (let i = 0; i < collections.length; i += BATCH_SIZE) {
            const batch = collections.slice(i, i + BATCH_SIZE);
            await Promise.all(batch.map((col) => this.native<boolean>('request_sync', { collection: col })));
          }
          console.log(`[XDB] Requested P2P sync for all ${collections.length} collections`);
        }
      } catch (err) {
        console.error('[XDB] Failed to request sync:', err);
      }
      return;
    }

    // localStorage fallback - just emit events
    console.log('[XDB] Sync requested (localStorage mode - no P2P)');
    const collections = this.getAllCollectionKeys();
    for (const col of collections) {
      this.emit({ type: 'sync', collection: col, records: this.getCollectionData(col) });
    }
  }

  /**
   * Get network status (connected peers, peer ID, etc.)
   */
  async getNetworkStatus(): Promise<XDBNetworkStatus> {
    if (this.useTauri) {
      try {
        return await this.native('get_network_status');
      } catch (err) {
        console.error('[XDB] Failed to get network status:', err);
        return { ...OFFLINE_NETWORK_STATUS };
      }
    }

    // Not available in localStorage mode
    return { ...OFFLINE_NETWORK_STATUS };
  }

  /** The persisted native networking choice; local-only when not native (audit XD-01). */
  async getNetworkSettings(): Promise<XDBNetworkSettings> {
    if (!this.useTauri) return { enabled: false, discovery: false, listen: false };
    return tauriInvoke<XDBNetworkSettings>('get_network_settings');
  }

  /**
   * Explicitly enable or disable native peer networking (persisted). Enabling
   * is a trusted-LAN development feature; it never happens implicitly.
   */
  async setNetworkEnabled(enabled: boolean, options: { discovery?: boolean; listen?: boolean } = {}): Promise<XDBNetworkSettings> {
    if (!this.useTauri) throw new Error('Native peer networking is only available in the desktop runtime.');
    return tauriInvoke<XDBNetworkSettings>('set_network_enabled', { enabled, ...options });
  }

  /** Lift the pause a local-scope restore set, then reconcile (audit XD-03). */
  async resumeSync(): Promise<boolean> {
    if (!this.useTauri) return false;
    return tauriInvoke<boolean>('resume_sync');
  }

  /**
   * Get the database file path for this app (Tauri only).
   * Returns the full path to the SQLite file, e.g.
   * "C:/Users/.../AppData/Roaming/softn-loader/apps/TheOffice/data.sqlite"
   */
  async getDbPath(): Promise<string | null> {
    if (!this.useTauri) return null;
    try {
      return await tauriInvoke<string>('get_db_path', this.tauriArgs());
    } catch {
      return null;
    }
  }

  /**
   * Get the app ID associated with this XDB instance
   */
  getAppId(): string | undefined {
    return this.appId;
  }

  /**
   * Check if P2P sync is available
   */
  isP2PAvailable(): boolean {
    return this.useTauri;
  }

  /**
   * Trigger a refresh for a collection (causes React hooks to re-render)
   */
  refresh(collection: string): void {
    this.emit({ type: 'refresh', collection, records: this.getCollectionData(collection) });
  }

  // --------------------------------------------------------------------------
  // Data Transfer (Export/Import)
  // --------------------------------------------------------------------------

  /**
   * Export all data from specified collections (or all collections)
   * Returns a JSON-serializable object
   */
  export(collections?: string[]): XDBExportData {
    const collectionNames = collections || this.getAllCollectionKeys();
    const data: Record<string, XDBRecord[]> = {};

    for (const collection of collectionNames) {
      data[collection] = this.getAllCollectionData(collection);
    }

    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      collections: data,
    };
  }

  /**
   * Export data as a downloadable JSON string
   */
  exportToJSON(collections?: string[]): string {
    return JSON.stringify(this.export(collections), null, 2);
  }

  /**
   * An export file is user-supplied JSON, so a row can be anything. Without a
   * string id a row could never be addressed, deduplicated or updated again,
   * and a non-object would crash the first property read.
   */
  private isImportableRecord(value: unknown): value is XDBRecord {
    if (typeof value !== 'object' || value === null) return false;
    const id = (value as { id?: unknown }).id;
    return typeof id === 'string' && id.length > 0;
  }

  /**
   * Import data from an export object.
   *
   * Merging (the default) builds one id-keyed index per collection, seeded
   * from the stored records in their stored order, then applies the incoming
   * rows in the order they arrive. The policy is last value wins: an id the
   * collection already holds is replaced in place and keeps its position, an
   * id that appears twice in one import keeps only the later row, and unseen
   * ids append. That is exactly what the Tauri branch's `coll.set` has always
   * done; the browser branch used to snapshot the existing ids once and append
   * every row missing from that snapshot, so two new rows sharing an id both
   * landed and the collection could never be deduplicated again.
   *
   * Replacing (`merge: false`) drops what the collection held — in memory and,
   * on Tauri, in SQLite — but writes the incoming rows through the same index,
   * so a batch cannot store one id twice either.
   *
   * A row that is not an object with a non-empty string id, or a collection
   * whose value is not an array, is skipped and counted in `skipped` rather
   * than thrown. Collections persist one by one, so throwing midway would
   * leave the store half-updated, which is worse than dropping a bad row.
   *
   * @param data - The exported data object
   * @param options - Import options
   */
  /**
   * Everything an import WILL do, computed without touching any state
   * (R2-SN-01): the envelope, collection names, writability (corrupt or
   * unhydrated collections) and every row are checked first, so a refusal
   * leaves cache and storage exactly as they were and no native batch is
   * sent. `skipped` counts rows and collections that would be dropped.
   */
  private planImport(
    data: XDBExportData,
    options: { merge?: boolean; clearFirst?: boolean }
  ): { plans: ImportPlan[]; skipped: number; replace: boolean } {
    const { merge = true, clearFirst = false } = options;
    // Replacement intent is normalised ONCE: `merge: false` or `clearFirst`
    // both mean "the collection afterwards holds exactly the accepted rows",
    // on every backend (R2-SN-02).
    const replace = !merge || clearFirst;
    if (!data || typeof data !== 'object' || !data.collections || typeof data.collections !== 'object' || Array.isArray(data.collections)) {
      throw new XDBStorageError('corrupt', 'The import has no collections object.');
    }
    const plans: ImportPlan[] = [];
    let skipped = 0;
    for (const [collection, incoming] of Object.entries(data.collections)) {
      if (!Array.isArray(incoming)) {
        skipped++;
        continue;
      }
      if (!collection || collection.includes(':')) {
        throw new XDBStorageError('corrupt', `"${collection}" is not a valid collection name.`, collection);
      }
      // A replacement of a collection this service has not loaded would drop
      // records it never saw; any write to a corrupt one would destroy the
      // only copy (audit SN-02). Checked for EVERY collection before ANY write.
      this.assertWritable(collection, replace);
      const index = new Map<string, XDBRecord>();
      let accepted = 0;
      for (const record of incoming as unknown[]) {
        if (!this.isImportableRecord(record)) {
          skipped++;
          continue;
        }
        index.set(record.id, record);
        accepted++;
      }
      plans.push({ collection, replace, records: [...index.values()], accepted });
    }
    return { plans, skipped, replace };
  }

  /** The records a collection holds after applying one plan to `existing`. */
  private static mergePlan(existing: XDBRecord[], plan: ImportPlan): XDBRecord[] {
    if (plan.replace) return plan.records;
    const index = new Map<string, XDBRecord>();
    for (const record of existing) index.set(record.id, record);
    for (const record of plan.records) index.set(record.id, record);
    return [...index.values()];
  }

  /**
   * Apply an immutable plan. Browser storage: one atomic key replacement per
   * collection, WITHOUT removing the old key first, so a failed write leaves
   * the previous value in place; because several keys are not a transaction,
   * a failure on a later collection restores the earlier ones to their prior
   * contents and the error says exactly what state remains (R2-SN-02).
   * Native: the cache is updated optimistically and ONE transaction carries
   * every batch; on failure the cache is reloaded from disk (audit SN-01).
   */
  private executeImport(plans: ImportPlan[]): { imported: number; collections: string[]; persisted: Promise<XDBPersistResult> } {
    const importedCollections: string[] = [];
    const imported = plans.reduce((n, plan) => n + plan.accepted, 0);

    if (!this.useTauri) {
      const written: Array<{ collection: string; previous: string | null }> = [];
      for (const plan of plans) {
        const key = this.collectionKey(plan.collection);
        const previous = this.storage.getItem(key);
        const records = XDBService.mergePlan(this.getAllCollectionData(plan.collection), plan);
        try {
          this.setCollectionData(plan.collection, records);
        } catch (error) {
          // Put back what earlier collections held before this import.
          const restored: string[] = [];
          for (const entry of written.reverse()) {
            try {
              if (entry.previous === null) this.storage.removeItem(this.collectionKey(entry.collection));
              else this.storage.setItem(this.collectionKey(entry.collection), entry.previous);
              restored.push(entry.collection);
              this.emit({ type: 'refresh', collection: entry.collection, records: this.getCollectionData(entry.collection) });
            } catch {
              // The rollback itself failed for this collection; reported below.
            }
          }
          const message = error instanceof Error ? error.message : String(error);
          const kept = restored.length ? ` Collections restored to their previous contents: ${restored.join(', ')}.` : '';
          const stuck = written.filter(e => !restored.includes(e.collection)).map(e => e.collection);
          const notRestored = stuck.length ? ` Could NOT restore: ${stuck.join(', ')} (they hold the imported rows).` : '';
          throw new XDBStorageError(
            error instanceof XDBStorageError ? error.kind : 'quota',
            `Import stopped at "${plan.collection}" (${message}); its previous contents are unchanged.${kept}${notRestored}`,
            plan.collection
          );
        }
        written.push({ collection: plan.collection, previous });
        importedCollections.push(plan.collection);
        this.emit({ type: 'refresh', collection: plan.collection, records: this.getCollectionData(plan.collection) });
      }
      return {
        imported,
        collections: importedCollections,
        persisted: Promise.resolve({ backend: this.persistent ? 'storage' : 'memory', collections: importedCollections, imported, tombstoned: 0 }),
      };
    }

    for (const plan of plans) {
      this.setCollectionData(plan.collection, XDBService.mergePlan(this.getAllCollectionData(plan.collection), plan));
      importedCollections.push(plan.collection);
      this.emit({ type: 'refresh', collection: plan.collection, records: this.getCollectionData(plan.collection) });
    }
    const batches = plans.map(plan => ({ collection: plan.collection, replace: plan.replace, records: plan.records }));
    const persisted: Promise<XDBPersistResult> = batches.length === 0
      ? Promise.resolve({ backend: 'native', collections: [], imported: 0, tombstoned: 0 })
      : this.native<{ imported: number; tombstoned: number; collections: Array<{ collection: string }> }>('import_records', { batches })
        .then(summary => ({
          backend: 'native' as const,
          collections: summary.collections.map(c => c.collection),
          imported: summary.imported,
          tombstoned: summary.tombstoned,
        }))
        .catch(async (err: unknown) => {
          console.error('[XDB] Native import was not committed; reloading the affected collections:', err);
          for (const collection of importedCollections) {
            try { await this.getAllAsync(collection); } catch { /* the hydration issue is already recorded */ }
            this.emit({ type: 'refresh', collection, records: this.getCollectionData(collection) });
          }
          throw err instanceof Error ? err : new Error(String(err));
        });
    return { imported, collections: importedCollections, persisted };
  }

  import(
    data: XDBExportData,
    options: { merge?: boolean; clearFirst?: boolean } = {}
  ): XDBImportResult {
    const { plans, skipped } = this.planImport(data, options);
    const { imported, collections, persisted } = this.executeImport(plans);
    return { imported, skipped, collections, persisted };
  }

  /**
   * Import and wait for the durable completion signal. Rejects when the
   * native transaction did not commit (the cache is reloaded first) or when a
   * collection could not be written.
   */
  async importAsync(
    data: XDBExportData,
    options: { merge?: boolean; clearFirst?: boolean } = {}
  ): Promise<XDBDurableImportResult> {
    const result = this.import(data, options);
    const persisted = await result.persisted;
    return { ...result, persisted };
  }

  /**
   * Import data from a JSON string
   */
  importFromJSON(
    jsonString: string,
    options: { merge?: boolean; clearFirst?: boolean } = {}
  ): XDBImportResult {
    const data = JSON.parse(jsonString) as XDBExportData;
    return this.import(data, options);
  }

  /**
   * Create a backup of all data
   */
  backup(): XDBExportData {
    return this.export();
  }

  /**
   * Restore from a backup (replacing every listed collection). The result of
   * the durable write is available through `restoreAsync`; this form keeps
   * the historical void signature for existing callers.
   */
  restore(backup: XDBExportData): void {
    this.import(backup, { merge: false, clearFirst: true });
  }

  /**
   * Restore and wait for the durable completion signal. Skipped rows are
   * reported prominently: a restore is not best-effort, so a caller must
   * accept a partial result explicitly.
   */
  async restoreAsync(backup: XDBExportData, options: { acceptPartial?: boolean } = {}): Promise<XDBDurableImportResult> {
    // Decide BEFORE mutating anything (R2-SN-01): a refused restore leaves
    // zero visible or persistent change and sends no native batch.
    const { plans, skipped } = this.planImport(backup, { merge: false, clearFirst: true });
    if (skipped > 0 && !options.acceptPartial) {
      throw new Error(`${skipped} row(s) or collection(s) in the backup were not importable; nothing was changed. Pass acceptPartial to restore the rest anyway.`);
    }
    const { imported, collections, persisted: pending } = this.executeImport(plans);
    const persisted = await pending;
    return { imported, skipped, collections, persisted };
  }
}

/**
 * Export data format
 */
export interface XDBExportData {
  version: number;
  exportedAt: string;
  collections: Record<string, XDBRecord[]>;
}

/**
 * What an import did. `imported` counts the rows accepted, before duplicate
 * ids collapse into one; `skipped` counts rows (and whole collections) that
 * were not importable and were dropped rather than allowed to abort the import.
 */
export interface XDBImportResult {
  imported: number;
  skipped: number;
  collections: string[];
  /**
   * Durable completion (audit SN-01): resolves once the import reached its
   * backend (one native SQLite transaction, or browser storage), rejects when
   * it did not. Callers that only need the optimistic result may ignore it.
   */
  persisted: Promise<XDBPersistResult>;
}

// ============================================================================
// React Hooks
// ============================================================================

import { useState, useEffect, useCallback, useMemo, useContext } from 'react';
import { AppScopeContext } from './app-scope-context';

// ── Sync signaling configuration ──────────────────────────

/** Default signaling server URLs for XDB sync.
 *  Stored here (in xdb.ts) so it's accessible without importing the heavy
 *  xdb-sync.ts module. The sync module reads this when it connects. */
let _defaultSignalingUrls: string[] | undefined;

/** Set default signaling server URLs for all XDB sync adapters.
 *  Call this at app startup to prevent connections to public signaling servers. */
export function setDefaultSignaling(urls: string[]): void {
  _defaultSignalingUrls = urls;
}

/** Get the configured default signaling URLs (used by xdb-sync.ts). */
export function getDefaultSignaling(): string[] | undefined {
  return _defaultSignalingUrls;
}

/** Cached reference to xdb-sync module (set after first dynamic import). */
let _syncModuleRef: { getAllSyncStatus: () => { connected: boolean; peers: number; room: string; peerId: string }[] } | null = null;

/** Register the sync module reference (called from xdb-sync.ts or script-runtime.ts). */
export function _setSyncModuleRef(mod: typeof _syncModuleRef): void {
  _syncModuleRef = mod;
}

/** Get sync status of all active rooms. Returns empty array if sync module not loaded. */
export function getSyncStatuses(): { connected: boolean; peers: number; room: string; peerId: string }[] {
  return _syncModuleRef?.getAllSyncStatus() ?? [];
}

/**
 * Live storage status of an XDB instance (audit SN-02): lets an app say
 * "memory only", "damaged collection" or "not loaded" instead of "saved".
 */
export function useXDBStorageStatus(xdb?: XDBService): XDBStorageStatus {
  const scoped = useContext(AppScopeContext)?.xdb;
  const service = xdb ?? scoped ?? getXDB();
  const [status, setStatus] = useState<XDBStorageStatus>(() => service.getStorageStatus());
  useEffect(() => {
    setStatus(service.getStorageStatus());
    return service.subscribeStorage(setStatus);
  }, [service]);
  return status;
}

// Per-app XDB instances
const xdbInstances = new Map<string, XDBService>();

const EPHEMERAL_XDB_PREFIX = '__softn_preview__';
let ephemeralXDBSequence = 0;

export interface EphemeralXDBScope {
  /** Pass to the renderer so scripts, data blocks and components share this store. */
  appId: string;
  xdb: XDBService;
  /** Call after unmounting the preview. Idempotent; discards its data and registry entry. */
  dispose: () => void;
}

/**
 * Create a registered, memory-only database for an editor preview. Seed `xdb`
 * before mounting the renderer, then use this appId for the preview's lifetime.
 * It never hydrates or writes native SQLite, even inside the desktop Builder.
 */
export function createEphemeralXDBScope(): EphemeralXDBScope {
  let appId: string;
  do {
    appId = `${EPHEMERAL_XDB_PREFIX}${Date.now().toString(36)}_${++ephemeralXDBSequence}`;
  } while (xdbInstances.has(appId));

  const values = new Map<string, string>();
  let disposed = false;
  const storage: XDBStorage = {
    getItem: (key) => disposed ? null : values.get(key) ?? null,
    setItem: (key, value) => { if (!disposed) values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
  const xdb = new XDBService(storage, `xdb:${appId}`, appId, { backend: 'storage' });
  xdbInstances.set(appId, xdb);

  return {
    appId,
    xdb,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (xdbInstances.get(appId) === xdb) xdbInstances.delete(appId);
      xdb.destroy();
      values.clear();
    },
  };
}

/**
 * A module-level pointer that once named the running app.
 *
 * Before the app scope existed (loader/app-scope.tsx), SoftNRenderer set this
 * during render and every no-argument getXDB() resolved through it. It named
 * whichever app had rendered most recently, not the app a caller was in, and
 * softn-web keeps every open tab mounted, so a handler that yielded in tab A
 * could resume after tab B re-rendered and write A's record into B's store.
 * Nothing in the loader sets it any more. getXDB(undefined) still honours it
 * only so that a test, or a host written before the scope existed, keeps the
 * behaviour it had.
 */
let activeAppId: string | undefined;

/**
 * Point the no-argument callers at an app; undefined restores the shared
 * default.
 *
 * @deprecated The loader no longer calls this. React code reads the app it
 * is in from the scope — useAppXDB(), or useCollection/useRecord, which
 * consult it — and a non-React caller must pass its appId to getXDB()
 * explicitly. Setting this moves every bare getXDB() while AppScope.appId
 * still reports what the renderer was given, so the two disagree. It remains
 * for tests and for legacy hosts only.
 */
export function setActiveXDBApp(appId?: string): void {
  activeAppId = appId;
}

/**
 * Storage keys are namespaced per app.
 *
 * Every bundle used to share the literal `xdb:` prefix, so opening a second
 * `.softn` gave it read *and delete* access to the first one's records —
 * `getAllCollectionKeys()` even enumerates them, so nothing had to be guessed.
 * The sibling localStorage bridge already namespaces as `softn:<appId>:`, and
 * SoftNRenderer documents per-app isolation as the intended design.
 */
function prefixFor(appId?: string): string {
  return appId ? `xdb:${appId}` : 'xdb';
}

export function getXDB(appId?: string): XDBService {
  const resolved = appId ?? activeAppId;
  const key = resolved || '_default';
  let instance = xdbInstances.get(key);
  if (!instance) {
    // A late callback from a closed preview must never create a persistent
    // database merely because its ephemeral registry entry was released.
    if (key.startsWith(EPHEMERAL_XDB_PREFIX)) {
      throw new Error('The preview database scope has been disposed.');
    }
    const migration = resolved ? migrateLegacyKeys(resolved) : 'none';
    instance = new XDBService(undefined, prefixFor(resolved), resolved);
    if (migration === 'incomplete') {
      instance._noteIssue({ kind: 'migration-incomplete', message: 'Older records could not all be copied into this app\'s storage (out of space). The original records were kept; free storage and reopen the app to finish.' });
    }
    xdbInstances.set(key, instance);
  }
  return instance;
}

/**
 * Adopt records written before storage was namespaced.
 *
 * Without this, upgrading silently empties every existing app. The legacy keys
 * are copied rather than moved because they may hold more than one app's
 * records — there is no way to tell whose is whose after the fact, and deleting
 * them would destroy data belonging to an app that has not been opened yet.
 * Copying preserves exactly the access each app already had while making all
 * subsequent writes private.
 */
/**
 * The old keys are never deleted, the copy is VERIFIED before the namespace is
 * marked migrated, and an interrupted run (quota) leaves no marker so the next
 * open restarts it (audit SN-02).
 *
 * @returns 'none' (nothing to migrate), 'done' (verified) or 'incomplete'
 */
function migrateLegacyKeys(appId: string): 'none' | 'done' | 'incomplete' {
  let storage: Storage;
  try {
    if (typeof localStorage === 'undefined') return 'none';
    storage = localStorage;
  } catch { return 'none'; }

  const marker = `xdb-meta:${appId}:legacy-migration`;
  if (storage.getItem(marker) === 'done') return 'done';

  const legacy: Array<[string, string]> = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    // Only bare `xdb:<collection>` keys — anything with a second colon is
    // already namespaced and belongs to some app.
    if (!key || !key.startsWith('xdb:') || key.indexOf(':', 4) !== -1) continue;
    const value = storage.getItem(key);
    if (value) legacy.push([key.slice(4), value]);
  }
  if (legacy.length === 0) return 'none';

  let complete = true;
  for (const [collection, value] of legacy) {
    const target = `xdb:${appId}:${collection}`;
    if (storage.getItem(target) === null) {
      try {
        storage.setItem(target, value);
      } catch {
        // Out of quota: stop, keep the legacy keys, and report it. The next
        // open resumes from here because no marker was written.
        complete = false;
        break;
      }
    }
    if (storage.getItem(target) !== value && storage.getItem(target) === null) complete = false;
  }
  if (complete) {
    try { storage.setItem(marker, 'done'); } catch { /* the copy is verified; the marker only saves a re-check */ }
    return 'done';
  }
  return 'incomplete';
}

/**
 * Set a custom XDB instance as the default (or for a specific app)
 */
export function setDefaultXDB(xdb: XDBService, appId?: string): void {
  xdbInstances.set(appId || '_default', xdb);
}

/**
 * Hook options for useCollection
 */
export interface UseCollectionOptions {
  /** Custom XDB instance to use */
  xdb?: XDBService;
  /** Query filter */
  filter?: Record<string, unknown>;
  /** Sort order */
  sort?: { field: string; order: 'asc' | 'desc' };
  /** Limit results */
  limit?: number;
  /** Skip initial fetch */
  skip?: boolean;
}

/**
 * React hook for accessing an XDB collection with automatic reactivity
 */
export function useCollection(
  collectionName: string,
  options: UseCollectionOptions = {}
): UseCollectionResult {
  // The store of the app this component is rendered in, when a renderer
  // published one; nothing else knows which app a component several levels
  // below the renderer belongs to. Read unconditionally — hook order — and
  // consulted only when the caller named no store, since an explicit option
  // is the caller saying it knows better than the tree it sits in. Below no
  // provider this is the shared default, as before.
  const scoped = useContext(AppScopeContext)?.xdb;
  const xdb = options.xdb ?? scoped ?? getXDB();

  const [records, setRecords] = useState<XDBRecord[]>([]);
  const [loading, setLoading] = useState(!options.skip);
  const [error, setError] = useState<Error | null>(null);

  // Query options
  const queryOptions = useMemo(
    () => ({
      filter: options.filter,
      sort: options.sort,
      limit: options.limit,
    }),
    [options.filter, options.sort, options.limit]
  );

  // Fetch records
  const fetchRecords = useCallback(() => {
    try {
      const data = xdb.query(collectionName, queryOptions);
      setRecords(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, [xdb, collectionName, queryOptions]);

  const hasFiltersOrSort = !!(
    queryOptions.filter ||
    queryOptions.sort ||
    queryOptions.limit !== undefined
  );

  // Initial fetch and subscription
  useEffect(() => {
    if (!options.skip) {
      fetchRecords();
    }

    // Subscribe to changes — patch state incrementally when possible,
    // fall back to full re-fetch only when filters/sorts need reapplying
    const unsubscribe = xdb.subscribe(collectionName, (event) => {
      if (event.type === 'refresh' || event.type === 'sync') {
        // Full re-fetch for bulk events
        fetchRecords();
      } else if (hasFiltersOrSort) {
        // Must re-fetch to reapply filters/sort/limit
        fetchRecords();
      } else if (event.type === 'create' && event.record) {
        // Append new record directly
        setRecords((prev) => [...prev, event.record!]);
      } else if (event.type === 'update' && event.record) {
        // Patch updated record in place
        setRecords((prev) => prev.map((r) => r.id === event.record!.id ? event.record! : r));
      } else if (event.type === 'delete' && event.record) {
        // Remove deleted record
        setRecords((prev) => prev.filter((r) => r.id !== event.record!.id));
      } else {
        fetchRecords();
      }
    });

    return unsubscribe;
  }, [xdb, collectionName, options.skip, fetchRecords, hasFiltersOrSort]);

  // Refresh function
  const refresh = useCallback(() => {
    setLoading(true);
    fetchRecords();
  }, [fetchRecords]);

  // Create function
  const create = useCallback(
    async (data: Record<string, unknown>): Promise<XDBRecord> => {
      try {
        const record = xdb.isP2PAvailable()
          ? await xdb.createAsync(collectionName, data)
          : xdb.create(collectionName, data);
        return record;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        setError(error);
        throw error;
      }
    },
    [xdb, collectionName]
  );

  // Update function
  const update = useCallback(
    async (id: string, data: Record<string, unknown>): Promise<XDBRecord> => {
      try {
        if (xdb.isP2PAvailable()) {
          const record = await xdb.updateAsync(id, data);
          if (!record) {
            throw new Error(`Record ${id} not found in collection ${collectionName}`);
          }
          return record;
        }

        const record = xdb.updateInCollection(collectionName, id, data);
        if (!record) {
          throw new Error(`Record ${id} not found in collection ${collectionName}`);
        }
        return record;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        setError(error);
        throw error;
      }
    },
    [xdb, collectionName]
  );

  // Remove function
  const remove = useCallback(
    async (id: string): Promise<void> => {
      try {
        if (xdb.isP2PAvailable()) {
          const success = await xdb.deleteAsync(id);
          if (!success) {
            throw new Error(`Record ${id} not found in collection ${collectionName}`);
          }
          return;
        }

        const success = xdb.deleteFromCollection(collectionName, id);
        if (!success) {
          throw new Error(`Record ${id} not found in collection ${collectionName}`);
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        setError(error);
        throw error;
      }
    },
    [xdb, collectionName]
  );

  return {
    records,
    loading,
    error,
    refresh,
    create,
    update,
    remove,
  };
}

/**
 * Hook to get a single record by ID
 */
export function useRecord(
  collectionName: string,
  recordId: string | null,
  options: { xdb?: XDBService } = {}
): { record: XDBRecord | null; loading: boolean; error: Error | null; refresh: () => void } {
  // Same resolution as useCollection: the caller's store, else the app's
  // from context, else the shared default.
  const scoped = useContext(AppScopeContext)?.xdb;
  const xdb = options.xdb ?? scoped ?? getXDB();

  const [record, setRecord] = useState<XDBRecord | null>(null);
  const [loading, setLoading] = useState(!!recordId);
  const [error, setError] = useState<Error | null>(null);

  const fetchRecord = useCallback(() => {
    if (!recordId) {
      setRecord(null);
      setError(null);
      setLoading(false);
      return;
    }

    try {
      const data = xdb.get(collectionName, recordId);
      setRecord(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, [xdb, collectionName, recordId]);

  useEffect(() => {
    fetchRecord();

    if (!recordId) return;

    // Subscribe to changes
    const unsubscribe = xdb.subscribe(collectionName, (event) => {
      if (event.type === 'refresh' || event.type === 'sync' || event.record?.id === recordId) {
        fetchRecord();
      }
    });

    return unsubscribe;
  }, [xdb, collectionName, recordId, fetchRecord]);

  return {
    record,
    loading,
    error,
    refresh: fetchRecord,
  };
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Generate a unique ID (UUIDv4-like)
 */
function generateId(): string {
  // Use crypto.randomUUID if available (modern browsers and Node.js)
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }

  // Fallback using crypto.getRandomValues (available in all modern browsers)
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    // Set version 4 (bits 12-15 of byte 6) and variant 1 (bits 6-7 of byte 8)
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  }

  // Last resort fallback (non-cryptographic, only for very old environments)
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Create an in-memory storage (for SSR or testing)
 */
function createMemoryStorage(): XDBStorage {
  const store = new Map<string, string>();

  return {
    getItem(key: string): string | null {
      return store.get(key) || null;
    },
    setItem(key: string, value: string): void {
      store.set(key, value);
    },
    removeItem(key: string): void {
      store.delete(key);
    },
  };
}

/**
 * Create XDB module for script integration
 */
export function createXDBModule(xdb?: XDBService) {
  const db = xdb || getXDB();

  return {
    create: (collection: string, data: Record<string, unknown>) => {
      return db.create(collection, data);
    },
    createAsync: (collection: string, data: Record<string, unknown>) => {
      return db.createAsync(collection, data);
    },
    get: (collection: string, id: string) => {
      return db.get(collection, id);
    },
    getAsync: (collection: string, id: string) => {
      return db.getAsync(collection, id);
    },
    query: (collection: string, filter?: Record<string, unknown>) => {
      return db.query(collection, filter ? { filter } : undefined);
    },
    queryAsync: (collection: string, filter?: Record<string, unknown>) => {
      return db.queryAsync(collection, filter ? { filter } : undefined);
    },
    getAll: (collection: string) => {
      return db.getAll(collection);
    },
    getAllAsync: (collection: string) => {
      return db.getAllAsync(collection);
    },
    update: (id: string, data: Record<string, unknown>) => {
      return db.update(id, data);
    },
    updateAsync: (id: string, data: Record<string, unknown>) => {
      return db.updateAsync(id, data);
    },
    delete: (id: string) => {
      return db.delete(id);
    },
    deleteAsync: (id: string) => {
      return db.deleteAsync(id);
    },
    sync: (collection?: string) => {
      return db.sync(collection);
    },
    count: (collection: string) => {
      return db.count(collection);
    },
    clear: (collection: string) => {
      return db.clear(collection);
    },
    // P2P specific
    getNetworkStatus: () => {
      return db.getNetworkStatus();
    },
    isP2PAvailable: () => {
      return db.isP2PAvailable();
    },
  };
}
