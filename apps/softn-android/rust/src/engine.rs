//! Core SoftN Mobile Runtime Engine powered by `zipp-browser` (`zipp-dom` + `zipp-renderer`)
//! and `zipp-vm` (frontend JS/TS/React + full-stack Container v2 backend + native SQLite).

use std::cell::Cell;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use anyrender::PaintScene;
use linebender_resource_handle::Blob;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use ureq::unversioned::resolver::{DefaultResolver, ResolvedSocketAddrs, Resolver};
use ureq::unversioned::transport::DefaultConnector;
use zipp_dom::html_parser::{HtmlDocument, HtmlProvider};
use zipp_dom::traits_src::net::{Bytes, NetHandler, NetProvider, Request};
use zipp_dom::traits_src::shell::{ColorScheme, Viewport};
use zipp_dom::{BaseDocument, Document, DocumentConfig, FontContext, LocalName};
use zipp_renderer::tinyskia::TinySkiaPainter;
use zipp_vm::embed::{HostCtx, JsValue, ScriptState};
use zipp_vm::frontend::{compile_source, Frontend};

use crate::backend::{BackendHttpRequest, LocalContainerBackend, WallDeadlineGuard};
use crate::bundle::{
    canonical_ble_uuid, is_blocked_ip, resolve_vfs_url, strip_virtual_origin, SoftnBundle,
    VIRTUAL_ORIGIN,
};
use crate::http_cache::{BlobStore, CacheLookup, MobileCookieJar, MobileHttpCache};
use crate::{canvas, canvas2d, esm, html_seed};
use crate::sql::{RequestSqlBridge, SqlStorage};

const HTTP_TIMEOUT_GLOBAL: Duration = Duration::from_secs(20);
const HTTP_TIMEOUT_CONNECT: Duration = Duration::from_secs(10);
const HTTP_TIMEOUT_READ: Duration = Duration::from_secs(15);
const MAX_HTTP_RESPONSE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_HTTP_REDIRECTS: usize = 5;
const MAX_IDB_NAME_BYTES: usize = 120;
const MAX_IDB_ENTRY_BYTES: usize = 16 * 1024 * 1024;
const MAX_IDB_FILES: usize = 64;
const MAX_STORAGE_KEY_BYTES: usize = 1024;
const MAX_STORAGE_VAL_BYTES: usize = 2 * 1024 * 1024;
const MAX_LOCAL_STORAGE_KEYS: usize = 1024;
const MAX_SESSION_STORAGE_KEYS: usize = 256;
const MAX_XDB_COLLECTIONS: usize = 64;
const MAX_PENDING_DEVICE_CALLS: usize = 64;
const MAX_OPEN_WS: usize = 64;
const MAX_SINGLE_BLOB_BYTES: usize = 32 * 1024 * 1024;
const MAX_PARSE_HTML_BYTES: usize = 4 * 1024 * 1024;
const FRONTEND_BOOT_STEP_BUDGET: u64 = 2_000_000_000;
const FRONTEND_INTERACT_STEP_BUDGET: u64 = 500_000_000;
const FRONTEND_HEAP_LIMIT_BYTES: usize = 128 * 1024 * 1024;
const FRONTEND_BOOT_WALL_MS: u64 = 15_000;
const FRONTEND_INTERACT_WALL_MS: u64 = if cfg!(debug_assertions) { 15_000 } else { 10_000 };
const MAX_DRAIN_WALL_MS: u64 = 5_000;
const RUST_TIMER_POLL_INTERVAL: Duration = Duration::from_millis(100);
const MAX_DATA_URL_BYTES: usize = 32 * 1024 * 1024;

/// Custom DNS resolver checking every resolved IP against `is_blocked_ip` at connection time.
/// Eliminates DNS-rebinding TOCTOU gaps for sandboxed external egress.
#[derive(Debug)]
struct SsrfSafeResolver {
    inner: DefaultResolver,
}

impl Resolver for SsrfSafeResolver {
    fn resolve(
        &self,
        uri: &ureq::http::Uri,
        config: &ureq::config::Config,
        timeout: ureq::unversioned::transport::NextTimeout,
    ) -> Result<ResolvedSocketAddrs, ureq::Error> {
        let addrs = self.inner.resolve(uri, config, timeout)?;
        for addr in addrs.iter() {
            if is_blocked_ip(addr.ip()) {
                return Err(ureq::Error::HostNotFound);
            }
        }
        Ok(addrs)
    }
}

/// Process-wide hardened HTTP agent: pools TCP/TLS connections across requests while enforcing
/// SSRF-safe DNS resolution, strict timeouts, proxy bypass prevention, and manual redirect checks.
static HTTP_AGENT: LazyLock<ureq::Agent> = LazyLock::new(|| {
    let config = ureq::config::Config::builder()
        .timeout_global(Some(HTTP_TIMEOUT_GLOBAL))
        .timeout_connect(Some(HTTP_TIMEOUT_CONNECT))
        .timeout_recv_body(Some(HTTP_TIMEOUT_READ))
        .http_status_as_error(false)
        .max_redirects(0)
        .proxy(None)
        .build();
    ureq::Agent::with_parts(
        config,
        DefaultConnector::default(),
        SsrfSafeResolver {
            inner: DefaultResolver::default(),
        },
    )
});

const ZIPP_CONSOLE_SHIM: &str =
    include_str!("../../../../../zipp-browser/apps/browser/src/console_shim.js");
const ZIPP_CLONE_JS: &str =
    include_str!("../../../../../zipp-browser/apps/browser/src/clone.js");
const ZIPP_DOM_SHIM: &str =
    include_str!("../../../../../zipp-browser/apps/browser/src/dom_shim.js");
const ZIPP_IDB_SHIM: &str =
    include_str!("../../../../../zipp-browser/apps/browser/src/indexeddb_shim.js");
const ZIPP_WEBGL_SHIM: &str =
    include_str!("../../../../../zipp-browser/apps/browser/src/webgl_shim.js");
const ZIPP_CANVAS2D_SHIM: &str =
    include_str!("../../../../../zipp-browser/apps/browser/src/canvas2d_shim.js");
const SOFTN_PRELUDE_JS: &str = include_str!("softn_prelude.js");

const HOST_PRELUDE_JS: &str = r#"
var __zippHostBytes = new Uint8Array(65536);
var __zippCredentials = "";
var __zippRequestHeaders = "";
function __zippFetchBytes(url, credentials) {
    var info = JSON.parse(__zippHostCall("http_bytes", String(url), credentials || ""));
    if (info && info.error && !info.status) {
        throw new TypeError(String(info.error));
    }
    var len = (info && info.len) || 0;
    if (__zippHostBytes.length < len) {
        __zippHostBytes = new Uint8Array(Math.max(len, __zippHostBytes.length * 2));
    }
    __zippHostCall("take_bytes");
    var buf = __zippHostBytes.slice(0, len).buffer;
    if (__zippHostBytes.length > 262144) {
        __zippHostBytes = new Uint8Array(65536);
    }
    return buf;
}
var env = {
    log: function (level, message) {
        __zippHostCall("log", String(level), String(message));
    }
};
var http = (function () {
    function request(method, url, body, contentType) {
        var credentials = __zippCredentials || "same-origin";
        var extraHeaders = __zippRequestHeaders;
        __zippCredentials = "";
        __zippRequestHeaders = "";
        var headers = {};
        if (extraHeaders) {
            try {
                var parsed = JSON.parse(extraHeaders);
                if (parsed && typeof parsed === "object") headers = parsed;
            } catch (e) {}
        }
        if (contentType && !headers["Content-Type"] && !headers["content-type"]) {
            headers["Content-Type"] = String(contentType);
        }
        var raw = __zippHostCall(
            "softn.fetch",
            method,
            String(url),
            JSON.stringify(headers),
            body == null ? "" : String(body),
            credentials
        );
        var r = JSON.parse(raw);
        if (r && r.error && !r.status) {
            throw new TypeError(String(r.error));
        }
        var hdrMap = {};
        if (Array.isArray(r.headers)) {
            for (var i = 0; i < r.headers.length; i++) {
                var p = r.headers[i];
                if (p && p.length >= 2) hdrMap[String(p[0]).toLowerCase()] = String(p[1]);
            }
        }
        var status = r.status || 200;
        return {
            status: status,
            ok: status >= 200 && status < 300,
            body: r.body || "",
            contentType: hdrMap["content-type"] || "",
            headers: hdrMap
        };
    }
    return {
        request: request,
        get: function (url) { return request("GET", url, "", ""); },
        head: function (url) { return request("HEAD", url, "", ""); },
        post: function (url, body, ct) { return request("POST", url, body, ct); },
        put: function (url, body, ct) { return request("PUT", url, body, ct); },
        patch: function (url, body, ct) { return request("PATCH", url, body, ct); },
        "delete": function (url) { return request("DELETE", url, "", ""); }
    };
})();
var __zippDrainStats = { rounds: 0, timers: 0, micro: 0, raf: 0 };
function __zippDrainQueues(rounds) {
    var did = 0;
    for (var i = 0; i < rounds; i++) {
        if (typeof __zippDueTimers === "function") __zippDueTimers();
        if (__timerQueue.length === 0 && __mcQueue.length === 0) break;
        __zippDrainStats.rounds++;
        var tLimit = 64;
        while (__timerQueue.length > 0 && tLimit-- > 0) {
            __zippDrainStats.timers++;
            did++;
            try { __timerQueue.shift()(); }
            catch (e) { env.log("error", "timer callback threw: " + ((e && (e.stack || e.message)) || e)); }
        }
        var mLimit = 128;
        while (__mcQueue.length > 0 && mLimit-- > 0) {
            __zippDrainStats.micro++;
            did++;
            try { __mcQueue.shift()(); }
            catch (e) { env.log("error", "microtask threw: " + ((e && (e.stack || e.message)) || e)); }
        }
    }
    return did;
}
function __zippStepRaf() {
    var now = typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
    var ran = 0;
    if (typeof __zippRunAnimationFrame === "function" && typeof __rafQueue !== "undefined" && __rafQueue.length > 0) {
        ran = __zippRunAnimationFrame(now);
        __zippDrainStats.raf += ran;
    }
    if (typeof __zippPresentCanvases === "function") {
        __zippPresentCanvases();
    }
    return ran;
}
function __zippHasPendingRaf() {
    return (
        typeof __rafQueue !== "undefined" &&
        __rafQueue.length > 0 &&
        typeof __zippCanvasContexts !== "undefined" &&
        __zippCanvasContexts.length > 0
    );
}
function __zippHasAnyRaf() {
    return typeof __rafQueue !== "undefined" && __rafQueue.length > 0;
}
function __getHtmlClassOnly() {
    try { return String((doc.documentElement && doc.documentElement.className) || ""); }
    catch (e) { return ""; }
}
function __getHtmlClass() {
    try {
        var el = doc.documentElement;
        if (!el) return "";
        var esc = function (s) {
            return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        };
        var out = [];
        if (el.className) out.push('class="' + esc(el.className) + '"');
        for (var k in el.attributes) {
            if (k === "class" || k === "style") continue;
            if (!/^[a-zA-Z_][a-zA-Z0-9_:-]*$/.test(k)) continue;
            out.push(k + '="' + esc(el.attributes[k]) + '"');
        }
        var sp = [];
        if (el.attributes && el.attributes.style) sp.push(String(el.attributes.style).replace(/;+$/, ""));
        if (el.style && typeof el.style === "object") {
            var sk = Object.keys(el.style);
            for (var i = 0; i < sk.length; i++) {
                var p = sk[i];
                if (p === "cssText" || p === "length") continue;
                var v = el.style[p];
                if (v === undefined || v === null || v === "" || typeof v === "function") continue;
                var cssName = p.indexOf("--") === 0 ? p : p.replace(/[A-Z]/g, function (m) { return "-" + m.toLowerCase(); });
                sp.push(cssName + ":" + String(v));
            }
        }
        if (sp.length > 0) out.push('style="' + esc(sp.join(";")) + '"');
        return out.join(" ");
    } catch (e) { return ""; }
}
function __zippDispatchEvent(handlerNid, targetNid, type) {
    var byType = __eventHandlers[handlerNid];
    if (!byType) return false;
    var handlers = byType[type];
    if (!handlers || handlers.length === 0) return false;
    var target = __nodesById[targetNid] || __nodesById[handlerNid] || null;
    var currentTarget = __nodesById[handlerNid] || null;
    var defaultPrevented = false;
    var propagationStopped = false;
    var immediateStopped = false;
    var ev = {
        type: type,
        target: target,
        srcElement: target,
        currentTarget: currentTarget,
        eventPhase: 2,
        bubbles: true,
        cancelable: true,
        isTrusted: true,
        timeStamp: Date.now ? Date.now() : 0,
        detail: 1,
        button: 0,
        buttons: 1,
        clientX: 0, clientY: 0, pageX: 0, pageY: 0, screenX: 0, screenY: 0,
        altKey: false, ctrlKey: false, metaKey: false, shiftKey: false,
        get defaultPrevented() { return defaultPrevented; },
        preventDefault: function () { defaultPrevented = true; },
        stopPropagation: function () { propagationStopped = true; },
        stopImmediatePropagation: function () { propagationStopped = true; immediateStopped = true; },
        composedPath: function () {
            var path = [], n = target;
            while (n) { path.push(n); n = n.parentNode; }
            return path;
        }
    };
    ev.nativeEvent = ev;
    for (var i = 0; i < handlers.length; i++) {
        try { handlers[i](ev); }
        catch (e) { env.log("error", "handler for " + type + " threw: " + ((e && (e.stack || e.message)) || e)); }
        if (immediateStopped) break;
    }
    return defaultPrevented;
}
"#;

