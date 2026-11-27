import { describe, it, expect, beforeEach } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  XdbSqlManager,
  loadXdbWasm,
  mountSoftNContainer,
  sqlInt,
  sqlDecimal,
  type AppDeploymentOffer,
  type HostPickedFile,
  type SaveRequest,
} from '../src/index';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINES_DIR = path.join(PKG_ROOT, 'dist', 'runtime', 'engines');
const LITE_WASM = path.join(ENGINES_DIR, 'zipp-javascript-lite.wasm');
const TS_WASM = path.join(ENGINES_DIR, 'zipp-typescript.wasm');
const PHP_WASM = path.join(ENGINES_DIR, 'zipp-php.wasm');
const XDB_WASM = path.join(ENGINES_DIR, 'xdb-wasm.wasm');
const XDB_GLUE = path.join(ENGINES_DIR, 'xdb-wasm.glue.js');

function flushAsync(ms = 120): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForText(
  root: ShadowRoot,
  selector: string,
  predicate: (text: string) => boolean,
  timeoutMs = 15_000
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const txt = root.querySelector(selector)?.textContent ?? '';
    if (predicate(txt)) return txt;
    await flushAsync(40);
  }
  throw new Error(`Timed out waiting for ${selector}; last value="${root.querySelector(selector)?.textContent ?? ''}"`);
}

