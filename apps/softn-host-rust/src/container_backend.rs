//! Multi-user ZIPP-sandboxed backend host for SoftN v2 Web App Containers.
//!
//! Runs embedded container backends (`manifest.backend` — PHP, Rust, JavaScript,
//! TypeScript, or Python) 100% inside the `zipp-vm` `safe-sandbox` interpreter:
//! - No native OS PHP/Python/shell execution, no JIT, no host filesystem escape
//! - Strict per-request instruction budget, heap cap, output cap, and wall-time watchdog
//! - Multi-user concurrent worker pool backed by persistent server-side WAL SQLite
//!   via the exact same `app.sql.*` capability bridge used in browser containers
//! - Safe static frontend serving (`frontendRoot`) with private backend files blocked

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use axum::body::Bytes;
use base64::Engine as _;
use regex::{Regex, RegexBuilder};
use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
use rusqlite::limits::Limit;
use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{params_from_iter, Connection};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use zipp_vm::embed::{HostValue, HostValueBudget, ScriptGoal, ScriptState};
use zipp_vm::frontend::{
    compile_php_program, compile_rust_program, compile_source, Frontend, PhpProgramConfig,
    PhpVfsOverlay, PythonMode, RustProgramConfig,
};

use crate::bridges::sql::{reject_symlink, LIKE_PATTERN_LIMIT};
use crate::bundle::{ContainerBackendConfig, ContainerDatabaseConfig, ServerManifest};

const REQUEST_STEP_BUDGET: u64 = 200_000_000;
const BOOT_STEP_BUDGET: u64 = 2_000_000_000;
const VM_HEAP_LIMIT: usize = if cfg!(test) { 64 << 20 } else { 256 << 20 };
const VM_OUTPUT_LIMIT: usize = 16 * 1024 * 1024;
const WALL_TIME_MS: u64 = 25_000;
const MAX_VFS_FILES: usize = 12_000;
const MAX_VFS_TOTAL_BYTES: usize = 128 * 1024 * 1024;
const MAX_OVERLAY_BYTES: usize = 16 * 1024 * 1024;
const MAX_SQL_RESULT_ROWS: usize = 10_000;
const MAX_SQL_RESULT_BYTES: usize = 8 * 1024 * 1024;
const MAX_CONTAINER_DATABASES: usize = 8;
const MAX_HTACCESS_BYTES: usize = 64 * 1024;
const MAX_HTACCESS_RULES: usize = 256;
const MAX_HTACCESS_CONDS: usize = 64;
const MAX_HTACCESS_DENY: usize = 64;
const MAX_HTACCESS_PASSES: usize = 4;
/// The longest `<Files>`, `<Files ~>` or `<FilesMatch>` pattern read, in bytes, as the Node host
/// and the browser's reader count it. A longer one closes the directory (`ParsedHtaccess::closed`).
const MAX_HTACCESS_FILES_PATTERN_BYTES: usize = 512;
const MAX_RESPONSE_HEADERS: usize = 128;
const MAX_RESPONSE_HEADER_BYTES: usize = 8192;
const MAX_RESPONSE_BODY_BYTES: usize = 16 * 1024 * 1024;
const MAX_SEED_TABLES: usize = 64;
const MAX_SEED_COLS: usize = 128;
const MAX_SEED_ROWS: usize = 50_000;
const MAX_OPEN_DB_HANDLES: usize = 32;

const JS_BACKEND_PRELUDE: &str = r#"
(function () {
  function sqlCall(op, a, b, c) {
    var raw = __zippHostCall("app.sql." + op, String(a === undefined ? "" : a), String(b === undefined ? "" : b), String(c === undefined ? "" : c));
    return raw ? JSON.parse(raw) : null;
  }
  function openDb(url) {
    var r = sqlCall("open", url || "app.db", "1", "");
    if (r && r.error) throw new Error(r.error);
    var id = r.id;
    return {
      id: id,
      query: function (sql, params) {
        var res = sqlCall("query", id, sql, params !== undefined ? JSON.stringify(params) : "");
        if (res && res.error) throw new Error(res.error);
        var cols = res.columns || [];
        var rows = (res.rows || []).map(function (arr) {
          var obj = {};
          for (var i = 0; i < cols.length; i++) obj[cols[i]] = arr[i];
          return obj;
        });
        return { columns: cols, rows: rows, rawRows: res.rows || [] };
      },
      execute: function (sql, params) {
        var res = sqlCall("execute", id, sql, params !== undefined ? JSON.stringify(params) : "");
        if (res && res.error) throw new Error(res.error);
        return res;
      },
      all: function (sql, params) {
        return this.query(sql, params).rows;
      },
      first: function (sql, params) {
        var rows = this.query(sql, params).rows;
        return rows.length > 0 ? rows[0] : null;
      },
      get: function (sql, params) {
        return this.first(sql, params);
      },
      run: function (sql, params) {
        return this.execute(sql, params);
      },
      seedJson: function (seed) {
        var payload = typeof seed === "string" ? seed : JSON.stringify(seed);
        var res = sqlCall("seed_json", id, payload, "");
        if (res && res.error) throw new Error(res.error);
        return res;
      },
      close: function () {
        return sqlCall("close", id, "", "");
      }
    };
  }
  globalThis.sqlite = { open: openDb };
})();
function __softnBackendDispatch(reqJson) {
  var req = JSON.parse(reqJson);
  var fn = typeof globalThis.handleRequest === "function"
    ? globalThis.handleRequest
    : (typeof globalThis.fetch === "function" ? globalThis.fetch : null);
  if (!fn) {
    return JSON.stringify({
      status: 500,
      headers: [["Content-Type", "text/plain; charset=utf-8"]],
      body: "JS/TS backend did not define handleRequest(req) or fetch(req)"
    });
  }
  var res = fn(req);
  if (res && typeof res.then === "function") {
    throw new Error("Async promise return from JS backend requires synchronous resolution");
  }
  if (typeof res === "string") {
    return JSON.stringify({ status: 200, headers: [["Content-Type", "text/html; charset=utf-8"]], body: res });
  }
  if (res && typeof res === "object") {
    var status = typeof res.status === "number" ? res.status : 200;
    var headers = [];
    if (Array.isArray(res.headers)) {
      headers = res.headers;
    } else if (res.headers && typeof res.headers === "object") {
      var ks = Object.keys(res.headers);
      for (var i = 0; i < ks.length; i++) headers.push([ks[i], String(res.headers[ks[i]])]);
    }
    var body = "";
    if (typeof res.body === "string") {
      body = res.body;
    } else if (res.json !== undefined) {
      body = JSON.stringify(res.json);
      if (!headers.some(function (h) { return String(h[0]).toLowerCase() === "content-type"; })) {
        headers.push(["Content-Type", "application/json; charset=utf-8"]);
      }
    } else if (res.body !== undefined && res.body !== null) {
      body = JSON.stringify(res.body);
    }
    return JSON.stringify({ status: status, headers: headers, body: body });
  }
  return JSON.stringify({ status: 200, headers: [["Content-Type", "text/plain"]], body: "" });
}
globalThis.__softnBackendDispatch = __softnBackendDispatch;
"#;

const PYTHON_SQLITE_BRIDGE_JS: &str = r#"
(function (R) {
  "use strict";
  const rt = R.__rt, E = rt.E;
  function toJsVal(v) {
    if (v === null || v === undefined || typeof v === "boolean" || typeof v === "string" || typeof v === "number") return v;
    if (typeof v === "bigint") return Number(v);
    if (v.cls === rt.T.list || v.cls === rt.T.tuple) return v.items.map(toJsVal);
    if (v.cls === rt.T.dict) {
      const o = {};
      for (const [k, val] of rt.dictEntryList(v)) o[rt.str(k)] = toJsVal(val);
      return o;
    }
    return rt.str(v);
  }
  function fromJsVal(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === "boolean" || typeof v === "string") return v;
    if (typeof v === "number") return Number.isInteger(v) ? BigInt(v) : v;
    if (Array.isArray(v)) return rt.list(v.map(fromJsVal));
    if (typeof v === "object") {
      const d = rt.dict();
      for (const k of Object.keys(v)) rt.dictSet(d, k, fromJsVal(v[k]));
      return d;
    }
    return String(v);
  }
  function sqlCall(op, a, b, c) {
    const raw = __zippHostCall("app.sql." + op, String(a === undefined ? "" : a), String(b === undefined ? "" : b), String(c === undefined ? "" : c));
    return raw ? JSON.parse(raw) : null;
  }
  function runQuery(id, args) {
    const sql = rt.needStr(args[0]);
    const params = args[1] !== undefined && args[1] !== null ? JSON.stringify(toJsVal(args[1])) : "";
    const res = sqlCall("query", id, sql, params);
    if (res && res.error) rt.fail(E.RuntimeError, String(res.error));
    const cols = res.columns || [];
    const rawRows = res.rows || [];
    const rows = rawRows.map(function (arr) {
      const o = {};
      for (let i = 0; i < cols.length; i++) o[cols[i]] = arr[i];
      return o;
    });
    return { columns: cols, rows: rows, rawRows: rawRows };
  }
  function runExec(id, args) {
    const sql = rt.needStr(args[0]);
    const params = args[1] !== undefined && args[1] !== null ? JSON.stringify(toJsVal(args[1])) : "";
    const res = sqlCall("execute", id, sql, params);
    if (res && res.error) rt.fail(E.RuntimeError, String(res.error));
    return res;
  }
  function makeConn(id) {
    const conn = rt.newModule("sqlite_conn", null);
    conn.globals.set("id", BigInt(id));
    conn.globals.set("query", rt.builtin("query", 2, function (args) {
      return fromJsVal(runQuery(id, args));
    }, 1));
    conn.globals.set("all", rt.builtin("all", 2, function (args) {
      return fromJsVal(runQuery(id, args).rows);
    }, 1));
    conn.globals.set("first", rt.builtin("first", 2, function (args) {
      const rows = runQuery(id, args).rows;
      return rows.length > 0 ? fromJsVal(rows[0]) : null;
    }, 1));
    conn.globals.set("get", rt.builtin("get", 2, function (args) {
      const rows = runQuery(id, args).rows;
      return rows.length > 0 ? fromJsVal(rows[0]) : null;
    }, 1));
    conn.globals.set("execute", rt.builtin("execute", 2, function (args) {
      return fromJsVal(runExec(id, args));
    }, 1));
    conn.globals.set("run", rt.builtin("run", 2, function (args) {
      return fromJsVal(runExec(id, args));
    }, 1));
    conn.globals.set("seed_json", rt.builtin("seed_json", 1, function (args) {
      const val = toJsVal(args[0]);
      const payload = typeof val === "string" ? val : JSON.stringify(val);
      const res = sqlCall("seed_json", id, payload, "");
      if (res && res.error) rt.fail(E.RuntimeError, String(res.error));
      return fromJsVal(res);
    }, 1));
    conn.globals.set("close", rt.builtin("close", 0, function () {
      return fromJsVal(sqlCall("close", id, "", ""));
    }));
    return conn;
  }
  const sqliteMod = rt.newModule("sqlite", null);
  sqliteMod.globals.set("open", rt.builtin("open", 1, function (args) {
    const url = args[0] !== undefined && args[0] !== null ? rt.needStr(args[0]) : "app.db";
    const res = sqlCall("open", url || "app.db", "1", "");
    if (res && res.error) rt.fail(E.RuntimeError, String(res.error));
    return makeConn(res.id);
  }, 0));
  const entry = rt.entryModule();
  if (entry) entry.globals.set("sqlite", sqliteMod);
})(__zipp_py);
"#;

const PYTHON_BACKEND_PRELUDE: &str = r#"
import json as _softn_json

def __softn_backend_dispatch(req_json):
    req = _softn_json.loads(req_json)
    fn = globals().get("handle_request") or globals().get("handleRequest")
    if fn is None or not callable(fn):
        return _softn_json.dumps({
            "status": 500,
            "headers": [["Content-Type", "text/plain; charset=utf-8"]],
            "body": "Python backend did not define handle_request(req)"
        })
    res = fn(req)
    if isinstance(res, str):
        return _softn_json.dumps({"status": 200, "headers": [["Content-Type", "text/html; charset=utf-8"]], "body": res})
    if isinstance(res, dict):
        status = int(res.get("status", 200))
        raw_headers = res.get("headers")
        headers = []
        if isinstance(raw_headers, list):
            headers = raw_headers
        elif isinstance(raw_headers, dict):
            for k, v in raw_headers.items():
                headers.append([str(k), str(v)])
        body = ""
        if isinstance(res.get("body"), str):
            body = res["body"]
        elif "json" in res and res["json"] is not None:
            body = _softn_json.dumps(res["json"])
            has_ct = any(str(h[0]).lower() == "content-type" for h in headers if isinstance(h, (list, tuple)) and len(h) >= 2)
            if not has_ct:
                headers.append(["Content-Type", "application/json; charset=utf-8"])
        elif res.get("body") is not None:
            body = _softn_json.dumps(res["body"])
        return _softn_json.dumps({"status": status, "headers": headers, "body": body})
    return _softn_json.dumps({"status": 200, "headers": [["Content-Type", "text/plain"]], "body": ""})
"#;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackendRuntimeKind {
    Php,
    Rust,
    JavaScript,
    TypeScript,
    Python,
}

impl BackendRuntimeKind {
    pub fn parse(raw: &str) -> Result<Self, String> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "php" => Ok(Self::Php),
            "rust" => Ok(Self::Rust),
            "javascript" | "js" => Ok(Self::JavaScript),
            "typescript" | "ts" => Ok(Self::TypeScript),
            "python" | "py" => Ok(Self::Python),
            other => Err(format!("Unsupported container backend runtime: {other:?}")),
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Php => "php",
            Self::Rust => "rust",
            Self::JavaScript => "javascript",
            Self::TypeScript => "typescript",
            Self::Python => "python",
        }
    }
}

/// Incoming HTTP request forwarded from Axum into the ZIPP-sandboxed backend pool.
#[derive(Debug, Clone)]
pub struct ContainerHttpRequest {
    pub method: String,
    pub path: String,
    pub query: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    pub client_ip: String,
    pub host: String,
    pub https: bool,
    pub htaccess_evaluated: bool,
}

/// Outgoing HTTP response returned from the ZIPP-sandboxed backend pool.
#[derive(Debug, Clone)]
pub struct ContainerHttpResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

struct WorkerJob {
    req: ContainerHttpRequest,
    reply: tokio::sync::oneshot::Sender<ContainerHttpResponse>,
}

struct WorkerWatch {
    abort: Arc<AtomicBool>,
    deadline_ms: Arc<AtomicU64>,
}

fn mono_ms() -> u64 {
    static START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_millis() as u64
}

/// Normalize a bundle-relative VFS key (forward slashes, no leading `/`, no `..`).
fn normalize_vfs_key(raw: &str) -> String {
    let normalized = raw.replace('\\', "/");
    let mut parts: Vec<&str> = Vec::new();
    for seg in normalized.split('/') {
        if seg.is_empty() || seg == "." {
            continue;
        }
        if seg == ".." {
            parts.pop();
        } else {
            parts.push(seg);
        }
    }
    parts.join("/")
}

/// Percent-decode and canonicalize an HTTP request path at ingress.
/// Rejects NUL bytes and encoded path separators (`%2f` / `%5c` / `%00`) so
/// URL-encoded segments cannot bypass `.htaccess` or private-path checks.
pub fn decode_http_path(raw: &str) -> Result<String, u16> {
    if raw.contains('\0') || raw.contains('\\') {
        return Err(400);
    }
    let bytes = raw.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return Err(400);
            }
            if let Ok(hex) = std::str::from_utf8(&bytes[i + 1..i + 3]) {
                if let Ok(b) = u8::from_str_radix(hex, 16) {
                    if b < 0x20 || b == 0x7f || b == b'/' || b == b'\\' || b == b'?' || b == b'#' {
                        return Err(400);
                    }
                    decoded.push(b);
                    i += 3;
                    continue;
                }
            }
            return Err(400);
        }
        decoded.push(bytes[i]);
        i += 1;
    }
    let text = String::from_utf8(decoded).map_err(|_| 400u16)?;
    if text.split('/').any(|seg| seg == "..") {
        return Err(400);
    }
    let trailing_slash = text.len() > 1 && text.ends_with('/');
    let norm = normalize_vfs_key(&text);
    if norm.is_empty() {
        Ok("/".to_owned())
    } else if trailing_slash {
        Ok(format!("/{norm}/"))
    } else {
        Ok(format!("/{norm}"))
    }
}

/// Check whether a path is a private/backend file that must NEVER be downloaded statically.
pub fn is_private_static_path(rel_path: &str) -> bool {
    let clean = normalize_vfs_key(rel_path);
    let lower = clean.to_ascii_lowercase();
    if lower.is_empty() {
        return false;
    }
    if lower
        .split('/')
        .any(|seg| seg.starts_with('.') && seg != ".well-known")
    {
        return true;
    }
    if lower == "manifest.json"
        || lower == "permission.json"
        || lower.starts_with("server/")
        || lower.starts_with("backend/")
        || lower.starts_with("private/")
        || lower.starts_with("db/")
        || lower.starts_with("database/")
        || lower.starts_with("migrations/")
    {
        return true;
    }
    let base = lower.rsplit('/').next().unwrap_or(&lower);
    if base.starts_with(".htaccess")
        || base.starts_with(".htpasswd")
        || base == ".env"
        || base.starts_with(".env.")
        || base == "cargo.toml"
        || base == "cargo.lock"
        || base == "composer.json"
        || base == "composer.lock"
        || base == "seed.json"
    {
        return true;
    }
    for ext in [
        ".php", ".phtml", ".php5", ".php7", ".php8", ".pht", ".phps", ".inc", ".phar", ".tpl",
        ".py", ".rs", ".toml", ".db", ".db-wal", ".db-shm", ".db-journal", ".sqlite",
        ".sqlite-wal", ".sqlite-shm", ".sqlite-journal", ".sqlite3", ".sqlite3-wal",
        ".sqlite3-shm", ".sqlite3-journal", ".sql", ".pem", ".key", ".secret", ".ini", ".bak",
        ".log", ".sh", ".logic",
    ] {
        if lower.ends_with(ext) {
            return true;
        }
    }
    false
}

/// Guess safe Content-Type for static frontend files.
pub fn mime_type_for(path: &str) -> &'static str {
    let ext = path
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" | "cjs" => "text/javascript; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "wasm" => "application/wasm",
        "txt" => "text/plain; charset=utf-8",
        "xml" => "application/xml; charset=utf-8",
        "csv" => "text/csv; charset=utf-8",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        _ => "application/octet-stream",
    }
}

// ── Minimal Apache `.htaccess` rewrite/security evaluator (matches @softn/container/src/htaccess.ts) ──

#[derive(Clone)]
struct HtaccessCond {
    test_string: String,
    pattern: String,
    compiled_regex: Option<Regex>,
    negated: bool,
    nocase: bool,
    or_next: bool,
}

#[derive(Clone)]
struct HtaccessRule {
    regex: Regex,
    /// `RewriteRule !pattern`: the rule is for a path the pattern does not match, and its
    /// `$1`…`$9` are empty, as Apache reads it.
    negated: bool,
    substitution: String,
    conds: Vec<HtaccessCond>,
    last: bool,
    qsa: bool,
    forbidden: bool,
    gone: bool,
    redirect_status: Option<u16>,
}

#[derive(Clone)]
struct RedirectMatchRule {
    status: u16,
    regex: Regex,
    target: Option<String>,
}

/// The methods a `Deny from all` / `Require all denied` is for: every one, or the ones the
/// `<Limit>` or `<LimitExcept>` it sits in says. Names are kept as Apache knows them: as
/// written (it matches them by case), and `HEAD` as `GET` (to Apache they are one method).
#[derive(Clone, Debug, PartialEq)]
enum DenyMethods {
    All,
    Only(Vec<String>),
    Except(Vec<String>),
}

impl DenyMethods {
    /// The scope of a `<Limit methods>` (`except`: `<LimitExcept methods>`) header. A `<Limit>`
    /// that names no method is one Apache refuses to load; it is read as naming them all.
    fn from_section(except: bool, args: &str) -> Self {
        let methods: Vec<String> = tokenize_apache_line(args).iter().map(|m| Self::apache_method(m)).collect();
        match (except, methods.is_empty()) {
            (true, _) => DenyMethods::Except(methods),
            (false, true) => DenyMethods::All,
            (false, false) => DenyMethods::Only(methods),
        }
    }

    fn apache_method(name: &str) -> String {
        if name == "HEAD" { "GET".to_owned() } else { name.to_owned() }
    }

    /// Whether the deny is for a request made with `method`, taken in upper case, which is
    /// how the host goes on to serve it.
    fn applies(&self, method: &str) -> bool {
        let method = Self::apache_method(&method.to_ascii_uppercase());
        match self {
            DenyMethods::All => true,
            DenyMethods::Only(methods) => methods.contains(&method),
            DenyMethods::Except(methods) => !methods.contains(&method),
        }
    }
}

#[derive(Clone, Default)]
struct ParsedHtaccess {
    dir_prefix: String,
    rewrite_engine: bool,
    rewrite_base: Option<String>,
    directory_index: Vec<String>,
    /// The directory's own denies, each with the methods it is for.
    deny_all: Vec<DenyMethods>,
    /// The denies of `<Files>`/`<FilesMatch>` blocks, likewise.
    deny_files: Vec<(Regex, DenyMethods)>,
    redirect_matches: Vec<RedirectMatchRule>,
    rules: Vec<HtaccessRule>,
}

impl ParsedHtaccess {
    /// A rules file that cannot be read in full, holds more denies, rewrite rules,
    /// RedirectMatch lines or conditions than are kept, or a `<Files>` pattern longer than is
    /// read (`MAX_HTACCESS_FILES_PATTERN_BYTES`), or whose sections do not match up or have a
    /// tag Apache does not read (`SectionTag::Malformed`), says who may not have what and
    /// cannot be asked: nobody has anything under it. The Node host
    /// (apps/softn-host-php/runtime/container-backend.mjs, `parseHtaccessFile`) reads it the
    /// same way. One read as far as it went, or passed over, let through what its unread
    /// part refused.
    fn closed(dir_prefix: &str, why: &str) -> Self {
        let dir_prefix = normalize_vfs_key(dir_prefix);
        tracing::warn!("{dir_prefix}/.htaccess: {why}, so everything under it is refused");
        ParsedHtaccess { dir_prefix, deny_all: vec![DenyMethods::All], ..Default::default() }
    }
}

/// Whether a line is `Deny from all` or `Require all denied`: by its words, in any case and
/// with any run of spaces and tabs between them, as Apache reads a directive.
fn is_apache_deny_all(line: &str) -> bool {
    let mut words = line.split([' ', '\t']).filter(|w| !w.is_empty());
    let mut next = || words.next().map(str::to_ascii_lowercase).unwrap_or_default();
    matches!(
        (next().as_str(), next().as_str(), next().as_str()),
        ("deny", "from", "all") | ("require", "all", "denied")
    )
}

enum HtaccessEval {
    Deny(u16),
    Redirect(u16, String),
    Rewrite { pathname: String, query: String },
}

fn tokenize_apache_line(line: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    let mut has_token = false;
    let mut chars = line.chars().peekable();
    while let Some(ch) = chars.next() {
        if let Some(q) = quote {
            if ch == '\\' && q == '"' {
                if let Some(next) = chars.next() {
                    cur.push(next);
                }
            } else if ch == q {
                quote = None;
            } else {
                cur.push(ch);
            }
            has_token = true;
        } else if ch == '"' || ch == '\'' {
            quote = Some(ch);
            has_token = true;
        } else if ch.is_whitespace() {
            if has_token {
                tokens.push(std::mem::take(&mut cur));
                has_token = false;
            }
        } else {
            cur.push(ch);
            has_token = true;
        }
    }
    if has_token {
        tokens.push(cur);
    }
    tokens
}

fn compile_apache_regex(pattern: &str, nocase: bool) -> Option<Regex> {
    if pattern.len() > 1024 {
        return None;
    }
    let spec = if nocase {
        format!("(?i){pattern}")
    } else {
        pattern.to_owned()
    };
    RegexBuilder::new(&spec)
        .size_limit(256 * 1024)
        .dfa_size_limit(256 * 1024)
        .build()
        .ok()
}

fn compile_apache_glob(glob: &str) -> Option<Regex> {
    let mut pat = String::with_capacity(glob.len() * 2 + 8);
    pat.push_str("(?i)^");
    for ch in glob.chars() {
        match ch {
            '*' => pat.push_str(".*"),
            '?' => pat.push('.'),
            '.' | '+' | '^' | '$' | '{' | '}' | '(' | ')' | '|' | '[' | ']' | '\\' => {
                pat.push('\\');
                pat.push(ch);
            }
            _ => pat.push(ch),
        }
    }
    pat.push('$');
    RegexBuilder::new(&pat)
        .size_limit(256 * 1024)
        .dfa_size_limit(256 * 1024)
        .build()
        .ok()
}

/// A section line of an `.htaccess`, as `parse_apache_section_tag` reads it.
enum SectionTag<'a> {
    /// `<Name args>` or `<Name>`: the lower-cased name, and what sits between it and the `>`.
    Open(String, &'a str),
    /// `</Name>`: the lower-cased name.
    Close(String),
    /// A line that starts as a tag does and is not one Apache reads: it answers 500 for
    /// everything under the directory. An opening tag whose name runs into its arguments or
    /// that does not end with its `>` (`<Files "secret.txt"`), or a closing tag that is not
    /// `</Name>` alone (`</Files >`, `</Files`). Apache passes over words after a tag's `>`
    /// after some tags and not others; here a tag is its whole line, and they are malformed too.
    Malformed,
}

/// The section tag a line of an `.htaccess` is, if it starts as one does: with `<` and a
/// letter, or with `</`. The Node host and the browser's reader read a line to the same tag.
fn parse_apache_section_tag(line: &str) -> Option<SectionTag<'_>> {
    let rest = line.strip_prefix('<')?;
    if let Some(after) = rest.strip_prefix('/') {
        let name_len = after.bytes().take_while(u8::is_ascii_alphabetic).count();
        return Some(if name_len > 0 && &after[name_len..] == ">" {
            SectionTag::Close(after[..name_len].to_ascii_lowercase())
        } else {
            SectionTag::Malformed
        });
    }
    let name_len = rest.bytes().take_while(u8::is_ascii_alphabetic).count();
    if name_len == 0 {
        return None;
    }
    // The name, then its `>`, or a space and the arguments and then the `>` that ends the line.
    let after_name = &rest[name_len..];
    let args = match after_name.strip_suffix('>') {
        Some("") => "",
        Some(args) if args.starts_with(char::is_whitespace) => args.trim(),
        _ => return Some(SectionTag::Malformed),
    };
    Some(SectionTag::Open(rest[..name_len].to_ascii_lowercase(), args))
}

/// The pattern of a `<Files>`/`<FilesMatch>` header, unquoted, and whether it is a regular
/// expression: `<FilesMatch regex>` and `<Files ~ regex>` hold one, `<Files name>` a wildcard
/// name. The Node host and the browser's reader take the same pattern from a header.
fn files_block_pattern<'a>(name: &str, args: &'a str) -> (&'a str, bool) {
    fn unquote(s: &str) -> &str {
        s.trim().trim_matches(|c| c == '"' || c == '\'')
    }
    if name == "filesmatch" {
        return (unquote(args), true);
    }
    match args.strip_prefix('~') {
        Some(rest) if rest.starts_with(char::is_whitespace) => (unquote(rest), true),
        _ => (unquote(args), false),
    }
}

/// A bundle's `.htaccess` as its rules, or, over 64 KiB, as a directory nobody may read from
/// (`ParsedHtaccess::closed`). By the file's own size, as the Node host measures it: read as
/// text, bytes that are not UTF-8 are longer than they were.
fn parse_htaccess_file(bytes: &[u8], dir_prefix: &str) -> ParsedHtaccess {
    if bytes.len() > MAX_HTACCESS_BYTES {
        return ParsedHtaccess::closed(dir_prefix, "the file is over 64 KiB and is not read");
    }
    parse_htaccess(&String::from_utf8_lossy(bytes), dir_prefix)
}

