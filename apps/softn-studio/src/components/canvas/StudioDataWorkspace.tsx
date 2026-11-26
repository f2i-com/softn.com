/**
 * StudioDataWorkspace — Visual Data editor inside SoftN AI Studio (`Preview | Code | Data`).
 *
 * Lets users inspect and modify BOTH:
 * 1. Embedded XDB SQLite 3 databases (`.db` / `.sqlite` / `manifest.databases` / `.sql`) using the
 *    exact same mini-phpMyAdmin editor as SoftN Builder (`@softn/editor-shared/SqliteDatabaseAdmin`),
 *    staying live-synced with AI agent `sqlite_*` edits and Undo/Redo history.
 * 2. Local `.xdb` document collections (browse/add/edit/delete seed rows & structure fields) and
 *    FormLogic private SQLite tables & API routes (`StudioDatabase` + `BackendEditor`).
 *
 * Available for BOTH Web App Containers (HTML/React/Vue/JS/TS) AND Classic `.ui` apps.
 */

import React, { Suspense, useEffect, useMemo, useState } from 'react';
import { hostedContainerOptions } from '@softn/runtime-shell/containerHost';
import {
  SqliteDatabaseAdmin,
  type SqliteDatabaseAdminHost,
} from '@softn/editor-shared/SqliteDatabaseAdmin';
import '@softn/editor-shared/sqliteAdmin.css';
import { useAIStore, useVFSStore, useWorkspaceStore } from '../../stores';
import {
  createStudioSqliteDatabase,
  detectStudioSqliteDatabases,
  parseStudioManifest,
  persistStudioSqliteBytes,
  readStudioTextFile,
  syncStudioSqliteSeedSql,
} from '../../lib/studioSqlite';
import { isPrivatePath } from '../../lib/paths';
import { busyReason } from '../../lib/fileOps';
import type { VFSFile } from '../../types/studio';

const StudioProjectTools = React.lazy(() => import('../panels/StudioDatabase'));

interface ParsedXdbCollection {
  path: string;
  collection: string;
  schemaFields: Array<{ name: string; type: string; required?: boolean }>;
  records: Array<Record<string, unknown>>;
  rawObject: Record<string, unknown>;
  parseError: string | null;
}

interface FormLogicServerInfo {
  entry: string | null;
  migrations: Array<{ path: string; sql: string }>;
  routes: Array<{ method: string; path: string; handler: string; transaction?: string }>;
}

function parseXdbCollections(files: ReadonlyMap<string, VFSFile>): ParsedXdbCollection[] {
  const out: ParsedXdbCollection[] = [];
  for (const [path, file] of files) {
    if (isPrivatePath(path) || !/\.xdb$/i.test(path) || typeof file.content !== 'string') continue;
    const fallbackName = path.split('/').pop()?.replace(/\.xdb$/i, '') || 'collection';
    try {
      const parsed = JSON.parse(file.content);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        out.push({
          path,
          collection: fallbackName,
          schemaFields: [],
          records: [],
          rawObject: { collection: fallbackName, records: [] },
          parseError: 'File is not a JSON object.',
        });
        continue;
      }
      const obj = parsed as Record<string, unknown>;
      const collection = typeof obj.collection === 'string' && obj.collection.trim() ? obj.collection.trim() : fallbackName;
      const rawRecords = Array.isArray(obj.records) ? obj.records : [];
      const records = rawRecords
        .filter((r): r is Record<string, unknown> => Boolean(r && typeof r === 'object' && !Array.isArray(r)))
        .map((r) => ({ ...r }));

      const fieldMap = new Map<string, { name: string; type: string; required?: boolean }>();
      // Read schema.fields if present (either array or object map)
      const schema = obj.schema && typeof obj.schema === 'object' ? (obj.schema as Record<string, unknown>) : null;
      if (schema && Array.isArray(schema.fields)) {
        for (const f of schema.fields) {
          if (f && typeof f === 'object' && typeof (f as Record<string, unknown>).name === 'string') {
            const rec = f as Record<string, unknown>;
            fieldMap.set(String(rec.name), {
              name: String(rec.name),
              type: typeof rec.type === 'string' ? rec.type : 'string',
              required: Boolean(rec.required),
            });
          }
        }
      } else if (schema && schema.fields && typeof schema.fields === 'object') {
        for (const [fname, fval] of Object.entries(schema.fields as Record<string, unknown>)) {
          const ftype = typeof fval === 'string'
            ? fval
            : fval && typeof fval === 'object' && typeof (fval as Record<string, unknown>).type === 'string'
              ? String((fval as Record<string, unknown>).type)
              : 'string';
          fieldMap.set(fname, {
            name: fname,
            type: ftype,
            required: Boolean(fval && typeof fval === 'object' && (fval as Record<string, unknown>).required),
          });
        }
      }
      // Infer additional fields from records (`r.data` if wrapped, or top-level keys)
      for (const rec of records) {
        const payload = rec.data && typeof rec.data === 'object' && !Array.isArray(rec.data)
          ? (rec.data as Record<string, unknown>)
          : rec;
        for (const [k, v] of Object.entries(payload)) {
          if (k === 'id' || k === 'created_at' || k === 'updated_at' || k === 'collection' || k === 'deleted') continue;
          if (!fieldMap.has(k)) {
            const inferred = typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : 'string';
            fieldMap.set(k, { name: k, type: inferred });
          }
        }
      }

      out.push({
        path,
        collection,
        schemaFields: [...fieldMap.values()],
        records,
        rawObject: obj,
        parseError: null,
      });
    } catch (err) {
      out.push({
        path,
        collection: fallbackName,
        schemaFields: [],
        records: [],
        rawObject: { collection: fallbackName, records: [] },
        parseError: err instanceof Error ? err.message : 'Invalid JSON',
      });
    }
  }
  return out.sort((a, b) => a.collection.localeCompare(b.collection));
}

