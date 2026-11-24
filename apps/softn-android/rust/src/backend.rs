//! In-process full-stack SoftN v2 Container Backend for Android & Mobile.
//!
//! Runs `manifest.backend` (PHP 8, JavaScript, TypeScript, Python, or Rust)
//! 100% natively inside `zipp-vm` (`safe-sandbox`) with persistent `rusqlite`
//! SQLite 3 storage in the app's private `filesDir`. Zero external binaries,
//! zero local HTTP sockets, 100% offline-capable.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, LazyLock, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use zipp_vm::embed::{HostValue, HostValueBudget, JsValue, ScriptGoal, ScriptState};
use zipp_vm::frontend::{
    compile_php_program, compile_rust_program, compile_source, Frontend, PhpProgramConfig,
    PhpVfsOverlay, PythonMode, RustProgramConfig,
};

use crate::bundle::{normalize_vfs_path, BackendConfig, SoftnBundle};
use crate::sql::{RequestSqlBridge, SqlStorage};

const REQUEST_STEP_BUDGET: u64 = 250_000_000;
const BOOT_STEP_BUDGET: u64 = 2_000_000_000;
const VM_HEAP_LIMIT: usize = 256 << 20;
const VM_OUTPUT_LIMIT: usize = 32 * 1024 * 1024;
const WALL_TIME_MS: u64 = 25_000;
const RUST_WORKER_RECV_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_OVERLAY_BYTES: usize = 16 * 1024 * 1024;
const MAX_OVERLAY_ENTRIES: usize = 4096;
const MAX_WS_OUTBOX: usize = 1024;

/// Shared zero-idle-wakeup wall-time watchdog for all sandboxed backend executions.
/// Sleeps indefinitely on a Condvar when no request is in flight and flips `abort` if a
/// backend VM exceeds `WALL_TIME_MS`.
struct WatchdogState {
    entries: Vec<(u64, Instant, Arc<AtomicBool>)>,
    next_id: u64,
}

struct SharedWatchdog {
    state: Mutex<WatchdogState>,
    cvar: Condvar,
}

static WATCHDOG: LazyLock<Arc<SharedWatchdog>> = LazyLock::new(|| {
    let wd = Arc::new(SharedWatchdog {
        state: Mutex::new(WatchdogState {
            entries: Vec::new(),
            next_id: 1,
        }),
        cvar: Condvar::new(),
    });
    let bg = Arc::clone(&wd);
    let _ = thread::Builder::new()
        .name("softn-backend-watchdog".into())
        .spawn(move || {
            let mut guard = bg.state.lock().unwrap_or_else(|e| e.into_inner());
            loop {
                if guard.entries.is_empty() {
                    guard = bg.cvar.wait(guard).unwrap_or_else(|e| e.into_inner());
                    continue;
                }
                let now = Instant::now();
                let mut next_deadline: Option<Instant> = None;
                guard.entries.retain(|(_, dl, abort)| {
                    if now >= *dl {
                        abort.store(true, Ordering::SeqCst);
                        false
                    } else {
                        next_deadline = Some(match next_deadline {
                            Some(cur) => cur.min(*dl),
                            None => *dl,
                        });
                        true
                    }
                });
                if let Some(dl) = next_deadline {
                    let wait = dl.saturating_duration_since(Instant::now());
                    if !wait.is_zero() {
                        let (g, _) = bg
                            .cvar
                            .wait_timeout(guard, wait)
                            .unwrap_or_else(|e| e.into_inner());
                        guard = g;
                    }
                }
            }
        });
    wd
});

pub(crate) struct WallDeadlineGuard {
    id: u64,
}

impl WallDeadlineGuard {
    pub(crate) fn arm(abort: Arc<AtomicBool>, timeout_ms: u64) -> Self {
        let wd = LazyLock::force(&WATCHDOG);
        let mut guard = wd.state.lock().unwrap_or_else(|e| e.into_inner());
        let id = guard.next_id;
        guard.next_id = guard.next_id.wrapping_add(1).max(1);
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        guard.entries.push((id, deadline, abort));
        wd.cvar.notify_one();
        Self { id }
    }
}

impl Drop for WallDeadlineGuard {
    fn drop(&mut self) {
        let wd = LazyLock::force(&WATCHDOG);
        let mut guard = wd.state.lock().unwrap_or_else(|e| e.into_inner());
        guard.entries.retain(|(id, _, _)| *id != self.id);
    }
}

#[derive(Debug, Clone)]
pub struct BackendHttpRequest {
    pub method: String,
    pub path: String,
    pub query: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct BackendHttpResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackendKind {
    Php,
    JavaScript,
    TypeScript,
    Python,
    Rust,
}

impl BackendKind {
    pub fn parse(raw: &str) -> Result<Self, String> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "php" => Ok(Self::Php),
            "js" | "javascript" => Ok(Self::JavaScript),
            "ts" | "typescript" => Ok(Self::TypeScript),
            "py" | "python" => Ok(Self::Python),
            "rs" | "rust" => Ok(Self::Rust),
            other => Err(format!("Unsupported backend runtime: {other}")),
        }
    }
}

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
      all: function (sql, params) { return this.query(sql, params).rows; },
      first: function (sql, params) { var rows = this.query(sql, params).rows; return rows.length > 0 ? rows[0] : null; },
      get: function (sql, params) { return this.first(sql, params); },
      run: function (sql, params) { return this.execute(sql, params); },
      seedJson: function (seed) {
        var payload = typeof seed === "string" ? seed : JSON.stringify(seed);
        var res = sqlCall("seed_json", id, payload, "");
        if (res && res.error) throw new Error(res.error);
        return res;
      },
      close: function () { return sqlCall("close", id, "", ""); }
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
  if (typeof res === "string") {
    return JSON.stringify({ status: 200, headers: [["Content-Type", "text/html; charset=utf-8"]], body: res });
  }
  if (!res || typeof res !== "object") {
    return JSON.stringify({ status: 204, headers: [], body: "" });
  }
  var status = typeof res.status === "number" ? res.status : 200;
  var headers = [];
  if (Array.isArray(res.headers)) {
    headers = res.headers;
  } else if (res.headers && typeof res.headers === "object") {
    for (var k in res.headers) headers.push([k, String(res.headers[k])]);
  }
  var body = res.body === undefined || res.body === null
    ? ""
    : (typeof res.body === "string" ? res.body : JSON.stringify(res.body));
  return JSON.stringify({ status: status, headers: headers, body: body });
}
"#;

