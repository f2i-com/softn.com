/**
 * XDB Sync — Real-time P2P Data Sharing via Yjs + WebRTC
 *
 * Provides peer-to-peer data synchronization for XDB so that SoftN apps
 * running on different devices can share data in real time over the network.
 *
 * The sync layer is opt-in per app instance — you join a "room" to start sharing.
 * The existing XDB API (db.create, db.query, db.update, db.delete) remains unchanged.
 *
 * Two identities are kept apart throughout:
 *
 * - The **room** is a label peers agree on. It is what the network sees.
 * - The **app** is who is replicating. Two bundles in one document that both
 *   pick the room "lobby" are two rooms, not one: they must not be handed each
 *   other's adapter, share an offline cache, or be torn down together. Every
 *   registry lookup below is by app *and* room, and the persisted CRDT cache
 *   is named by both.
 *
 * Three ways to stop, kept apart too, because a comment used to say "don't
 * destroy persistence — keep offline cache" as though closing the IndexedDB
 * connection and deleting the data were one act. They are not: y-indexeddb's
 * `destroy()` closes the connection and `clearData()` deletes the store.
 *
 * - `disconnect()`: leave the room; keep the document and its cache open so a
 *   `connect()` resumes. For an adapter the caller intends to keep.
 * - `close()`: leave, close the cache connection, free the document. Nothing
 *   stored is lost; the next `startSync` for the same app and room reloads
 *   it. This is what `stopSync` does.
 * - `destroy()`: close, and delete the stored cache. This is what
 *   `destroySync` does.
 */

import * as Y from 'yjs';
import { WebrtcProvider } from 'y-webrtc';
import { IndexeddbPersistence } from 'y-indexeddb';
import { XDBService, getDefaultSignaling, _setSyncModuleRef, type XDBEvent } from './xdb';
import type { XDBRecord } from '../types';
import { deepEqual } from './vm-state';

// ── Types ─────────────────────────────────────────────────

export interface XDBSyncOptions {
  /** Room name — all peers in the same room share data */
  room: string;
  /** Optional password for encrypted signaling */
  password?: string;
  /** Hex-encoded encryption key for P2P sync (used as password for y-webrtc).
   *  When set, all signaling messages are encrypted with AES-256-GCM. */
  encryptionKey?: string;
  /** Signaling server URLs (defaults to public Yjs signaling) */
  signaling?: string[];
  /** Display name for this peer (shown in awareness) */
  displayName?: string;
  /** When true, derives encryption key from the room name so all peers in the
   *  same room share the same key. Use for multiplayer/shared rooms. */
  sharedRoom?: boolean;
  /** Whether to persist CRDT state to IndexedDB (default: true) */
  persist?: boolean;
  /** App ID — when set, syncs the per-app XDB instance instead of the default */
  appId?: string;
}

export interface XDBSyncStatus {
  connected: boolean;
  peers: number;
  room: string;
  peerId: string;
}

/**
 * Where the offline CRDT cache for an app's room lives.
 *
 * Named by app and room. The default instance keeps the name it always had,
 * so a document that only ever ran one app finds its cache where it left it;
 * an app-scoped adapter never reads a cache it cannot prove is its own — a
 * legacy `xdb-sync-<room>` store may belong to any app that used that label.
 */
export function persistenceNameFor(appId: string | undefined, room: string): string {
  return appId ? `xdb-sync:${appId}:${room}` : `xdb-sync-${room}`;
}

/**
 * Last-writer-wins by `updated_at`. XDB stamps every write with an ISO time,
 * and ISO times order as strings. A record with no stamp loses to one with.
 */
