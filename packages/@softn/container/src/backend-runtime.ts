/**
 * Isolated Full-Stack Backend Runtime Session.
 *
 * Runs inside a Dedicated Web Worker (`/runtime/backend-worker.js`) in browsers,
 * or inline over an in-memory channel in Node/Vitest.
 *
 * Completely isolated from DOM and from the Frontend Worker:
 * - Hosts XDB SQLite WASM (`XdbSqlManager`) with automatic SQL & JSON seed hydration
 * - Runs Rust Axum/SQLx backends (`zipp-rust.wasm`)
 * - Runs PHP 8.x multi-file apps (`zipp-php.wasm` `PhpApp` SAPI + Worker Mode)
 *   with Apache `.htaccess` rewrite/security rules and virtual folder script resolution
 * - Runs JS/TS (`zipp-javascript.wasm` / `zipp-typescript.wasm`) and Python backends
 * - Streams dirty SQLite `.db` snapshots and PHP overlay snapshots back to host for IndexedDB persistence
 */

import { base64ToBytes, bytesToBase64, isBackendPrivatePath, mimeTypeFor } from './archive';
import { parseCookieHeader, statusTextFor } from './backend-transport';
import { evaluateHtaccessChain, parseHtaccess, type HtaccessVfsProbe, type ParsedHtaccess } from './htaccess';
import {
  loadXdbWasm,
  XdbSqlManager,
  ZIPP_SQL_CAPABILITIES,
  type SqlExecuteOptions,
  type XdbBudgetHooks,
  type XdbPersistMeta,
} from './xdb-sql-bridge';
import {
  loadZippEngine,
  type LoadedZippBindings,
  type ZippEngineInstance,
  type ZippPhpAppInstance,
} from './zipp-loader';
import type {
  BackendConfig,
  BackendWsEvent,
  ContainerBootStatus,
  DatabaseConfig,
  SqliteOpName,
  SqliteWorkspaceBudget,
  ZippEngineSource,
  ZippEngineTier,
} from './types';

export type HostToBackendMsg =
  | {
      type: 'init';
      appId: string;
      backend?: BackendConfig;
      databases?: DatabaseConfig[];
      textFiles: Record<string, string>;
      binaryFiles: Record<string, Uint8Array>;
      initialPersistedDbs?: Record<string, Uint8Array>;
      initialPersistedMeta?: Record<string, { revision?: number; schemaVersion?: number; checksum?: string }>;
      initialPhpOverlay?: string;
      initialRustOverlay?: string;
      runtimeUrl: string;
      engineModule?: ZippEngineSource;
      xdbModule?: ZippEngineSource;
      xdbGlueUrl?: string;
      instructionBudget?: number;
      maxOpenDbs?: number;
      maxWorkspaceDbs?: number;
      maxImportBytes?: number;
    }
  | {
      type: 'fetch';
      reqId: number;
      method: string;
      path: string;
      query: string;
      headers: Record<string, string>;
      bodyBytes?: Uint8Array;
    }
  | {
      type: 'ws-open';
      wsId: string;
      path: string;
      query: string;
      headers: Record<string, string>;
      protocols: string[];
    }
  | {
      type: 'ws-send';
      wsId: string;
      data: string;
      binary?: boolean;
    }
  | {
      type: 'ws-close';
      wsId: string;
      code?: number;
      reason?: string;
    }
  | {
      type: 'seed-db';
      reqId: number;
      dbName: string;
      seedJson: string;
    }
  | {
      type: 'export-db';
      reqId: number;
      dbName: string;
    }
  | {
      type: 'sqlite-op';
      reqId: number;
      op: SqliteOpName;
      args: unknown[];
    }
  | {
      type: 'flush-ack';
      reqId: number;
      dbKey?: string;
      handleId?: number;
    }
  | { type: 'flush' }
  | { type: 'dispose' };

export type BackendToHostMsg =
  | { type: 'ready' }
  | { type: 'status'; status: ContainerBootStatus }
  | {
      type: 'response';
      reqId: number;
      status: number;
      statusText: string;
      headers: Array<[string, string]>;
      bodyBytes: Uint8Array;
    }
  | {
      type: 'ws-event';
      wsId: string;
      event: BackendWsEvent;
    }
  | {
      type: 'rpc-reply';
      reqId: number;
      ok: boolean;
      result?: unknown;
      error?: string;
    }
  | { type: 'sqlite-persist'; dbKey: string; bytes: Uint8Array; meta?: XdbPersistMeta }
  | { type: 'php-overlay-persist'; overlayJson: string }
  | { type: 'rust-overlay-persist'; overlayJson: string }
  | { type: 'console'; level: 'log' | 'info' | 'warn' | 'error'; text: string }
  | { type: 'disposed' }
  | { type: 'error'; message: string };

interface RustWsFrameOut {
  wsId?: string;
  type?: 'text' | 'binary' | 'close' | 'ping' | 'pong';
  data?: string;
  code?: number;
  reason?: string;
}

function hexToUint8(hex: string): Uint8Array {
  const len = Math.floor(hex.length / 2);
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16) || 0;
  }
  return out;
}

function bytesToHexStr(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}
void bytesToHexStr;

const PRIVATE_STATIC_BLOCK = /(?:^|\/)(?:\.htaccess|\.htpasswd|\.env(?:\.[^/]*)?|cargo\.toml|cargo\.lock|manifest\.json|permission\.json|seed\.json|database\.seed\.json)$|\.(?:php|phtml|php5|php7|php8|pht|phps|inc|phar|tpl|rs|db|db-wal|db-shm|db-journal|sqlite|sqlite-wal|sqlite-shm|sqlite-journal|sqlite3|sqlite3-wal|sqlite3-shm|sqlite3-journal|sql|ini|bak|log|sh)$/i;

const PROTECTED_PHP_OVERLAY_EXT_RE = /\.(?:php|phtml|php5|php7|php8|pht|phps|inc|phar|tpl|ini|sql|db|db-wal|db-shm|db-journal|sqlite|sqlite-wal|sqlite-shm|sqlite-journal|sqlite3|sqlite3-wal|sqlite3-shm|sqlite3-journal|sh)$/i;
const PROTECTED_PHP_OVERLAY_BASE_RE = /^(?:\.htaccess|\.htpasswd|\.env(?:\..*)?|manifest\.json|permission\.json|seed\.json|database\.seed\.json)$/i;
const OVERLAY_RESERVED_SEGS = new Set(['', '.', '..', '__proto__', 'constructor', 'prototype']);
const MAX_OVERLAY_ENTRIES = 4096;
const MAX_OVERLAY_TOTAL_BYTES = 16 * 1024 * 1024;

function normalizeSafeOverlayPath(rawPath: string): string | null {
  // eslint-disable-next-line no-control-regex
  if (typeof rawPath !== 'string' || !rawPath || rawPath.includes('\0') || rawPath.includes('\\') || /[\u0000-\u001f\u007f]/.test(rawPath)) {
    return null;
  }
  const clean = rawPath.replace(/^\/+/, '');
  if (!clean || clean.endsWith('/') || clean.endsWith('.')) return null;
  const segs = clean.split('/');
  for (const s of segs) {
    if (OVERLAY_RESERVED_SEGS.has(s) || s.endsWith('.')) return null;
  }
  return clean;
}

function isProtectedPhpOverlayPath(rawPath: string, backendEntry?: string): boolean {
  const norm = normalizeSafeOverlayPath(rawPath);
  if (!norm) return true;
  const lower = norm.toLowerCase();
  const base = lower.slice(lower.lastIndexOf('/') + 1);
  if (PROTECTED_PHP_OVERLAY_EXT_RE.test(lower) || PROTECTED_PHP_OVERLAY_BASE_RE.test(base)) {
    return true;
  }
  if (backendEntry) {
    const cleanEntry = backendEntry.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
    if (cleanEntry && lower === cleanEntry) return true;
  }
  return false;
}

function sanitizePhpOverlayJson(rawJson: string, backendEntry?: string): string {
  try {
    if (rawJson.length > MAX_OVERLAY_TOTAL_BYTES) {
      return '{"writes":{},"deleted":[],"dirs":[]}';
    }
    const parsed = JSON.parse(rawJson) as {
      writes?: Record<string, unknown>;
      deleted?: unknown[];
      dirs?: unknown[];
    };
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return '{"writes":{},"deleted":[],"dirs":[]}';
    }
    const cleanWrites: Record<string, unknown> = Object.create(null);
    let writeCount = 0;
    let totalBytes = 0;
    if (parsed.writes && typeof parsed.writes === 'object' && !Array.isArray(parsed.writes)) {
      for (const [k, v] of Object.entries(parsed.writes)) {
        if (writeCount >= MAX_OVERLAY_ENTRIES) break;
        const norm = normalizeSafeOverlayPath(k);
        if (!norm || isProtectedPhpOverlayPath(norm, backendEntry)) continue;
        const valSize = typeof v === 'string' ? v.length : JSON.stringify(v).length;
        if (totalBytes + norm.length + valSize > MAX_OVERLAY_TOTAL_BYTES) continue;
        cleanWrites[norm] = v;
        writeCount++;
        totalBytes += norm.length + valSize;
      }
    }
    const cleanDeleted: string[] = [];
    if (Array.isArray(parsed.deleted)) {
      for (const p of parsed.deleted) {
        if (cleanDeleted.length >= MAX_OVERLAY_ENTRIES) break;
        if (typeof p !== 'string') continue;
        const norm = normalizeSafeOverlayPath(p);
        if (norm && !isProtectedPhpOverlayPath(norm, backendEntry)) cleanDeleted.push(norm);
      }
    }
    const cleanDirs: string[] = [];
    if (Array.isArray(parsed.dirs)) {
      for (const p of parsed.dirs) {
        if (cleanDirs.length >= MAX_OVERLAY_ENTRIES) break;
        if (typeof p !== 'string') continue;
        const norm = normalizeSafeOverlayPath(p);
        if (norm && !isProtectedPhpOverlayPath(norm, backendEntry)) cleanDirs.push(norm);
      }
    }
    return JSON.stringify({ writes: cleanWrites, deleted: cleanDeleted, dirs: cleanDirs });
  } catch {
    return '{"writes":{},"deleted":[],"dirs":[]}';
  }
}

const JS_BACKEND_PRELUDE = `
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
    throw new Error("Async promise return from JS backend requires synchronous or awaited resolution");
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
`;

