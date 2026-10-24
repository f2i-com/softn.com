//! One request, start to finish (the PHP host's runtime/request-worker.mjs):
//! the operator's configuration and the bundle checked, the logic validated
//! in the guest, migrations applied, the client counted against its limit,
//! the route found and its handler run.
//!
//! Every failure before a handler runs is answered with a static label of the
//! stage it happened in, never a value, a path or a message; the operator's
//! log gets the reason (js::log_failure).

use std::{
    path::{Path, PathBuf},
    rc::Rc,
    sync::{Arc, Mutex},
};

use rusqlite::{params, OptionalExtension};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::{
    guest::Guest,
    host_calls::{script_config, Crypto, Host, Route, STEPS},
    js, migrations,
    record_events::RecordEvents,
    sql::{self, Sql},
    HostError, Migration,
};

/// How many times the deadline may stop one migration before it is not started again.
const MIGRATION_ATTEMPTS: u32 = 3;
const MAX_INPUT_BYTES: usize = 6_000_000;

pub struct Answer {
    pub status: u16,
    pub body: String,
}

fn answer(status: u16, body: Value) -> Answer {
    Answer { status, body: js::stringify(&body) }
}

/// A file system failure as Node words it (`ENOENT: no such file or
/// directory, open '<path>'`), which is what the operator's log has said;
/// log_failure then takes the path out.
fn fs_error(syscall: &str, path: &Path, error: std::io::Error) -> HostError {
    let what = match error.kind() {
        std::io::ErrorKind::NotFound => "ENOENT: no such file or directory".to_string(),
        std::io::ErrorKind::PermissionDenied => "EACCES: permission denied".to_string(),
        std::io::ErrorKind::IsADirectory => "EISDIR: illegal operation on a directory".to_string(),
        std::io::ErrorKind::NotADirectory => "ENOTDIR: not a directory".to_string(),
        std::io::ErrorKind::InvalidData => "ERR_INVALID_DATA: the file is not UTF-8 text".to_string(),
        _ => format!("EIO: {error}"),
    };
    HostError::Library(format!("{what}, {syscall} '{}'", path.display()))
}

fn realpath(path: &Path) -> Result<PathBuf, HostError> {
    std::fs::canonicalize(path).map_err(|e| fs_error("realpath", path, e))
}

/// A file's text as Node's `readFileSync(path, 'utf8')` reads it: bytes that
/// are not UTF-8 are U+FFFD, not a refusal.
fn read_text(path: &Path) -> Result<String, HostError> {
    std::fs::read(path).map(|bytes| String::from_utf8_lossy(&bytes).into_owned()).map_err(|e| fs_error("open", path, e))
}

/// The backend root: the operator selects it, never a request or a bundle.
/// The Node runner resolves it as its worker loads, before any request, so a
/// root that cannot be resolved ends the runner with its error's code
/// (main.rs) rather than an answer; this gives that code.
pub fn backend_root() -> Result<PathBuf, String> {
    let root = match std::env::var_os("SOFTN_BACKEND_ROOT").filter(|v| !v.is_empty()) {
        Some(root) => PathBuf::from(root),
        None => std::env::current_exe().map_err(|_| "error".to_string())?.parent().map(Path::to_path_buf).unwrap_or_default(),
    };
    std::fs::canonicalize(&root).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => "ENOENT".to_string(),
        std::io::ErrorKind::PermissionDenied => "EACCES".to_string(),
        std::io::ErrorKind::NotADirectory => "ENOTDIR".to_string(),
        _ => "error".to_string(),
    })
}

/// `child` lies strictly inside `parent`.
fn contained(parent: &Path, child: &Path) -> bool {
    child != parent && child.starts_with(parent)
}

fn symlink(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink())
}

fn read_json(path: &Path) -> Result<Value, HostError> {
    let text = read_text(path)?;
    serde_json::from_str(&text).map_err(HostError::library)
}

fn is_handler(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some(c) if c == '$' || c == '_' || c.is_ascii_alphabetic())
        && chars.all(|c| c == '$' || c == '_' || c.is_ascii_alphanumeric())
}

struct Served {
    method: String,
    path: String,
    handler: String,
    writable: bool,
    upload: Option<Value>,
    poll: Option<Value>,
}

