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
    if ctx.database_name.is_some_and(|db| db != "main") {
        return Authorization::Deny;
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
        CreateIndex { table_name, .. } | DropIndex { table_name, .. } => {
            migration && application_table(table_name)
        }
        Reindex { index_name } => migration && application_table(index_name),
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
        let result = conn.execute_batch(if commit && !aborted {
            "COMMIT"
        } else {
            "ROLLBACK"
        });
        if result.is_err() {
            let _ = conn.execute_batch("ROLLBACK");
        }
        self.active = false;
        if result.is_err() || commit && aborted {
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

    fn run(&self, kind: &str, sql: &str, binds: &str) -> Result<Value, String> {
        if !self.active {
            return Err("SQL requires a host-scoped request transaction".into());
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
            for (i, name) in columns.iter().enumerate() {
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
            std::env::temp_dir().join(format!("softn-private-{}.sqlite", uuid::Uuid::new_v4()));
        let conn = open_connection(&path).unwrap();
        conn.execute_batch("CREATE TABLE records(id INTEGER PRIMARY KEY, value TEXT); CREATE TABLE _migrations(name TEXT);").unwrap();
        drop(conn);
        let bridge = NativeSql::new(path.clone());
        (path, bridge)
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
}
