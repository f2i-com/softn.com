//! Persistent sandboxed SQLite 3 storage manager (`app.sql.*` + app KV store).
//!
//! Stores each `.softn` app's SQLite databases in Android's private `filesDir`
//! (`<data_dir>/<app_id>/databases/`), pre-seeding `seedSql` / `seedJson` / bundled `.db`
//! files on first boot and exposing the exact `app.sql.*` JSON protocol expected by
//! `zipp-vm` (PHP `PDO`/`SQLite3`, JS `sqlite.open`, Python `sqlite3`, Rust SQL).

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Once};

use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
use rusqlite::limits::Limit;
use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{params, params_from_iter, Connection};
use serde_json::{json, Value};

use crate::bundle::{normalize_vfs_path, DatabaseConfig};

const MAX_OPEN_HANDLES: usize = 64;
const MAX_CONTAINER_DATABASES: usize = 8;
const MAX_RESULT_ROWS: usize = 10_000;
const MAX_RESULT_BYTES: usize = 8 * 1024 * 1024;
const MAX_SQL_PAGES: i64 = 131_072; // 512 MiB @ 4 KiB page size
const SQLITE_HARD_HEAP_LIMIT_BYTES: i64 = 64 * 1024 * 1024; // 64 MiB hard cap on mobile
const MAX_SEED_TABLES: usize = 64;
const MAX_SEED_COLS: usize = 128;
const MAX_SEED_ROWS: usize = 50_000;

fn install_sqlite_hard_heap_limit() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        // SAFETY: Process-wide SQLite hard heap cap preventing a single SQL query/BLOB from OOMing Android.
        unsafe {
            rusqlite::ffi::sqlite3_hard_heap_limit64(SQLITE_HARD_HEAP_LIMIT_BYTES);
        }
    });
}

fn reject_symlink(path: &Path) -> Result<(), String> {
    if let Ok(meta) = fs::symlink_metadata(path) {
        if meta.file_type().is_symlink() {
            return Err(format!(
                "Refusing to open symlinked SQLite path: {}",
                path.display()
            ));
        }
    }
    Ok(())
}

#[derive(Clone)]
pub struct SqlStorage {
    pub db_dir: PathBuf,
    pub kv_path: PathBuf,
    pub databases: Vec<DatabaseConfig>,
    kv_conn: Arc<Mutex<Connection>>,
}

impl SqlStorage {
    pub fn new(app_data_dir: &Path, databases: Vec<DatabaseConfig>) -> Result<Self, String> {
        let db_dir = app_data_dir.join("databases");
        fs::create_dir_all(&db_dir)
            .map_err(|e| format!("Failed to create app database directory: {e}"))?;
        let kv_path = app_data_dir.join("softn_kv.sqlite");
        let conn = Self::open_kv_connection(&kv_path)?;
        let storage = Self {
            db_dir,
            kv_path,
            databases,
            kv_conn: Arc::new(Mutex::new(conn)),
        };
        Ok(storage)
    }

    fn open_kv_connection(kv_path: &Path) -> Result<Connection, String> {
        reject_symlink(kv_path)?;
        let conn = Connection::open(kv_path)
            .map_err(|e| format!("Failed to open KV SQLite: {e}"))?;
        let _ = conn.busy_timeout(std::time::Duration::from_secs(5));
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA synchronous=NORMAL;
             PRAGMA trusted_schema=OFF;
             PRAGMA temp_store=MEMORY;
             PRAGMA cache_size=-2000;
             PRAGMA max_page_count=32768;
             CREATE TABLE IF NOT EXISTS local_storage (
                 k TEXT PRIMARY KEY,
                 v TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS xdb_collections (
                 collection TEXT PRIMARY KEY,
                 records_json TEXT NOT NULL
             );",
        )
        .map_err(|e| format!("Failed to initialize KV tables: {e}"))?;
        Ok(conn)
    }