const PYTHON_BACKEND_PRELUDE: &str = r#"
import json as _softn_json

def __softn_backend_dispatch(req_json):
    req = _softn_json.loads(req_json)
    fn = globals().get("handle_request") or globals().get("handleRequest")
    if fn is None:
        return _softn_json.dumps({
            "status": 500,
            "headers": [["Content-Type", "text/plain; charset=utf-8"]],
            "body": "Python backend did not define handle_request(req)"
        })
    res = fn(req)
    if isinstance(res, str):
        return _softn_json.dumps({"status": 200, "headers": [["Content-Type", "text/html; charset=utf-8"]], "body": res})
    if not isinstance(res, dict):
        return _softn_json.dumps({"status": 204, "headers": [], "body": ""})
    status = int(res.get("status", 200))
    raw_headers = res.get("headers", {})
    headers = []
    if isinstance(raw_headers, dict):
        for k, v in raw_headers.items():
            headers.append([str(k), str(v)])
    elif isinstance(raw_headers, list):
        headers = raw_headers
    body = res.get("body", "")
    if not isinstance(body, str):
        body = _softn_json.dumps(body)
    return _softn_json.dumps({"status": status, "headers": headers, "body": body})
"#;

pub struct LocalContainerBackend {
    pub kind: BackendKind,
    pub config: BackendConfig,
    pub mode: String,
    pub routes: Vec<String>,
    pub intercept_origins: Vec<String>,
    frontend_root: String,
    vfs: Arc<HashMap<String, Vec<u8>>>,
    php_overlay: Arc<Mutex<PhpVfsOverlay>>,
    sql_storage: SqlStorage,
    cookies: Mutex<HashMap<String, String>>,
    rust_worker: Option<RustWorkerHandle>,
}

enum RustWorkerCmd {
    Http {
        req: BackendHttpRequest,
        reply: mpsc::Sender<BackendHttpResponse>,
    },
    Control {
        payload: Value,
        reply: mpsc::Sender<Value>,
    },
    Shutdown,
}

struct RustWorkerHandle {
    tx: mpsc::Sender<RustWorkerCmd>,
    abort: Arc<AtomicBool>,
}

impl Drop for RustWorkerHandle {
    fn drop(&mut self) {
        self.abort.store(true, Ordering::SeqCst);
        let _ = self.tx.send(RustWorkerCmd::Shutdown);
    }
}

struct RustBackendWorker {
    state: ScriptState,
    dispatch_slot: u32,
    overlay_path: PathBuf,
    last_overlay_hash: Option<[u8; 32]>,
    ws_outbox: Vec<Value>,
    _sql_bridge: Arc<Mutex<RequestSqlBridge>>,
    abort: Arc<AtomicBool>,
}

impl LocalContainerBackend {
    pub fn new(bundle: &SoftnBundle, sql_storage: SqlStorage) -> Result<Option<Self>, String> {
        let Some(cfg) = bundle.manifest.backend.clone() else {
            return Ok(None);
        };
        let kind = BackendKind::parse(&cfg.runtime)?;
        let mode = cfg
            .mode
            .clone()
            .unwrap_or_else(|| {
                if bundle.entry_path.is_empty() || bundle.manifest.ssr_entry == Some(true) {
                    "ssr".to_string()
                } else {
                    "api".to_string()
                }
            })
            .to_ascii_lowercase();

        let routes = cfg.routes.clone().unwrap_or_else(|| {
            if mode == "ssr" {
                vec!["/".to_string()]
            } else {
                vec!["/api/".to_string(), "/api".to_string()]
            }
        });

        let intercept_origins = cfg.intercept_origins.clone().unwrap_or_default();

        // Preseed all declared SQLite databases into persistent app storage
        sql_storage.preseed_all(&bundle.vfs)?;

        // Share the bundle's immutable VFS zero-copy across frontend and backend.
        let vfs = Arc::clone(&bundle.vfs);
        let php_overlay = Arc::new(Mutex::new(PhpVfsOverlay::default()));

        let rust_worker = if kind == BackendKind::Rust {
            Some(Self::spawn_rust_worker_thread(&cfg, &vfs, &sql_storage)?)
        } else {
            None
        };

        Ok(Some(Self {
            kind,
            config: cfg,
            mode,
            routes,
            intercept_origins,
            frontend_root: bundle.frontend_root.clone(),
            vfs,
            php_overlay,
            sql_storage,
            cookies: Mutex::new(HashMap::new()),
            rust_worker,
        }))
    }

    pub fn should_route(&self, url_path: &str) -> bool {
        let path_only = url_path.split('?').next().unwrap_or(url_path);
        let norm = if path_only.starts_with('/') {
            path_only.to_string()
        } else {
            format!("/{path_only}")
        };

        if self.mode == "ssr" {
            // In SSR mode, static files inside frontendRoot aren't routed to PHP unless .php
            if !norm.ends_with(".php") && !norm.ends_with(".phtml") {
                let rel = normalize_vfs_path(&norm);
                if self.vfs.contains_key(&rel)
                    && (rel.ends_with(".css")
                        || rel.ends_with(".js")
                        || rel.ends_with(".png")
                        || rel.ends_with(".jpg")
                        || rel.ends_with(".jpeg")
                        || rel.ends_with(".svg")
                        || rel.ends_with(".webp")
                        || rel.ends_with(".ico")
                        || rel.ends_with(".woff2")
                        || rel.ends_with(".ttf"))
                {
                    return false;
                }
            }
            return true;
        }

        for prefix in &self.routes {
            let p = if prefix.starts_with('/') {
                prefix.as_str()
            } else {
                "/"
            };
            if p == "/" {
                return true;
            }
            let trimmed = p.trim_end_matches('/');
            if norm == trimmed || norm.starts_with(&format!("{trimmed}/")) {
                return true;
            }
        }
        false
    }

    pub fn matches_intercept_origin(&self, full_url: &str) -> Option<(String, String)> {
        for origin in &self.intercept_origins {
            let clean = origin.trim_end_matches('/');
            if let Some(rest) = full_url.strip_prefix(clean) {
                if rest.is_empty() || rest.starts_with('/') || rest.starts_with('?') {
                    let (p, q) = match rest.split_once('?') {
                        Some((p, q)) => (if p.is_empty() { "/" } else { p }, q),
                        None => (if rest.is_empty() { "/" } else { rest }, ""),
                    };
                    return Some((p.to_string(), q.to_string()));
                }
            }
        }
        None
    }

