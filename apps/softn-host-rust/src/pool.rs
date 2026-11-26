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

            // The index on (collection, updated_at, id) pulls were read by
            // before they went by server_received_at. No query filters or
            // sorts on updated_at (xdb's own lists go by created_at), so it
            // only cost every write: dropped where an older host made it.
            idx_conn.execute_batch("DROP INDEX IF EXISTS idx_records_sync;")
                .map_err(|e| format!("Failed to drop the unused sync index: {}", e))?;

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
            //
            // The stamp is the cursor a pull reads from, so within a collection it
            // has to go up with every write, and the clock it used to be read from
            // does not: a correction that steps it back a second (NTP, or a hand on
            // it) stamped the writes of that second before stamps already handed
            // out as cursors, and a device that had pulled up to one of those never
            // received them. Two writes in one millisecond tied, and went by id.
            // So each collection's latest stamp is kept (server_received_clock) and
            // a write takes the time or the millisecond after the latest, whichever
            // is later. It is kept in a table of its own because the record that
            // held the latest stamp may be the one a write replaces. See
            // received_stamp_triggers.
            let triggers_current: i64 = idx_conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' \
                     AND name IN ('trg_server_received_at_insert', 'trg_server_received_at_update') \
                     AND instr(sql, 'server_received_clock') > 0",
                    [],
                    |row| row.get(0),
                )
                .map_err(|e| format!("Failed to read server_received_at triggers: {}", e))?;
            if triggers_current != 2 {
                // The ones an older host made stamp by the clock alone: replaced
                // under their own names, so that a host of that age opened on
                // this database afterwards keeps these (`IF NOT EXISTS`).
                idx_conn
                    .execute_batch(&received_stamp_triggers())
                    .map_err(|e| format!("Failed to create server_received_at triggers: {}", e))?;
            }

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

            // No collection's clock is behind a stamp one of its records has:
            // the ones written before the clock was kept, and the ones just
            // backfilled. A stamp SQLite cannot read as a time is passed over
            // (nothing can be counted on from it), and a clock left on one
            // starts again from the records. The table is made here as well as
            // with the triggers, which cannot write a record without it.
            idx_conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS server_received_clock (collection TEXT PRIMARY KEY, latest TEXT NOT NULL); \
                 UPDATE server_received_clock SET latest = '' WHERE julianday(latest) IS NULL AND latest <> ''; \
                 INSERT INTO server_received_clock (collection, latest) \
                 SELECT collection, MAX(server_received_at) FROM records \
                 WHERE julianday(server_received_at) IS NOT NULL GROUP BY collection \
                 ON CONFLICT(collection) DO UPDATE SET latest = excluded.latest \
                 WHERE excluded.latest > server_received_clock.latest;"
            ).map_err(|e| format!("Failed to set the server_received_at clock: {}", e))?;
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
}