const SOFTN_UI_CSS: &str = r#"
:root {
  --softn-bg: #0f172a;
  --softn-surface: #1e293b;
  --softn-border: #334155;
  --softn-fg: #f8fafc;
  --softn-muted: #94a3b8;
  --softn-primary: #3b82f6;
  --softn-success: #10b981;
  --softn-warn: #f59e0b;
  --softn-danger: #ef4444;
  --softn-radius: 12px;
}
* { box-sizing: border-box; }
html, body {
  margin: 0;
  padding: 0;
  font-family: system-ui, -apple-system, sans-serif;
  background: var(--softn-bg);
  color: var(--softn-fg);
  font-size: 15px;
  line-height: 1.45;
}
.stack { display: flex; flex-direction: column; }
.row { display: flex; flex-direction: row; align-items: center; }
.between { justify-content: space-between; }
.wrap { flex-wrap: wrap; }
.gap-xs { gap: 6px; }
.gap-sm { gap: 10px; }
.gap-md { gap: 14px; }
.gap-lg { gap: 20px; }
.card {
  background: var(--softn-surface);
  border: 1px solid var(--softn-border);
  border-radius: var(--softn-radius);
  padding: 14px;
}
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 10px 14px;
  border-radius: 10px;
  border: 1px solid var(--softn-border);
  background: var(--softn-surface);
  color: var(--softn-fg);
  font-weight: 600;
  font-size: 14px;
}
.btn.primary { background: var(--softn-primary); border-color: var(--softn-primary); color: #ffffff; }
.btn.success { background: var(--softn-success); border-color: var(--softn-success); color: #ffffff; }
.btn.danger { background: var(--softn-danger); border-color: var(--softn-danger); color: #ffffff; }
.badge {
  display: inline-block;
  padding: 3px 9px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
  background: rgba(59, 130, 246, 0.2);
  color: #93c5fd;
}
input, textarea, select {
  width: 100%;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid var(--softn-border);
  background: #0b1220;
  color: var(--softn-fg);
  font-size: 14px;
}
"#;

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct HostDeviceInfo {
    #[serde(default = "default_platform")]
    pub platform: String,
    #[serde(default = "default_engine")]
    pub engine: String,
    #[serde(default)]
    pub os_version: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub capabilities: HashMap<String, bool>,
    /// Optional explicit allowlist of capabilities granted by the user / host UI
    /// (used in Player Mode so untrusted third-party `.softn` bundles cannot self-grant
    /// sensitive permissions merely by listing them in `permission.json`).
    /// When `None` (Standalone Mode / tests), `permission.json` alone governs access.
    #[serde(default)]
    pub granted_capabilities: Option<Vec<String>>,
    /// When `true` (Player Mode running user-opened third-party `.softn` files),
    /// persistent app storage is keyed by the bundle's cryptographic SHA-256 digest
    /// instead of `manifest.id` so a malicious bundle cannot spoof another app's ID.
    #[serde(default)]
    pub player_mode: bool,
}

impl HostDeviceInfo {
    pub fn host_allows_capability(&self, cap: &str) -> bool {
        match &self.granted_capabilities {
            None => true,
            Some(list) => list.iter().any(|c| c == cap),
        }
    }
}

fn default_platform() -> String {
    "android".to_string()
}
fn default_engine() -> String {
    "zipp-browser-android".to_string()
}

impl Default for HostDeviceInfo {
    fn default() -> Self {
        let mut capabilities = HashMap::new();
        capabilities.insert("camera".into(), true);
        capabilities.insert("bluetooth".into(), true);
        capabilities.insert("location".into(), true);
        capabilities.insert("haptics".into(), true);
        capabilities.insert("notifications".into(), true);
        Self {
            platform: default_platform(),
            engine: default_engine(),
            os_version: "16".into(),
            model: "Android".into(),
            capabilities,
            granted_capabilities: None,
            player_mode: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingDeviceRequest {
    pub id: u64,
    pub namespace: String,
    pub method: String,
    pub params: Value,
}

#[derive(Debug, Clone, Serialize)]
pub struct SelectPickerRequest {
    pub flid: u32,
    pub selected_index: i32,
    pub options: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct InteractionResult {
    pub dirty: bool,
    pub wants_raf: bool,
    pub has_canvas: bool,
    pub next_timer_ms: i64,
    pub ime_changed: bool,
    pub wants_ime: bool,
    pub input_text: String,
    pub input_type: String,
    pub pending_calls: Vec<PendingDeviceRequest>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub select_picker: Option<SelectPickerRequest>,
}

thread_local! {
    /// Scoped read-only pointer to the active `BaseDocument` during synchronous JS execution
    /// so `getComputedStyle()` queries Stylo on demand instead of eagerly serializing 14 CSS
    /// properties for every DOM node on every rebuild.
    static ACTIVE_LAYOUT_DOC: Cell<*const BaseDocument> = const { Cell::new(std::ptr::null()) };
}

struct LayoutDocGuard {
    prev: *const BaseDocument,
}

impl LayoutDocGuard {
    fn enter(doc: &BaseDocument) -> Self {
        let prev = ACTIVE_LAYOUT_DOC.with(|c| c.replace(doc as *const BaseDocument));
        Self { prev }
    }
}

impl Drop for LayoutDocGuard {
    fn drop(&mut self) {
        ACTIVE_LAYOUT_DOC.with(|c| c.set(self.prev));
    }
}

/// Snapshot of laid-out CSS box metrics (`clientWidth`/`clientHeight`/`getBoundingClientRect`),
/// `flid -> dom` mapping for lazy `getComputedStyle`, and hit-test rects (`elementFromPoint`)
/// exposed synchronously to JS via `__zippHostCall`.
#[derive(Default)]
struct LayoutCache {
    boxes: HashMap<u32, [f32; 6]>,
    rects: HashMap<u32, [f32; 4]>,
    order: Vec<u32>,
    flid_to_dom: HashMap<u32, usize>,
    scroll_x: f64,
    scroll_y: f64,
}

impl LayoutCache {
    fn update_from_doc(
        &mut self,
        doc: &BaseDocument,
        flid_to_dom: &HashMap<u32, usize>,
        scroll_x: f64,
        scroll_y: f64,
    ) {
        self.boxes.clear();
        self.rects.clear();
        self.order.clear();
        self.flid_to_dom.clear();
        self.scroll_x = scroll_x;
        self.scroll_y = scroll_y;
        let mut pairs: Vec<(usize, u32)> = flid_to_dom.iter().map(|(&f, &n)| (n, f)).collect();
        pairs.sort_unstable_by_key(|&(node_id, _)| node_id);
        self.boxes.reserve(pairs.len());
        self.rects.reserve(pairs.len());
        self.order.reserve(pairs.len());
        self.flid_to_dom.reserve(pairs.len());
        for (node_id, flid) in pairs {
            let Some(node) = doc.get_node(node_id) else {
                continue;
            };
            let l = &node.final_layout;
            let client_w =
                (l.size.width - l.border.left - l.border.right - l.scrollbar_size.width).max(0.0);
            let client_h =
                (l.size.height - l.border.top - l.border.bottom - l.scrollbar_size.height).max(0.0);
            let content_w = (client_w - l.padding.left - l.padding.right).max(0.0);
            let content_h = (client_h - l.padding.top - l.padding.bottom).max(0.0);
            self.boxes.insert(
                flid,
                [l.size.width, l.size.height, client_w, client_h, content_w, content_h],
            );
            let (tx, ty, tw, th) = node.transformed_border_rect();
            self.rects.insert(flid, [tx as f32, ty as f32, tw as f32, th as f32]);
            self.order.push(flid);
            self.flid_to_dom.insert(flid, node_id);
        }
    }

    /// O(1) update when only the root viewport scroll offset changed.
    fn set_viewport_scroll(&mut self, scroll_x: f64, scroll_y: f64) {
        self.scroll_x = scroll_x;
        self.scroll_y = scroll_y;
    }

    /// Fast rect-only refresh for nested container scrolls (never recomputes box sizes or CSS strings).
    fn update_rects_from_doc(
        &mut self,
        doc: &BaseDocument,
        flid_to_dom: &HashMap<u32, usize>,
        scroll_x: f64,
        scroll_y: f64,
    ) {
        self.scroll_x = scroll_x;
        self.scroll_y = scroll_y;
        for (&flid, &node_id) in flid_to_dom {
            if let Some(node) = doc.get_node(node_id) {
                let (tx, ty, tw, th) = node.transformed_border_rect();
                self.rects
                    .insert(flid, [tx as f32, ty as f32, tw as f32, th as f32]);
            }
        }
    }

    fn format_box(&self, flid_str: &str) -> String {
        let Ok(flid) = flid_str.parse::<u32>() else {
            return String::new();
        };
        let Some(b) = self.boxes.get(&flid) else {
            return String::new();
        };
        format!("[{},{},{},{},{},{}]", b[0], b[1], b[2], b[3], b[4], b[5])
    }

    fn format_rect(&self, flid_str: &str) -> String {
        let Ok(flid) = flid_str.parse::<u32>() else {
            return String::new();
        };
        let Some(r) = self.rects.get(&flid) else {
            return String::new();
        };
        format!(
            "[{},{},{},{}]",
            f64::from(r[0]) - self.scroll_x,
            f64::from(r[1]) - self.scroll_y,
            r[2],
            r[3]
        )
    }

    fn format_style(&self, flid_str: &str, prop: &str) -> String {
        let Ok(flid) = flid_str.parse::<u32>() else {
            return String::new();
        };
        let Some(&node_id) = self.flid_to_dom.get(&flid) else {
            return String::new();
        };
        let trimmed = prop.trim();
        if trimmed.is_empty() {
            return String::new();
        }
        ACTIVE_LAYOUT_DOC.with(|cell| {
            let ptr = cell.get();
            if ptr.is_null() {
                return String::new();
            }
            // SAFETY: `LayoutDocGuard` ensures `ptr` points to the immutably borrowed
            // `BaseDocument` for the exact dynamic extent of synchronous JS execution.
            let doc = unsafe { &*ptr };
            doc.get_node(node_id)
                .and_then(|n| n.computed_style_value(trimmed))
                .unwrap_or_default()
        })
    }

    fn hit(&self, x_str: &str, y_str: &str) -> String {
        let (Ok(x), Ok(y)) = (x_str.parse::<f32>(), y_str.parse::<f32>()) else {
            return String::new();
        };
        let doc_x = x + self.scroll_x as f32;
        let doc_y = y + self.scroll_y as f32;
        for &flid in self.order.iter().rev() {
            if let Some(&[rx, ry, rw, rh]) = self.rects.get(&flid) {
                if rw > 0.0 && rh > 0.0 && doc_x >= rx && doc_x <= rx + rw && doc_y >= ry && doc_y <= ry + rh {
                    return flid.to_string();
                }
            }
        }
        String::new()
    }
}

/// Zero-latency synchronous `NetProvider` serving `blob:` URIs, `data:` URIs
/// (such as captured camera photos), `.softn` archive assets, and cached/cookie-aware
/// `net`-permitted HTTPS resources straight into `zipp-dom`.
struct VfsNetProvider {
    bundle: Arc<SoftnBundle>,
    blobs: Arc<BlobStore>,
    http_cache: Arc<MobileHttpCache>,
    cookies: Arc<MobileCookieJar>,
    host_allows_net: bool,
}

fn looks_like_svg(url: &str, bytes: &[u8]) -> bool {
    let url_lower = url.to_ascii_lowercase();
    let path_part = url_lower.split(['?', '#']).next().unwrap_or("");
    if path_part.ends_with(".svg") || path_part.ends_with(".svgz") || url_lower.starts_with("data:image/svg+xml") {
        return true;
    }
    // The image handler hands any bytes it cannot decode as raster to `usvg`, whatever the URL
    // says, so every payload its XML parser could accept has to be sanitized. That parser allows
    // nothing ahead of the first `<` except a UTF-8 BOM and whitespace, which covers a leading
    // comment, a long prolog, a DOCTYPE and a prefixed `<s:svg>` root without scanning for
    // markers. Searching the whole payload for `<svg` instead sent stylesheets through the
    // sanitizer: one with an inline `data:image/svg+xml` icon and a `@media (width < 600px)`
    // query was dropped as malformed SVG and the page rendered unstyled. No raster or font
    // format starts this way, so those need no separate check.
    let body = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    body.iter().find(|b| !b.is_ascii_whitespace()) == Some(&b'<')
}

fn deliver_sanitized_bytes(url_str: &str, bytes: Vec<u8>, handler: Box<dyn NetHandler>) {
    // Reject gzip-compressed payloads (e.g. `.svgz` or disguised gzipped SVG that `usvg`
    // would natively decompress without going through `sanitize_svg_for_raster`).
    if bytes.starts_with(&[0x1f, 0x8b]) {
        return;
    }
    let payload = if looks_like_svg(url_str, &bytes) {
        match crate::canvas2d::sanitize_svg_for_raster(&bytes) {
            Some(clean) => clean,
            None => return,
        }
    } else {
        bytes
    };
    handler.bytes(url_str.to_string(), Bytes::from(payload));
}

impl NetProvider for VfsNetProvider {
    fn fetch(&self, _doc_id: usize, request: Request, handler: Box<dyn NetHandler>) {
        let url_str = request.url.as_str();
        if url_str.starts_with("blob:") {
            if let Some(bytes) = self.blobs.lookup_bytes(url_str) {
                deliver_sanitized_bytes(url_str, bytes, handler);
            }
            return;
        }
        if url_str.starts_with("data:") {
            if url_str.len() <= MAX_DATA_URL_BYTES {
                if let Ok(parsed) = data_url::DataUrl::process(url_str) {
                    if let Ok((body, _)) = parsed.decode_to_vec() {
                        if body.len() <= MAX_DATA_URL_BYTES {
                            deliver_sanitized_bytes(url_str, body, handler);
                        }
                    }
                }
            }
            return;
        }
        if let Some(rel) = strip_virtual_origin(url_str) {
            if let Some((_, _, bytes)) = self.bundle.read_public_asset(rel) {
                deliver_sanitized_bytes(url_str, bytes, handler);
            }
            return;
        }
        if self.host_allows_net && self.bundle.check_net_url(url_str).is_ok() {
            let revalidate = match self.http_cache.lookup(url_str) {
                CacheLookup::Fresh(entry) => {
                    deliver_sanitized_bytes(url_str, entry.body.as_ref().clone(), handler);
                    return;
                }
                CacheLookup::Revalidate(entry) => Some(entry),
                CacheLookup::Miss => None,
            };
            let mut cond_headers = Vec::new();
            if let Some(ref prev) = revalidate {
                if let Some(ref etag) = prev.etag {
                    cond_headers.push(("If-None-Match".to_string(), etag.clone()));
                }
                if let Some(ref lm) = prev.last_modified {
                    cond_headers.push(("If-Modified-Since".to_string(), lm.clone()));
                }
            }
            // Subresource fetches to external origins are cross-origin: do not send/store ambient cookies.
            if let Ok((final_url, status, resp_hdrs, bytes, sent_cookie)) =
                execute_safe_http_request(
                    &self.bundle,
                    &self.cookies,
                    "GET",
                    url_str,
                    &cond_headers,
                    "",
                    false,
                )
            {
                if status == 304 {
                    if let Some(prev) = revalidate {
                        let refreshed = self.http_cache.revalidate_304(url_str, prev, &resp_hdrs);
                        deliver_sanitized_bytes(url_str, refreshed.body.as_ref().clone(), handler);
                        return;
                    }
                }
                if final_url == url_str && !sent_cookie {
                    self.http_cache.store(url_str, status, &resp_hdrs, bytes.clone());
                }
                deliver_sanitized_bytes(url_str, bytes, handler);
            }
        }
    }
}

pub struct SoftnMobileEngine {
    pub bundle: Arc<SoftnBundle>,
    pub backend: Option<Arc<LocalContainerBackend>>,
    pub storage: SqlStorage,
    app_data_dir: PathBuf,
    blobs: Arc<BlobStore>,
    http_cache: Arc<MobileHttpCache>,
    cookies: Arc<MobileCookieJar>,
    host_allows_net: bool,
    session_storage: Arc<Mutex<HashMap<String, String>>>,
    js_state: Option<ScriptState>,
    js_abort: Arc<AtomicBool>,
    doc: HtmlDocument,
    painter: TinySkiaPainter,
    head_css: String,
    width: u32,
    height: u32,
    scale: f32,
    scroll_x: f64,
    scroll_y: f64,
    focused_flid: Option<u32>,
    active_canvas_flid: Option<u32>,
    last_pointer_phys: (f32, f32),
    flid_to_dom: HashMap<u32, usize>,
    dom_to_flid: HashMap<usize, u32>,
    canvas_flids: Vec<u32>,
    layout_cache: Arc<Mutex<LayoutCache>>,
    pending_calls: Arc<Mutex<Vec<PendingDeviceRequest>>>,
    pub logs: Arc<Mutex<Vec<String>>>,
    last_synced_html: String,
    last_dom_mutations: i64,
    last_rust_poll: Instant,
    rust_active_until: Instant,
    open_ws_count: Arc<AtomicUsize>,
    last_user_gesture_ms: Arc<AtomicU64>,
    layout_dirty: bool,
    full_repaint: bool,
    dirty_canvas_nodes: Vec<usize>,
    dirty: bool,
}

impl Drop for SoftnMobileEngine {
    fn drop(&mut self) {
        canvas::forget_shown();
        canvas2d::reset_all();
        #[cfg(target_os = "android")]
        crate::webgl::reset_all();
        self.blobs.clear();
    }
}

impl SoftnMobileEngine {
    pub fn load_bundle(
        bundle_bytes: &[u8],
        data_root: &Path,
        width: u32,
        height: u32,
        scale: f32,
        host_info: HostDeviceInfo,
    ) -> Result<Self, String> {
        canvas::forget_shown();
        canvas2d::reset_all();
        #[cfg(target_os = "android")]
        crate::webgl::reset_all();

        let bundle = Arc::new(SoftnBundle::from_zip_bytes(bundle_bytes)?);
        let storage_id = bundle.storage_dir_id(host_info.player_mode);
        let app_data_dir = data_root.join(&storage_id);
        let _ = std::fs::create_dir_all(&app_data_dir);
        let databases = bundle.manifest.databases.clone().unwrap_or_default();
        let storage = SqlStorage::new(&app_data_dir, databases)?;
        storage.preseed_all(&bundle.vfs)?;
        let backend = LocalContainerBackend::new(&bundle, storage.clone())?.map(Arc::new);
        let blobs = Arc::new(BlobStore::new());
        let http_cache = Arc::new(MobileHttpCache::open(&app_data_dir));
        let cookies = Arc::new(MobileCookieJar::open(&app_data_dir));
        let host_allows_net = host_info.host_allows_capability("net");
        let session_storage: Arc<Mutex<HashMap<String, String>>> =
            Arc::new(Mutex::new(HashMap::new()));

        let pending_calls: Arc<Mutex<Vec<PendingDeviceRequest>>> =
            Arc::new(Mutex::new(Vec::new()));
        let logs: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let layout_cache: Arc<Mutex<LayoutCache>> = Arc::new(Mutex::new(LayoutCache::default()));

        // Load initial HTML either from static VFS entry or from SSR backend (`GET /`)
        let raw_html = if !bundle.entry_path.is_empty() {
            bundle
                .read_text(&bundle.entry_path)
                .ok_or_else(|| format!("Entry file missing: {}", bundle.entry_path))?
        } else if let Some(ref be) = backend {
            let resp = be.handle_request(BackendHttpRequest {
                method: "GET".into(),
                path: "/".into(),
                query: String::new(),
                headers: vec![("Accept".into(), "text/html".into())],
                body: Vec::new(),
            });
            String::from_utf8_lossy(&resp.body).into_owned()
        } else {
            return Err("Bundle has neither index.html nor SSR backend".into());
        };

        let head_css = collect_head_css(&raw_html, &bundle);
        let initial_body = extract_body_inner_html(&raw_html);
        let initial_html_attrs = extract_html_open_attrs(&raw_html);
        let initial_html_attrs_str = initial_html_attrs
            .iter()
            .map(|(k, v)| format!("{k}=\"{}\"", escape_html_attr_val(v)))
            .collect::<Vec<_>>()
            .join(" ");

        let logical_w = ((width.max(1) as f32) / scale.max(1.0)).round().max(320.0) as u32;
        let logical_h = ((height.max(1) as f32) / scale.max(1.0)).round().max(480.0) as u32;
        let js_abort = Arc::new(AtomicBool::new(false));
        let open_ws_count = Arc::new(AtomicUsize::new(0));
        let last_user_gesture_ms = Arc::new(AtomicU64::new(0));

        // Boot frontend JavaScript/TypeScript inside `zipp-vm`
        let js_state = boot_frontend_vm(
            &raw_html,
            &initial_body,
            &initial_html_attrs,
            logical_w,
            logical_h,
            scale,
            &bundle,
            backend.as_ref(),
            &storage,
            &app_data_dir,
            Arc::clone(&blobs),
            Arc::clone(&http_cache),
            Arc::clone(&cookies),
            Arc::clone(&session_storage),
            host_info,
            Arc::clone(&layout_cache),
            Arc::clone(&pending_calls),
            Arc::clone(&logs),
            Arc::clone(&js_abort),
            Arc::clone(&open_ws_count),
            Arc::clone(&last_user_gesture_ms),
        )?;

        let mut engine = Self {
            bundle: Arc::clone(&bundle),
            backend,
            storage,
            app_data_dir,
            blobs: Arc::clone(&blobs),
            http_cache: Arc::clone(&http_cache),
            cookies: Arc::clone(&cookies),
            host_allows_net,
            session_storage,
            js_state,
            js_abort,
            doc: build_html_document(
                &compose_document_html(&head_css, &initial_body, &initial_html_attrs_str),
                &bundle,
                &blobs,
                &http_cache,
                &cookies,
                host_allows_net,
                width,
                height,
                scale,
                None,
            ),
            painter: TinySkiaPainter::new(width.max(1), height.max(1)),
            head_css,
            width: width.max(1),
            height: height.max(1),
            scale: scale.max(1.0),
            scroll_x: 0.0,
            scroll_y: 0.0,
            focused_flid: None,
            active_canvas_flid: None,
            last_pointer_phys: (
                (width.max(1) as f32) * 0.5,
                (height.max(1) as f32) * 0.5,
            ),
            flid_to_dom: HashMap::new(),
            dom_to_flid: HashMap::new(),
            canvas_flids: Vec::new(),
            layout_cache,
            pending_calls,
            logs,
            last_synced_html: String::new(),
            last_dom_mutations: -1,
            last_rust_poll: Instant::now() - Duration::from_secs(1),
            rust_active_until: Instant::now() + Duration::from_secs(2),
            open_ws_count,
            last_user_gesture_ms,
            layout_dirty: true,
            full_repaint: true,
            dirty_canvas_nodes: Vec::new(),
            dirty: true,
        };

        // Sync rendered DOM after initial JS execution + populate real LayoutCache bounds
        engine.sync_dom_from_vm();
        // Run initial animation frame so Canvas 2D scenes (e.g. 3D mine maps & charts)
        // measure their real LayoutCache container dimensions and render Frame 1 immediately.
        {
            let _wd = engine.renew_frontend_budget();
            let _doc_guard = LayoutDocGuard::enter(engine.doc.as_ref());
            if let Some(ref mut st) = engine.js_state {
                let _ = st.call_global("__zippStepRaf", &[]);
                drain_js(st);
                let _ = st.call_global("__zippEndSettle", &[]);
            }
        }
        engine.sync_dom_from_vm();
        Ok(engine)
    }

    pub fn resize(&mut self, width: u32, height: u32, scale: f32) {
        let w = width.max(1);
        let h = height.max(1);
        let s = scale.max(1.0);
        if self.width == w && self.height == h && (self.scale - s).abs() < 0.001 {
            return;
        }
        self.width = w;
        self.height = h;
        self.scale = s;
        self.painter.resize(w, h);
        let viewport = Viewport::new(w, h, s, self.color_scheme());
        self.doc.as_mut().set_viewport(viewport);
        self.doc.as_mut().resolve(0.0);
        if let Ok(mut lc) = self.layout_cache.lock() {
            lc.update_from_doc(self.doc.as_ref(), &self.flid_to_dom, self.scroll_x, self.scroll_y);
        }
        self.layout_dirty = false;
        self.full_repaint = true;
        self.dirty = true;
    }

    fn color_scheme(&self) -> ColorScheme {
        match self.bundle.manifest.theme.as_deref() {
            Some("light") => ColorScheme::Light,
            _ => ColorScheme::Dark,
        }
    }

    /// Paint the laid-out DOM into RGBA8888 pixel bytes (`width * height * 4` bytes).
    pub fn render_rgba(&mut self, out_rgba: &mut [u8]) -> bool {
        let expected = (self.width as usize) * (self.height as usize) * 4;
        if out_rgba.len() < expected {
            #[cfg(target_os = "android")]
            log::error!(
                "render_rgba: out_rgba too small ({} < {}) for {}x{}",
                out_rgba.len(),
                expected,
                self.width,
                self.height
            );
            return false;
        }
        if self.layout_dirty {
            self.doc.poll(None);
            self.doc.as_mut().resolve(0.0);
            if self.doc.poll(None) {
                self.doc.as_mut().resolve(0.0);
            }
            self.layout_dirty = false;
            self.full_repaint = true;
        }
        if self.full_repaint {
            self.painter.reset();
            zipp_renderer::paint_scene(
                &mut self.painter,
                self.doc.as_ref(),
                self.scale as f64,
                self.width,
                self.height,
                0,
                0,
            );
            self.full_repaint = false;
            self.dirty_canvas_nodes.clear();
        } else if !self.dirty_canvas_nodes.is_empty() {
            match self.compute_canvas_damage_rect() {
                CanvasDamage::Full => {
                    self.painter.reset();
                    zipp_renderer::paint_scene(
                        &mut self.painter,
                        self.doc.as_ref(),
                        self.scale as f64,
                        self.width,
                        self.height,
                        0,
                        0,
                    );
                }
                CanvasDamage::OpaqueRect(x0, y0, x1, y1) => {
                    self.painter.reset_damage_preserve(x0, y0, x1, y1);
                    zipp_renderer::paint_scene_from_nodes(
                        &mut self.painter,
                        self.doc.as_ref(),
                        self.scale as f64,
                        self.width,
                        self.height,
                        0,
                        0,
                        &self.dirty_canvas_nodes,
                    );
                }
                CanvasDamage::Rect(x0, y0, x1, y1) => {
                    self.painter.reset_damage(x0, y0, x1, y1);
                    zipp_renderer::paint_scene(
                        &mut self.painter,
                        self.doc.as_ref(),
                        self.scale as f64,
                        self.width,
                        self.height,
                        0,
                        0,
                    );
                }
                CanvasDamage::Offscreen => {
                    // All updated canvases are currently scrolled out of the viewport;
                    // the cached framebuffer is already bit-for-bit up to date.
                }
            }
            self.dirty_canvas_nodes.clear();
        }
        let src = self.painter.rgba_data();
        if src.len() >= expected {
            out_rgba[..expected].copy_from_slice(&src[..expected]);
            self.dirty = false;
            true
        } else {
            #[cfg(target_os = "android")]
            log::error!(
                "render_rgba: painter rgba_data too small ({} < {}) for {}x{}",
                src.len(),
                expected,
                self.width,
                self.height
            );
            false
        }
    }

    fn compute_canvas_damage_rect(&self) -> CanvasDamage {
        let doc = self.doc.as_ref();
        let scale = self.scale as f64;
        let fw = self.width as f64;
        let fh = self.height as f64;
        let (mut x0, mut y0, mut x1, mut y1) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);

        let mut all_opaque = true;
        for &node_id in &self.dirty_canvas_nodes {
            let Some(node) = doc.get_node(node_id) else {
                continue;
            };
            // Fall back to a full repaint if the canvas or any ancestor has a CSS transform,
            // opacity group, or filter blur so compositing stays 100% exact.
            let mut cur = Some(node_id);
            while let Some(cid) = cur {
                if let Some(n) = doc.get_node(cid) {
                    if let Some(st) = n.primary_styles() {
                        if !st.get_box().transform.0.is_empty()
                            || st.get_effects().opacity < 1.0
                            || !st.get_effects().filter.0.is_empty()
                        {
                            return CanvasDamage::Full;
                        }
                    }
                    cur = n.parent;
                } else {
                    break;
                }
            }
            if all_opaque {
                let is_opaque = node
                    .element_data()
                    .and_then(|e| e.raster_image_data())
                    .map(|img| {
                        let bytes: &[u8] = img.data.as_ref();
                        !bytes.is_empty()
                            && bytes.chunks_exact(4).step_by(64).all(|px| px[3] == 255)
                    })
                    .unwrap_or(false);
                if !is_opaque {
                    all_opaque = false;
                }
            }
            let at = node.absolute_position(0.0, 0.0);
            let lx = (at.x + node.scroll_offset.x as f32) as f64 - self.scroll_x;
            let ly = (at.y + node.scroll_offset.y as f32) as f64 - self.scroll_y;
            let lw = node.final_layout.size.width as f64;
            let lh = node.final_layout.size.height as f64;
            if lw <= 0.0 || lh <= 0.0 {
                continue;
            }
            x0 = x0.min(lx * scale - 2.0);
            y0 = y0.min(ly * scale - 2.0);
            x1 = x1.max((lx + lw) * scale + 2.0);
            y1 = y1.max((ly + lh) * scale + 2.0);
        }

        if !x0.is_finite() {
            return CanvasDamage::Offscreen;
        }
        let cx0 = x0.clamp(0.0, fw);
        let cy0 = y0.clamp(0.0, fh);
        let cx1 = x1.clamp(0.0, fw);
        let cy1 = y1.clamp(0.0, fh);
        if cx1 <= cx0 || cy1 <= cy0 {
            CanvasDamage::Offscreen
        } else if all_opaque && self.dirty_canvas_nodes.len() == 1 {
            CanvasDamage::OpaqueRect(cx0, cy0, cx1, cy1)
        } else {
            CanvasDamage::Rect(cx0, cy0, cx1, cy1)
        }
    }

    fn renew_frontend_budget(&mut self) -> WallDeadlineGuard {
        self.js_abort.store(false, Ordering::SeqCst);
        if let Some(ref mut st) = self.js_state {
            let _ = st.renew_step_budget(FRONTEND_INTERACT_STEP_BUDGET);
        }
        WallDeadlineGuard::arm(Arc::clone(&self.js_abort), FRONTEND_INTERACT_WALL_MS)
    }

    fn has_pending_raf(&mut self) -> bool {
        let Some(ref mut st) = self.js_state else {
            return false;
        };
        matches!(st.call_global("__zippHasPendingRaf", &[]), Ok(JsValue::Bool(true)))
    }

    fn has_any_raf_queued(&mut self) -> bool {
        let Some(ref mut st) = self.js_state else {
            return false;
        };
        matches!(st.call_global("__zippHasAnyRaf", &[]), Ok(JsValue::Bool(true)))
    }

    pub fn has_canvas(&self) -> bool {
        !self.canvas_flids.is_empty()
    }

    /// Milliseconds until the next scheduled JS or Rust backend timer is due (`-1` when idle).
    pub fn next_timer_ms(&mut self) -> i64 {
        let mut js_next: i64 = -1;
        if let Some(ref mut st) = self.js_state {
            if let Ok(JsValue::Number(n)) = st.call_global("__zippNextTimer", &[]) {
                if n.is_finite() && n >= 0.0 {
                    js_next = (n.ceil() as i64).min(60_000);
                }
            }
        }
        if self.backend.as_ref().is_some_and(|b| b.is_rust_backend())
            && (self.open_ws_count.load(Ordering::Relaxed) > 0
                || Instant::now() < self.rust_active_until)
        {
            return if js_next < 0 { 120 } else { js_next.min(120) };
        }
        js_next
    }

    fn build_interaction_result(
        &mut self,
        ime_changed: bool,
        wants_ime: bool,
        input_text: String,
        input_type: String,
        select_picker: Option<SelectPickerRequest>,
    ) -> InteractionResult {
        let wants_raf = self.has_pending_raf();
        let next_timer_ms = if wants_raf { 0 } else { self.next_timer_ms() };
        InteractionResult {
            dirty: self.dirty,
            wants_raf,
            has_canvas: self.has_canvas(),
            next_timer_ms,
            ime_changed,
            wants_ime,
            input_text,
            input_type,
            pending_calls: self.drain_pending_calls(),
            select_picker,
        }
    }

    /// Handle a tap at physical pixel coordinates `(x, y)` on Android.
    pub fn on_tap(&mut self, phys_x: f32, phys_y: f32) -> InteractionResult {
        self.last_user_gesture_ms.store(gesture_now_ms(), Ordering::Relaxed);
        let _watchdog = self.renew_frontend_budget();
        if self.backend.as_ref().is_some_and(|b| b.is_rust_backend()) {
            self.rust_active_until = Instant::now() + Duration::from_secs(2);
        }
        let logical_x = phys_x / self.scale + self.scroll_x as f32;
        let logical_y = phys_y / self.scale + self.scroll_y as f32;

        let mut wants_ime = false;
        let mut input_text = String::new();
        let mut input_type = "text".to_string();
        let mut select_picker: Option<SelectPickerRequest> = None;

        if let Some(hit) = self.doc.as_ref().hit(logical_x, logical_y) {
            let chain = self.doc.as_ref().node_chain(hit.node_id);
            let target_flid = chain
                .iter()
                .find_map(|id| self.dom_to_flid.get(id).copied());

            if let Some(flid) = target_flid {
                // Check whether the tapped element is an input/textarea/select/checkbox/submit button
                let meta = self.inspect_js_node(flid);
                let tag = meta
                    .get("tag")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let itype = meta
                    .get("type")
                    .and_then(|v| v.as_str())
                    .unwrap_or("text");

                if tag == "select" {
                    self.focused_flid = None;
                    if let Some(ref mut st) = self.js_state {
                        if let Ok(JsValue::String(raw)) = st.call_global(
                            "__softnInspectSelect",
                            &[JsValue::Number(f64::from(flid))],
                        ) {
                            if let Ok(parsed) = serde_json::from_str::<Value>(&raw) {
                                let opts: Vec<String> = parsed
                                    .get("options")
                                    .and_then(|v| v.as_array())
                                    .map(|arr| {
                                        arr.iter()
                                            .map(|o| {
                                                o.get("label")
                                                    .and_then(|l| l.as_str())
                                                    .unwrap_or("")
                                                    .to_string()
                                            })
                                            .collect()
                                    })
                                    .unwrap_or_default();
                                if !opts.is_empty() {
                                    let selected_index = parsed
                                        .get("selectedIndex")
                                        .and_then(|v| v.as_i64())
                                        .unwrap_or(0) as i32;
                                    select_picker = Some(SelectPickerRequest {
                                        flid,
                                        selected_index,
                                        options: opts,
                                    });
                                }
                            }
                        }
                    }
                } else if tag == "textarea"
                    || (tag == "input"
                        && itype != "checkbox"
                        && itype != "radio"
                        && itype != "submit"
                        && itype != "button")
                {
                    self.focused_flid = Some(flid);
                    wants_ime = true;
                    input_text = meta
                        .get("value")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    input_type = if tag == "textarea" {
                        "textarea".to_string()
                    } else {
                        itype.to_string()
                    };
                } else {
                    self.focused_flid = None;
                    if tag == "input" && itype == "checkbox" {
                        let _doc_guard = LayoutDocGuard::enter(self.doc.as_ref());
                        if let Some(ref mut st) = self.js_state {
                            stacker::maybe_grow(512 * 1024, 16 * 1024 * 1024, || {
                                let _ = st.call_global(
                                    "__softnToggleCheckbox",
                                    &[JsValue::Number(f64::from(flid))],
                                );
                            });
                        }
                    }
                }

                // Dispatch click along the ancestor chain in the JS VM (skip click if opening select picker)
                let mut flid_chain: Vec<u32> = Vec::new();
                for dom_id in &chain {
                    if let Some(&f) = self.dom_to_flid.get(dom_id) {
                        if !flid_chain.contains(&f) {
                            flid_chain.push(f);
                        }
                    }
                }
                if select_picker.is_none() {
                    {
                        let _doc_guard = LayoutDocGuard::enter(self.doc.as_ref());
                        if let Some(ref mut st) = self.js_state {
                            stacker::maybe_grow(512 * 1024, 16 * 1024 * 1024, || {
                                let mut prevented = false;
                                for handler_flid in &flid_chain {
                                    if let Ok(JsValue::Bool(true)) = st.call_global(
                                        "__zippDispatchEvent",
                                        &[
                                            JsValue::Number(f64::from(*handler_flid)),
                                            JsValue::Number(f64::from(flid)),
                                            JsValue::String("click".into()),
                                        ],
                                    ) {
                                        prevented = true;
                                    }
                                }
                                // If a submit button (or a child inside a submit button) was clicked and click didn't preventDefault, submit ancestor form
                                let is_submit_trigger = (tag == "button" && (itype == "submit" || itype == "text"))
                                    || (tag == "input" && itype == "submit");
                                if !prevented {
                                    if is_submit_trigger {
                                        let _ = st.call_global(
                                            "__softnSubmitAncestorForm",
                                            &[JsValue::Number(f64::from(flid))],
                                        );
                                    } else {
                                        // Check if any ancestor in flid_chain is a submit <button> (e.g., tapping an SVG/span inside a button)
                                        for &anc_flid in &flid_chain {
                                            if anc_flid == flid {
                                                continue;
                                            }
                                            let anc_json = match st.call_global(
                                                "__softnInspectNode",
                                                &[JsValue::Number(f64::from(anc_flid))],
                                            ) {
                                                Ok(JsValue::String(s)) => serde_json::from_str::<Value>(&s).unwrap_or_else(|_| json!({})),
                                                _ => json!({}),
                                            };
                                            let atag = anc_json.get("tag").and_then(|v| v.as_str()).unwrap_or("");
                                            let atype = anc_json.get("type").and_then(|v| v.as_str()).unwrap_or("text");
                                            if atag == "button" && (atype == "submit" || atype == "text") {
                                                let _ = st.call_global(
                                                    "__softnSubmitAncestorForm",
                                                    &[JsValue::Number(f64::from(anc_flid))],
                                                );
                                                break;
                                            }
                                        }
                                    }
                                }
                                drain_js(st);
                            });
                        }
                        // Step rAF once only if a callback or active canvas exists before syncing DOM.
                        if self.has_canvas() || self.has_any_raf_queued() {
                            if let Some(ref mut st) = self.js_state {
                                stacker::maybe_grow(512 * 1024, 16 * 1024 * 1024, || {
                                    let _ = st.call_global("__zippStepRaf", &[]);
                                    drain_js(st);
                                });
                            }
                        }
                    }
                    let prev_canvases = self.canvas_flids.clone();
                    self.sync_dom_from_vm();
                    // Only run a second rAF + DOM sync if the click mounted a brand-new <canvas>
                    // (now that LayoutCache has its real container size, render Frame 1 immediately).
                    if !self.canvas_flids.is_empty() && self.canvas_flids != prev_canvases {
                        {
                            let _doc_guard = LayoutDocGuard::enter(self.doc.as_ref());
                            if let Some(ref mut st) = self.js_state {
                                stacker::maybe_grow(512 * 1024, 16 * 1024 * 1024, || {
                                    let _ = st.call_global("__zippStepRaf", &[]);
                                    drain_js(st);
                                });
                            }
                        }
                        self.sync_dom_from_vm();
                    }
                }
            }
        }

        self.build_interaction_result(true, wants_ime, input_text, input_type, select_picker)
    }

    /// Select an option on a `<select>` element chosen from Android's native picker dialog.
    pub fn on_select_option(&mut self, flid: u32, index: i32) -> InteractionResult {
        self.last_user_gesture_ms.store(gesture_now_ms(), Ordering::Relaxed);
        let _watchdog = self.renew_frontend_budget();
        if self.backend.as_ref().is_some_and(|b| b.is_rust_backend()) {
            self.rust_active_until = Instant::now() + Duration::from_secs(2);
        }
        {
            let _doc_guard = LayoutDocGuard::enter(self.doc.as_ref());
            if let Some(ref mut st) = self.js_state {
                stacker::maybe_grow(512 * 1024, 16 * 1024 * 1024, || {
                    let _ = st.call_global(
                        "__softnSetSelectIndex",
                        &[JsValue::Number(f64::from(flid)), JsValue::Number(f64::from(index))],
                    );
                    drain_js(st);
                });
            }
            if self.has_canvas() || self.has_any_raf_queued() {
                if let Some(ref mut st) = self.js_state {
                    stacker::maybe_grow(512 * 1024, 16 * 1024 * 1024, || {
                        let _ = st.call_global("__zippStepRaf", &[]);
                        drain_js(st);
                    });
                }
            }
        }
        let prev_canvases = self.canvas_flids.clone();
        self.sync_dom_from_vm();
        if !self.canvas_flids.is_empty() && self.canvas_flids != prev_canvases {
            {
                let _doc_guard = LayoutDocGuard::enter(self.doc.as_ref());
                if let Some(ref mut st) = self.js_state {
                    stacker::maybe_grow(512 * 1024, 16 * 1024 * 1024, || {
                        let _ = st.call_global("__zippStepRaf", &[]);
                        drain_js(st);
                    });
                }
            }
            self.sync_dom_from_vm();
        }
        self.build_interaction_result(false, false, String::new(), "text".to_string(), None)
    }

    /// Begin a touch pointer sequence. Returns `true` if the touch landed on an interactive
    /// `<canvas>` (such as the 3D Mine Map), capturing subsequent move/up drags to orbit/pan
    /// instead of scrolling the page.
    pub fn on_pointer_down(&mut self, phys_x: f32, phys_y: f32) -> bool {
        self.last_user_gesture_ms.store(gesture_now_ms(), Ordering::Relaxed);
        self.active_canvas_flid = None;
        self.last_pointer_phys = (phys_x, phys_y);
        if self.canvas_flids.is_empty() {
            return false;
        }
        let logical_x = phys_x / self.scale + self.scroll_x as f32;
        let logical_y = phys_y / self.scale + self.scroll_y as f32;
        let Some(hit) = self.doc.as_ref().hit(logical_x, logical_y) else {
            return false;
        };
        let chain = self.doc.as_ref().node_chain(hit.node_id);
        let canvas_flid = chain.iter().find_map(|&dom_id| {
            let node = self.doc.as_ref().get_node(dom_id)?;
            let is_canvas = node
                .element_data()
                .map(|e| e.name.local.as_ref() == "canvas")
                .unwrap_or(false);
            if is_canvas {
                self.dom_to_flid.get(&dom_id).copied()
            } else {
                None
            }
        });
        let Some(flid) = canvas_flid else {
            return false;
        };
        self.active_canvas_flid = Some(flid);
        let _watchdog = self.renew_frontend_budget();
        let _doc_guard = LayoutDocGuard::enter(self.doc.as_ref());
        let client_x = f64::from(phys_x / self.scale);
        let client_y = f64::from(phys_y / self.scale);
        if let Some(ref mut st) = self.js_state {
            let _ = st.call_global(
                "__zippDispatchPointerEvent",
                &[
                    JsValue::Number(f64::from(flid)),
                    JsValue::String("pointerdown".into()),
                    JsValue::Number(client_x),
                    JsValue::Number(client_y),
                    JsValue::Number(0.0),
                    JsValue::Number(1.0),
                    JsValue::Number(1.0),
                ],
            );
            drain_js(st);
        }
        true
    }

    /// Route pointer movement while a `<canvas>` drag is active (3D camera orbit/pan).
    pub fn on_pointer_move(&mut self, phys_x: f32, phys_y: f32) -> InteractionResult {
        if let Some(flid) = self.active_canvas_flid {
            let _watchdog = self.renew_frontend_budget();
            let client_x = f64::from(phys_x / self.scale);
            let client_y = f64::from(phys_y / self.scale);
            {
                let _doc_guard = LayoutDocGuard::enter(self.doc.as_ref());
                if let Some(ref mut st) = self.js_state {
                    let _ = st.call_global(
                        "__zippDispatchPointerEvent",
                        &[
                            JsValue::Number(f64::from(flid)),
                            JsValue::String("pointermove".into()),
                            JsValue::Number(client_x),
                            JsValue::Number(client_y),
                            JsValue::Number(0.0),
                            JsValue::Number(1.0),
                            JsValue::Number(1.0),
                        ],
                    );
                    drain_js(st);
                    let _ = st.call_global("__zippStepRaf", &[]);
                    drain_js(st);
                }
            }
            self.sync_dom_from_vm();
        }
        self.build_interaction_result(false, false, String::new(), "text".to_string(), None)
    }

    /// Finish a `<canvas>` touch drag (triggers click-picking on short taps inside 3D view).
    pub fn on_pointer_up(&mut self, phys_x: f32, phys_y: f32) -> InteractionResult {
        if let Some(flid) = self.active_canvas_flid.take() {
            let _watchdog = self.renew_frontend_budget();
            let client_x = f64::from(phys_x / self.scale);
            let client_y = f64::from(phys_y / self.scale);
            {
                let _doc_guard = LayoutDocGuard::enter(self.doc.as_ref());
                if let Some(ref mut st) = self.js_state {
                    let _ = st.call_global(
                        "__zippDispatchPointerEvent",
                        &[
                            JsValue::Number(f64::from(flid)),
                            JsValue::String("pointerup".into()),
                            JsValue::Number(client_x),
                            JsValue::Number(client_y),
                            JsValue::Number(0.0),
                            JsValue::Number(0.0),
                            JsValue::Number(1.0),
                        ],
                    );
                    drain_js(st);
                    let _ = st.call_global("__zippStepRaf", &[]);
                    drain_js(st);
                }
            }
            self.sync_dom_from_vm();
        }
        self.build_interaction_result(false, false, String::new(), "text".to_string(), None)
    }

    /// Scroll vertically by `delta_phys_y` physical pixels (positive = scroll down).
    pub fn on_scroll(&mut self, delta_phys_y: f32) -> bool {
        self.on_scroll_2d(0.0, delta_phys_y)
    }

    /// Scroll horizontally and/or vertically by `(delta_phys_x, delta_phys_y)` physical pixels
    /// (positive = scroll right / down). Supports both nested `overflow: auto|scroll` containers
    /// (such as wide data grids, tab strips, and flex app shells) and root viewport scrolling.
    pub fn on_scroll_2d(&mut self, delta_phys_x: f32, delta_phys_y: f32) -> bool {
        if delta_phys_x.abs() < 0.01 && delta_phys_y.abs() < 0.01 {
            return false;
        }
        let delta_logical_x = (delta_phys_x / self.scale) as f64;
        let delta_logical_y = (delta_phys_y / self.scale) as f64;
        let (px, py) = self.last_pointer_phys;
        let lx = if px > 0.0 {
            px / self.scale
        } else {
            (self.width as f32 * 0.5) / self.scale
        };
        let ly = if py > 0.0 {
            py / self.scale
        } else {
            (self.height as f32 * 0.5) / self.scale
        };
        let anchor_id = self
            .doc
            .as_ref()
            .hit(lx + self.scroll_x as f32, ly + self.scroll_y as f32)
            .map(|h| h.node_id);
        let prev_vp = self.doc.as_ref().viewport_scroll();
        let changed = self.doc.as_mut().scroll_by(
            anchor_id,
            -delta_logical_x,
            -delta_logical_y,
            &mut |_| {},
        );
        if !changed {
            return false;
        }
        let new_vp = self.doc.as_ref().viewport_scroll();
        let vp_changed =
            (new_vp.x - prev_vp.x).abs() > 1e-6 || (new_vp.y - prev_vp.y).abs() > 1e-6;
        self.scroll_x = new_vp.x;
        self.scroll_y = new_vp.y;
        if let Ok(mut lc) = self.layout_cache.lock() {
            if vp_changed {
                // O(1) fast path: viewport scroll only shifts client coordinates.
                lc.set_viewport_scroll(self.scroll_x, self.scroll_y);
            } else {
                // Nested overflow container scrolled: refresh rects only (skip CSS style serialization).
                lc.update_rects_from_doc(
                    self.doc.as_ref(),
                    &self.flid_to_dom,
                    self.scroll_x,
                    self.scroll_y,
                );
            }
        }
        self.full_repaint = true;
        self.dirty = true;
        true
    }

    /// Set text value of the currently focused `<input>` / `<textarea>` from Android IME.
    pub fn on_text_input(&mut self, full_text: &str) -> InteractionResult {
        let _watchdog = self.renew_frontend_budget();
        if let Some(flid) = self.focused_flid {
            {
                let _doc_guard = LayoutDocGuard::enter(self.doc.as_ref());
                if let Some(ref mut st) = self.js_state {
                    let _ = st.call_global(
                        "__softnSetInputValue",
                        &[
                            JsValue::Number(f64::from(flid)),
                            JsValue::String(full_text.to_string()),
                        ],
                    );
                    drain_js(st);
                }
            }
            self.sync_dom_from_vm();
        }
        let wants_ime = self.focused_flid.is_some();
        self.build_interaction_result(
            false,
            wants_ime,
            full_text.to_string(),
            "text".to_string(),
            None,
        )
    }

    /// Submit focused form on IME Done/Enter key.
    pub fn on_submit_ime(&mut self) -> InteractionResult {
        let _watchdog = self.renew_frontend_budget();
        if self.backend.as_ref().is_some_and(|b| b.is_rust_backend()) {
            self.rust_active_until = Instant::now() + Duration::from_secs(2);
        }
        if let Some(flid) = self.focused_flid {
            {
                let _doc_guard = LayoutDocGuard::enter(self.doc.as_ref());
                if let Some(ref mut st) = self.js_state {
                    let _ = st.call_global(
                        "__softnSubmitAncestorForm",
                        &[JsValue::Number(f64::from(flid))],
                    );
                    drain_js(st);
                }
            }
            self.focused_flid = None;
            self.sync_dom_from_vm();
        }
        self.build_interaction_result(true, false, String::new(), "text".to_string(), None)
    }

    /// Resolve an asynchronous native Android hardware call back into the live `zipp-vm` Promise.
    pub fn resolve_device_call(
        &mut self,
        request_id: u64,
        ok: bool,
        payload_json: &str,
    ) -> InteractionResult {
        let _watchdog = self.renew_frontend_budget();
        {
            let _doc_guard = LayoutDocGuard::enter(self.doc.as_ref());
            if let Some(ref mut st) = self.js_state {
                stacker::maybe_grow(512 * 1024, 16 * 1024 * 1024, || {
                    let _ = st.call_global(
                        "__softnResolveDeviceCall",
                        &[
                            JsValue::Number(request_id as f64),
                            JsValue::Bool(ok),
                            JsValue::String(payload_json.to_string()),
                        ],
                    );
                    drain_js(st);
                });
            }
        }
        self.sync_dom_from_vm();
        let wants_ime = self.focused_flid.is_some();
        self.build_interaction_result(false, wants_ime, String::new(), "text".to_string(), None)
    }

    pub fn tick(&mut self) -> InteractionResult {
        let _watchdog = self.renew_frontend_budget();
        let mut changed = false;
        {
            let _doc_guard = LayoutDocGuard::enter(self.doc.as_ref());
            if let Some(ref be) = self.backend {
                if be.is_rust_backend()
                    && (self.open_ws_count.load(Ordering::Relaxed) > 0
                        || Instant::now() < self.rust_active_until)
                    && self.last_rust_poll.elapsed() >= RUST_TIMER_POLL_INTERVAL
                {
                    self.last_rust_poll = Instant::now();
                    let ws_frames = be.poll_rust_timers();
                    if !ws_frames.is_empty() {
                        self.rust_active_until = Instant::now() + Duration::from_secs(2);
                        if let Some(ref mut st) = self.js_state {
                            let frames_json = Value::Array(ws_frames).to_string();
                            stacker::maybe_grow(512 * 1024, 16 * 1024 * 1024, || {
                                let _ = st.call_global(
                                    "__softnDeliverWsFrames",
                                    &[JsValue::String(frames_json)],
                                );
                                st.run_microtasks();
                            });
                            changed = true;
                        }
                    }
                }
            }
            if let Some(ref mut st) = self.js_state {
                stacker::maybe_grow(512 * 1024, 16 * 1024 * 1024, || {
                    if let Ok(JsValue::Number(n)) =
                        st.call_global("__zippDrainQueues", &[JsValue::Number(8.0)])
                    {
                        if n > 0.0 {
                            st.run_microtasks();
                            changed = true;
                        }
                    }
                    if let Ok(JsValue::Number(r)) = st.call_global("__zippStepRaf", &[]) {
                        if r > 0.0 {
                            st.run_microtasks();
                            changed = true;
                        }
                    }
                });
            }
        }
        if changed {
            self.sync_dom_from_vm();
        } else {
            let updated = show_canvas_frames(
                self.doc.as_mut(),
                &self.flid_to_dom,
                canvas::take_frames(),
            );
            if !updated.is_empty() {
                self.dirty_canvas_nodes.extend(updated);
                self.dirty = true;
            }
        }
        let wants_ime = self.focused_flid.is_some();
        self.build_interaction_result(false, wants_ime, String::new(), "text".to_string(), None)
    }

    pub fn drain_pending_calls(&self) -> Vec<PendingDeviceRequest> {
        self.pending_calls
            .lock()
            .map(|mut q| std::mem::take(&mut *q))
            .unwrap_or_default()
    }

    pub fn bundle_info_json(&self) -> String {
        json!({
            "appId": self.bundle.app_id,
            "name": self.bundle.name,
            "version": self.bundle.version,
            "capabilities": self.bundle.declared_capabilities(),
            "hasBackend": self.backend.is_some(),
            "hasCanvas": self.has_canvas(),
            "backendRuntime": self.bundle.manifest.backend.as_ref().map(|b| b.runtime.as_str()),
            "databases": self.bundle.manifest.databases.as_ref().map(|d| d.len()).unwrap_or(0),
        })
        .to_string()
    }

    /// Clear HTTP disk + memory cache and decoded image caches for this app.
    pub fn clear_cache(&mut self) -> String {
        canvas2d::clear_image_cache();
        let (entries, bytes) = self.http_cache.clear();
        json!({ "ok": true, "entries": entries, "bytes": bytes }).to_string()
    }

    /// Clear cache, cookies, sessionStorage, localStorage, XDB, IndexedDB, overlays, and blobs for this app.
    pub fn clear_site_data(&mut self) -> String {
        canvas2d::clear_image_cache();
        let (entries, bytes) = self.http_cache.clear();
        let cookies = self.cookies.clear();
        if let Ok(mut sess) = self.session_storage.lock() {
            sess.clear();
        }
        self.storage.clear_local_storage();
        self.storage.clear_xdb_collections();
        let _ = std::fs::remove_dir_all(self.app_data_dir.join("idb"));
        let _ = std::fs::remove_file(self.app_data_dir.join("rust_vfs_overlay.json"));
        self.blobs.clear();
        json!({ "ok": true, "entries": entries, "bytes": bytes, "cookies": cookies }).to_string()
    }

    pub fn current_rendered_html(&mut self) -> String {
        let Some(ref mut st) = self.js_state else {
            return String::new();
        };
        let res = stacker::maybe_grow(512 * 1024, 16 * 1024 * 1024, || {
            st.call_global("__getRenderedHTML", &[])
        });
        match res {
            Ok(JsValue::String(s)) => s,
            _ => String::new(),
        }
    }

    #[cfg(test)]
    pub fn canvas_frame_summary(&self) -> Vec<(u32, u32, usize)> {
        let doc = self.doc.as_ref();
        let mut out = Vec::new();
        for &node_id in self.flid_to_dom.values() {
            if let Some(el) = doc.get_node(node_id).and_then(|n| n.element_data()) {
                if el.name.local.as_ref() == "canvas" {
                    if let Some(img) = el.raster_image_data() {
                        let bytes: &[u8] = img.data.as_ref();
                        let first = bytes.get(0..4).unwrap_or(&[0, 0, 0, 0]);
                        let varied = bytes
                            .chunks_exact(4)
                            .filter(|px| px[3] > 0 && *px != first)
                            .count();
                        out.push((img.width, img.height, varied));
                    } else {
                        out.push((0, 0, 0));
                    }
                }
            }
        }
        out
    }

    #[cfg(test)]
    pub fn find_flid_physical_center(&self, flid: u32) -> Option<(f32, f32)> {
        let doc = self.doc.as_ref();
        let w = (self.width as f32) / self.scale;
        let h = (self.height as f32) / self.scale;
        // Probe with the real Blitz hit-tester to find an exact screen coordinate that hits `flid`
        let mut y = 8.0f32;
        while y < h {
            let mut x = 16.0f32;
            while x < w {
                if let Some(hit) = doc.hit(x + self.scroll_x as f32, y + self.scroll_y as f32) {
                    let chain = doc.node_chain(hit.node_id);
                    if chain.iter().any(|id| self.dom_to_flid.get(id) == Some(&flid)) {
                        return Some((x * self.scale, y * self.scale));
                    }
                }
                x += 24.0;
            }
            y += 12.0;
        }
        None
    }

    fn inspect_js_node(&mut self, flid: u32) -> Value {
        let Some(ref mut st) = self.js_state else {
            return json!({});
        };
        match st.call_global("__softnInspectNode", &[JsValue::Number(f64::from(flid))]) {
            Ok(JsValue::String(s)) => serde_json::from_str(&s).unwrap_or_else(|_| json!({})),
            _ => json!({}),
        }
    }

    fn sync_dom_from_vm(&mut self) {
        let Some(ref mut st) = self.js_state else {
            return;
        };
        // Fast path for steady 3D / WebGL / Canvas 2D animation frames: if JS made
        // zero DOM mutations since our last sync, skip serializing the entire DOM tree
        // and jump straight to swapping any newly presented canvas frames!
        let cur_mutations = match st.call_global("__zippDomMutationCount", &[]) {
            Ok(JsValue::Number(n)) => n as i64,
            _ => -1,
        };
        if self.last_dom_mutations >= 0 && cur_mutations == self.last_dom_mutations {
            let updated = show_canvas_frames(
                self.doc.as_mut(),
                &self.flid_to_dom,
                canvas::take_frames(),
            );
            if !updated.is_empty() {
                self.dirty_canvas_nodes.extend(updated);
                self.dirty = true;
            }
            return;
        }
        let body_html = match stacker::maybe_grow(512 * 1024, 16 * 1024 * 1024, || {
            st.call_global("__getRenderedHTML", &[])
        }) {
            Ok(JsValue::String(s)) if !s.is_empty() => s,
            _ => return,
        };
        let dyn_css = match st.call_global("__getDynamicHeadStyles", &[]) {
            Ok(JsValue::String(s)) => s,
            _ => String::new(),
        };
        let full_css = if dyn_css.is_empty() {
            self.head_css.clone()
        } else {
            format!("{}\n{}", self.head_css, dyn_css)
        };
        let html_attrs = match st.call_global("__getHtmlClass", &[]) {
            Ok(JsValue::String(s)) => s,
            _ => String::new(),
        };
        self.last_dom_mutations = cur_mutations;
        let full_html = compose_document_html(&full_css, &body_html, &html_attrs);
        if full_html == self.last_synced_html {
            let updated = show_canvas_frames(
                self.doc.as_mut(),
                &self.flid_to_dom,
                canvas::take_frames(),
            );
            if !updated.is_empty() {
                self.dirty_canvas_nodes.extend(updated);
                self.dirty = true;
            }
            return;
        }
        self.last_synced_html = full_html;
        // Preserve per-element nested container scroll offsets across DOM rebuilds
        let saved_scrolls: Vec<(u32, zipp_dom::Point<f64>)> = self
            .flid_to_dom
            .iter()
            .filter_map(|(&flid, &dom_id)| {
                let n = self.doc.as_ref().get_node(dom_id)?;
                if n.scroll_offset.x != 0.0 || n.scroll_offset.y != 0.0 {
                    Some((flid, n.scroll_offset))
                } else {
                    None
                }
            })
            .collect();
        // Reuse the existing FontContext (embedded Liberation TTFs + any loaded @font-face),
        // NetProvider, and HtmlParserProvider across DOM rebuilds instead of re-parsing 12 TTFs.
        let reused_config = self
            .doc
            .as_ref()
            .clone_config_for_navigation(format!("{VIRTUAL_ORIGIN}/"));
        let mut doc = build_html_document(
            &self.last_synced_html,
            &self.bundle,
            &self.blobs,
            &self.http_cache,
            &self.cookies,
            self.host_allows_net,
            self.width,
            self.height,
            self.scale,
            Some(reused_config),
        );
        let (max_scroll_x, max_scroll_y) = {
            let l = doc.as_ref().root_element().final_layout;
            let content_w = l.size.width.max(l.content_size.width) as f64;
            let content_h = l.size.height.max(l.content_size.height) as f64;
            let view_w = (self.width as f64) / (self.scale as f64);
            let view_h = (self.height as f64) / (self.scale as f64);
            ((content_w - view_w).max(0.0), (content_h - view_h).max(0.0))
        };
        self.scroll_x = self.scroll_x.clamp(0.0, max_scroll_x);
        self.scroll_y = self.scroll_y.clamp(0.0, max_scroll_y);
        doc.as_mut().set_viewport_scroll(zipp_dom::Point {
            x: self.scroll_x,
            y: self.scroll_y,
        });

        let (flid_to_dom, mut canvas_flids) = build_flid_and_canvas_maps(doc.as_ref());
        canvas_flids.sort_unstable();
        self.flid_to_dom = flid_to_dom;
        self.canvas_flids = canvas_flids;
        self.dom_to_flid = self
            .flid_to_dom
            .iter()
            .map(|(&flid, &dom_id)| (dom_id, flid))
            .collect();
        for (flid, offset) in saved_scrolls {
            if let Some(&dom_id) = self.flid_to_dom.get(&flid) {
                if let Some(node) = doc.as_mut().get_node_mut(dom_id) {
                    let max_y = (node.final_layout.content_size.height - node.final_layout.size.height).max(0.0) as f64;
                    let max_x = (node.final_layout.content_size.width - node.final_layout.size.width).max(0.0) as f64;
                    node.scroll_offset = zipp_dom::Point {
                        x: offset.x.clamp(0.0, max_x),
                        y: offset.y.clamp(0.0, max_y),
                    };
                }
            }
        }
        if let Ok(mut lc) = self.layout_cache.lock() {
            lc.update_from_doc(doc.as_ref(), &self.flid_to_dom, self.scroll_x, self.scroll_y);
        }
        // Flush any newly presented canvas frames into SHOWN, then attach every canvas's
        // latest rendered picture directly onto its new DOM node.
        let _ = canvas::take_frames();
        let _ = show_canvas_frames(doc.as_mut(), &self.flid_to_dom, canvas::shown_frames());
        self.doc = doc;
        // build_html_document already polled and resolved layout; no need to re-resolve in render_rgba
        self.layout_dirty = false;
        self.full_repaint = true;
        self.dirty_canvas_nodes.clear();
        self.dirty = true;
    }
}

enum CanvasDamage {
    Full,
    OpaqueRect(f64, f64, f64, f64),
    Rect(f64, f64, f64, f64),
    Offscreen,
}

fn show_canvas_frames(
    doc: &mut BaseDocument,
    flid_to_dom: &HashMap<u32, usize>,
    frames: Vec<(u32, canvas::Shown)>,
) -> Vec<usize> {
    use zipp_dom::node::{ImageData, RasterImageData, SpecialElementData};
    if frames.is_empty() {
        return Vec::new();
    }
    let mut updated = Vec::new();
    for (flid, (width, height, rgba)) in frames {
        let Some(&node_id) = flid_to_dom.get(&flid) else {
            continue;
        };
        if let Some(element) = doc.get_node_mut(node_id).and_then(|n| n.element_data_mut()) {
            let image = RasterImageData::new(width, height, rgba);
            element.special_data =
                SpecialElementData::Image(Box::new(ImageData::Raster(image)));
            updated.push(node_id);
        }
    }
    updated
}

fn drain_js(st: &mut ScriptState) {
    let start = Instant::now();
    stacker::maybe_grow(512 * 1024, 16 * 1024 * 1024, || {
        for _ in 0..10 {
            if start.elapsed() >= Duration::from_millis(MAX_DRAIN_WALL_MS) {
                break;
            }
            st.run_microtasks();
            match st.call_global("__zippDrainQueues", &[JsValue::Number(50.0)]) {
                Ok(JsValue::Number(n)) if n > 0.0 => continue,
                _ => break,
            }
        }
        if start.elapsed() < Duration::from_millis(MAX_DRAIN_WALL_MS) {
            st.run_microtasks();
        }
    });
}

static EMBEDDED_FONT_CTX: LazyLock<FontContext> = LazyLock::new(load_embedded_fonts);

fn load_embedded_fonts() -> FontContext {
    let mut font_ctx = FontContext::default();
    zipp_dom::register_embedded_fonts(&mut font_ctx.collection);
    font_ctx
        .collection
        .register_fonts(Blob::new(Arc::new(zipp_dom::BULLET_FONT) as _), None);
    font_ctx
}

#[allow(clippy::too_many_arguments)]
fn build_html_document(
    html: &str,
    bundle: &Arc<SoftnBundle>,
    blobs: &Arc<BlobStore>,
    http_cache: &Arc<MobileHttpCache>,
    cookies: &Arc<MobileCookieJar>,
    host_allows_net: bool,
    width: u32,
    height: u32,
    scale: f32,
    reused_config: Option<DocumentConfig>,
) -> HtmlDocument {
    stacker::maybe_grow(512 * 1024, 16 * 1024 * 1024, || {
        let config = reused_config.unwrap_or_else(|| {
            let font_ctx = EMBEDDED_FONT_CTX.clone();
            let net_provider = Arc::new(VfsNetProvider {
                bundle: Arc::clone(bundle),
                blobs: Arc::clone(blobs),
                http_cache: Arc::clone(http_cache),
                cookies: Arc::clone(cookies),
                host_allows_net,
            });
            DocumentConfig {
                font_ctx: Some(font_ctx),
                base_url: Some(format!("{VIRTUAL_ORIGIN}/")),
                net_provider: Some(net_provider),
                html_parser_provider: Some(Arc::new(HtmlProvider)),
                ..Default::default()
            }
        });
        let mut doc = HtmlDocument::from_html(html, config);
        let color_scheme = match bundle.manifest.theme.as_deref() {
            Some("light") => ColorScheme::Light,
            _ => ColorScheme::Dark,
        };
        doc.as_mut().set_viewport(Viewport::new(
            width.max(1),
            height.max(1),
            scale.max(1.0),
            color_scheme,
        ));
        // Drain synchronous VfsNetProvider image/stylesheet loads and resolve layout once;
        // only re-resolve if style resolution triggered additional synchronous resources
        // (such as CSS background images or @font-face declarations).
        doc.poll(None);
        doc.as_mut().resolve(0.0);
        if doc.poll(None) {
            doc.as_mut().resolve(0.0);
        }
        doc
    })
}

fn escape_style_close(css: &str) -> String {
    let lower = css.to_ascii_lowercase();
    if !lower.contains("</style") {
        return css.to_string();
    }
    let mut out = String::with_capacity(css.len() + 16);
    let mut pos = 0usize;
    while let Some(rel) = lower[pos..].find("</style") {
        let abs = pos + rel;
        out.push_str(&css[pos..abs]);
        out.push_str("<\\/");
        out.push_str(&css[abs + 2..abs + 7]);
        pos = abs + 7;
    }
    out.push_str(&css[pos..]);
    out
}

fn escape_html_attr_val(val: &str) -> String {
    val.replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn is_valid_html_attr_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    let Some(first) = bytes.next() else {
        return false;
    };
    (first.is_ascii_alphabetic() || first == b'_')
        && bytes.all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b':'))
}

fn compose_document_html(head_css: &str, body_html: &str, html_attrs: &str) -> String {
    let attrs = if html_attrs.trim().is_empty() {
        String::new()
    } else {
        format!(" {html_attrs}")
    };
    let safe_css = escape_style_close(head_css);
    format!(
        "<!DOCTYPE html><html{attrs}><head><meta charset=\"utf-8\"><style>\n*{{box-sizing:border-box;}}html,body{{margin:0;padding:0;min-height:100%;}}\n{safe_css}\n</style></head><body>{body_html}</body></html>"
    )
}

fn build_flid_and_canvas_maps(doc: &BaseDocument) -> (HashMap<u32, usize>, Vec<u32>) {
    let mut map = HashMap::new();
    let mut canvases = Vec::new();
    let flid_attr = LocalName::from("data-flid");
    walk_flid(doc, 0, &flid_attr, &mut map, &mut canvases);
    (map, canvases)
}

fn walk_flid(
    doc: &BaseDocument,
    root_id: usize,
    flid_attr: &LocalName,
    map: &mut HashMap<u32, usize>,
    canvases: &mut Vec<u32>,
) {
    let mut stack = vec![root_id];
    while let Some(node_id) = stack.pop() {
        if let Some(node) = doc.get_node(node_id) {
            if let Some(val) = node.attr(flid_attr.clone()) {
                if let Ok(flid) = val.parse::<u32>() {
                    map.insert(flid, node_id);
                    if node
                        .element_data()
                        .is_some_and(|e| e.name.local.as_ref() == "canvas")
                    {
                        canvases.push(flid);
                    }
                }
            }
            for &kid in node.children.iter().rev() {
                stack.push(kid);
            }
        }
    }
}

/// Replace placeholder tokens in a single left-to-right scan so substituted values
/// (e.g. a bundle title containing `__BODY_HTML__`) are never re-expanded.
fn replace_placeholders_single_pass(template: &str, replacements: &[(&str, &str)]) -> String {
    let mut out = String::with_capacity(template.len() + 256);
    let bytes = template.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'_' && bytes.get(i + 1) == Some(&b'_') {
            let mut matched = false;
            for &(needle, val) in replacements {
                if template[i..].starts_with(needle) {
                    out.push_str(val);
                    i += needle.len();
                    matched = true;
                    break;
                }
            }
            if matched {
                continue;
            }
        }
        let next = template[i..]
            .find("__")
            .map(|rel| if rel == 0 { 1 } else { rel })
            .unwrap_or(bytes.len() - i);
        out.push_str(&template[i..i + next]);
        i += next;
    }
    out
}

#[allow(clippy::too_many_arguments)]
fn boot_frontend_vm(
    raw_html: &str,
    initial_body: &str,
    initial_html_attrs: &[(String, String)],
    logical_w: u32,
    logical_h: u32,
    scale: f32,
    bundle: &Arc<SoftnBundle>,
    backend: Option<&Arc<LocalContainerBackend>>,
    storage: &SqlStorage,
    app_data_dir: &Path,
    blobs: Arc<BlobStore>,
    http_cache: Arc<MobileHttpCache>,
    cookies: Arc<MobileCookieJar>,
    session_storage: Arc<Mutex<HashMap<String, String>>>,
    host_info: HostDeviceInfo,
    layout_cache: Arc<Mutex<LayoutCache>>,
    pending_calls: Arc<Mutex<Vec<PendingDeviceRequest>>>,
    logs: Arc<Mutex<Vec<String>>>,
    abort: Arc<AtomicBool>,
    open_ws_count: Arc<AtomicUsize>,
    last_user_gesture_ms: Arc<AtomicU64>,
) -> Result<Option<ScriptState>, String> {
    let (classic_scripts, module_entries) = extract_scripts(raw_html, bundle);
    if classic_scripts.is_empty() && module_entries.is_empty() {
        return Ok(None);
    }

    let escaped_body = escape_js_string(initial_body);

    let html_attrs_map: serde_json::Map<String, Value> = initial_html_attrs
        .iter()
        .map(|(k, v)| (k.clone(), Value::String(v.clone())))
        .collect();
    let escaped_html_attrs = escape_js_string(&Value::Object(html_attrs_map).to_string());

    let prefers_dark = !matches!(bundle.manifest.theme.as_deref(), Some("light"));
    let escaped_title = escape_js_string(&bundle.name);
    let page_url = format!("{VIRTUAL_ORIGIN}/");
    let prefers_dark_str = if prefers_dark { "true" } else { "false" };
    let logical_w_str = logical_w.to_string();
    let logical_h_str = logical_h.to_string();

    let template = format!(
        "{HOST_PRELUDE_JS}\n{ZIPP_CONSOLE_SHIM}\n{ZIPP_CLONE_JS}\n{ZIPP_DOM_SHIM}\n{ZIPP_IDB_SHIM}\n{ZIPP_WEBGL_SHIM}\n{ZIPP_CANVAS2D_SHIM}\n{SOFTN_PRELUDE_JS}"
    );
    let shim = replace_placeholders_single_pass(
        &template,
        &[
            ("__PAGE_URL__", &page_url),
            ("__PAGE_TITLE__", &escaped_title),
            ("__PREFERS_DARK__", prefers_dark_str),
            ("__VIEWPORT_W__", &logical_w_str),
            ("__VIEWPORT_H__", &logical_h_str),
            ("__BODY_HTML__", &escaped_body),
            ("__SOFTN_BODY_HTML__", &escaped_body),
            ("__SOFTN_HTML_ATTRS_JSON__", &escaped_html_attrs),
        ],
    );

    let mut full = shim;
    full.push_str(&format!("\nwindow.devicePixelRatio = {scale}; devicePixelRatio = {scale};\n"));

    for src in classic_scripts {
        full.push('\n');
        full.push_str(&src);
        full.push_str("\n;\n");
    }

    if !module_entries.is_empty() {
        let bundle_ref = Arc::clone(bundle);
        let bundle_ref2 = Arc::clone(bundle);
        let linked = esm::link_modules(
            &module_entries,
            &move |importer, spec| {
                if spec.starts_with("softn:") {
                    return spec.to_string();
                }
                let imp_path = importer
                    .strip_prefix(&format!("{VIRTUAL_ORIGIN}/"))
                    .unwrap_or(importer);
                if let Some(resolved) =
                    resolve_vfs_url(spec, imp_path, &bundle_ref.frontend_root)
                {
                    let mut final_path = resolved.clone();
                    if !bundle_ref.vfs.contains_key(&final_path) {
                        for ext in [".js", ".mjs", ".ts", ".tsx", ".jsx", "/index.js", "/index.ts"] {
                            let cand = format!("{resolved}{ext}");
                            if bundle_ref.vfs.contains_key(&cand) {
                                final_path = cand;
                                break;
                            }
                        }
                    }
                    format!("{VIRTUAL_ORIGIN}/{final_path}")
                } else {
                    spec.to_string()
                }
            },
            &move |url| {
                let rel = url
                    .strip_prefix(&format!("{VIRTUAL_ORIGIN}/"))
                    .unwrap_or(url);
                if bundle_ref2.is_private_asset(rel) {
                    return Err(format!("Blocked private module import: {rel}"));
                }
                bundle_ref2
                    .read_text(rel)
                    .ok_or_else(|| format!("Module not found in .softn archive: {rel}"))
            },
        );
        full.push('\n');
        full.push_str(&linked.source);
        full.push('\n');
    }

    // Grow the stack in-place (ScriptState is !Send) so large React/Three.js
    // bundles never overflow Android's 1 MiB JNI thread stack or debug test stacks.
    let mut st = stacker::grow(16 * 1024 * 1024, || {
        compile_source(&full, Frontend::TypeScript)
    })
    .map_err(|e| format!("Frontend JS/TS compile error: {e}"))?
    .into_state();

    // Allocate the instrumentation recorder FIRST (`set_limits`) so `set_heap_limit`,
    // `set_output_limit`, `set_dynamic_code_limits`, and wall-clock `abort` are all active!
    // On x86-64 with the native JIT enabled, `zipp-vm` pins a 256 MiB register reservation
    // on the first `run_init()` entry (`reserve_jit_regs`) and counts its capacity in
    // `audit_heap_bytes()`. Account for that static reservation on x86-64 so guest heap
    // growth stays strictly capped at `FRONTEND_HEAP_LIMIT_BYTES` (128 MiB) on every arch.
    // Per-interaction re-entry uses `renew_step_budget()` so these ceilings are never dropped.
    st.set_limits(FRONTEND_BOOT_STEP_BUDGET, Some(Arc::clone(&abort)));
    const JIT_REG_RESERVE_BYTES: usize = if cfg!(target_arch = "x86_64") {
        256 * 1024 * 1024
    } else {
        0
    };
    let heap_baseline = st.heap_bytes();
    st.set_heap_limit(
        heap_baseline
            .saturating_add(JIT_REG_RESERVE_BYTES)
            .saturating_add(FRONTEND_HEAP_LIMIT_BYTES),
    );
    st.set_output_limit(32 * 1024 * 1024);
    st.set_dynamic_code_limits(256 * 1024, 1024 * 1024, 64, 512, 256);

    let bundle_hc = Arc::clone(bundle);
    let backend_hc = backend.cloned();
    let storage_hc = storage.clone();
    let idb_dir = app_data_dir.join("idb");
    let blobs_hc = Arc::clone(&blobs);
    let http_cache_hc = Arc::clone(&http_cache);
    let cookies_hc = Arc::clone(&cookies);
    let host_allows_net = host_info.host_allows_capability("net");
    let session_hc = Arc::clone(&session_storage);
    let layout_hc = Arc::clone(&layout_cache);
    let pending_hc = Arc::clone(&pending_calls);
    let logs_hc = Arc::clone(&logs);
    let mut pending_bytes: Vec<u8> = Vec::new();
    let mut open_ws_ids: HashSet<String> = HashSet::new();
    let ws_count_hc = Arc::clone(&open_ws_count);
    let gesture_hc = Arc::clone(&last_user_gesture_ms);
    let sql_abort = Arc::new(AtomicBool::new(false));
    let mut frontend_sql = RequestSqlBridge::new(storage.clone(), Arc::clone(&sql_abort));

    st.set_host_call_ctx(Box::new(move |ctx: &mut dyn HostCtx, kind: &str, args: &[String]| {
        let arg = |i: usize| args.get(i).map(String::as_str).unwrap_or("");
        match kind {
            "c2d" => canvas2d::host_call(ctx, &bundle_hc, &blobs_hc, args),
            #[cfg(target_os = "android")]
            "gl" => crate::webgl::host_call(
                ctx,
                Arc::clone(&bundle_hc),
                Arc::clone(&blobs_hc),
                args,
            ),
            #[cfg(not(target_os = "android"))]
            "gl" => Err("Error: WebGL is available on Android EGL builds".into()),
            "image_info" => Ok(probe_image_info(&bundle_hc, &blobs_hc, arg(0))),
            "url" => url_parts(arg(0), arg(1)),
            "url_set" => url_set(arg(0), arg(1), arg(2)),
            "random" => {
                let n: usize = arg(0).parse().unwrap_or(0).min(65536);
                Ok(random_hex(n))
            }
            "parse_html" => {
                let raw = arg(0);
                if raw.len() > MAX_PARSE_HTML_BYTES {
                    return Ok("[[],[],[],[]]".to_string());
                }
                Ok(html_seed::parse_html_json(raw).unwrap_or_else(|| "[[],[],[],[]]".to_string()))
            }
            "blob_create" => {
                let mode = arg(0);
                let mime = arg(1);
                let origin = arg(2);
                let bytes = if mode == "text" {
                    let raw = arg(3);
                    if raw.len() > MAX_SINGLE_BLOB_BYTES {
                        return Err("RangeError: Blob exceeds 32 MiB single-blob limit".into());
                    }
                    raw.as_bytes().to_vec()
                } else {
                    let len: usize = mode.parse().unwrap_or(0);
                    if len > MAX_SINGLE_BLOB_BYTES {
                        return Err("RangeError: Blob exceeds 32 MiB single-blob limit".into());
                    }
                    if len == 0 {
                        Vec::new()
                    } else {
                        let (addr, count, ty) = ctx.typed_array_region("__zippHostBytes")?;
                        if ty != 1 || len > count || addr == 0 {
                            return Err("RangeError: blob_create buffer mismatch".into());
                        }
                        unsafe { std::slice::from_raw_parts(addr as *const u8, len).to_vec() }
                    }
                };
                blobs_hc.store(origin, mime, bytes)
            }
            "blob_revoke" => {
                blobs_hc.revoke(arg(0));
                Ok(String::new())
            }
            "blob_read" => {
                let url = arg(0);
                let Some((mime, bytes)) = blobs_hc.lookup(url) else {
                    return Err(format!("TypeError: blob URL not found: {url}"));
                };
                let len = bytes.len();
                pending_bytes = bytes;
                Ok(json!({ "len": len, "type": mime }).to_string())
            }
            "http_bytes" => {
                let raw_url = arg(0);
                let credentials = arg(1);
                let headers_json = arg(2);
                let (status, mime, bytes, err) = handle_softn_fetch_bytes(
                    &bundle_hc,
                    backend_hc.as_deref(),
                    &blobs_hc,
                    &http_cache_hc,
                    &cookies_hc,
                    host_allows_net,
                    raw_url,
                    credentials,
                    headers_json,
                );
                if let Some(error) = err {
                    return Ok(json!({ "error": error }).to_string());
                }
                let len = bytes.len();
                pending_bytes = bytes;
                Ok(json!({
                    "status": status,
                    "ok": (200..300).contains(&status),
                    "len": len,
                    "contentType": mime,
                })
                .to_string())
            }
            "take_bytes" => {
                let (addr, count, ty) = ctx.typed_array_region("__zippHostBytes")?;
                if ty != 1 {
                    return Err("TypeError: __zippHostBytes must be a Uint8Array".into());
                }
                let bytes = std::mem::take(&mut pending_bytes);
                if bytes.len() > count {
                    return Err("RangeError: __zippHostBytes is too small".into());
                }
                if !bytes.is_empty() {
                    if addr == 0 {
                        return Err("TypeError: __zippHostBytes has null buffer".into());
                    }
                    unsafe {
                        std::ptr::copy_nonoverlapping(bytes.as_ptr(), addr as *mut u8, bytes.len());
                    }
                }
                Ok(bytes.len().to_string())
            }
            "site_read" => {
                let store_kind = arg(0);
                let name = arg(1);
                match store_kind {
                    "local" => Ok(json!(storage_hc.load_local_storage()).to_string()),
                    "session" => Ok(session_hc
                        .lock()
                        .ok()
                        .and_then(|s| s.get(name).cloned())
                        .unwrap_or_default()),
                    "idb" => Ok(read_idb_file(&idb_dir, name).unwrap_or_default()),
                    _ => Ok(String::new()),
                }
            }
            "site_write" => {
                let store_kind = arg(0);
                let name = arg(1);
                let data = arg(2);
                match store_kind {
                    "local" => {
                        if let Ok(Value::Object(map)) = serde_json::from_str::<Value>(data) {
                            let entries: Vec<(String, String)> = map
                                .into_iter()
                                .filter_map(|(k, v)| {
                                    let s = v.as_str()?;
                                    if k.len() <= MAX_STORAGE_KEY_BYTES
                                        && s.len() <= MAX_STORAGE_VAL_BYTES
                                    {
                                        Some((k, s.to_string()))
                                    } else {
                                        None
                                    }
                                })
                                .take(MAX_LOCAL_STORAGE_KEYS)
                                .collect();
                            storage_hc.replace_local_storage(&entries);
                        }
                        Ok(String::new())
                    }
                    "session" => {
                        if name.len() <= MAX_STORAGE_KEY_BYTES
                            && data.len() <= MAX_STORAGE_VAL_BYTES
                        {
                            if let Ok(mut s) = session_hc.lock() {
                                if s.contains_key(name) || s.len() < MAX_SESSION_STORAGE_KEYS {
                                    s.insert(name.to_string(), data.to_string());
                                }
                            }
                        }
                        Ok(String::new())
                    }
                    "idb" => {
                        write_idb_file(&idb_dir, name, Some(data));
                        Ok(String::new())
                    }
                    _ => Ok(String::new()),
                }
            }
            "site_delete" => {
                let store_kind = arg(0);
                let name = arg(1);
                match store_kind {
                    "session" => {
                        if let Ok(mut s) = session_hc.lock() {
                            s.remove(name);
                        }
                    }
                    "idb" => write_idb_file(&idb_dir, name, None),
                    _ => {}
                }
                Ok(String::new())
            }
            "site_names" => {
                let store_kind = arg(0);
                match store_kind {
                    "idb" => Ok(list_idb_names(&idb_dir)),
                    "session" => {
                        let names: Vec<String> = session_hc
                            .lock()
                            .map(|s| s.keys().cloned().collect())
                            .unwrap_or_default();
                        Ok(json!(names).to_string())
                    }
                    _ => Ok("[]".into()),
                }
            }
            "cookie_get" => {
                let target = resolve_virtual_cookie_url(arg(0));
                Ok(cookies_hc.document_cookie(&target))
            }
            "cookie_set" => {
                let target = resolve_virtual_cookie_url(arg(0));
                cookies_hc.set_document_cookie(&target, arg(1));
                Ok(String::new())
            }
            "computed_style" => Ok(layout_hc
                .lock()
                .map(|lc| lc.format_style(arg(0), arg(1)))
                .unwrap_or_default()),
            "hit" => Ok(layout_hc
                .lock()
                .map(|lc| lc.hit(arg(0), arg(1)))
                .unwrap_or_default()),
            "seed" | "window_title" | "fullscreen" => Ok(String::new()),
            "box" => Ok(layout_hc
                .lock()
                .map(|lc| lc.format_box(arg(0)))
                .unwrap_or_default()),
            "rect" => Ok(layout_hc
                .lock()
                .map(|lc| lc.format_rect(arg(0)))
                .unwrap_or_default()),
            "log" => {
                let line = format!("[{}] {}", arg(0), arg(1));
                #[cfg(target_os = "android")]
                log::info!("{line}");
                if let Ok(mut buf) = logs_hc.lock() {
                    if buf.len() < 500 {
                        buf.push(line);
                    }
                }
                Ok(String::new())
            }
            "softn.storage" => match arg(0) {
                "load_all" => Ok(json!(storage_hc.load_local_storage()).to_string()),
                "set" => {
                    let k = arg(1);
                    let v = arg(2);
                    if k.len() <= MAX_STORAGE_KEY_BYTES
                        && v.len() <= MAX_STORAGE_VAL_BYTES
                        && (storage_hc.has_local_storage_key(k)
                            || storage_hc.count_local_storage_keys() < MAX_LOCAL_STORAGE_KEYS)
                    {
                        storage_hc.set_local_storage(k, v);
                        Ok("true".into())
                    } else {
                        Ok("false".into())
                    }
                }
                "remove" => {
                    storage_hc.remove_local_storage(arg(1));
                    Ok("true".into())
                }
                "clear" => {
                    storage_hc.clear_local_storage();
                    Ok("true".into())
                }
                _ => Ok("null".into()),
            },
            "softn.xdb" => match arg(0) {
                "load_all" => Ok(json!(storage_hc.load_xdb_collections()).to_string()),
                "save" => {
                    let col = arg(1);
                    let payload = arg(2);
                    if col.len() <= MAX_STORAGE_KEY_BYTES
                        && payload.len() <= MAX_STORAGE_VAL_BYTES
                        && (storage_hc.has_xdb_collection(col)
                            || storage_hc.count_xdb_collections() < MAX_XDB_COLLECTIONS)
                    {
                        storage_hc.save_xdb_collection(col, payload);
                    }
                    Ok("true".into())
                }
                _ => Ok("null".into()),
            },
            k if k.starts_with("app.sql.") => {
                if backend_hc.is_some() {
                    return Ok(json!({ "error": "Direct frontend SQLite disabled when backend is configured" }).to_string());
                }
                sql_abort.store(false, Ordering::SeqCst);
                let _sql_watchdog = WallDeadlineGuard::arm(Arc::clone(&sql_abort), 15_000);
                Ok(frontend_sql.call(k, args))
            }
            "softn.fetch" => {
                let method = arg(0);
                let raw_url = arg(1);
                let headers_json = arg(2);
                let body_text = arg(3);
                let credentials = arg(4);
                Ok(handle_softn_fetch(
                    &bundle_hc,
                    backend_hc.as_deref(),
                    &blobs_hc,
                    &http_cache_hc,
                    &cookies_hc,
                    host_allows_net,
                    method,
                    raw_url,
                    headers_json,
                    body_text,
                    credentials,
                ))
            }
            "softn.device" => {
                let req_id: u64 = arg(0).parse().unwrap_or(0);
                let namespace = arg(1);
                let method = arg(2);
                let params: Value =
                    serde_json::from_str(arg(3)).unwrap_or_else(|_| json!({}));
                Ok(handle_softn_device(
                    &bundle_hc,
                    &host_info,
                    logical_w,
                    logical_h,
                    scale,
                    &pending_hc,
                    &gesture_hc,
                    req_id,
                    namespace,
                    method,
                    params,
                ))
            }
            "softn.ws" => {
                let op = arg(0);
                let ws_id = arg(1);
                let a1 = arg(2);
                let a2 = arg(3);
                if let Some(ref be) = backend_hc {
                    let payload = match op {
                        "open" => {
                            if !open_ws_ids.contains(ws_id) && open_ws_ids.len() >= MAX_OPEN_WS {
                                return Ok(json!({
                                    "ok": false,
                                    "accepted": false,
                                    "body": "WebSocket connection limit exceeded"
                                })
                                .to_string());
                            }
                            let Some(uri) = extract_local_ws_uri(a1, be) else {
                                return Ok(json!({
                                    "ok": false,
                                    "accepted": false,
                                    "body": "External WebSocket origins are not supported by local container backend"
                                })
                                .to_string());
                            };
                            json!({ "__control": "ws_open", "wsId": ws_id, "uri": uri, "headers": [] })
                        }
                        "send" => json!({ "__control": "ws_send", "wsId": ws_id, "data": a1, "binary": false }),
                        "close" => {
                            open_ws_ids.remove(ws_id);
                            ws_count_hc.store(open_ws_ids.len(), Ordering::Relaxed);
                            json!({ "__control": "ws_close", "wsId": ws_id, "code": a1.parse::<u16>().unwrap_or(1000), "reason": a2 })
                        }
                        _ => return Ok(json!({ "ok": false }).to_string()),
                    };
                    let res = be.rust_control(payload);
                    if op == "open" && res.get("accepted").and_then(|v| v.as_bool()) == Some(true) {
                        open_ws_ids.insert(ws_id.to_string());
                        ws_count_hc.store(open_ws_ids.len(), Ordering::Relaxed);
                    }
                    if let Some(frames) = res.get("wsFrames").and_then(|v| v.as_array()) {
                        let mut removed = false;
                        for f in frames {
                            if f.get("type").and_then(|v| v.as_str()) == Some("close") {
                                if let Some(fid) = f.get("wsId").and_then(|v| v.as_str()) {
                                    removed |= open_ws_ids.remove(fid);
                                }
                            }
                        }
                        if removed {
                            ws_count_hc.store(open_ws_ids.len(), Ordering::Relaxed);
                        }
                    }
                    Ok(res.to_string())
                } else {
                    Ok(json!({ "ok": false, "accepted": false, "body": "No backend WebSocket handler" }).to_string())
                }
            }
            "navigate" => Ok(String::new()),
            _ => Ok(String::new()),
        }
    }));

    abort.store(false, Ordering::SeqCst);
    let _boot_watchdog = WallDeadlineGuard::arm(Arc::clone(&abort), FRONTEND_BOOT_WALL_MS);
    st.run_init()
        .map_err(|e| format!("Frontend runtime init error: {e}"))?;
    drain_js(&mut st);

    Ok(Some(st))
}

fn escape_js_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\'' => out.push_str("\\'"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\u{2028}' => out.push_str("\\u2028"),
            '\u{2029}' => out.push_str("\\u2029"),
            '\0' => out.push_str("\\u0000"),
            c => out.push(c),
        }
    }
    out
}

/// Pin `document.cookie` reads/writes strictly to the container's `VIRTUAL_ORIGIN`
/// so guest scripts cannot read or inject cookies for external API origins.
fn resolve_virtual_cookie_url(raw: &str) -> url::Url {
    let base = url::Url::parse(&format!("{VIRTUAL_ORIGIN}/")).expect("valid virtual origin");
    if let Ok(parsed) = url::Url::parse(raw) {
        if parsed.origin() == base.origin() {
            return parsed;
        }
    } else if raw.starts_with('/') {
        if let Ok(joined) = base.join(raw) {
            if joined.origin() == base.origin() {
                return joined;
            }
        }
    }
    base
}

fn idb_file_path(dir: &Path, name: &str) -> Option<PathBuf> {
    if name.is_empty() || name.len() > MAX_IDB_NAME_BYTES {
        return None;
    }
    let hex: String = name.bytes().map(|b| format!("{b:02x}")).collect();
    Some(dir.join(format!("n{hex}.json")))
}

fn read_idb_file(dir: &Path, name: &str) -> Option<String> {
    let path = idb_file_path(dir, name)?;
    if let Ok(meta) = std::fs::symlink_metadata(&path) {
        if meta.file_type().is_symlink() || meta.len() > MAX_IDB_ENTRY_BYTES as u64 {
            return None;
        }
    }
    std::fs::read_to_string(path).ok()
}

fn write_idb_file(dir: &Path, name: &str, data: Option<&str>) {
    let Some(path) = idb_file_path(dir, name) else {
        return;
    };
    if std::fs::symlink_metadata(dir)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
        || std::fs::symlink_metadata(&path)
            .map(|m| m.file_type().is_symlink())
            .unwrap_or(false)
    {
        return;
    }
    match data {
        Some(text) => {
            if text.len() > MAX_IDB_ENTRY_BYTES {
                return;
            }
            if !path.exists() {
                let count = std::fs::read_dir(dir)
                    .into_iter()
                    .flatten()
                    .flatten()
                    .count();
                if count >= MAX_IDB_FILES {
                    return;
                }
            }
            let _ = std::fs::create_dir_all(dir);
            let tmp = path.with_extension("json.tmp");
            if std::fs::symlink_metadata(&tmp)
                .map(|m| m.file_type().is_symlink())
                .unwrap_or(false)
            {
                return;
            }
            if std::fs::write(&tmp, text).is_ok() {
                let _ = std::fs::rename(&tmp, &path);
            }
        }
        None => {
            let _ = std::fs::remove_file(path);
        }
    }
}

fn list_idb_names(dir: &Path) -> String {
    let names: Vec<String> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let fname = e.file_name();
            let hex = fname.to_str()?.strip_prefix('n')?.strip_suffix(".json")?;
            let bytes: Option<Vec<u8>> = (0..hex.len())
                .step_by(2)
                .map(|i| u8::from_str_radix(hex.get(i..i + 2)?, 16).ok())
                .collect();
            String::from_utf8(bytes?).ok()
        })
        .collect();
    json!(names).to_string()
}

