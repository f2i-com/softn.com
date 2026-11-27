#!/usr/bin/env node
/**
 * Local interactive test server for SoftN's App-Builder Platform & Full-Stack CRUD Profile.
 *
 * Serves:
 *   - http://127.0.0.1:4840/                         (Interactive Demo Shell)
 *   - http://127.0.0.1:4840/bundles/fullstack-crud.softn  (Live zipped examples/fullstack-crud/)
 *   - http://127.0.0.1:4840/bundles/app-factory.softn     (Interactive softn:sqlite/bundle/files/apps/runtime sandbox)
 *   - http://127.0.0.1:4840/runtime/*                (Built @softn/container runtime + Brotli WASM engines)
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync, strToU8 } from 'fflate';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(DIR, '..', '..');
const RUNTIME_DIR = path.join(REPO_ROOT, 'packages', '@softn', 'container', 'dist', 'runtime');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.softn': 'application/zip',
  '.map': 'application/json',
};

function zipDirectory(dir, prefix = '') {
  const out = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      Object.assign(out, zipDirectory(full, rel));
    } else if (
      entry.isFile() &&
      entry.name !== 'README.md' &&
      entry.name !== 'serve.mjs' &&
      entry.name !== 'playground.html'
    ) {
      out[rel] = new Uint8Array(fs.readFileSync(full));
    }
  }
  return out;
}

function buildFullstackCrudBundle() {
  return zipSync(zipDirectory(DIR), { level: 6 });
}

function buildAppFactoryBundle() {
  const indexHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>SoftN App Factory Playground</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; padding: 16px; background: #0f172a; color: #e2e8f0; font-family: system-ui, sans-serif; }
    .grid { display: grid; gap: 14px; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 10px; padding: 14px; }
    h2 { margin: 0 0 8px; font-size: 1rem; color: #f8fafc; }
    p.hint { margin: 0 0 10px; color: #94a3b8; font-size: 0.85rem; }
    .row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    button { padding: 8px 12px; border-radius: 7px; border: 1px solid #3b82f6; background: #2563eb; color: #fff; font-weight: 600; cursor: pointer; font-size: 0.85rem; }
    button.secondary { background: #0f172a; border-color: #475569; color: #e2e8f0; }
    button.emerald { background: #059669; border-color: #10b981; }
    button.amber { background: #d97706; border-color: #f59e0b; }
    button:disabled { opacity: 0.45; cursor: not-allowed; }
    pre { margin: 10px 0 0; padding: 10px; background: #020617; border: 1px solid #1e293b; border-radius: 7px; overflow: auto; max-height: 220px; font-size: 0.78rem; color: #a5f3fc; }
    #preview-slot { margin-top: 10px; border: 1px dashed #475569; border-radius: 8px; min-height: 240px; overflow: hidden; background: #020617; }
    .status { font-size: 0.82rem; color: #34d399; margin-top: 6px; }
    .err { color: #f87171; }
  </style>
</head>
<body>
  <div class="grid">
    <div class="card">
      <h2>1. Live Runtime Capability Discovery (<code>softn:runtime</code>)</h2>
      <div class="row">
        <button id="btn-caps" type="button">Inspect Capabilities & Limits</button>
      </div>
      <pre id="caps-log">Click to query runtime.capabilities()...</pre>
    </div>

    <div class="card">
      <h2>2. Isolated SQLite Workspace, Lossless 64-bit Transport & Schema Introspection (<code>softn:sqlite</code> + <code>softn:files</code>)</h2>
      <p class="hint">Creates a temporary workspace, inserts signed 64-bit integers (<code>9007199254740993</code>, <code>-9223372036854775808</code>), decimals & BLOBs — or pick your own <code>.db</code>/<code>.sqlite</code> file via chunked <code>softn:files</code>.</p>
      <div class="row">
        <button id="btn-sample-db" type="button">Create Sample SQLite DB & Migrate</button>
        <button id="btn-pick-db" class="secondary" type="button">Pick Local .sqlite / .db File (Chunked)</button>
        <button id="btn-export-db" class="secondary" type="button" disabled>Export Migrated .db Snapshot</button>
      </div>
      <div id="db-status" class="status"></div>
      <pre id="db-log">Waiting...</pre>
    </div>

    <div class="card">
      <h2>3. Dynamic <code>.softn</code> Packaging, Live Nested Preview & Host Deployment (<code>softn:bundle</code> + <code>softn:apps</code>)</h2>
      <p class="hint">Packages the migrated SQLite DB + React TSX frontend + PHP API backend into a validated <code>.softn</code> bundle, then previews it live in an isolated non-persistent nested container or offers it to the host.</p>
      <div class="row">
        <button id="btn-build" class="emerald" type="button" disabled>Build .softn Bundle</button>
        <button id="btn-preview" type="button" disabled>Mount Live Preview</button>
        <button id="btn-dispose-preview" class="secondary" type="button" disabled>Dispose Preview</button>
        <button id="btn-download" class="secondary" type="button" disabled>Download .softn</button>
        <button id="btn-offer" class="amber" type="button" disabled>Offer to Host (FormLogic)</button>
      </div>
      <div id="bundle-status" class="status"></div>
      <pre id="bundle-log">Build a database in Step 2 first...</pre>
      <div id="preview-slot"></div>
    </div>
  </div>

  <script type="module" src="/app.js"></script>
</body>
</html>`;

  const appJs = `
import { runtime } from 'softn:runtime';
import { files } from 'softn:files';
import { sqlite } from 'softn:sqlite';
import { bundle } from 'softn:bundle';
import { apps } from 'softn:apps';

let migratedDbBytes = null;
let migratedSchema = null;
let builtArtifact = null;
let activePreview = null;

const $ = (id) => document.getElementById(id);

function setStatus(id, msg, isErr = false) {
  const el = $(id);
  el.textContent = msg;
  el.className = isErr ? 'status err' : 'status';
}

async function refreshCaps() {
  const caps = await runtime.capabilities();
  $('caps-log').textContent = JSON.stringify(caps, null, 2);
}

$('btn-caps').addEventListener('click', () => {
  refreshCaps().catch((e) => { $('caps-log').textContent = 'Error: ' + e.message; });
});

async function runSampleMigration() {
  setStatus('db-status', 'Running isolated temporary SQLite workspace...');
  const ws = await sqlite.createWorkspace({ maxDatabases: 4 });
  try {
    const src = await ws.create();
    await src.execute(\`
      CREATE TABLE products (
        id INTEGER PRIMARY KEY,
        sku TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        unit_price TEXT NOT NULL,
        raw_tag BLOB
      )
    \`);
    await src.transaction(async (tx) => {
      await tx.execute(
        'INSERT INTO products (id, sku, name, unit_price, raw_tag) VALUES (?, ?, ?, ?, ?)',
        [sqlite.sqlInt('9007199254740993'), 'SKU-A1', 'Solar Inverter 5kW', sqlite.sqlDecimal('1899.9500'), sqlite.sqlBlob('deadbeef')]
      );
      await tx.execute(
        'INSERT INTO products (id, sku, name, unit_price, raw_tag) VALUES (?, ?, ?, ?, ?)',
        [sqlite.sqlInt('-9223372036854775808'), 'SKU-B2', 'LiFePO4 Battery 10kWh', sqlite.sqlDecimal('4250.0000'), sqlite.sqlBlob('cafebabe')]
      );
      await tx.execute(
        'INSERT INTO products (id, sku, name, unit_price, raw_tag) VALUES (?, ?, ?, ?, ?)',
        [sqlite.sqlInt('9223372036854775807'), 'SKU-C3', 'Smart MPPT Controller', sqlite.sqlDecimal('499.5000'), null]
      );
    });

    const srcBytes = await src.exportBytes();
    const ro = await ws.import(srcBytes, { readOnly: true });
    let roEnforced = false;
    try { await ro.execute('DELETE FROM products'); } catch { roEnforced = true; }

    const rows = await ro.all('SELECT id, sku, name, unit_price, raw_tag FROM products ORDER BY sku');
    const target = await ws.create();
    await target.execute('CREATE TABLE products (id TEXT PRIMARY KEY, sku TEXT NOT NULL UNIQUE, name TEXT NOT NULL, unit_price TEXT NOT NULL)');
    await target.transaction(async (tx) => {
      for (const r of rows) {
        const exactId = r.id && typeof r.id === 'object' && r.id.type === 'integer' ? r.id.value : String(r.id);
        await tx.execute('INSERT INTO products (id, sku, name, unit_price) VALUES (?, ?, ?, ?)', [exactId, r.sku, r.name, r.unit_price]);
      }
    });

    const integrity = await target.integrityCheck();
    migratedSchema = await target.getSchema();
    const snap = await target.exportSnapshot({ consistency: 'committed' });
    migratedDbBytes = snap.bytes;

    $('db-log').textContent = JSON.stringify({
      readOnlySourceEnforced: roEnforced,
      losslessSourceRows: rows,
      integrityCheck: integrity,
      snapshot: { byteLength: snap.byteLength, checksum: snap.checksum, pageSize: snap.pageSize, pageCount: snap.pageCount },
      tables: migratedSchema.tables.map((t) => ({ name: t.name, columns: t.columns.map((c) => c.name + ':' + c.type) })),
    }, null, 2);

    $('btn-export-db').disabled = false;
    $('btn-build').disabled = false;
    setStatus('db-status', 'Workspace migrated & disposed cleanly (' + snap.byteLength + ' bytes).');
  } finally {
    await ws.dispose();
  }
}

$('btn-sample-db').addEventListener('click', () => {
  runSampleMigration().catch((e) => setStatus('db-status', 'Error: ' + e.message, true));
});

$('btn-pick-db').addEventListener('click', async () => {
  try {
    setStatus('db-status', 'Opening host file chooser...');
    const picked = await files.pick({ accept: ['.db', '.sqlite', '.sqlite3'] });
    if (!picked) {
      setStatus('db-status', 'File selection cancelled.');
      return;
    }
    const chunks = [];
    let chunkCount = 0;
    for await (const ch of picked.chunks({
      chunkSize: 256 * 1024,
      onProgress: (p) => setStatus('db-status', 'Reading ' + picked.name + ': ' + p.percent + '% (' + p.loaded + '/' + p.total + ' bytes)'),
    })) {
      chunks.push(ch);
      chunkCount++;
    }
    await picked.close();
    const total = chunks.reduce((s, c) => s + c.byteLength, 0);
    const bytes = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { bytes.set(c, off); off += c.byteLength; }

    const ws = await sqlite.createWorkspace();
    try {
      const ro = await ws.import(bytes, { readOnly: true });
      const schema = await ro.getSchema();
      const ic = await ro.integrityCheck({ checkForeignKeys: true });
      const firstTable = schema.tables[0];
      const previewRows = firstTable
        ? await ro.all('SELECT * FROM "' + firstTable.name.replace(/"/g, '""') + '" LIMIT 5')
        : [];
      migratedDbBytes = bytes;
      migratedSchema = schema;
      $('db-log').textContent = JSON.stringify({
        file: { name: picked.name, size: picked.size, chunksRead: chunkCount },
        integrityCheck: ic,
        tables: schema.tables.map((t) => ({ name: t.name, columns: t.columns.length, foreignKeys: t.foreignKeys })),
        sampleRows: previewRows,
      }, null, 2);
      $('btn-export-db').disabled = false;
      $('btn-build').disabled = false;
      setStatus('db-status', 'Imported ' + picked.name + ' (' + schema.tables.length + ' tables).');
    } finally {
      await ws.dispose();
    }
  } catch (e) {
    setStatus('db-status', 'Error: ' + e.message, true);
  }
});

$('btn-export-db').addEventListener('click', async () => {
  if (!migratedDbBytes) return;
  try {
    const w = await files.createWriter({ name: 'migrated-snapshot.db', type: 'application/x-sqlite3' });
    await w.write(migratedDbBytes);
    const res = await w.close();
    setStatus('db-status', res.saved ? 'Saved ' + res.name + ' (' + res.size + ' bytes, sha256=' + res.sha256.slice(0, 12) + '...)' : 'Export cancelled.');
  } catch (e) {
    setStatus('db-status', 'Error: ' + e.message, true);
  }
});

$('btn-build').addEventListener('click', async () => {
  if (!migratedDbBytes) return;
  try {
    setStatus('bundle-status', 'Packaging generated React TSX + PHP + SQLite .softn bundle...');
    if (builtArtifact) {
      await builtArtifact.dispose();
      builtArtifact = null;
    }
    const tableName = (migratedSchema && migratedSchema.tables[0] && migratedSchema.tables[0].name) || 'products';
    const safeTable = tableName.replace(/[^a-zA-Z0-9_]/g, '');

    const b = bundle.create({
      manifest: {
        engine: 2,
        id: 'generated-' + (safeTable || 'app'),
        name: 'Generated ' + (safeTable || 'Data') + ' Explorer',
        version: '1.0.0',
        frontendRoot: 'public',
        main: 'public/index.html',
        backend: {
          runtime: 'php',
          mode: 'api',
          entry: 'backend/index.php',
          routes: ['/api/'],
          phpMode: 'sapi',
        },
        databases: [
          { name: 'app', engine: 'sqlite', file: 'db/app.db', schemaVersion: 1, persist: true },
        ],
      },
      permissions: { permissions: {} },
    });

    const genHtml = '<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;padding:14px;background:#090d16;color:#e2e8f0;font-family:system-ui,sans-serif}table{width:100%;border-collapse:collapse;font-size:13px}th,td{padding:6px 8px;border-bottom:1px solid #1e293b;text-align:left}button{padding:6px 10px;border-radius:6px;border:1px solid #10b981;background:#059669;color:#fff;cursor:pointer}input{padding:6px;border-radius:6px;border:1px solid #334155;background:#0f172a;color:#fff;margin-right:6px}</style></head><body><div id="root"></div><script type="module" src="/app.tsx"></' + 'script></body></html>';

    const genTsx = \`
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

function GeneratedApp() {
  const [rows, setRows] = useState<Array<Record<string, unknown>>>([]);
  const [table, setTable] = useState<string>('');
  const [name, setName] = useState<string>('');
  const [price, setPrice] = useState<string>('299.0000');
  const [status, setStatus] = useState<string>('Loading from embedded PHP + SQLite backend...');

  const load = async () => {
    const res = await fetch('/api/records');
    const data = await res.json();
    setTable(data.table || '');
    setRows(data.rows || []);
    setStatus('Loaded ' + (data.rows || []).length + ' row(s) from table "' + (data.table || '') + '"');
  };

  useEffect(() => { void load(); }, []);

  const addProduct = async () => {
    if (!name.trim()) return;
    await fetch('/api/records', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: name.trim(), unit_price: price.trim() || '0.00' }),
    });
    setName('');
    await load();
  };

  const cols = rows.length > 0 ? Object.keys(rows[0]) : [];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <strong>Live Nested Preview — Table: {table || '...'}</strong>
        <span style={{ fontSize: 12, color: '#34d399' }}>{status}</span>
      </div>
      {table === 'products' ? (
        <div style={{ marginBottom: 10 }}>
          <input placeholder="New product name" value={name} onChange={(e: any) => setName(e.target.value)} />
          <input placeholder="Price" value={price} onChange={(e: any) => setPrice(e.target.value)} />
          <button type="button" onClick={addProduct}>+ Insert via PHP API</button>
        </div>
      ) : null}
      <table>
        <thead>
          <tr>{cols.map((c) => <th key={c}>{c}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>{cols.map((c) => <td key={c}>{r[c] == null ? 'NULL' : String(r[c])}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<GeneratedApp />);
\`;

    const genPhp = \`<?php
$pdo = new PDO('sqlite:db/app.db');
$pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$method = $_SERVER['REQUEST_METHOD'];
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$table = \${JSON.stringify(safeTable || 'products')};
header('Content-Type: application/json');
if ($method === 'GET' && $path === '/api/records') {
  $rows = $pdo->query('SELECT * FROM "' . $table . '" LIMIT 50')->fetchAll(PDO::FETCH_ASSOC);
  echo json_encode(['table' => $table, 'rows' => $rows]);
  exit;
}
if ($method === 'POST' && $path === '/api/records' && $table === 'products') {
  $body = json_decode(file_get_contents('php://input'), true);
  $id = '900719925474' . (string) rand(1000, 9999);
  $sku = 'SKU-' . rand(100, 999);
  $stmt = $pdo->prepare('INSERT INTO products (id, sku, name, unit_price) VALUES (?, ?, ?, ?)');
  $stmt->execute([$id, $sku, $body['name'], $body['unit_price']]);
  http_response_code(201);
  echo json_encode(['created' => true, 'id' => $id]);
  exit;
}
http_response_code(404);
echo json_encode(['error' => 'Not found']);
\`;

    b.addBinary('db/app.db', migratedDbBytes)
      .addText('public/index.html', genHtml)
      .addText('public/app.tsx', genTsx)
      .addText('backend/index.php', genPhp);

    const validation = await b.validate();
    builtArtifact = await b.build({ strict: true });

    $('bundle-log').textContent = JSON.stringify({
      valid: validation.valid,
      size: builtArtifact.size,
      fileCount: builtArtifact.fileCount,
      sha256: builtArtifact.sha256,
      manifest: builtArtifact.manifest,
    }, null, 2);

    $('btn-preview').disabled = false;
    $('btn-download').disabled = false;
    $('btn-offer').disabled = false;
    setStatus('bundle-status', 'Built validated .softn bundle (' + builtArtifact.size + ' bytes).');
  } catch (e) {
    setStatus('bundle-status', 'Error: ' + e.message, true);
  }
});

$('btn-preview').addEventListener('click', async () => {
  if (!builtArtifact) return;
  try {
    setStatus('bundle-status', 'Mounting isolated nested preview...');
    if (activePreview) {
      await activePreview.dispose();
      activePreview = null;
    }
    activePreview = await apps.preview({
      artifact: builtArtifact,
      target: $('preview-slot'),
    });
    $('btn-dispose-preview').disabled = false;
    setStatus('bundle-status', 'Nested preview active (' + activePreview.artifactId + ') — temporary storage, deployment stripped.');
  } catch (e) {
    setStatus('bundle-status', 'Error: ' + e.message, true);
  }
});

$('btn-dispose-preview').addEventListener('click', async () => {
  if (!activePreview) return;
  await activePreview.dispose();
  activePreview = null;
  $('btn-dispose-preview').disabled = true;
  setStatus('bundle-status', 'Preview disposed and artifact cleaned up.');
});

$('btn-download').addEventListener('click', async () => {
  if (!builtArtifact) return;
  try {
    const res = await builtArtifact.download('generated-app.softn');
    setStatus('bundle-status', res.saved ? 'Saved ' + res.name + ' (' + res.size + ' bytes).' : 'Download cancelled by user.');
  } catch (e) {
    setStatus('bundle-status', 'Error: ' + e.message, true);
  }
});

$('btn-offer').addEventListener('click', async () => {
  if (!builtArtifact) return;
  try {
    setStatus('bundle-status', 'Offering binary .softn bundle to host confirmation dialog...');
    const res = await apps.offerToHost({
      artifact: builtArtifact,
      name: (builtArtifact.manifest && builtArtifact.manifest.name) || 'Generated App',
      operation: 'create',
    });
    setStatus('bundle-status', 'Host response: ' + JSON.stringify(res));
  } catch (e) {
    setStatus('bundle-status', 'Error: ' + e.message, true);
  }
});

refreshCaps().catch(() => {});
`;

  return zipSync(
    {
      'manifest.json': strToU8(
        JSON.stringify(
          {
            engine: 2,
            id: 'softn-app-factory-playground',
            name: 'SoftN App Factory Playground',
            version: '1.0.0',
            main: 'index.html',
          },
          null,
          2
        )
      ),
      'permission.json': strToU8(
        JSON.stringify(
          {
            permissions: {
              files: { enabled: true },
              'sqlite-workspace': { enabled: true },
              'app-preview': { enabled: true },
              'app-deploy': { enabled: true },
            },
          },
          null,
          2
        )
      ),
      'index.html': strToU8(indexHtml),
      'app.js': strToU8(appJs),
    },
    { level: 6 }
  );
}

const port = Number(process.env.DEMO_PORT) || 4840;

const server = http.createServer((req, res) => {
  const urlPath = (req.url || '/').split('?')[0];

  if (urlPath === '/' || urlPath === '/index.html') {
    const html = fs.readFileSync(path.join(DIR, 'playground.html'));
    res.writeHead(200, { 'Content-Type': MIME['.html'], 'Content-Length': html.byteLength, 'Cache-Control': 'no-cache' });
    res.end(html);
    return;
  }

  if (urlPath === '/bundles/fullstack-crud.softn') {
    const bytes = buildFullstackCrudBundle();
    res.writeHead(200, { 'Content-Type': MIME['.softn'], 'Content-Length': bytes.byteLength, 'Cache-Control': 'no-cache' });
    res.end(bytes);
    return;
  }

  if (urlPath === '/bundles/app-factory.softn') {
    const bytes = buildAppFactoryBundle();
    res.writeHead(200, { 'Content-Type': MIME['.softn'], 'Content-Length': bytes.byteLength, 'Cache-Control': 'no-cache' });
    res.end(bytes);
    return;
  }

  if (urlPath.startsWith('/runtime/')) {
    const rel = path.normalize(urlPath.slice('/runtime/'.length));
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    const filePath = path.join(RUNTIME_DIR, rel);
    const ext = path.extname(filePath).toLowerCase();
    const acceptsBr = /\bbr\b/.test(req.headers['accept-encoding'] || '');
    if (ext === '.wasm' && acceptsBr && fs.existsSync(`${filePath}.br`)) {
      const brBytes = fs.readFileSync(`${filePath}.br`);
      res.writeHead(200, {
        'Content-Type': 'application/wasm',
        'Content-Encoding': 'br',
        'Content-Length': brBytes.byteLength,
        'Cache-Control': 'no-cache',
      });
      res.end(brBytes);
      return;
    }
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404).end('Not found');
      return;
    }
    const bytes = fs.readFileSync(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': bytes.byteLength,
      'Cache-Control': 'no-cache',
    });
    res.end(bytes);
    return;
  }

  res.writeHead(404).end('Not found');
});

server.listen(port, '127.0.0.1', () => {
  // eslint-disable-next-line no-console
  console.log(`SoftN App-Builder Platform & CRUD Demo listening at http://127.0.0.1:${port}/`);
});
