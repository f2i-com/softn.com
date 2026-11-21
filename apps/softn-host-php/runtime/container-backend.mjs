/**
 * SoftN v2 Web Container multi-user backend runner for `apps/softn-host-php`.
 *
 * Executes embedded container backends (`php`, `javascript`, `typescript`, `python`, `rust`)
 * strictly inside ZIPP WebAssembly `safe-sandbox` engines — NEVER native OS PHP, Python,
 * or shell execution — backed by Node 24's built-in `node:sqlite` (`DatabaseSync`) in
 * multi-user WAL mode under `private/data/databases/`.
 */
import {DatabaseSync} from 'node:sqlite';
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  lstatSync,
  realpathSync,
  existsSync,
  mkdirSync,
  chmodSync,
  copyFileSync,
  rmSync,
  renameSync,
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
  /(?:^|\/)(?:\.htaccess|\.htpasswd|\.env(?:\.[^/]*)?|cargo\.toml|cargo\.lock|composer\.json|composer\.lock|manifest\.json|permission\.json)$|\.(?:php|phtml|inc|tpl|rs|db|db-wal|db-shm|db-journal|sqlite|sqlite3|sql|ini|bak|log|sh|logic)$/i;

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

function applySeedJson(db, payload) {
  const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
  const tables = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed.tables && typeof parsed.tables === 'object' && !Array.isArray(parsed.tables) ? parsed.tables : parsed)
    : null;
  if (!tables) return {tablesCreated: 0, tablesSeeded: 0, rowsInserted: 0, statementsExecuted: 0};
  let tablesCreated = 0;
  let tablesSeeded = 0;
  let rowsInserted = 0;
  let statementsExecuted = 0;
  for (const [tableName, rows] of Object.entries(tables)) {
    if (!Array.isArray(rows) || rows.length === 0) continue;
    const quotedTable = sanitizeIdent(tableName);
    const cols = [];
    for (const row of rows) {
      if (row && typeof row === 'object' && !Array.isArray(row)) {
        for (const k of Object.keys(row)) if (!cols.includes(k)) cols.push(k);
      }
    }
    if (!cols.length) continue;
    const defs = cols.map(c => `${sanitizeIdent(c)} TEXT`).join(', ');
    db.exec(`CREATE TABLE IF NOT EXISTS ${quotedTable} (${defs})`);
    tablesCreated++;
    statementsExecuted++;
    const placeholders = cols.map(() => '?').join(', ');
    const stmt = db.prepare(`INSERT OR IGNORE INTO ${quotedTable} (${cols.map(sanitizeIdent).join(', ')}) VALUES (${placeholders})`);
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      stmt.run(...cols.map(c => toSqlValue(row[c])));
      rowsInserted++;
      statementsExecuted++;
    }
    tablesSeeded++;
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
      try {
        const st = lstatSync(this.primaryDbFile);
        if (st.isSymbolicLink()) throw new Error('Database symlink refused');
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
      return this.primaryDbFile;
    }
    const file = join(this.dbDir, safeDbFilename(key));
    if (!contained(realpathSync(this.dbDir), resolve(file))) {
      throw new Error('Database path escaped');
    }
    try {
      const st = lstatSync(file);
      if (st.isSymbolicLink()) throw new Error('Database symlink refused');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    return file;
  }

  openConfigured(filePath) {
    const db = new DatabaseSync(filePath, {allowExtension: false, limits: SQL_LIMITS});
    if (filePath !== ':memory:') {
      try { chmodSync(filePath, 0o600); } catch {}
    }
    db.exec(
      'PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF; PRAGMA max_page_count=131072;'
    );
    return db;
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
          if (sqlText.trim()) db.exec(sqlText);
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
      const canonical = this.resolveCanonicalKey(rawUrl);
      if (canonical === ':memory:') {
        const db = this.openConfigured(':memory:');
        const id = this.nextId++;
        this.handles.set(id, {key: ':memory:', db, ephemeral: true});
        return {id};
      }
      let shared = this.byKey.get(canonical);
      if (!shared) {
        const filePath = this.dbPathFor(canonical);
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

  execute(handleId, sql, paramsJson) {
    const managed = this.handles.get(handleId);
    if (!managed) return {error: `invalid sqlite connection handle ${handleId}`, code: 21, unique: false};
    try {
      const params = parseSqlParams(paramsJson);
      if (params.kind === 'none' && isMultiStatementOrControl(sql)) {
        managed.db.exec(sql);
        return {rows_affected: 0, last_insert_rowid: 0};
      }
      const stmt = managed.db.prepare(sql);
      if (typeof stmt.setAllowBareNamedParameters === 'function') stmt.setAllowBareNamedParameters(true);
      const info =
        params.kind === 'array'
          ? stmt.run(...params.values)
          : params.kind === 'object'
            ? stmt.run(params.values)
            : stmt.run();
      return {
        rows_affected: Number(info?.changes ?? 0),
        last_insert_rowid: Number(info?.lastInsertRowid ?? 0),
      };
    } catch (err) {
      return classifySqlError(err);
    }
  }

  query(handleId, sql, paramsJson) {
    const managed = this.handles.get(handleId);
    if (!managed) return {error: `invalid sqlite connection handle ${handleId}`, code: 21, unique: false};
    try {
      const params = parseSqlParams(paramsJson);
      const stmt = managed.db.prepare(sql);
      if (typeof stmt.setAllowBareNamedParameters === 'function') stmt.setAllowBareNamedParameters(true);
      if (typeof stmt.setReturnArrays === 'function') stmt.setReturnArrays(true);
      const colMeta = typeof stmt.columns === 'function' ? stmt.columns() : [];
      const columns = colMeta.map(c => String(c.name ?? c.column ?? ''));
      const rawRows =
        params.kind === 'array'
          ? stmt.all(...params.values)
          : params.kind === 'object'
            ? stmt.all(params.values)
            : stmt.all();
      const rows = rawRows.map(row =>
        Array.isArray(row) ? row.map(fromSqlValue) : columns.map(col => fromSqlValue(row[col]))
      );
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
      if (srcPath === dstPath) return {bytes: existsSync(srcPath) ? lstatSync(srcPath).size : 0};
      const existing = this.byKey.get(toNorm.key);
      if (existing) {
        try { existing.db.close(); } catch {}
        this.byKey.delete(toNorm.key);
      }
      copyFileSync(srcPath, dstPath);
      try { chmodSync(dstPath, 0o600); } catch {}
      return {bytes: lstatSync(dstPath).size};
    } catch (err) {
      return classifySqlError(err);
    }
  }

  remove(rawUrl) {
    const {key, inMemory} = normalizeDbKey(rawUrl);
    if (inMemory) return {ok: true, removed: false};
    if (/(?:-wal|-shm|-journal)$/i.test(key)) return {ok: true, removed: true};
    const existing = this.byKey.get(key);
    if (existing) {
      try { existing.db.close(); } catch {}
      this.byKey.delete(key);
    }
    try {
      const file = this.dbPathFor(key);
      if (existsSync(file)) {
        rmSync(file, {force: true});
        return {ok: true, removed: true};
      }
    } catch {}
    return {ok: true, removed: false};
  }

  close(handleId) {
    const managed = this.handles.get(handleId);
    if (!managed) return {ok: true};
    this.handles.delete(handleId);
    if (managed.ephemeral) {
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
  const out = {};
  if (!cookieStr) return out;
  for (const part of String(cookieStr).split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

function parseUrlEncoded(bodyText) {
  const out = {};
  if (!bodyText) return out;
  for (const [k, v] of new URLSearchParams(bodyText).entries()) {
    out[k] = v;
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
  const db = new DatabaseSync(rateFile, {allowExtension: false, limits: SQL_LIMITS});
  try {
    try { chmodSync(rateFile, 0o600); } catch {}
    db.exec('PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL;');
    db.exec('CREATE TABLE IF NOT EXISTS _request_limits(ip TEXT PRIMARY KEY, minute INTEGER NOT NULL, count INTEGER NOT NULL) STRICT');
    const rateKey = typeof request.rate_key === 'string' && request.rate_key ? request.rate_key : request.client_ip || '0.0.0.0';
    const minute = Math.floor(Date.now() / 60000);
    const ip = createHash('sha256').update(rateKey).digest('hex');
    db.prepare('DELETE FROM _request_limits WHERE minute < ?').run(minute - 1);
    db.prepare(
      'INSERT INTO _request_limits VALUES(?,?,1) ON CONFLICT(ip) DO UPDATE SET count=CASE WHEN minute=excluded.minute THEN count+1 ELSE 1 END,minute=excluded.minute'
    ).run(ip, minute);
    const row = db.prepare('SELECT count FROM _request_limits WHERE ip=?').get(ip);
    if (row && Number(row.count) > perMinute) {
      markLimited?.(minute, ip);
      return true;
    }
    return false;
  } finally {
    db.close();
  }
}

function resolvePhpScript(vfs, backend, targetPath) {
  const rel = normalizeVfsKey(targetPath);
  const entry = normalizeVfsKey(backend.entry);
  if (rel && vfs.has(rel)) {
    if (/\.(?:php|phtml)$/i.test(rel) && !rel.startsWith('server/') && !rel.startsWith('backend/')) {
      return rel;
    }
  }
  if (rel && vfs.has(`${rel}.php`) && !rel.startsWith('server/') && !rel.startsWith('backend/')) {
    return `${rel}.php`;
  }
  if (vfs.has(entry)) return entry;
  return null;
}

export async function handleContainerRequest({root, bundle, data, manifest, config, request, hostContext = null, markLimited}) {
  const backend = manifest.backend;
  const runtime = String(backend.runtime).toLowerCase();

  // /api/meta answers host diagnostics directly for setup.php and health checks
  if (request.path === '/api/meta' && request.method === 'GET') {
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

  if (checkContainerRateLimit({data, manifest, request, markLimited})) {
    return {
      status: 429,
      headers: [['Content-Type', 'application/json; charset=utf-8']],
      bodyBase64: Buffer.from(JSON.stringify({error: 'Too many requests.', code: 'rate_limited'})).toString('base64'),
    };
  }

  const vfs = loadBundleVfs(bundle);
  const entryKey = normalizeVfsKey(backend.entry);
  if (!vfs.has(entryKey)) {
    throw new Error(`Container backend entry not found: ${backend.entry}`);
  }

  // When hosted inside FormLogic (`containerPrimaryDatabase: 'application.sqlite'`),
  // store the container's primary SQLite database at `private/data/application.sqlite`
  // so FormLogic's Data manager and backup/restore work natively on the app's tables.
  const primaryDbFile =
    config.containerPrimaryDatabase === 'application.sqlite'
      ? join(data, 'application.sqlite')
      : null;

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
        : request.query && typeof request.query === 'object'
          ? new URLSearchParams(Object.entries(request.query).map(([k, v]) => [k, String(v ?? '')])).toString()
          : '';
    const rawHeaders = request.headers && typeof request.headers === 'object' ? request.headers : {};
    const headers = {};
    for (const [k, v] of Object.entries(rawHeaders)) {
      const lower = k.toLowerCase();
      // Never allow untrusted client headers to spoof host identity headers.
      if (lower.startsWith('x-formlogic-')) continue;
      if (typeof v === 'string') headers[lower] = v;
    }
    const verifiedContext = hostContext && typeof hostContext === 'object' && !Array.isArray(hostContext) ? hostContext : null;
    const hostEnv = {};
    if (verifiedContext) {
      const serialized = JSON.stringify(verifiedContext);
      headers['x-formlogic-context'] = serialized;
      hostEnv.FORMLOGIC_CONTEXT = serialized;
      if (verifiedContext.userId !== undefined && verifiedContext.userId !== null) {
        headers['x-formlogic-user-id'] = String(verifiedContext.userId);
        hostEnv.FORMLOGIC_USER_ID = String(verifiedContext.userId);
      }
      if (verifiedContext.roleId !== undefined && verifiedContext.roleId !== null) {
        headers['x-formlogic-role-id'] = String(verifiedContext.roleId);
        hostEnv.FORMLOGIC_ROLE_ID = String(verifiedContext.roleId);
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
      const initialOverlay = existsSync(overlayPath) ? readFileSync(overlayPath, 'utf8') : '';

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
        SERVER_NAME: host.split(':')[0] || 'localhost',
        HTTP_HOST: host,
        SERVER_PORT: https ? '443' : '80',
        HTTPS: https ? 'on' : '',
        REQUEST_SCHEME: https ? 'https' : 'http',
        REMOTE_ADDR: String(request.client_ip || '127.0.0.1'),
        CONTENT_TYPE: contentType,
        CONTENT_LENGTH: String(bodyBytes.byteLength),
      };
      for (const [k, v] of Object.entries(headers)) {
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
        const bodyBase64 = raw.bodyBase64 || Buffer.from(String(meta.body ?? ''), 'utf8').toString('base64');
        try {
          const snap = app.exportOverlayJson();
          if (snap && snap !== initialOverlay && snap !== '{"writes":{},"deleted":[],"dirs":[]}') {
            atomicWriteJson(overlayPath, snap);
          }
        } catch {}
        return {
          status: Number.isInteger(meta.status) ? meta.status : 200,
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
        return {
          status: Number.isInteger(parsed.status) ? parsed.status : 200,
          headers: Array.isArray(parsed.headers) ? parsed.headers : [['Content-Type', 'application/json; charset=utf-8']],
          bodyBase64: Buffer.from(String(parsed.body ?? ''), 'utf8').toString('base64'),
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
        const rawResp = dispatch.call(engine, '__softn_backend_dispatch', [
          JSON.stringify({method, path, query: queryString, headers, body: bodyText, ...(verifiedContext ? {context: verifiedContext} : {})}),
        ]);
        const parsed = JSON.parse(String(rawResp || '{}'));
        return {
          status: Number.isInteger(parsed.status) ? parsed.status : 200,
          headers: Array.isArray(parsed.headers) ? parsed.headers : [['Content-Type', 'application/json; charset=utf-8']],
          bodyBase64: Buffer.from(String(parsed.body ?? ''), 'utf8').toString('base64'),
        };
      } finally {
        try { engine.free?.(); } catch {}
      }
    }

    if (runtime === 'rust') {
      const rootPrefix = typeof backend.root === 'string' ? normalizeVfsKey(backend.root) : '';
      const vfsObj = vfsToZippObject(vfs, rootPrefix);
      const overlayPath = join(data, 'rust-overlay.json');
      const initialOverlay = existsSync(overlayPath) ? readFileSync(overlayPath, 'utf8') : '';
      if (initialOverlay) {
        try {
          const ov = JSON.parse(initialOverlay);
          if (Array.isArray(ov.deleted)) for (const d of ov.deleted) delete vfsObj[d];
          if (ov.writes && typeof ov.writes === 'object') {
            for (const [k, b64] of Object.entries(ov.writes)) if (typeof b64 === 'string') vfsObj[k] = {base64: b64};
          }
        } catch {}
      }
      const relEntry = rootPrefix && entryKey.startsWith(`${rootPrefix}/`) ? entryKey.slice(rootPrefix.length + 1) : entryKey;
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
        try {
          if (typeof engine.exportRustOverlayJson === 'function') {
            const snap = engine.exportRustOverlayJson();
            if (snap && snap !== initialOverlay && snap !== '{"writes":{},"deleted":[],"dirs":[]}') {
              atomicWriteJson(overlayPath, snap);
            }
          }
        } catch {}
        return {
          status: Number.isInteger(parsed.status) ? parsed.status : 200,
          headers: Array.isArray(parsed.headers) ? parsed.headers : [['Content-Type', 'application/json; charset=utf-8']],
          bodyBase64: Buffer.from(String(parsed.body ?? ''), 'utf8').toString('base64'),
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