    pub fn handle_request(&self, req: BackendHttpRequest) -> BackendHttpResponse {
        self.handle_request_opts(req, true)
    }

    pub fn handle_request_opts(
        &self,
        mut req: BackendHttpRequest,
        auto_cookies: bool,
    ) -> BackendHttpResponse {
        // Attach legacy session cookies only for direct backend callers;
        // `SoftnMobileEngine` manages full RFC 6265 cookies via `MobileCookieJar`.
        if auto_cookies {
            if let Ok(jar) = self.cookies.lock() {
                if !jar.is_empty()
                    && !req
                        .headers
                        .iter()
                        .any(|(k, _)| k.eq_ignore_ascii_case("cookie"))
                {
                    let header_val = jar
                        .iter()
                        .map(|(k, v)| format!("{k}={v}"))
                        .collect::<Vec<_>>()
                        .join("; ");
                    req.headers.push(("Cookie".into(), header_val));
                }
            }
        }

        let resp = match self.kind {
            BackendKind::Php => self.execute_php(&req),
            BackendKind::JavaScript | BackendKind::TypeScript | BackendKind::Python => {
                self.execute_script(&req)
            }
            BackendKind::Rust => self.execute_rust(&req),
        };

        if auto_cookies {
            if let Ok(mut jar) = self.cookies.lock() {
                for (k, v) in &resp.headers {
                    if k.eq_ignore_ascii_case("set-cookie") {
                        if let Some(first_pair) = v.split(';').next() {
                            if let Some((ck, cv)) = first_pair.split_once('=') {
                                let name = ck.trim();
                                if !name.is_empty() {
                                    jar.insert(name.to_string(), cv.trim().to_string());
                                }
                            }
                        }
                    }
                }
            }
        }

        resp
    }

    fn execute_php(&self, req: &BackendHttpRequest) -> BackendHttpResponse {
        let mut lower_headers = HashMap::new();
        for (k, v) in &req.headers {
            lower_headers.insert(k.to_ascii_lowercase(), v.clone());
        }

        let target_path = if req.path.starts_with('/') {
            req.path.clone()
        } else {
            format!("/{}", req.path)
        };
        let original_uri = if req.query.is_empty() {
            target_path.clone()
        } else {
            format!("{}?{}", target_path, req.query)
        };

        let rel = normalize_vfs_path(&target_path);
        let rel_lower = rel.to_ascii_lowercase();
        let backend_root_private = self.config.root.as_deref().is_some_and(|raw_root| {
            let root = normalize_vfs_path(raw_root).to_ascii_lowercase();
            let fe_root = self.frontend_root.to_ascii_lowercase();
            !root.is_empty()
                && root != fe_root
                && (rel_lower == root || rel_lower.starts_with(&format!("{root}/")))
        });
        let is_private_dir = backend_root_private
            || rel_lower.starts_with("server/")
            || rel_lower.starts_with("backend/")
            || rel_lower.starts_with("private/")
            || rel_lower.starts_with("db/")
            || rel_lower.starts_with("database/")
            || rel_lower.starts_with("migrations/")
            || rel_lower.split('/').any(|seg| seg.starts_with('.'));
        let entry_key = normalize_vfs_path(&self.config.entry);
        let script_key = if !rel.is_empty()
            && !is_private_dir
            && self.vfs.contains_key(&rel)
            && (rel_lower.ends_with(".php") || rel_lower.ends_with(".phtml"))
        {
            rel
        } else if self.vfs.contains_key(&entry_key) {
            entry_key
        } else {
            return BackendHttpResponse {
                status: 404,
                headers: vec![("Content-Type".into(), "text/plain; charset=utf-8".into())],
                body: format!("PHP entry not found: {}", self.config.entry).into_bytes(),
            };
        };

        let entry_source = String::from_utf8_lossy(&self.vfs[&script_key]).into_owned();
        let content_type = lower_headers
            .get("content-type")
            .cloned()
            .unwrap_or_default();
        let body_text = String::from_utf8_lossy(&req.body).into_owned();
        // ZIPP PHP represents every PHP string as a Latin-1 packed byte string (0x00..=0xFF per
        // UTF-8 byte) and runs `bytesToUtf8()` inside `json_decode()` / `mb_*()`. Packing raw
        // HTTP body bytes one-to-one into Latin-1 preserves non-ASCII UTF-8 (e.g. em-dashes,
        // accents, emojis) and binary payloads verbatim in `file_get_contents('php://input')`.
        let body_php_bytes: String = req.body.iter().map(|&b| b as char).collect();
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
        server.insert("QUERY_STRING".into(), json!(req.query));
        server.insert("SCRIPT_NAME".into(), json!(format!("/{script_key}")));
        server.insert("PHP_SELF".into(), json!(format!("/{script_key}")));
        server.insert("SCRIPT_FILENAME".into(), json!(format!("/{script_key}")));
        server.insert("DOCUMENT_ROOT".into(), json!("/"));
        server.insert("SERVER_PROTOCOL".into(), json!("HTTP/1.1"));
        server.insert("SERVER_NAME".into(), json!("app.softn.local"));
        server.insert("HTTP_HOST".into(), json!("app.softn.local"));
        server.insert("SERVER_PORT".into(), json!("443"));
        server.insert("HTTPS".into(), json!("on"));
        server.insert("REQUEST_SCHEME".into(), json!("https"));
        server.insert("REMOTE_ADDR".into(), json!("127.0.0.1"));
        server.insert("CONTENT_TYPE".into(), json!(content_type));
        server.insert("CONTENT_LENGTH".into(), json!(req.body.len().to_string()));
        for (k, v) in &lower_headers {
            let php_key = format!("HTTP_{}", k.to_ascii_uppercase().replace('-', "_"));
            server.insert(php_key, json!(v));
        }

        let mut sapi_obj = json!({
            "sapi": "zipp-server",
            "server": server,
            "query": req.query,
            "cookies": cookies,
            "contentType": content_type,
            "body": body_php_bytes,
        });
        if let Some(p) = post {
            sapi_obj["post"] = json!(p);
        }

        let req_base_dir = match script_key.rsplit_once('/') {
            Some((parent, _)) if !parent.is_empty() => format!("/{parent}"),
            _ => "/".to_owned(),
        };
        let env_pairs: Vec<(String, String)> = self
            .config
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
            vfs_arc: Some(Arc::clone(&self.vfs)),
            vfs_overlay: Some(Arc::clone(&self.php_overlay)),
            allow_native_fs: false,
            stream_stdout: false,
        };

