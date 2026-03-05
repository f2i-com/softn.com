/**
 * XDB Sync — Real-time P2P Data Sharing via Yjs + WebRTC
 *
 * Provides peer-to-peer data synchronization for XDB so that SoftN apps
 * running on different devices can share data in real time over the network.
 *
 * The sync layer is opt-in per app instance — you join a "room" to start sharing.
 * The existing XDB API (db.create, db.query, db.update, db.delete) remains unchanged.
 */

import * as Y from 'yjs';
import { WebrtcProvider } from 'y-webrtc';
import { IndexeddbPersistence } from 'y-indexeddb';
import { XDBService, type XDBEvent } from './xdb';
import type { XDBRecord } from '../types';

// ── Types ─────────────────────────────────────────────────

export interface XDBSyncOptions {
  /** Room name — all peers in the same room share data */
  room: string;
  /** Optional password for encrypted signaling */
  password?: string;
  /** Signaling server URLs (defaults to public Yjs signaling) */
  signaling?: string[];
  /** Display name for this peer (shown in awareness) */
  displayName?: string;
  /** Whether to persist CRDT state to IndexedDB (default: true) */
  persist?: boolean;
}

export interface XDBSyncStatus {
  connected: boolean;
  peers: number;
  room: string;
  peerId: string;
}

// ── Adapter Class ─────────────────────────────────────────

export class XDBSyncAdapter {
  private ydoc: Y.Doc;
  private provider: WebrtcProvider | null = null;
  private persistence: IndexeddbPersistence | null = null;
  private xdb: XDBService;
  private options: XDBSyncOptions;
  private unsubscribeXDB: (() => void) | null = null;
  private isSyncing = false;
  private observedCollections = new Set<string>();
  private collectionObservers = new Map<string, (event: Y.YMapEvent<unknown>) => void>();
  private persistenceListener: (() => void) | null = null;
  private updateHandler: (() => void) | null = null;

  constructor(xdb: XDBService, options: XDBSyncOptions) {
    this.xdb = xdb;
    this.options = options;
    this.ydoc = new Y.Doc();

    // Optional: IndexedDB persistence for offline CRDT cache
    if (options.persist !== false) {
      this.persistence = new IndexeddbPersistence(
        `xdb-sync-${options.room}`,
        this.ydoc
      );
    }
  }

  /** Start syncing — connect to peers */
  connect(): void {
    // Guard against double-connect (y-webrtc throws if room already exists)
    if (this.provider) return;

    // 1. Create WebRTC provider
    const providerOptions: { signaling?: string[]; password?: string } = {
      password: this.options.password,
    };
    // Default to local signaling server; fall back to user-provided URLs
    providerOptions.signaling =
      Array.isArray(this.options.signaling) && this.options.signaling.length > 0
        ? this.options.signaling
        : ['ws://localhost:4444'];
    this.provider = new WebrtcProvider(this.options.room, this.ydoc, providerOptions);

    // 2. Set awareness (our display name)
    if (this.options.displayName) {
      this.provider.awareness.setLocalStateField('user', {
        name: this.options.displayName,
      });
    }

    // 3. Start observing Yjs changes FIRST (captures incoming data)
    this.setupYjsObservers();

    // 4. Wait for persistence to load before initial sync
    //    This prevents races where we push stale local data into
    //    a Y.Doc that hasn't loaded its IndexedDB state yet.
    if (this.persistence) {
      this.persistenceListener = () => {
        this.performInitialSync();
        this.setupXDBListener();
      };
      this.persistence.on('synced', this.persistenceListener);
    } else {
      this.performInitialSync();
      this.setupXDBListener();
    }
  }

