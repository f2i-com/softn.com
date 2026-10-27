//! Private, non-syncing SQLite. Scripts never choose a path or transaction ID.
use crate::bundle::TransactionMode;
use rusqlite::{
    hooks::{AuthAction, AuthContext, Authorization},
    limits::Limit,
    params_from_iter,
    types::{Value as SqlValue, ValueRef},
    Connection,
};
use serde_json::{json, Map, Value};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

pub const MAX_RESULT_BYTES: usize = 2 * 1024 * 1024;

pub fn reject_symlink(path: &Path) -> Result<(), String> {
    if let Ok(metadata) = std::fs::symlink_metadata(path) {
        if metadata.file_type().is_symlink() {
            return Err("Private backend paths cannot be symlinks".into());
        }
    }
    Ok(())
}

/// The longest LIKE or GLOB pattern a statement may use. Matching one is a
/// single SQLite instruction, which neither the progress handler nor the
/// deadline can stop, and it costs the pattern's length times the text's:
/// a 20,000-character pattern took eight seconds against 200 KB, and against
/// a 1 MB note well past the 25-second deadline, holding the app's writer
/// lock inside a write. At this length a megabyte takes under a second.
pub const LIKE_PATTERN_LIMIT: i32 = 1000;

/// How much memory SQLite may hold in this process, every app's connections
/// together, without `SOFTN_SQLITE_MEMORY_MB`.
const SQLITE_MEMORY_MB_DEFAULT: i64 = 1024;

/// `SOFTN_SQLITE_MEMORY_MB` as a number of MiB: 64 to 65,536, the default
/// without it.
pub fn sqlite_memory_mb(raw: Option<&str>) -> Result<i64, String> {
    let Some(text) = raw else { return Ok(SQLITE_MEMORY_MB_DEFAULT) };
    text.trim()
        .parse::<i64>()
        .ok()
        .filter(|mb| (64..=65_536).contains(mb))
        .ok_or_else(|| format!("SOFTN_SQLITE_MEMORY_MB must be a whole number of MiB from 64 to 65536, not {text:?}"))
}

/// Hold SQLite to its share of the process's memory, before any connection
/// opens. Temporary tables and sorts stay in memory (`temp_store=MEMORY`, so
/// a statement cannot fill the disk every app shares), and nothing else
/// bounded what one statement could take: a recursive query over large rows
/// reached half a gigabyte in seconds, and on a host serving many apps one
/// app's request could take the process, and every app with it. Past the
/// limit a statement fails ("out of memory") and the process stays, as
/// softn-runner's does at its own limit.
pub fn hold_memory() -> Result<i64, String> {
    let mb = sqlite_memory_mb(std::env::var("SOFTN_SQLITE_MEMORY_MB").ok().as_deref())?;
    let bytes = mb * 1024 * 1024;
    // SAFETY: a plain call into the bundled SQLite, process-wide.
    unsafe { rusqlite::ffi::sqlite3_hard_heap_limit64(bytes) };
    Ok(bytes)
}

pub fn open_connection(path: &Path) -> Result<Connection, String> {
    reject_symlink(path)?;
    for suffix in ["-wal", "-shm", "-journal"] {
        reject_symlink(&PathBuf::from(format!("{}{suffix}", path.display())))?;
    }
    let conn = Connection::open(path).map_err(|_| "Cannot open private database")?;
    conn.busy_timeout(Duration::from_secs(3))
        .map_err(|_| "Cannot configure SQLite timeout")?;
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY; PRAGMA max_page_count=131072;")
        .map_err(|_| "Cannot configure private SQLite database")?;
    conn.set_limit(Limit::SQLITE_LIMIT_LENGTH, MAX_RESULT_BYTES as i32);
    conn.set_limit(Limit::SQLITE_LIMIT_SQL_LENGTH, 256 * 1024);
    conn.set_limit(Limit::SQLITE_LIMIT_COLUMN, 200);
    conn.set_limit(Limit::SQLITE_LIMIT_ATTACHED, 0);
    conn.set_limit(Limit::SQLITE_LIMIT_VARIABLE_NUMBER, 100);
    conn.set_limit(Limit::SQLITE_LIMIT_EXPR_DEPTH, 100);
    conn.set_limit(Limit::SQLITE_LIMIT_VDBE_OP, 100_000);
    conn.set_limit(Limit::SQLITE_LIMIT_WORKER_THREADS, 0);
    conn.set_limit(Limit::SQLITE_LIMIT_LIKE_PATTERN_LENGTH, LIKE_PATTERN_LIMIT);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(|_| "Cannot secure private database")?;
    }
    Ok(conn)
}

