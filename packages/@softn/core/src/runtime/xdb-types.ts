/**
 * The XDB service's public types: events, query options, storage, status,
 * network, import and export shapes. Every name here is re-exported from
 * ./xdb, which is the path everything imports them from.
 */

import type { XDBRecord } from '../types';

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
  /**
   * On a `delete`: the record was removed for good (`hardDelete`), not
   * marked deleted. `record` is the record as it was, which may itself be a
   * deleted one: a record moved to the trash first, then emptied from it.
   */
  removed?: boolean;
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
  /** Hosted storage advertises its actual parent acknowledgment capability. */
  acknowledgedPersistence?: AcknowledgedStoragePersistence;
}

export type StorageWriteState = 'pending' | 'confirmed' | 'failed' | 'unknown';

/** One immutable operation identity; a late reply can update state, not re-resolve completion. */
export interface StorageWriteReceipt {
  readonly generation: string;
  readonly sequence: number;
  readonly completion: Promise<void>;
  readonly state: StorageWriteState;
}

export interface StoragePersistenceStatus {
  protocol: 0 | 1;
  pendingWrites: number;
  failedWrites: number;
  unknownWrites: number;
  disposed: boolean;
}

interface StoragePersistenceObserver {
  getStatus(): StoragePersistenceStatus;
  subscribe(listener: (status: StoragePersistenceStatus) => void): () => void;
  /** Settlement of the finite set pending at this call; does not assert success. */
  whenIdle(): Promise<void>;
}

export type AcknowledgedStoragePersistence =
  | (StoragePersistenceObserver & { readonly protocol: 0 })
  | (StoragePersistenceObserver & {
      readonly protocol: 1;
      /** Admission preflight precedes optimistic cache mutation. */
      setItem(key: string, value: string): StorageWriteReceipt;
      removeItem(key: string): StorageWriteReceipt;
      /** Preflight and admit one parent-map commit before changing any cache key. */
      replaceBatch(replacements: readonly { key: string; value: string }[]): StorageWriteReceipt;
      /** Success for a captured finite set; sticky failed/unknown work rejects it. */
      captureBarrier(): Promise<void>;
    });

/** What `create` may be told beyond the data. */
export interface XDBCreateOptions {
  /**
   * The id the caller would like the record to have. Honoured when it names
   * nothing in the collection yet; otherwise a fresh id is generated, as
   * without the option. On the native backend it is the optimistic id only:
   * SQLite assigns the stored id and the service maps one to the other.
   */
  id?: string;
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
//                write hit a quota error, or a hosted save failed, has an
//                unknown outcome or cannot be confirmed (a FormLogic parent
//                without acknowledged storage); other collections keep working
//   memory-only  browser storage is inaccessible; nothing survives a reload
//   failed       native hydration failed as a whole (retryable)

export type XDBStorageState = 'loading' | 'ready' | 'degraded' | 'memory-only' | 'failed';
export type XDBStorageIssueKind =
  | 'inaccessible'
  | 'corrupt'
  | 'quota'
  | 'hydration-failed'
  | 'migration-incomplete'
  /** A hosted save was sent and not answered: whether the parent made it is unknown until it answers or the app is opened again. */
  | 'write-unknown'
  /** The hosted parent cannot acknowledge saves (no storage protocol 1): records are cached, and no save can be reported as made. */
  | 'persistence-unsupported'
  /** A write the synchronous API had already answered for was refused, by the native database (SQLite) or by the hosted parent; the in-memory record and the stored one disagree. */
  | 'write-failed'
  /** The sync host refused a change, or it could never be sent: it is on this device only, or the host has put the record back as it stands there. */
  | 'sync-refused';

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
  /** Whether writes reach durable storage: false for memory-only operation, and in a hosted frame unless the parent acknowledges saves. */
  persistent: boolean;
  /** Whether every collection was read from the backend successfully. */
  hydrated: boolean;
  /** Native operations plus shared hosted-storage writes not yet settled. Unknown writes are reported separately. */
  pendingWrites: number;
  /** Hosted adapter state, including writes made directly by the app's Storage API. */
  persistence?: StoragePersistenceStatus;
  issues: XDBStorageIssue[];
}

/**
 * Thrown instead of silently replacing damaged or unloaded data. `invalid-data`
 * is a record whose data JSON cannot hold (a cycle, a BigInt, nesting too
 * deep): refused before anything is written, and no fault of the storage.
 */
export class XDBStorageError extends Error {
  constructor(
    public readonly kind: XDBStorageIssueKind | 'unhydrated' | 'invalid-data',
    message: string,
    public readonly collection?: string
  ) {
    super(message);
    this.name = 'XDBStorageError';
  }
}

/** An import result whose durable completion has already been awaited. */
export type XDBDurableImportResult = Omit<XDBImportResult, 'persisted'> & { persisted: XDBPersistResult };

export interface XDBPersistResult {
  backend: 'native' | 'storage' | 'memory';
  collections: string[];
  imported: number;
  tombstoned: number;
}

/** Honest native network status (audit XD-01/XD-02); see docs/engineering/xdb/networking-and-restore-policy.md. */
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