        let mut st = match compile_php_program(&entry_source, config) {
            Ok(compiled) => compiled.into_state(),
            Err(err) => {
                return BackendHttpResponse {
                    status: 500,
                    headers: vec![("Content-Type".into(), "text/plain; charset=utf-8".into())],
                    body: format!("PHP compile error: {err}").into_bytes(),
                };
            }
        };

        let abort = Arc::new(AtomicBool::new(false));
        let _watchdog = WallDeadlineGuard::arm(Arc::clone(&abort), WALL_TIME_MS);
        harden_vm(&mut st, REQUEST_STEP_BUDGET, abort.clone());
        let mut sql_bridge = RequestSqlBridge::new(self.sql_storage.clone(), abort);
        st.set_host_call(Box::new(move |kind, args| Ok(sql_bridge.call(kind, args))));

        let init_res = st.run_init();
        let resource_err = st.resource_limit_error().map(|s| s.to_owned());
        let raw_bytes = st.take_php_output();

        // Enforce PHP overlay path & memory bounds after every request so a script
        // cannot overwrite `.php`/`.htaccess`/`.env` or exhaust RAM via VFS writes.
        if let Ok(mut ov) = self.php_overlay.lock() {
            sanitize_php_overlay(&mut ov, &self.config.entry);
        }

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
            return BackendHttpResponse {
                status: 503,
                headers: vec![("Content-Type".into(), "text/plain; charset=utf-8".into())],
                body: format!("Backend sandbox limit: {err}").into_bytes(),
            };
        }
        if let Err(err) = init_res {
            return BackendHttpResponse {
                status: 500,
                headers: vec![("Content-Type".into(), "text/plain; charset=utf-8".into())],
                body: if raw_bytes.is_empty() {
                    format!("PHP runtime error: {err}").into_bytes()
                } else {
                    raw_bytes
                },
            };
        }

        let meta: Value =
            serde_json::from_str(&meta_json).unwrap_or_else(|_| json!({ "status": 200 }));
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
        if !headers
            .iter()
            .any(|(k, _)| k.eq_ignore_ascii_case("content-type"))
        {
            headers.push(("Content-Type".into(), "application/json; charset=utf-8".into()));
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

        BackendHttpResponse {
            status,
            headers,
            body,
        }
    }

    fn execute_script(&self, req: &BackendHttpRequest) -> BackendHttpResponse {
        let entry_key = normalize_vfs_path(&self.config.entry);
        let Some(bytes) = self.vfs.get(&entry_key) else {
            return BackendHttpResponse {
                status: 404,
                headers: vec![("Content-Type".into(), "text/plain; charset=utf-8".into())],
                body: format!("Backend entry missing: {entry_key}").into_bytes(),
            };
        };
        let source = String::from_utf8_lossy(bytes);
        let (full_source, frontend, dispatch_fn) = match self.kind {
            BackendKind::JavaScript => (
                format!("{JS_BACKEND_PRELUDE}\n{source}"),
                Frontend::JavaScript {
                    goal: ScriptGoal::Pure,
                },
                "__softnBackendDispatch",
            ),
            BackendKind::TypeScript => (
                format!("{JS_BACKEND_PRELUDE}\n{source}"),
                Frontend::TypeScript,
                "__softnBackendDispatch",
            ),
            BackendKind::Python => (
                format!("{PYTHON_BACKEND_PRELUDE}\n{source}"),
                Frontend::Python {
                    mode: PythonMode::Module,
                },
                "__softn_backend_dispatch",
            ),
            _ => unreachable!(),
        };

        let mut st = match compile_source(&full_source, frontend) {
            Ok(c) => c.into_state(),
            Err(err) => {
                return BackendHttpResponse {
                    status: 500,
                    headers: vec![("Content-Type".into(), "text/plain; charset=utf-8".into())],
                    body: format!("Backend compile error: {err}").into_bytes(),
                };
            }
        };

        let abort = Arc::new(AtomicBool::new(false));
        let _watchdog = WallDeadlineGuard::arm(Arc::clone(&abort), WALL_TIME_MS);
        harden_vm(&mut st, REQUEST_STEP_BUDGET, abort.clone());
        let mut sql_bridge = RequestSqlBridge::new(self.sql_storage.clone(), abort);
        st.set_host_call(Box::new(move |kind, args| Ok(sql_bridge.call(kind, args))));

        if let Err(err) = st.run_init() {
            if let Some(limit) = st.resource_limit_error() {
                return BackendHttpResponse {
                    status: 503,
                    headers: vec![("Content-Type".into(), "text/plain; charset=utf-8".into())],
                    body: format!("Backend sandbox limit: {limit}").into_bytes(),
                };
            }
            return BackendHttpResponse {
                status: 500,
                headers: vec![("Content-Type".into(), "text/plain; charset=utf-8".into())],
                body: format!("Backend init error: {err}").into_bytes(),
            };
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

        let raw_resp = if self.kind == BackendKind::Python {
            let Some(slot) = st
                .symbols()
                .into_iter()
                .find(|s| s.name == "__zipp_py_call")
                .map(|s| s.index)
            else {
                return BackendHttpResponse {
                    status: 500,
                    headers: vec![("Content-Type".into(), "text/plain; charset=utf-8".into())],
                    body: b"Python runtime missing __zipp_py_call".to_vec(),
                };
            };
            let mut budget = HostValueBudget::new(65_536, 16 * 1024 * 1024);
            match st.call_slot_bounded(
                slot,
                &[
                    HostValue::String(dispatch_fn.to_string()),
                    HostValue::Array(vec![HostValue::String(req_json)]),
                ],
                &mut budget,
            ) {
                Ok(HostValue::String(s)) => s,
                Ok(other) => format!("{other:?}"),
                Err(e) => {
                    return BackendHttpResponse {
                        status: 500,
                        headers: vec![("Content-Type".into(), "text/plain; charset=utf-8".into())],
                        body: format!("Python backend error: {e:?}").into_bytes(),
                    };
                }
            }
        } else {
            match st.call_global(dispatch_fn, &[JsValue::String(req_json)]) {
                Ok(JsValue::String(s)) => s,
                Ok(_) => String::new(),
                Err(e) => {
                    return BackendHttpResponse {
                        status: 500,
                        headers: vec![("Content-Type".into(), "text/plain; charset=utf-8".into())],
                        body: format!("JS/TS backend error: {e}").into_bytes(),
                    };
                }
            }
        };

        parse_script_response(&raw_resp)
    }

    fn boot_rust_worker(
        cfg: &BackendConfig,
        vfs: &Arc<HashMap<String, Vec<u8>>>,
        sql_storage: &SqlStorage,
        abort: Arc<AtomicBool>,
    ) -> Result<RustBackendWorker, String> {
        let entry_key = normalize_vfs_path(&cfg.entry);
        let root_prefix = cfg
            .root
            .as_deref()
            .map(normalize_vfs_path)
            .unwrap_or_default();

        // Strip `backend.root` prefix (e.g. `"server"`) so `src/main.rs`, `Cargo.toml`,
        // `mod foo;`, and `include_str!(...)` resolve identically to `@softn/container`.
        let mut rust_vfs: HashMap<String, Vec<u8>> = HashMap::new();
        let prefix_slash = if root_prefix.is_empty() {
            String::new()
        } else {
            format!("{root_prefix}/")
        };
        for (k, v) in vfs.iter() {
            if !prefix_slash.is_empty() {
                if let Some(stripped) = k.strip_prefix(&prefix_slash) {
                    if !stripped.is_empty() {
                        rust_vfs.insert(stripped.to_string(), v.clone());
                    }
                }
            } else {
                rust_vfs.insert(k.clone(), v.clone());
            }
        }
        // Fallback: if root filtering left VFS empty, include everything.
        if rust_vfs.is_empty() {
            for (k, v) in vfs.iter() {
                rust_vfs.insert(k.clone(), v.clone());
            }
        }

        let rel_entry = if !prefix_slash.is_empty() {
            entry_key
                .strip_prefix(&prefix_slash)
                .unwrap_or(&entry_key)
                .to_string()
        } else {
            entry_key.clone()
        };

        // Restore previously persisted Rust VFS overlay (e.g. `.pit.secret` JWT signing key)
        // BEFORE `main()` runs so persisted JWT tokens remain valid across app restarts.
        let overlay_path = sql_storage
            .db_dir
            .parent()
            .unwrap_or(&sql_storage.db_dir)
            .join("rust_vfs_overlay.json");
        let last_overlay_hash = restore_rust_vfs_overlay(&overlay_path, &mut rust_vfs);

        let entry_source = rust_vfs
            .get(&rel_entry)
            .or_else(|| vfs.get(&entry_key))
            .map(|b| String::from_utf8_lossy(b).into_owned())
            .ok_or_else(|| format!("Rust backend entry not found: {rel_entry} (from {entry_key})"))?;

        let base_dir = match rel_entry.rsplit_once('/') {
            Some((p, _)) if !p.is_empty() => p.to_string(),
            _ => ".".to_string(),
        };
        let env_pairs: Vec<(String, String)> = cfg
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
            mode: "worker_boot".to_string(),
        };
        let _boot_watchdog = WallDeadlineGuard::arm(Arc::clone(&abort), WALL_TIME_MS);
        let mut st = compile_rust_program(&entry_source, config)?.into_state();
        harden_vm(&mut st, BOOT_STEP_BUDGET, abort.clone());
        let sql_bridge = Arc::new(Mutex::new(RequestSqlBridge::new(
            sql_storage.clone(),
            abort.clone(),
        )));
        let bridge_ref = Arc::clone(&sql_bridge);
        st.set_host_call(Box::new(move |kind, args| {
            let mut guard = bridge_ref
                .lock()
                .map_err(|_| "SQL bridge lock poisoned".to_string())?;
            Ok(guard.call(kind, args))
        }));
        st.run_init()?;
        let boot_out = st.take_rust_output();
        let boot_err = st.take_rust_stderr();
        #[cfg(target_os = "android")]
        {
            if !boot_out.is_empty() {
                log::info!("[rust-backend] {}", String::from_utf8_lossy(&boot_out).trim());
            }
            if !boot_err.is_empty() {
                log::info!("[rust-backend] {}", String::from_utf8_lossy(&boot_err).trim());
            }
        }
        let _ = (&boot_out, &boot_err);

        let dispatch_slot = st
            .symbols()
            .into_iter()
            .find(|s| s.name == "__zipp_rs_worker_request")
            .map(|s| s.index)
            .ok_or_else(|| "Rust worker did not register __zipp_rs_worker_request".to_string())?;

        // Immediately persist any files written during boot (e.g. `.pit.secret`)
        let saved_overlay_hash =
            persist_rust_vfs_overlay(&mut st, &overlay_path, last_overlay_hash);

        Ok(RustBackendWorker {
            state: st,
            dispatch_slot,
            overlay_path,
            last_overlay_hash: saved_overlay_hash,
            ws_outbox: Vec::new(),
            _sql_bridge: sql_bridge,
            abort,
        })
    }

    /// Spawn the Rust Axum backend worker on a dedicated thread with an 8 MiB stack so
    /// backend VM frames NEVER nest onto the frontend VM's stack (preventing stack overflow
    /// on Android's 1 MiB ART threads and Windows debug builds).
    fn spawn_rust_worker_thread(
        cfg: &BackendConfig,
        vfs: &Arc<HashMap<String, Vec<u8>>>,
        sql_storage: &SqlStorage,
    ) -> Result<RustWorkerHandle, String> {
        let cfg_owned = cfg.clone();
        let vfs_owned = Arc::clone(vfs);
        let sql_owned = sql_storage.clone();
        let abort = Arc::new(AtomicBool::new(false));
        let boot_abort = Arc::clone(&abort);
        let (cmd_tx, cmd_rx) = mpsc::channel::<RustWorkerCmd>();
        let (boot_tx, boot_rx) = mpsc::channel::<Result<(), String>>();

        thread::Builder::new()
            .name("softn-rust-backend".into())
            .stack_size(8 * 1024 * 1024)
            .spawn(move || {
                let mut worker =
                    match Self::boot_rust_worker(&cfg_owned, &vfs_owned, &sql_owned, boot_abort) {
                        Ok(w) => {
                            let _ = boot_tx.send(Ok(()));
                            w
                        }
                        Err(e) => {
                            let _ = boot_tx.send(Err(e));
                            return;
                        }
                    };
                while let Ok(cmd) = cmd_rx.recv() {
                    match cmd {
                        RustWorkerCmd::Http { req, reply } => {
                            let resp = worker.handle_http(&req);
                            let _ = reply.send(resp);
                        }
                        RustWorkerCmd::Control { payload, reply } => {
                            let res = worker.handle_control(payload);
                            let _ = reply.send(res);
                        }
                        RustWorkerCmd::Shutdown => break,
                    }
                }
            })
            .map_err(|e| format!("Failed to spawn Rust backend thread: {e}"))?;

        boot_rx
            .recv_timeout(RUST_WORKER_RECV_TIMEOUT)
            .map_err(|e| {
                abort.store(true, Ordering::SeqCst);
                match e {
                    mpsc::RecvTimeoutError::Timeout => {
                        "Rust backend worker timed out during boot".to_string()
                    }
                    mpsc::RecvTimeoutError::Disconnected => {
                        "Rust backend worker thread terminated during boot".to_string()
                    }
                }
            })??;

        Ok(RustWorkerHandle { tx: cmd_tx, abort })
    }

    fn execute_rust(&self, req: &BackendHttpRequest) -> BackendHttpResponse {
        let Some(ref handle) = self.rust_worker else {
            return BackendHttpResponse {
                status: 500,
                headers: vec![("Content-Type".into(), "text/plain; charset=utf-8".into())],
                body: b"Rust worker unavailable".to_vec(),
            };
        };
        let (tx, rx) = mpsc::channel();
        if handle
            .tx
            .send(RustWorkerCmd::Http {
                req: req.clone(),
                reply: tx,
            })
            .is_err()
        {
            return BackendHttpResponse {
                status: 500,
                headers: vec![("Content-Type".into(), "text/plain; charset=utf-8".into())],
                body: b"Rust worker thread disconnected".to_vec(),
            };
        }
        match rx.recv_timeout(RUST_WORKER_RECV_TIMEOUT) {
            Ok(resp) => resp,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                handle.abort.store(true, Ordering::SeqCst);
                BackendHttpResponse {
                    status: 503,
                    headers: vec![("Content-Type".into(), "text/plain; charset=utf-8".into())],
                    body: b"Rust backend request timed out".to_vec(),
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => BackendHttpResponse {
                status: 500,
                headers: vec![("Content-Type".into(), "text/plain; charset=utf-8".into())],
                body: b"Rust worker response dropped".to_vec(),
            },
        }
    }

    /// Dispatch a WebSocket or timer control command to a live Rust Axum worker.
    pub fn rust_control(&self, payload: Value) -> Value {
        let Some(ref handle) = self.rust_worker else {
            return json!({ "ok": false });
        };
        let (tx, rx) = mpsc::channel();
        if handle
            .tx
            .send(RustWorkerCmd::Control { payload, reply: tx })
            .is_err()
        {
            return json!({ "ok": false });
        }
        rx.recv_timeout(RUST_WORKER_RECV_TIMEOUT)
            .unwrap_or_else(|_| {
                handle.abort.store(true, Ordering::SeqCst);
                json!({ "ok": false, "error": "timeout" })
            })
    }

    /// Returns `true` when this app runs a persistent Rust Axum backend that may emit
    /// asynchronous timers or WebSocket frames between user interactions.
    pub fn is_rust_backend(&self) -> bool {
        self.kind == BackendKind::Rust
    }

    /// Poll pending async timers in a Rust worker and drain all queued WebSocket frames.
    pub fn poll_rust_timers(&self) -> Vec<Value> {
        if self.kind != BackendKind::Rust {
            return Vec::new();
        }
        let res = self.rust_control(json!({ "__control": "poll_timers" }));
        res.get("wsFrames")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default()
    }
}