    pub fn load_local_storage(&self) -> HashMap<String, String> {
        let mut map = HashMap::new();
        let Ok(conn) = self.kv_conn.lock() else {
            return map;
        };
        let Ok(mut stmt) = conn.prepare_cached("SELECT k, v FROM local_storage") else {
            return map;
        };
        let Ok(rows) = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))) else {
            return map;
        };
        for row in rows.flatten() {
            map.insert(row.0, row.1);
        }
        map
    }

    pub fn set_local_storage(&self, key: &str, value: &str) {
        if let Ok(conn) = self.kv_conn.lock() {
            if let Ok(mut stmt) = conn.prepare_cached(
                "INSERT INTO local_storage (k, v) VALUES (?1, ?2)
                 ON CONFLICT(k) DO UPDATE SET v = excluded.v",
            ) {
                let _ = stmt.execute(params![key, value]);
            }
        }
    }

    pub fn replace_local_storage(&self, entries: &[(String, String)]) {
        if let Ok(mut conn) = self.kv_conn.lock() {
            if let Ok(tx) = conn.transaction() {
                let _ = tx.execute("DELETE FROM local_storage", []);
                if let Ok(mut stmt) = tx.prepare_cached(
                    "INSERT INTO local_storage (k, v) VALUES (?1, ?2)
                     ON CONFLICT(k) DO UPDATE SET v = excluded.v",
                ) {
                    for (k, v) in entries {
                        let _ = stmt.execute(params![k, v]);
                    }
                }
                let _ = tx.commit();
            }
        }
    }

    pub fn remove_local_storage(&self, key: &str) {
        if let Ok(conn) = self.kv_conn.lock() {
            if let Ok(mut stmt) = conn.prepare_cached("DELETE FROM local_storage WHERE k = ?1") {
                let _ = stmt.execute(params![key]);
            }
        }
    }

    pub fn clear_local_storage(&self) {
        if let Ok(conn) = self.kv_conn.lock() {
            let _ = conn.execute("DELETE FROM local_storage", []);
        }
    }

    pub fn load_xdb_collections(&self) -> HashMap<String, Value> {
        let mut map = HashMap::new();
        let Ok(conn) = self.kv_conn.lock() else {
            return map;
        };
        let Ok(mut stmt) = conn.prepare_cached("SELECT collection, records_json FROM xdb_collections") else {
            return map;
        };
        let Ok(rows) = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))) else {
            return map;
        };
        for (col, raw) in rows.flatten() {
            if let Ok(val) = serde_json::from_str::<Value>(&raw) {
                map.insert(col, val);
            }
        }
        map
    }

    pub fn save_xdb_collection(&self, collection: &str, records_json: &str) {
        if let Ok(conn) = self.kv_conn.lock() {
            if let Ok(mut stmt) = conn.prepare_cached(
                "INSERT INTO xdb_collections (collection, records_json) VALUES (?1, ?2)
                 ON CONFLICT(collection) DO UPDATE SET records_json = excluded.records_json",
            ) {
                let _ = stmt.execute(params![collection, records_json]);
            }
        }
    }

    pub fn clear_xdb_collections(&self) {
        if let Ok(conn) = self.kv_conn.lock() {
            let _ = conn.execute("DELETE FROM xdb_collections", []);
        }
    }

    pub fn count_local_storage_keys(&self) -> usize {
        self.kv_conn
            .lock()
            .ok()
            .and_then(|conn| {
                conn.query_row("SELECT COUNT(*) FROM local_storage", [], |r| r.get::<_, i64>(0))
                    .ok()
            })
            .unwrap_or(0)
            .max(0) as usize
    }

    pub fn has_local_storage_key(&self, key: &str) -> bool {
        self.kv_conn
            .lock()
            .ok()
            .and_then(|conn| {
                conn.query_row(
                    "SELECT 1 FROM local_storage WHERE k = ?1 LIMIT 1",
                    params![key],
                    |_| Ok(true),
                )
                .ok()
            })
            .unwrap_or(false)
    }

    pub fn count_xdb_collections(&self) -> usize {
        self.kv_conn
            .lock()
            .ok()
            .and_then(|conn| {
                conn.query_row("SELECT COUNT(*) FROM xdb_collections", [], |r| r.get::<_, i64>(0))
                    .ok()
            })
            .unwrap_or(0)
            .max(0) as usize
    }

    pub fn has_xdb_collection(&self, collection: &str) -> bool {
        self.kv_conn
            .lock()
            .ok()
            .and_then(|conn| {
                conn.query_row(
                    "SELECT 1 FROM xdb_collections WHERE collection = ?1 LIMIT 1",
                    params![collection],
                    |_| Ok(true),
                )
                .ok()
            })
            .unwrap_or(false)
    }

    pub fn normalize_db_key(raw: &str) -> (String, bool) {
        let mut s = raw.trim().to_string();
        if s.is_empty() || s == ":memory:" || s == "sqlite::memory:" || s == "sqlite://:memory:" {
            return (":memory:".to_string(), true);
        }
        if let Some(rest) = s.strip_prefix("sqlite://") {
            s = rest.to_string();
        } else if let Some(rest) = s.strip_prefix("sqlite:") {
            s = rest.to_string();
        } else if let Some(rest) = s.strip_prefix("file:") {
            s = rest.to_string();
        }
        if let Some((before, query)) = s.split_once('?') {
            if query.contains("mode=memory") && !query.contains("cache=shared") {
                return (":memory:".to_string(), true);
            }
            s = before.to_string();
        }
        if s == ":memory:" {
            return (":memory:".to_string(), true);
        }
        let clean = normalize_vfs_path(&s);
        if clean.is_empty() {
            ("default.db".to_string(), false)
        } else {
            (clean, false)
        }
    }

    pub fn resolve_db_path(&self, raw: &str) -> Result<Option<PathBuf>, String> {
        let (key, in_memory) = Self::normalize_db_key(raw);
        if in_memory {
            return Ok(None);
        }
        let filename = key
            .rsplit('/')
            .next()
            .unwrap_or("app.db")
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' {
                    c
                } else {
                    '_'
                }
            })
            .collect::<String>();

        let mut safe_name = if filename.is_empty() || filename.starts_with('.') {
            "app.db".to_string()
        } else {
            filename
        };
        if !safe_name.ends_with(".db")
            && !safe_name.ends_with(".sqlite")
            && !safe_name.ends_with(".sqlite3")
        {
            safe_name.push_str(".db");
        }

        // If the manifest declares exactly one database and the script opens a generic alias
        // (e.g. `app.db`, `data/app.db`, `sales.db`), map cleanly to that configured DB file.
        let resolved = if self.databases.len() == 1 {
            let cfg = &self.databases[0];
            let target = cfg.file.as_deref().unwrap_or(&cfg.name);
            let (t_key, _) = Self::normalize_db_key(target);
            let t_base = t_key.rsplit('/').next().unwrap_or(&cfg.name);
            let mut t_name: String = t_base
                .chars()
                .map(|c| {
                    if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' {
                        c
                    } else {
                        '_'
                    }
                })
                .collect();
            if t_name.is_empty() || t_name.starts_with('.') {
                t_name = "app.db".to_string();
            }
            if !t_name.ends_with(".db")
                && !t_name.ends_with(".sqlite")
                && !t_name.ends_with(".sqlite3")
            {
                t_name.push_str(".db");
            }
            if safe_name == "app.db" || safe_name == "default.db" || safe_name == t_name {
                self.db_dir.join(t_name)
            } else {
                self.db_dir.join(safe_name)
            }
        } else {
            self.db_dir.join(safe_name)
        };

        reject_symlink(&resolved)?;
        for suffix in ["-wal", "-shm", "-journal"] {
            reject_symlink(&PathBuf::from(format!("{}{suffix}", resolved.display())))?;
        }
        Ok(Some(resolved))
    }

    pub fn open_configured_connection(path: Option<&Path>) -> Result<Connection, String> {
        install_sqlite_hard_heap_limit();
        if let Some(p) = path {
            reject_symlink(p)?;
        }
        let mut conn = match path {
            Some(p) => Connection::open(p).map_err(|e| format!("Failed to open SQLite DB: {e}"))?,
            None => Connection::open_in_memory()
                .map_err(|e| format!("Failed to open in-memory SQLite DB: {e}"))?,
        };
        let _ = conn.busy_timeout(std::time::Duration::from_secs(5));
        let pragmas = if path.is_some() {
            format!(
                "PRAGMA journal_mode=WAL;
                 PRAGMA synchronous=NORMAL;
                 PRAGMA foreign_keys=ON;
                 PRAGMA trusted_schema=OFF;
                 PRAGMA temp_store=MEMORY;
                 PRAGMA cache_size=-4000;
                 PRAGMA max_page_count={MAX_SQL_PAGES};"
            )
        } else {
            format!(
                "PRAGMA foreign_keys=ON;
                 PRAGMA trusted_schema=OFF;
                 PRAGMA temp_store=MEMORY;
                 PRAGMA max_page_count={MAX_SQL_PAGES};"
            )
        };
        let _ = conn.execute_batch(&pragmas);
        let _ = conn.set_limit(Limit::SQLITE_LIMIT_LENGTH, MAX_RESULT_BYTES as i32);
        let _ = conn.set_limit(Limit::SQLITE_LIMIT_SQL_LENGTH, 512 * 1024);
        let _ = conn.set_limit(Limit::SQLITE_LIMIT_COLUMN, 256);
        let _ = conn.set_limit(Limit::SQLITE_LIMIT_ATTACHED, 0);
        let _ = conn.set_limit(Limit::SQLITE_LIMIT_VARIABLE_NUMBER, 999);
        let _ = conn.set_limit(Limit::SQLITE_LIMIT_EXPR_DEPTH, 128);
        let _ = conn.set_limit(Limit::SQLITE_LIMIT_VDBE_OP, 250_000);
        let _ = conn.set_limit(Limit::SQLITE_LIMIT_WORKER_THREADS, 0);
        let _ = conn.set_limit(Limit::SQLITE_LIMIT_LIKE_PATTERN_LENGTH, 512);

        conn.authorizer(Some(|ctx: AuthContext<'_>| {
            if let Some(db_name) = ctx.database_name {
                if db_name != "main" && db_name != "temp" {
                    return Authorization::Deny;
                }
            }
            match ctx.action {
                AuthAction::Attach { .. }
                | AuthAction::Detach { .. }
                | AuthAction::CreateVtable { .. }
                | AuthAction::DropVtable { .. } => Authorization::Deny,
                AuthAction::Function { function_name }
                    if function_name.eq_ignore_ascii_case("load_extension")
                        || function_name.eq_ignore_ascii_case("fts3_tokenizer") =>
                {
                    Authorization::Deny
                }
                AuthAction::Pragma { pragma_name, pragma_value } => {
                    let lower = pragma_name.to_ascii_lowercase();
                    let allowed_read = matches!(
                        lower.as_str(),
                        "table_info"
                            | "table_xinfo"
                            | "table_list"
                            | "index_list"
                            | "index_info"
                            | "index_xinfo"
                            | "foreign_key_list"
                            | "foreign_keys"
                            | "user_version"
                            | "application_id"
                            | "schema_version"
                            | "busy_timeout"
                            | "encoding"
                            | "integrity_check"
                            | "quick_check"
                            | "page_count"
                            | "page_size"
                            | "freelist_count"
                    );
                    if !allowed_read {
                        return Authorization::Deny;
                    }
                    if pragma_value.is_some()
                        && !matches!(
                            lower.as_str(),
                            "foreign_keys" | "user_version" | "application_id"
                        )
                    {
                        return Authorization::Deny;
                    }
                    Authorization::Allow
                }
                _ => Authorization::Allow,
            }
        }))
        .map_err(|e| format!("Cannot install SQLite authorizer: {e}"))?;

        Ok(conn)
    }

    pub fn preseed_all(&self, vfs: &HashMap<String, Vec<u8>>) -> Result<(), String> {
        fs::create_dir_all(&self.db_dir)
            .map_err(|e| format!("Failed to create databases dir: {e}"))?;

        for cfg in &self.databases {
            let target = cfg.file.as_deref().unwrap_or(&cfg.name);
            let Some(path) = self.resolve_db_path(target)? else {
                continue;
            };
            let marker = PathBuf::from(format!("{}.softn_seeded", path.display()));
            if marker.exists() {
                continue;
            }
            if !path.exists() {
                if let Some(file_key) = cfg.file.as_deref() {
                    let norm = normalize_vfs_path(file_key);
                    if let Some(bytes) = vfs.get(&norm) {
                        fs::write(&path, bytes)
                            .map_err(|e| format!("Failed to unpack bundled DB '{norm}': {e}"))?;
                    }
                }
            }
            let conn = Self::open_configured_connection(Some(&path))?;
            if let Some(seed_sql) = &cfg.seed_sql {
                let norm = normalize_vfs_path(seed_sql);
                let sql_text = vfs
                    .get(&norm)
                    .map(|b| String::from_utf8_lossy(b).into_owned())
                    .unwrap_or_else(|| seed_sql.clone());
                if !sql_text.trim().is_empty() {
                    conn.execute_batch(&sql_text)
                        .map_err(|e| format!("Failed to run seedSql for DB '{}': {e}", cfg.name))?;
                }
            }
            if let Some(seed_json) = &cfg.seed_json {
                let payload = match seed_json {
                    Value::String(s) => {
                        let norm = normalize_vfs_path(s);
                        vfs.get(&norm)
                            .map(|b| String::from_utf8_lossy(b).into_owned())
                            .unwrap_or_else(|| s.clone())
                    }
                    other => other.to_string(),
                };
                if !payload.trim().is_empty() {
                    let _ = apply_seed_json(&conn, &payload)?;
                }
            }
            let _ = fs::write(&marker, b"1");
        }
        Ok(())
    }
}

