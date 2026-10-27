//! The PHP host's SQL rules (runtime/sql.mjs), on rusqlite: the database an
//! app's private logic reads and writes, as the Node runner opens and
//! guards it. Those rules are the Rust host's (bridges/sql.rs `authorize`,
//! `single_statement`), so an app behaves the same on every host; where the
//! Node runner differs from the Rust host on purpose (the connection's
//! limits, record-event triggers), this follows the Node runner, whose
//! databases these are.

use std::{
    collections::{HashMap, HashSet},
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

use rusqlite::{
    config::DbConfig,
    hooks::{AuthAction, AuthContext, Authorization},
    limits::Limit,
    types::{Value as SqlValue, ValueRef},
    Connection,
};
use serde_json::{Map, Value};

use crate::{js::MAX_SAFE, record_events::RecordEvents, HostError};

/// sql.mjs SQL_LIMITS: no attached database, 100 parameters, 100,000 opcodes,
/// and nothing that would make data an app already stored unreadable.
pub const VDBE_OP_LIMIT: i32 = 100_000;

/// sql.mjs: a query's rows, as JSON, may come to 2 MiB.
const RESULT_LIMIT: usize = 2 * 1024 * 1024;

/// Open the app's database as request-worker.mjs opens it.
pub fn open(path: &Path) -> Result<Connection, HostError> {
    let conn = Connection::open(path).map_err(HostError::sqlite)?;
    // node:sqlite's DatabaseSync: double-quoted string literals are off (they
    // are identifiers only), extensions cannot be loaded.
    conn.set_db_config(DbConfig::SQLITE_DBCONFIG_DQS_DML, false).map_err(HostError::sqlite)?;
    conn.set_db_config(DbConfig::SQLITE_DBCONFIG_DQS_DDL, false).map_err(HostError::sqlite)?;
    conn.set_limit(Limit::SQLITE_LIMIT_ATTACHED, 0).map_err(HostError::sqlite)?;
    conn.set_limit(Limit::SQLITE_LIMIT_VARIABLE_NUMBER, 100).map_err(HostError::sqlite)?;
    conn.set_limit(Limit::SQLITE_LIMIT_VDBE_OP, VDBE_OP_LIMIT).map_err(HostError::sqlite)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).map_err(HostError::library)?;
    }
    // Lock waits first, then the rest (request-worker.mjs). Temporary tables
    // and sorts stay in memory, as on the Rust host, where a statement that
    // spilled to temporary files could fill the disk every app shares before
    // the deadline; SQLite's memory is held to the request's limit besides
    // (limits.rs; the Node runner's node:sqlite has neither).
    conn.execute_batch(
        "PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; \
         PRAGMA trusted_schema=OFF; PRAGMA max_page_count=131072; PRAGMA temp_store=MEMORY;",
    )
    .map_err(HostError::sqlite)?;
    // The most memory SQLite may hold in this process: an allocation past it
    // fails the statement ("out of memory") instead of growing the process.
    // SAFETY: a plain call into the bundled SQLite, process-wide, which this
    // one-request process may set as it likes.
    unsafe { rusqlite::ffi::sqlite3_hard_heap_limit64(crate::limits::limits().sqlite) };
    Ok(conn)
}