impl RustBackendWorker {
    fn handle_http(&mut self, req: &BackendHttpRequest) -> BackendHttpResponse {
        // Renew per-request instruction budget WITHOUT calling `set_limits` (which would
        // replace the instrumentation Recorder and drop `heap_limit` / `dynamic_code_limits`).
        self.abort.store(false, Ordering::SeqCst);
        let _watchdog = WallDeadlineGuard::arm(Arc::clone(&self.abort), WALL_TIME_MS);
        let _ = self.state.renew_step_budget(REQUEST_STEP_BUDGET);

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
        let mut budget = HostValueBudget::new(65_536, 32 * 1024 * 1024);
        let resp = match self.state.call_slot_bounded(
            self.dispatch_slot,
            &[HostValue::String(req_json)],
            &mut budget,
        ) {
            Ok(HostValue::String(s)) => {
                // Capture any WS frames piggybacked on HTTP responses (bounded).
                if let Ok(parsed) = serde_json::from_str::<Value>(&s) {
                    if let Some(frames) = parsed.get("wsFrames").and_then(|v| v.as_array()) {
                        let room = MAX_WS_OUTBOX.saturating_sub(self.ws_outbox.len());
                        self.ws_outbox.extend(frames.iter().take(room).cloned());
                    }
                }
                parse_script_response(&s)
            }
            Ok(_) => BackendHttpResponse {
                status: 204,
                headers: Vec::new(),
                body: Vec::new(),
            },
            Err(e) => BackendHttpResponse {
                status: 500,
                headers: vec![("Content-Type".into(), "text/plain; charset=utf-8".into())],
                body: format!("Rust backend error: {e:?}").into_bytes(),
            },
        };
        let _ = self.state.take_rust_output();
        let _ = self.state.take_rust_stderr();
        if resp.status < 500 {
            self.last_overlay_hash = persist_rust_vfs_overlay(
                &mut self.state,
                &self.overlay_path,
                self.last_overlay_hash,
            );
        }
        resp
    }

