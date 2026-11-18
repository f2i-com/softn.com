import React, { useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useModalFocus } from '@softn/editor-shared/useModalFocus';
import { isHostedEditor } from '@softn/editor-shared/hostedEditor';
import '@softn/editor-shared/backendEditor.css';
import { useVFSStore } from '../../stores/vfsStore';
import { databaseFiles, designDatabase, fieldKinds, type DatabaseTarget } from '../../lib/designDatabase';
import { busyReason } from '../../lib/fileOps';
import BackendEditor from '@softn/editor-shared/BackendEditor';
import '../../styles/database.css';

export function readStudioBackendFiles() { return databaseFiles(useVFSStore.getState().files); }

export function applyStudioFiles(changes: Record<string, string>, label: string) {
  const busy = busyReason();
  if (busy) throw new Error(busy);
  const state = useVFSStore.getState();
  state.applyTransaction(Object.entries(changes).map(([path, content]) => ({
    op: state.files.has(path) ? 'update' : 'create', path, content,
  })), 'user', undefined, label);
}

export default function StudioProjectTools({ tool, onClose, onCreated }: { tool: 'backend' | 'database'; onClose(): void; onCreated(path: string): void }) {
  const dialog = tool === 'backend'
    ? <BackendEditor readFiles={readStudioBackendFiles} applyFiles={changes => applyStudioFiles(changes, 'Updated FormLogic backend')} onClose={onClose} />
    : <StudioDatabase onClose={onClose} onCreated={onCreated} />;
  return createPortal(dialog, document.getElementById('root') ?? document.body);
}

function StudioDatabase({ onClose, onCreated }: { onClose(): void; onCreated(path: string): void }) {
  const id = useId();
  const ref = useModalFocus(true, onClose, 'input');
  const [target, setTarget] = useState<DatabaseTarget>(() => isHostedEditor() ? 'formlogic' : 'local');
  const [name, setName] = useState('');
  const [fields, setFields] = useState([{ key: 0, name: '', type: 'string', required: false }]);
  const nextKey = useRef(1);
  const focusAfterEdit = useRef<number | 'add' | null>(null);
  const [error, setError] = useState('');
  useLayoutEffect(() => {
    if (focusAfterEdit.current === null) return;
    document.getElementById(`${id}-field-${focusAfterEdit.current}`)?.focus();
    focusAfterEdit.current = null;
  }, [fields, id]);
  const update = (key: number, change: Partial<typeof fields[number]>) => setFields(before => before.map(f => f.key === key ? { ...f, ...change } : f));
  const local = target === 'local';
  const storageHint = local ? 'Records stay on this device and are available offline.' : 'FormLogic adds an integer id and creates the table when you install the project.';
  function changeTarget(next: DatabaseTarget) {
    setTarget(next);
    if (next === 'local') setFields(list => list.map(field => field.type === 'integer' ? { ...field, type: 'number' } : field));
  }
  function addField() {
    const key = nextKey.current++;
    focusAfterEdit.current = key;
    setFields(list => [...list, { key, name: '', type: 'string', required: false }]);
  }
  function removeField(index: number) {
    focusAfterEdit.current = fields[index + 1]?.key ?? fields[index - 1]?.key ?? 'add';
    setFields(fields.filter((_, i) => i !== index));
  }
  function create(event: React.FormEvent) {
    event.preventDefault();
    try {
      const plan = designDatabase(readStudioBackendFiles(), target, name.trim(), fields.map(f => ({ ...f, name: f.name.trim() })));
      applyStudioFiles(plan.changes, `Created ${target === 'local' ? 'collection' : 'table'} ${name.trim()}`);
      onCreated(plan.path);
      onClose();
    } catch (problem) { setError(problem instanceof Error ? problem.message : 'Could not create the database.'); }
  }
  return <div className="sn-backdrop"><div className="sn-backend st-db-dialog" role="dialog" aria-modal="true" aria-labelledby={id} ref={ref}>
    <header><h2 id={id}>Design a database</h2><button type="button" onClick={onClose} aria-label="Close database designer">×</button></header>
    <form onSubmit={create} onChange={() => { if (error) setError(''); }}>
      <div className="st-db-body">
        <div className="st-db-storage">
          <label>Storage<select aria-describedby={`${id}-hint`} value={target} onChange={e => changeTarget(e.target.value as DatabaseTarget)}>
            <option value="local">Local collection</option><option value="formlogic">FormLogic table</option>
          </select></label>
          <label>{local ? 'Collection name' : 'Table name'}<input required placeholder="notes" value={name} onChange={e => setName(e.target.value)} /></label>
        </div>
        <p id={`${id}-hint`} className="st-db-hint">{storageHint}</p>
        <section aria-labelledby={`${id}-fields`}>
          <div className="sn-back-row"><h3 id={`${id}-fields`}>Fields</h3><button id={`${id}-field-add`} type="button" disabled={fields.length >= 100} onClick={addField}>Add field</button></div>
          {fields.map((field, i) => <div key={field.key} className="st-db-field">
            <label>Field name<input id={`${id}-field-${field.key}`} required aria-label={`Field ${i + 1} name`} placeholder="title" value={field.name} onChange={e => update(field.key, { name: e.target.value })} /></label>
            <label>Type<select aria-label={`Field ${i + 1} type`} value={field.type} onChange={e => update(field.key, { type: e.target.value })}>
              {fieldKinds.filter(kind => !local || kind !== 'integer').map(kind => <option key={kind}>{kind}</option>)}</select></label>
            <label className="st-db-required"><input type="checkbox" checked={field.required} aria-label={`Field ${i + 1} required`} onChange={e => update(field.key, { required: e.target.checked })} />Required</label>
            <button className="st-db-remove" type="button" aria-label={`Remove field ${i + 1}`} onClick={() => removeField(i)}>×</button>
          </div>)}
        </section>
      </div>
      <footer>
        {error && <p role="alert">{error}</p>}
        <button type="button" onClick={onClose}>Cancel</button><button className="sn-primary" type="submit">Create {local ? 'collection' : 'table'}</button>
      </footer>
    </form>
  </div></div>;
}
