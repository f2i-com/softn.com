import { describe, it, expect, beforeEach } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mountSoftNContainer, transformJsx } from '../src/index';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINES_DIR = path.join(PKG_ROOT, 'dist', 'runtime', 'engines');
const TS_WASM = path.join(ENGINES_DIR, 'zipp-typescript.wasm');
const RUST_WASM = path.join(ENGINES_DIR, 'zipp-rust.wasm');
const XDB_WASM = path.join(ENGINES_DIR, 'xdb-wasm.wasm');
const XDB_GLUE = path.join(ENGINES_DIR, 'xdb-wasm.glue.js');

function flushAsync(ms = 80): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('Direct Uncompiled React (.tsx / .jsx) Frontend Support', () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
  });

  it('transpiles JSX/TSX elements, fragments, spreads, and comments while preserving TypeScript generics', () => {
    const src = `
      interface Item { id: number; name: string; }
      const pick = <T,>(arr: Array<T>): T | undefined => arr.length > 0 ? arr[0] : undefined;
      export function List({ items, ...rest }: { items: Item[]; id?: string }) {
        const [count, setCount] = useState<number>(0);
        const low = count < 10 && items.length < 5;
        return (
          <>
            {/* comment ignored */}
            <section {...rest} data-low={low}>
              <h1>Count: {count}</h1>
              <ul>{items.map((it) => <li key={it.id}>{it.name}</li>)}</ul>
              <button disabled={count >= 5} onClick={() => setCount((c) => c + 1)}>Inc</button>
            </section>
          </>
        );
      }
    `;
    const out = transformJsx(src);
    expect(out).toContain('const pick = <T,>(arr: Array<T>)');
    expect(out).toContain('useState<number>(0)');
    expect(out).toContain('const low = count < 10 && items.length < 5;');
    expect(out).toContain('globalThis.__softnJsx(globalThis.__softnFragment, null,');
    expect(out).toContain('Object.assign({}, rest, { "data-low": low })');
    expect(out).not.toContain('comment ignored');
  });

  it('runs an uncompiled React + TypeScript (.tsx + .css) app directly with hooks, context, and controlled inputs', async () => {
    const reactSourceZip = zipSync({
      'index.html': strToU8(`<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Uncompiled React TSX</title></head>
<body>
  <div id="root"></div>
  <script type="module" src="/src/main.tsx"></script>
</body>
</html>`),
      'src/App.css': strToU8(`.card { padding: 12px; border: 1px solid #334155; }`),
      'src/ThemeContext.tsx': strToU8(`
import { createContext, useContext } from 'react';
export const ThemeContext = createContext<string>('amber');
export function useTheme(): string {
  return useContext(ThemeContext);
}
`),
      'src/App.tsx': strToU8(`
import { useState, useEffect, useMemo } from 'react';
import { ThemeContext, useTheme } from './ThemeContext';
import './App.css';

interface Task {
  id: number;
  title: string;
}

function Badge() {
  const theme = useTheme();
  return <span id="theme-badge">theme:{theme}</span>;
}

export function App() {
  const [tasks, setTasks] = useState<Task[]>([{ id: 1, title: 'Inspect haul road' }]);
  const [draft, setDraft] = useState<string>('');
  const [theme, setTheme] = useState<string>('cobalt');
  const [mounted, setMounted] = useState<boolean>(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const summary = useMemo(() => tasks.length + ' tasks', [tasks]);

  const addTask = () => {
    if (!draft.trim()) return;
    setTasks((prev) => [...prev, { id: prev.length + 1, title: draft.trim() }]);
    setDraft('');
  };

  return (
    <ThemeContext.Provider value={theme}>
      <div className="card">
        <h1 id="heading">React TSX Direct ({summary})</h1>
        <div id="mounted">{mounted ? 'yes' : 'no'}</div>
        <Badge />
        <button id="flip-theme" type="button" onClick={() => setTheme('emerald')}>Flip Theme</button>
        <input
          id="draft"
          value={draft}
          onChange={(e: any) => setDraft(e.target.value)}
        />
        <button id="add-btn" type="button" onClick={addTask}>Add</button>
        <ul id="task-list">
          {tasks.map((t) => (
            <li key={t.id}>{t.title}</li>
          ))}
        </ul>
      </div>
    </ThemeContext.Provider>
  );
}
`),
      'src/main.tsx': strToU8(`
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
`),
    });

    const host = document.createElement('div');
    document.body.appendChild(host);

    const handle = await mountSoftNContainer(host, {
      source: reactSourceZip,
      appId: 'test-react-source-tsx',
      isolation: 'inline',
      permissionMode: 'deny',
      engineWasm: { typescript: TS_WASM },
    });

    expect(handle.engineTier).toBe('typescript');
    await flushAsync(100);

    expect(handle.shadowRoot.querySelector('#heading')?.textContent).toBe('React TSX Direct (1 tasks)');
    expect(handle.shadowRoot.querySelector('#mounted')?.textContent).toBe('yes');
    expect(handle.shadowRoot.querySelector('#theme-badge')?.textContent).toBe('theme:cobalt');
    // CSS module/import injected a `<style>` tag
    expect(handle.shadowRoot.querySelectorAll('style').length).toBeGreaterThanOrEqual(1);

    // Context updates propagate cleanly
    (handle.shadowRoot.querySelector('#flip-theme') as HTMLButtonElement).click();
    await flushAsync(80);
    expect(handle.shadowRoot.querySelector('#theme-badge')?.textContent).toBe('theme:emerald');

    // Controlled input + add item keeps DOM in-place and appends task
    const input = handle.shadowRoot.querySelector('#draft') as HTMLInputElement;
    input.value = 'Check crusher belt';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await flushAsync(60);
    (handle.shadowRoot.querySelector('#add-btn') as HTMLButtonElement).click();
    await flushAsync(80);

    const items = Array.from(handle.shadowRoot.querySelectorAll('#task-list li')).map((li) => li.textContent);
    expect(items).toEqual(['Inspect haul road', 'Check crusher belt']);
    expect(handle.shadowRoot.querySelector('#heading')?.textContent).toBe('React TSX Direct (2 tasks)');

    handle.dispose();
  }, 30_000);

  it('runs a single .zip combining an UNCOMPILED React .tsx frontend (app/) + Rust Axum/SQLite backend (server/)', async () => {
    const fullstackTsxZip = zipSync({
      'app/index.html': strToU8(`<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Uncompiled React + Rust</title></head>
<body>
  <div id="root"></div>
  <script type="module" src="/src/main.tsx"></script>
</body>
</html>`),
      'app/src/main.tsx': strToU8(`
import { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';

interface Unit { id: number; code: string; }

function FleetApp() {
  const [units, setUnits] = useState<Unit[]>([]);

  const load = async () => {
    const r = await fetch('/api/units');
    setUnits(await r.json());
  };

  useEffect(() => {
    load();
  }, []);

  const addUnit = async () => {
    await fetch('/api/units', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'T-205' }),
    });
    await load();
  };

  return (
    <div>
      <button id="add-unit" type="button" onClick={addUnit}>Add Truck</button>
      <ul id="units">{units.map((u) => <li key={u.id}>{u.code}</li>)}</ul>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<FleetApp />);
`),
      'db/seed.json': strToU8(JSON.stringify({ units: [{ id: 1, code: 'T-101' }, { id: 2, code: 'S-01' }] })),
      'server/Cargo.toml': strToU8(`[package]\nname = "fleet"\nversion = "0.1.0"\nedition = "2021"\n`),
      'server/src/main.rs': strToU8(`
use axum::{extract::State, routing::get, Json, Router};
use serde::{Deserialize, Serialize};
use sqlx::{SqlitePool, Row};

#[derive(Serialize)]
struct Unit { id: i64, code: String }
#[derive(Deserialize)]
struct NewUnit { code: String }

async fn list(State(pool): State<SqlitePool>) -> Json<Vec<Unit>> {
    let rows = sqlx::query("SELECT id, code FROM units ORDER BY id").fetch_all(&pool).await.unwrap();
    Json(rows.into_iter().map(|r| Unit { id: r.get::<i64, _>(0), code: r.get::<String, _>(1) }).collect())
}

async fn create(State(pool): State<SqlitePool>, Json(b): Json<NewUnit>) -> Json<Unit> {
    let res = sqlx::query("INSERT INTO units (code) VALUES (?)").bind(&b.code).execute(&pool).await.unwrap();
    Json(Unit { id: res.last_insert_rowid(), code: b.code })
}

#[tokio::main]
async fn main() {
    let pool = SqlitePool::connect("sqlite:app.db").await.unwrap();
    let app = Router::new().route("/api/units", get(list).post(create)).with_state(pool);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:8080").await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
`),
    });

    const host = document.createElement('div');
    document.body.appendChild(host);

    const handle = await mountSoftNContainer(host, {
      source: fullstackTsxZip,
      appId: 'test-uncompiled-tsx-rust',
      isolation: 'inline',
      permissionMode: 'deny',
      engineWasm: { typescript: TS_WASM, rust: RUST_WASM },
      xdbWasm: XDB_WASM,
      xdbGlueUrl: XDB_GLUE,
    });

    expect(handle.manifest.frontendRoot).toBe('app');
    expect(handle.manifest.backend?.runtime).toBe('rust');
    await flushAsync(120);

    const before = Array.from(handle.shadowRoot.querySelectorAll('#units li')).map((li) => li.textContent);
    expect(before).toEqual(['T-101', 'S-01']);

    (handle.shadowRoot.querySelector('#add-unit') as HTMLButtonElement).click();
    await flushAsync(120);

    const after = Array.from(handle.shadowRoot.querySelectorAll('#units li')).map((li) => li.textContent);
    expect(after).toEqual(['T-101', 'S-01', 'T-205']);

    handle.dispose();
  }, 30_000);
});