/// The receipt stamp of each write, one that goes up whatever the clock does
/// (`ServerDb::new` says why): the table that keeps each collection's latest,
/// and the two triggers that stamp from it. In one transaction, so that no
/// write falls between the old triggers and these.
///
/// A write's stamp is the time now if that is after the collection's latest,
/// and otherwise the millisecond after the latest. A latest that is not in
/// the host's own form (a record from before receipt times was given its
/// `updated_at`, which may be to the second) can sort after its own next
/// millisecond; then the second after it is tried, and failing that the
/// latest is given again: never an earlier one, and never an error, since
/// this runs inside every write. The comparison is the one a pull makes, of
/// text.
///
/// The record's stamp is read back from the clock, with the time as it was
/// (`COALESCE`) should the collection have no row there after all.
fn received_stamp_triggers() -> String {
    const NOW: &str = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
    let after_latest = |step: &str| format!("strftime('%Y-%m-%dT%H:%M:%fZ', latest, '{step}')");
    let (next_ms, next_second) = (after_latest("+0.001 seconds"), after_latest("+1 seconds"));
    let stamp = format!(
        "INSERT INTO server_received_clock (collection, latest) \
           SELECT NEW.collection, '' \
           WHERE NOT EXISTS (SELECT 1 FROM server_received_clock WHERE collection = NEW.collection); \
         UPDATE server_received_clock SET latest = CASE \
             WHEN {NOW} > latest THEN {NOW} \
             WHEN {next_ms} > latest THEN {next_ms} \
             WHEN {next_second} > latest THEN {next_second} \
             ELSE latest END \
           WHERE collection = NEW.collection; \
         UPDATE records SET server_received_at = COALESCE( \
             (SELECT latest FROM server_received_clock WHERE collection = NEW.collection), {NOW}) \
           WHERE id = NEW.id;"
    );
    format!(
        "BEGIN IMMEDIATE; \
         CREATE TABLE IF NOT EXISTS server_received_clock ( \
           collection TEXT PRIMARY KEY, \
           latest TEXT NOT NULL \
         ); \
         DROP TRIGGER IF EXISTS trg_server_received_at_insert; \
         CREATE TRIGGER IF NOT EXISTS trg_server_received_at_insert \
         AFTER INSERT ON records \
         WHEN NEW.server_received_at IS NULL \
         BEGIN {stamp} END; \
         DROP TRIGGER IF EXISTS trg_server_received_at_update; \
         CREATE TRIGGER IF NOT EXISTS trg_server_received_at_update \
         AFTER UPDATE OF data, updated_at, deleted ON records \
         BEGIN {stamp} END; \
         COMMIT;"
    )
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
pub(crate) const MAX_COLLECTION_ROWS: i64 = 10_000;

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

/// Each record of `rows` to `take`, as SQLite reads it, until `take` says stop.
fn take_rows<F>(rows: rusqlite::MappedRows<'_, F>, take: &mut dyn FnMut(SyncRecord) -> bool) -> Result<(), DbError>
where
    F: FnMut(&rusqlite::Row<'_>) -> rusqlite::Result<SyncRecord>,
{
    for record in rows {
        if !take(record?) {
            break;
        }
    }
    Ok(())
}

/// Where a pull reads a collection from.
pub enum SyncFrom<'a> {
    /// Incremental: what was received after `since` (and, at that same
    /// time, after `last_id`), the soft-deleted records included, so a
    /// client can remove them.
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
    Since { since: &'a str, last_id: Option<&'a str> },
    /// Full: the non-deleted records after `after`, or from the start. See
    /// [`read_collection_page`].
    Page { after: Option<(&'a str, &'a str)> },
}

/// The records a pull reads, at most `limit` of them, handed to `take` one
/// at a time as SQLite reads them, until it answers false or there are no
/// more, in the order (server_received_at, id) the cursors follow; what
/// [`read_collection_page`] answers whole. A caller that stops early holds no
/// more of them than it kept, and goes on later from the last one it took,
/// as a cursor.
pub fn visit_sync_records(
    conn: &rusqlite::Connection,
    collection: &str,
    from: SyncFrom<'_>,
    limit: i64,
    take: &mut dyn FnMut(SyncRecord) -> bool,
) -> Result<(), DbError> {
    match from {
        SyncFrom::Since { since, last_id: Some(last_id) } => {
            let mut stmt = conn.prepare(&sync_sql(SyncRead::SinceAfter))?;
            let rows = stmt.query_map(params![collection, since, last_id, limit], sync_record)?;
            take_rows(rows, take)
        }
        SyncFrom::Since { since, last_id: None } => {
            let mut stmt = conn.prepare(&sync_sql(SyncRead::Since))?;
            let rows = stmt.query_map(params![collection, since, limit], sync_record)?;
            take_rows(rows, take)
        }
        SyncFrom::Page { after: Some((at, id)) } if !at.is_empty() => {
            let mut stmt = conn.prepare(&sync_sql(SyncRead::ReceivedAfter))?;
            let rows = stmt.query_map(params![collection, at, id, limit], sync_record)?;
            take_rows(rows, take)
        }
        // From the start, or from among the records with no receipt time,
        // which come first: the rest of those, then the others from their
        // start.
        SyncFrom::Page { after } => {
            let after_id = after.map(|(_, id)| id);
            let mut left = limit;
            let mut going = true;
            {
                let mut stmt = conn.prepare(&sync_sql(SyncRead::Unreceived))?;
                let rows = stmt.query_map(params![collection, after_id, limit], sync_record)?;
                take_rows(rows, &mut |record| {
                    left -= 1;
                    going = take(record);
                    going
                })?;
            }
            if !going || left <= 0 {
                return Ok(());
            }
            let mut stmt = conn.prepare(&sync_sql(SyncRead::Received))?;
            let rows = stmt.query_map(params![collection, left], sync_record)?;
            take_rows(rows, take)
        }
    }
}

/// The statements [`visit_sync_records`] reads with.
#[derive(Clone, Copy, Debug)]
enum SyncRead {
    /// Incremental, from a time.
    Since,
    /// Incremental, from a record.
    SinceAfter,
    /// Full: the records with no receipt time, after an id when one is given.
    Unreceived,
    /// Full: the records with a receipt time, from the first.
    Received,
    /// Full: the records after one that has a receipt time.
    ReceivedAfter,
}

/// The statement for `read`: the collection is `?1`, the cursor's parts
/// follow it and the limit is last.
///
/// Each goes to its place by `idx_records_sync_received` (collection,
/// server_received_at, id) and reads on in that order, so a step costs what
/// it reads. A pull runs one of these for every message it sends, where it
/// used to run one for a whole page, and the full pull's ordered by
/// `COALESCE(server_received_at, '')`: no index holds that, so each step
/// read every record and sorted them to find its five hundred. The order is
/// the same one, said in a way the index can serve: the records with no
/// receipt time (null, or empty) first, by id, then the rest by
/// (server_received_at, id). `+deleted` keeps the planner off the index on
/// `deleted`, which names most of the table.
fn sync_sql(read: SyncRead) -> String {
    const COLUMNS: &str = "SELECT id, collection, data, created_at, updated_at, deleted, server_received_at FROM records";
    const ORDER: &str = "ORDER BY server_received_at ASC, id ASC";
    match read {
        SyncRead::Since => format!("{COLUMNS} WHERE collection = ?1 AND server_received_at > ?2 {ORDER} LIMIT ?3"),
        // Compound cursor: after `since`, or at `since` and after `last_id`.
        SyncRead::SinceAfter => format!(
            "{COLUMNS} WHERE collection = ?1 AND (server_received_at, id) > (?2, ?3) {ORDER} LIMIT ?4"
        ),
        // Null and empty, each found in the index and read in id order,
        // merged: said as one `OR`, the planner read the whole collection.
        SyncRead::Unreceived => format!(
            "{COLUMNS} WHERE collection = ?1 AND +deleted = 0 AND server_received_at IS NULL AND (?2 IS NULL OR id > ?2) \
             UNION ALL \
             {COLUMNS} WHERE collection = ?1 AND +deleted = 0 AND server_received_at = '' AND (?2 IS NULL OR id > ?2) \
             ORDER BY id ASC LIMIT ?3"
        ),
        SyncRead::Received => format!(
            "{COLUMNS} WHERE collection = ?1 AND +deleted = 0 AND server_received_at > '' {ORDER} LIMIT ?2"
        ),
        SyncRead::ReceivedAfter => format!(
            "{COLUMNS} WHERE collection = ?1 AND +deleted = 0 AND (server_received_at, id) > (?2, ?3) {ORDER} LIMIT ?4"
        ),
    }
}

/// Query the first page of a collection's non-deleted records: at most
/// [`MAX_COLLECTION_ROWS`], oldest received first. See [`read_collection_page`].
#[cfg(test)]
pub fn read_collection(
    conn: &rusqlite::Connection,
    collection: &str,
) -> Result<Vec<SyncRecord>, DbError> {
    read_collection_page(conn, collection, None, MAX_COLLECTION_ROWS)
}

fn sync_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<SyncRecord> {
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
}

/// One page of a collection's non-deleted records, in the order
/// (server_received_at, id), starting after `after` when it is given.
///
/// A collection past [`MAX_COLLECTION_ROWS`] used to be read as its oldest
/// ten thousand records and no further: a new device never received the
/// rest, which were the newest, and nothing said so. A caller that gets a
/// full page passes the last record's (server_received_at, id) back as
/// `after` for the next. A record with no receipt time sorts as the empty
/// string, in the cursor as in the order, so a page that ends among such
/// records continues among them.
#[cfg(test)]
pub fn read_collection_page(
    conn: &rusqlite::Connection,
    collection: &str,
    after: Option<(&str, &str)>,
    limit: i64,
) -> Result<Vec<SyncRecord>, DbError> {
    let mut records = Vec::new();
    visit_sync_records(conn, collection, SyncFrom::Page { after }, limit, &mut |record| {
        records.push(record);
        true
    })?;
    Ok(records)
}

/// The most fields a filter may name for it to be applied in the query.
pub(crate) const MAX_FILTER_FIELDS: usize = 16;

/// What [`visit_collection_where`] hands over, answered whole.
#[cfg(test)]
pub fn read_collection_where(
    conn: &rusqlite::Connection,
    collection: &str,
    filter: &serde_json::Map<String, serde_json::Value>,
    limit: i64,
) -> Result<Vec<SyncRecord>, DbError> {
    let mut records = Vec::new();
    visit_collection_where(conn, collection, filter, limit, &mut |record| {
        records.push(record);
        true
    })?;
    Ok(records)
}

/// The first `limit` non-deleted records of a collection whose data has
/// every field of `filter` with that value, handed to `take` one at a time
/// as SQLite reads them, until it answers false or there are no more (as
/// [`visit_sync_records`] hands a pull's), so a caller with a size cap holds
/// no more than it kept.
///
/// This is what `db.query(collection, filter)` means, applied before the
/// page is cut. Applied after it, as it was, a filtered query over a large
/// collection looked only among the oldest ten thousand records and missed
/// every match past them. The comparison is JavaScript's `===` on the parsed
/// value, or a little wider, never narrower (the script still applies its
/// own filter to what comes back): a string by its text, a number by its
/// value as a double, `true`, `false` and `null` by kind, and an object or
/// an array matches nothing, as it never equals another.
pub fn visit_collection_where(
    conn: &rusqlite::Connection,
    collection: &str,
    filter: &serde_json::Map<String, serde_json::Value>,
    limit: i64,
    take: &mut dyn FnMut(SyncRecord) -> bool,
) -> Result<(), DbError> {
    use rusqlite::types::Value as Sql;
    let mut sql = String::from(
        "SELECT id, collection, data, created_at, updated_at, deleted, server_received_at \
         FROM records WHERE collection = ?1 AND +deleted = 0",
    );
    let mut binds: Vec<Sql> = vec![Sql::Text(collection.to_string())];
    for (key, value) in filter {
        binds.push(Sql::Text(key.clone()));
        let field = binds.len();
        let matches = match value {
            serde_json::Value::String(text) => {
                binds.push(Sql::Text(text.clone()));
                format!("type = 'text' AND atom = ?{}", binds.len())
            }
            serde_json::Value::Number(number) => {
                binds.push(Sql::Real(number.as_f64().unwrap_or(f64::NAN)));
                format!("type IN ('integer', 'real') AND CAST(atom AS REAL) = ?{}", binds.len())
            }
            serde_json::Value::Bool(true) => "type = 'true'".to_string(),
            serde_json::Value::Bool(false) => "type = 'false'".to_string(),
            serde_json::Value::Null => "type = 'null'".to_string(),
            serde_json::Value::Array(_) | serde_json::Value::Object(_) => return Ok(()),
        };
        // A key of an object is text and an index of an array an integer;
        // either is what a script names with a string. Data that is not
        // JSON has no fields (json_each would stop the whole query on it).
        sql.push_str(&format!(
            " AND CASE WHEN json_valid(data) THEN EXISTS (SELECT 1 FROM json_each(records.data) \
             WHERE CAST(key AS TEXT) = ?{field} AND {matches}) ELSE 0 END"
        ));
    }
    binds.push(Sql::Integer(limit));
    sql.push_str(&format!(" ORDER BY server_received_at ASC, id ASC LIMIT ?{}", binds.len()));
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(binds), sync_record)?;
    take_rows(rows, take)
}

/// Say, at most once a minute, that a read stopped at its limit.
pub(crate) fn warn_capped(what: &str, collection: &str, limit: i64) {
    static LAST: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let last = LAST.load(std::sync::atomic::Ordering::Relaxed);
    if now.saturating_sub(last) >= 60
        && LAST.compare_exchange(last, now, std::sync::atomic::Ordering::Relaxed, std::sync::atomic::Ordering::Relaxed).is_ok()
    {
        tracing::warn!(collection, limit, "{what} read {limit} records of a collection that has more");
    }
}

#[cfg(test)]
mod filter_tests {
    use super::*;
    use serde_json::{json, Value};

    /// What `db.query(collection, filter)` means: every field of the filter
    /// is a field of the data, with a value `===` it (the preamble's rule).
    fn script_filter(data: &Value, filter: &serde_json::Map<String, Value>) -> bool {
        let field = |key: &str| match data {
            Value::Object(map) => map.get(key).cloned(),
            Value::Array(items) => key.parse::<usize>().ok().filter(|i| i.to_string() == key).and_then(|i| items.get(i).cloned()),
            _ => None,
        };
        filter.iter().all(|(key, want)| match (field(key), want) {
            (Some(Value::String(a)), Value::String(b)) => a == *b,
            (Some(Value::Number(a)), Value::Number(b)) => a.as_f64() == b.as_f64(),
            (Some(Value::Bool(a)), Value::Bool(b)) => a == *b,
            (Some(Value::Null), Value::Null) => true,
            _ => false,
        })
    }

    fn store(records: &[(&str, &str)]) -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE records (id TEXT PRIMARY KEY, collection TEXT, data TEXT, created_at TEXT, updated_at TEXT, deleted INTEGER DEFAULT 0, server_received_at TEXT);",
        ).unwrap();
        for (n, (id, data)) in records.iter().enumerate() {
            conn.execute(
                "INSERT INTO records VALUES (?1, 'things', ?2, 't', 't', 0, ?3)",
                params![id, data, format!("2026-01-01T00:00:{n:02}Z")],
            ).unwrap();
        }
        conn
    }

    #[test]
    fn the_filter_in_the_query_finds_what_the_scripts_filter_finds() {
        let records = [
            ("text", r#"{"owner":"ann","n":1,"done":true,"note":null}"#),
            ("other", r#"{"owner":"bob","n":1.0,"done":false}"#),
            ("typed", r#"{"owner":1,"n":"1","done":"true","note":"null"}"#),
            ("nested", r#"{"owner":{"name":"ann"},"n":[1],"done":null}"#),
            ("absent", r#"{"title":"no such fields"}"#),
            ("big", r#"{"owner":"ann","n":9007199254740993}"#),
            ("escaped", r#"{"owner":"ann","n":-0.0}"#),
            ("list", r#"["ann",1,true]"#),
            ("scalar", r#""ann""#),
            ("broken", "{not json"),
            ("empty", r#"{"owner":"","n":0,"done":false}"#),
        ];
        let conn = store(&records);
        let filters = [
            json!({"owner": "ann"}), json!({"owner": "ann", "done": true}), json!({"owner": ""}),
            json!({"n": 1}), json!({"n": 1.0}), json!({"n": 0}), json!({"n": "1"}),
            json!({"n": 9007199254740992u64}), json!({"n": 9007199254740993u64}),
            json!({"done": true}), json!({"done": false}), json!({"done": null}), json!({"note": null}),
            json!({"done": "true"}), json!({"owner": 1}), json!({"missing": null}),
            json!({"owner": {"name": "ann"}}), json!({"n": [1]}),
            json!({"0": "ann"}), json!({"1": 1}), json!({"2": true, "0": "ann"}), json!({"00": "ann"}),
        ];
        for filter in &filters {
            let filter = filter.as_object().unwrap();
            let mut found: Vec<String> = read_collection_where(&conn, "things", filter, 100).unwrap().into_iter().map(|r| r.id).collect();
            found.sort();
            let mut wanted: Vec<String> = records.iter()
                .filter(|(_, data)| serde_json::from_str::<Value>(data).is_ok_and(|data| script_filter(&data, filter)))
                .map(|(id, _)| id.to_string())
                .collect();
            wanted.sort();
            assert_eq!(found, wanted, "filter {}", Value::Object(filter.clone()));
        }
    }

    /// The point of filtering in the query: the limit counts what matches.
    #[test]
    fn a_match_past_the_limit_of_an_unfiltered_read_is_found() {
        let records: Vec<(String, String)> = (0..6)
            .map(|n| (format!("r{n}"), format!(r#"{{"owner":"{}"}}"#, if n >= 4 { "ann" } else { "bob" })))
            .collect();
        let borrowed: Vec<(&str, &str)> = records.iter().map(|(id, data)| (id.as_str(), data.as_str())).collect();
        let conn = store(&borrowed);
        // Read first and filtered after, the two oldest are all there is to look among.
        let unfiltered: Vec<String> = read_collection_page(&conn, "things", None, 2).unwrap().into_iter().map(|r| r.id).collect();
        assert_eq!(unfiltered, vec!["r0", "r1"]);
        let filter = json!({"owner": "ann"});
        let found: Vec<String> = read_collection_where(&conn, "things", filter.as_object().unwrap(), 2).unwrap().into_iter().map(|r| r.id).collect();
        assert_eq!(found, vec!["r4", "r5"]);
    }

    /// A pull is read a message at a time, and each step's query goes on
    /// from the last record the step before read. A step has to reach that
    /// place by the index. The full pull's did not: it ordered by
    /// `COALESCE(server_received_at, '')`, which no index holds, so every
    /// step read the whole collection and sorted it to find its five hundred
    /// records, twenty times a page where a page had been one query.
    #[test]
    fn a_pull_step_reaches_its_place_by_the_index() {
        let dir = crate::test_dirs::temp_path("softn-pool", "");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("xdb.sqlite");
        let db = ServerDb::new(xdb::create_shared_db(path.clone()).unwrap(), &path, 2).unwrap();
        let conn = db.read().unwrap();
        for read in [SyncRead::Since, SyncRead::SinceAfter, SyncRead::Unreceived, SyncRead::Received, SyncRead::ReceivedAfter] {
            let mut stmt = conn.prepare(&format!("EXPLAIN QUERY PLAN {}", sync_sql(read))).unwrap();
            let unbound = vec![rusqlite::types::Null; stmt.parameter_count()];
            let plan = stmt
                .query_map(rusqlite::params_from_iter(unbound), |row| row.get::<_, String>(3))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
                .join(" | ");
            assert!(!plan.contains("SCAN"), "{read:?} reads the whole table: {plan}");
            assert!(
                plan.contains("idx_records_sync_received (collection=? AND "),
                "{read:?} does not go to its place in the index: {plan}"
            );
            // The records with no receipt time are sorted by id, and they
            // are the few a host from before receipt times left behind. No
            // other read sorts anything.
            if !matches!(read, SyncRead::Unreceived) {
                assert!(!plan.contains("TEMP B-TREE"), "{read:?} sorts what it reads: {plan}");
            }
        }
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Pages line up through records that have no receipt time.
    #[test]
    fn pages_continue_through_records_with_no_receipt_time() {
        let conn = store(&[("a", "{}"), ("b", "{}"), ("c", "{}"), ("d", "{}"), ("e", "{}")]);
        conn.execute("UPDATE records SET server_received_at = NULL WHERE id IN ('a', 'c', 'e')", []).unwrap();
        let mut seen = Vec::new();
        let mut cursor: Option<(String, String)> = None;
        loop {
            let page = read_collection_page(&conn, "things", cursor.as_ref().map(|(at, id)| (at.as_str(), id.as_str())), 2).unwrap();
            let full = page.len() == 2;
            if let Some(last) = page.last() {
                cursor = Some((last.server_received_at.clone(), last.id.clone()));
            }
            seen.extend(page.into_iter().map(|r| r.id));
            if !full {
                break;
            }
        }
        seen.sort();
        assert_eq!(seen, vec!["a", "b", "c", "d", "e"]);
    }
}

/// SH-F8: a record's receipt stamp is the cursor pulls read from, and it was
/// the wall clock's time, which can step back.
#[cfg(test)]
mod received_stamp_tests {
    use super::*;

    /// A database as the host opens it, and a second connection to look at
    /// (and set) what the triggers wrote.
    struct Store {
        dir: PathBuf,
        path: PathBuf,
        db: Option<ServerDb>,
        raw: rusqlite::Connection,
    }

    impl Store {
        fn open() -> Self {
            let dir = crate::test_dirs::temp_path("softn-pool-stamp", "");
            std::fs::create_dir_all(&dir).unwrap();
            let path = dir.join("xdb.sqlite");
            let db = ServerDb::new(xdb::create_shared_db(path.clone()).unwrap(), &path, 2).unwrap();
            let raw = rusqlite::Connection::open(&path).unwrap();
            Store { dir, path, db: Some(db), raw }
        }

        /// The host stopped and started again on the same file.
        fn restart(&mut self) {
            self.db = None;
            self.db = Some(ServerDb::new(xdb::create_shared_db(self.path.clone()).unwrap(), &self.path, 2).unwrap());
        }

        fn db(&self) -> &ServerDb {
            self.db.as_ref().unwrap()
        }

        /// `upsert_record`: xdb's `INSERT OR REPLACE`, which deletes the record's old row.
        fn put(&self, id: &str, collection: &str) -> String {
            self.db().write().upsert_record(Record {
                id: id.into(), collection: collection.into(), data: serde_json::json!({"n": 1}),
                created_at: "2026-01-01T00:00:00Z".into(), updated_at: "2026-01-01T00:00:00Z".into(), deleted: false,
            }).unwrap();
            self.stamp(id)
        }

        fn stamp(&self, id: &str) -> String {
            self.raw.query_row("SELECT server_received_at FROM records WHERE id = ?1", [id], |row| row.get(0)).unwrap()
        }

        /// As a clock running ahead left it: the record stamped `at`, and
        /// its collection's clock there too.
        fn stamped_ahead(&self, id: &str, collection: &str, at: &str) {
            self.raw.execute("UPDATE records SET server_received_at = ?1 WHERE id = ?2", [at, id]).unwrap();
            self.raw.execute("UPDATE server_received_clock SET latest = ?1 WHERE collection = ?2", [at, collection]).unwrap();
        }

        /// What an incremental pull from the place (`at`, `id`) is sent.
        fn pulled_since(&self, collection: &str, at: &str, id: &str) -> Vec<String> {
            let conn = self.db().read().unwrap();
            let mut ids = Vec::new();
            visit_sync_records(&conn, collection, SyncFrom::Since { since: at, last_id: Some(id) }, 100, &mut |record| {
                ids.push(record.id);
                true
            }).unwrap();
            ids
        }
    }

    impl Drop for Store {
        fn drop(&mut self) {
            self.db = None;
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    /// The host's own form, which a client takes as a place (`HOST_TIME` in
    /// @softn/core's xdb-server-sync.ts).
    fn is_host_time(stamp: &str) -> bool {
        let shape = "0000-00-00T00:00:00.000Z";
        stamp.len() == shape.len()
            && stamp.bytes().zip(shape.bytes()).all(|(got, want)| if want == b'0' { got.is_ascii_digit() } else { got == want })
    }

    /// The scenario: "a" was written (and pulled) while the clock ran ahead;
    /// the clock is put right; what is written next has to come after "a".
    #[test]
    fn a_write_is_stamped_after_the_stamps_already_given_when_the_clock_steps_back() {
        let store = Store::open();
        store.put("m", "notes");
        store.put("a", "notes");
        let ahead = "2099-06-01T12:00:00.000Z";
        store.stamped_ahead("a", "notes", ahead);
        assert_eq!(store.pulled_since("notes", ahead, "a"), Vec::<String>::new(), "a device that has pulled up to a");

        // A new record, with an id that sorts before the place's: only its stamp puts it after.
        let first = store.put("Z-new", "notes");
        assert!(first.as_str() > ahead, "{first} is before a stamp already handed out ({ahead})");
        assert_eq!(first, "2099-06-01T12:00:00.001Z", "the millisecond after the latest");
        // An edit of an older record, a delete, and the record that held the latest stamp written again
        // (`INSERT OR REPLACE` deletes its row: the latest is not among the records while that runs).
        store.db().write().update_record("m", serde_json::json!({"n": 2})).unwrap();
        let second = store.stamp("m");
        store.db().write().delete_record("Z-new").unwrap();
        let third = store.stamp("Z-new");
        let fourth = store.put("a", "notes");
        assert_eq!(
            [second.as_str(), third.as_str(), fourth.as_str()],
            ["2099-06-01T12:00:00.002Z", "2099-06-01T12:00:00.003Z", "2099-06-01T12:00:00.004Z"],
        );
        // The device receives all of it, in the order it was written.
        assert_eq!(store.pulled_since("notes", ahead, "a"), vec!["m", "Z-new", "a"]);

        // Each collection has its own stamps, as each has its own cursor.
        let other = store.put("t1", "tasks");
        assert!(is_host_time(&other) && other.as_str() < ahead, "{other}");
    }

    /// What is kept is in the database, and where it is not it is read from
    /// the records: a restart, or a database an older host wrote, starts no lower.
    #[test]
    fn the_stamps_go_on_from_the_latest_after_a_restart_and_from_an_older_hosts_database() {
        let mut store = Store::open();
        store.put("a", "notes");
        let ahead = "2099-06-01T12:00:00.000Z";
        store.stamped_ahead("a", "notes", ahead);
        store.restart();
        assert_eq!(store.put("b", "notes"), "2099-06-01T12:00:00.001Z");

        // An older host's database: its triggers, which stamp by the clock alone, and no clock table.
        store.db = None;
        store.raw.execute_batch(
            "DROP TRIGGER trg_server_received_at_insert; DROP TRIGGER trg_server_received_at_update; \
             DROP TABLE server_received_clock; \
             CREATE TRIGGER trg_server_received_at_insert AFTER INSERT ON records WHEN NEW.server_received_at IS NULL \
             BEGIN UPDATE records SET server_received_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id; END; \
             CREATE TRIGGER trg_server_received_at_update AFTER UPDATE OF data, updated_at, deleted ON records \
             BEGIN UPDATE records SET server_received_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id; END;",
        ).unwrap();
        store.restart();
        assert_eq!(store.put("c", "notes"), "2099-06-01T12:00:00.002Z", "from the records' own latest (b)");
        store.db().write().update_record("a", serde_json::json!({"n": 3})).unwrap();
        assert_eq!(store.stamp("a"), "2099-06-01T12:00:00.003Z");
        assert_eq!(store.pulled_since("notes", ahead, "a"), vec!["b", "c", "a"]);
    }

    /// Without a clock step: two writes in one millisecond had the same
    /// stamp, and a pull that had ended on the first could pass over the
    /// second (they go by id then, not by which came later).
    #[test]
    fn writes_in_the_same_millisecond_are_stamped_in_the_order_they_were_made() {
        let store = Store::open();
        let before: String = store.raw.query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", [], |row| row.get(0)).unwrap();
        // Ids that sort against the order of writing.
        let stamps: Vec<String> = (0..300).map(|n| store.put(&format!("r{:03}", 299 - n), "notes")).collect();
        for pair in stamps.windows(2) {
            assert!(pair[0] < pair[1], "{} was not stamped before {}", pair[0], pair[1]);
        }
        assert!(stamps.iter().all(|stamp| is_host_time(stamp)), "{stamps:?}");
        assert!(stamps[0] >= before, "the time, where nothing is later: {} < {before}", stamps[0]);
    }

    /// A record from before receipt times has its `updated_at` for a stamp,
    /// in whatever form that was. What is written next still comes after it
    /// where that can be said, and is never refused where it cannot.
    #[test]
    fn a_latest_stamp_in_another_form_is_still_followed_and_never_fails_a_write() {
        let mut store = Store::open();
        for (n, (legacy, next)) in [
            // xdb's own `updated_at`: nanoseconds and an offset.
            ("2099-06-01T12:00:00.123456789+00:00", "2099-06-01T12:00:00.124Z"),
            // To the second: its next millisecond sorts before it ('.' < 'Z'), its next second after.
            ("2099-06-01T12:00:00Z", "2099-06-01T12:00:01.000Z"),
            ("2099-06-01 12:00:00", "2099-06-01T12:00:00.001Z"),
        ].into_iter().enumerate() {
            let (collection, old, new) = (format!("legacy{n}"), format!("old{n}"), format!("new{n}"));
            store.put(&old, &collection);
            // As the backfill left such a record: stamped, with no clock kept yet.
            store.raw.execute("UPDATE records SET server_received_at = ?1 WHERE id = ?2", [legacy, old.as_str()]).unwrap();
            store.raw.execute("DELETE FROM server_received_clock", []).unwrap();
            store.restart();
            let stamp = store.put(&new, &collection);
            assert_eq!(stamp, next, "after {legacy}");
            assert!(stamp.as_str() > legacy, "{stamp} sorts before {legacy}");
            assert_eq!(store.pulled_since(&collection, legacy, &old), vec![new]);
        }

        // Not a time at all: the records' clock does not start from it,
        store.put("junk", "odd");
        store.raw.execute("UPDATE records SET server_received_at = 'zzz' WHERE id = 'junk'", []).unwrap();
        store.raw.execute("DELETE FROM server_received_clock", []).unwrap();
        store.restart();
        assert!(is_host_time(&store.put("fine", "odd")));
        // and if the clock itself is left on one, or at the last time there is, a write is not refused:
        // it is stamped no earlier.
        for stuck in ["zzz", "9999-12-31T23:59:59.999Z"] {
            store.raw.execute("UPDATE server_received_clock SET latest = ?1 WHERE collection = 'odd'", [stuck]).unwrap();
            assert_eq!(store.put("fine", "odd"), stuck);
            store.db().write().update_record("fine", serde_json::json!({"n": 2})).unwrap();
            assert_eq!(store.stamp("fine"), stuck);
        }
        // A clock left on what is not a time starts again when the host does, and one whose
        // table has gone is made again: the triggers cannot write a record without it.
        store.raw.execute("UPDATE server_received_clock SET latest = 'zzz' WHERE collection = 'odd'", []).unwrap();
        store.raw.execute("UPDATE records SET server_received_at = 'zzz' WHERE collection = 'odd'", []).unwrap();
        store.restart();
        assert!(is_host_time(&store.put("fine", "odd")));
        store.db = None;
        store.raw.execute_batch("DROP TABLE server_received_clock").unwrap();
        store.restart();
        let again = store.put("fine", "odd");
        assert!(is_host_time(&again) && again.as_str() > "2026", "{again}");
        assert_eq!(store.put("new0", "legacy0"), "2099-06-01T12:00:00.125Z", "and goes on from the records");
    }
}