fn probe_image_info(bundle: &SoftnBundle, blobs: &BlobStore, url: &str) -> String {
    let raw = if url.starts_with("blob:") {
        blobs.lookup_bytes(url)
    } else if url.starts_with("data:") {
        if url.len() <= MAX_DATA_URL_BYTES {
            data_url::DataUrl::process(url)
                .ok()
                .and_then(|p| p.decode_to_vec().ok())
                .filter(|(b, _)| b.len() <= MAX_DATA_URL_BYTES)
                .map(|(b, _)| b)
        } else {
            None
        }
    } else if let Some(rel) = strip_virtual_origin(url) {
        bundle.read_public_asset(rel).map(|(_, _, b)| b)
    } else if url.starts_with("http://") || url.starts_with("https://") {
        None
    } else {
        bundle.read_public_asset(url).map(|(_, _, b)| b)
    };
    if let Some(bytes) = raw {
        if let Ok(reader) = image::ImageReader::new(std::io::Cursor::new(&bytes)).with_guessed_format() {
            if let Ok((w, h)) = reader.into_dimensions() {
                return json!({ "width": w, "height": h }).to_string();
            }
        }
        if let Some((w, h)) = canvas2d::sanitize_svg_for_raster(&bytes)
            .and_then(|clean| zipp_renderer::svg_size(&clean))
        {
            return json!({ "width": w, "height": h }).to_string();
        }
    }
    r#"{"width":0,"height":0}"#.to_string()
}