pub struct RequestSqlBridge {
    storage: SqlStorage,
    handles: HashMap<u64, Connection>,
    next_id: u64,
    abort: Arc<AtomicBool>,
}

impl RequestSqlBridge {
    pub fn new(storage: SqlStorage, abort: Arc<AtomicBool>) -> Self {
        Self {
            storage,
            handles: HashMap::new(),
            next_id: 1,
            abort,
        }
    }

    fn is_sidecar_name(raw: &str) -> bool {
        let (key, _) = SqlStorage::normalize_db_key(raw);
        let lower = key.to_ascii_lowercase();
        lower.ends_with("-wal")
            || lower.ends_with("-shm")
            || lower.ends_with("-journal")
            || lower.ends_with(".softn_seeded")
    }

    fn count_db_files(&self) -> usize {
        let Ok(entries) = fs::read_dir(&self.storage.db_dir) else {
            return 0;
        };
        entries
            .flatten()
            .filter(|e| {
                let name = e.file_name().to_string_lossy().to_ascii_lowercase();
                (name.ends_with(".db") || name.ends_with(".sqlite") || name.ends_with(".sqlite3"))
                    && !name.ends_with("-wal")
                    && !name.ends_with("-shm")
                    && !name.ends_with("-journal")
            })
            .count()
    }

