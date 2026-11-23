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

use base64::Engine as _;
use regex::Regex;
use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
use rusqlite::limits::Limit;
use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{params_from_iter, Connection};
use serde_json::{json, Value};
use zipp_vm::embed::{HostValue, HostValueBudget, JsValue, ScriptGoal, ScriptState};
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

/// Check whether a path is a private/backend file that must NEVER be downloaded statically.
pub fn is_private_static_path(rel_path: &str) -> bool {
    let clean = normalize_vfs_key(rel_path);
    let lower = clean.to_ascii_lowercase();
    if lower.is_empty() {
        return false;
    }
    if lower == "manifest.json"
        || lower == "permission.json"
        || lower == ".git"
        || lower.starts_with(".git/")
        || lower.starts_with("server/")
        || lower.starts_with("backend/")
        || lower.starts_with("private/")
        || lower.contains("/.git/")
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
        ".php", ".phtml", ".inc", ".tpl", ".rs", ".db", ".db-wal", ".db-shm", ".db-journal",
        ".sqlite", ".sqlite3", ".sql", ".ini", ".bak", ".log", ".sh", ".logic",
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

#[derive(Clone, Default)]
struct ParsedHtaccess {
    dir_prefix: String,
    rewrite_engine: bool,
    rewrite_base: Option<String>,
    directory_index: Vec<String>,
    deny_files: Vec<Regex>,
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
    let spec = if nocase {
        format!("(?i){pattern}")
    } else {
        pattern.to_owned()
    };
    Regex::new(&spec).ok()
}

fn parse_htaccess(source: &str, dir_prefix: &str) -> ParsedHtaccess {
    let mut out = ParsedHtaccess {
        dir_prefix: normalize_vfs_key(dir_prefix),
        ..Default::default()
    };
    let mut pending_conds: Vec<HtaccessCond> = Vec::new();
    let mut in_files_match: Option<Regex> = None;
    let mut files_match_denied = false;

    for raw_line in source.lines() {
        let trimmed = raw_line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let lower = trimmed.to_ascii_lowercase();
        if lower.starts_with("<filesmatch") && trimmed.ends_with('>') {
            let inner = trimmed[11..trimmed.len() - 1]
                .trim()
                .trim_matches(|c| c == '"' || c == '\'');
            in_files_match = compile_apache_regex(inner, true);
            files_match_denied = false;
            continue;
        }
        if lower == "</filesmatch>" {
            if let Some(rx) = in_files_match.take() {
                if files_match_denied {
                    out.deny_files.push(rx);
                }
            }
            files_match_denied = false;
            continue;
        }
        if in_files_match.is_some() {
            if lower.starts_with("deny from all") || lower.starts_with("require all denied") {
                files_match_denied = true;
            }
            continue;
        }
        if lower.starts_with("<ifmodule")
            || lower.starts_with("</ifmodule")
            || lower.starts_with("<files")
            || lower.starts_with("</files")
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
            "rewritecond" if tokens.len() >= 3 => {
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
                pending_conds.push(HtaccessCond {
                    test_string,
                    pattern,
                    negated,
                    nocase,
                    or_next,
                });
            }
            "rewriterule" if tokens.len() >= 3 => {
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

fn vfs_has_file(vfs: &HashMap<String, Vec<u8>>, rel: &str) -> bool {
    vfs.contains_key(&normalize_vfs_key(rel))
}

fn vfs_has_dir(vfs: &HashMap<String, Vec<u8>>, rel: &str) -> bool {
    let clean = normalize_vfs_key(rel);
    if clean.is_empty() {
        return true;
    }
    let prefix = format!("{clean}/");
    vfs.keys().any(|k| k.starts_with(&prefix))
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
    let bytes = expr.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if i + 2 < bytes.len() && bytes[i] == b'%' && bytes[i + 1] == b'{' {
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
                        if let Some(v) = headers.get(&key) {
                            out.push_str(v);
                        }
                    }
                    _ => {}
                }
                i += 3 + end;
                continue;
            }
        }
        out.push(bytes[i] as char);
        i += 1;
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
    let mut prefixes = vec![String::new()];
    let mut acc = String::new();
    for seg in clean.trim_start_matches('/').split('/').filter(|s| !s.is_empty()) {
        if !acc.is_empty() {
            acc.push('/');
        }
        acc.push_str(seg);
        if htaccess_map.contains_key(&acc) {
            prefixes.push(acc.clone());
        }
    }

    let mut cur_path = clean;
    let mut cur_query = query.to_owned();

    for prefix in prefixes {
        let Some(ht) = htaccess_map.get(&prefix) else {
            continue;
        };
        if !ht.deny_files.is_empty() {
            let trimmed = cur_path.trim_matches('/');
            let segs: Vec<&str> = trimmed.split('/').filter(|s| !s.is_empty()).collect();
            if let Some(&last_seg) = segs.last() {
                if ht.deny_files.iter().any(|rx| rx.is_match(last_seg)) {
                    return HtaccessEval::Deny(403);
                }
            }
            let mut probe = String::new();
            for &seg in segs.iter().take(segs.len().saturating_sub(1)) {
                if !probe.is_empty() {
                    probe.push('/');
                }
                probe.push_str(seg);
                if vfs.contains_key(&probe) && ht.deny_files.iter().any(|rx| rx.is_match(seg)) {
                    return HtaccessEval::Deny(403);
                }
            }
        }
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
                    "-d" => vfs_has_dir(vfs, &test_val),
                    "-l" | "-L" => false,
                    pat if pat.starts_with('=') => {
                        let rhs = &pat[1..];
                        if cond.nocase {
                            test_val.eq_ignore_ascii_case(rhs)
                        } else {
                            test_val == rhs
                        }
                    }
                    pat => {
                        if let Some(rx) = compile_apache_regex(pat, cond.nocase) {
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
            let expanded = expand_apache_vars(
                &apply_backrefs(&rule.substitution, &rule_groups, &last_cond_groups),
                &rel_probe,
                &cur_path,
                &cur_query,
                method,
                host,
                https,
                headers,
            );
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
            let next_full = if sub_path.starts_with('/') {
                sub_path.to_owned()
            } else if let Some(base) = &ht.rewrite_base {
                let b = base.trim_end_matches('/');
                format!("{b}/{sub_path}")
            } else {
                format!("{prefix_slashes}{sub_path}")
            }
            .replace("//", "/");

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
            if rule.last {
                break;
            }
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
        self.databases.iter().any(|cfg| {
            let target = cfg.file.as_deref().unwrap_or(&cfg.name);
            matches!(self.resolve_db_path(target), Ok(Some(cfg_path)) if cfg_path == path)
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

    fn open_configured_connection(path: Option<&Path>) -> Result<Connection, String> {
        let mut conn = match path {
            Some(p) => Connection::open(p).map_err(|e| format!("Cannot open SQLite DB: {e}"))?,
            None => Connection::open_in_memory().map_err(|e| format!("Cannot open memory SQLite DB: {e}"))?,
        };
        conn.busy_timeout(Duration::from_secs(5))
            .map_err(|e| format!("Cannot configure SQLite timeout: {e}"))?;
        let pragmas = if path.is_some() {
            "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL; PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY; PRAGMA max_page_count=131072;"
        } else {
            "PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY;"
        };
        conn.execute_batch(pragmas)
            .map_err(|e| format!("Cannot configure SQLite pragmas: {e}"))?;
        conn.set_limit(Limit::SQLITE_LIMIT_LENGTH, MAX_SQL_RESULT_BYTES as i32);
        conn.set_limit(Limit::SQLITE_LIMIT_SQL_LENGTH, 512 * 1024);
        conn.set_limit(Limit::SQLITE_LIMIT_COLUMN, 256);
        conn.set_limit(Limit::SQLITE_LIMIT_ATTACHED, 0);
        conn.set_limit(Limit::SQLITE_LIMIT_VARIABLE_NUMBER, 999);
        conn.set_limit(Limit::SQLITE_LIMIT_EXPR_DEPTH, 128);
        conn.set_limit(Limit::SQLITE_LIMIT_VDBE_OP, 250_000);
        conn.set_limit(Limit::SQLITE_LIMIT_WORKER_THREADS, 0);
        conn.set_limit(Limit::SQLITE_LIMIT_LIKE_PATTERN_LENGTH, LIKE_PATTERN_LIMIT);
        // Install SQLite semantic authorizer blocking host-filesystem ATTACH/DETACH,
        // extension loading, and unsafe PRAGMAs (e.g. trusted_schema, writable_schema, max_page_count).
        conn.authorizer(Some(|ctx: AuthContext<'_>| match ctx.action {
            AuthAction::Attach { .. } | AuthAction::Detach { .. } => Authorization::Deny,
            AuthAction::Function { function_name }
                if function_name.eq_ignore_ascii_case("load_extension")
                    || function_name.eq_ignore_ascii_case("fts3_tokenizer") =>
            {
                Authorization::Deny
            }
            AuthAction::Pragma { pragma_name, .. } => {
                let lower = pragma_name.to_ascii_lowercase();
                if matches!(
                    lower.as_str(),
                    "table_info"
                        | "table_xinfo"
                        | "index_list"
                        | "index_info"
                        | "foreign_key_list"
                        | "foreign_keys"
                        | "database_list"
                        | "user_version"
                        | "application_id"
                        | "schema_version"
                        | "busy_timeout"
                        | "synchronous"
                        | "journal_mode"
                        | "cache_size"
                        | "encoding"
                        | "integrity_check"
                        | "quick_check"
                        | "compile_options"
                        | "page_count"
                        | "page_size"
                        | "freelist_count"
                        | "wal_checkpoint"
                ) {
                    Authorization::Allow
                } else {
                    Authorization::Deny
                }
            }
            _ => Authorization::Allow,
        }))
        .map_err(|e| format!("Cannot install SQLite authorizer: {e}"))?;
        Ok(conn)
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
            // Copy bundled `.db` file if present and DB file doesn't exist yet
            if !path.exists() {
                if let Some(file_key) = cfg.file.as_deref() {
                    let norm = normalize_vfs_key(file_key);
                    if let Some(bytes) = vfs.get(&norm) {
                        fs::write(&path, bytes)
                            .map_err(|e| format!("Failed to unpack bundled DB {norm}: {e}"))?;
                    }
                }
            }
            let conn = Self::open_configured_connection(Some(&path))?;
            if let Some(seed_sql) = &cfg.seed_sql {
                let norm = normalize_vfs_key(seed_sql);
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
                        let norm = normalize_vfs_key(s);
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

    for (table_name, rows_val) in tables {
        let Some(rows) = rows_val.as_array() else {
            continue;
        };
        if rows.is_empty() {
            continue;
        }
        let quoted_table = sanitize_ident(table_name)?;
        let mut col_names: Vec<String> = Vec::new();
        for row in rows {
            if let Some(obj) = row.as_object() {
                for k in obj.keys() {
                    if !col_names.contains(k) {
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
}

struct RequestSqlBridge {
    config: SqlStorageConfig,
    handles: HashMap<u64, Connection>,
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

    fn call(&mut self, kind: &str, args: &[String]) -> String {
        if self.abort.load(Ordering::Relaxed) {
            return json!({ "error": "Request timed out", "code": 9, "unique": false }).to_string();
        }
        let op = kind.strip_prefix("app.sql.").unwrap_or(kind);
        let arg = |idx: usize| args.get(idx).map(String::as_str).unwrap_or("");
        match op {
            "open" => {
                match self.config.resolve_db_path(arg(0)) {
                    Ok(path) => match SqlStorageConfig::open_configured_connection(path.as_deref()) {
                        Ok(mut conn) => {
                            let abort = self.abort.clone();
                            conn.progress_handler(
                                1000,
                                Some(move || abort.load(Ordering::Relaxed)),
                            );
                            let id = self.next_id;
                            self.next_id += 1;
                            self.handles.insert(id, conn);
                            json!({ "id": id }).to_string()
                        }
                        Err(e) => classify_sqlite_error(&e).to_string(),
                    },
                    Err(e) => classify_sqlite_error(&e).to_string(),
                }
            }
            "execute" => {
                let id = arg(0).parse::<u64>().unwrap_or(0);
                let sql = arg(1);
                let params_raw = arg(2).trim();
                let Some(conn) = self.handles.get(&id) else {
                    return json!({ "error": format!("invalid sqlite connection handle {id}"), "code": 21, "unique": false }).to_string();
                };
                match Self::run_execute(conn, sql, params_raw) {
                    Ok(v) => v.to_string(),
                    Err(e) => classify_sqlite_error(&e).to_string(),
                }
            }
            "query" => {
                let id = arg(0).parse::<u64>().unwrap_or(0);
                let sql = arg(1);
                let params_raw = arg(2).trim();
                let Some(conn) = self.handles.get(&id) else {
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
                let Some(conn) = self.handles.get(&id) else {
                    return json!({ "error": format!("invalid sqlite connection handle {id}"), "code": 21, "unique": false }).to_string();
                };
                match apply_seed_json(conn, payload) {
                    Ok(v) => v.to_string(),
                    Err(e) => classify_sqlite_error(&e).to_string(),
                }
            }
            "copy" => {
                let from = arg(0);
                let to = arg(1);
                match (self.config.resolve_db_path(from), self.config.resolve_exact_db_path(to)) {
                    (Ok(Some(src)), Ok(Some(dst))) => {
                        if src == dst {
                            let bytes = fs::metadata(&src).map(|m| m.len()).unwrap_or(0);
                            return json!({ "bytes": bytes }).to_string();
                        }
                        match fs::copy(&src, &dst) {
                            Ok(bytes) => json!({ "bytes": bytes }).to_string(),
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
                match self.config.resolve_exact_db_path(target) {
                    Ok(Some(path)) => {
                        if self.config.is_configured_db_path(&path) {
                            return json!({ "error": "cannot remove configured primary database", "code": 1, "unique": false }).to_string();
                        }
                        if path.exists() {
                            let removed = fs::remove_file(&path).is_ok();
                            json!({ "ok": true, "removed": removed }).to_string()
                        } else {
                            json!({ "ok": true, "removed": false }).to_string()
                        }
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

    fn run_execute(conn: &Connection, sql: &str, params_raw: &str) -> Result<Value, String> {
        let no_params = params_raw.is_empty() || params_raw == "[]" || params_raw == "{}" || params_raw == "null";
        if no_params {
            // Check if multi-statement batch (e.g. PHP PDO::exec running DDL migrations)
            if sql.matches(';').count() > 1 {
                conn.execute_batch(sql).map_err(|e| e.to_string())?;
                return Ok(json!({
                    "rows_affected": conn.changes(),
                    "last_insert_rowid": conn.last_insert_rowid(),
                }));
            }
        }
        let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
        Self::bind_params(&mut stmt, params_raw)?;
        let rows_affected = stmt.raw_execute().map_err(|e| e.to_string())?;
        Ok(json!({
            "rows_affected": rows_affected,
            "last_insert_rowid": conn.last_insert_rowid(),
        }))
    }

    fn run_query(conn: &Connection, sql: &str, params_raw: &str) -> Result<Value, String> {
        let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
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

fn load_php_overlay(path: &Path) -> PhpVfsOverlay {
    let Ok(text) = fs::read_to_string(path) else {
        return PhpVfsOverlay::default();
    };
    let Ok(val) = serde_json::from_str::<Value>(&text) else {
        return PhpVfsOverlay::default();
    };
    let mut ov = PhpVfsOverlay::default();
    if let Some(writes) = val.get("writes").and_then(|v| v.as_object()) {
        for (k, v) in writes {
            if let Some(b64) = v.as_str() {
                if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(b64) {
                    if ov.total_bytes.saturating_add(bytes.len()) <= MAX_OVERLAY_BYTES {
                        ov.total_bytes += bytes.len();
                        ov.writes.insert(normalize_vfs_key(k), bytes);
                    }
                }
            }
        }
    }
    if let Some(deleted) = val.get("deleted").and_then(|v| v.as_array()) {
        for item in deleted {
            if let Some(s) = item.as_str() {
                ov.deleted.insert(normalize_vfs_key(s));
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

fn save_php_overlay(path: &Path, overlay: &PhpVfsOverlay) {
    if overlay.writes.is_empty() && overlay.deleted.is_empty() && overlay.dirs.is_empty() {
        return;
    }
    let mut writes = serde_json::Map::new();
    for (k, bytes) in &overlay.writes {
        writes.insert(
            k.clone(),
            Value::String(base64::engine::general_purpose::STANDARD.encode(bytes)),
        );
    }
    let payload = json!({
        "writes": writes,
        "deleted": overlay.deleted.iter().collect::<Vec<_>>(),
        "dirs": overlay.dirs.iter().collect::<Vec<_>>(),
    });
    if let Ok(bytes) = serde_json::to_vec(&payload) {
        let tmp = path.with_extension("json.tmp");
        if fs::write(&tmp, &bytes).is_ok() {
            let _ = fs::rename(&tmp, path);
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
    if let Some(arr) = val.as_array() {
        for item in arr {
            if let Some(pair) = item.as_array() {
                if pair.len() >= 2 {
                    if let (Some(k), Some(v)) = (pair[0].as_str(), pair[1].as_str()) {
                        out.push((k.to_owned(), v.to_owned()));
                    }
                }
            }
        }
    } else if let Some(obj) = val.as_object() {
        for (k, v) in obj {
            if let Some(s) = v.as_str() {
                out.push((k.clone(), s.to_owned()));
            }
        }
    }
    out
}

fn execute_php_request(
    req: &ContainerHttpRequest,
    backend: &ContainerBackendConfig,
    vfs: &Arc<HashMap<String, Vec<u8>>>,
    overlay: &Arc<Mutex<PhpVfsOverlay>>,
    htaccess_map: &HashMap<String, ParsedHtaccess>,
    sql_cfg: &SqlStorageConfig,
    abort: Arc<AtomicBool>,
) -> ContainerHttpResponse {
    let mut lower_headers = HashMap::new();
    for (k, v) in &req.headers {
        lower_headers.insert(k.to_ascii_lowercase(), v.clone());
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

    if !htaccess_map.is_empty() {
        match evaluate_htaccess_chain(
            htaccess_map,
            &target_path,
            &target_query,
            &req.method,
            &req.host,
            req.https,
            &lower_headers,
            vfs,
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
    let is_private_dir = rel_lower.starts_with("server/")
        || rel_lower.starts_with("backend/")
        || rel_lower.starts_with("private/");
    let entry_key = normalize_vfs_key(&backend.entry);
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
                body: format!("PHP Backend Error: {err}").into_bytes(),
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
            body: format!("Sandbox limit exceeded: {err}").into_bytes(),
        };
    }
    if let Err(err) = init_res {
        tracing::error!("ZIPP PHP runtime error: {err}");
        return ContainerHttpResponse {
            status: 500,
            headers: vec![("Content-Type".into(), "text/plain; charset=utf-8".into())],
            body: if raw_bytes.is_empty() {
                format!("PHP Backend Error: {err}").into_bytes()
            } else {
                raw_bytes
            },
        };
    }

    let meta: Value = serde_json::from_str(&meta_json).unwrap_or_else(|_| json!({ "status": 200 }));
    let status = meta
        .get("status")
        .and_then(|v| v.as_u64())
        .and_then(|n| u16::try_from(n).ok())
        .filter(|c| (100..600).contains(c))
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
                body: format!("Backend compile error: {err}").into_bytes(),
            };
        }
    };

    harden_script_state(&mut st, REQUEST_STEP_BUDGET, abort.clone());
    let mut sql_bridge = RequestSqlBridge::new(sql_cfg.clone(), abort);
    st.set_host_call(Box::new(move |k, args| Ok(sql_bridge.call(k, args))));

    if let Err(err) = st.run_init() {
        let limit = st.resource_limit_error().map(|s| s.to_owned());
        return ContainerHttpResponse {
            status: if limit.is_some() { 503 } else { 500 },
            headers: vec![("Content-Type".into(), "text/plain; charset=utf-8".into())],
            body: format!("Backend init error: {}", limit.unwrap_or(err)).into_bytes(),
        };
    }

    if kind == BackendRuntimeKind::Python {
        if let Err(err) = st.eval_in_context(PYTHON_SQLITE_BRIDGE_JS) {
            return ContainerHttpResponse {
                status: 500,
                headers: vec![("Content-Type".into(), "text/plain; charset=utf-8".into())],
                body: format!("Python SQLite bridge init error: {err}").into_bytes(),
            };
        }
    }

    let mut headers_obj = serde_json::Map::new();
    for (k, v) in &req.headers {
        headers_obj.insert(k.to_ascii_lowercase(), Value::String(v.clone()));
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
            return ContainerHttpResponse {
                status: 503,
                headers: vec![("Content-Type".into(), "text/plain; charset=utf-8".into())],
                body: format!("Sandbox limit exceeded: {limit}").into_bytes(),
            };
        }
        match res {
            Ok(HostValue::String(s)) => s,
            Ok(_) => {
                return ContainerHttpResponse {
                    status: 500,
                    headers: vec![("Content-Type".into(), "text/plain; charset=utf-8".into())],
                    body: b"Python backend dispatch returned non-string response".to_vec(),
                };
            }
            Err(err) => {
                return ContainerHttpResponse {
                    status: 500,
                    headers: vec![("Content-Type".into(), "text/plain; charset=utf-8".into())],
                    body: format!("Python backend error: {err:?}").into_bytes(),
                };
            }
        }
    } else {
        let call_res = st.call_global(dispatch_fn, &[JsValue::String(req_json)]);
        if let Some(limit) = st.resource_limit_error() {
            return ContainerHttpResponse {
                status: 503,
                headers: vec![("Content-Type".into(), "text/plain; charset=utf-8".into())],
                body: format!("Sandbox limit exceeded: {limit}").into_bytes(),
            };
        }
        match call_res {
            Ok(JsValue::String(s)) => s,
            Ok(_) => {
                return ContainerHttpResponse {
                    status: 500,
                    headers: vec![("Content-Type".into(), "text/plain; charset=utf-8".into())],
                    body: b"Backend dispatch returned non-string response".to_vec(),
                };
            }
            Err(err) => {
                return ContainerHttpResponse {
                    status: 500,
                    headers: vec![("Content-Type".into(), "text/plain; charset=utf-8".into())],
                    body: format!("Backend error: {err}").into_bytes(),
                };
            }
        }
    };

    let parsed: Value = serde_json::from_str(&raw_resp).unwrap_or_else(|_| json!({ "status": 500, "body": raw_resp }));
    let status = parsed
        .get("status")
        .and_then(|v| v.as_u64())
        .and_then(|n| u16::try_from(n).ok())
        .filter(|c| (100..600).contains(c))
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

    ContainerHttpResponse {
        status,
        headers,
        body,
    }
}

struct WarmRustWorker {
    state: ScriptState,
    dispatch_slot: u32,
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
                    continue;
                }
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
            allow_vfs_write: true,
            allow_native_fs: false,
            allow_net: false,
            stream_stdout: false,
            mode: "worker_boot".to_owned(),
        };
        let mut st = compile_rust_program(&entry_source, config)?.into_state();
        harden_script_state(&mut st, BOOT_STEP_BUDGET, abort.clone());
        let mut sql_bridge = RequestSqlBridge::new(sql_cfg.clone(), abort);
        st.set_host_call(Box::new(move |kind, args| Ok(sql_bridge.call(kind, args))));
        st.run_init()?;

        let dispatch_slot = st
            .symbols()
            .into_iter()
            .find(|s| s.name == "__zipp_rs_worker_request")
            .map(|s| s.index)
            .ok_or_else(|| "Rust worker did not register __zipp_rs_worker_request".to_owned())?;

        Ok(Self {
            state: st,
            dispatch_slot,
        })
    }

    fn dispatch(&mut self, req: &ContainerHttpRequest, abort: Arc<AtomicBool>) -> ContainerHttpResponse {
        harden_script_state(&mut self.state, REQUEST_STEP_BUDGET, abort);
        let uri = if req.query.is_empty() {
            req.path.clone()
        } else {
            format!("{}?{}", req.path, req.query)
        };
        let mut headers_obj = serde_json::Map::new();
        for (k, v) in &req.headers {
            headers_obj.insert(k.to_ascii_lowercase(), Value::String(v.clone()));
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
        if let Some(limit) = self.state.resource_limit_error() {
            return ContainerHttpResponse {
                status: 503,
                headers: vec![("Content-Type".into(), "text/plain; charset=utf-8".into())],
                body: format!("Sandbox limit exceeded: {limit}").into_bytes(),
            };
        }
        let raw = match res {
            Ok(HostValue::String(s)) => s,
            Ok(_) => {
                return ContainerHttpResponse {
                    status: 500,
                    headers: vec![("Content-Type".into(), "text/plain; charset=utf-8".into())],
                    body: b"Rust worker returned non-string response".to_vec(),
                };
            }
            Err(err) => {
                return ContainerHttpResponse {
                    status: 500,
                    headers: vec![("Content-Type".into(), "text/plain; charset=utf-8".into())],
                    body: format!("Rust backend error: {err:?}").into_bytes(),
                };
            }
        };
        let parsed: Value = serde_json::from_str(&raw).unwrap_or_else(|_| json!({ "status": 500, "body": raw }));
        let status = parsed
            .get("status")
            .and_then(|v| v.as_u64())
            .and_then(|n| u16::try_from(n).ok())
            .filter(|c| (100..600).contains(c))
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
        ContainerHttpResponse {
            status,
            headers,
            body,
        }
    }
}

// ── Public Multi-User Container Backend Runtime ──

pub struct ContainerBackendRuntime {
    #[allow(dead_code)]
    pub runtime_kind: BackendRuntimeKind,
    pub mode: String,
    pub routes: Vec<String>,
    pub frontend_root: Option<String>,
    pub main_file: Option<String>,
    pub ssr_entry: bool,
    vfs: Arc<HashMap<String, Vec<u8>>>,
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
        let entry_key = normalize_vfs_key(&backend.entry);
        if !vfs.contains_key(&entry_key) {
            return Err(format!(
                "Container backend entry '{}' not found in bundle",
                backend.entry
            ));
        }

        let sql_cfg = SqlStorageConfig {
            db_dir: data_dir.join("databases"),
            databases: manifest.databases.clone().unwrap_or_default(),
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
        let php_overlay = Arc::new(Mutex::new(load_php_overlay(&overlay_path)));

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

        // Pre-validate Rust backend on startup (first worker boots eagerly; fail fast if broken)
        let mut startup_err: Option<String> = None;
        for idx in 0..worker_count {
            let rx = rx.clone();
            let vfs = Arc::clone(&vfs);
            let backend_cfg = backend.clone();
            let htaccess_arc = Arc::clone(&htaccess_arc);
            let php_overlay = Arc::clone(&php_overlay);
            let overlay_path = overlay_path.clone();
            let sql_cfg = sql_cfg.clone();
            let entry_source = Arc::clone(&entry_source_arc);

            let abort = Arc::new(AtomicBool::new(false));
            let deadline_ms = Arc::new(AtomicU64::new(0));
            watches.lock().unwrap().push(WorkerWatch {
                abort: Arc::clone(&abort),
                deadline_ms: Arc::clone(&deadline_ms),
            });

            let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();
            let spawn_res = thread::Builder::new()
                .name(format!("zipp-container-{}-{idx}", runtime_kind.as_str()))
                .stack_size(16 * 1024 * 1024)
                .spawn(move || {
                    let mut rust_worker: Option<WarmRustWorker> = if runtime_kind == BackendRuntimeKind::Rust {
                        match WarmRustWorker::boot(&backend_cfg, &vfs, &sql_cfg, Arc::clone(&abort)) {
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
                        abort.store(false, Ordering::SeqCst);
                        deadline_ms.store(mono_ms() + WALL_TIME_MS, Ordering::SeqCst);

                        let resp = match runtime_kind {
                            BackendRuntimeKind::Php => {
                                let out = execute_php_request(
                                    &job.req,
                                    &backend_cfg,
                                    &vfs,
                                    &php_overlay,
                                    &htaccess_arc,
                                    &sql_cfg,
                                    Arc::clone(&abort),
                                );
                                if let Ok(ov) = php_overlay.lock() {
                                    save_php_overlay(&overlay_path, &ov);
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
                                    w.dispatch(&job.req, Arc::clone(&abort))
                                } else {
                                    ContainerHttpResponse {
                                        status: 500,
                                        headers: vec![("Content-Type".into(), "text/plain".into())],
                                        body: b"Rust worker unavailable".to_vec(),
                                    }
                                }
                            }
                        };

                        deadline_ms.store(0, Ordering::SeqCst);
                        let _ = job.reply.send(resp);
                    }
                });
            if let Err(e) = spawn_res {
                startup_err = Some(format!("Failed to spawn container backend worker: {e}"));
                break;
            }
            match ready_rx.recv() {
                Ok(Ok(())) => {}
                Ok(Err(e)) => {
                    startup_err = Some(e);
                    break;
                }
                Err(_) => {
                    startup_err = Some("Container backend worker exited during startup".into());
                    break;
                }
            }
        }

        if let Some(err) = startup_err {
            return Err(err);
        }

        // Cooperative wall-time watchdog for all ZIPP sandbox workers
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
            frontend_root: manifest.frontend_root.as_deref().map(normalize_vfs_key).filter(|s| !s.is_empty()),
            main_file: manifest.main.as_deref().map(normalize_vfs_key).filter(|s| !s.is_empty()),
            ssr_entry: manifest.ssr_entry.unwrap_or(false),
            vfs,
            tx,
            stop_watchdog,
        })))
    }

    /// Resolve a public static asset path inside `frontendRoot` (or bundle root), refusing private files.
    pub fn resolve_static_asset(&self, req_path: &str) -> Result<Option<(&'static str, Vec<u8>)>, u16> {
        let rel = normalize_vfs_key(req_path);
        if !rel.is_empty() && is_private_static_path(&rel) {
            return Err(403);
        }

        let mut candidates: Vec<String> = Vec::new();
        if let Some(root) = &self.frontend_root {
            if rel.is_empty() {
                candidates.push(format!("{root}/index.html"));
                if let Some(main) = &self.main_file {
                    if !is_private_static_path(main) {
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
                if !is_private_static_path(main) {
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
            if is_private_static_path(&cand) {
                return Err(403);
            }
            if let Some(bytes) = self.vfs.get(&cand) {
                return Ok(Some((mime_type_for(&cand), bytes.clone())));
            }
        }

        // SPA fallback for extensionless routes in `api` mode (when an HTML entry exists)
        if self.mode == "api" && !self.ssr_entry {
            let last_seg = rel.rsplit('/').next().unwrap_or("");
            if !last_seg.contains('.') {
                let fallback = self
                    .main_file
                    .as_deref()
                    .filter(|m| !is_private_static_path(m) && (m.ends_with(".html") || m.ends_with(".htm")))
                    .map(str::to_owned)
                    .or_else(|| {
                        self.frontend_root
                            .as_ref()
                            .map(|r| format!("{r}/index.html"))
                            .filter(|p| self.vfs.contains_key(p))
                    })
                    .or_else(|| self.vfs.contains_key("index.html").then(|| "index.html".to_owned()));
                if let Some(html_path) = fallback {
                    if let Some(bytes) = self.vfs.get(&html_path) {
                        return Ok(Some(("text/html; charset=utf-8", bytes.clone())));
                    }
                }
            }
        }

        Ok(None)
    }

    /// Decide whether an HTTP request routes to the ZIPP-sandboxed backend or static frontend assets.
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
            })
            .await;
        assert_eq!(py_resp.status, 200, "py body: {}", String::from_utf8_lossy(&py_resp.body));
        let py_json: Value = serde_json::from_slice(&py_resp.body).unwrap();
        assert_eq!(py_json["count"], 1);
        assert_eq!(py_json["last"], "pong-from-python");

        let _ = fs::remove_dir_all(&root);
    }
}