fn url_parts(input: &str, base: &str) -> Result<String, String> {
    let parsed = if base.is_empty() {
        url::Url::parse(input)
    } else {
        url::Url::parse(base).and_then(|b| b.join(input))
    }
    .map_err(|e| format!("TypeError: Invalid URL: {e}"))?;
    Ok(url_parts_json(&parsed))
}

fn url_parts_json(u: &url::Url) -> String {
    use url::quirks as q;
    json!({
        "href": q::href(u),
        "origin": q::origin(u),
        "protocol": q::protocol(u),
        "username": q::username(u),
        "password": q::password(u),
        "host": q::host(u),
        "hostname": q::hostname(u),
        "port": q::port(u),
        "pathname": q::pathname(u),
        "search": q::search(u),
        "hash": q::hash(u),
    })
    .to_string()
}

fn url_set(href: &str, part: &str, value: &str) -> Result<String, String> {
    use url::quirks as q;
    let mut u = url::Url::parse(href).map_err(|e| format!("TypeError: Invalid URL: {e}"))?;
    let _ = match part {
        "protocol" => q::set_protocol(&mut u, value),
        "username" => q::set_username(&mut u, value),
        "password" => q::set_password(&mut u, value),
        "host" => q::set_host(&mut u, value),
        "hostname" => q::set_hostname(&mut u, value),
        "port" => q::set_port(&mut u, value),
        "pathname" => {
            q::set_pathname(&mut u, value);
            Ok(())
        }
        "search" => {
            q::set_search(&mut u, value);
            Ok(())
        }
        "hash" => {
            q::set_hash(&mut u, value);
            Ok(())
        }
        _ => return Err(format!("unknown URL part {part:?}")),
    };
    Ok(url_parts_json(&u))
}

