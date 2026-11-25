/**
 * SoftN v2 Web Container multi-user backend runner for `apps/softn-host-php`.
 *
 * Executes embedded container backends (`php`, `javascript`, `typescript`, `python`, `rust`)
 * strictly inside ZIPP WebAssembly `safe-sandbox` engines — NEVER native OS PHP, Python,
 * or shell execution — backed by Node 24's built-in `node:sqlite` (`DatabaseSync`) in
 * multi-user WAL mode under `private/data/databases/`.
 */
import {DatabaseSync, constants as SQLITE_CONST} from 'node:sqlite';
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  lstatSync,
  statSync,
  realpathSync,
  existsSync,
  mkdirSync,
  chmodSync,
  copyFileSync,
  rmSync,
  renameSync,
  openSync,
  closeSync,
} from 'node:fs';
import {join, dirname, relative, isAbsolute, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {SQL_LIMITS} from './sql.mjs';

const MAX_VFS_FILES = 4000;
const MAX_VFS_TOTAL_BYTES = 64 * 1024 * 1024;
const INSTRUCTION_BUDGET = 200_000_000;
const BOOT_INSTRUCTION_BUDGET = 1_500_000_000;

const ZIPP_SQL_CAPABILITIES = [
  'app.sql.open',
  'app.sql.execute',
  'app.sql.query',
  'app.sql.seed_json',
  'app.sql.copy',
  'app.sql.remove',
  'app.sql.close',
];

const PRIVATE_STATIC_BLOCK =
  /(?:^|\/)(?:\.htaccess|\.htpasswd|\.env(?:\.[^/]*)?|cargo\.toml|cargo\.lock|composer\.json|composer\.lock|manifest\.json|permission\.json)$|\.(?:php|phtml|php5|php7|php8|pht|phps|phar|inc|tpl|rs|py|pem|key|secret|toml|db|db-wal|db-shm|db-journal|sqlite|sqlite-wal|sqlite-shm|sqlite-journal|sqlite3|sqlite3-wal|sqlite3-shm|sqlite3-journal|sql|ini|bak|log|sh|logic)$/i;

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
        raw_headers = res.get("headers", [])
        if isinstance(raw_headers, dict):
            headers = [[str(k), str(v)] for k, v in raw_headers.items()]
        else:
            headers = [[str(h[0]), str(h[1])] for h in raw_headers]
        if "json" in res and res["json"] is not None:
            body = _softn_json.dumps(res["json"])
            if not any(h[0].lower() == "content-type" for h in headers):
                headers.append(["Content-Type", "application/json; charset=utf-8"])
        else:
            body = res.get("body", "")
            if not isinstance(body, str):
                body = _softn_json.dumps(body)
        return _softn_json.dumps({"status": status, "headers": headers, "body": body})
    return _softn_json.dumps({"status": 200, "headers": [["Content-Type", "text/plain"]], "body": ""})
`;

export function isContainerBackendManifest(manifest) {
  return Boolean(
    manifest &&
      typeof manifest === 'object' &&
      !Array.isArray(manifest) &&
      manifest.backend &&
      typeof manifest.backend === 'object' &&
      !Array.isArray(manifest.backend) &&
      typeof manifest.backend.runtime === 'string' &&
      manifest.backend.runtime.trim() !== '' &&
      typeof manifest.backend.entry === 'string' &&
      manifest.backend.entry.trim() !== ''
  );
}

function normalizeVfsKey(raw) {
  const parts = [];
  for (const seg of String(raw ?? '').replace(/\\/g, '/').split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

function contained(parent, child) {
  const rel = relative(parent, child);
  return rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/'));
}

function normalizeDbKey(rawUrl) {
  let clean = String(rawUrl ?? '').trim();
  const qIdx = clean.indexOf('?');
  if (qIdx >= 0) clean = clean.slice(0, qIdx);
  clean = clean.replace(/^sqlite:\/\//i, '').replace(/^sqlite:/i, '').replace(/^file:/i, '');
  if (!clean || clean === ':memory:' || clean.toLowerCase() === 'memory') {
    return {key: ':memory:', inMemory: true};
  }
  clean = clean.replace(/\\/g, '/').replace(/^\/+/, '').replace(/^\.\//, '');
  const segs = clean.split('/').filter(s => s && s !== '.' && s !== '..');
  if (!segs.length) return {key: ':memory:', inMemory: true};
  return {key: segs.join('/'), inMemory: false};
}

function safeDbFilename(key) {
  const cleaned = key.replace(/[^a-zA-Z0-9._-]/g, '_');
  if (!cleaned || cleaned === '.' || cleaned === '..' || cleaned.includes('..')) {
    throw new Error('Invalid database name');
  }
  return cleaned;
}

function classifySqlError(err) {
  const msg = String(err?.message ?? err ?? 'SQL error');
  const lower = msg.toLowerCase();
  const unique = lower.includes('unique constraint failed') || lower.includes('primary key constraint failed');
  const constraint =
    unique ||
    lower.includes('not null constraint failed') ||
    lower.includes('foreign key constraint failed') ||
    lower.includes('check constraint failed');
  const code = unique ? 2067 : constraint ? 19 : Number(err?.errcode) || 1;
  return {error: msg, code, unique};
}

function toSqlValue(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') return v;
  if (v instanceof Uint8Array) return v;
  if (typeof v === 'object' && typeof v.hex === 'string' && v.hex.length % 2 === 0 && /^[0-9a-fA-F]*$/.test(v.hex)) {
    return Buffer.from(v.hex, 'hex');
  }
  return JSON.stringify(v);
}

function fromSqlValue(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') {
    const n = Number(v);
    return Number.isSafeInteger(n) ? n : v.toString();
  }
  if (v instanceof Uint8Array) {
    if (v.byteLength > Math.floor(MAX_SQL_RESULT_BYTES / 2)) {
      throw new Error(`SQL blob value exceeded result byte limit (${MAX_SQL_RESULT_BYTES})`);
    }
    return {hex: Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('hex')};
  }
  return v;
}

function sanitizeIdent(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9_]+$/.test(name)) {
    throw new Error(`Invalid SQL identifier in seedJson: ${String(name)}`);
  }
  return `"${name}"`;
}

const MAX_SEED_TABLES = 64;
const MAX_SEED_COLUMNS = 128;
const MAX_SEED_ROWS = 50_000;

function applySeedJson(db, payload) {
  if (typeof payload === 'string' && Buffer.byteLength(payload, 'utf8') > MAX_SQL_RESULT_BYTES * 2) {
    throw new Error('seedJson payload exceeds size limit');
  }
  const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
  const tables = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed.tables && typeof parsed.tables === 'object' && !Array.isArray(parsed.tables) ? parsed.tables : parsed)
    : null;
  if (!tables) return {tablesCreated: 0, tablesSeeded: 0, rowsInserted: 0, statementsExecuted: 0};
  let tablesCreated = 0;
  let tablesSeeded = 0;
  let rowsInserted = 0;
  let statementsExecuted = 0;
  db.exec('BEGIN');
  try {
    for (const [tableName, rows] of Object.entries(tables)) {
      if (!Array.isArray(rows) || rows.length === 0) continue;
      if (tablesCreated >= MAX_SEED_TABLES) {
        throw new Error(`seedJson exceeds maximum table limit (${MAX_SEED_TABLES})`);
      }
      if (tableName.startsWith('_')) {
        throw new Error(`seedJson cannot create host-reserved table: ${tableName}`);
      }
      const quotedTable = sanitizeIdent(tableName);
      const colSet = new Set();
      for (const row of rows) {
        if (row && typeof row === 'object' && !Array.isArray(row)) {
          for (const k of Object.keys(row)) {
            if (!colSet.has(k)) {
              if (colSet.size >= MAX_SEED_COLUMNS) {
                throw new Error(`seedJson table "${tableName}" exceeds column limit (${MAX_SEED_COLUMNS})`);
              }
              colSet.add(k);
            }
          }
        }
      }
      const cols = [...colSet];
      if (!cols.length) continue;
      const defs = cols.map(c => `${sanitizeIdent(c)} TEXT`).join(', ');
      db.exec(`CREATE TABLE IF NOT EXISTS ${quotedTable} (${defs})`);
      tablesCreated++;
      statementsExecuted++;
      const placeholders = cols.map(() => '?').join(', ');
      const stmt = db.prepare(`INSERT OR IGNORE INTO ${quotedTable} (${cols.map(sanitizeIdent).join(', ')}) VALUES (${placeholders})`);
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue;
        if (rowsInserted >= MAX_SEED_ROWS) {
          throw new Error(`seedJson exceeds maximum row limit (${MAX_SEED_ROWS})`);
        }
        stmt.run(...cols.map(c => toSqlValue(row[c])));
        rowsInserted++;
        statementsExecuted++;
      }
      tablesSeeded++;
    }
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch {}
    throw err;
  }
  return {tablesCreated, tablesSeeded, rowsInserted, statementsExecuted};
}

function parseSqlParams(paramsJson) {
  if (!paramsJson || !String(paramsJson).trim()) return {kind: 'none'};
  const parsed = JSON.parse(String(paramsJson));
  if (Array.isArray(parsed)) {
    return {kind: 'array', values: parsed.map(toSqlValue)};
  }
  if (parsed && typeof parsed === 'object') {
    const out = Object.create(null);
    for (const [k, v] of Object.entries(parsed)) {
      const cleanKey = k.startsWith(':') || k.startsWith('$') || k.startsWith('@') ? k : ':' + k;
      out[cleanKey] = toSqlValue(v);
    }
    return {kind: 'object', values: out};
  }
  return {kind: 'none'};
}

function isMultiStatementOrControl(sql) {
  const trimmed = sql.trim();
  if (/^(?:BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE|PRAGMA|VACUUM)\b/i.test(trimmed)) return true;
  // Detect multiple statements separated by `;` outside string literals
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < trimmed.length - 1; i++) {
    const ch = trimmed[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === ';' && !inSingle && !inDouble && trimmed.slice(i + 1).trim() !== '') return true;
  }
  return false;
}

const MAX_SQL_RESULT_ROWS = 10_000;
const MAX_SQL_RESULT_BYTES = 8 * 1024 * 1024;
const CONTAINER_SQL_LIMITS = Object.freeze({...SQL_LIMITS, length: MAX_SQL_RESULT_BYTES});
const MAX_OVERLAY_BYTES = 16 * 1024 * 1024;
const MAX_CONTAINER_DATABASES = 8;
const MAX_OPEN_DB_HANDLES = 32;
const MAX_MEMORY_DB_HANDLES = 4;
const MAX_PYTHON_SQL_CACHE_BYTES = 8 * 1024 * 1024;
const SAFE_PRAGMA_NAMES = new Set([
  'table_info', 'table_xinfo', 'index_list', 'index_info', 'foreign_key_list',
  'foreign_keys', 'user_version', 'application_id', 'schema_version',
  'busy_timeout', 'encoding', 'integrity_check', 'quick_check',
  'page_count', 'page_size', 'freelist_count',
]);
const WRITABLE_SAFE_PRAGMAS = new Set(['foreign_keys', 'user_version', 'application_id']);

function isHostReservedTable(name) {
  return typeof name === 'string' && name.startsWith('_');
}

function containerSqlAuthorizer(action, a, b, database, state) {
  const C = SQLITE_CONST;
  if (state && state.inHostSavepoint && (action === C.SQLITE_TRANSACTION || action === C.SQLITE_SAVEPOINT)) {
    return C.SQLITE_DENY;
  }
  if (action === C.SQLITE_ATTACH || action === C.SQLITE_DETACH) return C.SQLITE_DENY;
  if (action === C.SQLITE_CREATE_VTABLE || action === C.SQLITE_DROP_VTABLE) return C.SQLITE_DENY;
  if (action === C.SQLITE_ALTER_TABLE) {
    return (a === 'main' || a === 'temp') && !isHostReservedTable(b) ? C.SQLITE_OK : C.SQLITE_DENY;
  }
  if (database && database !== 'main' && database !== 'temp') return C.SQLITE_DENY;
  switch (action) {
    case C.SQLITE_SELECT:
    case C.SQLITE_RECURSIVE:
    case C.SQLITE_TRANSACTION:
    case C.SQLITE_SAVEPOINT:
    case C.SQLITE_ANALYZE:
    case C.SQLITE_REINDEX:
      return C.SQLITE_OK;
    case C.SQLITE_PRAGMA: {
      const pName = typeof a === 'string' ? a.toLowerCase() : '';
      if (!SAFE_PRAGMA_NAMES.has(pName)) return C.SQLITE_DENY;
      if (b !== null && b !== undefined && !WRITABLE_SAFE_PRAGMAS.has(pName)) return C.SQLITE_DENY;
      return C.SQLITE_OK;
    }
    case C.SQLITE_FUNCTION: {
      const fnName = typeof b === 'string' ? b.toLowerCase() : '';
      if (fnName === 'load_extension' || fnName === 'fts3_tokenizer') return C.SQLITE_DENY;
      return C.SQLITE_OK;
    }
    case C.SQLITE_READ:
    case C.SQLITE_INSERT:
    case C.SQLITE_UPDATE:
    case C.SQLITE_DELETE:
    case C.SQLITE_CREATE_TABLE:
    case C.SQLITE_DROP_TABLE:
    case C.SQLITE_CREATE_TEMP_TABLE:
    case C.SQLITE_DROP_TEMP_TABLE:
    case C.SQLITE_CREATE_VIEW:
    case C.SQLITE_DROP_VIEW:
    case C.SQLITE_CREATE_TEMP_VIEW:
    case C.SQLITE_DROP_TEMP_VIEW:
      return !isHostReservedTable(a) ? C.SQLITE_OK : C.SQLITE_DENY;
    case C.SQLITE_CREATE_INDEX:
    case C.SQLITE_DROP_INDEX:
    case C.SQLITE_CREATE_TEMP_INDEX:
    case C.SQLITE_DROP_TEMP_INDEX:
    case C.SQLITE_CREATE_TRIGGER:
    case C.SQLITE_DROP_TRIGGER:
    case C.SQLITE_CREATE_TEMP_TRIGGER:
    case C.SQLITE_DROP_TEMP_TRIGGER:
      return !isHostReservedTable(a) && !isHostReservedTable(b) ? C.SQLITE_OK : C.SQLITE_DENY;
    default:
      return C.SQLITE_DENY;
  }
}

function isProtectedRustSourcePath(key, relEntry) {
  const norm = normalizeVfsKey(key).toLowerCase();
  if (!norm) return true;
  if (relEntry && norm === normalizeVfsKey(relEntry).toLowerCase()) return true;
  const base = norm.includes('/') ? norm.slice(norm.lastIndexOf('/') + 1) : norm;
  if (
    base === 'cargo.toml' ||
    base === 'cargo.lock' ||
    base === 'manifest.json' ||
    base === 'permission.json' ||
    base === '.htaccess' ||
    base === '.htpasswd' ||
    base === '.env' ||
    base.startsWith('.env.') ||
    base === 'seed.json'
  ) {
    return true;
  }
  return /\.(?:rs|ini|sql|db|db-wal|db-shm|db-journal|sqlite|sqlite-wal|sqlite-shm|sqlite-journal|sqlite3|sqlite3-wal|sqlite3-shm|sqlite3-journal|sh|bak)$/i.test(base);
}

function isProtectedPhpOverlayPath(key, backendEntry) {
  const norm = normalizeVfsKey(key).toLowerCase();
  if (!norm) return true;
  if (backendEntry && norm === normalizeVfsKey(backendEntry).toLowerCase()) return true;
  const base = norm.includes('/') ? norm.slice(norm.lastIndexOf('/') + 1) : norm;
  if (
    base === '.htaccess' ||
    base === '.htpasswd' ||
    base === '.env' ||
    base.startsWith('.env.') ||
    base === 'manifest.json' ||
    base === 'permission.json' ||
    base === 'seed.json'
  ) {
    return true;
  }
  return /\.(?:php|phtml|php5|php7|php8|pht|phps|inc|phar|tpl|sql|ini|db|db-wal|db-shm|db-journal|sqlite|sqlite-wal|sqlite-shm|sqlite-journal|sqlite3|sqlite3-wal|sqlite3-shm|sqlite3-journal)$/i.test(base);
}

function sanitizeOverlayObj(rawJson, isProtected) {
  const empty = {writes: Object.create(null), deleted: [], dirs: []};
  if (!rawJson || typeof rawJson !== 'string') return empty;
  try {
    const parsed = JSON.parse(rawJson);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return empty;
    const writes = Object.create(null);
    if (parsed.writes && typeof parsed.writes === 'object' && !Array.isArray(parsed.writes)) {
      for (const [k, v] of Object.entries(parsed.writes)) {
        if (typeof v !== 'string') continue;
        const norm = normalizeVfsKey(k);
        if (!norm || isProtected(norm)) continue;
        writes[norm] = v;
      }
    }
    const deletedSet = new Set();
    if (Array.isArray(parsed.deleted)) {
      for (const d of parsed.deleted) {
        if (typeof d !== 'string') continue;
        const norm = normalizeVfsKey(d);
        if (norm && !isProtected(norm)) deletedSet.add(norm);
      }
    }
    const dirsSet = new Set();
    if (Array.isArray(parsed.dirs)) {
      for (const d of parsed.dirs) {
        if (typeof d !== 'string') continue;
        const norm = normalizeVfsKey(d);
        if (norm && !isProtected(norm)) dirsSet.add(norm);
      }
    }
    return {writes, deleted: [...deletedSet], dirs: [...dirsSet]};
  } catch {
    return empty;
  }
}

function sanitizePhpOverlayJson(rawJson, backendEntry) {
  const obj = sanitizeOverlayObj(rawJson, k => isProtectedPhpOverlayPath(k, backendEntry));
  if (Object.keys(obj.writes).length === 0 && obj.deleted.length === 0 && obj.dirs.length === 0) return '';
  return JSON.stringify(obj);
}

function sanitizeRustOverlayJson(rawJson, relEntry) {
  const obj = sanitizeOverlayObj(rawJson, k => isProtectedRustSourcePath(k, relEntry));
  if (Object.keys(obj.writes).length === 0 && obj.deleted.length === 0 && obj.dirs.length === 0) return '';
  return JSON.stringify(obj);
}

const SLEEP_ARRAY = new Int32Array(new SharedArrayBuffer(4));

function withOverlayLock(lockPath, fn) {
  const deadline = Date.now() + 5000;
  let fd = -1;
  while (fd < 0) {
    try {
      fd = openSync(lockPath, 'wx', 0o600);
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const st = statSync(lockPath);
        if (Date.now() - st.mtimeMs > 30_000) {
          // Atomically rename stale lock before removing so concurrent waiters cannot unlink a newly acquired lock.
          const stalePath = `${lockPath}.stale.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
          try {
            renameSync(lockPath, stalePath);
            rmSync(stalePath, {force: true});
          } catch {}
          continue;
        }
      } catch {}
      if (Date.now() >= deadline) {
        throw new Error('Timed out acquiring overlay lock');
      }
      Atomics.wait(SLEEP_ARRAY, 0, 0, 10);
    }
  }
  try {
    return fn();
  } finally {
    try { closeSync(fd); } catch {}
    try { rmSync(lockPath, {force: true}); } catch {}
  }
}