const PYTHON_BACKEND_PRELUDE = `
import json as _softn_json

class _SoftnSqlYield(BaseException):
    def __init__(self, op, a, b, c):
        self.op = op
        self.a = a
        self.b = b
        self.c = c

_softn_sql_cache = []
_softn_sql_idx = 0

def _softn_sql_call(op, a="", b="", c=""):
    global _softn_sql_idx
    idx = _softn_sql_idx
    if idx < len(_softn_sql_cache):
        _softn_sql_idx = idx + 1
        res = _softn_sql_cache[idx]
        if isinstance(res, dict) and "__sql_err" in res:
            raise RuntimeError(str(res["__sql_err"]))
        return res
    raise _SoftnSqlYield(op, str(a), str(b), str(c))

class _SoftnSqliteConn:
    def __init__(self, db_id):
        self.id = db_id
    def query(self, sql, params=None):
        p = _softn_json.dumps(params) if params is not None else ""
        res = _softn_sql_call("query", self.id, sql, p)
        if isinstance(res, dict) and res.get("error"):
            raise RuntimeError(str(res["error"]))
        cols = res.get("columns") or []
        raw_rows = res.get("rows") or []
        rows = []
        for arr in raw_rows:
            row = {}
            for i in range(len(cols)):
                row[cols[i]] = arr[i] if i < len(arr) else None
            rows.append(row)
        return {"columns": cols, "rows": rows, "rawRows": raw_rows}
    def all(self, sql, params=None):
        return self.query(sql, params)["rows"]
    def first(self, sql, params=None):
        rows = self.query(sql, params)["rows"]
        return rows[0] if len(rows) > 0 else None
    def get(self, sql, params=None):
        return self.first(sql, params)
    def execute(self, sql, params=None):
        p = _softn_json.dumps(params) if params is not None else ""
        res = _softn_sql_call("execute", self.id, sql, p)
        if isinstance(res, dict) and res.get("error"):
            raise RuntimeError(str(res["error"]))
        return res
    def run(self, sql, params=None):
        return self.execute(sql, params)
    def seed_json(self, seed):
        payload = seed if isinstance(seed, str) else _softn_json.dumps(seed)
        res = _softn_sql_call("seed_json", self.id, payload, "")
        if isinstance(res, dict) and res.get("error"):
            raise RuntimeError(str(res["error"]))
        return res
    def close(self):
        return _softn_sql_call("close", self.id, "", "")

class _SoftnSqliteModule:
    def open(self, url="app.db"):
        r = _softn_sql_call("open", url or "app.db", "1", "")
        if isinstance(r, dict) and r.get("error"):
            raise RuntimeError(str(r["error"]))
        return _SoftnSqliteConn(r["id"])

sqlite = _SoftnSqliteModule()

def __softn_backend_dispatch(req_json, sql_cache_json="[]"):
    global _softn_sql_cache, _softn_sql_idx
    _softn_sql_cache = _softn_json.loads(sql_cache_json) if sql_cache_json else []
    _softn_sql_idx = 0
    req = _softn_json.loads(req_json)
    fn = globals().get("handle_request") or globals().get("handleRequest")
    if fn is None or not callable(fn):
        return _softn_json.dumps({
            "status": 500,
            "headers": [["Content-Type", "text/plain; charset=utf-8"]],
            "body": "Python backend did not define handle_request(req)"
        })
    try:
        res = fn(req)
    except _SoftnSqlYield as y:
        return _softn_json.dumps({"__softn_sql_need": [y.op, y.a, y.b, y.c]})
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
`;

const UTF8_DECODER = new TextDecoder();
const UTF8_ENCODER = new TextEncoder();

function decodeBodyText(bytes: Uint8Array | undefined): string {
  if (!bytes || bytes.byteLength === 0) return '';
  return UTF8_DECODER.decode(bytes);
}

function encodeUtf8(text: string): Uint8Array {
  return UTF8_ENCODER.encode(text);
}

/**
 * Bytes as zipp-php takes the text of a request: one character per byte (0x00..0xFF), which
 * `json_decode()` and `mb_*()` read back as UTF-8.
 */
function latin1Packed(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < bytes.byteLength; i += 8192) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + 8192)));
  }
  return parts.join('');
}

/** Text for zipp-php as its UTF-8 bytes (ASCII as it is). */
function phpText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return /[^\u0000-\u007f]/.test(text) ? latin1Packed(UTF8_ENCODER.encode(text)) : text;
}

const MAX_RESPONSE_HEADERS = 128;
const MAX_RESPONSE_HEADER_BYTES = 8192;
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * A backend's status as both native hosts read it (`backend_status` in apps/softn-host-rust,
 * `clampContainerStatus` in apps/softn-host-php): a whole number from 200 to 599, else 500.
 */
function backendStatus(raw: unknown): number {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 200 && raw <= 599 ? raw : 500;
}

/**
 * A backend's headers as the native hosts send them (`parse_headers_json`): pairs of a header
 * name and a value without CR, LF or NUL, at most 128, a number or boolean value as its text.
 * Any other pair is dropped: it reached the cookie jar and the page's fetch, threw there, and
 * the request was never answered.
 */
function backendHeaders(raw: unknown): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  if (!Array.isArray(raw)) return out;
  for (const item of raw) {
    if (out.length >= MAX_RESPONSE_HEADERS) break;
    if (!Array.isArray(item) || item.length < 2) continue;
    const name: unknown = item[0];
    const given: unknown = item[1];
    const value =
      typeof given === 'string'
        ? given
        : (typeof given === 'number' && Number.isFinite(given)) || typeof given === 'boolean'
          ? String(given)
          : null;
    if (typeof name !== 'string' || value === null) continue;
    if (name.length > 256 || !HEADER_NAME_RE.test(name)) continue;
    if (value.length > MAX_RESPONSE_HEADER_BYTES || /[\r\n\0]/.test(value)) continue;
    out.push([name, value]);
  }
  return out;
}

/**
 * Whether a request header reaches a backend, as on the native hosts (`backend_request_header`
 * in apps/softn-host-rust): a name of lower-case letters, digits and `-` alone (PHP spells `-`
 * and `_` alike in `$_SERVER`, so an `X_Forwarded_For` stood in for `X-Forwarded-For`), and
 * none of the `x-formlogic-*` names FormLogic's runner keeps for itself. `LocalBackendTransport`
 * already sends no others; this holds the session to it too.
 */
function backendRequestHeader(lowerName: string): boolean {
  return /^[a-z0-9-]+$/.test(lowerName) && lowerName !== 'x-formlogic' && !lowerName.startsWith('x-formlogic-');
}

/**
 * `SERVER_NAME` as the hosts give it (`server_host_name`), and Apache: the host a request named
 * without its port (an IPv6 address keeps its brackets); the port is `SERVER_PORT`'s.
 */
function serverHostName(host: string): string {
  const h = host.trim();
  let name: string;
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    name = end >= 0 ? h.slice(0, end + 1) : '';
  } else {
    name = h.split(':')[0];
  }
  return name || 'localhost';
}

/**
 * A request's path as both native hosts take it where it comes in (`decode_http_path` in
 * apps/softn-host-rust, `softn_decode_path` in apps/softn-host-php/runtime/request.php): decoded
 * once, so `.htaccess`, the files and the backend all read the same path, with empty and `.`
 * segments gone and a trailing `/` kept. Null (answered 400) for a `%` without two hex digits,
 * an encoded separator, control character, `?` or `#`, a raw control character or backslash, a
 * `..` segment, or bytes that are not UTF-8. Handed on encoded, `/%61dmin` passed a rule
 * written for `/admin` that the app's router, which decodes, then served.
 */
function decodeRequestPath(raw: string): string | null {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(raw) || /%(?![0-9A-Fa-f]{2})/.test(raw)) return null;
  if (/%(?:[01][0-9A-Fa-f]|7[Ff]|2[Ff]|5[Cc]|3[Ff]|23)/.test(raw)) return null;
  let text: string;
  try {
    text = decodeURIComponent(raw);
  } catch {
    return null;
  }
  const segments = text.split('/');
  if (segments.includes('..')) return null;
  const trailing = text.length > 1 && text.endsWith('/');
  const parts = segments.filter((s) => s !== '' && s !== '.');
  return parts.length === 0 ? '/' : `/${parts.join('/')}${trailing ? '/' : ''}`;
}

function normalizeBackendRequestPath(rawPath: string): string {
  const withSlash = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
  const out: string[] = [];
  for (const seg of withSlash.replace(/\\/g, '/').split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (out.length > 0) out.pop();
      continue;
    }
    out.push(seg);
  }
  return '/' + out.join('/');
}

export class BackendWorkerSession {
  private readonly postToHost: (msg: BackendToHostMsg) => void;
  private backend?: BackendConfig;
  private textFiles: Record<string, string> = Object.create(null);
  private binaryFiles: Record<string, Uint8Array> = Object.create(null);
  private vfsDirs = new Set<string>();
  private htaccessFiles = new Map<string, ParsedHtaccess>();
  private sqlManager: XdbSqlManager | null = null;
  private sqlBridge: { call: (kind: string, args: string[]) => unknown } | null = null;
  private zippBindings: LoadedZippBindings | null = null;
  private rustEngine: ZippEngineInstance | null = null;
  private phpApp: ZippPhpAppInstance | null = null;
  private phpWorkerEngine: ZippEngineInstance | null = null;
  private jsEngine: ZippEngineInstance | null = null;
  private pythonEngine: ZippEngineInstance | null = null;
  private lastPhpOverlaySnapshot = '';
  private lastRawPhpOverlay = '';
  private lastRustOverlaySnapshot = '';
  private rustOverlayWrites: Record<string, string> = Object.create(null);
  private rustOverlayDeleted = new Set<string>();
  private rustOverlayDirs = new Set<string>();
  private instructionBudget = 200_000_000;
  private rustTimerHandle: ReturnType<typeof setTimeout> | null = null;
  private sqlFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private rustOverlayTimer: ReturnType<typeof setTimeout> | null = null;
  /** The SQL bridge the backend's engine was started with, to start it again with. */
  private engineSqlBridge: { call: (kind: string, args: string[]) => unknown } | null = null;
  /** The Rust backend's open WebSockets, closed when its engine is started again. */
  private readonly rustWsIds = new Set<string>();
  private disposed = false;

  constructor(postToHost: (msg: BackendToHostMsg) => void) {
    this.postToHost = postToHost;
  }