fn parse_htaccess(source: &str, dir_prefix: &str) -> ParsedHtaccess {
    let mut out = ParsedHtaccess {
        dir_prefix: normalize_vfs_key(dir_prefix),
        ..Default::default()
    };
    let mut pending_conds: Vec<HtaccessCond> = Vec::new();
    // The `<Files>`/`<FilesMatch>` block being read: its matcher and whether it denies. Being
    // inside the block is kept apart from having a matcher, because a pattern that does not
    // compile here (the regex crate has no look-around) still opens a block. Its lines must
    // not be read as the directory's own: `Require all denied` under
    // `<FilesMatch "^(?!index\.php$).*\.php$">` would then refuse every request, the entry
    // script included. Such a block denies nothing instead. What it would have named cannot be
    // worked out, and the paths the host keeps private do not depend on `.htaccess`.
    let mut files_block: Option<(Option<Regex>, Vec<DenyMethods>)> = None;
    // How deep the line sits in `<If>`, `<ElseIf>` and `<Else>`, whose condition is not
    // evaluated here. Their lines are skipped: a deny for some requests is not a deny for all.
    let mut unevaluated_depth = 0usize;
    // The `<Limit>`/`<LimitExcept>` sections the line sits in. A deny inside one is for the
    // methods it names (it used to be dropped, and then it was for nobody). Apache does not
    // let them nest; where they do, the deny is read as one for every method.
    let mut limits: Vec<DenyMethods> = Vec::new();
    // More denies than are kept (the directory's own and its blocks' together) close the
    // directory: the ones past the count used to be dropped.
    let too_many = |out: &ParsedHtaccess, pending: usize| out.deny_all.len() + out.deny_files.len() + pending > MAX_HTACCESS_DENY;
    // So do more RewriteRule or RedirectMatch lines than are kept, or more RewriteCond lines
    // before one rule. Those past the count used to be dropped too, and any of them could have
    // refused a request (`[F]`, `RedirectMatch 403`) or kept one from a rule that would have.
    // They are counted as they are read, compiled or not, so that the Node host, whose pattern
    // engine compiles some patterns this one does not and the other way round, closes the
    // directory at the same line.
    let mut rewrite_rules_read = 0usize;
    let mut redirect_matches_read = 0usize;
    // The sections the line sits in, by name, the innermost last. Apache will not load a file
    // whose sections do not match up (one closed that is not the innermost open, or one left
    // open at the end) and answers 500 for everything under the directory. Read as far as it
    // went, a block left open denied nothing, and what followed a stray closing tag was read
    // as though it were outside its section: such a file refuses everything here instead. So
    // does one with a tag Apache does not read (`</Files >`, `<Files "secret.txt"`), which was
    // taken for the tag it looks like.
    let mut sections: Vec<String> = Vec::new();

    for raw_line in source.lines() {
        // What JavaScript's `trim` takes off is taken off here too (a byte-order mark; and
        // the Node host takes off U+0085, which only Rust's does), so that a line is the
        // same line to both hosts.
        let trimmed = raw_line.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if let Some(tag) = parse_apache_section_tag(trimmed) {
            let (closing, name, args) = match tag {
                SectionTag::Open(name, args) => (false, name, args),
                SectionTag::Close(name) => (true, name, ""),
                SectionTag::Malformed => return ParsedHtaccess::closed(dir_prefix, "it holds a section tag Apache does not read"),
            };
            if !closing {
                sections.push(name.clone());
            } else if sections.pop().as_ref() != Some(&name) {
                return ParsedHtaccess::closed(dir_prefix, "it closes a section that is not the one open");
            }
            match name.as_str() {
                "if" | "elseif" | "else" => {
                    unevaluated_depth = if closing {
                        unevaluated_depth.saturating_sub(1)
                    } else {
                        unevaluated_depth + 1
                    };
                }
                _ if unevaluated_depth > 0 => {}
                "limit" | "limitexcept" if closing => {
                    limits.pop();
                }
                "limit" | "limitexcept" => limits.push(DenyMethods::from_section(name == "limitexcept", args)),
                "files" | "filesmatch" if closing => match files_block.take() {
                    Some((Some(rx), methods)) => {
                        out.deny_files.extend(methods.into_iter().map(|methods| (rx.clone(), methods)));
                        if too_many(&out, 0) {
                            return ParsedHtaccess::closed(dir_prefix, "it holds more denies than are kept");
                        }
                    }
                    Some((None, methods)) if !methods.is_empty() => tracing::warn!(
                        "{}/.htaccess: a <Files>/<FilesMatch> pattern is not supported here, so its deny is not applied",
                        out.dir_prefix
                    ),
                    _ => {}
                },
                "files" | "filesmatch" => {
                    // A pattern over the limit is not read, and what it would have named cannot
                    // be worked out: nobody has anything under the directory. It used to be read
                    // as one that does not compile, which denies nothing.
                    let (pattern, is_regex) = files_block_pattern(&name, args);
                    if pattern.len() > MAX_HTACCESS_FILES_PATTERN_BYTES {
                        return ParsedHtaccess::closed(dir_prefix, "it holds a <Files>/<FilesMatch> pattern over 512 bytes");
                    }
                    let matcher = if is_regex { compile_apache_regex(pattern, true) } else { compile_apache_glob(pattern) };
                    files_block = Some((matcher, Vec::new()));
                }
                // `<IfModule>` and the like: the body applies as written.
                _ => {}
            }
            continue;
        }
        if unevaluated_depth > 0 {
            continue;
        }
        if is_apache_deny_all(trimmed) {
            let methods = match limits.as_slice() {
                [] => DenyMethods::All,
                [limit] => limit.clone(),
                _ => DenyMethods::All,
            };
            // Said twice (`Require all denied` and, for an older Apache, `Deny from all`) is said once.
            let kept = match files_block.as_mut() {
                Some((_, block_methods)) => block_methods,
                None => &mut out.deny_all,
            };
            if !kept.contains(&methods) {
                kept.push(methods);
            }
            let pending = files_block.as_ref().map_or(0, |(_, block_methods)| block_methods.len());
            if too_many(&out, pending) {
                return ParsedHtaccess::closed(dir_prefix, "it holds more denies than are kept");
            }
            continue;
        }
        // Nothing else is read inside a block or a method section.
        if files_block.is_some() || !limits.is_empty() {
            continue;
        }

        let tokens = tokenize_apache_line(trimmed);
        if tokens.is_empty() {
            continue;
        }
        match tokens[0].to_ascii_lowercase().as_str() {
            "rewriteengine" if tokens.len() >= 2 => {
                out.rewrite_engine = tokens[1].eq_ignore_ascii_case("on");
            }
            "rewritebase" if tokens.len() >= 2 => {
                out.rewrite_base = Some(tokens[1].clone());
            }
            "directoryindex" if tokens.len() >= 2 => {
                out.directory_index = tokens[1..].to_vec();
            }
            "redirectmatch" if tokens.len() >= 2 => {
                redirect_matches_read += 1;
                if redirect_matches_read > MAX_HTACCESS_RULES {
                    return ParsedHtaccess::closed(dir_prefix, "it holds more RedirectMatch lines than are kept");
                }
                let (status, pat_idx) = match tokens[1].to_ascii_lowercase().as_str() {
                    "permanent" => (301u16, 2),
                    "temp" => (302u16, 2),
                    "seeother" => (303u16, 2),
                    "gone" => (410u16, 2),
                    s => match s.parse::<u16>() {
                        Ok(code) if (300..=599).contains(&code) => (code, 2),
                        _ => (302u16, 1),
                    },
                };
                if let Some(pat) = tokens.get(pat_idx) {
                    if let Some(rx) = compile_apache_regex(pat, false) {
                        let target = tokens.get(pat_idx + 1).cloned();
                        out.redirect_matches.push(RedirectMatchRule { status, regex: rx, target });
                    }
                }
            }
            "rewritecond" if tokens.len() >= 3 => {
                if pending_conds.len() >= MAX_HTACCESS_CONDS {
                    return ParsedHtaccess::closed(dir_prefix, "a rewrite rule has more conditions than are kept");
                }
                let test_string = tokens[1].clone();
                let mut pattern = tokens[2].clone();
                let mut negated = false;
                if let Some(rest) = pattern.strip_prefix('!') {
                    negated = true;
                    pattern = rest.to_owned();
                }
                let flags = tokens.get(3).map(String::as_str).unwrap_or("");
                let inner = flags.trim_start_matches('[').trim_end_matches(']');
                let mut nocase = false;
                let mut or_next = false;
                for f in inner.split(',').map(str::trim) {
                    if f.eq_ignore_ascii_case("nc") || f.eq_ignore_ascii_case("nocase") {
                        nocase = true;
                    }
                    if f.eq_ignore_ascii_case("or") || f.eq_ignore_ascii_case("ornext") {
                        or_next = true;
                    }
                }
                let compiled_regex = if matches!(pattern.as_str(), "-f" | "-F" | "-s" | "-d" | "-l" | "-L")
                    || pattern.starts_with('=')
                {
                    None
                } else {
                    compile_apache_regex(&pattern, nocase)
                };
                pending_conds.push(HtaccessCond {
                    test_string,
                    pattern,
                    compiled_regex,
                    negated,
                    nocase,
                    or_next,
                });
            }
            "rewriterule" if tokens.len() >= 3 => {
                rewrite_rules_read += 1;
                if rewrite_rules_read > MAX_HTACCESS_RULES {
                    return ParsedHtaccess::closed(dir_prefix, "it holds more rewrite rules than are kept");
                }
                // A leading `!` negates the pattern (it is not a part of it).
                let (negated, pat) = match tokens[1].strip_prefix('!') {
                    Some(rest) => (true, rest),
                    None => (false, tokens[1].as_str()),
                };
                let substitution = tokens[2].clone();
                let flags = tokens.get(3).map(String::as_str).unwrap_or("");
                let inner = flags.trim_start_matches('[').trim_end_matches(']');
                let mut last = false;
                let mut qsa = false;
                let mut nocase = false;
                let mut forbidden = false;
                let mut gone = false;
                let mut redirect_status: Option<u16> = None;
                for f in inner.split(',').map(str::trim) {
                    let up = f.to_ascii_uppercase();
                    match up.as_str() {
                        "L" | "LAST" | "END" => last = true,
                        "QSA" | "QSAPPEND" => qsa = true,
                        "NC" | "NOCASE" => nocase = true,
                        "F" | "FORBIDDEN" => {
                            forbidden = true;
                            last = true;
                        }
                        "G" | "GONE" => {
                            gone = true;
                            last = true;
                        }
                        "R" => redirect_status = Some(302),
                        _ if up.starts_with("R=") => {
                            let val = &up[2..];
                            redirect_status = Some(match val {
                                "PERMANENT" => 301,
                                "TEMP" => 302,
                                num => num.parse::<u16>().ok().filter(|c| (300..400).contains(c)).unwrap_or(302),
                            });
                        }
                        _ => {}
                    }
                }
                if let Some(regex) = compile_apache_regex(pat, nocase) {
                    out.rules.push(HtaccessRule {
                        regex,
                        negated,
                        substitution,
                        conds: std::mem::take(&mut pending_conds),
                        last,
                        qsa,
                        forbidden,
                        gone,
                        redirect_status,
                    });
                } else {
                    pending_conds.clear();
                }
            }
            _ => {}
        }
    }
    if let Some(open) = sections.last() {
        return ParsedHtaccess::closed(dir_prefix, &format!("its <{open}> section is not closed"));
    }
    out
}

fn build_vfs_dir_index(vfs: &HashMap<String, Vec<u8>>) -> HashSet<String> {
    let mut dirs = HashSet::new();
    for key in vfs.keys() {
        let mut pos = 0;
        while let Some(rel) = key[pos..].find('/') {
            let idx = pos + rel;
            if idx > 0 {
                dirs.insert(key[..idx].to_owned());
            }
            pos = idx + 1;
        }
    }
    dirs
}

fn vfs_has_file(vfs: &HashMap<String, Vec<u8>>, rel: &str) -> bool {
    vfs.contains_key(&normalize_vfs_key(rel))
}

fn vfs_has_dir(vfs_dirs: &HashSet<String>, rel: &str) -> bool {
    let clean = normalize_vfs_key(rel);
    if clean.is_empty() {
        return true;
    }
    vfs_dirs.contains(&clean)
}

fn expand_apache_vars(
    expr: &str,
    rel_path: &str,
    full_path: &str,
    query: &str,
    method: &str,
    host: &str,
    https: bool,
    headers: &HashMap<String, String>,
) -> String {
    let mut out = String::with_capacity(expr.len());
    let mut i = 0;
    while i < expr.len() {
        if expr[i..].starts_with("%{") {
            if let Some(end) = expr[i + 2..].find('}') {
                let var = &expr[i + 2..i + 2 + end];
                let up = var.to_ascii_uppercase();
                match up.as_str() {
                    "REQUEST_FILENAME" => out.push_str(rel_path),
                    "REQUEST_URI" => out.push_str(full_path),
                    "QUERY_STRING" => out.push_str(query),
                    "REQUEST_METHOD" => out.push_str(method),
                    "HTTP_HOST" => out.push_str(host),
                    "HTTPS" => out.push_str(if https { "on" } else { "off" }),
                    _ if up.starts_with("HTTP:") => {
                        let key = var[5..].to_ascii_lowercase();
                        if !matches!(key.as_str(), "cookie" | "authorization" | "proxy-authorization") {
                            if let Some(v) = headers.get(&key) {
                                out.push_str(v);
                            }
                        }
                    }
                    _ => {}
                }
                i += 3 + end;
                continue;
            }
        }
        let ch = expr[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

fn apply_backrefs(sub: &str, rule_groups: &[String], cond_groups: &[String]) -> String {
    let mut out = String::with_capacity(sub.len());
    let chars: Vec<char> = sub.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if (chars[i] == '$' || chars[i] == '%') && i + 1 < chars.len() && chars[i + 1].is_ascii_digit() {
            let idx = (chars[i + 1] as u8 - b'0') as usize;
            let groups = if chars[i] == '$' { rule_groups } else { cond_groups };
            if idx > 0 {
                if let Some(g) = groups.get(idx - 1) {
                    out.push_str(g);
                }
            }
            i += 2;
            continue;
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

fn evaluate_htaccess_chain(
    htaccess_map: &HashMap<String, ParsedHtaccess>,
    pathname: &str,
    query: &str,
    method: &str,
    host: &str,
    https: bool,
    headers: &HashMap<String, String>,
    vfs: &HashMap<String, Vec<u8>>,
    vfs_dirs: &HashSet<String>,
) -> HtaccessEval {
    let trailing_slash = pathname.len() > 1 && pathname.ends_with('/');
    let norm_rel = normalize_vfs_key(pathname);
    let clean = if norm_rel.is_empty() {
        "/".to_owned()
    } else if trailing_slash {
        format!("/{norm_rel}/")
    } else {
        format!("/{norm_rel}")
    };
    let mut cur_path = clean;
    let mut cur_query = query.to_owned();

    let check_access = |path_to_check: &str| -> Option<HtaccessEval> {
        let mut active_prefixes = vec![String::new()];
        let mut acc = String::new();
        for seg in path_to_check.trim_start_matches('/').split('/').filter(|s| !s.is_empty()) {
            if !acc.is_empty() {
                acc.push('/');
            }
            acc.push_str(seg);
            if htaccess_map.contains_key(&acc) {
                active_prefixes.push(acc.clone());
            }
        }
        let trimmed = path_to_check.trim_matches('/');
        let segs: Vec<&str> = trimmed.split('/').filter(|s| !s.is_empty()).collect();
        for prefix in &active_prefixes {
            let Some(ht) = htaccess_map.get(prefix) else {
                continue;
            };
            if ht.deny_all.iter().any(|methods| methods.applies(method)) {
                return Some(HtaccessEval::Deny(403));
            }
            if !ht.deny_files.is_empty() {
                // A `<Files>` block names the file a request is mapped to. That is the last
                // segment, and it is also any segment before it that is a file: Apache stops
                // there and hands the rest to it as PATH_INFO, so `/db.inc/x` is `db.inc`.
                // The Node host tests the same names (`evaluateHtaccessChain`).
                let denied = |name: &str| ht.deny_files.iter().any(|(rx, methods)| methods.applies(method) && rx.is_match(name));
                if let Some(&last_seg) = segs.last() {
                    if denied(last_seg) {
                        return Some(HtaccessEval::Deny(403));
                    }
                }
                let mut probe = String::new();
                for &seg in segs.iter().take(segs.len().saturating_sub(1)) {
                    if !probe.is_empty() {
                        probe.push('/');
                    }
                    probe.push_str(seg);
                    if vfs.contains_key(&probe) && denied(seg) {
                        return Some(HtaccessEval::Deny(403));
                    }
                }
            }
            for rm in &ht.redirect_matches {
                if let Some(caps) = rm.regex.captures(path_to_check) {
                    if rm.status >= 400 {
                        return Some(HtaccessEval::Deny(rm.status));
                    }
                    if let Some(ref target) = rm.target {
                        let groups: Vec<String> = (1..caps.len())
                            .map(|idx| caps.get(idx).map(|m| m.as_str().to_owned()).unwrap_or_default())
                            .collect();
                        let loc = apply_backrefs(target, &groups, &[]);
                        return Some(HtaccessEval::Redirect(rm.status, loc));
                    }
                }
            }
        }
        None
    };

    if let Some(blocked) = check_access(&cur_path) {
        return blocked;
    }

    for _pass in 0..MAX_HTACCESS_PASSES {
        let mut prefixes = vec![String::new()];
        let mut acc = String::new();
        for seg in cur_path.trim_start_matches('/').split('/').filter(|s| !s.is_empty()) {
            if !acc.is_empty() {
                acc.push('/');
            }
            acc.push_str(seg);
            if htaccess_map.contains_key(&acc) {
                prefixes.push(acc.clone());
            }
        }
        let path_before_pass = cur_path.clone();
        let mut rewrote_any = false;

        for prefix in prefixes {
            let Some(ht) = htaccess_map.get(&prefix) else {
                continue;
            };
            if !ht.rewrite_engine || ht.rules.is_empty() {
                continue;
            }
            let prefix_slashes = if ht.dir_prefix.is_empty() {
                "/".to_owned()
            } else {
                format!("/{}/", ht.dir_prefix)
            };
            let mut local_path = if ht.dir_prefix.is_empty() {
                cur_path.trim_start_matches('/').to_owned()
            } else if cur_path == format!("/{}", ht.dir_prefix) {
                String::new()
            } else if let Some(rest) = cur_path.strip_prefix(&prefix_slashes) {
                rest.to_owned()
            } else {
                continue;
            };

            for rule in &ht.rules {
                // A rule is for a path its pattern matches, or for one it does not when it is
                // negated, which then has no groups: its `$1`…`$9` are empty.
                let rule_groups: Vec<String> = match rule.regex.captures(&local_path) {
                    Some(_) if rule.negated => continue,
                    Some(caps) => (1..caps.len())
                        .map(|idx| caps.get(idx).map(|m| m.as_str().to_owned()).unwrap_or_default())
                        .collect(),
                    None if rule.negated => Vec::new(),
                    None => continue,
                };
                let rel_probe = if ht.dir_prefix.is_empty() {
                    local_path.clone()
                } else if local_path.is_empty() {
                    ht.dir_prefix.clone()
                } else {
                    format!("{}/{}", ht.dir_prefix, local_path)
                };

                let mut conds_ok = true;
                let mut last_cond_groups: Vec<String> = Vec::new();
                let mut in_or = false;
                let mut or_acc = false;

                for cond in &rule.conds {
                    let test_val = expand_apache_vars(
                        &cond.test_string,
                        &rel_probe,
                        &cur_path,
                        &cur_query,
                        method,
                        host,
                        https,
                        headers,
                    );
                    let mut groups = Vec::new();
                    let raw_match = match cond.pattern.as_str() {
                        "-f" | "-F" | "-s" => vfs_has_file(vfs, &test_val),
                        "-d" => vfs_has_dir(vfs_dirs, &test_val),
                        "-l" | "-L" => false,
                        pat if pat.starts_with('=') => {
                            let rhs = &pat[1..];
                            if cond.nocase {
                                test_val.eq_ignore_ascii_case(rhs)
                            } else {
                                test_val == rhs
                            }
                        }
                        _ => {
                            if let Some(ref rx) = cond.compiled_regex {
                                if let Some(cm) = rx.captures(&test_val) {
                                    for idx in 1..cm.len() {
                                        groups.push(cm.get(idx).map(|m| m.as_str().to_owned()).unwrap_or_default());
                                    }
                                    true
                                } else {
                                    false
                                }
                            } else {
                                false
                            }
                        }
                    };
                    let matched = if cond.negated { !raw_match } else { raw_match };
                    if matched && !groups.is_empty() {
                        last_cond_groups = groups;
                    }
                    if cond.or_next {
                        or_acc = if in_or { or_acc || matched } else { matched };
                        in_or = true;
                    } else {
                        let term = if in_or { or_acc || matched } else { matched };
                        in_or = false;
                        or_acc = false;
                        if !term {
                            conds_ok = false;
                            break;
                        }
                    }
                }
                if in_or && !or_acc {
                    conds_ok = false;
                }
                if !conds_ok {
                    continue;
                }
                if rule.forbidden {
                    return HtaccessEval::Deny(403);
                }
                if rule.gone {
                    return HtaccessEval::Deny(410);
                }
                if rule.substitution == "-" {
                    if rule.last {
                        break;
                    }
                    continue;
                }
                // Expand Apache server variables BEFORE substituting attacker-controlled regex
                // backreferences so a captured URL segment containing `%{HTTP:Cookie}` is never evaluated.
                let expanded_vars = expand_apache_vars(
                    &rule.substitution,
                    &rel_probe,
                    &cur_path,
                    &cur_query,
                    method,
                    host,
                    https,
                    headers,
                );
                let expanded = apply_backrefs(&expanded_vars, &rule_groups, &last_cond_groups);
                let (sub_path, sub_query) = match expanded.split_once('?') {
                    Some((p, q)) => (p, Some(q)),
                    None => (expanded.as_str(), None),
                };
                let next_query = match sub_query {
                    Some(sq) if rule.qsa && !cur_query.is_empty() => {
                        if sq.is_empty() {
                            cur_query.clone()
                        } else {
                            format!("{sq}&{cur_query}")
                        }
                    }
                    Some(sq) => sq.to_owned(),
                    None => cur_query.clone(),
                };
                if let Some(code) = rule.redirect_status {
                    let loc = if next_query.is_empty() {
                        sub_path.to_owned()
                    } else {
                        format!("{sub_path}?{next_query}")
                    };
                    return HtaccessEval::Redirect(code, loc);
                }
                let raw_next = if sub_path.starts_with('/') {
                    sub_path.to_owned()
                } else if let Some(base) = &ht.rewrite_base {
                    let b = base.trim_end_matches('/');
                    format!("{b}/{sub_path}")
                } else {
                    format!("{prefix_slashes}{sub_path}")
                };
                // Canonicalize rewritten path with `normalize_vfs_key` to eliminate `..`, `///`, etc.
                let trailing = raw_next.len() > 1 && raw_next.ends_with('/');
                let norm_next = normalize_vfs_key(&raw_next);
                let next_full = if norm_next.is_empty() {
                    "/".to_owned()
                } else if trailing {
                    format!("/{norm_next}/")
                } else {
                    format!("/{norm_next}")
                };

                if let Some(blocked) = check_access(&next_full) {
                    return blocked;
                }

                local_path = if !ht.dir_prefix.is_empty() {
                    next_full
                        .strip_prefix(&prefix_slashes)
                        .unwrap_or_else(|| next_full.trim_start_matches('/'))
                        .to_owned()
                } else {
                    next_full.trim_start_matches('/').to_owned()
                };
                cur_path = next_full;
                cur_query = next_query;
                rewrote_any = true;
                if rule.last {
                    break;
                }
            }
        }
        if !rewrote_any || cur_path == path_before_pass {
            break;
        }
    }

    HtaccessEval::Rewrite {
        pathname: cur_path,
        query: cur_query,
    }
}

// ── Server-side Sandboxed Multi-User SQLite Bridge (`app.sql.*`) ──

#[derive(Clone)]
struct SqlStorageConfig {
    db_dir: PathBuf,
    databases: Vec<ContainerDatabaseConfig>,
    db_fs_lock: Arc<Mutex<()>>,
}

impl SqlStorageConfig {
    fn normalize_db_key(raw: &str) -> (String, bool) {
        let mut s = raw.trim().to_owned();
        if s.is_empty() || s == ":memory:" || s == "sqlite::memory:" || s == "sqlite://:memory:" {
            return (":memory:".to_owned(), true);
        }
        if let Some(rest) = s.strip_prefix("sqlite://") {
            s = rest.to_owned();
        } else if let Some(rest) = s.strip_prefix("sqlite:") {
            s = rest.to_owned();
        } else if let Some(rest) = s.strip_prefix("file:") {
            s = rest.to_owned();
        }
        if let Some((before, query)) = s.split_once('?') {
            if query.contains("mode=memory") && !query.contains("cache=shared") {
                return (":memory:".to_owned(), true);
            }
            s = before.to_owned();
        }
        if s == ":memory:" {
            return (":memory:".to_owned(), true);
        }
        let clean = normalize_vfs_key(&s);
        if clean.is_empty() {
            ("default.db".to_owned(), false)
        } else {
            (clean, false)
        }
    }

    fn resolve_db_path(&self, raw: &str) -> Result<Option<PathBuf>, String> {
        self.resolve_db_path_inner(raw, true)
    }

    fn resolve_exact_db_path(&self, raw: &str) -> Result<Option<PathBuf>, String> {
        self.resolve_db_path_inner(raw, false)
    }

    fn is_configured_db_path(&self, path: &Path) -> bool {
        let target_name = path
            .file_name()
            .and_then(|n| n.to_str())
            .map(str::to_ascii_lowercase);
        self.databases.iter().any(|cfg| {
            let target = cfg.file.as_deref().unwrap_or(&cfg.name);
            matches!(self.resolve_db_path(target), Ok(Some(cfg_path)) if cfg_path == path
                || target_name.is_some()
                    && cfg_path
                        .file_name()
                        .and_then(|n| n.to_str())
                        .map(str::to_ascii_lowercase)
                        == target_name)
        })
    }

    fn resolve_db_path_inner(&self, raw: &str, allow_single_alias: bool) -> Result<Option<PathBuf>, String> {
        let (key, in_memory) = Self::normalize_db_key(raw);
        if in_memory {
            return Ok(None);
        }
        let lower = key.to_ascii_lowercase();
        let base = lower.rsplit('/').next().unwrap_or(&lower);
        let dedup = base.strip_suffix(".db.db").map(|s| format!("{s}.db")).unwrap_or_else(|| base.to_owned());

        let mut chosen_key = key.clone();
        let mut matched_cfg = false;
        for cfg in &self.databases {
            let cfg_target = cfg.file.as_deref().unwrap_or(&cfg.name);
            let (cfg_key, _) = Self::normalize_db_key(cfg_target);
            let cfg_lower = cfg_key.to_ascii_lowercase();
            let name_lower = cfg.name.to_ascii_lowercase();
            if cfg_lower == lower
                || name_lower == lower
                || cfg_lower == base
                || cfg_lower == dedup
                || format!("{name_lower}.db") == base
                || format!("{name_lower}.db") == dedup
            {
                chosen_key = cfg_key;
                matched_cfg = true;
                break;
            }
        }
        // Single-DB aliasing (matches XdbSqlManager in @softn/container)
        if allow_single_alias && !matched_cfg && self.databases.len() == 1 {
            let cfg = &self.databases[0];
            let cfg_target = cfg.file.as_deref().unwrap_or(&cfg.name);
            let (cfg_key, _) = Self::normalize_db_key(cfg_target);
            chosen_key = cfg_key;
        }

        // Flatten to safe filename under `<data_dir>/databases/`
        let safe_name: String = chosen_key
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' {
                    c
                } else {
                    '_'
                }
            })
            .collect();
        let filename = if safe_name.is_empty() || safe_name.starts_with('.') {
            format!("db_{safe_name}.sqlite")
        } else if safe_name.ends_with(".db") || safe_name.ends_with(".sqlite") || safe_name.ends_with(".sqlite3") {
            safe_name
        } else {
            format!("{safe_name}.db")
        };
        let path = self.db_dir.join(filename);
        reject_symlink(&path)?;
        for suffix in ["-wal", "-shm", "-journal"] {
            reject_symlink(&PathBuf::from(format!("{}{suffix}", path.display())))?;
        }
        Ok(Some(path))
    }

    fn open_configured_connection(path: Option<&Path>) -> Result<(Connection, Arc<AtomicBool>), String> {
        let mut conn = match path {
            Some(p) => Connection::open(p).map_err(|e| format!("Cannot open SQLite DB: {e}"))?,
            None => Connection::open_in_memory().map_err(|e| format!("Cannot open memory SQLite DB: {e}"))?,
        };
        conn.busy_timeout(Duration::from_secs(5))
            .map_err(|e| format!("Cannot configure SQLite timeout: {e}"))?;
        let pragmas = if path.is_some() {
            "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL; PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY; PRAGMA max_page_count=131072;"
        } else {
            "PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY; PRAGMA max_page_count=131072;"
        };
        conn.execute_batch(pragmas)
            .map_err(|e| format!("Cannot configure SQLite pragmas: {e}"))?;
        let _ = conn.set_limit(Limit::SQLITE_LIMIT_LENGTH, MAX_SQL_RESULT_BYTES as i32);
        let _ = conn.set_limit(Limit::SQLITE_LIMIT_SQL_LENGTH, 512 * 1024);
        let _ = conn.set_limit(Limit::SQLITE_LIMIT_COLUMN, 256);
        let _ = conn.set_limit(Limit::SQLITE_LIMIT_ATTACHED, 0);
        let _ = conn.set_limit(Limit::SQLITE_LIMIT_VARIABLE_NUMBER, 999);
        let _ = conn.set_limit(Limit::SQLITE_LIMIT_EXPR_DEPTH, 128);
        let _ = conn.set_limit(Limit::SQLITE_LIMIT_VDBE_OP, 250_000);
        let _ = conn.set_limit(Limit::SQLITE_LIMIT_WORKER_THREADS, 0);
        let _ = conn.set_limit(Limit::SQLITE_LIMIT_LIKE_PATTERN_LENGTH, LIKE_PATTERN_LIMIT);
        let in_host_savepoint = Arc::new(AtomicBool::new(false));
        let in_sp = Arc::clone(&in_host_savepoint);
        // Install SQLite semantic authorizer blocking host-filesystem ATTACH/DETACH,
        // extension loading, virtual tables, host-reserved `_*` objects, unsafe PRAGMAs,
        // and transaction/savepoint tampering while a host DDL savepoint guard is active.
        conn.authorizer(Some(move |ctx: AuthContext<'_>| {
            if let Some(db_name) = ctx.database_name {
                if db_name != "main" && db_name != "temp" {
                    return Authorization::Deny;
                }
            }
            match ctx.action {
                AuthAction::Transaction { .. } | AuthAction::Savepoint { .. }
                    if in_sp.load(Ordering::Acquire) =>
                {
                    Authorization::Deny
                }
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
                AuthAction::Read { table_name, .. }
                | AuthAction::Insert { table_name }
                | AuthAction::Update { table_name, .. }
                | AuthAction::Delete { table_name }
                | AuthAction::CreateTable { table_name }
                | AuthAction::DropTable { table_name }
                | AuthAction::CreateTempTable { table_name }
                | AuthAction::DropTempTable { table_name }
                | AuthAction::AlterTable { table_name, .. }
                    if table_name.starts_with('_') =>
                {
                    Authorization::Deny
                }
                AuthAction::CreateTrigger { trigger_name, table_name }
                | AuthAction::DropTrigger { trigger_name, table_name }
                | AuthAction::CreateTempTrigger { trigger_name, table_name }
                | AuthAction::DropTempTrigger { trigger_name, table_name }
                    if trigger_name.starts_with('_') || table_name.starts_with('_') =>
                {
                    Authorization::Deny
                }
                AuthAction::CreateView { view_name }
                | AuthAction::DropView { view_name }
                | AuthAction::CreateTempView { view_name }
                | AuthAction::DropTempView { view_name }
                    if view_name.starts_with('_') =>
                {
                    Authorization::Deny
                }
                AuthAction::CreateIndex { index_name, table_name }
                | AuthAction::DropIndex { index_name, table_name }
                | AuthAction::CreateTempIndex { index_name, table_name }
                | AuthAction::DropTempIndex { index_name, table_name }
                    if index_name.starts_with('_') || table_name.starts_with('_') =>
                {
                    Authorization::Deny
                }
                AuthAction::Pragma { pragma_name, pragma_value } => {
                    let lower = pragma_name.to_ascii_lowercase();
                    let is_introspection = matches!(
                        lower.as_str(),
                        "table_info"
                            | "table_xinfo"
                            | "index_list"
                            | "index_info"
                            | "foreign_key_list"
                    );
                    let is_writable = matches!(
                        lower.as_str(),
                        "foreign_keys" | "user_version" | "application_id"
                    );
                    let allowed_read = is_introspection
                        || is_writable
                        || matches!(
                            lower.as_str(),
                            "schema_version"
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
                    if let Some(val) = pragma_value {
                        if is_introspection {
                            // SQLite passes the target table/index name as pragma_value for
                            // read-only schema introspection pragmas; block reserved tables.
                            let val_lower = val.to_ascii_lowercase();
                            if val.starts_with('_') || val_lower.starts_with("sqlite_") {
                                return Authorization::Deny;
                            }
                            return Authorization::Allow;
                        }
                        if !is_writable {
                            return Authorization::Deny;
                        }
                    }
                    Authorization::Allow
                }
                _ => Authorization::Allow,
            }
        }))
        .map_err(|e| format!("Cannot install SQLite authorizer: {e}"))?;
        Ok((conn, in_host_savepoint))
    }

    fn preseed_all(&self, vfs: &HashMap<String, Vec<u8>>) -> Result<(), String> {
        fs::create_dir_all(&self.db_dir)
            .map_err(|e| format!("Failed to create container databases dir: {e}"))?;
        for cfg in &self.databases {
            let target = cfg.file.as_deref().unwrap_or(&cfg.name);
            let Some(path) = self.resolve_db_path(target)? else {
                continue;
            };
            let marker = PathBuf::from(format!("{}.softn_seeded", path.display()));
            if marker.exists() {
                continue;
            }
            let db_existed_before = path.exists();
            // Copy bundled `.db` file if present and DB file doesn't exist yet
            if !db_existed_before {
                if let Some(file_key) = cfg.file.as_deref() {
                    let norm = normalize_vfs_key(file_key);
                    if let Some(bytes) = vfs.get(&norm) {
                        fs::write(&path, bytes)
                            .map_err(|e| format!("Failed to unpack bundled DB {norm}: {e}"))?;
                    }
                }
            }
            let (mut conn, in_host_savepoint) = Self::open_configured_connection(Some(&path))?;
            let seed_deadline = Instant::now() + Duration::from_secs(30);
            let mut seed_steps = 0u64;
            let _ = conn.progress_handler(
                1000,
                Some(move || {
                    seed_steps += 1000;
                    seed_steps > 50_000_000 || Instant::now() >= seed_deadline
                }),
            );
            if let Some(seed_sql) = &cfg.seed_sql {
                let norm = normalize_vfs_key(seed_sql);
                let sql_text = vfs
                    .get(&norm)
                    .map(|b| String::from_utf8_lossy(b).into_owned())
                    .unwrap_or_else(|| seed_sql.clone());
                if !sql_text.trim().is_empty() {
                    let analysis = analyze_sql_keywords(&sql_text);
                    let has_rename = analysis.has_rename;
                    let has_explicit_tx = analysis.has_tx_control;
                    if has_rename && has_explicit_tx {
                        drop(conn);
                        if !db_existed_before {
                            let _ = fs::remove_file(&path);
                        }
                        return Err(format!(
                            "seedSql for DB '{}' cannot mix transaction/savepoint control with RENAME",
                            cfg.name
                        ));
                    }
                    let reserved_before = reserved_sqlite_objects(&conn);
                    let use_sp = (has_rename || !has_explicit_tx)
                        && conn.execute_batch("SAVEPOINT softn_seed_guard").is_ok();
                    let exec_res = {
                        let _guard = if use_sp {
                            in_host_savepoint.store(true, Ordering::Release);
                            Some(SavepointFlagReset(&in_host_savepoint))
                        } else {
                            None
                        };
                        conn.execute_batch(&sql_text)
                    };
                    if let Err(e) = exec_res {
                        if use_sp {
                            let _ = conn.execute_batch(
                                "ROLLBACK TO softn_seed_guard; RELEASE softn_seed_guard",
                            );
                        }
                        drop(conn);
                        if !db_existed_before {
                            let _ = fs::remove_file(&path);
                        }
                        return Err(format!("Failed to run seedSql for DB '{}': {e}", cfg.name));
                    }
                    let reserved_after = reserved_sqlite_objects(&conn);
                    if reserved_after.iter().any(|n| !reserved_before.contains(n)) {
                        if use_sp {
                            let _ = conn.execute_batch(
                                "ROLLBACK TO softn_seed_guard; RELEASE softn_seed_guard",
                            );
                        }
                        drop(conn);
                        if !db_existed_before {
                            let _ = fs::remove_file(&path);
                        }
                        return Err(format!(
                            "seedSql for DB '{}' attempted to create or rename a host-reserved _-prefixed object",
                            cfg.name
                        ));
                    }
                    if use_sp {
                        if let Err(e) = conn.execute_batch("RELEASE softn_seed_guard") {
                            let _ = conn.execute_batch(
                                "ROLLBACK TO softn_seed_guard; RELEASE softn_seed_guard",
                            );
                            drop(conn);
                            if !db_existed_before {
                                let _ = fs::remove_file(&path);
                            }
                            return Err(format!(
                                "Failed to commit seedSql savepoint for DB '{}': {e}",
                                cfg.name
                            ));
                        }
                    }
                }
            }
            if let Some(seed_json) = &cfg.seed_json {
                let payload = match seed_json {
                    Value::String(s) => {
                        let norm = normalize_vfs_key(s);
                        vfs.get(&norm)
                            .map(|b| String::from_utf8_lossy(b).into_owned())
                            .unwrap_or_else(|| s.clone())
                    }
                    other => other.to_string(),
                };
                if !payload.trim().is_empty() {
                    let _ = apply_seed_json(&conn, &payload, None)?;
                }
            }
            let _ = fs::write(&marker, b"1");
        }
        Ok(())
    }
}

struct SavepointFlagReset<'a>(&'a AtomicBool);

impl Drop for SavepointFlagReset<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
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
    if hex.len() % 2 != 0 {
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
        ValueRef::Blob(b) => json!({ "hex": encode_hex(b) }),
    }
}

