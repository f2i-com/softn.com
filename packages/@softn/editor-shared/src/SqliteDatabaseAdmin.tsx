/**
 * SqliteDatabaseAdmin — Shared mini-phpMyAdmin editor for XDB SQLite 3 databases
 * bundled inside `.softn` apps (used by both SoftN Builder and SoftN AI Studio).
 *
 * Supports full schema creation/modification (Create/Rename/Drop Table, Add/Rename/Drop
 * Column, Indexes, Foreign Keys, DDL view), full record CRUD (Browse with search/sort/
 * pagination, Insert, Edit with NULL toggle, Delete, Truncate), an interactive SQL
 * console, and SQL dump / `.db` binary export — synced live back into the `.softn` bundle.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  SqliteSession,
  isMutatingSql,
  quoteSqlIdent,
  sqliteBytesSignature,
  type ProjectSqliteDatabase,
  type SqliteBrowseResult,
  type SqliteColumnInfo,
  type SqliteExecResult,
  type SqliteNewColumnSpec,
  type SqliteTableStructure,
  type SqliteTableSummary,
} from './sqliteDatabase';
import './sqliteAdmin.css';

type SubTab = 'browse' | 'structure' | 'insert' | 'sql' | 'create-table';

const SQLITE_TYPES = ['INTEGER', 'TEXT', 'REAL', 'NUMERIC', 'BLOB'] as const;

export interface SqliteAdminNotifier {
  success: (message: string) => void;
  info: (message: string) => void;
  error: (message: string) => void;
}

export interface SqliteAdminConfirmOptions {
  title?: string;
  confirmLabel?: string;
  danger?: boolean;
}

export interface SqliteDatabaseAdminHost {
  projectId: string;
  databases: ProjectSqliteDatabase[];
  readTextFile: (path: string) => string | null;
  persistBytes: (db: ProjectSqliteDatabase, bytes: Uint8Array, label?: string) => void;
  createDatabase: (rawName: string, options: { runtimeUrl?: string }) => Promise<ProjectSqliteDatabase>;
  /** Optional callback to sync an exported SQL dump back into the DB's seed `.sql` file. */
  onSyncSeedSql?: (db: ProjectSqliteDatabase, sqlDump: string) => void;
  /** Optional runtime base URL for loading XDB SQLite WASM. */
  runtimeUrl?: string;
  /** When true (e.g. while an AI run is actively writing), disable mutations safely. */
  readOnly?: boolean;
  readOnlyReason?: string;
  notify?: SqliteAdminNotifier;
  confirm?: (message: string, options?: SqliteAdminConfirmOptions) => Promise<boolean>;
}

export interface SqliteDatabaseAdminProps {
  host: SqliteDatabaseAdminHost;
  /** Optional header toggle slot (e.g. switch between SQLite and Collections/FormLogic). */
  modeSwitch?: React.ReactNode;
}

function coerceFieldValue(raw: string, colType: string, isNull: boolean): unknown {
  if (isNull) return null;
  const upper = (colType || '').toUpperCase();
  if (upper.includes('INT') && /^-?\d+$/.test(raw.trim())) {
    const num = Number(raw.trim());
    if (Number.isSafeInteger(num)) return num;
  }
  if ((upper.includes('REAL') || upper.includes('FLOA') || upper.includes('DOUB') || upper.includes('NUM')) && raw.trim() !== '') {
    const num = Number(raw.trim());
    if (Number.isFinite(num)) return num;
  }
  return raw;
}

