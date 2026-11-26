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

#[derive(Clone, Default)]
struct ParsedHtaccess {
    dir_prefix: String,
    rewrite_engine: bool,
    rewrite_base: Option<String>,
    directory_index: Vec<String>,
    deny_all: bool,
    deny_files: Vec<Regex>,
    redirect_matches: Vec<RedirectMatchRule>,
    rules: Vec<HtaccessRule>,
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
    if glob.len() > 256 {
        return None;
    }
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

fn parse_htaccess(source: &str, dir_prefix: &str) -> ParsedHtaccess {
    let mut out = ParsedHtaccess {
        dir_prefix: normalize_vfs_key(dir_prefix),
        ..Default::default()
    };
    let bounded_src = if source.len() > MAX_HTACCESS_BYTES {
        let mut end = MAX_HTACCESS_BYTES;
        while end > 0 && !source.is_char_boundary(end) {
            end -= 1;
        }
        &source[..end]
    } else {
        source
    };
    let mut pending_conds: Vec<HtaccessCond> = Vec::new();
    let mut in_files_block: Option<Regex> = None;
    let mut files_block_denied = false;

    for raw_line in bounded_src.lines() {
        let trimmed = raw_line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let lower = trimmed.to_ascii_lowercase();
        if lower.starts_with("<filesmatch") && trimmed.ends_with('>') {
            let inner = trimmed[11..trimmed.len() - 1]
                .trim()
                .trim_matches(|c| c == '"' || c == '\'');
            in_files_block = compile_apache_regex(inner, true);
            files_block_denied = false;
            continue;
        }
        if lower.starts_with("<files")
            && trimmed.ends_with('>')
            && trimmed.as_bytes().get(6).is_some_and(|b| b.is_ascii_whitespace())
        {
            let inner = trimmed[6..trimmed.len() - 1]
                .trim()
                .trim_matches(|c| c == '"' || c == '\'');
            in_files_block = compile_apache_glob(inner);
            files_block_denied = false;
            continue;
        }
        if lower == "</filesmatch>" || lower == "</files>" {
            if let Some(rx) = in_files_block.take() {
                if files_block_denied && out.deny_files.len() < MAX_HTACCESS_DENY {
                    out.deny_files.push(rx);
                }
            }
            files_block_denied = false;
            continue;
        }
        if in_files_block.is_some() {
            if lower.starts_with("deny from all") || lower.starts_with("require all denied") {
                files_block_denied = true;
            }
            continue;
        }
        if lower.starts_with("deny from all") || lower.starts_with("require all denied") {
            out.deny_all = true;
            continue;
        }
        if lower.starts_with("<ifmodule")
            || lower.starts_with("</ifmodule")
            || lower.starts_with("<directory")
            || lower.starts_with("</directory")
        {
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
            "redirectmatch" if tokens.len() >= 2 && out.redirect_matches.len() < MAX_HTACCESS_RULES => {
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
            "rewritecond" if tokens.len() >= 3 && pending_conds.len() < MAX_HTACCESS_CONDS => {
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
            "rewriterule" if tokens.len() >= 3 && out.rules.len() < MAX_HTACCESS_RULES => {
                let pat = &tokens[1];
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
            if ht.deny_all {
                return Some(HtaccessEval::Deny(403));
            }
            if !ht.deny_files.is_empty() {
                if let Some(&last_seg) = segs.last() {
                    if ht.deny_files.iter().any(|rx| rx.is_match(last_seg)) {
                        return Some(HtaccessEval::Deny(403));
                    }
                }
                let mut probe = String::new();
                for &seg in segs.iter().take(segs.len().saturating_sub(1)) {
                    if !probe.is_empty() {
                        probe.push('/');
                    }
                    probe.push_str(seg);
                    if vfs.contains_key(&probe) && ht.deny_files.iter().any(|rx| rx.is_match(seg)) {
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
                let Some(caps) = rule.regex.captures(&local_path) else {
                    continue;
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
                let rule_groups: Vec<String> = (1..caps.len())
                    .map(|idx| caps.get(idx).map(|m| m.as_str().to_owned()).unwrap_or_default())
                    .collect();
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
    let mut clean_writes = HashMap::with_capacity(ov.writes.len());
    let mut total = 0usize;
    let mut keys: Vec<String> = ov.writes.keys().cloned().collect();
    keys.sort();
    for k in keys {
        if let Some(bytes) = ov.writes.remove(&k) {
            let norm = normalize_vfs_key(&k);
            if is_protected_php_overlay_path(&norm, backend_entry) {
                continue;
            }
            if total.saturating_add(bytes.len()) <= MAX_OVERLAY_BYTES {
                total += bytes.len();
                clean_writes.insert(norm, bytes);
            }
        }
    }
    ov.writes = clean_writes;
    ov.total_bytes = total;
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

fn merge_and_save_php_overlay(
    path: &Path,
    shared_overlay: &Mutex<Arc<PhpVfsOverlay>>,
    initial: &PhpVfsOverlay,
    mut final_req: PhpVfsOverlay,
    backend_entry: &str,
    last_saved: &Mutex<Vec<u8>>,
) {
    sanitize_php_overlay(&mut final_req, backend_entry);
    // Fast path: if this request made no sanitized overlay changes, skip locking/encoding/disk I/O.
    if final_req.writes == initial.writes
        && final_req.deleted == initial.deleted
        && final_req.dirs == initial.dirs
    {
        return;
    }
    let Ok(mut shared_guard) = shared_overlay.lock() else {
        return;
    };
    let mut owned_copy: Option<PhpVfsOverlay> = None;
    let shared: &mut PhpVfsOverlay = match Arc::get_mut(&mut *shared_guard) {
        Some(ov) => ov,
        None => {
            owned_copy = Some(clone_php_overlay(&*shared_guard));
            owned_copy.as_mut().unwrap()
        }
    };
    // Apply deletions first to reclaim quota, then only accept new/updated writes that fit
    // within MAX_OVERLAY_BYTES so incoming writes can never alphabetically evict existing files.
    for k in initial.writes.keys() {
        if !final_req.writes.contains_key(k) {
            if let Some(old) = shared.writes.remove(k) {
                shared.total_bytes = shared.total_bytes.saturating_sub(old.len());
            }
        }
    }
    for d in &final_req.deleted {
        if !initial.deleted.contains(d) {
            shared.deleted.insert(d.clone());
            if let Some(old) = shared.writes.remove(d) {
                shared.total_bytes = shared.total_bytes.saturating_sub(old.len());
            }
        }
    }
    for d in &initial.deleted {
        if !final_req.deleted.contains(d) && !final_req.writes.contains_key(d) {
            shared.deleted.remove(d);
        }
    }
    for (k, v) in &final_req.writes {
        if initial.writes.get(k) != Some(v) {
            let old_len = shared.writes.get(k).map(Vec::len).unwrap_or(0);
            let next_total = shared
                .total_bytes
                .saturating_sub(old_len)
                .saturating_add(v.len());
            if next_total <= MAX_OVERLAY_BYTES {
                shared.writes.insert(k.clone(), v.clone());
                shared.total_bytes = next_total;
                shared.deleted.remove(k);
            }
        }
    }
    for d in &final_req.dirs {
        if !initial.dirs.contains(d) {
            shared.dirs.insert(d.clone());
        }
    }
    for d in &initial.dirs {
        if !final_req.dirs.contains(d) {
            shared.dirs.remove(d);
        }
    }
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
                let text = String::from_utf8_lossy(bytes);
                htaccess_map.insert(prefix.to_owned(), parse_htaccess(&text, prefix));
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
                                                &initial_ov,
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
}