    pub fn call(&mut self, kind: &str, args: &[String]) -> String {
        if self.abort.load(Ordering::Relaxed) {
            return json!({ "error": "Request timed out", "code": 9, "unique": false }).to_string();
        }
        let op = kind.strip_prefix("app.sql.").unwrap_or(kind);
        let arg = |idx: usize| args.get(idx).map(String::as_str).unwrap_or("");
        match op {
            "open" => {
                if self.handles.len() >= MAX_OPEN_HANDLES {
                    return json!({ "error": "Too many open SQLite handles", "code": 18, "unique": false }).to_string();
                }
                if Self::is_sidecar_name(arg(0)) {
                    return json!({ "error": "Cannot open SQLite sidecar file directly", "code": 1, "unique": false }).to_string();
                }
                match self.storage.resolve_db_path(arg(0)) {
                    Ok(path) => {
                        if let Some(ref p) = path {
                            if !p.exists() && self.count_db_files() >= MAX_CONTAINER_DATABASES {
                                return json!({
                                    "error": format!("Database file limit exceeded (max {MAX_CONTAINER_DATABASES})"),
                                    "code": 18,
                                    "unique": false
                                })
                                .to_string();
                            }
                        }
                        match SqlStorage::open_configured_connection(path.as_deref()) {
                            Ok(mut conn) => {
                                let abort = self.abort.clone();
                                let _ = conn.progress_handler(
                                    1000,
                                    Some(move || abort.load(Ordering::Relaxed)),
                                );
                                let id = self.next_id;
                                self.next_id += 1;
                                self.handles.insert(id, conn);
                                json!({ "id": id }).to_string()
                            }
                            Err(e) => classify_sqlite_error(&e).to_string(),
                        }
                    }
                    Err(e) => classify_sqlite_error(&e).to_string(),
                }
            }
            "execute" => {
                let id = arg(0).parse::<u64>().unwrap_or(0);
                let sql = arg(1);
                let params_raw = arg(2).trim();
                let Some(conn) = self.handles.get(&id) else {
                    return json!({ "error": format!("Invalid sqlite handle {id}"), "code": 21, "unique": false }).to_string();
                };
                match run_execute(conn, sql, params_raw) {
                    Ok(v) => v.to_string(),
                    Err(e) => classify_sqlite_error(&e).to_string(),
                }
            }
            "query" => {
                let id = arg(0).parse::<u64>().unwrap_or(0);
                let sql = arg(1);
                let params_raw = arg(2).trim();
                let Some(conn) = self.handles.get(&id) else {
                    return json!({ "error": format!("Invalid sqlite handle {id}"), "code": 21, "unique": false }).to_string();
                };
                match run_query(conn, sql, params_raw) {
                    Ok(v) => v.to_string(),
                    Err(e) => classify_sqlite_error(&e).to_string(),
                }
            }
            "seed_json" => {
                let id = arg(0).parse::<u64>().unwrap_or(0);
                let payload = arg(1);
                let Some(conn) = self.handles.get(&id) else {
                    return json!({ "error": format!("Invalid sqlite handle {id}"), "code": 21, "unique": false }).to_string();
                };
                match apply_seed_json(conn, payload) {
                    Ok(v) => v.to_string(),
                    Err(e) => classify_sqlite_error(&e).to_string(),
                }
            }
            "close" => {
                let id = arg(0).parse::<u64>().unwrap_or(0);
                self.handles.remove(&id);
                json!({ "ok": true }).to_string()
            }
            other => json!({ "error": format!("Unsupported app.sql op: {other}"), "code": 1, "unique": false }).to_string(),
        }
    }
}