function readFormLogicServerInfo(files: ReadonlyMap<string, VFSFile>): FormLogicServerInfo {
  const manifest = parseStudioManifest(files);
  const server = manifest?.server && typeof manifest.server === 'object'
    ? (manifest.server as Record<string, unknown>)
    : null;
  const entry = typeof server?.entry === 'string' ? server.entry : null;

  const migrationPaths = new Set<string>();
  const dbBlock = server?.database && typeof server.database === 'object'
    ? (server.database as Record<string, unknown>)
    : null;
  if (Array.isArray(dbBlock?.migrations)) {
    for (const m of dbBlock.migrations) {
      if (typeof m === 'string') migrationPaths.add(m);
    }
  }
  for (const path of files.keys()) {
    if (/^server\/migrations\/.*\.sql$/i.test(path)) migrationPaths.add(path);
  }
  const migrations = [...migrationPaths]
    .sort((a, b) => a.localeCompare(b))
    .map((path) => {
      const f = files.get(path);
      return { path, sql: f && typeof f.content === 'string' ? f.content : '' };
    });

  const routes = Array.isArray(server?.routes)
    ? (server.routes as Array<Record<string, unknown>>)
        .filter((r) => r && typeof r === 'object')
        .map((r) => ({
          method: String(r.method ?? 'GET'),
          path: String(r.path ?? '/api/'),
          handler: String(r.handler ?? ''),
          transaction: typeof r.transaction === 'string' ? r.transaction : undefined,
        }))
    : [];

  return { entry, migrations, routes };
}

function coerceXdbValue(raw: string, type: string): unknown {
  if (type === 'number' || type === 'integer') {
    const trimmed = raw.trim();
    if (trimmed === '') return 0;
    const num = Number(trimmed);
    return Number.isFinite(num) ? (type === 'integer' ? Math.trunc(num) : num) : raw;
  }
  if (type === 'boolean') {
    return raw === 'true' || raw === '1';
  }
  return raw;
}

function recordUsesWrappedData(rec: Record<string, unknown>): boolean {
  return Boolean(rec.data && typeof rec.data === 'object' && !Array.isArray(rec.data));
}

function readRecordField(rec: Record<string, unknown>, field: string): unknown {
  if (field === 'id') return rec.id;
  if (recordUsesWrappedData(rec)) {
    return (rec.data as Record<string, unknown>)[field];
  }
  return rec[field];
}

function writeRecordFields(
  original: Record<string, unknown> | null,
  id: string,
  values: Record<string, unknown>,
  preferWrapped: boolean
): Record<string, unknown> {
  if (original && recordUsesWrappedData(original)) {
    return {
      ...original,
      id,
      data: { ...(original.data as Record<string, unknown>), ...values },
    };
  }
  if (!original && preferWrapped) {
    return { id, data: { ...values } };
  }
  return { ...(original ?? {}), id, ...values };
}

