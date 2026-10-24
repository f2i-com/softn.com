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
import { megabytes, PEER_RECORD_HEADROOM, RECORD_STORAGE_BUDGET, StorageBudget } from './storage-budget';
import { deepEqual } from './vm-state';
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
  AcknowledgedStoragePersistence,
  StorageWriteReceipt,
} from './xdb-types';
import { debug } from './debug';

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

/** The key suffix under which a damaged collection's bytes are kept (`recordCorruption`). */
const QUARANTINE_COPY = /\.corrupt\.[0-9a-z]+$/;

const OFFLINE_NETWORK_STATUS: XDBNetworkStatus = { peer_id: '', connected_peers: [], is_running: false, mode: 'local-only', enabled: false, discovery: false, listening: false, sync_paused: false };

/**
 * Whether a name can be a collection's. A colon is what separates an app's
 * prefix from its collections in a key: the default store's "A:notes" was
 * app A's "notes", and a record created there was written into app A's
 * records, while every lookup by id here passed it over. An import refused
 * such names already; a create took them.
 */
function isCollectionName(collection: unknown): collection is string {
  return typeof collection === 'string' && collection.length > 0 && !collection.includes(':');
}

function assertCollectionName(collection: string): void {
  if (!isCollectionName(collection)) {
    throw new TypeError(`"${String(collection)}" is not a valid collection name: a name is not empty and has no ":".`);
  }
}

/**
 * Record data as it is stored and read back: what JSON makes of it. A record
 * is returned and announced as `get` will read it, not as the caller's own
 * object; a `Date` went to peers as `{}`, because the announcement carried
 * the object itself into the shared document. A value JSON cannot hold (a
 * cycle, a BigInt, nesting deeper than it goes) is refused as what it is,
 * before anything is written; it used to be reported as a full disk.
 */
function storedData<T>(data: T): T {
  const text = storableText(data);
  return text === undefined ? data : (JSON.parse(text) as T);
}

/**
 * `data` as JSON, or the refusal. An update's patch is checked with this
 * before anything is sent, and normalised only once merged: a field the
 * patch sets to undefined is a field removed, as JSON drops it.
 */
function storableText(data: unknown): string | undefined {
  let reserved = false;
  let text: string | undefined;
  try {
    text = JSON.stringify(data, (key, value: unknown) => {
      if (key === TAURI_IPC_KEY) reserved = true;
      return value;
    });
  } catch (err) {
    throw new XDBStorageError('invalid-data', `This record cannot be saved: its data is not something JSON can hold (${err instanceof Error ? err.message : String(err)}).`);
  }
  if (reserved) {
    throw new XDBStorageError('invalid-data', `This record cannot be saved: a field named ${TAURI_IPC_KEY} is one the desktop app's IPC takes for its own, and a record holding it could not be stored there or carried to it.`);
  }
  return text;
}

/** A change made while no server sync client listened, as the note keeps it (`XDBService.noteUnheard`). */
export interface UnheardEdit {
  collection: string;
  id: string;
  /** The stamp it gave the record: the client sends it only while the record still has it. */
  stamp: string;
  kind: 'create' | 'update' | 'delete';
  /** Stamped in this device's time (sent with the offset), or as the stamp is (a heard copy's). */
  own: boolean;
  /** When it was made by this clock, where that is not its stamp (an import keeps the backup's). */
  made?: number;
  /**
   * The stamp of the copy it was made after, when that was ahead of this clock (`after` on the
   * mutation event): it is sent no earlier than just after it, and otherwise at when it was made
   * with the offset, as a listening client sends it.
   */
  after?: string;
}

/** A record removed for good while no client listened, with when, and the copy it removed when ahead of this clock. */
export interface UnheardRemoval {
  collection: string;
  id: string;
  at: number;
  after?: string;
}

/**
 * A collection an import changed while no client listened, whose records the note could not
 * name one by one (the store refused it so long): the client sends every record of it, made
 * then. A create the host has had already is answered with its copy, which is kept.
 */
export interface UnheardImport {
  collection: string;
  made: number;
}

interface UnheardNote {
  edits: Map<string, UnheardEdit>;
  removals: Map<string, UnheardRemoval>;
  imports: Map<string, UnheardImport>;
}

/** What a server sync client reads of the note (`XDBService.readUnheardNote`). */
export interface UnheardNoteRead {
  edits: UnheardEdit[];
  removals: UnheardRemoval[];
  imports: UnheardImport[];
}

/**
 * One more change into the note, as the host should hear of the record's changes together.
 * An edit of a record created here and not yet sent is still its create (an update the host
 * refuses, having no record); a record created and then deleted or removed here never reached
 * the host, and nothing is kept of it. An edit and a removal of one record stand for each other.
 */
function mergeUnheard(note: UnheardNote, change: { edit: UnheardEdit } | { removal: UnheardRemoval }): void {
  if ('edit' in change) {
    const { edit } = change;
    const key = `${edit.collection}\u0000${edit.id}`;
    const before = note.edits.get(key);
    note.removals.delete(key);
    note.edits.delete(key);
    if (before?.kind === 'create' && edit.kind === 'delete') return;
    note.edits.set(key, before?.kind === 'create' && edit.kind === 'update' ? { ...edit, kind: 'create' } : edit);
    return;
  }
  const { removal } = change;
  const key = `${removal.collection}\u0000${removal.id}`;
  const before = note.edits.get(key);
  note.edits.delete(key);
  note.removals.delete(key);
  if (before?.kind === 'create') return;
  note.removals.set(key, removal);
}

/**
 * A key Tauri's IPC reads as its own on any object it is handed: it calls the
 * value as a function, so a record with such a field (a key a person typed)
 * failed on the desktop before reaching the native store, after the cache
 * and sync had taken it.
 */
const TAURI_IPC_KEY = '__TAURI_TO_IPC_KEY__';

/**
 * How far ahead of this clock a record's stamp may be: what peer sync takes
 * from a room (xdb-sync.ts), and what an edit follows (editStamp). One limit
 * for both, because the newer stamp wins: an edit that could not follow a
 * stamp a peer accepts lost to it, and a script's edit of a record stamped
 * between an hour (the limit edits had) and a day ahead was put back on the
 * device that made it. A room has no clock of authority, as a sync host has,
 * so this is wide enough for any honest clock (one an hour out after a time
 * zone change) and still refuses a stamp of 9999, which won over every edit.
 */
export const STAMP_AHEAD_LIMIT_MS = 24 * 60 * 60 * 1000;

/**
 * A stamp as a time to order by: milliseconds, or -Infinity for none or one
 * that is no time. As text, stamps order only while they are written alike:
 * the native store and the sync host write `+00:00` and nanoseconds, and a
 * peer can write any offset, which as text sorted up to two days ahead.
 */
export function stampTime(stamp: string | undefined): number {
  const at = stamp ? Date.parse(stamp) : NaN;
  return Number.isFinite(at) ? at : -Infinity;
}

/**
 * Whether two stamps name one time. The desktop's native store writes the stamp the page gave
 * an edit as `+00:00`, and its answer takes the page's place: compared as text, the stamp a
 * page gave a record was never the record's own again.
 */
export function sameStamp(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a === b) return true;
  const at = stampTime(a);
  return at !== -Infinity && at === stampTime(b);
}

/**
 * The stamp of an edit made here to a record stamped `previous`: later than
 * it. The newer stamp wins wherever records meet (peer sync, the sync host),
 * and an edit was stamped with this clock alone, so on a device whose clock
 * ran behind the one that last wrote the record, the person's own edit was
 * older than what it edited and lost to it on every peer. A stamp up to
 * STAMP_AHEAD_LIMIT_MS ahead is followed by a millisecond; one further ahead
 * is one no peer takes, and the edit takes this clock's time.
 */
export function editStamp(previous: string | undefined, now = Date.now()): string {
  const at = stampTime(previous);
  if (at >= now && at - now <= STAMP_AHEAD_LIMIT_MS) return new Date(at + 1).toISOString();
  return new Date(now).toISOString();
}

/**
 * Where else a record is kept that an edit made here must be stamped after:
 * a sync room's copy of it (xdb-sync.ts), which this device may not hold.
 * Answers that copy's stamp, or nothing.
 */
export type StampSource = (collection: string, id: string) => string | undefined;

/**
 * Why the native store's import would refuse `record` for `collection`, or
 * null: its `Record` takes every field, of these types, and import_records
 * refuses an id of spaces and a record that names another collection.
 */
function nativeImportRefusal(record: XDBRecord, collection: string): string | null {
  const row = record as unknown as Record<string, unknown>;
  if (typeof row.id !== 'string' || isBlankToRust(row.id)) return 'has no id';
  if (row.collection !== collection) return `names ${JSON.stringify(row.collection)} as its collection`;
  // `data: undefined` is a field JSON leaves out, and the Record then has none.
  if (typeof row.created_at !== 'string' || typeof row.updated_at !== 'string' || typeof row.deleted !== 'boolean' || row.data === undefined) {
    return 'is not a whole record (id, collection, data, created_at, updated_at, deleted)';
  }
  if (!readableByNative(row, 0)) return 'holds text the native store cannot read (half of a surrogate pair) or is nested past 100 levels';
  return null;
}

/** Empty or white space to Rust's `trim()`, which also takes U+0085 that JS's does not. */
function isBlankToRust(text: string): boolean {
  return /^[\s\u0085]*$/.test(text);
}

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?:^|[^\ud800-\udbff])[\udc00-\udfff]/;

/**
 * Whether serde_json will read a value as the IPC hands it on: no string
 * (or key) holding half of a surrogate pair, which a web backup can carry
 * when an app cut text in an emoji, and not nested past its recursion
 * limit, 128 levels counting the request around it.
 */
function readableByNative(value: unknown, depth: number): boolean {
  if (typeof value === 'string') return !LONE_SURROGATE.test(value);
  // JSON has no BigInt: the request would not be written at all.
  if (typeof value === 'bigint') return false;
  if (typeof value !== 'object' || value === null) return true;
  if (depth > 100 || TAURI_IPC_KEY in value) return false;
  if (Array.isArray(value)) return value.every((item) => readableByNative(item, depth + 1));
  return Object.entries(value).every(([key, item]) => !LONE_SURROGATE.test(key) && readableByNative(item, depth + 1));
}

/** A record's data when it is an object, else nothing: an imported row's `data` may be anything. */
function objectData(record: XDBRecord): Record<string, unknown> {
  const data = record.data as unknown;
  return typeof data === 'object' && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
}

/**
 * A field of a record's data as a filter or a sort reads it: its own, never
 * one every object inherits. Sorting on "constructor" read each record's
 * Object constructor, and a filter on it matched records that had no such
 * field.
 */
function fieldOf(record: XDBRecord, field: string): unknown {
  const data = objectData(record);
  return Object.prototype.hasOwnProperty.call(data, field) ? data[field] : undefined;
}

function matchesFilter(record: XDBRecord, filter: Record<string, unknown>): boolean {
  const data = objectData(record);
  return Object.entries(filter).every(([key, value]) => Object.prototype.hasOwnProperty.call(data, key) && data[key] === value);
}

