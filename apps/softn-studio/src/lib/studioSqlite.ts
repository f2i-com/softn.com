/**
 * Studio VFS adapter for the shared `@softn/editor-shared/sqliteDatabase` engine.
 *
 * Bridges `useVFSStore` (`Map<string, VFSFile>`, supporting both text and binary `Uint8Array`
 * entries with atomic undoable transactions) to XDB SQLite 3 WASM sessions used by both
 * Studio's visual Data tab and Studio's AI agent SQLite tools.
 */

import type { LoadedXdbBindings } from '@softn/container';
import {
  buildNewSqliteDatabase,
  createEmptySqliteBytes,
  detectSqliteDatabases,
  normalizeSqlitePath,
  upsertSqliteManifest,
  type ProjectSqliteDatabase,
  type SqliteFileIndex,
} from '@softn/editor-shared/sqliteDatabase';
import type { VFSFile } from '../types/studio';
import { useVFSStore, type VFSChangeRecord } from '../stores/vfsStore';
import { useWorkspaceStore } from '../stores/workspaceStore';
import { isPrivatePath } from './paths';
import { busyReason } from './fileOps';

export function parseStudioManifest(files: ReadonlyMap<string, VFSFile>): Record<string, unknown> | null {
  const mf = files.get('manifest.json');
  if (!mf || typeof mf.content !== 'string') return null;
  try {
    const parsed = JSON.parse(mf.content);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function buildStudioSqliteIndex(files: ReadonlyMap<string, VFSFile>): SqliteFileIndex {
  const textFiles = new Map<string, string>();
  const binaryFiles = new Map<string, Uint8Array>();
  for (const [path, file] of files) {
    if (isPrivatePath(path)) continue;
    const norm = normalizeSqlitePath(path);
    if (typeof file.content === 'string') {
      textFiles.set(norm, file.content);
    } else if (file.content instanceof Uint8Array) {
      binaryFiles.set(norm, file.content);
    }
  }
  return {
    manifest: parseStudioManifest(files),
    textFiles,
    binaryFiles,
  };
}

export function detectStudioSqliteDatabases(files: ReadonlyMap<string, VFSFile>): ProjectSqliteDatabase[] {
  return detectSqliteDatabases(buildStudioSqliteIndex(files));
}

export function readStudioTextFile(files: ReadonlyMap<string, VFSFile>, path: string): string | null {
  const norm = normalizeSqlitePath(path);
  const direct = files.get(norm);
  if (direct) {
    return typeof direct.content === 'string'
      ? direct.content
      : new TextDecoder().decode(direct.content);
  }
  for (const [k, f] of files) {
    if (normalizeSqlitePath(k) === norm) {
      return typeof f.content === 'string' ? f.content : new TextDecoder().decode(f.content);
    }
  }
  return null;
}

export interface BuildSqlitePersistResult {
  records: VFSChangeRecord[];
  filePath: string;
  manifestText: string;
  seedSqlPath?: string;
}

/**
 * Build atomic `VFSChangeRecord[]` to write a SQLite `.db` binary, clean up stale WAL/journal
 * sidecars, register the DB in `manifest.json` (`databases[]`), and optionally write a `.sql` seed dump.
 */
export function buildSqlitePersistRecords(
  files: ReadonlyMap<string, VFSFile>,
  db: ProjectSqliteDatabase,
  bytes: Uint8Array,
  options: { syncSeedSqlDump?: string; seedSqlPath?: string } = {}
): BuildSqlitePersistResult {
  const filePath = normalizeSqlitePath(db.file);
  const records: VFSChangeRecord[] = [];
  const nextBytes = new Uint8Array(bytes);

  records.push({
    op: files.has(filePath) ? 'update' : 'create',
    path: filePath,
    content: nextBytes,
  });

  // Clear stale WAL / rollback journal files beside the freshly exported DB
  for (const sidecar of [`${filePath}-wal`, `${filePath}-journal`]) {
    if (files.has(sidecar)) {
      records.push({ op: 'delete', path: sidecar });
    }
  }

  let effectiveSeedSqlPath: string | undefined;
  if (typeof options.syncSeedSqlDump === 'string') {
    effectiveSeedSqlPath = normalizeSqlitePath(
      options.seedSqlPath || db.seedSqlPaths[0] || 'backend/schema.sql'
    );
    records.push({
      op: files.has(effectiveSeedSqlPath) ? 'update' : 'create',
      path: effectiveSeedSqlPath,
      content: options.syncSeedSqlDump,
    });
  }

  const ws = useWorkspaceStore.getState();
  const dbWithSeed: ProjectSqliteDatabase = effectiveSeedSqlPath
    ? {
        ...db,
        seedSqlPaths: db.seedSqlPaths.includes(effectiveSeedSqlPath)
          ? db.seedSqlPaths
          : [effectiveSeedSqlPath, ...db.seedSqlPaths],
      }
    : db;

  const currentManifest = parseStudioManifest(files);
  const nextManifest = upsertSqliteManifest(currentManifest, dbWithSeed, {
    name: ws.projectName || ws.brief?.appName || 'Untitled App',
    version: '1.0.0',
    description: ws.brief?.description || '',
  });
  const manifestText = `${JSON.stringify(nextManifest, null, 2)}\n`;
  const existingManifestFile = files.get('manifest.json');
  const existingManifestText =
    existingManifestFile && typeof existingManifestFile.content === 'string'
      ? existingManifestFile.content
      : null;

  if (existingManifestText !== manifestText) {
    records.push({
      op: existingManifestFile ? 'update' : 'create',
      path: 'manifest.json',
      content: manifestText,
    });
  }

  return { records, filePath, manifestText, seedSqlPath: effectiveSeedSqlPath };
}

/**
 * Persist modified SQLite `.db` binary bytes into Studio's VFS as an undoable user transaction.
 */
export function persistStudioSqliteBytes(
  db: ProjectSqliteDatabase,
  bytes: Uint8Array,
  label?: string
): void {
  const busy = busyReason();
  if (busy) throw new Error(busy);
  const vfs = useVFSStore.getState();
  const { records } = buildSqlitePersistRecords(vfs.files, db, bytes);
  vfs.applyTransaction(records, 'user', undefined, label || `Updated SQLite database ${db.file}`);
}

/**
 * Create a brand-new empty SQLite `.db` in Studio's VFS and register it in `manifest.json`.
 */
export async function createStudioSqliteDatabase(
  rawName: string,
  options: { runtimeUrl?: string; bindings?: LoadedXdbBindings; fileOverride?: string } = {}
): Promise<ProjectSqliteDatabase> {
  const busy = busyReason();
  if (busy) throw new Error(busy);
  const projectId = useWorkspaceStore.getState().projectId;
  const bytes = await createEmptySqliteBytes(options);
  // The engine loads first, which can take a while: the project open now may not be the one
  // the database was asked for, and a run may have begun.
  if (useWorkspaceStore.getState().projectId !== projectId) throw new Error('Another project was opened while the database was being made, so it was not added to it.');
  const began = busyReason();
  if (began) throw new Error(began);
  const db = buildNewSqliteDatabase(rawName, bytes, options.fileOverride);
  const vfs = useVFSStore.getState();
  const { records } = buildSqlitePersistRecords(vfs.files, db, bytes);
  vfs.applyTransaction(records, 'user', undefined, `Created SQLite database ${db.file}`);
  return db;
}

/**
 * Write an exported SQL dump back into the database's seed `.sql` file in Studio's VFS.
 */
export function syncStudioSqliteSeedSql(db: ProjectSqliteDatabase, sqlDump: string): void {
  const busy = busyReason();
  if (busy) throw new Error(busy);
  const vfs = useVFSStore.getState();
  const seedPath = normalizeSqlitePath(db.seedSqlPaths[0] || 'backend/schema.sql');
  const records: VFSChangeRecord[] = [
    {
      op: vfs.files.has(seedPath) ? 'update' : 'create',
      path: seedPath,
      content: sqlDump,
    },
  ];
  const currentManifest = parseStudioManifest(vfs.files);
  const dbWithSeed: ProjectSqliteDatabase = {
    ...db,
    seedSqlPaths: [seedPath, ...db.seedSqlPaths.filter((p) => p !== seedPath)],
  };
  const ws = useWorkspaceStore.getState();
  const nextManifest = upsertSqliteManifest(currentManifest, dbWithSeed, {
    name: ws.projectName || ws.brief?.appName || 'Untitled App',
    version: '1.0.0',
    description: ws.brief?.description || '',
  });
  const manifestText = `${JSON.stringify(nextManifest, null, 2)}\n`;
  const existingManifest = vfs.files.get('manifest.json');
  if (!existingManifest || existingManifest.content !== manifestText) {
    records.push({
      op: existingManifest ? 'update' : 'create',
      path: 'manifest.json',
      content: manifestText,
    });
  }
  vfs.applyTransaction(records, 'user', undefined, `Synced SQLite schema to ${seedPath}`);
}