fn application_table(table: &str) -> bool {
    !table.to_ascii_lowercase().starts_with("sqlite_") && !table.starts_with('_')
}

/// SQLite's semantic authorizer is the boundary; textual statement validation
/// below is only for enforcing the one-statement bridge contract.
pub fn authorize(ctx: AuthContext<'_>, migration: bool, writable: bool) -> Authorization {
    use AuthAction::*;
    // ALTER TABLE names (database, table) in the action itself; DROP COLUMN
    // passes the dropped column where other actions pass the database name,
    // so the check below would refuse every DROP COLUMN. The new name of a
    // RENAME TO is never shown to the authorizer: `apply_migrations` checks
    // the schema afterwards.
    if let AlterTable { database_name, table_name } = ctx.action {
        return if migration && database_name == "main" && application_table(table_name) {
            Authorization::Allow
        } else {
            Authorization::Deny
        };
    }
    if ctx.database_name.is_some_and(|db| db != "main") {
        // RENAME COLUMN/TABLE also rewrites any temp trigger or view that
        // names the table, so it reads (and may update) the temp schema. The
        // migration connection can create no temp objects, so there is none.
        let temp_schema = |table: &str| matches!(table, "sqlite_temp_master" | "sqlite_temp_schema");
        let rename_reads_temp = migration
            && ctx.database_name == Some("temp")
            && match ctx.action {
                AuthAction::Read { table_name, .. } | AuthAction::Update { table_name, .. } => temp_schema(table_name),
                _ => false,
            };
        if !rename_reads_temp {
            return Authorization::Deny;
        }
    }
    let allowed = match ctx.action {
        Select | Recursive => true,
        Read { table_name, .. } => {
            application_table(table_name) || migration && table_name.starts_with("sqlite_")
        }
        Insert { table_name } | Delete { table_name } | Update { table_name, .. } => {
            writable
                && (application_table(table_name) || migration && table_name.starts_with("sqlite_"))
        }
        CreateTable { table_name } => {
            migration && (application_table(table_name) || table_name == "sqlite_sequence")
        }
        DropTable { table_name } => migration && application_table(table_name),
        // An index of an app table, under a name outside the host's `_`
        // namespace (SQLite's CREATE INDEX also asks for REINDEX of the new
        // name, but that is incidental, and DROP INDEX asks nothing more).
        CreateIndex { index_name, table_name } | DropIndex { index_name, table_name } => {
            migration && application_table(table_name) && !index_name.starts_with('_')
        }
        Reindex { index_name } => migration && application_table(index_name),
        // The clock, for defaults and backfills in a migration, as on the PHP
        // host. Not at request time: a request uses `softn.time`.
        Function { function_name }
            if migration
                && matches!(
                    function_name.to_ascii_lowercase().as_str(),
                    "datetime" | "date" | "time" | "strftime" | "julianday" | "unixepoch"
                ) =>
        {
            true
        }
        // ALTER TABLE rewrites the schema with SQL of SQLite's own, which
        // calls these; the sqlite_* ones cannot be called from app SQL at all.
        Function { function_name }
            if migration
                && matches!(
                    function_name.to_ascii_lowercase().as_str(),
                    "printf" | "format" | "sqlite_rename_column" | "sqlite_rename_table"
                        | "sqlite_rename_test" | "sqlite_rename_quotefix" | "sqlite_drop_column"
                ) =>
        {
            true
        }
        // Migrations do not install triggers, views, virtual tables or extensions.
        Function { function_name } => matches!(
            function_name.to_ascii_lowercase().as_str(),
            "count"
                | "min"
                | "max"
                | "sum"
                | "avg"
                | "total"
                | "coalesce"
                | "ifnull"
                | "nullif"
                | "length"
                | "lower"
                | "upper"
                | "trim"
                | "ltrim"
                | "rtrim"
                | "substr"
                | "substring"
                | "replace"
                | "instr"
                | "abs"
                | "round"
                | "like"
                | "glob"
                | "typeof"
                | "unicode"
                | "char"
                | "hex"
                | "quote"
        ),
        _ => false,
    };
    if allowed {
        Authorization::Allow
    } else {
        Authorization::Deny
    }
}