  /** Stop syncing — disconnect from peers */
  disconnect(): void {
    try {
      if (this.unsubscribeXDB) {
        this.unsubscribeXDB();
        this.unsubscribeXDB = null;
      }
      // Remove the update handler for collection discovery
      if (this.updateHandler) {
        this.ydoc.off('update', this.updateHandler);
        this.updateHandler = null;
      }
      // Remove persistence listener to prevent duplicate handlers on reconnect
      if (this.persistenceListener && this.persistence) {
        this.persistence.off('synced', this.persistenceListener);
        this.persistenceListener = null;
      }
      if (this.provider) {
        this.provider.destroy();
        this.provider = null;
      }
    } finally {
      // Always clean up observers and tracked state, even if provider.destroy() throws
      for (const [collName, handler] of this.collectionObservers) {
        try {
          const ymap = this.ydoc.getMap(collName);
          ymap.unobserve(handler);
        } catch {
          // Ignore errors from already-destroyed ymaps
        }
      }
      this.collectionObservers.clear();
      this.observedCollections.clear();
      // Note: don't destroy persistence here — keep offline cache
    }
  }

  /** Get current sync status */
  getStatus(): XDBSyncStatus {
    const awareness = this.provider?.awareness;
    const awarenessSize = awareness ? awareness.getStates().size : 0;
    const connected = this.provider?.connected ?? false;
    const providerAny = this.provider as any;
    const webrtcPeers = providerAny?.room?.webrtcConns?.size ?? 0;
    return {
      connected,
      peers: Math.max(awarenessSize - 1, webrtcPeers),
      room: this.options.room,
      peerId: String(this.ydoc.clientID),
    };
  }

  /** Get awareness (online peers) */
  getAwareness(): Map<number, Record<string, unknown>> {
    if (!this.provider?.awareness) return new Map();
    return this.provider.awareness.getStates() as Map<number, Record<string, unknown>>;
  }

  /** Destroy and cleanup all resources */
  destroy(): void {
    this.disconnect();
    if (this.persistence) {
      this.persistence.destroy();
      this.persistence = null;
    }
    this.ydoc.destroy();
    this.observedCollections.clear();
  }

  // ── Internal: Initial Sync ──────────────────────────────

  /**
   * Push local XDB records into Y.Doc and pull remote records to XDB.
   *
   * Called AFTER y-indexeddb finishes loading (if persistence is enabled),
   * so the Y.Doc already has any previously persisted CRDT state.
   */
  private performInitialSync(): void {
    // Push all local collections into Y.Doc
    this.ydoc.transact(() => {
      const collections = this.xdb.getCollections();
      for (const collName of collections) {
        if (collName.startsWith('_')) continue;

        const ymap = this.ydoc.getMap(collName);
        const records = this.xdb.getAllRaw(collName);

        for (const record of records) {
          // Always push — Yjs handles dedup internally.
          // If the value is identical, no CRDT update is generated.
          ymap.set(record.id, recordToJSON(record));
        }

        // Start observing this collection if not already
        if (!this.observedCollections.has(collName)) {
          this.observeCollection(collName);
        }
      }
    });

    // Pull any records from Y.Doc that we don't have locally
    // (from persisted CRDT state or fast-connecting peers)
    for (const [key] of this.ydoc.share) {
      if (key.startsWith('_')) continue;

      const ymap = this.ydoc.getMap(key);
      if (ymap.size === 0) continue;

      this.isSyncing = true;
      try {
        // Build a set of local IDs once (avoids O(n*m) re-reads from storage)
        const localIds = new Set(this.xdb.getAllRaw(key).map(r => r.id));
        ymap.forEach((val, recordId) => {
          if (!localIds.has(recordId)) {
            const record = jsonToRecord(val as Record<string, unknown>);
            this.xdb.writeRecord(key, record);
          }
        });
      } finally {
        this.isSyncing = false;
      }

      // Start observing this collection if not already
      if (!this.observedCollections.has(key)) {
        this.observeCollection(key);
      }
    }
  }

  // ── Internal: XDB → Yjs (outbound) ─────────────────────