    fn handle_control(&mut self, payload: Value) -> Value {
        self.abort.store(false, Ordering::SeqCst);
        let _watchdog = WallDeadlineGuard::arm(Arc::clone(&self.abort), WALL_TIME_MS);
        let _ = self.state.renew_step_budget(REQUEST_STEP_BUDGET / 2);
        let mut budget = HostValueBudget::new(65_536, 16 * 1024 * 1024);
        let raw = match self.state.call_slot_bounded(
            self.dispatch_slot,
            &[HostValue::String(payload.to_string())],
            &mut budget,
        ) {
            Ok(HostValue::String(s)) => s,
            _ => return json!({ "ok": false }),
        };
        let mut parsed: Value = serde_json::from_str(&raw).unwrap_or_else(|_| json!({ "ok": false }));
        if let Some(frames) = parsed.get("wsFrames").and_then(|v| v.as_array()) {
            let room = MAX_WS_OUTBOX.saturating_sub(self.ws_outbox.len());
            self.ws_outbox.extend(frames.iter().take(room).cloned());
        }
        let drained = std::mem::take(&mut self.ws_outbox);
        if let Some(obj) = parsed.as_object_mut() {
            obj.insert("wsFrames".into(), Value::Array(drained));
        }
        parsed
    }
}

fn is_protected_overlay_path(p: &str, backend_entry: Option<&str>) -> bool {
    let norm = normalize_vfs_path(p);
    if norm.is_empty() || norm.contains('\0') {
        return true;
    }
    let lower = norm.to_ascii_lowercase();
    let base = lower.rsplit('/').next().unwrap_or("");
    for ext in [
        ".php",
        ".php5",
        ".php7",
        ".php8",
        ".pht",
        ".phps",
        ".phtml",
        ".inc",
        ".phar",
        ".py",
        ".rs",
        ".toml",
        ".sql",
        ".db",
        ".db-wal",
        ".db-shm",
        ".db-journal",
        ".sqlite",
        ".sqlite-wal",
        ".sqlite-shm",
        ".sqlite-journal",
        ".sqlite3",
        ".sqlite3-wal",
        ".sqlite3-shm",
        ".sqlite3-journal",
        ".pem",
        ".key",
        ".tpl",
        ".yaml",
        ".yml",
        ".ini",
        ".bak",
        ".log",
        ".sh",
        ".logic",
    ] {
        if lower.ends_with(ext) {
            return true;
        }
    }
    if matches!(
        base,
        ".htaccess"
            | ".htpasswd"
            | ".env"
            | "manifest.json"
            | "permission.json"
            | "cargo.toml"
            | "cargo.lock"
            | "composer.json"
            | "composer.lock"
    ) || base.starts_with(".env.")
    {
        return true;
    }
    if let Some(entry) = backend_entry {
        let entry_lower = normalize_vfs_path(entry).to_ascii_lowercase();
        if !entry_lower.is_empty() && lower == entry_lower {
            return true;
        }
    }
    false
}

