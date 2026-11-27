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

import { sha256 } from '@softn/bundle-format/sha256';
import {
  bytesToHex,
  normalizeSqlParamsJson,
  parseXdbResultJson,
  type SqlParamEncodeOptions,
} from './sqlite-codec';
import type {
  DatabaseConfig,
  SqlColumnInfo,
  SqlForeignKeyInfo,
  SqlIndexInfo,
  SqlIntegrityReport,
  SqlMigrationStatus,
  SqlSchemaMetadata,
  SqlSnapshotResult,
  SqlTableSchema,
  SqlValue,
  SqlValueMode,
  SqliteWorkspaceBudget,
  ZippEngineSource,
} from './types';

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

export interface XdbPersistMeta {
  revision: number;
  checksum: string;
  schemaVersion: number;
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
  /** Initial persisted metadata (revision, schemaVersion) restored from host IndexedDB. */
  initialPersistedMeta?: Readonly<Record<string, { revision?: number; schemaVersion?: number; checksum?: string }>>;
  /** Sandbox resource ceilings per connection (`0` = unlimited). */
  maxStepsPerConnection?: bigint;
  maxMemoryBytes?: bigint;
  maxPageReads?: bigint;
  /** Host-configurable ceiling on distinct named databases (clamped to platform cap). */
  maxOpenDbs?: number;
  /** Host-configurable ceiling on databases per temporary workspace (clamped to platform cap). */
  maxWorkspaceDbs?: number;
  /** Host-configurable max SQLite import image size in bytes (clamped to platform cap). */
  maxImportBytes?: number;
  /** Called whenever a database is modified and ready to persist. */
  onPersist?: (dbKey: string, bytes: Uint8Array, meta: XdbPersistMeta) => void;
  /** Called whenever a sandboxed database is removed via `remove()`. */
  onRemove?: (dbKey: string) => void;
}

export interface SqlExecuteOptions extends SqlParamEncodeOptions {
  valueMode?: SqlValueMode;
}

export interface SqlErrorResult {
  error: string;
  code: number;
  unique: boolean;
}

const XDB_ENCODER = new TextEncoder();
const XDB_DECODER = new TextDecoder();
const SQLITE_MAGIC = 'SQLite format 3\0';
const MAX_SQL_RESULT_JSON_CHARS = 16 * 1024 * 1024;
const MAX_SQL_RESULT_ROWS = 50_000;
const MAX_EPHEMERAL_DBS = 8;
const EPHEMERAL_MAX_MEMORY_BYTES = BigInt(64 * 1024 * 1024);
const DEFAULT_MAX_STEPS_PER_CONN = 2_000_000_000n;
const DEFAULT_MAX_PAGE_READS = 50_000_000n;
const EPHEMERAL_MAX_STEPS = 200_000_000n;
const EPHEMERAL_MAX_PAGE_READS = 2_000_000n;
const PLATFORM_MAX_OPEN_DBS = 32;
const PLATFORM_MAX_WORKSPACES = 8;
const PLATFORM_MAX_WORKSPACE_DBS = 16;
const PLATFORM_MAX_IMPORT_BYTES = 128 * 1024 * 1024;
const DEFAULT_MAX_IMPORT_BYTES = 64 * 1024 * 1024;
const PLATFORM_MAX_WORKSPACE_MEMORY = BigInt(128 * 1024 * 1024);
const PLATFORM_MAX_WORKSPACE_STEPS = 500_000_000n;
const PLATFORM_MAX_WORKSPACE_PAGE_READS = 5_000_000n;

function sha256HexSync(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}

function validateSqliteHeader(bytes: Uint8Array): { valid: boolean; reason?: string; pageSize?: number } {
  if (bytes.byteLength === 0) return { valid: true, pageSize: 4096 };
  if (bytes.byteLength < 100) {
    return { valid: false, reason: `SQLite file too small (${bytes.byteLength} bytes, expected >= 100)` };
  }
  for (let i = 0; i < 16; i++) {
    if (bytes[i] !== SQLITE_MAGIC.charCodeAt(i)) {
      return { valid: false, reason: 'Invalid SQLite file header magic (expected "SQLite format 3\\0")' };
    }
  }
  const rawPageSize = (bytes[16] << 8) | bytes[17];
  const pageSize = rawPageSize === 1 ? 65536 : rawPageSize;
  const isPow2 = pageSize >= 512 && pageSize <= 65536 && (pageSize & (pageSize - 1)) === 0;
  if (!isPow2) {
    return { valid: false, reason: `Invalid SQLite page size in header (${pageSize})` };
  }
  if (bytes.byteLength % pageSize !== 0) {
    return {
      valid: false,
      reason: `SQLite file length (${bytes.byteLength}) is not a multiple of page size (${pageSize})`,
    };
  }
  return { valid: true, pageSize };
}

function quoteIdent(name: string): string {
  return `"${String(name).replace(/"/g, '""')}"`;
}

/**
 * Fallback parser for SQLite `REFERENCES` clauses inside `CREATE TABLE` DDL
 * when an engine's `PRAGMA foreign_key_list` returns empty results.
 */
function parseForeignKeysFromCreateTableSql(sql: string | null): SqlForeignKeyInfo[] {
  if (!sql) return [];
  const open = sql.indexOf('(');
  const close = sql.lastIndexOf(')');
  if (open < 0 || close <= open) return [];
  const body = sql.slice(open + 1, close);
  // Split top-level comma-separated column/constraint definitions
  const parts: string[] = [];
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
    } else if (inDouble) {
      if (ch === '"') inDouble = false;
    } else if (ch === "'") {
      inSingle = true;
    } else if (ch === '"') {
      inDouble = true;
    } else if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth = Math.max(0, depth - 1);
    } else if (ch === ',' && depth === 0) {
      parts.push(body.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = body.slice(start).trim();
  if (last) parts.push(last);

  const unquote = (ident: string) => ident.trim().replace(/^["`[]|["`\]]$/g, '');
  const fks: SqlForeignKeyInfo[] = [];
  let fkId = 0;
  for (const part of parts) {
    // Table-level: [CONSTRAINT name] FOREIGN KEY (a, b) REFERENCES parent (x, y) [ON DELETE ...] [ON UPDATE ...]
    const tblMatch = /(?:CONSTRAINT\s+(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|\w+)\s+)?FOREIGN\s+KEY\s*\(([^)]+)\)\s*REFERENCES\s+("[^"]+"|`[^`]+`|\[[^\]]+\]|\w+)\s*(?:\(([^)]+)\))?([\s\S]*)/i.exec(part);
    if (tblMatch) {
      const fromCols = tblMatch[1].split(',').map(unquote).filter(Boolean);
      const refTable = unquote(tblMatch[2]);
      const toCols = tblMatch[3] ? tblMatch[3].split(',').map(unquote).filter(Boolean) : fromCols;
      const tail = tblMatch[4] ?? '';
      const onDelete = (/ON\s+DELETE\s+(CASCADE|SET\s+NULL|SET\s+DEFAULT|RESTRICT|NO\s+ACTION)/i.exec(tail)?.[1] ?? 'NO ACTION').toUpperCase().replace(/\s+/g, ' ');
      const onUpdate = (/ON\s+UPDATE\s+(CASCADE|SET\s+NULL|SET\s+DEFAULT|RESTRICT|NO\s+ACTION)/i.exec(tail)?.[1] ?? 'NO ACTION').toUpperCase().replace(/\s+/g, ' ');
      for (let seq = 0; seq < fromCols.length; seq++) {
        fks.push({
          id: fkId,
          seq,
          table: refTable,
          from: fromCols[seq],
          to: toCols[seq] ?? fromCols[seq],
          onUpdate,
          onDelete,
        });
      }
      fkId++;
      continue;
    }
    // Column-level: col_name TYPE ... REFERENCES parent(col) [ON DELETE ...] [ON UPDATE ...]
    const colMatch = /^("[^"]+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_][A-Za-z0-9_$]*)\b[\s\S]*?\bREFERENCES\s+("[^"]+"|`[^`]+`|\[[^\]]+\]|\w+)\s*(?:\(([^)]+)\))?([\s\S]*)/i.exec(part);
    if (colMatch) {
      const fromCol = unquote(colMatch[1]);
      if (/^(?:PRIMARY|UNIQUE|CHECK|CONSTRAINT|FOREIGN)$/i.test(fromCol)) continue;
      const refTable = unquote(colMatch[2]);
      const toCol = colMatch[3] ? unquote(colMatch[3].split(',')[0]) : 'id';
      const tail = colMatch[4] ?? '';
      const onDelete = (/ON\s+DELETE\s+(CASCADE|SET\s+NULL|SET\s+DEFAULT|RESTRICT|NO\s+ACTION)/i.exec(tail)?.[1] ?? 'NO ACTION').toUpperCase().replace(/\s+/g, ' ');
      const onUpdate = (/ON\s+UPDATE\s+(CASCADE|SET\s+NULL|SET\s+DEFAULT|RESTRICT|NO\s+ACTION)/i.exec(tail)?.[1] ?? 'NO ACTION').toUpperCase().replace(/\s+/g, ' ');
      fks.push({
        id: fkId++,
        seq: 0,
        table: refTable,
        from: fromCol,
        to: toCol,
        onUpdate,
        onDelete,
      });
    }
  }
  return fks;
}

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

