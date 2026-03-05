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

  constructor(storage?: XDBStorage, prefix = 'xdb', appId?: string) {
    this.storage =
      storage || (typeof localStorage !== 'undefined' ? localStorage : createMemoryStorage());
    this.prefix = prefix;
    this.appId = appId;
    this.listeners = new Map();
    this.globalListeners = new Set();
    this.useTauri = isTauri();

    this.isReady = new Promise(resolve => {
      this._resolveReady = resolve;
    });

    // Setup Tauri event listeners for P2P sync
    if (this.useTauri) {
      this.setupTauriEventListeners();
      this.hydrateFromBackend();
    } else {
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

    tauriInvoke<string[]>('get_collections', this.tauriArgs())
      .then(async (collections) => {
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
            this.emit({ type: 'refresh', collection, records: this.getCollectionData(collection) });
          } catch (err) {
            console.error('[XDB] Failed to hydrate collection:', collection, err);
          }
        }
        this._resolveReady();
      })
      .catch((err) => {
        console.error('[XDB] Failed to hydrate from Tauri backend:', err);
        // Resolve anyway to prevent the app from hanging permanently
        this._resolveReady();
      });
  }

  /**
   * Cleanup Tauri event listeners
   */
  destroy(): void {
    for (const unlisten of this.tauriUnlisteners) {
      unlisten();
    }
    this.tauriUnlisteners = [];
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

    const key = this.collectionKey(collection);
    const data = this.storage.getItem(key);
    if (!data) return [];

    try {
      return JSON.parse(data) as XDBRecord[];
    } catch {
      return [];
    }
  }

  private setCollectionData(collection: string, records: XDBRecord[]): void {
    if (this.useTauri) {
      const coll = new Map<string, XDBRecord>();
      for (const r of records) coll.set(r.id, r);
      this.memoryStore.set(collection, coll);
      this.knownCollections.add(collection);
      return;
    }

    const key = this.collectionKey(collection);
    this.storage.setItem(key, JSON.stringify(records));
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

      // Create in backend asynchronously
      tauriInvoke<XDBRecord>('create_record', this.tauriArgs({
        payload: { collection, data },
      }))
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
            tauriInvoke('update_record', this.tauriArgs({
              payload: { id: serverRecord.id, data: mergedData },
            })).catch(() => {});
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

    return record;
  }

  /**
   * Create a record asynchronously (returns the actual server record)
   */
  async createAsync(collection: string, data: Record<string, unknown>): Promise<XDBRecord> {
    if (this.useTauri) {
      const record = await tauriInvoke<XDBRecord>('create_record', this.tauriArgs({
        payload: { collection, data },
      }));
      this.getOrCreateCollection(collection).set(record.id, record);
      this.emit({ type: 'create', collection, record });
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
      tauriInvoke<XDBRecord>('update_record', this.tauriArgs({
        payload: { id: resolvedId, data },
      }))
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
        const record = await tauriInvoke<XDBRecord>('update_record', this.tauriArgs({
          payload: { id, data },
        }));
        this.getOrCreateCollection(record.collection).set(record.id, record);
        this.emit({ type: 'update', collection: record.collection, record });
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
      return updatedRecord;
    }

    const records = this.getAllCollectionData(collection);
    const index = records.findIndex((r) => r.id === id);

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
      tauriInvoke<boolean>('delete_record', this.tauriArgs({ id: resolvedId }))
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
        await tauriInvoke<boolean>('delete_record', this.tauriArgs({ id }));
        for (const [collection, coll] of this.memoryStore) {
          const record = coll.get(id);
          if (record) {
            const deleted = { ...record, deleted: true, updated_at: new Date().toISOString() };
            coll.set(id, deleted);
            this.emit({ type: 'delete', collection, record: deleted });
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
      const record = coll?.get(id);
      if (!record || record.deleted) return false;
      const deleted = { ...record, deleted: true, updated_at: new Date().toISOString() };
      coll!.set(id, deleted);
      this.emit({ type: 'delete', collection, record: deleted });
      return true;
    }

    const records = this.getAllCollectionData(collection);
    const index = records.findIndex((r) => r.id === id);

    if (index === -1) return false;

    const record = records[index];
    record.deleted = true;
    record.updated_at = new Date().toISOString();

    this.setCollectionData(collection, records);

    this.emit({ type: 'delete', collection, record });

    return true;
  }

  /**
   * Hard delete - permanently remove a record
   */
  hardDelete(collection: string, id: string): boolean {
    if (this.useTauri) {
      const coll = this.memoryStore.get(collection);
      const record = coll?.get(id);
      if (!record) return false;
      coll!.delete(id);

      if (this.useTauri) {
        tauriInvoke<boolean>('delete_record', this.tauriArgs({ id })).catch((err) => {
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
      tauriInvoke<boolean>('delete_record', this.tauriArgs({ id })).catch((err) => {
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
      tauriInvoke<XDBRecord>('upsert_record', this.tauriArgs({ record })).catch((err) => {
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
    if (this.useTauri) {
      const coll = this.memoryStore.get(collection);
      const removed = coll?.get(id);
      if (removed) {
        coll!.delete(id);
        this.emit({ type: 'delete', collection, record: removed });
      }
      tauriInvoke<boolean>('delete_record', this.tauriArgs({ id })).catch((err) => {
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
        if (key?.startsWith(prefixWithColon)) {
          keys.push(key.slice(prefixWithColon.length));
        }
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
    if (this.useTauri) {
      this.memoryStore.delete(collection);
      this.knownCollections.delete(collection);
      this.emit({ type: 'refresh', collection, records: [] });
      // Persist to SQLite backend
      tauriInvoke<boolean>('clear_collection', this.tauriArgs({ collection })).catch((err) => {
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
          await tauriInvoke<boolean>('request_sync', this.tauriArgs({ collection }));
          console.log(`[XDB] Requested P2P sync for collection: ${collection}`);
        } else {
          // Sync all collections in batches to avoid flooding IPC/network
          const collections = await tauriInvoke<string[]>('get_collections', this.tauriArgs());
          const BATCH_SIZE = 5;
          for (let i = 0; i < collections.length; i += BATCH_SIZE) {
            const batch = collections.slice(i, i + BATCH_SIZE);
            await Promise.all(batch.map((col) => tauriInvoke<boolean>('request_sync', this.tauriArgs({ collection: col }))));
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
  async getNetworkStatus(): Promise<{
    peer_id: string;
    connected_peers: string[];
    is_running: boolean;
  }> {
    if (this.useTauri) {
      try {
        return await tauriInvoke('get_network_status', this.tauriArgs());
      } catch (err) {
        console.error('[XDB] Failed to get network status:', err);
        return { peer_id: '', connected_peers: [], is_running: false };
      }
    }

    // Not available in localStorage mode
    return { peer_id: '', connected_peers: [], is_running: false };
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
   * Import data from an export object
   * @param data - The exported data object
   * @param options - Import options
   */
  import(
    data: XDBExportData,
    options: { merge?: boolean; clearFirst?: boolean } = {}
  ): { imported: number; collections: string[] } {
    const { merge = true, clearFirst = false } = options;
    let importedCount = 0;
    const importedCollections: string[] = [];

    for (const [collection, records] of Object.entries(data.collections)) {
      if (clearFirst) {
        this.clear(collection);
      }

      if (merge) {
        if (this.useTauri) {
          // O(1) merge via Map
          const coll = this.getOrCreateCollection(collection);
          for (const record of records) {
            coll.set(record.id, record);
            importedCount++;
          }
        } else {
          // Array-based merge for localStorage
          const existingRecords = this.getAllCollectionData(collection);
          const existingIds = new Set(existingRecords.map((r) => r.id));

          for (const record of records) {
            if (existingIds.has(record.id)) {
              const index = existingRecords.findIndex((r) => r.id === record.id);
              if (index !== -1) {
                existingRecords[index] = record;
              }
            } else {
              existingRecords.push(record);
            }
            importedCount++;
          }

          this.setCollectionData(collection, existingRecords);
        }
      } else {
        // Replace all data in collection
        this.setCollectionData(collection, records);
        importedCount += records.length;
      }

      importedCollections.push(collection);

      // Persist imported records to Tauri backend
      if (this.useTauri) {
        const allRecords = this.getAllCollectionData(collection);
        for (const record of allRecords) {
          tauriInvoke<XDBRecord>('upsert_record', this.tauriArgs({ record })).catch((err) => {
            console.error('[XDB] Failed to persist imported record in Tauri:', err);
          });
        }
      }

      this.emit({ type: 'refresh', collection, records: this.getCollectionData(collection) });
    }

    return { imported: importedCount, collections: importedCollections };
  }

  /**
   * Import data from a JSON string
   */
  importFromJSON(
    jsonString: string,
    options: { merge?: boolean; clearFirst?: boolean } = {}
  ): { imported: number; collections: string[] } {
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
   * Restore from a backup
   */
  restore(backup: XDBExportData): void {
    this.import(backup, { merge: false, clearFirst: true });
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

// ============================================================================
// React Hooks
// ============================================================================

import { useState, useEffect, useCallback, useMemo } from 'react';

// Per-app XDB instances
const xdbInstances = new Map<string, XDBService>();

/**
 * Get or create an XDB instance, optionally per-app.
 * When appId is provided, returns an isolated instance for that app.
 * Without appId, returns the default instance.
 */
export function getXDB(appId?: string): XDBService {
  const key = appId || '_default';
  let instance = xdbInstances.get(key);
  if (!instance) {
    instance = new XDBService(undefined, 'xdb', appId);
    xdbInstances.set(key, instance);
  }
  return instance;
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
  const xdb = options.xdb || getXDB();

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

  // Initial fetch and subscription
  useEffect(() => {
    if (!options.skip) {
      fetchRecords();
    }

    // Subscribe to changes — patch state incrementally when possible,
    // fall back to full re-fetch only when filters/sorts need reapplying
    const hasFiltersOrSort = !!(queryOptions.filter || queryOptions.sort || queryOptions.limit);
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
  }, [xdb, collectionName, options.skip, fetchRecords]);

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
  const xdb = options.xdb || getXDB();

  const [record, setRecord] = useState<XDBRecord | null>(null);
  const [loading, setLoading] = useState(!!recordId);
  const [error, setError] = useState<Error | null>(null);

  const fetchRecord = useCallback(() => {
    if (!recordId) {
      setRecord(null);
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
      if (event.record?.id === recordId) {
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
 * Create XDB module for FormLogic integration
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