fn sanitize_php_overlay(overlay: &mut PhpVfsOverlay, backend_entry: &str) {
    overlay
        .writes
        .retain(|k, _| !is_protected_overlay_path(k, Some(backend_entry)));
    overlay
        .deleted
        .retain(|k| !is_protected_overlay_path(k, Some(backend_entry)));
    if overlay.deleted.len() > MAX_OVERLAY_ENTRIES {
        let mut dels: Vec<String> = overlay.deleted.iter().cloned().collect();
        dels.sort();
        dels.truncate(MAX_OVERLAY_ENTRIES);
        overlay.deleted = dels.into_iter().collect();
    }
    let mut total: usize = overlay.writes.values().map(Vec::len).sum();
    if total > MAX_OVERLAY_BYTES || overlay.writes.len() > MAX_OVERLAY_ENTRIES {
        let mut keys: Vec<String> = overlay.writes.keys().cloned().collect();
        keys.sort();
        for k in keys {
            if total <= MAX_OVERLAY_BYTES && overlay.writes.len() <= MAX_OVERLAY_ENTRIES {
                break;
            }
            if let Some(removed) = overlay.writes.remove(&k) {
                total = total.saturating_sub(removed.len());
            }
        }
    }
    overlay.total_bytes = total;
}

fn hash_rust_overlay_snapshot(
    writes: &[(&str, &[u8])],
    deleted: &[&str],
    dirs: &[&str],
) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"W:");
    for (k, bytes) in writes {
        hasher.update((k.len() as u64).to_le_bytes());
        hasher.update(k.as_bytes());
        hasher.update((bytes.len() as u64).to_le_bytes());
        hasher.update(bytes);
    }
    hasher.update(b"D:");
    for d in deleted {
        hasher.update((d.len() as u64).to_le_bytes());
        hasher.update(d.as_bytes());
    }
    hasher.update(b"R:");
    for d in dirs {
        hasher.update((d.len() as u64).to_le_bytes());
        hasher.update(d.as_bytes());
    }
    hasher.finalize().into()
}

fn restore_rust_vfs_overlay(
    path: &Path,
    vfs: &mut HashMap<String, Vec<u8>>,
) -> Option<[u8; 32]> {
    if let Ok(meta) = fs::symlink_metadata(path) {
        if meta.file_type().is_symlink() || meta.len() > (MAX_OVERLAY_BYTES as u64) * 3 {
            return None;
        }
    }
    let Ok(raw) = fs::read_to_string(path) else {
        return None;
    };
    let Ok(parsed) = serde_json::from_str::<Value>(&raw) else {
        return None;
    };
    let mut del_keys: Vec<String> = Vec::new();
    if let Some(deleted) = parsed.get("deleted").and_then(|v| v.as_array()) {
        for d in deleted.iter().take(MAX_OVERLAY_ENTRIES) {
            if let Some(s) = d.as_str() {
                let norm = normalize_vfs_path(s);
                if !is_protected_overlay_path(&norm, None) {
                    vfs.remove(&norm);
                    del_keys.push(norm);
                }
            }
        }
    }
    let mut restored_bytes: usize = 0;
    let mut restored_writes: Vec<(String, Vec<u8>)> = Vec::new();
    if let Some(writes) = parsed.get("writes").and_then(|v| v.as_object()) {
        for (k, v) in writes.iter().take(MAX_OVERLAY_ENTRIES) {
            let norm = normalize_vfs_path(k);
            if is_protected_overlay_path(&norm, None) {
                continue;
            }
            if let Some(hex_str) = v.as_str() {
                if let Some(bytes) = decode_hex_bytes(hex_str) {
                    if restored_bytes.saturating_add(bytes.len()) <= MAX_OVERLAY_BYTES {
                        restored_bytes += bytes.len();
                        vfs.insert(norm.clone(), bytes.clone());
                        restored_writes.push((norm, bytes));
                    }
                }
            }
        }
    }
    let mut dir_keys: Vec<String> = Vec::new();
    if let Some(dirs) = parsed.get("dirs").and_then(|v| v.as_array()) {
        for d in dirs.iter().take(MAX_OVERLAY_ENTRIES) {
            if let Some(s) = d.as_str() {
                let norm = normalize_vfs_path(s);
                if !norm.is_empty() && !is_protected_overlay_path(&norm, None) {
                    dir_keys.push(norm);
                }
            }
        }
    }
    restored_writes.sort_by(|a, b| a.0.cmp(&b.0));
    del_keys.sort();
    dir_keys.sort();
    let w_refs: Vec<(&str, &[u8])> = restored_writes
        .iter()
        .map(|(k, b)| (k.as_str(), b.as_slice()))
        .collect();
    let d_refs: Vec<&str> = del_keys.iter().map(String::as_str).collect();
    let r_refs: Vec<&str> = dir_keys.iter().map(String::as_str).collect();
    Some(hash_rust_overlay_snapshot(&w_refs, &d_refs, &r_refs))
}

