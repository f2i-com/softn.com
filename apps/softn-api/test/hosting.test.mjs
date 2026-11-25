/**
 * Hosting flexibility & ZIPP safe-sandbox hosted backend tests for `apps/softn-api`:
 * - `business` core category is registered in `/api/categories`
 * - Publishing & patching `hosting` (`browser` | `server` | `hybrid`), `backendUrl`, `withholdBackend`
 * - Filtering directory listings via `?hosting=browser|server|hybrid|backend` and `?cap=backend`
 * - `Pages::playConfig` emits `backendUrl` for `server`/`hybrid`, omits it for `browser` and `hybrid?mode=local`
 * - `withholdBackend` strips server files from `/bundle.softn` & `/source` and blocks blind remix
 * - Live HTTP requests (`GET`, `POST`, SQLite persistence, CSRF 403) executing a PHP container backend
 *   strictly inside ZIPP WASM `safe-sandbox` via `ANY /api/apps/{slug}/backend/...`
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { HAVE_PHP, skip, copyDir, freePort, waitFor } from './helpers/harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.resolve(here, '..');
const repo = path.resolve(apiDir, '../..');
const require = createRequire(import.meta.url);
const { zipSync, unzipSync, strToU8 } = require('fflate');

const containerEnginesDir = path.join(repo, 'packages/@softn/container/dist/runtime/engines');
const coreWasmDir = path.join(repo, 'packages/@softn/core/wasm-zipp');
const hostRuntimeDir = path.join(repo, 'apps/softn-host-php/runtime');
const hasPhpWasm = fs.existsSync(path.join(containerEnginesDir, 'zipp-php.wasm'));

let root = '';
let server = null;
let base = '';
let adminKey = '';

async function api(method, route, { body, headers = {}, raw } = {}) {
  const init = { method, headers: { ...headers } };
  if (raw !== undefined) init.body = raw;
  else if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(base + route, init);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-json */
  }
  return { status: res.status, json, text, headers: res.headers };
}

