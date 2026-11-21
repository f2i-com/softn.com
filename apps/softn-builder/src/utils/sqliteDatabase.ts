/**
 * XDB SQLite 3 database inspection, schema manipulation, and CRUD helpers for
 * SoftN Builder's mini-phpMyAdmin Data tab.
 *
 * Uses the real pure-safe-Rust XDB SQLite 3 WASM engine (`@softn/container`)
 * so every DDL/DML edit runs against the exact same SQLite engine that executes
 * inside SoftN containers and writes standard `.db` bytes back into the
 * project bundle (`projectStore.source.extraEntries`).
 */

import {
  loadXdbWasm,
  type DatabaseConfig,
  type LoadedXdbBindings,
  type XdbWasmConnection,
} from '@softn/container';
import { useProjectStore, type RetainedSource } from '../stores/projectStore';
import type { AssetFile, LogicFileState } from '../types/builder';

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
  /** Current binary bytes from `extraEntries` / `assetFiles`, if any. */
  initialBytes: Uint8Array | null;
  /** Optional WAL bytes beside the DB file, if present. */
  walBytes: Uint8Array | null;
  /** Optional rollback journal bytes beside the DB file, if present. */
  journalBytes: Uint8Array | null;
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

export interface SqliteBrowseResult {
  columns: string[];
  /** Rows in column order; `rowid` is tracked separately when available. */
  rows: Array<{ rowid: number | null; values: unknown[] }>;
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

const DB_FILE_RE = /\.(?:db|sqlite|sqlite3)$/i;
const SQL_FILE_RE = /\.sql$/i;

export function quoteSqlIdent(ident: string): string {
  const clean = String(ident ?? '');
  if (!clean) throw new Error('Identifier cannot be empty.');
  return `"${clean.replace(/"/g, '""')}"`;
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
  const str = typeof val === 'string' ? val : JSON.stringify(val);
  return `'${str.replace(/'/g, "''")}'`;
}

/**
 * Split a multi-statement SQL script into individual statements, respecting
 * single/double-quoted strings, line/block comments, and `BEGIN ... END` blocks.
 */
export function splitSqlStatements(script: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let inBlockComment = false;
  let beginDepth = 0;

  const isIdentChar = (c: string) => /[A-Za-z0-9_$]/.test(c);

  for (let i = 0; i < script.length; i++) {
    const ch = script[i];
    const next = script[i + 1] ?? '';

    if (inLineComment) {
      cur += ch;
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      cur += ch;
      if (ch === '*' && next === '/') {
        cur += '/';
        i++;
        inBlockComment = false;
      }
      continue;
    }
    if (inSingle) {
      cur += ch;
      if (ch === "'" && next === "'") {
        cur += "'";
        i++;
      } else if (ch === "'") {
        inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      cur += ch;
      if (ch === '"' && next === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inDouble = false;
      }
      continue;
    }

    if (ch === '-' && next === '-') {
      inLineComment = true;
      cur += '--';
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      cur += '/*';
      i++;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      cur += ch;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      cur += ch;
      continue;
    }

    // Track trigger/compound BEGIN ... END blocks so semicolons inside triggers don't split prematurely
    if ((i === 0 || !isIdentChar(script[i - 1])) && /[BbEe]/.test(ch)) {
      const slice5 = script.slice(i, i + 5).toUpperCase();
      const after5 = script[i + 5] ?? '';
      if (slice5 === 'BEGIN' && !isIdentChar(after5)) {
        // Only count BEGIN inside CREATE TRIGGER, not standalone BEGIN TRANSACTION
        if (/\bCREATE\s+(?:TEMP\s+|TEMPORARY\s+)?TRIGGER\b/i.test(cur)) {
          beginDepth++;
        }
      } else {
        const slice3 = script.slice(i, i + 3).toUpperCase();
        const after3 = script[i + 3] ?? '';
        if (slice3 === 'END' && !isIdentChar(after3) && beginDepth > 0) {
          beginDepth--;
        }
      }
    }

    if (ch === ';' && beginDepth === 0) {
      const trimmed = cur.trim();
      if (trimmed) out.push(trimmed);
      cur = '';
      continue;
    }

    cur += ch;
  }

  const tail = cur.trim();
  if (tail) out.push(tail);
  return out;
}

function normalizePath(p: string): string {
  return String(p || '').replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/^\/+/, '');
}

function findBinaryEntry(
  extraEntries: ReadonlyMap<string, Uint8Array>,
  assetFiles: ReadonlyMap<string, AssetFile>,
  candidates: string[]
): { path: string; bytes: Uint8Array } | null {
  const assetByPath = new Map<string, Uint8Array>();
  for (const a of assetFiles.values()) {
    const bp = normalizePath(a.bundlePath || `assets/${a.name}`);
    assetByPath.set(bp, a.data);
  }
  for (const raw of candidates) {
    const p = normalizePath(raw);
    if (!p) continue;
    const extra = extraEntries.get(p);
    if (extra) return { path: p, bytes: extra };
    const asset = assetByPath.get(p);
    if (asset) return { path: p, bytes: asset };
  }
  return null;
}

function readProjectTextFile(
  path: string,
  logicFiles: ReadonlyMap<string, LogicFileState>,
  extraEntries: ReadonlyMap<string, Uint8Array>
): string | null {
  const norm = normalizePath(path);
  for (const lf of logicFiles.values()) {
    if (normalizePath(lf.path) === norm) return lf.content;
  }
  const extra = extraEntries.get(norm);
  if (extra) return new TextDecoder().decode(extra);
  return null;
}

function listProjectSqlPaths(
  logicFiles: ReadonlyMap<string, LogicFileState>,
  extraEntries: ReadonlyMap<string, Uint8Array>
): string[] {
  const found = new Set<string>();
  for (const lf of logicFiles.values()) {
    const p = normalizePath(lf.path);
    if (SQL_FILE_RE.test(p)) found.add(p);
  }
  for (const p of extraEntries.keys()) {
    const norm = normalizePath(p);
    if (SQL_FILE_RE.test(norm)) found.add(norm);
  }
  return [...found].sort((a, b) => a.localeCompare(b));
}

/**
 * Discover every SQLite database declared in `manifest.databases` or bundled
 * as `.db`/`.sqlite`/`.sqlite3` (or inferred from backend `.sql` migrations).
 */
export function detectProjectSqliteDatabases(
  source: Pick<RetainedSource, 'manifest' | 'extraEntries'>,
  logicFiles: ReadonlyMap<string, LogicFileState>,
  assetFiles: ReadonlyMap<string, AssetFile>
): ProjectSqliteDatabase[] {
  const result: ProjectSqliteDatabase[] = [];
  const seenFiles = new Set<string>();
  const allSqlPaths = listProjectSqlPaths(logicFiles, source.extraEntries);

  const manifest = source.manifest;
  const declared = Array.isArray(manifest?.databases)
    ? (manifest.databases as DatabaseConfig[])
    : [];

  for (const cfg of declared) {
    if (!cfg || typeof cfg !== 'object') continue;
    if (cfg.engine && cfg.engine !== 'sqlite') continue;
    const rawName = typeof cfg.name === 'string' && cfg.name.trim() ? cfg.name.trim() : 'app';
    const rawFile = typeof cfg.file === 'string' && cfg.file.trim()
      ? normalizePath(cfg.file.trim())
      : `${rawName}.db`;
    const baseName = rawFile.slice(rawFile.lastIndexOf('/') + 1);
    const binMatch = findBinaryEntry(source.extraEntries, assetFiles, [
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
      seedSqlPaths.push(normalizePath(cfg.seedSql.trim()));
    }
    // Include additional migration SQL files if seedSql points to one in a migrations/ dir or none is set
    if (seedSqlPaths.length === 0 && allSqlPaths.length > 0 && declared.length === 1) {
      seedSqlPaths.push(...allSqlPaths);
    }

    const walMatch = findBinaryEntry(source.extraEntries, assetFiles, [`${effectivePath}-wal`]);
    const journalMatch = findBinaryEntry(source.extraEntries, assetFiles, [`${effectivePath}-journal`]);

    result.push({
      id: `db:${rawName}:${effectivePath}`,
      name: rawName,
      file: effectivePath,
      seedSqlPaths,
      seedJsonPath: typeof cfg.seedJson === 'string' && cfg.seedJson.trim() ? normalizePath(cfg.seedJson.trim()) : undefined,
      hasBinary: Boolean(binMatch),
      initialBytes: binMatch?.bytes ?? null,
      walBytes: walMatch?.bytes ?? null,
      journalBytes: journalMatch?.bytes ?? null,
    });
  }

  // Standalone `.db` / `.sqlite` / `.sqlite3` files in extraEntries or assetFiles
  const scanBinFile = (rawPath: string, bytes: Uint8Array) => {
    const p = normalizePath(rawPath);
    if (!DB_FILE_RE.test(p)) return;
    if (seenFiles.has(p.toLowerCase())) return;
    seenFiles.add(p.toLowerCase());
    const base = p.slice(p.lastIndexOf('/') + 1).replace(DB_FILE_RE, '') || 'database';
    const walMatch = findBinaryEntry(source.extraEntries, assetFiles, [`${p}-wal`]);
    const journalMatch = findBinaryEntry(source.extraEntries, assetFiles, [`${p}-journal`]);
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
  };

  for (const [p, bytes] of source.extraEntries) scanBinFile(p, bytes);
  for (const a of assetFiles.values()) scanBinFile(a.bundlePath || `assets/${a.name}`, a.data);

  // Fallback: if a web container has SQL schema/migration files and a backend, synthesize an editable default DB
  if (result.length === 0 && allSqlPaths.length > 0) {
    result.push({
      id: 'inferred:app.db',
      name: 'app',
      file: 'app.db',
      seedSqlPaths: allSqlPaths,
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

  static async openDatabase(
    db: ProjectSqliteDatabase,
    logicFiles: ReadonlyMap<string, LogicFileState>,
    extraEntries: ReadonlyMap<string, Uint8Array>,
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

    // If no pre-baked binary exists (or forceReseed), hydrate from seedSql / seedJson
    if (!useBinary) {
      for (const sqlPath of db.seedSqlPaths) {
        const sqlText = readProjectTextFile(sqlPath, logicFiles, extraEntries);
        if (sqlText && sqlText.trim()) {
          session.execScript(sqlText);
        }
      }
      if (db.seedJsonPath) {
        const jsonText = readProjectTextFile(db.seedJsonPath, logicFiles, extraEntries);
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

    const selectSql = struct.hasRowid
      ? `SELECT rowid AS __softn_rowid, ${colSelect} FROM ${quotedTable}${whereSql}${orderSql} LIMIT ? OFFSET ?`
      : `SELECT ${colSelect} FROM ${quotedTable}${whereSql}${orderSql} LIMIT ? OFFSET ?`;

    const dataRes = this.exec(selectSql, [...params, pageSize, offset]);
    const rows = dataRes.rows.map((r) => {
      if (struct.hasRowid) {
        return {
          rowid: r[0] === null || r[0] === undefined ? null : Number(r[0]),
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
    locator: { rowid?: number | null; pkValues?: Record<string, unknown> },
    updates: Record<string, unknown>
  ): SqliteExecResult {
    const entries = Object.entries(updates);
    if (entries.length === 0) {
      return { columns: [], rows: [], changes: 0, lastInsertRowid: 0 };
    }
    const qt = quoteSqlIdent(tableName);
    const setSql = entries.map(([k]) => `${quoteSqlIdent(k)} = ?`).join(', ');
    const params: unknown[] = entries.map(([, v]) => (v === undefined ? null : v));

    if (typeof locator.rowid === 'number' && Number.isFinite(locator.rowid)) {
      params.push(locator.rowid);
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
    locator: { rowid?: number | null; pkValues?: Record<string, unknown> }
  ): SqliteExecResult {
    const qt = quoteSqlIdent(tableName);
    if (typeof locator.rowid === 'number' && Number.isFinite(locator.rowid)) {
      return this.exec(`DELETE FROM ${qt} WHERE rowid = ?`, [locator.rowid]);
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
      // SQLite requires a DEFAULT when adding a NOT NULL column to a non-empty table
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
      // Safe SQLite table-rebuild fallback when DROP COLUMN hits a constraint or older engine rule
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
 * Persist modified SQLite `.db` binary bytes back into `projectStore.source.extraEntries`
 * and ensure `manifest.databases` references the database file so both Live Preview
 * and `.softn` Export carry the updated database immediately.
 */
export function persistSqliteBytesToProject(db: ProjectSqliteDatabase, bytes: Uint8Array): void {
  const store = useProjectStore.getState();
  const prevSource = store.source;
  const nextExtra = new Map(prevSource.extraEntries);
  const filePath = normalizePath(db.file);
  nextExtra.set(filePath, new Uint8Array(bytes));
  // Clear stale WAL/journal files beside the freshly checkpointed export
  nextExtra.delete(`${filePath}-wal`);
  nextExtra.delete(`${filePath}-journal`);

  const baseManifest: Record<string, unknown> = prevSource.manifest
    ? (JSON.parse(JSON.stringify(prevSource.manifest)) as Record<string, unknown>)
    : {
        formatVersion: 2,
        engine: 2,
        name: store.name || 'Untitled App',
        version: store.version || '1.0.0',
        description: store.description || '',
      };

  const existingDbs = Array.isArray(baseManifest.databases)
    ? [...(baseManifest.databases as DatabaseConfig[])]
    : [];
  const idx = existingDbs.findIndex(
    (entry) =>
      entry &&
      (entry.name === db.name ||
        normalizePath(entry.file || '') === filePath)
  );
  const nextEntry: DatabaseConfig = {
    ...(idx >= 0 ? existingDbs[idx] : {}),
    name: db.name,
    engine: 'sqlite',
    file: filePath,
    ...(db.seedSqlPaths[0] ? { seedSql: db.seedSqlPaths[0] } : {}),
  };
  if (idx >= 0) existingDbs[idx] = nextEntry;
  else existingDbs.push(nextEntry);
  baseManifest.databases = existingDbs;

  store.setSource({
    ...prevSource,
    manifest: baseManifest,
    manifestBytes: null,
    extraEntries: nextExtra,
  });
  store.markDirty();
}

/**
 * Create a brand-new empty SQLite `.db` in the current project.
 */
export async function createProjectSqliteDatabase(
  rawName: string,
  options: { runtimeUrl?: string; bindings?: LoadedXdbBindings } = {}
): Promise<ProjectSqliteDatabase> {
  const cleanName = rawName.trim().replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
  if (!cleanName) throw new Error('Database name is required.');
  const file = `${cleanName}.db`;
  const bindings = options.bindings ?? (await loadXdbWasm({ runtimeUrl: options.runtimeUrl }));
  const conn = new bindings.WasmConnection(null, null, null, 4096, 0n, 0n, 0n);
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(conn.export_bytes());
  } finally {
    try { conn.close(); } catch { /* ignore */ }
    try { conn.free(); } catch { /* ignore */ }
  }
  const db: ProjectSqliteDatabase = {
    id: `db:${cleanName}:${file}`,
    name: cleanName,
    file,
    seedSqlPaths: [],
    hasBinary: true,
    initialBytes: bytes,
    walBytes: null,
    journalBytes: null,
  };
  persistSqliteBytesToProject(db, bytes);
  return db;
}