fn random_hex(n: usize) -> String {
    use sha2::{Digest, Sha256};
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let mut out = String::with_capacity(n * 2);
    const HEX: &[u8; 16] = b"0123456789abcdef";

    // On Unix/Android, read from a single cached kernel CSPRNG handle (`/dev/urandom`).
    #[cfg(unix)]
    {
        use std::io::Read;
        static URANDOM: LazyLock<Option<Mutex<std::fs::File>>> =
            LazyLock::new(|| std::fs::File::open("/dev/urandom").ok().map(Mutex::new));
        if let Some(ref lock) = *URANDOM {
            if let Ok(mut f) = lock.lock() {
                let mut raw = vec![0u8; n];
                if f.read_exact(&mut raw).is_ok() {
                    for b in raw {
                        out.push(HEX[(b >> 4) as usize] as char);
                        out.push(HEX[(b & 15) as usize] as char);
                    }
                    return out;
                }
            }
        }
    }

    let mut produced = 0usize;
    while produced < n {
        let seq = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let mut h = Sha256::new();
        h.update(seq.to_le_bytes());
        h.update(nanos.to_le_bytes());
        h.update(std::process::id().to_le_bytes());
        let digest = h.finalize();
        for &b in digest.iter() {
            if produced >= n {
                break;
            }
            out.push(HEX[(b >> 4) as usize] as char);
            out.push(HEX[(b & 15) as usize] as char);
            produced += 1;
        }
    }
    out
}