/// Take the authorizer off the connection.
pub fn clear(conn: &Connection) -> Result<(), HostError> {
    conn.authorizer(None::<fn(AuthContext<'_>) -> Authorization>).map_err(HostError::sqlite)
}

/// Functions app SQL may call, at request time and in migrations.
pub const RUNTIME_FUNCTIONS: &[&str] = &[
    "count", "min", "max", "sum", "avg", "total", "coalesce", "ifnull", "nullif", "length", "lower", "upper",
    "trim", "ltrim", "rtrim", "substr", "substring", "replace", "instr", "abs", "round", "like", "glob", "typeof",
    "unicode", "char", "hex", "quote",
];
/// Migrations may also read the clock, and ALTER TABLE's own SQL calls these.
pub const MIGRATION_ONLY_FUNCTIONS: &[&str] = &[
    "datetime", "date", "time", "strftime", "julianday", "unixepoch", "printf", "format", "sqlite_rename_column",
    "sqlite_rename_table", "sqlite_rename_test", "sqlite_rename_quotefix", "sqlite_drop_column",
];

/// An app's own table: not SQLite's and not in the host's `_` namespace.
pub fn app_table(name: &str) -> bool {
    !name.is_empty() && !name.to_lowercase().starts_with("sqlite_") && !name.starts_with('_')
}

fn readable(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    app_table(name) && !lower.starts_with("pragma_") && lower != "dbstat"
}

fn allow(yes: bool) -> Authorization {
    if yes {
        Authorization::Allow
    } else {
        Authorization::Deny
    }
}

/// The migration authorizer (sql.mjs `migrationAuthorizer`).
pub fn migration_authorize(ctx: &AuthContext<'_>) -> Authorization {
    use AuthAction::*;
    if let AlterTable { database_name, table_name } = ctx.action {
        return allow(database_name == "main" && app_table(table_name));
    }
    if let Some(database) = ctx.database_name.filter(|d| *d != "main") {
        let temp_schema = |t: &str| t == "sqlite_temp_master" || t == "sqlite_temp_schema";
        return allow(
            database == "temp"
                && match ctx.action {
                    Read { table_name, .. } | Update { table_name, .. } => temp_schema(table_name),
                    _ => false,
                },
        );
    }
    allow(match ctx.action {
        Select | Recursive => true,
        Read { table_name, .. } | Insert { table_name } | Update { table_name, .. } | Delete { table_name } => {
            app_table(table_name) || table_name.starts_with("sqlite_")
        }
        CreateTable { table_name } => app_table(table_name) || table_name == "sqlite_sequence",
        DropTable { table_name } => app_table(table_name),
        Reindex { index_name } => app_table(index_name),
        CreateIndex { index_name, table_name } | DropIndex { index_name, table_name } => {
            app_table(table_name) && !index_name.starts_with('_')
        }
        Function { function_name } => {
            let name = function_name.to_lowercase();
            RUNTIME_FUNCTIONS.contains(&name.as_str()) || MIGRATION_ONLY_FUNCTIONS.contains(&name.as_str())
        }
        _ => false,
    })
}

/// What `scan_statement` reads of a statement.
pub struct Scan {
    pub keyword: String,
    /// How many parameters it has, as SQLite numbers them.
    pub parameters: usize,
    /// Its :name, @name, $name and #name parameters, each with its number.
    pub named: Vec<(usize, String)>,
}

/// One statement, as the Rust host's `single_statement` reads it, with its
/// leading keyword and its parameters (sql.mjs `scanStatement`).
pub fn scan_statement(sql: &str) -> Result<Scan, HostError> {
    if sql.is_empty() || sql.len() > 20_000 || sql.contains('\0') {
        return Err(HostError::own("SQL text exceeds host limits"));
    }
    let chars: Vec<char> = sql.chars().collect();
    let n = chars.len();
    let space = |c: char| matches!(c, ' ' | '\t' | '\n' | '\u{c}' | '\r');
    let id_char = |c: Option<&char>| c.is_some_and(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '$' || (*c as u32) >= 0x80);
    let starts = |i: usize, s: &str| s.chars().enumerate().all(|(k, c)| chars.get(i + k) == Some(&c));
    let mut named: Vec<(usize, String)> = Vec::new();
    let (mut i, mut ended, mut parameters, mut keyword): (usize, bool, usize, Option<String>) = (0, false, 0, None);
    while i < n {
        let c = chars[i];
        if space(c) {
            i += 1;
            continue;
        }
        if starts(i, "--") {
            i = (i + 2..n).find(|&j| chars[j] == '\n').map_or(n, |j| j + 1);
            continue;
        }
        if starts(i, "/*") {
            let end = (i + 2..n.saturating_sub(1)).find(|&j| chars[j] == '*' && chars[j + 1] == '/');
            match end {
                Some(end) => i = end + 2,
                None => return Err(HostError::own("Unterminated SQL comment")),
            }
            continue;
        }
        if ended {
            return Err(HostError::own("Only one SQL statement is allowed"));
        }
        if c == ';' {
            ended = true;
            i += 1;
            continue;
        }
        if matches!(c, '\'' | '"' | '`' | '[') {
            let close = if c == '[' { ']' } else { c };
            i += 1;
            while i < n {
                if chars[i] == close {
                    i += 1;
                    if close != ']' && chars.get(i) == Some(&close) {
                        i += 1;
                        continue;
                    }
                    break;
                }
                i += 1;
            }
            continue;
        }
        if c == '?' {
            let mut j = i + 1;
            while j < n && chars[j].is_ascii_digit() {
                j += 1;
            }
            // Counted without overflowing, as JavaScript's numbers count: anything past
            // the 100 a statement may have is refused below, however large.
            parameters = if j > i + 1 {
                parameters.max(chars[i + 1..j].iter().collect::<String>().parse::<usize>().unwrap_or(usize::MAX))
            } else {
                parameters.saturating_add(1)
            };
            i = j;
            continue;
        }
        // SQLite's #name counted with the others (sql.mjs).
        if matches!(c, ':' | '@' | '$' | '#') {
            let (mut j, mut count) = (i + 1, 0);
            loop {
                if id_char(chars.get(j)) {
                    j += 1;
                    count += 1;
                } else if starts(j, "::") {
                    j += 2;
                } else if chars.get(j) == Some(&'(') && count > 0 {
                    while j < n && chars[j] != ')' && !space(chars[j]) {
                        j += 1;
                    }
                    if chars.get(j) == Some(&')') {
                        j += 1;
                    }
                    break;
                } else {
                    break;
                }
            }
            if count > 0 {
                let name: String = chars[i..j].iter().collect();
                if !named.iter().any(|(_, known)| *known == name) {
                    parameters = parameters.saturating_add(1);
                    named.push((parameters, name));
                }
            }
            i = j.max(i + 1);
            continue;
        }
        if id_char(Some(&c)) {
            let start = i;
            while i < n && id_char(chars.get(i)) {
                i += 1;
            }
            if keyword.is_none() {
                keyword = Some(chars[start..i].iter().collect::<String>().to_uppercase());
            }
            continue;
        }
        if keyword.is_none() {
            keyword = Some(String::new());
        }
        i += 1;
    }
    if parameters > 100 {
        return Err(HostError::own("SQL allows at most 100 binds"));
    }
    Ok(Scan { keyword: keyword.unwrap_or_default(), parameters, named })
}

/// sql.mjs FORGET_LAST_INSERT: the id an execute reports is its own row's.
const FORGET_LAST_INSERT: &str = "CREATE TEMP TABLE IF NOT EXISTS _softn_last_insert(id INTEGER PRIMARY KEY); \
                                  INSERT OR REPLACE INTO temp._softn_last_insert(id) VALUES(0);";

/// The request-time SQL bridge (sql.mjs `createSql`).
pub struct Sql {
    tables: Arc<HashSet<String>>,
    record_events: Option<Arc<RecordEvents>>,
}

impl Sql {
    pub fn new(conn: &Connection, record_events: Option<Arc<RecordEvents>>) -> Result<Self, HostError> {
        let mut statement = conn.prepare("SELECT name FROM sqlite_master WHERE type='table'").map_err(HostError::sqlite)?;
        let tables = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(HostError::sqlite)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(HostError::sqlite)?
            .into_iter()
            .filter(|name| app_table(name))
            .collect();
        Ok(Self { tables: Arc::new(tables), record_events })
    }

    /// Install the request-time authorizer. A statement is never prepared or
    /// run unless this succeeded.
    fn install(&self, conn: &Connection, writes: bool, wrote: &Arc<AtomicBool>) -> Result<(), HostError> {
        let tables = Arc::clone(&self.tables);
        let events = self.record_events.clone();
        let wrote = Arc::clone(wrote);
        conn.authorizer(Some(move |ctx: AuthContext<'_>| {
            use AuthAction::*;
            if events.as_ref().is_some_and(|e| e.authorize(&ctx)) {
                return Authorization::Allow;
            }
            if ctx.database_name.is_some_and(|d| d != "main") {
                return Authorization::Deny;
            }
            match ctx.action {
                Select | Recursive => Authorization::Allow,
                Read { table_name, .. } => allow(readable(table_name)),
                Insert { table_name } | Update { table_name, .. } | Delete { table_name } => {
                    if !writes || !tables.contains(table_name) {
                        return Authorization::Deny;
                    }
                    wrote.store(true, Ordering::Relaxed);
                    Authorization::Allow
                }
                Function { function_name } => allow(RUNTIME_FUNCTIONS.contains(&function_name.to_lowercase().as_str())),
                _ => Authorization::Deny,
            }
        }))
        .map_err(HostError::sqlite)
    }

    /// `sql(kind, text, params, writable)`: `query` and `first` run one
    /// read-only statement; `execute` one INSERT, UPDATE, DELETE or REPLACE
    /// (behind a WITH, perhaps) that returns no rows, and only in a write.
    pub fn call(&self, conn: &Connection, kind: &str, text: Option<&Value>, params: Option<&Value>, writable: bool) -> Result<Value, HostError> {
        if !matches!(kind, "query" | "first" | "execute") {
            return Err(HostError::own("Invalid query"));
        }
        let Some(Value::String(text)) = text else {
            return Err(HostError::own("SQL text exceeds host limits"));
        };
        let Scan { keyword, parameters, named } = scan_statement(text)?;
        let allowed: &[&str] = if kind == "execute" { &["INSERT", "UPDATE", "DELETE", "REPLACE", "WITH"] } else { &["SELECT", "WITH", "VALUES"] };
        if !allowed.contains(&keyword.as_str()) {
            return Err(HostError::own(if kind == "execute" { "execute requires a DML statement" } else { "query requires a read-only statement" }));
        }
        let empty = Vec::new();
        let params = match params {
            None => &empty,
            Some(Value::Array(items)) if items.len() <= 100 => items,
            Some(_) => return Err(HostError::own("SQL allows at most 100 binds")),
        };
        if params.len() != parameters {
            return Err(HostError::own("SQL bind count does not match statement"));
        }
        let mut values = Vec::with_capacity(params.len());
        for param in params {
            values.push(match param {
                Value::Null => SqlValue::Null,
                Value::String(s) => SqlValue::Text(s.clone()),
                Value::Number(n) => {
                    let f = n.as_f64().unwrap_or(f64::NAN);
                    if !f.is_finite() || f.abs() > MAX_SAFE {
                        return Err(HostError::own("SQL binds support only strings, finite numbers and null"));
                    }
                    if f.fract() == 0.0 {
                        SqlValue::Integer(f as i64)
                    } else {
                        SqlValue::Real(f)
                    }
                }
                _ => return Err(HostError::own("SQL binds support only strings, finite numbers and null")),
            });
        }
        let writes = kind == "execute" && writable;
        let wrote = Arc::new(AtomicBool::new(false));
        self.install(conn, writes, &wrote)?;
        let prepared = conn.prepare(text);
        let cleared = clear(conn);
        let mut statement = prepared.map_err(HostError::sqlite)?;
        cleared?;
        if kind == "execute" && (!wrote.load(Ordering::Relaxed) || statement.column_count() != 0) {
            return Err(HostError::own("execute requires a DML statement without returned rows"));
        }
        // The host's own statement, while no authorizer is set.
        if kind == "execute" {
            conn.execute_batch(FORGET_LAST_INSERT).map_err(HostError::sqlite)?;
        }
        self.install(conn, writes, &wrote)?;
        // A statement still running near the deadline is interrupted, and the
        // request fails and rolls back with an answer, rather than by the kill.
        let deadline = crate::soft_deadline();
        conn.progress_handler(1000, Some(move || std::time::Instant::now() >= deadline)).map_err(HostError::sqlite)?;
        let result = Self::run(conn, &mut statement, kind, values, &named);
        drop(statement);
        let _ = conn.progress_handler(0, None::<fn() -> bool>);
        let cleared = clear(conn);
        let value = result?;
        cleared?;
        Ok(value)
    }

    /// Bind as sql.mjs `bindArguments` hands the values to node:sqlite and as
    /// node:sqlite binds them: the value for each :name, @name, $name or
    /// #name the scan found by that name, the others in order to the
    /// parameters SQLite gives no name or a `?NNN` one. Where the scan and
    /// SQLite number the parameters alike, as they do for every parameter
    /// SQLite reads, value i is parameter i.
    fn bind(statement: &mut rusqlite::Statement<'_>, values: Vec<SqlValue>, named: &[(usize, String)]) -> Result<(), HostError> {
        let mut by_name = Vec::new();
        let mut positional = Vec::new();
        for (i, value) in values.into_iter().enumerate() {
            match named.iter().find(|(number, _)| *number == i + 1) {
                Some((_, name)) => by_name.push((name, value)),
                None => positional.push(value),
            }
        }
        if !by_name.is_empty() {
            // Bound by name, node:sqlite first refuses two parameters whose
            // names match without their first character (`:a` and `$a`,
            // `?1` and `:1`).
            let names: Vec<&str> = (1..=statement.parameter_count()).filter_map(|i| statement.parameter_name(i)).collect();
            let mut bare: HashMap<&str, &str> = HashMap::new();
            for full in names {
                if let Some(existing) = bare.insert(&full[1..], full).filter(|existing| *existing != full) {
                    return Err(HostError::library(format!(
                        "Cannot create bare named parameter '{}' because of conflicting names '{existing}' and '{full}'.",
                        &full[1..]
                    )));
                }
            }
            for (name, value) in by_name {
                let index = statement
                    .parameter_index(name)
                    .map_err(HostError::sqlite)?
                    .ok_or_else(|| HostError::library(format!("Unknown named parameter '{name}'")))?;
                statement.raw_bind_parameter(index, value).map_err(HostError::sqlite)?;
            }
        }
        let mut index = 1;
        for value in positional {
            while statement.parameter_name(index).is_some_and(|name| !name.starts_with('?')) {
                index += 1;
            }
            statement.raw_bind_parameter(index, value).map_err(HostError::sqlite)?;
            index += 1;
        }
        Ok(())
    }

    fn run(conn: &Connection, statement: &mut rusqlite::Statement<'_>, kind: &str, values: Vec<SqlValue>, named: &[(usize, String)]) -> Result<Value, HostError> {
        Self::bind(statement, values, named)?;
        if kind == "execute" {
            let changes = statement.raw_execute().map_err(HostError::sqlite)?;
            let id = conn.last_insert_rowid();
            if id.unsigned_abs() as f64 > MAX_SAFE {
                return Err(HostError::own("SQL row ID outside safe JavaScript range"));
            }
            return Ok(serde_json::json!({ "changes": changes, "lastInsertRowid": id }));
        }
        let columns: Vec<String> = statement.column_names().iter().map(|s| s.to_string()).collect();
        let mut rows = statement.raw_query();
        let mut output = Vec::new();
        let mut bytes = 0usize;
        while let Some(row) = rows.next().map_err(HostError::sqlite)? {
            let mut object = Map::new();
            // node:sqlite reads the whole row, refusing an integer past the
            // safe range as it goes; sql.mjs refuses a BLOB in what it read,
            // then a result past 2 MiB. A text's JSON is at least as long as
            // the text, so once the texts alone are past the limit the answer
            // is that limit, known without copying them: a single SELECT
            // could otherwise make the runner hold gigabytes.
            let (mut binary, mut over) = (false, false);
            let mut raw = bytes;
            for (i, name) in columns.iter().enumerate() {
                let value = match row.get_ref(i).map_err(HostError::sqlite)? {
                    ValueRef::Text(v) if over || raw + v.len() > RESULT_LIMIT => {
                        over = true;
                        Value::Null
                    }
                    ValueRef::Text(v) => {
                        raw += v.len();
                        String::from_utf8_lossy(v).into_owned().into()
                    }
                    ValueRef::Null => Value::Null,
                    ValueRef::Integer(v) => {
                        if v.unsigned_abs() as f64 > MAX_SAFE {
                            return Err(HostError::library(format!("Value is too large to be represented as a JavaScript number: {v}")));
                        }
                        v.into()
                    }
                    ValueRef::Real(v) => serde_json::Number::from_f64(v).map_or(Value::Null, Value::Number),
                    ValueRef::Blob(_) => {
                        binary = true;
                        Value::Null
                    }
                };
                object.insert(name.clone(), value);
            }
            if binary {
                return Err(HostError::own("Binary SQL values are not supported"));
            }
            if over {
                return Err(HostError::own("Query result limit"));
            }
            let row = Value::Object(object);
            bytes += crate::js::stringify(&row).len();
            if bytes > RESULT_LIMIT || output.len() >= 1000 {
                return Err(HostError::own("Query result limit"));
            }
            if kind == "first" {
                return Ok(row);
            }
            output.push(row);
        }
        Ok(if kind == "first" { Value::Null } else { Value::Array(output) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.set_db_config(DbConfig::SQLITE_DBCONFIG_DQS_DML, false).unwrap();
        conn.set_db_config(DbConfig::SQLITE_DBCONFIG_DQS_DDL, false).unwrap();
        conn.set_limit(Limit::SQLITE_LIMIT_VARIABLE_NUMBER, 100).unwrap();
        conn.execute_batch("CREATE TABLE items(id INTEGER PRIMARY KEY, name TEXT); CREATE TABLE _host(x);").unwrap();
        conn
    }

    #[test]
    fn statements_are_scanned_as_the_node_runner_scans_them() {
        let scan = scan_statement("select ?, ?3, :a, :a, @b").unwrap();
        assert_eq!((scan.keyword.as_str(), scan.parameters), ("SELECT", 5));
        assert_eq!(scan.named, vec![(4, ":a".to_string()), (5, "@b".to_string())]);
        assert_eq!(scan_statement("  -- note\n with x as (select 1) select * from x; -- tail").unwrap().keyword, "WITH");
        assert_eq!(scan_statement("select 'a;b'").unwrap().keyword, "SELECT");
        assert!(scan_statement("select 1; select 2").is_err());
        assert!(scan_statement("select /* open").is_err());
        // A parameter number past any count is refused, not an overflow.
        for text in ["SELECT ?99999999999999999999, ?", "SELECT ?18446744073709551615, :a", "SELECT ?101"] {
            assert!(matches!(scan_statement(text), Err(HostError::Own(m)) if m == "SQL allows at most 100 binds"), "{text}");
        }
    }

    #[test]
    fn the_authorizer_keeps_to_the_apps_tables() {
        let conn = fixture();
        let sql = Sql::new(&conn, None).unwrap();
        let q = |kind: &str, text: &str, writable: bool| sql.call(&conn, kind, Some(&Value::String(text.into())), Some(&serde_json::json!([])), writable);
        assert!(q("execute", "INSERT INTO items(name) VALUES('a')", true).is_ok());
        assert_eq!(q("first", "SELECT name FROM items", false).unwrap(), serde_json::json!({"name": "a"}));
        for text in ["SELECT * FROM _host", "SELECT * FROM sqlite_master", "SELECT load_extension('x')", "SELECT \"x\""] {
            assert!(matches!(q("query", text, false), Err(HostError::Library(_))), "{text}");
        }
        assert!(q("execute", "INSERT INTO items(name) VALUES('b')", false).is_err());
        assert_eq!(q("execute", "UPDATE items SET name='c'", true).unwrap()["lastInsertRowid"], 0);
    }

    #[test]
    fn parameters_and_values_are_refused_as_node_sqlite_refuses_them() {
        let conn = fixture();
        let sql = Sql::new(&conn, None).unwrap();
        let q = |text: &str, params: Value| sql.call(&conn, "query", Some(&Value::String(text.into())), Some(&params), false);
        assert_eq!(q("SELECT ?3 AS x, :a AS y", serde_json::json!([1, 2, 3, 4])).unwrap(), serde_json::json!([{"x": 3, "y": 4}]));
        let library = |text: &str, params: Value, message: &str| {
            assert!(matches!(q(text, params), Err(HostError::Library(m)) if m == message), "{text}");
        };
        library("SELECT :a AS x, $a AS y", serde_json::json!([1, 2]), "Cannot create bare named parameter 'a' because of conflicting names ':a' and '$a'.");
        library("SELECT ?1 AS x, :1 AS y", serde_json::json!([1, 2]), "Cannot create bare named parameter '1' because of conflicting names '?1' and ':1'.");
        // The whole row is read before a BLOB in it is refused.
        let big = "Value is too large to be represented as a JavaScript number: 9007199254740993";
        library("SELECT x'00' AS a, 9007199254740993 AS b", serde_json::json!([]), big);
        assert!(matches!(q("SELECT x'00' AS a, 1 AS b", serde_json::json!([])), Err(HostError::Own(m)) if m == "Binary SQL values are not supported"));
        // SQLite's #name is a parameter like :name, bound by its name.
        assert_eq!(q("SELECT #a AS x, ? AS y", serde_json::json!([5, 6])).unwrap(), serde_json::json!([{"x": 5, "y": 6}]));
        // A text past the result limit is that limit, read without copying it.
        conn.execute("INSERT INTO items(name) VALUES(?1)", [ "x".repeat(RESULT_LIMIT + 1) ]).unwrap();
        assert!(matches!(q("SELECT name FROM items", serde_json::json!([])), Err(HostError::Own(m)) if m == "Query result limit"));
        assert!(matches!(q("SELECT x'00' AS b, name FROM items", serde_json::json!([])), Err(HostError::Own(m)) if m == "Binary SQL values are not supported"));
    }
}
