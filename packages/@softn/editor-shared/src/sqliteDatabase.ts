/**
 * Shared XDB SQLite 3 database inspection, schema manipulation, and CRUD helpers
 * for SoftN Builder, SoftN AI Studio's Data tab, and Studio's AI agent harness.
 *
 * Uses the real pure-safe-Rust XDB SQLite 3 WASM engine (`@softn/container`)
 * so every DDL/DML edit runs against the exact same SQLite engine that executes
 * inside SoftN containers and writes standard `.db` bytes back into `.softn` bundles.
 */

import type { DatabaseConfig, LoadedXdbBindings, XdbWasmConnection } from '@softn/container';

type LoadXdbWasm = typeof import('@softn/container').loadXdbWasm;

/**
 * The engine's loader, imported when a database is first opened: a static
 * import of @softn/container put all of it (about 460 KB) in the first load of
 * every editor screen that can reach a database, Studio's agent tools and Data
 * tab among them, though most visits never open one. Every caller awaits the
 * engine already, and the container is the same chunk the previews import.
 */
async function loadXdbWasm(...args: Parameters<LoadXdbWasm>): ReturnType<LoadXdbWasm> {
  const { loadXdbWasm: load } = await import('@softn/container');
  return load(...args);
}

export interface ProjectSqliteDatabase {
  /** Stable identifier for the DB selector. */
  id: string;
  /** Logical display name (e.g. `brewdesk`, `app`). */
  name: string;
  /** Bundle-relative `.db` / `.sqlite` path where binary bytes live. */
  file: string;
  /** Optional SQL migration/seed path(s) in the project. */
  seedSqlPaths: string[];
  /** Optional declarative JSON seed path in the project. */
  seedJsonPath?: string;
  /** True when binary SQLite bytes already exist in the bundle. */
  hasBinary: boolean;
  /** Current binary bytes from the project bundle, if any. */
  initialBytes: Uint8Array | null;
  /** Optional WAL bytes beside the DB file, if present. */
  walBytes: Uint8Array | null;
  /** Optional rollback journal bytes beside the DB file, if present. */
  journalBytes: Uint8Array | null;
}

export interface SqliteFileIndex {
  manifest: Record<string, unknown> | null;
  textFiles: ReadonlyMap<string, string>;
  binaryFiles: ReadonlyMap<string, Uint8Array>;
}

export interface SqliteManifestFallbackMeta {
  name?: string;
  version?: string;
  description?: string;
}

export interface SqliteTableSummary {
  name: string;
  type: 'table' | 'view';
  sql: string;
  rowCount: number;
}

export interface SqliteColumnInfo {
  cid: number;
  name: string;
  type: string;
  notnull: boolean;
  dfltValue: string | null;
  pk: number;
}

export interface SqliteIndexInfo {
  name: string;
  unique: boolean;
  origin: string;
  columns: string[];
}

export interface SqliteForeignKeyInfo {
  id: number;
  table: string;
  from: string;
  to: string;
  onUpdate: string;
  onDelete: string;
}

export interface SqliteTableStructure {
  name: string;
  type: 'table' | 'view';
  sql: string;
  columns: SqliteColumnInfo[];
  indexes: SqliteIndexInfo[];
  foreignKeys: SqliteForeignKeyInfo[];
  hasRowid: boolean;
  pkColumns: string[];
}

/**
 * A row's rowid: a number while a number holds it exactly, and past 2^53 its
 * digits as text. Read as a number, 9007199254740993 came back as ...992,
 * which is another row's, and Browse's Edit and Delete changed that row.
 */
export type SqliteRowid = number | string;

export interface SqliteBrowseResult {
  columns: string[];
  /** Rows in column order; `rowid` is tracked separately when available. */
  rows: Array<{ rowid: SqliteRowid | null; values: unknown[] }>;
  totalRows: number;
  page: number;
  pageSize: number;
  hasRowid: boolean;
  pkColumns: string[];
}

export interface SqliteNewColumnSpec {
  name: string;
  type: string;
  primaryKey?: boolean;
  autoIncrement?: boolean;
  notNull?: boolean;
  unique?: boolean;
  defaultValue?: string;
}

export interface SqliteExecResult {
  columns: string[];
  rows: unknown[][];
  changes: number;
  lastInsertRowid: number;
}

export const SQLITE_DB_FILE_RE = /\.(?:db|sqlite|sqlite3)$/i;
const SQL_FILE_RE = /\.sql$/i;

export function normalizeSqlitePath(p: string): string {
  return String(p || '').replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/^\/+/, '');
}

export function quoteSqlIdent(ident: string): string {
  const clean = String(ident ?? '');
  if (!clean) throw new Error('Identifier cannot be empty.');
  return `"${clean.replace(/"/g, '""')}"`;
}

/** A rowid read as text (`CAST(rowid AS TEXT)`): a number while a number holds it exactly, else the digits. */
function rowidRead(raw: unknown): SqliteRowid | null {
  if (raw === null || raw === undefined) return null;
  const text = String(raw);
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : text;
}

/**
 * A rowid as it is bound in a WHERE: a finite number, or the digits of one a
 * number cannot hold, which SQLite compares with the rowid as the integer they
 * spell. Null for anything else.
 */
function rowidBound(rowid: SqliteRowid | null | undefined): SqliteRowid | null {
  if (typeof rowid === 'number') return Number.isFinite(rowid) ? rowid : null;
  return typeof rowid === 'string' && /^-?\d+$/.test(rowid) ? rowid : null;
}