function mergeAndPersistOverlay(overlayPath, initialJson, exportedJson, isProtected) {
  const nextSanitized = sanitizeOverlayObj(exportedJson, isProtected);
  const nextStr =
    Object.keys(nextSanitized.writes).length === 0 &&
    nextSanitized.deleted.length === 0 &&
    nextSanitized.dirs.length === 0
      ? ''
      : JSON.stringify(nextSanitized);
  if (nextStr === initialJson) return;
  const initObj = sanitizeOverlayObj(initialJson, isProtected);
  withOverlayLock(`${overlayPath}.lock`, () => {
    const rawCurrent =
      existsSync(overlayPath) && !lstatSync(overlayPath).isSymbolicLink()
        ? readFileSync(overlayPath, 'utf8')
        : '';
    const merged = sanitizeOverlayObj(rawCurrent, isProtected);
    const delSet = new Set(merged.deleted);
    const dirSet = new Set(merged.dirs);
    const initDel = new Set(initObj.deleted);
    const initDirs = new Set(initObj.dirs);
    const nextDel = new Set(nextSanitized.deleted);
    const nextDirs = new Set(nextSanitized.dirs);

    for (const [k, v] of Object.entries(nextSanitized.writes)) {
      if (initObj.writes[k] !== v) {
        merged.writes[k] = v;
        delSet.delete(k);
      }
    }
    for (const k of Object.keys(initObj.writes)) {
      if (!(k in nextSanitized.writes)) {
        delete merged.writes[k];
      }
    }
    for (const d of nextDel) {
      if (!initDel.has(d)) {
        delSet.add(d);
        delete merged.writes[d];
      }
    }
    for (const d of initDel) {
      if (!nextDel.has(d) && !(d in nextSanitized.writes)) {
        delSet.delete(d);
      }
    }
    for (const d of nextDirs) {
      if (!initDirs.has(d)) dirSet.add(d);
    }
    for (const d of initDirs) {
      if (!nextDirs.has(d)) dirSet.delete(d);
    }

    const finalObj = {writes: merged.writes, deleted: [...delSet], dirs: [...dirSet]};
    if (Object.keys(finalObj.writes).length === 0 && finalObj.deleted.length === 0 && finalObj.dirs.length === 0) {
      try { rmSync(overlayPath, {force: true}); } catch {}
      return;
    }
    const finalJson = JSON.stringify(finalObj);
    if (Buffer.byteLength(finalJson, 'utf8') <= MAX_OVERLAY_BYTES) {
      atomicWriteJson(overlayPath, finalJson);
    }
  });
}