fn classify_sqlite_error(msg: &str) -> Value {
    let lower = msg.to_ascii_lowercase();
    let unique = lower.contains("unique constraint failed") || lower.contains("primary key constraint failed");
    let constraint = unique
        || lower.contains("not null constraint failed")
        || lower.contains("foreign key constraint failed")
        || lower.contains("check constraint failed");
    let code = if unique { 2067 } else if constraint { 19 } else { 1 };
    json!({ "error": msg, "code": code, "unique": unique })
}

fn sanitize_ident(name: &str) -> Result<String, String> {
    if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err(format!("Invalid SQL identifier in seedJson: {name:?}"));
    }
    Ok(format!("\"{name}\""))
}

fn reserved_sqlite_objects(conn: &Connection) -> HashSet<String> {
    let mut set = HashSet::new();
    for (prefix, catalog) in [("main", "sqlite_master"), ("temp", "sqlite_temp_master")] {
        let q = format!("SELECT name FROM {catalog} WHERE name LIKE '\\_%' ESCAPE '\\'");
        if let Ok(mut stmt) = conn.prepare(&q) {
            if let Ok(rows) = stmt.query_map([], |r| r.get::<_, String>(0)) {
                for name in rows.flatten() {
                    set.insert(format!("{prefix}:{name}"));
                }
            }
        }
    }
    set
}

struct SqlKeywordAnalysis {
    may_mutate_schema: bool,
    has_rename: bool,
    has_tx_control: bool,
}

/// Tokenize SQL outside comments and quoted literals/identifiers so keyword
/// checks never false-positive on column/table names (e.g. `end_time`, `pending`),
/// string literals, `CASE ... END`, or `CREATE TRIGGER ... BEGIN ... END`.
fn analyze_sql_keywords(sql: &str) -> SqlKeywordAnalysis {
    let bytes = sql.as_bytes();
    let mut i = 0usize;
    let mut may_mutate_schema = false;
    let mut has_rename = false;
    let mut has_tx_control = false;
    let mut at_stmt_start = true;
    let mut stmt_is_create = false;
    let mut in_trigger_header = false;
    let mut trigger_depth = 0usize;
    let mut case_depth = 0usize;

    while i < bytes.len() {
        let b = bytes[i];
        if b == b'\'' {
            at_stmt_start = false;
            i += 1;
            while i < bytes.len() {
                if bytes[i] == b'\'' {
                    if i + 1 < bytes.len() && bytes[i + 1] == b'\'' {
                        i += 2;
                        continue;
                    }
                    i += 1;
                    break;
                }
                i += 1;
            }
            continue;
        }
        if b == b'"' || b == b'`' {
            let q = b;
            at_stmt_start = false;
            i += 1;
            while i < bytes.len() {
                if bytes[i] == q {
                    if i + 1 < bytes.len() && bytes[i + 1] == q {
                        i += 2;
                        continue;
                    }
                    i += 1;
                    break;
                }
                i += 1;
            }
            continue;
        }
        if b == b'[' {
            at_stmt_start = false;
            i += 1;
            while i < bytes.len() && bytes[i] != b']' {
                i += 1;
            }
            if i < bytes.len() {
                i += 1;
            }
            continue;
        }
        if b == b'-' && i + 1 < bytes.len() && bytes[i + 1] == b'-' {
            i += 2;
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        if b == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'*' {
            i += 2;
            while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                i += 1;
            }
            i = (i + 2).min(bytes.len());
            continue;
        }
        if b == b';' {
            at_stmt_start = true;
            stmt_is_create = false;
            if trigger_depth == 0 {
                in_trigger_header = false;
            }
            i += 1;
            continue;
        }
        if b.is_ascii_alphabetic() || b == b'_' {
            let start = i;
            i += 1;
            while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_') {
                i += 1;
            }
            let kw = std::str::from_utf8(&bytes[start..i]).unwrap_or("").to_ascii_lowercase();
            let keep_create_flag = matches!(kw.as_str(), "create" | "temp" | "temporary");
            match kw.as_str() {
                "alter" => may_mutate_schema = true,
                "create" => {
                    may_mutate_schema = true;
                    if at_stmt_start {
                        stmt_is_create = true;
                    }
                }
                "trigger" if stmt_is_create => {
                    in_trigger_header = true;
                }
                "rename" => {
                    may_mutate_schema = true;
                    has_rename = true;
                }
                "savepoint" | "release" | "commit" | "rollback" => {
                    has_tx_control = true;
                }
                "case" => {
                    case_depth += 1;
                }
                "begin" => {
                    if in_trigger_header {
                        in_trigger_header = false;
                        trigger_depth += 1;
                    } else if at_stmt_start && trigger_depth == 0 {
                        has_tx_control = true;
                    }
                }
                "end" => {
                    if case_depth > 0 {
                        case_depth -= 1;
                    } else if trigger_depth > 0 {
                        trigger_depth -= 1;
                    } else if at_stmt_start {
                        has_tx_control = true;
                    }
                }
                _ => {}
            }
            if !keep_create_flag {
                stmt_is_create = false;
            }
            at_stmt_start = false;
            continue;
        }
        if !b.is_ascii_whitespace() {
            at_stmt_start = false;
        }
        i += 1;
    }

    SqlKeywordAnalysis {
        may_mutate_schema,
        has_rename,
        has_tx_control,
    }
}

fn has_multiple_statements(sql: &str) -> bool {
    let bytes = sql.as_bytes();
    let mut i = 0;
    let mut in_single = false;
    let mut in_double = false;
    let mut saw_semi = false;
    while i < bytes.len() {
        let b = bytes[i];
        if in_single {
            if b == b'\'' {
                if i + 1 < bytes.len() && bytes[i + 1] == b'\'' {
                    i += 2;
                    continue;
                }
                in_single = false;
            }
            i += 1;
            continue;
        }
        if in_double {
            if b == b'"' {
                if i + 1 < bytes.len() && bytes[i + 1] == b'"' {
                    i += 2;
                    continue;
                }
                in_double = false;
            }
            i += 1;
            continue;
        }
        if b == b'-' && i + 1 < bytes.len() && bytes[i + 1] == b'-' {
            i += 2;
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        if b == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'*' {
            i += 2;
            while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                i += 1;
            }
            i = (i + 2).min(bytes.len());
            continue;
        }
        if b == b'\'' {
            in_single = true;
            if saw_semi {
                return true;
            }
        } else if b == b'"' {
            in_double = true;
            if saw_semi {
                return true;
            }
        } else if b == b';' {
            saw_semi = true;
        } else if !b.is_ascii_whitespace() && saw_semi {
            return true;
        }
        i += 1;
    }
    false
}

