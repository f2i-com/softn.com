/**
 * DataWorkspace — Smart switcher for Builder's Data tab.
 *
 * When a `.softn` project declares or bundles an XDB SQLite database (`.db`,
 * `.sqlite`, `.sqlite3`, `manifest.databases`, or backend `.sql` migrations),
 * opens directly into the mini-phpMyAdmin SQLite explorer (`SqliteDatabaseAdmin`).
 * Classic `.ui` / `.xdb` projects continue to open in `SchemaDesigner`, with a
 * clean mode switcher so users can switch between SQLite databases and `.xdb`
 * collections at any time.
 */

import { useEffect, useMemo, useState } from 'react';
import { useProjectStore } from '../../stores/projectStore';
import { useFilesStore } from '../../stores/filesStore';
import { detectProjectSqliteDatabases } from '../../utils/sqliteDatabase';
import DatabaseWorkspace from './DatabaseWorkspace';
import { SqliteDatabaseAdmin } from './SqliteDatabaseAdmin';

export function DataWorkspace({
  hosted = false,
  onSave,
  saveLabel = 'Return to FormLogic',
}: {
  hosted?: boolean;
  onSave?: () => void;
  saveLabel?: string;
}) {
  const projectId = useProjectStore((state) => state.projectId);
  const projectFormat = useProjectStore((state) => state.projectFormat);
  const source = useProjectStore((state) => state.source);
  const logicFiles = useFilesStore((state) => state.logicFiles);
  const assetFiles = useFilesStore((state) => state.assetFiles);

  const sqliteDbs = useMemo(
    () => detectProjectSqliteDatabases(source, logicFiles, assetFiles),
    [source, logicFiles, assetFiles]
  );

  const hasSqlite = sqliteDbs.length > 0;
  const preferSqlite = hasSqlite || (projectFormat === 'web' && !hosted);
  const [mode, setMode] = useState<'sqlite' | 'xdb'>(() => (preferSqlite ? 'sqlite' : 'xdb'));

  // Automatically pick the right default view when opening a different project
  useEffect(() => {
    setMode(preferSqlite ? 'sqlite' : 'xdb');
  }, [projectId, preferSqlite]);

  const modeSwitch = (
    <div className="bl-seg" role="group" aria-label="Data engine">
      <button
        type="button"
        aria-pressed={mode === 'sqlite'}
        onClick={() => setMode('sqlite')}
        title="Manage XDB SQLite 3 tables, schema, records, and SQL"
      >
        SQLite{sqliteDbs.length > 0 ? ` (${sqliteDbs.length})` : ''}
      </button>
      <button
        type="button"
        aria-pressed={mode === 'xdb'}
        onClick={() => setMode('xdb')}
        title="Visual ER diagram for .xdb document collections"
      >
        Collections
      </button>
    </div>
  );

  if (mode === 'sqlite') {
    return <SqliteDatabaseAdmin modeSwitch={modeSwitch} />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {hasSqlite || projectFormat === 'web' ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '6px 14px',
            background: 'var(--ink-2)',
            borderBottom: '1px solid var(--line-soft)',
            flexShrink: 0,
          }}
        >
          {modeSwitch}
          <span style={{ fontSize: 12, color: 'var(--dim)' }}>
            Switch to SQLite to inspect or edit this app’s embedded SQLite database
          </span>
        </div>
      ) : null}
      <div style={{ flex: 1, minHeight: 0 }}>
        <DatabaseWorkspace hosted={hosted} onSave={onSave ?? (() => {})} saveLabel={saveLabel} />
      </div>
    </div>
  );
}