function isNewer(candidate: { updated_at?: string }, incumbent: { updated_at?: string }): boolean {
  const a = candidate.updated_at ?? '';
  const b = incumbent.updated_at ?? '';
  return a > b;
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
  private closed = false;

  constructor(xdb: XDBService, options: XDBSyncOptions) {
    this.xdb = xdb;
    this.options = options;
    this.ydoc = new Y.Doc();

    // Optional: IndexedDB persistence for offline CRDT cache
    if (options.persist !== false) {
      this.persistence = new IndexeddbPersistence(
        persistenceNameFor(options.appId, options.room),
        this.ydoc
      );
    }
  }

  /** The document, for a host that wants to exchange updates itself (tests, relays). */
  get doc(): Y.Doc {
    return this.ydoc;
  }

  /** Start syncing — connect to peers */
  connect(): void {
    if (this.closed) throw new Error('[XDB Sync] This adapter has been closed');
    // Guard against double-connect (y-webrtc throws if room already exists)
    if (this.provider) return;

    // 1. Create WebRTC provider
    // Use encryptionKey (per-dapp derived key) if available, else fallback to password
    const effectivePassword = this.options.encryptionKey || this.options.password;
    const providerOptions: { signaling?: string[]; password?: string } = {
      password: effectivePassword,
    };
    // Use explicit signaling URLs, then app-level defaults, then empty
    // (never fall back to y-webrtc's public signaling servers).
    const appDefaults = getDefaultSignaling();
    if (Array.isArray(this.options.signaling) && this.options.signaling.length > 0) {
      providerOptions.signaling = this.options.signaling;
    } else if (appDefaults && appDefaults.length > 0) {
      providerOptions.signaling = appDefaults;
    } else {
      // Empty array prevents y-webrtc from using its built-in public servers
      providerOptions.signaling = [];
    }
    console.log('[XDB Sync] Connecting to room:', this.options.room,
      '| password:', effectivePassword ? '(encrypted)' : '(none)',
      '| signaling:', providerOptions.signaling);
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

  /**
   * Bring the document and the local database into agreement without a
   * provider — what a host does when it exchanges updates itself. The
   * persistence load is not waited for here; a caller that persists should
   * `connect()` instead.
   */
  attachLocal(): void {
    if (this.closed) throw new Error('[XDB Sync] This adapter has been closed');
    this.setupYjsObservers();
    this.performInitialSync();
    this.setupXDBListener();
  }

  /** Stop syncing — disconnect from peers. The document and its cache stay open. */
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
    }
  }

  /**
   * Release everything this adapter holds, keeping what it stored.
   *
   * The persistence provider's `destroy()` closes its IndexedDB connection and
   * detaches from the document; the data in the store is untouched and is
   * reloaded by the next adapter for this app and room. Safe to call twice.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.disconnect();
    } finally {
      if (this.persistence) {
        try {
          this.persistence.destroy();
        } catch (err) {
          console.warn('[XDB Sync] Persistence did not close cleanly:', err);
        }
        this.persistence = null;
      }
      this.ydoc.destroy();
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

  /**
   * Forget: close, and delete the stored CRDT cache for this app and room.
   *
   * The deletion is asynchronous inside y-indexeddb; the returned promise
   * settles when it is done, and a caller that does not care may ignore it.
   * The local XDB records are not touched — they are the app's data, and the
   * cache is only a copy of what the room agreed on.
   */
  destroy(): Promise<void> {
    const persistence = this.persistence;
    let cleared: Promise<void> = Promise.resolve();
    if (persistence && typeof (persistence as { clearData?: unknown }).clearData === 'function') {
      cleared = Promise.resolve(persistence.clearData()).catch((err: unknown) => {
        console.warn('[XDB Sync] Could not clear persisted sync data:', err);
      });
    }
    this.close();
    return cleared;
  }

  // ── Internal: Initial Sync ──────────────────────────────

  /**
   * Reconcile the local XDB with the document, in both directions.
   *
   * Called AFTER y-indexeddb finishes loading (if persistence is enabled),
   * so the Y.Doc already has any previously persisted CRDT state.
   *
   * This used to push every local record into the document unconditionally,
   * on the theory that Yjs would notice an identical value. It does not: a
   * `Y.Map.set` is always a new write, so the push generated a full
   * collection's worth of CRDT updates for peers to apply, and — worse — a
   * local copy that had been offline for a week overwrote whatever the room
   * had agreed on since. Now a record goes in only if the document does not
   * have it or has an older one, and comes out only if the document's copy is
   * newer. Equal stamps with equal contents are left alone.
   */
  private performInitialSync(): void {
    const collections = this.xdb.getCollections();

    // Push: local records the document lacks, or has an older copy of.
    this.ydoc.transact(() => {
      for (const collName of collections) {
        if (collName.startsWith('_')) continue;

        const ymap = this.ydoc.getMap(collName);
        const records = this.xdb.getAllRaw(collName);

        for (const record of records) {
          const existing = ymap.get(record.id) as Record<string, unknown> | undefined;
          if (existing === undefined || isNewer(record, existing as { updated_at?: string })) {
            const json = recordToJSON(record);
            if (existing === undefined || !deepEqual(existing, json)) ymap.set(record.id, json);
          }
        }

        // Observe, but do not project here: the pull below is about to read
        // every map, and this one is inside a transaction of our own.
        if (!this.observedCollections.has(collName)) {
          this.observeCollection(collName, false);
        }
      }
    });

    // Pull: records the document has that we lack, or has a newer copy of
    // (from persisted CRDT state or fast-connecting peers).
    for (const [key] of this.ydoc.share) {
      if (key.startsWith('_')) continue;

      const ymap = this.ydoc.getMap(key);
      if (ymap.size === 0) continue;

      this.projectCollection(key, ymap);

      // Start observing this collection if not already
      if (!this.observedCollections.has(key)) {
        this.observeCollection(key, false);
      }
    }
  }

  /**
   * Write into XDB whatever the document holds for a collection that the
   * local database lacks or holds an older copy of. Runs with the echo guard
   * up, so the writes do not come straight back as outbound changes.
   */
  private projectCollection(collName: string, ymap: Y.Map<unknown>): void {
    if (ymap.size === 0) return;
    this.isSyncing = true;
    try {
      // Build a map of local records once (avoids O(n*m) re-reads from storage)
      const local = new Map(this.xdb.getAllRaw(collName).map((r) => [r.id, r]));
      ymap.forEach((val, recordId) => {
        const record = jsonToRecord(val as Record<string, unknown>);
        const mine = local.get(recordId);
        if (!mine || isNewer(record, mine)) {
          this.xdb.writeRecord(collName, record);
        }
      });
    } finally {
      this.isSyncing = false;
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
        this.observeCollection(event.collection, false);
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
            //
            // It used to be applied by emptying the map and refilling it, so
            // one changed record in a batched notification became a delete
            // and a re-insert of every record in the collection — that many
            // CRDT updates to send, and that many for each peer to apply.
            // Now only what differs is written: changed or new records are
            // set, records the refresh no longer lists are deleted, and the
            // rest are not touched.
            if (event.records) {
              const listed = new Set<string>();
              for (const record of event.records) {
                listed.add(record.id);
                const json = recordToJSON(record);
                const existing = ymap.get(record.id);
                if (existing === undefined || !deepEqual(existing, json)) {
                  ymap.set(record.id, json);
                }
              }
              for (const k of Array.from(ymap.keys())) {
                if (!listed.has(k)) ymap.delete(k);
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
   *
   * `project` says whether to write the map's current contents into XDB
   * first. A map discovered from the document's `update` event was filled by
   * the very transaction that announced it, and an observer attached after
   * that transaction will never be told about it — so the first record of a
   * new collection arriving from a peer was missed unless another followed.
   * Discovery projects; the bootstrap does its own pull and passes false.
   */
  private observeCollection(collName: string, project: boolean): void {
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
            this.xdb.writeRecord(collName, jsonToRecord(val));
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

    if (project) this.projectCollection(collName, ymap);
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
      this.observeCollection(key, false);
    }

    // Discover new collections after each Y.Doc update.
    this.updateHandler = () => {
      for (const [key] of this.ydoc.share) {
        if (key.startsWith('_')) continue;
        if (!this.observedCollections.has(key)) {
          this.observeCollection(key, true);
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
    data: (json.data as Record<string, unknown>) ?? {},
    created_at: (json.created_at as string) ?? '',
    updated_at: (json.updated_at as string) ?? '',
    deleted: (json.deleted as boolean) ?? false,
  };
}

// ── Sync Manager (multiple adapters) ──────────────────────
//
// Lives in xdb-sync.ts (NOT xdb.ts) to avoid circular dependency.
// xdb-sync.ts imports from xdb.ts, never the reverse.

import { getXDB } from './xdb';

/** Adapters, keyed by app scope and room together. */
const syncAdapters = new Map<string, XDBSyncAdapter>();
const SYNC_ROOM_KEY_PREFIX = 'xdb-sync-active-room';

/**
 * The registry key for an app's room: a JSON tuple, so no app identifier or
 * room label can be spelled to collide with another pair.
 */
function registryKey(appId: string | undefined, room: string): string {
  return JSON.stringify([appId ?? null, room]);
}

function inScope(key: string, appId: string | undefined): boolean {
  const [owner] = JSON.parse(key) as [string | null, string];
  return owner === (appId ?? null);
}

/** Get the localStorage key for persisting the active sync room, namespaced by appId. */
function getSyncRoomKey(appId?: string): string {
  return appId ? `${SYNC_ROOM_KEY_PREFIX}:${appId}` : SYNC_ROOM_KEY_PREFIX;
}

/**
 * Start syncing an XDB instance to a room.
 * When `options.appId` is set, syncs the per-app XDB instance (not the default).
 * If this app already syncs this room, returns the existing adapter.
 * Persists the room to localStorage so sync can auto-resume after reload.
 */
export function startSync(options: XDBSyncOptions): XDBSyncAdapter {
  // Register this module so getSyncStatuses() works without dynamic import
  _setSyncModuleRef({ getAllSyncStatus });
  const key = registryKey(options.appId, options.room);
  const existing = syncAdapters.get(key);
  if (existing) {
    console.warn(`[XDB Sync] Room "${options.room}" already has an active sync adapter. Returning existing adapter — new options are ignored.`);
    return existing;
  }
  const adapter = new XDBSyncAdapter(getXDB(options.appId), options);
  adapter.connect();
  syncAdapters.set(key, adapter);
  try {
    localStorage.setItem(getSyncRoomKey(options.appId), options.room);
  } catch {
    // localStorage may be unavailable in restricted contexts
  }
  return adapter;
}

/**
 * Stop syncing — leaves the room and releases the adapter; the offline cache
 * in IndexedDB is kept.
 *
 * With a room, stops that room for this app. Without one, stops every room
 * this app is in — and only this app's: a document that mounts several apps
 * at once must not have one app's `stopSync()` cut the others off. A host
 * that wants everything gone calls {@link stopAllSync}.
 */
export function stopSync(room?: string, appId?: string): void {
  if (room) {
    const key = registryKey(appId, room);
    const adapter = syncAdapters.get(key);
    if (adapter) {
      syncAdapters.delete(key);
      adapter.close();
    }
    try {
      const storageKey = getSyncRoomKey(appId);
      const saved = localStorage.getItem(storageKey);
      if (saved === room) localStorage.removeItem(storageKey);
    } catch {
      // localStorage may be unavailable in restricted contexts
    }
  } else {
    for (const [key, adapter] of Array.from(syncAdapters.entries())) {
      if (!inScope(key, appId)) continue;
      syncAdapters.delete(key);
      adapter.close();
    }
    try {
      localStorage.removeItem(getSyncRoomKey(appId));
    } catch {
      // localStorage may be unavailable in restricted contexts
    }
  }
}

/**
 * Stop every adapter in every app scope. For a host tearing the page down —
 * not for an app, which may only stop its own.
 */
export function stopAllSync(): void {
  for (const [key, adapter] of Array.from(syncAdapters.entries())) {
    syncAdapters.delete(key);
    adapter.close();
  }
}

/**
 * Destroy sync completely — disconnects AND deletes the IndexedDB cache.
 * Use this for full cleanup when you want to wipe CRDT state. Scoped to one
 * app exactly as `stopSync` is.
 */
export function destroySync(room?: string, appId?: string): Promise<void> {
  const pending: Promise<void>[] = [];
  if (room) {
    const key = registryKey(appId, room);
    const adapter = syncAdapters.get(key);
    if (adapter) {
      syncAdapters.delete(key);
      pending.push(adapter.destroy());
    }
  } else {
    for (const [key, adapter] of Array.from(syncAdapters.entries())) {
      if (!inScope(key, appId)) continue;
      syncAdapters.delete(key);
      pending.push(adapter.destroy());
    }
  }
  return Promise.all(pending).then(() => undefined);
}

/**
 * Get an app's sync adapter by room name, or its first active adapter when
 * no room is given. Never another app's.
 */
export function getSyncAdapter(room?: string, appId?: string): XDBSyncAdapter | null {
  if (room) {
    return syncAdapters.get(registryKey(appId, room)) || null;
  }
  for (const [key, adapter] of syncAdapters) {
    if (inScope(key, appId)) return adapter;
  }
  return null;
}

/**
 * Get status of all active sync rooms — every app's, or one app's.
 */
export function getAllSyncStatus(appId?: string): XDBSyncStatus[] {
  const out: XDBSyncStatus[] = [];
  for (const [key, adapter] of syncAdapters) {
    if (appId !== undefined && !inScope(key, appId)) continue;
    out.push(adapter.getStatus());
  }
  return out;
}

/**
 * Get the saved sync room from localStorage (for auto-resume after reload).
 */
export function getSavedSyncRoom(appId?: string): string | null {
  try { return localStorage.getItem(getSyncRoomKey(appId)); } catch { return null; }
}
