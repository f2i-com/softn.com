import { describe, it, expect, beforeEach } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mountSoftNContainer, type BackendTransport } from '../src/index';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINES_DIR = path.join(PKG_ROOT, 'dist', 'runtime', 'engines');
const LITE_WASM = path.join(ENGINES_DIR, 'zipp-javascript-lite.wasm');
const JS_WASM = path.join(ENGINES_DIR, 'zipp-javascript.wasm');
const RUST_WASM = path.join(ENGINES_DIR, 'zipp-rust.wasm');
const XDB_WASM = path.join(ENGINES_DIR, 'xdb-wasm.wasm');
const XDB_GLUE = path.join(ENGINES_DIR, 'xdb-wasm.glue.js');

const PIT_ROOT = 'E:\\repos\\mining_projects\\pit_software';

function flushAsync(ms = 60): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function collectFilesRecursive(
  baseDir: string,
  zipPrefix: string,
  out: Record<string, Uint8Array>,
  filter?: (rel: string) => boolean
): void {
  for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
    const abs = path.join(baseDir, entry.name);
    const rel = zipPrefix ? `${zipPrefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name === 'target' || entry.name === 'node_modules' || entry.name === '.git') continue;
      collectFilesRecursive(abs, rel, out, filter);
    } else if (!filter || filter(rel)) {
      out[rel] = new Uint8Array(fs.readFileSync(abs));
    }
  }
}

describe('Full-Stack Rust & JS Backends + FormLogic Transport Decoupling', () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
  });

  it('runs a single .zip React/HTML frontend + embedded Rust Axum/SQLx/XDB backend with interceptOrigins and JSON seed data', async () => {
    const fullstackRustZip = zipSync({
      'index.html': strToU8(`<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Rust + SQLite Full-Stack</title></head>
<body>
  <h1 id="title">Inventory</h1>
  <ul id="items"></ul>
  <button id="add" type="button">Add Drill</button>
  <div id="rust-leak">pending</div>
  <script type="module">
    async function refresh() {
      // Uses http://localhost:8080 (intercepted locally by SoftN BackendTransport — zero net permission!)
      const res = await fetch('http://localhost:8080/api/items');
      const items = await res.json();
      const ul = document.getElementById('items');
      ul.innerHTML = '';
      for (const it of items) {
        const li = document.createElement('li');
        li.textContent = it.name + ' (' + it.qty + ')';
        ul.appendChild(li);
      }
    }
    await refresh();
    // Verify frontend cannot read backend Rust source files
    const srcRes = await fetch('/server/src/main.rs');
    document.getElementById('rust-leak').textContent = 'rust_src_status=' + srcRes.status;

    document.getElementById('add').addEventListener('click', async () => {
      await fetch('http://localhost:8080/api/items', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Blast Drill', qty: 3 }),
      });
      await refresh();
    });
  </script>
</body>
</html>`),
      'db/seed.json': strToU8(
        JSON.stringify({
          items: [
            { id: 1, name: 'Haul Truck', qty: 4 },
            { id: 2, name: 'Excavator', qty: 2 },
          ],
        })
      ),
      'server/Cargo.toml': strToU8(`[package]\nname = "inv-server"\nversion = "0.1.0"\nedition = "2021"\n`),
      'server/src/main.rs': strToU8(`
use axum::{extract::State, routing::{get, post}, Json, Router};
use serde::{Deserialize, Serialize};
use sqlx::{SqlitePool, Row};

#[derive(Serialize)]
struct Item { id: i64, name: String, qty: i64 }

#[derive(Deserialize)]
struct NewItem { name: String, qty: i64 }

async fn list_items(State(pool): State<SqlitePool>) -> Json<Vec<Item>> {
    let rows = sqlx::query("SELECT id, name, qty FROM items ORDER BY id")
        .fetch_all(&pool).await.unwrap();
    let out = rows.into_iter().map(|r| Item {
        id: r.get::<i64, _>(0),
        name: r.get::<String, _>(1),
        qty: r.get::<i64, _>(2),
    }).collect();
    Json(out)
}

async fn add_item(State(pool): State<SqlitePool>, Json(body): Json<NewItem>) -> Json<Item> {
    let res = sqlx::query("INSERT INTO items (name, qty) VALUES (?, ?)")
        .bind(&body.name)
        .bind(body.qty)
        .execute(&pool).await.unwrap();
    Json(Item { id: res.last_insert_rowid(), name: body.name, qty: body.qty })
}

