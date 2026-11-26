/**
 * AI Agent SQLite Harness Tools for SoftN AI Studio.
 *
 * Allows the Studio AI agent to inspect and directly modify any SQLite `.db` / `.sqlite`
 * database bundled inside a `.softn` app (both Web Containers and `.ui` apps) using the
 * exact same pure-Rust XDB SQLite 3 WASM engine that runs in SoftN containers.
 *
 * Every mutation (`sqlite_execute`) exports updated `.db` binary bytes, updates
 * `manifest.json` (`databases[]`) if needed, optionally updates a `.sql` seed file,
 * and commits everything as one atomic `'ai'` VFS transaction so Studio's History,
 * Undo/Redo, Live Preview, and Data workspace all stay in sync.
 */

import type { LoadedXdbBindings } from '@softn/container';
import { hostedContainerOptions } from '@softn/runtime-shell/containerHost';
import {
  SqliteSession,
  buildNewSqliteDatabase,
  createEmptySqliteBytes,
  isReadOnlySql,
  normalizeSqlitePath,
  type ProjectSqliteDatabase,
} from '@softn/editor-shared/sqliteDatabase';
import type { VFSFile } from '../../types/studio';
import type { VFSChangeRecord } from '../../stores/vfsStore';
import { resolveProjectPath } from '../paths';
import {
  buildSqlitePersistRecords,
  detectStudioSqliteDatabases,
  readStudioTextFile,
} from '../studioSqlite';
import { lineDiff, type LineDiff } from './diff';

export interface SqliteToolDeps {
  files: Map<string, VFSFile>;
  bindings?: LoadedXdbBindings;
  runtimeUrl?: string;
  commit: (
    records: VFSChangeRecord[],
    seenAfter: Array<{ path: string; whole: boolean; generated?: boolean }>
  ) => string;
}

export interface SqliteToolResult {
  content: string;
  isError: boolean;
  subject: string;
  changed?: boolean;
  transactionId?: string;
  changeSummary?: string;
  diff?: LineDiff[];
}

const DEFAULT_QUERY_LIMIT = 50;
const MAX_QUERY_LIMIT = 200;
const MAX_CELL_CHARS = 240;

function getRuntimeOptions(deps: SqliteToolDeps): { runtimeUrl?: string; bindings?: LoadedXdbBindings } {
  if (deps.bindings) return { bindings: deps.bindings };
  return { runtimeUrl: deps.runtimeUrl ?? hostedContainerOptions().runtimeUrl };
}

function formatCell(val: unknown): string {
  if (val === null || val === undefined) return 'NULL';
  if (val instanceof Uint8Array) return `<BLOB ${val.byteLength} B>`;
  const raw = typeof val === 'string' ? val : JSON.stringify(val);
  return raw.length > MAX_CELL_CHARS ? `${raw.slice(0, MAX_CELL_CHARS - 1)}…` : raw;
}

function formatRowsTable(columns: string[], rows: unknown[][], limit: number): string {
  const shown = rows.slice(0, limit);
  if (columns.length === 0) return '(no columns)';
  if (shown.length === 0) return `Columns: ${columns.join(', ')}\n(0 rows)`;
  const lines = [columns.join(' | '), columns.map(() => '---').join(' | ')];
  for (const row of shown) {
    lines.push(row.map((cell) => formatCell(cell).replace(/\r?\n/g, '\\n')).join(' | '));
  }
  if (rows.length > limit) {
    lines.push(`… showing ${limit} of ${rows.length} rows (pass a higher limit or narrow with LIMIT/WHERE).`);
  }
  return lines.join('\n');
}

function matchDatabase(
  dbs: ProjectSqliteDatabase[],
  requested: string | undefined
): { ok: true; db: ProjectSqliteDatabase } | { ok: false; reason: string } {
  if (requested && requested.trim()) {
    const q = normalizeSqlitePath(requested.trim()).toLowerCase();
    const match = dbs.find((d) => {
      const normFile = normalizeSqlitePath(d.file).toLowerCase();
      const base = normFile.slice(normFile.lastIndexOf('/') + 1);
      return (
        d.name.toLowerCase() === q ||
        normFile === q ||
        base === q ||
        `${d.name.toLowerCase()}.db` === q
      );
    });
    if (match) return { ok: true, db: match };
    if (dbs.length === 0) {
      return { ok: false, reason: `No SQLite database "${requested}" found in this project.` };
    }
    return {
      ok: false,
      reason: `No SQLite database matching "${requested}". Available: ${dbs.map((d) => `${d.name} (${d.file})`).join(', ')}.`,
    };
  }
  if (dbs.length === 1) return { ok: true, db: dbs[0] };
  if (dbs.length === 0) {
    return {
      ok: false,
      reason: 'No SQLite database exists in this project yet. Run sqlite_execute with CREATE TABLE ... to create app.db automatically.',
    };
  }
  return {
    ok: false,
    reason: `This project has ${dbs.length} SQLite databases (${dbs.map((d) => `${d.name} (${d.file})`).join(', ')}). Pass the "database" argument to choose one.`,
  };
}