/** Whether `sql` holds another statement after a `;` outside quotes. */
function hasFollowingStatement(sql: string): boolean {
  let inSingle = false;
  let inDouble = false;
  for (let k = 0; k < sql.length; k++) {
    const c = sql[k];
    if (inSingle) {
      if (c === "'") inSingle = false;
    } else if (inDouble) {
      if (c === '"') inDouble = false;
    } else if (c === "'") {
      inSingle = true;
    } else if (c === '"') {
      inDouble = true;
    } else if (c === ';' && sql.slice(k + 1).trim().length > 0) {
      return true;
    }
  }
  return false;
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
  if (hasFollowingStatement(rest)) return true;
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
  readOnly: boolean;
  workspaceId?: string;
  revision: number;
  schemaVersion: number;
  lastChecksum?: string;
  migrationStatus?: SqlMigrationStatus;
}

interface WorkspaceState {
  id: string;
  maxDatabases: number;
  maxMemoryBytes: bigint;
  maxSteps: bigint;
  maxPageReads: bigint;
  maxImportBytes: number;
  handleIds: Set<number>;
  cancelled: boolean;
}

/** One backend request's view of the SQL handles (`XdbSqlManager.beginRequestScope`). */
export interface SqlRequestScope {
  readonly firstHandleId: number;
  readonly openTransactions: ReadonlySet<string>;
  ended: boolean;
}

const DEFAULT_MAX_OPEN_DBS = 8;
const MAX_OPEN_HANDLES = 64;

export class XdbSqlManager {
  private readonly bindings: LoadedXdbBindings;
  private readonly databases: readonly DatabaseConfig[];
  private readonly textFiles: Readonly<Record<string, string>>;
  private readonly binaryFiles: Readonly<Record<string, Uint8Array>>;
  private readonly initialPersistedDbs: Readonly<Record<string, Uint8Array>>;
  private readonly initialPersistedMeta: Readonly<Record<string, { revision?: number; schemaVersion?: number; checksum?: string }>>;
  private readonly maxSteps: bigint;
  private readonly maxMemory: bigint;
  private readonly maxPageReads: bigint;
  private readonly maxOpenDbs: number;
  private readonly maxWorkspaceDbs: number;
  private readonly maxImportBytes: number;
  private readonly onPersist?: (dbKey: string, bytes: Uint8Array, meta: XdbPersistMeta) => void;
  private readonly onRemove?: (dbKey: string) => void;

  /** Shared live persistent databases keyed by normalized `dbKey`. */
  private readonly byKey = new Map<string, ManagedDb>();
  /** Handle table (`connId -> ManagedDb`) exposed to ZIPP guests. */
  private readonly handles = new Map<number, ManagedDb>();
  /** Isolated temporary database workspaces (`workspaceId -> WorkspaceState`). */
  private readonly workspaces = new Map<string, WorkspaceState>();
  /**
   * The one handle of each persistent database. Its connection is shared by every open, so
   * every open of it is the same handle, and closing it leaves it open for the others: code
   * that opens per request and never closes (PDO, the JS template) cannot use the table up,
   * and a handle opened at start-up or kept between requests stays valid.
   */
  private readonly sharedHandleByKey = new Map<string, number>();
  private ephemeralCount = 0;
  private nextHandleId = 1;
  private nextWorkspaceSeq = 1;
  private disposed = false;