  private scheduleSqlFlush(): void {
    if (this.disposed || !this.sqlManager || this.sqlFlushTimer !== null) return;
    this.sqlFlushTimer = setTimeout(() => {
      this.sqlFlushTimer = null;
      if (!this.disposed) this.sqlManager?.flushDirty();
    }, 250);
  }

  private flushSqlNow(): void {
    if (this.sqlFlushTimer !== null) {
      clearTimeout(this.sqlFlushTimer);
      this.sqlFlushTimer = null;
    }
    this.sqlManager?.flushDirty();
  }

  private emitStatus(status: ContainerBootStatus): void {
    if (!this.disposed) {
      this.postToHost({ type: 'status', status });
    }
  }

  async handleMessage(msg: HostToBackendMsg): Promise<void> {
    if (this.disposed && msg.type !== 'dispose') return;
    switch (msg.type) {
      case 'init':
        await this.init(msg);
        return;
      case 'fetch':
        await this.handleFetch(msg);
        return;
      case 'ws-open':
        this.handleWsOpen(msg);
        return;
      case 'ws-send':
        this.handleWsSend(msg);
        return;
      case 'ws-close':
        this.handleWsClose(msg);
        return;
      case 'seed-db':
        this.handleSeedDb(msg);
        return;
      case 'export-db':
        this.handleExportDb(msg);
        return;
      case 'sqlite-op':
        this.handleSqliteOp(msg);
        return;
      case 'flush-ack':
        this.handleFlushAck(msg);
        return;
      case 'flush':
        this.flushSqlNow();
        this.persistRustOverlayIfChanged();
        return;
      case 'dispose':
        this.dispose();
        return;
    }
  }