function formatTableListSummary(session: SqliteSession): string {
  const tables = session.listTables();
  if (tables.length === 0) return '(no tables yet)';
  return tables
    .map((t) => `${t.name}${t.type === 'view' ? ' [view]' : ''} (${t.rowCount} ${t.rowCount === 1 ? 'row' : 'rows'})`)
    .join(', ');
}

/** `sqlite_list_databases` — Discover all SQLite databases and summarize their tables and row counts. */
export async function runSqliteListDatabases(deps: SqliteToolDeps): Promise<SqliteToolResult> {
  const dbs = detectStudioSqliteDatabases(deps.files);
  if (dbs.length === 0) {
    return {
      isError: false,
      subject: 'SQLite databases',
      content:
        'No SQLite databases found in this project yet. You can create one by calling sqlite_execute with a CREATE TABLE statement (defaults to app.db and registers it in manifest.json).',
    };
  }
  const opts = getRuntimeOptions(deps);
  const lines: string[] = [];
  for (const db of dbs) {
    let session: SqliteSession | null = null;
    try {
      session = await SqliteSession.open(db, (p) => readStudioTextFile(deps.files, p), opts);
      const stats = session.pageInfo();
      const sizeKb = (stats.approxBytes / 1024).toFixed(1);
      const seedNote = db.seedSqlPaths.length > 0 ? `, seedSql: ${db.seedSqlPaths.join(', ')}` : '';
      const modeNote = db.hasBinary ? 'bundled .db' : 'seeded from SQL';
      lines.push(`- ${db.name} (${db.file}, ${modeNote}, ${sizeKb} KB${seedNote}): ${formatTableListSummary(session)}`);
    } catch (err) {
      lines.push(`- ${db.name} (${db.file}): could not open (${err instanceof Error ? err.message : String(err)})`);
    } finally {
      session?.close();
    }
  }
  return {
    isError: false,
    subject: `${dbs.length} SQLite DB${dbs.length === 1 ? '' : 's'}`,
    content: lines.join('\n'),
  };
}