/** The hex digits of a BLOB value in the engine's JSON form, or null for anything else. */
function blobHexOf(val: unknown): string | null {
  if (!val || typeof val !== 'object' || Array.isArray(val)) return null;
  const keys = Object.keys(val);
  const hex = (val as { hex?: unknown }).hex;
  return keys.length === 1 && typeof hex === 'string' && /^(?:[0-9a-fA-F]{2})*$/.test(hex) ? hex : null;
}

export function formatSqlLiteral(val: unknown): string {
  if (val === null || val === undefined) return 'NULL';
  if (typeof val === 'number') return Number.isFinite(val) ? String(val) : 'NULL';
  if (typeof val === 'boolean') return val ? '1' : '0';
  if (val instanceof Uint8Array) {
    let hex = '';
    for (let i = 0; i < val.length; i++) hex += val[i].toString(16).padStart(2, '0');
    return `X'${hex}'`;
  }
  // A BLOB as the engine answers one (`execute_json` gives `{ "hex": "00ff" }`).
  // Written as text, it came back from a dump as the string `{"hex":"00ff"}`.
  const blobHex = blobHexOf(val);
  if (blobHex !== null) return `X'${blobHex}'`;
  const str = typeof val === 'string' ? val : JSON.stringify(val);
  return `'${str.replace(/'/g, "''")}'`;
}

/**
 * Compute a fast, deterministic signature for binary SQLite bytes so UI viewers
 * can distinguish their own writes from external/AI edits.
 */
