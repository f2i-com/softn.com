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
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { HAVE_PHP, skip, copyDir, freePort, waitFor, startServer, makeBundle } from './helpers/harness.mjs';

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

function makePhpContainerBundle(name, version = '1.0.0') {
  return zipSync({
    'manifest.json': strToU8(
      JSON.stringify({
        engine: 2,
        id: `test.${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
        name,
        version,
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

test('the bundle a hosted backend was extracted into is kept while its version is still in use, and pruned once it is not', skip, async () => {
  // The folder a version is extracted into was pruned by its age since the
  // extraction: the first request for the next version removed it under a
  // request that was still running the one before, which answered 502.
  const pub = await api('POST', '/api/apps', {
    headers: { 'X-Admin-Key': adminKey },
    body: { name: 'Rolling Ledger', category: 'business', hosting: 'hybrid', bundleBase64: Buffer.from(makePhpContainerBundle('Rolling Ledger')).toString('base64') },
  });
  assert.equal(pub.status, 201, JSON.stringify(pub.json));
  const slug = pub.json.app.slug;
  const cacheRoot = path.join(root, 'data', 'apps', slug, 'backend-cache');
  const extracted = () => fs.readdirSync(cacheRoot).filter((n) => /^v\d+-[0-9a-f]{12}$/.test(n)).map((n) => n.split('-')[0]).sort();
  const tenMinutesAgo = (version) => {
    const name = fs.readdirSync(cacheRoot).find((n) => n.startsWith(`${version}-`));
    const then = new Date(Date.now() - 600_000);
    fs.utimesSync(path.join(cacheRoot, name), then, then);
  };
  // Whatever the sandbox answers (it may not be installed here): the bundle is extracted before it runs.
  const call = () => api('GET', `/api/apps/${slug}/backend/api/items`);
  const publishNext = async (version) => {
    const next = await api('POST', `/api/apps/${slug}/versions`, {
      headers: { 'X-Admin-Key': adminKey },
      body: { bundleBase64: Buffer.from(makePhpContainerBundle('Rolling Ledger', version)).toString('base64') },
    });
    assert.equal(next.status, 201, next.text);
  };

  await call();
  assert.deepEqual(extracted(), ['v1']);
  // Extracted ten minutes ago, and a request uses it now.
  tenMinutesAgo('v1');
  await call();
  await publishNext('1.0.1');
  await call();
  assert.deepEqual(extracted(), ['v1', 'v2'], 'version 1 was in use a moment ago, and a request may still be running it');

  // Unused for ten minutes, it goes with the first request for the version after.
  tenMinutesAgo('v1');
  await publishNext('1.0.2');
  await call();
  assert.deepEqual(extracted(), ['v2', 'v3']);
});

test('a client bundle no version of a withheld app names any more is pruned once it is not in use, and one a version names is kept', skip, async () => {
  // backend-cache/client-v<N>-<sha>.softn and its .sha256 were never removed:
  // the client bundle of a version dropped at maxVersionsPerApp, of bytes
  // replaced where they were (the seed does that to a demo's v1), and every
  // one of an app that has stopped withholding its backend stayed for good.
  const s = await startServer({ prefix: 'softn-client-prune-', config: { maxVersionsPerApp: 2 } });
  try {
    const admin = { 'X-Admin-Key': s.adminKey };
    const b64 = (bytes) => Buffer.from(bytes).toString('base64');
    const sha12 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 12);
    const v1 = makePhpContainerBundle('Withheld Ledger', '1.0.0');
    const pub = await s.api('POST', '/api/apps', { headers: admin, body: { name: 'Withheld Ledger', hosting: 'server', withholdBackend: true, bundleBase64: b64(v1) } });
    assert.equal(pub.status, 201, pub.text);
    assert.equal(pub.json.app.hosting.withholdBackend, true);
    const slug = pub.json.app.slug;
    const appDir = path.join(s.dataDir, 'apps', slug);
    assert.ok(fs.existsSync(path.join(appDir, 'v1.softn')));
    const cacheRoot = path.join(appDir, 'backend-cache');
    const clients = () => (fs.existsSync(cacheRoot) ? fs.readdirSync(cacheRoot) : []).filter((n) => n.startsWith('client-')).sort();
    const of = (n, bytes) => [`client-v${n}-${sha12(bytes)}.softn`, `client-v${n}-${sha12(bytes)}.softn.sha256`];
    const sorted = (...pairs) => pairs.flat().sort();
    const unused = (...names) => {
      const then = new Date(Date.now() - 600_000);
      for (const name of names.flat()) fs.utimesSync(path.join(cacheRoot, name), then, then);
    };
    const detail = async () => {
      const res = await s.api('GET', `/api/apps/${slug}`);
      assert.equal(res.status, 200, res.text);
      return res.json.app;
    };
    const publishNext = async (bytes) => {
      const res = await s.api('POST', `/api/apps/${slug}/versions`, { headers: admin, body: { bundleBase64: b64(bytes) } });
      assert.equal(res.status, 201, res.text);
      return res.json;
    };

    // The app's page lists each version with its client bundle's digest and size.
    await detail();
    assert.deepEqual(clients(), sorted(of(1, v1)));
    const v2 = makePhpContainerBundle('Withheld Ledger', '1.0.1');
    await publishNext(v2);
    assert.deepEqual(clients(), sorted(of(1, v1), of(2, v2)));

    // Version 2 is dropped to make room for version 3. Built a moment ago, its client bundle is kept a while.
    const v3 = makePhpContainerBundle('Withheld Ledger', '1.0.2');
    assert.deepEqual((await publishNext(v3)).app.droppedVersions, [2]);
    assert.deepEqual(clients(), sorted(of(1, v1), of(2, v2), of(3, v3)));
    // Unused for ten minutes, it goes, digest and all. The ones the versions still name are in use, however old.
    unused(of(1, v1), of(2, v2), of(3, v3));
    await detail();
    assert.deepEqual(clients(), sorted(of(1, v1), of(3, v3)));

    // Version 1's bytes replaced where they are, as the seed replaces a demo's.
    const v1b = makePhpContainerBundle('Withheld Ledger', '1.0.0-second-printing');
    fs.writeFileSync(path.join(appDir, 'v1.softn'), v1b);
    await detail();
    assert.deepEqual(clients(), sorted(of(1, v1), of(1, v1b), of(3, v3)), 'the replaced one was used a moment ago');
    unused(of(1, v1));
    await detail();
    assert.deepEqual(clients(), sorted(of(1, v1b), of(3, v3)));

    // An app that no longer withholds its backend serves no client bundle, and all of them go in time.
    const freed = await s.api('PATCH', `/api/apps/${slug}`, { headers: admin, body: { withholdBackend: false } });
    assert.equal(freed.status, 200, freed.text);
    assert.equal(freed.json.app.hosting.withholdBackend, false);
    assert.deepEqual(clients(), sorted(of(1, v1b), of(3, v3)));
    unused(of(1, v1b), of(3, v3));
    await detail();
    assert.deepEqual(clients(), []);
  } finally {
    s.stop();
  }
});

test(
  'a hosted backend cannot set what a browser keeps for the whole origin: reporting, alternative services, client hints, pins',
  { skip: (!HAVE_PHP || !hasPhpWasm) && 'PHP CLI or zipp-php.wasm missing' },
  async () => {
    // Sent by one app's backend, each of these is kept by the browser for the
    // directory's origin: its pages and every other app's, long after the response.
    const originWide = {
      NEL: '{"report_to":"spy","max_age":31536000,"include_subdomains":true}',
      'Report-To': '{"group":"spy","max_age":31536000,"endpoints":[{"url":"https://spy.example/r"}]}',
      'Reporting-Endpoints': 'spy="https://spy.example/r"',
      'Alt-Svc': 'h3="spy.example:443"; ma=31536000; persist=1',
      'Accept-CH': 'Sec-CH-UA-Full-Version-List, Sec-CH-UA-Model',
      'Critical-CH': 'Sec-CH-UA-Model',
      'Origin-Agent-Cluster': '?0',
      'Cross-Origin-Opener-Policy-Report-Only': 'same-origin; report-to="spy"',
      'Cross-Origin-Embedder-Policy-Report-Only': 'require-corp; report-to="spy"',
      'Expect-CT': 'max-age=31536000, enforce',
      'Public-Key-Pins': 'pin-sha256="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="; max-age=31536000',
      'Public-Key-Pins-Report-Only': 'pin-sha256="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="; report-uri="https://spy.example/r"',
    };
    const lines = Object.entries(originWide).map(([name, value]) => `header(${JSON.stringify(`${name}: ${value}`).replaceAll('$', '\\$')});`);
    const bundle = zipSync({
      'manifest.json': strToU8(
        JSON.stringify({
          engine: 2,
          id: 'test.header-setter',
          name: 'Header Setter',
          version: '1.0.0',
          description: 'A backend that sets headers',
          main: 'index.html',
          backend: { runtime: 'php', entry: 'server/index.php', mode: 'api', routes: ['/api/'] },
        })
      ),
      'index.html': strToU8('<!doctype html><html><body><h1>Header Setter</h1></body></html>'),
      'server/index.php': strToU8(`<?php\nheader('Content-Type: application/json; charset=utf-8');\nheader('X-App-Note: kept');\n${lines.join('\n')}\necho json_encode(['ok' => true]);\n`),
    });
    const pub = await api('POST', '/api/apps', {
      headers: { 'X-Admin-Key': adminKey },
      body: { name: 'Header Setter', category: 'tools', hosting: 'server', bundleBase64: Buffer.from(bundle).toString('base64') },
    });
    assert.equal(pub.status, 201, JSON.stringify(pub.json));
    const res = await api('GET', `/api/apps/${pub.json.app.slug}/backend/api/ping`);
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.json, { ok: true });
    assert.equal(res.headers.get('x-app-note'), 'kept', 'a header of the app\'s own is passed on');
    for (const name of Object.keys(originWide)) assert.equal(res.headers.get(name), null, `${name} is not passed on`);
  }
);

test(
  'a hosted backend cannot raise the browser\'s own sign-in dialog under the directory\'s name',
  { skip: (!HAVE_PHP || !hasPhpWasm) && 'PHP CLI or zipp-php.wasm missing' },
  async () => {
    // A 401 with WWW-Authenticate makes the browser ask for a name and a
    // password in its own dialog, which names the directory's host and not the
    // app, and what is typed is sent back as Authorization, which is passed on
    // to the app's backend: any hosted app could ask the directory's visitors
    // for their password as the directory. The status is the app's to give;
    // the challenge is not.
    const bundle = zipSync({
      'manifest.json': strToU8(
        JSON.stringify({
          engine: 2,
          id: 'test.sign-in-asker',
          name: 'Sign In Asker',
          version: '1.0.0',
          description: 'A backend that asks for a password',
          main: 'index.html',
          backend: { runtime: 'php', entry: 'server/index.php', mode: 'api', routes: ['/api/'] },
        })
      ),
      'index.html': strToU8('<!doctype html><html><body><h1>Sign In Asker</h1></body></html>'),
      'server/index.php': strToU8(
        `<?php\nhttp_response_code(401);\nheader('Content-Type: application/json; charset=utf-8');\nheader('X-App-Note: kept');\nheader('WWW-Authenticate: Basic realm="SoftN directory account"');\nheader('Proxy-Authenticate: Basic realm="SoftN directory account"');\necho json_encode(['ok' => false, 'saw' => $_SERVER['HTTP_AUTHORIZATION'] ?? null]);\n`
      ),
    });
    const pub = await api('POST', '/api/apps', {
      headers: { 'X-Admin-Key': adminKey },
      body: { name: 'Sign In Asker', category: 'tools', hosting: 'server', bundleBase64: Buffer.from(bundle).toString('base64') },
    });
    assert.equal(pub.status, 201, JSON.stringify(pub.json));
    const res = await api('GET', `/api/apps/${pub.json.app.slug}/backend/api/account`, { headers: { Authorization: 'Bearer app-token' } });
    assert.equal(res.status, 401, res.text);
    assert.equal(res.headers.get('x-app-note'), 'kept', 'the answer is the backend\'s own');
    assert.equal(res.headers.get('www-authenticate'), null, 'WWW-Authenticate is not passed on');
    assert.equal(res.headers.get('proxy-authenticate'), null, 'Proxy-Authenticate is not passed on');
    // An app's own token scheme still reaches it: only the browser's dialog is withheld.
    assert.equal(res.json.saw, 'Bearer app-token');
  }
);

test(
  'the directory\'s own Basic or Digest sign-in is not passed on to a hosted backend, and an app\'s own token is',
  { skip: (!HAVE_PHP || !hasPhpWasm) && 'PHP CLI or zipp-php.wasm missing' },
  async () => {
    // A directory behind HTTP Basic or Digest auth (a password on the whole
    // site, say) has the browser send its sign-in with every request to it,
    // a hosted app's backend among them, which was handed Authorization as it
    // came: any hosted app could read the site's password. An app's own
    // scheme (a bearer token its frontend sends) is still the app's.
    const bundle = zipSync({
      'manifest.json': strToU8(
        JSON.stringify({
          engine: 2,
          id: 'test.credential-echo',
          name: 'Credential Echo',
          version: '1.0.0',
          description: 'A backend that says what Authorization it was given',
          main: 'index.html',
          backend: { runtime: 'php', entry: 'server/index.php', mode: 'api', routes: ['/api/'] },
        })
      ),
      'index.html': strToU8('<!doctype html><html><body><h1>Credential Echo</h1></body></html>'),
      'server/index.php': strToU8(`<?php\nheader('Content-Type: application/json; charset=utf-8');\necho json_encode(['saw' => $_SERVER['HTTP_AUTHORIZATION'] ?? null]);\n`),
    });
    const pub = await api('POST', '/api/apps', {
      headers: { 'X-Admin-Key': adminKey },
      body: { name: 'Credential Echo', category: 'tools', hosting: 'server', bundleBase64: Buffer.from(bundle).toString('base64') },
    });
    assert.equal(pub.status, 201, JSON.stringify(pub.json));
    const saw = async (authorization) => {
      const res = await api('GET', `/api/apps/${pub.json.app.slug}/backend/api/whoami`, { headers: { Authorization: authorization } });
      assert.equal(res.status, 200, res.text);
      return res.json.saw;
    };
    const site = Buffer.from('site-owner:the site password').toString('base64');
    for (const withheld of [`Basic ${site}`, `basic ${site}`, `BASIC   ${site}`, 'Digest username="site-owner", realm="softn", nonce="abc", uri="/", response="0123"', 'digest username="site-owner"']) {
      assert.equal(await saw(withheld), null, `${withheld.split(' ')[0]} is the site's sign-in and is not passed on`);
    }
    for (const passed of ['Bearer app-token', 'bearer app-token', 'Token abc123', 'Basicish not-the-basic-scheme']) {
      assert.equal(await saw(passed), passed);
    }
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

test('a publisher\'s custom backendUrl is taken only by a directory that knows its own address', skip, async () => {
  // Which origin is the site's own was read from the request that set the
  // URL. Sent to the server's IP address or another of its names, a URL on
  // the site's real name passed as somebody else's, and the app was pointed
  // at another app's backend there: a visitor who opened it on the real name
  // had its frontend speaking to that backend as themselves.
  const unset = await startServer({ prefix: 'softn-hosting-no-origin-', config: { allowPublicServerHosting: true } });
  const known = await startServer({ prefix: 'softn-hosting-origin-', config: { allowPublicServerHosting: true, siteOrigin: 'https://directory.example' } });
  try {
    const publish = (s, name, backendUrl, headers = {}) => {
      const fd = new FormData();
      fd.append('bundle', new Blob([makeBundle(name)]), 'app.softn');
      fd.append('name', name);
      fd.append('hosting', 'server');
      fd.append('backendUrl', backendUrl);
      return s.api('POST', '/api/apps', { body: fd, headers });
    };

    // The test's server is reached as 127.0.0.1, which is not the name its visitors use.
    for (const url of ['https://directory.example/api/apps/victim/backend', 'https://directory.example']) {
      const refused = await publish(unset, 'Borrowed Backend', url);
      assert.equal(refused.status, 403, refused.text);
      assert.match(refused.json.error, /siteOrigin/);
    }
    assert.equal((await unset.api('GET', '/api/apps')).json.total, 0, 'nothing was published');
    // Nor by a change to an app already there.
    const fd = new FormData();
    fd.append('bundle', new Blob([makeBundle('Plain App')]), 'app.softn');
    const plain = await unset.api('POST', '/api/apps', { body: fd });
    assert.equal(plain.status, 201, plain.text);
    const patched = await unset.api('PATCH', `/api/apps/${plain.json.app.slug}`, {
      headers: { 'X-Edit-Key': plain.json.editKey },
      body: { backendUrl: 'https://directory.example/api/apps/victim/backend', hosting: 'server' },
    });
    assert.equal(patched.status, 403, patched.text);
    // The site owner still sets one. It is kept, and is the app's backend once the directory knows its own address.
    const byOwner = await publish(unset, 'Owner Backend', 'https://backend.example/api', { 'X-Admin-Key': unset.adminKey });
    assert.equal(byOwner.status, 201, byOwner.text);
    assert.equal(byOwner.json.app.hosting.customBackendUrl, 'https://backend.example/api');
    assert.equal(byOwner.json.app.hosting.backendUrl, null);

    // Where the address is known, a backend elsewhere is a publisher's to name, and the site's own is not.
    const elsewhere = await publish(known, 'Own Server', 'https://backend.example/api');
    assert.equal(elsewhere.status, 201, elsewhere.text);
    assert.equal(elsewhere.json.app.hosting.backendUrl, 'https://backend.example/api');
    const own = await publish(known, 'Borrowed Backend', 'https://directory.example/api/apps/victim/backend');
    assert.equal(own.status, 403, own.text);
  } finally {
    unset.stop();
    known.stop();
  }
});

test('one rule says which backendUrl of its own an app\'s frontend is pointed at, on the play page and in the API the web app reads', skip, async () => {
  // The play page never gave out a backend elsewhere and gave out one on this
  // site for an app the owner trusts; the API gave the web app whatever was
  // stored, the site's own addresses among them, and the web app used it:
  // an app pointed at /api/apps/<another>/backend spoke to that backend as
  // the visitor. Now Apps::hostingInfo decides once, and both read it.
  const unset = await startServer({ prefix: 'softn-backend-rule-no-origin-' });
  const known = await startServer({ prefix: 'softn-backend-rule-', config: { siteOrigin: 'https://directory.example' } });
  try {
    // Set by the site owner, who may store any address: the rule is about which one is used.
    const publish = async (s, name, backendUrl, bundle = makeBundle(name)) => {
      const fd = new FormData();
      fd.append('bundle', new Blob([bundle]), 'app.softn');
      fd.append('name', name);
      fd.append('hosting', 'server');
      fd.append('backendUrl', backendUrl);
      const res = await s.api('POST', '/api/apps', { body: fd, headers: { 'X-Admin-Key': s.adminKey } });
      assert.equal(res.status, 201, res.text);
      assert.equal(res.json.app.hosting.customBackendUrl, backendUrl, 'what was set is kept as it was set');
      return res.json.app.slug;
    };
    // What the API tells the web app (/web/app/<slug>), and what the play page's shell is given.
    const pointedAt = async (s, slug) => {
      const hosting = (await s.api('GET', `/api/apps/${slug}`)).json.app.hosting;
      const page = await s.api('GET', `/play/${slug}`);
      assert.equal(page.status, 200, page.text);
      const cfg = JSON.parse(page.text.match(/id="softn-runtime-config">([^<]+)</)[1]);
      return { api: hosting.backendUrl, play: cfg.backendUrl ?? null };
    };
    const nowhere = { api: null, play: null };

    // On this site, and not the app's own hosted backend: never, whoever set it and however it is written.
    const path = await publish(known, 'Path Backend', '/internal/backend');
    assert.deepEqual(await pointedAt(known, path), nowhere);
    const another = await publish(known, 'Borrowed Backend', 'https://directory.example/api/apps/victim/backend');
    assert.deepEqual(await pointedAt(known, another), nowhere);
    const root = await publish(known, 'Whole Site', 'https://DIRECTORY.example:443');
    assert.deepEqual(await pointedAt(known, root), nowhere);
    // By the name the request came to, which is this site too whatever siteOrigin says.
    const byHost = await publish(known, 'Other Name', `${known.base}/api/apps/victim/backend`);
    assert.deepEqual(await pointedAt(known, byHost), nowhere);
    // Nor for an app the owner trusts, which the play page used to make an exception of.
    const appJson = `${known.dataDir}/apps/${path}/app.json`;
    const doc = JSON.parse(fs.readFileSync(appJson, 'utf8'));
    doc.app.trusted = true;
    fs.writeFileSync(appJson, JSON.stringify(doc, null, 2));
    assert.equal((await known.api('GET', `/api/apps/${path}`)).json.app.trusted, true);
    assert.deepEqual(await pointedAt(known, path), nowhere);

    // The app's own hosted backend is the one address on this site it may name, as a path or in full
    // (an app with a backend of its own to host: naming it is naming none, as the next test shows).
    const own = await publish(known, 'Own Backend', 'https://backend.example/api', makePhpContainerBundle('Own Backend'));
    for (const written of [`/api/apps/${own}/backend`, `https://directory.example/api/apps/${own}/backend/`]) {
      const set = await known.api('PATCH', `/api/apps/${own}`, { body: { backendUrl: written }, headers: { 'X-Admin-Key': known.adminKey } });
      assert.equal(set.status, 200, set.text);
      assert.deepEqual(await pointedAt(known, own), { api: `/api/apps/${own}/backend`, play: `/api/apps/${own}/backend` });
    }
    // A path that only begins like it is another app's, or the site's.
    for (const written of [`/api/apps/${own}/backend/../../victim/backend`, `/api/apps/${own}/backend?x=1`, `https://directory.example/api/apps/${own}/backendx`]) {
      const set = await known.api('PATCH', `/api/apps/${own}`, { body: { backendUrl: written }, headers: { 'X-Admin-Key': known.adminKey } });
      if (set.status === 200) assert.deepEqual(await pointedAt(known, own), nowhere, written);
      else assert.equal(set.status, 400, set.text);
    }

    // A backend elsewhere is used where the site knows its own address. The play page's shell takes a
    // backend on its own origin only, so there it is the web app that reaches one elsewhere.
    const elsewhere = await publish(known, 'Own Server', 'https://backend.example/api');
    assert.deepEqual(await pointedAt(known, elsewhere), { api: 'https://backend.example/api', play: null });
    // And where it does not, none is: it cannot tell an address elsewhere from one of its own.
    const unknown = await publish(unset, 'Own Server', 'https://backend.example/api', makePhpContainerBundle('Own Server'));
    assert.deepEqual(await pointedAt(unset, unknown), nowhere);
    const ownThere = await unset.api('PATCH', `/api/apps/${unknown}`, { body: { backendUrl: `/api/apps/${unknown}/backend` }, headers: { 'X-Admin-Key': unset.adminKey } });
    assert.equal(ownThere.status, 200, ownThere.text);
    assert.deepEqual(await pointedAt(unset, unknown), { api: `/api/apps/${unknown}/backend`, play: `/api/apps/${unknown}/backend` });
  } finally {
    unset.stop();
    known.stop();
  }
});

test('an app whose backendUrl names its own hosted backend, however it is written, is answered by that backend', skip, async () => {
  // The rule above gives an app's frontend its own /api/apps/<slug>/backend
  // when that is what its backendUrl names, and the backend route refused
  // every stored backendUrl as a custom one: the one address on this site an
  // app may name was handed to its frontend, and answered 400 there.
  const admin = { 'X-Admin-Key': adminKey };
  const pub = await api('POST', '/api/apps', {
    headers: admin,
    body: { name: 'Own Path Ledger', category: 'business', hosting: 'server', bundleBase64: Buffer.from(makePhpContainerBundle('Own Path Ledger')).toString('base64') },
  });
  assert.equal(pub.status, 201, JSON.stringify(pub.json));
  const slug = pub.json.app.slug;
  const own = `/api/apps/${slug}/backend`;
  const cacheRoot = path.join(root, 'data', 'apps', slug, 'backend-cache');
  // This suite's server knows its own address (siteOrigin), so the full form is this site's too.
  for (const written of [own, `${own}/`, `${base}${own}`]) {
    const set = await api('PATCH', `/api/apps/${slug}`, { headers: admin, body: { backendUrl: written } });
    assert.equal(set.status, 200, set.text);
    assert.equal(set.json.app.hosting.customBackendUrl, written, 'what was set is kept as it was set');
    assert.equal(set.json.app.hosting.backendUrl, own);
    fs.rmSync(cacheRoot, { recursive: true, force: true });
    const res = await api('GET', `${own}/api/items`);
    assert.notEqual(res.status, 400, `${written}: ${res.text}`);
    // The bundle is extracted before the sandbox runs, whether or not the sandbox is installed here.
    assert.ok(fs.existsSync(cacheRoot) && fs.readdirSync(cacheRoot).some((n) => /^v1-[0-9a-f]{12}$/.test(n)), `${written}: the hosted backend took the request`);
    if (hasPhpWasm) {
      assert.equal(res.status, 200, `${written}: ${res.text}`);
      assert.equal(res.headers.get('x-softn-sandbox'), 'zipp-safe-sandbox');
      assert.deepEqual(res.json, { ok: true, items: [] });
    }
    // And the API says where it runs as it does for an app that names no backend.
    assert.equal(set.json.app.hosting.sandbox, 'zipp-safe-sandbox', written);
  }
  // A backend elsewhere is the app's to reach there, and is not served from here.
  const elsewhere = await api('PATCH', `/api/apps/${slug}`, { headers: admin, body: { backendUrl: 'https://backend.example/api' } });
  assert.equal(elsewhere.status, 200, elsewhere.text);
  assert.equal(elsewhere.json.app.hosting.backendUrl, 'https://backend.example/api');
  assert.equal((await api('GET', `${own}/api/items`)).status, 400);

  // Naming its own backend is naming none, so an app with no backend to host is not hosted by it.
  const plain = await api('POST', '/api/apps', {
    headers: admin,
    body: { name: 'Own Path Plain', hosting: 'server', backendUrl: 'https://backend.example/api', bundleBase64: Buffer.from(makeBundle('Own Path Plain')).toString('base64') },
  });
  assert.equal(plain.status, 201, JSON.stringify(plain.json));
  assert.equal(plain.json.app.hosting.serverHosted, true, 'hosted elsewhere');
  const plainOwn = `/api/apps/${plain.json.app.slug}/backend`;
  const named = await api('PATCH', `/api/apps/${plain.json.app.slug}`, { headers: admin, body: { backendUrl: plainOwn } });
  assert.equal(named.status, 200, named.text);
  assert.deepEqual(
    [named.json.app.hosting.mode, named.json.app.hosting.serverHosted, named.json.app.hosting.backendUrl, named.json.app.hosting.customBackendUrl],
    ['browser', false, null, plainOwn],
  );
  assert.equal((await api('GET', `${plainOwn}/api/items`)).status, 404);
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