fn parse_sql_params(params_raw: &str) -> Result<Vec<SqlValue>, String> {
    if params_raw.is_empty() {
        return Ok(Vec::new());
    }
    let val: Value = serde_json::from_str(params_raw)
        .map_err(|e| format!("Invalid SQL params JSON: {e}"))?;
    match val {
        Value::Array(arr) => Ok(arr.iter().map(json_to_sql_value).collect()),
        Value::Null => Ok(Vec::new()),
        other => Ok(vec![json_to_sql_value(&other)]),
    }
}

fn run_execute(conn: &Connection, sql: &str, params_raw: &str) -> Result<Value, String> {
    let sql_params = parse_sql_params(params_raw)?;
    if sql_params.is_empty() && sql.contains(';') {
        // Multi-statement DDL/batch execution
        let trimmed = sql.trim();
        let multi = trimmed.trim_end_matches(';').contains(';');
        if multi {
            conn.execute_batch(trimmed).map_err(|e| e.to_string())?;
            let changes = conn.changes();
            let last_id = conn.last_insert_rowid();
            return Ok(json!({
                "changes": changes,
                "rows_affected": changes,
                "lastInsertRowid": last_id,
                "last_insert_rowid": last_id
            }));
        }
    }
    let changes = conn
        .execute(sql, params_from_iter(sql_params))
        .map_err(|e| e.to_string())?;
    let last_id = conn.last_insert_rowid();
    Ok(json!({
        "changes": changes,
        "rows_affected": changes,
        "lastInsertRowid": last_id,
        "last_insert_rowid": last_id
    }))
}

