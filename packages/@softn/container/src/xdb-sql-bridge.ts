/**
 * XDB SQLite WASM Engine Loader & ZIPP `app.sql.*` Bridge.
 *
 * Powers pure-safe-Rust SQLite 3 databases inside SoftN containers for:
 * - Rust backends (`sqlx::SqlitePool` via ZIPP `app.sql.*`)
 * - PHP backends (`PDO`, `SQLite3`, `mysqli` via ZIPP `app.sql.*`)
 * - JS/TS & Python backends and frontend `softn:sqlite`
 *
 * Features:
 * - Sandbox-confined database paths (no escape outside container storage)
 * - Automatic hydration from persisted IndexedDB bytes -> bundled `.db` (+ `-wal`) ->
 *   `seedSql` -> declarative `seedJson` (`WasmConnection.seed_json`)
 * - Shared live connection per logical `dbKey` so repeated opens (e.g. PHP shared-nothing
 *   requests or SQLx pools) see consistent committed state with zero re-parse overhead
 * - Unified instruction metering (`hostChargeSteps` from XDB `BudgetMeter` deltas)
 * - Dirty-tracking & SQLite `.db` binary export (`export_bytes()`) for IndexedDB persistence
 */

import type { DatabaseConfig, ZippEngineSource } from './types';

export interface XdbWasmConnection {
  execute_json(sql: string, params_json?: string | null): string;
  execute_xdb_json(sql: string, params_json?: string | null): string;
  seed_json(seed_json: string): string;
  export_bytes(): Uint8Array;
  page_size(): number;
  page_count(): number;
  in_transaction(): boolean;
  changes(): bigint | number;
  total_changes(): bigint | number;
  last_insert_rowid(): bigint | number;
  meter_usage_json(): string;
  close(): void;
  free(): void;
}

export interface LoadedXdbBindings {
  WasmConnection: new (
    initial_bytes?: Uint8Array | null,
    wal_bytes?: Uint8Array | null,
    journal_bytes?: Uint8Array | null,
    page_size?: number,
    max_steps?: bigint,
    max_memory_bytes?: bigint,
    max_page_reads?: bigint
  ) => XdbWasmConnection;
  module: WebAssembly.Module;
}

export interface XdbBudgetHooks {
  hostStepsRemaining?: () => number;
  hostChargeSteps?: (steps: number) => void;
}

export interface XdbSqlManagerOptions {
  bindings: LoadedXdbBindings;
  /** Declared databases from `manifest.json` or auto-discovered from the archive. */
  databases?: readonly DatabaseConfig[];
  /** Bundled archive text files (for `.sql` / `.json` seed files). */
  textFiles?: Readonly<Record<string, string>>;
  /** Bundled archive binary files (for `.db` / `.db-wal` / `.db-journal` images). */
  binaryFiles?: Readonly<Record<string, Uint8Array>>;
  /** Persisted database images previously saved to host IndexedDB, keyed by normalized `dbKey`. */
  initialPersistedDbs?: Readonly<Record<string, Uint8Array>>;
  /** Sandbox resource ceilings per connection (`0` = unlimited). */
  maxStepsPerConnection?: bigint;
  maxMemoryBytes?: bigint;
  maxPageReads?: bigint;
  /** Called whenever a database is modified and ready to persist. */
  onPersist?: (dbKey: string, bytes: Uint8Array) => void;
  /** Called whenever a sandboxed database is removed via `remove()`. */
  onRemove?: (dbKey: string) => void;
}

const XDB_ENCODER = new TextEncoder();
const XDB_DECODER = new TextDecoder();
const MAX_SQL_RESULT_JSON_CHARS = 16 * 1024 * 1024;
const MAX_SQL_RESULT_ROWS = 50_000;
const MAX_EPHEMERAL_DBS = 4;
const EPHEMERAL_MAX_MEMORY_BYTES = BigInt(32 * 1024 * 1024);
const DEFAULT_MAX_STEPS_PER_CONN = 2_000_000_000n;
const DEFAULT_MAX_PAGE_READS = 50_000_000n;
const EPHEMERAL_MAX_STEPS = 50_000_000n;
const EPHEMERAL_MAX_PAGE_READS = 500_000n;

const cachedXdbPromise: Map<string, Promise<LoadedXdbBindings>> = new Map();
const cachedXdbByModule = new WeakMap<WebAssembly.Module, Promise<LoadedXdbBindings>>();

function isNodeRuntime(): boolean {
  return typeof process !== 'undefined' && typeof process.versions?.node === 'string';
}

function isWasmMagic(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 4 && bytes[0] === 0x00 && bytes[1] === 0x61 && bytes[2] === 0x73 && bytes[3] === 0x6d;
}