fn is_valid_http_header_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 256
        && name.bytes().all(|b| {
            b.is_ascii_alphanumeric()
                || matches!(
                    b,
                    b'!' | b'#'
                        | b'$'
                        | b'%'
                        | b'&'
                        | b'\''
                        | b'*'
                        | b'+'
                        | b'-'
                        | b'.'
                        | b'^'
                        | b'_'
                        | b'`'
                        | b'|'
                        | b'~'
                )
        })
}

fn is_valid_http_header_value(val: &str) -> bool {
    val.len() <= 8192
        && !val.bytes().any(|b| b == b'\r' || b == b'\n' || b == 0)
}

fn is_forbidden_outbound_header(lower: &str) -> bool {
    matches!(
        lower,
        "host"
            | "cookie"
            | "connection"
            | "keep-alive"
            | "transfer-encoding"
            | "content-length"
            | "te"
            | "upgrade"
            | "x-real-ip"
    ) || lower.starts_with("proxy-")
        || lower.starts_with("x-forwarded-")
}

fn sanitize_outbound_headers(raw: &[(String, String)]) -> Vec<(String, String)> {
    raw.iter()
        .filter(|(k, v)| {
            is_valid_http_header_name(k)
                && is_valid_http_header_value(v)
                && !is_forbidden_outbound_header(&k.to_ascii_lowercase())
        })
        .cloned()
        .collect()
}

/// `(final_url, status, headers, body, sent_cookie)`
type SafeHttpResponse = (String, u16, Vec<(String, String)>, Vec<u8>, bool);

/// Execute an external HTTP/HTTPS request through the pooled SSRF-hardened `HTTP_AGENT`
/// with manual redirect verification (up to `MAX_HTTP_REDIRECTS` hops), cross-origin
/// credential stripping, and strict response body limits (`MAX_HTTP_RESPONSE_BYTES`).
fn execute_safe_http_request(
    bundle: &SoftnBundle,
    cookies: &MobileCookieJar,
    initial_method: &str,
    initial_url: &str,
    initial_headers: &[(String, String)],
    initial_body: &str,
    send_cookies: bool,
) -> Result<SafeHttpResponse, String> {
    let mut current_url = initial_url.to_string();
    let mut method = initial_method.to_ascii_uppercase();
    let mut headers = sanitize_outbound_headers(initial_headers);
    let mut body_opt: Option<&str> = Some(initial_body);
    let initial_origin = url::Url::parse(initial_url).ok().map(|u| u.origin());
    let mut any_cookie_sent = false;
    let deadline = Instant::now() + HTTP_TIMEOUT_GLOBAL;

    for hop in 0..=MAX_HTTP_REDIRECTS {
        if Instant::now() >= deadline {
            return Err("Network error: global request timeout exceeded".into());
        }
        bundle.check_net_url(&current_url)?;
        let parsed = url::Url::parse(&current_url).map_err(|e| format!("Invalid URL: {e}"))?;
        let same_origin = initial_origin
            .as_ref()
            .is_some_and(|orig| *orig == parsed.origin());
        let cookie_val = if send_cookies && (hop == 0 || same_origin) {
            cookies.cookie_header(&parsed)
        } else {
            None
        };
        if cookie_val.is_some() {
            any_cookie_sent = true;
        }

        macro_rules! build_req {
            ($req:expr) => {{
                let mut r = $req;
                for (k, v) in &headers {
                    if !same_origin && k.eq_ignore_ascii_case("authorization") {
                        continue;
                    }
                    r = r.header(k.as_str(), v.as_str());
                }
                if let Some(ref c) = cookie_val {
                    r = r.header("Cookie", c.as_str());
                }
                r
            }};
        }

        let agent = &*HTTP_AGENT;
        let call_res = match method.as_str() {
            "POST" => build_req!(agent.post(&current_url)).send(body_opt.unwrap_or("")),
            "PUT" => build_req!(agent.put(&current_url)).send(body_opt.unwrap_or("")),
            "PATCH" => build_req!(agent.patch(&current_url)).send(body_opt.unwrap_or("")),
            "DELETE" => build_req!(agent.delete(&current_url)).call(),
            "HEAD" => build_req!(agent.head(&current_url)).call(),
            _ => build_req!(agent.get(&current_url)).call(),
        };

        let mut resp = call_res.map_err(|e| format!("Network error: {e}"))?;
        let status = resp.status().as_u16();
        let resp_hdrs = collect_ureq_headers(&resp);
        if send_cookies && (hop == 0 || same_origin) {
            store_set_cookies(cookies, &current_url, &resp_hdrs);
        }

        if matches!(status, 301 | 302 | 303 | 307 | 308) {
            if let Some(loc) = resp_hdrs
                .iter()
                .find(|(k, _)| k.eq_ignore_ascii_case("location"))
                .map(|(_, v)| v.as_str())
            {
                if hop >= MAX_HTTP_REDIRECTS {
                    return Err("Too many HTTP redirects".into());
                }
                let next = parsed
                    .join(loc.trim())
                    .map_err(|e| format!("Invalid redirect Location: {e}"))?;
                let next_str = next.to_string();
                bundle.check_net_url(&next_str)?;
                if next.origin() != parsed.origin() {
                    headers.retain(|(k, _)| !k.eq_ignore_ascii_case("authorization"));
                }
                if status == 303 || ((status == 301 || status == 302) && method == "POST") {
                    method = "GET".to_string();
                    body_opt = None;
                }
                current_url = next_str;
                continue;
            }
        }

        let body = if method == "HEAD" || status == 204 || status == 304 {
            Vec::new()
        } else {
            resp.body_mut()
                .with_config()
                .limit(MAX_HTTP_RESPONSE_BYTES)
                .read_to_vec()
                .map_err(|e| format!("Response body error: {e}"))?
        };
        return Ok((current_url, status, resp_hdrs, body, any_cookie_sent));
    }

    Err("Too many HTTP redirects".into())
}