#[tokio::main]
async fn main() {
    let pool = SqlitePool::connect("sqlite:app.db").await.unwrap();
    let app = Router::new()
        .route("/api/items", get(list_items).post(add_item))
        .with_state(pool);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:8080").await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
`),
    });

    const host = document.createElement('div');
    document.body.appendChild(host);

    const handle = await mountSoftNContainer(host, {
      source: fullstackRustZip,
      appId: 'test-rust-inventory',
      isolation: 'inline',
      permissionMode: 'deny', // Zero external net permission!
      engineWasm: { lite: LITE_WASM, rust: RUST_WASM },
      xdbWasm: XDB_WASM,
      xdbGlueUrl: XDB_GLUE,
    });

    await flushAsync(100);

    // 1. Seeded items returned from Rust Axum + SQLx + XDB WASM
    const before = Array.from(handle.shadowRoot.querySelectorAll('#items li')).map((li) => li.textContent);
    expect(before).toEqual(['Haul Truck (4)', 'Excavator (2)']);

    // 2. Frontend cannot read `server/src/main.rs` (VFS partitioned!)
    expect(handle.shadowRoot.querySelector('#rust-leak')?.textContent).toBe('rust_src_status=404');

    // 3. Frontend POSTs to `http://localhost:8080/api/items` -> Rust inserts into XDB SQLite -> UI updates!
    (handle.shadowRoot.querySelector('#add') as HTMLButtonElement).click();
    await flushAsync(120);

    const after = Array.from(handle.shadowRoot.querySelectorAll('#items li')).map((li) => li.textContent);
    expect(after).toEqual(['Haul Truck (4)', 'Excavator (2)', 'Blast Drill (3)']);

    handle.dispose();
  }, 30_000);

  it('supports swapping in an external FormLogic-style BackendTransport without changing a single line of app code', async () => {
    const appZip = zipSync({
      'index.html': strToU8(`<!DOCTYPE html>
<html><body>
  <div id="greeting">loading</div>
  <script type="module">
    const res = await fetch('/api/whoami');
    const data = await res.json();
    document.getElementById('greeting').textContent = data.tenant + ':' + data.user;
  </script>
</body></html>`),
    });

    // Simulate a FormLogic multi-user remote sandbox BackendTransport
    const calls: string[] = [];
    const formLogicTransport: BackendTransport = {
      ready: Promise.resolve(),
      async fetch(req) {
        calls.push(`${req.method} ${req.path}`);
        return {
          status: 200,
          statusText: 'OK',
          headers: [['content-type', 'application/json']],
          body: strToU8(JSON.stringify({ tenant: 'formlogic-cloud', user: 'multi-user-42' })),
        };
      },
      dispose() {},
    };

    const host = document.createElement('div');
    document.body.appendChild(host);

    const handle = await mountSoftNContainer(host, {
      source: appZip,
      appId: 'test-formlogic-swap',
      isolation: 'inline',
      permissionMode: 'deny',
      backendTransport: formLogicTransport,
      engineWasm: { lite: LITE_WASM },
    });

    await flushAsync(80);
    expect(calls).toEqual(['GET /api/whoami']);
    expect(handle.shadowRoot.querySelector('#greeting')?.textContent).toBe('formlogic-cloud:multi-user-42');
    expect(handle.backendTransport).toBe(formLogicTransport);

    handle.dispose();
  });

  it('runs a single .zip app with an embedded JS backend (backend/server.js) + XDB SQLite', async () => {
    const jsBackendZip = zipSync({
      'index.html': strToU8(`<!DOCTYPE html>
<html><body>
  <div id="out">loading</div>
  <script type="module">
    const r = await fetch('/api/ping');
    const j = await r.json();
    document.getElementById('out').textContent = j.msg + ':' + j.count;
  </script>
</body></html>`),
      'db/seed.json': strToU8(JSON.stringify({ widgets: [{ id: 1, label: 'alpha' }, { id: 2, label: 'beta' }] })),
      'backend/server.js': strToU8(`
        globalThis.handleRequest = function(req) {
          if (req.path === '/api/ping') {
            var db = sqlite.open('app.db');
            var res = db.query('SELECT COUNT(*) AS cnt FROM widgets');
            return {
              status: 200,
              json: { msg: 'pong', count: res.rows[0].cnt }
            };
          }
          return { status: 404, body: 'not found' };
        };
      `),
    });

    const host = document.createElement('div');
    document.body.appendChild(host);

    const handle = await mountSoftNContainer(host, {
      source: jsBackendZip,
      appId: 'test-js-backend',
      isolation: 'inline',
      permissionMode: 'deny',
      engineWasm: { lite: LITE_WASM, javascript: JS_WASM },
      xdbWasm: XDB_WASM,
      xdbGlueUrl: XDB_GLUE,
    });

    await flushAsync(80);
    expect(handle.shadowRoot.querySelector('#out')?.textContent).toBe('pong:2');
    handle.dispose();
  });

  it('packs and boots the REAL pit_software full-stack app (React/Vite app/dist + 103-file Rust Axum/SQLx server/) in a single .zip inside SoftN', async () => {
    const distDir = path.join(PIT_ROOT, 'app', 'dist');
    const serverSrcDir = path.join(PIT_ROOT, 'server', 'src');
    const cargoToml = path.join(PIT_ROOT, 'server', 'Cargo.toml');
    if (!fs.existsSync(distDir) || !fs.existsSync(serverSrcDir) || !fs.existsSync(cargoToml)) {
      return;
    }

    // Pack REAL pit_software frontend + 103-file Rust server into ONE `.zip` with NO manifest.json!
    const files: Record<string, Uint8Array> = {};
    collectFilesRecursive(distDir, 'app/dist', files);
    files['server/Cargo.toml'] = new Uint8Array(fs.readFileSync(cargoToml));
    collectFilesRecursive(serverSrcDir, 'server/src', files, (rel) => rel.endsWith('.rs') || rel.endsWith('.sql'));
    const pitZip = zipSync(files, { level: 0 });

    const host = document.createElement('div');
    document.body.appendChild(host);

    const statuses: string[] = [];
    const handle = await mountSoftNContainer(host, {
      source: pitZip,
      appId: 'pit-software-real-test',
      isolation: 'inline',
      permissionMode: 'deny',
      persistStorage: false,
      engineWasm: { lite: LITE_WASM, javascript: JS_WASM, rust: RUST_WASM },
      xdbWasm: XDB_WASM,
      xdbGlueUrl: XDB_GLUE,
      limits: { instructionsPerTurn: 500_000_000, turnTimeoutMs: 60_000 },
      onStatus: (s) => statuses.push(s.phase),
    });

    expect(statuses).toContain('opening');
    expect(statuses).toContain('loading-sqlite');
    expect(statuses).toContain('booting-backend');
    expect(statuses).toContain('ready');

    // 1. Verify zero-config full-stack auto-discovery
    expect(handle.manifest.frontendRoot).toBe('app/dist');
    expect(handle.manifest.backend?.runtime).toBe('rust');
    expect(handle.manifest.backend?.entry).toBe('server/src/main.rs');
    expect(handle.backendTransport).toBeDefined();

    // 2. Dispatch real API requests through SoftN's BackendTransport -> zipp-rust.wasm -> xdb-wasm!
    const bt = handle.backendTransport!;
    const dec = new TextDecoder();

    // GET /api/v1/health
    const health = await bt.fetch({ method: 'GET', path: '/api/v1/health', query: '', headers: {} });
    expect(health.status).toBe(200);
    const healthJson = JSON.parse(dec.decode(health.body));
    expect(healthJson.status).toBe('ok');

    // GET /api/v1/setup/status (verifies all 78-table migrations + demo seed succeeded!)
    const setup = await bt.fetch({ method: 'GET', path: '/api/v1/setup/status', query: '', headers: {} });
    expect(setup.status).toBe(200);
    const setupJson = JSON.parse(dec.decode(setup.body));
    expect(setupJson.sites_count).toBeGreaterThanOrEqual(1);
    expect(setupJson.equipment_count).toBeGreaterThanOrEqual(1);
    expect(setupJson.locations_count).toBeGreaterThanOrEqual(1);

    // POST /api/v1/auth/login -> signed JWT access_token
    const login = await bt.fetch({
      method: 'POST',
      path: '/api/v1/auth/login',
      query: '',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'admin@pit.software', password: 'ChangeMe!2026' }),
    });
    expect(login.status).toBe(200);
    const loginJson = JSON.parse(dec.decode(login.body));
    expect(typeof loginJson.access_token).toBe('string');
    expect(loginJson.access_token.split('.').length).toBe(3);

    // GET /api/v1/auth/me with Bearer JWT
    const me = await bt.fetch({
      method: 'GET',
      path: '/api/v1/auth/me',
      query: '',
      headers: { authorization: `Bearer ${loginJson.access_token}` },
    });
    expect(me.status).toBe(200);
    const meJson = JSON.parse(dec.decode(me.body));
    expect(meJson.user.email).toBe('admin@pit.software');
    expect(meJson.sites.length).toBeGreaterThanOrEqual(1);

    // GET /api/v1/sites with Bearer JWT
    const sites = await bt.fetch({
      method: 'GET',
      path: '/api/v1/sites',
      query: '',
      headers: { authorization: `Bearer ${loginJson.access_token}` },
    });
    expect(sites.status).toBe(200);
    const sitesJson = JSON.parse(dec.decode(sites.body));
    const list = Array.isArray(sitesJson) ? sitesJson : sitesJson.sites ?? sitesJson.items ?? sitesJson.data ?? [];
    expect(list.length).toBeGreaterThanOrEqual(1);
    const siteId = Number(list[0].id ?? 1);

    // 3. Real full-duplex Axum WebSocket + Simulation start/tick/stop!
    const ticketResp = await bt.fetch({
      method: 'POST',
      path: '/api/v1/ws/ticket',
      query: '',
      headers: { authorization: `Bearer ${loginJson.access_token}` },
    });
    expect(ticketResp.status).toBe(200);
    const ticketJson = JSON.parse(dec.decode(ticketResp.body));
    expect(typeof ticketJson.ticket).toBe('string');

    const wsMessages: Array<Record<string, unknown>> = [];
    let wsOpened = false;
    const wsHandle = bt.openWebSocket!(
      `/api/v1/ws?ticket=${encodeURIComponent(ticketJson.ticket)}&site_id=${siteId}`,
      [],
      (ev) => {
        if (ev.type === 'open') wsOpened = true;
        if (ev.type === 'message' && typeof ev.data === 'string') {
          try { wsMessages.push(JSON.parse(ev.data)); } catch { /* ignore */ }
        }
      }
    );
    await flushAsync(80);
    expect(wsOpened).toBe(true);
    expect(wsMessages.some((m) => m.kind === 'hello')).toBe(true);

    // Heartbeat ping -> pong over virtual Axum WebSocket
    wsHandle.send(JSON.stringify({ type: 'ping' }));
    await flushAsync(80);
    expect(wsMessages.some((m) => m.type === 'pong')).toBe(true);

    // POST /api/v1/simulate/start -> clones pit.db -> pit-sim.db + spawns live tokio interval!
    const simStart = await bt.fetch({
      method: 'POST',
      path: '/api/v1/simulate/start',
      query: '',
      headers: {
        authorization: `Bearer ${loginJson.access_token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ site_id: siteId, interval_ms: 1000 }),
    });
    expect(simStart.status).toBe(200);
    const simStartJson = JSON.parse(dec.decode(simStart.body));
    expect(simStartJson.ok).toBe(true);
    expect(wsMessages.some((m) => m.type === 'sim' && (m.data as Record<string, unknown>)?.running === true)).toBe(true);

    const posCountBefore = wsMessages.filter((m) => m.type === 'position').length;
    expect(posCountBefore).toBeGreaterThanOrEqual(1);

    // Wait for cooperative background tokio::time::interval tick to fire live!
    await flushAsync(1250);
    const posCountAfter = wsMessages.filter((m) => m.type === 'position').length;
    expect(posCountAfter).toBeGreaterThan(posCountBefore);

    // POST /api/v1/simulate/stop -> aborts background interval + cleans up pit-sim.db
    const simStop = await bt.fetch({
      method: 'POST',
      path: '/api/v1/simulate/stop',
      query: '',
      headers: {
        authorization: `Bearer ${loginJson.access_token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ site_id: siteId }),
    });
    expect(simStop.status).toBe(200);
    const simStopJson = JSON.parse(dec.decode(simStop.body));
    expect(simStopJson.ok).toBe(true);
    expect(simStopJson.aborted).toBe(true);

    wsHandle.close(1000, 'done');

    // Virtual folder browser can inspect the archive tree
    const rootDirs = handle.listVirtualDirectory('').map((e) => e.name);
    expect(rootDirs).toContain('app');
    expect(rootDirs).toContain('server');

    handle.dispose();
  }, 90_000);
});