function displayCellValue(val: unknown): { text: string; isNull: boolean } {
  if (val === null || val === undefined) return { text: 'NULL', isNull: true };
  if (val instanceof Uint8Array) return { text: `<BLOB ${val.byteLength} B>`, isNull: false };
  if (typeof val === 'object') return { text: JSON.stringify(val), isNull: false };
  return { text: String(val), isNull: false };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function triggerDownload(filename: string, data: BlobPart, mime: string): void {
  const blob = new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const s: Record<string, React.CSSProperties> = {
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minHeight: 0,
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
    letterSpacing: '-0.01em',
    color: 'var(--paper)',
  },
  badge: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    padding: '2px 8px',
    borderRadius: 999,
    fontSize: 11,
    fontFamily: 'var(--mono)',
    background: 'rgba(99, 102, 241, 0.14)',
    color: 'var(--paper)',
    border: '1px solid var(--line)',
  },
  select: {
    background: 'var(--ink)',
    color: 'var(--paper)',
    border: '1px solid var(--line)',
    borderRadius: 6,
    padding: '4px 8px',
    fontSize: 12.5,
    fontFamily: 'var(--mono)',
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
  },
  sidebarHead: {
    padding: '10px 10px 8px',
    borderBottom: '1px solid var(--line-soft)',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  tableList: {
    flex: 1,
    overflowY: 'auto',
    padding: '6px 6px 12px',
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
  },
  tableBtn: {
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
  tableBtnActive: {
    background: 'rgba(99, 102, 241, 0.2)',
    color: 'var(--paper)',
    fontWeight: 600,
  },
  countPill: {
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
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  tabBar: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    padding: '0 14px',
    borderBottom: '1px solid var(--line-soft)',
    background: 'var(--ink-2)',
    flexShrink: 0,
    flexWrap: 'wrap',
  },
  tabBtn: {
    padding: '9px 12px',
    background: 'transparent',
    borderTopWidth: 0,
    borderLeftWidth: 0,
    borderRightWidth: 0,
    borderBottomWidth: 2,
    borderBottomStyle: 'solid',
    borderBottomColor: 'transparent',
    color: 'var(--dim)',
    cursor: 'pointer',
    fontSize: 12.5,
    fontWeight: 500,
  },
  tabBtnActive: {
    color: 'var(--paper)',
    borderBottomColor: 'var(--coral, #6366f1)',
    fontWeight: 600,
  },
  pane: {
    flex: 1,
    minHeight: 0,
    overflow: 'auto',
    padding: 16,
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
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
    userSelect: 'none',
  },
  td: {
    padding: '7px 10px',
    borderBottom: '1px solid var(--line-soft)',
    color: 'var(--paper)',
    maxWidth: 320,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    verticalAlign: 'middle',
  },
  nullVal: {
    color: 'var(--dim)',
    fontStyle: 'italic',
    opacity: 0.7,
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
  sectionHead: {
    fontFamily: 'var(--display)',
    fontSize: 13.5,
    fontWeight: 700,
    color: 'var(--paper)',
    margin: 0,
  },
  errorBox: {
    padding: '9px 12px',
    borderRadius: 6,
    background: 'rgba(239, 68, 68, 0.12)',
    border: '1px solid rgba(239, 68, 68, 0.45)',
    color: 'var(--danger, #fca5a5)',
    fontSize: 12.5,
    fontFamily: 'var(--mono)',
    whiteSpace: 'pre-wrap',
  },
  okBox: {
    padding: '8px 12px',
    borderRadius: 6,
    background: 'rgba(16, 185, 129, 0.12)',
    border: '1px solid rgba(16, 185, 129, 0.4)',
    color: 'var(--mint, #6ee7b7)',
    fontSize: 12,
    fontFamily: 'var(--mono)',
  },
  noticeBox: {
    padding: '7px 12px',
    background: 'rgba(232, 163, 61, 0.12)',
    borderBottom: '1px solid rgba(232, 163, 61, 0.35)',
    color: 'var(--paper)',
    fontSize: 12,
    flexShrink: 0,
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
};

export function SqliteDatabaseAdmin({ host, modeSwitch }: SqliteDatabaseAdminProps) {
  const { projectId, databases, readOnly = false, readOnlyReason } = host;

  const hostRef = useRef(host);
  hostRef.current = host;

  const [selectedDbId, setSelectedDbId] = useState<string>(() => databases[0]?.id ?? '');
  const activeDb: ProjectSqliteDatabase | null = useMemo(
    () => databases.find((d) => d.id === selectedDbId) ?? databases[0] ?? null,
    [databases, selectedDbId]
  );

  const sessionRef = useRef<SqliteSession | null>(null);
  const lastSelfBytesSigRef = useRef<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [dbStats, setDbStats] = useState<{ pageSize: number; pageCount: number; approxBytes: number } | null>(null);

  const [tables, setTables] = useState<SqliteTableSummary[]>([]);
  const [tableFilter, setTableFilter] = useState('');
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const selectedTableRef = useRef<string | null>(null);
  selectedTableRef.current = selectedTable;
  const [activeTab, setActiveTab] = useState<SubTab>('browse');

  // Browse state
  const [browse, setBrowse] = useState<SqliteBrowseResult | null>(null);
  const [structure, setStructure] = useState<SqliteTableStructure | null>(null);
  const [browseSearch, setBrowseSearch] = useState('');
  const [browsePage, setBrowsePage] = useState(1);
  const [browsePageSize, setBrowsePageSize] = useState(25);
  const [sortBy, setSortBy] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<'ASC' | 'DESC'>('ASC');
  const [actionError, setActionError] = useState<string | null>(null);

  // Inline Edit Row modal state
  const [editingRow, setEditingRow] = useState<{
    rowid: number | null;
    pkValues: Record<string, unknown>;
    draft: Record<string, { value: string; isNull: boolean }>;
  } | null>(null);

  // Insert Row state
  const [insertDraft, setInsertDraft] = useState<Record<string, { value: string; isNull: boolean }>>({});

  // Structure edit states
  const [newCol, setNewCol] = useState<SqliteNewColumnSpec>({ name: '', type: 'TEXT', notNull: false, defaultValue: '' });
  const [renamingCol, setRenamingCol] = useState<{ from: string; to: string } | null>(null);
  const [renameTableInput, setRenameTableInput] = useState('');
  const [newIndexName, setNewIndexName] = useState('');
  const [newIndexCol, setNewIndexCol] = useState('');
  const [newIndexUnique, setNewIndexUnique] = useState(false);

  // Create Table state
  const [newTableName, setNewTableName] = useState('');
  const [newTableCols, setNewTableCols] = useState<SqliteNewColumnSpec[]>([
    { name: 'id', type: 'INTEGER', primaryKey: true, autoIncrement: true, notNull: true, defaultValue: '' },
    { name: 'name', type: 'TEXT', notNull: true, defaultValue: '' },
    { name: 'created_at', type: 'TEXT', defaultValue: 'CURRENT_TIMESTAMP' },
  ]);

  // SQL Console state
  const [sqlQuery, setSqlQuery] = useState("SELECT name, type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name;");
  const [sqlResult, setSqlResult] = useState<{ exec: SqliteExecResult; elapsedMs: number } | null>(null);
  const [sqlError, setSqlError] = useState<string | null>(null);

  // New DB inline form
  const [creatingDb, setCreatingDb] = useState(false);
  const [newDbName, setNewDbName] = useState('');

  const notify = useCallback((kind: 'success' | 'info' | 'error', message: string) => {
    const n = hostRef.current.notify;
    if (n) {
      n[kind](message);
    } else if (kind === 'error') {
      setActionError(message);
    } else {
      setStatusMessage(message);
    }
  }, []);

  useEffect(() => {
    if (!statusMessage) return;
    const t = setTimeout(() => setStatusMessage(null), 3200);
    return () => clearTimeout(t);
  }, [statusMessage]);

  const confirmAction = useCallback(async (message: string, opts?: SqliteAdminConfirmOptions): Promise<boolean> => {
    if (hostRef.current.confirm) {
      return hostRef.current.confirm(message, opts);
    }
    return typeof window !== 'undefined' ? window.confirm(message) : true;
  }, []);

  // Keep selectedDbId in sync when project switches
  useEffect(() => {
    if (databases.length > 0 && !databases.some((d) => d.id === selectedDbId)) {
      setSelectedDbId(databases[0].id);
    }
  }, [databases, selectedDbId]);

  const refreshTableView = useCallback(
    (
      session: SqliteSession,
      tableName: string | null,
      opts?: { page?: number; pageSize?: number; sortBy?: string | null; sortDir?: 'ASC' | 'DESC'; search?: string }
    ) => {
      const nextTables = session.listTables();
      setTables(nextTables);
      setDbStats(session.pageInfo());

      const target =
        tableName && nextTables.some((t) => t.name === tableName)
          ? tableName
          : nextTables[0]?.name ?? null;
      setSelectedTable(target);

      if (!target) {
        setStructure(null);
        setBrowse(null);
        return;
      }

      const struct = session.getTableStructure(target);
      setStructure(struct);
      setRenameTableInput(target);
      if (struct.columns.length > 0 && !newIndexCol) {
        setNewIndexCol(struct.columns[0].name);
      }

      const data = session.browseTable(target, {
        page: opts?.page ?? browsePage,
        pageSize: opts?.pageSize ?? browsePageSize,
        sortBy: opts?.sortBy !== undefined ? opts.sortBy : sortBy,
        sortDir: opts?.sortDir ?? sortDir,
        search: opts?.search !== undefined ? opts.search : browseSearch,
      });
      setBrowse(data);

      const freshInsert: Record<string, { value: string; isNull: boolean }> = {};
      for (const col of struct.columns) {
        freshInsert[col.name] = {
          value: '',
          isNull: !col.notnull && col.pk === 0 && col.dfltValue === null,
        };
      }
      setInsertDraft(freshInsert);
    },
    [browsePage, browsePageSize, sortBy, sortDir, browseSearch, newIndexCol]
  );

  // Sync mutated DB bytes back into the project bundle immediately
  const persistSession = useCallback((label?: string) => {
    const session = sessionRef.current;
    if (!session || !activeDb) return;
    try {
      const bytes = session.exportBytes();
      lastSelfBytesSigRef.current = sqliteBytesSignature(bytes);
      hostRef.current.persistBytes(activeDb, bytes, label);
    } catch (err) {
      notify('error', `Could not sync database to bundle: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [activeDb, notify]);

  const openedKeyRef = useRef<string>('');
  const openDb = useCallback(
    async (db: ProjectSqliteDatabase, forceReseed = false, preserveTable = false) => {
      const key = `${projectId}:${db.id}:${forceReseed ? Date.now() : 'live'}:${preserveTable ? Date.now() : '0'}`;
      openedKeyRef.current = key;
      if (!preserveTable) setLoading(true);
      setLoadError(null);
      setActionError(null);
      setEditingRow(null);
      if (!preserveTable) {
        setSqlResult(null);
        setSqlError(null);
      }

      try {
        sessionRef.current?.close();
        sessionRef.current = null;
        const session = await SqliteSession.open(
          db,
          (path) => hostRef.current.readTextFile(path),
          {
            runtimeUrl: hostRef.current.runtimeUrl,
            forceReseed,
          }
        );
        if (openedKeyRef.current !== key) {
          session.close();
          return;
        }
        sessionRef.current = session;
        lastSelfBytesSigRef.current = sqliteBytesSignature(db.initialBytes);
        const initialTables = session.listTables();
        const targetTable =
          preserveTable && selectedTableRef.current && initialTables.some((t) => t.name === selectedTableRef.current)
            ? selectedTableRef.current
            : initialTables[0]?.name ?? null;
        if (!preserveTable) {
          setBrowsePage(1);
          setSortBy(null);
          setBrowseSearch('');
        }
        refreshTableView(session, targetTable, preserveTable ? undefined : { page: 1, sortBy: null, search: '' });
        if (!preserveTable && targetTable) {
          setSqlQuery(`SELECT * FROM ${quoteSqlIdent(targetTable)} LIMIT 50;`);
        }
        if (forceReseed) {
          const bytes = session.exportBytes();
          lastSelfBytesSigRef.current = sqliteBytesSignature(bytes);
          hostRef.current.persistBytes(db, bytes, `Re-seeded ${db.name} from SQL`);
          notify('success', `Rebuilt ${db.name} from seed SQL`);
        }
      } catch (err) {
        if (openedKeyRef.current === key) {
          setLoadError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (openedKeyRef.current === key) {
          setLoading(false);
        }
      }
    },
    [projectId, refreshTableView, notify]
  );

  // Open when selected database ID or project changes
  const activeDbId = activeDb?.id ?? '';
  const activeBytesSig = useMemo(
    () => (activeDb ? sqliteBytesSignature(activeDb.initialBytes) : 'none'),
    [activeDb]
  );

  useEffect(() => {
    if (!activeDb) {
      sessionRef.current?.close();
      sessionRef.current = null;
      lastSelfBytesSigRef.current = null;
      setTables([]);
      setSelectedTable(null);
      setStructure(null);
      setBrowse(null);
      return;
    }
    void openDb(activeDb, false, false);
    return () => {
      sessionRef.current?.close();
      sessionRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, activeDbId]);

  // Reload live session automatically when an external actor (e.g. Studio AI or Undo/Redo)
  // modifies the active `.db` binary bytes in the project store.
  useEffect(() => {
    if (!activeDb || !sessionRef.current) return;
    if (activeBytesSig === lastSelfBytesSigRef.current) return;
    void openDb(activeDb, false, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBytesSig]);

  const handleSelectTable = (name: string) => {
    const session = sessionRef.current;
    if (!session) return;
    setActionError(null);
    setEditingRow(null);
    setRenamingCol(null);
    setBrowsePage(1);
    setSortBy(null);
    setBrowseSearch('');
    if (activeTab === 'create-table') setActiveTab('browse');
    refreshTableView(session, name, { page: 1, sortBy: null, search: '' });
    setSqlQuery(`SELECT * FROM ${quoteSqlIdent(name)} LIMIT 50;`);
  };

  const handleBrowseSearch = (q: string) => {
    setBrowseSearch(q);
    setBrowsePage(1);
    if (sessionRef.current && selectedTable) {
      refreshTableView(sessionRef.current, selectedTable, { page: 1, search: q });
    }
  };

  const handleSort = (col: string) => {
    const nextDir: 'ASC' | 'DESC' = sortBy === col && sortDir === 'ASC' ? 'DESC' : 'ASC';
    setSortBy(col);
    setSortDir(nextDir);
    if (sessionRef.current && selectedTable) {
      refreshTableView(sessionRef.current, selectedTable, { sortBy: col, sortDir: nextDir });
    }
  };

  const handlePageChange = (nextPage: number) => {
    setBrowsePage(nextPage);
    if (sessionRef.current && selectedTable) {
      refreshTableView(sessionRef.current, selectedTable, { page: nextPage });
    }
  };

  const handlePageSizeChange = (size: number) => {
    setBrowsePageSize(size);
    setBrowsePage(1);
    if (sessionRef.current && selectedTable) {
      refreshTableView(sessionRef.current, selectedTable, { page: 1, pageSize: size });
    }
  };

  const openEditRow = (row: { rowid: number | null; values: unknown[] }) => {
    if (!structure || readOnly) return;
    const pkValues: Record<string, unknown> = {};
    const draft: Record<string, { value: string; isNull: boolean }> = {};
    structure.columns.forEach((col, i) => {
      const val = row.values[i];
      if (col.pk > 0) pkValues[col.name] = val;
      draft[col.name] = {
        value: val === null || val === undefined ? '' : typeof val === 'object' ? JSON.stringify(val) : String(val),
        isNull: val === null || val === undefined,
      };
    });
    setEditingRow({ rowid: row.rowid, pkValues, draft });
    setActionError(null);
  };

  const handleSaveEditRow = (e: React.FormEvent) => {
    e.preventDefault();
    const session = sessionRef.current;
    if (!session || !selectedTable || !structure || !editingRow || readOnly) return;
    setActionError(null);
    try {
      const updates: Record<string, unknown> = {};
      for (const col of structure.columns) {
        const entry = editingRow.draft[col.name];
        if (!entry) continue;
        updates[col.name] = coerceFieldValue(entry.value, col.type, entry.isNull);
      }
      session.updateRow(selectedTable, { rowid: editingRow.rowid, pkValues: editingRow.pkValues }, updates);
      persistSession(`Updated row in ${selectedTable}`);
      setEditingRow(null);
      refreshTableView(session, selectedTable);
      notify('success', 'Row updated');
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDeleteRow = (row: { rowid: number | null; values: unknown[] }) => {
    const session = sessionRef.current;
    if (!session || !selectedTable || !structure || readOnly) return;
    setActionError(null);
    try {
      const pkValues: Record<string, unknown> = {};
      structure.columns.forEach((col, i) => {
        if (col.pk > 0) pkValues[col.name] = row.values[i];
      });
      session.deleteRow(selectedTable, { rowid: row.rowid, pkValues });
      persistSession(`Deleted row from ${selectedTable}`);
      refreshTableView(session, selectedTable);
      notify('info', 'Row deleted');
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleInsertRow = (andBrowse: boolean) => {
    const session = sessionRef.current;
    if (!session || !selectedTable || !structure || readOnly) return;
    setActionError(null);
    try {
      const values: Record<string, unknown> = {};
      for (const col of structure.columns) {
        const entry = insertDraft[col.name];
        if (!entry) continue;
        if (!entry.isNull && entry.value === '' && (col.pk > 0 || col.dfltValue !== null)) {
          continue;
        }
        values[col.name] = coerceFieldValue(entry.value, col.type, entry.isNull);
      }
      session.insertRow(selectedTable, values);
      persistSession(`Inserted row into ${selectedTable}`);
      refreshTableView(session, selectedTable);
      notify('success', `Inserted row into ${selectedTable}`);
      if (andBrowse) setActiveTab('browse');
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleTruncateTable = async () => {
    const session = sessionRef.current;
    if (!session || !selectedTable || readOnly) return;
    const ok = await confirmAction(`Delete ALL rows from "${selectedTable}"? The table structure will stay intact.`, {
      title: 'Empty table',
      confirmLabel: 'Delete all rows',
      danger: true,
    });
    if (!ok) return;
    try {
      session.truncateTable(selectedTable);
      persistSession(`Emptied table ${selectedTable}`);
      refreshTableView(session, selectedTable, { page: 1 });
      notify('info', `Emptied ${selectedTable}`);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleAddColumn = (e: React.FormEvent) => {
    e.preventDefault();
    const session = sessionRef.current;
    if (!session || !selectedTable || readOnly) return;
    setActionError(null);
    try {
      const colName = newCol.name.trim();
      session.addColumn(selectedTable, newCol);
      persistSession(`Added column ${colName} to ${selectedTable}`);
      setNewCol({ name: '', type: 'TEXT', notNull: false, defaultValue: '' });
      refreshTableView(session, selectedTable);
      notify('success', `Added column ${colName} to ${selectedTable}`);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleRenameColumn = (e: React.FormEvent) => {
    e.preventDefault();
    const session = sessionRef.current;
    if (!session || !selectedTable || !renamingCol || readOnly) return;
    setActionError(null);
    try {
      session.renameColumn(selectedTable, renamingCol.from, renamingCol.to);
      persistSession(`Renamed column ${renamingCol.from} to ${renamingCol.to} in ${selectedTable}`);
      setRenamingCol(null);
      refreshTableView(session, selectedTable);
      notify('success', 'Column renamed');
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDropColumn = async (colName: string) => {
    const session = sessionRef.current;
    if (!session || !selectedTable || readOnly) return;
    const ok = await confirmAction(`Drop column "${colName}" from "${selectedTable}"? Data in that column will be removed.`, {
      title: 'Drop column',
      confirmLabel: 'Drop column',
      danger: true,
    });
    if (!ok) return;
    setActionError(null);
    try {
      session.dropColumn(selectedTable, colName);
      persistSession(`Dropped column ${colName} from ${selectedTable}`);
      refreshTableView(session, selectedTable);
      notify('info', `Dropped column ${colName}`);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleRenameTable = (e: React.FormEvent) => {
    e.preventDefault();
    const session = sessionRef.current;
    if (!session || !selectedTable || readOnly) return;
    const next = renameTableInput.trim();
    if (!next || next === selectedTable) return;
    setActionError(null);
    try {
      session.renameTable(selectedTable, next);
      persistSession(`Renamed table ${selectedTable} to ${next}`);
      refreshTableView(session, next);
      notify('success', `Renamed table to ${next}`);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDropTable = async () => {
    const session = sessionRef.current;
    if (!session || !selectedTable || !structure || readOnly) return;
    const ok = await confirmAction(`Permanently drop ${structure.type} "${selectedTable}" and all of its data?`, {
      title: `Drop ${structure.type}`,
      confirmLabel: `Drop ${selectedTable}`,
      danger: true,
    });
    if (!ok) return;
    setActionError(null);
    try {
      session.dropTable(selectedTable, structure.type);
      persistSession(`Dropped ${structure.type} ${selectedTable}`);
      refreshTableView(session, null);
      notify('info', `Dropped ${selectedTable}`);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleAddIndex = (e: React.FormEvent) => {
    e.preventDefault();
    const session = sessionRef.current;
    if (!session || !selectedTable || readOnly) return;
    setActionError(null);
    try {
      const col = newIndexCol || structure?.columns[0]?.name || '';
      const idxName = newIndexName.trim() || `idx_${selectedTable}_${col}`;
      session.createIndex(selectedTable, idxName, [col], newIndexUnique);
      persistSession(`Created index ${idxName} on ${selectedTable}`);
      setNewIndexName('');
      setNewIndexUnique(false);
      refreshTableView(session, selectedTable);
      notify('success', `Created index ${idxName}`);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDropIndex = (idxName: string) => {
    const session = sessionRef.current;
    if (!session || !selectedTable || readOnly) return;
    setActionError(null);
    try {
      session.dropIndex(idxName);
      persistSession(`Dropped index ${idxName}`);
      refreshTableView(session, selectedTable);
      notify('info', `Dropped index ${idxName}`);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleCreateTable = (e: React.FormEvent) => {
    e.preventDefault();
    const session = sessionRef.current;
    if (!session || readOnly) return;
    setActionError(null);
    try {
      const cleanName = newTableName.trim();
      session.createTable(cleanName, newTableCols);
      persistSession(`Created table ${cleanName}`);
      setNewTableName('');
      setNewTableCols([
        { name: 'id', type: 'INTEGER', primaryKey: true, autoIncrement: true, notNull: true, defaultValue: '' },
        { name: 'name', type: 'TEXT', notNull: true, defaultValue: '' },
      ]);
      setActiveTab('browse');
      refreshTableView(session, cleanName, { page: 1, sortBy: null, search: '' });
      notify('success', `Created table "${cleanName}"`);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleRunSql = () => {
    const session = sessionRef.current;
    if (!session || !sqlQuery.trim()) return;
    const mutates = isMutatingSql(sqlQuery);
    if (mutates && readOnly) {
      setSqlError(readOnlyReason || 'Database is currently read-only.');
      return;
    }
    setSqlError(null);
    const t0 = performance.now();
    try {
      const exec = session.execScript(sqlQuery);
      const elapsedMs = Math.max(0.1, performance.now() - t0);
      setSqlResult({ exec, elapsedMs });
      if (mutates) {
        persistSession(`Ran SQL on ${activeDb?.name ?? 'SQLite'}`);
      }
      refreshTableView(session, selectedTable);
    } catch (err) {
      setSqlResult(null);
      setSqlError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleCreateDatabase = async (e: React.FormEvent) => {
    e.preventDefault();
    const raw = newDbName.trim();
    if (!raw || readOnly) return;
    try {
      const created = await hostRef.current.createDatabase(raw, { runtimeUrl: hostRef.current.runtimeUrl });
      setCreatingDb(false);
      setNewDbName('');
      setSelectedDbId(created.id);
      notify('success', `Created SQLite database ${created.file}`);
    } catch (err) {
      notify('error', err instanceof Error ? err.message : String(err));
    }
  };

  const handleDownloadDb = () => {
    const session = sessionRef.current;
    if (!session || !activeDb) return;
    const bytes = session.exportBytes();
    const filename = activeDb.file.slice(activeDb.file.lastIndexOf('/') + 1) || `${activeDb.name}.db`;
    triggerDownload(filename, bytes.slice().buffer, 'application/x-sqlite3');
  };

  const handleDownloadSqlDump = () => {
    const session = sessionRef.current;
    if (!session || !activeDb) return;
    const dump = session.exportSqlDump();
    triggerDownload(`${activeDb.name}.sql`, dump, 'text/sql;charset=utf-8');
  };

  const handleSyncSeedSql = () => {
    const session = sessionRef.current;
    if (!session || !activeDb || !hostRef.current.onSyncSeedSql || readOnly) return;
    try {
      const dump = session.exportSqlDump();
      hostRef.current.onSyncSeedSql(activeDb, dump);
      const target = activeDb.seedSqlPaths[0] || 'backend/schema.sql';
      notify('success', `Synced SQLite schema & rows to ${target}`);
    } catch (err) {
      notify('error', err instanceof Error ? err.message : String(err));
    }
  };

  const filteredTables = useMemo(() => {
    const q = tableFilter.trim().toLowerCase();
    if (!q) return tables;
    return tables.filter((t) => t.name.toLowerCase().includes(q));
  }, [tables, tableFilter]);

  const createTablePreviewSql = useMemo(() => {
    try {
      return SqliteSession.buildCreateTableSql(newTableName || 'new_table', newTableCols);
    } catch {
      return '-- Add a table name and at least one named column';
    }
  }, [newTableName, newTableCols]);

  const totalPages = browse ? Math.max(1, Math.ceil(browse.totalRows / browse.pageSize)) : 1;

  return (
    <div style={s.root} data-sqlite-admin="true">
      {/* Top toolbar */}
      <div style={s.topbar}>
        {modeSwitch}
        <span style={s.title}>SQLite / XDB Explorer</span>

        {databases.length > 0 && (
          <select
            aria-label="Select SQLite database"
            style={s.select}
            value={activeDb?.id ?? ''}
            onChange={(e) => setSelectedDbId(e.target.value)}
          >
            {databases.map((db) => (
              <option key={db.id} value={db.id}>
                {db.name} ({db.file})
              </option>
            ))}
          </select>
        )}

        {creatingDb ? (
          <form onSubmit={(e) => void handleCreateDatabase(e)} style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <input
              type="text"
              aria-label="New database name"
              placeholder="app"
              value={newDbName}
              onChange={(e) => setNewDbName(e.target.value)}
              style={{ ...s.input, width: 120 }}
              autoFocus
            />
            <button type="submit" className="sn-sql-btn sn-sql-btn-primary sn-sql-btn-sm" disabled={readOnly}>Create</button>
            <button type="button" className="sn-sql-btn sn-sql-btn-sm" onClick={() => { setCreatingDb(false); setNewDbName(''); }}>Cancel</button>
          </form>
        ) : (
          <button type="button" className="sn-sql-btn sn-sql-btn-sm" disabled={readOnly} onClick={() => setCreatingDb(true)}>
            + New DB
          </button>
        )}

        {dbStats && (
          <span style={s.badge} title={`Page size ${dbStats.pageSize} B × ${dbStats.pageCount} pages`}>
            {tables.length} {tables.length === 1 ? 'table' : 'tables'} · {formatBytes(dbStats.approxBytes)}
          </span>
        )}

        {statusMessage && (
          <span style={{ ...s.badge, borderColor: 'rgba(16, 185, 129, 0.45)', color: 'var(--mint, #6ee7b7)' }} role="status">
            {statusMessage}
          </span>
        )}

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          {activeDb && host.onSyncSeedSql && (
            <button
              type="button"
              className="sn-sql-btn sn-sql-btn-sm"
              disabled={readOnly}
              title={`Write current schema and rows into ${activeDb.seedSqlPaths[0] || 'backend/schema.sql'}`}
              onClick={handleSyncSeedSql}
            >
              Sync to SQL
            </button>
          )}
          {activeDb && activeDb.seedSqlPaths.length > 0 && (
            <button
              type="button"
              className="sn-sql-btn sn-sql-btn-sm"
              disabled={readOnly}
              title={`Re-run ${activeDb.seedSqlPaths.join(', ')} on a fresh database`}
              onClick={async () => {
                const ok = await confirmAction(
                  `Reset "${activeDb.name}" and re-run ${activeDb.seedSqlPaths.join(', ')}? Any manual table or row edits in this database will be replaced.`,
                  { title: 'Reset from seed SQL', confirmLabel: 'Reset & re-seed', danger: true }
                );
                if (ok) void openDb(activeDb, true, false);
              }}
            >
              Re-seed SQL
            </button>
          )}
          {activeDb && (
            <>
              <button type="button" className="sn-sql-btn sn-sql-btn-sm" onClick={handleDownloadSqlDump}>
                Export SQL
              </button>
              <button type="button" className="sn-sql-btn sn-sql-btn-sm" onClick={handleDownloadDb}>
                Download .db
              </button>
            </>
          )}
        </div>
      </div>

      {readOnly && (
        <div style={s.noticeBox} role="status">
          {readOnlyReason || 'Editing is paused while the AI is updating the project. The view updates live as changes land.'}
        </div>
      )}

      {/* Empty state if no SQLite DB in project */}
      {!activeDb ? (
        <div style={s.emptyCenter}>
          <div style={{ fontFamily: 'var(--display)', fontSize: 18, fontWeight: 700, color: 'var(--paper)' }}>
            No SQLite database in this project yet
          </div>
          <p style={{ maxWidth: 440, margin: 0, lineHeight: 1.6 }}>
            Create an embedded XDB SQLite 3 database to design tables, manage rows, and run SQL queries directly inside your <code style={{ fontFamily: 'var(--mono)' }}>.softn</code> bundle.
          </p>
          <button
            type="button"
            className="sn-sql-btn sn-sql-btn-primary sn-sql-btn-lg"
            disabled={readOnly}
            onClick={() => {
              setNewDbName('app');
              setCreatingDb(true);
            }}
          >
            + Create SQLite database
          </button>
        </div>
      ) : loading ? (
        <div style={s.emptyCenter} role="status">
          <strong>Opening {activeDb.file} in XDB SQLite WASM…</strong>
        </div>
      ) : loadError ? (
        <div style={s.pane}>
          <div style={s.errorBox}>Could not open {activeDb.file}: {loadError}</div>
          <div>
            <button type="button" className="sn-sql-btn sn-sql-btn-sm" onClick={() => void openDb(activeDb, false, false)}>
              Retry
            </button>
          </div>
        </div>
      ) : (
        <div style={s.body}>
          {/* Left table sidebar */}
          <aside style={s.sidebar} aria-label="Database tables">
            <div style={s.sidebarHead}>
              <input
                type="search"
                aria-label="Filter tables"
                placeholder="Filter tables…"
                value={tableFilter}
                onChange={(e) => setTableFilter(e.target.value)}
                style={{ ...s.input, width: '100%' }}
              />
              <button
                type="button"
                className="sn-sql-btn sn-sql-btn-primary sn-sql-btn-sm"
                style={{ width: '100%' }}
                disabled={readOnly}
                onClick={() => {
                  setActionError(null);
                  setActiveTab('create-table');
                }}
              >
                + New table
              </button>
            </div>
            <div style={s.tableList}>
              {filteredTables.length === 0 ? (
                <div style={{ padding: '14px 10px', fontSize: 12, color: 'var(--dim)' }}>
                  {tables.length === 0 ? 'No tables yet — click "+ New table" or run SQL.' : 'No tables match filter.'}
                </div>
              ) : (
                filteredTables.map((t) => {
                  const active = t.name === selectedTable && activeTab !== 'create-table';
                  return (
                    <button
                      key={t.name}
                      type="button"
                      onClick={() => handleSelectTable(t.name)}
                      style={{ ...s.tableBtn, ...(active ? s.tableBtnActive : {}) }}
                      aria-current={active ? 'page' : undefined}
                      title={`${t.type === 'view' ? 'View' : 'Table'}: ${t.name} (${t.rowCount} rows)`}
                    >
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {t.type === 'view' ? '👁 ' : '⊞ '}
                        {t.name}
                      </span>
                      <span style={s.countPill}>{t.rowCount}</span>
                    </button>
                  );
                })
              )}
            </div>
          </aside>

          {/* Main right workspace */}
          <div style={s.main}>
            {/* phpMyAdmin tabs */}
            <div style={s.tabBar} role="tablist" aria-label="Database views">
              {selectedTable && (
                <span style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 12.5, marginRight: 10, color: 'var(--paper)' }}>
                  {selectedTable}
                </span>
              )}
              {(
                [
                  ['browse', 'Browse'],
                  ['structure', 'Structure'],
                  ['insert', 'Insert'],
                  ['sql', 'SQL'],
                  ['create-table', '+ Create table'],
                ] as const
              ).map(([id, label]) => {
                const disabled = !selectedTable && (id === 'browse' || id === 'structure' || id === 'insert');
                return (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={activeTab === id}
                    disabled={disabled}
                    onClick={() => {
                      setActionError(null);
                      setActiveTab(id);
                    }}
                    style={{
                      ...s.tabBtn,
                      ...(activeTab === id ? s.tabBtnActive : {}),
                      ...(disabled ? { opacity: 0.4, cursor: 'not-allowed' } : {}),
                    }}
                  >
                    {label}
                  </button>
                );
              })}
            </div>

            <div style={s.pane}>
              {actionError && <div style={s.errorBox}>{actionError}</div>}

              {/* TAB: BROWSE */}
              {activeTab === 'browse' && selectedTable && structure && browse && (
                <>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <input
                      type="search"
                      aria-label="Search rows"
                      placeholder={`Search ${selectedTable}…`}
                      value={browseSearch}
                      onChange={(e) => handleBrowseSearch(e.target.value)}
                      style={{ ...s.input, minWidth: 200, flex: '1 1 200px', maxWidth: 360 }}
                    />
                    <select
                      aria-label="Rows per page"
                      style={s.select}
                      value={browsePageSize}
                      onChange={(e) => handlePageSizeChange(Number(e.target.value))}
                    >
                      <option value={25}>25 rows</option>
                      <option value={50}>50 rows</option>
                      <option value={100}>100 rows</option>
                    </select>
                    <span style={{ fontSize: 12, color: 'var(--dim)' }}>
                      {browse.totalRows} {browse.totalRows === 1 ? 'row' : 'rows'}
                    </span>
                    <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                      {structure.type === 'table' && (
                        <>
                          <button type="button" className="sn-sql-btn sn-sql-btn-primary sn-sql-btn-sm" disabled={readOnly} onClick={() => setActiveTab('insert')}>
                            + Insert row
                          </button>
                          <button type="button" className="sn-sql-btn sn-sql-btn-sm" onClick={() => void handleTruncateTable()} disabled={readOnly || browse.totalRows === 0}>
                            Empty table
                          </button>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Inline Edit Row card */}
                  {editingRow && (
                    <form onSubmit={handleSaveEditRow} style={s.card} aria-label="Edit row">
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <h3 style={s.sectionHead}>
                          Edit row {editingRow.rowid !== null ? `#${editingRow.rowid}` : ''}
                        </h3>
                        <button type="button" className="sn-sql-btn sn-sql-btn-sm" onClick={() => setEditingRow(null)}>
                          Cancel
                        </button>
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 10 }}>
                        {structure.columns.map((col) => {
                          const entry = editingRow.draft[col.name] ?? { value: '', isNull: false };
                          return (
                            <label key={col.name} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                              <span style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                                <span style={{ fontFamily: 'var(--mono)', fontWeight: 600 }}>
                                  {col.name} <span style={{ color: 'var(--dim)', fontWeight: 400 }}>{col.type}</span>
                                </span>
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--dim)' }}>
                                  <input
                                    type="checkbox"
                                    checked={entry.isNull}
                                    onChange={(e) =>
                                      setEditingRow((prev) =>
                                        prev
                                          ? {
                                              ...prev,
                                              draft: {
                                                ...prev.draft,
                                                [col.name]: { ...entry, isNull: e.target.checked },
                                              },
                                            }
                                          : null
                                      )
                                    }
                                  />
                                  NULL
                                </span>
                              </span>
                              <input
                                type="text"
                                disabled={entry.isNull}
                                value={entry.isNull ? '' : entry.value}
                                placeholder={entry.isNull ? 'NULL' : ''}
                                onChange={(e) =>
                                  setEditingRow((prev) =>
                                    prev
                                      ? {
                                          ...prev,
                                          draft: {
                                            ...prev.draft,
                                            [col.name]: { value: e.target.value, isNull: false },
                                          },
                                        }
                                      : null
                                  )
                                }
                                style={{ ...s.input, opacity: entry.isNull ? 0.5 : 1 }}
                              />
                            </label>
                          );
                        })}
                      </div>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button type="submit" className="sn-sql-btn sn-sql-btn-primary sn-sql-btn-sm" disabled={readOnly}>Save changes</button>
                        <button type="button" className="sn-sql-btn sn-sql-btn-sm" onClick={() => setEditingRow(null)}>Cancel</button>
                      </div>
                    </form>
                  )}

                  {/* Data grid */}
                  <div style={s.tableWrap}>
                    <table style={s.grid}>
                      <thead>
                        <tr>
                          {structure.type === 'table' && <th style={{ ...s.th, width: 110 }}>Actions</th>}
                          {browse.columns.map((col) => (
                            <th
                              key={col}
                              style={{ ...s.th, cursor: 'pointer' }}
                              onClick={() => handleSort(col)}
                              title={`Sort by ${col}`}
                            >
                              {col}
                              {sortBy === col ? (sortDir === 'ASC' ? ' ▲' : ' ▼') : ''}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {browse.rows.length === 0 ? (
                          <tr>
                            <td colSpan={browse.columns.length + (structure.type === 'table' ? 1 : 0)} style={{ ...s.td, textAlign: 'center', color: 'var(--dim)', padding: 24 }}>
                              {browseSearch ? 'No rows match your search.' : 'This table has no rows yet.'}
                            </td>
                          </tr>
                        ) : (
                          browse.rows.map((row, rIdx) => (
                            <tr key={row.rowid !== null ? `r-${row.rowid}` : `i-${rIdx}`}>
                              {structure.type === 'table' && (
                                <td style={{ ...s.td, whiteSpace: 'nowrap' }}>
                                  <button
                                    type="button"
                                    className="sn-sql-btn sn-sql-btn-sm"
                                    style={{ marginRight: 4, padding: '2px 7px', fontSize: 11, minHeight: 22 }}
                                    disabled={readOnly}
                                    onClick={() => openEditRow(row)}
                                  >
                                    Edit
                                  </button>
                                  <button
                                    type="button"
                                    className="sn-sql-btn sn-sql-btn-sm sn-sql-btn-danger"
                                    style={{ padding: '2px 7px', fontSize: 11, minHeight: 22 }}
                                    disabled={readOnly}
                                    onClick={() => handleDeleteRow(row)}
                                  >
                                    Del
                                  </button>
                                </td>
                              )}
                              {row.values.map((val, cIdx) => {
                                const disp = displayCellValue(val);
                                return (
                                  <td
                                    key={cIdx}
                                    style={{ ...s.td, ...(disp.isNull ? s.nullVal : {}) }}
                                    title={disp.text}
                                  >
                                    {disp.text}
                                  </td>
                                );
                              })}
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>

                  {/* Pagination */}
                  {totalPages > 1 && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end' }}>
                      <button
                        type="button"
                        className="sn-sql-btn sn-sql-btn-sm"
                        disabled={browse.page <= 1}
                        onClick={() => handlePageChange(browse.page - 1)}
                      >
                        ← Prev
                      </button>
                      <span style={{ fontSize: 12, color: 'var(--dim)' }}>
                        Page {browse.page} of {totalPages}
                      </span>
                      <button
                        type="button"
                        className="sn-sql-btn sn-sql-btn-sm"
                        disabled={browse.page >= totalPages}
                        onClick={() => handlePageChange(browse.page + 1)}
                      >
                        Next →
                      </button>
                    </div>
                  )}
                </>
              )}

              {/* TAB: STRUCTURE */}
              {activeTab === 'structure' && selectedTable && structure && (
                <>
                  <div style={s.tableWrap}>
                    <table style={s.grid}>
                      <thead>
                        <tr>
                          <th style={s.th}>#</th>
                          <th style={s.th}>Column</th>
                          <th style={s.th}>Type</th>
                          <th style={s.th}>Null</th>
                          <th style={s.th}>Default</th>
                          <th style={s.th}>Key</th>
                          {structure.type === 'table' && <th style={s.th}>Actions</th>}
                        </tr>
                      </thead>
                      <tbody>
                        {structure.columns.map((col: SqliteColumnInfo) => (
                          <tr key={col.name}>
                            <td style={{ ...s.td, color: 'var(--dim)' }}>{col.cid + 1}</td>
                            <td style={{ ...s.td, fontWeight: 600 }}>
                              {renamingCol?.from === col.name ? (
                                <form onSubmit={handleRenameColumn} style={{ display: 'inline-flex', gap: 4 }}>
                                  <input
                                    type="text"
                                    value={renamingCol.to}
                                    onChange={(e) => setRenamingCol({ ...renamingCol, to: e.target.value })}
                                    style={{ ...s.input, width: 140, padding: '2px 6px' }}
                                    autoFocus
                                  />
                                  <button type="submit" className="sn-sql-btn sn-sql-btn-primary sn-sql-btn-sm" disabled={readOnly}>Save</button>
                                  <button type="button" className="sn-sql-btn sn-sql-btn-sm" onClick={() => setRenamingCol(null)}>✕</button>
                                </form>
                              ) : (
                                col.name
                              )}
                            </td>
                            <td style={s.td}>{col.type || 'ANY'}</td>
                            <td style={s.td}>{col.notnull ? 'NO' : 'YES'}</td>
                            <td style={{ ...s.td, ...(col.dfltValue === null ? s.nullVal : {}) }}>
                              {col.dfltValue === null ? 'NULL' : col.dfltValue}
                            </td>
                            <td style={s.td}>{col.pk > 0 ? `PK${structure.pkColumns.length > 1 ? ` #${col.pk}` : ''}` : ''}</td>
                            {structure.type === 'table' && (
                              <td style={{ ...s.td, whiteSpace: 'nowrap' }}>
                                <button
                                  type="button"
                                  className="sn-sql-btn sn-sql-btn-sm"
                                  style={{ marginRight: 4, padding: '2px 7px', fontSize: 11, minHeight: 22 }}
                                  disabled={readOnly}
                                  onClick={() => setRenamingCol({ from: col.name, to: col.name })}
                                >
                                  Rename
                                </button>
                                <button
                                  type="button"
                                  className="sn-sql-btn sn-sql-btn-sm sn-sql-btn-danger"
                                  style={{ padding: '2px 7px', fontSize: 11, minHeight: 22 }}
                                  disabled={readOnly || structure.columns.length <= 1}
                                  onClick={() => void handleDropColumn(col.name)}
                                >
                                  Drop
                                </button>
                              </td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {/* Add Column */}
                  {structure.type === 'table' && (
                    <form onSubmit={handleAddColumn} style={s.card}>
                      <h3 style={s.sectionHead}>Add column</h3>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                        <input
                          type="text"
                          aria-label="New column name"
                          placeholder="column_name"
                          value={newCol.name}
                          onChange={(e) => setNewCol({ ...newCol, name: e.target.value })}
                          style={{ ...s.input, width: 170 }}
                          required
                        />
                        <select
                          aria-label="New column type"
                          style={s.select}
                          value={newCol.type}
                          onChange={(e) => setNewCol({ ...newCol, type: e.target.value })}
                        >
                          {SQLITE_TYPES.map((t) => (
                            <option key={t} value={t}>{t}</option>
                          ))}
                        </select>
                        <input
                          type="text"
                          aria-label="New column default value"
                          placeholder="Default (optional)"
                          value={newCol.defaultValue ?? ''}
                          onChange={(e) => setNewCol({ ...newCol, defaultValue: e.target.value })}
                          style={{ ...s.input, width: 170 }}
                        />
                        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12.5 }}>
                          <input
                            type="checkbox"
                            checked={!!newCol.notNull}
                            onChange={(e) => setNewCol({ ...newCol, notNull: e.target.checked })}
                          />
                          NOT NULL
                        </label>
                        <button type="submit" className="sn-sql-btn sn-sql-btn-primary sn-sql-btn-sm" disabled={readOnly}>
                          + Add column
                        </button>
                      </div>
                    </form>
                  )}

                  {/* Indexes */}
                  {structure.type === 'table' && (
                    <div style={s.card}>
                      <h3 style={s.sectionHead}>Indexes ({structure.indexes.length})</h3>
                      {structure.indexes.length > 0 && (
                        <div style={s.tableWrap}>
                          <table style={s.grid}>
                            <thead>
                              <tr>
                                <th style={s.th}>Name</th>
                                <th style={s.th}>Unique</th>
                                <th style={s.th}>Columns</th>
                                <th style={s.th}>Action</th>
                              </tr>
                            </thead>
                            <tbody>
                              {structure.indexes.map((idx) => (
                                <tr key={idx.name}>
                                  <td style={s.td}>{idx.name}</td>
                                  <td style={s.td}>{idx.unique ? 'YES' : 'NO'}</td>
                                  <td style={s.td}>{idx.columns.join(', ')}</td>
                                  <td style={s.td}>
                                    {idx.origin === 'c' ? (
                                      <button
                                        type="button"
                                        className="sn-sql-btn sn-sql-btn-sm sn-sql-btn-danger"
                                        style={{ padding: '2px 7px', fontSize: 11, minHeight: 22 }}
                                        disabled={readOnly}
                                        onClick={() => handleDropIndex(idx.name)}
                                      >
                                        Drop
                                      </button>
                                    ) : (
                                      <span style={{ color: 'var(--dim)', fontSize: 11 }}>auto</span>
                                    )}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                      <form onSubmit={handleAddIndex} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                        <input
                          type="text"
                          aria-label="Index name"
                          placeholder={`idx_${selectedTable}_${newIndexCol || 'col'}`}
                          value={newIndexName}
                          onChange={(e) => setNewIndexName(e.target.value)}
                          style={{ ...s.input, width: 190 }}
                        />
                        <select
                          aria-label="Index column"
                          style={s.select}
                          value={newIndexCol}
                          onChange={(e) => setNewIndexCol(e.target.value)}
                        >
                          {structure.columns.map((c) => (
                            <option key={c.name} value={c.name}>{c.name}</option>
                          ))}
                        </select>
                        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12.5 }}>
                          <input type="checkbox" checked={newIndexUnique} onChange={(e) => setNewIndexUnique(e.target.checked)} />
                          UNIQUE
                        </label>
                        <button type="submit" className="sn-sql-btn sn-sql-btn-sm" disabled={readOnly}>+ Add index</button>
                      </form>
                    </div>
                  )}

                  {/* Foreign Keys */}
                  {structure.foreignKeys.length > 0 && (
                    <div style={s.card}>
                      <h3 style={s.sectionHead}>Foreign keys ({structure.foreignKeys.length})</h3>
                      <div style={s.tableWrap}>
                        <table style={s.grid}>
                          <thead>
                            <tr>
                              <th style={s.th}>Column</th>
                              <th style={s.th}>References</th>
                              <th style={s.th}>ON UPDATE</th>
                              <th style={s.th}>ON DELETE</th>
                            </tr>
                          </thead>
                          <tbody>
                            {structure.foreignKeys.map((fk, i) => (
                              <tr key={i}>
                                <td style={s.td}>{fk.from}</td>
                                <td style={s.td}>{fk.table}({fk.to})</td>
                                <td style={s.td}>{fk.onUpdate}</td>
                                <td style={s.td}>{fk.onDelete}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {/* Table Operations + DDL */}
                  <div style={s.card}>
                    <h3 style={s.sectionHead}>Table operations</h3>
                    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                      {structure.type === 'table' && (
                        <form onSubmit={handleRenameTable} style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                          <input
                            type="text"
                            aria-label="Rename table"
                            value={renameTableInput}
                            onChange={(e) => setRenameTableInput(e.target.value)}
                            style={{ ...s.input, width: 180 }}
                          />
                          <button type="submit" className="sn-sql-btn sn-sql-btn-sm" disabled={readOnly || !renameTableInput.trim() || renameTableInput.trim() === selectedTable}>
                            Rename table
                          </button>
                        </form>
                      )}
                      <button
                        type="button"
                        className="sn-sql-btn sn-sql-btn-sm sn-sql-btn-danger"
                        disabled={readOnly}
                        onClick={() => void handleDropTable()}
                      >
                        Drop {structure.type} &ldquo;{selectedTable}&rdquo;
                      </button>
                    </div>
                    {structure.sql && (
                      <details>
                        <summary style={{ cursor: 'pointer', color: 'var(--dim)', fontSize: 12 }}>
                          Show CREATE statement (DDL)
                        </summary>
                        <pre style={{ marginTop: 8, padding: 10, borderRadius: 6, background: 'var(--ink)', border: '1px solid var(--line-soft)', overflowX: 'auto', fontSize: 12, fontFamily: 'var(--mono)' }}>
                          {structure.sql}
                        </pre>
                      </details>
                    )}
                  </div>
                </>
              )}

              {/* TAB: INSERT */}
              {activeTab === 'insert' && selectedTable && structure && (
                <div style={s.card}>
                  <h3 style={s.sectionHead}>Insert into {selectedTable}</h3>
                  {structure.type === 'view' ? (
                    <p style={{ color: 'var(--dim)', margin: 0 }}>Views are read-only. Select a table to insert rows.</p>
                  ) : (
                    <>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
                        {structure.columns.map((col) => {
                          const entry = insertDraft[col.name] ?? { value: '', isNull: false };
                          const autoHint = col.pk > 0 ? 'auto if blank' : col.dfltValue !== null ? `default: ${col.dfltValue}` : '';
                          return (
                            <label key={col.name} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                              <span style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                                <span style={{ fontFamily: 'var(--mono)', fontWeight: 600 }}>
                                  {col.name}{' '}
                                  <span style={{ color: 'var(--dim)', fontWeight: 400 }}>
                                    {col.type || 'ANY'}{col.pk > 0 ? ' · PK' : ''}{col.notnull ? ' · NOT NULL' : ''}
                                  </span>
                                </span>
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--dim)' }}>
                                  <input
                                    type="checkbox"
                                    checked={entry.isNull}
                                    onChange={(e) =>
                                      setInsertDraft((prev) => ({
                                        ...prev,
                                        [col.name]: { ...entry, isNull: e.target.checked },
                                      }))
                                    }
                                  />
                                  NULL
                                </span>
                              </span>
                              <input
                                type="text"
                                aria-label={`Value for ${col.name}`}
                                disabled={entry.isNull}
                                value={entry.isNull ? '' : entry.value}
                                placeholder={entry.isNull ? 'NULL' : autoHint}
                                onChange={(e) =>
                                  setInsertDraft((prev) => ({
                                    ...prev,
                                    [col.name]: { value: e.target.value, isNull: false },
                                  }))
                                }
                                style={{ ...s.input, opacity: entry.isNull ? 0.5 : 1 }}
                              />
                            </label>
                          );
                        })}
                      </div>
                      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                        <button type="button" className="sn-sql-btn sn-sql-btn-primary sn-sql-btn-sm" disabled={readOnly} onClick={() => handleInsertRow(true)}>
                          Insert &amp; browse
                        </button>
                        <button type="button" className="sn-sql-btn sn-sql-btn-sm" disabled={readOnly} onClick={() => handleInsertRow(false)}>
                          Insert &amp; add another
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )}

              {/* TAB: SQL CONSOLE */}
              {activeTab === 'sql' && (
                <>
                  <div style={s.card}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                      <h3 style={s.sectionHead}>Run SQL query on {activeDb.name}</h3>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {selectedTable && (
                          <button
                            type="button"
                            className="sn-sql-btn sn-sql-btn-sm"
                            onClick={() => setSqlQuery(`SELECT * FROM ${quoteSqlIdent(selectedTable)} LIMIT 50;`)}
                          >
                            SELECT *
                          </button>
                        )}
                        {selectedTable && (
                          <button
                            type="button"
                            className="sn-sql-btn sn-sql-btn-sm"
                            onClick={() => setSqlQuery(`SELECT COUNT(*) AS total FROM ${quoteSqlIdent(selectedTable)};`)}
                          >
                            COUNT(*)
                          </button>
                        )}
                        <button
                          type="button"
                          className="sn-sql-btn sn-sql-btn-sm"
                          onClick={() => setSqlQuery("SELECT name, type, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name;")}
                        >
                          Schema
                        </button>
                      </div>
                    </div>
                    <textarea
                      aria-label="SQL query editor"
                      rows={6}
                      value={sqlQuery}
                      onChange={(e) => setSqlQuery(e.target.value)}
                      onKeyDown={(e) => {
                        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                          e.preventDefault();
                          handleRunSql();
                        }
                      }}
                      style={{
                        ...s.input,
                        width: '100%',
                        fontFamily: 'var(--mono)',
                        fontSize: 12.5,
                        lineHeight: 1.55,
                        resize: 'vertical',
                      }}
                    />
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <button type="button" className="sn-sql-btn sn-sql-btn-primary sn-sql-btn-sm" onClick={handleRunSql}>
                        Run SQL (Ctrl+Enter)
                      </button>
                      <button type="button" className="sn-sql-btn sn-sql-btn-sm" onClick={() => { setSqlQuery(''); setSqlResult(null); setSqlError(null); }}>
                        Clear
                      </button>
                    </div>
                  </div>

                  {sqlError && <div style={s.errorBox}>{sqlError}</div>}

                  {sqlResult && (
                    <>
                      <div style={s.okBox}>
                        {sqlResult.exec.columns.length > 0
                          ? `Returned ${sqlResult.exec.rows.length} row(s) in ${sqlResult.elapsedMs.toFixed(1)} ms`
                          : `Query OK — ${sqlResult.exec.changes} row(s) affected${sqlResult.exec.lastInsertRowid ? ` · last_insert_rowid = ${sqlResult.exec.lastInsertRowid}` : ''} (${sqlResult.elapsedMs.toFixed(1)} ms)`}
                      </div>
                      {sqlResult.exec.columns.length > 0 && (
                        <div style={s.tableWrap}>
                          <table style={s.grid}>
                            <thead>
                              <tr>
                                {sqlResult.exec.columns.map((c, i) => (
                                  <th key={i} style={s.th}>{c}</th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {sqlResult.exec.rows.map((r, ri) => (
                                <tr key={ri}>
                                  {r.map((cell, ci) => {
                                    const disp = displayCellValue(cell);
                                    return (
                                      <td key={ci} style={{ ...s.td, ...(disp.isNull ? s.nullVal : {}) }} title={disp.text}>
                                        {disp.text}
                                      </td>
                                    );
                                  })}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </>
                  )}
                </>
              )}

              {/* TAB: CREATE TABLE */}
              {activeTab === 'create-table' && (
                <form onSubmit={handleCreateTable} style={s.card}>
                  <h3 style={s.sectionHead}>Create new table</h3>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4, maxWidth: 320 }}>
                    <span style={{ fontSize: 12, color: 'var(--dim)' }}>Table name</span>
                    <input
                      type="text"
                      aria-label="New table name"
                      placeholder="customers"
                      value={newTableName}
                      onChange={(e) => setNewTableName(e.target.value)}
                      style={s.input}
                      required
                    />
                  </label>

                  <div style={s.tableWrap}>
                    <table style={s.grid}>
                      <thead>
                        <tr>
                          <th style={s.th}>Column name</th>
                          <th style={s.th}>Type</th>
                          <th style={s.th}>PK</th>
                          <th style={s.th}>AI</th>
                          <th style={s.th}>Not Null</th>
                          <th style={s.th}>Unique</th>
                          <th style={s.th}>Default</th>
                          <th style={s.th}></th>
                        </tr>
                      </thead>
                      <tbody>
                        {newTableCols.map((col, idx) => (
                          <tr key={idx}>
                            <td style={s.td}>
                              <input
                                type="text"
                                aria-label={`Column ${idx + 1} name`}
                                value={col.name}
                                onChange={(e) =>
                                  setNewTableCols((prev) => prev.map((c, i) => (i === idx ? { ...c, name: e.target.value } : c)))
                                }
                                style={{ ...s.input, width: 150 }}
                                required
                              />
                            </td>
                            <td style={s.td}>
                              <select
                                aria-label={`Column ${idx + 1} type`}
                                value={col.type}
                                onChange={(e) =>
                                  setNewTableCols((prev) => prev.map((c, i) => (i === idx ? { ...c, type: e.target.value } : c)))
                                }
                                style={s.select}
                              >
                                {SQLITE_TYPES.map((t) => (
                                  <option key={t} value={t}>{t}</option>
                                ))}
                              </select>
                            </td>
                            <td style={s.td}>
                              <input
                                type="checkbox"
                                checked={!!col.primaryKey}
                                onChange={(e) =>
                                  setNewTableCols((prev) => prev.map((c, i) => (i === idx ? { ...c, primaryKey: e.target.checked } : c)))
                                }
                              />
                            </td>
                            <td style={s.td}>
                              <input
                                type="checkbox"
                                disabled={!col.primaryKey || col.type !== 'INTEGER'}
                                checked={!!col.autoIncrement && !!col.primaryKey && col.type === 'INTEGER'}
                                onChange={(e) =>
                                  setNewTableCols((prev) => prev.map((c, i) => (i === idx ? { ...c, autoIncrement: e.target.checked } : c)))
                                }
                              />
                            </td>
                            <td style={s.td}>
                              <input
                                type="checkbox"
                                checked={!!col.notNull}
                                onChange={(e) =>
                                  setNewTableCols((prev) => prev.map((c, i) => (i === idx ? { ...c, notNull: e.target.checked } : c)))
                                }
                              />
                            </td>
                            <td style={s.td}>
                              <input
                                type="checkbox"
                                checked={!!col.unique}
                                onChange={(e) =>
                                  setNewTableCols((prev) => prev.map((c, i) => (i === idx ? { ...c, unique: e.target.checked } : c)))
                                }
                              />
                            </td>
                            <td style={s.td}>
                              <input
                                type="text"
                                placeholder="optional"
                                value={col.defaultValue ?? ''}
                                onChange={(e) =>
                                  setNewTableCols((prev) => prev.map((c, i) => (i === idx ? { ...c, defaultValue: e.target.value } : c)))
                                }
                                style={{ ...s.input, width: 130 }}
                              />
                            </td>
                            <td style={s.td}>
                              <button
                                type="button"
                                className="sn-sql-btn sn-sql-btn-sm"
                                disabled={newTableCols.length <= 1}
                                onClick={() => setNewTableCols((prev) => prev.filter((_, i) => i !== idx))}
                              >
                                ✕
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <button
                      type="button"
                      className="sn-sql-btn sn-sql-btn-sm"
                      onClick={() => setNewTableCols((prev) => [...prev, { name: '', type: 'TEXT', defaultValue: '' }])}
                    >
                      + Add column
                    </button>
                    <button type="submit" className="sn-sql-btn sn-sql-btn-primary sn-sql-btn-sm" disabled={readOnly}>
                      Create table
                    </button>
                  </div>

                  <pre style={{ margin: 0, padding: 10, borderRadius: 6, background: 'var(--ink)', border: '1px solid var(--line-soft)', fontSize: 12, fontFamily: 'var(--mono)', overflowX: 'auto' }}>
                    {createTablePreviewSql}
                  </pre>
                </form>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