fn collect_ureq_headers<B>(resp: &ureq::http::Response<B>) -> Vec<(String, String)> {
    resp.headers()
        .iter()
        .filter_map(|(k, v)| Some((k.as_str().to_string(), v.to_str().ok()?.to_string())))
        .collect()
}

fn store_set_cookies(cookies: &MobileCookieJar, url_str: &str, headers: &[(String, String)]) {
    let set_cookies: Vec<String> = headers
        .iter()
        .filter(|(k, _)| k.eq_ignore_ascii_case("set-cookie"))
        .map(|(_, v)| v.clone())
        .collect();
    if set_cookies.is_empty() {
        return;
    }
    let resolved = if url_str.starts_with("http://") || url_str.starts_with("https://") {
        url::Url::parse(url_str).ok()
    } else {
        let path = if url_str.starts_with('/') {
            url_str.to_string()
        } else {
            format!("/{url_str}")
        };
        url::Url::parse(&format!("{VIRTUAL_ORIGIN}{path}")).ok()
    };
    if let Some(u) = resolved {
        cookies.set_from_response(&u, &set_cookies);
    }
}

#[allow(clippy::too_many_arguments)]
fn handle_softn_fetch_bytes(
    bundle: &SoftnBundle,
    backend: Option<&LocalContainerBackend>,
    blobs: &BlobStore,
    http_cache: &MobileHttpCache,
    cookies: &MobileCookieJar,
    host_allows_net: bool,
    raw_url: &str,
    credentials: &str,
    headers_json: &str,
) -> (u16, String, Vec<u8>, Option<String>) {
    if raw_url.starts_with("blob:") {
        return match blobs.lookup(raw_url) {
            Some((mime, bytes)) => (200, mime, bytes, None),
            None => (404, String::new(), Vec::new(), Some(format!("Blob URL not found: {raw_url}"))),
        };
    }
    if raw_url.starts_with("data:") {
        if raw_url.len() > MAX_DATA_URL_BYTES {
            return (413, String::new(), Vec::new(), Some("Data URL exceeds size limit".into()));
        }
        return match data_url::DataUrl::process(raw_url) {
            Ok(parsed) => {
                let mime = parsed.mime_type().to_string();
                match parsed.decode_to_vec() {
                    Ok((bytes, _)) if bytes.len() <= MAX_DATA_URL_BYTES => (200, mime, bytes, None),
                    Ok(_) => (413, String::new(), Vec::new(), Some("Data URL exceeds size limit".into())),
                    Err(e) => (400, String::new(), Vec::new(), Some(format!("Invalid data URL: {e:?}"))),
                }
            }
            Err(e) => (400, String::new(), Vec::new(), Some(format!("Invalid data URL: {e:?}"))),
        };
    }

    let mut req_headers: Vec<(String, String)> = Vec::new();
    if !headers_json.is_empty() {
        if let Ok(Value::Object(map)) = serde_json::from_str::<Value>(headers_json) {
            for (k, v) in map {
                if let Some(s) = v.as_str() {
                    if is_valid_http_header_name(&k)
                        && is_valid_http_header_value(s)
                        && !is_forbidden_outbound_header(&k.to_ascii_lowercase())
                    {
                        req_headers.push((k, s.to_string()));
                    }
                }
            }
        }
    }
    let has_auth_hdr = req_headers
        .iter()
        .any(|(k, _)| k.eq_ignore_ascii_case("authorization"));

    let send_same_origin_cookies = credentials != "omit";
    // 1. Check backend interceptOrigins first (matches `handle_softn_fetch`).
    if let Some(be) = backend {
        if let Some((path, query)) = be.matches_intercept_origin(raw_url) {
            if send_same_origin_cookies {
                if let Ok(u) = url::Url::parse(raw_url) {
                    if let Some(c) = cookies.cookie_header(&u) {
                        req_headers.push(("Cookie".into(), c));
                    }
                }
            }
            let resp = be.handle_request_opts(
                BackendHttpRequest {
                    method: "GET".into(),
                    path,
                    query,
                    headers: req_headers,
                    body: Vec::new(),
                },
                false,
            );
            if send_same_origin_cookies {
                store_set_cookies(cookies, raw_url, &resp.headers);
            }
            let ct = resp
                .headers
                .iter()
                .find(|(k, _)| k.eq_ignore_ascii_case("content-type"))
                .map(|(_, v)| v.clone())
                .unwrap_or_else(|| "application/octet-stream".into());
            return (resp.status, ct, resp.body, None);
        }
    }

    let local_part = if let Some(rest) = strip_virtual_origin(raw_url) {
        Some(rest)
    } else if !raw_url.starts_with("http://") && !raw_url.starts_with("https://") {
        Some(raw_url)
    } else {
        None
    };

    if let Some(rel) = local_part {
        let (path_raw, query) = match rel.split_once('?') {
            Some((p, q)) => (p, q),
            None => (rel, ""),
        };
        let norm_path = if path_raw.starts_with('/') {
            path_raw.to_string()
        } else {
            format!("/{path_raw}")
        };
        if let Some(be) = backend {
            if be.should_route(&norm_path) {
                if send_same_origin_cookies {
                    if let Ok(u) = url::Url::parse(&format!("{VIRTUAL_ORIGIN}{norm_path}")) {
                        if let Some(c) = cookies.cookie_header(&u) {
                            req_headers.push(("Cookie".into(), c));
                        }
                    }
                }
                let resp = be.handle_request_opts(
                    BackendHttpRequest {
                        method: "GET".into(),
                        path: norm_path.clone(),
                        query: query.to_string(),
                        headers: req_headers,
                        body: Vec::new(),
                    },
                    false,
                );
                if send_same_origin_cookies {
                    store_set_cookies(cookies, &norm_path, &resp.headers);
                }
                let ct = resp
                    .headers
                    .iter()
                    .find(|(k, _)| k.eq_ignore_ascii_case("content-type"))
                    .map(|(_, v)| v.clone())
                    .unwrap_or_else(|| "application/octet-stream".into());
                return (resp.status, ct, resp.body, None);
            }
        }
        if let Some((_, mime, bytes)) = bundle.read_public_asset(&norm_path) {
            return (200, mime.to_string(), bytes, None);
        }
        return (404, "text/plain".into(), b"Not Found".to_vec(), None);
    }

    if !host_allows_net {
        return (
            0,
            String::new(),
            Vec::new(),
            Some("Network access was not granted by the user".into()),
        );
    }
    if let Err(err) = bundle.check_net_url(raw_url) {
        return (0, String::new(), Vec::new(), Some(err));
    }

    // External URLs are cross-origin relative to `https://app.softn.local`:
    // only send/store cookies when `credentials === "include"`.
    let send_external_cookies = credentials == "include";
    let revalidate = if !send_external_cookies && !has_auth_hdr {
        match http_cache.lookup(raw_url) {
            CacheLookup::Fresh(e) => return (e.status, e.content_type, e.body.as_ref().clone(), None),
            CacheLookup::Revalidate(e) => Some(e),
            CacheLookup::Miss => None,
        }
    } else {
        None
    };

    let mut cond_headers = req_headers;
    if let Some(ref prev) = revalidate {
        if let Some(ref etag) = prev.etag {
            cond_headers.push(("If-None-Match".to_string(), etag.clone()));
        }
        if let Some(ref lm) = prev.last_modified {
            cond_headers.push(("If-Modified-Since".to_string(), lm.clone()));
        }
    }
    match execute_safe_http_request(
        bundle,
        cookies,
        "GET",
        raw_url,
        &cond_headers,
        "",
        send_external_cookies,
    ) {
        Ok((final_url, status, resp_hdrs, body, sent_cookie)) => {
            if status == 304 {
                if let Some(prev) = revalidate {
                    let refreshed = http_cache.revalidate_304(raw_url, prev, &resp_hdrs);
                    return (
                        refreshed.status,
                        refreshed.content_type,
                        refreshed.body.as_ref().clone(),
                        None,
                    );
                }
            }
            let ct = resp_hdrs
                .iter()
                .find(|(k, _)| k.eq_ignore_ascii_case("content-type"))
                .map(|(_, v)| v.clone())
                .unwrap_or_else(|| "application/octet-stream".into());
            if !has_auth_hdr && !sent_cookie && final_url == raw_url {
                http_cache.store(raw_url, status, &resp_hdrs, body.clone());
            }
            (status, ct, body, None)
        }
        Err(e) => (0, String::new(), Vec::new(), Some(e)),
    }
}

#[allow(clippy::too_many_arguments)]
fn handle_softn_fetch(
    bundle: &SoftnBundle,
    backend: Option<&LocalContainerBackend>,
    blobs: &BlobStore,
    http_cache: &MobileHttpCache,
    cookies: &MobileCookieJar,
    host_allows_net: bool,
    method: &str,
    raw_url: &str,
    headers_json: &str,
    body_text: &str,
    credentials: &str,
) -> String {
    if method.eq_ignore_ascii_case("GET") && (raw_url.starts_with("blob:") || raw_url.starts_with("data:")) {
        let (status, ct, bytes, err) = handle_softn_fetch_bytes(
            bundle,
            backend,
            blobs,
            http_cache,
            cookies,
            host_allows_net,
            raw_url,
            credentials,
            headers_json,
        );
        if let Some(error) = err {
            return json!({ "error": error }).to_string();
        }
        return format_fetch_response(raw_url, status, vec![("Content-Type".into(), ct)], &bytes);
    }

    let mut headers: Vec<(String, String)> = Vec::new();
    if let Ok(Value::Object(map)) = serde_json::from_str::<Value>(headers_json) {
        for (k, v) in map {
            if let Some(s) = v.as_str() {
                if is_valid_http_header_name(&k)
                    && is_valid_http_header_value(s)
                    && !is_forbidden_outbound_header(&k.to_ascii_lowercase())
                {
                    headers.push((k, s.to_string()));
                }
            }
        }
    }
    let send_same_origin_cookies = credentials != "omit";
    let has_auth_hdr = headers.iter().any(|(k, _)| k.eq_ignore_ascii_case("authorization"));

    // 1. Check backend interceptOrigins first
    if let Some(be) = backend {
        if let Some((path, query)) = be.matches_intercept_origin(raw_url) {
            if send_same_origin_cookies {
                if let Ok(u) = url::Url::parse(raw_url) {
                    if let Some(c) = cookies.cookie_header(&u) {
                        headers.push(("Cookie".into(), c));
                    }
                }
            }
            let resp = be.handle_request_opts(
                BackendHttpRequest {
                    method: method.to_string(),
                    path,
                    query,
                    headers,
                    body: body_text.as_bytes().to_vec(),
                },
                false,
            );
            if send_same_origin_cookies {
                store_set_cookies(cookies, raw_url, &resp.headers);
            }
            return format_fetch_response(raw_url, resp.status, resp.headers, &resp.body);
        }
    }

    // 2. Relative or virtual origin URL
    let local_part = if let Some(rest) = strip_virtual_origin(raw_url) {
        Some(rest)
    } else if !raw_url.starts_with("http://") && !raw_url.starts_with("https://") {
        Some(raw_url)
    } else {
        None
    };

    if let Some(rel) = local_part {
        let (path_raw, query) = match rel.split_once('?') {
            Some((p, q)) => (p, q),
            None => (rel, ""),
        };
        let norm_path = if path_raw.starts_with('/') {
            path_raw.to_string()
        } else {
            format!("/{path_raw}")
        };

        if let Some(be) = backend {
            if be.should_route(&norm_path) {
                if send_same_origin_cookies {
                    if let Ok(u) = url::Url::parse(&format!("{VIRTUAL_ORIGIN}{norm_path}")) {
                        if let Some(c) = cookies.cookie_header(&u) {
                            headers.push(("Cookie".into(), c));
                        }
                    }
                }
                let resp = be.handle_request_opts(
                    BackendHttpRequest {
                        method: method.to_string(),
                        path: norm_path.clone(),
                        query: query.to_string(),
                        headers,
                        body: body_text.as_bytes().to_vec(),
                    },
                    false,
                );
                if send_same_origin_cookies {
                    store_set_cookies(cookies, &norm_path, &resp.headers);
                }
                return format_fetch_response(raw_url, resp.status, resp.headers, &resp.body);
            }
        }

        if let Some((_, mime, bytes)) = bundle.read_public_asset(&norm_path) {
            return format_fetch_response(
                raw_url,
                200,
                vec![("Content-Type".into(), mime.into())],
                &bytes,
            );
        }

        return format_fetch_response(
            raw_url,
            404,
            vec![("Content-Type".into(), "text/plain".into())],
            b"Not Found",
        );
    }

    // 3. External HTTP/HTTPS — strictly gated by permission.json `net` + host consent
    if !host_allows_net {
        return json!({ "error": "Network access was not granted by the user" }).to_string();
    }
    if let Err(err) = bundle.check_net_url(raw_url) {
        return json!({ "error": err }).to_string();
    }

    let upper_method = method.to_ascii_uppercase();
    // External origins are cross-origin relative to `https://app.softn.local`:
    // only send/store cookies when `credentials === "include"`.
    let send_external_cookies = credentials == "include";
    let cacheable_get = upper_method == "GET" && !has_auth_hdr && !send_external_cookies;
    let revalidate = if cacheable_get {
        match http_cache.lookup(raw_url) {
            CacheLookup::Fresh(e) => {
                return format_fetch_response(
                    raw_url,
                    e.status,
                    vec![("Content-Type".into(), e.content_type)],
                    &e.body,
                );
            }
            CacheLookup::Revalidate(e) => Some(e),
            CacheLookup::Miss => None,
        }
    } else {
        None
    };

    let mut outbound_headers = headers;
    if let Some(ref prev) = revalidate {
        if let Some(ref etag) = prev.etag {
            outbound_headers.push(("If-None-Match".to_string(), etag.clone()));
        }
        if let Some(ref lm) = prev.last_modified {
            outbound_headers.push(("If-Modified-Since".to_string(), lm.clone()));
        }
    }
    match execute_safe_http_request(
        bundle,
        cookies,
        &upper_method,
        raw_url,
        &outbound_headers,
        body_text,
        send_external_cookies,
    ) {
        Ok((final_url, status, resp_hdrs, body, sent_cookie)) => {
            if status == 304 {
                if let Some(prev) = revalidate {
                    let refreshed = http_cache.revalidate_304(raw_url, prev, &resp_hdrs);
                    let mut merged_hdrs = resp_hdrs;
                    if !merged_hdrs
                        .iter()
                        .any(|(k, _)| k.eq_ignore_ascii_case("content-type"))
                        && !refreshed.content_type.is_empty()
                    {
                        merged_hdrs.push(("Content-Type".into(), refreshed.content_type));
                    }
                    return format_fetch_response(
                        &final_url,
                        refreshed.status,
                        merged_hdrs,
                        &refreshed.body,
                    );
                }
            }
            if upper_method == "GET" && !has_auth_hdr && !sent_cookie && final_url == raw_url {
                http_cache.store(raw_url, status, &resp_hdrs, body.clone());
            } else if matches!(upper_method.as_str(), "POST" | "PUT" | "PATCH" | "DELETE") {
                http_cache.invalidate(raw_url);
            }
            format_fetch_response(&final_url, status, resp_hdrs, &body)
        }
        Err(e) => json!({ "error": e }).to_string(),
    }
}

fn format_fetch_response(
    url: &str,
    status: u16,
    headers: Vec<(String, String)>,
    body: &[u8],
) -> String {
    let hdr_pairs: Vec<[String; 2]> = headers
        .into_iter()
        .filter(|(k, _)| !k.eq_ignore_ascii_case("set-cookie"))
        .map(|(k, v)| [k, v])
        .collect();
    json!({
        "url": url,
        "status": status,
        "headers": hdr_pairs,
        "body": String::from_utf8_lossy(body),
    })
    .to_string()
}

fn gesture_now_ms() -> u64 {
    static START: LazyLock<Instant> = LazyLock::new(Instant::now);
    START.elapsed().as_millis().min(u64::MAX as u128) as u64 + 1
}