  private async init(msg: Extract<HostToBackendMsg, { type: 'init' }>): Promise<void> {
    try {
      this.backend = msg.backend;
      this.textFiles = Object.assign(Object.create(null) as Record<string, string>, msg.textFiles ?? {});
      this.binaryFiles = Object.assign(Object.create(null) as Record<string, Uint8Array>, msg.binaryFiles ?? {});
      // Precompute ancestor directory prefixes once so `.htaccess` `-d` probes run in O(1)
      // instead of scanning all VFS keys on every HTTP request.
      this.vfsDirs.clear();
      const indexDirs = (key: string) => {
        let slash = key.indexOf('/');
        while (slash > 0) {
          this.vfsDirs.add(key.slice(0, slash));
          slash = key.indexOf('/', slash + 1);
        }
      };
      for (const k of Object.keys(this.textFiles)) indexDirs(k);
      for (const k of Object.keys(this.binaryFiles)) indexDirs(k);
      if (msg.instructionBudget && msg.instructionBudget > 0) {
        this.instructionBudget = msg.instructionBudget;
      }

      // 1. Parse all `.htaccess` files across the archive (root + nested virtual directories)
      this.htaccessFiles.clear();
      for (const [name, content] of Object.entries(this.textFiles)) {
        if (name === '.htaccess' || name.endsWith('/.htaccess')) {
          const dirPrefix = name === '.htaccess' ? '' : name.slice(0, -'/.htaccess'.length);
          this.htaccessFiles.set(dirPrefix, parseHtaccess(content, dirPrefix));
        }
      }

      // 2. Load XDB SQLite WASM & backend ZIPP engine in parallel to eliminate serial boot latency!
      this.emitStatus({
        phase: 'loading-sqlite',
        message: 'Loading SQLite & backend runtime…',
        percent: 25,
      });
      const backendTier: ZippEngineTier | null = this.backend
        ? this.backend.runtime === 'rust'
          ? 'rust'
          : this.backend.runtime === 'php'
            ? 'php'
            : this.backend.runtime === 'typescript'
              ? 'typescript'
              : this.backend.runtime === 'python'
                ? 'python'
                : 'javascript'
        : null;
      const [xdbBindings, preloadedZippBindings] = await Promise.all([
        loadXdbWasm({
          runtimeUrl: msg.runtimeUrl,
          explicitSource: msg.xdbModule,
          glueUrl: msg.xdbGlueUrl,
        }),
        backendTier
          ? loadZippEngine({
              tier: backendTier,
              runtimeUrl: msg.runtimeUrl,
              explicitSource: msg.engineModule,
            })
          : Promise.resolve(null),
      ]);
      if (this.disposed) return;
      const dbCount = msg.databases?.length ?? 0;
      const persistedCount = msg.initialPersistedDbs ? Object.keys(msg.initialPersistedDbs).length : 0;
      this.emitStatus({
        phase: 'hydrating-db',
        message: 'Preparing database…',
        percent: 38,
        detail:
          persistedCount > 0
            ? 'Restoring saved local database'
            : dbCount > 0
              ? `Opening ${msg.databases!.map((d) => d.name).join(', ')}`
              : 'Ready for SQLite storage',
      });
      this.sqlManager = new XdbSqlManager({
        bindings: xdbBindings,
        databases: msg.databases,
        textFiles: this.textFiles,
        binaryFiles: this.binaryFiles,
        initialPersistedDbs: msg.initialPersistedDbs,
        initialPersistedMeta: msg.initialPersistedMeta,
        // Cap per-connection SQL VM steps and page reads so recursive CTEs cannot hang the worker.
        maxStepsPerConnection: 200_000_000n,
        maxPageReads: 5_000_000n,
        maxOpenDbs: msg.maxOpenDbs,
        maxWorkspaceDbs: msg.maxWorkspaceDbs,
        maxImportBytes: msg.maxImportBytes,
        onPersist: (dbKey, bytes, meta) => {
          if (!this.disposed) {
            this.postToHost({ type: 'sqlite-persist', dbKey, bytes, meta });
          }
        },
      });
      this.sqlManager.preseedConfiguredDatabases();
      // Defer cold-boot seed persistence so initial DB snapshot export never stalls boot latency.
      this.scheduleSqlFlush();

      // 3. Boot backend runtime (if configured)
      if (this.backend && preloadedZippBindings) {
        const runtimeLabel =
          this.backend.runtime === 'rust'
            ? 'Rust'
            : this.backend.runtime === 'php'
              ? 'PHP'
              : this.backend.runtime === 'typescript'
                ? 'TypeScript'
                : this.backend.runtime === 'python'
                  ? 'Python'
                  : 'JavaScript';
        this.emitStatus({
          phase: 'loading-backend-runtime',
          message: `Loading ${runtimeLabel} WebAssembly runtime…`,
          percent: 52,
        });
        this.zippBindings = preloadedZippBindings;

        const budgetHooks: XdbBudgetHooks = {
          hostStepsRemaining: this.zippBindings.hostStepsRemaining,
          hostChargeSteps: this.zippBindings.hostChargeSteps,
        };
        const sqlBridge = this.sqlManager.createZippSqlBridge(budgetHooks);
        this.engineSqlBridge = sqlBridge;

        this.emitStatus({
          phase: 'booting-backend',
          message: `Starting ${runtimeLabel} backend…`,
          percent: 68,
          detail:
            this.backend.runtime === 'rust'
              ? 'Compiling crate and initializing database'
              : `Entry: ${this.backend.entry}`,
        });

        if (this.backend.runtime === 'rust') {
          this.bootRustBackend(sqlBridge, msg.initialRustOverlay);
        } else if (this.backend.runtime === 'php') {
          this.bootPhpBackend(sqlBridge, msg.initialPhpOverlay);
        } else if (this.backend.runtime === 'javascript' || this.backend.runtime === 'typescript') {
          this.bootJsBackend(sqlBridge, this.backend.runtime);
        } else if (this.backend.runtime === 'python') {
          this.bootPythonBackend(sqlBridge);
        }

        this.emitStatus({
          phase: 'backend-ready',
          message: `${runtimeLabel} backend ready`,
          percent: 82,
        });
      }

      this.postToHost({ type: 'ready' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.postToHost({ type: 'error', message });
    }
  }

  private buildVfsObjectForZipp(stripPrefix?: string): Record<string, string | { base64: string }> {
    const out: Record<string, string | { base64: string }> = Object.create(null);
    const prefix = stripPrefix ? stripPrefix.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') + '/' : '';
    const heavyFrontendMediaRe = /\.(?:png|jpe?g|gif|webp|avif|ico|mp4|webm|mp3|wav|ogg|woff2?|ttf|otf|glb|gltf|wasm)$/i;
    for (const [k, v] of Object.entries(this.textFiles)) {
      if (prefix && k.startsWith(prefix)) {
        out[k.slice(prefix.length)] = v;
      } else {
        out[k] = v;
      }
    }
    for (const [k, bytes] of Object.entries(this.binaryFiles)) {
      // Skip large binary DB images from ZIPP VFS (XDB opens DBs directly via app.sql.*)
      if (/\.(?:db|db-wal|db-shm|db-journal|sqlite|sqlite3)$/i.test(k)) continue;
      // Skip heavy frontend media/font/3D/WASM binaries outside the backend root (or >64 KB
      // in root PHP apps where `dispatchPhpRequest` serves static files straight from `binaryFiles`)
      // to avoid base64-encoding megabytes into WASM linear memory on cold boot.
      if (heavyFrontendMediaRe.test(k) && ((prefix && !k.startsWith(prefix)) || bytes.byteLength > 65_536)) {
        continue;
      }
      const entry = { base64: bytesToBase64(bytes) };
      if (prefix && k.startsWith(prefix)) {
        out[k.slice(prefix.length)] = entry;
      } else {
        out[k] = entry;
      }
    }
    return out;
  }

  private isProtectedRustOverlayPath(rawPath: string): boolean {
    const clean = normalizeSafeOverlayPath(rawPath);
    if (!clean) return true;
    const lower = clean.toLowerCase();
    const base = lower.slice(lower.lastIndexOf('/') + 1);
    if (
      lower.endsWith('.rs') ||
      base === 'cargo.toml' ||
      base === 'cargo.lock' ||
      PROTECTED_PHP_OVERLAY_BASE_RE.test(base)
    ) {
      return true;
    }
    if (this.backend) {
      const rootPrefix = this.backend.root ? this.backend.root.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') : '';
      const relEntry =
        rootPrefix && this.backend.entry.startsWith(`${rootPrefix}/`)
          ? this.backend.entry.slice(rootPrefix.length + 1)
          : this.backend.entry;
      if (lower === relEntry.toLowerCase() || lower === this.backend.entry.toLowerCase()) return true;
    }
    return false;
  }

  /**
   * Keep the Rust overlay soon, once for a burst. The engine exports it whole, everything the
   * app has written, so exported after every request, WebSocket message and timer it cost the
   * size of that each time (28 ms a request for 8 MB written). A request that may write keeps it
   * at once, and a flush (the page hidden or closed) and dispose do too.
   */
  private scheduleRustOverlayPersist(): void {
    if (this.disposed || !this.rustEngine || this.rustOverlayTimer !== null) return;
    this.rustOverlayTimer = setTimeout(() => {
      this.rustOverlayTimer = null;
      if (!this.disposed) this.persistRustOverlayIfChanged();
    }, 250);
  }

  private persistRustOverlayIfChanged(): void {
    if (this.rustOverlayTimer !== null) {
      clearTimeout(this.rustOverlayTimer);
      this.rustOverlayTimer = null;
    }
    if (!this.rustEngine || typeof this.rustEngine.exportRustOverlayJson !== 'function') return;
    try {
      const raw = this.rustEngine.exportRustOverlayJson();
      // The engine's overlay is what changed since it started, on top of the files restored
      // then; a file removed is listed in `deleted`. Empty is nothing changed. It was read as
      // everything removed: the boot after a visit that wrote files kept an empty overlay, and
      // the visit after that had none of them (a generated secret, an upload).
      if (!raw || raw.length > MAX_OVERLAY_TOTAL_BYTES || raw === '{"writes":{},"deleted":[],"dirs":[]}') return;
      const delta = JSON.parse(raw) as {
        writes?: Record<string, string>;
        deleted?: string[];
        dirs?: string[];
      };
      let dirty = false;
      let writeCount = Object.keys(this.rustOverlayWrites).length;
      if (delta.writes && typeof delta.writes === 'object') {
        for (const [k, b64] of Object.entries(delta.writes)) {
          if (typeof b64 !== 'string') continue;
          const norm = normalizeSafeOverlayPath(k);
          if (!norm || this.isProtectedRustOverlayPath(norm)) continue;
          const hasKey = Object.prototype.hasOwnProperty.call(this.rustOverlayWrites, norm);
          if (!hasKey && writeCount >= MAX_OVERLAY_ENTRIES) continue;
          if (this.rustOverlayWrites[norm] !== b64 || this.rustOverlayDeleted.has(norm)) {
            if (!hasKey) writeCount++;
            this.rustOverlayWrites[norm] = b64;
            this.rustOverlayDeleted.delete(norm);
            dirty = true;
          }
        }
      }
      if (Array.isArray(delta.deleted)) {
        for (const d of delta.deleted) {
          if (typeof d !== 'string') continue;
          const norm = normalizeSafeOverlayPath(d);
          if (!norm || this.isProtectedRustOverlayPath(norm)) continue;
          if (Object.prototype.hasOwnProperty.call(this.rustOverlayWrites, norm)) {
            delete this.rustOverlayWrites[norm];
            dirty = true;
          }
          if (!this.rustOverlayDeleted.has(norm) && this.rustOverlayDeleted.size < MAX_OVERLAY_ENTRIES) {
            this.rustOverlayDeleted.add(norm);
            dirty = true;
          }
        }
      }
      if (Array.isArray(delta.dirs)) {
        for (const dir of delta.dirs) {
          if (typeof dir !== 'string') continue;
          const norm = normalizeSafeOverlayPath(dir);
          if (norm && !this.isProtectedRustOverlayPath(norm) && !this.rustOverlayDirs.has(norm) && this.rustOverlayDirs.size < MAX_OVERLAY_ENTRIES) {
            this.rustOverlayDirs.add(norm);
            dirty = true;
          }
        }
      }
      if (!dirty) return;
      const merged = JSON.stringify({
        writes: { ...this.rustOverlayWrites },
        deleted: [...this.rustOverlayDeleted].sort(),
        dirs: [...this.rustOverlayDirs].sort(),
      });
      if (merged.length <= MAX_OVERLAY_TOTAL_BYTES && merged !== this.lastRustOverlaySnapshot) {
        this.lastRustOverlaySnapshot = merged;
        this.postToHost({ type: 'rust-overlay-persist', overlayJson: merged });
      }
    } catch {
      // Ignore overlay serialization errors
    }
  }

  private bootRustBackend(
    sqlBridge: { call: (kind: string, args: string[]) => unknown },
    initialOverlay?: string
  ): void {
    const bindings = this.zippBindings!;
    const backend = this.backend!;
    const engine = new bindings.Engine();
    // Generous boot budget for migrations & initial DB seeding
    engine.setInstructionBudget(2_000_000_000);
    engine.setSyncHostCapabilities([...ZIPP_SQL_CAPABILITIES]);
    if (engine.addAppBridge) {
      engine.addAppBridge('sql', sqlBridge);
    } else {
      engine.setAppBridge(sqlBridge);
    }

    const rootPrefix = backend.root ? backend.root.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') : '';
    const vfsObj = this.buildVfsObjectForZipp(rootPrefix);

    // Restore previously persisted Rust VFS overlay (e.g. `.pit.secret` JWT keyfile) BEFORE main() runs
    this.rustOverlayWrites = Object.create(null);
    this.rustOverlayDeleted.clear();
    this.rustOverlayDirs.clear();
    this.lastRustOverlaySnapshot = '';
    if (initialOverlay) {
      try {
        const parsed = JSON.parse(initialOverlay) as {
          writes?: Record<string, string>;
          deleted?: string[];
          dirs?: string[];
        };
        if (Array.isArray(parsed.deleted)) {
          for (const d of parsed.deleted) {
            if (typeof d !== 'string') continue;
            const norm = normalizeSafeOverlayPath(d);
            if (norm && !this.isProtectedRustOverlayPath(norm) && this.rustOverlayDeleted.size < MAX_OVERLAY_ENTRIES) {
              this.rustOverlayDeleted.add(norm);
              delete vfsObj[norm];
            }
          }
        }
        if (parsed.writes && typeof parsed.writes === 'object') {
          let count = 0;
          for (const [k, b64] of Object.entries(parsed.writes)) {
            if (count >= MAX_OVERLAY_ENTRIES) break;
            if (typeof b64 !== 'string') continue;
            const norm = normalizeSafeOverlayPath(k);
            if (norm && !this.isProtectedRustOverlayPath(norm)) {
              this.rustOverlayWrites[norm] = b64;
              vfsObj[norm] = { base64: b64 };
              count++;
            }
          }
        }
        if (Array.isArray(parsed.dirs)) {
          for (const dir of parsed.dirs) {
            if (typeof dir !== 'string') continue;
            const norm = normalizeSafeOverlayPath(dir);
            if (norm && !this.isProtectedRustOverlayPath(norm) && this.rustOverlayDirs.size < MAX_OVERLAY_ENTRIES) {
              this.rustOverlayDirs.add(norm);
            }
          }
        }
        this.lastRustOverlaySnapshot = initialOverlay;
      } catch {
        // Ignore malformed persisted Rust overlay
      }
    }

    const relEntry =
      rootPrefix && backend.entry.startsWith(`${rootPrefix}/`)
        ? backend.entry.slice(rootPrefix.length + 1)
        : backend.entry;

    const env: Record<string, string> = {
      ...(backend.env ?? {}),
    };

    if (!engine.initRustProject) {
      throw new Error('Loaded ZIPP engine does not support Rust projects (expected zipp-rust.wasm)');
    }
    engine.initRustProject(vfsObj, relEntry, {
      mode: 'worker_boot',
      writableVfs: true,
      env,
    });

    const out = engine.takeRustOutput?.() ?? '';
    const err = engine.takeRustStderr?.() ?? '';
    if (out.trim()) this.postToHost({ type: 'console', level: 'log', text: out.trim() });
    if (err.trim()) this.postToHost({ type: 'console', level: 'info', text: err.trim() });

    // Restore per-request turn budget after boot
    engine.setInstructionBudget(Math.max(this.instructionBudget, 200_000_000));
    this.scheduleSqlFlush();
    this.rustEngine = engine;
    // Immediately persist any files written during boot (such as freshly generated `.pit.secret`)
    this.persistRustOverlayIfChanged();
  }

  private bootPhpBackend(
    sqlBridge: { call: (kind: string, args: string[]) => unknown },
    initialOverlay?: string
  ): void {
    const bindings = this.zippBindings!;
    const backend = this.backend!;
    const vfsObj = this.buildVfsObjectForZipp();

    if (backend.phpMode === 'worker') {
      const engine = new bindings.Engine();
      engine.setInstructionBudget(Math.max(this.instructionBudget, 200_000_000));
      engine.setSyncHostCapabilities([...ZIPP_SQL_CAPABILITIES]);
      if (engine.addAppBridge) engine.addAppBridge('sql', sqlBridge);
      else engine.setAppBridge(sqlBridge);
      if (!engine.initPhpProject) {
        throw new Error('Loaded ZIPP engine does not support PHP projects (expected zipp-php.wasm)');
      }
      engine.initPhpProject(vfsObj, backend.entry, {
        env: backend.env ?? {},
      });
      this.phpWorkerEngine = engine;
      return;
    }

    if (!bindings.PhpApp) {
      throw new Error('Loaded ZIPP engine does not export PhpApp (expected zipp-php.wasm)');
    }
    const app = new bindings.PhpApp();
    app.setInstructionBudget(Math.max(this.instructionBudget, 200_000_000));
    app.setSyncHostCapabilities([...ZIPP_SQL_CAPABILITIES]);
    app.addAppBridge('sql', sqlBridge);
    if (backend.env) {
      app.setEnv(backend.env);
    }
    app.mountFiles(vfsObj);
    if (initialOverlay) {
      try {
        const cleanOverlay = sanitizePhpOverlayJson(initialOverlay, backend.entry);
        app.importOverlayJson(cleanOverlay);
        this.lastPhpOverlaySnapshot = cleanOverlay;
      } catch {
        // Ignore corrupt persisted overlay snapshot
      }
    }
    this.phpApp = app;
  }

  private bootJsBackend(
    sqlBridge: { call: (kind: string, args: string[]) => unknown },
    runtime: 'javascript' | 'typescript'
  ): void {
    const bindings = this.zippBindings!;
    const backend = this.backend!;
    const source = this.textFiles[backend.entry];
    if (source === undefined) {
      throw new Error(`JS/TS backend entry '${backend.entry}' not found in archive`);
    }
    const engine = new bindings.Engine();
    engine.setInstructionBudget(Math.max(this.instructionBudget, 200_000_000));
    engine.setSyncHostCapabilities([...ZIPP_SQL_CAPABILITIES]);
    if (engine.addAppBridge) engine.addAppBridge('sql', sqlBridge);
    else engine.setAppBridge(sqlBridge);
    engine.initSource(`${JS_BACKEND_PRELUDE}\n${source}`, runtime);
    this.jsEngine = engine;
  }

  private bootPythonBackend(
    sqlBridge: { call: (kind: string, args: string[]) => unknown }
  ): void {
    const bindings = this.zippBindings!;
    const backend = this.backend!;
    const source = this.textFiles[backend.entry];
    if (source === undefined) {
      throw new Error(`Python backend entry '${backend.entry}' not found in archive`);
    }
    const engine = new bindings.Engine();
    engine.setInstructionBudget(Math.max(this.instructionBudget, 200_000_000));
    engine.setSyncHostCapabilities([...ZIPP_SQL_CAPABILITIES]);
    if (engine.addAppBridge) engine.addAppBridge('sql', sqlBridge);
    else engine.setAppBridge(sqlBridge);
    engine.initSource(`${PYTHON_BACKEND_PRELUDE}\n${source}`, 'python');
    // Python replay executes SQL from the outer host loop (outside a WASM sync host-call frame),
    // so use a bridge without hostChargeSteps (XDB's own BudgetMeter still bounds SQL steps).
    this.sqlBridge = this.sqlManager?.createZippSqlBridge() ?? sqlBridge;
    this.pythonEngine = engine;
  }

  private createVfsProbe(): HtaccessVfsProbe {
    const textFiles = this.textFiles;
    const binaryFiles = this.binaryFiles;
    const vfsDirs = this.vfsDirs;
    return {
      isFile(relPath: string): boolean {
        const clean = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
        return Object.prototype.hasOwnProperty.call(textFiles, clean) || Object.prototype.hasOwnProperty.call(binaryFiles, clean);
      },
      isDir(relPath: string): boolean {
        const clean = relPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
        if (!clean) return true;
        return vfsDirs.has(clean);
      },
      fileSize(relPath: string): number {
        const clean = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
        if (Object.prototype.hasOwnProperty.call(textFiles, clean)) return textFiles[clean].length;
        if (Object.prototype.hasOwnProperty.call(binaryFiles, clean)) return binaryFiles[clean].byteLength;
        return 0;
      },
    };
  }

  private readArchiveBytes(relPath: string): Uint8Array | null {
    const clean = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
    if (Object.prototype.hasOwnProperty.call(this.binaryFiles, clean)) {
      return this.binaryFiles[clean];
    }
    if (Object.prototype.hasOwnProperty.call(this.textFiles, clean)) {
      return encodeUtf8(this.textFiles[clean]);
    }
    return null;
  }

  private hasArchiveFile(relPath: string): boolean {
    const clean = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
    return (
      Object.prototype.hasOwnProperty.call(this.textFiles, clean) ||
      Object.prototype.hasOwnProperty.call(this.binaryFiles, clean)
    );
  }

  private resolveDirectoryIndex(dirRel: string): string | null {
    const rootHt = this.htaccessFiles.get('');
    const dirHt = dirRel ? this.htaccessFiles.get(dirRel) : undefined;
    const candidates =
      dirHt && dirHt.directoryIndex.length > 0
        ? dirHt.directoryIndex
        : rootHt && rootHt.directoryIndex.length > 0
          ? rootHt.directoryIndex
          : ['index.php', 'index.html', 'index.htm'];
    for (const idx of candidates) {
      const full = dirRel ? `${dirRel}/${idx}` : idx;
      if (this.hasArchiveFile(full)) return full;
    }
    return null;
  }

  /**
   * Start the backend's engine again when a request left it gone (`disposed`, the engine's own
   * word for it: an instruction budget run out, another ceiling hit). The native hosts start each
   * request's program afresh, and the Rust host rebuilds its worker; here every request after it
   * was answered "zipp: engine is disposed" until the page was reloaded. A Rust backend's open
   * WebSockets went with its engine, and are closed.
   */
  private restartDisposedEngine(): void {
    const bridge = this.engineSqlBridge;
    const backend = this.backend;
    if (this.disposed || !bridge || !backend || !this.zippBindings) return;
    const gone = (engine: ZippEngineInstance | null) => {
      if (!engine?.disposed) return false;
      try {
        engine.free?.();
      } catch {
        // ignore
      }
      return true;
    };
    try {
      if (gone(this.rustEngine)) {
        this.rustEngine = null;
        if (this.rustTimerHandle !== null) {
          clearTimeout(this.rustTimerHandle);
          this.rustTimerHandle = null;
        }
        for (const wsId of this.rustWsIds) {
          this.postToHost({
            type: 'ws-event',
            wsId,
            event: { type: 'close', code: 1011, reason: 'Backend restarted', wasClean: false },
          });
        }
        this.rustWsIds.clear();
        this.bootRustBackend(bridge, this.lastRustOverlaySnapshot || undefined);
      } else if (gone(this.jsEngine)) {
        this.jsEngine = null;
        this.bootJsBackend(bridge, backend.runtime === 'typescript' ? 'typescript' : 'javascript');
      } else if (gone(this.pythonEngine)) {
        this.pythonEngine = null;
        this.bootPythonBackend(bridge);
      } else if (gone(this.phpWorkerEngine)) {
        this.phpWorkerEngine = null;
        this.bootPhpBackend(bridge);
      } else {
        return;
      }
      this.postToHost({ type: 'console', level: 'warn', text: '[backend] started again after a request used up its engine' });
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      this.postToHost({ type: 'console', level: 'error', text: `[backend] could not be started again: ${text}` });
    }
  }

  private async handleFetch(msg: Extract<HostToBackendMsg, { type: 'fetch' }>): Promise<void> {
    this.restartDisposedEngine();
    const decodedPath = decodeRequestPath(msg.path);
    if (decodedPath === null) {
      this.postToHost({
        type: 'response',
        reqId: msg.reqId,
        status: 400,
        statusText: statusTextFor(400),
        headers: [['Content-Type', 'text/plain; charset=utf-8']],
        bodyBytes: encodeUtf8('Bad Request'),
      });
      return;
    }
    if (decodedPath !== msg.path) msg = { ...msg, path: decodedPath };
    const given = msg.headers ?? {};
    if (Object.keys(given).some((k) => !backendRequestHeader(k.toLowerCase()))) {
      const kept: Record<string, string> = Object.create(null) as Record<string, string>;
      for (const [k, v] of Object.entries(given)) {
        if (backendRequestHeader(k.toLowerCase())) kept[k] = v;
      }
      msg = { ...msg, headers: kept };
    }
    // Each request's SQL ends with it, as on the native hosts (a PHP worker keeps its objects).
    const sqlScope = this.sqlManager && !this.phpWorkerEngine ? this.sqlManager.beginRequestScope() : null;
    const endSqlScope = () => {
      if (sqlScope) this.sqlManager?.endRequestScope(sqlScope, this.phpApp !== null);
    };
    try {
      let status = 404;
      let headers: Array<[string, string]> = [['Content-Type', 'text/plain; charset=utf-8']];
      let bodyBytes: Uint8Array = encodeUtf8('Not Found');

      if (this.rustEngine) {
        const uri = msg.query ? `${msg.path}?${msg.query}` : msg.path;
        this.rustEngine.renewInstructionBudget();
        const rawResp = this.rustEngine.rustDispatchRequest!(
          JSON.stringify({
            method: msg.method,
            uri,
            headers: msg.headers,
            body: decodeBodyText(msg.bodyBytes),
          })
        );
        const parsed = JSON.parse(rawResp) as {
          status?: number;
          headers?: Array<[string, string]>;
          body?: string;
          wsFrames?: RustWsFrameOut[];
          nextTimerMs?: number | null;
        };
        status = parsed.status ?? 200;
        headers = Array.isArray(parsed.headers) ? parsed.headers : [];
        bodyBytes = encodeUtf8(parsed.body ?? '');

        this.drainRustConsole();
        this.forwardRustWsFrames(parsed.wsFrames);
        this.scheduleRustTimerPoll(parsed.nextTimerMs);
      } else if (this.phpApp || this.phpWorkerEngine) {
        const phpResp = this.dispatchPhpRequest(msg);
        status = phpResp.status;
        headers = phpResp.headers;
        bodyBytes = phpResp.bodyBytes;
      } else if (this.jsEngine) {
        this.jsEngine.renewInstructionBudget();
        const rawResp = this.jsEngine.callFunction!('__softnBackendDispatch', [
          JSON.stringify({
            method: msg.method,
            path: msg.path,
            query: msg.query,
            headers: msg.headers,
            body: decodeBodyText(msg.bodyBytes),
          }),
        ]);
        const parsed = JSON.parse(String(rawResp)) as {
          status?: number;
          headers?: Array<[string, string]>;
          body?: string;
        };
        status = parsed.status ?? 200;
        headers = Array.isArray(parsed.headers) ? parsed.headers : [];
        bodyBytes = encodeUtf8(parsed.body ?? '');
      } else if (this.pythonEngine) {
        const pyDispatch = this.pythonEngine.pythonCall ?? this.pythonEngine.callFunction;
        if (!pyDispatch) {
          throw new Error('Loaded ZIPP Python engine does not expose pythonCall');
        }
        const reqPayload = JSON.stringify({
          method: msg.method,
          path: msg.path,
          query: msg.query,
          headers: msg.headers,
          body: decodeBodyText(msg.bodyBytes),
        });
        // Each result as its JSON, made once: the whole cache was made again for every step of
        // the replay, so a request's SQL results were serialized once per later statement.
        const sqlCacheParts: string[] = [];
        const toCacheJson = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? Number(x) : x)) ?? 'null';
        let parsed: {
          status?: number;
          headers?: Array<[string, string]>;
          body?: string;
          __softn_sql_need?: [string, string, string, string];
        } = {};
        const MAX_SQL_STEPS = 512;
        const MAX_PYTHON_SQL_CACHE_BYTES = 8 * 1024 * 1024;
        // Renew budget ONCE per HTTP request (not inside the SQL replay loop, which would
        // amplify the per-request budget by up to 512x).
        this.pythonEngine.renewInstructionBudget();
        for (let step = 0; step <= MAX_SQL_STEPS; step++) {
          const cacheJson = `[${sqlCacheParts.join(',')}]`;
          if (cacheJson.length > MAX_PYTHON_SQL_CACHE_BYTES) {
            throw new Error('Python backend exceeded maximum SQL cache size per request');
          }
          const rawResp = pyDispatch.call(this.pythonEngine, '__softn_backend_dispatch', [
            reqPayload,
            cacheJson,
          ]);
          parsed = JSON.parse(String(rawResp)) as typeof parsed;
          if (Array.isArray(parsed.__softn_sql_need) && this.sqlBridge) {
            if (step >= MAX_SQL_STEPS) {
              throw new Error('Python backend exceeded maximum SQL operations per request');
            }
            const [op, a, b, c] = parsed.__softn_sql_need;
            try {
              const rawSql = this.sqlBridge.call(`sql.${op}`, [a ?? '', b ?? '', c ?? '']);
              sqlCacheParts.push(toCacheJson(typeof rawSql === 'string' ? (rawSql ? JSON.parse(rawSql) : null) : (rawSql ?? null)));
            } catch (sqlErr) {
              sqlCacheParts.push(toCacheJson({ __sql_err: sqlErr instanceof Error ? sqlErr.message : String(sqlErr) }));
            }
            continue;
          }
          break;
        }
        status = parsed.status ?? 200;
        headers = Array.isArray(parsed.headers) ? parsed.headers : [];
        bodyBytes = encodeUtf8(parsed.body ?? '');
      }
      endSqlScope();

      // Persist Rust / PHP VFS overlays if modified (JWT keyfiles, sessions, compiled templates, uploads)
      if (this.rustEngine) {
        const methodUpper = msg.method.toUpperCase();
        if (methodUpper !== 'GET' && methodUpper !== 'HEAD') this.persistRustOverlayIfChanged();
        else this.scheduleRustOverlayPersist();
      }
      if (this.phpApp) {
        try {
          const rawOverlay = this.phpApp.exportOverlayJson();
          if (rawOverlay !== this.lastRawPhpOverlay) {
            this.lastRawPhpOverlay = rawOverlay;
            const snap = sanitizePhpOverlayJson(rawOverlay, this.backend?.entry);
            const isEmptySnap = snap === '{"writes":{},"deleted":[],"dirs":[]}';
            if (snap !== this.lastPhpOverlaySnapshot && (!isEmptySnap || this.lastPhpOverlaySnapshot !== '')) {
              this.lastPhpOverlaySnapshot = snap;
              this.postToHost({ type: 'php-overlay-persist', overlayJson: snap });
            }
          }
        } catch {
          // ignore
        }
      }

      // As the native hosts answer: a status that is no HTTP status is a 500, the pairs that are
      // no header dropped, and a HEAD, 204, 205 or 304 answer has no body, as the browser gives it.
      status = backendStatus(status);
      headers = backendHeaders(headers);
      if (msg.method.toUpperCase() === 'HEAD' || status === 204 || status === 205 || status === 304) {
        bodyBytes = new Uint8Array(0);
      }

      // Deliver the HTTP response to the frontend immediately so mutating requests never stall
      // on SQLite `.db` binary export / IndexedDB persistence, then flush dirty DBs right after.
      this.postToHost({
        type: 'response',
        reqId: msg.reqId,
        status,
        statusText: statusTextFor(status),
        headers,
        bodyBytes,
      });

      if (msg.method !== 'GET' && msg.method !== 'HEAD') {
        this.flushSqlNow();
      } else {
        this.scheduleSqlFlush();
      }
    } catch (err) {
      endSqlScope();
      const text = err instanceof Error ? err.message : String(err);
      this.postToHost({
        type: 'response',
        reqId: msg.reqId,
        status: 500,
        statusText: 'Internal Server Error',
        headers: [['Content-Type', 'text/plain; charset=utf-8']],
        bodyBytes: encodeUtf8(`Backend Error: ${text}`),
      });
      // What the handler wrote before it failed stays written, and is saved like any write.
      try {
        if (msg.method !== 'GET' && msg.method !== 'HEAD') this.flushSqlNow();
        else this.scheduleSqlFlush();
      } catch {
        // ignore
      }
      this.restartDisposedEngine();
    }
  }

