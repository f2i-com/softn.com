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
  type XdbBudgetHooks,
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
      initialPhpOverlay?: string;
      initialRustOverlay?: string;
      runtimeUrl: string;
      engineModule?: ZippEngineSource;
      xdbModule?: ZippEngineSource;
      xdbGlueUrl?: string;
      instructionBudget?: number;
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
      op: 'open' | 'execute' | 'query' | 'seed_json' | 'close';
      args: unknown[];
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
  | { type: 'sqlite-persist'; dbKey: string; bytes: Uint8Array }
  | { type: 'php-overlay-persist'; overlayJson: string }
  | { type: 'rust-overlay-persist'; overlayJson: string }
  | { type: 'console'; level: 'log' | 'info' | 'warn' | 'error'; text: string }
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

const PRIVATE_STATIC_BLOCK = /(?:^|\/)(?:\.htaccess|\.htpasswd|\.env(?:\.[^/]*)?|cargo\.toml|cargo\.lock|manifest\.json|permission\.json|seed\.json)$|\.(?:php|phtml|inc|phar|tpl|rs|db|db-wal|db-shm|db-journal|sqlite|sqlite3|sql|ini|bak|log|sh)$/i;

const PROTECTED_PHP_OVERLAY_EXT_RE = /\.(?:php|phtml|inc|phar)$/i;
const PROTECTED_PHP_OVERLAY_BASE_RE = /^(?:\.htaccess|\.htpasswd|\.env(?:\..*)?|manifest\.json|permission\.json)$/i;

function isProtectedPhpOverlayPath(rawPath: string, backendEntry?: string): boolean {
  const norm = String(rawPath ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!norm || norm.includes('\0')) return true;
  const segs = norm.split('/');
  if (segs.some((s) => s === '..' || s === '.')) return true;
  const lower = norm.toLowerCase();
  const base = segs[segs.length - 1].toLowerCase();
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
    const parsed = JSON.parse(rawJson) as {
      writes?: Record<string, unknown>;
      deleted?: unknown[];
      dirs?: unknown[];
    };
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return '{"writes":{},"deleted":[],"dirs":[]}';
    }
    const cleanWrites: Record<string, unknown> = Object.create(null);
    if (parsed.writes && typeof parsed.writes === 'object' && !Array.isArray(parsed.writes)) {
      for (const [k, v] of Object.entries(parsed.writes)) {
        if (!isProtectedPhpOverlayPath(k, backendEntry)) {
          cleanWrites[k] = v;
        }
      }
    }
    const cleanDeleted = Array.isArray(parsed.deleted)
      ? parsed.deleted.filter((p): p is string => typeof p === 'string' && !isProtectedPhpOverlayPath(p, backendEntry))
      : [];
    const cleanDirs = Array.isArray(parsed.dirs)
      ? parsed.dirs.filter((p): p is string => typeof p === 'string' && !p.includes('..') && !p.includes('\0'))
      : [];
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

function decodeBodyText(bytes: Uint8Array | undefined): string {
  if (!bytes || bytes.byteLength === 0) return '';
  return new TextDecoder().decode(bytes);
}

function encodeUtf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function parseUrlEncodedBody(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const part of raw.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const k = eq >= 0 ? part.slice(0, eq) : part;
    const v = eq >= 0 ? part.slice(eq + 1) : '';
    try {
      out[decodeURIComponent(k.replace(/\+/g, ' '))] = decodeURIComponent(v.replace(/\+/g, ' '));
    } catch {
      out[k] = v;
    }
  }
  return out;
}

export class BackendWorkerSession {
  private readonly postToHost: (msg: BackendToHostMsg) => void;
  private backend?: BackendConfig;
  private textFiles: Record<string, string> = Object.create(null);
  private binaryFiles: Record<string, Uint8Array> = Object.create(null);
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
  private lastRustOverlaySnapshot = '';
  private rustOverlayWrites: Record<string, string> = Object.create(null);
  private rustOverlayDeleted = new Set<string>();
  private rustOverlayDirs = new Set<string>();
  private instructionBudget = 200_000_000;
  private rustTimerHandle: ReturnType<typeof setTimeout> | null = null;
  private sqlFlushTimer: ReturnType<typeof setTimeout> | null = null;
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