fn apply_seed_json(
    conn: &Connection,
    payload: &str,
    abort: Option<&AtomicBool>,
) -> Result<Value, String> {
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
            if abort.is_some_and(|a| a.load(Ordering::Relaxed)) {
                return Err("seedJson aborted: request deadline exceeded".into());
            }
            if table_name.starts_with('_') {
                return Err("seedJson cannot target host-reserved _-prefixed table".into());
            }
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
                .map_err(|e| format!("seedJson INSERT prepare failed: {e}"))?;
            tables_seeded += 1;
            for row in rows {
                if abort.is_some_and(|a| a.load(Ordering::Relaxed)) {
                    return Err("seedJson aborted: request deadline exceeded".into());
                }
                let Some(obj) = row.as_object() else {
                    continue;
                };
                let vals: Vec<SqlValue> = col_names
                    .iter()
                    .map(|c| obj.get(c).map(json_to_sql_value).unwrap_or(SqlValue::Null))
                    .collect();
                let n = stmt
                    .execute(params_from_iter(vals))
                    .map_err(|e| format!("seedJson INSERT failed: {e}"))?;
                rows_inserted += n;
                statements += 1;
            }
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

struct RequestSqlBridge {
    config: SqlStorageConfig,
    handles: HashMap<u64, (Connection, Arc<AtomicBool>)>,
    next_id: u64,
    abort: Arc<AtomicBool>,
}

impl RequestSqlBridge {
    fn new(config: SqlStorageConfig, abort: Arc<AtomicBool>) -> Self {
        Self {
            config,
            handles: HashMap::new(),
            next_id: 1,
            abort,
        }
    }

    fn count_db_files(&self) -> usize {
        let Ok(entries) = fs::read_dir(&self.config.db_dir) else {
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

    fn is_sidecar_name(raw: &str) -> bool {
        let (key, _) = SqlStorageConfig::normalize_db_key(raw);
        let lower = key.to_ascii_lowercase();
        lower.ends_with("-wal")
            || lower.ends_with("-shm")
            || lower.ends_with("-journal")
            || lower.ends_with(".softn_seeded")
    }

    fn call(&mut self, kind: &str, args: &[String]) -> String {
        if self.abort.load(Ordering::Relaxed) {
            return json!({ "error": "Request timed out", "code": 9, "unique": false }).to_string();
        }
        let op = kind.strip_prefix("app.sql.").unwrap_or(kind);
        let arg = |idx: usize| args.get(idx).map(String::as_str).unwrap_or("");
        match op {
            "open" => {
                if self.handles.len() >= MAX_OPEN_DB_HANDLES {
                    return json!({ "error": format!("open SQLite handle limit exceeded (max {MAX_OPEN_DB_HANDLES})"), "code": 18, "unique": false }).to_string();
                }
                if Self::is_sidecar_name(arg(0)) {
                    return json!({ "error": "cannot open SQLite sidecar file directly", "code": 1, "unique": false }).to_string();
                }
                let _fs_guard = self.config.db_fs_lock.lock().unwrap_or_else(|e| e.into_inner());
                match self.config.resolve_db_path(arg(0)) {
                    Ok(path) => {
                        if let Some(ref p) = path {
                            if !p.exists() && self.count_db_files() >= MAX_CONTAINER_DATABASES {
                                return json!({ "error": format!("database file limit exceeded (max {MAX_CONTAINER_DATABASES})"), "code": 18, "unique": false }).to_string();
                            }
                        }
                        match SqlStorageConfig::open_configured_connection(path.as_deref()) {
                            Ok((mut conn, in_host_savepoint)) => {
                                let abort = self.abort.clone();
                                let _ = conn.progress_handler(
                                    1000,
                                    Some(move || abort.load(Ordering::Relaxed)),
                                );
                                let id = self.next_id;
                                self.next_id += 1;
                                self.handles.insert(id, (conn, in_host_savepoint));
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
                let Some((conn, in_host_savepoint)) = self.handles.get(&id) else {
                    return json!({ "error": format!("invalid sqlite connection handle {id}"), "code": 21, "unique": false }).to_string();
                };
                match Self::run_execute(conn, in_host_savepoint, sql, params_raw) {
                    Ok(v) => v.to_string(),
                    Err(e) => classify_sqlite_error(&e).to_string(),
                }
            }
            "query" => {
                let id = arg(0).parse::<u64>().unwrap_or(0);
                let sql = arg(1);
                let params_raw = arg(2).trim();
                let Some((conn, _)) = self.handles.get(&id) else {
                    return json!({ "error": format!("invalid sqlite connection handle {id}"), "code": 21, "unique": false }).to_string();
                };
                match Self::run_query(conn, sql, params_raw) {
                    Ok(v) => v.to_string(),
                    Err(e) => classify_sqlite_error(&e).to_string(),
                }
            }
            "seed_json" => {
                let id = arg(0).parse::<u64>().unwrap_or(0);
                let payload = arg(1);
                let Some((conn, _)) = self.handles.get(&id) else {
                    return json!({ "error": format!("invalid sqlite connection handle {id}"), "code": 21, "unique": false }).to_string();
                };
                match apply_seed_json(conn, payload, Some(&self.abort)) {
                    Ok(v) => v.to_string(),
                    Err(e) => classify_sqlite_error(&e).to_string(),
                }
            }
            "copy" => {
                let from = arg(0);
                let to = arg(1);
                if Self::is_sidecar_name(to) {
                    return json!({ "error": "cannot copy to SQLite sidecar file", "code": 1, "unique": false }).to_string();
                }
                let _fs_guard = self.config.db_fs_lock.lock().unwrap_or_else(|e| e.into_inner());
                match (self.config.resolve_db_path(from), self.config.resolve_exact_db_path(to)) {
                    (Ok(Some(src)), Ok(Some(dst))) => {
                        if self.config.is_configured_db_path(&dst) {
                            return json!({ "error": "cannot overwrite configured primary database", "code": 1, "unique": false }).to_string();
                        }
                        if !dst.exists() && self.count_db_files() >= MAX_CONTAINER_DATABASES {
                            return json!({ "error": format!("database file limit exceeded (max {MAX_CONTAINER_DATABASES})"), "code": 18, "unique": false }).to_string();
                        }
                        if !src.exists() {
                            return json!({ "error": "source database does not exist", "code": 14, "unique": false }).to_string();
                        }
                        if src == dst {
                            let bytes = fs::metadata(&src).map(|m| m.len()).unwrap_or(0);
                            return json!({ "bytes": bytes }).to_string();
                        }
                        // Flush WAL journal on source DB before copying (never create missing src).
                        if let Ok(ckpt) = Connection::open_with_flags(&src, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE) {
                            let _ = ckpt.execute_batch("PRAGMA busy_timeout=3000; PRAGMA wal_checkpoint(TRUNCATE);");
                        }
                        match fs::copy(&src, &dst) {
                            Ok(bytes) => {
                                let dst_str = dst.to_string_lossy();
                                for suffix in ["-wal", "-shm", "-journal"] {
                                    let _ = fs::remove_file(format!("{dst_str}{suffix}"));
                                }
                                json!({ "bytes": bytes }).to_string()
                            }
                            Err(e) => classify_sqlite_error(&e.to_string()).to_string(),
                        }
                    }
                    _ => json!({ "error": "cannot copy in-memory database", "code": 1, "unique": false }).to_string(),
                }
            }
            "remove" => {
                let target = arg(0);
                let (key, in_memory) = SqlStorageConfig::normalize_db_key(target);
                if in_memory {
                    return json!({ "ok": true, "removed": false }).to_string();
                }
                let lower_key = key.to_ascii_lowercase();
                if lower_key.ends_with("-wal")
                    || lower_key.ends_with("-shm")
                    || lower_key.ends_with("-journal")
                    || lower_key.ends_with(".softn_seeded")
                {
                    return json!({ "ok": true, "removed": true }).to_string();
                }
                let _fs_guard = self.config.db_fs_lock.lock().unwrap_or_else(|e| e.into_inner());
                match self.config.resolve_exact_db_path(target) {
                    Ok(Some(path)) => {
                        if self.config.is_configured_db_path(&path) {
                            return json!({ "error": "cannot remove configured primary database", "code": 1, "unique": false }).to_string();
                        }
                        let removed = if path.exists() {
                            fs::remove_file(&path).is_ok()
                        } else {
                            false
                        };
                        let p_str = path.to_string_lossy();
                        for suffix in ["-wal", "-shm", "-journal"] {
                            let _ = fs::remove_file(format!("{p_str}{suffix}"));
                        }
                        json!({ "ok": true, "removed": removed }).to_string()
                    }
                    _ => json!({ "ok": true, "removed": false }).to_string(),
                }
            }
            "close" => {
                let id = arg(0).parse::<u64>().unwrap_or(0);
                self.handles.remove(&id);
                json!({ "ok": true }).to_string()
            }
            other => json!({ "error": format!("unknown sql operation: {other}"), "code": 1, "unique": false }).to_string(),
        }
    }

    fn bind_params(stmt: &mut rusqlite::Statement<'_>, params_raw: &str) -> Result<usize, String> {
        if params_raw.is_empty() || params_raw == "[]" || params_raw == "{}" || params_raw == "null" {
            return Ok(0);
        }
        let parsed: Value = serde_json::from_str(params_raw)
            .map_err(|e| format!("Invalid SQL parameters JSON: {e}"))?;
        match parsed {
            Value::Array(items) => {
                for (i, item) in items.iter().enumerate() {
                    let sql_val = json_to_sql_value(item);
                    stmt.raw_bind_parameter(i + 1, sql_val)
                        .map_err(|e| format!("SQL bind error at index {}: {e}", i + 1))?;
                }
                Ok(items.len())
            }
            Value::Object(map) => {
                let mut bound = 0usize;
                for (k, v) in &map {
                    let sql_val = json_to_sql_value(v);
                    let candidates = if k.starts_with(':') || k.starts_with('@') || k.starts_with('$') {
                        vec![k.clone()]
                    } else {
                        vec![format!(":{k}"), format!("@{k}"), format!("${k}"), k.clone()]
                    };
                    for name in candidates {
                        if let Ok(Some(idx)) = stmt.parameter_index(&name) {
                            stmt.raw_bind_parameter(idx, sql_val.clone())
                                .map_err(|e| format!("SQL bind error for {name}: {e}"))?;
                            bound += 1;
                            break;
                        }
                    }
                }
                Ok(bound)
            }
            _ => Err("SQL parameters must be a JSON array or object".into()),
        }
    }

    fn run_execute(
        conn: &Connection,
        in_host_savepoint: &AtomicBool,
        sql: &str,
        params_raw: &str,
    ) -> Result<Value, String> {
        static DDL_SP_SEQ: AtomicU64 = AtomicU64::new(1);
        let analysis = analyze_sql_keywords(sql);
        let may_mutate_schema = analysis.may_mutate_schema;
        let no_params = params_raw.is_empty() || params_raw == "[]" || params_raw == "{}" || params_raw == "null";
        let is_multi = no_params && has_multiple_statements(sql);
        if may_mutate_schema && is_multi && analysis.has_tx_control {
            return Err("Cannot mix transaction/savepoint control with multi-statement DDL".into());
        }
        let reserved_before = if may_mutate_schema {
            Some(reserved_sqlite_objects(conn))
        } else {
            None
        };
        let sp_name = format!("softn_ddl_{}", DDL_SP_SEQ.fetch_add(1, Ordering::Relaxed));
        let use_sp = may_mutate_schema && conn.execute_batch(&format!("SAVEPOINT {sp_name}")).is_ok();

        let exec_res: Result<Value, String> = {
            let _sp_guard = if use_sp {
                in_host_savepoint.store(true, Ordering::Release);
                Some(SavepointFlagReset(in_host_savepoint))
            } else {
                None
            };
            if is_multi {
                conn.execute_batch(sql)
                    .map_err(|e| e.to_string())
                    .map(|()| {
                        json!({
                            "rows_affected": conn.changes(),
                            "last_insert_rowid": conn.last_insert_rowid(),
                        })
                    })
            } else {
                match conn.prepare(sql) {
                    Ok(mut stmt) => match Self::bind_params(&mut stmt, params_raw) {
                        Ok(_) => stmt.raw_execute().map_err(|e| e.to_string()).map(|rows_affected| {
                            json!({
                                "rows_affected": rows_affected,
                                "last_insert_rowid": conn.last_insert_rowid(),
                            })
                        }),
                        Err(e) => Err(e),
                    },
                    Err(e) => Err(e.to_string()),
                }
            }
        };

        if let Some(before) = reserved_before {
            let created_reserved = exec_res.is_ok()
                && reserved_sqlite_objects(conn)
                    .iter()
                    .any(|n| !before.contains(n));
            if created_reserved {
                if use_sp {
                    let _ = conn.execute_batch(&format!("ROLLBACK TO {sp_name}; RELEASE {sp_name}"));
                }
                return Err(
                    "Creating or renaming a table into the host-reserved underscore-prefixed namespace is not allowed"
                        .into(),
                );
            }
        }
        if use_sp {
            if exec_res.is_ok() {
                if conn.execute_batch(&format!("RELEASE {sp_name}")).is_err() {
                    let _ = conn.execute_batch(&format!("ROLLBACK TO {sp_name}; RELEASE {sp_name}"));
                    return Err("SQLite DDL savepoint integrity check failed".into());
                }
            } else {
                let _ = conn.execute_batch(&format!("ROLLBACK TO {sp_name}; RELEASE {sp_name}"));
            }
        }
        exec_res
    }

    fn run_query(conn: &Connection, sql: &str, params_raw: &str) -> Result<Value, String> {
        let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
        if !stmt.readonly() {
            return Err("SQLite query() only permits read-only statements; use execute() for writes/DDL".into());
        }
        let columns: Vec<String> = stmt.column_names().map(str::to_owned).collect();
        Self::bind_params(&mut stmt, params_raw)?;
        let mut rows = stmt.raw_query();
        let mut out_rows: Vec<Value> = Vec::new();
        let mut approx_bytes = 2usize;

        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            if out_rows.len() >= MAX_SQL_RESULT_ROWS {
                return Err(format!("SQL query exceeded max row limit ({MAX_SQL_RESULT_ROWS})"));
            }
            let mut arr = Vec::with_capacity(columns.len());
            for i in 0..columns.len() {
                let vref = row.get_ref(i).map_err(|e| e.to_string())?;
                if let ValueRef::Text(t) = vref {
                    approx_bytes += t.len();
                } else if let ValueRef::Blob(b) = vref {
                    approx_bytes += b.len() * 2;
                } else {
                    approx_bytes += 16;
                }
                if approx_bytes > MAX_SQL_RESULT_BYTES {
                    return Err("SQL query result exceeded host byte limit".into());
                }
                arr.push(sql_ref_to_json(vref));
            }
            out_rows.push(Value::Array(arr));
        }
        Ok(json!({
            "columns": columns,
            "rows": out_rows,
        }))
    }
}

// ── Bundle VFS loading & PHP Overlay persistence ──

fn load_bundle_vfs(bundle_path: &Path) -> Result<HashMap<String, Vec<u8>>, String> {
    let mut vfs = HashMap::new();
    let mut total_bytes = 0usize;
    let canonical_root = fs::canonicalize(bundle_path)
        .map_err(|e| format!("Invalid bundle directory: {e}"))?;

    fn walk(
        root: &Path,
        dir: &Path,
        vfs: &mut HashMap<String, Vec<u8>>,
        total_bytes: &mut usize,
    ) -> Result<(), String> {
        let entries = fs::read_dir(dir).map_err(|e| format!("Failed to read bundle dir: {e}"))?;
        for entry in entries {
            let entry = entry.map_err(|e| format!("Failed to read dir entry: {e}"))?;
            let path = entry.path();
            let meta = fs::symlink_metadata(&path)
                .map_err(|e| format!("Failed to stat {}: {e}", path.display()))?;
            if meta.file_type().is_symlink() {
                continue;
            }
            if meta.is_dir() {
                walk(root, &path, vfs, total_bytes)?;
            } else if meta.is_file() {
                if vfs.len() >= MAX_VFS_FILES {
                    return Err(format!("Bundle exceeds max VFS file limit ({MAX_VFS_FILES})"));
                }
                let rel = path
                    .strip_prefix(root)
                    .map_err(|_| "Bundle file escaped root")?;
                let key = normalize_vfs_key(&rel.to_string_lossy());
                if key.is_empty() {
                    continue;
                }
                let bytes = fs::read(&path)
                    .map_err(|e| format!("Failed to read bundle file {key}: {e}"))?;
                *total_bytes = total_bytes.saturating_add(bytes.len());
                if *total_bytes > MAX_VFS_TOTAL_BYTES {
                    return Err("Bundle exceeds max VFS byte limit".into());
                }
                vfs.insert(key, bytes);
            }
        }
        Ok(())
    }

    walk(&canonical_root, &canonical_root, &mut vfs, &mut total_bytes)?;
    Ok(vfs)
}

fn is_protected_php_overlay_path(key: &str, backend_entry: &str) -> bool {
    let norm = normalize_vfs_key(key);
    if norm.is_empty() || norm.contains('\0') {
        return true;
    }
    let lower = norm.to_ascii_lowercase();
    let base = lower.rsplit('/').next().unwrap_or("");
    if base == ".htaccess"
        || base == ".htpasswd"
        || base == ".env"
        || base.starts_with(".env.")
        || base == "manifest.json"
        || base == "permission.json"
        || base == "seed.json"
    {
        return true;
    }
    for ext in [
        ".php", ".phtml", ".php5", ".php7", ".php8", ".pht", ".phps", ".inc", ".phar", ".tpl",
        ".sql", ".ini", ".db", ".db-wal", ".db-shm", ".db-journal", ".sqlite", ".sqlite-wal",
        ".sqlite-shm", ".sqlite-journal", ".sqlite3", ".sqlite3-wal", ".sqlite3-shm",
        ".sqlite3-journal",
    ] {
        if lower.ends_with(ext) {
            return true;
        }
    }
    let entry_lower = normalize_vfs_key(backend_entry).to_ascii_lowercase();
    !entry_lower.is_empty() && lower == entry_lower
}

fn clone_php_overlay(src: &PhpVfsOverlay) -> PhpVfsOverlay {
    PhpVfsOverlay {
        writes: src.writes.clone(),
        deleted: src.deleted.clone(),
        dirs: src.dirs.clone(),
        total_bytes: src.total_bytes,
    }
}

fn sanitize_php_overlay(ov: &mut PhpVfsOverlay, backend_entry: &str) {
    strip_protected_php_overlay_paths(ov, backend_entry);
    let mut total = 0usize;
    let mut keys: Vec<String> = ov.writes.keys().cloned().collect();
    keys.sort();
    for k in keys {
        let len = ov.writes.get(&k).map(Vec::len).unwrap_or(0);
        if total.saturating_add(len) <= MAX_OVERLAY_BYTES {
            total += len;
        } else {
            ov.writes.remove(&k);
        }
    }
    ov.total_bytes = total;
}

/// Normalizes the overlay's paths and drops the ones a request may never write. It applies no
/// size cap: what a request's overlay lacks is taken as deleted by that request, so trimming
/// it to fit here would delete stored files the request never touched.
fn strip_protected_php_overlay_paths(ov: &mut PhpVfsOverlay, backend_entry: &str) {
    ov.writes = ov
        .writes
        .drain()
        .map(|(k, bytes)| (normalize_vfs_key(&k), bytes))
        .filter(|(k, _)| !is_protected_php_overlay_path(k, backend_entry))
        .collect();
    ov.total_bytes = ov.writes.values().map(Vec::len).sum();
    ov.deleted = ov
        .deleted
        .drain()
        .map(|k| normalize_vfs_key(&k))
        .filter(|k| !is_protected_php_overlay_path(k, backend_entry))
        .collect();
    ov.dirs = ov
        .dirs
        .drain()
        .map(|k| normalize_vfs_key(&k))
        .filter(|k| !is_protected_php_overlay_path(k, backend_entry))
        .collect();
}

/// What a request changed in its copy of the overlay, against the overlay it started from:
/// all a merge needs of either. It is worked out before the store's lock is taken, so that
/// the request can let go of what it started from first (`merge_and_save_php_overlay`).
struct PhpOverlayChanges {
    /// Files it started with and no longer has.
    removed: Vec<String>,
    /// Paths it marked deleted, and marks it took off.
    deleted: Vec<String>,
    undeleted: Vec<String>,
    /// Files it wrote or changed, with their bytes.
    written: Vec<(String, Vec<u8>)>,
    dirs_added: Vec<String>,
    dirs_removed: Vec<String>,
}

impl PhpOverlayChanges {
    fn between(initial: &PhpVfsOverlay, mut final_req: PhpVfsOverlay) -> Self {
        let removed = initial.writes.keys().filter(|k| !final_req.writes.contains_key(*k)).cloned().collect();
        let deleted = final_req.deleted.iter().filter(|d| !initial.deleted.contains(*d)).cloned().collect();
        let undeleted = initial
            .deleted
            .iter()
            .filter(|d| !final_req.deleted.contains(*d) && !final_req.writes.contains_key(*d))
            .cloned()
            .collect();
        let dirs_added = final_req.dirs.iter().filter(|d| !initial.dirs.contains(*d)).cloned().collect();
        let dirs_removed = initial.dirs.iter().filter(|d| !final_req.dirs.contains(*d)).cloned().collect();
        let written = final_req.writes.drain().filter(|(k, v)| initial.writes.get(k) != Some(v)).collect();
        PhpOverlayChanges { removed, deleted, undeleted, written, dirs_added, dirs_removed }
    }

    /// Onto the stored overlay, which other requests may have changed since this one began.
    /// Deletions first to reclaim quota, then only the new and updated writes that fit
    /// within MAX_OVERLAY_BYTES, so incoming writes can never evict existing files.
    fn apply(self, shared: &mut PhpVfsOverlay) {
        for k in &self.removed {
            if let Some(old) = shared.writes.remove(k) {
                shared.total_bytes = shared.total_bytes.saturating_sub(old.len());
            }
        }
        for d in self.deleted {
            if let Some(old) = shared.writes.remove(&d) {
                shared.total_bytes = shared.total_bytes.saturating_sub(old.len());
            }
            shared.deleted.insert(d);
        }
        for d in &self.undeleted {
            shared.deleted.remove(d);
        }
        for (k, v) in self.written {
            let old_len = shared.writes.get(&k).map(Vec::len).unwrap_or(0);
            let next_total = shared
                .total_bytes
                .saturating_sub(old_len)
                .saturating_add(v.len());
            if next_total <= MAX_OVERLAY_BYTES {
                shared.deleted.remove(&k);
                shared.writes.insert(k, v);
                shared.total_bytes = next_total;
            }
        }
        for d in self.dirs_added {
            shared.dirs.insert(d);
        }
        for d in &self.dirs_removed {
            shared.dirs.remove(d);
        }
    }
}

fn merge_and_save_php_overlay(
    path: &Path,
    shared_overlay: &Mutex<Arc<PhpVfsOverlay>>,
    initial: Arc<PhpVfsOverlay>,
    mut final_req: PhpVfsOverlay,
    backend_entry: &str,
    last_saved: &Mutex<Vec<u8>>,
) {
    // Only the protected paths come out of the request's overlay here. Whether a write fits is
    // decided per file below, against what is stored: capping this copy first dropped the
    // files that sort last, and the merge then deleted them from the store as if the request
    // had. The Node runner evicts nothing either (it skips a save that would not fit).
    strip_protected_php_overlay_paths(&mut final_req, backend_entry);
    // Fast path: if this request made no sanitized overlay changes, skip locking/encoding/disk I/O.
    if final_req.writes == initial.writes
        && final_req.deleted == initial.deleted
        && final_req.dirs == initial.dirs
    {
        return;
    }
    let changes = PhpOverlayChanges::between(&initial, final_req);
    // The request lets go of the overlay it started from before the store is touched. That
    // is the stored overlay itself, and while the request held it the store could not be
    // changed in place (`Arc::get_mut` below never succeeded): every request that wrote
    // anything copied all of it, up to 16 MiB, with the lock held.
    drop(initial);
    let Ok(mut shared_guard) = shared_overlay.lock() else {
        return;
    };
    // In place when no request in flight is reading this overlay. A copy when one is: that
    // request keeps what it started from, and the store goes on to the copy.
    let mut owned_copy: Option<PhpVfsOverlay> = None;
    let shared: &mut PhpVfsOverlay = match Arc::get_mut(&mut *shared_guard) {
        Some(ov) => ov,
        None => {
            owned_copy = Some(clone_php_overlay(&*shared_guard));
            owned_copy.as_mut().unwrap()
        }
    };
    changes.apply(shared);
    sanitize_php_overlay(shared, backend_entry);
    save_php_overlay(path, shared, backend_entry, last_saved);
    if let Some(updated) = owned_copy {
        *shared_guard = Arc::new(updated);
    }
}

fn load_php_overlay(path: &Path, backend_entry: &str) -> PhpVfsOverlay {
    if reject_symlink(path).is_err() {
        return PhpVfsOverlay::default();
    }
    let Ok(text) = fs::read_to_string(path) else {
        return PhpVfsOverlay::default();
    };
    let Ok(val) = serde_json::from_str::<Value>(&text) else {
        return PhpVfsOverlay::default();
    };
    let mut ov = PhpVfsOverlay::default();
    if let Some(writes) = val.get("writes").and_then(|v| v.as_object()) {
        for (k, v) in writes {
            let norm = normalize_vfs_key(k);
            if is_protected_php_overlay_path(&norm, backend_entry) {
                continue;
            }
            if let Some(b64) = v.as_str() {
                if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(b64) {
                    if ov.total_bytes.saturating_add(bytes.len()) <= MAX_OVERLAY_BYTES {
                        ov.total_bytes += bytes.len();
                        ov.writes.insert(norm, bytes);
                    }
                }
            }
        }
    }
    if let Some(deleted) = val.get("deleted").and_then(|v| v.as_array()) {
        for item in deleted {
            if let Some(s) = item.as_str() {
                let norm = normalize_vfs_key(s);
                if !is_protected_php_overlay_path(&norm, backend_entry) {
                    ov.deleted.insert(norm);
                }
            }
        }
    }
    if let Some(dirs) = val.get("dirs").and_then(|v| v.as_array()) {
        for item in dirs {
            if let Some(s) = item.as_str() {
                ov.dirs.insert(normalize_vfs_key(s));
            }
        }
    }
    ov
}

fn save_php_overlay(
    path: &Path,
    overlay: &mut PhpVfsOverlay,
    backend_entry: &str,
    last_saved: &Mutex<Vec<u8>>,
) {
    sanitize_php_overlay(overlay, backend_entry);
    if overlay.writes.is_empty() && overlay.deleted.is_empty() && overlay.dirs.is_empty() {
        if let Ok(mut prev) = last_saved.lock() {
            if !prev.is_empty() || path.exists() {
                let _ = fs::remove_file(path);
                prev.clear();
            }
        }
        return;
    }
    let mut keys: Vec<&String> = overlay.writes.keys().collect();
    keys.sort();
    let mut writes = serde_json::Map::new();
    for k in keys {
        if let Some(bytes) = overlay.writes.get(k) {
            writes.insert(
                k.clone(),
                Value::String(base64::engine::general_purpose::STANDARD.encode(bytes)),
            );
        }
    }
    let mut deleted: Vec<&String> = overlay.deleted.iter().collect();
    deleted.sort();
    let mut dirs: Vec<&String> = overlay.dirs.iter().collect();
    dirs.sort();
    let payload = json!({
        "writes": writes,
        "deleted": deleted,
        "dirs": dirs,
    });
    if let Ok(bytes) = serde_json::to_vec(&payload) {
        if let Ok(mut prev) = last_saved.lock() {
            if *prev == bytes {
                return;
            }
            let tmp = path.with_extension("json.tmp");
            if fs::write(&tmp, &bytes).is_ok() && fs::rename(&tmp, path).is_ok() {
                *prev = bytes;
            }
        }
    }
}

// ── Per-request ZIPP `safe-sandbox` execution helpers ──

fn harden_script_state(st: &mut ScriptState, steps: u64, abort: Arc<AtomicBool>) {
    st.set_limits(steps, Some(abort));
    st.set_heap_limit(VM_HEAP_LIMIT);
    st.set_output_limit(VM_OUTPUT_LIMIT);
    st.set_dynamic_code_limits(256 * 1024, 1024 * 1024, 64, 512, 256);
    st.disable_vm_jit();
}

fn parse_cookie_header(raw: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for part in raw.split(';') {
        if let Some((k, v)) = part.split_once('=') {
            let key = k.trim();
            if !key.is_empty() {
                out.insert(key.to_owned(), v.trim().to_owned());
            }
        }
    }
    out
}

fn parse_url_encoded(raw: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for part in raw.split('&') {
        if part.is_empty() {
            continue;
        }
        let (k, v) = part.split_once('=').unwrap_or((part, ""));
        out.insert(percent_decode(k), percent_decode(v));
    }
    out
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'+' {
            out.push(b' ');
            i += 1;
        } else if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(hex) = std::str::from_utf8(&bytes[i + 1..i + 3]) {
                if let Ok(byte) = u8::from_str_radix(hex, 16) {
                    out.push(byte);
                    i += 3;
                    continue;
                }
            }
            out.push(bytes[i]);
            i += 1;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn parse_headers_json(val: &Value) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let push_pair = |out: &mut Vec<(String, String)>, k: &str, v: &str| {
        if out.len() >= MAX_RESPONSE_HEADERS {
            return;
        }
        if k.is_empty() || k.len() > 256 || v.len() > MAX_RESPONSE_HEADER_BYTES {
            return;
        }
        if k.bytes().any(|b| b <= 0x20 || b == 0x7f || b == b':')
            || v.bytes().any(|b| b == b'\r' || b == b'\n' || b == 0)
        {
            return;
        }
        out.push((k.to_owned(), v.to_owned()));
    };
    if let Some(arr) = val.as_array() {
        for item in arr {
            if out.len() >= MAX_RESPONSE_HEADERS {
                break;
            }
            if let Some(pair) = item.as_array() {
                if pair.len() >= 2 {
                    if let (Some(k), Some(v)) = (pair[0].as_str(), pair[1].as_str()) {
                        push_pair(&mut out, k, v);
                    }
                }
            }
        }
    } else if let Some(obj) = val.as_object() {
        for (k, v) in obj {
            if out.len() >= MAX_RESPONSE_HEADERS {
                break;
            }
            if let Some(s) = v.as_str() {
                push_pair(&mut out, k, s);
            }
        }
    }
    out
}

fn clamp_response_body(body: Vec<u8>) -> Result<Vec<u8>, ContainerHttpResponse> {
    if body.len() > MAX_RESPONSE_BODY_BYTES {
        return Err(ContainerHttpResponse {
            status: 502,
            headers: vec![("Content-Type".into(), "text/plain; charset=utf-8".into())],
            body: b"Backend response exceeded maximum allowed size".to_vec(),
        });
    }
    Ok(body)
}

#[allow(clippy::too_many_arguments)]
fn execute_php_request(
    req: &ContainerHttpRequest,
    backend: &ContainerBackendConfig,
    vfs: &Arc<HashMap<String, Vec<u8>>>,
    vfs_dirs: &HashSet<String>,
    overlay: &Arc<Mutex<PhpVfsOverlay>>,
    htaccess_map: &HashMap<String, ParsedHtaccess>,
    private_dir_prefixes: &[String],
    sql_cfg: &SqlStorageConfig,
    abort: Arc<AtomicBool>,
) -> ContainerHttpResponse {
    let mut lower_headers: HashMap<String, String> = HashMap::new();
    for (k, v) in &req.headers {
        let lk = k.to_ascii_lowercase();
        let sep = if lk == "cookie" { "; " } else { ", " };
        lower_headers
            .entry(lk)
            .and_modify(|existing| {
                existing.push_str(sep);
                existing.push_str(v);
            })
            .or_insert_with(|| v.clone());
    }
    let original_uri = if req.query.is_empty() {
        req.path.clone()
    } else {
        format!("{}?{}", req.path, req.query)
    };

    let mut target_path = if req.path.starts_with('/') {
        req.path.clone()
    } else {
        format!("/{}", req.path)
    };
    let mut target_query = req.query.clone();

    if !req.htaccess_evaluated && !htaccess_map.is_empty() {
        match evaluate_htaccess_chain(
            htaccess_map,
            &target_path,
            &target_query,
            &req.method,
            &req.host,
            req.https,
            &lower_headers,
            vfs,
            vfs_dirs,
        ) {
            HtaccessEval::Deny(status) => {
                return ContainerHttpResponse {
                    status,
                    headers: vec![("Content-Type".into(), "text/plain; charset=utf-8".into())],
                    body: b"Forbidden".to_vec(),
                };
            }
            HtaccessEval::Redirect(status, location) => {
                return ContainerHttpResponse {
                    status,
                    headers: vec![
                        ("Location".into(), location),
                        ("Content-Type".into(), "text/plain; charset=utf-8".into()),
                    ],
                    body: Vec::new(),
                };
            }
            HtaccessEval::Rewrite { pathname, query } => {
                target_path = pathname;
                target_query = query;
            }
        }
    }

    let rel = normalize_vfs_key(&target_path);
    let rel_lower = rel.to_ascii_lowercase();
    let entry_key = normalize_vfs_key(&backend.entry);
    let entry_lower = entry_key.to_ascii_lowercase();
    let is_private_dir = rel_lower != entry_lower
        && (rel_lower.starts_with("server/")
            || rel_lower.starts_with("backend/")
            || rel_lower.starts_with("private/")
            || rel_lower.starts_with("db/")
            || rel_lower.starts_with("database/")
            || rel_lower.starts_with("migrations/")
            || rel_lower.split('/').any(|seg| seg.starts_with('.'))
            || private_dir_prefixes.iter().any(|p| rel_lower.starts_with(p)));
    let script_key: Option<String> = if !rel.is_empty()
        && !is_private_dir
        && vfs.contains_key(&rel)
        && (rel.ends_with(".php") || rel.ends_with(".phtml"))
    {
        Some(rel.clone())
    } else if !rel.is_empty() && !is_private_dir && vfs.contains_key(&format!("{rel}.php")) {
        Some(format!("{rel}.php"))
    } else if vfs.contains_key(&entry_key) {
        Some(entry_key.clone())
    } else {
        None
    };

    let Some(script_key) = script_key else {
        return ContainerHttpResponse {
            status: 404,
            headers: vec![("Content-Type".into(), "text/plain; charset=utf-8".into())],
            body: format!("404 Not Found: {target_path}").into_bytes(),
        };
    };

    // Re-evaluate `.htaccess` access rules against the resolved script path (e.g., `/config` -> `/config.php`)
    // so `<FilesMatch>` / `RewriteRule [F]` rules cannot be bypassed via extensionless PHP resolution.
    let resolved_script_path = format!("/{script_key}");
    if !htaccess_map.is_empty() && resolved_script_path != target_path {
        if let HtaccessEval::Deny(status) = evaluate_htaccess_chain(
            htaccess_map,
            &resolved_script_path,
            &target_query,
            &req.method,
            &req.host,
            req.https,
            &lower_headers,
            vfs,
            vfs_dirs,
        ) {
            return ContainerHttpResponse {
                status,
                headers: vec![("Content-Type".into(), "text/plain; charset=utf-8".into())],
                body: b"Forbidden".to_vec(),
            };
        }
    }

    let entry_source = match vfs.get(&script_key) {
        Some(bytes) => String::from_utf8_lossy(bytes).into_owned(),
        None => {
            return ContainerHttpResponse {
                status: 500,
                headers: vec![("Content-Type".into(), "text/plain; charset=utf-8".into())],
                body: b"PHP entry script missing from bundle".to_vec(),
            };
        }
    };

    let content_type = lower_headers
        .get("content-type")
        .cloned()
        .unwrap_or_default();
    let body_text = String::from_utf8_lossy(&req.body).into_owned();
    let cookies = lower_headers
        .get("cookie")
        .map(|s| parse_cookie_header(s))
        .unwrap_or_default();
    let post = if content_type
        .to_ascii_lowercase()
        .contains("application/x-www-form-urlencoded")
    {
        Some(parse_url_encoded(&body_text))
    } else {
        None
    };

    let mut server = serde_json::Map::new();
    server.insert("REQUEST_METHOD".into(), json!(req.method.to_ascii_uppercase()));
    server.insert("REQUEST_URI".into(), json!(original_uri));
    server.insert("QUERY_STRING".into(), json!(target_query));
    server.insert("SCRIPT_NAME".into(), json!(format!("/{script_key}")));
    server.insert("PHP_SELF".into(), json!(format!("/{script_key}")));
    server.insert("SCRIPT_FILENAME".into(), json!(format!("/{script_key}")));
    server.insert("DOCUMENT_ROOT".into(), json!("/"));
    server.insert("SERVER_PROTOCOL".into(), json!("HTTP/1.1"));
    server.insert("SERVER_NAME".into(), json!(req.host));
    server.insert("HTTP_HOST".into(), json!(req.host));
    server.insert("SERVER_PORT".into(), json!(if req.https { "443" } else { "80" }));
    server.insert("HTTPS".into(), json!(if req.https { "on" } else { "off" }));
    server.insert("REQUEST_SCHEME".into(), json!(if req.https { "https" } else { "http" }));
    server.insert("REMOTE_ADDR".into(), json!(req.client_ip));
    server.insert("CONTENT_TYPE".into(), json!(content_type));
    server.insert("CONTENT_LENGTH".into(), json!(req.body.len().to_string()));
    for (k, v) in &lower_headers {
        if k == "host" {
            // Preserve trusted-proxy-derived `req.host` already set in SERVER_NAME and HTTP_HOST.
            continue;
        }
        let php_key = format!("HTTP_{}", k.to_ascii_uppercase().replace('-', "_"));
        server.insert(php_key, json!(v));
    }

    let mut sapi_obj = json!({
        "sapi": "zipp-server",
        "server": server,
        "query": target_query,
        "cookies": cookies,
        "contentType": content_type,
        "body": body_text,
    });
    if let Some(p) = post {
        sapi_obj["post"] = json!(p);
    }

    let req_base_dir = match script_key.rsplit_once('/') {
        Some((parent, _)) if !parent.is_empty() => format!("/{parent}"),
        _ => "/".to_owned(),
    };
    let env_pairs: Vec<(String, String)> = backend
        .env
        .as_ref()
        .map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
        .unwrap_or_default();

    let config = PhpProgramConfig {
        file: format!("/{script_key}"),
        base_dir: req_base_dir,
        argv: Vec::new(),
        env: env_pairs,
        sapi_request_json: Some(sapi_obj.to_string()),
        vfs: None,
        vfs_arc: Some(Arc::clone(vfs)),
        vfs_overlay: Some(Arc::clone(overlay)),
        allow_native_fs: false,
        stream_stdout: false,
    };

    let mut st = match compile_php_program(&entry_source, config) {
        Ok(compiled) => compiled.into_state(),
        Err(err) => {
            tracing::error!("ZIPP PHP compile error: {err}");
            return ContainerHttpResponse {
                status: 500,
                headers: vec![("Content-Type".into(), "text/plain; charset=utf-8".into())],
                body: b"Internal backend error".to_vec(),
            };
        }
    };

    harden_script_state(&mut st, REQUEST_STEP_BUDGET, abort.clone());
    let mut sql_bridge = RequestSqlBridge::new(sql_cfg.clone(), abort);
    st.set_host_call(Box::new(move |kind, args| Ok(sql_bridge.call(kind, args))));

    let init_res = st.run_init();
    let resource_err = st.resource_limit_error().map(|s| s.to_owned());
    let raw_bytes = st.take_php_output();

    let take_resp_slot = st
        .symbols()
        .into_iter()
        .find(|s| s.name == "__zipp_php_take_response")
        .map(|s| s.index);

    let mut meta_json =
        r#"{"status":200,"headers":[["Content-Type","text/html; charset=UTF-8"]],"body":""}"#
            .to_owned();
    if resource_err.is_none() {
        if let Some(slot) = take_resp_slot {
            let mut budget = HostValueBudget::new(65_536, 16 * 1024 * 1024);
            if let Ok(HostValue::String(s)) = st.call_slot_bounded(slot, &[], &mut budget) {
                meta_json = s;
            }
        }
    }

    if let Some(err) = resource_err {
        tracing::warn!("ZIPP PHP sandbox limit triggered: {err}");
        return ContainerHttpResponse {
            status: 503,
            headers: vec![("Content-Type".into(), "text/plain; charset=utf-8".into())],
            body: b"Sandbox limit exceeded".to_vec(),
        };
    }
    if let Err(err) = init_res {
        tracing::error!("ZIPP PHP runtime error: {err}");
        let err_body = if raw_bytes.is_empty() {
            b"Internal backend error".to_vec()
        } else {
            match clamp_response_body(raw_bytes) {
                Ok(b) => b,
                Err(resp) => return resp,
            }
        };
        return ContainerHttpResponse {
            status: 500,
            headers: vec![("Content-Type".into(), "text/plain; charset=utf-8".into())],
            body: err_body,
        };
    }

    let meta: Value = serde_json::from_str(&meta_json).unwrap_or_else(|_| json!({ "status": 200 }));
    let status = meta
        .get("status")
        .and_then(|v| v.as_u64())
        .and_then(|n| u16::try_from(n).ok())
        .filter(|c| (200..600).contains(c))
        .unwrap_or(200);
    let mut headers = meta
        .get("headers")
        .map(parse_headers_json)
        .unwrap_or_default();
    if !headers.iter().any(|(k, _)| k.eq_ignore_ascii_case("content-type")) {
        headers.push(("Content-Type".into(), "text/html; charset=UTF-8".into()));
    }
    let body = if !raw_bytes.is_empty() {
        raw_bytes
    } else {
        meta.get("body")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .as_bytes()
            .to_vec()
    };
    let body = match clamp_response_body(body) {
        Ok(b) => b,
        Err(resp) => return resp,
    };

    ContainerHttpResponse {
        status,
        headers,
        body,
    }
}

fn execute_script_backend_request(
    kind: BackendRuntimeKind,
    req: &ContainerHttpRequest,
    source: &str,
    sql_cfg: &SqlStorageConfig,
    abort: Arc<AtomicBool>,
) -> ContainerHttpResponse {
    let (full_source, frontend, dispatch_fn) = match kind {
        BackendRuntimeKind::JavaScript => (
            format!("{JS_BACKEND_PRELUDE}\n{source}"),
            Frontend::JavaScript {
                goal: ScriptGoal::Pure,
            },
            "__softnBackendDispatch",
        ),
        BackendRuntimeKind::TypeScript => (
            format!("{JS_BACKEND_PRELUDE}\n{source}"),
            Frontend::TypeScript,
            "__softnBackendDispatch",
        ),
        BackendRuntimeKind::Python => (
            format!("{PYTHON_BACKEND_PRELUDE}\n{source}"),
            Frontend::Python {
                mode: PythonMode::Module,
            },
            "__softn_backend_dispatch",
        ),
        _ => unreachable!(),
    };

    let mut st = match compile_source(&full_source, frontend) {
        Ok(compiled) => compiled.into_state(),
        Err(err) => {
            tracing::error!("ZIPP {} backend compile error: {err}", kind.as_str());
            return ContainerHttpResponse {
                status: 500,
                headers: vec![("Content-Type".into(), "text/plain; charset=utf-8".into())],
                body: b"Internal backend error".to_vec(),
            };
        }
    };

    harden_script_state(&mut st, REQUEST_STEP_BUDGET, abort.clone());
    let mut sql_bridge = RequestSqlBridge::new(sql_cfg.clone(), abort);
    st.set_host_call(Box::new(move |k, args| Ok(sql_bridge.call(k, args))));

    if let Err(err) = st.run_init() {
        let limit = st.resource_limit_error().map(|s| s.to_owned());
        tracing::error!("ZIPP {} backend init error: {}", kind.as_str(), limit.as_deref().unwrap_or(&err));
        return ContainerHttpResponse {
            status: if limit.is_some() { 503 } else { 500 },
            headers: vec![("Content-Type".into(), "text/plain; charset=utf-8".into())],
            body: if limit.is_some() {
                b"Sandbox limit exceeded".to_vec()
            } else {
                b"Internal backend error".to_vec()
            },
        };
    }

    if kind == BackendRuntimeKind::Python {
        if let Err(err) = st.eval_in_context(PYTHON_SQLITE_BRIDGE_JS) {
            tracing::error!("Python SQLite bridge init error: {err}");
            return ContainerHttpResponse {
                status: 500,
                headers: vec![("Content-Type".into(), "text/plain; charset=utf-8".into())],
                body: b"Internal backend error".to_vec(),
            };
        }
    }

    let mut headers_obj = serde_json::Map::new();
    for (k, v) in &req.headers {
        let lower = k.to_ascii_lowercase();
        let sep = if lower == "cookie" { "; " } else { ", " };
        match headers_obj.get_mut(&lower) {
            Some(Value::String(existing)) => {
                existing.push_str(sep);
                existing.push_str(v);
            }
            _ => {
                headers_obj.insert(lower, Value::String(v.clone()));
            }
        }
    }
    let req_json = json!({
        "method": req.method.to_ascii_uppercase(),
        "path": req.path,
        "query": req.query,
        "headers": headers_obj,
        "body": String::from_utf8_lossy(&req.body),
    })
    .to_string();

    let raw_resp = if kind == BackendRuntimeKind::Python {
        let Some(py_call_slot) = st
            .symbols()
            .into_iter()
            .find(|s| s.name == "__zipp_py_call")
            .map(|s| s.index)
        else {
            return ContainerHttpResponse {
                status: 500,
                headers: vec![("Content-Type".into(), "text/plain; charset=utf-8".into())],
                body: b"Python runtime missing __zipp_py_call hook".to_vec(),
            };
        };
        let mut budget = HostValueBudget::new(65_536, 16 * 1024 * 1024);
        let res = st.call_slot_bounded(
            py_call_slot,
            &[
                HostValue::String(dispatch_fn.to_owned()),
                HostValue::Array(vec![HostValue::String(req_json)]),
            ],
            &mut budget,
        );
        if let Some(limit) = st.resource_limit_error() {
            tracing::warn!("Python backend sandbox limit triggered: {limit}");
            return ContainerHttpResponse {
                status: 503,
                headers: vec![("Content-Type".into(), "text/plain; charset=utf-8".into())],
                body: b"Sandbox limit exceeded".to_vec(),
            };
        }
        match res {
            Ok(HostValue::String(s)) => s,
            Ok(_) => {
                return ContainerHttpResponse {
                    status: 500,
                    headers: vec![("Content-Type".into(), "text/plain; charset=utf-8".into())],
                    body: b"Internal backend error".to_vec(),
                };
            }
            Err(err) => {
                tracing::error!("Python backend error: {err:?}");
                return ContainerHttpResponse {
                    status: 500,
                    headers: vec![("Content-Type".into(), "text/plain; charset=utf-8".into())],
                    body: b"Internal backend error".to_vec(),
                };
            }
        }
    } else {
        let Some(dispatch_slot) = st
            .symbols()
            .into_iter()
            .find(|s| s.name == dispatch_fn)
            .map(|s| s.index)
        else {
            return ContainerHttpResponse {
                status: 500,
                headers: vec![("Content-Type".into(), "text/plain; charset=utf-8".into())],
                body: b"Script backend missing dispatch hook".to_vec(),
            };
        };
        let mut budget = HostValueBudget::new(65_536, 16 * 1024 * 1024);
        let call_res = st.call_slot_bounded(
            dispatch_slot,
            &[HostValue::String(req_json)],
            &mut budget,
        );
        if let Some(limit) = st.resource_limit_error() {
            tracing::warn!("Script backend sandbox limit triggered: {limit}");
            return ContainerHttpResponse {
                status: 503,
                headers: vec![("Content-Type".into(), "text/plain; charset=utf-8".into())],
                body: b"Sandbox limit exceeded".to_vec(),
            };
        }
        match call_res {
            Ok(HostValue::String(s)) => s,
            Ok(_) => {
                return ContainerHttpResponse {
                    status: 500,
                    headers: vec![("Content-Type".into(), "text/plain; charset=utf-8".into())],
                    body: b"Internal backend error".to_vec(),
                };
            }
            Err(err) => {
                tracing::error!("Script backend error: {err:?}");
                return ContainerHttpResponse {
                    status: 500,
                    headers: vec![("Content-Type".into(), "text/plain; charset=utf-8".into())],
                    body: b"Internal backend error".to_vec(),
                };
            }
        }
    };

    let parsed: Value = serde_json::from_str(&raw_resp).unwrap_or_else(|_| json!({ "status": 500, "body": raw_resp }));
    let status = parsed
        .get("status")
        .and_then(|v| v.as_u64())
        .and_then(|n| u16::try_from(n).ok())
        .filter(|c| (200..600).contains(c))
        .unwrap_or(200);
    let headers = parsed
        .get("headers")
        .map(parse_headers_json)
        .unwrap_or_else(|| vec![("Content-Type".into(), "application/json; charset=utf-8".into())]);
    let body = parsed
        .get("body")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .as_bytes()
        .to_vec();
    let body = match clamp_response_body(body) {
        Ok(b) => b,
        Err(resp) => return resp,
    };

    ContainerHttpResponse {
        status,
        headers,
        body,
    }
}

struct WarmRustWorker {
    state: ScriptState,
    dispatch_slot: u32,
    sql_bridge: Arc<Mutex<RequestSqlBridge>>,
}

impl WarmRustWorker {
    fn boot(
        backend: &ContainerBackendConfig,
        vfs: &HashMap<String, Vec<u8>>,
        sql_cfg: &SqlStorageConfig,
        abort: Arc<AtomicBool>,
    ) -> Result<Self, String> {
        let root_prefix = backend
            .root
            .as_deref()
            .map(normalize_vfs_key)
            .unwrap_or_default();
        let entry_full = normalize_vfs_key(&backend.entry);
        let rel_entry = if !root_prefix.is_empty() {
            entry_full
                .strip_prefix(&format!("{root_prefix}/"))
                .unwrap_or(&entry_full)
                .to_owned()
        } else {
            entry_full.clone()
        };

        let mut rust_vfs = HashMap::new();
        let strip_prefix = if root_prefix.is_empty() {
            String::new()
        } else {
            format!("{root_prefix}/")
        };
        for (k, v) in vfs {
            let lower = k.to_ascii_lowercase();
            if lower.ends_with(".db") || lower.ends_with(".sqlite") || lower.ends_with(".sqlite3") {
                continue;
            }
            if !strip_prefix.is_empty() {
                if let Some(stripped) = k.strip_prefix(&strip_prefix) {
                    rust_vfs.insert(stripped.to_owned(), v.clone());
                } else if lower == "manifest.json" {
                    rust_vfs.insert(k.clone(), v.clone());
                }
                continue;
            }
            rust_vfs.insert(k.clone(), v.clone());
        }

        let entry_source = rust_vfs
            .get(&rel_entry)
            .map(|b| String::from_utf8_lossy(b).into_owned())
            .ok_or_else(|| format!("Rust backend entry '{rel_entry}' not found in bundle"))?;

        let base_dir = match rel_entry.rsplit_once('/') {
            Some((parent, _)) if !parent.is_empty() => parent.to_owned(),
            _ => ".".to_owned(),
        };
        let env_pairs: Vec<(String, String)> = backend
            .env
            .as_ref()
            .map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
            .unwrap_or_default();

        let config = RustProgramConfig {
            file: rel_entry,
            base_dir,
            argv: Vec::new(),
            env: env_pairs,
            vfs: Some(rust_vfs),
            // Keep VFS read-only in multi-user warm workers so one user's request cannot
            // mutate in-memory files seen by another user on the same worker.
            allow_vfs_write: false,
            allow_native_fs: false,
            allow_net: false,
            stream_stdout: false,
            mode: "worker_boot".to_owned(),
        };
        let mut st = compile_rust_program(&entry_source, config)?.into_state();
        harden_script_state(&mut st, BOOT_STEP_BUDGET, abort.clone());
        let sql_bridge = Arc::new(Mutex::new(RequestSqlBridge::new(sql_cfg.clone(), abort)));
        let bridge_for_vm = Arc::clone(&sql_bridge);
        st.set_host_call(Box::new(move |kind, args| {
            let mut guard = bridge_for_vm
                .lock()
                .map_err(|_| "SQL bridge lock poisoned".to_owned())?;
            Ok(guard.call(kind, args))
        }));
        st.run_init()?;
        if let Ok(mut guard) = sql_bridge.lock() {
            guard.handles.clear();
        }

        let dispatch_slot = st
            .symbols()
            .into_iter()
            .find(|s| s.name == "__zipp_rs_worker_request")
            .map(|s| s.index)
            .ok_or_else(|| "Rust worker did not register __zipp_rs_worker_request".to_owned())?;

        Ok(Self {
            state: st,
            dispatch_slot,
            sql_bridge,
        })
    }

    /// Dispatch a request on the warm worker, returning `(response, needs_rebuild)`.
    /// Whenever a resource limit, internal VM error, or poisoned SQL bridge lock occurs,
    /// `needs_rebuild = true` instructs the worker thread to tear down and re-boot cleanly.
    fn dispatch(&mut self, req: &ContainerHttpRequest, abort: Arc<AtomicBool>) -> (ContainerHttpResponse, bool) {
        match self.sql_bridge.lock() {
            Ok(mut guard) => {
                guard.abort = Arc::clone(&abort);
                guard.handles.clear();
            }
            Err(_) => {
                return (
                    ContainerHttpResponse {
                        status: 500,
                        headers: vec![("Content-Type".into(), "text/plain; charset=utf-8".into())],
                        body: b"Internal backend error".to_vec(),
                    },
                    true,
                );
            }
        }
        harden_script_state(&mut self.state, REQUEST_STEP_BUDGET, abort);
        let uri = if req.query.is_empty() {
            req.path.clone()
        } else {
            format!("{}?{}", req.path, req.query)
        };
        let mut headers_obj = serde_json::Map::new();
        for (k, v) in &req.headers {
            let lower = k.to_ascii_lowercase();
            let sep = if lower == "cookie" { "; " } else { ", " };
            match headers_obj.get_mut(&lower) {
                Some(Value::String(existing)) => {
                    existing.push_str(sep);
                    existing.push_str(v);
                }
                _ => {
                    headers_obj.insert(lower, Value::String(v.clone()));
                }
            }
        }
        let req_json = json!({
            "method": req.method.to_ascii_uppercase(),
            "uri": uri,
            "headers": headers_obj,
            "body": String::from_utf8_lossy(&req.body),
        })
        .to_string();

        let mut budget = HostValueBudget::new(65_536, 16 * 1024 * 1024);
        let res = self.state.call_slot_bounded(
            self.dispatch_slot,
            &[HostValue::String(req_json)],
            &mut budget,
        );
        let poisoned = match self.sql_bridge.lock() {
            Ok(mut guard) => {
                guard.handles.clear();
                false
            }
            Err(_) => true,
        };
        if let Some(limit) = self.state.resource_limit_error() {
            tracing::warn!("Rust worker sandbox limit triggered: {limit}");
            return (
                ContainerHttpResponse {
                    status: 503,
                    headers: vec![("Content-Type".into(), "text/plain; charset=utf-8".into())],
                    body: b"Sandbox limit exceeded".to_vec(),
                },
                true,
            );
        }
        let raw = match res {
            Ok(HostValue::String(s)) => s,
            Ok(_) => {
                return (
                    ContainerHttpResponse {
                        status: 500,
                        headers: vec![("Content-Type".into(), "text/plain; charset=utf-8".into())],
                        body: b"Internal backend error".to_vec(),
                    },
                    true,
                );
            }
            Err(err) => {
                tracing::error!("Rust backend error: {err:?}");
                return (
                    ContainerHttpResponse {
                        status: 500,
                        headers: vec![("Content-Type".into(), "text/plain; charset=utf-8".into())],
                        body: b"Internal backend error".to_vec(),
                    },
                    true,
                );
            }
        };
        let parsed: Value = serde_json::from_str(&raw).unwrap_or_else(|_| json!({ "status": 500, "body": raw }));
        let status = parsed
            .get("status")
            .and_then(|v| v.as_u64())
            .and_then(|n| u16::try_from(n).ok())
            .filter(|c| (200..600).contains(c))
            .unwrap_or(200);
        let headers = parsed
            .get("headers")
            .map(parse_headers_json)
            .unwrap_or_default();
        let body = parsed
            .get("body")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .as_bytes()
            .to_vec();
        let body = match clamp_response_body(body) {
            Ok(b) => b,
            Err(resp) => return (resp, poisoned),
        };
        (
            ContainerHttpResponse {
                status,
                headers,
                body,
            },
            poisoned,
        )
    }
}

// ── Public Multi-User Container Backend Runtime ──

#[derive(Clone)]
pub struct CachedStaticAsset {
    pub mime: &'static str,
    pub bytes: Bytes,
    pub etag: String,
    pub immutable: bool,
}

fn compute_etag(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut hex = String::with_capacity(18);
    hex.push('"');
    for b in &digest[..8] {
        use std::fmt::Write;
        let _ = write!(&mut hex, "{b:02x}");
    }
    hex.push('"');
    hex
}

fn is_fingerprinted_asset_path(rel: &str) -> bool {
    let file_name = rel.rsplit('/').next().unwrap_or(rel);
    let Some((stem, ext)) = file_name.rsplit_once('.') else {
        return false;
    };
    let ext_lower = ext.to_ascii_lowercase();
    if !matches!(
        ext_lower.as_str(),
        "js" | "mjs" | "css" | "wasm" | "woff2" | "woff" | "ttf" | "otf" | "png" | "jpg" | "jpeg"
            | "webp" | "avif" | "gif" | "svg" | "ico"
    ) {
        return false;
    }
    // Match Vite/Webpack/esbuild content hashes (`app-Ab12Cd34.js`, `chunk.a1b2c3d4.css`)
    if let Some((_, suffix)) = stem.rsplit_once(['-', '.']) {
        if suffix.len() >= 8
            && suffix.len() <= 32
            && suffix.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
            && suffix.bytes().any(|b| b.is_ascii_digit())
            && suffix.bytes().any(|b| b.is_ascii_alphabetic())
        {
            return true;
        }
    }
    false
}

pub enum StaticOrBackend {
    Static {
        mime: &'static str,
        bytes: Bytes,
        etag: String,
        immutable: bool,
    },
    Deny(u16),
    Redirect(u16, String),
    NotFound,
    Backend { path: String, query: String },
}

pub struct ContainerBackendRuntime {
    #[allow(dead_code)]
    pub runtime_kind: BackendRuntimeKind,
    pub mode: String,
    pub routes: Vec<String>,
    pub frontend_root: Option<String>,
    pub main_file: Option<String>,
    pub ssr_entry: bool,
    private_exact_paths: HashSet<String>,
    private_dir_prefixes: Vec<String>,
    vfs: Arc<HashMap<String, Vec<u8>>>,
    static_assets: HashMap<String, CachedStaticAsset>,
    vfs_dirs: Arc<HashSet<String>>,
    htaccess_map: Arc<HashMap<String, ParsedHtaccess>>,
    tx: crossbeam_channel::Sender<WorkerJob>,
    stop_watchdog: Arc<AtomicBool>,
}

impl ContainerBackendRuntime {
    pub fn load(
        manifest: &ServerManifest,
        bundle_path: &Path,
        data_dir: &Path,
        workers: Option<usize>,
    ) -> Result<Option<Arc<Self>>, String> {
        let Some(backend) = &manifest.backend else {
            return Ok(None);
        };
        let runtime_kind = BackendRuntimeKind::parse(&backend.runtime)?;
        let vfs = Arc::new(load_bundle_vfs(bundle_path)?);
        let vfs_dirs = Arc::new(build_vfs_dir_index(&vfs));
        let entry_key = normalize_vfs_key(&backend.entry);
        if !vfs.contains_key(&entry_key) {
            return Err(format!(
                "Container backend entry '{}' not found in bundle",
                backend.entry
            ));
        }

        let frontend_root = manifest
            .frontend_root
            .as_deref()
            .map(normalize_vfs_key)
            .filter(|s| !s.is_empty());

        // Dynamically mark declared backend entry/root (and parent directory of backend.entry
        // when non-root and distinct from frontendRoot) and database files as private so
        // non-standard paths (e.g. `api/auth.js` or `custom_data.bin`) are never served statically.
        let mut private_exact_paths = HashSet::new();
        let mut private_dir_prefixes = Vec::new();
        let fe_lower = frontend_root.as_deref().unwrap_or("").to_ascii_lowercase();
        if !entry_key.is_empty() {
            let entry_lower = entry_key.to_ascii_lowercase();
            private_exact_paths.insert(entry_lower.clone());
            if backend.root.is_none() {
                if let Some((parent, _)) = entry_lower.rsplit_once('/') {
                    if !parent.is_empty()
                        && parent != fe_lower
                        && !matches!(parent, "public" | "assets" | "static" | "js" | "css")
                    {
                        let pref = format!("{parent}/");
                        if !private_dir_prefixes.contains(&pref) {
                            private_dir_prefixes.push(pref);
                        }
                    }
                }
            }
        }
        if let Some(ref raw_root) = backend.root {
            let norm_root = normalize_vfs_key(raw_root).to_ascii_lowercase();
            if !norm_root.is_empty() && norm_root != fe_lower {
                private_exact_paths.insert(norm_root.clone());
                let pref = format!("{norm_root}/");
                if !private_dir_prefixes.contains(&pref) {
                    private_dir_prefixes.push(pref);
                }
            }
        }
        if let Some(ref dbs) = manifest.databases {
            for db in dbs {
                if let Some(ref f) = db.file {
                    let nf = normalize_vfs_key(f).to_ascii_lowercase();
                    if !nf.is_empty() {
                        private_exact_paths.insert(nf);
                    }
                }
                if let Some(ref s) = db.seed_sql {
                    let ns = normalize_vfs_key(s).to_ascii_lowercase();
                    if !ns.is_empty() {
                        private_exact_paths.insert(ns);
                    }
                }
                if let Some(Value::String(ref s)) = db.seed_json {
                    let ns = normalize_vfs_key(s).to_ascii_lowercase();
                    if !ns.is_empty() {
                        private_exact_paths.insert(ns);
                    }
                }
            }
        }

        let sql_cfg = SqlStorageConfig {
            db_dir: data_dir.join("databases"),
            databases: manifest.databases.clone().unwrap_or_default(),
            db_fs_lock: Arc::new(Mutex::new(())),
        };
        sql_cfg.preseed_all(&vfs)?;

        // Parse any `.htaccess` files in the bundle
        let mut htaccess_map = HashMap::new();
        for (path, bytes) in vfs.iter() {
            if path == ".htaccess" || path.ends_with("/.htaccess") {
                let prefix = if path == ".htaccess" {
                    ""
                } else {
                    &path[..path.len() - "/.htaccess".len()]
                };
                htaccess_map.insert(prefix.to_owned(), parse_htaccess_file(bytes, prefix));
            }
        }
        let htaccess_arc = Arc::new(htaccess_map);

        let overlay_path = data_dir.join("php-overlay.json");
        let php_overlay = Arc::new(Mutex::new(Arc::new(load_php_overlay(&overlay_path, &entry_key))));
        let last_saved_overlay = Arc::new(Mutex::new(
            fs::read(&overlay_path).unwrap_or_default(),
        ));

        let mode = backend
            .mode
            .clone()
            .unwrap_or_else(|| if runtime_kind == BackendRuntimeKind::Php { "ssr".into() } else { "api".into() });
        let routes = backend
            .routes
            .clone()
            .filter(|r| !r.is_empty())
            .unwrap_or_else(|| {
                if mode == "ssr" {
                    vec!["/".into()]
                } else {
                    vec!["/api/".into(), "/ws".into()]
                }
            });

        let worker_count = workers
            .unwrap_or_else(|| {
                std::thread::available_parallelism()
                    .map(|n| n.get().clamp(2, 8))
                    .unwrap_or(4)
            })
            .clamp(1, 32);

        let (tx, rx) = crossbeam_channel::bounded::<WorkerJob>(worker_count * 16);
        let watches: Arc<Mutex<Vec<WorkerWatch>>> = Arc::new(Mutex::new(Vec::new()));
        let stop_watchdog = Arc::new(AtomicBool::new(false));

        let entry_source_arc = Arc::new(
            String::from_utf8_lossy(vfs.get(&entry_key).unwrap()).into_owned(),
        );
        let private_dir_prefixes_arc = Arc::new(private_dir_prefixes.clone());

        // Spawn the cooperative wall-time watchdog BEFORE booting workers so a slow/infinite
        // Rust `main()` during boot is bounded by WALL_TIME_MS too.
        let watches_bg = Arc::clone(&watches);
        let stop_bg = Arc::clone(&stop_watchdog);
        let _ = thread::Builder::new()
            .name("zipp-container-watchdog".into())
            .spawn(move || {
                while !stop_bg.load(Ordering::Relaxed) {
                    thread::sleep(Duration::from_millis(200));
                    let now = mono_ms();
                    if let Ok(list) = watches_bg.lock() {
                        for w in list.iter() {
                            let dl = w.deadline_ms.load(Ordering::Relaxed);
                            if dl != 0 && now >= dl {
                                w.abort.store(true, Ordering::SeqCst);
                            }
                        }
                    }
                }
            });

        // Pre-validate Rust backend on startup (first worker boots eagerly; fail fast if broken)
        let mut startup_err: Option<String> = None;
        let boot_deadline = Instant::now() + Duration::from_secs(30);
        for idx in 0..worker_count {
            let rx = rx.clone();
            let vfs = Arc::clone(&vfs);
            let vfs_dirs = Arc::clone(&vfs_dirs);
            let backend_cfg = backend.clone();
            let htaccess_arc = Arc::clone(&htaccess_arc);
            let private_dirs_bg = Arc::clone(&private_dir_prefixes_arc);
            let php_overlay = Arc::clone(&php_overlay);
            let last_saved_overlay = Arc::clone(&last_saved_overlay);
            let overlay_path = overlay_path.clone();
            let sql_cfg = sql_cfg.clone();
            let entry_source = Arc::clone(&entry_source_arc);

            let abort = Arc::new(AtomicBool::new(false));
            let deadline_ms = Arc::new(AtomicU64::new(0));
            watches.lock().unwrap().push(WorkerWatch {
                abort: Arc::clone(&abort),
                deadline_ms: Arc::clone(&deadline_ms),
            });

            let global_slot = match crate::runtime::reserve_global_worker_slot() {
                Ok(slot) => slot,
                Err(why) => {
                    if idx == 0 {
                        startup_err = Some(format!("Failed to allocate container backend worker slot: {why}"));
                    }
                    break;
                }
            };
            let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();
            let spawn_res = thread::Builder::new()
                .name(format!("zipp-container-{}-{idx}", runtime_kind.as_str()))
                .stack_size(16 * 1024 * 1024)
                .spawn(move || {
                    let _global_slot = global_slot;
                    let mut rust_worker: Option<WarmRustWorker> = if runtime_kind == BackendRuntimeKind::Rust {
                        abort.store(false, Ordering::SeqCst);
                        deadline_ms.store(mono_ms() + WALL_TIME_MS, Ordering::SeqCst);
                        let booted = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                            WarmRustWorker::boot(&backend_cfg, &vfs, &sql_cfg, Arc::clone(&abort))
                        })) {
                            Ok(res) => res,
                            Err(_) => Err("Rust backend panicked during startup".to_owned()),
                        };
                        deadline_ms.store(0, Ordering::SeqCst);
                        match booted {
                            Ok(w) => {
                                let _ = ready_tx.send(Ok(()));
                                Some(w)
                            }
                            Err(e) => {
                                let _ = ready_tx.send(Err(e));
                                return;
                            }
                        }
                    } else {
                        let _ = ready_tx.send(Ok(()));
                        None
                    };

                    while let Ok(job) = rx.recv() {
                        // Skip requests whose caller already timed out (504) or disconnected so
                        // stale mutations never run or commit after the response was abandoned.
                        if job.reply.is_closed() {
                            continue;
                        }
                        abort.store(false, Ordering::SeqCst);
                        deadline_ms.store(mono_ms() + WALL_TIME_MS, Ordering::SeqCst);

                        let mut rust_needs_rebuild = false;
                        let dispatch_res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                            match runtime_kind {
                                BackendRuntimeKind::Php => {
                                    // Take an O(1) Arc snapshot under the mutex; clone only once for
                                    // the isolated per-request overlay so concurrent requests never
                                    // observe uncommitted or protected writes mid-execution.
                                    let initial_ov = php_overlay
                                        .lock()
                                        .map(|ov| Arc::clone(&ov))
                                        .unwrap_or_else(|_| Arc::new(PhpVfsOverlay::default()));
                                    let req_ov = Arc::new(Mutex::new(clone_php_overlay(&initial_ov)));
                                    let out = execute_php_request(
                                        &job.req,
                                        &backend_cfg,
                                        &vfs,
                                        &vfs_dirs,
                                        &req_ov,
                                        &htaccess_arc,
                                        &private_dirs_bg,
                                        &sql_cfg,
                                        Arc::clone(&abort),
                                    );
                                    if out.status < 500 {
                                        if let Ok(mut guard) = req_ov.lock() {
                                            let final_ov = std::mem::take(&mut *guard);
                                            drop(guard);
                                            merge_and_save_php_overlay(
                                                &overlay_path,
                                                &php_overlay,
                                                initial_ov,
                                                final_ov,
                                                &backend_cfg.entry,
                                                &last_saved_overlay,
                                            );
                                        }
                                    }
                                    out
                                }
                                BackendRuntimeKind::JavaScript
                                | BackendRuntimeKind::TypeScript
                                | BackendRuntimeKind::Python => execute_script_backend_request(
                                    runtime_kind,
                                    &job.req,
                                    &entry_source,
                                    &sql_cfg,
                                    Arc::clone(&abort),
                                ),
                                BackendRuntimeKind::Rust => {
                                    if let Some(w) = rust_worker.as_mut() {
                                        let (resp, rebuild) = w.dispatch(&job.req, Arc::clone(&abort));
                                        rust_needs_rebuild = rebuild;
                                        resp
                                    } else {
                                        rust_needs_rebuild = true;
                                        ContainerHttpResponse {
                                            status: 500,
                                            headers: vec![("Content-Type".into(), "text/plain".into())],
                                            body: b"Rust worker unavailable".to_vec(),
                                        }
                                    }
                                }
                            }
                        }));

                        let resp = match dispatch_res {
                            Ok(r) => r,
                            Err(_) => {
                                if runtime_kind == BackendRuntimeKind::Rust {
                                    rust_needs_rebuild = true;
                                }
                                tracing::error!("Container backend worker recovered from a panic during request dispatch");
                                ContainerHttpResponse {
                                    status: 500,
                                    headers: vec![("Content-Type".into(), "text/plain; charset=utf-8".into())],
                                    body: b"Internal backend error".to_vec(),
                                }
                            }
                        };

                        deadline_ms.store(0, Ordering::SeqCst);
                        let _ = job.reply.send(resp);

                        if runtime_kind == BackendRuntimeKind::Rust && rust_needs_rebuild {
                            rust_worker = None;
                            abort.store(false, Ordering::SeqCst);
                            deadline_ms.store(mono_ms() + WALL_TIME_MS, Ordering::SeqCst);
                            let rebuilt = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                                WarmRustWorker::boot(&backend_cfg, &vfs, &sql_cfg, Arc::clone(&abort))
                            })) {
                                Ok(res) => res,
                                Err(_) => Err("Rust backend panicked during rebuild".to_owned()),
                            };
                            match rebuilt {
                                Ok(w) => {
                                    rust_worker = Some(w);
                                    tracing::info!("Rebuilt warm Rust container worker after error/limit");
                                }
                                Err(e) => {
                                    tracing::error!("Failed to rebuild warm Rust container worker: {e}");
                                }
                            }
                            deadline_ms.store(0, Ordering::SeqCst);
                        }
                    }
                });
            if let Err(e) = spawn_res {
                startup_err = Some(format!("Failed to spawn container backend worker: {e}"));
                break;
            }
            let remaining = boot_deadline.saturating_duration_since(Instant::now());
            match ready_rx.recv_timeout(remaining) {
                Ok(Ok(())) => {}
                Ok(Err(e)) => {
                    startup_err = Some(e);
                    break;
                }
                Err(_) => {
                    startup_err = Some("Container backend worker timed out or exited during startup".into());
                    break;
                }
            }
        }

        if let Some(err) = startup_err {
            if let Ok(list) = watches.lock() {
                for w in list.iter() {
                    w.abort.store(true, Ordering::SeqCst);
                }
            }
            stop_watchdog.store(true, Ordering::Relaxed);
            return Err(err);
        }

        // Precompute zero-copy Bytes, strong ETag, and immutability metadata for all public
        // static frontend files once at bundle load time.
        let mut static_assets = HashMap::new();
        for (path, bytes) in vfs.iter() {
            let lower = normalize_vfs_key(path).to_ascii_lowercase();
            let is_priv = is_private_static_path(path)
                || private_exact_paths.contains(&lower)
                || private_dir_prefixes.iter().any(|p| lower.starts_with(p));
            if !is_priv {
                static_assets.insert(
                    path.clone(),
                    CachedStaticAsset {
                        mime: mime_type_for(path),
                        bytes: Bytes::from(bytes.clone()),
                        etag: compute_etag(bytes),
                        immutable: is_fingerprinted_asset_path(path),
                    },
                );
            }
        }

        tracing::info!(
            "Started ZIPP safe-sandbox container backend (runtime={}, mode={}, workers={}, routes={:?})",
            runtime_kind.as_str(),
            mode,
            worker_count,
            routes
        );

        Ok(Some(Arc::new(Self {
            runtime_kind,
            mode,
            routes,
            frontend_root,
            main_file: manifest.main.as_deref().map(normalize_vfs_key).filter(|s| !s.is_empty()),
            ssr_entry: manifest.ssr_entry.unwrap_or(false),
            private_exact_paths,
            private_dir_prefixes,
            vfs,
            static_assets,
            vfs_dirs,
            htaccess_map: htaccess_arc,
            tx,
            stop_watchdog,
        })))
    }

    fn is_private_path(&self, rel: &str) -> bool {
        if is_private_static_path(rel) {
            return true;
        }
        let lower = normalize_vfs_key(rel).to_ascii_lowercase();
        if self.private_exact_paths.contains(&lower) {
            return true;
        }
        self.private_dir_prefixes
            .iter()
            .any(|prefix| lower.starts_with(prefix))
    }

    /// Resolve a public static asset path inside `frontendRoot` (or bundle root) with zero-copy
    /// `Bytes` and precomputed `ETag`/immutability metadata, refusing private files.
    pub fn resolve_static_asset_cached(&self, req_path: &str) -> Result<Option<CachedStaticAsset>, u16> {
        let rel = normalize_vfs_key(req_path);
        if !rel.is_empty() && self.is_private_path(&rel) {
            return Err(403);
        }

        let mut candidates: Vec<String> = Vec::new();
        if let Some(root) = &self.frontend_root {
            if rel.is_empty() {
                candidates.push(format!("{root}/index.html"));
                if let Some(main) = &self.main_file {
                    if !self.is_private_path(main) {
                        candidates.push(main.clone());
                    }
                }
            } else {
                let prefixed = if rel == *root || rel.starts_with(&format!("{root}/")) {
                    rel.clone()
                } else {
                    format!("{root}/{rel}")
                };
                candidates.push(prefixed);
            }
        } else if rel.is_empty() {
            if let Some(main) = &self.main_file {
                if !self.is_private_path(main) {
                    candidates.push(main.clone());
                }
            }
            candidates.push("index.html".into());
        } else {
            candidates.push(rel.clone());
        }

        let mut seen = HashSet::new();
        for cand in candidates {
            if !seen.insert(cand.clone()) {
                continue;
            }
            if self.is_private_path(&cand) {
                return Err(403);
            }
            if let Some(asset) = self.static_assets.get(&cand) {
                return Ok(Some(asset.clone()));
            }
        }

        // SPA fallback for extensionless routes in `api` mode (when an HTML entry exists)
        if self.mode == "api" && !self.ssr_entry {
            let last_seg = rel.rsplit('/').next().unwrap_or("");
            if !last_seg.contains('.') {
                let fallback = self
                    .main_file
                    .as_deref()
                    .filter(|m| !self.is_private_path(m) && (m.ends_with(".html") || m.ends_with(".htm")))
                    .map(str::to_owned)
                    .or_else(|| {
                        self.frontend_root
                            .as_ref()
                            .map(|r| format!("{r}/index.html"))
                            .filter(|p| self.static_assets.contains_key(p))
                    })
                    .or_else(|| self.static_assets.contains_key("index.html").then(|| "index.html".to_owned()));
                if let Some(html_path) = fallback {
                    if let Some(asset) = self.static_assets.get(&html_path) {
                        let mut spa = asset.clone();
                        spa.mime = "text/html; charset=utf-8";
                        spa.immutable = false;
                        return Ok(Some(spa));
                    }
                }
            }
        }

        Ok(None)
    }

    /// Resolve a public static asset path inside `frontendRoot` (or bundle root), refusing private files.
    pub fn resolve_static_asset(&self, req_path: &str) -> Result<Option<(&'static str, Vec<u8>)>, u16> {
        self.resolve_static_asset_cached(req_path)
            .map(|opt| opt.map(|a| (a.mime, a.bytes.to_vec())))
    }

    /// Single-pass ingress resolver: decodes URL escapes, evaluates `.htaccess` deny/redirect rules
    /// BEFORE static asset serving, and resolves static assets in ONE lookup (avoiding double buffer clones).
    pub fn resolve_ingress(
        &self,
        method: &str,
        raw_path: &str,
        query: &str,
        host: &str,
        https: bool,
        lower_headers: &HashMap<String, String>,
    ) -> StaticOrBackend {
        let pathname = match decode_http_path(raw_path) {
            Ok(p) => p,
            Err(code) => return StaticOrBackend::Deny(code),
        };
        let mut effective_path = pathname;
        let mut effective_query = query.to_owned();
        if !self.htaccess_map.is_empty() {
            match evaluate_htaccess_chain(
                &self.htaccess_map,
                &effective_path,
                &effective_query,
                method,
                host,
                https,
                lower_headers,
                &self.vfs,
                &self.vfs_dirs,
            ) {
                HtaccessEval::Deny(code) => return StaticOrBackend::Deny(code),
                HtaccessEval::Redirect(code, loc) => return StaticOrBackend::Redirect(code, loc),
                HtaccessEval::Rewrite { pathname: next, query: next_q } => {
                    effective_path = next;
                    effective_query = next_q;
                }
            }
        }
        let lower = effective_path.to_ascii_lowercase();
        if lower.starts_with("/server/")
            || lower.starts_with("/backend/")
            || lower.starts_with("/private/")
            || lower == "/server"
            || lower == "/backend"
            || lower == "/private"
        {
            return StaticOrBackend::Deny(403);
        }
        if lower.ends_with(".php") || lower.ends_with(".phtml") {
            return StaticOrBackend::Backend {
                path: effective_path,
                query: effective_query,
            };
        }
        let upper_method = method.to_ascii_uppercase();
        if upper_method != "GET" && upper_method != "HEAD" {
            return StaticOrBackend::Backend {
                path: effective_path,
                query: effective_query,
            };
        }
        for prefix in &self.routes {
            if prefix == "/" || prefix == "/*" {
                let rel = normalize_vfs_key(&effective_path);
                if !rel.is_empty() && !rel.ends_with(".html") && !rel.ends_with(".htm") {
                    return match self.resolve_static_asset_cached(&effective_path) {
                        Ok(Some(asset)) => StaticOrBackend::Static {
                            mime: asset.mime,
                            bytes: asset.bytes,
                            etag: asset.etag,
                            immutable: asset.immutable,
                        },
                        Ok(None) => StaticOrBackend::Backend {
                            path: effective_path,
                            query: effective_query,
                        },
                        Err(code) => StaticOrBackend::Deny(code),
                    };
                }
                return StaticOrBackend::Backend {
                    path: effective_path,
                    query: effective_query,
                };
            }
            let clean = if prefix.starts_with('/') {
                prefix.clone()
            } else {
                format!("/{prefix}")
            };
            let bare = clean.trim_end_matches('/');
            if effective_path == bare
                || effective_path.starts_with(&clean)
                || effective_path.starts_with(&format!("{bare}/"))
            {
                return StaticOrBackend::Backend {
                    path: effective_path,
                    query: effective_query,
                };
            }
        }
        match self.resolve_static_asset_cached(&effective_path) {
            Ok(Some(asset)) => StaticOrBackend::Static {
                mime: asset.mime,
                bytes: asset.bytes,
                etag: asset.etag,
                immutable: asset.immutable,
            },
            Ok(None) => StaticOrBackend::NotFound,
            Err(code) => StaticOrBackend::Deny(code),
        }
    }

    /// Decide whether an HTTP request routes to the ZIPP-sandboxed backend or static frontend assets.
    #[allow(dead_code)]
    pub fn should_route_to_backend(&self, method: &str, req_path: &str) -> bool {
        let norm_rel = normalize_vfs_key(req_path);
        let pathname = if norm_rel.is_empty() {
            "/".to_owned()
        } else {
            format!("/{norm_rel}")
        };
        let lower = pathname.to_ascii_lowercase();
        // Never directly invoke private server/, backend/, or private/ directories via HTTP paths;
        // let resolve_static_asset refuse them with 403 Forbidden.
        if lower.starts_with("/server/")
            || lower.starts_with("/backend/")
            || lower.starts_with("/private/")
            || lower == "/server"
            || lower == "/backend"
            || lower == "/private"
        {
            return false;
        }
        if lower.ends_with(".php") || lower.ends_with(".phtml") {
            return true;
        }
        let upper_method = method.to_ascii_uppercase();
        if upper_method != "GET" && upper_method != "HEAD" {
            return true;
        }
        for prefix in &self.routes {
            if prefix == "/" || prefix == "/*" {
                // In SSR mode, static frontend assets (CSS/JS/SVG/images/fonts) serve directly
                let rel = normalize_vfs_key(&pathname);
                if !rel.is_empty() && !rel.ends_with(".html") && !rel.ends_with(".htm") {
                    if let Ok(Some(_)) = self.resolve_static_asset(&pathname) {
                        return false;
                    }
                }
                return true;
            }
            let clean = if prefix.starts_with('/') {
                prefix.clone()
            } else {
                format!("/{prefix}")
            };
            let bare = clean.trim_end_matches('/');
            if pathname == bare || pathname.starts_with(&clean) || pathname.starts_with(&format!("{bare}/")) {
                return true;
            }
        }
        false
    }

    /// Execute one HTTP request through the multi-user ZIPP `safe-sandbox` worker pool.
    pub async fn dispatch(&self, req: ContainerHttpRequest) -> ContainerHttpResponse {
        let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
        let job = WorkerJob {
            req,
            reply: reply_tx,
        };
        if self.tx.try_send(job).is_err() {
            return ContainerHttpResponse {
                status: 503,
                headers: vec![("Content-Type".into(), "application/json; charset=utf-8".into())],
                body: br#"{"error":"Backend workers are busy; retry shortly"}"#.to_vec(),
            };
        }
        match tokio::time::timeout(Duration::from_millis(WALL_TIME_MS + 5_000), reply_rx).await {
            Ok(Ok(resp)) => resp,
            _ => ContainerHttpResponse {
                status: 504,
                headers: vec![("Content-Type".into(), "application/json; charset=utf-8".into())],
                body: br#"{"error":"Sandboxed backend request timed out"}"#.to_vec(),
            },
        }
    }
}