#[allow(clippy::too_many_arguments)]
fn handle_softn_device(
    bundle: &SoftnBundle,
    host_info: &HostDeviceInfo,
    logical_w: u32,
    logical_h: u32,
    scale: f32,
    pending_calls: &Arc<Mutex<Vec<PendingDeviceRequest>>>,
    last_user_gesture_ms: &Arc<AtomicU64>,
    req_id: u64,
    namespace: &str,
    method: &str,
    mut params: Value,
) -> String {
    if !params.is_object() {
        params = json!({});
    }
    // 1. Non-sensitive device metadata (always permitted)
    if namespace == "device" && method == "getInfo" {
        return json!({
            "ok": true,
            "result": {
                "platform": host_info.platform,
                "engine": host_info.engine,
                "osVersion": host_info.os_version,
                "model": host_info.model,
                "screenWidth": logical_w,
                "screenHeight": logical_h,
                "devicePixelRatio": scale,
                "capabilities": host_info.capabilities,
            }
        })
        .to_string();
    }

    // 2. Feature detection (`isAvailable`) never touches user hardware
    if method == "isAvailable" && namespace != "device" {
        let cap_key = match namespace {
            "sensors" => "accel",
            other => other,
        };
        let available = host_info
            .capabilities
            .get(namespace)
            .or_else(|| host_info.capabilities.get(cap_key))
            .copied()
            .unwrap_or(false);
        let permitted =
            bundle.has_capability(cap_key) && host_info.host_allows_capability(cap_key);
        return json!({
            "ok": true,
            "result": { "available": available, "permitted": permitted }
        })
        .to_string();
    }

    // 2b. Native OS Share sheet requires a fresh (<= 5 s) user gesture and consumes it
    // so an untrusted app cannot spam share dialogs in the background or on load.
    if namespace == "device" && method == "share" {
        let prev = last_user_gesture_ms.load(Ordering::Relaxed);
        let now = gesture_now_ms();
        if prev == 0 || now.saturating_sub(prev) > 5_000 {
            return json!({
                "ok": false,
                "error": "Share requires a recent user tap or interaction."
            })
            .to_string();
        }
        last_user_gesture_ms.store(0, Ordering::Relaxed);
    }

    // 3. Enforce capability declaration in permission.json + host user consent natively in Rust
    let required_cap = match namespace {
        "device" if method == "clipboardRead" || method == "clipboardWrite" => Some("clipboard"),
        "device" | "permissions" => None,
        "camera" => Some("camera"),
        "bluetooth" => Some("bluetooth"),
        "location" => Some("location"),
        "haptics" => Some("haptics"),
        "notifications" => Some("notifications"),
        "files" => Some("files"),
        "sensors" => Some("accel"),
        "mic" => Some("mic"),
        other => {
            return json!({ "ok": false, "error": format!("Unknown device namespace: {other}") })
                .to_string();
        }
    };

    // Permission query checks bundle permission.json + host user consent FIRST
    // (denied immediately if undeclared or not granted), then delegates to Android OS state check.
    if namespace == "permissions" && method == "query" {
        let cap = params
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        let mapped = match cap.as_str() {
            "geolocation" => "location",
            "microphone" => "mic",
            "accelerometer" | "gyroscope" | "magnetometer" => "accel",
            "clipboard-read" | "clipboard-write" => "clipboard",
            other => other,
        };
        if !mapped.is_empty() {
            if !bundle.has_capability(mapped) {
                return json!({
                    "ok": true,
                    "result": { "state": "denied", "reason": "not_declared_in_permission_json" }
                })
                .to_string();
            }
            if !host_info.host_allows_capability(mapped) {
                return json!({
                    "ok": true,
                    "result": { "state": "denied", "reason": "not_granted_by_user" }
                })
                .to_string();
            }
        }
    }

    if let Some(cap) = required_cap {
        if !bundle.has_capability(cap) {
            return json!({
                "ok": false,
                "error": format!(
                    "{cap} access is not permitted. Declare \"{cap}\": {{ \"enabled\": true }} in permission.json."
                )
            })
            .to_string();
        }
        if !host_info.host_allows_capability(cap) {
            return json!({
                "ok": false,
                "error": format!("{cap} access was not granted by the user.")
            })
            .to_string();
        }
    }

    // 4. Enforce canonical BLE service UUID allowlist natively in Rust
    if namespace == "bluetooth" {
        if let Some(allowed) = bundle.allowed_ble_services() {
            if allowed.is_empty() {
                return json!({
                    "ok": false,
                    "error": "Bluetooth service allowlist in permission.json is empty"
                })
                .to_string();
            }
            if method == "scan" {
                let requested = params.get("services").and_then(|v| v.as_array()).cloned();
                match requested {
                    Some(arr) if !arr.is_empty() => {
                        let mut canonical_list = Vec::with_capacity(arr.len());
                        for s in &arr {
                            let Some(raw_u) = s.as_str() else {
                                return json!({
                                    "ok": false,
                                    "error": "Bluetooth scan service UUID must be a string"
                                })
                                .to_string();
                            };
                            let Some(canon) = canonical_ble_uuid(raw_u) else {
                                return json!({
                                    "ok": false,
                                    "error": format!("Invalid Bluetooth service UUID '{raw_u}'")
                                })
                                .to_string();
                            };
                            if !allowed.contains(&canon) {
                                return json!({
                                    "ok": false,
                                    "error": format!("Bluetooth service '{raw_u}' is not in permission.json bluetooth.services allowlist")
                                })
                                .to_string();
                            }
                            canonical_list.push(Value::String(canon));
                        }
                        if let Some(obj) = params.as_object_mut() {
                            obj.insert("services".into(), Value::Array(canonical_list));
                        }
                    }
                    _ => {
                        // Missing or empty `services`: constrain scan strictly to the allowlisted UUIDs
                        // so a script cannot omit `services` to discover arbitrary BLE peripherals.
                        let mut allowed_sorted: Vec<String> = allowed.iter().cloned().collect();
                        allowed_sorted.sort();
                        if let Some(obj) = params.as_object_mut() {
                            obj.insert(
                                "services".into(),
                                Value::Array(allowed_sorted.into_iter().map(Value::String).collect()),
                            );
                        }
                    }
                }
            } else if method == "connect" {
                // Propagate the canonical BLE service allowlist into Kotlin so GATT service
                // discovery and subsequent read/write calls only expose allowlisted services.
                let mut allowed_sorted: Vec<String> = allowed.iter().cloned().collect();
                allowed_sorted.sort();
                if let Some(obj) = params.as_object_mut() {
                    obj.insert(
                        "allowedServices".into(),
                        Value::Array(allowed_sorted.into_iter().map(Value::String).collect()),
                    );
                }
            } else if method == "read" || method == "write" {
                let raw_svc = params
                    .get("serviceUuid")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let Some(canon) = canonical_ble_uuid(raw_svc) else {
                    return json!({
                        "ok": false,
                        "error": format!("Invalid Bluetooth service UUID '{raw_svc}'")
                    })
                    .to_string();
                };
                if !allowed.contains(&canon) {
                    return json!({
                        "ok": false,
                        "error": format!("Bluetooth service '{raw_svc}' is not allowed by permission.json allowlist")
                    })
                    .to_string();
                }
                if let Some(obj) = params.as_object_mut() {
                    obj.insert("serviceUuid".into(), Value::String(canon));
                }
            }
        }
    }

    // 5. Queue native hardware call for Android Kotlin bridge (bounded to prevent queue flooding)
    if let Ok(mut queue) = pending_calls.lock() {
        if queue.len() >= MAX_PENDING_DEVICE_CALLS {
            return json!({
                "ok": false,
                "error": "Too many pending native device calls"
            })
            .to_string();
        }
        queue.push(PendingDeviceRequest {
            id: req_id,
            namespace: namespace.to_string(),
            method: method.to_string(),
            params,
        });
    }
    json!({ "pending": true }).to_string()
}

fn collect_head_css(raw_html: &str, bundle: &SoftnBundle) -> String {
    let mut css = String::new();
    let lower = raw_html.to_ascii_lowercase();

    // 1. Inline <link rel="stylesheet" href="...">
    let mut pos = 0usize;
    while let Some(rel_idx) = lower[pos..].find("<link") {
        let abs = pos + rel_idx;
        let Some(end_rel) = raw_html[abs..].find('>') else {
            break;
        };
        let tag = &raw_html[abs..abs + end_rel + 1];
        let tag_lower = tag.to_ascii_lowercase();
        if tag_lower.contains("stylesheet") {
            if let Some(href) = extract_attr(tag, "href") {
                if href == "softn:ui.css" || href == "/runtime/ui.css" {
                    css.push_str(SOFTN_UI_CSS);
                    css.push('\n');
                } else if let Some(vfs_path) =
                    resolve_vfs_url(&href, &bundle.entry_path, &bundle.frontend_root)
                {
                    if !bundle.is_private_asset(&vfs_path) {
                        if let Some(text) = bundle.read_text(&vfs_path) {
                            css.push_str(&text);
                            css.push('\n');
                        }
                    }
                } else if let Some((_, _, bytes)) = bundle.read_public_asset(&href) {
                    css.push_str(&String::from_utf8_lossy(&bytes));
                    css.push('\n');
                }
            }
        }
        pos = abs + end_rel + 1;
    }

    // 2. Inline <style>...</style> blocks
    let mut spos = 0usize;
    while spos < raw_html.len() {
        let Some(rel_idx) = lower[spos..].find("<style") else {
            break;
        };
        let abs = spos + rel_idx;
        let Some(open_end) = raw_html[abs..].find('>') else {
            break;
        };
        let content_start = abs + open_end + 1;
        let Some(close_rel) = lower[content_start..].find("</style") else {
            break;
        };
        let close_abs = content_start + close_rel;
        css.push_str(&raw_html[content_start..close_abs]);
        css.push('\n');
        match raw_html[close_abs..].find('>') {
            Some(gt) => spos = close_abs + gt + 1,
            None => break,
        }
    }

    css
}

/// Extract a local WebSocket request URI for the embedded container backend.
/// Rejects arbitrary external `ws://` / `wss://` hosts so external origins cannot
/// be silently misrouted into the local backend.
fn extract_local_ws_uri(raw_url: &str, backend: &LocalContainerBackend) -> Option<String> {
    let trimmed = raw_url.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.starts_with('/') && !trimmed.starts_with("//") {
        return Some(trimmed.to_string());
    }
    if let Some((path, query)) = backend.matches_intercept_origin(trimmed) {
        return Some(if query.is_empty() {
            path
        } else {
            format!("{path}?{query}")
        });
    }
    let normalized = if let Some(rest) = trimmed.strip_prefix("wss://") {
        format!("https://{rest}")
    } else if let Some(rest) = trimmed.strip_prefix("ws://") {
        format!("http://{rest}")
    } else if trimmed.starts_with("https://") || trimmed.starts_with("http://") {
        trimmed.to_string()
    } else if trimmed.contains("://") {
        return None;
    } else {
        return Some(format!("/{trimmed}"));
    };
    if let Some((path, query)) = backend.matches_intercept_origin(&normalized) {
        return Some(if query.is_empty() {
            path
        } else {
            format!("{path}?{query}")
        });
    }
    let parsed = url::Url::parse(&normalized).ok()?;
    let host = parsed.host_str()?.to_ascii_lowercase();
    let virtual_host = url::Url::parse(VIRTUAL_ORIGIN)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_ascii_lowercase()))
        .unwrap_or_else(|| "app.softn.local".to_string());
    if host != virtual_host {
        return None;
    }
    Some(match parsed.query() {
        Some(q) if !q.is_empty() => format!("{}?{q}", parsed.path()),
        _ => parsed.path().to_string(),
    })
}

fn extract_html_open_attrs(raw_html: &str) -> Vec<(String, String)> {
    let lower = raw_html.to_ascii_lowercase();
    let Some(idx) = lower.find("<html") else {
        return Vec::new();
    };
    let Some(end) = raw_html[idx..].find('>') else {
        return Vec::new();
    };
    let tag = &raw_html[idx + 5..idx + end];
    let bytes = tag.as_bytes();
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < bytes.len() {
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= bytes.len() || bytes[i] == b'/' {
            break;
        }
        let ns = i;
        while i < bytes.len() && !bytes[i].is_ascii_whitespace() && bytes[i] != b'=' {
            i += 1;
        }
        let name = tag[ns..i].trim().to_ascii_lowercase();
        if name.is_empty() {
            break;
        }
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        let mut val = String::new();
        if i < bytes.len() && bytes[i] == b'=' {
            i += 1;
            while i < bytes.len() && bytes[i].is_ascii_whitespace() {
                i += 1;
            }
            if i < bytes.len() && (bytes[i] == b'"' || bytes[i] == b'\'') {
                let q = bytes[i];
                i += 1;
                let vs = i;
                while i < bytes.len() && bytes[i] != q {
                    i += 1;
                }
                val = tag[vs..i].to_string();
                if i < bytes.len() {
                    i += 1;
                }
            } else {
                let vs = i;
                while i < bytes.len() && !bytes[i].is_ascii_whitespace() {
                    i += 1;
                }
                val = tag[vs..i].to_string();
            }
        }
        if is_valid_html_attr_name(&name) {
            out.push((name, val));
        }
    }
    out
}

fn extract_body_inner_html(raw_html: &str) -> String {
    let lower = raw_html.to_ascii_lowercase();
    let Some(body_idx) = lower.find("<body") else {
        return strip_script_tags(raw_html);
    };
    let Some(open_end) = raw_html[body_idx..].find('>') else {
        return String::new();
    };
    let start = body_idx + open_end + 1;
    let end = lower[start..]
        .rfind("</body>")
        .map(|i| start + i)
        .unwrap_or(raw_html.len());
    strip_script_tags(&raw_html[start..end])
}

fn strip_script_tags(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let lower = html.to_ascii_lowercase();
    let mut pos = 0usize;
    while let Some(idx) = lower[pos..].find("<script") {
        let abs = pos + idx;
        out.push_str(&html[pos..abs]);
        if let Some(close) = lower[abs..].find("</script>") {
            pos = abs + close + 9;
        } else {
            pos = html.len();
            break;
        }
    }
    if pos < html.len() {
        out.push_str(&html[pos..]);
    }
    out
}

fn extract_scripts(raw_html: &str, bundle: &SoftnBundle) -> (Vec<String>, Vec<(String, String)>) {
    let mut classic = Vec::new();
    let mut modules = Vec::new();
    let lower = raw_html.to_ascii_lowercase();
    let mut pos = 0usize;
    let mut inline_seq = 0usize;

    while pos < raw_html.len() {
        let Some(rel_idx) = lower[pos..].find("<script") else {
            break;
        };
        let abs = pos + rel_idx;
        let Some(open_end) = raw_html[abs..].find('>') else {
            break;
        };
        let tag = &raw_html[abs..abs + open_end + 1];
        let body_start = abs + open_end + 1;
        let close_rel = lower[body_start..].find("</script");
        let ty = extract_attr(tag, "type")
            .unwrap_or_default()
            .to_ascii_lowercase();
        let is_js = ty.is_empty()
            || ty == "module"
            || ty == "text/javascript"
            || ty == "application/javascript"
            || ty == "text/typescript";

        if is_js {
            if let Some(src) = extract_attr(tag, "src") {
                if let Some(vfs_path) =
                    resolve_vfs_url(&src, &bundle.entry_path, &bundle.frontend_root)
                {
                    if !bundle.is_private_asset(&vfs_path) {
                        if let Some(code) = bundle.read_text(&vfs_path) {
                            if ty == "module" {
                                modules.push((format!("{VIRTUAL_ORIGIN}/{vfs_path}"), code));
                            } else {
                                classic.push(code);
                            }
                        }
                    }
                } else if let Some((path, _, bytes)) = bundle.read_public_asset(&src) {
                    let code = String::from_utf8_lossy(&bytes).into_owned();
                    if ty == "module" {
                        modules.push((format!("{VIRTUAL_ORIGIN}/{path}"), code));
                    } else {
                        classic.push(code);
                    }
                }
            } else if let Some(cr) = close_rel {
                let code = raw_html[body_start..body_start + cr].trim();
                if !code.is_empty() {
                    inline_seq += 1;
                    if ty == "module" {
                        let base_name = if bundle.entry_path.is_empty() {
                            format!("inline_{inline_seq}.js")
                        } else {
                            format!("{}#inline_{inline_seq}.js", bundle.entry_path)
                        };
                        modules.push((format!("{VIRTUAL_ORIGIN}/{base_name}"), code.to_string()));
                    } else {
                        classic.push(code.to_string());
                    }
                }
            }
        }

        if let Some(cr) = close_rel {
            let close_abs = body_start + cr;
            match raw_html[close_abs..].find('>') {
                Some(gt) => pos = close_abs + gt + 1,
                None => break,
            }
        } else {
            pos = body_start;
        }
    }

    (classic, modules)
}

fn extract_attr(tag: &str, attr_name: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let needle = format!("{attr_name}=");
    let mut search_from = 0usize;
    while let Some(idx) = lower[search_from..].find(&needle) {
        let abs = search_from + idx;
        // Verify attribute boundary (preceded by whitespace)
        if abs > 0 {
            let prev = tag.as_bytes()[abs - 1];
            if !prev.is_ascii_whitespace() {
                search_from = abs + needle.len();
                continue;
            }
        }
        let after = &tag[abs + needle.len()..];
        let trimmed = after.trim_start();
        if let Some(rest) = trimmed.strip_prefix('"') {
            return rest.split('"').next().map(|s| s.to_string());
        } else if let Some(rest) = trimmed.strip_prefix('\'') {
            return rest.split('\'').next().map(|s| s.to_string());
        } else {
            return trimmed
                .split(|c: char| c.is_ascii_whitespace() || c == '>' || c == '/')
                .next()
                .map(|s| s.to_string());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct Capture(Arc<Mutex<Option<Vec<u8>>>>);

    impl NetHandler for Capture {
        fn bytes(self: Box<Self>, _resolved_url: String, bytes: Bytes) {
            *self.0.lock().unwrap() = Some(bytes.to_vec());
        }
    }

    fn deliver(url: &str, bytes: &[u8]) -> Option<Vec<u8>> {
        let slot = Arc::new(Mutex::new(None));
        deliver_sanitized_bytes(url, bytes.to_vec(), Box::new(Capture(slot.clone())));
        let delivered = slot.lock().unwrap().take();
        delivered
    }

    #[test]
    fn stylesheets_mentioning_svg_are_delivered_untouched() {
        // An inline SVG icon plus a range media query: `<svg` appears mid-payload and the bare
        // `<` is not a tag, which the SVG sanitizer rejects as malformed.
        let css = br#"@charset "utf-8";
.icon{background:url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'><!DOCTYPE x><?xml?></svg>")}
@media (width < 600px){.icon{display:none}}"#;
        assert!(crate::canvas2d::sanitize_svg_for_raster(css).is_none());
        for url in ["https://softn.local/app.css", "blob:softn/1", "https://softn.local/app.css?v=.svg"] {
            assert!(!looks_like_svg(url, css), "{url}");
            assert_eq!(deliver(url, css).as_deref(), Some(&css[..]), "{url}");
        }
    }

    #[test]
    fn every_payload_the_svg_parser_could_accept_is_still_sanitized() {
        // None of these say SVG in the URL; each opens the way an XML document may.
        let local = [
            &b"<svg><image href=\"/data/secret.png\"/></svg>"[..],
            b"\xEF\xBB\xBF \r\n\t<svg><image href=\"/data/secret.png\"/></svg>",
            b"<!-- note --><svg><image href=\"/data/secret.png\"/></svg>",
            b"<?xml version=\"1.0\"?><svg><image href=\"/data/secret.png\"/></svg>",
            b"<s:svg xmlns:s=\"http://www.w3.org/2000/svg\"><s:image href=\"/data/secret.png\"/></s:svg>",
        ];
        for svg in local {
            assert!(looks_like_svg("https://softn.local/pic.png", svg));
            let clean = deliver("https://softn.local/pic.png", svg).expect("sanitized, not dropped");
            assert!(!String::from_utf8(clean).unwrap().contains("secret.png"));
        }
        // A DTD is refused outright, so nothing is delivered.
        let dtd = b"<!DOCTYPE svg [<!ENTITY x SYSTEM \"file:///etc/passwd\">]><svg/>";
        assert!(looks_like_svg("blob:softn/2", dtd));
        assert!(deliver("blob:softn/2", dtd).is_none());

        // The URL alone is enough, whatever the payload starts with.
        assert!(looks_like_svg("https://softn.local/icon.SVG?v=2", b"not xml"));
        assert!(looks_like_svg("data:image/svg+xml;base64,AAAA", b"not xml"));

        // Raster and font payloads never open with `<`, so they skip the sanitizer.
        assert!(!looks_like_svg("https://softn.local/a.png", b"\x89PNG\r\n\x1a\n"));
        assert!(!looks_like_svg("https://softn.local/a.woff2", b"wOF2\x00\x01\x00\x00"));
        assert!(!looks_like_svg("https://softn.local/empty", b""));
    }
}
