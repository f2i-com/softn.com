//! Read-pool + write-singleton wrapper around XDB's SharedDb.
//!
//! SQLite in WAL mode supports many concurrent readers but only one writer.
//! This module mirrors that model: writes go through the existing Mutex<XdbDatabase>,
//! while reads use an r2d2 pool of read-only connections for true concurrency.

use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::{params, OpenFlags};
use std::path::PathBuf;
use xdb::{DbError, Record, SharedDb, XdbDatabase};

/// Thread-safe DB handle with separate read pool and write lock.
/// Read operations use the pool (concurrent), writes lock the singleton.
#[derive(Clone)]
pub struct ServerDb {
    writer: SharedDb,
    read_pool: Pool<SqliteConnectionManager>,
}

impl ServerDb {
    /// Create a ServerDb wrapping an existing SharedDb.
    /// Opens a separate read-only connection pool to the same SQLite file.
    pub fn new(writer: SharedDb, db_path: &PathBuf, read_pool_size: u32) -> Result<Self, String> {
        let manager = SqliteConnectionManager::file(db_path)
            .with_flags(
                OpenFlags::SQLITE_OPEN_READ_ONLY
                    | OpenFlags::SQLITE_OPEN_NO_MUTEX
                    | OpenFlags::SQLITE_OPEN_URI,
            )
            .with_init(|c| {
                c.execute_batch(
                    "PRAGMA journal_mode = WAL;
                     PRAGMA synchronous = NORMAL;
                     PRAGMA busy_timeout = 5000;",
                )
            });

        let read_pool = Pool::builder()
            .max_size(read_pool_size)
            .min_idle(Some(1))
            // Don't close idle connections — avoids WAL checkpoint disruption
            // from rapid connect/disconnect cycles.
            .idle_timeout(None)
            // Gently recycle connections after 30 minutes so all read locks are
            // periodically dropped, allowing SQLite to fully checkpoint the WAL
            // back into the main database file. Without this, continuous
            // overlapping reads can hold locks on old WAL frames indefinitely,
            // causing unbounded WAL growth under sustained traffic.
            .max_lifetime(Some(std::time::Duration::from_secs(30 * 60)))
            .build(manager)
            .map_err(|e| format!("Failed to create read pool: {}", e))?;

        // Schema migrations and index creation for sync queries.
        {
            let idx_conn = rusqlite::Connection::open(db_path)
                .map_err(|e| format!("Failed to open DB for indexing: {}", e))?;
            idx_conn.execute_batch("PRAGMA busy_timeout = 5000;")
                .map_err(|e| format!("Failed to set busy_timeout: {}", e))?;

            // Legacy index (kept for non-sync queries that filter by updated_at)
            idx_conn.execute_batch(
                "CREATE INDEX IF NOT EXISTS idx_records_sync \
                 ON records (collection, updated_at, id);"
            ).map_err(|e| format!("Failed to create sync index: {}", e))?;

            // Add server_received_at column for sync cursor pagination.
            // This separates the sync pull cursor (server_received_at, monotonically
            // increasing) from LWW conflict resolution (updated_at, may be a past
            // timestamp from offline edits). Without this, a client that goes offline,
            // edits a record on Monday, and reconnects Wednesday would have its Monday
            // timestamp accepted — but other clients whose lastSync cursor is Tuesday
            // would permanently miss the edit (WHERE updated_at > Tuesday skips Monday).
            // ALTER TABLE ADD COLUMN has no IF NOT EXISTS — ignore the error on re-run.
            let _ = idx_conn.execute_batch(
                "ALTER TABLE records ADD COLUMN server_received_at TEXT"
            );

            // Triggers: auto-set server_received_at on every write.
            // INSERT trigger: fires when a new row is inserted (including INSERT OR
            // REPLACE used by xdb's upsert_record). The WHEN clause checks for NULL
            // so explicitly-provided values are preserved.
            // UPDATE trigger: fires when data/updated_at/deleted change (all xdb write
            // paths). Does NOT fire when only server_received_at changes, preventing
            // trigger chains.
            idx_conn.execute_batch(
                "CREATE TRIGGER IF NOT EXISTS trg_server_received_at_insert \
                 AFTER INSERT ON records \
                 WHEN NEW.server_received_at IS NULL \
                 BEGIN \
                   UPDATE records SET server_received_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id; \
                 END; \
                 \
                 CREATE TRIGGER IF NOT EXISTS trg_server_received_at_update \
                 AFTER UPDATE OF data, updated_at, deleted ON records \
                 BEGIN \
                   UPDATE records SET server_received_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id; \
                 END;"
            ).map_err(|e| format!("Failed to create server_received_at triggers: {}", e))?;

            // Backfill existing rows that predate the migration.
            // Uses updated_at as a reasonable approximation — these records were written
            // before the column existed, so their "server received" time ≈ updated_at.
            idx_conn.execute_batch(
                "UPDATE records SET server_received_at = updated_at WHERE server_received_at IS NULL"
            ).map_err(|e| format!("Failed to backfill server_received_at: {}", e))?;

            // Index for sync_pull cursor queries (collection, server_received_at, id).
            idx_conn.execute_batch(
                "CREATE INDEX IF NOT EXISTS idx_records_sync_received \
                 ON records (collection, server_received_at, id);"
            ).map_err(|e| format!("Failed to create sync_received index: {}", e))?;
        }

        Ok(Self { writer, read_pool })
    }

