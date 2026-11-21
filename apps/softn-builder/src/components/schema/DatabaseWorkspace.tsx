import { lazy, Suspense, useState } from 'react';
import { useProjectStore } from '../../stores/projectStore';
import './database.css';

const Collections = lazy(() => import('./SchemaDesigner').then(module => ({ default: module.SchemaDesigner })));
const HostedTables = lazy(() => import('./HostedTables'));

export default function DatabaseWorkspace({ hosted, onSave, saveLabel }: {
  hosted: boolean;
  onSave: () => void;
  saveLabel: string;
}) {
  const [mode, setMode] = useState<'local' | 'hosted'>(hosted ? 'hosted' : 'local');
  const [openedTables, setOpenedTables] = useState(hosted);
  const generation = useProjectStore(state => state.workspaceGeneration);
  return (
    <section className="bl-db-workspace" aria-label="Database workspace">
      <header className="bl-db-bar">
        <h2>Database</h2>
        <div className="bl-seg" role="group" aria-label="Database location">
          <button type="button" aria-pressed={mode === 'local'} onClick={() => setMode('local')}>Local collections</button>
          <button type="button" aria-pressed={mode === 'hosted'} onClick={() => { setOpenedTables(true); setMode('hosted'); }}>FormLogic tables</button>
        </div>
      </header>
      <div className="bl-db-body">
        <Suspense fallback={<p role="status" className="bl-db-loading">Opening the database designer…</p>}>
          {mode === 'local' && <Collections />}
        </Suspense>
        {openedTables && <div className="bl-db-pane" hidden={mode !== 'hosted'}>
          <Suspense fallback={<p role="status" className="bl-db-loading">Opening FormLogic tables…</p>}>
            <HostedTables key={generation} onSave={hosted ? onSave : undefined} saveLabel={saveLabel} />
          </Suspense>
        </div>}
      </div>
    </section>
  );
}