describe('SoftN App Factory End-to-End Platform (softn:bundle, softn:files, softn:apps, softn:runtime)', () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
  });

  it('executes the complete 12-step Application Factory acceptance workflow (import SQLite -> workspace migration -> generate React/TSX + PHP .softn -> preview -> export -> standalone CRUD + persistence -> FormLogic offer -> v1->v2 upgrade)', async () => {
    // Prepare a real source SQLite binary containing 64-bit integer IDs and decimal prices
    const xdb = await loadXdbWasm({ explicitSource: XDB_WASM, glueUrl: XDB_GLUE });
    const seedMgr = new XdbSqlManager({ bindings: xdb, databases: [] });
    const seedWs = seedMgr.createWorkspace();
    if ('error' in seedWs) throw new Error(seedWs.error);
    const seedDb = seedMgr.createDatabase({ workspaceId: seedWs.id, temporary: true });
    if ('error' in seedDb) throw new Error(seedDb.error);
    seedMgr.execute(
      seedDb.id,
      `CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT NOT NULL, unit_price TEXT NOT NULL);
       INSERT INTO products (id, name, unit_price) VALUES (?, ?, ?);
       INSERT INTO products (id, name, unit_price) VALUES (?, ?, ?);`,
      JSON.stringify([
        sqlInt('9007199254740993'),
        'Solar Inverter',
        sqlDecimal('1899.9500'),
        sqlInt('9007199254740994'),
        'Battery Pack',
        sqlDecimal('4250.0000'),
      ])
    );
    const exportedSeed = seedMgr.exportBytesByHandle(seedDb.id);
    if ('error' in exportedSeed) throw new Error(exportedSeed.error);
    const sourceDbBytes = exportedSeed.bytes;
    seedMgr.dispose();

    const savedFiles: SaveRequest[] = [];
    const offeredApps: AppDeploymentOffer[] = [];
    let progressCallbacks = 0;

    // Parent "App Factory" SoftN application (general-purpose builder app)
    const factoryAppZip = zipSync({
      'manifest.json': strToU8(
        JSON.stringify({
          engine: 2,
          id: 'softn-app-factory-test',
          name: 'App Factory Test',
          version: '1.0.0',
          main: 'index.html',
        })
      ),
      'permission.json': strToU8(
        JSON.stringify({
          permissions: {
            files: { enabled: true },
            'sqlite-workspace': { enabled: true },
            'app-preview': { enabled: true },
            'app-deploy': { enabled: true },
          },
        })
      ),
      'index.html': strToU8(`<!doctype html>
<html><body>
  <div id="caps-out">pending</div>
  <div id="file-out">pending</div>
  <div id="preview-box" style="min-height:120px"></div>
  <div id="preview-out">pending</div>
  <div id="download-out">pending</div>
  <div id="offer-out">pending</div>
  <div id="done-out">pending</div>
  <script type="module">
    import { runtime } from 'softn:runtime';
    import { files } from 'softn:files';
    import { sqlite } from 'softn:sqlite';
    import { bundle } from 'softn:bundle';
    import { apps } from 'softn:apps';

    async function run() {
      // 1. Runtime capability discovery
      const caps = await runtime.capabilities();
      document.getElementById('caps-out').textContent = JSON.stringify({
        host: caps.host,
        sqliteImport: caps.capabilities.sqliteImport,
        bundleGeneration: caps.capabilities.bundleGeneration,
        dynamicAppPreview: caps.capabilities.dynamicAppPreview,
        applicationDeployment: caps.capabilities.applicationDeployment,
        chunkedFiles: caps.capabilities.chunkedFiles,
      });

      // 2. Chunked file pick with size inspection before reading + progress tracking
      const picked = await files.pick({ accept: ['.db', '.sqlite'] });
      let chunksSeen = 0;
      const chunks = [];
      for await (const chunk of picked.chunks({
        chunkSize: 4096,
        onProgress: () => { chunksSeen++; },
      })) {
        chunks.push(chunk);
      }
      const totalLen = chunks.reduce((n, c) => n + c.byteLength, 0);
      const uploadedBytes = new Uint8Array(totalLen);
      let off = 0;
      for (const c of chunks) { uploadedBytes.set(c, off); off += c.byteLength; }
      await picked.close();
      document.getElementById('file-out').textContent = picked.name + ':' + picked.size + ':chunks=' + chunksSeen;

      // 3. Isolated temporary workspace: read-only source + fresh target + lossless 64-bit copy + integrity check
      const ws = await sqlite.createWorkspace();
      const source = await ws.import(uploadedBytes, { readOnly: true });
      const schema = await source.getSchema();
      const target = await ws.create();
      await target.execute('CREATE TABLE products (id TEXT PRIMARY KEY, name TEXT NOT NULL, unit_price TEXT NOT NULL)');
      const srcRows = await source.all('SELECT id, name, unit_price FROM products ORDER BY id');
      await target.transaction(async (tx) => {
        for (const r of srcRows) {
          const exactId = typeof r.id === 'object' && r.id && r.id.type === 'integer' ? r.id.value : String(r.id);
          await tx.execute('INSERT INTO products (id, name, unit_price) VALUES (?, ?, ?)', [exactId, r.name, r.unit_price]);
        }
      });
      const integrity = await target.integrityCheck();
      if (!integrity.ok) throw new Error('Target SQLite integrity check failed');
      const targetDbBytes = await target.exportBytes();
      await ws.dispose();

      // 4. Dynamically package a generated React/TSX + PHP Slim + SQLite SoftN v2 bundle
      const builder = bundle.create({
        manifest: {
          engine: 2,
          id: 'generated-products-app',
          name: 'Generated Products App',
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
            {
              name: 'app',
              engine: 'sqlite',
              file: 'db/app.db',
              schemaVersion: 1,
              persist: true,
            },
          ],
        },
        permissions: { permissions: {} },
      });

      builder
        .addBinary('db/app.db', targetDbBytes)
        .addText('public/index.html', '<!doctype html><html><body><div id="root"></div><script type="module" src="/app.tsx"><\\/script></body></html>')
        .addText('public/app.tsx', [
          "import { useEffect, useState } from 'react';",
          "import { createRoot } from 'react-dom/client';",
          "interface Product { id: string; name: string; unit_price: string; }",
          "function App() {",
          "  const [items, setItems] = useState<Product[]>([]);",
          "  const [deployBlocked, setDeployBlocked] = useState<string>('pending');",
          "  useEffect(() => {",
          "    fetch('/api/products').then((r) => r.json()).then((d) => setItems(d.items || []));",
          "    import('softn:apps').then(({ apps }) => apps.offerToHost({ artifact: new Uint8Array([1,2,3]), name: 'Escape' })).then(",
          "      () => setDeployBlocked('ALLOWED'),",
          "      (e) => setDeployBlocked('DENIED:' + e.message)",
          "    );",
          "  }, []);",
          "  return (",
          "    <div>",
          "      <h2 id='gen-title'>Generated Products ({items.length})</h2>",
          "      <div id='preview-deploy-check'>{deployBlocked}</div>",
          "      <ul id='gen-list'>{items.map((p) => <li key={p.id}>{p.id}:{p.name}:{p.unit_price}</li>)}</ul>",
          "    </div>",
          "  );",
          "}",
          "createRoot(document.getElementById('root')!).render(<App />);",
        ].join('\\n'))
        .addText('backend/index.php', [
          '<?php',
          '$pdo = new PDO("sqlite:db/app.db");',
          '$pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);',
          '$method = $_SERVER["REQUEST_METHOD"];',
          '$path = parse_url($_SERVER["REQUEST_URI"], PHP_URL_PATH);',
          'header("Content-Type: application/json");',
          'if ($method === "GET" && $path === "/api/products") {',
          '  $rows = $pdo->query("SELECT id, name, unit_price FROM products ORDER BY id")->fetchAll(PDO::FETCH_ASSOC);',
          '  echo json_encode(["items" => $rows]);',
          '  exit;',
          '}',
          'if ($method === "POST" && $path === "/api/products") {',
          '  $body = json_decode(file_get_contents("php://input"), true);',
          '  $stmt = $pdo->prepare("INSERT INTO products (id, name, unit_price) VALUES (?, ?, ?)");',
          '  $stmt->execute([$body["id"], $body["name"], $body["unit_price"]]);',
          '  http_response_code(201);',
          '  echo json_encode(["created" => true, "id" => $body["id"]]);',
          '  exit;',
          '}',
          'if ($method === "PATCH" && preg_match("#^/api/products/([^/]+)$#", $path, $m)) {',
          '  $body = json_decode(file_get_contents("php://input"), true);',
          '  $stmt = $pdo->prepare("UPDATE products SET name = ?, unit_price = ? WHERE id = ?");',
          '  $stmt->execute([$body["name"], $body["unit_price"], $m[1]]);',
          '  echo json_encode(["updated" => true]);',
          '  exit;',
          '}',
          'if ($method === "DELETE" && preg_match("#^/api/products/([^/]+)$#", $path, $m)) {',
          '  $stmt = $pdo->prepare("DELETE FROM products WHERE id = ?");',
          '  $stmt->execute([$m[1]]);',
          '  echo json_encode(["deleted" => true]);',
          '  exit;',
          '}',
          'http_response_code(404);',
          'echo json_encode(["error" => "Not found"]);',
        ].join('\\n'));

      const validation = await builder.validate();
      if (!validation.valid) throw new Error('Bundle invalid: ' + validation.errors.join(', '));
      const built = await builder.build({ strict: true });

      // 5. Dynamically preview generated app inside parent container (isolated, temporary, deployment stripped!)
      const preview = await apps.preview({
        artifact: built,
        target: document.getElementById('preview-box'),
      });
      await new Promise((r) => setTimeout(r, 250));
      document.getElementById('preview-out').textContent = 'preview=' + preview.id + '|tables=' + schema.tables.length;

      // 6. Export .softn bundle via explicit save confirmation
      const dl = await built.download('generated-products.softn');
      document.getElementById('download-out').textContent = dl.saved + ':' + dl.name + ':' + dl.size;

      // 7. Offer binary .softn bundle to host (FormLogic deployment bridge)
      const offerRes = await apps.offerToHost({
        artifact: built,
        name: 'Generated Products App',
        operation: 'create',
      });
      document.getElementById('offer-out').textContent = offerRes.status + ':' + (offerRes.appId || '');

      await preview.dispose();
      await built.dispose();
      document.getElementById('done-out').textContent = 'COMPLETE';
    }
    run().catch((err) => {
      document.getElementById('done-out').textContent = 'ERROR:' + (err && err.message ? err.message : String(err));
    });
  </script>
</body></html>`),
    });

    const host = document.createElement('div');
    document.body.appendChild(host);

    const factoryHandle = await mountSoftNContainer(host, {
      source: factoryAppZip,
      appId: 'test-app-factory',
      hostName: 'formlogic',
      isolation: 'inline',
      permissionMode: 'preapproved',
      engineWasm: { lite: LITE_WASM, typescript: TS_WASM, php: PHP_WASM },
      xdbWasm: XDB_WASM,
      xdbGlueUrl: XDB_GLUE,
      onPickFiles: async (): Promise<HostPickedFile[]> => [
        {
          name: 'source.db',
          type: 'application/x-sqlite3',
          size: sourceDbBytes.byteLength,
          lastModified: Date.now(),
          slice: async (start, end) => {
            progressCallbacks++;
            return sourceDbBytes.subarray(start, end);
          },
        },
      ],
      onSaveRequest: async (req) => {
        savedFiles.push(req);
        return true;
      },
      onOfferApp: async (offer) => {
        offeredApps.push(offer);
        return { ok: true, status: 'accepted', appId: 'fl-app-99', url: 'https://formlogic.example/apps/fl-app-99' };
      },
    });

    const doneText = await waitForText(
      factoryHandle.shadowRoot,
      '#done-out',
      (t) => t === 'COMPLETE' || t.startsWith('ERROR:'),
      25_000
    );
    expect(doneText).toBe('COMPLETE');

    // Verify capability discovery
    const caps = JSON.parse(factoryHandle.shadowRoot.querySelector('#caps-out')!.textContent!);
    expect(caps).toEqual({
      host: 'formlogic',
      sqliteImport: true,
      bundleGeneration: true,
      dynamicAppPreview: true,
      applicationDeployment: true,
      chunkedFiles: true,
    });

    // Verify chunked file pick
    expect(progressCallbacks).toBeGreaterThanOrEqual(1);
    expect(factoryHandle.shadowRoot.querySelector('#file-out')?.textContent).toContain(`source.db:${sourceDbBytes.byteLength}`);

    // Verify download confirmation captured the real .softn archive
    expect(savedFiles.length).toBe(1);
    expect(savedFiles[0].name).toBe('generated-products.softn');
    expect(savedFiles[0].size).toBeGreaterThan(200);

    // Verify FormLogic host offer captured validated binary archive + summary
    expect(offeredApps.length).toBe(1);
    expect(offeredApps[0].summary?.frontend).toBe('React / TypeScript');
    expect(offeredApps[0].summary?.backend).toBe('PHP');
    expect(offeredApps[0].summary?.database).toBe('SQLite');
    expect(offeredApps[0].sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(factoryHandle.shadowRoot.querySelector('#offer-out')?.textContent).toBe('accepted:fl-app-99');

    factoryHandle.dispose();

    // 8. Mount the EXPORTED `.softn` standalone, perform CRUD (POST/PATCH/DELETE), reload & verify persistence!
    const exportedBundle = savedFiles[0].bytes;
    const standaloneHost = document.createElement('div');
    document.body.appendChild(standaloneHost);

    const standalone = await mountSoftNContainer(standaloneHost, {
      source: exportedBundle,
      appId: 'generated-products-standalone',
      storagePrefix: 'softn-test-gen-standalone:',
      persistStorage: true,
      isolation: 'inline',
      permissionMode: 'deny',
      engineWasm: { typescript: TS_WASM, php: PHP_WASM },
      xdbWasm: XDB_WASM,
      xdbGlueUrl: XDB_GLUE,
    });

    await waitForText(standalone.shadowRoot, '#gen-title', (t) => t === 'Generated Products (2)', 15_000);
    expect(standalone.shadowRoot.querySelector('#gen-list')?.textContent).toContain('9007199254740993:Solar Inverter:1899.9500');

    // Create, update, delete via PHP backend API
    const api = standalone.backendTransport!;
    const created = await api.fetch({
      method: 'POST',
      path: '/api/products',
      query: '',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: '9007199254740999', name: 'Charge Controller', unit_price: '499.5000' }),
    });
    expect(created.status).toBe(201);

    const patched = await api.fetch({
      method: 'PATCH',
      path: '/api/products/9007199254740993',
      query: '',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Solar Inverter Pro', unit_price: '1999.9500' }),
    });
    expect(patched.status).toBe(200);

    const deleted = await api.fetch({
      method: 'DELETE',
      path: '/api/products/9007199254740994',
      query: '',
      headers: {},
    });
    expect(deleted.status).toBe(200);

    await standalone.flushDatabase();
    standalone.dispose();

    // 9. Reload standalone app -> confirm CRUD mutations survived reload!
    const reloadHost = document.createElement('div');
    document.body.appendChild(reloadHost);
    const reloaded = await mountSoftNContainer(reloadHost, {
      source: exportedBundle,
      appId: 'generated-products-standalone',
      storagePrefix: 'softn-test-gen-standalone:',
      persistStorage: true,
      isolation: 'inline',
      permissionMode: 'deny',
      engineWasm: { typescript: TS_WASM, php: PHP_WASM },
      xdbWasm: XDB_WASM,
      xdbGlueUrl: XDB_GLUE,
    });
    await waitForText(reloaded.shadowRoot, '#gen-title', (t) => t === 'Generated Products (2)', 15_000);
    const listText = reloaded.shadowRoot.querySelector('#gen-list')?.textContent ?? '';
    expect(listText).toContain('9007199254740993:Solar Inverter Pro:1999.9500');
    expect(listText).toContain('9007199254740999:Charge Controller:499.5000');
    expect(listText).not.toContain('9007199254740994');
    reloaded.dispose();
  }, 60_000);

  it('supports bounded streaming export via softn:files createWriter and enforces abort & deny-preview-deploy security', async () => {
    const saved: SaveRequest[] = [];
    const writerApp = zipSync({
      'manifest.json': strToU8(JSON.stringify({ engine: 2, name: 'Writer Test', main: 'index.html' })),
      'permission.json': strToU8(JSON.stringify({ permissions: { files: { enabled: true } } })),
      'index.html': strToU8(`<!doctype html>
<html><body>
  <div id="out">pending</div>
  <script type="module">
    import { files } from 'softn:files';
    const w = await files.createWriter({ name: 'report.bin', type: 'application/octet-stream' });
    await w.write(new Uint8Array([1, 2, 3, 4]));
    await w.write(new Uint8Array([5, 6, 7, 8]));
    const res = await w.close();
    const w2 = await files.createWriter({ name: 'cancelled.bin' });
    await w2.write('discard');
    const ab = await w2.abort();
    document.getElementById('out').textContent = res.saved + ':' + res.size + ':aborted=' + ab.aborted;
  </script>
</body></html>`),
    });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const handle = await mountSoftNContainer(host, {
      source: writerApp,
      appId: 'test-file-writer',
      isolation: 'inline',
      permissionMode: 'preapproved',
      engineWasm: { lite: LITE_WASM },
      onSaveRequest: async (req) => {
        saved.push(req);
        return true;
      },
    });

    const out = await waitForText(handle.shadowRoot, '#out', (t) => t !== 'pending');
    expect(out).toBe('true:8:aborted=true');
    expect(saved.length).toBe(1);
    expect(Array.from(saved[0].bytes)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    handle.dispose();
  }, 20_000);
});