pub fn run(root: &Path, input: &str, guest: &Guest, migration: &Arc<Mutex<Option<Migration>>>) -> Answer {
    let mut stage = "configuration_read";
    let mut db: Option<Rc<rusqlite::Connection>> = None;
    let result = handle(root, input, guest, migration, &mut stage, &mut db);
    let out = match result {
        Ok(answer) => answer,
        Err(error) => {
            // A busy database is a moment's load, not something to look into.
            if error.busy() {
                answer(503, serde_json::json!({ "error": "The server is busy. Please retry.", "code": "database_busy" }))
            } else {
                js::log_failure(&format!("startup stage {stage}"), error.reason());
                answer(503, serde_json::json!({ "error": "The backend is unavailable. Check its private configuration.", "code": "backend_unavailable", "diagnostic": stage }))
            }
        }
    };
    drop(db);
    out
}

fn handle(
    root: &Path,
    input: &str,
    guest: &Guest,
    migration: &Arc<Mutex<Option<Migration>>>,
    stage: &mut &'static str,
    db_slot: &mut Option<Rc<rusqlite::Connection>>,
) -> Result<Answer, HostError> {
    let root = root.to_path_buf();
    let config = read_json(&root.join("private/config.json"))?;
    *stage = "configuration_values";
    let key_hex = config.get("keyHex").and_then(Value::as_str).unwrap_or("");
    if key_hex.len() != 64 || !key_hex.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) || !config.get("development").is_some_and(Value::is_boolean) {
        return Err(HostError::own("Invalid configuration"));
    }
    // Operator hooks are JavaScript modules the Node runner imports; this
    // runner runs no JavaScript outside the guest.
    if config.get("enableRequestHook") == Some(&Value::Bool(true)) || config.get("enableAfterRequestHook") == Some(&Value::Bool(true)) {
        return Err(HostError::own("Operator request hooks need the Node runner (runner.mjs)"));
    }
    let development = config["development"] == Value::Bool(true);
    let host_context = config.get("enableHostContext") == Some(&Value::Bool(true));

    *stage = "bundle_directory";
    let bundle = realpath(&root.join("app"))?;
    if symlink(&root.join("app")) || !contained(&root, &bundle) {
        return Err(HostError::own("Invalid bundle directory"));
    }
    let inside = |relative: Option<&Value>| -> Result<PathBuf, HostError> {
        let Some(relative) = relative.and_then(Value::as_str) else {
            return Err(HostError::own("Invalid bundle path"));
        };
        if relative.starts_with('/') || relative.contains('\\') || relative.split('/').any(|s| s == ".." || s == ".") {
            return Err(HostError::own("Invalid bundle path"));
        }
        let file = realpath(&bundle.join(relative))?;
        if !contained(&bundle, &file) {
            return Err(HostError::own("Bundle path escaped"));
        }
        Ok(file)
    };

    *stage = "manifest_read";
    let manifest = read_json(&inside(Some(&Value::String("manifest.json".into())))?)?;
    *stage = "application_identity";
    if !js::strict_equal(config.get("appId"), manifest.get("id")) {
        return Err(HostError::own("Operator configuration belongs to another app"));
    }
    let supported = ["sql", "crypto", "time", "trusted-client-ip", "transaction-scope", "photos"];
    let required = manifest.get("server").and_then(|s| s.get("requires"));
    *stage = "application_capabilities";
    // `config.capabilities?.includes(c)`: an array's element, or a string's substring.
    let granted = |c: &str| match config.get("capabilities") {
        Some(Value::Array(list)) => list.iter().any(|v| v.as_str() == Some(c)),
        Some(Value::String(text)) => text.contains(c),
        _ => false,
    };
    let capabilities: Vec<String> = match required.and_then(|r| r.get("capabilities")).and_then(Value::as_array) {
        Some(list) if required.and_then(|r| r.get("apiVersion")).and_then(Value::as_f64) == Some(1.0) => {
            let mut names = Vec::new();
            for c in list {
                match c.as_str() {
                    Some(c) if supported.contains(&c) && granted(c) => names.push(c.to_string()),
                    _ => return Err(HostError::own("Unsupported application capabilities")),
                }
            }
            names
        }
        _ => return Err(HostError::own("Unsupported application capabilities")),
    };
    let sync_enabled = manifest.get("server").and_then(|s| s.get("sync")).and_then(|s| s.get("enabled")).is_some_and(|v| truthy(v));
    if sync_enabled {
        return Err(HostError::own("Unsupported application capabilities"));
    }
    let photos_granted = capabilities.iter().any(|c| c == "photos");

    *stage = "crypto_domains";
    let domain = |name: &str| config.get("cryptoDomains").and_then(|d| d.get(name)).and_then(Value::as_str).filter(|d| (1..=128).contains(&d.len()) && d.bytes().all(|b| (b'!'..=b'~').contains(&b)));
    let (Some(hmac_domain), Some(seal_domain)) = (domain("hmac"), domain("seal")) else {
        return Err(HostError::own("Invalid crypto domains"));
    };
    if hmac_domain == seal_domain {
        return Err(HostError::own("Invalid crypto domains"));
    }

    *stage = "route_configuration";
    let declared = match manifest["server"].get("routes").and_then(Value::as_array) {
        Some(list) if list.len() <= 256 => list.clone(),
        _ => return Err(HostError::own("Unsupported route declaration")),
    };
    let mut unserved: Vec<Value> = Vec::new();
    let mut routes: Vec<Served> = Vec::new();
    for r in &declared {
        let (Some(path), Some(method), Some(handler)) = (r.get("path").and_then(Value::as_str), r.get("method").and_then(Value::as_str), r.get("handler").and_then(Value::as_str)) else {
            return Err(HostError::own("Unsupported route declaration"));
        };
        if !r.is_object() || !is_handler(handler) {
            return Err(HostError::own("Unsupported route declaration"));
        }
        // No transaction declared (or the Rust host's `none`): a read for a
        // GET, a write for anything else.
        let transaction = match r.get("transaction") {
            None => if method == "GET" { "read" } else { "write" },
            Some(Value::String(t)) if t == "none" => if method == "GET" { "read" } else { "write" },
            Some(Value::String(t)) if t == "read" || t == "write" => if t == "read" { "read" } else { "write" },
            _ => return Err(HostError::own("Unsupported route declaration")),
        };
        let authorization = match r.get("authorization") {
            None => "application",
            Some(Value::String(a)) if a == "host-token" || a == "hosttoken" => "hosttoken",
            Some(Value::String(a)) if a == "application" || a == "anonymous" => if a == "application" { "application" } else { "anonymous" },
            _ => return Err(HostError::own("Unsupported route declaration")),
        };
        let served_path = path.strip_prefix("/api/").is_some_and(|rest| !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'/' | b'_' | b'-')));
        let reason = if !served_path {
            Some("path outside /api/ is not routed to this host")
        } else if !["GET", "POST", "PUT", "DELETE"].contains(&method) {
            Some("method not served by this host")
        } else if authorization == "hosttoken" {
            Some("hosttoken authorization: this host holds no token")
        } else {
            None
        };
        if let Some(reason) = reason {
            unserved.push(serde_json::json!({ "method": method, "path": path, "reason": reason }));
            continue;
        }
        routes.push(Served {
            method: method.into(),
            path: path.into(),
            handler: handler.into(),
            writable: transaction == "write",
            upload: r.get("upload").cloned(),
            poll: r.get("poll").cloned(),
        });
    }
    if declared.iter().any(|r| r.get("upload").is_some_and(|u| u.as_str() != Some("photo") || !photos_granted || r.get("method").and_then(Value::as_str) != Some("POST"))) {
        return Err(HostError::own("Unsupported upload capability"));
    }
    let mut seen = std::collections::HashSet::new();
    if !declared.iter().all(|r| seen.insert(format!("{} {}", js::string_of(r.get("method")), js::string_of(r.get("path"))))) {
        return Err(HostError::own("Duplicate route"));
    }
    if routes.iter().any(|r| r.poll.as_ref().is_some_and(|p| !p.is_boolean() || (p == &Value::Bool(true) && (r.method != "GET" || r.writable)))) {
        return Err(HostError::own("Invalid polling route"));
    }

    *stage = "application_source";
    let source = read_text(&inside(manifest["server"].get("entry"))?)?;
    let app_config = match manifest.get("config").and_then(|c| c.get("app")) {
        Some(app) if truthy(app) => app.clone(),
        _ => Value::Object(Map::new()),
    };
    let handlers: Vec<Value> = declared.iter().map(|r| r.get("handler").cloned().unwrap_or(Value::Null)).collect();
    let validation = guest.run(
        &serde_json::json!({ "mode": "validate", "source": source, "config": script_config(&app_config, development, photos_granted), "handlers": handlers, "steps": STEPS, "grant": false }),
        Box::new(|_, _| "null".into()),
    )?;
    if validation.get("ok") != Some(&Value::Bool(true)) {
        return Err(HostError::Library(validation.get("error").and_then(Value::as_str).unwrap_or("the logic did not validate").into()));
    }

    *stage = "data_directory";
    let data = realpath(&root.join("private/data"))?;
    let private = realpath(&root.join("private"))?;
    if symlink(&root.join("private/data")) || !contained(&private, &data) {
        return Err(HostError::own("Invalid data path"));
    }

    *stage = "request_input";
    if input.len() > MAX_INPUT_BYTES {
        return Err(HostError::own("Input limit"));
    }
    let mut request: Map<String, Value> = match serde_json::from_str(input) {
        Ok(Value::Object(map)) => map,
        _ => return Err(HostError::own("Invalid request")),
    };
    let request_path = request.get("path").and_then(Value::as_str).unwrap_or("").to_string();
    let request_method = request.get("method").and_then(Value::as_str).unwrap_or("").to_string();
    if !request_path.starts_with("/api/") || !["GET", "POST", "PUT", "DELETE"].contains(&request_method.as_str()) || !request.get("client_ip").is_some_and(Value::is_string) {
        return Err(HostError::own("Invalid request"));
    }

    *stage = "database_open";
    let file = data.join("application.sqlite");
    if symlink(&file) {
        return Err(HostError::own("Invalid database"));
    }
    let db = Rc::new(sql::open(&file)?);
    *db_slot = Some(Rc::clone(&db));
    *stage = "database_lock";
    db.execute_batch("BEGIN IMMEDIATE").map_err(HostError::sqlite)?;
    let counted = (|| -> Result<Option<Answer>, HostError> {
        *stage = "database_migrations";
        db.execute_batch("CREATE TABLE IF NOT EXISTS _migrations(name TEXT PRIMARY KEY, sha256 TEXT NOT NULL, applied_at INTEGER NOT NULL) STRICT").map_err(HostError::sqlite)?;
        // In sorted order, by their bytes, as the Rust host applies them.
        let mut names: Vec<String> = Vec::new();
        // `[...(manifest.server.database?.migrations || [])]`: nothing when falsy, a
        // string's characters, and refused (not iterable, or not a string) otherwise.
        match manifest["server"].get("database").and_then(|d| d.get("migrations")).filter(|m| truthy(m)) {
            None => {}
            Some(Value::Array(list)) => {
                for name in list {
                    names.push(name.as_str().ok_or_else(|| HostError::own("Invalid migration list"))?.to_string());
                }
            }
            Some(Value::String(text)) => names.extend(text.chars().map(String::from)),
            Some(_) => return Err(HostError::own("Invalid migration list")),
        }
        names.sort_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
        if names.windows(2).any(|w| w[0] == w[1]) {
            return Err(HostError::own("Duplicate migration path"));
        }
        let stopped_note = data.join("migration-stopped.json");
        let operator_run = migrations::setup_deadline_ms().is_some();
        let stopped: Option<Value> = std::fs::read_to_string(&stopped_note).ok().and_then(|t| serde_json::from_str(&t).ok());
        for name in &names {
            let text = read_text(&inside(Some(&Value::String(name.clone())))?)?;
            let hash = format!("{:x}", Sha256::digest(text.as_bytes()));
            let old: Option<String> = db.query_row("SELECT sha256 FROM _migrations WHERE name=?", params![name], |row| row.get(0)).optional().map_err(HostError::sqlite)?;
            if let Some(old) = old {
                if old != hash {
                    return Err(HostError::own("Migration mismatch"));
                }
                continue;
            }
            let file_name = name.rsplit('/').next().unwrap_or(name).to_string();
            let stops = stopped.as_ref().filter(|s| s.get("name").and_then(Value::as_str) == Some(name) && s.get("sha256").and_then(Value::as_str) == Some(&hash)).and_then(|s| s.get("stops")).and_then(Value::as_f64).unwrap_or(0.0);
            if !operator_run && stops >= f64::from(MIGRATION_ATTEMPTS) {
                *stage = "migration_stopped";
                return Err(HostError::own(format!(
                    "Migration {file_name} was stopped at the deadline {} times and is not started again until it changes or migration-stopped.json is removed from the private data folder, or setup.php is run with --migration-deadline=SECONDS to apply it",
                    js::number_text(stops)
                )));
            }
            *migration.lock().unwrap() = Some(Migration { name: name.clone(), file: file_name, sha256: hash.clone(), marker: stopped_note.clone(), attempts: MIGRATION_ATTEMPTS });
            migrations::apply(&db, &text)?;
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64);
            db.execute("INSERT INTO _migrations VALUES(?,?,?)", params![name, hash, now]).map_err(HostError::sqlite)?;
            *migration.lock().unwrap() = None;
        }
        if stopped.is_some() {
            let _ = std::fs::remove_file(&stopped_note);
        }
        let mut statement = db.prepare("SELECT name FROM _migrations").map_err(HostError::sqlite)?;
        let ledger: Vec<String> = statement.query_map([], |row| row.get(0)).map_err(HostError::sqlite)?.collect::<Result<_, _>>().map_err(HostError::sqlite)?;
        drop(statement);
        if ledger.iter().any(|name| !names.contains(name)) {
            return Err(HostError::own("Deployment removed a previously applied migration"));
        }

        *stage = "request_limits";
        db.execute_batch("CREATE TABLE IF NOT EXISTS _request_limits(ip TEXT PRIMARY KEY, minute INTEGER NOT NULL, count INTEGER NOT NULL) STRICT").map_err(HostError::sqlite)?;
        let rate_key = match request.get("rate_key") {
            Some(Value::String(k)) if !k.is_empty() => k.clone(),
            _ => request["client_ip"].as_str().unwrap_or("").to_string(),
        };
        let minute = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| (d.as_millis() / 60_000) as i64);
        let ip = format!("{:x}", Sha256::digest(rate_key.as_bytes()));
        db.execute("DELETE FROM _request_limits WHERE minute<?", params![minute - 1]).map_err(HostError::sqlite)?;
        db.execute(
            "INSERT INTO _request_limits VALUES(?,?,1) ON CONFLICT(ip) DO UPDATE SET count=CASE WHEN minute=excluded.minute THEN count+1 ELSE 1 END,minute=excluded.minute",
            params![ip, minute],
        )
        .map_err(HostError::sqlite)?;
        let count: i64 = db.query_row("SELECT count FROM _request_limits WHERE ip=?", params![ip], |row| row.get(0)).map_err(HostError::sqlite)?;
        db.execute_batch("COMMIT").map_err(HostError::sqlite)?;
        // config.server.requestsPerMinute: a whole number (Number.isInteger, however
        // large), 0 for no limit, 120 when not set.
        let per_minute = manifest
            .get("config")
            .and_then(|c| c.get("server"))
            .and_then(|s| s.get("requestsPerMinute"))
            .and_then(Value::as_f64)
            .filter(|n| n.is_finite() && n.fract() == 0.0 && *n >= 0.0)
            .unwrap_or(120.0);
        if per_minute > 0.0 && count as f64 > per_minute {
            mark_limited(&root, minute, &ip);
            return Ok(Some(answer(429, serde_json::json!({ "error": "Too many requests.", "code": "rate_limited" }))));
        }
        Ok(None)
    })();
    match counted {
        Err(e) => {
            let _ = db.execute_batch("ROLLBACK");
            return Err(e);
        }
        Ok(Some(limited)) => return Ok(limited),
        Ok(None) => {}
    }
    // An upload http.php would not take is counted and answered: no handler runs.
    if request.get("refused").and_then(Value::as_str) == Some("photo") {
        return Ok(answer(400, serde_json::json!({ "error": "Photo rejected. Use a still JPEG, PNG or WebP under 4 MB, 16 megapixels and 8192 pixels a side.", "code": "photo_rejected" })));
    }

    *stage = "record_events";
    let env_json = |name: &str, fallback: &str| -> Result<Value, HostError> {
        let text = std::env::var(name).ok().filter(|t| !t.is_empty()).unwrap_or_else(|| fallback.into());
        serde_json::from_str(&text).map_err(HostError::library)
    };
    let subscriptions: Value = if host_context { env_json("SOFTN_RECORD_EVENTS", "[]")? } else { Value::Array(Vec::new()) };
    let events = RecordEvents::configure(&db, &subscriptions)?;

    *stage = "wasm_initialization";
    let mut key = [0u8; 32];
    for (i, byte) in key.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&key_hex[i * 2..i * 2 + 2], 16).map_err(HostError::library)?;
    }
    let host = Host {
        db: Rc::clone(&db),
        sql: Rc::new(Sql::new(&db, events.map(Arc::new))?),
        crypto: Rc::new(Crypto::new(&key, hmac_domain, seal_domain)),
        capabilities: capabilities.clone(),
        source,
        app_config,
        development,
    };
    let photos = photos_granted && request.get("photos") == Some(&Value::Bool(true));
    let route = routes.iter().find(|r| r.path == request_path && r.method == request_method);
    if request_path == "/api/meta" && request_method == "GET" {
        let mut meta = Map::new();
        meta.insert("development".into(), Value::Bool(development));
        meta.insert("photos".into(), Value::Bool(photos));
        if let Some(version) = manifest.get("version") {
            meta.insert("version".into(), version.clone());
        }
        meta.insert("runtime".into(), Value::String("zipp-wasm-on-demand".into()));
        if let Some(id) = manifest.get("id") {
            meta.insert("appId".into(), id.clone());
        }
        if !unserved.is_empty() {
            meta.insert("unservedRoutes".into(), Value::Array(unserved));
        }
        return Ok(answer(200, Value::Object(meta)));
    }
    let Some(route) = route else {
        let aside = unserved.iter().find(|u| u["path"].as_str() == Some(&request_path) && u["method"].as_str() == Some(&request_method));
        return Ok(if aside.is_some_and(|u| u["reason"].as_str().is_some_and(|r| r.starts_with("hosttoken"))) {
            answer(401, serde_json::json!({ "error": "Authorization required" }))
        } else {
            answer(404, serde_json::json!({ "error": "Endpoint not found.", "code": "not_found" }))
        });
    };
    // The rate bucket is the host's; the address only for an app granted trusted-client-ip.
    request.shift_remove("rate_key");
    if !capabilities.iter().any(|c| c == "trusted-client-ip") {
        request.shift_remove("client_ip");
    }
    if route.upload.as_ref().and_then(Value::as_str) != Some("photo") {
        request.shift_remove("upload");
    }
    *stage = "request_integration";
    let context = if host_context { env_json("SOFTN_HOST_CONTEXT", "{}")? } else { Value::Object(Map::new()) };
    let context = match context {
        Value::Object(map) => Value::Object(map),
        _ => Value::Object(Map::new()),
    };
    request.shift_remove("context");
    request.insert("context".into(), context);
    let (status, body) = host.invoke(guest, Value::Object(request), &Route { handler: route.handler.clone(), writable: route.writable }, photos);
    Ok(Answer { status, body })
}

/// JavaScript truthiness of a JSON value.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// Note that a rate bucket is over its limit for this minute, where http.php
/// looks before it starts a runner: one directory a minute, one empty file a
/// bucket, earlier minutes removed.
fn mark_limited(root: &Path, minute: i64, bucket: &str) {
    let all = root.join("private/limited");
    let now = all.join(minute.to_string());
    if std::fs::create_dir_all(&now).is_err() {
        return;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&now, std::fs::Permissions::from_mode(0o700));
    }
    let _ = std::fs::write(now.join(bucket), "");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(now.join(bucket), std::fs::Permissions::from_mode(0o600));
    }
    if let Ok(entries) = std::fs::read_dir(&all) {
        for entry in entries.flatten() {
            if entry.file_name() != std::ffi::OsString::from(minute.to_string()) {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    }
}
