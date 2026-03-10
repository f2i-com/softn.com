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
            // Don't close idle connections — avoids WAL checkpoint disruption.
            .idle_timeout(None)
            .max_lifetime(None)
            .build(manager)
            .map_err(|e| format!("Failed to create read pool: {}", e))?;

        Ok(Self { writer, read_pool })
    }

    /// Lock the writer for mutations (create, update, delete).
    /// Recovers from poisoned locks to avoid permanent failure.
    pub fn write(&self) -> std::sync::MutexGuard<'_, XdbDatabase> {
        self.writer
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
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

/// Query all non-deleted records in a collection using a read-only connection.
pub fn read_collection(
    conn: &rusqlite::Connection,
    collection: &str,
) -> Result<Vec<Record>, DbError> {
    let mut stmt = conn.prepare(
        "SELECT id, collection, data, created_at, updated_at, deleted \
         FROM records WHERE collection = ?1 AND deleted = 0 \
         ORDER BY created_at DESC LIMIT ?2",
    )?;

    let records = stmt
        .query_map(params![collection, MAX_COLLECTION_ROWS], |row| {
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
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(records)
}