fn run_query(conn: &Connection, sql: &str, params_raw: &str) -> Result<Value, String> {
    let sql_params = parse_sql_params(params_raw)?;
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let col_count = stmt.column_count();
    if col_count == 0 {
        let changes = stmt
            .execute(params_from_iter(sql_params))
            .map_err(|e| e.to_string())?;
        let last_id = conn.last_insert_rowid();
        return Ok(json!({
            "columns": [],
            "rows": [],
            "changes": changes,
            "rows_affected": changes,
            "lastInsertRowid": last_id,
            "last_insert_rowid": last_id
        }));
    }
    let columns: Vec<String> = (0..col_count)
        .map(|i| stmt.column_name(i).unwrap_or("").to_string())
        .collect();

    let mut rows_out: Vec<Value> = Vec::new();
    let mut total_bytes: usize = 0;
    {
        let mut rows = stmt
            .query(params_from_iter(sql_params))
            .map_err(|e| e.to_string())?;
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            if rows_out.len() >= MAX_RESULT_ROWS {
                return Err(format!(
                    "SQLite query result exceeded maximum row limit ({MAX_RESULT_ROWS})"
                ));
            }
            let mut arr = Vec::with_capacity(col_count);
            for i in 0..col_count {
                let vref = row.get_ref(i).map_err(|e| e.to_string())?;
                // Account serialized byte budget BEFORE materializing JSON arrays/hex for BLOBs
                // so a single large BLOB cannot OOM-kill the process before the limit check runs.
                let est_bytes = match vref {
                    ValueRef::Text(t) => t.len().saturating_add(4),
                    ValueRef::Blob(b) => b.len().saturating_mul(6).saturating_add(32),
                    _ => 12,
                };
                total_bytes = total_bytes.saturating_add(est_bytes);
                if total_bytes > MAX_RESULT_BYTES {
                    return Err("SQLite query result exceeded maximum byte limit".into());
                }
                arr.push(sql_ref_to_json(vref));
            }
            rows_out.push(Value::Array(arr));
        }
    }

    Ok(json!({
        "columns": columns,
        "rows": rows_out,
        "changes": conn.changes(),
        "rows_affected": conn.changes(),
        "lastInsertRowid": conn.last_insert_rowid(),
        "last_insert_rowid": conn.last_insert_rowid()
    }))
}