/** `sqlite_schema` — Inspect tables, columns, primary keys, indexes, foreign keys, and CREATE DDL. */
export async function runSqliteSchema(
  input: Record<string, unknown>,
  deps: SqliteToolDeps
): Promise<SqliteToolResult> {
  const requestedDb = typeof input.database === 'string' ? input.database : undefined;
  const requestedTable = typeof input.table === 'string' && input.table.trim() ? input.table.trim() : undefined;
  const dbs = detectStudioSqliteDatabases(deps.files);
  const resolved = matchDatabase(dbs, requestedDb);
  if (!resolved.ok) {
    return { isError: true, subject: requestedDb || 'SQLite schema', content: resolved.reason };
  }
  const db = resolved.db;
  let session: SqliteSession | null = null;
  try {
    session = await SqliteSession.open(db, (p) => readStudioTextFile(deps.files, p), getRuntimeOptions(deps));
    const allTables = session.listTables();
    const targets = requestedTable
      ? allTables.filter((t) => t.name.toLowerCase() === requestedTable.toLowerCase())
      : allTables;

    if (requestedTable && targets.length === 0) {
      return {
        isError: true,
        subject: `${db.name}.${requestedTable}`,
        content: `Table "${requestedTable}" was not found in ${db.file}. Available tables: ${allTables.map((t) => t.name).join(', ') || '(none)'}.`,
      };
    }

    if (targets.length === 0) {
      return {
        isError: false,
        subject: db.file,
        content: `${db.name} (${db.file}) has no tables yet.`,
      };
    }

    const blocks: string[] = [`Database: ${db.name} (${db.file})`];
    for (const tbl of targets) {
      const st = session.getTableStructure(tbl.name);
      const colLines = st.columns.map((c) => {
        const flags: string[] = [];
        if (c.pk > 0) flags.push('PK');
        if (c.notnull) flags.push('NOT NULL');
        if (c.dfltValue !== null) flags.push(`DEFAULT ${c.dfltValue}`);
        return `  - ${c.name}: ${c.type || 'ANY'}${flags.length ? ` [${flags.join(', ')}]` : ''}`;
      });
      const idxLines = st.indexes.map(
        (idx) => `  - index ${idx.name}${idx.unique ? ' (UNIQUE)' : ''} on (${idx.columns.join(', ')})`
      );
      const fkLines = st.foreignKeys.map(
        (fk) => `  - FK ${fk.from} -> ${fk.table}(${fk.to}) ON UPDATE ${fk.onUpdate} ON DELETE ${fk.onDelete}`
      );
      blocks.push(
        [
          `\n### ${st.type} ${st.name} (${tbl.rowCount} ${tbl.rowCount === 1 ? 'row' : 'rows'})`,
          ...colLines,
          ...idxLines,
          ...fkLines,
          st.sql ? `DDL:\n${st.sql};` : '',
        ]
          .filter(Boolean)
          .join('\n')
      );
    }

    return {
      isError: false,
      subject: requestedTable ? `${db.file}:${requestedTable}` : db.file,
      content: blocks.join('\n'),
    };
  } catch (err) {
    return {
      isError: true,
      subject: db.file,
      content: `Failed to inspect ${db.file}: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    session?.close();
  }
}

/** `sqlite_query` — Run a read-only SELECT / PRAGMA / EXPLAIN query against an app SQLite DB. */
export async function runSqliteQuery(
  input: Record<string, unknown>,
  deps: SqliteToolDeps
): Promise<SqliteToolResult> {
  const sql = typeof input.sql === 'string' ? input.sql.trim() : '';
  const requestedDb = typeof input.database === 'string' ? input.database : undefined;
  if (!sql) {
    return { isError: true, subject: 'SQLite query', content: 'sql is required.' };
  }
  if (!isReadOnlySql(sql)) {
    return {
      isError: true,
      subject: 'SQLite query',
      content: 'sqlite_query only allows read-only SELECT, WITH, EXPLAIN, or read-only PRAGMA statements. Use sqlite_execute to run CREATE, ALTER, DROP, INSERT, UPDATE, or DELETE.',
    };
  }
  const dbs = detectStudioSqliteDatabases(deps.files);
  const resolved = matchDatabase(dbs, requestedDb);
  if (!resolved.ok) {
    return { isError: true, subject: requestedDb || 'SQLite query', content: resolved.reason };
  }
  const db = resolved.db;
  const params = Array.isArray(input.params) ? input.params : undefined;
  const rawLimit = Number(input.limit);
  const limit = Number.isFinite(rawLimit) && rawLimit >= 1
    ? Math.min(MAX_QUERY_LIMIT, Math.floor(rawLimit))
    : DEFAULT_QUERY_LIMIT;

  let session: SqliteSession | null = null;
  try {
    session = await SqliteSession.open(db, (p) => readStudioTextFile(deps.files, p), getRuntimeOptions(deps));
    const res = params && params.length > 0 ? session.exec(sql, params) : session.execScript(sql);
    const body = formatRowsTable(res.columns, res.rows, limit);
    return {
      isError: false,
      subject: db.file,
      content: `${db.name} (${db.file}) — ${res.rows.length} row(s):\n${body}`,
    };
  } catch (err) {
    return {
      isError: true,
      subject: db.file,
      content: `SQLite query failed on ${db.file}: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    session?.close();
  }
}

/** Why the tool may not write `path`, or null: a project path, not Studio's own, and of the kind (`ending`) it has to be. */
function writableProblem(path: string, ending?: RegExp): { path: string; problem: string } | null {
  const verdict = resolveProjectPath(path);
  if (!verdict.ok) return { path, problem: `${path} is not a project path: ${verdict.reason}` };
  if (verdict.private) return { path, problem: `${verdict.path} is private editor state (builder/), which you do not write` };
  if (ending && !ending.test(verdict.path)) return { path, problem: `${verdict.path} is not a .sql file, and the seed dump is SQL: give seed_sql_path a .sql file` };
  return null;
}

/**
 * `sqlite_execute` — Execute DDL or DML statements against a project SQLite database,
 * persist the updated `.db` binary bytes into VFS as an atomic undoable `'ai'` transaction,
 * register in `manifest.json` if needed, and optionally write a `.sql` seed dump.
 */
export async function runSqliteExecute(
  input: Record<string, unknown>,
  deps: SqliteToolDeps
): Promise<SqliteToolResult> {
  const sql = typeof input.sql === 'string' ? input.sql.trim() : '';
  const requestedDb = typeof input.database === 'string' && input.database.trim() ? input.database.trim() : undefined;
  const syncSeedSql = input.sync_seed_sql === true;
  const seedSqlPathArg = typeof input.seed_sql_path === 'string' && input.seed_sql_path.trim()
    ? normalizeSqlitePath(input.seed_sql_path.trim())
    : undefined;

  if (!sql) {
    return { isError: true, subject: 'SQLite execute', content: 'sql is required.' };
  }

  const opts = getRuntimeOptions(deps);
  const dbs = detectStudioSqliteDatabases(deps.files);
  let targetDb: ProjectSqliteDatabase;
  let createdNewDb = false;

  if (dbs.length === 0) {
    const rawName = requestedDb ? requestedDb.replace(/\.(?:db|sqlite|sqlite3)$/i, '') : 'app';
    const fileOverride = requestedDb && /\.(?:db|sqlite|sqlite3)$/i.test(requestedDb) ? requestedDb : undefined;
    const emptyBytes = await createEmptySqliteBytes(opts);
    targetDb = buildNewSqliteDatabase(rawName, emptyBytes, fileOverride);
    createdNewDb = true;
  } else {
    const matched = matchDatabase(dbs, requestedDb);
    if (matched.ok) {
      targetDb = matched.db;
    } else if (requestedDb) {
      // Allow explicitly creating a new named database (e.g. database: "analytics.db")
      const rawName = requestedDb.replace(/\.(?:db|sqlite|sqlite3)$/i, '');
      const fileOverride = /\.(?:db|sqlite|sqlite3)$/i.test(requestedDb) ? requestedDb : undefined;
      const emptyBytes = await createEmptySqliteBytes(opts);
      targetDb = buildNewSqliteDatabase(rawName, emptyBytes, fileOverride);
      createdNewDb = true;
    } else {
      return { isError: true, subject: 'SQLite execute', content: matched.reason };
    }
  }

  // Where the tool writes is the project's own files, as for every other write: the seed dump
  // went wherever it was asked to (over index.html, into Studio's notes under builder/).
  const refusal =
    (createdNewDb ? writableProblem(normalizeSqlitePath(targetDb.file)) : null) ??
    (syncSeedSql ? writableProblem(seedSqlPathArg ?? normalizeSqlitePath(targetDb.seedSqlPaths[0] || 'backend/schema.sql'), /\.sql$/i) : null);
  if (refusal) return { isError: true, subject: refusal.path, content: `${refusal.problem}. Nothing was run or written.` };

  const params = Array.isArray(input.params) ? input.params : undefined;
  let session: SqliteSession | null = null;
  try {
    session = await SqliteSession.open(targetDb, (p) => readStudioTextFile(deps.files, p), opts);
    const execResult = params && params.length > 0 ? session.exec(sql, params) : session.execScript(sql);
    const nextBytes = session.exportBytes();
    const tablesSummary = formatTableListSummary(session);
    const dump = syncSeedSql ? session.exportSqlDump() : undefined;

    const persist = buildSqlitePersistRecords(deps.files, targetDb, nextBytes, {
      syncSeedSqlDump: dump,
      seedSqlPath: seedSqlPathArg,
    });

    // Build line diffs for any text files updated alongside the binary `.db`
    const diffs: LineDiff[] = [];
    const seenAfter: Array<{ path: string; whole: boolean; generated?: boolean }> = [];
    for (const rec of persist.records) {
      if (typeof rec.content === 'string') {
        const prev = deps.files.get(rec.path);
        const prevText = prev && typeof prev.content === 'string' ? prev.content : null;
        diffs.push(lineDiff(rec.path, prevText, rec.content));
        // Text the tool made (the manifest's database entry, the seed dump): not the model's to have seen whole.
        seenAfter.push({ path: rec.path, whole: false, generated: true });
      }
    }

    const transactionId = deps.commit(persist.records, seenAfter);
    const sizeKb = (nextBytes.byteLength / 1024).toFixed(1);
    const parts: string[] = [
      `${createdNewDb ? 'Created' : 'Updated'} ${persist.filePath} (${sizeKb} KB).`,
      `Changes: ${execResult.changes} row(s) affected${execResult.lastInsertRowid ? `, last_insert_rowid=${execResult.lastInsertRowid}` : ''}.`,
      `Tables: ${tablesSummary}.`,
    ];
    if (persist.seedSqlPath) {
      parts.push(`Synced SQL dump to ${persist.seedSqlPath}.`);
    }
    if (execResult.columns.length > 0 && execResult.rows.length > 0) {
      parts.push(`\nReturned rows:\n${formatRowsTable(execResult.columns, execResult.rows, DEFAULT_QUERY_LIMIT)}`);
    }

    return {
      isError: false,
      subject: persist.filePath,
      changed: true,
      transactionId,
      changeSummary: `${createdNewDb ? 'Created' : 'Modified'} SQLite database ${persist.filePath} (${execResult.changes} row change${execResult.changes === 1 ? '' : 's'}).`,
      diff: diffs.length > 0 ? diffs : undefined,
      content: parts.join('\n'),
    };
  } catch (err) {
    return {
      isError: true,
      subject: targetDb.file,
      content: `SQLite execution failed on ${targetDb.file}: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    session?.close();
  }
}