      // 2. Load XDB SQLite WASM & pre-seed declared/discovered databases (SQL + JSON seeds!)
      this.emitStatus({
        phase: 'loading-sqlite',
        message: 'Loading SQLite database engine…',
        percent: 25,
      });
      const xdbBindings = await loadXdbWasm({
        runtimeUrl: msg.runtimeUrl,
        explicitSource: msg.xdbModule,
        glueUrl: msg.xdbGlueUrl,
      });
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
        // Cap per-connection SQL VM steps and page reads so recursive CTEs cannot hang the worker.
        maxStepsPerConnection: 200_000_000n,
        maxPageReads: 5_000_000n,
        onPersist: (dbKey, bytes) => {
          if (!this.disposed) {
            this.postToHost({ type: 'sqlite-persist', dbKey, bytes });
          }
        },
      });
      this.sqlManager.preseedConfiguredDatabases();
      this.sqlManager.flushDirty();

      // 3. Boot backend runtime (if configured)
      if (this.backend) {
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
        const tier: ZippEngineTier =
          this.backend.runtime === 'rust'
            ? 'rust'
            : this.backend.runtime === 'php'
              ? 'php'
              : this.backend.runtime === 'typescript'
                ? 'typescript'
                : this.backend.runtime === 'python'
                  ? 'python'
                  : 'javascript';

        this.zippBindings = await loadZippEngine({
          tier,
          runtimeUrl: msg.runtimeUrl,
          explicitSource: msg.engineModule,
        });

        const budgetHooks: XdbBudgetHooks = {
          hostStepsRemaining: this.zippBindings.hostStepsRemaining,
          hostChargeSteps: this.zippBindings.hostChargeSteps,
        };
        const sqlBridge = this.sqlManager.createZippSqlBridge(budgetHooks);

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
    if (!rawPath || typeof rawPath !== 'string' || rawPath.includes('\0') || rawPath.includes('\\')) return true;
    const clean = rawPath.replace(/^\/+/, '');
    if (!clean || clean.split('/').some((seg) => seg === '' || seg === '.' || seg === '..' || seg === '__proto__')) {
      return true;
    }
    const lower = clean.toLowerCase();
    const base = lower.slice(lower.lastIndexOf('/') + 1);
    if (lower.endsWith('.rs') || base === 'cargo.toml' || base === 'cargo.lock') return true;
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

  private persistRustOverlayIfChanged(): void {
    if (!this.rustEngine || typeof this.rustEngine.exportRustOverlayJson !== 'function') return;
    try {
      const raw = this.rustEngine.exportRustOverlayJson();
      if (!raw || raw === '{"writes":{},"deleted":[],"dirs":[]}') return;
      const delta = JSON.parse(raw) as {
        writes?: Record<string, string>;
        deleted?: string[];
        dirs?: string[];
      };
      let dirty = false;
      if (delta.writes && typeof delta.writes === 'object') {
        for (const [k, b64] of Object.entries(delta.writes)) {
          if (typeof b64 !== 'string' || this.isProtectedRustOverlayPath(k)) continue;
          if (this.rustOverlayWrites[k] !== b64 || this.rustOverlayDeleted.has(k)) {
            this.rustOverlayWrites[k] = b64;
            this.rustOverlayDeleted.delete(k);
            dirty = true;
          }
        }
      }
      if (Array.isArray(delta.deleted)) {
        for (const d of delta.deleted) {
          if (typeof d !== 'string' || this.isProtectedRustOverlayPath(d)) continue;
          if (d in this.rustOverlayWrites) {
            delete this.rustOverlayWrites[d];
            dirty = true;
          }
          if (!this.rustOverlayDeleted.has(d)) {
            this.rustOverlayDeleted.add(d);
            dirty = true;
          }
        }
      }
      if (Array.isArray(delta.dirs)) {
        for (const dir of delta.dirs) {
          if (typeof dir === 'string' && !this.rustOverlayDirs.has(dir)) {
            this.rustOverlayDirs.add(dir);
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
      if (merged !== this.lastRustOverlaySnapshot) {
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
            if (typeof d === 'string' && !this.isProtectedRustOverlayPath(d)) {
              this.rustOverlayDeleted.add(d);
              delete vfsObj[d];
            }
          }
        }
        if (parsed.writes && typeof parsed.writes === 'object') {
          for (const [k, b64] of Object.entries(parsed.writes)) {
            if (typeof b64 === 'string' && !this.isProtectedRustOverlayPath(k)) {
              this.rustOverlayWrites[k] = b64;
              vfsObj[k] = { base64: b64 };
            }
          }
        }
        if (Array.isArray(parsed.dirs)) {
          for (const dir of parsed.dirs) {
            if (typeof dir === 'string') this.rustOverlayDirs.add(dir);
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
    this.sqlManager?.flushDirty();
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
    return {
      isFile(relPath: string): boolean {
        const clean = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
        return Object.prototype.hasOwnProperty.call(textFiles, clean) || Object.prototype.hasOwnProperty.call(binaryFiles, clean);
      },
      isDir(relPath: string): boolean {
        const clean = relPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
        if (!clean) return true;
        const prefix = `${clean}/`;
        for (const k of Object.keys(textFiles)) if (k.startsWith(prefix)) return true;
        for (const k of Object.keys(binaryFiles)) if (k.startsWith(prefix)) return true;
        return false;
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

  private async handleFetch(msg: Extract<HostToBackendMsg, { type: 'fetch' }>): Promise<void> {
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
        const sqlCache: unknown[] = [];
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
          const cacheJson = JSON.stringify(sqlCache, (_k, v) => (typeof v === 'bigint' ? Number(v) : v));
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
              sqlCache.push(typeof rawSql === 'string' ? (rawSql ? JSON.parse(rawSql) : null) : (rawSql ?? null));
            } catch (sqlErr) {
              sqlCache.push({ __sql_err: sqlErr instanceof Error ? sqlErr.message : String(sqlErr) });
            }
            continue;
          }
          break;
        }
        status = parsed.status ?? 200;
        headers = Array.isArray(parsed.headers) ? parsed.headers : [];
        bodyBytes = encodeUtf8(parsed.body ?? '');
      }

      // Persist Rust / PHP VFS overlays if modified (JWT keyfiles, sessions, compiled templates, uploads)
      if (this.rustEngine) {
        this.persistRustOverlayIfChanged();
      }
      if (this.phpApp) {
        try {
          const snap = sanitizePhpOverlayJson(this.phpApp.exportOverlayJson(), this.backend?.entry);
          if (snap !== this.lastPhpOverlaySnapshot && snap !== '{"writes":{},"deleted":[],"dirs":[]}') {
            this.lastPhpOverlaySnapshot = snap;
            this.postToHost({ type: 'php-overlay-persist', overlayJson: snap });
          }
        } catch {
          // ignore
        }
      }

      // Flush mutating HTTP requests before returning so committed SQLite writes survive
      // an immediate reload or preview dispose; coalesce any incidental GET writes.
      if (msg.method !== 'GET' && msg.method !== 'HEAD') {
        this.flushSqlNow();
      } else {
        this.scheduleSqlFlush();
      }

      this.postToHost({
        type: 'response',
        reqId: msg.reqId,
        status,
        statusText: statusTextFor(status),
        headers,
        bodyBytes,
      });
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      this.postToHost({
        type: 'response',
        reqId: msg.reqId,
        status: 500,
        statusText: 'Internal Server Error',
        headers: [['Content-Type', 'text/plain; charset=utf-8']],
        bodyBytes: encodeUtf8(`Backend Error: ${text}`),
      });
    }
  }

  private dispatchPhpRequest(msg: Extract<HostToBackendMsg, { type: 'fetch' }>): {
    status: number;
    headers: Array<[string, string]>;
    bodyBytes: Uint8Array;
  } {
    const vfsProbe = this.createVfsProbe();
    let targetPath = msg.path.startsWith('/') ? msg.path : `/${msg.path}`;
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

    // 3. Static asset serving (GET/HEAD only, blocking private/backend/manifest/DB files)
    if (staticFile) {
      const backendRootWithSlash = this.backend?.root
        ? this.backend.root.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') + '/'
        : '';
      const isPrivateStatic =
        PRIVATE_STATIC_BLOCK.test(staticFile) ||
        isBackendPrivatePath(staticFile, true, backendRootWithSlash);
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
          bodyBytes: methodUpper === 'HEAD' ? new Uint8Array(0) : bytes,
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

    const lowerHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(msg.headers)) {
      lowerHeaders[k.toLowerCase()] = v;
    }
    const contentType = lowerHeaders['content-type'] ?? '';
    const bodyText = decodeBodyText(msg.bodyBytes);
    const cookies = parseCookieHeader(lowerHeaders['cookie']);
    const post = contentType.toLowerCase().includes('application/x-www-form-urlencoded')
      ? parseUrlEncodedBody(bodyText)
      : undefined;

    const server: Record<string, string> = {
      REQUEST_METHOD: msg.method.toUpperCase(),
      REQUEST_URI: originalUri,
      QUERY_STRING: targetQuery,
      SCRIPT_NAME: `/${scriptToRun}`,
      PHP_SELF: `/${scriptToRun}`,
      SCRIPT_FILENAME: `/${scriptToRun}`,
      DOCUMENT_ROOT: '/',
      SERVER_PROTOCOL: 'HTTP/1.1',
      SERVER_NAME: lowerHeaders['host'] || 'app.softn.local',
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
      query: targetQuery,
      cookies,
      contentType,
      body: bodyText,
      post,
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
    const res = this.sqlManager.seedJson(msg.dbName, msg.seedJson);
    this.flushSqlNow();
    if ('error' in res) {
      this.postToHost({ type: 'rpc-reply', reqId: msg.reqId, ok: false, error: res.error });
    } else {
      this.postToHost({ type: 'rpc-reply', reqId: msg.reqId, ok: true, result: res });
    }
  }

  private handleExportDb(msg: Extract<HostToBackendMsg, { type: 'export-db' }>): void {
    this.flushSqlNow();
    const bytes = this.sqlManager?.exportBytes(msg.dbName) ?? null;
    this.postToHost({ type: 'rpc-reply', reqId: msg.reqId, ok: true, result: bytes });
  }

  private handleSqliteOp(msg: Extract<HostToBackendMsg, { type: 'sqlite-op' }>): void {
    if (!this.sqlManager) {
      this.postToHost({ type: 'rpc-reply', reqId: msg.reqId, ok: false, error: 'SQLite engine not initialized' });
      return;
    }
    let result: unknown;
    switch (msg.op) {
      case 'open':
        result = this.sqlManager.open(String(msg.args[0] ?? 'app.db'));
        break;
      case 'execute':
        result = this.sqlManager.execute(Number(msg.args[0]), String(msg.args[1] ?? ''), msg.args[2] ? String(msg.args[2]) : undefined);
        this.sqlManager.flushDirty();
        break;
      case 'query':
        result = this.sqlManager.query(Number(msg.args[0]), String(msg.args[1] ?? ''), msg.args[2] ? String(msg.args[2]) : undefined);
        break;
      case 'seed_json':
        result = this.sqlManager.seedJson(
          typeof msg.args[0] === 'number' ? msg.args[0] : String(msg.args[0] ?? 'app.db'),
          String(msg.args[1] ?? '{}')
        );
        this.sqlManager.flushDirty();
        break;
      case 'close':
        result = this.sqlManager.close(Number(msg.args[0]));
        break;
    }
    this.postToHost({ type: 'rpc-reply', reqId: msg.reqId, ok: true, result });
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
      this.scheduleSqlFlush();
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      this.postToHost({ type: 'console', level: 'error', text: `[backend timer] ${text}` });
    }
  }

  private handleWsOpen(msg: Extract<HostToBackendMsg, { type: 'ws-open' }>): void {
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
      this.scheduleSqlFlush();
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      this.postToHost({ type: 'console', level: 'error', text: `[backend ws-send] ${text}` });
    }
  }

  private handleWsClose(msg: Extract<HostToBackendMsg, { type: 'ws-close' }>): void {
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
    try { this.flushSqlNow(); } catch { /* ignore */ }
    this.disposed = true;
    try { this.rustEngine?.dispose(); } catch { /* ignore */ }
    try { this.phpApp?.dispose(); } catch { /* ignore */ }
    try { this.phpWorkerEngine?.dispose(); } catch { /* ignore */ }
    try { this.jsEngine?.dispose(); } catch { /* ignore */ }
    try { this.pythonEngine?.dispose(); } catch { /* ignore */ }
    try { this.sqlManager?.dispose(); } catch { /* ignore */ }
    this.rustEngine = null;
    this.phpApp = null;
    this.phpWorkerEngine = null;
    this.jsEngine = null;
    this.pythonEngine = null;
    this.sqlManager = null;
  }
}