pub fn clear_authorizer(conn: &Connection) {
    conn.authorizer(None::<fn(AuthContext<'_>) -> Authorization>);
}

/// Reject a second statement while allowing semicolons inside SQL literals.
fn single_statement(sql: &str) -> Result<(), String> {
    if sql.is_empty() || sql.len() > 20_000 || sql.as_bytes().contains(&0) {
        return Err("SQL text exceeds host limits".into());
    }
    let bytes = sql.as_bytes();
    let (mut i, mut ended) = (0, false);
    while i < bytes.len() {
        if bytes[i].is_ascii_whitespace() {
            i += 1;
            continue;
        }
        if i + 1 < bytes.len() && &bytes[i..i + 2] == b"--" {
            i += 2;
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        if i + 1 < bytes.len() && &bytes[i..i + 2] == b"/*" {
            i += 2;
            while i + 1 < bytes.len() && &bytes[i..i + 2] != b"*/" {
                i += 1;
            }
            if i + 1 >= bytes.len() {
                return Err("Unterminated SQL comment".into());
            }
            i += 2;
            continue;
        }
        if ended {
            return Err("Only one SQL statement is allowed".into());
        }
        if bytes[i] == b';' {
            ended = true;
            i += 1;
            continue;
        }
        if matches!(bytes[i], b'\'' | b'"' | b'`' | b'[') {
            let close = if bytes[i] == b'[' { b']' } else { bytes[i] };
            i += 1;
            while i < bytes.len() {
                if bytes[i] == close {
                    i += 1;
                    if i < bytes.len() && bytes[i] == close && close != b']' {
                        i += 1;
                        continue;
                    }
                    break;
                }
                i += 1;
            }
        } else {
            i += 1;
        }
    }
    Ok(())
}

pub struct NativeSql {
    path: PathBuf,
    connection: Option<Connection>,
    failed: bool,
    active: bool,
    /// Whether the open transaction is a write, which is what its
    /// authorizer was installed with (and is installed with again).
    writable: bool,
    cancellation: Arc<AtomicBool>,
    deadline: Instant,
}

impl NativeSql {
    pub fn mark_failed(&mut self) {
        if self.active {
            self.failed = true;
        }
    }

    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            connection: None,
            failed: false,
            active: false,
            writable: false,
            cancellation: Arc::new(AtomicBool::new(false)),
            deadline: Instant::now(),
        }
    }

    pub fn begin(
        &mut self,
        mode: TransactionMode,
        cancellation: Arc<AtomicBool>,
    ) -> Result<(), String> {
        if self.active {
            self.finish(false)?;
        }
        if mode == TransactionMode::None {
            return Ok(());
        }
        if cancellation.load(Ordering::Relaxed) {
            return Err("Request cancelled".into());
        }
        if self.connection.is_none() {
            self.connection = Some(open_connection(&self.path)?);
        }
        let conn = self.connection.as_ref().unwrap();
        self.failed = false;
        self.deadline = Instant::now() + Duration::from_secs(25);
        self.cancellation = cancellation;
        let sql = if mode == TransactionMode::Write {
            "BEGIN IMMEDIATE"
        } else {
            "BEGIN"
        };
        conn.execute_batch(sql)
            .map_err(|_| "Private database is busy; retry the same action")?;
        self.active = true;
        let writable = mode == TransactionMode::Write;
        self.writable = writable;
        conn.authorizer(Some(move |ctx: AuthContext<'_>| {
            authorize(ctx, false, writable)
        }));
        let cancel = self.cancellation.clone();
        let deadline = self.deadline;
        let mut steps = 0u64;
        conn.progress_handler(
            1000,
            Some(move || {
                steps += 1000;
                steps > 5_000_000 || Instant::now() >= deadline || cancel.load(Ordering::Relaxed)
            }),
        );
        Ok(())
    }

    pub fn finish(&mut self, commit: bool) -> Result<(), String> {
        if !self.active {
            return Ok(());
        }
        let conn = self.connection.as_ref().unwrap();
        clear_authorizer(conn);
        conn.progress_handler(0, None::<fn() -> bool>);
        let aborted = self.failed
            || self.cancellation.load(Ordering::Relaxed)
            || Instant::now() >= self.deadline;
        // A transaction SQLite already ended (ON CONFLICT ROLLBACK, an error
        // it rolls back for) has nothing to commit, and a request that asked
        // for its rollback has it.
        let lost = conn.is_autocommit();
        let result = if lost {
            Ok(())
        } else {
            conn.execute_batch(if commit && !aborted { "COMMIT" } else { "ROLLBACK" })
        };
        if result.is_err() {
            let _ = conn.execute_batch("ROLLBACK");
        }
        self.active = false;
        if result.is_err() || commit && (aborted || lost) {
            return Err("Private SQL transaction was rolled back".into());
        }
        Ok(())
    }

    pub fn call(&mut self, kind: &str, sql: &str, binds: &str) -> Result<Value, String> {
        let result = self.run(kind, sql, binds);
        if result.is_err() {
            self.failed = true;
        }
        result
    }

    /// Run before an `execute`, so that the `lastInsertRowid` it reports is
    /// its own: the id of a row this statement inserted, and 0 when it
    /// inserted none (an `INSERT OR IGNORE` that was ignored, an upsert that
    /// updated, an `UPDATE`, a `DELETE`).
    ///
    /// SQLite keeps the last id a connection inserted until its next insert,
    /// and a worker keeps its connection: a statement that inserted nothing
    /// answered with the row an earlier request had made, another client's
    /// as likely as not. SQLite has no statement that clears it, so the host
    /// inserts row 0 of a table of its own in the connection's temporary
    /// schema, which no app SQL can name. The authorizer refuses everything
    /// outside `main`, the host's statement included, so it is taken off for
    /// that statement and put back. The same on the PHP host
    /// (runtime/sql.mjs FORGET_LAST_INSERT).
    fn forget_last_insert(&self, conn: &Connection) -> Result<(), String> {
        clear_authorizer(conn);
        let forgotten = conn.execute_batch(
            "CREATE TEMP TABLE IF NOT EXISTS _softn_last_insert(id INTEGER PRIMARY KEY); \
             INSERT OR REPLACE INTO temp._softn_last_insert(id) VALUES(0);",
        );
        let writable = self.writable;
        conn.authorizer(Some(move |ctx: AuthContext<'_>| {
            authorize(ctx, false, writable)
        }));
        forgotten.map_err(|_| "SQL write failed".into())
    }

    fn run(&self, kind: &str, sql: &str, binds: &str) -> Result<Value, String> {
        if !self.active {
            return Err("SQL requires a host-scoped request transaction".into());
        }
        // Once SQLite has ended the request's transaction (a statement's ON
        // CONFLICT ROLLBACK), each statement would commit by itself, whatever
        // the request answers: none runs.
        if self.connection.as_ref().is_some_and(Connection::is_autocommit) {
            return Err("Private SQL transaction was rolled back".into());
        }
        if self.cancellation.load(Ordering::Relaxed) || Instant::now() >= self.deadline {
            return Err("SQL request cancelled or timed out".into());
        }
        single_statement(sql)?;
        if binds.len() > MAX_RESULT_BYTES {
            return Err("SQL bind data exceeds host limit".into());
        }
        let input: Vec<Value> =
            serde_json::from_str(binds).map_err(|_| "SQL parameters must be a JSON array")?;
        if input.len() > 100 {
            return Err("SQL allows at most 100 binds".into());
        }
        let mut params = Vec::with_capacity(input.len());
        for value in input {
            params.push(match value {
                Value::Null => SqlValue::Null,
                Value::String(s) => SqlValue::Text(s),
                Value::Number(n) => {
                    let f = n.as_f64().ok_or("SQL requires a finite number")?;
                    if !f.is_finite() || f.abs() > 9_007_199_254_740_991.0 {
                        return Err("SQL number outside safe JavaScript range".into());
                    }
                    if f.fract() == 0.0 {
                        SqlValue::Integer(f as i64)
                    } else {
                        SqlValue::Real(f)
                    }
                }
                _ => return Err("SQL binds support only strings, finite numbers and null".into()),
            });
        }
        let conn = self.connection.as_ref().unwrap();
        let mut stmt = conn.prepare(sql).map_err(|_| "SQL statement rejected")?;
        if stmt.parameter_count() != params.len() {
            return Err("SQL bind count does not match statement".into());
        }
        if kind == "sql.execute" {
            if stmt.readonly() || stmt.column_count() != 0 {
                return Err("execute requires a DML statement without returned rows".into());
            }
            self.forget_last_insert(conn)?;
            let changes = stmt
                .execute(params_from_iter(params))
                .map_err(|_| "SQL write failed")?;
            let id = conn.last_insert_rowid();
            if id.unsigned_abs() > 9_007_199_254_740_991 {
                return Err("SQL row ID outside safe JavaScript range".into());
            }
            return Ok(json!({"changes":changes,"lastInsertRowid":id}));
        }
        if !stmt.readonly() {
            return Err("query requires a read-only statement".into());
        }
        let columns: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
        let mut rows = stmt
            .query(params_from_iter(params))
            .map_err(|_| "SQL query failed")?;
        let mut output = Vec::new();
        let mut output_bytes = 2;
        while let Some(row) = rows
            .next()
            .map_err(|_| "SQL query exceeded budget or failed")?
        {
            if output.len() >= 1000 {
                return Err("SQL result exceeds 1000 rows".into());
            }
            let mut obj = Map::new();
            // A text's JSON is at least as long as the text: once the texts
            // alone pass the limit, so does the result, known before they
            // are copied. A row of 200 columns of 2 MiB each was copied
            // twice, some 800 MB in the worker, before the limit refused it.
            let mut raw = output_bytes;
            for (i, name) in columns.iter().enumerate() {
                if let ValueRef::Text(v) = row.get_ref(i).map_err(|_| "SQL result conversion failed")? {
                    raw += v.len();
                    if raw > MAX_RESULT_BYTES {
                        return Err("SQL result exceeds byte limit".into());
                    }
                }
                let value = match row.get_ref(i).map_err(|_| "SQL result conversion failed")? {
                    ValueRef::Null => Value::Null,
                    ValueRef::Integer(v) => {
                        if v.unsigned_abs() > 9_007_199_254_740_991 {
                            return Err("SQL integer outside safe JavaScript range".into());
                        }
                        v.into()
                    }
                    ValueRef::Real(v) => serde_json::Number::from_f64(v)
                        .ok_or("Non-finite SQL result")?
                        .into(),
                    ValueRef::Text(v) => std::str::from_utf8(v)
                        .map_err(|_| "Invalid UTF-8 SQL text")?
                        .into(),
                    ValueRef::Blob(_) => return Err("Binary SQL values are not supported".into()),
                };
                obj.insert(name.clone(), value);
            }
            let value = Value::Object(obj);
            output_bytes += serde_json::to_vec(&value)
                .map_err(|_| "SQL result conversion failed")?
                .len()
                + 1;
            if output_bytes > MAX_RESULT_BYTES {
                return Err("SQL result exceeds byte limit".into());
            }
            if kind == "sql.first" {
                return Ok(value);
            }
            output.push(value);
        }
        Ok(if kind == "sql.first" {
            Value::Null
        } else {
            Value::Array(output)
        })
    }
}