    /// Lock the writer for mutations (create, update, delete).
    /// Recovers from poisoned locks to avoid permanent failure after a thread
    /// panic. This is safe because XdbDatabase wraps SQLite, which automatically
    /// rolls back any uncommitted transaction when the connection is next used.
    /// The in-memory CRDT `docs` cache is not used by softn-server's sync path.
    pub fn write(&self) -> std::sync::MutexGuard<'_, XdbDatabase> {
        self.writer.lock().unwrap_or_else(|poisoned| {
            tracing::warn!(
                "Writer mutex was poisoned by a panicked thread — recovering. \
                 SQLite will auto-rollback any uncommitted transaction."
            );
            poisoned.into_inner()
        })
    }

    /// Get a read-only connection from the pool.
    pub fn read(
        &self,
    ) -> Result<r2d2::PooledConnection<SqliteConnectionManager>, String> {
        self.read_pool
            .get()
            .map_err(|e| format!("Read pool error: {}", e))
    }

    /// Get the underlying SharedDb (for code that still needs direct access).
    #[allow(dead_code)]
    pub fn shared(&self) -> &SharedDb {
        &self.writer
    }
}

// ── Standalone read queries (don't need XdbDatabase, just a Connection) ──

/// Extended record with server-assigned receipt timestamp for sync cursors.
/// `server_received_at` is set by the server (via SQLite trigger) at the exact
/// moment a row is written, regardless of what `updated_at` contains. Sync pull
/// uses `server_received_at` as the pagination cursor instead of `updated_at`
/// to prevent "lost updates" when clients push offline edits with past timestamps.
pub struct SyncRecord {
    pub id: String,
    pub collection: String,
    pub data: serde_json::Value,
    pub created_at: String,
    pub updated_at: String,
    pub server_received_at: String,
    pub deleted: bool,
}

/// Maximum rows returned by read_collection to prevent unbounded memory usage
/// from collections with millions of rows. This bounds both RAM consumption
/// (each row is deserialized to serde_json::Value) and the time a worker thread
/// is blocked on a query, preventing worker pool exhaustion from pathological reads.
const MAX_COLLECTION_ROWS: i64 = 10_000;

/// Query a single record by ID using a read-only connection.
pub fn read_record(conn: &rusqlite::Connection, id: &str) -> Result<Record, DbError> {
    conn.query_row(
        "SELECT id, collection, data, created_at, updated_at, deleted FROM records WHERE id = ?1",
        params![id],
        |row| {
            let raw_data = row.get::<_, String>(2)?;
            Ok(Record {
                id: row.get(0)?,
                collection: row.get(1)?,
                data: serde_json::from_str(&raw_data).unwrap_or_else(|e| {
                    tracing::warn!("Invalid JSON in record data: {}", e);
                    serde_json::Value::Null
                }),
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
                deleted: row.get::<_, i32>(5)? != 0,
            })
        },
    )
    .map_err(|_| DbError::NotFound(id.to_string()))
}