function clampContainerStatus(raw) {
  return Number.isInteger(raw) && raw >= 200 && raw <= 599 ? raw : 500;
}

/**
 * Strip SQL comments (`-- ...` and `/* ... *\/`) outside quoted strings/identifiers,
 * and blank single-quoted string literal contents (`'...'` -> `''`) so strings cannot
 * mask comment tokens or trigger false positives while quoted identifiers stay intact.
 */
function stripSqlCommentsPreservingQuotes(sql) {
  const src = String(sql ?? '');
  let out = '';
  let i = 0;
  const len = src.length;
  while (i < len) {
    const ch = src[i];
    if (ch === "'") {
      out += "''";
      i++;
      while (i < len) {
        if (src[i] === "'") {
          if (i + 1 < len && src[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === '"' || ch === '`') {
      const q = ch;
      out += q;
      i++;
      while (i < len) {
        const c = src[i];
        out += c;
        i++;
        if (c === q) {
          if (i < len && src[i] === q) {
            out += q;
            i++;
            continue;
          }
          break;
        }
      }
      continue;
    }
    if (ch === '[') {
      out += '[';
      i++;
      while (i < len) {
        const c = src[i];
        out += c;
        i++;
        if (c === ']') break;
      }
      continue;
    }
    if (ch === '-' && i + 1 < len && src[i + 1] === '-') {
      out += ' ';
      i += 2;
      while (i < len && src[i] !== '\n' && src[i] !== '\r') i++;
      continue;
    }
    if (ch === '/' && i + 1 < len && src[i + 1] === '*') {
      out += ' ';
      i += 2;
      while (i + 1 < len && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i = i + 1 < len ? i + 2 : len;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function assertSafeSqlStatement(sql) {
  const stripped = stripSqlCommentsPreservingQuotes(sql);
  if (/\b(?:ATTACH|DETACH)\b/i.test(stripped)) {
    throw new Error('SQLite ATTACH/DETACH is not permitted in sandboxed container');
  }
  if (/\bload_extension\s*\(/i.test(stripped) || /\bfts3_tokenizer\s*\(/i.test(stripped)) {
    throw new Error('SQLite extension loading is not permitted in sandboxed container');
  }
  if (/\bRENAME\s+TO(?:\s+|(?=["'`[]))["'`[]?_/i.test(stripped)) {
    throw new Error('SQLite RENAME TO host-reserved namespace is not permitted in sandboxed container');
  }
  const pragmaRe = /\bPRAGMA\s+(?:["'`[]?[A-Za-z0-9_]+["'`\]]?\s*\.\s*)?["'`[]?([A-Za-z0-9_]+)["'`\]]?/gi;
  let m;
  while ((m = pragmaRe.exec(stripped)) !== null) {
    if (!SAFE_PRAGMA_NAMES.has(m[1].toLowerCase())) {
      throw new Error(`SQLite PRAGMA ${m[1]} is not permitted in sandboxed container`);
    }
  }
}

function assertNoSymlinkWithSidecars(filePath) {
  for (const target of [filePath, `${filePath}-wal`, `${filePath}-shm`, `${filePath}-journal`]) {
    try {
      const st = lstatSync(target);
      if (st.isSymbolicLink()) throw new Error('Database symlink refused');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
}

class NodeSqlManager {
  constructor({dbDir, databases, vfs, primaryDbFile = null}) {
    this.dbDir = dbDir;
    this.databases = Array.isArray(databases) ? databases : [];
    this.vfs = vfs;
    this.primaryDbFile = primaryDbFile;
    this.primaryKey = this.databases.length > 0
      ? normalizeDbKey(this.databases[0].file || `${this.databases[0].name}.db`).key
      : null;
    if (this.primaryKey === ':memory:') this.primaryKey = null;
    this.byKey = new Map();
    this.handles = new Map();
    this.memoryHandles = 0;
    this.nextId = 1;
    mkdirSync(dbDir, {recursive: true, mode: 0o700});
  }

  findConfigForKey(key) {
    const lower = key.toLowerCase();
    const base = lower.replace(/\.db$|\.sqlite3?$/i, '');
    return (
      this.databases.find(cfg => {
        const cfgFile = normalizeDbKey(cfg.file || '').key.toLowerCase();
        const cfgName = String(cfg.name || '').toLowerCase();
        const cfgFileBase = cfgFile.replace(/\.db$|\.sqlite3?$/i, '');
        return lower === cfgFile || lower === cfgName || base === cfgName || base === cfgFileBase;
      }) || (this.databases.length === 1 && !lower.includes('sim') ? this.databases[0] : undefined)
    );
  }

  resolveCanonicalKey(rawKey) {
    const {key, inMemory} = normalizeDbKey(rawKey);
    if (inMemory) return ':memory:';
    if (this.byKey.has(key)) return key;
    const cfg = this.findConfigForKey(key);
    if (cfg) {
      const cfgTarget = normalizeDbKey(cfg.file || `${cfg.name}.db`).key;
      if (cfgTarget !== ':memory:') return cfgTarget;
    }
    return key;
  }

  dbPathFor(key) {
    if (this.primaryDbFile && (!this.primaryKey || key === this.primaryKey)) {
      if (!this.primaryKey) this.primaryKey = key;
      assertNoSymlinkWithSidecars(this.primaryDbFile);
      return this.primaryDbFile;
    }
    const file = join(this.dbDir, safeDbFilename(key));
    if (!contained(realpathSync(this.dbDir), resolve(file))) {
      throw new Error('Database path escaped');
    }
    assertNoSymlinkWithSidecars(file);
    return file;
  }

  openConfigured(filePath) {
    const db = new DatabaseSync(filePath, {allowExtension: false, limits: CONTAINER_SQL_LIMITS});
    if (filePath === ':memory:') {
      db.exec('PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA max_page_count=8192;');
    } else {
      try { chmodSync(filePath, 0o600); } catch {}
      db.exec(
        'PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF; PRAGMA max_page_count=131072;'
      );
    }
    if (typeof db.setAuthorizer !== 'function') {
      try { db.close(); } catch {}
      throw new Error('Node sqlite setAuthorizer is required for sandboxed container SQL');
    }
    const authState = {inHostSavepoint: false};
    db.setAuthorizer((action, a, b, database) => containerSqlAuthorizer(action, a, b, database, authState));
    db.__softnAuthState = authState;
    return db;
  }

  countDbFiles() {
    let count = 0;
    try {
      for (const entry of readdirSync(this.dbDir, {withFileTypes: true})) {
        if (!entry.isFile()) continue;
        if (/(?:-wal|-shm|-journal|\.softn_seeded)$/i.test(entry.name)) continue;
        count++;
      }
    } catch {}
    return count;
  }

  isProtectedDbKey(key, filePath) {
    const safeName = (() => { try { return safeDbFilename(key); } catch { return ''; } })();
    const safeLower = safeName.toLowerCase();
    if (/(?:-wal|-shm|-journal|\.softn_seeded)$/i.test(key) || /(?:-wal|-shm|-journal|\.softn_seeded)$/i.test(safeName)) {
      return true;
    }
    const lower = key.toLowerCase();
    const resolvedTarget = filePath ? resolve(filePath).toLowerCase() : null;
    if (this.primaryKey) {
      if (lower === this.primaryKey.toLowerCase()) return true;
      try {
        if (safeLower && safeLower === safeDbFilename(this.primaryKey).toLowerCase()) return true;
      } catch {}
    }
    if (this.primaryDbFile && resolvedTarget && resolvedTarget === resolve(this.primaryDbFile).toLowerCase()) return true;
    for (const cfg of this.databases) {
      const cfgKey = normalizeDbKey(cfg.file || `${cfg.name}.db`).key;
      if (!cfgKey || cfgKey === ':memory:') continue;
      if (lower === cfgKey.toLowerCase()) return true;
      try {
        if (safeLower && safeLower === safeDbFilename(cfgKey).toLowerCase()) return true;
      } catch {}
      if (resolvedTarget) {
        try {
          if (resolvedTarget === resolve(this.dbPathFor(cfgKey)).toLowerCase()) return true;
        } catch {}
      }
    }
    return false;
  }

  preseedAll() {
    for (const cfg of this.databases) {
      const target = normalizeDbKey(cfg.file || `${cfg.name}.db`);
      if (target.inMemory) continue;
      const path = this.dbPathFor(target.key);
      const marker = path + '.softn_seeded';
      if (existsSync(marker)) continue;
      const existedBefore = existsSync(path);
      if (!existedBefore && typeof cfg.file === 'string') {
        const norm = normalizeVfsKey(cfg.file);
        const bundled = this.vfs.get(norm);
        if (bundled) {
          writeFileSync(path, bundled, {mode: 0o600});
        }
      }
      const db = this.openConfigured(path);
      try {
        // If a database file already existed (for example from a FormLogic backup restore)
        // and already contains user tables, do not re-run seed inserts over restored data.
        const existingTables = existedBefore
          ? db.prepare("SELECT count(*) AS cnt FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_%'").get()
          : {cnt: 0};
        const alreadyPopulated = Number(existingTables?.cnt || 0) > 0;
        if (!alreadyPopulated && typeof cfg.seedSql === 'string' && cfg.seedSql.trim()) {
          const norm = normalizeVfsKey(cfg.seedSql);
          const bundledSql = this.vfs.get(norm);
          const sqlText = bundledSql ? bundledSql.toString('utf8') : cfg.seedSql;
          if (sqlText.trim()) {
            assertSafeSqlStatement(sqlText);
            const strippedLower = stripSqlCommentsPreservingQuotes(sqlText).toLowerCase();
            const hasRename = /\brename\b/.test(strippedLower);
            const hasExplicitTx = /\b(?:begin|commit|rollback|savepoint|release|end)\b/.test(strippedLower);
            if (hasRename && hasExplicitTx) {
              throw new Error('Seed SQL cannot mix transaction/savepoint control with RENAME');
            }
            const reservedBefore = new Set(
              db
                .prepare("SELECT name FROM sqlite_master WHERE name LIKE '\\_%' ESCAPE '\\'")
                .all()
                .map(r => String(r.name))
            );
            const useSp = hasRename || !hasExplicitTx;
            if (useSp) db.exec('SAVEPOINT softn_seed_guard');
            try {
              if (useSp && db.__softnAuthState) db.__softnAuthState.inHostSavepoint = true;
              try {
                db.exec(sqlText);
              } finally {
                if (db.__softnAuthState) db.__softnAuthState.inHostSavepoint = false;
              }
              const reservedAfter = db
                .prepare("SELECT name FROM sqlite_master WHERE name LIKE '\\_%' ESCAPE '\\'")
                .all();
              for (const row of reservedAfter) {
                if (!reservedBefore.has(String(row.name))) {
                  throw new Error('Seed SQL cannot create or rename objects in host-reserved _ namespace');
                }
              }
              if (useSp) db.exec('RELEASE softn_seed_guard');
            } catch (seedErr) {
              if (useSp) {
                try { db.exec('ROLLBACK TO softn_seed_guard; RELEASE softn_seed_guard'); } catch {}
              }
              throw seedErr;
            }
          }
        }
        if (!alreadyPopulated && cfg.seedJson !== undefined && cfg.seedJson !== null) {
          let payload = cfg.seedJson;
          if (typeof payload === 'string') {
            const norm = normalizeVfsKey(payload);
            const bundledJson = this.vfs.get(norm);
            if (bundledJson) payload = bundledJson.toString('utf8');
          }
          if (typeof payload !== 'string' || payload.trim()) {
            applySeedJson(db, payload);
          }
        }
      } finally {
        db.close();
      }
      writeFileSync(marker, '1', {mode: 0o600});
    }
  }

  open(rawUrl) {
    try {
      if (this.handles.size >= MAX_OPEN_DB_HANDLES) {
        return {error: `open SQLite handle limit exceeded (max ${MAX_OPEN_DB_HANDLES})`, code: 18, unique: false};
      }
      const canonical = this.resolveCanonicalKey(rawUrl);
      if (canonical === ':memory:') {
        if (this.memoryHandles >= MAX_MEMORY_DB_HANDLES) {
          return {error: `in-memory SQLite handle limit exceeded (max ${MAX_MEMORY_DB_HANDLES})`, code: 18, unique: false};
        }
        const db = this.openConfigured(':memory:');
        const id = this.nextId++;
        this.handles.set(id, {key: ':memory:', db, ephemeral: true});
        this.memoryHandles++;
        return {id};
      }
      const safeName = safeDbFilename(canonical);
      if (/(?:-wal|-shm|-journal|\.softn_seeded)$/i.test(canonical) || /(?:-wal|-shm|-journal|\.softn_seeded)$/i.test(safeName)) {
        return {error: 'cannot open SQLite sidecar file directly', code: 1, unique: false};
      }
      let shared = this.byKey.get(canonical);
      if (!shared) {
        const filePath = this.dbPathFor(canonical);
        if (this.byKey.size >= MAX_CONTAINER_DATABASES || (!existsSync(filePath) && this.countDbFiles() >= MAX_CONTAINER_DATABASES)) {
          return {error: `database file limit exceeded (max ${MAX_CONTAINER_DATABASES})`, code: 18, unique: false};
        }
        shared = {key: canonical, db: this.openConfigured(filePath), ephemeral: false};
        this.byKey.set(canonical, shared);
      }
      const id = this.nextId++;
      this.handles.set(id, shared);
      return {id};
    } catch (err) {
      return classifySqlError(err);
    }
  }

  reservedObjects(db) {
    const names = new Set();
    try {
      for (const row of db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '\\_%' ESCAPE '\\'").all()) {
        names.add(`main:${String(row.name)}`);
      }
    } catch {}
    try {
      for (const row of db.prepare("SELECT name FROM sqlite_temp_master WHERE name LIKE '\\_%' ESCAPE '\\'").all()) {
        names.add(`temp:${String(row.name)}`);
      }
    } catch {}
    return names;
  }

  execute(handleId, sql, paramsJson) {
    const managed = this.handles.get(handleId);
    if (!managed) return {error: `invalid sqlite connection handle ${handleId}`, code: 21, unique: false};
    try {
      assertSafeSqlStatement(sql);
      const lower = String(sql ?? '').toLowerCase();
      const mayMutateSchema = lower.includes('alter') || lower.includes('create') || lower.includes('rename');
      const reservedBefore = mayMutateSchema ? this.reservedObjects(managed.db) : null;
      const params = parseSqlParams(paramsJson);
      const multi = params.kind === 'none' && isMultiStatementOrControl(sql);
      if (mayMutateSchema && multi && /\b(?:savepoint|release|commit|rollback|begin|end)\b/i.test(lower)) {
        return {error: 'Cannot mix transaction/savepoint control with multi-statement DDL', code: 23, unique: false};
      }
      const spName = mayMutateSchema ? `softn_ddl_${Math.random().toString(16).slice(2, 10)}` : null;
      let spOpen = false;
      if (spName) {
        try {
          managed.db.exec(`SAVEPOINT ${spName}`);
          spOpen = true;
        } catch {}
      }
      let out;
      try {
        if (spOpen && managed.db.__softnAuthState) managed.db.__softnAuthState.inHostSavepoint = true;
        try {
          if (multi) {
            managed.db.exec(sql);
            out = {rows_affected: 0, last_insert_rowid: 0};
          } else {
            const stmt = managed.db.prepare(sql);
            if (typeof stmt.setAllowBareNamedParameters === 'function') stmt.setAllowBareNamedParameters(true);
            const info =
              params.kind === 'array'
                ? stmt.run(...params.values)
                : params.kind === 'object'
                  ? stmt.run(params.values)
                  : stmt.run();
            out = {
              rows_affected: Number(info?.changes ?? 0),
              last_insert_rowid: Number(info?.lastInsertRowid ?? 0),
            };
          }
        } finally {
          if (managed.db.__softnAuthState) managed.db.__softnAuthState.inHostSavepoint = false;
        }
        if (reservedBefore) {
          for (const name of this.reservedObjects(managed.db)) {
            if (!reservedBefore.has(name)) {
              throw new Error('Creating or renaming a table into the host-reserved _ namespace is not permitted');
            }
          }
        }
        if (spOpen) managed.db.exec(`RELEASE ${spName}`);
        return out;
      } catch (innerErr) {
        if (spOpen) {
          try { managed.db.exec(`ROLLBACK TO ${spName}; RELEASE ${spName}`); } catch {}
        }
        throw innerErr;
      }
    } catch (err) {
      return classifySqlError(err);
    }
  }

  query(handleId, sql, paramsJson) {
    const managed = this.handles.get(handleId);
    if (!managed) return {error: `invalid sqlite connection handle ${handleId}`, code: 21, unique: false};
    try {
      assertSafeSqlStatement(sql);
      const params = parseSqlParams(paramsJson);
      const stmt = managed.db.prepare(sql);
      if (typeof stmt.readOnly === 'boolean' && !stmt.readOnly) {
        return {error: 'SQLite query() only permits read-only statements; use execute() for writes/DDL', code: 23, unique: false};
      }
      if (typeof stmt.setAllowBareNamedParameters === 'function') stmt.setAllowBareNamedParameters(true);
      if (typeof stmt.setReturnArrays === 'function') stmt.setReturnArrays(true);
      const colMeta = typeof stmt.columns === 'function' ? stmt.columns() : [];
      const columns = colMeta.map(c => String(c.name ?? c.column ?? ''));
      const iter =
        typeof stmt.iterate === 'function'
          ? (params.kind === 'array'
              ? stmt.iterate(...params.values)
              : params.kind === 'object'
                ? stmt.iterate(params.values)
                : stmt.iterate())
          : (params.kind === 'array'
              ? stmt.all(...params.values)
              : params.kind === 'object'
                ? stmt.all(params.values)
                : stmt.all());
      const rows = [];
      let approxBytes = 0;
      for (const row of iter) {
        if (rows.length >= MAX_SQL_RESULT_ROWS) {
          return {error: `SQL query exceeded row limit (${MAX_SQL_RESULT_ROWS})`, code: 18, unique: false};
        }
        const mapped = Array.isArray(row) ? row.map(fromSqlValue) : columns.map(col => fromSqlValue(row[col]));
        for (const v of mapped) {
          if (typeof v === 'string') approxBytes += v.length * 2;
          else if (v && typeof v === 'object' && typeof v.hex === 'string') approxBytes += v.hex.length + 16;
          else if (v && typeof v === 'object') approxBytes += 64;
          else approxBytes += 8;
        }
        if (approxBytes > MAX_SQL_RESULT_BYTES) {
          return {error: `SQL query exceeded result byte limit (${MAX_SQL_RESULT_BYTES})`, code: 18, unique: false};
        }
        rows.push(mapped);
      }
      return {columns, rows};
    } catch (err) {
      return classifySqlError(err);
    }
  }

  seedJson(handleId, payload) {
    const managed = this.handles.get(handleId);
    if (!managed) return {error: `invalid sqlite connection handle ${handleId}`, code: 21, unique: false};
    try {
      return applySeedJson(managed.db, payload);
    } catch (err) {
      return classifySqlError(err);
    }
  }

  copy(fromUrl, toUrl) {
    try {
      const fromKey = this.resolveCanonicalKey(fromUrl);
      const toNorm = normalizeDbKey(toUrl);
      if (fromKey === ':memory:' || toNorm.inMemory) return {error: 'cannot copy :memory: database', code: 1, unique: false};
      const srcPath = this.dbPathFor(fromKey);
      const dstPath = this.dbPathFor(toNorm.key);
      if (this.isProtectedDbKey(toNorm.key, dstPath)) {
        return {error: 'cannot overwrite primary or configured database', code: 1, unique: false};
      }
      if (
        (!this.byKey.has(toNorm.key) && this.byKey.size >= MAX_CONTAINER_DATABASES) ||
        (!existsSync(dstPath) && this.countDbFiles() >= MAX_CONTAINER_DATABASES)
      ) {
        return {error: `database file limit exceeded (max ${MAX_CONTAINER_DATABASES})`, code: 18, unique: false};
      }
      if (srcPath === dstPath) return {bytes: existsSync(srcPath) ? lstatSync(srcPath).size : 0};
      // Flush WAL journal on source DB before file copy so the destination sees all committed writes.
      try {
        const ckpt = new DatabaseSync(srcPath, {allowExtension: false, limits: CONTAINER_SQL_LIMITS});
        try {
          ckpt.exec('PRAGMA busy_timeout=3000; PRAGMA wal_checkpoint(TRUNCATE);');
        } finally {
          ckpt.close();
        }
      } catch {}
      const existing = this.byKey.get(toNorm.key);
      if (existing) {
        try { existing.db.close(); } catch {}
        this.byKey.delete(toNorm.key);
        for (const [hid, m] of this.handles.entries()) {
          if (m === existing) this.handles.delete(hid);
        }
      }
      copyFileSync(srcPath, dstPath);
      for (const suffix of ['-wal', '-shm', '-journal']) {
        try { rmSync(dstPath + suffix, {force: true}); } catch {}
      }
      try { chmodSync(dstPath, 0o600); } catch {}
      return {bytes: lstatSync(dstPath).size};
    } catch (err) {
      return classifySqlError(err);
    }
  }

  remove(rawUrl) {
    const {key, inMemory} = normalizeDbKey(rawUrl);
    if (inMemory) return {ok: true, removed: false};
    let file;
    try {
      file = this.dbPathFor(key);
    } catch (err) {
      return classifySqlError(err);
    }
    if (/(?:-wal|-shm|-journal|\.softn_seeded)$/i.test(key) || /(?:-wal|-shm|-journal|\.softn_seeded)$/i.test(safeDbFilename(key))) {
      return {ok: true, removed: true};
    }
    // Never delete the container's configured primary or declared database files (by key or canonical path).
    if (this.isProtectedDbKey(key, file)) {
      return {error: 'cannot remove primary or configured database', code: 1, unique: false};
    }
    const existing = this.byKey.get(key);
    if (existing) {
      try { existing.db.close(); } catch {}
      this.byKey.delete(key);
      for (const [hid, m] of this.handles.entries()) {
        if (m === existing) this.handles.delete(hid);
      }
    }
    let removed = false;
    try {
      if (existsSync(file)) {
        rmSync(file, {force: true});
        removed = true;
      }
    } catch {}
    for (const suffix of ['-wal', '-shm', '-journal']) {
      try { rmSync(file + suffix, {force: true}); } catch {}
    }
    return {ok: true, removed};
  }

  close(handleId) {
    const managed = this.handles.get(handleId);
    if (!managed) return {ok: true};
    this.handles.delete(handleId);
    if (managed.ephemeral) {
      this.memoryHandles = Math.max(0, this.memoryHandles - 1);
      try { managed.db.close(); } catch {}
    }
    return {ok: true};
  }

  createZippBridge() {
    return {
      call: (kindRaw, argsRaw) => {
        const kind = String(kindRaw ?? '');
        const args = Array.isArray(argsRaw) ? argsRaw : [];
        switch (kind) {
          case 'sql.open':
            return this.open(args[0] ?? ':memory:');
          case 'sql.execute':
            return this.execute(Number(args[0]), args[1] ?? '', args[2]);
          case 'sql.query':
            return this.query(Number(args[0]), args[1] ?? '', args[2]);
          case 'sql.seed_json':
            return this.seedJson(Number(args[0]), args[1] ?? '{}');
          case 'sql.copy':
            return this.copy(args[0] ?? '', args[1] ?? '');
          case 'sql.remove':
            return this.remove(args[0] ?? '');
          case 'sql.close':
            return this.close(Number(args[0]));
          default:
            return {error: `unknown sql operation: ${kind}`, code: 1, unique: false};
        }
      },
    };
  }

  dispose() {
    const closed = new Set();
    for (const m of this.byKey.values()) {
      if (!closed.has(m.db)) {
        closed.add(m.db);
        try { m.db.close(); } catch {}
      }
    }
    for (const m of this.handles.values()) {
      if (!closed.has(m.db)) {
        closed.add(m.db);
        try { m.db.close(); } catch {}
      }
    }
    this.byKey.clear();
    this.handles.clear();
    this.memoryHandles = 0;
  }
}

function loadBundleVfs(bundleDir) {
  const canonical = realpathSync(bundleDir);
  const vfs = new Map();
  let totalBytes = 0;

  function walk(dir) {
    for (const entry of readdirSync(dir, {withFileTypes: true})) {
      const full = join(dir, entry.name);
      const meta = lstatSync(full);
      if (meta.isSymbolicLink()) continue;
      if (meta.isDirectory()) {
        walk(full);
      } else if (meta.isFile()) {
        if (vfs.size >= MAX_VFS_FILES) throw new Error('Bundle exceeds max file limit');
        const key = normalizeVfsKey(relative(canonical, full));
        if (!key) continue;
        const bytes = readFileSync(full);
        totalBytes += bytes.byteLength;
        if (totalBytes > MAX_VFS_TOTAL_BYTES) throw new Error('Bundle exceeds max byte limit');
        vfs.set(key, bytes);
      }
    }
  }

  walk(canonical);
  return vfs;
}

/**
 * Load only specific normalized keys (entry + declared database seed files) from `bundleDir`
 * without walking up to 64 MiB of frontend assets for JS/TS/Python or `/api/meta` requests.
 */
function loadSelectedBundleVfs(bundleDir, rawKeys) {
  const canonical = realpathSync(bundleDir);
  const vfs = new Map();
  let totalBytes = 0;
  for (const raw of rawKeys) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const key = normalizeVfsKey(raw);
    if (!key || vfs.has(key)) continue;
    const full = resolve(canonical, key);
    if (!contained(canonical, full)) continue;
    try {
      // Reject any symlink along path segments inside the bundle.
      let cur = canonical;
      let symlinked = false;
      for (const seg of key.split('/')) {
        cur = join(cur, seg);
        if (lstatSync(cur).isSymbolicLink()) {
          symlinked = true;
          break;
        }
      }
      if (symlinked) continue;
      const meta = lstatSync(full);
      if (!meta.isFile()) continue;
      const bytes = readFileSync(full);
      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_VFS_TOTAL_BYTES) throw new Error('Bundle exceeds max byte limit');
      vfs.set(key, bytes);
    } catch (e) {
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') continue;
      throw e;
    }
  }
  return vfs;
}

function collectSeedKeys(backend, databases) {
  const keys = [];
  if (typeof backend?.entry === 'string') keys.push(backend.entry);
  for (const cfg of Array.isArray(databases) ? databases : []) {
    if (!cfg || typeof cfg !== 'object') continue;
    if (typeof cfg.file === 'string') keys.push(cfg.file);
    if (typeof cfg.seedSql === 'string') keys.push(cfg.seedSql);
    if (typeof cfg.seedJson === 'string') keys.push(cfg.seedJson);
  }
  return keys;
}

function vfsToZippObject(vfs, stripPrefix = '') {
  const out = Object.create(null);
  const prefix = stripPrefix ? normalizeVfsKey(stripPrefix) + '/' : '';
  for (const [k, bytes] of vfs.entries()) {
    if (/\.(?:db|db-wal|db-shm|db-journal|sqlite|sqlite3)$/i.test(k)) continue;
    const targetKey = prefix && k.startsWith(prefix) ? k.slice(prefix.length) : k;
    // Detect binary vs UTF-8 text cleanly
    let isBinary = false;
    const sample = Math.min(bytes.byteLength, 512);
    for (let i = 0; i < sample; i++) {
      if (bytes[i] === 0) {
        isBinary = true;
        break;
      }
    }
    out[targetKey] = isBinary ? {base64: bytes.toString('base64')} : bytes.toString('utf8');
  }
  return out;
}

function resolveContainerEngineDir(root) {
  const candidates = [
    // Shared runtime install (FormLogic's resources/softn-native/wasm/container/) first
    fileURLToPath(new URL('./wasm/container', import.meta.url)),
    root ? join(root, 'wasm/container') : '',
    process.env.SOFTN_CONTAINER_ENGINES_DIR || '',
    resolve(dirname(fileURLToPath(import.meta.url)), '../../../packages/@softn/container/dist/runtime/engines'),
  ].filter(Boolean);
  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }
  return null;
}

const loadedEngines = new Map();

async function loadZippSandboxEngine(runtime, root) {
  const rt = runtime.toLowerCase();
  if (rt === 'javascript' || rt === 'js' || rt === 'python' || rt === 'py') {
    if (!loadedEngines.has('core')) {
      const localGlue = fileURLToPath(new URL('./wasm/zipp_wasm.mjs', import.meta.url));
      const localWasm = fileURLToPath(new URL('./wasm/zipp_wasm_bg.wasm', import.meta.url));
      let glueFile = localGlue;
      let wasmFile = localWasm;
      if (!existsSync(glueFile) || !existsSync(wasmFile)) {
        const candidates = [
          root ? join(root, 'wasm') : '',
          process.env.SOFTN_CORE_WASM_DIR || '',
          resolve(dirname(fileURLToPath(import.meta.url)), '../../../packages/@softn/core/wasm-zipp'),
        ].filter(Boolean);
        for (const dir of candidates) {
          const g = existsSync(join(dir, 'zipp_wasm.mjs')) ? join(dir, 'zipp_wasm.mjs') : join(dir, 'zipp_wasm.js');
          const w = join(dir, 'zipp_wasm_bg.wasm');
          if (existsSync(g) && existsSync(w)) {
            glueFile = g;
            wasmFile = w;
            break;
          }
        }
      }
      if (!existsSync(glueFile) || !existsSync(wasmFile)) {
        throw new Error('Missing core ZIPP WASM engine files (zipp_wasm.mjs / zipp_wasm_bg.wasm)');
      }
      const coreZipp = await import(pathToFileURL(glueFile).href);
      coreZipp.initSync({module: readFileSync(wasmFile)});
      const profile = JSON.parse(coreZipp.zippProfile());
      if (!Array.isArray(profile.features) || !profile.features.includes('safe-sandbox')) {
        throw new Error('ZIPP sandbox profile missing');
      }
      loadedEngines.set('core', coreZipp);
    }
    return loadedEngines.get('core');
  }

  const engineBase =
    rt === 'php' ? 'zipp-php' : rt === 'typescript' || rt === 'ts' ? 'zipp-typescript' : rt === 'rust' ? 'zipp-rust' : null;
  if (!engineBase) throw new Error(`Unsupported container backend runtime: ${runtime}`);
  if (loadedEngines.has(engineBase)) return loadedEngines.get(engineBase);

  const dir = resolveContainerEngineDir(root);
  if (!dir) throw new Error(`ZIPP WASM engine directory for ${engineBase} is not installed`);
  const wasmFile = join(dir, `${engineBase}.wasm`);
  const glueFile = join(dir, `${engineBase}.glue.js`);
  if (!existsSync(wasmFile) || !existsSync(glueFile)) {
    throw new Error(`Missing ZIPP WASM engine files for ${engineBase}`);
  }
  const mod = await import(pathToFileURL(glueFile).href);
  mod.initSync({module: readFileSync(wasmFile)});
  const profile = JSON.parse(mod.zippProfile());
  if (!Array.isArray(profile.features) || !profile.features.includes('safe-sandbox')) {
    throw new Error(`ZIPP ${engineBase} engine does not report safe-sandbox profile`);
  }
  loadedEngines.set(engineBase, mod);
  return mod;
}

function parseCookieHeader(cookieStr) {
  const out = Object.create(null);
  if (!cookieStr) return out;
  for (const part of String(cookieStr).split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k && k !== '__proto__' && k !== 'constructor' && k !== 'prototype') out[k] = v;
  }
  return out;
}

function parseUrlEncoded(bodyText) {
  const out = Object.create(null);
  if (!bodyText) return out;
  for (const [k, v] of new URLSearchParams(bodyText).entries()) {
    if (k && k !== '__proto__' && k !== 'constructor' && k !== 'prototype') out[k] = v;
  }
  return out;
}

function atomicWriteJson(filePath, content) {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, content, {mode: 0o600});
  renameSync(tmp, filePath);
}

function checkContainerRateLimit({data, manifest, request, markLimited}) {
  const declaredLimit = manifest.config?.server?.requestsPerMinute;
  const perMinute = Number.isInteger(declaredLimit) && declaredLimit >= 0 ? declaredLimit : 120;
  if (perMinute === 0) return false;
  const rateFile = join(data, 'container-rate.sqlite');
  assertNoSymlinkWithSidecars(rateFile);
  const db = new DatabaseSync(rateFile, {allowExtension: false, limits: SQL_LIMITS});
  try {
    try { chmodSync(rateFile, 0o600); } catch {}
    db.exec('PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; PRAGMA trusted_schema=OFF; PRAGMA max_page_count=4096;');
    db.exec('CREATE TABLE IF NOT EXISTS _request_limits(ip TEXT PRIMARY KEY, minute INTEGER NOT NULL, count INTEGER NOT NULL) STRICT');
    const rateKey = typeof request.rate_key === 'string' && request.rate_key ? request.rate_key : request.client_ip || '0.0.0.0';
    const minute = Math.floor(Date.now() / 60000);
    const ip = createHash('sha256').update(rateKey).digest('hex');
    db.exec('BEGIN IMMEDIATE');
    let row;
    try {
      db.prepare('DELETE FROM _request_limits WHERE minute < ?').run(minute - 1);
      db.prepare(
        'INSERT INTO _request_limits VALUES(?,?,1) ON CONFLICT(ip) DO UPDATE SET count=CASE WHEN minute=excluded.minute THEN count+1 ELSE 1 END,minute=excluded.minute'
      ).run(ip, minute);
      row = db.prepare('SELECT count FROM _request_limits WHERE ip=?').get(ip);
      db.exec('COMMIT');
    } catch (txErr) {
      try { db.exec('ROLLBACK'); } catch {}
      throw txErr;
    }
    if (row && Number(row.count) > perMinute) {
      markLimited?.(minute, ip);
      return true;
    }
    return false;
  } finally {
    db.close();
  }
}

function isPrivatePhpDir(rel, backend) {
  const lower = rel.toLowerCase();
  if (
    /^(?:server|backend|private|db|database|migrations)\//.test(lower) ||
    /(?:^|\/)\./.test(lower)
  ) {
    return true;
  }
  const root = typeof backend?.root === 'string' ? normalizeVfsKey(backend.root).toLowerCase() : '';
  if (root && (lower === root || lower.startsWith(`${root}/`))) return true;
  return false;
}

function htaccessGlobToRegExp(glob) {
  const escaped = String(glob).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

function isDeniedByHtaccess(vfs, targetPath) {
  const rel = normalizeVfsKey(targetPath);
  if (!rel) return false;
  const segs = rel.split('/');
  const base = segs[segs.length - 1] || '';
  const dirs = [''];
  for (let i = 0; i < segs.length - 1; i++) {
    dirs.push(segs.slice(0, i + 1).join('/'));
  }
  for (const dir of dirs) {
    const key = dir ? `${dir}/.htaccess` : '.htaccess';
    const rawBuf = vfs.get(key);
    if (!rawBuf) continue;
    const text = rawBuf.toString('utf8');
    if (text.length > 64 * 1024) continue;
    const lines = text.split(/\r?\n/);
    let blockMatchers = null;
    let blockDenied = false;
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const openMatch = /^<(FilesMatch|Files)\s+["']?([^"'>]+)["']?\s*>$/i.exec(line);
      if (openMatch) {
        const tag = openMatch[1].toLowerCase();
        const pat = openMatch[2].trim();
        blockDenied = false;
        blockMatchers = null;
        if (pat.length <= 256) {
          if (tag === 'files') {
            blockMatchers = htaccessGlobToRegExp(pat);
          } else if (!/\((?:[^()\\]*[*+?{][^()\\]*)\)[*+?{]/.test(pat)) {
            try {
              blockMatchers = new RegExp(pat, 'i');
            } catch {}
          }
        }
        continue;
      }
      if (/^<\/(?:FilesMatch|Files)\s*>$/i.test(line)) {
        if (blockDenied && blockMatchers && blockMatchers.test(base)) {
          return true;
        }
        blockMatchers = null;
        blockDenied = false;
        continue;
      }
      if (blockMatchers && /^(?:Require\s+all\s+denied|Deny\s+from\s+all)\b/i.test(line)) {
        blockDenied = true;
      }
    }
  }
  return false;
}

function parseServerHostName(host) {
  const h = String(host || 'localhost').trim();
  if (!h) return 'localhost';
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return end > 0 ? h.slice(0, end + 1) : 'localhost';
  }
  const idx = h.indexOf(':');
  return (idx >= 0 ? h.slice(0, idx) : h) || 'localhost';
}

function resolvePhpScript(vfs, backend, targetPath) {
  const rel = normalizeVfsKey(targetPath);
  const entry = normalizeVfsKey(backend.entry);
  if (rel && vfs.has(rel)) {
    if (/\.(?:php|phtml)$/i.test(rel) && !isPrivatePhpDir(rel, backend)) {
      return rel;
    }
  }
  if (rel && vfs.has(`${rel}.php`) && !isPrivatePhpDir(`${rel}.php`, backend)) {
    return `${rel}.php`;
  }
  if (vfs.has(entry)) return entry;
  return null;
}

export async function handleContainerRequest({root, bundle, data, manifest, config, request, hostContext = null, markLimited}) {
  const backend = manifest.backend;
  const runtime = String(backend.runtime).toLowerCase();

  // When hosted inside FormLogic (`containerPrimaryDatabase: 'application.sqlite'`),
  // store the container's primary SQLite database at `private/data/application.sqlite`
  // so FormLogic's Data manager and backup/restore work natively on the app's tables.
  const primaryDbFile =
    config.containerPrimaryDatabase === 'application.sqlite'
      ? join(data, 'application.sqlite')
      : null;

  if (checkContainerRateLimit({data, manifest, request, markLimited})) {
    return {
      status: 429,
      headers: [['Content-Type', 'application/json; charset=utf-8']],
      bodyBase64: Buffer.from(JSON.stringify({error: 'Too many requests.', code: 'rate_limited'})).toString('base64'),
    };
  }

  // /api/meta answers host diagnostics directly for setup.php and health checks,
  // validating the container backend entry and seeding declared SQLite databases.
  if (request.path === '/api/meta' && request.method === 'GET') {
    const vfs = loadSelectedBundleVfs(bundle, collectSeedKeys(backend, manifest.databases));
    const entryKey = normalizeVfsKey(backend.entry);
    if (!vfs.has(entryKey)) {
      throw new Error(`Container backend entry not found: ${backend.entry}`);
    }
    const sqlManager = new NodeSqlManager({
      dbDir: join(data, 'databases'),
      databases: manifest.databases || [],
      vfs,
      primaryDbFile,
    });
    try {
      sqlManager.preseedAll();
    } finally {
      sqlManager.dispose();
    }
    return {
      isMeta: true,
      status: 200,
      body: {
        development: config.development === true,
        version: String(manifest.version || '0.0.0'),
        runtime: 'zipp-wasm-container',
        backendRuntime: runtime,
        appId: manifest.id || config.appId || 'softn-app',
      },
    };
  }

  const needsFullVfs = runtime === 'php' || runtime === 'rust';
  const vfs = needsFullVfs
    ? loadBundleVfs(bundle)
    : loadSelectedBundleVfs(bundle, collectSeedKeys(backend, manifest.databases));
  const entryKey = normalizeVfsKey(backend.entry);
  if (!vfs.has(entryKey)) {
    throw new Error(`Container backend entry not found: ${backend.entry}`);
  }

  const sqlManager = new NodeSqlManager({
    dbDir: join(data, 'databases'),
    databases: manifest.databases || [],
    vfs,
    primaryDbFile,
  });

  try {
    sqlManager.preseedAll();
    const sqlBridge = sqlManager.createZippBridge();
    const engineMod = await loadZippSandboxEngine(runtime, root);

    const method = String(request.method || 'GET').toUpperCase();
    const path = String(request.path || '/');
    const queryString =
      typeof request.queryString === 'string'
        ? request.queryString
        : typeof request.query === 'string'
          ? request.query.replace(/^\?/, '')
          : request.query && typeof request.query === 'object'
            ? new URLSearchParams(Object.entries(request.query).map(([k, v]) => [k, String(v ?? '')])).toString()
            : '';
    const rawHeaders = request.headers;
    const headers = Object.create(null);
    const headerEntries = Array.isArray(rawHeaders)
      ? rawHeaders.filter(pair => Array.isArray(pair) && pair.length >= 2)
      : rawHeaders && typeof rawHeaders === 'object'
        ? Object.entries(rawHeaders)
        : [];
    for (const [k, v] of headerEntries) {
      const lower = String(k).toLowerCase();
      // Reject non-token header names (including underscores, which CGI/PHP collapse to `_`
      // just like hyphens, allowing `x_formlogic_user_id` to spoof `HTTP_X_FORMLOGIC_USER_ID`).
      if (!/^[a-z0-9-]+$/.test(lower)) continue;
      if (lower.startsWith('x-formlogic-') || lower === 'x-formlogic') continue;
      if (typeof v === 'string') headers[lower] = v;
    }
    const verifiedContext = hostContext && typeof hostContext === 'object' && !Array.isArray(hostContext) ? hostContext : null;
    const hostEnv = {};
    if (Array.isArray(manifest.databases) && manifest.databases.length > 0 && manifest.databases[0]?.file) {
      hostEnv.SOFTN_DB_PATH = String(manifest.databases[0].file);
    }
    if (verifiedContext) {
      const serialized = JSON.stringify(verifiedContext);
      headers['x-formlogic-context'] = serialized;
      hostEnv.FORMLOGIC_CONTEXT = serialized;
      hostEnv.SOFTN_HOST_CONTEXT = serialized;
      if (verifiedContext.userId !== undefined && verifiedContext.userId !== null) {
        headers['x-formlogic-user-id'] = String(verifiedContext.userId);
        hostEnv.FORMLOGIC_USER_ID = String(verifiedContext.userId);
      }
      if (verifiedContext.roleId !== undefined && verifiedContext.roleId !== null) {
        headers['x-formlogic-role-id'] = String(verifiedContext.roleId);
        hostEnv.FORMLOGIC_ROLE_ID = String(verifiedContext.roleId);
      }
      if (verifiedContext.userRole !== undefined && verifiedContext.userRole !== null) {
        headers['x-formlogic-user-role'] = String(verifiedContext.userRole);
        hostEnv.FORMLOGIC_USER_ROLE = String(verifiedContext.userRole);
      }
      if (typeof verifiedContext.authenticated === 'boolean') {
        headers['x-formlogic-authenticated'] = verifiedContext.authenticated ? '1' : '0';
        hostEnv.FORMLOGIC_AUTHENTICATED = verifiedContext.authenticated ? '1' : '0';
      }
      if (typeof verifiedContext.appId === 'string' && verifiedContext.appId) {
        headers['x-formlogic-app-id'] = verifiedContext.appId;
        hostEnv.FORMLOGIC_APP_ID = verifiedContext.appId;
      }
    }
    const bodyBytes =
      typeof request.bodyBase64 === 'string' && request.bodyBase64 !== ''
        ? Buffer.from(request.bodyBase64, 'base64')
        : request.body && typeof request.body === 'object' && Object.keys(request.body).length > 0
          ? Buffer.from(JSON.stringify(request.body), 'utf8')
          : Buffer.alloc(0);
    const bodyText = bodyBytes.toString('utf8');

    if (runtime === 'php') {
      if (isDeniedByHtaccess(vfs, path)) {
        return {
          status: 403,
          headers: [['Content-Type', 'application/json; charset=utf-8']],
          bodyBase64: Buffer.from(JSON.stringify({error: 'Forbidden.', code: 'forbidden'})).toString('base64'),
        };
      }
      const scriptToRun = resolvePhpScript(vfs, backend, path);
      if (!scriptToRun) {
        return {
          status: 404,
          headers: [['Content-Type', 'application/json; charset=utf-8']],
          bodyBase64: Buffer.from(JSON.stringify({error: 'Endpoint not found.', code: 'not_found'})).toString('base64'),
        };
      }
      const vfsObj = vfsToZippObject(vfs);
      const overlayPath = join(data, 'php-overlay.json');
      const rawInitialOverlay = existsSync(overlayPath) && !lstatSync(overlayPath).isSymbolicLink() ? readFileSync(overlayPath, 'utf8') : '';
      const initialOverlay = sanitizePhpOverlayJson(rawInitialOverlay, entryKey);

      const contentType = headers['content-type'] || '';
      const host = String(request.host || headers['host'] || 'localhost');
      const https = request.https === true;
      const originalUri = queryString ? `${path}?${queryString}` : path;
      const server = {
        REQUEST_METHOD: method,
        REQUEST_URI: originalUri,
        QUERY_STRING: queryString,
        SCRIPT_NAME: `/${scriptToRun}`,
        PHP_SELF: `/${scriptToRun}`,
        SCRIPT_FILENAME: `/${scriptToRun}`,
        DOCUMENT_ROOT: '/',
        SERVER_PROTOCOL: 'HTTP/1.1',
        SERVER_NAME: parseServerHostName(host),
        HTTP_HOST: host,
        SERVER_PORT: https ? '443' : '80',
        HTTPS: https ? 'on' : '',
        REQUEST_SCHEME: https ? 'https' : 'http',
        REMOTE_ADDR: String(request.client_ip || '127.0.0.1'),
        CONTENT_TYPE: contentType,
        CONTENT_LENGTH: String(bodyBytes.byteLength),
      };
      for (const [k, v] of Object.entries(headers)) {
        if (k === 'host') continue;
        server[`HTTP_${k.toUpperCase().replace(/-/g, '_')}`] = v;
      }
      const sapiReqJson = JSON.stringify({
        sapi: 'zipp-server',
        server,
        query: queryString,
        cookies: parseCookieHeader(headers['cookie'] || ''),
        contentType,
        body: bodyText,
        post: contentType.toLowerCase().includes('application/x-www-form-urlencoded') ? parseUrlEncoded(bodyText) : undefined,
      });

      if (!engineMod.PhpApp) throw new Error('Loaded ZIPP PHP engine does not export PhpApp');
      const app = new engineMod.PhpApp();
      try {
        app.setInstructionBudget(INSTRUCTION_BUDGET);
        app.setSyncHostCapabilities([...ZIPP_SQL_CAPABILITIES]);
        app.addAppBridge('sql', sqlBridge);
        const mergedPhpEnv = {...(backend.env && typeof backend.env === 'object' ? backend.env : {}), ...hostEnv};
        if (Object.keys(mergedPhpEnv).length > 0) app.setEnv(mergedPhpEnv);
        app.mountFiles(vfsObj);
        if (initialOverlay) {
          try { app.importOverlayJson(initialOverlay); } catch {}
        }
        const raw = app.handleRequest(scriptToRun, sapiReqJson);
        const meta = JSON.parse(raw.metaJson || '{}');
        const outHeaders = Array.isArray(meta.headers) ? meta.headers : [['Content-Type', 'text/html; charset=UTF-8']];
        const status = clampContainerStatus(meta.status);
        const bodyBase64 =
          method === 'HEAD' || status === 204 || status === 304
            ? ''
            : raw.bodyBase64 || Buffer.from(String(meta.body ?? ''), 'utf8').toString('base64');
        if (status < 500) {
          try {
            mergeAndPersistOverlay(overlayPath, initialOverlay, app.exportOverlayJson(), k => isProtectedPhpOverlayPath(k, entryKey));
          } catch {}
        }
        return {
          status,
          headers: outHeaders,
          bodyBase64,
        };
      } finally {
        try { app.free?.(); } catch {}
      }
    }

    if (runtime === 'javascript' || runtime === 'js' || runtime === 'typescript' || runtime === 'ts') {
      const lang = runtime === 'typescript' || runtime === 'ts' ? 'typescript' : 'javascript';
      const source = vfs.get(entryKey).toString('utf8');
      const engine = new engineMod.Engine();
      try {
        engine.setInstructionBudget(INSTRUCTION_BUDGET);
        engine.setSyncHostCapabilities([...ZIPP_SQL_CAPABILITIES]);
        if (typeof engine.addAppBridge === 'function') engine.addAppBridge('sql', sqlBridge);
        else engine.setAppBridge(sqlBridge);
        engine.initSource(`${JS_BACKEND_PRELUDE}\n${source}`, lang);
        const rawResp = engine.callFunction('__softnBackendDispatch', [
          JSON.stringify({method, path, query: queryString, headers, body: bodyText, ...(verifiedContext ? {context: verifiedContext} : {})}),
        ]);
        const parsed = JSON.parse(String(rawResp || '{}'));
        const status = clampContainerStatus(parsed.status);
        return {
          status,
          headers: Array.isArray(parsed.headers) ? parsed.headers : [['Content-Type', 'application/json; charset=utf-8']],
          bodyBase64: method === 'HEAD' || status === 204 || status === 304 ? '' : Buffer.from(String(parsed.body ?? ''), 'utf8').toString('base64'),
        };
      } finally {
        try { engine.free?.(); } catch {}
      }
    }

    if (runtime === 'python' || runtime === 'py') {
      const source = vfs.get(entryKey).toString('utf8');
      const engine = new engineMod.Engine();
      try {
        engine.setInstructionBudget(INSTRUCTION_BUDGET);
        engine.setSyncHostCapabilities([...ZIPP_SQL_CAPABILITIES]);
        if (typeof engine.addAppBridge === 'function') engine.addAppBridge('sql', sqlBridge);
        else engine.setAppBridge(sqlBridge);
        engine.initSource(`${PYTHON_BACKEND_PRELUDE}\n${source}`, 'python');
        const dispatch = engine.pythonCall || engine.callFunction;
        const reqPayload = JSON.stringify({method, path, query: queryString, headers, body: bodyText, ...(verifiedContext ? {context: verifiedContext} : {})});
        const sqlCacheParts = [];
        let sqlCacheBytes = 2;
        let parsed = {};
        for (let step = 0; step <= 512; step++) {
          const cacheJson = `[${sqlCacheParts.join(',')}]`;
          if (sqlCacheBytes > MAX_PYTHON_SQL_CACHE_BYTES) {
            throw new Error('Python backend exceeded SQL cache memory limit');
          }
          const rawResp = dispatch.call(engine, '__softn_backend_dispatch', [
            reqPayload,
            cacheJson,
          ]);
          parsed = JSON.parse(String(rawResp || '{}'));
          if (Array.isArray(parsed.__softn_sql_need)) {
            if (step >= 512) throw new Error('Python backend exceeded maximum SQL operations per request');
            const [op, a, b, c] = parsed.__softn_sql_need;
            try {
              const rawSql = sqlBridge.call(`sql.${op}`, [a ?? '', b ?? '', c ?? '']);
              const val = typeof rawSql === 'string' ? (rawSql ? JSON.parse(rawSql) : null) : (rawSql ?? null);
              const serializedEntry = JSON.stringify(val, (_k, v) => (typeof v === 'bigint' ? Number(v) : v)) || 'null';
              const entrySize = Buffer.byteLength(serializedEntry, 'utf8');
              sqlCacheBytes += entrySize + (sqlCacheParts.length > 0 ? 1 : 0);
              if (sqlCacheBytes > MAX_PYTHON_SQL_CACHE_BYTES) {
                throw new Error('Python backend exceeded SQL cache memory limit');
              }
              sqlCacheParts.push(serializedEntry);
            } catch (sqlErr) {
              if (sqlErr instanceof Error && sqlErr.message.includes('SQL cache memory limit')) throw sqlErr;
              const errEntry = JSON.stringify({__sql_err: sqlErr instanceof Error ? sqlErr.message : String(sqlErr)});
              sqlCacheBytes += Buffer.byteLength(errEntry, 'utf8') + (sqlCacheParts.length > 0 ? 1 : 0);
              if (sqlCacheBytes > MAX_PYTHON_SQL_CACHE_BYTES) {
                throw new Error('Python backend exceeded SQL cache memory limit');
              }
              sqlCacheParts.push(errEntry);
            }
            continue;
          }
          break;
        }
        const status = clampContainerStatus(parsed.status);
        return {
          status,
          headers: Array.isArray(parsed.headers) ? parsed.headers : [['Content-Type', 'application/json; charset=utf-8']],
          bodyBase64: method === 'HEAD' || status === 204 || status === 304 ? '' : Buffer.from(String(parsed.body ?? ''), 'utf8').toString('base64'),
        };
      } finally {
        try { engine.free?.(); } catch {}
      }
    }

    if (runtime === 'rust') {
      const rootPrefix = typeof backend.root === 'string' ? normalizeVfsKey(backend.root) : '';
      const vfsObj = vfsToZippObject(vfs, rootPrefix);
      const relEntry = rootPrefix && entryKey.startsWith(`${rootPrefix}/`) ? entryKey.slice(rootPrefix.length + 1) : entryKey;
      const overlayPath = join(data, 'rust-overlay.json');
      const rawInitialOverlay = existsSync(overlayPath) && !lstatSync(overlayPath).isSymbolicLink() ? readFileSync(overlayPath, 'utf8') : '';
      const initialOverlay = sanitizeRustOverlayJson(rawInitialOverlay, relEntry);
      if (initialOverlay) {
        try {
          const ov = JSON.parse(initialOverlay);
          if (Array.isArray(ov.deleted)) {
            for (const d of ov.deleted) {
              if (typeof d === 'string' && !isProtectedRustSourcePath(d, relEntry)) delete vfsObj[d];
            }
          }
          if (ov.writes && typeof ov.writes === 'object') {
            for (const [k, b64] of Object.entries(ov.writes)) {
              if (typeof b64 === 'string' && !isProtectedRustSourcePath(k, relEntry)) vfsObj[k] = {base64: b64};
            }
          }
        } catch {}
      }
      const engine = new engineMod.Engine();
      try {
        engine.setInstructionBudget(BOOT_INSTRUCTION_BUDGET);
        engine.setSyncHostCapabilities([...ZIPP_SQL_CAPABILITIES]);
        if (typeof engine.addAppBridge === 'function') engine.addAppBridge('sql', sqlBridge);
        else engine.setAppBridge(sqlBridge);
        engine.initRustProject(vfsObj, relEntry, {
          mode: 'worker_boot',
          writableVfs: true,
          env: {...(backend.env && typeof backend.env === 'object' ? backend.env : {}), ...hostEnv},
        });
        engine.setInstructionBudget(INSTRUCTION_BUDGET);
        const uri = queryString ? `${path}?${queryString}` : path;
        const rawResp = engine.rustDispatchRequest(JSON.stringify({method, uri, headers, body: bodyText}));
        const parsed = JSON.parse(String(rawResp || '{}'));
        const status = clampContainerStatus(parsed.status);
        if (status < 500) {
          try {
            if (typeof engine.exportRustOverlayJson === 'function') {
              mergeAndPersistOverlay(overlayPath, initialOverlay, engine.exportRustOverlayJson(), k => isProtectedRustSourcePath(k, relEntry));
            }
          } catch {}
        }
        return {
          status,
          headers: Array.isArray(parsed.headers) ? parsed.headers : [['Content-Type', 'application/json; charset=utf-8']],
          bodyBase64: method === 'HEAD' || status === 204 || status === 304 ? '' : Buffer.from(String(parsed.body ?? ''), 'utf8').toString('base64'),
        };
      } finally {
        try { engine.free?.(); } catch {}
      }
    }

    throw new Error(`Unsupported container backend runtime: ${runtime}`);
  } finally {
    sqlManager.dispose();
  }
}

export {PRIVATE_STATIC_BLOCK};
