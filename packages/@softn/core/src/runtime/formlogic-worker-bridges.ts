/**
 * Snapshot-based bridges for Web Worker FormLogic execution.
 *
 * These bridges operate on in-memory snapshots of XDB data and localStorage,
 * allowing the WASM VM to run in a Web Worker without direct access to the
 * main thread's storage. Mutations are queued and sent back to the main thread.
 */

// ============================================================================
// Mutation types
// ============================================================================

export type DBMutation =
  | { type: 'create'; collection: string; data: Record<string, unknown>; tempId: string }
  | { type: 'update'; id: string; data: Record<string, unknown> }
  | { type: 'delete'; id: string }
  | { type: 'hardDelete'; collection: string; id: string }
  | { type: 'startSync'; room: string; options?: Record<string, unknown> }
  | { type: 'stopSync'; room?: string };

export type LSMutation =
  | { type: 'setItem'; key: string; value: string }
  | { type: 'removeItem'; key: string }
  | { type: 'clear' };

// ============================================================================
// XDBRecord shape (duplicated here to avoid importing from ../types in worker)
// ============================================================================

interface WorkerXDBRecord {
  id: string;
  collection: string;
  data: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  deleted?: boolean;
}

// ============================================================================
// Snapshot DB Bridge
// ============================================================================

let tempIdCounter = 0;

/**
 * In-memory DB bridge backed by a snapshot from the main thread.
 * Supports read operations from the snapshot and queues write operations
 * as mutations to be applied on the main thread.
 */
export class SnapshotDBBridge {
  private collections: Map<string, WorkerXDBRecord[]> = new Map();
  private allRecords: Map<string, WorkerXDBRecord> = new Map();
  private mutations: DBMutation[] = [];
  private _syncStatus = { connected: false, peers: 0, room: '', peerId: '' };
  private _savedSyncRoom: string | null = null;

  /**
   * Replace the snapshot with fresh data from the main thread.
   */
  updateSnapshot(
    data: Record<string, WorkerXDBRecord[]>,
    syncStatus?: { connected: boolean; peers: number; room: string; peerId: string },
    savedSyncRoom?: string | null
  ): void {
    this.collections.clear();
    this.allRecords.clear();
    for (const [collection, records] of Object.entries(data)) {
      const arr = (records || []).map(r => ({ ...r }));
      this.collections.set(collection, arr);
      for (const rec of arr) {
        this.allRecords.set(rec.id, rec);
      }
    }
    if (syncStatus) this._syncStatus = syncStatus;
    if (savedSyncRoom !== undefined) this._savedSyncRoom = savedSyncRoom;
    this.mutations = [];
  }

  /**
   * Merge a partial snapshot (delta) into the existing snapshot.
   * Only the collections present in the delta are replaced; all others
   * are preserved from the previous snapshot. This avoids the cost of
   * structured-cloning the entire DB state across the worker boundary.
   */
  mergeDelta(
    delta: Record<string, WorkerXDBRecord[]>,
    syncStatus?: { connected: boolean; peers: number; room: string; peerId: string },
    savedSyncRoom?: string | null
  ): void {
    for (const [collection, records] of Object.entries(delta)) {
      // Remove old records for this collection from allRecords
      const existing = this.collections.get(collection);
      if (existing) {
        for (const r of existing) {
          this.allRecords.delete(r.id);
        }
      }
      // Insert new records
      const arr = (records || []).map(r => ({ ...r }));
      this.collections.set(collection, arr);
      for (const rec of arr) {
        this.allRecords.set(rec.id, rec);
      }
    }
    if (syncStatus) this._syncStatus = syncStatus;
    if (savedSyncRoom !== undefined) this._savedSyncRoom = savedSyncRoom;
    this.mutations = [];
  }

  /**
   * Flush queued mutations and return them.
   */
  flushMutations(): DBMutation[] {
    const m = this.mutations;
    this.mutations = [];
    return m;
  }

  // --- DBNamespace-compatible interface ---

  query(collection: string): WorkerXDBRecord[] {
    return this.collections.get(collection) || [];
  }

  create(collection: string, data: Record<string, unknown>): WorkerXDBRecord {
    const tempId = `_wk_${++tempIdCounter}`;
    const now = new Date().toISOString();
    const record: WorkerXDBRecord = {
      id: tempId,
      collection,
      data: { ...data },
      created_at: now,
      updated_at: now,
      deleted: false,
    };
    const arr = this.collections.get(collection) || [];
    arr.push(record);
    this.collections.set(collection, arr);
    this.allRecords.set(tempId, record);
    this.mutations.push({ type: 'create', collection, data: { ...data }, tempId });
    return record;
  }

  update(id: string, data: Record<string, unknown>): WorkerXDBRecord | null {
    const existing = this.allRecords.get(id);
    if (!existing) return null;
    const updated: WorkerXDBRecord = {
      ...existing,
      data: { ...existing.data, ...data },
      updated_at: new Date().toISOString(),
    };
    this.allRecords.set(id, updated);
    const arr = this.collections.get(existing.collection);
    if (arr) {
      const idx = arr.findIndex(r => r.id === id);
      if (idx >= 0) arr[idx] = updated;
    }
    this.mutations.push({ type: 'update', id, data: { ...data } });
    return updated;
  }

  delete(id: string): void {
    const existing = this.allRecords.get(id);
    if (existing) {
      this.allRecords.delete(id);
      const arr = this.collections.get(existing.collection);
      if (arr) {
        const idx = arr.findIndex(r => r.id === id);
        if (idx >= 0) arr.splice(idx, 1);
      }
    }
    this.mutations.push({ type: 'delete', id });
  }

  hardDelete(collection: string, id: string): void {
    this.allRecords.delete(id);
    const arr = this.collections.get(collection);
    if (arr) {
      const idx = arr.findIndex(r => r.id === id);
      if (idx >= 0) arr.splice(idx, 1);
    }
    this.mutations.push({ type: 'hardDelete', collection, id });
  }

  get(collection: string, id: string): WorkerXDBRecord | null {
    const arr = this.collections.get(collection) || [];
    return arr.find(r => r.id === id) || null;
  }

  startSync(room: string, options?: Record<string, unknown>): void {
    this.mutations.push({ type: 'startSync', room, options });
  }

  stopSync(room?: string): void {
    this.mutations.push({ type: 'stopSync', room });
  }

  getSyncStatus(): { connected: boolean; peers: number; room: string; peerId: string } {
    return this._syncStatus;
  }

  getSavedSyncRoom(): string | null {
    return this._savedSyncRoom;
  }

  ready(): Promise<void> {
    return Promise.resolve();
  }
}

// ============================================================================
// Snapshot LocalStorage Bridge
// ============================================================================

/**
 * In-memory localStorage bridge backed by a snapshot from the main thread.
 * Keys are unprefixed (the main thread handles prefix stripping/adding).
 */
export class SnapshotLocalStorageBridge {
  private store: Map<string, string> = new Map();
  private mutations: LSMutation[] = [];

  updateSnapshot(data: Record<string, string>): void {
    this.store.clear();
    for (const [k, v] of Object.entries(data)) {
      this.store.set(k, v);
    }
    this.mutations = [];
  }

  flushMutations(): LSMutation[] {
    const m = this.mutations;
    this.mutations = [];
    return m;
  }

  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value);
    this.mutations.push({ type: 'setItem', key, value });
  }

  removeItem(key: string): void {
    this.store.delete(key);
    this.mutations.push({ type: 'removeItem', key });
  }

  clear(): void {
    this.store.clear();
    this.mutations.push({ type: 'clear' });
  }
}