fn json_to_sql_value(v: &Value) -> SqlValue {
    match v {
        Value::Null => SqlValue::Null,
        Value::Bool(b) => SqlValue::Integer(if *b { 1 } else { 0 }),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                SqlValue::Integer(i)
            } else if let Some(u) = n.as_u64() {
                if u <= i64::MAX as u64 {
                    SqlValue::Integer(u as i64)
                } else {
                    SqlValue::Real(u as f64)
                }
            } else if let Some(f) = n.as_f64() {
                if f.is_finite() {
                    SqlValue::Real(f)
                } else {
                    SqlValue::Null
                }
            } else {
                SqlValue::Null
            }
        }
        Value::String(s) => SqlValue::Text(s.clone()),
        Value::Object(map) => {
            if let Some(Value::Array(arr)) = map.get("__blob") {
                let bytes: Vec<u8> = arr
                    .iter()
                    .filter_map(|v| v.as_u64().and_then(|n| u8::try_from(n).ok()))
                    .collect();
                return SqlValue::Blob(bytes);
            }
            if let Some(Value::String(hex)) = map.get("hex") {
                if let Some(bytes) = decode_hex(hex) {
                    return SqlValue::Blob(bytes);
                }
            }
            SqlValue::Text(v.to_string())
        }
        Value::Array(_) => SqlValue::Text(v.to_string()),
    }
}

fn decode_hex(hex: &str) -> Option<Vec<u8>> {
    if !hex.len().is_multiple_of(2) {
        return None;
    }
    let mut out = Vec::with_capacity(hex.len() / 2);
    let bytes = hex.as_bytes();
    for i in (0..bytes.len()).step_by(2) {
        let s = std::str::from_utf8(&bytes[i..i + 2]).ok()?;
        out.push(u8::from_str_radix(s, 16).ok()?);
    }
    Some(out)
}

fn encode_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        use std::fmt::Write;
        let _ = write!(&mut out, "{b:02x}");
    }
    out
}

fn sql_ref_to_json(val: ValueRef<'_>) -> Value {
    match val {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => Value::from(i),
        ValueRef::Real(f) => serde_json::Number::from_f64(f)
            .map(Value::Number)
            .unwrap_or(Value::Null),
        ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => json!({ "__blob": b, "hex": encode_hex(b) }),
    }
}

fn classify_sqlite_error(msg: &str) -> Value {
    let lower = msg.to_ascii_lowercase();
    let unique = lower.contains("unique constraint failed")
        || lower.contains("primary key constraint failed");
    let constraint = unique
        || lower.contains("not null constraint failed")
        || lower.contains("foreign key constraint failed")
        || lower.contains("check constraint failed");
    let code = if unique {
        2067
    } else if constraint {
        19
    } else {
        1
    };
    json!({ "error": msg, "code": code, "unique": unique })
}

fn sanitize_ident(name: &str) -> Result<String, String> {
    if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err(format!("Invalid SQL identifier in seedJson: {name:?}"));
    }
    Ok(format!("\"{name}\""))
}

