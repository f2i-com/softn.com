import { useId, useRef, useState } from 'react';
import { addFormLogicBackend, apiMethods, appendBackendRoute, isRecord, parseManifest } from './formlogicBackend';
import { useModalFocus } from './useModalFocus';
import './backendEditor.css';

interface Props {
  readFiles(): Record<string, string>;
  applyFiles(changes: Record<string, string>): void;
  onClose(): void;
}

function openBackend(read: Props['readFiles']) {
  const files = read();
  const original = parseManifest(files['manifest.json']);
  const plan = addFormLogicBackend(original, Object.keys(files));
  const server = plan.manifest.server as Record<string, unknown>;
  if (server.routes !== undefined && !Array.isArray(server.routes)) throw new Error('Check server.routes in manifest.json.');
  const source = plan.files[plan.entry] ?? files[plan.entry];
  if (typeof source !== 'string') throw new Error(`Open ${plan.entry} as a text file to edit it.`);
  return { files, plan, server, routes: (server.routes ?? []) as unknown[], source, existing: !!original.server };
}

export default function BackendEditor({ readFiles, applyFiles, onClose }: Props) {
  const id = useId();
  const ref = useModalFocus(true, onClose, 'h2');
  const [opened] = useState(() => {
    try { return { data: openBackend(readFiles), error: '' }; }
    catch (error) { return { error: (error as Error).message, data: null }; }
  });
  const data = opened.data;
  const [source, setSource] = useState(data?.source ?? '');
  const [routes, setRoutes] = useState(data?.routes ?? []);
  const [method, setMethod] = useState<string>('GET');
  const [path, setPath] = useState('');
  const [handler, setHandler] = useState('');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState(opened.error);
  const addButton = useRef<HTMLButtonElement>(null);
  const visibleRoutes = routes.filter(isRecord);

  function save() {
    if (!data) return;
    try {
      const current = readFiles();
      const { entry } = data.plan;
      if (current['manifest.json'] !== data.files['manifest.json'] || current[entry] !== data.files[entry]) {
        throw new Error('The project changed while this editor was open. Reopen Backend to load the latest source.');
      }
      if (!source.trim()) throw new Error('Enter the backend handler source before saving.');
      const changes: Record<string, string> = {};
      if (!data.existing || routes !== data.routes) {
        changes['manifest.json'] = JSON.stringify({ ...data.plan.manifest, server: { ...data.server, routes } }, null, 2) + '\n';
      }
      if (source !== current[entry]) changes[entry] = source;
      if (Object.keys(changes).length) applyFiles(changes);
      onClose();
    } catch (problem) { setError((problem as Error).message); }
  }

  function addRoute() {
    try {
      const next = appendBackendRoute(routes, source, method, path.trim(), handler.trim());
      setRoutes(next.routes); setSource(next.source); setAdding(false); setPath(''); setHandler(''); setError('');
      addButton.current?.focus();
    } catch (problem) { setError((problem as Error).message); }
  }

  return <div className="sn-backdrop"><div className="sn-backend sn-api-editor" role="dialog" aria-modal="true" aria-labelledby={id} ref={ref}>
    <header><h2 id={id} tabIndex={-1}>FormLogic backend</h2><button type="button" onClick={onClose} aria-label="Close backend editor">×</button></header>
    <div className="sn-api-body">
    <p>Define the routes and handlers that run on FormLogic or the self-hosted PHP server.</p>
    {data && <>
      <section aria-label="API routes"><div className="sn-back-row"><h3>API routes</h3>
        <button ref={addButton} type="button" onClick={() => { setAdding(!adding); setError(''); }} aria-expanded={adding}>{adding ? 'Cancel route' : 'Add route'}</button></div>
        {visibleRoutes.length === 0 ? <p>Add a route to connect an HTTP request to a handler.</p> :
          <ul className="sn-api-routes">{visibleRoutes.map((r, i) => <li key={i}><strong>{String(r.method)}</strong><code>{String(r.path)}</code><span>{String(r.handler)}</span></li>)}</ul>}
        {adding && <form className="sn-back-fields" onSubmit={event => { event.preventDefault(); addRoute(); }}>
          <label>Method<select value={method} onChange={e => setMethod(e.target.value)}>{apiMethods.map(m => <option key={m}>{m}</option>)}</select></label>
          <label>Path<input autoFocus required value={path} placeholder="/api/notes" autoCapitalize="none" spellCheck={false} onChange={e => setPath(e.target.value)} /></label>
          <label>Handler<input required value={handler} placeholder="listNotes" autoCapitalize="none" spellCheck={false} onChange={e => setHandler(e.target.value)} /></label>
          <button type="submit">Insert route</button>
        </form>}
      </section>
      <label className="sn-source">Handler source <code>{data.plan.entry}</code>
        <textarea spellCheck={false} value={source} onChange={e => setSource(e.target.value)} /></label>
    </>}
    </div>
    {error && <p role="alert">{error}</p>}
    <footer><button type="button" onClick={onClose}>Cancel</button>
      {data && <button type="button" className="sn-primary" disabled={adding} onClick={save}>{data.existing ? 'Save backend' : 'Add backend'}</button>}
    </footer>
  </div></div>;
}