  private setupXDBListener(): void {
    this.unsubscribeXDB = this.xdb.subscribeAll((event: XDBEvent) => {
      // Skip events caused by incoming sync (prevent echo loop)
      if (this.isSyncing) return;

      // Skip internal collections
      if (event.collection.startsWith('_')) return;

      const ymap = this.ydoc.getMap(event.collection);

      // Ensure we're observing this collection
      if (!this.observedCollections.has(event.collection)) {
        this.observeCollection(event.collection);
      }

      this.ydoc.transact(() => {
        switch (event.type) {
          case 'create':
          case 'update':
            if (event.record) {
              ymap.set(event.record.id, recordToJSON(event.record));
            }
            break;

          case 'delete':
            if (event.record) {
              if (event.record.deleted) {
                // Soft delete: update the record in Y.Map with deleted flag
                ymap.set(event.record.id, recordToJSON(event.record));
              } else {
                // Hard delete: remove from Y.Map entirely
                ymap.delete(event.record.id);
              }
            }
            break;

          case 'refresh':
            // Refresh represents authoritative local state for this collection.
            // Replace the Y.Map contents to keep CRDT in sync with SQLite/local cache.
            if (event.records) {
              for (const k of Array.from(ymap.keys())) {
                ymap.delete(k);
              }
              for (const record of event.records) {
                ymap.set(record.id, recordToJSON(record));
              }
            }
            break;

          // 'sync' events are local-only, ignore
        }
      });
    });
  }

  // ── Internal: Yjs → XDB (inbound) ──────────────────────

  /**
   * Start observing a single collection Y.Map for remote changes.
   */
  private observeCollection(collName: string): void {
    if (this.observedCollections.has(collName)) return;
    this.observedCollections.add(collName);

    const ymap = this.ydoc.getMap(collName);

    const handler = (event: Y.YMapEvent<unknown>) => {
      // Skip if we're currently writing to XDB (prevent echo)
      if (this.isSyncing) return;

      // Skip our own local transactions (from XDB → Yjs path).
      // But allow loads from providers (y-indexeddb, y-webrtc) even
      // if they report transaction.local=true. We distinguish by
      // checking transaction.origin: our outbound writes use the
      // default origin (null), while providers set origin to themselves.
      if (event.transaction.local && event.transaction.origin === null) {
        return;
      }

      this.isSyncing = true;
      try {
        for (const [recordId, change] of event.changes.keys) {
          if (change.action === 'add' || change.action === 'update') {
            const val = ymap.get(recordId) as Record<string, unknown>;
            if (!val) continue;
            const record = jsonToRecord(val);

            if (record.deleted) {
              // Remote soft-delete
              this.xdb.writeRecord(collName, record);
            } else {
              this.xdb.writeRecord(collName, record);
            }
          } else if (change.action === 'delete') {
            // Remote hard-delete
            this.xdb.removeRecord(collName, recordId);
          }
        }
      } finally {
        this.isSyncing = false;
      }
    };

    ymap.observe(handler);
    this.collectionObservers.set(collName, handler);
  }

  /**
   * Set up dynamic collection discovery.
   *
   * When a remote peer creates a record in a collection we haven't seen,
   * a new Y.Map appears in ydoc.share. We detect this after every Y.Doc
   * update and start observing the new collection.
   */
  private setupYjsObservers(): void {
    // Observe existing collections from Y.Doc
    for (const [key] of this.ydoc.share) {
      if (key.startsWith('_')) continue;
      this.observeCollection(key);
    }

    // Discover new collections after each Y.Doc update.
    this.updateHandler = () => {
      for (const [key] of this.ydoc.share) {
        if (key.startsWith('_')) continue;
        if (!this.observedCollections.has(key)) {
          this.observeCollection(key);
        }
      }
    };
    this.ydoc.on('update', this.updateHandler);
  }
}

// ── Serialization ─────────────────────────────────────────

