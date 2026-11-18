import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { addFormLogicBackend } from '@softn/editor-shared/formlogicBackend';
import { createTableMigration, createTableSql, listedMigrations, migrationTableNames, type HostedTableColumn } from '@softn/editor-shared/hostedDatabase';
import { applyBuilderBackendFiles, readBuilderBackendFiles } from '../../utils/backendFiles';
import { useProjectStore } from '../../stores/projectStore';

const blankColumns = () => [{ key: 1, name: '', type: 'TEXT' as HostedTableColumn['type'], required: false }];

export default function HostedTables({ onSave, saveLabel }: { onSave?: () => void; saveLabel: string }) {
  const projectFormat = useProjectStore(state => state.projectFormat);
  const source = useProjectStore(state => state.source);
  const history = useMemo(() => {
    try {
      const files = readBuilderBackendFiles({ source, projectFormat });
      return { files, paths: listedMigrations(files), error: '' };
    } catch (error) {
      return { files: {} as Record<string, string>, paths: [], error: (error as Error).message };
    }
  }, [projectFormat, source]);
  const [name, setName] = useState('');
  const [columns, setColumns] = useState(blankColumns);
  const [error, setError] = useState('');
  const [added, setAdded] = useState('');
  const fieldId = useId();
  const tableName = useRef<HTMLInputElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const columnInputs = useRef(new Map<number, HTMLInputElement>());
  const nextFocus = useRef<number | 'add' | null>(null);
  const errorMessage = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    const target = nextFocus.current;
    if (target === 'add') addButton.current?.focus();
    else if (target !== null) columnInputs.current.get(target)?.focus();
    nextFocus.current = null;
  }, [columns]);
  useEffect(() => { if (error) errorMessage.current?.focus(); }, [error]);
  const design = { name, columns };
  let sql = '';
  try { sql = createTableSql(design); } catch { /* Incomplete drafts have no SQL preview. */ }

  function submit(event: FormEvent) {
    event.preventDefault();
    try {
      // Source may have changed since the draft was opened. Allocate its next file at submit time.
      const current = readBuilderBackendFiles();
      const manifest = JSON.parse(current['manifest.json']);
      const changes: Record<string, string> = {};
      const backend = addFormLogicBackend(manifest, Object.keys(current));
      if (backend.manifest !== manifest) {
        Object.assign(changes, backend.files);
        changes['manifest.json'] = JSON.stringify(backend.manifest);
      }
      const migration = createTableMigration({ ...current, ...changes }, design);
      changes[migration.path] = migration.sql;
      changes['manifest.json'] = migration.manifest;
      applyBuilderBackendFiles(changes);
      setAdded(`Added ${name.trim()} in ${migration.path}.`);
      setError('');
      setName('');
      setColumns(blankColumns());
      tableName.current?.focus();
    } catch (failure) {
      setAdded('');
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }

  function changeColumn(key: number, patch: Partial<HostedTableColumn>) {
    setColumns(all => all.map(column => column.key === key ? { ...column, ...patch } : column));
  }

  function addColumn() {
    const key = (columns.at(-1)?.key ?? 0) + 1;
    nextFocus.current = key;
    setColumns([...columns, { ...blankColumns()[0], key }]);
    setError('');
    setAdded('');
  }

  function removeColumn(index: number) {
    nextFocus.current = columns[index + 1]?.key ?? columns[index - 1]?.key ?? 'add';
    setColumns(columns.filter((_, i) => i !== index));
    setError('');
    setAdded('');
  }

  return (
    <section aria-label="FormLogic app data" className="bl-db-hosted">
      <div className="bl-db-intro">
        <h2>FormLogic tables</h2>
        <p>Define the tables your private backend can read and write. FormLogic creates them when you install the project.</p>
      </div>
      <div className="bl-db-grid">
        <form className="bl-db-card" onSubmit={submit} onChange={() => { setError(''); setAdded(''); }}>
          <h3>New table</h3>
          <label className="bl-db-field">Table name
            <input ref={tableName} required autoComplete="off" autoCapitalize="none" spellCheck={false} aria-describedby={fieldId + '-names'}
              placeholder="tasks" value={name} onChange={event => setName(event.target.value)} />
          </label>
          <p id={fieldId + '-names'} className="bl-db-hint">Start names with a letter. Use letters, numbers and underscores.</p>
          <div className="bl-db-subhead"><h4>Columns</h4>
            <button ref={addButton} type="button" className="bl-btn bl-btn-sm" onClick={addColumn}>+ Add column</button>
          </div>
          <p className="bl-db-id"><code>id</code> Integer primary key · assigned automatically</p>
          {columns.map((column, index) => (
            <div key={column.key} className="bl-db-col">
              <label className="bl-db-field">Name
                <input ref={input => { if (input) columnInputs.current.set(column.key, input); else columnInputs.current.delete(column.key); }}
                  required aria-label={`Column ${index + 1} name`} autoCapitalize="none" spellCheck={false} autoComplete="off" placeholder="title" value={column.name}
                  onChange={event => changeColumn(column.key, { name: event.target.value })} />
              </label>
              <label className="bl-db-field">Type
                <select aria-label={`Column ${index + 1} type`} value={column.type}
                  onChange={event => changeColumn(column.key, { type: event.target.value as HostedTableColumn['type'] })}>
                  <option value="TEXT">Text</option><option value="INTEGER">Integer</option>
                  <option value="REAL">Decimal</option><option value="BOOLEAN">Yes / no</option>
                </select>
              </label>
              <label className="bl-db-required"><input type="checkbox" aria-label={`Column ${index + 1} required`} checked={column.required}
                onChange={event => changeColumn(column.key, { required: event.target.checked })} /> Required</label>
              <button type="button" className="bl-btn bl-btn-sm bl-btn-ghost" aria-label={`Remove column ${index + 1}`}
                onClick={() => removeColumn(index)}>Remove</button>
            </div>
          ))}
          {sql && <details className="bl-db-sql"><summary>Preview SQL</summary><pre>{sql}</pre></details>}
          {error && <p ref={errorMessage} tabIndex={-1} role="alert" className="bl-db-error">{error}</p>}
          <button className="bl-btn bl-btn-primary bl-btn-lg" type="submit">Add table to project</button>
          {added && <p role="status" className="bl-db-feedback">{added}</p>}
        </form>
        <aside className="bl-db-card bl-db-history" aria-label="Database migrations">
          <h3>Migration history</h3>
          {history.error ? <p role="alert">{history.error}</p> : !history.paths.length
            ? <p>Your first table adds a numbered SQL file here. Open a migration to read its SQL.</p>
            : <ol>{history.paths.map((path, index) => (
              <li key={path + index}><details><summary><strong>{migrationTableNames(history.files[path] ?? '').join(', ') || 'Database change'}</strong><code>{path}</code></summary>
                <pre>{history.files[path] ?? 'The project is missing this file.'}</pre>
              </details></li>
            ))}</ol>}
          {onSave && <button type="button" className="bl-btn bl-btn-sm" onClick={onSave}>{saveLabel}</button>}
        </aside>
      </div>
    </section>
  );
}