impl Drop for ContainerBackendRuntime {
    fn drop(&mut self) {
        self.stop_watchdog.store(true, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_file(base: &Path, rel: &str, content: &str) {
        let full = base.join(rel);
        if let Some(parent) = full.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(full, content).unwrap();
    }

    #[tokio::test]
    async fn php_container_backend_runs_sandboxed_with_multiuser_sqlite_persistence() {
        let root = crate::test_dirs::temp_path("softn-container-php", "");
        let bundle = root.join("bundle");
        let data = root.join("data");
        fs::create_dir_all(&bundle).unwrap();
        fs::create_dir_all(&data).unwrap();

        write_file(
            &bundle,
            "manifest.json",
            r#"{
              "id": "com.test.php-notes",
              "name": "PHP Notes",
              "version": "1.0.0",
              "engine": 2,
              "main": "public/index.html",
              "frontendRoot": "public",
              "backend": {
                "runtime": "php",
                "entry": "backend/index.php",
                "mode": "api",
                "routes": ["/api/"]
              },
              "databases": [
                { "name": "notes", "engine": "sqlite", "file": "notes.db", "seedSql": "backend/schema.sql" }
              ]
            }"#,
        );
        write_file(&bundle, "public/index.html", "<!doctype html><h1>PHP Notes</h1>");
        write_file(
            &bundle,
            "backend/schema.sql",
            "CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY AUTOINCREMENT, author TEXT NOT NULL, body TEXT NOT NULL);",
        );
        write_file(
            &bundle,
            "backend/index.php",
            r#"<?php
$pdo = new PDO('sqlite:notes.db');
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$uri = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
header('Content-Type: application/json; charset=utf-8');
if ($uri === '/api/notes' && $method === 'POST') {
    $data = json_decode(file_get_contents('php://input'), true);
    $stmt = $pdo->prepare('INSERT INTO notes (author, body) VALUES (?, ?)');
    $stmt->execute([$data['author'] ?? 'anon', $data['body'] ?? '']);
    http_response_code(201);
    echo json_encode(['id' => (int)$pdo->lastInsertId(), 'ok' => true]);
    exit;
}
if ($uri === '/api/notes' && $method === 'GET') {
    $rows = $pdo->query('SELECT id, author, body FROM notes ORDER BY id ASC')->fetchAll(PDO::FETCH_ASSOC);
    echo json_encode(['notes' => $rows]);
    exit;
}
http_response_code(404);
echo json_encode(['error' => 'Not found']);
"#,
        );

        let manifest = crate::bundle::load_manifest(&bundle).unwrap();
        let rt = ContainerBackendRuntime::load(&manifest, &bundle, &data, Some(2))
            .unwrap()
            .expect("container backend loaded");

        // Static frontend works; backend source & SQL are strictly blocked
        let (mime, html) = rt.resolve_static_asset("/").unwrap().unwrap();
        assert!(mime.starts_with("text/html"));
        assert!(String::from_utf8_lossy(&html).contains("PHP Notes"));
        assert_eq!(rt.resolve_static_asset("/backend/index.php"), Err(403));
        assert_eq!(rt.resolve_static_asset("/backend/schema.sql"), Err(403));
        assert_eq!(rt.resolve_static_asset("/manifest.json"), Err(403));

        // Simulate two concurrent users posting notes into the shared WAL SQLite DB
        let req1 = ContainerHttpRequest {
            method: "POST".into(),
            path: "/api/notes".into(),
            query: String::new(),
            headers: vec![("Content-Type".into(), "application/json".into())],
            body: br#"{"author":"alice","body":"Hello from Alice"}"#.to_vec(),
            client_ip: "127.0.0.1".into(),
            host: "localhost".into(),
            https: false,
            htaccess_evaluated: false,
        };
        let req2 = ContainerHttpRequest {
            method: "POST".into(),
            path: "/api/notes".into(),
            query: String::new(),
            headers: vec![("Content-Type".into(), "application/json".into())],
            body: br#"{"author":"bob","body":"Hello from Bob"}"#.to_vec(),
            client_ip: "127.0.0.2".into(),
            host: "localhost".into(),
            https: false,
            htaccess_evaluated: false,
        };
        let (r1, r2) = tokio::join!(rt.dispatch(req1), rt.dispatch(req2));
        assert_eq!(r1.status, 201, "r1 body: {}", String::from_utf8_lossy(&r1.body));
        assert_eq!(r2.status, 201, "r2 body: {}", String::from_utf8_lossy(&r2.body));

        // Verify both users' records are persisted and readable across requests
        let list_resp = rt
            .dispatch(ContainerHttpRequest {
                method: "GET".into(),
                path: "/api/notes".into(),
                query: String::new(),
                headers: vec![],
                body: vec![],
                client_ip: "127.0.0.3".into(),
                host: "localhost".into(),
                https: false,
                htaccess_evaluated: false,
            })
            .await;
        assert_eq!(list_resp.status, 200);
        let parsed: Value = serde_json::from_slice(&list_resp.body).unwrap();
        let notes = parsed["notes"].as_array().unwrap();
        assert_eq!(notes.len(), 2);
        let authors: HashSet<&str> = notes.iter().map(|n| n["author"].as_str().unwrap()).collect();
        assert!(authors.contains("alice") && authors.contains("bob"));

        let _ = fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn js_and_python_container_backends_run_in_zipp_sandbox() {
        let root = crate::test_dirs::temp_path("softn-container-multi", "");
        let bundle = root.join("bundle-js");
        let data = root.join("data-js");
        fs::create_dir_all(&bundle).unwrap();
        fs::create_dir_all(&data).unwrap();

        write_file(
            &bundle,
            "manifest.json",
            r#"{
              "id": "com.test.js-api",
              "name": "JS API",
              "version": "1.0.0",
              "engine": 2,
              "main": "index.html",
              "backend": { "runtime": "javascript", "entry": "backend/server.js", "mode": "api", "routes": ["/api/"] },
              "databases": [{ "name": "app", "engine": "sqlite", "file": "app.db" }]
            }"#,
        );
        write_file(&bundle, "index.html", "<!doctype html><h1>JS API</h1>");
        write_file(
            &bundle,
            "backend/server.js",
            r#"
function handleRequest(req) {
  const db = sqlite.open("app.db");
  db.execute("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)");
  if (req.path === "/api/loop") {
    while (true) {}
  }
  if (req.method === "POST" && req.path === "/api/kv") {
    const payload = JSON.parse(req.body || "{}");
    db.execute("INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)", [payload.k, payload.v]);
    return { status: 201, json: { saved: true } };
  }
  const res = db.query("SELECT k, v FROM kv ORDER BY k");
  return { status: 200, json: { items: res.rows } };
}
"#,
        );

        let manifest = crate::bundle::load_manifest(&bundle).unwrap();
        let rt = ContainerBackendRuntime::load(&manifest, &bundle, &data, Some(1))
            .unwrap()
            .unwrap();

        let post = rt
            .dispatch(ContainerHttpRequest {
                method: "POST".into(),
                path: "/api/kv".into(),
                query: String::new(),
                headers: vec![],
                body: br#"{"k":"greeting","v":"sandboxed"}"#.to_vec(),
                client_ip: "127.0.0.1".into(),
                host: "localhost".into(),
                https: false,
                htaccess_evaluated: false,
            })
            .await;
        assert_eq!(post.status, 201);

        let get = rt
            .dispatch(ContainerHttpRequest {
                method: "GET".into(),
                path: "/api/kv".into(),
                query: String::new(),
                headers: vec![],
                body: vec![],
                client_ip: "127.0.0.1".into(),
                host: "localhost".into(),
                https: false,
                htaccess_evaluated: false,
            })
            .await;
        assert_eq!(get.status, 200);
        let parsed: Value = serde_json::from_slice(&get.body).unwrap();
        assert_eq!(parsed["items"][0]["v"], "sandboxed");

        // Verify ZIPP safe-sandbox instruction budget halts infinite loops cleanly
        let loop_resp = rt
            .dispatch(ContainerHttpRequest {
                method: "GET".into(),
                path: "/api/loop".into(),
                query: String::new(),
                headers: vec![],
                body: vec![],
                client_ip: "127.0.0.1".into(),
                host: "localhost".into(),
                https: false,
                htaccess_evaluated: false,
            })
            .await;
        assert_eq!(loop_resp.status, 503);

        // Now verify Python container backend in ZIPP sandbox
        let py_bundle = root.join("bundle-py");
        let py_data = root.join("data-py");
        fs::create_dir_all(&py_bundle).unwrap();
        fs::create_dir_all(&py_data).unwrap();
        write_file(
            &py_bundle,
            "manifest.json",
            r#"{
              "id": "com.test.py-api",
              "name": "Py API",
              "version": "1.0.0",
              "engine": 2,
              "main": "index.html",
              "backend": { "runtime": "python", "entry": "backend/server.py", "mode": "api", "routes": ["/api/"] },
              "databases": [{ "name": "app", "engine": "sqlite", "file": "app.db" }]
            }"#,
        );
        write_file(&py_bundle, "index.html", "<!doctype html><h1>Py API</h1>");
        write_file(
            &py_bundle,
            "backend/server.py",
            r#"
def handle_request(req):
    db = sqlite.open("app.db")
    db.execute("CREATE TABLE IF NOT EXISTS pings (id INTEGER PRIMARY KEY AUTOINCREMENT, msg TEXT)")
    db.execute("INSERT INTO pings (msg) VALUES (?)", ["pong-from-python"])
    rows = db.query("SELECT id, msg FROM pings")["rows"]
    return {"status": 200, "json": {"count": len(rows), "last": rows[-1]["msg"]}}
"#,
        );
        let py_manifest = crate::bundle::load_manifest(&py_bundle).unwrap();
        let py_rt = ContainerBackendRuntime::load(&py_manifest, &py_bundle, &py_data, Some(1))
            .unwrap()
            .unwrap();
        let py_resp = py_rt
            .dispatch(ContainerHttpRequest {
                method: "GET".into(),
                path: "/api/ping".into(),
                query: String::new(),
                headers: vec![],
                body: vec![],
                client_ip: "127.0.0.1".into(),
                host: "localhost".into(),
                https: false,
                htaccess_evaluated: false,
            })
            .await;
        assert_eq!(py_resp.status, 200, "py body: {}", String::from_utf8_lossy(&py_resp.body));
        let py_json: Value = serde_json::from_slice(&py_resp.body).unwrap();
        assert_eq!(py_json["count"], 1);
        assert_eq!(py_json["last"], "pong-from-python");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn round2_security_htaccess_vars_sqlite_rename_and_php_overlay() {
        // 1. Apache variable double-expansion: captured user input containing `%{HTTP:Cookie}`
        // must NOT be expanded into the request's Cookie header.
        let mut htmap = HashMap::new();
        htmap.insert(
            String::new(),
            parse_htaccess("RewriteEngine On\nRewriteRule ^p/(.*)$ /out/$1 [L]\n", ""),
        );
        let mut headers = HashMap::new();
        headers.insert("cookie".into(), "secret=topsecret".into());
        let empty_vfs = HashMap::new();
        let empty_dirs = HashSet::new();
        match evaluate_htaccess_chain(
            &htmap,
            "/p/%{HTTP:Cookie}",
            "",
            "GET",
            "example.com",
            true,
            &headers,
            &empty_vfs,
            &empty_dirs,
        ) {
            HtaccessEval::Rewrite { pathname, .. } => {
                assert_eq!(pathname, "/out/%{HTTP:Cookie}", "must not expand user-supplied %{{HTTP:Cookie}}");
                assert!(!pathname.contains("topsecret"));
            }
            _ => panic!("expected Rewrite result"),
        }

        // 1b. Precomputed O(1) vfs_dirs index + precompiled RewriteCond regex
        let mut dir_vfs = HashMap::new();
        dir_vfs.insert("assets/img/logo.png".into(), b"png".to_vec());
        let dir_index = build_vfs_dir_index(&dir_vfs);
        assert!(vfs_has_dir(&dir_index, "assets"));
        assert!(vfs_has_dir(&dir_index, "assets/img"));
        assert!(!vfs_has_dir(&dir_index, "assets/missing"));
        let mut cond_map = HashMap::new();
        cond_map.insert(
            String::new(),
            parse_htaccess(
                "RewriteEngine On\nRewriteCond %{REQUEST_FILENAME} !-d\nRewriteCond %{HTTP_HOST} ^api\\. [NC]\nRewriteRule ^v1/(.*)$ /handler.php?r=$1 [L]\n",
                "",
            ),
        );
        match evaluate_htaccess_chain(
            &cond_map,
            "/v1/items",
            "",
            "GET",
            "API.example.com",
            true,
            &headers,
            &dir_vfs,
            &dir_index,
        ) {
            HtaccessEval::Rewrite { pathname, query } => {
                assert_eq!(pathname, "/handler.php");
                assert_eq!(query, "r=items");
            }
            _ => panic!("expected Rewrite for precompiled RewriteCond"),
        }

        // 1c. Hardened private static asset path blocking (dotfiles, secrets, db dirs, python)
        for forbidden in [
            ".pit.secret",
            "sub/.env",
            "keys/tls.pem",
            "db/app.json",
            "migrations/001.txt",
            "worker.py",
        ] {
            assert!(is_private_static_path(forbidden), "expected private: {forbidden}");
        }
        assert!(!is_private_static_path(".well-known/assetlinks.json"));
        assert!(!is_private_static_path("assets/app.js"));

        // 2. SQLite authorizer & SAVEPOINT post-DDL guard must block ALTER TABLE ... RENAME TO _host_table.
        let (conn, _) = SqlStorageConfig::open_configured_connection(None).unwrap();
        conn.execute("CREATE TABLE items (id INTEGER PRIMARY KEY)", []).unwrap();
        assert!(conn.execute("CREATE TABLE _secret (id INTEGER PRIMARY KEY)", []).is_err());
        // Writable busy_timeout must be denied (read-only allowed)
        assert!(conn.execute("PRAGMA busy_timeout = 999999", []).is_err());
        assert!(conn.query_row("PRAGMA busy_timeout", [], |r| r.get::<_, i64>(0)).is_ok());

        let tmp_dir = crate::test_dirs::temp_path("softn-sql-guard", "");
        std::fs::create_dir_all(&tmp_dir).unwrap();
        let sql_cfg = SqlStorageConfig {
            db_dir: tmp_dir.clone(),
            databases: vec![],
            db_fs_lock: Arc::new(Mutex::new(())),
        };
        let mut bridge = RequestSqlBridge::new(sql_cfg, Arc::new(AtomicBool::new(false)));
        let open_res: Value = serde_json::from_str(&bridge.call("open", &[":memory:".into()])).unwrap();
        let h = open_res["id"].as_u64().unwrap().to_string();
        let create_res: Value = serde_json::from_str(&bridge.call("execute", &[h.clone(), "CREATE TABLE items (id INT)".into(), "[]".into()])).unwrap();
        assert!(create_res.get("error").is_none(), "create failed: {create_res}");
        let rename_bad1: Value = serde_json::from_str(&bridge.call("execute", &[h.clone(), "ALTER TABLE items RENAME TO _host_secret".into(), "[]".into()])).unwrap();
        assert!(rename_bad1.get("error").is_some(), "expected reserved rename block: {rename_bad1}");
        let rename_bad2: Value = serde_json::from_str(&bridge.call("execute", &[h.clone(), "ALTER TABLE items RENAME TO \"_host_secret\"".into(), "[]".into()])).unwrap();
        assert!(rename_bad2.get("error").is_some(), "expected quoted reserved rename block: {rename_bad2}");
        let rename_ok: Value = serde_json::from_str(&bridge.call("execute", &[h.clone(), "ALTER TABLE items RENAME TO items_v2".into(), "[]".into()])).unwrap();
        assert!(rename_ok.get("error").is_none(), "valid rename failed: {rename_ok}");
        // Multi-statement queries with string-literal semicolons are allowed, while actual second statements are rejected.
        assert!(!has_multiple_statements("SELECT ';' FROM items_v2;"));
        assert!(has_multiple_statements("SELECT 1; DROP TABLE items_v2"));
        // URL-encoded path decoding blocks %00 and traversal, and decodes %73erver so private blocks apply.
        assert!(decode_http_path("/foo%00bar").is_err());
        assert!(decode_http_path("/a/%2e%2e/server/secret.php").is_err());
        assert_eq!(decode_http_path("/%73erver/secret.php").unwrap(), "/server/secret.php");
        // RedirectMatch 403 and 301 work in .htaccess parsing.
        let ht = parse_htaccess("RedirectMatch 403 ^/secret/.*\nRedirectMatch 301 ^/old/(.*)$ /new/$1\n", "");
        let mut hmap = HashMap::new();
        hmap.insert(String::new(), ht);
        let empty_vfs = HashMap::new();
        let empty_dirs = HashSet::new();
        let empty_hdrs = HashMap::new();
        assert!(matches!(
            evaluate_htaccess_chain(&hmap, "/secret/key", "", "GET", "localhost", false, &empty_hdrs, &empty_vfs, &empty_dirs),
            HtaccessEval::Deny(403)
        ));
        assert!(matches!(
            evaluate_htaccess_chain(&hmap, "/old/page", "", "GET", "localhost", false, &empty_hdrs, &empty_vfs, &empty_dirs),
            HtaccessEval::Redirect(301, ref loc) if loc == "/new/page"
        ));

        // 3. Protected PHP overlay paths must be stripped.
        assert!(is_protected_php_overlay_path("index.php", "index.php"));
        assert!(is_protected_php_overlay_path("sub/backdoor.phtml", "index.php"));
        assert!(is_protected_php_overlay_path(".htaccess", "index.php"));
        assert!(is_protected_php_overlay_path(".env.local", "index.php"));
        assert!(is_protected_php_overlay_path("manifest.json", "index.php"));
        assert!(!is_protected_php_overlay_path("uploads/note.txt", "index.php"));

        // 4. Round-5 hardening: .htaccess never expands sensitive auth/cookie headers,
        //    and SQLite DDL savepoint authorizer blocks `END;` / `RELEASE` escape attempts.
        let mut sens_headers = HashMap::new();
        sens_headers.insert("cookie".into(), "session=secret123".into());
        sens_headers.insert("authorization".into(), "Bearer tok".into());
        sens_headers.insert("proxy-authorization".into(), "Basic abc".into());
        sens_headers.insert("x-custom".into(), "ok".into());
        let expanded = expand_apache_vars(
            "c=%{HTTP:Cookie};a=%{HTTP:Authorization};p=%{HTTP:Proxy-Authorization};x=%{HTTP:X-Custom}",
            "/test",
            "/test",
            "",
            "GET",
            "example.com",
            true,
            &sens_headers,
        );
        assert_eq!(expanded, "c=;a=;p=;x=ok");
        assert!(!expanded.contains("secret123"));
        assert!(!expanded.contains("Bearer"));

        // Attempt to break out of host DDL savepoint via `END;` or `RELEASE` in multi-statement SQL
        let end_attempt: Value = serde_json::from_str(&bridge.call(
            "execute",
            &[h.clone(), "ALTER TABLE items_v2 RENAME TO _pwn; END;".into(), "[]".into()],
        ))
        .unwrap();
        assert!(end_attempt.get("error").is_some(), "END; savepoint escape must be blocked: {end_attempt}");
    }

    #[test]
    fn php_overlay_write_evicts_nothing_the_request_did_not_delete() {
        const MIB: usize = 1024 * 1024;
        let dir = crate::test_dirs::temp_path("softn-php-overlay", "");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("php-overlay.json");
        let mut stored = PhpVfsOverlay::default();
        stored.writes.insert("uploads/a.bin".into(), vec![1u8; 9 * MIB]);
        stored.writes.insert("uploads/b.bin".into(), vec![2u8; 6 * MIB]);
        stored.total_bytes = 15 * MIB;
        let shared = Mutex::new(Arc::new(stored));
        let last_saved = Mutex::new(Vec::new());
        // One request: it starts from the stored overlay, changes its own copy, and merges back.
        let request = |change: &dyn Fn(&mut PhpVfsOverlay)| {
            let initial = Arc::clone(&shared.lock().unwrap());
            let mut mine = clone_php_overlay(&initial);
            change(&mut mine);
            merge_and_save_php_overlay(&path, &shared, initial, mine, "index.php", &last_saved);
        };
        let stored_files = || {
            let now = shared.lock().unwrap();
            let mut names: Vec<String> = now.writes.keys().cloned().collect();
            names.sort();
            (names, now.total_bytes)
        };

        // 2 MiB more does not fit beside 15 MiB. The new file is the one left out: it sorts
        // first, and `uploads/b.bin`, which sorts last, used to be deleted to make room.
        request(&|ov| {
            ov.writes.insert("cache/x.bin".into(), vec![3u8; 2 * MIB]);
        });
        assert_eq!(stored_files(), (vec!["uploads/a.bin".into(), "uploads/b.bin".into()], 15 * MIB));

        // A write that fits lands beside them, and a protected path never does.
        request(&|ov| {
            ov.writes.insert("cache/y.bin".into(), vec![4u8; MIB / 2]);
            ov.writes.insert("cache/shell.php".into(), b"<?php".to_vec());
        });
        assert_eq!(
            stored_files(),
            (vec!["cache/y.bin".into(), "uploads/a.bin".into(), "uploads/b.bin".into()], 15 * MIB + MIB / 2)
        );

        // Deleting is the request's to do, and frees the room for what it writes with it.
        request(&|ov| {
            ov.writes.remove("uploads/b.bin");
            ov.deleted.insert("uploads/b.bin".into());
            ov.writes.insert("cache/x.bin".into(), vec![3u8; 2 * MIB]);
        });
        let kept: Vec<String> = vec!["cache/x.bin".into(), "cache/y.bin".into(), "uploads/a.bin".into()];
        assert_eq!(stored_files(), (kept.clone(), 11 * MIB + MIB / 2));

        // The file on disk says the same.
        let reloaded = load_php_overlay(&path, "index.php");
        let mut on_disk: Vec<String> = reloaded.writes.keys().cloned().collect();
        on_disk.sort();
        assert_eq!(on_disk, kept);
        assert!(reloaded.deleted.contains("uploads/b.bin"));
        let _ = fs::remove_dir_all(&dir);
    }

    /// A request that wrote something used to copy the whole stored overlay (up to 16 MiB)
    /// with the store's lock held, every time: the store could only be changed in place if
    /// nothing else held it, and the request itself did, as the overlay it had started from.
    #[test]
    fn php_overlay_is_changed_in_place_unless_a_request_in_flight_is_reading_it() {
        let dir = crate::test_dirs::temp_path("softn-php-overlay-inplace", "");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("php-overlay.json");
        let mut stored = PhpVfsOverlay::default();
        stored.writes.insert("uploads/a.bin".into(), vec![1u8; 4096]);
        stored.dirs.insert("uploads".into());
        stored.total_bytes = 4096;
        let shared = Mutex::new(Arc::new(stored));
        let last_saved = Mutex::new(Vec::new());
        let stored_at = || Arc::as_ptr(&*shared.lock().unwrap());
        let names = |overlay: &PhpVfsOverlay| {
            let mut names: Vec<String> = overlay.writes.keys().cloned().collect();
            names.sort();
            names
        };
        // A request as the worker runs one: it starts from the stored overlay, changes a copy,
        // and hands both to the merge.
        let begin = || {
            let initial = Arc::clone(&shared.lock().unwrap());
            let mine = clone_php_overlay(&initial);
            (initial, mine)
        };

        // On its own: the stored overlay is the one that was there, changed. Not a copy of it.
        let before = stored_at();
        let (initial, mut mine) = begin();
        mine.writes.insert("uploads/b.bin".into(), vec![2u8; 100]);
        mine.deleted.insert("tmp/old.txt".into());
        mine.dirs.insert("tmp".into());
        merge_and_save_php_overlay(&path, &shared, initial, mine, "index.php", &last_saved);
        assert_eq!(stored_at(), before, "the stored overlay was copied to be changed");
        {
            let now = shared.lock().unwrap();
            assert_eq!(names(&now), vec!["uploads/a.bin".to_string(), "uploads/b.bin".to_string()]);
            assert_eq!(now.total_bytes, 4196);
            assert!(now.deleted.contains("tmp/old.txt") && now.dirs.contains("tmp") && now.dirs.contains("uploads"));
            assert_eq!(Arc::strong_count(&now), 1);
        }

        // With another request under way: that one goes on reading what it started from,
        // whole and unchanged, and the store moves on to a copy with both requests' changes.
        let (other_initial, mut other_mine) = begin();
        let (initial, mut mine) = begin();
        mine.writes.remove("uploads/a.bin");
        mine.deleted.insert("uploads/a.bin".into());
        mine.writes.insert("uploads/c.bin".into(), vec![3u8; 10]);
        merge_and_save_php_overlay(&path, &shared, initial, mine, "index.php", &last_saved);
        assert_ne!(stored_at(), before);
        assert_eq!(names(&other_initial), vec!["uploads/a.bin".to_string(), "uploads/b.bin".to_string()]);
        assert_eq!(other_initial.total_bytes, 4196);
        assert!(!other_initial.deleted.contains("uploads/a.bin"));
        assert_eq!(names(&shared.lock().unwrap()), vec!["uploads/b.bin".to_string(), "uploads/c.bin".to_string()]);
        // The other request finishes: its own change goes in beside the first one's.
        let before = stored_at();
        other_mine.writes.insert("uploads/d.bin".into(), vec![4u8; 5]);
        merge_and_save_php_overlay(&path, &shared, other_initial, other_mine, "index.php", &last_saved);
        assert_eq!(stored_at(), before, "nothing else was reading it by then");
        {
            let now = shared.lock().unwrap();
            assert_eq!(names(&now), vec!["uploads/b.bin".to_string(), "uploads/c.bin".to_string(), "uploads/d.bin".to_string()]);
            assert_eq!(now.total_bytes, 115);
            assert!(now.deleted.contains("uploads/a.bin"));
        }
        // And the file on disk is the store.
        let reloaded = load_php_overlay(&path, "index.php");
        assert_eq!(names(&reloaded), vec!["uploads/b.bin".to_string(), "uploads/c.bin".to_string(), "uploads/d.bin".to_string()]);
        assert!(reloaded.deleted.contains("uploads/a.bin") && reloaded.deleted.contains("tmp/old.txt"));

        // A request that changed nothing does not touch the store at all.
        let (initial, mine) = begin();
        merge_and_save_php_overlay(&path, &shared, initial, mine, "index.php", &last_saved);
        assert_eq!(stored_at(), before);
        let _ = fs::remove_dir_all(&dir);
    }

    fn root_htaccess_denies(source: &str, method: &str, path: &str) -> bool {
        let mut map = HashMap::new();
        map.insert(String::new(), parse_htaccess(source, ""));
        matches!(
            evaluate_htaccess_chain(&map, path, "", method, "localhost", false, &HashMap::new(), &HashMap::new(), &HashSet::new()),
            HtaccessEval::Deny(403)
        )
    }

    // The same cases as apps/softn-host-php/tests/container-backend.test.mjs, which reads
    // `.htaccess` the same way.
    #[test]
    fn htaccess_deny_inside_a_section_is_not_a_deny_for_the_directory() {
        let denies = |source: &str, path: &str| root_htaccess_denies(source, "GET", path);

        // A look-ahead does not compile here and Drupal's stock rule has one, and `(` is no
        // pattern. None of the blocks may take the entry script, or anything else, with it. (A
        // pattern over 512 bytes is not read either, and closes the directory instead:
        // the_two_hosts_close_a_directory_whose_files_pattern_is_too_long.)
        let lookahead = "<FilesMatch \"^(?!index\\.php$).*\\.php$\">\n  Require all denied\n</FilesMatch>\n";
        let drupal = concat!(
            "<FilesMatch \"\\.(engine|inc|install|make|module|profile|po|sh|.*sql|theme|twig|tpl(\\.php)?|xtmpl|yml)",
            "(~|\\.sw[op]|\\.bak|\\.orig|\\.save)?$|^(\\.(?!well-known).*|Entries.*|Repository|Root|Tag|Template|",
            "composer\\.(json|lock)|web\\.config|yarn\\.lock|package\\.json)$|^#.*#$|\\.php(~|\\.sw[op]|\\.bak|\\.orig|\\.save)$\">\n",
            "  <IfModule mod_authz_core.c>\n    Require all denied\n  </IfModule>\n",
            "  <IfModule !mod_authz_core.c>\n    Order allow,deny\n    Deny from all\n  </IfModule>\n",
            "</FilesMatch>\n",
        );
        let invalid = "<FilesMatch \"(\">\nDeny from all\n</FilesMatch>\n";
        for source in [lookahead, drupal, invalid] {
            for path in ["/index.php", "/", "/assets/app.css", "/api/notes", "/aaa"] {
                assert!(!denies(source, path), "{path} under {source}");
            }
        }
        // A header whose pattern holds a `<` or a `>` still opens a block. One that is not closed
        // is not a header Apache reads, and closes the directory
        // (the_two_hosts_close_a_directory_whose_section_tags_are_malformed).
        let unclosed_header = "<FilesMatch \"\\.inc$\"\nDeny from all\n</FilesMatch>\n";
        assert!(denies(unclosed_header, "/index.php"));
        assert!(denies(unclosed_header, "/db.inc"));
        let named = "<FilesMatch \"\\.(?<ext>bak|old)$\">\nDeny from all\n</FilesMatch>\n";
        assert!(!denies(named, "/index.php"));
        assert!(denies(named, "/site.old"));

        // The block ends where it says, so what follows it is still read.
        let then_files = format!("{lookahead}<Files \"notes.txt\">\nDeny from all\n</Files>\n");
        assert!(denies(&then_files, "/notes.txt"));
        assert!(!denies(&then_files, "/index.php"));
        let then_all = format!("{lookahead}Require all denied\n");
        assert!(denies(&then_all, "/index.php"));

        // `<Files ~ "regex">` is the regular-expression form, and an opening tag may have spaces
        // before its `>` (a closing one may not: `</Files >` closes the directory).
        let tilde = "<Files ~ \"^\\.ht|\\.bak$\">\nDeny from all\n</Files>\n";
        assert!(denies(tilde, "/old.BAK"));
        assert!(!denies(tilde, "/index.php"));
        let quoted = "<FilesMatch '\\.(inc|tpl)$' >\nRequire all denied\n</FilesMatch>\n<Files config.php>\nRequire all denied\n</Files>\n";
        assert!(denies(quoted, "/lib/db.inc"));
        assert!(denies(quoted, "/config.php"));
        assert!(!denies(quoted, "/index.php"));

        // Expression sections are not evaluated, so their denies are for nobody. A method
        // section's are for the methods it names (the_two_hosts_read_htaccess_denies_alike).
        let conditional = concat!(
            "<LimitExcept GET POST>\n  Order deny,allow\n  Deny from all\n</LimitExcept>\n",
            "<Limit PUT DELETE>\n  Require all denied\n</Limit>\n",
            "<If \"%{HTTP_HOST} == 'old.example'\">\n  Require all denied\n</If>\n",
            "<ElseIf \"-R '10.0.0.0/8'\">\n  Require all denied\n</ElseIf>\n",
            "<Else>\n  <Files \"index.php\">\n    Require all denied\n  </Files>\n</Else>\n",
            "<Files \"admin.php\">\n  <Limit POST>\n    Require all denied\n  </Limit>\n</Files>\n",
            "<Files \"notes.txt\">\n  Require all denied\n</Files>\n",
        );
        for path in ["/index.php", "/admin.php", "/assets/app.css"] {
            assert!(!root_htaccess_denies(conditional, "GET", path), "GET {path}");
            assert!(root_htaccess_denies(conditional, "PUT", path), "PUT {path}");
        }
        assert!(!root_htaccess_denies(conditional, "POST", "/index.php"));
        assert!(root_htaccess_denies(conditional, "POST", "/admin.php"));
        for method in ["GET", "POST", "PUT"] {
            assert!(root_htaccess_denies(conditional, method, "/notes.txt"));
        }

        // `<IfModule>` bodies apply as written: the usual way to close a directory still does.
        let closed = "<IfModule mod_authz_core.c>\n  Require all denied\n</IfModule>\n<IfModule !mod_authz_core.c>\n  Deny from all\n</IfModule>\n";
        assert!(denies(closed, "/index.php"));
        let in_ifmodule = "<IfModule mod_authz_core.c>\n  <Files \"config.php\">\n    Require all denied\n  </Files>\n</IfModule>\n";
        assert!(denies(in_ifmodule, "/config.php"));
        assert!(!denies(in_ifmodule, "/index.php"));

        // Rules outside a skipped section are kept and the ones inside it are not.
        let rewrites = parse_htaccess(
            "RewriteEngine On\n<If \"%{HTTPS} == 'off'\">\n  RewriteRule ^ https://example.test/ [R=301,L]\n</If>\nRewriteRule ^a$ /b [L]\n",
            "",
        );
        assert!(rewrites.rewrite_engine);
        assert_eq!(rewrites.rules.len(), 1);
        assert_eq!(rewrites.rules[0].substitution, "/b");
    }

    /// Whether a request is refused under a bundle whose root `.htaccess` is `source` and
    /// whose other files are `files`.
    fn htaccess_file_denies(source: &[u8], files: &[&str], method: &str, path: &str) -> bool {
        let mut map = HashMap::new();
        map.insert(String::new(), parse_htaccess_file(source, ""));
        let vfs: HashMap<String, Vec<u8>> = files.iter().map(|file| (file.to_string(), Vec::new())).collect();
        matches!(
            evaluate_htaccess_chain(&map, path, "", method, "localhost", false, &HashMap::new(), &vfs, &HashSet::new()),
            HtaccessEval::Deny(403)
        )
    }

    // The same cases as "the two hosts read .htaccess denies alike" in
    // apps/softn-host-php/tests/container-backend.test.mjs: where the two differed.
    #[test]
    fn the_two_hosts_read_htaccess_denies_alike() {
        let denies = |source: &str, method: &str, path: &str| htaccess_file_denies(source.as_bytes(), &[], method, path);

        // A directive is its words: in any case, with any run of spaces and tabs between.
        // This host wanted single spaces, and took `Deny from all.example.com` for a deny.
        for deny in ["deny  from\tall", "DENY FROM ALL", "Require\t\tall   denied", "require all DENIED", "\t Deny from all \t", "\u{feff}Deny from all"] {
            assert!(denies(&format!("{deny}\n"), "GET", "/index.php"), "{deny:?}");
            assert!(denies(&format!("<Files \"a.txt\">\n{deny}\n</Files>\n"), "GET", "/a.txt"), "{deny:?}");
        }
        for other in ["Deny from all.example.com", "Deny from allowed.example", "Require all deniedx", "Require all granted", "Denyfrom all", "# Deny from all"] {
            assert!(!denies(&format!("{other}\n"), "GET", "/index.php"), "{other:?}");
        }

        // A rules file too large to read in full refuses everything under it. This host
        // read its first 64 KiB and the other host none of it: each let through what the
        // rest refused.
        let padding = |bytes: usize| format!("#{}\n", "x".repeat(bytes - 2));
        let too_large = format!("{}Options -Indexes\n", padding(64 * 1024));
        for path in ["/index.php", "/assets/app.css", "/"] {
            assert!(denies(&too_large, "GET", path), "{path}");
        }
        let last_block = "<Files \"z.txt\">\nDeny from all\n</Files>\n";
        let largest = format!("{}{last_block}", padding(64 * 1024 - last_block.len()));
        assert_eq!(largest.len(), 64 * 1024);
        assert!(!denies(&largest, "GET", "/index.php"));
        assert!(denies(&largest, "GET", "/z.txt"), "a file that fits is read to its end");
        // By the file's size, not its text's: these bytes are three times as long read as text.
        let not_utf8 = [b"Options -Indexes\n".as_slice(), &[0xff; 30 * 1024]].concat();
        assert!(!htaccess_file_denies(&not_utf8, &[], "GET", "/index.php"));

        // A `<Files>` block names the file a request is mapped to: the last segment, and a
        // segment before it that is a file (the rest is its PATH_INFO). The other host tested
        // only the last.
        let inc = "<FilesMatch \"\\.inc$\">\nRequire all denied\n</FilesMatch>\n";
        let files = ["index.php", "db.inc", "lib/db.inc"];
        let under = |path: &str| htaccess_file_denies(inc.as_bytes(), &files, "GET", path);
        assert!(under("/db.inc") && under("/lib/db.inc") && under("/nowhere/x.inc"));
        assert!(under("/db.inc/anything") && under("/lib/db.inc/a/b"));
        assert!(!under("/missing.inc/anything"), "not a file, so not what the request is mapped to");
        assert!(!under("/index.php/anything") && !under("/lib/other"));

        // A deny inside `<Limit>`/`<LimitExcept>` is for the methods the section names. Both
        // hosts dropped it, and then it was for nobody.
        let except = "<LimitExcept GET POST>\n  Order deny,allow\n  Deny from all\n</LimitExcept>\n";
        for (method, refused) in [("GET", false), ("HEAD", false), ("POST", false), ("get", false), ("PUT", true), ("DELETE", true), ("PROPFIND", true)] {
            assert_eq!(denies(except, method, "/index.php"), refused, "{method}");
        }
        let only = "<Limit PUT DELETE>\n  Require all denied\n</Limit>\n";
        for (method, refused) in [("PUT", true), ("DELETE", true), ("delete", true), ("GET", false), ("POST", false)] {
            assert_eq!(denies(only, method, "/index.php"), refused, "{method}");
        }
        // To Apache HEAD is GET, and a method's name is matched by case.
        let get = "<Limit GET>\nDeny from all\n</Limit>\n";
        assert!(denies(get, "GET", "/") && denies(get, "HEAD", "/") && !denies(get, "POST", "/"));
        let head = "<LimitExcept HEAD>\nDeny from all\n</LimitExcept>\n";
        assert!(!denies(head, "GET", "/") && !denies(head, "HEAD", "/") && denies(head, "POST", "/"));
        assert!(!denies("<Limit get>\nDeny from all\n</Limit>\n", "GET", "/"));
        assert!(denies("<LimitExcept get>\nDeny from all\n</LimitExcept>\n", "GET", "/"));
        // Inside a block, and with the block's own deny beside it.
        let admin = "<Files \"admin.php\">\n  <Limit POST>\n    Require all denied\n  </Limit>\n</Files>\n<Limit PUT>\nDeny from all\n</Limit>\n<Files \"x.txt\">\nDeny from all\n</Files>\n";
        assert!(denies(admin, "POST", "/admin.php") && !denies(admin, "GET", "/admin.php") && !denies(admin, "POST", "/index.php"));
        assert!(denies(admin, "PUT", "/index.php") && denies(admin, "GET", "/x.txt") && !denies(admin, "GET", "/index.php"));
        // What Apache would not load is read the safe way: for every method.
        let nested = "<Limit POST>\n<LimitExcept GET>\nDeny from all\n</LimitExcept>\n</Limit>\n";
        assert!(denies(nested, "GET", "/") && denies(nested, "POST", "/"));
        assert!(denies("<Limit>\nDeny from all\n</Limit>\n", "GET", "/"));
        // A method section under an expression section is skipped with it, as before.
        assert!(!denies("<If \"true\">\n<Limit GET>\nDeny from all\n</Limit>\n</If>\n", "GET", "/"));
        // Nothing but a deny is read inside a method section.
        let rewrites = parse_htaccess("RewriteEngine On\n<Limit POST>\nRewriteRule ^a$ /b [L]\n</Limit>\nRewriteRule ^c$ /d [L]\n", "");
        assert_eq!(rewrites.rules.len(), 1);

        // More denies than are kept close the directory. This host dropped the ones past
        // the sixty-fourth; the other kept them all.
        let blocks = |count: usize| -> String {
            (0..count)
                .map(|n| format!("<Files \"f{n}.txt\">\n<IfModule a>\nRequire all denied\n</IfModule>\n<IfModule !a>\nDeny from all\n</IfModule>\n</Files>\n"))
                .collect()
        };
        assert!(!denies(&blocks(64), "GET", "/index.php"), "said twice in a block is one deny");
        assert!(denies(&blocks(64), "GET", "/f63.txt"));
        assert!(denies(&blocks(65), "GET", "/index.php"));
        assert!(denies(&format!("{}Require all denied\n", blocks(64)), "GET", "/assets/app.css"));

        // A request for a directory is under that directory's own rules, as one for a file
        // in it is. The other host read them only for what lay below the directory.
        let mut closed_dir = HashMap::new();
        closed_dir.insert("admin".to_owned(), parse_htaccess_file(b"Require all denied\n", "admin"));
        let vfs: HashMap<String, Vec<u8>> = HashMap::from([("admin/index.php".to_owned(), Vec::new())]);
        let refused = |path: &str| {
            matches!(
                evaluate_htaccess_chain(&closed_dir, path, "", "GET", "localhost", false, &HashMap::new(), &vfs, &HashSet::new()),
                HtaccessEval::Deny(403)
            )
        };
        for path in ["/admin", "/admin/", "/admin/index.php", "/admin/missing"] {
            assert!(refused(path), "{path}");
        }
        assert!(!refused("/") && !refused("/administrator"));
    }

    /// The status a request is refused with under a bundle whose `.htaccess` files are
    /// `htaccess` (each a directory and its text) and whose other files are `files`, or 0 when
    /// it is not refused. The request is its method, path, query, host and headers.
    fn htaccess_refusal(
        htaccess: &[(&str, &str)],
        files: &[&str],
        (method, path, query, host, headers): (&str, &str, &str, &str, &[(&str, &str)]),
    ) -> u16 {
        let map: HashMap<String, ParsedHtaccess> =
            htaccess.iter().map(|&(dir, text)| (dir.to_owned(), parse_htaccess_file(text.as_bytes(), dir))).collect();
        let vfs: HashMap<String, Vec<u8>> = htaccess
            .iter()
            .map(|&(dir, text)| (if dir.is_empty() { ".htaccess".to_owned() } else { format!("{dir}/.htaccess") }, text.as_bytes().to_vec()))
            .chain(files.iter().map(|file| (file.to_string(), Vec::new())))
            .collect();
        let headers: HashMap<String, String> = headers.iter().map(|&(name, value)| (name.to_owned(), value.to_owned())).collect();
        match evaluate_htaccess_chain(&map, path, query, method, host, false, &headers, &vfs, &build_vfs_dir_index(&vfs)) {
            HtaccessEval::Deny(status) => status,
            _ => 0,
        }
    }

    // The same cases as "the two hosts refuse what RedirectMatch and RewriteRule refuse" in
    // apps/softn-host-php/tests/container-backend.test.mjs. That host enforced neither: a
    // request this one refused was run there.
    #[test]
    fn the_two_hosts_refuse_what_redirect_match_and_rewrite_rules_refuse() {
        let files = ["index.php", "lib/db.inc", "lib/util.php"];
        let refused = |htaccess: &[(&str, &str)], method: &str, path: &str, query: &str, host: &str, headers: &[(&str, &str)]| {
            htaccess_refusal(htaccess, &files, (method, path, query, host, headers))
        };
        let get = |source: &str, path: &str, query: &str| refused(&[("", source)], "GET", path, query, "localhost", &[]);

        // A RedirectMatch to a status of 400 or more refuses what it matches with that status.
        // It matches the whole path, by case, for any method.
        let statuses = concat!(
            "RedirectMatch 403 ^/secret/\n",
            "RedirectMatch 404 ^/includes/\n",
            "RedirectMatch gone ^/old\\.php$\n",
            "RedirectMatch 401 ^/members\n",
            "RedirectMatch 451 ^/withheld\n",
            "RedirectMatch 503 ^/down$\n",
            "RedirectMatch 403 ^/Cased\n",
        );
        for (path, status) in [
            ("/secret/key", 403), ("/secret", 0), ("/includes/config.php", 404), ("/old.php", 410), ("/members/list", 401),
            ("/withheld", 451), ("/down", 503), ("/down/x", 0), ("/Cased", 403), ("/cased", 0), ("/index.php", 0),
        ] {
            assert_eq!(get(statuses, path, ""), status, "{path}");
        }
        assert_eq!(refused(&[("", statuses)], "POST", "/secret/key", "", "localhost", &[]), 403);
        // One that sends the request elsewhere first is the answer; one without a target is passed over.
        let order = "RedirectMatch 301 ^/moved/(.*)$ /new/$1\nRedirectMatch 403 ^/moved/\nRedirectMatch 302 ^/bare\nRedirectMatch 403 ^/bare\n";
        assert_eq!(get(order, "/moved/x", ""), 0);
        assert_eq!(get(order, "/bare", ""), 403);
        // A status of 400 or more refuses with a target too; `seeother` is a redirect (303).
        assert_eq!(get("RedirectMatch 401 ^/members /login\n", "/members/x", ""), 401);
        assert_eq!(get("RedirectMatch seeother ^/x /y\nRedirectMatch 403 ^/x\n", "/x", ""), 0);
        // Not read inside a block, a method section or an expression section; read inside <IfModule>.
        let sections = concat!(
            "<Files \"x.txt\">\nRedirectMatch 403 ^/\n</Files>\n",
            "<Limit GET>\nRedirectMatch 403 ^/\n</Limit>\n",
            "<If \"true\">\nRedirectMatch 403 ^/\n</If>\n",
            "<IfModule mod_alias.c>\nRedirectMatch 404 ^/hidden/\n</IfModule>\n",
        );
        assert_eq!(["/x.txt", "/index.php", "/hidden/a"].map(|path| get(sections, path, "")), [0, 0, 404]);
        // A directory's own, for the directory and what is under it, by the whole path.
        let admin = [("admin", "RedirectMatch 403 ^/admin/?$\nRedirectMatch 404 ^/admin/private/\n")];
        assert_eq!(
            ["/admin", "/admin/", "/admin/private/x", "/admin/ok.php", "/private/x"].map(|path| refused(&admin, "GET", path, "", "localhost", &[])),
            [403, 403, 404, 0, 0]
        );

        // `RewriteRule … [F]` refuses with 403 and `[G]` with 410, where the rewrite engine is
        // on, the rules before it let the request get that far, and its conditions hold.
        let rules = concat!(
            "RewriteEngine On\n",
            "RewriteRule ^index\\.php$ - [L]\n",
            "RewriteRule ^admin/ - [F]\n",
            "RewriteRule ^ADMIN2 - [F,NC]\n",
            "RewriteRule ^old\\.html$ - [G]\n",
            "RewriteCond %{REQUEST_METHOD} =POST\n",
            "RewriteRule ^api/ - [F]\n",
            "RewriteCond %{QUERY_STRING} (^|&)debug=\n",
            "RewriteRule ^ - [F]\n",
        );
        for (path, query, status) in [
            ("/admin/x", "", 403), ("/admin2", "", 403), ("/old.html", "", 410), ("/api/notes", "", 0),
            ("/page", "debug=1", 403), ("/page", "a=1&debug", 0), ("/page", "", 0), ("/index.php", "debug=1", 0), ("/other", "", 0),
        ] {
            assert_eq!(get(rules, path, query), status, "{path}?{query}");
        }
        assert_eq!(refused(&[("", rules)], "POST", "/api/notes", "", "localhost", &[]), 403);
        // With the engine off, at the end of the file or never turned on, no rule is run.
        assert_eq!(get("RewriteEngine On\nRewriteRule ^ - [F]\nRewriteEngine Off\n", "/x", ""), 0);
        assert_eq!(get("RewriteRule ^ - [F]\n", "/x", ""), 0);

        // A request the rules rewrite is refused for where it is rewritten to: by a later rule,
        // a <FilesMatch> or a RedirectMatch. One they send elsewhere first is not refused.
        let rewrites = concat!(
            "RewriteEngine On\n",
            "RewriteRule ^go$ /elsewhere [R=301,L]\n",
            "RewriteRule ^go$ - [F]\n",
            "RewriteRule ^old/(.*)$ new/$1\n",
            "RewriteRule ^new/secret - [F]\n",
            "RewriteRule ^config$ lib/db.inc [L]\n",
            "RewriteRule ^hide/(.*)$ /hidden/$1 [L]\n",
            "<FilesMatch \"\\.inc$\">\nRequire all denied\n</FilesMatch>\n",
            "RedirectMatch 404 ^/hidden/\n",
        );
        assert_eq!(["/go", "/old/secret", "/old/public", "/config", "/hide/a"].map(|path| get(rewrites, path, "")), [0, 403, 0, 403, 404]);

        // Conditions on the bundle's files and directories, the host and the request's headers,
        // with [OR] and [NC]. The Cookie header is never read into one.
        let conditions = concat!(
            "RewriteEngine On\n",
            "RewriteCond %{REQUEST_FILENAME} !-f\n",
            "RewriteRule \\.php$ - [F]\n",
            "RewriteCond %{REQUEST_FILENAME} -d\n",
            "RewriteRule ^ - [G]\n",
            "RewriteCond %{HTTP_HOST} ^old\\. [NC,OR]\n",
            "RewriteCond %{HTTP:X-Legacy} ^1$\n",
            "RewriteRule ^ - [F]\n",
            "RewriteCond %{HTTP:Cookie} session\n",
            "RewriteRule ^ - [F]\n",
        );
        let asked = |path: &str, host: &str, headers: &[(&str, &str)]| refused(&[("", conditions)], "GET", path, "", host, headers);
        assert_eq!(asked("/missing.php", "localhost", &[]), 403);
        assert_eq!(asked("/index.php", "localhost", &[]), 0);
        assert_eq!(asked("/lib/util.php", "localhost", &[]), 0);
        assert_eq!(asked("/lib", "localhost", &[]), 410);
        assert_eq!(asked("/page", "Old.example.com", &[]), 403);
        assert_eq!(asked("/page", "localhost", &[("x-legacy", "1")]), 403);
        assert_eq!(asked("/page", "localhost", &[("cookie", "session=abc")]), 0);
        assert_eq!(asked("/page", "localhost", &[]), 0);

        // A directory's rules are for what is under it, matched without its name.
        let sub = [("admin", "RewriteEngine On\nRewriteRule ^secret - [F]\n")];
        assert_eq!(
            ["/admin/secret.txt", "/secret.txt", "/admin", "/admin/x/secret"].map(|path| refused(&sub, "GET", path, "", "localhost", &[])),
            [403, 0, 0, 0]
        );
        // Not read inside a method section; a rule whose pattern does not compile is not read,
        // and the conditions before it go with it.
        assert_eq!(refused(&[("", "RewriteEngine On\n<Limit POST>\nRewriteRule ^ - [F]\n</Limit>\n")], "POST", "/x", "", "localhost", &[]), 0);
        let invalid = "RewriteEngine On\nRewriteCond %{REQUEST_METHOD} =GET\nRewriteRule ( - [F]\nRewriteRule ^blocked - [F]\n";
        assert_eq!(refused(&[("", invalid)], "POST", "/blocked", "", "localhost", &[]), 403);
        assert_eq!(get(invalid, "/x", ""), 0);
    }

    // The same cases as "the two hosts close a directory with more rules than are kept" in
    // apps/softn-host-php/tests/container-backend.test.mjs. This host dropped the lines past
    // the count, and any of them could have refused a request, or kept one from a rule that
    // would have.
    #[test]
    fn the_two_hosts_close_a_directory_with_more_rules_than_are_kept() {
        let get = |source: &str, path: &str| htaccess_refusal(&[("", source)], &["index.php"], ("GET", path, "", "localhost", &[]));
        let lines = |count: usize, line: &dyn Fn(usize) -> String| -> String { (0..count).map(|n| line(n) + "\n").collect() };

        // 256 RewriteRule lines are read, the last of them too; a 257th closes the directory.
        let rules = |count: usize| format!("RewriteEngine On\n{}RewriteRule ^admin - [F]\n", lines(count, &|n| format!("RewriteRule ^r{n}$ /x{n}")));
        assert_eq!(get(&rules(255), "/admin"), 403);
        assert_eq!(get(&rules(255), "/index.php"), 0);
        for path in ["/admin", "/index.php", "/assets/app.css"] {
            assert_eq!(get(&rules(256), path), 403, "{path}");
        }
        // So do 257 RedirectMatch lines.
        let redirects = |count: usize| format!("{}RedirectMatch 403 ^/secret\n", lines(count, &|n| format!("RedirectMatch 301 ^/r{n}$ /x{n}")));
        assert_eq!(get(&redirects(255), "/secret"), 403);
        assert_eq!(get(&redirects(255), "/index.php"), 0);
        assert_eq!(get(&redirects(256), "/secret"), 403);
        assert_eq!(get(&redirects(256), "/index.php"), 403);
        // And 65 RewriteCond lines before one rule (64 are read). The one past the count, here
        // the last, would have kept `/public` from the pass-through and so for the [F] after it.
        let conds = |count: usize, then: &str| {
            let held = lines(count, &|n| format!("RewriteCond %{{HTTP_HOST}} !^nowhere{n}$"));
            format!("RewriteEngine On\n{held}{then}RewriteRule ^public - [L]\nRewriteRule ^ - [F]\n")
        };
        assert_eq!(get(&conds(64, ""), "/public"), 0);
        assert_eq!(get(&conds(64, ""), "/other"), 403);
        assert_eq!(get(&conds(64, "RewriteCond %{HTTP_HOST} =nowhere\n"), "/public"), 403);
        assert_eq!(get(&conds(65, ""), "/public"), 403);
        // Lines that are not read (in an expression section) are not counted.
        let skipped = format!("RewriteEngine On\n<If \"true\">\n{}</If>\nRewriteRule ^admin - [F]\n", lines(300, &|n| format!("RewriteRule ^r{n}$ /x{n}")));
        assert_eq!(get(&skipped, "/admin"), 403);
        assert_eq!(get(&skipped, "/index.php"), 0);
    }

    // The same cases as "the two hosts close a directory whose sections do not match up" in
    // apps/softn-host-php/tests/container-backend.test.mjs. Apache will not load such a file
    // and answers 500 for everything under it; both hosts read as far as it went, so a block
    // left open denied nothing, and what followed a stray closing tag was read as though it
    // were outside the section.
    #[test]
    fn the_two_hosts_close_a_directory_whose_sections_do_not_match_up() {
        let get = |source: &str, path: &str| htaccess_refusal(&[("", source)], &["index.php"], ("GET", path, "", "localhost", &[]));
        // Left open at the end of the file: a block, a method section, <IfModule>, <If>.
        for source in [
            "<Files \"secret.txt\">\nRequire all denied\n",
            "<FilesMatch \"\\.inc$\">\nDeny from all\n",
            "<Files \"a.txt\">\nRequire all denied\nRewriteEngine On\nRewriteRule ^admin - [F]\n",
            "<Limit POST>\nRequire all denied\n",
            "<IfModule mod_rewrite.c>\nRewriteEngine On\n",
            "<If \"true\">\nRequire all denied\n",
            "<IfModule a>\n<Files \"x.txt\">\nRequire all denied\n</Files>\n",
        ] {
            for path in ["/index.php", "/secret.txt", "/assets/app.css", "/"] {
                assert_eq!(get(source, path), 403, "{path} under {source:?}");
            }
        }
        // Closed where it is not the innermost open section, or not open at all.
        for source in [
            "</Files>\nOptions -Indexes\n",
            "<Files \"a.txt\">\nRequire all denied\n</FilesMatch>\n",
            "<IfModule a>\n<Files \"x\">\n</IfModule>\n</Files>\n",
            "<Limit POST>\n</LimitExcept>\n",
            "<If \"true\">\n</If>\n</If>\n",
        ] {
            assert_eq!(get(source, "/index.php"), 403, "{source:?}");
        }
        // Sections that match up are read as before, whatever the case of their names.
        let nested = "<IfModule a>\n<Files \"x.txt\">\nRequire all denied\n</Files>\n</IfModule>\n";
        assert_eq!([get(nested, "/x.txt"), get(nested, "/index.php")], [403, 0]);
        let cased = "<files \"x.txt\">\nRequire all denied\n</FILES>\n";
        assert_eq!([get(cased, "/x.txt"), get(cased, "/index.php")], [403, 0]);
        assert_eq!(get("# <Files \"x.txt\">\nOptions -Indexes\n", "/index.php"), 0);
    }

    /// The status a request is refused with under a bundle of `index.php`, `lib/db.inc` and
    /// `lib/util.php` whose `.htaccess` files are `htaccess`, or 0.
    fn refusal_of(htaccess: &[(&str, &str)], method: &str, path: &str, query: &str, host: &str) -> u16 {
        htaccess_refusal(htaccess, &["index.php", "lib/db.inc", "lib/util.php"], (method, path, query, host, &[]))
    }

    // The same cases as "the two hosts read negated rule patterns as Apache does" in
    // apps/softn-host-php/tests/container-backend.test.mjs and in the browser's reader
    // (packages/@softn/container/test/htaccess-and-vnav.test.ts). All three took the `!` of
    // `RewriteRule !pattern` for part of the pattern, so `RewriteRule !^public/ - [F]` matched
    // nothing and forbade nothing.
    #[test]
    fn the_two_hosts_read_negated_rule_patterns_as_apache_does() {
        let get = |source: &str, path: &str| refusal_of(&[("", source)], "GET", path, "", "localhost");

        // `RewriteRule !pattern` is for a path the pattern does not match, by case unless [NC].
        let outside = "RewriteEngine On\nRewriteRule !^public/ - [F]\n";
        assert_eq!(
            ["/public/app.css", "/public/", "/index.php", "/public", "/", "/x/public/a", "/PUBLIC/a"].map(|path| get(outside, path)),
            [0, 0, 403, 403, 403, 403, 403]
        );
        assert_eq!(["/PUBLIC/a", "/Other"].map(|path| get("RewriteEngine On\nRewriteRule !^public/ - [F,NC]\n", path)), [0, 403]);
        assert_eq!(["/keep.html", "/x"].map(|path| get("RewriteEngine On\nRewriteRule !^keep\\.html$ - [G]\n", path)), [0, 410]);
        // An empty pattern matches every path, so its negation none.
        assert_eq!(get("RewriteEngine On\nRewriteRule ! - [F]\n", "/x"), 0);
        // A directory's, for what is under it, matched without its name.
        let admin = [("admin", "RewriteEngine On\nRewriteRule !^login\\.php$ - [F]\n")];
        assert_eq!(
            ["/admin/login.php", "/admin/users", "/admin", "/index.php"].map(|path| refusal_of(&admin, "GET", path, "", "localhost")),
            [0, 403, 403, 0]
        );
        // Its conditions must hold, as for any rule.
        let posted = [("", "RewriteEngine On\nRewriteCond %{REQUEST_METHOD} =POST\nRewriteRule !^api/ - [F]\n")];
        assert_eq!(
            [("POST", "/x"), ("POST", "/api/notes"), ("GET", "/x")].map(|(method, path)| refusal_of(&posted, method, path, "", "localhost")),
            [403, 0, 0]
        );
        // `$1`…`$9` are empty, as the pattern matched nothing: `/x` is rewritten to `/gone/`.
        let groups = "RewriteEngine On\nRewriteRule !^(public)/(.*)$ /gone/$2 [L]\nRedirectMatch 410 ^/gone/$\n";
        assert_eq!(["/x", "/public/a"].map(|path| get(groups, path)), [410, 0]);
    }

    // The same cases as "the two hosts read negated conditions and RedirectMatch as Apache does"
    // in apps/softn-host-php/tests/container-backend.test.mjs and in the browser's reader. All
    // three read these so already.
    #[test]
    fn the_two_hosts_read_negated_conditions_and_redirect_match_as_apache_does() {
        let get = |source: &str, path: &str| refusal_of(&[("", source)], "GET", path, "", "localhost");

        // RedirectMatch has no negated form: a leading `!` is part of its pattern, as Apache
        // reads it, so `!^/public/` matches nothing.
        let redirects = "RedirectMatch 403 !^/public/\nRedirectMatch 404 !private\n";
        assert_eq!(["/x", "/public/a", "/private", "/a!private"].map(|path| get(redirects, path)), [0, 0, 0, 404]);

        // `RewriteCond … !CondPattern` holds where the pattern does not: a pattern, `=text` (by
        // case unless [NC]) or a file test, alone or in an [OR] run.
        let conds = [("", "RewriteEngine On\nRewriteCond %{REQUEST_URI} !^/public/\nRewriteCond %{HTTP_HOST} !=static.example [NC]\nRewriteRule ^ - [F]\n")];
        assert_eq!(
            [("/public/x", "localhost"), ("/other", "localhost"), ("/other", "STATIC.example"), ("/other", "static.example.com")]
                .map(|(path, host)| refusal_of(&conds, "GET", path, "", host)),
            [0, 403, 0, 403]
        );
        assert_eq!(["/lib", "/lib.txt"].map(|path| get("RewriteEngine On\nRewriteCond %{REQUEST_FILENAME} !-d\nRewriteRule ^lib - [F]\n", path)), [0, 403]);
        let either = [("", "RewriteEngine On\nRewriteCond %{HTTP_HOST} ^admin\\. [OR]\nRewriteCond %{QUERY_STRING} !(^|&)token=\nRewriteRule ^panel - [F]\n")];
        assert_eq!(
            [("", "localhost"), ("token=1", "localhost"), ("token=1", "admin.example")].map(|(query, host)| refusal_of(&either, "GET", "/panel", query, host)),
            [403, 0, 403]
        );
        // A negated condition gives `%1`…`%9` nothing, even where its pattern matched: `%1` here
        // is the first condition's `secret`, not the second's `public`.
        let backrefs = [(
            "",
            concat!(
                "RewriteEngine On\n",
                "RewriteCond %{QUERY_STRING} ^to=([a-z]+)$\n",
                "RewriteCond %{HTTP_HOST} !^(public)\\. [OR]\n",
                "RewriteCond %{REQUEST_METHOD} =GET\n",
                "RewriteRule ^go$ /%1 [L]\n",
                "RewriteRule ^secret$ - [F]\n",
            ),
        )];
        assert_eq!(
            [("to=secret", "public.example"), ("to=secret", "localhost"), ("to=public", "public.example")]
                .map(|(query, host)| refusal_of(&backrefs, "GET", "/go", query, host)),
            [403, 403, 0]
        );
    }

    // The same cases as "the two hosts close a directory whose section tags are malformed" in
    // apps/softn-host-php/tests/container-backend.test.mjs and in the browser's reader. Apache
    // will not load a file with a section tag like these and answers 500 for everything under
    // the directory; all three readers took `</Files >` and `<Files "secret.txt"` for the tags
    // they look like.
    #[test]
    fn the_two_hosts_close_a_directory_whose_section_tags_are_malformed() {
        let get = |source: &str, path: &str| htaccess_refusal(&[("", source)], &["index.php"], ("GET", path, "", "localhost", &[]));
        let malformed = [
            // An opening tag without its `>`, one with a `>` among its arguments and none at the
            // end, one whose name runs into its argument, and one in a section not evaluated.
            "<Files \"secret.txt\"\nRequire all denied\n</Files>\n",
            "<FilesMatch \"\\.inc$\"\nDeny from all\n</FilesMatch>\n",
            "<IfModule mod_rewrite.c\nRewriteEngine On\n</IfModule>\n",
            "<IfVersion >= 2.4\n</IfVersion>\n",
            "<Files\"secret.txt\">\nRequire all denied\n</Files>\n",
            "<If \"true\">\n<Files \"secret.txt\"\n</Files>\n</If>\n",
            // A closing tag that is not `</Name>`: a space before its `>`, no `>`, a space after its `<`.
            "<Files \"secret.txt\">\nRequire all denied\n</Files >\n",
            "<Files \"secret.txt\">\nRequire all denied\n</Files\n",
            "<IfModule a>\n</IfModule >\n",
            "</ Files>\nOptions -Indexes\n",
            // Words after a tag's `>`. Apache passes over them after some tags and not others;
            // here a tag is its whole line.
            "<Files \"secret.txt\"> # private\nRequire all denied\n</Files>\n",
            "<Files \"secret.txt\">\nRequire all denied\n</Files> # private\n",
        ];
        let read_anyway: Vec<&str> = malformed
            .into_iter()
            .filter(|source| ["/index.php", "/secret.txt", "/assets/app.css", "/"].iter().any(|path| get(source, path) != 403))
            .collect();
        assert!(read_anyway.is_empty(), "not refused everything under: {read_anyway:#?}");
        // Spaces before an opening tag's `>`, a tab after its name, a `>` among its arguments or
        // in its pattern, and a name with its `>` alone, are tags Apache reads, and so are they here.
        for source in [
            "<Files \"secret.txt\" >\nRequire all denied\n</Files>\n",
            "<Files\t\"secret.txt\">\nRequire all denied\n</Files>\n",
            "<IfVersion >= 2.4>\n<Files \"secret.txt\">\nRequire all denied\n</Files>\n</IfVersion>\n",
            "<FilesMatch \"^secret>?\\.txt$\">\nRequire all denied\n</FilesMatch>\n",
            "<If \"true\">\n</If>\n<Else>\nRequire all denied\n</Else>\n<Files \"secret.txt\">\nRequire all denied\n</Files>\n",
        ] {
            assert_eq!([get(source, "/secret.txt"), get(source, "/index.php")], [403, 0], "{source:?}");
        }
    }

    // The same cases as "the two hosts close a directory whose <Files> pattern is too long" in
    // apps/softn-host-php/tests/container-backend.test.mjs and in the browser's reader. A
    // `<FilesMatch>` or `<Files ~>` pattern was held to 1024 bytes here, 256 characters on the
    // Node host and 512 in the browser, and a `<Files>` name to 256 bytes here and characters
    // there, and one past the limit denied nothing.
    #[test]
    fn the_two_hosts_close_a_directory_whose_files_pattern_is_too_long() {
        let get = |source: &str, path: &str| htaccess_refusal(&[("", source)], &["index.php"], ("GET", path, "", "localhost", &[]));
        let regex_of = |padding: &str| format!("^secret\\.txt$|^{padding}$");
        let files_match = |pattern: &str| format!("<FilesMatch \"{pattern}\">\nRequire all denied\n</FilesMatch>\n");
        let tilde = |pattern: &str| format!("<Files ~ \"{pattern}\">\nRequire all denied\n</Files>\n");
        let files = |name: &str| format!("<Files \"{name}\">\nRequire all denied\n</Files>\n");
        // 512 bytes, in ASCII and in two-byte characters, and a byte more.
        let (fits, fits_short) = (regex_of(&"a".repeat(496)), regex_of(&"é".repeat(248)));
        let (over, over_short) = (regex_of(&"a".repeat(497)), regex_of(&format!("a{}", "é".repeat(248))));
        let (name, name_short) = (format!("{}.txt", "a".repeat(508)), format!("{}.txt", "é".repeat(254)));
        let (long_name, long_name_short) = (format!("{}.txt", "a".repeat(509)), format!("a{}.txt", "é".repeat(254)));
        assert_eq!(
            [&fits, &fits_short, &over, &over_short, &name, &name_short, &long_name, &long_name_short].map(|p| (p.len(), p.chars().count())),
            [(512, 512), (512, 264), (513, 513), (513, 265), (512, 512), (512, 258), (513, 513), (513, 259)]
        );

        // A pattern of 512 bytes is read: it names what it names, and nothing else.
        let read = [
            ("<FilesMatch> of 512 bytes", files_match(&fits), "/secret.txt".to_owned()),
            ("<FilesMatch> of 512 bytes in 264 characters", files_match(&fits_short), "/secret.txt".to_owned()),
            ("<Files ~> of 512 bytes", tilde(&fits), "/secret.txt".to_owned()),
            ("<Files ~> of 512 bytes in 264 characters", tilde(&fits_short), "/secret.txt".to_owned()),
            ("<Files> of 512 bytes", files(&name), format!("/{name}")),
            ("<Files> of 512 bytes in 258 characters", files(&name_short), format!("/{name_short}")),
        ];
        let misread: Vec<&str> = read
            .iter()
            .filter(|(_, source, named)| [get(source, named), get(source, "/index.php")] != [403, 0])
            .map(|(label, ..)| *label)
            .collect();

        // One a byte longer, or far longer, refuses everything under the directory.
        let closing = [
            ("<FilesMatch> of 513 bytes", files_match(&over)),
            ("<FilesMatch> of 513 bytes in 265 characters", files_match(&over_short)),
            ("<FilesMatch> of 2000 bytes", files_match(&"a".repeat(2000))),
            ("<Files ~> of 513 bytes", tilde(&over)),
            ("<Files ~> of 513 bytes in 265 characters", tilde(&over_short)),
            ("<Files> of 513 bytes", files(&long_name)),
            ("<Files> of 513 bytes in 259 characters", files(&long_name_short)),
        ];
        let read_anyway: Vec<&str> = closing
            .iter()
            .filter(|(_, source)| ["/index.php", "/secret.txt", "/assets/app.css", "/"].iter().any(|path| get(source, path) != 403))
            .map(|(label, _)| *label)
            .collect();
        assert!(
            misread.is_empty() && read_anyway.is_empty(),
            "not read as written: {misread:?}; not refused everything under: {read_anyway:?}"
        );

        // Not read in a section that is not evaluated, and so not held to the limit.
        assert_eq!(get(&format!("<If \"true\">\n{}</If>\n", files_match(&"a".repeat(2000))), "/index.php"), 0);
    }
}