impl Drop for NativeSql {
    fn drop(&mut self) {
        let _ = self.finish(false);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (PathBuf, NativeSql) {
        let path =
            crate::test_dirs::temp_path("softn-private", ".sqlite");
        let conn = open_connection(&path).unwrap();
        conn.execute_batch("CREATE TABLE records(id INTEGER PRIMARY KEY, value TEXT); CREATE TABLE _migrations(name TEXT);").unwrap();
        drop(conn);
        let bridge = NativeSql::new(path.clone());
        (path, bridge)
    }
    /// A statement whose conflict rolls the transaction back ends it under
    /// the request: what the handler writes after that is refused, not
    /// committed by itself, and a rollback the handler asks for stands.
    #[test]
    fn nothing_is_written_after_sqlite_ends_the_transaction() {
        let (path, mut bridge) = fixture();
        let count = || open_connection(&path).unwrap().query_row("SELECT COUNT(*) FROM records", [], |r| r.get::<_, i64>(0)).unwrap();
        for commit in [true, false] {
            bridge.begin(TransactionMode::Write, Arc::new(AtomicBool::new(false))).unwrap();
            bridge.call("sql.execute", "INSERT INTO records VALUES(1,'kept?')", "[]").unwrap();
            assert!(bridge.call("sql.execute", "INSERT OR ROLLBACK INTO records VALUES(1,'again')", "[]").is_err());
            assert_eq!(bridge.call("sql.execute", "INSERT INTO records VALUES(2,'after')", "[]"), Err("Private SQL transaction was rolled back".into()));
            assert_eq!(bridge.finish(commit).is_err(), commit, "commit {commit}");
            assert_eq!(count(), 0, "commit {commit}");
        }
    }

    /// Matching a LIKE pattern is one SQLite instruction, which the deadline
    /// cannot stop; its cost is the pattern's length times the text's.
    #[test]
    fn a_like_pattern_is_held_to_a_length_the_deadline_can_cover() {
        let (_path, mut bridge) = fixture();
        bridge.begin(TransactionMode::Read, Arc::new(AtomicBool::new(false))).unwrap();
        let at = |n: usize| serde_json::to_string(&serde_json::json!(["a".repeat(100), "%".to_string() + &"a".repeat(n)])).unwrap();
        // The pattern is `%` and n letters: one under the limit runs, one over it is refused.
        assert!(bridge.call("sql.query", "SELECT ? LIKE ? AS hit", &at(LIKE_PATTERN_LIMIT as usize - 2)).is_ok());
        assert!(bridge.call("sql.query", "SELECT ? LIKE ? AS hit", &at(LIKE_PATTERN_LIMIT as usize)).is_err());
        let _ = bridge.finish(false);
    }

    #[test]
    fn the_sqlite_memory_setting_is_read_and_checked() {
        assert_eq!(sqlite_memory_mb(None), Ok(1024));
        assert_eq!(sqlite_memory_mb(Some(" 2048 ")), Ok(2048));
        for wrong in ["", "63", "65537", "1.5", "lots"] {
            assert!(sqlite_memory_mb(Some(wrong)).is_err(), "{wrong:?}");
        }
    }

    #[test]
    fn rejects_sql_escape_paths_and_rolls_back_caught_errors() {
        let (path, mut bridge) = fixture();
        for sql in [
            "ATTACH DATABASE ':memory:' AS other",
            "PRAGMA writable_schema=ON",
            "SELECT * FROM _migrations",
            "SELECT * FROM sqlite_master",
            "SELECT load_extension('a')",
            "CREATE TABLE evil(x)",
            "BEGIN",
            "SELECT 1; SELECT 2",
        ] {
            bridge
                .begin(TransactionMode::Write, Arc::new(AtomicBool::new(false)))
                .unwrap();
            assert!(bridge.call("sql.query", sql, "[]").is_err(), "{sql}");
            assert!(bridge.finish(true).is_err());
        }
        bridge
            .begin(TransactionMode::Write, Arc::new(AtomicBool::new(false)))
            .unwrap();
        bridge
            .call(
                "sql.execute",
                "INSERT INTO records VALUES(?,?)",
                "[1,\"private\"]",
            )
            .unwrap();
        assert!(bridge
            .call("sql.execute", "INSERT INTO records VALUES(?,?)", "[2,true]")
            .is_err());
        assert!(bridge.finish(true).is_err());
        assert_eq!(
            open_connection(&path)
                .unwrap()
                .query_row("SELECT COUNT(*) FROM records", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
    #[test]
    fn isolates_databases_and_enforces_read_mode_and_cancellation() {
        let (_path, mut a) = fixture();
        let (_path2, mut b) = fixture();
        a.begin(TransactionMode::Write, Arc::new(AtomicBool::new(false)))
            .unwrap();
        a.call(
            "sql.execute",
            "INSERT INTO records VALUES(1,'private; data')",
            "[]",
        )
        .unwrap();
        a.finish(true).unwrap();
        b.begin(TransactionMode::Read, Arc::new(AtomicBool::new(false)))
            .unwrap();
        assert_eq!(
            b.call("sql.first", "SELECT COUNT(*) AS n FROM records", "[]")
                .unwrap()["n"],
            0
        );
        assert!(b
            .call(
                "sql.execute",
                "INSERT INTO records VALUES(1,'blocked')",
                "[]"
            )
            .is_err());
        b.finish(false).unwrap();
        let cancellation = Arc::new(AtomicBool::new(false));
        a.begin(TransactionMode::Write, cancellation.clone())
            .unwrap();
        a.call("sql.execute", "DELETE FROM records", "[]").unwrap();
        cancellation.store(true, Ordering::Relaxed);
        assert!(a.finish(true).is_err());
    }

    /// A row's columns come back in the order the statement names them, as on
    /// the PHP host. They used to be sorted by name.
    #[test]
    fn a_row_keeps_the_order_of_its_columns() {
        let (_path, mut bridge) = fixture();
        bridge.begin(TransactionMode::Read, Arc::new(AtomicBool::new(false))).unwrap();
        let row = bridge.call("sql.first", "SELECT 1 AS zz, 'b' AS aa, 3 AS mm", "[]").unwrap();
        assert_eq!(row.to_string(), r#"{"zz":1,"aa":"b","mm":3}"#);
        bridge.finish(false).unwrap();
    }

    /// `lastInsertRowid` is the id of a row the statement inserted, and 0
    /// when it inserted none. A worker keeps its connection, and SQLite keeps
    /// the last id a connection inserted until its next insert: a statement
    /// that inserted nothing answered with the row an earlier request had
    /// made, and a handler that took it for its own linked a stranger's row.
    #[test]
    fn a_statement_that_inserts_nothing_has_no_last_insert_rowid() {
        let (_path, mut bridge) = fixture();
        let begin = |bridge: &mut NativeSql| bridge.begin(TransactionMode::Write, Arc::new(AtomicBool::new(false))).unwrap();
        // One client's request makes row 1234.
        begin(&mut bridge);
        let made = bridge.call("sql.execute", "INSERT INTO records VALUES(1234,'alice')", "[]").unwrap();
        assert_eq!(made, json!({"changes": 1, "lastInsertRowid": 1234}));
        bridge.finish(true).unwrap();
        // The next request on that worker inserts nothing.
        begin(&mut bridge);
        for (sql, changes) in [
            ("INSERT OR IGNORE INTO records VALUES(1234,'bob')", 0),
            ("UPDATE records SET value = 'bob' WHERE id = 1234", 1),
            ("INSERT INTO records VALUES(1234,'bob') ON CONFLICT(id) DO UPDATE SET value = excluded.value", 1),
            ("DELETE FROM records WHERE id = 1234", 1),
        ] {
            assert_eq!(bridge.call("sql.execute", sql, "[]").unwrap(), json!({"changes": changes, "lastInsertRowid": 0}), "{sql}");
        }
        // And one that does insert still says which row, in a transaction
        // that is rolled back as well: nothing is left behind for the next.
        assert_eq!(bridge.call("sql.execute", "INSERT INTO records(value) VALUES('bob')", "[]").unwrap()["lastInsertRowid"], 1);
        bridge.finish(false).unwrap();
        begin(&mut bridge);
        assert_eq!(bridge.call("sql.execute", "UPDATE records SET value = 'x'", "[]").unwrap()["lastInsertRowid"], 0);
        bridge.finish(true).unwrap();
    }
}