export function sqliteBytesSignature(bytes: Uint8Array | null | undefined): string {
  if (!bytes || bytes.byteLength === 0) return 'empty';
  let h = 0x811c9dc5;
  const len = bytes.byteLength;
  // Every byte. A database over 64 KB used to be sampled (every 64th byte of
  // one of 1 MB), so a change that touched only unsampled pages, at the same
  // length, read as no change: the Data tab kept showing the old rows, and its
  // next save wrote its own copy back over the change. A pass over every byte
  // of a few megabytes is milliseconds.
  for (let i = 0; i < len; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${len}:${h.toString(16)}`;
}

/**
 * Strip leading SQL comments (`-- ...` and `/* ... *\/`) to inspect the leading keyword.
 */
function stripLeadingSqlComments(sql: string): string {
  let i = 0;
  const n = sql.length;
  while (i < n) {
    while (i < n && /\s/.test(sql[i])) i++;
    if (sql[i] === '-' && sql[i + 1] === '-') {
      i += 2;
      while (i < n && sql[i] !== '\n') i++;
      continue;
    }
    if (sql[i] === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    break;
  }
  return sql.slice(i);
}

/**
 * Return true when every statement in `script` is strictly read-only
 * (`SELECT`, `WITH`, `EXPLAIN`, or a read-only `PRAGMA` without `=`).
 */
export function isReadOnlySql(script: string): boolean {
  const stmts = splitSqlStatements(script);
  if (stmts.length === 0) return false;
  for (const stmt of stmts) {
    const clean = stripLeadingSqlComments(stmt).trim();
    if (!clean) continue;
    const m = /^([A-Za-z]+)/.exec(clean);
    const kw = m ? m[1].toUpperCase() : '';
    if (kw === 'SELECT' || kw === 'EXPLAIN') continue;
    if (kw === 'WITH') {
      // Disallow CTEs with mutating main statements
      if (/\b(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(clean)) return false;
      continue;
    }
    if (kw === 'PRAGMA') {
      // PRAGMA key = value mutates connection state; disallow assignment
      if (clean.includes('=')) return false;
      continue;
    }
    return false;
  }
  return true;
}

/**
 * Return true if `script` appears to contain any mutating SQL statement.
 */
export function isMutatingSql(script: string): boolean {
  const stmts = splitSqlStatements(script);
  for (const stmt of stmts) {
    const clean = stripLeadingSqlComments(stmt).trim();
    if (/^(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|VACUUM|REINDEX|ATTACH|DETACH)\b/i.test(clean)) {
      return true;
    }
    if (/^WITH\b/i.test(clean) && /\b(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(clean)) {
      return true;
    }
  }
  return false;
}

/**
 * Split a multi-statement SQL script into individual statements, respecting
 * single/double-quoted strings, line/block comments, and `BEGIN ... END` blocks.
 */
export function splitSqlStatements(script: string): string[] {
  const out: string[] = [];
  // Where the statement being read began: it is `script.slice(start, i)`. It
  // used to be built a character at a time, which made a large seed (a dump
  // of every row, as Sync seed SQL writes it) several times slower to split.
  let start = 0;
  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let inBlockComment = false;
  let beginDepth = 0;
  // CASE … END expressions, whose END is theirs and not the trigger body's.
  let caseDepth = 0;

  const isIdentChar = (c: string) => /[A-Za-z0-9_$]/.test(c);

  for (let i = 0; i < script.length; i++) {
    const ch = script[i];
    const next = script[i + 1] ?? '';

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        i++;
        inBlockComment = false;
      }
      continue;
    }
    if (inSingle) {
      if (ch === "'" && next === "'") {
        i++;
      } else if (ch === "'") {
        inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      if (ch === '"' && next === '"') {
        i++;
      } else if (ch === '"') {
        inDouble = false;
      }
      continue;
    }

    if (ch === '-' && next === '-') {
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i++;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }

    // Track trigger/compound BEGIN ... END blocks so semicolons inside triggers don't split prematurely
    if ((ch === 'B' || ch === 'b' || ch === 'E' || ch === 'e' || ch === 'C' || ch === 'c') && (i === 0 || !isIdentChar(script[i - 1]))) {
      const slice5 = script.slice(i, i + 5).toUpperCase();
      const after5 = script[i + 5] ?? '';
      const slice4 = slice5.slice(0, 4);
      const after4 = script[i + 4] ?? '';
      if (slice5 === 'BEGIN' && !isIdentChar(after5)) {
        if (/\bCREATE\s+(?:TEMP\s+|TEMPORARY\s+)?TRIGGER\b/i.test(script.slice(start, i))) {
          beginDepth++;
        }
      } else if (slice4 === 'CASE' && !isIdentChar(after4)) {
        caseDepth++;
      } else {
        const slice3 = script.slice(i, i + 3).toUpperCase();
        const after3 = script[i + 3] ?? '';
        if (slice3 === 'END' && !isIdentChar(after3)) {
          if (caseDepth > 0) caseDepth--;
          else if (beginDepth > 0) beginDepth--;
        }
      }
    }

    if (ch === ';' && beginDepth === 0) {
      const trimmed = script.slice(start, i).trim();
      if (trimmed) out.push(trimmed);
      start = i + 1;
      // A CASE left open (a statement SQLite will refuse) ends with its statement.
      caseDepth = 0;
      continue;
    }
  }

  const tail = script.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

function findBinaryInMap(
  binaryFiles: ReadonlyMap<string, Uint8Array>,
  candidates: string[]
): { path: string; bytes: Uint8Array } | null {
  // Build a normalized lookup map once per search when needed
  for (const raw of candidates) {
    const p = normalizeSqlitePath(raw);
    if (!p) continue;
    const direct = binaryFiles.get(p);
    if (direct) return { path: p, bytes: direct };
  }
  const normalized = new Map<string, { path: string; bytes: Uint8Array }>();
  for (const [k, v] of binaryFiles) {
    const norm = normalizeSqlitePath(k);
    if (!normalized.has(norm)) normalized.set(norm, { path: norm, bytes: v });
  }
  for (const raw of candidates) {
    const p = normalizeSqlitePath(raw);
    const match = normalized.get(p);
    if (match) return match;
  }
  return null;
}

function listSqlPaths(index: SqliteFileIndex): string[] {
  const found = new Set<string>();
  for (const p of index.textFiles.keys()) {
    const norm = normalizeSqlitePath(p);
    // Exclude FormLogic server/migrations/*.sql if they are owned by manifest.server.database
    if (SQL_FILE_RE.test(norm)) found.add(norm);
  }
  for (const p of index.binaryFiles.keys()) {
    const norm = normalizeSqlitePath(p);
    if (SQL_FILE_RE.test(norm)) found.add(norm);
  }
  return [...found].sort((a, b) => a.localeCompare(b));
}

/**
 * Discover every SQLite database declared in `manifest.databases`, bundled
 * as `.db`/`.sqlite`/`.sqlite3`, or inferred from `.sql` seed/schema files.
 */
export function detectSqliteDatabases(index: SqliteFileIndex): ProjectSqliteDatabase[] {
  const result: ProjectSqliteDatabase[] = [];
  const seenFiles = new Set<string>();
  const allSqlPaths = listSqlPaths(index);

  const manifest = index.manifest;
  const declared = Array.isArray(manifest?.databases)
    ? (manifest.databases as DatabaseConfig[])
    : [];

  // Identify FormLogic private-sqlite migrations so we don't mistakenly treat them
  // as an unconfigured standalone container DB unless declared in manifest.databases
  const formLogicMigrations = new Set<string>();
  const serverBlock = manifest?.server as { database?: { migrations?: unknown } } | undefined;
  if (Array.isArray(serverBlock?.database?.migrations)) {
    for (const m of serverBlock.database.migrations) {
      if (typeof m === 'string') formLogicMigrations.add(normalizeSqlitePath(m));
    }
  }
  const containerSqlPaths = allSqlPaths.filter((p) => !formLogicMigrations.has(p));

  for (const cfg of declared) {
    if (!cfg || typeof cfg !== 'object') continue;
    if (cfg.engine && cfg.engine !== 'sqlite') continue;
    const rawName = typeof cfg.name === 'string' && cfg.name.trim() ? cfg.name.trim() : 'app';
    const rawFile = typeof cfg.file === 'string' && cfg.file.trim()
      ? normalizeSqlitePath(cfg.file.trim())
      : `${rawName}.db`;
    const baseName = rawFile.slice(rawFile.lastIndexOf('/') + 1);
    const binMatch = findBinaryInMap(index.binaryFiles, [
      rawFile,
      `data/${baseName}`,
      `db/${baseName}`,
      `database/${baseName}`,
      `backend/${baseName}`,
      `backend/data/${baseName}`,
      `server/${baseName}`,
      baseName,
    ]);
    const effectivePath = binMatch?.path ?? rawFile;
    seenFiles.add(effectivePath.toLowerCase());
    seenFiles.add(rawFile.toLowerCase());

    const seedSqlPaths: string[] = [];
    if (typeof cfg.seedSql === 'string' && cfg.seedSql.trim()) {
      seedSqlPaths.push(normalizeSqlitePath(cfg.seedSql.trim()));
    }
    if (seedSqlPaths.length === 0 && containerSqlPaths.length > 0 && declared.length === 1) {
      seedSqlPaths.push(...containerSqlPaths);
    }

    const walMatch = findBinaryInMap(index.binaryFiles, [`${effectivePath}-wal`]);
    const journalMatch = findBinaryInMap(index.binaryFiles, [`${effectivePath}-journal`]);

    result.push({
      id: `db:${rawName}:${effectivePath}`,
      name: rawName,
      file: effectivePath,
      seedSqlPaths,
      seedJsonPath: typeof cfg.seedJson === 'string' && cfg.seedJson.trim() ? normalizeSqlitePath(cfg.seedJson.trim()) : undefined,
      hasBinary: Boolean(binMatch),
      initialBytes: binMatch?.bytes ?? null,
      walBytes: walMatch?.bytes ?? null,
      journalBytes: journalMatch?.bytes ?? null,
    });
  }

  for (const [rawPath, bytes] of index.binaryFiles) {
    const p = normalizeSqlitePath(rawPath);
    if (!SQLITE_DB_FILE_RE.test(p)) continue;
    if (seenFiles.has(p.toLowerCase())) continue;
    seenFiles.add(p.toLowerCase());
    const base = p.slice(p.lastIndexOf('/') + 1).replace(SQLITE_DB_FILE_RE, '') || 'database';
    const walMatch = findBinaryInMap(index.binaryFiles, [`${p}-wal`]);
    const journalMatch = findBinaryInMap(index.binaryFiles, [`${p}-journal`]);
    result.push({
      id: `file:${p}`,
      name: base,
      file: p,
      seedSqlPaths: [],
      hasBinary: true,
      initialBytes: bytes,
      walBytes: walMatch?.bytes ?? null,
      journalBytes: journalMatch?.bytes ?? null,
    });
  }

  // Fallback: if non-FormLogic `.sql` schema/migration files exist, synthesize an editable default DB
  if (result.length === 0 && containerSqlPaths.length > 0) {
    result.push({
      id: 'inferred:app.db',
      name: 'app',
      file: 'app.db',
      seedSqlPaths: containerSqlPaths,
      hasBinary: false,
      initialBytes: null,
      walBytes: null,
      journalBytes: null,
    });
  }

  return result;
}

/**
 * High-level SQLite / XDB session wrapper around `WasmConnection` providing
 * phpMyAdmin-style introspection, schema modification, full CRUD, and SQL dump export.
 */
export class SqliteSession {
  private readonly conn: XdbWasmConnection;
  private disposed = false;

  constructor(conn: XdbWasmConnection) {
    this.conn = conn;
  }

  static async open(
    db: ProjectSqliteDatabase,
    readTextFile: (path: string) => string | null,
    options: {
      runtimeUrl?: string;
      bindings?: LoadedXdbBindings;
      forceReseed?: boolean;
    } = {}
  ): Promise<SqliteSession> {
    const bindings = options.bindings ?? (await loadXdbWasm({ runtimeUrl: options.runtimeUrl }));
    const useBinary = !options.forceReseed && db.initialBytes && db.initialBytes.byteLength > 0;
    const conn = useBinary
      ? new bindings.WasmConnection(db.initialBytes, db.walBytes ?? null, db.journalBytes ?? null, 4096, 0n, 0n, 0n)
      : new bindings.WasmConnection(null, null, null, 4096, 0n, 0n, 0n);

    const session = new SqliteSession(conn);

    if (!useBinary) {
      for (const sqlPath of db.seedSqlPaths) {
        const sqlText = readTextFile(sqlPath);
        if (sqlText && sqlText.trim()) {
          session.execScript(sqlText);
        }
      }
      if (db.seedJsonPath) {
        const jsonText = readTextFile(db.seedJsonPath);
        if (jsonText && jsonText.trim()) {
          conn.seed_json(jsonText);
        }
      }
    }

    return session;
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error('SQLite session is closed.');
  }

  exec(sql: string, params?: unknown[]): SqliteExecResult {
    this.assertOpen();
    const paramsJson = params && params.length > 0 ? JSON.stringify(params) : null;
    const raw = this.conn.execute_json(sql, paramsJson);
    const parsed = JSON.parse(raw) as {
      columns?: string[];
      rows?: unknown[][];
      changes?: number;
      lastInsertRowid?: number;
      error?: string;
    };
    if (parsed.error) {
      throw new Error(parsed.error);
    }
    return {
      columns: Array.isArray(parsed.columns) ? parsed.columns : [],
      rows: Array.isArray(parsed.rows) ? parsed.rows : [],
      changes: Number(parsed.changes ?? 0),
      lastInsertRowid: Number(parsed.lastInsertRowid ?? 0),
    };
  }

  execScript(script: string): SqliteExecResult {
    const statements = splitSqlStatements(script);
    let last: SqliteExecResult = { columns: [], rows: [], changes: 0, lastInsertRowid: 0 };
    let totalChanges = 0;
    for (const stmt of statements) {
      last = this.exec(stmt);
      totalChanges += last.changes;
    }
    return { ...last, changes: totalChanges };
  }

  listTables(): SqliteTableSummary[] {
    const res = this.exec(
      "SELECT name, type, COALESCE(sql, '') AS sql FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY type ASC, name ASC"
    );
    return res.rows.map((r) => {
      const name = String(r[0] ?? '');
      const type = r[1] === 'view' ? 'view' : 'table';
      const sql = String(r[2] ?? '');
      let rowCount = 0;
      try {
        const countRes = this.exec(`SELECT COUNT(*) FROM ${quoteSqlIdent(name)}`);
        rowCount = Number(countRes.rows[0]?.[0] ?? 0);
      } catch {
        rowCount = 0;
      }
      return { name, type, sql, rowCount };
    });
  }

  getTableStructure(tableName: string): SqliteTableStructure {
    const meta = this.exec(
      "SELECT type, COALESCE(sql, '') FROM sqlite_master WHERE name = ? AND type IN ('table', 'view')",
      [tableName]
    );
    const type: 'table' | 'view' = meta.rows[0]?.[0] === 'view' ? 'view' : 'table';
    const sql = String(meta.rows[0]?.[1] ?? '');

    const colsRes = this.exec(`PRAGMA table_info(${quoteSqlIdent(tableName)})`);
    const columns: SqliteColumnInfo[] = colsRes.rows.map((r) => ({
      cid: Number(r[0] ?? 0),
      name: String(r[1] ?? ''),
      type: String(r[2] ?? ''),
      notnull: Number(r[3] ?? 0) !== 0,
      dfltValue: r[4] === null || r[4] === undefined ? null : String(r[4]),
      pk: Number(r[5] ?? 0),
    }));

    const pkColumns = columns
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name);

    const isWithoutRowid = type === 'view' || /\bWITHOUT\s+ROWID\b/i.test(sql);
    let hasRowid = !isWithoutRowid;
    if (hasRowid) {
      try {
        this.exec(`SELECT rowid FROM ${quoteSqlIdent(tableName)} LIMIT 0`);
      } catch {
        hasRowid = false;
      }
    }

    const indexes: SqliteIndexInfo[] = [];
    try {
      const idxRes = this.exec(`PRAGMA index_list(${quoteSqlIdent(tableName)})`);
      for (const r of idxRes.rows) {
        const idxName = String(r[1] ?? '');
        const unique = Number(r[2] ?? 0) !== 0;
        const origin = String(r[3] ?? 'c');
        let idxCols: string[] = [];
        try {
          const infoRes = this.exec(`PRAGMA index_info(${quoteSqlIdent(idxName)})`);
          idxCols = infoRes.rows.map((ir) => String(ir[2] ?? '')).filter(Boolean);
        } catch {
          idxCols = [];
        }
        indexes.push({ name: idxName, unique, origin, columns: idxCols });
      }
    } catch {
      // views or unsupported pragma
    }

    const foreignKeys: SqliteForeignKeyInfo[] = [];
    try {
      const fkRes = this.exec(`PRAGMA foreign_key_list(${quoteSqlIdent(tableName)})`);
      for (const r of fkRes.rows) {
        foreignKeys.push({
          id: Number(r[0] ?? 0),
          table: String(r[2] ?? ''),
          from: String(r[3] ?? ''),
          to: String(r[4] ?? ''),
          onUpdate: String(r[5] ?? 'NO ACTION'),
          onDelete: String(r[6] ?? 'NO ACTION'),
        });
      }
    } catch {
      // ignore
    }

    return { name: tableName, type, sql, columns, indexes, foreignKeys, hasRowid, pkColumns };
  }

  browseTable(
    tableName: string,
    opts: {
      page?: number;
      pageSize?: number;
      sortBy?: string | null;
      sortDir?: 'ASC' | 'DESC';
      search?: string;
    } = {}
  ): SqliteBrowseResult {
    const struct = this.getTableStructure(tableName);
    const pageSize = Math.max(1, Math.min(500, opts.pageSize ?? 25));
    const requestedPage = Math.max(1, opts.page ?? 1);
    const quotedTable = quoteSqlIdent(tableName);

    const whereClauses: string[] = [];
    const params: unknown[] = [];
    const searchTerm = (opts.search ?? '').trim();
    if (searchTerm && struct.columns.length > 0) {
      const pattern = `%${searchTerm}%`;
      const parts = struct.columns.map((c) => `CAST(${quoteSqlIdent(c.name)} AS TEXT) LIKE ?`);
      whereClauses.push(`(${parts.join(' OR ')})`);
      for (let i = 0; i < struct.columns.length; i++) params.push(pattern);
    }
    const whereSql = whereClauses.length ? ` WHERE ${whereClauses.join(' AND ')}` : '';

    const countRes = this.exec(`SELECT COUNT(*) FROM ${quotedTable}${whereSql}`, params);
    const totalRows = Number(countRes.rows[0]?.[0] ?? 0);
    const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
    const page = Math.min(requestedPage, totalPages);
    const offset = (page - 1) * pageSize;

    const validColNames = new Set(struct.columns.map((c) => c.name));
    let orderSql = '';
    if (opts.sortBy && validColNames.has(opts.sortBy)) {
      const dir = opts.sortDir === 'DESC' ? 'DESC' : 'ASC';
      orderSql = ` ORDER BY ${quoteSqlIdent(opts.sortBy)} ${dir}`;
    } else if (struct.hasRowid) {
      orderSql = ' ORDER BY rowid ASC';
    }

    const colSelect = struct.columns.map((c) => quoteSqlIdent(c.name)).join(', ');
    if (!colSelect) {
      return {
        columns: [],
        rows: [],
        totalRows: 0,
        page: 1,
        pageSize,
        hasRowid: struct.hasRowid,
        pkColumns: struct.pkColumns,
      };
    }

    // The rowid as text, which the engine's JSON cannot round (see SqliteRowid).
    const selectSql = struct.hasRowid
      ? `SELECT CAST(rowid AS TEXT) AS __softn_rowid, ${colSelect} FROM ${quotedTable}${whereSql}${orderSql} LIMIT ? OFFSET ?`
      : `SELECT ${colSelect} FROM ${quotedTable}${whereSql}${orderSql} LIMIT ? OFFSET ?`;

    const dataRes = this.exec(selectSql, [...params, pageSize, offset]);
    const rows = dataRes.rows.map((r) => {
      if (struct.hasRowid) {
        return {
          rowid: rowidRead(r[0]),
          values: r.slice(1),
        };
      }
      return { rowid: null, values: r };
    });

    return {
      columns: struct.columns.map((c) => c.name),
      rows,
      totalRows,
      page,
      pageSize,
      hasRowid: struct.hasRowid,
      pkColumns: struct.pkColumns,
    };
  }

  insertRow(tableName: string, values: Record<string, unknown>): SqliteExecResult {
    const entries = Object.entries(values);
    const qt = quoteSqlIdent(tableName);
    if (entries.length === 0) {
      return this.exec(`INSERT INTO ${qt} DEFAULT VALUES`);
    }
    const cols = entries.map(([k]) => quoteSqlIdent(k)).join(', ');
    const placeholders = entries.map(() => '?').join(', ');
    const params = entries.map(([, v]) => (v === undefined ? null : v));
    return this.exec(`INSERT INTO ${qt} (${cols}) VALUES (${placeholders})`, params);
  }

  updateRow(
    tableName: string,
    locator: { rowid?: SqliteRowid | null; pkValues?: Record<string, unknown> },
    updates: Record<string, unknown>
  ): SqliteExecResult {
    const entries = Object.entries(updates);
    if (entries.length === 0) {
      return { columns: [], rows: [], changes: 0, lastInsertRowid: 0 };
    }
    const qt = quoteSqlIdent(tableName);
    const setSql = entries.map(([k]) => `${quoteSqlIdent(k)} = ?`).join(', ');
    const params: unknown[] = entries.map(([, v]) => (v === undefined ? null : v));

    const rowid = rowidBound(locator.rowid);
    if (rowid !== null) {
      params.push(rowid);
      return this.exec(`UPDATE ${qt} SET ${setSql} WHERE rowid = ?`, params);
    }
    const pkEntries = Object.entries(locator.pkValues ?? {});
    if (pkEntries.length === 0) {
      throw new Error('Cannot update row without rowid or primary key values.');
    }
    const whereSql = pkEntries
      .map(([k, v]) => {
        if (v === null || v === undefined) return `${quoteSqlIdent(k)} IS NULL`;
        params.push(v);
        return `${quoteSqlIdent(k)} = ?`;
      })
      .join(' AND ');
    return this.exec(`UPDATE ${qt} SET ${setSql} WHERE ${whereSql}`, params);
  }

  deleteRow(
    tableName: string,
    locator: { rowid?: SqliteRowid | null; pkValues?: Record<string, unknown> }
  ): SqliteExecResult {
    const qt = quoteSqlIdent(tableName);
    const rowid = rowidBound(locator.rowid);
    if (rowid !== null) {
      return this.exec(`DELETE FROM ${qt} WHERE rowid = ?`, [rowid]);
    }
    const pkEntries = Object.entries(locator.pkValues ?? {});
    if (pkEntries.length === 0) {
      throw new Error('Cannot delete row without rowid or primary key values.');
    }
    const params: unknown[] = [];
    const whereSql = pkEntries
      .map(([k, v]) => {
        if (v === null || v === undefined) return `${quoteSqlIdent(k)} IS NULL`;
        params.push(v);
        return `${quoteSqlIdent(k)} = ?`;
      })
      .join(' AND ');
    return this.exec(`DELETE FROM ${qt} WHERE ${whereSql}`, params);
  }

  truncateTable(tableName: string): SqliteExecResult {
    return this.exec(`DELETE FROM ${quoteSqlIdent(tableName)}`);
  }

  static buildCreateTableSql(tableName: string, columns: SqliteNewColumnSpec[]): string {
    const name = tableName.trim();
    if (!name) throw new Error('Table name is required.');
    if (columns.length === 0) throw new Error('Add at least one column.');
    const pkCols = columns.filter((c) => c.primaryKey);
    const compositePk = pkCols.length > 1;

    const defs: string[] = columns.map((col) => {
      const colName = col.name.trim();
      if (!colName) throw new Error('Every column must have a name.');
      const parts = [quoteSqlIdent(colName), (col.type || 'TEXT').trim().toUpperCase()];
      if (col.primaryKey && !compositePk) {
        parts.push('PRIMARY KEY');
        if (col.autoIncrement && parts[1] === 'INTEGER') parts.push('AUTOINCREMENT');
      }
      if (col.notNull && !col.primaryKey) parts.push('NOT NULL');
      if (col.unique && !col.primaryKey) parts.push('UNIQUE');
      if (col.defaultValue !== undefined && col.defaultValue.trim() !== '') {
        parts.push(`DEFAULT ${formatDefaultExpr(col.defaultValue.trim())}`);
      }
      return parts.join(' ');
    });
    if (compositePk) {
      defs.push(`PRIMARY KEY (${pkCols.map((c) => quoteSqlIdent(c.name.trim())).join(', ')})`);
    }
    return `CREATE TABLE ${quoteSqlIdent(name)} (\n  ${defs.join(',\n  ')}\n)`;
  }

  createTable(tableName: string, columns: SqliteNewColumnSpec[]): SqliteExecResult {
    return this.exec(SqliteSession.buildCreateTableSql(tableName, columns));
  }

  addColumn(tableName: string, col: SqliteNewColumnSpec): SqliteExecResult {
    const colName = col.name.trim();
    if (!colName) throw new Error('Column name is required.');
    const parts = [quoteSqlIdent(colName), (col.type || 'TEXT').trim().toUpperCase()];
    if (col.notNull) parts.push('NOT NULL');
    if (col.defaultValue !== undefined && col.defaultValue.trim() !== '') {
      parts.push(`DEFAULT ${formatDefaultExpr(col.defaultValue.trim())}`);
    } else if (col.notNull) {
      parts.push(parts[1] === 'INTEGER' || parts[1] === 'REAL' || parts[1] === 'NUMERIC' ? 'DEFAULT 0' : "DEFAULT ''");
    }
    return this.exec(`ALTER TABLE ${quoteSqlIdent(tableName)} ADD COLUMN ${parts.join(' ')}`);
  }

  renameColumn(tableName: string, oldName: string, newName: string): SqliteExecResult {
    const next = newName.trim();
    if (!next) throw new Error('New column name is required.');
    return this.exec(
      `ALTER TABLE ${quoteSqlIdent(tableName)} RENAME COLUMN ${quoteSqlIdent(oldName)} TO ${quoteSqlIdent(next)}`
    );
  }

  dropColumn(tableName: string, colName: string): SqliteExecResult {
    try {
      return this.exec(`ALTER TABLE ${quoteSqlIdent(tableName)} DROP COLUMN ${quoteSqlIdent(colName)}`);
    } catch {
      const struct = this.getTableStructure(tableName);
      const remaining = struct.columns.filter((c) => c.name !== colName);
      if (remaining.length === 0) {
        throw new Error('Cannot drop the last column in a table.');
      }
      const tempName = `__softn_rebuild_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const newCols: SqliteNewColumnSpec[] = remaining.map((c) => ({
        name: c.name,
        type: c.type || 'TEXT',
        primaryKey: c.pk > 0,
        notNull: c.notnull,
        defaultValue: c.dfltValue ?? undefined,
      }));
      const colList = remaining.map((c) => quoteSqlIdent(c.name)).join(', ');
      this.exec('BEGIN TRANSACTION');
      try {
        this.exec(SqliteSession.buildCreateTableSql(tempName, newCols));
        this.exec(`INSERT INTO ${quoteSqlIdent(tempName)} (${colList}) SELECT ${colList} FROM ${quoteSqlIdent(tableName)}`);
        this.exec(`DROP TABLE ${quoteSqlIdent(tableName)}`);
        this.exec(`ALTER TABLE ${quoteSqlIdent(tempName)} RENAME TO ${quoteSqlIdent(tableName)}`);
        this.exec('COMMIT');
      } catch (err) {
        try { this.exec('ROLLBACK'); } catch { /* ignore */ }
        throw err;
      }
      return { columns: [], rows: [], changes: 1, lastInsertRowid: 0 };
    }
  }

  renameTable(oldName: string, newName: string): SqliteExecResult {
    const next = newName.trim();
    if (!next) throw new Error('New table name is required.');
    return this.exec(`ALTER TABLE ${quoteSqlIdent(oldName)} RENAME TO ${quoteSqlIdent(next)}`);
  }

  dropTable(tableName: string, type: 'table' | 'view' = 'table'): SqliteExecResult {
    const kw = type === 'view' ? 'VIEW' : 'TABLE';
    return this.exec(`DROP ${kw} ${quoteSqlIdent(tableName)}`);
  }

  createIndex(tableName: string, indexName: string, columns: string[], unique = false): SqliteExecResult {
    const idx = indexName.trim();
    if (!idx) throw new Error('Index name is required.');
    if (columns.length === 0) throw new Error('Select at least one column.');
    const colsSql = columns.map((c) => quoteSqlIdent(c)).join(', ');
    return this.exec(`CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${quoteSqlIdent(idx)} ON ${quoteSqlIdent(tableName)} (${colsSql})`);
  }

  dropIndex(indexName: string): SqliteExecResult {
    return this.exec(`DROP INDEX ${quoteSqlIdent(indexName)}`);
  }

  exportSqlDump(): string {
    const lines: string[] = [
      '-- SoftN XDB SQLite Dump',
      `-- Generated at ${new Date().toISOString()}`,
      'BEGIN TRANSACTION;',
      '',
    ];
    const objects = this.exec(
      "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY CASE type WHEN 'table' THEN 1 WHEN 'index' THEN 2 WHEN 'view' THEN 3 WHEN 'trigger' THEN 4 ELSE 5 END, name ASC"
    );
    const tables: string[] = [];
    for (const row of objects.rows) {
      const type = String(row[0] ?? '');
      const name = String(row[1] ?? '');
      const sql = String(row[2] ?? '').trim();
      if (!sql) continue;
      lines.push(sql.endsWith(';') ? sql : `${sql};`);
      if (type === 'table') tables.push(name);
    }
    lines.push('');
    for (const table of tables) {
      const struct = this.getTableStructure(table);
      if (struct.columns.length === 0) continue;
      const cols = struct.columns.map((c) => quoteSqlIdent(c.name)).join(', ');
      const data = this.exec(`SELECT ${cols} FROM ${quoteSqlIdent(table)}`);
      if (data.rows.length === 0) continue;
      lines.push(`-- Data for ${table} (${data.rows.length} row${data.rows.length === 1 ? '' : 's'})`);
      for (const r of data.rows) {
        const vals = r.map((v) => formatSqlLiteral(v)).join(', ');
        lines.push(`INSERT INTO ${quoteSqlIdent(table)} (${cols}) VALUES (${vals});`);
      }
      lines.push('');
    }
    lines.push('COMMIT;');
    return lines.join('\n');
  }

  pageInfo(): { pageSize: number; pageCount: number; approxBytes: number } {
    this.assertOpen();
    const pageSize = Number(this.conn.page_size());
    const pageCount = Number(this.conn.page_count());
    return { pageSize, pageCount, approxBytes: pageSize * pageCount };
  }

  exportBytes(): Uint8Array {
    this.assertOpen();
    return new Uint8Array(this.conn.export_bytes());
  }

  close(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.conn.close();
    } catch {
      // ignore
    }
    try {
      this.conn.free();
    } catch {
      // ignore
    }
  }
}

function formatDefaultExpr(raw: string): string {
  const upper = raw.toUpperCase();
  if (
    upper === 'NULL' ||
    upper === 'CURRENT_TIMESTAMP' ||
    upper === 'CURRENT_DATE' ||
    upper === 'CURRENT_TIME' ||
    /^-?\d+(?:\.\d+)?$/.test(raw) ||
    (raw.startsWith("'") && raw.endsWith("'")) ||
    (raw.startsWith('(') && raw.endsWith(')'))
  ) {
    return raw;
  }
  return formatSqlLiteral(raw);
}

/**
 * Create empty XDB SQLite 3 binary bytes.
 */
export async function createEmptySqliteBytes(
  options: { runtimeUrl?: string; bindings?: LoadedXdbBindings } = {}
): Promise<Uint8Array> {
  const bindings = options.bindings ?? (await loadXdbWasm({ runtimeUrl: options.runtimeUrl }));
  const conn = new bindings.WasmConnection(null, null, null, 4096, 0n, 0n, 0n);
  try {
    return new Uint8Array(conn.export_bytes());
  } finally {
    try { conn.close(); } catch { /* ignore */ }
    try { conn.free(); } catch { /* ignore */ }
  }
}

/**
 * Build a `ProjectSqliteDatabase` entry from a sanitized name and `.db` bytes.
 */
export function buildNewSqliteDatabase(rawName: string, bytes: Uint8Array, fileOverride?: string): ProjectSqliteDatabase {
  const cleanName = rawName.trim().replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
  if (!cleanName) throw new Error('Database name is required.');
  const file = fileOverride ? normalizeSqlitePath(fileOverride) : `${cleanName}.db`;
  return {
    id: `db:${cleanName}:${file}`,
    name: cleanName,
    file,
    seedSqlPaths: [],
    hasBinary: true,
    initialBytes: new Uint8Array(bytes),
    walBytes: null,
    journalBytes: null,
  };
}

/**
 * Return a cloned `manifest.json` object with `manifest.databases` updated or created
 * to reference `db` (preserving all existing manifest keys and other databases).
 */
export function upsertSqliteManifest(
  manifest: Record<string, unknown> | null,
  db: ProjectSqliteDatabase,
  fallbackMeta: SqliteManifestFallbackMeta = {}
): Record<string, unknown> {
  const filePath = normalizeSqlitePath(db.file);
  const baseManifest: Record<string, unknown> = manifest
    ? (JSON.parse(JSON.stringify(manifest)) as Record<string, unknown>)
    : {
        formatVersion: 2,
        engine: 2,
        name: fallbackMeta.name || 'Untitled App',
        version: fallbackMeta.version || '1.0.0',
        description: fallbackMeta.description || '',
      };

  const existingDbs = Array.isArray(baseManifest.databases)
    ? [...(baseManifest.databases as DatabaseConfig[])]
    : [];
  const idx = existingDbs.findIndex(
    (entry) =>
      entry &&
      (entry.name === db.name || normalizeSqlitePath(entry.file || '') === filePath)
  );
  const nextEntry: DatabaseConfig = {
    ...(idx >= 0 ? existingDbs[idx] : {}),
    name: db.name,
    engine: 'sqlite',
    file: filePath,
    persist: (idx >= 0 && typeof existingDbs[idx]?.persist === 'boolean') ? existingDbs[idx].persist : true,
    ...(db.seedSqlPaths[0] ? { seedSql: db.seedSqlPaths[0] } : {}),
  };
  if (idx >= 0) existingDbs[idx] = nextEntry;
  else existingDbs.push(nextEntry);
  baseManifest.databases = existingDbs;
  return baseManifest;
}