fn apply_seed_json(conn: &Connection, payload: &str) -> Result<Value, String> {
    let parsed: Value = serde_json::from_str(payload)
        .map_err(|e| format!("Invalid seedJson payload: {e}"))?;
    let mut tables_created = 0usize;
    let mut tables_seeded = 0usize;
    let mut rows_inserted = 0usize;
    let mut statements = 0usize;

    let tables = parsed
        .get("tables")
        .and_then(|v| v.as_object())
        .or_else(|| parsed.as_object());
    let Some(tables) = tables else {
        return Ok(json!({
            "tablesCreated": 0,
            "tablesSeeded": 0,
            "rowsInserted": 0,
            "statementsExecuted": 0
        }));
    };

    if tables.len() > MAX_SEED_TABLES {
        return Err(format!("seedJson exceeds max table limit ({MAX_SEED_TABLES})"));
    }

    let in_tx = !conn.is_autocommit();
    if !in_tx {
        conn.execute_batch("BEGIN")
            .map_err(|e| format!("seedJson BEGIN failed: {e}"))?;
    }

    let run = (|| -> Result<Value, String> {
        let mut total_rows_seen = 0usize;
        for (table_name, rows_val) in tables {
            let Some(rows) = rows_val.as_array() else {
                continue;
            };
            if rows.is_empty() {
                continue;
            }
            total_rows_seen = total_rows_seen.saturating_add(rows.len());
            if total_rows_seen > MAX_SEED_ROWS {
                return Err(format!("seedJson exceeds max row limit ({MAX_SEED_ROWS})"));
            }
            let quoted_table = sanitize_ident(table_name)?;
            let mut col_names: Vec<String> = Vec::new();
            let mut col_seen: HashSet<&str> = HashSet::new();
            for row in rows {
                if let Some(obj) = row.as_object() {
                    for k in obj.keys() {
                        if col_seen.insert(k.as_str()) {
                            if col_names.len() >= MAX_SEED_COLS {
                                return Err(format!(
                                    "seedJson table '{table_name}' exceeds max column limit ({MAX_SEED_COLS})"
                                ));
                            }
                            col_names.push(k.clone());
                        }
                    }
                }
            }
            if col_names.is_empty() {
                continue;
            }
            let col_defs: Result<Vec<String>, String> = col_names
                .iter()
                .map(|c| Ok(format!("{} TEXT", sanitize_ident(c)?)))
                .collect();
            let create_sql = format!(
                "CREATE TABLE IF NOT EXISTS {} ({})",
                quoted_table,
                col_defs?.join(", ")
            );
            conn.execute(&create_sql, [])
                .map_err(|e| format!("seedJson CREATE TABLE failed: {e}"))?;
            tables_created += 1;
            statements += 1;

            let quoted_cols: Result<Vec<String>, String> =
                col_names.iter().map(|c| sanitize_ident(c)).collect();
            let placeholders = vec!["?"; col_names.len()].join(", ");
            let insert_sql = format!(
                "INSERT OR IGNORE INTO {} ({}) VALUES ({})",
                quoted_table,
                quoted_cols?.join(", "),
                placeholders
            );
            let mut stmt = conn
                .prepare(&insert_sql)
                .map_err(|e| format!("seedJson prepare failed: {e}"))?;
            for row in rows {
                if let Some(obj) = row.as_object() {
                    let vals: Vec<SqlValue> = col_names
                        .iter()
                        .map(|c| obj.get(c).map(json_to_sql_value).unwrap_or(SqlValue::Null))
                        .collect();
                    let n = stmt
                        .execute(params_from_iter(vals))
                        .map_err(|e| format!("seedJson insert failed: {e}"))?;
                    rows_inserted += n;
                    statements += 1;
                }
            }
            tables_seeded += 1;
        }
        Ok(json!({
            "tablesCreated": tables_created,
            "tablesSeeded": tables_seeded,
            "rowsInserted": rows_inserted,
            "statementsExecuted": statements
        }))
    })();

    if !in_tx {
        match &run {
            Ok(_) => {
                conn.execute_batch("COMMIT")
                    .map_err(|e| format!("seedJson COMMIT failed: {e}"))?;
            }
            Err(_) => {
                let _ = conn.execute_batch("ROLLBACK");
            }
        }
    }
    run
}