/// Query records in a collection received after `since` (incremental sync).
/// Includes soft-deleted records so clients can remove them locally.
///
/// Uses `server_received_at` (server-assigned on write) instead of `updated_at`
/// (client-provided) for the pagination cursor. This prevents "lost updates"
/// when clients push offline edits with past timestamps: a record created offline
/// on Monday and pushed on Wednesday gets `server_received_at = Wednesday`, so
/// other clients with `lastSync = Tuesday` correctly pick it up.
///
/// Uses a compound cursor (server_received_at, id) to handle timestamp ties: if a
/// bulk operation updates >10k records in the same millisecond, a strictly
/// `server_received_at > ?` cursor would permanently miss records sharing the last
/// timestamp. The compound cursor ensures deterministic pagination.
pub fn read_collection_since(
    conn: &rusqlite::Connection,
    collection: &str,
    since: &str,
    last_id: Option<&str>,
) -> Result<Vec<SyncRecord>, DbError> {
    // Compound cursor: (server_received_at > since) OR (server_received_at = since AND id > last_id)
    // When last_id is None (first pull), fall back to the simpler server_received_at > since.
    if let Some(lid) = last_id {
        let mut stmt = conn.prepare(
            "SELECT id, collection, data, created_at, updated_at, deleted, server_received_at \
             FROM records WHERE collection = ?1 \
             AND (server_received_at > ?2 OR (server_received_at = ?2 AND id > ?3)) \
             ORDER BY server_received_at ASC, id ASC LIMIT ?4",
        )?;
        let records = stmt.query_map(params![collection, since, lid, MAX_COLLECTION_ROWS], |row| {
                let raw_data = row.get::<_, String>(2)?;
                Ok(SyncRecord {
                    id: row.get(0)?,
                    collection: row.get(1)?,
                    data: serde_json::from_str(&raw_data).unwrap_or_else(|e| {
                        tracing::warn!("Invalid JSON in record data: {}", e);
                        serde_json::Value::Null
                    }),
                    created_at: row.get(3)?,
                    updated_at: row.get(4)?,
                    deleted: row.get::<_, i32>(5)? != 0,
                    server_received_at: row.get::<_, Option<String>>(6)?
                        .unwrap_or_default(),
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(records)
    } else {
        let mut stmt = conn.prepare(
            "SELECT id, collection, data, created_at, updated_at, deleted, server_received_at \
             FROM records WHERE collection = ?1 AND server_received_at > ?2 \
             ORDER BY server_received_at ASC, id ASC LIMIT ?3",
        )?;
        let records = stmt.query_map(params![collection, since, MAX_COLLECTION_ROWS], |row| {
                let raw_data = row.get::<_, String>(2)?;
                Ok(SyncRecord {
                    id: row.get(0)?,
                    collection: row.get(1)?,
                    data: serde_json::from_str(&raw_data).unwrap_or_else(|e| {
                        tracing::warn!("Invalid JSON in record data: {}", e);
                        serde_json::Value::Null
                    }),
                    created_at: row.get(3)?,
                    updated_at: row.get(4)?,
                    deleted: row.get::<_, i32>(5)? != 0,
                    server_received_at: row.get::<_, Option<String>>(6)?
                        .unwrap_or_default(),
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(records)
    }
}

/// Query all non-deleted records in a collection using a read-only connection.
/// Sorted by (server_received_at ASC, id ASC) to match the incremental sync
/// cursor so clients can paginate forward using the compound cursor. If a
/// collection has >10k records, the client receives the first 10k and uses the
/// last record's (serverReceivedAt, id) as a compound cursor in the next sync_pull.
pub fn read_collection(
    conn: &rusqlite::Connection,
    collection: &str,
) -> Result<Vec<SyncRecord>, DbError> {
    let mut stmt = conn.prepare(
        "SELECT id, collection, data, created_at, updated_at, deleted, server_received_at \
         FROM records WHERE collection = ?1 AND deleted = 0 \
         ORDER BY server_received_at ASC, id ASC LIMIT ?2",
    )?;

    let records = stmt
        .query_map(params![collection, MAX_COLLECTION_ROWS], |row| {
            let raw_data = row.get::<_, String>(2)?;
            Ok(SyncRecord {
                id: row.get(0)?,
                collection: row.get(1)?,
                data: serde_json::from_str(&raw_data).unwrap_or_else(|e| {
                    tracing::warn!("Invalid JSON in record data: {}", e);
                    serde_json::Value::Null
                }),
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
                deleted: row.get::<_, i32>(5)? != 0,
                server_received_at: row.get::<_, Option<String>>(6)?
                    .unwrap_or_default(),
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(records)
}
