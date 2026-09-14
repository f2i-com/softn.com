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
//                write hit a quota error; other collections keep working
//   memory-only  browser storage is inaccessible; nothing survives a reload
//   failed       native hydration failed as a whole (retryable)

export type XDBStorageState = 'loading' | 'ready' | 'degraded' | 'memory-only' | 'failed';
export type XDBStorageIssueKind =
  | 'inaccessible'
  | 'corrupt'
  | 'quota'
  | 'hydration-failed'
  | 'migration-incomplete'
  /** A native (SQLite) write the synchronous API had already answered for was refused; the in-memory record and the database disagree. */
  | 'write-failed';

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