/** Records with the field missing (or null) last, in either order. */
function byField(field: string, order: 'asc' | 'desc'): (a: XDBRecord, b: XDBRecord) => number {
  return (a, b) => {
    const aVal = fieldOf(a, field);
    const bVal = fieldOf(b, field);
    if (aVal === bVal) return 0;
    if (aVal === undefined || aVal === null) return 1;
    if (bVal === undefined || bVal === null) return -1;
    const comparison = (aVal as number) < (bVal as number) ? -1 : 1;
    return order === 'desc' ? -comparison : comparison;
  };
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
  /** What the app's records may take of the browser's store, when that is where they are. */
  private budget: StorageBudget | null = null;
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
  /** The sync rooms' copies an edit is stamped after (StampSource). */
  private stampSources = new Set<StampSource>();

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
  private pendingStorage = new Set<Promise<void>>();
  private storagePersistence?: AcknowledgedStoragePersistence;
  private storageUnsubscribe: (() => void) | null = null;
  private storageCancellations = new Set<() => void>();
  private unknownStorageReceipts = new Map<StorageWriteReceipt, string[]>();
  private resolveStorageOwnerReleased!: () => void;
  private storageOwnerReleased = new Promise<void>(resolve => { this.resolveStorageOwnerReleased = resolve; });
  private destroyed = false;
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
    // The app's share of the browser's store, which the host and every other
    // app use too (storage-budget.ts).
    try {
      if (typeof localStorage !== 'undefined' && this.storage === localStorage) {
        this.budget = new StorageBudget(localStorage, `${prefix}:`, RECORD_STORAGE_BUDGET);
      }
    } catch {
      // No browser store here to share.
    }
    this.listeners = new Map();
    this.globalListeners = new Set();
    this.useTauri = options.backend !== 'storage' && isTauri();
    if (!this.useTauri) {
      this.storagePersistence = this.storage.acknowledgedPersistence;
      this.storageUnsubscribe = this.storagePersistence?.subscribe(() => this.hostedStorageChanged()) ?? null;
      this.hostedStorageChanged();
    }

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
      debug(`[XDB] Peer ${event.type}: ${event.peer_id}`);
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
    // A collection that failed to load and is no longer there (a peer's
    // reset cleared it) has nothing left to load: kept as failed, the store
    // stayed unloaded through every retry, and every import was refused.
    const listed = new Set(collections);
    for (const failed of [...this.hydrationFailed]) if (!listed.has(failed)) this.hydrationFailed.delete(failed);
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
          if (!existing || stampTime(existing.updated_at) <= stampTime(r.updated_at)) {
            coll.set(r.id, r);
          }
        }
        this.knownCollections.add(collection);
        this.hydrationFailed.delete(collection);
        this.emit({ type: 'refresh', collection, records: this.getCollectionData(collection), reload: true });
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

  /** Native or hosted writes from this service that have not settled yet. */
  hasPendingWrites(): boolean {
    return this.pendingNative.size > 0 || this.pendingStorage.size > 0 || !this.destroyed && (this.storagePersistence?.getStatus().pendingWrites ?? 0) > 0;
  }

  /** Hosted settlement captures a finite set; native draining keeps its existing semantics. Neither asserts success. */
  async whenIdle(): Promise<void> {
    const hostedIdle = this.storagePersistence && !this.destroyed
      ? Promise.race([this.storagePersistence.whenIdle(), this.storageOwnerReleased]) : null;
    const hostedWrites = [...this.pendingStorage];
    const nativeIdle = async () => {
      while (this.pendingNative.size > 0) await Promise.allSettled([...this.pendingNative]);
    };
    await Promise.allSettled([nativeIdle(), ...hostedWrites, ...(hostedIdle ? [hostedIdle] : [])]);
  }

  /** Track exactly this write, independently of later writes or event-listener reentrancy. */
  private hostedWrite(receipt: StorageWriteReceipt, collections: string[]): Promise<void> {
    let cancel!: () => void;
    const completion = new Promise<void>((resolve, reject) => {
      cancel = () => reject(new XDBStorageError('write-unknown', 'The storage owner was released before this write was acknowledged. Reopen the app to read the parent snapshot.'));
      receipt.completion.then(resolve, reject);
    });
    this.pendingStorage.add(completion);
    this.storageCancellations.add(cancel);
    this.notifyStatus();
    const settle = (failed: boolean, error?: unknown) => {
      this.pendingStorage.delete(completion);
      this.storageCancellations.delete(cancel);
      if (this.destroyed) return;
      if (failed) {
        const unknown = receipt.state === 'unknown' || !!error && typeof error === 'object' && 'state' in error && error.state === 'unknown';
        if (unknown) this.unknownStorageReceipts.set(receipt, collections);
        for (const collection of collections) {
          this.noteIssue({ kind: unknown ? 'write-unknown' : 'write-failed', collection, message: unknown
            ? `Saving "${collection}" has an unknown outcome. Reopen the app to read the parent snapshot before retrying.`
            : `A change to "${collection}" was not acknowledged by the parent storage. Export unsaved work before closing the app.` });
        }
      }
      this.hostedStorageChanged();
    };
    // Attach rejection handling even for the synchronous API's intentionally ignored result.
    completion.then(() => settle(false), error => settle(true, error));
    return completion;
  }

  private hostedStorageChanged(): void {
    if (this.destroyed || !this.storagePersistence) return;
    for (const [receipt, collections] of this.unknownStorageReceipts) {
      if (receipt.state === 'unknown') continue;
      this.unknownStorageReceipts.delete(receipt);
      for (const collection of collections) {
        if (![...this.unknownStorageReceipts.values()].some(names => names.includes(collection))) {
          this.issues = this.issues.filter(issue => !(issue.kind === 'write-unknown' && issue.collection === collection));
        }
        if (receipt.state === 'failed') this.noteIssue({ kind: 'write-failed', collection, message: `The parent later refused a change to "${collection}". Export unsaved work before closing the app.` });
      }
    }
    const status = this.storagePersistence.getStatus();
    const summary: Array<{ kind: XDBStorageIssue['kind']; present: boolean; message: string }> = [
      { kind: 'persistence-unsupported', present: status.protocol === 0, message: 'This hosted parent does not support acknowledged saving. Cached changes cannot be reported as saved.' },
      { kind: 'write-failed', present: status.failedWrites > 0 || status.disposed, message: 'Some hosted changes were not saved, or the storage connection was closed. Export unsaved work before closing the app.' },
      { kind: 'write-unknown', present: status.unknownWrites > 0, message: 'A hosted save has an unknown outcome. Reopen the app to read the parent snapshot before retrying.' },
    ];
    for (const entry of summary) {
      const existing = this.issues.some(issue => issue.kind === entry.kind && issue.collection === undefined);
      if (entry.present && !existing) this.issues.push({ kind: entry.kind, message: entry.message, at: new Date().toISOString() });
      else if (!entry.present && existing) this.issues = this.issues.filter(issue => !(issue.kind === entry.kind && issue.collection === undefined));
    }
    if (this.storageState === 'ready' && this.issues.length > 0) this.storageState = 'degraded';
    else if (this.storageState === 'degraded' && this.issues.length === 0 && this.corrupt.size === 0) this.storageState = 'ready';
    this.notifyStatus();
  }

  private unsupportedPersistence(collection?: string): Promise<void> {
    this.noteIssue({ kind: 'persistence-unsupported', collection, message: 'This hosted parent cannot acknowledge saving. The visible change is cached only.' });
    const rejected = Promise.reject<void>(new XDBStorageError('persistence-unsupported', 'This hosted parent does not support acknowledged saving.', collection));
    rejected.catch(() => {});
    return rejected;
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
    if (this.destroyed) return;
    const status = this.storagePersistence?.getStatus();
    const needed = this.hasPendingWrites() || this.storageState === 'memory-only'
      || !!status && (status.pendingWrites > 0 || status.failedWrites > 0 || status.unknownWrites > 0 || status.protocol === 0 || status.disposed);
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
    const persistence = this.storagePersistence?.getStatus();
    return {
      state: this.storageState,
      persistent: this.persistent && (!persistence || !this.destroyed && persistence.protocol === 1 && !persistence.disposed),
      hydrated: this.hydrated,
      pendingWrites: this.pendingNative.size + Math.max(this.pendingStorage.size, this.destroyed ? 0 : persistence?.pendingWrites ?? 0),
      ...(persistence ? { persistence } : {}),
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

  /**
   * Have edits stamped after what `source` holds of a record as well as what
   * this store does; the returned function stops it. A sync room may hold a
   * newer copy than this device kept (its share of the store full, or a
   * backup restored): an edit stamped after the older copy here was still
   * older than the room's, lost to it on every peer, and was never sent.
   */
  addStampSource(source: StampSource): () => void {
    this.stampSources.add(source);
    return () => {
      this.stampSources.delete(source);
    };
  }

  /** The cache's live record with this id, in whichever collection holds it. */
  private cachedLive(id: string): XDBRecord | undefined {
    for (const coll of this.memoryStore.values()) {
      const record = coll.get(id);
      if (record && !record.deleted) return record;
    }
    return undefined;
  }

  /** The stamp of an edit made now to `record`: after its own and after every room's copy of it. */
  private stampAfter(record: XDBRecord): string {
    let latest = record.updated_at;
    for (const source of this.stampSources) {
      let theirs: string | undefined;
      try {
        theirs = source(record.collection, record.id);
      } catch {
        // A room closing as the edit is made: its copy no longer counts.
        continue;
      }
      if (theirs !== undefined && stampTime(theirs) > stampTime(latest)) latest = theirs;
    }
    const key = `${record.collection}\u0000${record.id}`;
    // Whether the copy edited was this device's own, before noting it.
    const own = sameStamp(this.stampedHere.get(key), latest);
    this.noteEditedAfter(record.collection, record.id, latest);
    const now = Date.now();
    const stamp = editStamp(latest, now);
    // This clock's time, or one past a copy of its own: this device's. One past a
    // copy heard from the host or a room is in their time, and the next edit's op
    // is floored after it as after that copy.
    const mine = stamp === new Date(now).toISOString() || own;
    if (mine) this.noteStampedHere(record.collection, record.id, stamp);
    else this.stampedHere.delete(key);
    this.noteGiven(record.collection, record.id, stamp, mine);
    return stamp;
  }

  /**
   * The stamp the last change of each record was given here, and whether in this device's own
   * time, until the change is announced: what the note of changes made while no server sync
   * client listened keeps of it (`noteUnheardEdit`).
   */
  private givenStamp = new Map<string, { stamp: string; own: boolean }>();

  private noteGiven(collection: string, id: string, stamp: string, own: boolean): void {
    if (this.givenStamp.size >= 10_000) this.givenStamp.clear();
    this.givenStamp.set(`${collection}\u0000${id}`, { stamp, own });
  }

  /**
   * The stamp this device gave each record it last created or edited in its own time, by
   * record: a copy of its own is not one an edit follows for server sync's floor
   * (`noteEditedAfter`). A create and an edit of it in one millisecond, or a burst of edits,
   * left the copy at or past this clock, and the op went out in this clock's time, ahead of
   * the host's on a device whose clock ran fast. A stamp that followed a copy heard from the
   * host is not one of these: counted as one, the edit after it went out unfloored, before the
   * one it came after, and the host took it for older and dropped it.
   */
  private stampedHere = new Map<string, string>();

  private noteStampedHere(collection: string, id: string, stamp: string): void {
    if (this.stampedHere.size >= 10_000) this.stampedHere.clear();
    this.stampedHere.set(`${collection}\u0000${id}`, stamp);
  }

  /** Whether this page gave `id` of `collection` the stamp `stamp`, in this device's time. */
  isOwnStamp(collection: string, id: string, stamp: unknown): boolean {
    return sameStamp(this.stampedHere.get(`${collection}\u0000${id}`), stamp);
  }

  /** The stamp of a copy, when an edit or a removal of it follows it (`noteEditedAfter`'s rule). */
  private followedStamp(collection: string, id: string, stamp: string | undefined): string | undefined {
    if (stamp === undefined) return undefined;
    const at = stampTime(stamp);
    const now = Date.now();
    if (!(at >= now) || at - now > STAMP_AHEAD_LIMIT_MS) return undefined;
    return this.isOwnStamp(collection, id, stamp) ? undefined : stamp;
  }

  /**
   * The stamp of the copy an edit or a removal was made after, by record, until the change is
   * announced (`after` on the mutation event): server sync stamps its op no earlier than just
   * after it. Kept only for a copy stamped ahead of this clock, which is when an edit follows
   * it (editStamp). One behind is older than the edit by this clock and by the host's, and a
   * floor at the edit's own stamp put the op in this clock's time: on a device whose clock ran
   * fast, ahead of the host's, past edits other devices made in between, which it undid.
   */
  private editedAfter = new Map<string, string>();

  private noteEditedAfter(collection: string, id: string, stamp: string): void {
    if (this.followedStamp(collection, id, stamp) === undefined) return;
    // Taken by the announcement that follows; a bound for writes that threw before it.
    if (this.editedAfter.size >= 10_000) this.editedAfter.clear();
    this.editedAfter.set(`${collection}\u0000${id}`, stamp);
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
    if (this.destroyed && this.storagePersistence) throw new XDBStorageError('write-failed', 'This storage owner has been released.', collection);
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
      if (this.destroyed && this.storagePersistence) throw new Error('The hosted storage owner was released.');
      if (this.storagePersistence?.protocol === 1) this.hostedWrite(this.storagePersistence.setItem(quarantineKey, raw), [collection]);
      else {
        this.storage.setItem(quarantineKey, raw);
        this.budget?.wrote(quarantineKey, raw);
      }
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
    this.destroyed = true;
    this.resolveStorageOwnerReleased();
    this.storageUnsubscribe?.();
    this.storageUnsubscribe = null;
    for (const cancel of this.storageCancellations) cancel();
    this.storageCancellations.clear();
    this.pendingStorage.clear();
    this.unknownStorageReceipts.clear();
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
    // A name with a colon names another app's key (isCollectionName).
    if (!isCollectionName(collection)) return [];
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

  /** `reserve`: what of the record budget to keep back (PEER_RECORD_HEADROOM, for what peers send). */
  private setCollectionData(collection: string, records: XDBRecord[], reserve = 0): Promise<void> | undefined {
    this.assertWritable(collection, false);
    if (this.useTauri) {
      const coll = new Map<string, XDBRecord>();
      for (const r of records) coll.set(r.id, r);
      this.memoryStore.set(collection, coll);
      this.knownCollections.add(collection);
      return;
    }

    assertCollectionName(collection);
    const key = this.collectionKey(collection);
    let persisted: Promise<void> | undefined;
    // A value JSON cannot hold is not a full disk, and the store is not degraded by it.
    let value: string;
    try {
      value = JSON.stringify(records);
    } catch (err) {
      throw new XDBStorageError('invalid-data', `"${collection}" cannot be saved: a record's data is not something JSON can hold (${err instanceof Error ? err.message : String(err)}).`, collection);
    }
    try {
      if (this.storagePersistence?.protocol === 1) persisted = this.hostedWrite(this.storagePersistence.setItem(key, value), [collection]);
      else {
        this.budget?.admit(key, value, reserve);
        this.storage.setItem(key, value);
        this.budget?.wrote(key, value);
        if (this.storagePersistence) persisted = this.unsupportedPersistence(collection);
      }
      this.acknowledged.delete(collection);
    } catch (err) {
      // localStorage.setItem is atomic: the previous value is intact. Say so
      // instead of pretending the write happened (audit SN-02).
      const message = err instanceof Error ? err.message : String(err);
      this.noteIssue({ kind: 'quota', collection, message: `Could not save "${collection}" (${message}). The previously saved records are unchanged; free storage or export your data.` });
      throw new XDBStorageError('quota', `Could not save "${collection}": ${message}`, collection);
    }
    this.knownCollections.add(collection);
    this.indexCollection(collection, true);
    return persisted;
  }

  /** Whether the storage can list its keys, as localStorage can; one that cannot keeps a list of its collections. */
  private canListKeys(): boolean {
    return 'length' in this.storage && typeof (this.storage as Storage).key === 'function';
  }

  private collectionIndex: Set<string> | null = null;

  /**
   * The collections stored here, for a storage that cannot list its keys
   * (one with getItem, setItem and removeItem alone, which is all XDBStorage
   * asks). Such a store reopened knew only the collections the page had
   * touched since: a record could not be found by id, updated, deleted or
   * exported until its collection was read by name.
   */
  private storedIndex(): Set<string> {
    if (!this.collectionIndex) {
      this.collectionIndex = new Set();
      try {
        const saved: unknown = JSON.parse(this.storage.getItem(this.metaKey('collections')) ?? '[]');
        if (Array.isArray(saved)) for (const name of saved) if (isCollectionName(name)) this.collectionIndex.add(name);
      } catch {
        // Unreadable: the collections this page touches are still found.
      }
    }
    return this.collectionIndex;
  }

  private indexCollection(collection: string, stored: boolean): void {
    // A hosted parent's storage lists its keys (formlogic-host's storage.ts),
    // and each write to it is a save the parent acknowledges: none is added.
    if (this.useTauri || this.storagePersistence || this.canListKeys()) return;
    const index = this.storedIndex();
    if (index.has(collection) === stored) return;
    if (stored) index.add(collection);
    else index.delete(collection);
    try {
      this.writeMeta('collections', JSON.stringify([...index]));
    } catch {
      // The records were saved; only finding them after a reopen depends on
      // this, and the next new collection writes the list again.
    }
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
      const written = new Set(this._batchWritten);
      this._batchDirty.clear();
      this._batchWritten.clear();
      for (const collection of dirty) {
        // A collection only read again during the batch is announced as a reload.
        this.emitNow({ type: 'refresh', collection, records: this.getCollectionData(collection), ...(written.has(collection) ? {} : { reload: true }) });
      }
    }
  }

  /** Collections changed during the batch by something other than a reload (`XDBEvent.reload`). */
  private _batchWritten = new Set<string>();

  /**
   * Emit an event to listeners (or defer if batching)
   */
  private emit(event: XDBEvent): void {
    if (this._batchDepth > 0) {
      // Batching: just track which collections changed
      this._batchDirty.add(event.collection);
      if (!event.reload) this._batchWritten.add(event.collection);
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
    assertCollectionName(collection);
    data = storedData(data);
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
            this.native<boolean>('delete_record', { id: serverRecord.id, collection, updatedAt: currentOptimistic?.updated_at })
              .then(() => this.nativeWriteLanded(collection))
              .catch((err) => {
                // A clear of its collection took the row first: gone, as asked.
                if (/\bnot found\b/i.test(err instanceof Error ? err.message : String(err))) this.nativeWriteLanded(collection);
                else this.nativeWriteFailed('delete a record', collection, err);
              });
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
            // Stamped when the edit was made, or just after the native create: SQLite stamped
            // the update with its own later time, and the record here kept the create's.
            const stamp = stampTime(currentOptimistic.updated_at) > stampTime(serverRecord.updated_at)
              ? currentOptimistic.updated_at
              : editStamp(serverRecord.updated_at);
            mergedRecord = { ...serverRecord, data: mergedData, updated_at: stamp };
            // Push merged data to server so it's persisted
            this.native('update_record', {
              payload: { id: serverRecord.id, data: mergedData, updated_at: stamp },
            }).catch((err) => this.nativeWriteFailed('update a record', collection, err));
          } else {
            mergedRecord = serverRecord;
          }

          c.set(serverRecord.id, mergedRecord);
          this.noteStampedHere(collection, mergedRecord.id, mergedRecord.updated_at);
          this.noteGiven(collection, mergedRecord.id, mergedRecord.updated_at, true);
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

    return this.createStorage(collection, data, options).result;
  }

  private createStorage(collection: string, data: Record<string, unknown>, options: XDBCreateOptions = {}): { result: XDBRecord; persisted?: Promise<void> } {
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
    const persisted = this.setCollectionData(collection, records);
    this.noteStampedHere(collection, record.id, now);
    this.noteGiven(collection, record.id, now, true);

    this.emit({ type: 'create', collection, record });
    this.notifyMutation('create', collection, record.id, data);

    return { result: record, persisted };
  }

  /**
   * Create a record asynchronously (returns the actual server record)
   */
  async createAsync(collection: string, data: Record<string, unknown>): Promise<XDBRecord> {
    assertCollectionName(collection);
    data = storedData(data);
    if (this.useTauri) {
      const record = await this.native<XDBRecord>('create_record', {
        payload: { collection, data },
      });
      this.getOrCreateCollection(collection).set(record.id, record);
      this.noteStampedHere(collection, record.id, record.updated_at);
      this.noteGiven(collection, record.id, record.updated_at, true);
      this.emit({ type: 'create', collection, record });
      this.notifyMutation('create', collection, record.id, record.data);
      return record;
    }

    const { result, persisted } = this.createStorage(collection, data);
    await persisted;
    return result;
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
      const filter = options.filter;
      records = records.filter((record) => matchesFilter(record, filter));
    }

    // Apply sort (restricted to record.data fields)
    if (options?.sort) {
      records.sort(byField(options.sort.field, options.sort.order));
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
        let changed = false;
        // Build a set of server IDs for cleanup
        const serverIds = new Set(records.map(r => r.id));
        // Merge: server records update cache, but preserve optimistic records
        // (those with IDs not known to the server yet) and don't revive locally deleted records
        for (const r of records) {
          const existing = coll.get(r.id);
          // Never revive a record that was locally deleted (delete was async, backend is stale)
          if (existing?.deleted) continue;
          if (!existing || (stampTime(existing.updated_at) <= stampTime(r.updated_at) && !deepEqual(existing, r))) {
            coll.set(r.id, r);
            changed = true;
          }
        }
        // Remove stale local records whose server-assigned IDs are no longer in backend
        // (but keep optimistic records that haven't been resolved yet). A
        // deleted one is kept: the native store lists live records only, and
        // its tombstone is what tells peer sync and server sync it is gone.
        for (const [localId, local] of coll) {
          if (!serverIds.has(localId) && !this.isOptimisticId(localId) && !local.deleted) {
            coll.delete(localId);
            changed = true;
          }
        }
        // Announced only when it changed something. Every <data> read on the
        // desktop comes here and every announcement starts another one: a
        // mounted <data> block re-read SQLite every 120 ms for as long as it
        // was shown, and each read went to peer sync as a fresh `refresh`.
        if (changed) this.emit({ type: 'refresh', collection, records: this.getCollectionData(collection), reload: true });
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
        const filter = options.filter;
        records = records.filter((record) => matchesFilter(record, filter));
      }

      // Apply sort
      if (options?.sort) {
        records.sort(byField(options.sort.field, options.sort.order));
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
    storableText(data);
    if (this.useTauri) {
      // Resolve optimistic ID → server ID if the create callback has already fired
      const resolvedId = this.optimisticIdMap.get(id) || id;

      // The collection of the record this touched, for the failure report,
      // and whether its own create was still in flight when this was sent:
      // by the time SQLite answers, the create may have landed.
      let touched: string | undefined;
      // What this update puts in the cache, made before SQLite is asked so
      // that its stamp goes with the request. Stamped after a sync room's
      // copy as well (stampAfter), which SQLite knows nothing of: it stamped
      // the edit with its own clock, its answer replaced this record, and the
      // edit lost to the room's copy.
      let applied: XDBRecord | undefined;
      for (const [collection, coll] of this.memoryStore) {
        let record = coll.get(id);
        if (!record && id !== resolvedId) record = coll.get(resolvedId);
        if (record && !record.deleted) {
          touched = collection;
          applied = {
            ...record,
            data: storedData({ ...objectData(record), ...data }),
            updated_at: this.stampAfter(record),
          };
          coll.set(record.id, applied);
          break;
        }
      }
      // While the record's own create is in flight SQLite has no row to
      // address: the change is kept in the cache and the create callback
      // sends it, merged, once the row exists. Sending it now could only fail.
      if (!this.pendingCreateIds.has(id)) {
        // Async update via Tauri - fire and forget
        this.native<XDBRecord>('update_record', {
          payload: { id: resolvedId, data, updated_at: applied?.updated_at },
        })
          .then((serverRecord) => {
            this.nativeWriteLanded(serverRecord.collection);
            // Applied only while the cache still holds what this update put
            // there, as updateInCollection does: a newer edit or a deletion
            // wins even if this answer comes last. Weighed by time instead,
            // a delete in the same tick (stamped in the same millisecond, or
            // before SQLite's own clock) lost, and the record came back.
            const c = this.getOrCreateCollection(serverRecord.collection);
            if (c.get(serverRecord.id) === applied) {
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

      // Return optimistic result
      if (applied && touched !== undefined) {
        this.emit({ type: 'update', collection: touched, record: applied });
        this.notifyMutationLanded('update', touched, applied.id, applied.data);
        return applied;
      }
      return null;
    }

    return this.updateStorage(id, data).result;
  }

  private updateStorage(id: string, data: Partial<Record<string, unknown>>): { result: XDBRecord | null; persisted?: Promise<void> } {
    const allKeys = this.getAllCollectionKeys();

    for (const collection of allKeys) {
      const records = this.getAllCollectionData(collection);
      // A deleted record is kept here for sync and is not there to update,
      // as `get`, `delete`, `updateInCollection` and the desktop branch above
      // all have it. This one did not ask: it patched the deleted record,
      // announced the update and answered with it.
      const index = records.findIndex((r) => r.id === id && !r.deleted);

      if (index !== -1) {
        const record = records[index];
        const updatedRecord: XDBRecord = {
          ...record,
          data: storedData({ ...objectData(record), ...data }),
          updated_at: this.stampAfter(record),
        };

        records[index] = updatedRecord;
        const persisted = this.setCollectionData(collection, records);

        this.emit({ type: 'update', collection, record: updatedRecord });
        this.notifyMutation('update', collection, id, updatedRecord.data);

        return { result: updatedRecord, persisted };
      }
    }

    return { result: null };
  }

  /**
   * Update a record asynchronously
   */
  async updateAsync(id: string, data: Partial<Record<string, unknown>>): Promise<XDBRecord | null> {
    storableText(data);
    if (this.useTauri) {
      try {
        // Stamped after the cache's copy and a room's, as update() stamps it.
        const held = this.cachedLive(id);
        const record = await this.native<XDBRecord>('update_record', {
          payload: { id, data, updated_at: held ? this.stampAfter(held) : undefined },
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

    const { result, persisted } = this.updateStorage(id, data);
    await persisted;
    return result;
  }

  /**
   * Update a record in a specific collection by ID
   */
  updateInCollection(
    collection: string,
    id: string,
    data: Partial<Record<string, unknown>>
  ): XDBRecord | null {
    storableText(data);
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
        data: storedData({ ...objectData(record), ...data }),
        updated_at: this.stampAfter(record),
      };
      coll.set(record.id, updatedRecord);
      this.emit({ type: 'update', collection, record: updatedRecord });
      this.notifyMutationLanded('update', collection, record.id, updatedRecord.data);

      // A row still being created has none to update: the create callback
      // sends the change, merged, once it exists, as for update().
      if (this.pendingCreateIds.has(record.id)) return updatedRecord;
      // A scoped edit is still a local mutation: persist it just like update(),
      // while keeping the optimistic cache change in the requested collection.
      this.native<XDBRecord>('update_record', {
        payload: { id: record.id, data, updated_at: updatedRecord.updated_at },
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
      data: storedData({ ...objectData(record), ...data }),
      updated_at: this.stampAfter(record),
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
      // The tombstone, made before SQLite is asked so that its stamp goes
      // with the request, as an update's does.
      let tombstone: { id: string; record: XDBRecord } | undefined;
      for (const [collection, coll] of this.memoryStore) {
        const lookupId = coll.has(id) ? id : (id !== resolvedId && coll.has(resolvedId) ? resolvedId : null);
        if (!lookupId) continue;
        const record = coll.get(lookupId);
        if (record && !record.deleted) {
          touched = collection;
          tombstone = { id: lookupId, record: { ...record, deleted: true, updated_at: this.stampAfter(record) } };
          coll.set(lookupId, tombstone.record);
          break;
        }
      }
      // A record whose create is still in flight has no row to delete yet;
      // the tombstone below stays in the cache and the create callback
      // deletes the row once SQLite has written it.
      if (!this.pendingCreateIds.has(id)) {
        // Async delete via Tauri - fire and forget
        this.native<boolean>('delete_record', { id: resolvedId, updatedAt: tombstone?.record.updated_at })
          .then(() => {
            this.nativeWriteLanded(touched);
            // Announced once, below, when the cache took the delete: told
            // again here, every listener heard of each delete twice.
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
      if (tombstone && touched !== undefined) {
        this.emit({ type: 'delete', collection: touched, record: tombstone.record });
        this.notifyMutationLanded('delete', touched, tombstone.id);
      }

      return true; // Optimistic
    }

    return this.deleteStorage(id).result;
  }

  private deleteStorage(id: string): { result: boolean; persisted?: Promise<void> } {
    const allKeys = this.getAllCollectionKeys();

    for (const collection of allKeys) {
      const records = this.getAllCollectionData(collection);
      // A record deleted already is not there to delete, as for
      // `deleteFromCollection`: it was stamped again, announced again and
      // answered with success.
      const index = records.findIndex((r) => r.id === id && !r.deleted);

      if (index !== -1) {
        const record = records[index];
        record.deleted = true;
        record.updated_at = this.stampAfter(record);

        const persisted = this.setCollectionData(collection, records);

        this.emit({ type: 'delete', collection, record });
        this.notifyMutation('delete', collection, id);

        return { result: true, persisted };
      }
    }

    return { result: false };
  }

  /**
   * Delete a record asynchronously
   */
  async deleteAsync(id: string): Promise<boolean> {
    if (this.useTauri) {
      try {
        const held = this.cachedLive(id);
        const stamp = held ? this.stampAfter(held) : undefined;
        await this.native<boolean>('delete_record', { id, updatedAt: stamp });
        for (const [collection, coll] of this.memoryStore) {
          const record = coll.get(id);
          if (record) {
            const deleted = { ...record, deleted: true, updated_at: stamp ?? this.stampAfter(record) };
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

    const { result, persisted } = this.deleteStorage(id);
    await persisted;
    return result;
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
      const deleted = { ...record, deleted: true, updated_at: this.stampAfter(record) };
      coll!.set(record.id, deleted);
      this.emit({ type: 'delete', collection, record: deleted });
      this.notifyMutationLanded('delete', collection, record.id);
      // A row still being created is deleted by the create callback instead.
      if (!this.pendingCreateIds.has(record.id)) {
        this.native<boolean>('delete_record', { id: record.id, collection, updatedAt: deleted.updated_at })
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
    record.updated_at = this.stampAfter(record);

    this.setCollectionData(collection, records);

    this.emit({ type: 'delete', collection, record });
    this.notifyMutation('delete', collection, id);

    return true;
  }

  /**
   * Hard delete - permanently remove a record
   *
   * Server sync is told as it is of any delete (`db.prune` and
   * `db.clearCollection` remove records this way). It used to hear nothing:
   * the server kept the record, and the next pull brought it back.
   */
  hardDelete(collection: string, id: string): boolean {
    this.assertWritable(collection, true);
    if (this.useTauri) {
      const coll = this.memoryStore.get(collection);
      const record = coll?.get(id);
      if (!record) return false;
      coll!.delete(id);

      const stillBeingCreated = this.pendingCreateIds.has(id);
      if (stillBeingCreated) {
        // No row yet: the create callback deletes the one SQLite writes and
        // never puts the record back in the cache. Nor does it announce the
        // create, so there is no delete to announce either.
        this.abandonedCreates.add(id);
      } else {
        this.native<boolean>('delete_record', { id, collection })
          .then(() => this.nativeWriteLanded(collection))
          .catch((err) => this.nativeWriteFailed('remove a record', collection, err));
      }

      // `removed`: a record deleted first and then removed is announced as
      // it was, deleted, and peer sync took that for a soft delete and kept
      // it in the room.
      this.noteRemovedForGood(collection, id);
      this.emit({ type: 'delete', collection, record, removed: true });
      if (!stillBeingCreated) {
        this.noteUnheardRemovals(collection, [record]);
        this.noteEditedAfter(collection, id, record.updated_at);
        this.notifyMutation('delete', collection, id);
      }
      return true;
    }

    return this.hardDeleteMany(collection, [id]) > 0;
  }

  /**
   * Remove several records of one collection for good, in one write.
   * `db.prune` and `db.clearCollection` removed records one `hardDelete` at
   * a time, and each read and wrote the whole collection again: a thousand
   * records cost a thousand rewrites of what was left. Each record is
   * announced and told to server sync as `hardDelete` does; announced
   * together, listeners hear of a batch as they do of a script's call: one
   * refresh. Returns how many were removed.
   */
  hardDeleteMany(collection: string, ids: Iterable<string>): number {
    this.assertWritable(collection, true);
    if (this.useTauri) {
      let removed = 0;
      this.suppressNotifications();
      try {
        for (const id of ids) if (this.hardDelete(collection, id)) removed++;
      } finally {
        this.resumeNotifications();
      }
      return removed;
    }

    const wanted = new Set(ids);
    const records = this.getAllCollectionData(collection);
    const found = new Map(records.filter((r) => wanted.has(r.id)).map((r) => [r.id, r]));
    if (found.size === 0) return 0;
    this.setCollectionData(collection, records.filter((r) => !wanted.has(r.id)));
    // Announced in the order asked for (oldest first, for a prune).
    const gone = [...wanted].flatMap((id) => found.get(id) ?? []);
    for (const record of gone) this.noteRemovedForGood(collection, record.id);

    const together = gone.length > 1;
    if (together) this.suppressNotifications();
    try {
      for (const record of gone) this.emit({ type: 'delete', collection, record, removed: true });
    } finally {
      if (together) this.resumeNotifications();
    }
    this.noteUnheardRemovals(collection, gone);
    for (const record of gone) {
      this.noteEditedAfter(collection, record.id, record.updated_at);
      this.notifyMutation('delete', collection, record.id);
    }
    return gone.length;
  }

  // --------------------------------------------------------------------------
  // Removals kept for the peer-to-peer room
  // --------------------------------------------------------------------------

  /**
   * Records removed for good here that peer sync has not told the room, by
   * collection: an id is noted as it goes, and taken off once the room is
   * told (xdb-sync.ts). Peer sync tells the room as a removal is made, while
   * it is open; one made while it was not (the app closed to its room, or
   * offline before it joined) reached nobody, and the room's copy came back
   * at the next opening, written into this store as a record it lacked.
   * Kept only by a store that has been in a room, at most this many to a
   * collection, oldest going first, beside the records.
   */
  private static readonly PENDING_REMOVALS_KEPT = 2000;
  private pendingRemovalSets = new Map<string, Set<string>>();
  private pendingRemovalsDirty = new Set<string>();
  private pendingRemovalsScheduled = false;
  private joinedRoom: boolean | null = null;

  /** Peer sync says so on joining a room: from then on a removal is kept for it. */
  markJoinedRoom(): void {
    this.joinedRoom = true;
    try {
      if (this.readSyncMeta('p2p-room') !== '1') this.writeSyncMeta('p2p-room', '1');
    } catch {
      // Not kept: removals are kept for this page's life.
    }
  }

  private pendingRemovalSet(collection: string): Set<string> {
    let set = this.pendingRemovalSets.get(collection);
    if (set) return set;
    set = new Set();
    try {
      const saved: unknown = JSON.parse(this.readSyncMeta(`removals:${collection}`) ?? '[]');
      if (Array.isArray(saved)) for (const id of saved) if (typeof id === 'string') set.add(id);
    } catch {
      // An unreadable list is an empty one.
    }
    this.pendingRemovalSets.set(collection, set);
    return set;
  }

  private noteRemovedForGood(collection: string, id: string): void {
    if (this.joinedRoom === null) this.joinedRoom = this.readSyncMeta('p2p-room') === '1';
    if (!this.joinedRoom) return;
    const set = this.pendingRemovalSet(collection);
    set.delete(id);
    set.add(id);
    while (set.size > XDBService.PENDING_REMOVALS_KEPT) set.delete(set.values().next().value as string);
    this.pendingRemovalsChanged(collection);
  }

  /** The removals of a collection the room has not been told. */
  pendingRemovals(collection: string): string[] {
    return [...this.pendingRemovalSet(collection)];
  }

  isPendingRemoval(collection: string, id: string): boolean {
    return this.pendingRemovalSet(collection).has(id);
  }

  /** The room has been told, or the record was made here again. */
  forgetPendingRemoval(collection: string, id: string): void {
    if (this.pendingRemovalSet(collection).delete(id)) this.pendingRemovalsChanged(collection);
  }

  private pendingRemovalsChanged(collection: string): void {
    this.pendingRemovalsDirty.add(collection);
    if (this.pendingRemovalsScheduled) return;
    this.pendingRemovalsScheduled = true;
    // Written once for a batch: a prune of thousands notes each id.
    queueMicrotask(() => {
      this.pendingRemovalsScheduled = false;
      for (const name of this.pendingRemovalsDirty) {
        try {
          this.writeSyncMeta(`removals:${name}`, JSON.stringify([...this.pendingRemovalSet(name)]));
        } catch {
          // Kept for this page's life.
        }
      }
      this.pendingRemovalsDirty.clear();
    });
  }

  // --------------------------------------------------------------------------
  // Sync Adapter API
  // --------------------------------------------------------------------------

  /**
   * The collections this store holds, and any this page has touched. It
   * listed only the latter: a server pull named no collection the app had
   * not read since it opened, and peer sync shared none of them.
   */
  getCollections(): string[] {
    if (this.useTauri) return Array.from(this.knownCollections);
    return [...new Set([...this.knownCollections, ...this.getAllCollectionKeys()])];
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

  /**
   * `writeRecord` for many records of one collection: in browser storage the
   * collection is read and written once, not once a record. Peer sync wrote
   * a room's records one at a time, each re-reading and re-serialising the
   * whole collection: 1,000 records took 0.3 s to bring in and 4,000 took
   * 4.4 s, so one update from a peer could hold a joining tab. All or none:
   * a write the store refuses throws before anything is announced.
   */
  writeRecords(collection: string, list: readonly XDBRecord[]): void {
    if (list.length === 0) return;
    if (list.length === 1) {
      this.writeRecord(collection, list[0]);
      return;
    }
    if (this.useTauri) {
      // One native call for the lot, one rewrite of the collection's stored
      // document (upsert_records). One call a record rewrote the whole
      // document each time: a room of a few thousand records cost
      // gigabytes of writes to join on the desktop.
      this.knownCollections.add(collection);
      const coll = this.getOrCreateCollection(collection);
      const events: XDBEvent[] = list.map((record) => {
        const event: XDBEvent = { type: coll.has(record.id) ? 'update' : 'create', collection, record };
        coll.set(record.id, record);
        return event;
      });
      this.native<string[]>('upsert_records', { records: list })
        .then((refused) => {
          // Not written, as upsert_record refuses one: a record another
          // collection holds under the same id.
          if (Array.isArray(refused) && refused.length > 0) {
            this.nativeWriteFailed('save a record', collection, new Error(`${refused.length === 1 ? 'a record' : `${refused.length} records`} of another collection here`));
          } else {
            this.nativeWriteLanded(collection);
          }
        })
        .catch((err) => this.nativeWriteFailed('save a record', collection, err));
      for (const event of events) this.emit(event);
      return;
    }
    this.knownCollections.add(collection);
    const records = this.getAllCollectionData(collection);
    const at = new Map(records.map((r, i) => [r.id, i]));
    const events: XDBEvent[] = [];
    for (const record of list) {
      const index = at.get(record.id);
      if (index !== undefined) {
        records[index] = record;
        events.push({ type: 'update', collection, record });
      } else {
        at.set(record.id, records.length);
        records.push(record);
        events.push({ type: 'create', collection, record });
      }
    }
    this.setCollectionData(collection, records);
    for (const event of events) this.emit(event);
  }

  /**
   * Peer sync's write of what a room brought for one collection: as
   * `writeRecords`, but held to the record budget less PEER_RECORD_HEADROOM,
   * so the app's own writes always have room, and taking what fits. Records
   * are taken in order while they fit; the rest, and any JSON cannot hold,
   * are passed over and returned, and what was taken is written at once.
   * Peers could fill the whole budget, after which the person's own edits
   * were refused; and a batch the budget refused was tried again a record at
   * a time, each re-reading and re-serialising the collection, which held a
   * joining tab for as long as the room had records past the budget.
   * Throws as `writeRecords` does when the store itself refuses the write.
   */
  writePeerRecords(collection: string, list: readonly XDBRecord[]): XDBRecord[] {
    if (list.length === 0) return [];
    if (this.useTauri) {
      // Passed over, as browser storage passes over a record JSON cannot hold:
      // what the native store cannot read (a field named as Tauri's IPC's own,
      // text it cannot hold, nesting past 100) failed the whole native write it
      // was in, so one peer's record kept a room's batch out of SQLite.
      const passed = list.filter((record) => !readableByNative(record, 0));
      this.writeRecords(collection, passed.length === 0 ? list : list.filter((record) => !passed.includes(record)));
      return passed;
    }
    const records = this.getAllCollectionData(collection);
    const at = new Map(records.map((r, i) => [r.id, i]));
    const budget = this.budget;
    const room = budget ? budget.room(this.collectionKey(collection), PEER_RECORD_HEADROOM) : Infinity;
    // The length of the collection as it will be stored, followed record by
    // record: '[' + each record's JSON joined by ',' + ']'.
    let size = JSON.stringify(records).length;
    const passed: XDBRecord[] = [];
    let overBudget = false;
    const events: XDBEvent[] = [];
    for (const record of list) {
      let length: number;
      try {
        length = JSON.stringify(record).length;
      } catch {
        passed.push(record);
        continue;
      }
      const index = at.get(record.id);
      const next = index === undefined
        ? size + length + (records.length > 0 ? 1 : 0)
        : size - JSON.stringify(records[index]).length + length;
      if (next > room) {
        passed.push(record);
        overBudget = true;
        continue;
      }
      size = next;
      if (index !== undefined) {
        records[index] = record;
        events.push({ type: 'update', collection, record });
      } else {
        at.set(record.id, records.length);
        records.push(record);
        events.push({ type: 'create', collection, record });
      }
    }
    if (overBudget && budget) {
      this.noteIssue({
        kind: 'quota',
        collection,
        message: `Some of the room's records for "${collection}" are not kept on this device: what peers send may take ${megabytes(budget.limit - PEER_RECORD_HEADROOM)} MB of the app's ${megabytes(budget.limit)} MB of browser storage, so that its own writes have room. They stay in the room.`,
      });
    }
    if (events.length === 0) return passed;
    this.knownCollections.add(collection);
    this.setCollectionData(collection, records, PEER_RECORD_HEADROOM);
    for (const event of events) this.emit(event);
    return passed;
  }

  removeRecord(collection: string, id: string): void {
    this.assertWritable(collection, true);
    if (this.useTauri) {
      const coll = this.memoryStore.get(collection);
      const removed = coll?.get(id);
      if (removed) {
        coll!.delete(id);
        this.emit({ type: 'delete', collection, record: removed, removed: true });
      }
      // Named, so an id another collection holds is not deleted from it.
      this.native<boolean>('delete_record', { id, collection })
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
      this.emit({ type: 'delete', collection, record: removed, removed: true });
    }
  }

  /**
   * `removeRecord` for many records of one collection: in browser storage the collection is
   * read and written once, and on the desktop the records the cache holds go to the native
   * store as tombstones in one call (upsert_records), as delete_record writes each. A pull's
   * deletions were removed a record at a time, each re-reading and rewriting the collection,
   * and on the desktop each a native call that rewrote its stored document.
   */
  removeRecords(collection: string, ids: readonly string[]): void {
    if (ids.length <= 1) {
      if (ids.length === 1) this.removeRecord(collection, ids[0]);
      return;
    }
    this.assertWritable(collection, true);
    if (this.useTauri) {
      const coll = this.memoryStore.get(collection);
      const tombstones: XDBRecord[] = [];
      const events: XDBEvent[] = [];
      for (const id of ids) {
        const removed = coll?.get(id);
        if (!removed) {
          // Not held here: the native store is asked by id, as before.
          this.removeRecord(collection, id);
          continue;
        }
        coll!.delete(id);
        tombstones.push({ ...removed, deleted: true, updated_at: editStamp(removed.updated_at) });
        events.push({ type: 'delete', collection, record: removed, removed: true });
      }
      if (tombstones.length > 0) {
        this.native<string[]>('upsert_records', { records: tombstones })
          .then((refused) => {
            if (Array.isArray(refused) && refused.length > 0) {
              this.nativeWriteFailed('remove a record', collection, new Error(`${refused.length === 1 ? 'a record' : `${refused.length} records`} of another collection here`));
            } else {
              this.nativeWriteLanded(collection);
            }
          })
          .catch((err) => this.nativeWriteFailed('remove a record', collection, err));
      }
      for (const event of events) this.emit(event);
      return;
    }
    const gone = new Set(ids);
    const records = this.getAllCollectionData(collection);
    const kept = records.filter((record) => !gone.has(record.id));
    if (kept.length === records.length) return;
    this.setCollectionData(collection, kept);
    for (const record of records) if (gone.has(record.id)) this.emit({ type: 'delete', collection, record, removed: true });
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
    /** The stamp of the copy the change was made after, when it was ahead of this clock (`editedAfter`). */
    after?: string;
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
    after?: string;
  }) => void): () => void {
    this.mutationListeners.add(listener);
    return () => { this.mutationListeners.delete(listener); };
  }

  private firstUnheard: number | null = null;

  /**
   * Records removed for good while no server sync client listened (hardDelete, a prune,
   * clearCollection), with when, by this device's clock; taken by the client that starts
   * listening, which tells the host (takeUnheardRemovals). A removal leaves no tombstone for the
   * client's scan to find: the host kept the record, and the next pull wrote it back here.
   * At most this many, oldest going first. `after`: the stamp of the copy removed, when it was
   * ahead of this clock (a write heard just before), which the delete is stamped after, as one
   * made while listening is: without it, it lost to that write on the host and came undone.
   */
  private static readonly UNHEARD_REMOVALS_KEPT = 50_000;
  private unheardRemovals = new Map<string, { collection: string; id: string; at: number; after?: string }>();

  takeUnheardRemovals(): Array<{ collection: string; id: string; at: number; after?: string }> {
    const taken = [...this.unheardRemovals.values()];
    this.unheardRemovals.clear();
    return taken;
  }

  private noteUnheardRemovals(collection: string, records: Iterable<{ id: string; updated_at?: string }>): void {
    if (this.mutationListeners.size > 0 || this._mutationSource === 'server') return;
    const at = Date.now();
    for (const { id, updated_at } of records) {
      const key = `${collection}\u0000${id}`;
      const after = this.followedStamp(collection, id, updated_at);
      const removal = { collection, id, at, ...(after === undefined ? {} : { after }) };
      this.unheardRemovals.delete(key);
      this.unheardRemovals.set(key, removal);
      this.noteUnheard({ removal });
    }
    for (const key of this.unheardRemovals.keys()) {
      if (this.unheardRemovals.size <= XDBService.UNHEARD_REMOVALS_KEPT) break;
      this.unheardRemovals.delete(key);
    }
  }

  /**
   * The stamp of the first change this page made while no server sync client listened, or
   * null; taken by the client that starts listening, whose scan looks back to it as well as to
   * the store's mark of where listening last stopped. Another tab of the app moves that mark on
   * with its own saves, past what this page wrote before its client listened (an app writes
   * while the person is asked to allow sync, and while the client's module loads), and the scan
   * started after it: the change was never sent.
   */
  takeFirstUnheardChange(): number | null {
    const at = this.firstUnheard;
    this.firstUnheard = null;
    return at;
  }

  private noteUnheardChange(collection: string, recordId: string): void {
    if (this.firstUnheard !== null || this._mutationSource === 'server') return;
    // The record's stamp, which a scan by stamp finds it at: no later than now, and taken a
    // moment before the change is announced. Now, for a record no longer kept.
    let at = Date.now();
    try {
      const held = this.getAllCollectionData(collection).find((record) => record.id === recordId);
      const stamp = Date.parse(String(held?.updated_at));
      if (stamp < at) at = stamp;
    } catch {
      // Unreadable: the time now.
    }
    this.firstUnheard = at;
  }

  /**
   * The note of changes made while no server sync client listened, kept beside the records
   * (`sync-unheard`) by a store that has synced with a host: what the marks above keep for
   * this page, kept for the next page whose client starts. A page that wrote and closed before
   * its client listened left nothing the next could tell from a record heard from the host:
   * its edits went at their own stamps, without the offset on a device behind the host, and
   * an import's records, at the backup's older stamps, were not found at all. Each entry is
   * what was seen as it was made; the client sends it only while the record still is so
   * (`readUnheardNote`), and forgets it once the op is saved with the queue
   * (`forgetUnheardNote`). As much as the store takes, up to UNHEARD_NOTE_CHARS
   * (`writeUnheardNoteMaps`): it was cut at 64 KB, oldest first, and an import or a clear of
   * more than a few hundred records, of which the scan of stamps finds nothing, lost the rest.
   */
  private static readonly UNHEARD_NOTE = 'sync-unheard';
  private static readonly UNHEARD_NOTE_CHARS = 4 * 1024 * 1024;
  private unheardNotePending: UnheardNote | null = null;
  private unheardNoteScheduled = false;
  private syncedWithHost = false;

  /** Whether a server sync client has kept its marks here (positive answers are kept). */
  private hasSyncedWithHost(): boolean {
    if (this.syncedWithHost) return true;
    try {
      this.syncedWithHost = ['sync-watched', 'sync-queue', 'sync-pulled'].some((name) => this.readSyncMeta(name) !== null);
    } catch {
      // Unreadable: not yet.
    }
    return this.syncedWithHost;
  }

  private noteUnheard(change: { edit: UnheardEdit } | { removal: UnheardRemoval }): void {
    if (this._mutationSource === 'server' || !this.hasSyncedWithHost()) return;
    const pending = (this.unheardNotePending ??= { edits: new Map(), removals: new Map(), imports: new Map() });
    mergeUnheard(pending, change);
    if (this.unheardNoteScheduled) return;
    this.unheardNoteScheduled = true;
    // Written once for a batch, as the peer removals are.
    queueMicrotask(() => {
      this.unheardNoteScheduled = false;
      const changes = this.unheardNotePending;
      this.unheardNotePending = null;
      if (!changes) return;
      const note = this.readUnheardNoteMaps();
      for (const edit of changes.edits.values()) mergeUnheard(note, { edit });
      for (const removal of changes.removals.values()) mergeUnheard(note, { removal });
      this.writeUnheardNoteMaps(note);
    });
  }

  private readUnheardNoteMaps(): UnheardNote {
    const note: UnheardNote = { edits: new Map(), removals: new Map(), imports: new Map() };
    try {
      const saved = JSON.parse(this.readSyncMeta(XDBService.UNHEARD_NOTE) ?? 'null') as { e?: unknown; r?: unknown; i?: unknown } | null;
      for (const entry of Array.isArray(saved?.e) ? saved.e : []) {
        const [collection, id, stamp, kind, own, made, after] = Array.isArray(entry) ? entry : [];
        if (typeof collection !== 'string' || typeof id !== 'string' || typeof stamp !== 'string') continue;
        if (kind !== 'create' && kind !== 'update' && kind !== 'delete') continue;
        note.edits.set(`${collection}\u0000${id}`, {
          collection,
          id,
          stamp,
          kind,
          own: own === 1,
          ...(typeof made === 'number' ? { made } : {}),
          ...(typeof after === 'string' ? { after } : {}),
        });
      }
      // Removals made together kept together, [collection, at, after, [ids]]; one alone,
      // [collection, id, at, after], as the note kept them before.
      for (const entry of Array.isArray(saved?.r) ? saved.r : []) {
        if (!Array.isArray(entry) || typeof entry[0] !== 'string') continue;
        const collection = entry[0];
        const grouped = typeof entry[1] === 'number';
        const [at, after, ids] = grouped ? [entry[1], entry[2], entry[3]] : [entry[2], entry[3], [entry[1]]];
        if (typeof at !== 'number' || !Array.isArray(ids)) continue;
        for (const id of ids) {
          if (typeof id === 'string') note.removals.set(`${collection}\u0000${id}`, { collection, id, at, ...(typeof after === 'string' ? { after } : {}) });
        }
      }
      for (const entry of Array.isArray(saved?.i) ? saved.i : []) {
        const [collection, made] = Array.isArray(entry) ? entry : [];
        if (typeof collection === 'string' && typeof made === 'number') note.imports.set(collection, { collection, made });
      }
    } catch {
      // Unreadable: an empty note, and the scan of stamps finds what it can.
    }
    return note;
  }

  /**
   * Write the note, as much of it as the store takes. Past UNHEARD_NOTE_CHARS, or refused (an
   * app's records and notes share its budget of the browser's storage), what else finds goes
   * first: an edit in this device's time, which the scan of stamps finds at its stamp (without
   * the offset); then one made after a copy it followed, found the same way; then an import's
   * edits, kept as one mark of their collection (`UnheardImport`). Removals and deletions, of
   * which nothing is left to find, go last, oldest first, and only while the store refuses even
   * the rest.
   */
  private writeUnheardNoteMaps(note: UnheardNote): void {
    let edits = [...note.edits.values()];
    let removals = [...note.removals.values()];
    const imports = new Map(note.imports);
    const lasting = (e: UnheardEdit) => e.kind === 'delete';
    const imported = (e: UnheardEdit) => !lasting(e) && e.made !== undefined && e.after === undefined;
    const steps: Array<() => boolean> = [
      () => {
        const before = edits.length;
        edits = edits.filter((e) => lasting(e) || e.made !== undefined || e.after !== undefined);
        return edits.length < before;
      },
      () => {
        const before = edits.length;
        edits = edits.filter((e) => lasting(e) || imported(e));
        return edits.length < before;
      },
      () => {
        const marked = edits.filter(imported);
        for (const e of marked) {
          const kept = imports.get(e.collection);
          imports.set(e.collection, { collection: e.collection, made: Math.max(kept?.made ?? -Infinity, e.made!) });
        }
        edits = edits.filter((e) => !imported(e));
        return marked.length > 0;
      },
    ];
    for (;;) {
      if (this.tryWriteUnheardNote(edits, removals, imports)) return;
      const step = steps.shift();
      if (step) {
        step();
        continue;
      }
      // The oldest half of what is left goes, removals and deletions alike.
      const rest = edits.length + removals.length;
      if (rest === 0) return;
      const drop = Math.ceil(rest / 2);
      const kept = [...removals.map((r) => ({ at: r.at, r })), ...edits.map((e) => ({ at: e.made ?? stampTime(e.stamp), e }))]
        .sort((a, b) => a.at - b.at)
        .slice(drop);
      removals = kept.flatMap((k) => ('r' in k ? [k.r] : []));
      edits = kept.flatMap((k) => ('e' in k ? [k.e] : []));
    }
  }

  /** One try at writing the note (`writeUnheardNoteMaps`): false when it is too long or the store refuses it. */
  private tryWriteUnheardNote(edits: UnheardEdit[], removals: UnheardRemoval[], imports: Map<string, UnheardImport>): boolean {
    const e = edits.map((edit) => JSON.stringify([
      edit.collection, edit.id, edit.stamp, edit.kind, edit.own ? 1 : 0,
      ...(edit.after !== undefined ? [edit.made ?? null, edit.after] : edit.made !== undefined ? [edit.made] : []),
    ]));
    // Removals made together (a clear, an import replacing a collection) share their time.
    const groups = new Map<string, { collection: string; at: number; after: string | null; ids: string[] }>();
    for (const removal of removals) {
      const key = JSON.stringify([removal.collection, removal.at, removal.after ?? null]);
      const group = groups.get(key) ?? { collection: removal.collection, at: removal.at, after: removal.after ?? null, ids: [] };
      group.ids.push(removal.id);
      groups.set(key, group);
    }
    const r = [...groups.values()].map((g) => JSON.stringify([g.collection, g.at, g.after, g.ids]));
    const i = [...imports.values()].map((mark) => JSON.stringify([mark.collection, mark.made]));
    const value = e.length + r.length + i.length > 0 ? `{"v":1,"e":[${e.join(',')}],"r":[${r.join(',')}],"i":[${i.join(',')}]}` : null;
    if (value !== null && value.length > XDBService.UNHEARD_NOTE_CHARS) return false;
    try {
      this.writeSyncMeta(XDBService.UNHEARD_NOTE, value);
      return true;
    } catch {
      return false;
    }
  }

  /** The note of changes made while no client listened, for a server sync client to send. */
  readUnheardNote(): UnheardNoteRead {
    const note = this.readUnheardNoteMaps();
    return { edits: [...note.edits.values()], removals: [...note.removals.values()], imports: [...note.imports.values()] };
  }

  /**
   * Take from the note what a client read and has saved with its queue, each entry only while
   * it is still as read: one another tab wrote since for the same record is the next client's.
   */
  forgetUnheardNote(read: Partial<UnheardNoteRead>): void {
    const note = this.readUnheardNoteMaps();
    let changed = false;
    for (const edit of read.edits ?? []) {
      const key = `${edit.collection}\u0000${edit.id}`;
      const held = note.edits.get(key);
      if (held && sameStamp(held.stamp, edit.stamp) && held.kind === edit.kind) changed = note.edits.delete(key) || changed;
    }
    for (const removal of read.removals ?? []) {
      const key = `${removal.collection}\u0000${removal.id}`;
      if (note.removals.get(key)?.at === removal.at) changed = note.removals.delete(key) || changed;
    }
    for (const mark of read.imports ?? []) {
      if (note.imports.get(mark.collection)?.made === mark.made) changed = note.imports.delete(mark.collection) || changed;
    }
    if (changed) this.writeUnheardNoteMaps(note);
  }

  /**
   * notifyMutation, for an edit or a deletion in the native store's cache: not while the
   * record's own create is still with SQLite. Its id there is the optimistic one, which the
   * sync host never hears of (it refused the change as not found, and the person was told a
   * change was not taken); the create callback tells the record as it then is, under the id
   * SQLite gave it, edits and all, and nothing of one deleted first.
   */
  private notifyMutationLanded(type: 'update' | 'delete', collection: string, recordId: string, data?: Record<string, unknown>): void {
    if (this.pendingCreateIds.has(recordId)) {
      this.editedAfter.delete(`${collection}\u0000${recordId}`);
      return;
    }
    this.notifyMutation(type, collection, recordId, data);
  }

  /** Notify mutation listeners (called internally after create/update/delete). */
  private notifyMutation(type: string, collection: string, recordId: string, data?: Record<string, unknown>): void {
    const key = `${collection}\u0000${recordId}`;
    const after = this.editedAfter.get(key);
    if (after !== undefined) this.editedAfter.delete(key);
    const given = this.givenStamp.get(key);
    if (given !== undefined) this.givenStamp.delete(key);
    // Server sync is the one listener.
    if (this.mutationListeners.size === 0) {
      this.noteUnheardChange(collection, recordId);
      if (given && (type === 'create' || type === 'update' || type === 'delete')) {
        // As a listening client queues it: made now, in this device's time, and after the copy
        // it followed. Noted at its stamp alone, an edit of a copy ahead of this clock (the
        // stamp just after it) went at that stamp, without the offset, on a device behind the
        // host older than edits other devices made meanwhile.
        const followed = after === undefined ? {} : { made: Date.now(), after };
        this.noteUnheard({ edit: { collection, id: recordId, stamp: given.stamp, kind: type, own: given.own || after !== undefined, ...followed } });
      }
      return;
    }
    const event = { type, collection, recordId, data, source: this._mutationSource, ...(after !== undefined ? { after } : {}) };
    for (const listener of this.mutationListeners) {
      try { listener(event); } catch { /* ignore */ }
    }
  }

  /**
   * Upsert a record from the server (doesn't trigger push back to server).
   *
   * `keepLocalDelete` is for a record this device has deleted and the server
   * has not yet answered that delete for: the record stays deleted here, as
   * the server will have it once the delete lands. Otherwise the record is
   * what the server says it is, a live record. The host weighs a delete by
   * when it was made and keeps a record changed after it, sending the pusher
   * the record as it stands; a tombstone kept whatever the server said hid
   * that record on this device for good.
   */
  upsertFromServer(
    collection: string,
    record: {
      id: string;
      collection: string;
      data: Record<string, unknown>;
      createdAt: string;
      updatedAt: string;
    },
    keepLocalDelete = false
  ): void {
    // An update delta carries no creation time, so it comes from the row
    // already here. Without this, `created_at` was restamped to now — a
    // record edited on another device jumped position in any list sorted by
    // it. Deliberately not `get()`, which hides soft-deleted rows — the
    // deleted ones are a case this has to see.
    const existing = this.getAllCollectionData(collection).find((r) => r.id === record.id);
    const xdbRecord = this.fromServer(collection, record, keepLocalDelete, existing);
    if (!xdbRecord) return;
    // Restored however the write ends: a write that threw (a full disk) left
    // it set, and every local edit after it was taken for the server's and
    // never pushed.
    this._mutationSource = 'server';
    try {
      this.writeRecord(collection, xdbRecord);
      this.notifyMutation('upsert', collection, record.id, record.data);
    } finally {
      this._mutationSource = undefined;
    }
  }

  /**
   * `upsertFromServer` for the records of one pull of a collection: the
   * collection read once and written once (writeRecords), where each record
   * read and wrote it whole, and on the desktop was a native call that
   * rewrote the collection's stored document, so a first pull of thousands
   * of records cost as many rewrites of all of them. All or none: a write
   * the store refuses throws, as writeRecords does.
   */
  upsertManyFromServer(
    collection: string,
    entries: ReadonlyArray<{ record: Parameters<XDBService['upsertFromServer']>[1]; keepLocalDelete: boolean }>
  ): void {
    if (entries.length === 0) return;
    const held = new Map(this.getAllCollectionData(collection).map((r) => [r.id, r]));
    const list: XDBRecord[] = [];
    for (const { record, keepLocalDelete } of entries) {
      const xdbRecord = this.fromServer(collection, record, keepLocalDelete, held.get(record.id));
      if (!xdbRecord) continue;
      held.set(record.id, xdbRecord);
      list.push(xdbRecord);
    }
    if (list.length === 0) return;
    this._mutationSource = 'server';
    try {
      this.writeRecords(collection, list);
      for (const record of list) this.notifyMutation('upsert', collection, record.id, record.data);
    } finally {
      this._mutationSource = undefined;
    }
  }

  /** A record from the sync host as written here, or null when it is not to be written. */
  private fromServer(
    collection: string,
    record: Parameters<XDBService['upsertFromServer']>[1],
    keepLocalDelete: boolean,
    existing: XDBRecord | undefined
  ): XDBRecord | null {
    // Removed here for good (`hardDelete`) and not yet answered: there is no
    // row to keep deleted, and writing one brought the record back to life.
    if (keepLocalDelete && !existing) return null;
    // Not taken on the desktop when its native store cannot read it (a field
    // named as Tauri's IPC's own, at any depth): the write failed after the
    // cache had it, and the store said its writes were failing.
    if (this.useTauri && !readableByNative(record.data, 1)) {
      console.warn(`[XDB] A record from the sync host was not kept: the desktop's store cannot hold "${record.id}" of "${collection}".`);
      return null;
    }
    return {
      id: record.id,
      // The collection it is written to, whatever the server's copy says: a
      // record of `notes` naming `secrets` was written there by a store that
      // writes by the record's own (the desktop's), into a collection the
      // server was never given.
      collection,
      data: record.data,
      created_at: record.createdAt || existing?.created_at || new Date().toISOString(),
      updated_at: record.updatedAt || new Date().toISOString(),
      deleted: keepLocalDelete && existing?.deleted === true,
    };
  }

  /**
   * Delete a record from the server (doesn't trigger push back to server).
   */
  deleteFromServer(collection: string, recordId: string): void {
    this._mutationSource = 'server';
    try {
      this.removeRecord(collection, recordId);
      this.notifyMutation('delete', collection, recordId);
    } finally {
      this._mutationSource = undefined;
    }
  }

  /** `deleteFromServer` for many records of one collection, removed at once (`removeRecords`). */
  deleteManyFromServer(collection: string, recordIds: readonly string[]): void {
    if (recordIds.length === 0) return;
    this._mutationSource = 'server';
    try {
      this.removeRecords(collection, recordIds);
      for (const id of recordIds) this.notifyMutation('delete', collection, id);
    } finally {
      this._mutationSource = undefined;
    }
  }

  /**
   * What server sync keeps beside the records between page loads: the
   * changes made here that the server has not answered yet, and where its
   * last pull of each collection ended. Kept in this store's own storage,
   * so each app has its own and it goes wherever the app's records go, under
   * a key no collection can have (a collection name has no colon).
   */
  readSyncMeta(name: string): string | null {
    try {
      return this.storage.getItem(this.metaKey(name));
    } catch {
      return null;
    }
  }

  /** Save (or, with null, remove) what `readSyncMeta` reads. Throws when the storage refuses it. */
  writeSyncMeta(name: string, value: string | null): void {
    this.writeMeta(name, value);
  }

  private metaKey(name: string): string {
    return `${this.prefix}::${name}`;
  }

  /** A write beside the records, by the path record writes take and counted against the same budget. */
  private writeMeta(name: string, value: string | null): void {
    if (this.destroyed && this.storagePersistence) return;
    const key = this.metaKey(name);
    if (this.storagePersistence?.protocol === 1) {
      this.hostedWrite(value === null ? this.storagePersistence.removeItem(key) : this.storagePersistence.setItem(key, value), []);
      return;
    }
    if (value === null) {
      this.storage.removeItem(key);
      this.budget?.removed(key);
      return;
    }
    this.budget?.admit(key, value);
    this.storage.setItem(key, value);
    this.budget?.wrote(key, value);
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
        // Nor is the copy of a damaged collection kept beside it
        // (recordCorruption). Read as a collection, it was found damaged
        // too and copied again, so every export, update or delete by id
        // left one more copy behind until the storage was full.
        if (QUARANTINE_COPY.test(collection)) continue;
        keys.push(collection);
      }
      return keys;
    }

    // A storage that cannot list its keys: the collections it has stored
    // (storedIndex), and any this page has touched.
    if (this.useTauri) return Array.from(this.knownCollections);
    return [...new Set([...this.knownCollections, ...this.storedIndex()])];
  }

  /**
   * Clear all data in a collection
   */
  clear(collection: string): void {
    assertCollectionName(collection);
    this.assertWritable(collection, true);
    // Server sync is told of each record this removes, as of any delete. It
    // heard nothing: the server kept the records, and the next pull brought
    // every one of them back. And every record it takes, deleted ones too, is
    // kept for a sync room that is not open, as hardDeleteMany keeps them: none
    // was, and the room's copies came back at its next opening.
    let held: XDBRecord[];
    if (this.useTauri) {
      const cached = [...(this.memoryStore.get(collection)?.values() ?? [])];
      // A record still being created goes too, as hardDelete takes one: its
      // create callback removes the row SQLite writes, and neither puts it back
      // in the cache nor announces it, which brought it back after the clear.
      for (const record of cached) if (this.pendingCreateIds.has(record.id)) this.abandonedCreates.add(record.id);
      held = cached.filter((r) => !this.pendingCreateIds.has(r.id));
      this.memoryStore.delete(collection);
      this.knownCollections.delete(collection);
      this.emit({ type: 'refresh', collection, records: [] });
      // Persist to SQLite backend
      this.native<boolean>('clear_collection', { collection })
        .then(() => this.nativeWriteLanded(collection))
        .catch((err) => this.nativeWriteFailed('clear a collection', collection, err));
    } else {
      held = this.getAllCollectionData(collection);
      if (this.storagePersistence?.protocol === 1) this.hostedWrite(this.storagePersistence.removeItem(this.collectionKey(collection)), [collection]);
      else {
        this.storage.removeItem(this.collectionKey(collection));
        this.budget?.removed(this.collectionKey(collection));
        if (this.storagePersistence) this.unsupportedPersistence(collection);
      }
      this.indexCollection(collection, false);
      this.emit({ type: 'refresh', collection, records: [] });
    }
    for (const record of held) this.noteRemovedForGood(collection, record.id);
    this.noteUnheardRemovals(collection, held);
    for (const record of held) {
      if (record.deleted) continue;
      this.noteEditedAfter(collection, record.id, record.updated_at);
      this.notifyMutation('delete', collection, record.id);
    }
  }

  /**
   * Clear all XDB data
   */
  clearAll(): void {
    const collections = this.getAllCollectionKeys().filter(isCollectionName);
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
          debug(`[XDB] Requested P2P sync for collection: ${collection}`);
        } else {
          // Sync all collections in batches to avoid flooding IPC/network
          const collections = await tauriInvoke<string[]>('get_collections', this.tauriArgs());
          const BATCH_SIZE = 5;
          for (let i = 0; i < collections.length; i += BATCH_SIZE) {
            const batch = collections.slice(i, i + BATCH_SIZE);
            await Promise.all(batch.map((col) => this.native<boolean>('request_sync', { collection: col })));
          }
          debug(`[XDB] Requested P2P sync for all ${collections.length} collections`);
        }
      } catch (err) {
        console.error('[XDB] Failed to request sync:', err);
      }
      return;
    }

    // localStorage fallback - just emit events
    debug('[XDB] Sync requested (localStorage mode - no P2P)');
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

  /**
   * What an import changed in a collection, said as the writes it amounts
   * to: a record new here a create, one changed an update, one gone (a
   * replacement drops what the backup does not hold) a delete. An import
   * said only `refresh`, which server sync does not hear, so an import or a
   * restore stayed on the device it was made on, and the next pull took it
   * back. A record that was here goes as an update, which the host weighs by
   * its time and keeps; one new here as a create, which the host keeps its
   * own copy of where it has one.
   */
  private announceImport(collection: string, before: XDBRecord[], after: XDBRecord[]): void {
    if (this.mutationListeners.size === 0) {
      // What a replacement took away, kept for the client that starts, as any removal made
      // while nothing listens is: it left no tombstone, and the first pull brought it back.
      // Deleted ones too, as clear keeps them: a deletion made while nothing listened, then
      // taken away with its tombstone, was neither found nor sent.
      const now = new Set(after.map((record) => record.id));
      this.noteUnheardRemovals(collection, before.filter((record) => !now.has(record.id)));
      // And what it made or changed, as a client hears it (below): an edit made now, by this
      // clock. The records keep the backup's stamps, older than the store's marks, and the
      // client's scan of stamps never found them.
      const was = new Map(before.map((record) => [record.id, record]));
      const made = Date.now();
      for (const record of after) {
        const previous = was.get(record.id);
        const live = previous !== undefined && !previous.deleted;
        const kind = record.deleted ? (live ? 'delete' : null) : !live ? 'create' : JSON.stringify(previous.data) !== JSON.stringify(record.data) ? 'update' : null;
        if (kind) this.noteUnheard({ edit: { collection, id: record.id, stamp: record.updated_at, kind, own: true, made } });
      }
      return;
    }
    const was = new Map(before.map((record) => [record.id, record]));
    const now = new Set<string>();
    for (const record of after) {
      now.add(record.id);
      const previous = was.get(record.id);
      const live = previous !== undefined && !previous.deleted;
      if (record.deleted) {
        if (live) this.notifyMutation('delete', collection, record.id);
      } else if (!live) {
        this.notifyMutation('create', collection, record.id, record.data);
      } else if (JSON.stringify(previous.data) !== JSON.stringify(record.data)) {
        this.notifyMutation('update', collection, record.id, record.data);
      }
    }
    for (const [id, previous] of was) {
      if (!now.has(id) && !previous.deleted) this.notifyMutation('delete', collection, id);
    }
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
      if (this.destroyed && this.storagePersistence) throw new XDBStorageError('write-failed', 'This storage owner has been released.');
      if (this.storagePersistence?.protocol === 0) throw new XDBStorageError('persistence-unsupported', 'This hosted parent does not support acknowledged batch saving; nothing was changed.');
      // Phase 1: read and prepare everything. Nothing is written yet, so a
      // failure here (an unreadable key, a corrupt previous value) leaves
      // every collection exactly as it was.
      const prepared: Array<{ collection: string; previous: string | null; before: XDBRecord[]; records: XDBRecord[] }> = [];
      for (const plan of plans) {
        try {
          const previous = this.storage.getItem(this.collectionKey(plan.collection));
          const before = this.getAllCollectionData(plan.collection);
          const records = XDBService.mergePlan(before, plan);
          prepared.push({ collection: plan.collection, previous, before, records });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new XDBStorageError(
            error instanceof XDBStorageError ? error.kind : 'corrupt',
            `Import refused at "${plan.collection}" while reading its current contents (${message}); nothing was changed.`,
            plan.collection
          );
        }
      }
      if (this.storagePersistence?.protocol === 1) {
        // The adapter validates the whole wire input and candidate parent map
        // before touching any key. Never split a refused import or compensate
        // an asynchronous failure by overwriting subsequent edits.
        const replacements = prepared.map(plan => ({ key: this.collectionKey(plan.collection), value: JSON.stringify(plan.records) }));
        importedCollections.push(...prepared.map(plan => plan.collection));
        const persistedCollections = [...importedCollections];
        const completion = replacements.length === 0
          ? Promise.resolve()
          : this.hostedWrite(this.storagePersistence.replaceBatch(replacements), persistedCollections);
        for (const plan of prepared) {
          this.knownCollections.add(plan.collection);
          this.acknowledged.delete(plan.collection);
          this.emit({ type: 'refresh', collection: plan.collection, records: this.getCollectionData(plan.collection) });
          this.announceImport(plan.collection, plan.before, plan.records);
        }
        const persisted = completion.then(() => ({ backend: 'storage' as const, collections: [...persistedCollections], imported, tombstoned: 0 }));
        // Synchronous import/restore may ignore durable completion safely;
        // async callers still receive the original rejecting promise.
        persisted.catch(() => {});
        return { imported, collections: importedCollections, persisted };
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
              const key = this.collectionKey(entry.collection);
              if (entry.previous === null) {
                this.storage.removeItem(key);
                this.budget?.removed(key);
              } else {
                this.storage.setItem(key, entry.previous);
                this.budget?.wrote(key, entry.previous);
              }
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
      // Said once every collection is written: a failure part-way puts the
      // earlier ones back, and what was put back was never imported.
      for (const plan of prepared) this.announceImport(plan.collection, plan.before, plan.records);
      return {
        imported,
        collections: importedCollections,
        persisted: Promise.resolve({ backend: this.persistent ? 'storage' : 'memory', collections: importedCollections, imported, tombstoned: 0 }),
      };
    }

    // The refusals of import_records known here, made before anything
    // changes: the native store answers after the cache below has changed and
    // sync has been told of the import, so a refusal there left the import in
    // the room and on the sync server, a replacement's dropped records
    // dropped with it, and the next sync brought them back here. These are
    // the refusals it is known to make, not every one it can: one not
    // foreseen here, or a native failure after this (a full disk), still
    // leaves the import sent. A record must be one its native shape takes,
    // with a real id, of the collection it is imported into; and records are kept by id alone,
    // so not a live record of another collection (a deleted one it writes
    // over), here or earlier in this import: which the cache can say only
    // once every collection has loaded (not while one is still loading, nor
    // after one failed to).
    if (!this.isHydrated()) {
      throw new XDBStorageError('unhydrated', 'Import refused: the native database has not finished loading, and a record not yet loaded could be one this import holds. Wait for it, or retry loading; nothing was changed.');
    }
    // Every collection that holds each id live: a peer's record the native
    // store refused stays in the cache under its own collection beside the
    // one that really holds it.
    const owners = new Map<string, Set<string>>();
    const own = (id: string, collection: string) => {
      let held = owners.get(id);
      if (!held) owners.set(id, (held = new Set()));
      held.add(collection);
    };
    for (const [collection, coll] of this.memoryStore) {
      for (const [id, record] of coll) if (!record.deleted) own(id, collection);
    }
    for (const plan of plans) {
      if (isBlankToRust(plan.collection) || !readableByNative(plan.collection, 0)) {
        throw new XDBStorageError('invalid-data', 'Import refused: a collection has no name, or one the native store cannot read; nothing was changed.');
      }
      for (const record of plan.records) {
        const elsewhere = [...(owners.get(record.id) ?? [])].find((collection) => collection !== plan.collection);
        const refusal = nativeImportRefusal(record, plan.collection)
          ?? (elsewhere !== undefined ? `is a record of "${elsewhere}" here` : null);
        if (refusal !== null) {
          throw new XDBStorageError('invalid-data', `Import refused: record "${record.id}" for "${plan.collection}" ${refusal}; nothing was changed.`, plan.collection);
        }
        if (!record.deleted) own(record.id, plan.collection);
      }
    }
    // Each collection's cache as the import found it, for a refusal to put back.
    const untouched = new Map<string, Map<string, XDBRecord>>();
    for (const plan of plans) {
      const before = this.getAllCollectionData(plan.collection);
      const after = XDBService.mergePlan(before, plan);
      untouched.set(plan.collection, new Map(this.memoryStore.get(plan.collection) ?? []));
      this.setCollectionData(plan.collection, after);
      importedCollections.push(plan.collection);
      this.emit({ type: 'refresh', collection: plan.collection, records: this.getCollectionData(plan.collection) });
      this.announceImport(plan.collection, before, after);
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
            // From the cache as it was before the import: reloaded over the
            // import, the merge below kept what it had deleted and what it
            // stamped newer, neither of which the native store holds.
            const was = untouched.get(collection);
            if (was) this.memoryStore.set(collection, was);
            try { await this.getAllAsync(collection); } catch { /* the hydration issue is already recorded */ }
            this.emit({ type: 'refresh', collection, records: this.getCollectionData(collection), reload: true });
          }
          throw err instanceof Error ? err : new Error(String(err));
        });
    return { imported, collections: importedCollections, persisted };
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