const s: Record<string, React.CSSProperties> = {
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minHeight: 0,
    width: '100%',
    background: 'var(--ink)',
    color: 'var(--paper)',
    fontFamily: 'var(--body)',
    fontSize: 13,
  },
  topbar: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '8px 14px',
    minHeight: 46,
    background: 'var(--ink-2)',
    borderBottom: '1px solid var(--line-soft)',
    flexWrap: 'wrap',
    flexShrink: 0,
  },
  title: {
    fontFamily: 'var(--display)',
    fontWeight: 700,
    fontSize: 14,
    color: 'var(--paper)',
  },
  body: {
    display: 'flex',
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
  },
  sidebar: {
    width: 240,
    minWidth: 190,
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--ink-2)',
    borderRight: '1px solid var(--line-soft)',
    minHeight: 0,
    overflowY: 'auto',
    padding: '8px 8px 14px',
    gap: 6,
  },
  sideSection: {
    fontSize: 11,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    color: 'var(--dim)',
    padding: '8px 6px 4px',
  },
  sideBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    width: '100%',
    padding: '7px 9px',
    borderRadius: 6,
    border: 'none',
    background: 'transparent',
    color: 'var(--paper)',
    cursor: 'pointer',
    textAlign: 'left',
    fontSize: 12.5,
    fontFamily: 'var(--mono)',
  },
  sideBtnActive: {
    background: 'rgba(99, 102, 241, 0.2)',
    fontWeight: 600,
  },
  pill: {
    fontSize: 11,
    color: 'var(--dim)',
    background: 'rgba(128, 128, 128, 0.14)',
    padding: '1px 6px',
    borderRadius: 999,
    flexShrink: 0,
  },
  main: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    overflow: 'auto',
    padding: 16,
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
  },
  card: {
    background: 'var(--ink-2)',
    border: '1px solid var(--line-soft)',
    borderRadius: 8,
    padding: 14,
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  tableWrap: {
    width: '100%',
    overflowX: 'auto',
    border: '1px solid var(--line-soft)',
    borderRadius: 8,
    background: 'var(--ink-2)',
  },
  grid: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: 12.5,
    fontFamily: 'var(--mono)',
  },
  th: {
    textAlign: 'left',
    padding: '8px 10px',
    background: 'rgba(128, 128, 128, 0.06)',
    borderBottom: '1px solid var(--line)',
    color: 'var(--dim)',
    fontWeight: 600,
    whiteSpace: 'nowrap',
  },
  td: {
    padding: '7px 10px',
    borderBottom: '1px solid var(--line-soft)',
    color: 'var(--paper)',
    maxWidth: 320,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  input: {
    background: 'var(--ink)',
    color: 'var(--paper)',
    border: '1px solid var(--line)',
    borderRadius: 6,
    padding: '5px 8px',
    fontSize: 12.5,
    outline: 'none',
  },
  select: {
    background: 'var(--ink)',
    color: 'var(--paper)',
    border: '1px solid var(--line)',
    borderRadius: 6,
    padding: '5px 8px',
    fontSize: 12.5,
    fontFamily: 'var(--mono)',
  },
  emptyCenter: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    padding: 32,
    textAlign: 'center',
    color: 'var(--dim)',
  },
  errorBox: {
    padding: '9px 12px',
    borderRadius: 6,
    background: 'rgba(239, 68, 68, 0.12)',
    border: '1px solid rgba(239, 68, 68, 0.45)',
    color: 'var(--danger, #fca5a5)',
    fontSize: 12.5,
    fontFamily: 'var(--mono)',
  },
  okBox: {
    padding: '6px 10px',
    borderRadius: 6,
    background: 'rgba(16, 185, 129, 0.12)',
    border: '1px solid rgba(16, 185, 129, 0.4)',
    color: 'var(--mint, #6ee7b7)',
    fontSize: 12,
  },
};

export interface StudioDataWorkspaceProps {
  /** Open a specific project file in Studio's Code editor. */
  onOpenFile?: (path: string) => void;
}