function recordToJSON(record: XDBRecord): Record<string, unknown> {
  return {
    id: record.id,
    collection: record.collection,
    data: record.data,
    created_at: record.created_at,
    updated_at: record.updated_at,
    deleted: record.deleted,
  };
}

function jsonToRecord(json: Record<string, unknown>): XDBRecord {
  return {
    id: json.id as string,
    collection: json.collection as string,
    data: (json.data as Record<string, unknown>) || {},
    created_at: (json.created_at as string) || '',
    updated_at: (json.updated_at as string) || '',
    deleted: (json.deleted as boolean) || false,
  };
}

// ── Sync Manager (multiple adapters) ──────────────────────
//
// Lives in xdb-sync.ts (NOT xdb.ts) to avoid circular dependency.
// xdb-sync.ts imports from xdb.ts, never the reverse.

import { getXDB } from './xdb';

const syncAdapters = new Map<string, XDBSyncAdapter>();
const SYNC_ROOM_KEY = 'xdb-sync-active-room';

/**
 * Start syncing the default XDB instance to a room.
 * If a sync for this room already exists, returns the existing adapter.
 * Persists the room to localStorage so sync can auto-resume after reload.
 */
export function startSync(options: XDBSyncOptions): XDBSyncAdapter {
  if (syncAdapters.has(options.room)) {
    console.warn(`[XDB Sync] Room "${options.room}" already has an active sync adapter. Returning existing adapter — new options are ignored.`);
    return syncAdapters.get(options.room)!;
  }
  const adapter = new XDBSyncAdapter(getXDB(), options);
  adapter.connect();
  syncAdapters.set(options.room, adapter);
  try {
    localStorage.setItem(SYNC_ROOM_KEY, options.room);
  } catch {
    // localStorage may be unavailable in restricted contexts
  }
  return adapter;
}

/**
 * Stop syncing — disconnects from peers but preserves IndexedDB cache.
 * If room is provided, stops that room only. If no room, stops all.
 * The adapter is removed from the map so next startSync() creates a fresh one.
 */
export function stopSync(room?: string): void {
  if (room) {
    const adapter = syncAdapters.get(room);
    if (adapter) {
      adapter.disconnect();
      syncAdapters.delete(room);
    }
    try {
      const saved = localStorage.getItem(SYNC_ROOM_KEY);
      if (saved === room) localStorage.removeItem(SYNC_ROOM_KEY);
    } catch {
      // localStorage may be unavailable in restricted contexts
    }
  } else {
    for (const adapter of syncAdapters.values()) {
      adapter.disconnect();
    }
    syncAdapters.clear();
    try {
      localStorage.removeItem(SYNC_ROOM_KEY);
    } catch {
      // localStorage may be unavailable in restricted contexts
    }
  }
}

/**
 * Destroy sync completely — disconnects AND removes IndexedDB persistence.
 * Use this for full cleanup when you want to wipe CRDT state.
 */
export function destroySync(room?: string): void {
  if (room) {
    const adapter = syncAdapters.get(room);
    if (adapter) {
      adapter.destroy();
      syncAdapters.delete(room);
    }
  } else {
    for (const adapter of syncAdapters.values()) {
      adapter.destroy();
    }
    syncAdapters.clear();
  }
}

/**
 * Get a sync adapter by room name (or first active adapter if no room).
 */
export function getSyncAdapter(room?: string): XDBSyncAdapter | null {
  if (room) {
    return syncAdapters.get(room) || null;
  }
  // Return first active adapter
  const first = syncAdapters.values().next();
  return first.done ? null : first.value;
}

/**
 * Get status of all active sync rooms.
 */
export function getAllSyncStatus(): XDBSyncStatus[] {
  return Array.from(syncAdapters.values()).map(a => a.getStatus());
}

/**
 * Get the saved sync room from localStorage (for auto-resume after reload).
 */
export function getSavedSyncRoom(): string | null {
  try { return localStorage.getItem(SYNC_ROOM_KEY); } catch { return null; }
}
