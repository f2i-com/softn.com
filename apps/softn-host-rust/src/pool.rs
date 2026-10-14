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

/// The first `limit` non-deleted records of a collection whose data has
/// every field of `filter` with that value.
///
/// This is what `db.query(collection, filter)` means, applied before the
/// page is cut. Applied after it, as it was, a filtered query over a large
/// collection looked only among the oldest ten thousand records and missed
/// every match past them. The comparison is JavaScript's `===` on the parsed
/// value, or a little wider, never narrower (the script still applies its
/// own filter to what comes back): a string by its text, a number by its
/// value as a double, `true`, `false` and `null` by kind, and an object or
/// an array matches nothing, as it never equals another.
pub fn read_collection_where(
    conn: &rusqlite::Connection,
    collection: &str,
    filter: &serde_json::Map<String, serde_json::Value>,
    limit: i64,
) -> Result<Vec<SyncRecord>, DbError> {
    use rusqlite::types::Value as Sql;
    let mut sql = String::from(
        "SELECT id, collection, data, created_at, updated_at, deleted, server_received_at \
         FROM records WHERE collection = ?1 AND deleted = 0",
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
            serde_json::Value::Array(_) | serde_json::Value::Object(_) => return Ok(Vec::new()),
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
    sql.push_str(&format!(" ORDER BY COALESCE(server_received_at, '') ASC, id ASC LIMIT ?{}", binds.len()));
    let records = conn
        .prepare(&sql)?
        .query_map(rusqlite::params_from_iter(binds), sync_record)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(records)
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