async function resolveNodeContainerPkgRoot(): Promise<string | null> {
  const pathMod = await import('node:path');
  const fsMod = await import('node:fs');
  try {
    const moduleMod = await import('node:module');
    const req = moduleMod.createRequire(pathMod.join(process.cwd(), 'package.json'));
    return pathMod.dirname(req.resolve('@softn/container/package.json'));
  } catch {
    let dir = process.cwd();
    for (let i = 0; i < 6; i++) {
      const direct = pathMod.join(dir, 'packages', '@softn', 'container');
      if (fsMod.existsSync(pathMod.join(direct, 'package.json'))) return direct;
      if (fsMod.existsSync(pathMod.join(dir, 'package.json')) && pathMod.basename(dir) === 'container') return dir;
      const parent = pathMod.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return null;
  }
}

async function compileWasm(source: ZippEngineSource): Promise<WebAssembly.Module> {
  if (source instanceof WebAssembly.Module) return source;
  if (typeof source === 'string') {
    if (isNodeRuntime() && (/^[a-zA-Z]:[\\/]/.test(source) || source.startsWith('/') || source.startsWith('.'))) {
      const fs = await import('node:fs/promises');
      const raw = new Uint8Array(await fs.readFile(source));
      if (!isWasmMagic(raw)) {
        const zlib = await import('node:zlib');
        return WebAssembly.compile(new Uint8Array(zlib.brotliDecompressSync(raw)));
      }
      return WebAssembly.compile(raw);
    }
    const base =
      typeof document !== 'undefined'
        ? document.baseURI
        : typeof self !== 'undefined' && self.location
          ? self.location.href
          : undefined;
    const url = base ? new URL(source, base) : new URL(source);
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Failed to fetch XDB WASM (${url.pathname}): HTTP ${resp.status}`);
    const ct = (resp.headers.get('content-type') ?? '').split(';')[0].trim();
    if (ct === 'application/wasm' && typeof WebAssembly.compileStreaming === 'function') {
      try {
        const compiled = await WebAssembly.compileStreaming(resp.clone());
        void resp.body?.cancel().catch(() => undefined);
        return compiled;
      } catch {
        // fallback below
      }
    }
    return WebAssembly.compile(new Uint8Array(await resp.arrayBuffer()));
  }
  const view =
    source instanceof ArrayBuffer
      ? new Uint8Array(source)
      : new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  return WebAssembly.compile(view);
}

/**
 * Load & initialize the XDB SQLite WASM module (`xdb-wasm.wasm` + `xdb-wasm.glue.js`).
 */
export async function loadXdbWasm(options: {
  runtimeUrl?: string;
  explicitSource?: ZippEngineSource;
  glueUrl?: string;
} = {}): Promise<LoadedXdbBindings> {
  const { explicitSource } = options;
  let runtimeUrl = options.runtimeUrl;
  if (
    !runtimeUrl ||
    (isNodeRuntime() && (runtimeUrl === '/runtime/' || runtimeUrl.endsWith('/assets/container-runtime/')))
  ) {
    if (isNodeRuntime()) {
      const pathMod = await import('node:path');
      const pkgRoot = await resolveNodeContainerPkgRoot();
      runtimeUrl = pkgRoot ? pathMod.join(pkgRoot, 'dist', 'runtime') : '/runtime/';
    } else {
      runtimeUrl = '/runtime/';
    }
  }

  const explicitModule = explicitSource instanceof WebAssembly.Module ? explicitSource : null;
  if (explicitModule) {
    const cachedMod = cachedXdbByModule.get(explicitModule);
    if (cachedMod) return cachedMod;
  }
  const cacheKey = typeof explicitSource === 'string'
    ? `src:${explicitSource}`
    : explicitSource
      ? ''
      : `rt:${runtimeUrl}`;
  if (cacheKey && cachedXdbPromise.has(cacheKey)) {
    return cachedXdbPromise.get(cacheKey)!;
  }

  const loadPromise = (async (): Promise<LoadedXdbBindings> => {
    const normalizedBase = runtimeUrl.replace(/[\\/]?$/, '/');
    let wasmSource: ZippEngineSource = explicitSource ?? `${normalizedBase}engines/xdb-wasm.wasm`;
    let gluePathOrUrl = options.glueUrl ?? `${normalizedBase}engines/xdb-wasm.glue.js`;

    if (isNodeRuntime()) {
      const fsMod = await import('node:fs');
      const pathMod = await import('node:path');
      const urlMod = await import('node:url');

      if (!explicitSource && typeof wasmSource === 'string' && !fsMod.existsSync(wasmSource)) {
        const candidates = [
          process.env.XDB_WASM_DIR ? pathMod.join(process.env.XDB_WASM_DIR, 'xdb_wasm_bg.wasm') : null,
          process.env.XDB_REPO ? pathMod.join(process.env.XDB_REPO, 'crates', 'xdb-wasm', 'pkg', 'xdb_wasm_bg.wasm') : null,
        ].filter((p): p is string => Boolean(p));
        for (const cand of candidates) {
          if (fsMod.existsSync(cand)) {
            wasmSource = cand;
            gluePathOrUrl = pathMod.join(pathMod.dirname(cand), 'xdb_wasm.js');
            break;
          }
        }
      } else if (!fsMod.existsSync(gluePathOrUrl)) {
        const alt = typeof wasmSource === 'string'
          ? pathMod.join(pathMod.dirname(wasmSource), 'xdb_wasm.js')
          : null;
        if (alt && fsMod.existsSync(alt)) {
          gluePathOrUrl = alt;
        }
      }

      const module = await compileWasm(wasmSource);
      const glueHref = /^[a-zA-Z]:[\\/]/.test(gluePathOrUrl) || gluePathOrUrl.startsWith('/')
        ? urlMod.pathToFileURL(gluePathOrUrl).href
        : gluePathOrUrl;
      const glue = (await import(/* @vite-ignore */ glueHref)) as Record<string, unknown>;
      if (typeof glue.initSync === 'function') {
        (glue.initSync as (arg: { module: WebAssembly.Module }) => void)({ module });
      } else if (typeof glue.default === 'function') {
        await (glue.default as (arg: { module_or_path: WebAssembly.Module }) => Promise<unknown>)({
          module_or_path: module,
        });
      }
      return {
        WasmConnection: glue.WasmConnection as LoadedXdbBindings['WasmConnection'],
        module,
      };
    }

    // Browser / Web Worker path: load same-origin `.glue.js` cleanly (strict CSP compatible!)
    const module = await compileWasm(wasmSource);
    const baseHref =
      typeof document !== 'undefined'
        ? document.baseURI
        : typeof self !== 'undefined' && self.location
          ? self.location.href
          : undefined;
    const resolvedGlueUrl = baseHref ? new URL(gluePathOrUrl, baseHref).href : gluePathOrUrl;
    const glue = (await import(/* @vite-ignore */ resolvedGlueUrl)) as Record<string, unknown>;
    if (typeof glue.initSync === 'function') {
      (glue.initSync as (arg: { module: WebAssembly.Module }) => void)({ module });
    } else if (typeof glue.default === 'function') {
      await (glue.default as (arg: { module_or_path: WebAssembly.Module }) => Promise<unknown>)({
        module_or_path: module,
      });
    }
    return {
      WasmConnection: glue.WasmConnection as LoadedXdbBindings['WasmConnection'],
      module,
    };
  })();

  if (explicitModule) {
    loadPromise.catch(() => cachedXdbByModule.delete(explicitModule));
    cachedXdbByModule.set(explicitModule, loadPromise);
  } else if (cacheKey) {
    loadPromise.catch(() => cachedXdbPromise.delete(cacheKey));
    cachedXdbPromise.set(cacheKey, loadPromise);
  }
  return loadPromise;
}

/** Normalize a SQLite URL/path (from SQLx, PDO, SQLite3, mysqli) to a sandbox-safe `dbKey`. */
export function normalizeDbKey(rawUrl: string): { key: string; inMemory: boolean } {
  let s = String(rawUrl ?? '').trim();
  if (!s || s === ':memory:' || s === 'sqlite::memory:' || s === 'sqlite://:memory:') {
    return { key: ':memory:', inMemory: true };
  }
  // Strip sqlite:// / sqlite: / file: prefixes and query params
  if (/^sqlite:\/\//i.test(s)) s = s.slice('sqlite://'.length);
  else if (/^sqlite:/i.test(s)) s = s.slice('sqlite:'.length);
  else if (/^file:/i.test(s)) s = s.slice('file:'.length);

  const qIdx = s.indexOf('?');
  const query = qIdx >= 0 ? s.slice(qIdx + 1) : '';
  if (qIdx >= 0) s = s.slice(0, qIdx);

  if (s === ':memory:' || /(?:^|&)mode=memory(?:&|$)/i.test(query)) {
    const shared = /(?:^|&)cache=shared(?:&|$)/i.test(query);
    if (!shared || !s || s === ':memory:') {
      return { key: ':memory:', inMemory: true };
    }
  }

  // Normalize slashes and prevent traversal outside sandbox root
  const parts: string[] = [];
  for (const seg of s.replace(/\\/g, '/').split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      parts.pop();
    } else {
      parts.push(seg);
    }
  }
  const clean = parts.join('/') || 'default.db';
  return { key: clean, inMemory: false };
}

function isWriteStatement(sql: string): boolean {
  // Strip leading whitespace and SQL comments (including `--...` without trailing newline).
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql.charCodeAt(i);
    if (ch <= 32) { i++; continue; }
    if (ch === 45 && sql.charCodeAt(i + 1) === 45) {
      const nl = sql.indexOf('\n', i + 2);
      i = nl >= 0 ? nl + 1 : n;
      continue;
    }
    if (ch === 47 && sql.charCodeAt(i + 1) === 42) {
      const end = sql.indexOf('*/', i + 2);
      i = end >= 0 ? end + 2 : n;
      continue;
    }
    break;
  }
  const rest = sql.slice(i);
  if (!rest) return false;
  // Multi-statement batches containing `;` outside quotes may include writes after a SELECT.
  let inSingle = false;
  let inDouble = false;
  for (let k = 0; k < rest.length; k++) {
    const c = rest[k];
    if (inSingle) {
      if (c === "'") inSingle = false;
    } else if (inDouble) {
      if (c === '"') inDouble = false;
    } else if (c === "'") {
      inSingle = true;
    } else if (c === '"') {
      inDouble = true;
    } else if (c === ';' && rest.slice(k + 1).trim().length > 0) {
      return true;
    }
  }
  const head = rest.slice(0, 24).toUpperCase();
  if (
    head.startsWith('SELECT') ||
    head.startsWith('EXPLAIN') ||
    head.startsWith('VALUES')
  ) {
    return false;
  }
  if (head.startsWith('PRAGMA')) {
    return rest.includes('=');
  }
  return true;
}

function classifySqlError(err: unknown): { error: string; code: number; unique: boolean } {
  const msg = err instanceof Error ? err.message : String(err);
  const isUnique = /UNIQUE constraint failed|PRIMARY KEY constraint failed|unique/i.test(msg);
  const isNotNull = /NOT NULL constraint failed/i.test(msg);
  const isForeignKey = /FOREIGN KEY constraint failed/i.test(msg);
  const isConstraint = isUnique || isNotNull || isForeignKey || /CHECK constraint failed/i.test(msg);
  const code = isUnique ? 2067 : isConstraint ? 19 : 1;
  return { error: msg, code, unique: isUnique };
}

function readMeterSteps(conn: XdbWasmConnection): number {
  try {
    const parsed = JSON.parse(conn.meter_usage_json()) as { steps?: number };
    return typeof parsed.steps === 'number' ? parsed.steps : 0;
  } catch {
    return 0;
  }
}

interface ManagedDb {
  key: string;
  conn: XdbWasmConnection;
  persistent: boolean;
  dirty: boolean;
  ephemeral: boolean;
}

const MAX_OPEN_DBS = 8;
const MAX_OPEN_HANDLES = 32;

export class XdbSqlManager {
  private readonly bindings: LoadedXdbBindings;
  private readonly databases: readonly DatabaseConfig[];
  private readonly textFiles: Readonly<Record<string, string>>;
  private readonly binaryFiles: Readonly<Record<string, Uint8Array>>;
  private readonly initialPersistedDbs: Readonly<Record<string, Uint8Array>>;
  private readonly maxSteps: bigint;
  private readonly maxMemory: bigint;
  private readonly maxPageReads: bigint;
  private readonly onPersist?: (dbKey: string, bytes: Uint8Array) => void;
  private readonly onRemove?: (dbKey: string) => void;

  /** Shared live persistent databases keyed by normalized `dbKey`. */
  private readonly byKey = new Map<string, ManagedDb>();
  /** Handle table (`connId -> ManagedDb`) exposed to ZIPP guests. */
  private readonly handles = new Map<number, ManagedDb>();
  private ephemeralCount = 0;
  private nextHandleId = 1;
  private disposed = false;

  constructor(options: XdbSqlManagerOptions) {
    this.bindings = options.bindings;
    this.databases = options.databases ?? [];
    this.textFiles = options.textFiles ?? {};
    this.binaryFiles = options.binaryFiles ?? {};
    this.initialPersistedDbs = options.initialPersistedDbs ?? {};
    this.maxSteps = options.maxStepsPerConnection ?? DEFAULT_MAX_STEPS_PER_CONN;
    this.maxMemory = options.maxMemoryBytes ?? BigInt(128 * 1024 * 1024);
    this.maxPageReads = options.maxPageReads ?? DEFAULT_MAX_PAGE_READS;
    this.onPersist = options.onPersist;
    this.onRemove = options.onRemove;
  }

  private findConfigForKey(dbKey: string): DatabaseConfig | undefined {
    const lower = dbKey.toLowerCase();
    const base = lower.slice(lower.lastIndexOf('/') + 1);
    const dedup = base.endsWith('.db.db') ? base.slice(0, -3) : base;
    for (const cfg of this.databases) {
      const cfgKey = normalizeDbKey(cfg.file || cfg.name).key.toLowerCase();
      if (
        cfgKey === lower ||
        cfg.name.toLowerCase() === lower ||
        cfgKey === base ||
        cfgKey === dedup ||
        `${cfg.name.toLowerCase()}.db` === base ||
        `${cfg.name.toLowerCase()}.db` === dedup
      ) {
        return cfg;
      }
    }
    // If the container declares a single database and the requested DB isn't a separate
    // bundled file in the archive, bind to that single database (so PHP apps using e.g.
    // `DB_NAME = 'sngine'` connect seamlessly to the container's seeded SQLite DB).
    if (this.databases.length === 1 && !this.findArchiveBytes(dbKey)) {
      return this.databases[0];
    }
    return undefined;
  }

  private findArchiveBytes(path: string): Uint8Array | null {
    const clean = path.replace(/\\/g, '/').replace(/^\/+/, '');
    if (Object.hasOwn(this.binaryFiles, clean) && this.binaryFiles[clean]) return this.binaryFiles[clean];
    if (Object.hasOwn(this.textFiles, clean) && this.textFiles[clean] !== undefined) {
      return XDB_ENCODER.encode(this.textFiles[clean]);
    }
    return null;
  }

  private findArchiveText(path: string): string | null {
    const clean = path.replace(/\\/g, '/').replace(/^\/+/, '');
    if (Object.hasOwn(this.textFiles, clean) && this.textFiles[clean] !== undefined) return this.textFiles[clean];
    if (Object.hasOwn(this.binaryFiles, clean) && this.binaryFiles[clean]) {
      return XDB_DECODER.decode(this.binaryFiles[clean]);
    }
    return null;
  }

  private createConnection(dbKey: string, ephemeral: boolean): ManagedDb {
    if (ephemeral && this.ephemeralCount >= MAX_EPHEMERAL_DBS) {
      throw new Error(`Too many ephemeral in-memory SQLite databases open (max ${MAX_EPHEMERAL_DBS})`);
    }
    if (!ephemeral && !this.byKey.has(dbKey) && this.byKey.size >= MAX_OPEN_DBS) {
      throw new Error(`Too many distinct SQLite databases open (max ${MAX_OPEN_DBS})`);
    }
    const cfg = ephemeral ? undefined : this.findConfigForKey(dbKey);
    const persisted = ephemeral
      ? undefined
      : (Object.hasOwn(this.initialPersistedDbs, dbKey) ? this.initialPersistedDbs[dbKey] : undefined) ??
        (cfg && Object.hasOwn(this.initialPersistedDbs, cfg.name) ? this.initialPersistedDbs[cfg.name] : undefined);

    let initialBytes: Uint8Array | null = null;
    let walBytes: Uint8Array | null = null;
    let journalBytes: Uint8Array | null = null;
    let hydratedFromPersisted = false;

    if (persisted && persisted.byteLength > 0) {
      initialBytes = persisted;
      hydratedFromPersisted = true;
    } else if (!ephemeral) {
      // Check bundled .db file by exact key or configured file path
      const dbPath = cfg?.file || dbKey;
      const bundled = this.findArchiveBytes(dbPath) ?? this.findArchiveBytes(dbKey);
      if (bundled && bundled.byteLength > 0) {
        initialBytes = bundled;
        walBytes = this.findArchiveBytes(`${dbPath}-wal`) ?? this.findArchiveBytes(`${dbKey}-wal`);
        journalBytes = this.findArchiveBytes(`${dbPath}-journal`) ?? this.findArchiveBytes(`${dbKey}-journal`);
      }
    }

    const connSteps = ephemeral ? EPHEMERAL_MAX_STEPS : this.maxSteps;
    const connMem = ephemeral ? (this.maxMemory < EPHEMERAL_MAX_MEMORY_BYTES ? this.maxMemory : EPHEMERAL_MAX_MEMORY_BYTES) : this.maxMemory;
    const connPageReads = ephemeral ? EPHEMERAL_MAX_PAGE_READS : this.maxPageReads;
    const conn = new this.bindings.WasmConnection(
      initialBytes,
      walBytes,
      journalBytes,
      4096,
      connSteps,
      connMem,
      connPageReads
    );

    let seeded = false;
    if (!hydratedFromPersisted && !ephemeral) {
      // Apply seedSql (inline SQL or archive path)
      const seedSqlSpec = cfg?.seedSql;
      if (seedSqlSpec) {
        const sqlText = this.findArchiveText(seedSqlSpec) ?? seedSqlSpec;
        if (sqlText.trim()) {
          conn.execute_json(sqlText, null);
          seeded = true;
        }
      }
      // Apply seedJson (inline JSON object/string or archive path)
      const seedJsonSpec = cfg?.seedJson;
      if (seedJsonSpec) {
        let jsonText: string | null = null;
        if (typeof seedJsonSpec === 'string') {
          jsonText = this.findArchiveText(seedJsonSpec) ?? seedJsonSpec;
        } else if (typeof seedJsonSpec === 'object') {
          jsonText = JSON.stringify(seedJsonSpec);
        }
        if (jsonText && jsonText.trim()) {
          conn.seed_json(jsonText);
          seeded = true;
        }
      }
    }

    const managed: ManagedDb = {
      key: dbKey,
      conn,
      persistent: !ephemeral && (cfg?.persist ?? true),
      dirty: seeded,
      ephemeral,
    };

    if (ephemeral) {
      this.ephemeralCount++;
    } else {
      this.byKey.set(dbKey, managed);
    }
    return managed;
  }

  /** Pre-open and seed all configured databases (so JSON/SQL seeds are ready immediately on boot). */
  preseedConfiguredDatabases(): void {
    if (this.disposed) return;
    for (const cfg of this.databases) {
      const target = cfg.file || `${cfg.name}.db`;
      const { key, inMemory } = normalizeDbKey(target);
      if (!inMemory && !this.byKey.has(key)) {
        this.createConnection(key, false);
      }
    }
  }

  private resolveCanonicalKey(rawKey: string): string {
    const { key } = normalizeDbKey(rawKey);
    if (this.byKey.has(key)) return key;
    const cfg = this.findConfigForKey(key);
    if (cfg) {
      const cfgKey = normalizeDbKey(cfg.file || cfg.name).key;
      if (cfgKey !== ':memory:') return cfgKey;
    }
    return key;
  }

  /** Open a SQLite connection handle (returning `{ id }` or `{ error, code, unique }`). */
  open(rawUrl: string): { id: number } | { error: string; code: number; unique: boolean } {
    if (this.disposed) return { error: 'SQLite manager is disposed', code: 21, unique: false };
    try {
      if (this.handles.size >= MAX_OPEN_HANDLES) {
        return { error: `Too many open SQLite connection handles (max ${MAX_OPEN_HANDLES})`, code: 14, unique: false };
      }
      const { key, inMemory } = normalizeDbKey(rawUrl);
      const canonical = inMemory ? ':memory:' : this.resolveCanonicalKey(key);
      if (!inMemory && !this.byKey.has(canonical) && this.byKey.size >= MAX_OPEN_DBS) {
        return { error: `Too many distinct SQLite databases open (max ${MAX_OPEN_DBS})`, code: 14, unique: false };
      }
      const managed = inMemory
        ? this.createConnection(':memory:', true)
        : this.byKey.get(canonical) ?? this.createConnection(canonical, false);
      const id = this.nextHandleId++;
      this.handles.set(id, managed);
      return { id };
    } catch (err) {
      return classifySqlError(err);
    }
  }

  /** Execute a statement (`INSERT`/`UPDATE`/`DELETE`/`CREATE`/`PRAGMA`/etc.). */
  execute(
    handleId: number,
    sql: string,
    paramsJson?: string,
    hooks?: XdbBudgetHooks
  ): { rows_affected: number; last_insert_rowid: number } | { error: string; code: number; unique: boolean } {
    const managed = this.handles.get(handleId);
    if (!managed) return { error: `invalid sqlite connection handle ${handleId}`, code: 21, unique: false };
    const before = hooks?.hostChargeSteps ? readMeterSteps(managed.conn) : 0;
    const changesBefore = Number(managed.conn.total_changes());
    try {
      const raw = managed.conn.execute_json(sql, paramsJson && paramsJson.trim() ? paramsJson : null);
      this.chargeDelta(managed.conn, before, hooks);
      if (raw.length > MAX_SQL_RESULT_JSON_CHARS) {
        return { error: 'SQLite result exceeds maximum serialized size limit', code: 18, unique: false };
      }
      const parsed = JSON.parse(raw) as { changes?: number; lastInsertRowid?: number };
      if (isWriteStatement(sql) || Number(managed.conn.total_changes()) !== changesBefore) {
        managed.dirty = true;
      }
      return {
        rows_affected: Number(parsed.changes ?? 0),
        last_insert_rowid: Number(parsed.lastInsertRowid ?? 0),
      };
    } catch (err) {
      this.chargeDelta(managed.conn, before, hooks);
      return classifySqlError(err);
    }
  }

  /** Execute a query returning `{ columns, rows }` (also handles DDL/DML with `RETURNING` or `PRAGMA`). */
  query(
    handleId: number,
    sql: string,
    paramsJson?: string,
    hooks?: XdbBudgetHooks
  ): { columns: string[]; rows: unknown[][] } | { error: string; code: number; unique: boolean } {
    const managed = this.handles.get(handleId);
    if (!managed) return { error: `invalid sqlite connection handle ${handleId}`, code: 21, unique: false };
    const before = hooks?.hostChargeSteps ? readMeterSteps(managed.conn) : 0;
    const changesBefore = Number(managed.conn.total_changes());
    try {
      const raw = managed.conn.execute_json(sql, paramsJson && paramsJson.trim() ? paramsJson : null);
      this.chargeDelta(managed.conn, before, hooks);
      if (raw.length > MAX_SQL_RESULT_JSON_CHARS) {
        return { error: 'SQLite query result exceeds maximum serialized size limit', code: 18, unique: false };
      }
      const parsed = JSON.parse(raw) as { columns?: string[]; rows?: unknown[][] };
      const rows = Array.isArray(parsed.rows) ? parsed.rows : [];
      if (rows.length > MAX_SQL_RESULT_ROWS) {
        return { error: `SQLite query returned more than ${MAX_SQL_RESULT_ROWS} rows`, code: 18, unique: false };
      }
      if (isWriteStatement(sql) || Number(managed.conn.total_changes()) !== changesBefore) {
        managed.dirty = true;
      }
      return {
        columns: parsed.columns ?? [],
        rows,
      };
    } catch (err) {
      this.chargeDelta(managed.conn, before, hooks);
      return classifySqlError(err);
    }
  }

  /** Apply declarative JSON seed data to an open handle or named database. */
  seedJson(
    handleOrKey: number | string,
    seedJson: string | Record<string, unknown>,
    hooks?: XdbBudgetHooks
  ): { tablesCreated: number; tablesSeeded: number; rowsInserted: number; statementsExecuted: number } | { error: string; code: number; unique: boolean } {
    let managed: ManagedDb | undefined;
    if (typeof handleOrKey === 'number') {
      managed = this.handles.get(handleOrKey);
    } else {
      const { key, inMemory } = normalizeDbKey(handleOrKey);
      const canonical = inMemory ? ':memory:' : this.resolveCanonicalKey(key);
      if (!inMemory) {
        try {
          managed = this.byKey.get(canonical) ?? this.createConnection(canonical, false);
        } catch (err) {
          return classifySqlError(err);
        }
      }
    }
    if (!managed) return { error: `database '${handleOrKey}' not found`, code: 21, unique: false };
    const payload = typeof seedJson === 'string' ? seedJson : JSON.stringify(seedJson);
    const before = hooks?.hostChargeSteps ? readMeterSteps(managed.conn) : 0;
    try {
      const raw = managed.conn.seed_json(payload);
      this.chargeDelta(managed.conn, before, hooks);
      managed.dirty = true;
      return JSON.parse(raw) as {
        tablesCreated: number;
        tablesSeeded: number;
        rowsInserted: number;
        statementsExecuted: number;
      };
    } catch (err) {
      this.chargeDelta(managed.conn, before, hooks);
      return classifySqlError(err);
    }
  }

  /** Close a connection handle (ephemeral `:memory:` handles are freed immediately; persistent ones flush via `BackendWorkerSession`). */
  close(handleId: number): { ok: true } {
    const managed = this.handles.get(handleId);
    if (!managed) return { ok: true };
    this.handles.delete(handleId);
    if (managed.ephemeral) {
      this.ephemeralCount = Math.max(0, this.ephemeralCount - 1);
      try {
        managed.conn.close();
      } catch {
        // ignore
      }
      try {
        managed.conn.free();
      } catch {
        // ignore
      }
    }
    return { ok: true };
  }

  /** Flush all dirty persistent databases that are not mid-transaction, returning snapshots. */
  flushDirty(): Array<{ dbKey: string; bytes: Uint8Array }> {
    const flushed: Array<{ dbKey: string; bytes: Uint8Array }> = [];
    for (const managed of this.byKey.values()) {
      if (managed.dirty && managed.persistent && !managed.conn.in_transaction()) {
        const snap = this.flushOne(managed);
        if (snap) flushed.push({ dbKey: managed.key, bytes: snap });
      }
    }
    return flushed;
  }

  /** Export a single named database's live SQLite `.db` bytes. */
  exportBytes(dbKeyOrUrl: string): Uint8Array | null {
    const canonical = this.resolveCanonicalKey(dbKeyOrUrl);
    const managed = this.byKey.get(canonical);
    if (!managed) return null;
    return managed.conn.export_bytes();
  }

  /**
   * Copy a live SQLite database image to another sandboxed database key (used by
   * Rust `std::fs::copy("pit.db", "pit-sim.db")` etc. when cloning a DB for simulation).
   */
  copy(
    fromUrl: string,
    toUrl: string
  ): { bytes: number } | { error: string; code: number; unique: boolean } {
    if (this.disposed) return { error: 'SQLite manager is disposed', code: 21, unique: false };
    try {
      const fromNorm = normalizeDbKey(fromUrl);
      const toNorm = normalizeDbKey(toUrl);
      if (fromNorm.inMemory) return { error: 'cannot copy from :memory:', code: 1, unique: false };
      if (toNorm.inMemory) return { error: 'cannot copy to :memory:', code: 1, unique: false };

      const srcKey = this.resolveCanonicalKey(fromNorm.key);
      const srcManaged = this.byKey.get(srcKey) ?? this.createConnection(srcKey, false);
      const bytes = srcManaged.conn.export_bytes();
      const dstKey = toNorm.key;

      if (dstKey === srcKey) {
        return { bytes: bytes.byteLength };
      }
      if (!this.byKey.has(dstKey) && this.byKey.size >= MAX_OPEN_DBS) {
        return { error: `Too many distinct SQLite databases open (max ${MAX_OPEN_DBS})`, code: 14, unique: false };
      }

      const existing = this.byKey.get(dstKey);
      if (existing) {
        for (const [hid, m] of this.handles) {
          if (m === existing) this.handles.delete(hid);
        }
        try { existing.conn.close(); } catch { /* ignore */ }
        try { existing.conn.free(); } catch { /* ignore */ }
        this.byKey.delete(dstKey);
      }

      const clonedConn = new this.bindings.WasmConnection(
        bytes,
        null,
        null,
        4096,
        this.maxSteps,
        this.maxMemory,
        this.maxPageReads
      );
      const isDeclaredTarget = this.databases.some(
        (cfg) => normalizeDbKey(cfg.file || cfg.name).key.toLowerCase() === dstKey.toLowerCase()
      );
      this.byKey.set(dstKey, {
        key: dstKey,
        conn: clonedConn,
        persistent: isDeclaredTarget,
        dirty: isDeclaredTarget,
        ephemeral: false,
      });
      return { bytes: bytes.byteLength };
    } catch (err) {
      return classifySqlError(err);
    }
  }

  /**
   * Remove a sandboxed database by exact normalized key (used by `std::fs::remove_file`).
   * Deliberately does NOT fall back to single-DB aliasing so removing a scratch DB
   * like `pit-sim.db` or sidecars (`-wal`, `-shm`) can never touch the primary DB.
   */
  remove(rawUrl: string): { ok: true; removed: boolean } {
    if (this.disposed) return { ok: true, removed: false };
    const { key, inMemory } = normalizeDbKey(rawUrl);
    if (inMemory) return { ok: true, removed: false };
    if (/(?:-wal|-shm|-journal)$/i.test(key)) {
      return { ok: true, removed: true };
    }
    const existing = this.byKey.get(key);
    if (!existing) return { ok: true, removed: false };
    for (const [hid, m] of this.handles) {
      if (m === existing) this.handles.delete(hid);
    }
    this.byKey.delete(key);
    try { existing.conn.close(); } catch { /* ignore */ }
    try { existing.conn.free(); } catch { /* ignore */ }
    this.onRemove?.(key);
    return { ok: true, removed: true };
  }

  private flushOne(managed: ManagedDb): Uint8Array | null {
    try {
      const bytes = managed.conn.export_bytes();
      managed.dirty = false;
      this.onPersist?.(managed.key, bytes);
      return bytes;
    } catch {
      return null;
    }
  }

  private chargeDelta(conn: XdbWasmConnection, beforeSteps: number, hooks?: XdbBudgetHooks): void {
    if (!hooks?.hostChargeSteps) return;
    const after = readMeterSteps(conn);
    const delta = after - beforeSteps;
    if (delta > 0) {
      hooks.hostChargeSteps(delta);
    }
  }

  /**
   * Build the synchronous bridge object for `engine.addAppBridge('sql', ...)` /
   * `phpApp.addAppBridge('sql', ...)`.
   *
   * NOTE: `zipp-wasm` JSON-stringifies the return value of `bridge.call(kind, args)`,
   * so every branch MUST return a plain JS object (never a pre-encoded JSON string!).
   */
  createZippSqlBridge(hooks?: XdbBudgetHooks): { call: (kind: string, args: string[]) => unknown } {
    return {
      call: (kindRaw: string, argsRaw: string[]) => {
        const kind = String(kindRaw ?? '');
        const args = Array.isArray(argsRaw) ? argsRaw : [];
        switch (kind) {
          case 'sql.open':
            return this.open(args[0] ?? ':memory:');
          case 'sql.execute':
            return this.execute(Number(args[0]), args[1] ?? '', args[2], hooks);
          case 'sql.query':
            return this.query(Number(args[0]), args[1] ?? '', args[2], hooks);
          case 'sql.seed_json':
            return this.seedJson(Number(args[0]), args[1] ?? '{}', hooks);
          case 'sql.copy':
            return this.copy(args[0] ?? '', args[1] ?? '');
          case 'sql.remove':
            return this.remove(args[0] ?? '');
          case 'sql.close':
            return this.close(Number(args[0]));
          default:
            return { error: `unknown sql operation: ${kind}`, code: 1, unique: false };
        }
      },
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.flushDirty();
    this.disposed = true;
    const freed = new Set<XdbWasmConnection>();
    for (const m of this.byKey.values()) {
      if (!freed.has(m.conn)) {
        freed.add(m.conn);
        try { m.conn.close(); } catch { /* ignore */ }
        try { m.conn.free(); } catch { /* ignore */ }
      }
    }
    for (const m of this.handles.values()) {
      if (!freed.has(m.conn)) {
        freed.add(m.conn);
        try { m.conn.close(); } catch { /* ignore */ }
        try { m.conn.free(); } catch { /* ignore */ }
      }
    }
    this.byKey.clear();
    this.handles.clear();
    this.ephemeralCount = 0;
  }
}

export const ZIPP_SQL_CAPABILITIES = [
  'app.sql.open',
  'app.sql.execute',
  'app.sql.query',
  'app.sql.seed_json',
  'app.sql.copy',
  'app.sql.remove',
  'app.sql.close',
] as const;
