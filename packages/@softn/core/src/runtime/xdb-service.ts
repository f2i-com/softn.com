/**
 * XDB Service - the database itself.
 *
 * One class, two backends chosen at construction: the native SQLite store
 * behind Tauri (with P2P sync) when the page runs inside the SoftN Loader,
 * else the storage-backed (localStorage, or memory) store. The
 * per-app registry that hands out instances lives in xdb-registry.ts, the
 * React hooks in xdb-hooks.ts, the types in xdb-types.ts; ./xdb re-exports
 * all of them under the paths everything imports.
 */

import type { XDBRecord } from '../types';
import { isTauri, tauriInvoke, tauriListen } from './xdb-native-transport';
import { XDBStorageError } from './xdb-types';
import type {
  XDBEvent,
  XDBEventListener,
  XDBQueryOptions,
  XDBStorage,
  XDBCreateOptions,
  XDBServiceOptions,
  XDBStorageState,
  XDBStorageIssue,
  XDBStorageStatus,
  XDBDurableImportResult,
  XDBPersistResult,
  XDBNetworkStatus,
  XDBNetworkSettings,
  XDBExportData,
  XDBImportResult,
} from './xdb-types';

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
  /**
   * Optimistic ids hard-deleted while their create was still in flight. The
   * record is already out of the cache, so the create callback cannot see
   * the deletion there; this is how it learns not to put the record back.
   */
  private abandonedCreates: Set<string> = new Set();
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

  /**
   * The id a new record gets: the caller's, when it offers one that names
   * nothing in the collection yet (a worker hands over the id its snapshot
   * already uses, so what the script holds is what the store holds), else a
   * fresh one. An id already in use, live or tombstoned, is never reused.
   */
  private usableId(collection: string, wanted: string | undefined): string {
    if (typeof wanted !== 'string' || wanted.length === 0 || wanted.length > 128) return generateId();
    if (this.useTauri) {
      if (this.memoryStore.get(collection)?.has(wanted) || this.optimisticIdMap.has(wanted)) return generateId();
      return wanted;
    }
    return this.getAllCollectionData(collection).some((r) => r.id === wanted) ? generateId() : wanted;
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

  /**
   * A native write the synchronous API had already answered for came back
   * refused (core audit 2.4). The API's result shapes are unchanged — the
   * caller got its optimistic record — so the disagreement between memory
   * and SQLite is reported where the host can see it: the console, as before,
   * and the storage status, which the host's notice bar watches. The next
   * acknowledged write to the same collection clears it.
   */
  private nativeWriteFailed(operation: string, collection: string | undefined, err: unknown): void {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[XDB] Failed to ${operation} in the native database:`, err);
    this.noteIssue({
      kind: 'write-failed',
      collection,
      message: collection
        ? `A change to "${collection}" could not be saved to the native database (${reason}). What you see may not be what is stored; retry the change or export your data.`
        : `A change could not be saved to the native database (${reason}). What you see may not be what is stored; retry the change or export your data.`,
    });
  }

  /** A native write landed: a refusal noted for its collection no longer describes the store. */
  private nativeWriteLanded(collection: string | undefined): void {
    if (!this.issues.some(i => i.kind === 'write-failed' && i.collection === collection)) return;
    this.issues = this.issues.filter(i => !(i.kind === 'write-failed' && i.collection === collection));
    if (this.storageState === 'degraded' && this.corrupt.size === 0 && this.issues.length === 0) this.storageState = 'ready';
    this.notifyStatus();
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
  create(collection: string, data: Record<string, unknown>, options: XDBCreateOptions = {}): XDBRecord {
    if (this.useTauri) {
      this.knownCollections.add(collection);
      // Async create via Tauri - fire and forget, return optimistic result.
      // A caller-chosen id (a worker's snapshot record) is the optimistic id
      // here; SQLite still assigns the stored id, and the map below joins the
      // two exactly as it does for a generated one.
      const optimisticRecord: XDBRecord = {
        id: this.usableId(collection, options.id),
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

      // Create in backend asynchronously. Server sync is told once SQLite has
      // the record and under the id SQLite gave it: announced on the optimistic
      // id, a record that the native write then refused was pushed to the
      // server under an id that exists nowhere.
      this.native<XDBRecord>('create_record', {
        payload: { collection, data },
      })
        .then((serverRecord) => {
          this.pendingCreateIds.delete(optimisticRecord.id);
          this.nativeWriteLanded(collection);
          const c = this.getOrCreateCollection(collection);
          const currentOptimistic = c.get(optimisticRecord.id);
          c.delete(optimisticRecord.id);

          // Store ID mapping so in-flight updates/deletes can resolve the real ID
          this.optimisticIdMap.set(optimisticRecord.id, serverRecord.id);

          // A delete that raced the create is applied now, after it: the row
          // SQLite just wrote is tombstoned under its own id, the cache keeps
          // the tombstone, and nothing announces a record that was gone
          // before it was acknowledged. (Applying the server record first
          // used to bring the record back to life.)
          if (currentOptimistic?.deleted || this.abandonedCreates.delete(optimisticRecord.id)) {
            if (currentOptimistic) {
              c.set(serverRecord.id, { ...serverRecord, data: { ...serverRecord.data, ...currentOptimistic.data }, deleted: true, updated_at: currentOptimistic.updated_at });
            }
            this.native<boolean>('delete_record', { id: serverRecord.id })
              .then(() => this.nativeWriteLanded(collection))
              .catch((err) => this.nativeWriteFailed('delete a record', collection, err));
            return;
          }

          // Preserve any local data modifications made since creation (e.g. db.update()
          // calls that ran between create() and this callback resolving)
          let mergedRecord: XDBRecord;
          // (An update replaces the cached object, so identity says whether
          // one happened; timestamps can agree to the millisecond.)
          if (currentOptimistic && currentOptimistic !== optimisticRecord) {
            // Local data was modified — merge: local data wins over server's original data
            const mergedData = { ...serverRecord.data, ...currentOptimistic.data };
            mergedRecord = { ...serverRecord, data: mergedData };
            // Push merged data to server so it's persisted
            this.native('update_record', {
              payload: { id: serverRecord.id, data: mergedData },
            }).catch((err) => this.nativeWriteFailed('update a record', collection, err));
          } else {
            mergedRecord = serverRecord;
          }

          c.set(serverRecord.id, mergedRecord);
          this.emit({ type: 'create', collection, record: mergedRecord });
          this.notifyMutation('create', collection, mergedRecord.id, mergedRecord.data);
        })
        .catch((err) => {
          this.pendingCreateIds.delete(optimisticRecord.id);
          this.abandonedCreates.delete(optimisticRecord.id);
          this.nativeWriteFailed('create a record', collection, err);
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
      id: this.usableId(collection, options.id),
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

      // The collection of the record this touched, for the failure report,
      // and whether its own create was still in flight when this was sent:
      // by the time SQLite answers, the create may have landed.
      let touched: string | undefined;
      // While the record's own create is in flight SQLite has no row to
      // address: the change is kept in the cache and the create callback
      // sends it, merged, once the row exists. Sending it now could only fail.
      if (!this.pendingCreateIds.has(id)) {
        // Async update via Tauri - fire and forget
        this.native<XDBRecord>('update_record', {
          payload: { id: resolvedId, data },
        })
          .then((serverRecord) => {
            this.nativeWriteLanded(serverRecord.collection);
            // Only apply server response if no newer local changes exist
            const c = this.getOrCreateCollection(serverRecord.collection);
            const current = c.get(serverRecord.id);
            if (!current || current.updated_at <= serverRecord.updated_at) {
              c.set(serverRecord.id, serverRecord);
              this.emit({ type: 'update', collection: serverRecord.collection, record: serverRecord });
            }
          })
          .catch((err) => {
            // Expected for a record that is gone; a refusal for a record
            // that exists is a failure.
            if (touched === undefined) return;
            this.nativeWriteFailed('update a record', touched, err);
          });
      }

      // Return optimistic result — try both the original and resolved IDs
      for (const [collection, coll] of this.memoryStore) {
        let record = coll.get(id);
        if (!record && id !== resolvedId) record = coll.get(resolvedId);
        if (record && !record.deleted) {
          touched = collection;
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

      // The collection of the record this touched, for the failure report,
      // and whether its own create was still in flight when this was sent.
      let touched: string | undefined;
      // A record whose create is still in flight has no row to delete yet;
      // the tombstone below stays in the cache and the create callback
      // deletes the row once SQLite has written it.
      if (!this.pendingCreateIds.has(id)) {
        // Async delete via Tauri - fire and forget
        this.native<boolean>('delete_record', { id: resolvedId })
          .then(() => {
            this.nativeWriteLanded(touched);
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
          .catch((err) => {
            // Expected when the record was already gone; a refusal for a
            // record that exists is a failure.
            if (touched === undefined) return;
            this.nativeWriteFailed('delete a record', touched, err);
          });
      }

      // Optimistically update in-memory cache — try both original and resolved IDs
      for (const [collection, coll] of this.memoryStore) {
        const lookupId = coll.has(id) ? id : (id !== resolvedId && coll.has(resolvedId) ? resolvedId : null);
        if (!lookupId) continue;
        const record = coll.get(lookupId);
        if (record && !record.deleted) {
          touched = collection;
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
      // A row still being created is deleted by the create callback instead.
      if (!this.pendingCreateIds.has(record.id)) {
        this.native<boolean>('delete_record', { id: record.id })
          .then(() => this.nativeWriteLanded(collection))
          .catch((err) => this.nativeWriteFailed('delete a record', collection, err));
      }
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

      if (this.pendingCreateIds.has(id)) {
        // No row yet: the create callback deletes the one SQLite writes and
        // never puts the record back in the cache.
        this.abandonedCreates.add(id);
      } else {
        this.native<boolean>('delete_record', { id })
          .then(() => this.nativeWriteLanded(collection))
          .catch((err) => this.nativeWriteFailed('remove a record', collection, err));
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
      this.native<XDBRecord>('upsert_record', { record })
        .then(() => this.nativeWriteLanded(collection))
        .catch((err) => this.nativeWriteFailed('save a record', collection, err));
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
      this.native<boolean>('delete_record', { id })
        .then(() => this.nativeWriteLanded(collection))
        .catch((err) => this.nativeWriteFailed('remove a record', collection, err));
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
      this.native<boolean>('clear_collection', { collection })
        .then(() => this.nativeWriteLanded(collection))
        .catch((err) => this.nativeWriteFailed('clear a collection', collection, err));
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
   * Every previous value is READ and every replacement PREPARED before the
   * first write (R3-SN-03), so a read or preparation failure changes nothing
   * at all, and the only failures that can occur mid-sequence are writes,
   * which the rollback below covers. This is an in-memory undo, not a
   * journal: the product does not promise atomicity across a crash between
   * two collection writes, and the error text says what remains.
   * Native: the cache is updated optimistically and ONE transaction carries
   * every batch; on failure the cache is reloaded from disk (audit SN-01).
   */
  private executeImport(plans: ImportPlan[]): { imported: number; collections: string[]; persisted: Promise<XDBPersistResult> } {
    const importedCollections: string[] = [];
    const imported = plans.reduce((n, plan) => n + plan.accepted, 0);

    if (!this.useTauri) {
      // Phase 1: read and prepare everything. Nothing is written yet, so a
      // failure here (an unreadable key, a corrupt previous value) leaves
      // every collection exactly as it was.
      const prepared: Array<{ collection: string; previous: string | null; records: XDBRecord[] }> = [];
      for (const plan of plans) {
        try {
          const previous = this.storage.getItem(this.collectionKey(plan.collection));
          const records = XDBService.mergePlan(this.getAllCollectionData(plan.collection), plan);
          prepared.push({ collection: plan.collection, previous, records });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new XDBStorageError(
            error instanceof XDBStorageError ? error.kind : 'corrupt',
            `Import refused at "${plan.collection}" while reading its current contents (${message}); nothing was changed.`,
            plan.collection
          );
        }
      }
      // Phase 2: write, with the earlier collections restored on a later failure.
      const written: Array<{ collection: string; previous: string | null }> = [];
      for (const plan of prepared) {
        const { previous, records } = plan;
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
