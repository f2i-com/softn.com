/**
 * Builder adapter over `@softn/editor-shared/sqliteDatabase`.
 *
 * Bridges Builder's `projectStore` + `filesStore` (`extraEntries`, `logicFiles`, `assetFiles`)
 * to the shared XDB SQLite 3 WASM session and discovery engine.
 */

import type { LoadedXdbBindings } from '@softn/container';
import {
  SqliteSession as SharedSqliteSession,
  buildNewSqliteDatabase,
  createEmptySqliteBytes,
  detectSqliteDatabases,
  formatSqlLiteral,
  isMutatingSql,
  isReadOnlySql,
  normalizeSqlitePath,
  quoteSqlIdent,
  splitSqlStatements,
  sqliteBytesSignature,
  upsertSqliteManifest,
  type ProjectSqliteDatabase,
  type SqliteBrowseResult,
  type SqliteColumnInfo,
  type SqliteExecResult,
  type SqliteForeignKeyInfo,
  type SqliteIndexInfo,
  type SqliteNewColumnSpec,
  type SqliteTableStructure,
  type SqliteTableSummary,
} from '@softn/editor-shared/sqliteDatabase';
import { useProjectStore, type RetainedSource } from '../stores/projectStore';
import type { AssetFile, LogicFileState } from '../types/builder';

export {
  formatSqlLiteral,
  isMutatingSql,
  isReadOnlySql,
  quoteSqlIdent,
  splitSqlStatements,
  sqliteBytesSignature,
  type ProjectSqliteDatabase,
  type SqliteBrowseResult,
  type SqliteColumnInfo,
  type SqliteExecResult,
  type SqliteForeignKeyInfo,
  type SqliteIndexInfo,
  type SqliteNewColumnSpec,
  type SqliteTableStructure,
  type SqliteTableSummary,
};

export function readProjectSqliteTextFile(
  path: string,
  logicFiles: ReadonlyMap<string, LogicFileState>,
  extraEntries: ReadonlyMap<string, Uint8Array>
): string | null {
  const norm = normalizeSqlitePath(path);
  for (const lf of logicFiles.values()) {
    if (normalizeSqlitePath(lf.path) === norm) return lf.content;
  }
  const extra = extraEntries.get(norm);
  if (extra) return new TextDecoder().decode(extra);
  return null;
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
  const textFiles = new Map<string, string>();
  for (const lf of logicFiles.values()) {
    textFiles.set(normalizeSqlitePath(lf.path), lf.content);
  }
  const binaryFiles = new Map<string, Uint8Array>();
  for (const [p, bytes] of source.extraEntries) {
    binaryFiles.set(normalizeSqlitePath(p), bytes);
  }
  for (const a of assetFiles.values()) {
    const bp = normalizeSqlitePath(a.bundlePath || `assets/${a.name}`);
    if (!binaryFiles.has(bp)) binaryFiles.set(bp, a.data);
  }
  return detectSqliteDatabases({
    manifest: source.manifest,
    textFiles,
    binaryFiles,
  });
}

/**
 * Builder-compatible subclass of `SqliteSession` preserving `SqliteSession.openDatabase`.
 */
export class SqliteSession extends SharedSqliteSession {
  static async openDatabase(
    db: ProjectSqliteDatabase,
    logicFiles: ReadonlyMap<string, LogicFileState>,
    extraEntries: ReadonlyMap<string, Uint8Array>,
    options: {
      runtimeUrl?: string;
      bindings?: LoadedXdbBindings;
      forceReseed?: boolean;
    } = {}
  ): Promise<SharedSqliteSession> {
    return SharedSqliteSession.open(
      db,
      (path) => readProjectSqliteTextFile(path, logicFiles, extraEntries),
      options
    );
  }
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
  const filePath = normalizeSqlitePath(db.file);
  nextExtra.set(filePath, new Uint8Array(bytes));
  nextExtra.delete(`${filePath}-wal`);
  nextExtra.delete(`${filePath}-journal`);

  const baseManifest = upsertSqliteManifest(prevSource.manifest, db, {
    name: store.name || 'Untitled App',
    version: store.version || '1.0.0',
    description: store.description || '',
  });

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
  const bytes = await createEmptySqliteBytes(options);
  const db = buildNewSqliteDatabase(rawName, bytes);
  persistSqliteBytesToProject(db, bytes);
  return db;
}