  private dispatchPhpRequest(msg: Extract<HostToBackendMsg, { type: 'fetch' }>): {
    status: number;
    headers: Array<[string, string]>;
    bodyBytes: Uint8Array;
  } {
    const vfsProbe = this.createVfsProbe();
    // Decoded and normalized at `handleFetch`, its trailing `/` kept for `.htaccess` (`^blog/$`)
    // and `REQUEST_URI`, as the hosts keep it.
    let targetPath = msg.path.startsWith('/') ? msg.path : normalizeBackendRequestPath(msg.path);
    let targetQuery = msg.query ?? '';
    const originalUri = msg.query ? `${targetPath}?${msg.query}` : targetPath;

    // 1. Evaluate `.htaccess` rules (root + nested virtual directories)
    if (this.htaccessFiles.size > 0) {
      const htRes = evaluateHtaccessChain(
        this.htaccessFiles,
        {
          pathname: targetPath,
          query: targetQuery,
          method: msg.method,
          host: msg.headers['host'] || 'app.softn.local',
          headers: msg.headers,
          https: true,
        },
        vfsProbe
      );
      if (htRes.action === 'deny') {
        return {
          status: htRes.status,
          headers: [['Content-Type', 'text/plain; charset=utf-8']],
          bodyBytes: encodeUtf8(statusTextFor(htRes.status)),
        };
      }
      if (htRes.action === 'redirect') {
        return {
          status: htRes.status,
          headers: [
            ['Location', htRes.location],
            ['Content-Type', 'text/plain; charset=utf-8'],
          ],
          bodyBytes: encodeUtf8(''),
        };
      }
      targetPath = htRes.pathname;
      targetQuery = htRes.query;
    }

    // 2. Resolve virtual folder / script / static asset path
    const rel = targetPath.replace(/^\/+/, '').replace(/\/+$/, '');
    let scriptToRun: string | null = null;
    let staticFile: string | null = null;

    if (rel && this.hasArchiveFile(rel)) {
      if (/\.(?:php|phtml)$/i.test(rel)) {
        scriptToRun = rel;
      } else {
        staticFile = rel;
      }
    } else if (!rel || vfsProbe.isDir(rel)) {
      const idx = this.resolveDirectoryIndex(rel);
      if (idx) {
        if (/\.(?:php|phtml)$/i.test(idx)) scriptToRun = idx;
        else staticFile = idx;
      }
    } else if (this.hasArchiveFile(`${rel}.php`)) {
      // Clean extensionless virtual folder script access (e.g. `/admin/users` -> `admin/users.php`)
      scriptToRun = `${rel}.php`;
    } else if (this.backend?.entry && /\.(?:php|phtml)$/i.test(this.backend.entry)) {
      // Front-controller fallback if no static extension (e.g. SPA/MVC route when no .htaccess)
      const lastSeg = rel.slice(rel.lastIndexOf('/') + 1);
      if (!lastSeg.includes('.') && this.hasArchiveFile(this.backend.entry)) {
        scriptToRun = this.backend.entry;
      }
    }

    // Re-evaluate `.htaccess` access rules against the resolved target path whenever
    // DirectoryIndex, extensionless `.php`, or front-controller fallback changed the target.
    const resolvedTarget = scriptToRun ? `/${scriptToRun}` : staticFile ? `/${staticFile}` : null;
    if (resolvedTarget && resolvedTarget !== targetPath && this.htaccessFiles.size > 0) {
      const resolvedCheck = evaluateHtaccessChain(
        this.htaccessFiles,
        {
          pathname: resolvedTarget,
          query: targetQuery,
          method: msg.method,
          host: msg.headers['host'] || 'app.softn.local',
          headers: msg.headers,
          https: true,
        },
        vfsProbe
      );
      if (resolvedCheck.action === 'deny') {
        return {
          status: resolvedCheck.status,
          headers: [['Content-Type', 'text/plain; charset=utf-8']],
          bodyBytes: encodeUtf8(statusTextFor(resolvedCheck.status)),
        };
      }
    }

    // 3. Static asset serving (GET/HEAD only, blocking private/backend/manifest/DB files)
    if (staticFile) {
      const backendRootWithSlash = this.backend?.root
        ? this.backend.root.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') + '/'
        : '';
      const backendEntryLower = this.backend?.entry
        ? this.backend.entry.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase()
        : '';
      const isPrivateStatic =
        PRIVATE_STATIC_BLOCK.test(staticFile) ||
        isBackendPrivatePath(staticFile, true, backendRootWithSlash) ||
        (backendEntryLower !== '' && staticFile.toLowerCase() === backendEntryLower);
      if (isPrivateStatic) {
        return {
          status: 403,
          headers: [['Content-Type', 'text/plain; charset=utf-8']],
          bodyBytes: encodeUtf8('Forbidden'),
        };
      }
      const methodUpper = msg.method.toUpperCase();
      if (methodUpper !== 'GET' && methodUpper !== 'HEAD') {
        return {
          status: 405,
          headers: [
            ['Content-Type', 'text/plain; charset=utf-8'],
            ['Allow', 'GET, HEAD'],
          ],
          bodyBytes: encodeUtf8('Method Not Allowed'),
        };
      }
      const bytes = this.readArchiveBytes(staticFile);
      if (bytes) {
        return {
          status: 200,
          headers: [['Content-Type', mimeTypeFor(staticFile)]],
          bodyBytes: methodUpper === 'HEAD' ? new Uint8Array(0) : bytes.slice(),
        };
      }
    }

    // 4. PHP execution (SAPI shared-nothing via `PhpApp` or warm `phpWorkerEngine`)
    if (!scriptToRun) {
      return {
        status: 404,
        headers: [['Content-Type', 'text/plain; charset=utf-8']],
        bodyBytes: encodeUtf8(`404 Not Found: ${targetPath}`),
      };
    }

    const lowerHeaders: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const [k, v] of Object.entries(msg.headers)) {
      const lower = k.toLowerCase();
      if (lower === '__proto__' || lower === 'constructor' || lower === 'prototype') continue;
      lowerHeaders[lower] = v;
    }
    const contentType = lowerHeaders['content-type'] ?? '';
    // ZIPP PHP strings are Latin-1 packed UTF-8 byte sequences (0x00..0xFF per byte), and
    // `json_decode()` / `mb_*()` decode via `bytesToUtf8()`. Passing raw body bytes packed
    // 1:1 into Latin-1 preserves non-ASCII UTF-8 characters (e.g. em-dashes, accents, emojis)
    // and binary payloads verbatim in `file_get_contents('php://input')`.
    const bodyPhpBytes = msg.bodyBytes && msg.bodyBytes.byteLength > 0 ? latin1Packed(msg.bodyBytes) : '';
    // Text the host decoded (a cookie, the path, a query a rewrite filled from the path) goes as
    // its UTF-8 bytes too: given as it was, "José" reached PHP as Latin-1. A form body is read by
    // the engine itself, as PHP reads it (`a[]=1&a[]=2` an array, its text UTF-8); the map of
    // it the host also sent had neither, and took the place of the engine's.
    const cookies: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const [k, v] of Object.entries(parseCookieHeader(lowerHeaders['cookie']))) {
      cookies[phpText(k)] = phpText(v);
    }
    const scriptPath = phpText(`/${scriptToRun}`);

    const server: Record<string, string> = {
      REQUEST_METHOD: msg.method.toUpperCase(),
      REQUEST_URI: phpText(originalUri),
      QUERY_STRING: phpText(targetQuery),
      SCRIPT_NAME: scriptPath,
      PHP_SELF: scriptPath,
      SCRIPT_FILENAME: scriptPath,
      DOCUMENT_ROOT: '/',
      SERVER_PROTOCOL: 'HTTP/1.1',
      SERVER_NAME: serverHostName(lowerHeaders['host'] || 'app.softn.local'),
      HTTP_HOST: lowerHeaders['host'] || 'app.softn.local',
      SERVER_PORT: '443',
      HTTPS: 'on',
      REQUEST_SCHEME: 'https',
      REMOTE_ADDR: '127.0.0.1',
      CONTENT_TYPE: contentType,
      CONTENT_LENGTH: String(msg.bodyBytes?.byteLength ?? 0),
    };
    for (const [k, v] of Object.entries(lowerHeaders)) {
      const phpKey = `HTTP_${k.toUpperCase().replace(/-/g, '_')}`;
      server[phpKey] = v;
    }

    const sapiReqJson = JSON.stringify({
      sapi: 'zipp-server',
      server,
      query: phpText(targetQuery),
      cookies,
      contentType,
      body: bodyPhpBytes,
    });

    if (this.phpWorkerEngine) {
      this.phpWorkerEngine.renewInstructionBudget();
      const raw = this.phpWorkerEngine.phpDispatchRequest!(sapiReqJson);
      const meta = JSON.parse(raw.metaJson) as { status?: number; headers?: Array<[string, string]>; body?: string };
      const bodyBytes = raw.bodyBase64 ? base64ToBytes(raw.bodyBase64) : encodeUtf8(meta.body ?? '');
      return {
        status: meta.status ?? 200,
        headers: Array.isArray(meta.headers) ? meta.headers : [['Content-Type', 'text/html; charset=UTF-8']],
        bodyBytes,
      };
    }

    const raw = this.phpApp!.handleRequest(scriptToRun, sapiReqJson);
    const meta = JSON.parse(raw.metaJson) as { status?: number; headers?: Array<[string, string]>; body?: string };
    const bodyBytes = raw.bodyBase64 ? base64ToBytes(raw.bodyBase64) : encodeUtf8(meta.body ?? '');
    if (raw.error) {
      this.postToHost({ type: 'console', level: 'error', text: raw.error });
    }
    return {
      status: meta.status ?? 200,
      headers: Array.isArray(meta.headers) ? meta.headers : [['Content-Type', 'text/html; charset=UTF-8']],
      bodyBytes,
    };
  }

  private handleSeedDb(msg: Extract<HostToBackendMsg, { type: 'seed-db' }>): void {
    if (!this.sqlManager) {
      this.postToHost({ type: 'rpc-reply', reqId: msg.reqId, ok: false, error: 'SQLite engine not initialized' });
      return;
    }
    try {
      const res = this.sqlManager.seedJson(msg.dbName, msg.seedJson);
      this.flushSqlNow();
      if ('error' in res) {
        this.postToHost({ type: 'rpc-reply', reqId: msg.reqId, ok: false, error: res.error });
      } else {
        this.postToHost({ type: 'rpc-reply', reqId: msg.reqId, ok: true, result: res });
      }
    } catch (err) {
      this.postToHost({
        type: 'rpc-reply',
        reqId: msg.reqId,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private handleExportDb(msg: Extract<HostToBackendMsg, { type: 'export-db' }>): void {
    try {
      this.flushSqlNow();
      const bytes = this.sqlManager?.exportBytes(msg.dbName) ?? null;
      this.postToHost({ type: 'rpc-reply', reqId: msg.reqId, ok: true, result: bytes });
    } catch (err) {
      this.postToHost({
        type: 'rpc-reply',
        reqId: msg.reqId,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private handleFlushAck(msg: Extract<HostToBackendMsg, { type: 'flush-ack' }>): void {
    if (!this.sqlManager) {
      this.postToHost({ type: 'rpc-reply', reqId: msg.reqId, ok: true, result: { dbKey: msg.dbKey ?? null, flushedKeys: [] } });
      return;
    }
    try {
      const targetKey =
        typeof msg.handleId === 'number'
          ? this.sqlManager.getKeyForHandle(msg.handleId) ?? undefined
          : msg.dbKey;
      if (!targetKey && this.sqlFlushTimer !== null) {
        clearTimeout(this.sqlFlushTimer);
        this.sqlFlushTimer = null;
      }
      const flushed = this.sqlManager.flushDirty(targetKey);
      this.postToHost({
        type: 'rpc-reply',
        reqId: msg.reqId,
        ok: true,
        result: {
          dbKey: targetKey ?? null,
          flushedKeys: flushed.map((f) => f.dbKey),
        },
      });
    } catch (err) {
      this.postToHost({
        type: 'rpc-reply',
        reqId: msg.reqId,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private decodeSqliteImportArg(raw: unknown): Uint8Array {
    if (raw instanceof Uint8Array) return raw;
    if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
    if (typeof raw === 'string') return base64ToBytes(raw);
    if (raw && typeof raw === 'object' && typeof (raw as { base64?: unknown }).base64 === 'string') {
      return base64ToBytes((raw as { base64: string }).base64);
    }
    throw new Error('Expected Uint8Array or base64 SQLite image');
  }

  private handleSqliteOp(msg: Extract<HostToBackendMsg, { type: 'sqlite-op' }>): void {
    if (!this.sqlManager) {
      this.postToHost({ type: 'rpc-reply', reqId: msg.reqId, ok: false, error: 'SQLite engine not initialized' });
      return;
    }
    try {
      let result: unknown;
      switch (msg.op) {
        case 'open': {
          const openOpts =
            msg.args[1] && typeof msg.args[1] === 'object' && !Array.isArray(msg.args[1])
              ? (msg.args[1] as { readOnly?: boolean })
              : undefined;
          result = this.sqlManager.open(String(msg.args[0] ?? 'app.db'), openOpts);
          break;
        }
        case 'create': {
          const createOpts =
            msg.args[0] && typeof msg.args[0] === 'object' && !Array.isArray(msg.args[0])
              ? (msg.args[0] as { temporary?: boolean; name?: string; readOnly?: boolean; workspaceId?: string })
              : { temporary: true };
          result = this.sqlManager.createDatabase(createOpts);
          break;
        }
        case 'import_bytes': {
          const bytes = this.decodeSqliteImportArg(msg.args[0]);
          const importOpts =
            msg.args[1] && typeof msg.args[1] === 'object' && !Array.isArray(msg.args[1])
              ? (msg.args[1] as { readOnly?: boolean; temporary?: boolean; workspaceId?: string })
              : undefined;
          result = this.sqlManager.importBytes(bytes, importOpts);
          break;
        }
        case 'execute': {
          const execOpts =
            msg.args[3] && typeof msg.args[3] === 'object' && !Array.isArray(msg.args[3])
              ? (msg.args[3] as SqlExecuteOptions)
              : undefined;
          result = this.sqlManager.execute(
            Number(msg.args[0]),
            String(msg.args[1] ?? ''),
            msg.args[2] ? String(msg.args[2]) : undefined,
            undefined,
            execOpts
          );
          this.scheduleSqlFlush();
          break;
        }
        case 'query': {
          const queryOpts =
            msg.args[3] && typeof msg.args[3] === 'object' && !Array.isArray(msg.args[3])
              ? (msg.args[3] as SqlExecuteOptions)
              : undefined;
          result = this.sqlManager.query(
            Number(msg.args[0]),
            String(msg.args[1] ?? ''),
            msg.args[2] ? String(msg.args[2]) : undefined,
            undefined,
            queryOpts
          );
          this.scheduleSqlFlush();
          break;
        }
        case 'seed_json':
          result = this.sqlManager.seedJson(
            typeof msg.args[0] === 'number' ? msg.args[0] : String(msg.args[0] ?? 'app.db'),
            String(msg.args[1] ?? '{}')
          );
          this.scheduleSqlFlush();
          break;
        case 'get_schema':
          result = this.sqlManager.getSchema(Number(msg.args[0]));
          break;
        case 'export_bytes': {
          const exportOpts =
            msg.args[1] && typeof msg.args[1] === 'object' && !Array.isArray(msg.args[1])
              ? (msg.args[1] as { consistency?: 'committed' | 'immediate' })
              : undefined;
          result = this.sqlManager.exportBytesByHandle(Number(msg.args[0]), exportOpts);
          break;
        }
        case 'export_snapshot': {
          const snapOpts =
            msg.args[1] && typeof msg.args[1] === 'object' && !Array.isArray(msg.args[1])
              ? (msg.args[1] as { consistency?: 'committed' | 'immediate' })
              : undefined;
          const target = typeof msg.args[0] === 'number' ? msg.args[0] : String(msg.args[0] ?? 'app.db');
          result = this.sqlManager.exportSnapshot(target, snapOpts);
          break;
        }
        case 'clone': {
          const cloneOpts =
            msg.args[1] && typeof msg.args[1] === 'object' && !Array.isArray(msg.args[1])
              ? (msg.args[1] as { readOnly?: boolean; workspaceId?: string })
              : undefined;
          result = this.sqlManager.cloneHandle(Number(msg.args[0]), cloneOpts);
          break;
        }
        case 'integrity_check': {
          const icOpts =
            msg.args[1] && typeof msg.args[1] === 'object' && !Array.isArray(msg.args[1])
              ? (msg.args[1] as { checkForeignKeys?: boolean })
              : undefined;
          result = this.sqlManager.integrityCheck(Number(msg.args[0]), icOpts);
          break;
        }
        case 'migration_status': {
          const target = typeof msg.args[0] === 'number' ? msg.args[0] : String(msg.args[0] ?? 'app.db');
          result = this.sqlManager.getMigrationStatus(target);
          break;
        }
        case 'dispose':
          result = this.sqlManager.disposeHandle(Number(msg.args[0]));
          this.flushSqlNow();
          break;
        case 'close':
          result = this.sqlManager.close(Number(msg.args[0]));
          this.flushSqlNow();
          break;
        case 'workspace_create': {
          const budget =
            msg.args[0] && typeof msg.args[0] === 'object' && !Array.isArray(msg.args[0])
              ? (msg.args[0] as SqliteWorkspaceBudget)
              : undefined;
          result = this.sqlManager.createWorkspace(budget);
          break;
        }
        case 'workspace_create_db': {
          const wsId = String(msg.args[0] ?? '');
          const opts =
            msg.args[1] && typeof msg.args[1] === 'object' && !Array.isArray(msg.args[1])
              ? (msg.args[1] as { readOnly?: boolean })
              : undefined;
          result = this.sqlManager.createDatabase({ ...opts, workspaceId: wsId, temporary: true });
          break;
        }
        case 'workspace_import_bytes': {
          const wsId = String(msg.args[0] ?? '');
          const bytes = this.decodeSqliteImportArg(msg.args[1]);
          const opts =
            msg.args[2] && typeof msg.args[2] === 'object' && !Array.isArray(msg.args[2])
              ? (msg.args[2] as { readOnly?: boolean })
              : undefined;
          result = this.sqlManager.importBytes(bytes, { ...opts, workspaceId: wsId, temporary: true });
          break;
        }
        case 'workspace_cancel':
          result = this.sqlManager.cancelWorkspace(String(msg.args[0] ?? ''));
          break;
        case 'workspace_dispose':
          result = this.sqlManager.disposeWorkspace(String(msg.args[0] ?? ''));
          break;
        default:
          this.postToHost({ type: 'rpc-reply', reqId: msg.reqId, ok: false, error: `Unknown SQLite op: ${String(msg.op)}` });
          return;
      }
      this.postToHost({ type: 'rpc-reply', reqId: msg.reqId, ok: true, result });
    } catch (err) {
      this.postToHost({
        type: 'rpc-reply',
        reqId: msg.reqId,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private drainRustConsole(): void {
    if (!this.rustEngine) return;
    const out = this.rustEngine.takeRustOutput?.() ?? '';
    const err = this.rustEngine.takeRustStderr?.() ?? '';
    if (out.trim()) this.postToHost({ type: 'console', level: 'log', text: out.trim() });
    if (err.trim()) this.postToHost({ type: 'console', level: 'info', text: err.trim() });
  }

  private forwardRustWsFrames(frames: RustWsFrameOut[] | undefined): void {
    if (!frames || frames.length === 0 || this.disposed) return;
    for (const f of frames) {
      const wsId = String(f.wsId ?? '');
      if (!wsId) continue;
      if (f.type === 'text') {
        this.postToHost({ type: 'ws-event', wsId, event: { type: 'message', data: String(f.data ?? '') } });
      } else if (f.type === 'binary') {
        this.postToHost({ type: 'ws-event', wsId, event: { type: 'message', data: hexToUint8(String(f.data ?? '')) } });
      } else if (f.type === 'close') {
        this.rustWsIds.delete(wsId);
        this.postToHost({
          type: 'ws-event',
          wsId,
          event: { type: 'close', code: f.code ?? 1000, reason: f.reason ?? '', wasClean: true },
        });
      }
    }
  }

  private scheduleRustTimerPoll(nextTimerMs: number | null | undefined): void {
    if (this.rustTimerHandle !== null) {
      clearTimeout(this.rustTimerHandle);
      this.rustTimerHandle = null;
    }
    if (this.disposed || !this.rustEngine || nextTimerMs === null || nextTimerMs === undefined) {
      return;
    }
    const delay = Math.max(5, Math.min(Math.ceil(Number(nextTimerMs) || 0), 60_000));
    this.rustTimerHandle = setTimeout(() => {
      this.rustTimerHandle = null;
      this.pollRustTimers();
    }, delay);
  }

  private pollRustTimers(): void {
    if (this.disposed || !this.rustEngine) return;
    try {
      this.rustEngine.renewInstructionBudget();
      const raw = this.rustEngine.rustDispatchRequest!(JSON.stringify({ __control: 'poll_timers' }));
      const parsed = JSON.parse(raw) as {
        wsFrames?: RustWsFrameOut[];
        nextTimerMs?: number | null;
      };
      this.drainRustConsole();
      this.forwardRustWsFrames(parsed.wsFrames);
      this.scheduleRustTimerPoll(parsed.nextTimerMs);
      this.scheduleRustOverlayPersist();
      this.scheduleSqlFlush();
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      this.postToHost({ type: 'console', level: 'error', text: `[backend timer] ${text}` });
      this.restartDisposedEngine();
    }
  }

  private handleWsOpen(msg: Extract<HostToBackendMsg, { type: 'ws-open' }>): void {
    this.restartDisposedEngine();
    if (!this.rustEngine) {
      this.postToHost({
        type: 'ws-event',
        wsId: msg.wsId,
        event: { type: 'open', protocol: msg.protocols[0] ?? '' },
      });
      return;
    }
    try {
      const uri = msg.query ? `${msg.path}?${msg.query}` : msg.path;
      this.rustEngine.renewInstructionBudget();
      const raw = this.rustEngine.rustDispatchRequest!(
        JSON.stringify({
          __control: 'ws_open',
          wsId: msg.wsId,
          uri,
          headers: Object.entries(msg.headers ?? {}),
        })
      );
      const parsed = JSON.parse(raw) as {
        accepted?: boolean;
        status?: number;
        body?: string;
        wsFrames?: RustWsFrameOut[];
        nextTimerMs?: number | null;
      };
      this.drainRustConsole();
      this.scheduleSqlFlush();
      if (parsed.accepted) {
        this.rustWsIds.add(msg.wsId);
        this.postToHost({
          type: 'ws-event',
          wsId: msg.wsId,
          event: { type: 'open', protocol: msg.protocols[0] ?? '' },
        });
        this.forwardRustWsFrames(parsed.wsFrames);
      } else {
        const reason = parsed.body || `WebSocket rejected (HTTP ${parsed.status ?? 403})`;
        this.postToHost({ type: 'ws-event', wsId: msg.wsId, event: { type: 'error', message: reason } });
        this.postToHost({
          type: 'ws-event',
          wsId: msg.wsId,
          event: { type: 'close', code: 1006, reason, wasClean: false },
        });
      }
      this.scheduleRustTimerPoll(parsed.nextTimerMs);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.postToHost({ type: 'ws-event', wsId: msg.wsId, event: { type: 'error', message: reason } });
      this.postToHost({
        type: 'ws-event',
        wsId: msg.wsId,
        event: { type: 'close', code: 1011, reason, wasClean: false },
      });
    }
  }

  private handleWsSend(msg: Extract<HostToBackendMsg, { type: 'ws-send' }>): void {
    if (!this.rustEngine) return;
    try {
      this.rustEngine.renewInstructionBudget();
      const raw = this.rustEngine.rustDispatchRequest!(
        JSON.stringify({
          __control: 'ws_send',
          wsId: msg.wsId,
          data: msg.data,
          binary: !!msg.binary,
        })
      );
      const parsed = JSON.parse(raw) as {
        wsFrames?: RustWsFrameOut[];
        nextTimerMs?: number | null;
      };
      this.drainRustConsole();
      this.forwardRustWsFrames(parsed.wsFrames);
      this.scheduleRustTimerPoll(parsed.nextTimerMs);
      this.scheduleRustOverlayPersist();
      this.scheduleSqlFlush();
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      this.postToHost({ type: 'console', level: 'error', text: `[backend ws-send] ${text}` });
      this.restartDisposedEngine();
    }
  }

  private handleWsClose(msg: Extract<HostToBackendMsg, { type: 'ws-close' }>): void {
    this.rustWsIds.delete(msg.wsId);
    if (!this.rustEngine) return;
    try {
      this.rustEngine.renewInstructionBudget();
      const raw = this.rustEngine.rustDispatchRequest!(
        JSON.stringify({
          __control: 'ws_close',
          wsId: msg.wsId,
          code: msg.code ?? 1000,
          reason: msg.reason ?? '',
        })
      );
      const parsed = JSON.parse(raw) as {
        wsFrames?: RustWsFrameOut[];
        nextTimerMs?: number | null;
      };
      this.drainRustConsole();
      this.forwardRustWsFrames(parsed.wsFrames);
      this.scheduleRustTimerPoll(parsed.nextTimerMs);
      this.scheduleRustOverlayPersist();
      this.scheduleSqlFlush();
    } catch {
      // ignore close errors
    }
  }

  dispose(): void {
    if (this.disposed) return;
    if (this.rustTimerHandle !== null) {
      clearTimeout(this.rustTimerHandle);
      this.rustTimerHandle = null;
    }
    try { this.persistRustOverlayIfChanged(); } catch { /* ignore */ }
    try { this.flushSqlNow(); } catch { /* ignore */ }
    this.disposed = true;
    try { this.postToHost({ type: 'disposed' }); } catch { /* ignore */ }
    try { this.rustEngine?.dispose(); this.rustEngine?.free?.(); } catch { /* ignore */ }
    try { this.phpApp?.dispose(); this.phpApp?.free?.(); } catch { /* ignore */ }
    try { this.phpWorkerEngine?.dispose(); this.phpWorkerEngine?.free?.(); } catch { /* ignore */ }
    try { this.jsEngine?.dispose(); this.jsEngine?.free?.(); } catch { /* ignore */ }
    try { this.pythonEngine?.dispose(); this.pythonEngine?.free?.(); } catch { /* ignore */ }
    try { this.sqlManager?.dispose(); } catch { /* ignore */ }
    this.rustEngine = null;
    this.phpApp = null;
    this.phpWorkerEngine = null;
    this.jsEngine = null;
    this.pythonEngine = null;
    this.sqlManager = null;
  }
}