  constructor(options: XdbSqlManagerOptions) {
    this.bindings = options.bindings;
    this.databases = options.databases ?? [];
    this.textFiles = options.textFiles ?? {};
    this.binaryFiles = options.binaryFiles ?? {};
    this.initialPersistedDbs = options.initialPersistedDbs ?? {};
    this.initialPersistedMeta = options.initialPersistedMeta ?? {};
    this.maxSteps = options.maxStepsPerConnection ?? DEFAULT_MAX_STEPS_PER_CONN;
    this.maxMemory = options.maxMemoryBytes ?? BigInt(128 * 1024 * 1024);
    this.maxPageReads = options.maxPageReads ?? DEFAULT_MAX_PAGE_READS;
    this.maxOpenDbs =
      typeof options.maxOpenDbs === 'number' && Number.isInteger(options.maxOpenDbs) && options.maxOpenDbs > 0
        ? Math.min(options.maxOpenDbs, PLATFORM_MAX_OPEN_DBS)
        : DEFAULT_MAX_OPEN_DBS;
    this.maxWorkspaceDbs =
      typeof options.maxWorkspaceDbs === 'number' && Number.isInteger(options.maxWorkspaceDbs) && options.maxWorkspaceDbs > 0
        ? Math.min(options.maxWorkspaceDbs, PLATFORM_MAX_WORKSPACE_DBS)
        : 8;
    this.maxImportBytes =
      typeof options.maxImportBytes === 'number' && Number.isFinite(options.maxImportBytes) && options.maxImportBytes > 0
        ? Math.min(Math.floor(options.maxImportBytes), PLATFORM_MAX_IMPORT_BYTES)
        : DEFAULT_MAX_IMPORT_BYTES;
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

  private readUserVersion(conn: XdbWasmConnection): number {
    try {
      const parsed = parseXdbResultJson(conn.execute_json('PRAGMA user_version', null), 'legacy');
      const v = Number(parsed.rows[0]?.[0] ?? 0);
      return Number.isInteger(v) && v >= 0 ? v : 0;
    } catch {
      return 0;
    }
  }

  /**
   * Apply versioned, non-destructive schema migrations declared in `DatabaseConfig.migrations`.
   * Captures a pre-upgrade binary snapshot and restores it cleanly if any migration fails.
   */
  private applyDeclaredMigrations(
    dbKey: string,
    conn: XdbWasmConnection,
    cfg: DatabaseConfig,
    hydratedFromPersisted: boolean,
    connSteps: bigint,
    connMem: bigint,
    connPageReads: bigint
  ): { conn: XdbWasmConnection; migrated: boolean; schemaVersion: number; status: SqlMigrationStatus } {
    const migrations = [...(cfg.migrations ?? [])].sort((a, b) => a.version - b.version);
    const highestMigration = migrations.length > 0 ? migrations[migrations.length - 1].version : 0;
    const targetVersion = Math.max(cfg.schemaVersion ?? 0, highestMigration);

    if (migrations.length === 0) {
      const userVer = this.readUserVersion(conn);
      const effectiveVer = userVer || cfg.schemaVersion || 1;
      return {
        conn,
        migrated: false,
        schemaVersion: effectiveVer,
        status: { dbKey, targetVersion: targetVersion || effectiveVer, currentVersion: effectiveVer, applied: [] },
      };
    }

    // Read existing ledger if `_softn_migrations` already exists
    const appliedMap = new Map<number, { version: number; checksum: string; file?: string; appliedAt: string }>();
    let hasLedger = false;
    try {
      const tbl = parseXdbResultJson(
        conn.execute_json("SELECT name FROM sqlite_master WHERE type='table' AND name='_softn_migrations'", null),
        'legacy'
      );
      if (tbl.rows.length > 0) {
        hasLedger = true;
        const ledger = parseXdbResultJson(
          conn.execute_json('SELECT version, checksum, file, applied_at FROM _softn_migrations ORDER BY version ASC', null),
          'legacy'
        );
        for (const row of ledger.rows) {
          const v = Number(row[0]);
          if (Number.isInteger(v) && v > 0) {
            appliedMap.set(v, {
              version: v,
              checksum: String(row[1] ?? ''),
              file: row[2] != null ? String(row[2]) : undefined,
              appliedAt: String(row[3] ?? ''),
            });
          }
        }
      }
    } catch {
      hasLedger = false;
    }

    const userVersion = this.readUserVersion(conn);
    const maxAppliedLedger = appliedMap.size > 0 ? Math.max(...appliedMap.keys()) : 0;
    const minDeclaredVersion = migrations[0].version;
    let currentVersion = Math.max(maxAppliedLedger, userVersion);
    if (!hasLedger && currentVersion === 0 && hydratedFromPersisted && minDeclaredVersion > 1) {
      // Upgrading an existing persisted v1 database that pre-dates the migration ledger.
      currentVersion = 1;
    }

    // Verify checksums of already-applied migrations to catch accidental tampering
    for (const mig of migrations) {
      const prev = appliedMap.get(mig.version);
      if (!prev) continue;
      const sqlText = mig.file ? this.findArchiveText(mig.file) : (mig.sql ?? null);
      if (sqlText !== null) {
        const expectedChecksum = sha256HexSync(XDB_ENCODER.encode(sqlText));
        if (prev.checksum && prev.checksum !== expectedChecksum) {
          throw new Error(
            `Migration v${mig.version} checksum mismatch for database "${dbKey}" (already applied with ${prev.checksum.slice(0, 12)}, manifest provides ${expectedChecksum.slice(0, 12)})`
          );
        }
      }
    }

    const pending = migrations.filter((m) => m.version > currentVersion && !appliedMap.has(m.version));
    if (pending.length === 0) {
      const finalVersion = Math.max(currentVersion, targetVersion > 0 && currentVersion >= targetVersion ? currentVersion : currentVersion);
      return {
        conn,
        migrated: false,
        schemaVersion: finalVersion || 1,
        status: {
          dbKey,
          targetVersion: targetVersion || finalVersion || 1,
          currentVersion: finalVersion || 1,
          applied: [...appliedMap.values()].sort((a, b) => a.version - b.version),
        },
      };
    }

    // Capture a full recoverable snapshot before applying any migration statements
    const preUpgradeSnapshot = conn.export_bytes();
    const activeConn = conn;
    let appliedCount = 0;

    try {
      activeConn.execute_json(
        'CREATE TABLE IF NOT EXISTS _softn_migrations (version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, file TEXT, applied_at TEXT NOT NULL)',
        null
      );

      for (const mig of pending) {
        const sqlText = mig.file ? this.findArchiveText(mig.file) : (mig.sql ?? null);
        if (sqlText === null || !sqlText.trim()) {
          throw new Error(`Migration v${mig.version} for database "${dbKey}" has missing or empty SQL${mig.file ? ` (${mig.file})` : ''}`);
        }
        const checksum = sha256HexSync(XDB_ENCODER.encode(sqlText));
        const appliedAt = new Date().toISOString();

        activeConn.execute_json('BEGIN', null);
        try {
          activeConn.execute_json(sqlText, null);
          activeConn.execute_json(
            'INSERT INTO _softn_migrations (version, checksum, file, applied_at) VALUES (?, ?, ?, ?)',
            JSON.stringify([mig.version, checksum, mig.file ?? null, appliedAt])
          );
          activeConn.execute_json(`PRAGMA user_version = ${mig.version}`, null);
          activeConn.execute_json('COMMIT', null);
        } catch (migErr) {
          try {
            if (activeConn.in_transaction()) activeConn.execute_json('ROLLBACK', null);
          } catch {
            // ignore rollback error; full snapshot restore follows below
          }
          throw migErr;
        }
        appliedMap.set(mig.version, { version: mig.version, checksum, file: mig.file, appliedAt });
        currentVersion = mig.version;
        appliedCount++;
      }

      if (targetVersion > currentVersion) {
        activeConn.execute_json(`PRAGMA user_version = ${targetVersion}`, null);
        currentVersion = targetVersion;
      }

      return {
        conn: activeConn,
        migrated: appliedCount > 0,
        schemaVersion: currentVersion || 1,
        status: {
          dbKey,
          targetVersion: targetVersion || currentVersion || 1,
          currentVersion: currentVersion || 1,
          applied: [...appliedMap.values()].sort((a, b) => a.version - b.version),
        },
      };
    } catch (err) {
      // Restore the exact pre-upgrade snapshot so user records are never lost or half-migrated
      try { activeConn.close(); } catch { /* ignore */ }
      try { activeConn.free(); } catch { /* ignore */ }
      const restored = new this.bindings.WasmConnection(
        preUpgradeSnapshot,
        null,
        null,
        4096,
        connSteps,
        connMem,
        connPageReads
      );
      const message = err instanceof Error ? err.message : String(err);
      const status: SqlMigrationStatus = {
        dbKey,
        targetVersion: targetVersion || 1,
        currentVersion: currentVersion || 1,
        applied: [...appliedMap.values()].sort((a, b) => a.version - b.version),
        lastError: message,
      };
      // Wrap wasm-bindgen string errors in a real Error object so recovery metadata attaches cleanly.
      const wrapped = err instanceof Error ? err : new Error(`Migration failed for "${dbKey}": ${message}`);
      (wrapped as { _restoredConn?: XdbWasmConnection; _migrationStatus?: SqlMigrationStatus })._restoredConn = restored;
      (wrapped as { _restoredConn?: XdbWasmConnection; _migrationStatus?: SqlMigrationStatus })._migrationStatus = status;
      throw wrapped;
    }
  }

  private createConnection(dbKey: string, ephemeral: boolean): ManagedDb {
    if (ephemeral && this.ephemeralCount >= MAX_EPHEMERAL_DBS) {
      throw new Error(`Too many ephemeral in-memory SQLite databases open (max ${MAX_EPHEMERAL_DBS})`);
    }
    if (!ephemeral && !this.byKey.has(dbKey) && this.byKey.size >= this.maxOpenDbs) {
      throw new Error(`Too many distinct SQLite databases open (max ${this.maxOpenDbs})`);
    }
    const cfg = ephemeral ? undefined : this.findConfigForKey(dbKey);
    const persisted = ephemeral
      ? undefined
      : (Object.hasOwn(this.initialPersistedDbs, dbKey) ? this.initialPersistedDbs[dbKey] : undefined) ??
        (cfg && Object.hasOwn(this.initialPersistedDbs, cfg.name) ? this.initialPersistedDbs[cfg.name] : undefined);
    const persistedMeta = ephemeral
      ? undefined
      : (Object.hasOwn(this.initialPersistedMeta, dbKey) ? this.initialPersistedMeta[dbKey] : undefined) ??
        (cfg && Object.hasOwn(this.initialPersistedMeta, cfg.name) ? this.initialPersistedMeta[cfg.name] : undefined);

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
    let conn = new this.bindings.WasmConnection(
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

    let schemaVersion = persistedMeta?.schemaVersion ?? this.readUserVersion(conn);
    let migrationStatus: SqlMigrationStatus | undefined;
    let migrated = false;
    if (!ephemeral && cfg && Array.isArray(cfg.migrations) && cfg.migrations.length > 0) {
      try {
        const res = this.applyDeclaredMigrations(dbKey, conn, cfg, hydratedFromPersisted, connSteps, connMem, connPageReads);
        conn = res.conn;
        migrated = res.migrated;
        schemaVersion = res.schemaVersion;
        migrationStatus = res.status;
      } catch (err) {
        const restored = (err as { _restoredConn?: XdbWasmConnection })._restoredConn;
        const failedStatus = (err as { _migrationStatus?: SqlMigrationStatus })._migrationStatus;
        if (restored) {
          // Keep the pre-upgrade database intact and queryable on recovery while surfacing the error!
          const recovered: ManagedDb = {
            key: dbKey,
            conn: restored,
            persistent: cfg.persist ?? true,
            dirty: false,
            ephemeral: false,
            readOnly: false,
            revision: persistedMeta?.revision ?? 0,
            schemaVersion: failedStatus?.currentVersion ?? (schemaVersion || 1),
            lastChecksum: persistedMeta?.checksum,
            migrationStatus: failedStatus,
          };
          this.byKey.set(dbKey, recovered);
        }
        throw err;
      }
    } else if (schemaVersion === 0) {
      schemaVersion = cfg?.schemaVersion ?? 1;
    }

    const managed: ManagedDb = {
      key: dbKey,
      conn,
      persistent: !ephemeral && (cfg?.persist ?? true),
      dirty: seeded || migrated,
      ephemeral,
      readOnly: false,
      revision: persistedMeta?.revision ?? 0,
      schemaVersion,
      lastChecksum: persistedMeta?.checksum,
      migrationStatus,
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
  open(
    rawUrl: string,
    options?: { readOnly?: boolean }
  ): { id: number; readOnly?: boolean } | SqlErrorResult {
    if (this.disposed) return { error: 'SQLite manager is disposed', code: 21, unique: false };
    try {
      const { key, inMemory } = normalizeDbKey(rawUrl);
      const canonical = inMemory ? ':memory:' : this.resolveCanonicalKey(key);
      const wantsReadOnly = options?.readOnly === true;
      if (!inMemory && !wantsReadOnly) {
        const shared = this.sharedHandleByKey.get(canonical);
        const live = this.byKey.get(canonical);
        if (shared !== undefined && live && this.handles.get(shared) === live) return { id: shared };
      }
      if (this.handles.size >= MAX_OPEN_HANDLES) {
        return { error: `Too many open SQLite connection handles (max ${MAX_OPEN_HANDLES})`, code: 14, unique: false };
      }
      if (!inMemory && !this.byKey.has(canonical) && this.byKey.size >= this.maxOpenDbs) {
        return { error: `Too many distinct SQLite databases open (max ${this.maxOpenDbs})`, code: 14, unique: false };
      }
      const base = inMemory
        ? this.createConnection(':memory:', true)
        : this.byKey.get(canonical) ?? this.createConnection(canonical, false);
      if (wantsReadOnly && !inMemory) {
        // Return an independent read-only view wrapper around the live connection so writers stay unaffected
        const id = this.nextHandleId++;
        this.handles.set(id, { ...base, readOnly: true });
        return { id, readOnly: true };
      }
      if (wantsReadOnly) {
        base.readOnly = true;
        try { base.conn.execute_json('PRAGMA query_only = ON', null); } catch { /* enforced by host too */ }
      }
      const id = this.nextHandleId++;
      this.handles.set(id, base);
      if (!base.ephemeral && !wantsReadOnly) this.sharedHandleByKey.set(base.key, id);
      return { id, ...(wantsReadOnly ? { readOnly: true } : {}) };
    } catch (err) {
      return classifySqlError(err);
    }
  }

  /** Create a new isolated temporary (or named non-aliased) database handle. */
  createDatabase(options?: {
    temporary?: boolean;
    name?: string;
    readOnly?: boolean;
    workspaceId?: string;
  }): { id: number; readOnly: boolean; temporary: boolean; workspaceId?: string } | SqlErrorResult {
    if (this.disposed) return { error: 'SQLite manager is disposed', code: 21, unique: false };
    try {
      const workspaceId = options?.workspaceId;
      const ws = workspaceId ? this.workspaces.get(workspaceId) : undefined;
      if (workspaceId && !ws) {
        return { error: `Invalid SQLite workspace: ${workspaceId}`, code: 21, unique: false };
      }
      if (ws?.cancelled) {
        return { error: 'SQLite workspace operation was cancelled', code: 9, unique: false };
      }
      if (this.handles.size >= MAX_OPEN_HANDLES) {
        return { error: `Too many open SQLite connection handles (max ${MAX_OPEN_HANDLES})`, code: 14, unique: false };
      }
      const isTemporary = Boolean(ws) || options?.temporary !== false;
      if (!isTemporary && options?.name) {
        const opened = this.open(options.name, { readOnly: options.readOnly });
        if ('error' in opened) return opened;
        return { id: opened.id, readOnly: options.readOnly === true, temporary: false };
      }
      if (ws) {
        if (ws.handleIds.size >= ws.maxDatabases) {
          return { error: `Workspace database limit reached (max ${ws.maxDatabases})`, code: 14, unique: false };
        }
      } else if (this.ephemeralCount >= MAX_EPHEMERAL_DBS) {
        return { error: `Too many temporary SQLite databases open (max ${MAX_EPHEMERAL_DBS})`, code: 14, unique: false };
      }
      const connSteps = ws ? ws.maxSteps : EPHEMERAL_MAX_STEPS;
      const connMem = ws ? ws.maxMemoryBytes : (this.maxMemory < EPHEMERAL_MAX_MEMORY_BYTES ? this.maxMemory : EPHEMERAL_MAX_MEMORY_BYTES);
      const connPageReads = ws ? ws.maxPageReads : EPHEMERAL_MAX_PAGE_READS;
      const conn = new this.bindings.WasmConnection(null, null, null, 4096, connSteps, connMem, connPageReads);
      const readOnly = options?.readOnly === true;
      if (readOnly) {
        try { conn.execute_json('PRAGMA query_only = ON', null); } catch { /* host enforces too */ }
      }
      const id = this.nextHandleId++;
      const managed: ManagedDb = {
        key: ws ? `workspace:${ws.id}:${id}` : `temp:${id}`,
        conn,
        persistent: false,
        dirty: false,
        ephemeral: true,
        readOnly,
        workspaceId: ws?.id,
        revision: 0,
        schemaVersion: 1,
      };
      this.handles.set(id, managed);
      if (ws) ws.handleIds.add(id);
      else this.ephemeralCount++;
      return { id, readOnly, temporary: true, ...(ws ? { workspaceId: ws.id } : {}) };
    } catch (err) {
      return classifySqlError(err);
    }
  }

  /** Open an uploaded/provided binary SQLite database image as an isolated handle (zero aliasing). */
  importBytes(
    bytes: Uint8Array,
    options?: { readOnly?: boolean; temporary?: boolean; workspaceId?: string }
  ): { id: number; readOnly: boolean; temporary: boolean; byteLength: number; workspaceId?: string } | SqlErrorResult {
    if (this.disposed) return { error: 'SQLite manager is disposed', code: 21, unique: false };
    try {
      if (!(bytes instanceof Uint8Array)) {
        return { error: 'importBytes requires a Uint8Array SQLite database image', code: 21, unique: false };
      }
      const workspaceId = options?.workspaceId;
      const ws = workspaceId ? this.workspaces.get(workspaceId) : undefined;
      if (workspaceId && !ws) {
        return { error: `Invalid SQLite workspace: ${workspaceId}`, code: 21, unique: false };
      }
      if (ws?.cancelled) {
        return { error: 'SQLite workspace operation was cancelled', code: 9, unique: false };
      }
      const limit = ws ? ws.maxImportBytes : this.maxImportBytes;
      if (bytes.byteLength > limit) {
        return {
          error: `SQLite import (${bytes.byteLength} bytes) exceeds maximum allowed size (${limit} bytes)`,
          code: 18,
          unique: false,
        };
      }
      if (bytes.byteLength > 0) {
        const hdr = validateSqliteHeader(bytes);
        if (!hdr.valid) {
          return { error: hdr.reason ?? 'Invalid SQLite database header', code: 26, unique: false };
        }
      }
      if (this.handles.size >= MAX_OPEN_HANDLES) {
        return { error: `Too many open SQLite connection handles (max ${MAX_OPEN_HANDLES})`, code: 14, unique: false };
      }
      if (ws) {
        if (ws.handleIds.size >= ws.maxDatabases) {
          return { error: `Workspace database limit reached (max ${ws.maxDatabases})`, code: 14, unique: false };
        }
      } else if (this.ephemeralCount >= MAX_EPHEMERAL_DBS) {
        return { error: `Too many temporary SQLite databases open (max ${MAX_EPHEMERAL_DBS})`, code: 14, unique: false };
      }
      const connSteps = ws ? ws.maxSteps : EPHEMERAL_MAX_STEPS;
      const connMem = ws ? ws.maxMemoryBytes : (this.maxMemory < EPHEMERAL_MAX_MEMORY_BYTES ? this.maxMemory : EPHEMERAL_MAX_MEMORY_BYTES);
      const connPageReads = ws ? ws.maxPageReads : EPHEMERAL_MAX_PAGE_READS;
      const copy = bytes.byteLength > 0 ? bytes.slice() : null;
      const conn = new this.bindings.WasmConnection(copy, null, null, 4096, connSteps, connMem, connPageReads);
      const readOnly = options?.readOnly === true;
      if (readOnly) {
        try { conn.execute_json('PRAGMA query_only = ON', null); } catch { /* host enforces too */ }
      }
      const id = this.nextHandleId++;
      const managed: ManagedDb = {
        key: ws ? `workspace:${ws.id}:${id}` : `import:${id}`,
        conn,
        persistent: false,
        dirty: false,
        ephemeral: true,
        readOnly,
        workspaceId: ws?.id,
        revision: 0,
        schemaVersion: this.readUserVersion(conn) || 1,
      };
      this.handles.set(id, managed);
      if (ws) ws.handleIds.add(id);
      else this.ephemeralCount++;
      return {
        id,
        readOnly,
        temporary: options?.temporary !== false,
        byteLength: bytes.byteLength,
        ...(ws ? { workspaceId: ws.id } : {}),
      };
    } catch (err) {
      return classifySqlError(err);
    }
  }

  /** Create an isolated workspace with host-enforced database, memory, and execution budgets. */
  createWorkspace(
    budget?: SqliteWorkspaceBudget
  ): { id: string; workspaceId: string; limits: Required<SqliteWorkspaceBudget> } | SqlErrorResult {
    if (this.disposed) return { error: 'SQLite manager is disposed', code: 21, unique: false };
    if (this.workspaces.size >= PLATFORM_MAX_WORKSPACES) {
      return { error: `Too many active SQLite workspaces (max ${PLATFORM_MAX_WORKSPACES})`, code: 14, unique: false };
    }
    const maxDatabases = Math.max(
      1,
      Math.min(
        typeof budget?.maxDatabases === 'number' && Number.isInteger(budget.maxDatabases) && budget.maxDatabases > 0
          ? budget.maxDatabases
          : this.maxWorkspaceDbs,
        this.maxWorkspaceDbs,
        PLATFORM_MAX_WORKSPACE_DBS
      )
    );
    const maxMemoryNum = Math.max(
      4 * 1024 * 1024,
      Math.min(
        typeof budget?.maxMemoryBytes === 'number' && Number.isFinite(budget.maxMemoryBytes) && budget.maxMemoryBytes > 0
          ? Math.floor(budget.maxMemoryBytes)
          : Number(EPHEMERAL_MAX_MEMORY_BYTES),
        Number(PLATFORM_MAX_WORKSPACE_MEMORY)
      )
    );
    const maxStepsNum = Math.max(
      100_000,
      Math.min(
        typeof budget?.maxSteps === 'number' && Number.isFinite(budget.maxSteps) && budget.maxSteps > 0
          ? Math.floor(budget.maxSteps)
          : Number(EPHEMERAL_MAX_STEPS),
        Number(PLATFORM_MAX_WORKSPACE_STEPS)
      )
    );
    const maxPageReadsNum = Math.max(
      10_000,
      Math.min(
        typeof budget?.maxPageReads === 'number' && Number.isFinite(budget.maxPageReads) && budget.maxPageReads > 0
          ? Math.floor(budget.maxPageReads)
          : Number(EPHEMERAL_MAX_PAGE_READS),
        Number(PLATFORM_MAX_WORKSPACE_PAGE_READS)
      )
    );
    const maxImportBytes = Math.max(
      64 * 1024,
      Math.min(
        typeof budget?.maxImportBytes === 'number' && Number.isFinite(budget.maxImportBytes) && budget.maxImportBytes > 0
          ? Math.floor(budget.maxImportBytes)
          : this.maxImportBytes,
        this.maxImportBytes,
        PLATFORM_MAX_IMPORT_BYTES
      )
    );
    const id = `ws_${this.nextWorkspaceSeq++}`;
    this.workspaces.set(id, {
      id,
      maxDatabases,
      maxMemoryBytes: BigInt(maxMemoryNum),
      maxSteps: BigInt(maxStepsNum),
      maxPageReads: BigInt(maxPageReadsNum),
      maxImportBytes,
      handleIds: new Set<number>(),
      cancelled: false,
    });
    return {
      id,
      workspaceId: id,
      limits: {
        maxDatabases,
        maxMemoryBytes: maxMemoryNum,
        maxSteps: maxStepsNum,
        maxPageReads: maxPageReadsNum,
        maxImportBytes,
      },
    };
  }

  /** Mark a workspace cancelled so subsequent migration batches fail fast cleanly. */
  cancelWorkspace(workspaceId: string): { ok: true; cancelled: boolean } | SqlErrorResult {
    const ws = this.workspaces.get(workspaceId);
    if (!ws) return { error: `Invalid SQLite workspace: ${workspaceId}`, code: 21, unique: false };
    ws.cancelled = true;
    return { ok: true, cancelled: true };
  }

  /** Dispose an entire workspace and release every database connection it owns. */
  disposeWorkspace(workspaceId: string): { ok: true; disposed: true; disposedHandles: number; closedHandles: number } {
    const ws = this.workspaces.get(workspaceId);
    if (!ws) return { ok: true, disposed: true, disposedHandles: 0, closedHandles: 0 };
    let count = 0;
    for (const hid of [...ws.handleIds]) {
      const res = this.disposeHandle(hid);
      if (res.disposed) count++;
    }
    this.workspaces.delete(workspaceId);
    return { ok: true, disposed: true, disposedHandles: count, closedHandles: count };
  }

  /** Create an isolated copy of an existing handle's committed database image. */
  cloneHandle(
    handleId: number,
    options?: { readOnly?: boolean; workspaceId?: string }
  ): { id: number; readOnly: boolean; temporary: boolean; byteLength: number; workspaceId?: string } | SqlErrorResult {
    const source = this.handles.get(handleId);
    if (!source) return { error: `invalid sqlite connection handle ${handleId}`, code: 21, unique: false };
    if (source.workspaceId && this.workspaces.get(source.workspaceId)?.cancelled) {
      return { error: 'SQLite workspace operation was cancelled', code: 9, unique: false };
    }
    try {
      if (source.conn.in_transaction()) {
        return { error: 'Cannot clone database while a transaction is active; commit or rollback first', code: 5, unique: false };
      }
      const bytes = source.conn.export_bytes();
      return this.importBytes(bytes, {
        readOnly: options?.readOnly === true,
        temporary: true,
        workspaceId: options?.workspaceId ?? source.workspaceId,
      });
    } catch (err) {
      return classifySqlError(err);
    }
  }

  /** Explicitly release a handle (frees WASM resources immediately for temporary/workspace handles). */
  disposeHandle(handleId: number): { ok: true; disposed: boolean } {
    const managed = this.handles.get(handleId);
    if (!managed) return { ok: true, disposed: false };
    // Never destroy a persistent database's shared live backing connection on handle dispose;
    // flush dirty state and keep shared named DB intact for other callers.
    if (!managed.ephemeral && this.sharedHandleByKey.get(managed.key) === handleId) {
      return { ok: true, disposed: false };
    }
    this.handles.delete(handleId);
    if (managed.workspaceId) {
      const ws = this.workspaces.get(managed.workspaceId);
      ws?.handleIds.delete(handleId);
    }
    if (managed.ephemeral) {
      if (!managed.workspaceId) {
        this.ephemeralCount = Math.max(0, this.ephemeralCount - 1);
      }
      try { managed.conn.close(); } catch { /* ignore */ }
      try { managed.conn.free(); } catch { /* ignore */ }
      return { ok: true, disposed: true };
    }
    return { ok: true, disposed: true };
  }

  private checkHandleUsable(managed: ManagedDb, sql: string): SqlErrorResult | null {
    if (managed.workspaceId && this.workspaces.get(managed.workspaceId)?.cancelled) {
      return { error: 'SQLite workspace operation was cancelled', code: 9, unique: false };
    }
    if (managed.readOnly && isWriteStatement(sql)) {
      return { error: 'attempt to write a readonly database', code: 8, unique: false };
    }
    return null;
  }

  /** Execute a statement (`INSERT`/`UPDATE`/`DELETE`/`CREATE`/`PRAGMA`/etc.). */
  execute(
    handleId: number,
    sql: string,
    paramsJson?: string,
    hooks?: XdbBudgetHooks,
    options?: SqlExecuteOptions
  ): { rows_affected: number; last_insert_rowid: number; lastInsertRowid: string } | SqlErrorResult {
    const managed = this.handles.get(handleId);
    if (!managed) return { error: `invalid sqlite connection handle ${handleId}`, code: 21, unique: false };
    const blocked = this.checkHandleUsable(managed, sql);
    if (blocked) return blocked;
    const before = hooks?.hostChargeSteps ? readMeterSteps(managed.conn) : 0;
    const changesBefore = Number(managed.conn.total_changes());
    try {
      const encodedParams = normalizeSqlParamsJson(paramsJson, options);
      const raw = managed.conn.execute_json(sql, encodedParams);
      this.chargeDelta(managed.conn, before, hooks);
      if (raw.length > MAX_SQL_RESULT_JSON_CHARS) {
        return { error: 'SQLite result exceeds maximum serialized size limit', code: 18, unique: false };
      }
      const parsed = parseXdbResultJson(raw, options?.valueMode ?? 'legacy');
      if (isWriteStatement(sql) || Number(managed.conn.total_changes()) !== changesBefore) {
        managed.dirty = true;
      }
      let exactRowid = parsed.lastInsertRowid;
      try {
        exactRowid = BigInt(managed.conn.last_insert_rowid()).toString();
      } catch {
        // fallback to parsed token
      }
      return {
        rows_affected: parsed.changes,
        last_insert_rowid: Number(exactRowid),
        lastInsertRowid: exactRowid,
      };
    } catch (err) {
      this.chargeDelta(managed.conn, before, hooks);
      this.markDirtyAfterFailure(managed, sql, changesBefore);
      return classifySqlError(err);
    }
  }

  /**
   * A batch that fails part-way keeps the statements that ran before the failing one
   * (each commits on its own outside a transaction), so the saved image must take them.
   */
  private markDirtyAfterFailure(managed: ManagedDb, sql: string, changesBefore: number): void {
    if (managed.readOnly) return;
    try {
      if (Number(managed.conn.total_changes()) !== changesBefore || (isWriteStatement(sql) && hasFollowingStatement(sql))) {
        managed.dirty = true;
      }
    } catch {
      managed.dirty = true;
    }
  }

  /** Execute a query returning `{ columns, rows }` (also handles DDL/DML with `RETURNING` or `PRAGMA`). */
  query(
    handleId: number,
    sql: string,
    paramsJson?: string,
    hooks?: XdbBudgetHooks,
    options?: SqlExecuteOptions
  ): { columns: string[]; rows: SqlValue[][] } | SqlErrorResult {
    const managed = this.handles.get(handleId);
    if (!managed) return { error: `invalid sqlite connection handle ${handleId}`, code: 21, unique: false };
    const blocked = this.checkHandleUsable(managed, sql);
    if (blocked) return blocked;
    const before = hooks?.hostChargeSteps ? readMeterSteps(managed.conn) : 0;
    const changesBefore = Number(managed.conn.total_changes());
    try {
      const encodedParams = normalizeSqlParamsJson(paramsJson, options);
      const raw = managed.conn.execute_json(sql, encodedParams);
      this.chargeDelta(managed.conn, before, hooks);
      if (raw.length > MAX_SQL_RESULT_JSON_CHARS) {
        return { error: 'SQLite query result exceeds maximum serialized size limit', code: 18, unique: false };
      }
      const mode: SqlValueMode = options?.valueMode ?? 'legacy';
      const parsed = parseXdbResultJson(raw, mode);
      if (parsed.rows.length > MAX_SQL_RESULT_ROWS) {
        return { error: `SQLite query returned more than ${MAX_SQL_RESULT_ROWS} rows`, code: 18, unique: false };
      }
      if (isWriteStatement(sql) || Number(managed.conn.total_changes()) !== changesBefore) {
        managed.dirty = true;
      }
      return {
        columns: parsed.columns,
        rows: parsed.rows,
      };
    } catch (err) {
      this.chargeDelta(managed.conn, before, hooks);
      this.markDirtyAfterFailure(managed, sql, changesBefore);
      return classifySqlError(err);
    }
  }

  /** Inspect structured database metadata (tables, columns, keys, foreign keys, indexes, views, triggers). */
  getSchema(handleId: number): SqlSchemaMetadata | SqlErrorResult {
    const managed = this.handles.get(handleId);
    if (!managed) return { error: `invalid sqlite connection handle ${handleId}`, code: 21, unique: false };
    if (managed.workspaceId && this.workspaces.get(managed.workspaceId)?.cancelled) {
      return { error: 'SQLite workspace operation was cancelled', code: 9, unique: false };
    }
    try {
      const master = parseXdbResultJson(
        managed.conn.execute_json(
          "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
          null
        ),
        'lossless'
      );
      const tables: SqlTableSchema[] = [];
      const allIndexes: SqlIndexInfo[] = [];
      const views: Array<{ name: string; sql: string | null }> = [];
      const triggers: Array<{ name: string; table: string; sql: string | null }> = [];
      const indexSqlByName = new Map<string, string | null>();

      for (const row of master.rows) {
        const type = String(row[0] ?? '').toLowerCase();
        const name = String(row[1] ?? '');
        const tblName = String(row[2] ?? '');
        const sql = row[3] != null ? String(row[3]) : null;
        if (type === 'index') {
          indexSqlByName.set(name, sql);
        } else if (type === 'view') {
          views.push({ name, sql });
        } else if (type === 'trigger') {
          triggers.push({ name, table: tblName, sql });
        }
      }

      for (const row of master.rows) {
        const type = String(row[0] ?? '').toLowerCase();
        if (type !== 'table') continue;
        const tableName = String(row[1] ?? '');
        const tableSql = row[3] != null ? String(row[3]) : null;

        const colsRes = parseXdbResultJson(
          managed.conn.execute_json(`PRAGMA table_info(${quoteIdent(tableName)})`, null),
          'lossless'
        );
        const columns: SqlColumnInfo[] = colsRes.rows.map((r) => ({
          cid: Number(r[0] ?? 0),
          name: String(r[1] ?? ''),
          type: String(r[2] ?? ''),
          notNull: Number(r[3] ?? 0) !== 0,
          defaultValue: (r[4] ?? null) as SqlValue,
          primaryKey: Number(r[5] ?? 0),
        }));
        const primaryKey = columns
          .filter((c) => c.primaryKey > 0)
          .sort((a, b) => a.primaryKey - b.primaryKey)
          .map((c) => c.name);

        // Foreign keys via PRAGMA foreign_key_list with DDL fallback
        let foreignKeys: SqlForeignKeyInfo[] = [];
        try {
          const fkRes = parseXdbResultJson(
            managed.conn.execute_json(`PRAGMA foreign_key_list(${quoteIdent(tableName)})`, null),
            'legacy'
          );
          foreignKeys = fkRes.rows.map((r) => ({
            id: Number(r[0] ?? 0),
            seq: Number(r[1] ?? 0),
            table: String(r[2] ?? ''),
            from: String(r[3] ?? ''),
            to: String(r[4] ?? ''),
            onUpdate: String(r[5] ?? 'NO ACTION'),
            onDelete: String(r[6] ?? 'NO ACTION'),
          }));
        } catch {
          foreignKeys = [];
        }
        if (foreignKeys.length === 0 && tableSql) {
          foreignKeys = parseForeignKeysFromCreateTableSql(tableSql);
        }

        // Indexes via PRAGMA index_list + PRAGMA index_info
        const tableIndexes: SqlIndexInfo[] = [];
        try {
          const idxList = parseXdbResultJson(
            managed.conn.execute_json(`PRAGMA index_list(${quoteIdent(tableName)})`, null),
            'legacy'
          );
          for (const idxRow of idxList.rows) {
            const idxName = String(idxRow[1] ?? '');
            const unique = Number(idxRow[2] ?? 0) !== 0;
            const idxCols: string[] = [];
            try {
              const info = parseXdbResultJson(
                managed.conn.execute_json(`PRAGMA index_info(${quoteIdent(idxName)})`, null),
                'legacy'
              );
              for (const infoRow of info.rows) {
                if (infoRow[2] != null) idxCols.push(String(infoRow[2]));
              }
            } catch {
              // ignore
            }
            const idxMeta: SqlIndexInfo = {
              name: idxName,
              table: tableName,
              unique,
              columns: idxCols,
              sql: indexSqlByName.get(idxName) ?? null,
            };
            tableIndexes.push(idxMeta);
            allIndexes.push(idxMeta);
          }
        } catch {
          // ignore
        }

        tables.push({
          name: tableName,
          sql: tableSql,
          columns,
          primaryKey,
          foreignKeys,
          indexes: tableIndexes,
        });
      }

      // Include any standalone CREATE INDEX entries not surfaced by PRAGMA index_list
      for (const row of master.rows) {
        if (String(row[0] ?? '').toLowerCase() !== 'index') continue;
        const idxName = String(row[1] ?? '');
        const tblName = String(row[2] ?? '');
        const sql = row[3] != null ? String(row[3]) : null;
        if (!allIndexes.some((idx) => idx.name === idxName)) {
          const unique = Boolean(sql && /\bCREATE\s+UNIQUE\s+INDEX\b/i.test(sql));
          const colMatch = sql ? /\(([^)]+)\)/.exec(sql) : null;
          const cols = colMatch
            ? colMatch[1].split(',').map((s) => s.trim().replace(/^["`[]|["`\]]$/g, '').split(/\s+/)[0]).filter(Boolean)
            : [];
          const meta: SqlIndexInfo = { name: idxName, table: tblName, unique, columns: cols, sql };
          allIndexes.push(meta);
          const tbl = tables.find((t) => t.name === tblName);
          if (tbl) tbl.indexes.push(meta);
        }
      }

      return {
        tables,
        indexes: allIndexes,
        views,
        triggers,
        pageSize: managed.conn.page_size(),
        pageCount: managed.conn.page_count(),
        userVersion: this.readUserVersion(managed.conn),
        schemaVersion: managed.schemaVersion,
      };
    } catch (err) {
      return classifySqlError(err);
    }
  }

  /** Perform structural, B-tree, and optional relational integrity checks on a handle. */
  integrityCheck(
    handleId: number,
    options?: { checkForeignKeys?: boolean }
  ): SqlIntegrityReport | SqlErrorResult {
    const managed = this.handles.get(handleId);
    if (!managed) return { error: `invalid sqlite connection handle ${handleId}`, code: 21, unique: false };
    const messages: string[] = [];
    let headerValid = true;
    let pragmaOk = true;

    try {
      const bytes = managed.conn.export_bytes();
      const hdr = validateSqliteHeader(bytes);
      if (!hdr.valid) {
        headerValid = false;
        messages.push(hdr.reason ?? 'Invalid SQLite file header');
      }
    } catch (err) {
      headerValid = false;
      messages.push(`Failed to export database image: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      const res = parseXdbResultJson(managed.conn.execute_json('PRAGMA integrity_check', null), 'legacy');
      const vals = res.rows.map((r) => String(r[0] ?? ''));
      if (vals.length === 0 || (vals.length === 1 && vals[0].toLowerCase() === 'ok')) {
        pragmaOk = true;
      } else {
        pragmaOk = false;
        messages.push(...vals);
      }
    } catch (err) {
      pragmaOk = false;
      messages.push(`PRAGMA integrity_check failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    const foreignKeyViolations: SqlIntegrityReport['foreignKeyViolations'] = [];
    let foreignKeysChecked = false;
    const schema = this.getSchema(handleId);
    if (!('error' in schema)) {
      for (const tbl of schema.tables) {
        try {
          managed.conn.execute_json(`SELECT COUNT(*) FROM ${quoteIdent(tbl.name)}`, null);
        } catch (err) {
          pragmaOk = false;
          messages.push(`Table "${tbl.name}" failed scan: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (options?.checkForeignKeys !== false) {
        foreignKeysChecked = true;
        const tableNames = new Set(schema.tables.map((t) => t.name.toLowerCase()));
        for (const tbl of schema.tables) {
          for (const fk of tbl.foreignKeys) {
            if (!tableNames.has(fk.table.toLowerCase())) {
              foreignKeyViolations.push({
                table: tbl.name,
                column: fk.from,
                referencesTable: fk.table,
                referencesColumn: fk.to,
                count: 1,
              });
              messages.push(`Foreign key on ${tbl.name}.${fk.from} references missing table ${fk.table}`);
              continue;
            }
            try {
              const orphanSql = `SELECT COUNT(*) FROM ${quoteIdent(tbl.name)} c LEFT JOIN ${quoteIdent(fk.table)} p ON c.${quoteIdent(fk.from)} = p.${quoteIdent(fk.to)} WHERE c.${quoteIdent(fk.from)} IS NOT NULL AND p.${quoteIdent(fk.to)} IS NULL`;
              const orphanRes = parseXdbResultJson(managed.conn.execute_json(orphanSql, null), 'legacy');
              const count = Number(orphanRes.rows[0]?.[0] ?? 0);
              if (count > 0) {
                foreignKeyViolations.push({
                  table: tbl.name,
                  column: fk.from,
                  referencesTable: fk.table,
                  referencesColumn: fk.to,
                  count,
                });
                messages.push(`Foreign key violation: ${count} row(s) in ${tbl.name}.${fk.from} reference missing ${fk.table}.${fk.to}`);
              }
            } catch (err) {
              messages.push(`Foreign key check on ${tbl.name}.${fk.from} failed: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        }
      }
    } else {
      pragmaOk = false;
      messages.push(`Schema inspection failed: ${schema.error}`);
    }

    const ok = headerValid && pragmaOk && foreignKeyViolations.length === 0;
    if (ok && messages.length === 0) messages.push('ok');
    return {
      ok,
      headerValid,
      pragmaOk,
      messages,
      foreignKeysChecked,
      foreignKeyViolations,
    };
  }

  /** Export a consistent binary SQLite snapshot with revision, checksum, and schema metadata. */
  exportSnapshot(
    handleOrKey: number | string,
    options?: { consistency?: 'committed' | 'immediate' }
  ): SqlSnapshotResult | SqlErrorResult {
    const managed = typeof handleOrKey === 'number'
      ? this.handles.get(handleOrKey)
      : this.byKey.get(this.resolveCanonicalKey(handleOrKey));
    if (!managed) return { error: `SQLite database or handle '${handleOrKey}' not found`, code: 21, unique: false };
    const consistency = options?.consistency ?? 'committed';
    if (consistency === 'committed' && managed.conn.in_transaction()) {
      return {
        error: 'Cannot export committed SQLite snapshot while a transaction is active; commit or rollback first',
        code: 5,
        unique: false,
      };
    }
    try {
      const bytes = managed.conn.export_bytes();
      const checksum = sha256HexSync(bytes);
      return {
        bytes,
        byteLength: bytes.byteLength,
        checksum,
        revision: managed.revision,
        schemaVersion: managed.schemaVersion,
        consistency,
        pageSize: managed.conn.page_size(),
        pageCount: managed.conn.page_count(),
      };
    } catch (err) {
      return classifySqlError(err);
    }
  }

  /** Export raw SQLite `.db` bytes from an open handle ID (supports temporary, workspace, and named DBs). */
  exportBytesByHandle(
    handleId: number,
    options?: { consistency?: 'committed' | 'immediate' }
  ): { bytes: Uint8Array } | SqlErrorResult {
    const snap = this.exportSnapshot(handleId, options);
    if ('error' in snap) return snap;
    return { bytes: snap.bytes };
  }

  /** Return the migration status ledger for a named database or handle. */
  getMigrationStatus(handleOrKey: number | string): SqlMigrationStatus | SqlErrorResult {
    const managed = typeof handleOrKey === 'number'
      ? this.handles.get(handleOrKey)
      : this.byKey.get(this.resolveCanonicalKey(handleOrKey));
    if (!managed) return { error: `SQLite database or handle '${handleOrKey}' not found`, code: 21, unique: false };
    if (managed.migrationStatus) return managed.migrationStatus;
    return {
      dbKey: managed.key,
      targetVersion: managed.schemaVersion,
      currentVersion: managed.schemaVersion,
      applied: [],
    };
  }

  /** Resolve a handle's canonical dbKey (for flush/persistence queries). */
  getKeyForHandle(handleId: number): string | null {
    const managed = this.handles.get(handleId);
    return managed ? managed.key : null;
  }

  /** Apply declarative JSON seed data to an open handle or named database. */
  seedJson(
    handleOrKey: number | string,
    seedJson: string | Record<string, unknown>,
    hooks?: XdbBudgetHooks
  ): { tablesCreated: number; tablesSeeded: number; rowsInserted: number; statementsExecuted: number } | SqlErrorResult {
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
    if (managed.readOnly) return { error: 'attempt to write a readonly database', code: 8, unique: false };
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
      // A seed that fails part-way has already created or filled what came before.
      managed.dirty = true;
      return classifySqlError(err);
    }
  }

  /** Close a connection handle (ephemeral/workspace handles are freed immediately; persistent ones flush via `BackendWorkerSession`). */
  close(handleId: number): { ok: true } {
    this.disposeHandle(handleId);
    return { ok: true };
  }

  /**
   * Mark the start of one backend request. The native hosts give each request connections of
   * its own: what a request opens, and a transaction it leaves open, ends with the request.
   */
  beginRequestScope(): SqlRequestScope {
    const openTransactions = new Set<string>();
    for (const m of this.byKey.values()) {
      try {
        if (m.conn.in_transaction()) openTransactions.add(m.key);
      } catch {
        // ignore
      }
    }
    return { firstHandleId: this.nextHandleId, openTransactions, ended: false };
  }

  /**
   * End a request begun with `beginRequestScope`: roll back a transaction it began and never
   * finished (as dropping its connection does on the native hosts, and as PDO does when a
   * script ends), and with `releaseHandles` close the in-memory databases it opened.
   */
  endRequestScope(scope: SqlRequestScope, releaseHandles: boolean): void {
    if (scope.ended || this.disposed) return;
    scope.ended = true;
    for (const m of this.byKey.values()) {
      if (scope.openTransactions.has(m.key)) continue;
      try {
        if (m.conn.in_transaction()) m.conn.execute_json('ROLLBACK', null);
      } catch {
        // ignore
      }
    }
    if (!releaseHandles) return;
    for (const [id, m] of this.handles) {
      if (id >= scope.firstHandleId && m.ephemeral && !m.workspaceId) this.close(id);
    }
  }

  /** Flush all dirty persistent databases that are not mid-transaction, returning snapshots. */
  flushDirty(onlyDbKey?: string): Array<{ dbKey: string; bytes: Uint8Array; meta: XdbPersistMeta }> {
    const flushed: Array<{ dbKey: string; bytes: Uint8Array; meta: XdbPersistMeta }> = [];
    for (const managed of this.byKey.values()) {
      if (onlyDbKey && managed.key !== onlyDbKey) continue;
      if (managed.dirty && managed.persistent && !managed.conn.in_transaction()) {
        const snap = this.flushOne(managed);
        if (snap) flushed.push({ dbKey: managed.key, bytes: snap.bytes, meta: snap.meta });
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
  ): { bytes: number } | SqlErrorResult {
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
      if (!this.byKey.has(dstKey) && this.byKey.size >= this.maxOpenDbs) {
        return { error: `Too many distinct SQLite databases open (max ${this.maxOpenDbs})`, code: 14, unique: false };
      }

      const existing = this.byKey.get(dstKey);
      if (existing) {
        for (const [hid, m] of this.handles) {
          if (m === existing) this.handles.delete(hid);
        }
        try { existing.conn.close(); } catch { /* ignore */ }
        try { existing.conn.free(); } catch { /* ignore */ }
        this.byKey.delete(dstKey);
        this.sharedHandleByKey.delete(dstKey);
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
        readOnly: false,
        revision: 0,
        schemaVersion: srcManaged.schemaVersion,
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
  remove(rawUrl: string): { ok: true; removed: boolean } | SqlErrorResult {
    if (this.disposed) return { ok: true, removed: false };
    const { key, inMemory } = normalizeDbKey(rawUrl);
    if (inMemory) return { ok: true, removed: false };
    if (/(?:-wal|-shm|-journal)$/i.test(key)) {
      return { ok: true, removed: true };
    }
    const lower = key.toLowerCase();
    const baseOf = (k: string) => k.slice(k.lastIndexOf('/') + 1);
    const configured = this.databases.some((cfg) => {
      const cfgKey = normalizeDbKey(cfg.file || cfg.name).key.toLowerCase();
      return cfgKey === lower || baseOf(cfgKey) === baseOf(lower);
    });
    if (configured) {
      return { error: 'cannot remove configured primary database', code: 1, unique: false };
    }
    const existing = this.byKey.get(key);
    if (!existing) return { ok: true, removed: false };
    for (const [hid, m] of this.handles) {
      if (m === existing) this.handles.delete(hid);
    }
    this.byKey.delete(key);
    this.sharedHandleByKey.delete(key);
    try { existing.conn.close(); } catch { /* ignore */ }
    try { existing.conn.free(); } catch { /* ignore */ }
    this.onRemove?.(key);
    return { ok: true, removed: true };
  }

  private flushOne(managed: ManagedDb): { bytes: Uint8Array; meta: XdbPersistMeta } | null {
    try {
      const bytes = managed.conn.export_bytes();
      const checksum = sha256HexSync(bytes);
      managed.revision += 1;
      managed.lastChecksum = checksum;
      managed.dirty = false;
      const meta: XdbPersistMeta = {
        revision: managed.revision,
        checksum,
        schemaVersion: managed.schemaVersion,
      };
      this.onPersist?.(managed.key, bytes, meta);
      return { bytes, meta };
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
    this.workspaces.clear();
    this.sharedHandleByKey.clear();
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