export const StudioDataWorkspace: React.FC<StudioDataWorkspaceProps> = ({ onOpenFile }) => {
  const files = useVFSStore((st) => st.files);
  const projectId = useWorkspaceStore((st) => st.projectId) ?? 'studio-project';
  const agentWriting = useAIStore((st) => st.agentState === 'building');

  const sqliteDbs = useMemo(() => detectStudioSqliteDatabases(files), [files]);
  const xdbCollections = useMemo(() => parseXdbCollections(files), [files]);
  const formLogic = useMemo(() => readFormLogicServerInfo(files), [files]);
  const manifest = useMemo(() => parseStudioManifest(files), [files]);
  const hasContainerBackend = Boolean(
    manifest?.backend && typeof manifest.backend === 'object'
  );

  const collectionsAndServerCount = xdbCollections.length + (formLogic.entry || formLogic.migrations.length > 0 ? 1 : 0);
  const defaultMode: 'sqlite' | 'collections' =
    sqliteDbs.length > 0 || (hasContainerBackend && collectionsAndServerCount === 0)
      ? 'sqlite'
      : 'collections';

  const [mode, setMode] = useState<'sqlite' | 'collections'>(defaultMode);
  useEffect(() => {
    setMode(defaultMode);
  }, [projectId, defaultMode]);

  const [toolDialog, setToolDialog] = useState<'database' | 'backend' | null>(null);
  const [selectedCollectionPath, setSelectedCollectionPath] = useState<string | '__formlogic__'>(() =>
    xdbCollections[0]?.path ?? (formLogic.entry || formLogic.migrations.length > 0 ? '__formlogic__' : '')
  );
  const [collectionTab, setCollectionTab] = useState<'rows' | 'fields'>('rows');
  const [rowSearch, setRowSearch] = useState('');
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  /**
   * The file the row being edited is in, as it was when the row was opened. The row is known by
   * its place in the file, and a file changed meanwhile (another tab's save taken in, an undo)
   * may hold another record there: the draft was written over that one.
   */
  const [editingFrom, setEditingFrom] = useState<{ path: string; version: number } | null>(null);
  const [rowDraft, setRowDraft] = useState<Record<string, string>>({});
  const [addingRow, setAddingRow] = useState(false);
  const [newFieldName, setNewFieldName] = useState('');
  const [newFieldType, setNewFieldType] = useState<'string' | 'number' | 'boolean' | 'date'>('string');
  const [newFieldDefault, setNewFieldDefault] = useState('');
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    if (!feedback) return;
    const t = setTimeout(() => setFeedback(null), 3200);
    return () => clearTimeout(t);
  }, [feedback]);

  useEffect(() => {
    if (selectedCollectionPath === '__formlogic__') {
      if (formLogic.entry || formLogic.migrations.length > 0) return;
    }
    if (xdbCollections.some((c) => c.path === selectedCollectionPath)) return;
    if (xdbCollections[0]) setSelectedCollectionPath(xdbCollections[0].path);
    else if (formLogic.entry || formLogic.migrations.length > 0) setSelectedCollectionPath('__formlogic__');
    else setSelectedCollectionPath('');
  }, [xdbCollections, formLogic.entry, formLogic.migrations.length, selectedCollectionPath]);

  const activeCollection = useMemo(
    () => xdbCollections.find((c) => c.path === selectedCollectionPath) ?? null,
    [xdbCollections, selectedCollectionPath]
  );
  // A form opened on one collection is not one for the next.
  const activePath = activeCollection?.path ?? null;
  useEffect(() => {
    setEditingIndex(null);
    setEditingFrom(null);
    setAddingRow(false);
  }, [activePath]);

  const sqliteHost = useMemo<SqliteDatabaseAdminHost>(
    () => ({
      projectId,
      databases: sqliteDbs,
      runtimeUrl: hostedContainerOptions().runtimeUrl,
      readOnly: agentWriting,
      readOnlyReason: 'The AI is working: manual SQLite edits pause until the run stops, and AI changes appear live.',
      readTextFile: (path) => readStudioTextFile(useVFSStore.getState().files, path),
      persistBytes: (db, bytes, label) => {
        persistStudioSqliteBytes(db, bytes, label);
      },
      createDatabase: (rawName, opts) => createStudioSqliteDatabase(rawName, opts),
      onSyncSeedSql: (db, dump) => {
        syncStudioSqliteSeedSql(db, dump);
      },
    }),
    [projectId, sqliteDbs, agentWriting]
  );

  const modeSwitch = (
    <div className="sn-sql-seg" role="group" aria-label="Data engine">
      <button
        type="button"
        aria-pressed={mode === 'sqlite'}
        onClick={() => setMode('sqlite')}
        title="Inspect and edit embedded XDB SQLite 3 databases"
      >
        SQLite{sqliteDbs.length > 0 ? ` (${sqliteDbs.length})` : ''}
      </button>
      <button
        type="button"
        aria-pressed={mode === 'collections'}
        onClick={() => setMode('collections')}
        title="Manage local .xdb collections and FormLogic tables & API routes"
      >
        Collections &amp; FormLogic{collectionsAndServerCount > 0 ? ` (${collectionsAndServerCount})` : ''}
      </button>
    </div>
  );

  const saveCollection = (
    col: ParsedXdbCollection,
    nextRecords: Array<Record<string, unknown>>,
    nextFields: Array<{ name: string; type: string; required?: boolean }>,
    label: string
  ) => {
    const busy = busyReason();
    if (busy) {
      setFeedback({ kind: 'err', text: busy });
      return;
    }
    const nextObj: Record<string, unknown> = {
      ...col.rawObject,
      collection: col.collection,
      schema: {
        ...(col.rawObject.schema && typeof col.rawObject.schema === 'object'
          ? (col.rawObject.schema as Record<string, unknown>)
          : {}),
        fields: nextFields,
      },
      records: nextRecords,
    };
    const content = `${JSON.stringify(nextObj, null, 2)}\n`;
    const vfs = useVFSStore.getState();
    vfs.applyTransaction(
      [{ op: vfs.files.has(col.path) ? 'update' : 'create', path: col.path, content }],
      'user',
      undefined,
      label
    );
    setFeedback({ kind: 'ok', text: label });
  };

  const openNewRowForm = () => {
    if (!activeCollection) return;
    // One more than the count was, after a deletion, often a record's own id.
    const ids = new Set(activeCollection.records.map((record) => String(record.id ?? '')));
    let next = activeCollection.records.length + 1;
    while (ids.has(`${activeCollection.collection}-${next}`)) next++;
    const nextId = `${activeCollection.collection}-${next}`;
    const draft: Record<string, string> = { id: nextId };
    for (const f of activeCollection.schemaFields) {
      draft[f.name] = f.type === 'boolean' ? 'false' : f.type === 'number' || f.type === 'integer' ? '0' : '';
    }
    setRowDraft(draft);
    setEditingIndex(null);
    setAddingRow(true);
  };

  const openEditRowForm = (index: number) => {
    if (!activeCollection) return;
    const rec = activeCollection.records[index];
    if (!rec) return;
    const draft: Record<string, string> = { id: String(rec.id ?? '') };
    for (const f of activeCollection.schemaFields) {
      const val = readRecordField(rec, f.name);
      draft[f.name] = val === null || val === undefined ? '' : typeof val === 'object' ? JSON.stringify(val) : String(val);
    }
    setRowDraft(draft);
    setAddingRow(false);
    setEditingIndex(index);
    setEditingFrom({ path: activeCollection.path, version: files.get(activeCollection.path)?.version ?? -1 });
  };

  const handleCommitRow = (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeCollection) return;
    const id = (rowDraft.id || '').trim() || `${activeCollection.collection}-${Date.now()}`;
    const values: Record<string, unknown> = {};
    for (const f of activeCollection.schemaFields) {
      values[f.name] = coerceXdbValue(rowDraft[f.name] ?? '', f.type);
    }
    const preferWrapped = activeCollection.records.some(recordUsesWrappedData);
    const nextRecords = [...activeCollection.records];
    if (addingRow) {
      nextRecords.push(writeRecordFields(null, id, values, preferWrapped));
      saveCollection(activeCollection, nextRecords, activeCollection.schemaFields, `Added row to ${activeCollection.collection}`);
      setAddingRow(false);
    } else if (editingIndex !== null && nextRecords[editingIndex]) {
      if (editingFrom?.path !== activeCollection.path || files.get(activeCollection.path)?.version !== editingFrom.version) {
        setFeedback({ kind: 'err', text: `${activeCollection.path} changed while the row was open (an undo, the AI or another tab), so nothing was saved over it. Open the row again to edit it as it is now.` });
        return;
      }
      nextRecords[editingIndex] = writeRecordFields(nextRecords[editingIndex], id, values, preferWrapped);
      saveCollection(activeCollection, nextRecords, activeCollection.schemaFields, `Updated row in ${activeCollection.collection}`);
      setEditingIndex(null);
    }
  };

  const handleDeleteCollectionRow = (index: number) => {
    if (!activeCollection) return;
    const nextRecords = activeCollection.records.filter((_, i) => i !== index);
    saveCollection(activeCollection, nextRecords, activeCollection.schemaFields, `Deleted row from ${activeCollection.collection}`);
  };

  const handleAddCollectionField = (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeCollection) return;
    const name = newFieldName.trim();
    if (!name) return;
    if (activeCollection.schemaFields.some((f) => f.name.toLowerCase() === name.toLowerCase())) {
      setFeedback({ kind: 'err', text: `Field "${name}" already exists.` });
      return;
    }
    const nextFields = [...activeCollection.schemaFields, { name, type: newFieldType }];
    const defaultVal = newFieldDefault !== '' ? coerceXdbValue(newFieldDefault, newFieldType) : undefined;
    const nextRecords =
      defaultVal !== undefined
        ? activeCollection.records.map((rec) =>
            recordUsesWrappedData(rec)
              ? { ...rec, data: { ...(rec.data as Record<string, unknown>), [name]: defaultVal } }
              : { ...rec, [name]: defaultVal }
          )
        : activeCollection.records;
    saveCollection(activeCollection, nextRecords, nextFields, `Added field "${name}" to ${activeCollection.collection}`);
    setNewFieldName('');
    setNewFieldDefault('');
  };

  const handleDropCollectionField = (fieldName: string) => {
    if (!activeCollection) return;
    const nextFields = activeCollection.schemaFields.filter((f) => f.name !== fieldName);
    const nextRecords = activeCollection.records.map((rec) => {
      if (recordUsesWrappedData(rec)) {
        const nextData = { ...(rec.data as Record<string, unknown>) };
        delete nextData[fieldName];
        return { ...rec, data: nextData };
      }
      const nextRec = { ...rec };
      delete nextRec[fieldName];
      return nextRec;
    });
    saveCollection(activeCollection, nextRecords, nextFields, `Removed field "${fieldName}" from ${activeCollection.collection}`);
  };

  const filteredRecords = useMemo(() => {
    if (!activeCollection) return [];
    const q = rowSearch.trim().toLowerCase();
    return activeCollection.records
      .map((rec, idx) => ({ rec, idx }))
      .filter(({ rec }) => !q || JSON.stringify(rec).toLowerCase().includes(q));
  }, [activeCollection, rowSearch]);

  if (mode === 'sqlite') {
    return (
      <div style={s.root} data-studio-data-workspace="sqlite">
        <SqliteDatabaseAdmin host={sqliteHost} modeSwitch={modeSwitch} />
      </div>
    );
  }

  return (
    <div style={s.root} data-studio-data-workspace="collections">
      <div style={s.topbar}>
        {modeSwitch}
        <span style={s.title}>Collections &amp; FormLogic Data</span>
        {feedback && (
          <span style={feedback.kind === 'ok' ? s.okBox : s.errorBox} role="status">
            {feedback.text}
          </span>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button
            type="button"
            className="sn-sql-btn sn-sql-btn-primary sn-sql-btn-sm"
            disabled={agentWriting}
            onClick={() => setToolDialog('database')}
          >
            + New collection / table
          </button>
          <button
            type="button"
            className="sn-sql-btn sn-sql-btn-sm"
            disabled={agentWriting}
            onClick={() => setToolDialog('backend')}
          >
            FormLogic API routes{formLogic.routes.length > 0 ? ` (${formLogic.routes.length})` : ''}
          </button>
        </div>
      </div>

      {xdbCollections.length === 0 && !formLogic.entry && formLogic.migrations.length === 0 ? (
        <div style={s.emptyCenter}>
          <div style={{ fontFamily: 'var(--display)', fontSize: 18, fontWeight: 700, color: 'var(--paper)' }}>
            No collections or FormLogic tables yet
          </div>
          <p style={{ maxWidth: 460, margin: 0, lineHeight: 1.6 }}>
            Create a local offline <code style={{ fontFamily: 'var(--mono)' }}>.xdb</code> collection (accessible via <code style={{ fontFamily: 'var(--mono)' }}>db.*</code> or <code style={{ fontFamily: 'var(--mono)' }}>softn:db</code>) or a FormLogic private SQLite table with server API routes — works in both Web Containers and <code style={{ fontFamily: 'var(--mono)' }}>.ui</code> apps.
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
            <button
              type="button"
              className="sn-sql-btn sn-sql-btn-primary sn-sql-btn-lg"
              disabled={agentWriting}
              onClick={() => setToolDialog('database')}
            >
              + Design collection or FormLogic table
            </button>
            <button
              type="button"
              className="sn-sql-btn sn-sql-btn-lg"
              onClick={() => setMode('sqlite')}
            >
              Switch to embedded SQLite
            </button>
          </div>
        </div>
      ) : (
        <div style={s.body}>
          <aside style={s.sidebar} aria-label="Collections and tables">
            <div style={s.sideSection}>Local Collections (.xdb)</div>
            {xdbCollections.length === 0 ? (
              <div style={{ padding: '4px 8px 8px', fontSize: 12, color: 'var(--dim)' }}>None yet</div>
            ) : (
              xdbCollections.map((col) => {
                const active = selectedCollectionPath === col.path;
                return (
                  <button
                    key={col.path}
                    type="button"
                    style={{ ...s.sideBtn, ...(active ? s.sideBtnActive : {}) }}
                    onClick={() => {
                      setSelectedCollectionPath(col.path);
                      setEditingIndex(null);
                      setAddingRow(false);
                    }}
                  >
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      ⊞ {col.collection}
                    </span>
                    <span style={s.pill}>{col.records.length}</span>
                  </button>
                );
              })
            )}

            {(formLogic.entry || formLogic.migrations.length > 0) && (
              <>
                <div style={s.sideSection}>FormLogic Backend</div>
                <button
                  type="button"
                  style={{ ...s.sideBtn, ...(selectedCollectionPath === '__formlogic__' ? s.sideBtnActive : {}) }}
                  onClick={() => setSelectedCollectionPath('__formlogic__')}
                >
                  <span>⚡ Tables &amp; API</span>
                  <span style={s.pill}>{formLogic.migrations.length}</span>
                </button>
              </>
            )}
          </aside>

          <div style={s.main}>
            {selectedCollectionPath === '__formlogic__' ? (
              <>
                <div style={s.card}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                    <h3 style={{ margin: 0, fontFamily: 'var(--display)', fontSize: 15 }}>
                      FormLogic Private SQLite Backend
                    </h3>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button
                        type="button"
                        className="sn-sql-btn sn-sql-btn-primary sn-sql-btn-sm"
                        disabled={agentWriting}
                        onClick={() => setToolDialog('database')}
                      >
                        + Add table
                      </button>
                      <button
                        type="button"
                        className="sn-sql-btn sn-sql-btn-sm"
                        disabled={agentWriting}
                        onClick={() => setToolDialog('backend')}
                      >
                        Edit routes &amp; handlers
                      </button>
                      {formLogic.entry && onOpenFile && (
                        <button
                          type="button"
                          className="sn-sql-btn sn-sql-btn-sm"
                          onClick={() => onOpenFile(formLogic.entry!)}
                        >
                          Open {formLogic.entry}
                        </button>
                      )}
                    </div>
                  </div>
                  <p style={{ margin: 0, fontSize: 12.5, color: 'var(--dim)', lineHeight: 1.5 }}>
                    FormLogic runs <code style={{ fontFamily: 'var(--mono)' }}>{formLogic.entry || 'server/main.logic'}</code> against a private per-workspace SQLite database and applies numbered migrations in order. Both Web Containers (<code style={{ fontFamily: 'var(--mono)' }}>import &#123; api &#125; from &apos;softn:api&apos;</code>) and <code style={{ fontFamily: 'var(--mono)' }}>.ui</code> apps (<code style={{ fontFamily: 'var(--mono)' }}>softn.net.fetch</code>) can call these routes.
                  </p>
                </div>

                {formLogic.routes.length > 0 && (
                  <div style={s.card}>
                    <h4 style={{ margin: 0, fontFamily: 'var(--display)', fontSize: 13.5 }}>
                      API Routes ({formLogic.routes.length})
                    </h4>
                    <div style={s.tableWrap}>
                      <table style={s.grid}>
                        <thead>
                          <tr>
                            <th style={s.th}>Method</th>
                            <th style={s.th}>Path</th>
                            <th style={s.th}>Handler</th>
                            <th style={s.th}>Transaction</th>
                          </tr>
                        </thead>
                        <tbody>
                          {formLogic.routes.map((r, i) => (
                            <tr key={`${r.method}:${r.path}:${i}`}>
                              <td style={{ ...s.td, fontWeight: 700 }}>{r.method}</td>
                              <td style={s.td}>{r.path}</td>
                              <td style={s.td}>{r.handler}</td>
                              <td style={s.td}>{r.transaction || 'read'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                <div style={s.card}>
                  <h4 style={{ margin: 0, fontFamily: 'var(--display)', fontSize: 13.5 }}>
                    SQL Migrations ({formLogic.migrations.length})
                  </h4>
                  {formLogic.migrations.length === 0 ? (
                    <div style={{ fontSize: 12.5, color: 'var(--dim)' }}>No migration files yet.</div>
                  ) : (
                    formLogic.migrations.map((m) => (
                      <div key={m.path} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                          <code style={{ fontFamily: 'var(--mono)', fontSize: 12.5, fontWeight: 600 }}>{m.path}</code>
                          {onOpenFile && (
                            <button type="button" className="sn-sql-btn sn-sql-btn-sm" onClick={() => onOpenFile(m.path)}>
                              Open SQL
                            </button>
                          )}
                        </div>
                        <pre style={{ margin: 0, padding: 10, borderRadius: 6, background: 'var(--ink)', border: '1px solid var(--line-soft)', fontSize: 12, fontFamily: 'var(--mono)', overflowX: 'auto' }}>
                          {m.sql || '-- empty migration'}
                        </pre>
                      </div>
                    ))
                  )}
                </div>
              </>
            ) : activeCollection ? (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <strong style={{ fontFamily: 'var(--mono)', fontSize: 14 }}>{activeCollection.collection}</strong>
                  <span style={{ fontSize: 12, color: 'var(--dim)', fontFamily: 'var(--mono)' }}>{activeCollection.path}</span>
                  <div className="sn-sql-seg" role="group" aria-label="Collection view">
                    <button type="button" aria-pressed={collectionTab === 'rows'} onClick={() => setCollectionTab('rows')}>
                      Records ({activeCollection.records.length})
                    </button>
                    <button type="button" aria-pressed={collectionTab === 'fields'} onClick={() => setCollectionTab('fields')}>
                      Fields ({activeCollection.schemaFields.length})
                    </button>
                  </div>
                  <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                    {onOpenFile && (
                      <button type="button" className="sn-sql-btn sn-sql-btn-sm" onClick={() => onOpenFile(activeCollection.path)}>
                        Edit raw JSON
                      </button>
                    )}
                  </div>
                </div>

                {activeCollection.parseError ? (
                  <div style={s.errorBox}>
                    Could not parse {activeCollection.path}: {activeCollection.parseError}
                  </div>
                ) : collectionTab === 'rows' ? (
                  <>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <input
                        type="search"
                        aria-label="Filter collection records"
                        placeholder={`Search ${activeCollection.collection}…`}
                        value={rowSearch}
                        onChange={(e) => setRowSearch(e.target.value)}
                        style={{ ...s.input, minWidth: 200, maxWidth: 340, flex: '1 1 200px' }}
                      />
                      <button
                        type="button"
                        className="sn-sql-btn sn-sql-btn-primary sn-sql-btn-sm"
                        style={{ marginLeft: 'auto' }}
                        disabled={agentWriting}
                        onClick={openNewRowForm}
                      >
                        + Add record
                      </button>
                    </div>

                    {(addingRow || editingIndex !== null) && (
                      <form onSubmit={handleCommitRow} style={s.card}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <h4 style={{ margin: 0, fontFamily: 'var(--display)', fontSize: 13.5 }}>
                            {addingRow ? `New record in ${activeCollection.collection}` : `Edit record #${(editingIndex ?? 0) + 1}`}
                          </h4>
                          <button type="button" className="sn-sql-btn sn-sql-btn-sm" onClick={() => { setAddingRow(false); setEditingIndex(null); }}>
                            Cancel
                          </button>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
                          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                            <span style={{ fontSize: 12, fontFamily: 'var(--mono)', fontWeight: 600 }}>id</span>
                            <input
                              type="text"
                              value={rowDraft.id ?? ''}
                              onChange={(e) => setRowDraft((p) => ({ ...p, id: e.target.value }))}
                              style={s.input}
                              required
                            />
                          </label>
                          {activeCollection.schemaFields.map((f) => (
                            <label key={f.name} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                              <span style={{ fontSize: 12, fontFamily: 'var(--mono)', fontWeight: 600 }}>
                                {f.name} <span style={{ color: 'var(--dim)', fontWeight: 400 }}>{f.type}</span>
                              </span>
                              {f.type === 'boolean' ? (
                                <select
                                  value={rowDraft[f.name] === 'true' ? 'true' : 'false'}
                                  onChange={(e) => setRowDraft((p) => ({ ...p, [f.name]: e.target.value }))}
                                  style={s.select}
                                >
                                  <option value="false">false</option>
                                  <option value="true">true</option>
                                </select>
                              ) : (
                                <input
                                  type="text"
                                  value={rowDraft[f.name] ?? ''}
                                  onChange={(e) => setRowDraft((p) => ({ ...p, [f.name]: e.target.value }))}
                                  style={s.input}
                                />
                              )}
                            </label>
                          ))}
                        </div>
                        <div style={{ display: 'flex', gap: 8 }}>
                          <button type="submit" className="sn-sql-btn sn-sql-btn-primary sn-sql-btn-sm" disabled={agentWriting}>
                            {addingRow ? 'Add record' : 'Save changes'}
                          </button>
                          <button type="button" className="sn-sql-btn sn-sql-btn-sm" onClick={() => { setAddingRow(false); setEditingIndex(null); }}>
                            Cancel
                          </button>
                        </div>
                      </form>
                    )}

                    <div style={s.tableWrap}>
                      <table style={s.grid}>
                        <thead>
                          <tr>
                            <th style={{ ...s.th, width: 110 }}>Actions</th>
                            <th style={s.th}>id</th>
                            {activeCollection.schemaFields.map((f) => (
                              <th key={f.name} style={s.th}>{f.name}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {filteredRecords.length === 0 ? (
                            <tr>
                              <td colSpan={activeCollection.schemaFields.length + 2} style={{ ...s.td, textAlign: 'center', color: 'var(--dim)', padding: 24 }}>
                                {rowSearch ? 'No matching records.' : 'No seed records yet.'}
                              </td>
                            </tr>
                          ) : (
                            filteredRecords.map(({ rec, idx }) => (
                              <tr key={`${String(rec.id ?? idx)}-${idx}`}>
                                <td style={{ ...s.td, whiteSpace: 'nowrap' }}>
                                  <button
                                    type="button"
                                    className="sn-sql-btn sn-sql-btn-sm"
                                    style={{ marginRight: 4, padding: '2px 7px', fontSize: 11, minHeight: 22 }}
                                    disabled={agentWriting}
                                    onClick={() => openEditRowForm(idx)}
                                  >
                                    Edit
                                  </button>
                                  <button
                                    type="button"
                                    className="sn-sql-btn sn-sql-btn-sm sn-sql-btn-danger"
                                    style={{ padding: '2px 7px', fontSize: 11, minHeight: 22 }}
                                    disabled={agentWriting}
                                    onClick={() => handleDeleteCollectionRow(idx)}
                                  >
                                    Del
                                  </button>
                                </td>
                                <td style={s.td}>{String(rec.id ?? '')}</td>
                                {activeCollection.schemaFields.map((f) => {
                                  const v = readRecordField(rec, f.name);
                                  const text = v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v);
                                  return <td key={f.name} style={s.td} title={text}>{text}</td>;
                                })}
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>
                  </>
                ) : (
                  <>
                    <div style={s.tableWrap}>
                      <table style={s.grid}>
                        <thead>
                          <tr>
                            <th style={s.th}>Field</th>
                            <th style={s.th}>Type</th>
                            <th style={s.th}>Required</th>
                            <th style={s.th}>Action</th>
                          </tr>
                        </thead>
                        <tbody>
                          {activeCollection.schemaFields.length === 0 ? (
                            <tr>
                              <td colSpan={4} style={{ ...s.td, textAlign: 'center', color: 'var(--dim)', padding: 18 }}>
                                No fields defined yet. Add a field below.
                              </td>
                            </tr>
                          ) : (
                            activeCollection.schemaFields.map((f) => (
                              <tr key={f.name}>
                                <td style={{ ...s.td, fontWeight: 600 }}>{f.name}</td>
                                <td style={s.td}>{f.type}</td>
                                <td style={s.td}>{f.required ? 'YES' : 'NO'}</td>
                                <td style={s.td}>
                                  <button
                                    type="button"
                                    className="sn-sql-btn sn-sql-btn-sm sn-sql-btn-danger"
                                    style={{ padding: '2px 7px', fontSize: 11, minHeight: 22 }}
                                    disabled={agentWriting}
                                    onClick={() => handleDropCollectionField(f.name)}
                                  >
                                    Remove
                                  </button>
                                </td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>

                    <form onSubmit={handleAddCollectionField} style={s.card}>
                      <h4 style={{ margin: 0, fontFamily: 'var(--display)', fontSize: 13.5 }}>Add field</h4>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                        <input
                          type="text"
                          aria-label="New field name"
                          placeholder="priority"
                          value={newFieldName}
                          onChange={(e) => setNewFieldName(e.target.value)}
                          style={{ ...s.input, width: 170 }}
                          required
                        />
                        <select
                          aria-label="New field type"
                          value={newFieldType}
                          onChange={(e) => setNewFieldType(e.target.value as 'string' | 'number' | 'boolean' | 'date')}
                          style={s.select}
                        >
                          <option value="string">string</option>
                          <option value="number">number</option>
                          <option value="boolean">boolean</option>
                          <option value="date">date</option>
                        </select>
                        <input
                          type="text"
                          aria-label="Default value for existing records"
                          placeholder="Default for existing rows (optional)"
                          value={newFieldDefault}
                          onChange={(e) => setNewFieldDefault(e.target.value)}
                          style={{ ...s.input, width: 220 }}
                        />
                        <button type="submit" className="sn-sql-btn sn-sql-btn-primary sn-sql-btn-sm" disabled={agentWriting}>
                          + Add field
                        </button>
                      </div>
                    </form>
                  </>
                )}
              </>
            ) : null}
          </div>
        </div>
      )}

      {toolDialog && (
        <Suspense fallback={null}>
          <StudioProjectTools
            tool={toolDialog}
            onClose={() => setToolDialog(null)}
            onCreated={(createdPath) => {
              if (/\.xdb$/i.test(createdPath)) {
                setSelectedCollectionPath(createdPath);
              } else {
                setSelectedCollectionPath('__formlogic__');
              }
            }}
          />
        </Suspense>
      )}
    </div>
  );
};