fn persist_rust_vfs_overlay(
    st: &mut ScriptState,
    path: &Path,
    prev_hash: Option<[u8; 32]>,
) -> Option<[u8; 32]> {
    let (writes, deleted, dirs) = st.snapshot_rust_vfs_overlay();
    if writes.is_empty() && deleted.is_empty() && dirs.is_empty() {
        return prev_hash;
    }

    let mut clean_writes: Vec<(String, Vec<u8>)> = Vec::new();
    let mut total_bytes: usize = 0;
    let mut sorted_writes: Vec<(String, Vec<u8>)> = writes
        .into_iter()
        .map(|(k, b)| (normalize_vfs_path(&k), b))
        .filter(|(k, _)| !is_protected_overlay_path(k, None))
        .collect();
    sorted_writes.sort_by(|a, b| a.0.cmp(&b.0));
    for (k, bytes) in sorted_writes.into_iter().take(MAX_OVERLAY_ENTRIES) {
        if total_bytes.saturating_add(bytes.len()) <= MAX_OVERLAY_BYTES {
            total_bytes += bytes.len();
            clean_writes.push((k, bytes));
        }
    }

    let mut clean_deleted: Vec<String> = deleted
        .into_iter()
        .map(|d| normalize_vfs_path(&d))
        .filter(|d| !is_protected_overlay_path(d, None))
        .collect();
    clean_deleted.sort();
    clean_deleted.dedup();
    clean_deleted.truncate(MAX_OVERLAY_ENTRIES);

    let mut clean_dirs: Vec<String> = dirs
        .into_iter()
        .map(|d| normalize_vfs_path(&d))
        .filter(|d| !d.is_empty() && !is_protected_overlay_path(d, None))
        .collect();
    clean_dirs.sort();
    clean_dirs.dedup();
    clean_dirs.truncate(MAX_OVERLAY_ENTRIES);

    if clean_writes.is_empty() && clean_deleted.is_empty() && clean_dirs.is_empty() {
        return prev_hash;
    }

    // Fast change-detection before doing any hex encoding or JSON serialization.
    let w_refs: Vec<(&str, &[u8])> = clean_writes
        .iter()
        .map(|(k, b)| (k.as_str(), b.as_slice()))
        .collect();
    let d_refs: Vec<&str> = clean_deleted.iter().map(String::as_str).collect();
    let r_refs: Vec<&str> = clean_dirs.iter().map(String::as_str).collect();
    let next_hash = hash_rust_overlay_snapshot(&w_refs, &d_refs, &r_refs);
    if prev_hash == Some(next_hash) {
        return prev_hash;
    }

    let mut writes_map = serde_json::Map::new();
    for (k, bytes) in clean_writes {
        writes_map.insert(k, Value::String(encode_hex_bytes(&bytes)));
    }
    let del_arr: Vec<Value> = clean_deleted.into_iter().map(Value::String).collect();
    let dirs_arr: Vec<Value> = clean_dirs.into_iter().map(Value::String).collect();
    let next_json = json!({
        "writes": writes_map,
        "deleted": del_arr,
        "dirs": dirs_arr
    })
    .to_string();

    if fs::symlink_metadata(path)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
    {
        return prev_hash;
    }
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let tmp = path.with_extension("json.tmp");
    if !fs::symlink_metadata(&tmp)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
        && fs::write(&tmp, &next_json).is_ok()
    {
        let _ = fs::rename(&tmp, path);
    }
    Some(next_hash)
}

fn encode_hex_bytes(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        use std::fmt::Write;
        let _ = write!(&mut out, "{b:02x}");
    }
    out
}

fn decode_hex_bytes(hex: &str) -> Option<Vec<u8>> {
    if !hex.len().is_multiple_of(2) {
        return None;
    }
    let mut out = Vec::with_capacity(hex.len() / 2);
    let b = hex.as_bytes();
    for i in (0..b.len()).step_by(2) {
        let s = std::str::from_utf8(&b[i..i + 2]).ok()?;
        out.push(u8::from_str_radix(s, 16).ok()?);
    }
    Some(out)
}

fn harden_vm(st: &mut ScriptState, steps: u64, abort: Arc<AtomicBool>) {
    st.set_limits(steps, Some(abort));
    let baseline = st.heap_bytes();
    st.set_heap_limit(baseline.saturating_add(VM_HEAP_LIMIT));
    st.set_output_limit(VM_OUTPUT_LIMIT);
    st.set_dynamic_code_limits(256 * 1024, 1024 * 1024, 64, 512, 256);
    st.disable_vm_jit();
}

fn parse_script_response(raw: &str) -> BackendHttpResponse {
    let parsed: Value = serde_json::from_str(raw).unwrap_or_else(|_| {
        json!({ "status": 200, "headers": [["Content-Type", "text/plain; charset=utf-8"]], "body": raw })
    });
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
    BackendHttpResponse {
        status,
        headers,
        body,
    }
}

fn parse_headers_json(val: &Value) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let sanitize = |s: &str| s.replace(['\r', '\n', '\0'], "");
    match val {
        Value::Array(arr) => {
            for item in arr {
                if let Some(pair) = item.as_array() {
                    if pair.len() >= 2 {
                        if let (Some(k), Some(v)) = (pair[0].as_str(), pair[1].as_str()) {
                            let ck = sanitize(k);
                            if !ck.is_empty() {
                                out.push((ck, sanitize(v)));
                            }
                        }
                    }
                }
            }
        }
        Value::Object(map) => {
            for (k, v) in map {
                let ck = sanitize(k);
                if ck.is_empty() {
                    continue;
                }
                if let Some(s) = v.as_str() {
                    out.push((ck, sanitize(s)));
                } else {
                    out.push((ck, sanitize(&v.to_string())));
                }
            }
        }
        _ => {}
    }
    out
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