function makePhpContainerBundle(name) {
  return zipSync({
    'manifest.json': strToU8(
      JSON.stringify({
        engine: 2,
        id: `test.${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
        name,
        version: '1.0.0',
        description: `${name} full-stack PHP + SQLite container`,
        main: 'index.html',
        backend: {
          runtime: 'php',
          entry: 'server/index.php',
          mode: 'api',
          routes: ['/api/'],
        },
        databases: [
          {
            name: 'app',
            engine: 'sqlite',
            file: 'data/app.db',
            seedSql: 'server/schema.sql',
            persist: true,
          },
        ],
      })
    ),
    'index.html': strToU8('<!doctype html><html><body><h1>Hosted App</h1></body></html>'),
    'server/schema.sql': strToU8(
      'CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL);'
    ),
    'server/index.php': strToU8(`<?php
$pdo = new PDO('sqlite:data/app.db');
$pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$uri = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
header('Content-Type: application/json; charset=utf-8');
if ($method === 'POST' && $uri === '/api/items') {
    $data = json_decode(file_get_contents('php://input') ?: '{}', true) ?: [];
    $title = trim((string)($data['title'] ?? 'Untitled'));
    $stmt = $pdo->prepare('INSERT INTO items (title) VALUES (?)');
    $stmt->execute([$title]);
    http_response_code(201);
    header('Set-Cookie: session_a=alpha; Path=/', false);
    header('Set-Cookie: session_b=beta; Path=/', false);
    echo json_encode(['ok' => true, 'id' => (int)$pdo->lastInsertId(), 'title' => $title]);
    exit;
}
if ($method === 'GET' && $uri === '/api/items') {
    $rows = $pdo->query('SELECT id, title FROM items ORDER BY id ASC')->fetchAll(PDO::FETCH_ASSOC);
    echo json_encode(['ok' => true, 'items' => $rows]);
    exit;
}
http_response_code(404);
echo json_encode(['ok' => false, 'path' => $uri]);
`),
  });
}

before(async () => {
  if (!HAVE_PHP) return;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'softn-hosting-'));
  copyDir(apiDir, path.join(root, 'api'));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.mkdirSync(path.join(root, 'play'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'play/index.html'),
    '<!doctype html><html><head><title>App</title></head><body><div id="root"></div></body></html>'
  );
  fs.writeFileSync(
    path.join(root, 'index.html'),
    '<!doctype html><html><head><title>SoftN</title></head><body><div id="root"></div></body></html>'
  );

  for (let attempt = 1; ; attempt++) {
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    fs.writeFileSync(
      path.join(root, 'data/config.json'),
      JSON.stringify({
        siteOrigin: base,
        seedDemos: false,
        hostedBackend: {
          runtimeDir: hostRuntimeDir,
          enginesDir: containerEnginesDir,
          coreWasmDir,
        },
      })
    );
    server = spawn('php', ['-S', `127.0.0.1:${port}`, '-t', root, path.join(root, 'api/router.php')], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env },
    });
    let bindFailure = '';
    server.stderr.on('data', (d) => {
      const s = String(d);
      if (/Failed to listen|Address already in use/i.test(s)) bindFailure = s.trim();
    });
    const probeAbort = new AbortController();
    const exited = new Promise((resolve) => server.once('exit', (code) => {
      probeAbort.abort();
      resolve(code ?? -1);
    }));
    const outcome = await Promise.race([
      waitFor(`${base}/api/health`, 15000, probeAbort.signal).then(() => 'up', () => 'down'),
      exited.then((code) => `exited ${code}`),
    ]);
    probeAbort.abort();
    if (outcome === 'up' && server.exitCode === null) break;
    server.kill();
    if (attempt >= 5) throw new Error(`php -S could not bind after ${attempt} attempts (${bindFailure || outcome})`);
  }
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'data/config.json'), 'utf8'));
  adminKey = cfg.adminKey;
});

after(() => {
  if (server) server.kill();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

test('business core category exists in /api/categories', skip, async () => {
  const res = await api('GET', '/api/categories');
  assert.equal(res.status, 200);
  const business = res.json.categories.find((c) => c.id === 'business');
  assert.ok(business, 'business category should exist');
  assert.equal(business.name, 'Business Apps');
});

test('supports browser, hybrid, and server hosting modes + filters + playConfig + withholdBackend', skip, async () => {
  const bundle = makePhpContainerBundle('Cafe Ops');

  // 1. Publish as hybrid in business category
  const pub = await api('POST', '/api/apps', {
    headers: { 'X-Admin-Key': adminKey },
    body: {
      name: 'Cafe Ops',
      category: 'business',
      hosting: 'hybrid',
      bundleBase64: Buffer.from(bundle).toString('base64'),
    },
  });
  assert.equal(pub.status, 201, JSON.stringify(pub.json));
  const slug = pub.json.app.slug;
  const editKey = pub.json.editKey;
  assert.equal(pub.json.app.category, 'business');
  assert.equal(pub.json.app.engine, 2);
  assert.equal(pub.json.app.backendRuntime, 'php');
  assert.equal(pub.json.app.hosting.mode, 'hybrid');
  assert.equal(pub.json.app.hosting.serverHosted, true);
  assert.equal(pub.json.app.hosting.browserSupported, true);
  assert.equal(pub.json.app.hosting.backendUrl, `/api/apps/${slug}/backend`);
  assert.equal(pub.json.app.hosting.sandbox, 'zipp-safe-sandbox');
  assert.equal(pub.json.app.urls.playLocal, `/play/${slug}?mode=local`);
  assert.equal(pub.json.app.urls.runtimeLocal, `/web/app/${slug}?mode=local`);

  // 2. Listing filters (?hosting=server, ?hosting=browser, ?hosting=hybrid, ?cap=backend)
  for (const q of ['hosting=server', 'hosting=browser', 'hosting=hybrid', 'hosting=backend', 'cap=backend']) {
    const list = await api('GET', `/api/apps?${q}`);
    assert.equal(list.status, 200);
    assert.ok(list.json.apps.some((a) => a.slug === slug), `Expected ${slug} in ?${q}`);
  }

  // 3. Play page emits backendUrl by default and omits it on ?mode=local
  const playHosted = await api('GET', `/play/${slug}`);
  assert.equal(playHosted.status, 200);
  const hostedCfgMatch = playHosted.text.match(/id="softn-runtime-config">([^<]+)</);
  assert.ok(hostedCfgMatch);
  const hostedCfg = JSON.parse(hostedCfgMatch[1]);
  assert.equal(hostedCfg.backendUrl, `/api/apps/${slug}/backend`);

  const playLocal = await api('GET', `/play/${slug}?mode=local`);
  assert.equal(playLocal.status, 200);
  const localCfgMatch = playLocal.text.match(/id="softn-runtime-config">([^<]+)</);
  assert.ok(localCfgMatch);
  const localCfg = JSON.parse(localCfgMatch[1]);
  assert.equal(localCfg.backendUrl, undefined);

  // 4. Switch to server mode with withholdBackend=true (admin key when allowPublicServerHosting is false)
  const patched = await api('PATCH', `/api/apps/${slug}`, {
    headers: { 'X-Edit-Key': editKey, 'X-Admin-Key': adminKey },
    body: { hosting: 'server', withholdBackend: true },
  });
  assert.equal(patched.status, 200, JSON.stringify(patched.json));
  assert.equal(patched.json.app.hosting.mode, 'server');
  assert.equal(patched.json.app.hosting.browserSupported, false);
  assert.equal(patched.json.app.hosting.withholdBackend, true);

  const clientBundleRes = await fetch(`${base}/api/apps/${slug}/bundle.softn`);
  assert.equal(clientBundleRes.status, 200);
  const clientZip = unzipSync(new Uint8Array(await clientBundleRes.arrayBuffer()));
  assert.ok(clientZip['index.html'], 'client bundle keeps index.html');
  assert.equal(clientZip['server/index.php'], undefined, 'client bundle withholds server/index.php');
  assert.equal(clientZip['server/schema.sql'], undefined, 'client bundle withholds server/schema.sql');
  const clientManifest = JSON.parse(new TextDecoder().decode(clientZip['manifest.json']));
  assert.equal(clientManifest.backend, undefined, 'client manifest strips backend config');

  const srcRes = await api('GET', `/api/apps/${slug}/source`);
  assert.equal(srcRes.status, 200);
  assert.ok(!srcRes.json.files.some((f) => f.path.startsWith('server/')), 'source hides withheld backend files');

  const blindRemix = await api('POST', `/api/apps/${slug}/remix`, { body: { name: 'Stolen' } });
  assert.equal(blindRemix.status, 403);

  // 5. Switch to browser-only -> /backend returns 404, play page has no backendUrl
  const toBrowser = await api('PATCH', `/api/apps/${slug}`, {
    headers: { 'X-Edit-Key': editKey },
    body: { hosting: 'browser' },
  });
  assert.equal(toBrowser.status, 200);
  assert.equal(toBrowser.json.app.hosting.mode, 'browser');
  assert.equal(toBrowser.json.app.hosting.serverHosted, false);
  assert.equal(toBrowser.json.app.hosting.backendUrl, null);

  const blockedBackend = await api('GET', `/api/apps/${slug}/backend/api/items`);
  assert.equal(blockedBackend.status, 404);
});

test(
  'executes hosted PHP + SQLite container backend strictly inside ZIPP safe-sandbox with multi-user persistence and CSRF protection',
  { skip: (!HAVE_PHP || !hasPhpWasm) && 'PHP CLI or zipp-php.wasm missing' },
  async () => {
    const bundle = makePhpContainerBundle('Sandbox Ledger');
    const pub = await api('POST', '/api/apps', {
      headers: { 'X-Admin-Key': adminKey },
      body: {
        name: 'Sandbox Ledger',
        category: 'business',
        hosting: 'hybrid',
        bundleBase64: Buffer.from(bundle).toString('base64'),
      },
    });
    assert.equal(pub.status, 201, JSON.stringify(pub.json));
    const slug = pub.json.app.slug;

    // Cross-origin POST must be rejected (403)
    const csrf = await api('POST', `/api/apps/${slug}/backend/api/items`, {
      headers: { Origin: 'https://evil.example' },
      body: { title: 'Blocked' },
    });
    assert.equal(csrf.status, 403);

    // Initial GET -> empty list, executed inside ZIPP safe-sandbox
    const empty = await api('GET', `/api/apps/${slug}/backend/api/items`);
    assert.equal(empty.status, 200, empty.text);
    assert.equal(empty.headers.get('x-softn-sandbox'), 'zipp-safe-sandbox');
    assert.deepEqual(empty.json, { ok: true, items: [] });

    // POST creates a row and returns multiple Set-Cookie headers
    const created = await api('POST', `/api/apps/${slug}/backend/api/items`, {
      body: { title: 'Flat White' },
    });
    assert.equal(created.status, 201, created.text);
    assert.equal(created.json.ok, true);
    assert.equal(created.json.title, 'Flat White');
    assert.ok(created.headers.get('content-security-policy')?.includes('sandbox'), 'hosted backend response carries sandbox CSP');
    assert.equal(created.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(created.headers.get('x-frame-options'), 'DENY');
    const cookies = created.headers.getSetCookie?.() ?? [];
    assert.ok(
      cookies.some((c) => c.includes('session_a=alpha') && c.includes(`Path=/api/apps/${slug}/backend`) && c.includes('SameSite=Lax')),
      `Expected path-scoped session_a cookie, got ${JSON.stringify(cookies)}`
    );
    assert.ok(
      cookies.some((c) => c.includes('session_b=beta') && c.includes(`Path=/api/apps/${slug}/backend`)),
      `Expected path-scoped session_b cookie, got ${JSON.stringify(cookies)}`
    );

    // Subsequent GET sees persisted SQLite row
    const afterPost = await api('GET', `/api/apps/${slug}/backend/api/items`);
    assert.equal(afterPost.status, 200, afterPost.text);
    assert.equal(afterPost.json.items.length, 1);
    assert.equal(afterPost.json.items[0].title, 'Flat White');
  }
);

test('public publishing is browser-only by default; server hosting can only be enabled via app.json or allowPublicServerHosting config', skip, async () => {
  const bundle = makePhpContainerBundle('Client Only App');

  // /api/categories reports allowPublicServerHosting: false by default
  const cats = await api('GET', '/api/categories');
  assert.equal(cats.status, 200);
  assert.equal(cats.json.allowPublicServerHosting, false);

  // Public publish asking for hybrid/server hosting is refused (403)
  const blocked = await api('POST', '/api/apps', {
    body: {
      name: 'Blocked Hosted',
      category: 'business',
      hosting: 'hybrid',
      bundleBase64: Buffer.from(bundle).toString('base64'),
    },
  });
  assert.equal(blocked.status, 403);

  // Public publish without server hosting succeeds as browser-sandboxed
  const ok = await api('POST', '/api/apps', {
    body: {
      name: 'Client Only App',
      category: 'business',
      bundleBase64: Buffer.from(bundle).toString('base64'),
    },
  });
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  const slug = ok.json.app.slug;
  const editKey = ok.json.editKey;
  assert.equal(ok.json.app.hosting.mode, 'browser');
  assert.equal(ok.json.app.hosting.serverHosted, false);

  // Public PATCH cannot flip hosting to server/hybrid either (403)
  const patchBlocked = await api('PATCH', `/api/apps/${slug}`, {
    headers: { 'X-Edit-Key': editKey },
    body: { hosting: 'server' },
  });
  assert.equal(patchBlocked.status, 403);

  // Site owner editing data/apps/<slug>/app.json directly enables hybrid hosting
  const appJsonPath = path.join(root, 'data', 'apps', slug, 'app.json');
  const doc = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
  doc.app.hosting = 'hybrid';
  fs.writeFileSync(appJsonPath, JSON.stringify(doc, null, 2));

  const detail = await api('GET', `/api/apps/${slug}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.json.app.hosting.mode, 'hybrid');
  assert.equal(detail.json.app.hosting.serverHosted, true);
});

test('source endpoint exposes PHP, Rust, SQL, and streams images/audio/video safely via /source/file with Range support', skip, async () => {
  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
  const mp3Bytes = new Uint8Array([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  const bundle = zipSync({
    'manifest.json': strToU8(JSON.stringify({ name: 'Polyglot Media', version: '1.0.0', description: 'All files', main: 'ui/main.ui' })),
    'ui/main.ui': strToU8('<App><Text>Hi</Text></App>'),
    'server/index.php': strToU8('<?php echo "ok";'),
    'backend/src/main.rs': strToU8('fn main() { println!("hi"); }'),
    'server/schema.sql': strToU8('CREATE TABLE notes (id INTEGER PRIMARY KEY);'),
    'assets/logo.svg': strToU8('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>'),
    'assets/hero.png': pngBytes,
    'assets/chime.mp3': mp3Bytes,
  });

  const pub = await api('POST', '/api/apps', {
    body: { name: 'Polyglot Media', category: 'tools', bundleBase64: Buffer.from(bundle).toString('base64') },
  });
  assert.equal(pub.status, 201, JSON.stringify(pub.json));
  const slug = pub.json.app.slug;

  const src = await api('GET', `/api/apps/${slug}/source`);
  assert.equal(src.status, 200);
  const byPath = new Map(src.json.files.map((f) => [f.path, f]));
  assert.equal(byPath.get('server/index.php')?.text, '<?php echo "ok";');
  assert.equal(byPath.get('server/index.php')?.kind, 'text');
  assert.equal(byPath.get('backend/src/main.rs')?.text, 'fn main() { println!("hi"); }');
  assert.equal(byPath.get('server/schema.sql')?.text, 'CREATE TABLE notes (id INTEGER PRIMARY KEY);');
  assert.equal(byPath.get('assets/logo.svg')?.kind, 'image');
  assert.ok(byPath.get('assets/logo.svg')?.text?.includes('<svg'));
  assert.equal(byPath.get('assets/hero.png')?.kind, 'image');
  assert.equal(byPath.get('assets/chime.mp3')?.kind, 'audio');

  // Stream image with sandboxed user-content CSP
  const imgRes = await fetch(`${base}/api/apps/${slug}/source/file?path=${encodeURIComponent('assets/hero.png')}`);
  assert.equal(imgRes.status, 200);
  assert.equal(imgRes.headers.get('content-type'), 'image/png');
  assert.ok(imgRes.headers.get('content-security-policy')?.includes('sandbox'));
  assert.deepEqual(new Uint8Array(await imgRes.arrayBuffer()), pngBytes);

  // Stream audio with HTTP Range header -> 206 Partial Content
  const audioRange = await fetch(`${base}/api/apps/${slug}/source/file?path=${encodeURIComponent('assets/chime.mp3')}`, {
    headers: { Range: 'bytes=0-3' },
  });
  assert.equal(audioRange.status, 206);
  assert.equal(audioRange.headers.get('content-type'), 'audio/mpeg');
  assert.equal(audioRange.headers.get('content-range'), 'bytes 0-3/10');
  assert.deepEqual(new Uint8Array(await audioRange.arrayBuffer()), mp3Bytes.slice(0, 4));

  // Path traversal rejected
  const bad = await fetch(`${base}/api/apps/${slug}/source/file?path=${encodeURIComponent('../config.json')}`);
  assert.equal(bad.status, 400);
  // Backslash traversal also rejected via Bundle::unsafeName
  const badSlash = await fetch(`${base}/api/apps/${slug}/source/file?path=${encodeURIComponent('assets\\..\\config.json')}`);
  assert.equal(badSlash.status, 400);
});
