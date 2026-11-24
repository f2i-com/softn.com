/**
 * End-to-end tests for SoftN v2 Web Container backends on `apps/softn-host-php`:
 * - PHP (PDO + WAL SQLite + multi-header Set-Cookie) inside ZIPP `zipp-php.wasm` safe-sandbox
 * - TypeScript & JavaScript & Python inside ZIPP WASM safe-sandbox with WAL SQLite persistence
 * - Real Slim 4 PHP bundle (`BrewDesk-1.0.0.softn`) when present locally
 * - PHP `request.php` helpers (`softn_is_container_manifest`, `softn_runner_choice`, `softn_runner_result`)
 * - `package.mjs` container engine bundling and `backendUrl` deployment config
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, cpSync, rmSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {unzipSync} from 'fflate';
import {deploymentConfig, packagePhp} from '../package.mjs';
import {readArchive} from '../../../scripts/lib/archive.mjs';

const runtimeDir = fileURLToPath(new URL('../runtime/', import.meta.url));
const coreWasmDir = fileURLToPath(new URL('../../../packages/@softn/core/wasm-zipp/', import.meta.url));
const containerEnginesDir = fileURLToPath(new URL('../../../packages/@softn/container/dist/runtime/engines/', import.meta.url));
const hasCoreWasm = existsSync(join(coreWasmDir, 'zipp_wasm_bg.wasm'));
const hasPhpWasm = existsSync(join(containerEnginesDir, 'zipp-php.wasm'));
const hasTsWasm = existsSync(join(containerEnginesDir, 'zipp-typescript.wasm'));
const hasPhpCli = spawnSync('php', ['-v']).status === 0;

function makeBackendFixture(t, files, appId = 'container-test') {
  const root = mkdtempSync(join(tmpdir(), 'softn-php-container-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  mkdirSync(join(root, 'wasm'), {recursive: true});
  mkdirSync(join(root, 'private/data'), {recursive: true});
  mkdirSync(join(root, 'app'), {recursive: true});
  cpSync(runtimeDir, root, {recursive: true});
  copyFileSync(join(coreWasmDir, 'zipp_wasm.js'), join(root, 'wasm/zipp_wasm.mjs'));
  copyFileSync(join(coreWasmDir, 'zipp_wasm_bg.wasm'), join(root, 'wasm/zipp_wasm_bg.wasm'));
  writeFileSync(
    join(root, 'private/config.json'),
    JSON.stringify({
      development: false,
      keyHex: 'a'.repeat(64),
      appId,
      capabilities: [],
      cryptoDomains: {hmac: `${appId}:hmac:v1`, seal: `${appId}:seal:v1`},
      trustedProxies: [],
    })
  );
  for (const [rel, content] of Object.entries(files)) {
    const dest = join(root, 'app', rel);
    mkdirSync(dirname(dest), {recursive: true});
    writeFileSync(dest, content);
  }
  return root;
}

function runRunner(root, request) {
  const res = spawnSync(process.execPath, [join(root, 'runner.mjs')], {
    input: JSON.stringify(request),
    encoding: 'utf8',
    env: {
      ...process.env,
      SOFTN_BACKEND_ROOT: root,
      SOFTN_CONTAINER_ENGINES_DIR: containerEnginesDir,
    },
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(res.status, 0, `runner exited ${res.status}: ${res.stderr}`);
  const parsed = JSON.parse(res.stdout);
  parsed.stderr = res.stderr;
  if (typeof parsed.bodyBase64 === 'string') {
    parsed.bodyText = Buffer.from(parsed.bodyBase64, 'base64').toString('utf8');
  }
  return parsed;
}

test('runs PHP v2 container backend in ZIPP safe-sandbox with WAL SQLite persistence and cookies', {skip: (!hasCoreWasm || !hasPhpWasm) && 'ZIPP WASM engines not built'}, t => {
  const root = makeBackendFixture(t, {
    'manifest.json': JSON.stringify({
      engine: 2,
      id: 'php-notes',
      name: 'PHP Notes',
      version: '1.2.3',
      main: 'public/index.html',
      frontendRoot: 'public',
      backend: {runtime: 'php', entry: 'server/public/index.php', mode: 'api', routes: ['/api/']},
      databases: [{name: 'app', engine: 'sqlite', file: 'app.db', seedSql: 'server/migrations/001.sql', persist: true}],
    }),
    'public/index.html': '<!doctype html><h1>PHP Notes</h1>',
    'server/migrations/001.sql': 'CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL UNIQUE);',
    'server/public/index.php': `<?php
header('Content-Type: application/json; charset=utf-8');
header('Set-Cookie: sid=abc123; Path=/; HttpOnly', false);
header('Set-Cookie: theme=dark; Path=/', false);
$pdo = new PDO('sqlite:app');
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
if ($method === 'POST') {
    $data = json_decode(file_get_contents('php://input'), true) ?: [];
    $stmt = $pdo->prepare('INSERT INTO notes (title) VALUES (?)');
    $stmt->execute([$data['title'] ?? 'untitled']);
    http_response_code(201);
    echo json_encode(['id' => (int)$pdo->lastInsertId(), 'cookieSid' => $_COOKIE['sid'] ?? null]);
} else {
    $rows = $pdo->query('SELECT id, title FROM notes ORDER BY id')->fetchAll(PDO::FETCH_ASSOC);
    echo json_encode(['notes' => $rows]);
}
`,
  }, 'php-notes');

  // 1. /api/meta reports zipp-wasm-container runtime
  const meta = runRunner(root, {path: '/api/meta', method: 'GET', query: {}, headers: {}, body: {}, client_ip: '127.0.0.1'});
  assert.equal(meta.status, 200);
  assert.equal(meta.body.runtime, 'zipp-wasm-container');
  assert.equal(meta.body.backendRuntime, 'php');
  assert.equal(meta.body.appId, 'php-notes');

  // 2. POST persists into WAL SQLite in process #1 and preserves both Set-Cookie headers & incoming Cookie
  const post = runRunner(root, {
    path: '/api/notes',
    method: 'POST',
    queryString: '',
    headers: {'content-type': 'application/json', cookie: 'sid=from-browser'},
    bodyBase64: Buffer.from(JSON.stringify({title: 'Hello WAL'})).toString('base64'),
    client_ip: '127.0.0.1',
  });
  assert.equal(post.status, 201, post.bodyText);
  assert.deepEqual(JSON.parse(post.bodyText), {id: 1, cookieSid: 'from-browser'});
  const cookies = post.headers.filter(([k]) => k.toLowerCase() === 'set-cookie').map(([, v]) => v);
  assert.equal(cookies.length, 2);

  // 3. Fresh process #2 reads back the persisted row from WAL SQLite
  const get = runRunner(root, {
    path: '/api/notes',
    method: 'GET',
    queryString: '',
    headers: {},
    bodyBase64: '',
    client_ip: '127.0.0.1',
  });
  assert.equal(get.status, 200, get.bodyText);
  assert.deepEqual(JSON.parse(get.bodyText), {notes: [{id: 1, title: 'Hello WAL'}]});
});

test('runs TypeScript and Python v2 container backends in ZIPP safe-sandbox with WAL SQLite persistence', {skip: (!hasCoreWasm || !hasTsWasm) && 'ZIPP WASM engines not built'}, t => {
  const tsRoot = makeBackendFixture(t, {
    'manifest.json': JSON.stringify({
      engine: 2,
      id: 'ts-api',
      name: 'TS API',
      version: '1.0.0',
      main: 'index.html',
      backend: {runtime: 'typescript', entry: 'backend/api.ts', mode: 'api', routes: ['/api/']},
      databases: [{name: 'app', engine: 'sqlite', file: 'app.db', seedSql: 'backend/init.sql', persist: true}],
    }),
    'index.html': '<!doctype html><h1>TS</h1>',
    'backend/init.sql': 'CREATE TABLE IF NOT EXISTS todos (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL);',
    'backend/api.ts': `
interface Req { method: string; path: string; body: string; }
function handleRequest(req: Req) {
  const db = sqlite.open('app.db');
  if (req.method === 'POST') {
    const body = JSON.parse(req.body || '{}') as { label: string };
    db.execute('INSERT INTO todos (label) VALUES (?)', [body.label]);
    return { status: 201, json: { ok: true } };
  }
  const res = db.query('SELECT id, label FROM todos ORDER BY id');
  return { status: 200, json: { todos: res.rows } };
}
globalThis.handleRequest = handleRequest;
`,
  }, 'ts-api');

  const r1 = runRunner(tsRoot, {
    path: '/api/todos',
    method: 'POST',
    queryString: '',
    headers: {'content-type': 'application/json'},
    bodyBase64: Buffer.from(JSON.stringify({label: 'Ship v2'})).toString('base64'),
    client_ip: '127.0.0.1',
  });
  assert.equal(r1.status, 201, r1.bodyText);
  const r2 = runRunner(tsRoot, {
    path: '/api/todos',
    method: 'GET',
    queryString: '',
    headers: {},
    bodyBase64: '',
    client_ip: '127.0.0.1',
  });
  assert.equal(r2.status, 200, r2.bodyText);
  assert.deepEqual(JSON.parse(r2.bodyText), {todos: [{id: 1, label: 'Ship v2'}]});

  const pyRoot = makeBackendFixture(t, {
    'manifest.json': JSON.stringify({
      engine: 2,
      id: 'py-api',
      name: 'Py API',
      version: '1.0.0',
      main: 'index.html',
      backend: {runtime: 'python', entry: 'backend/api.py', mode: 'api', routes: ['/api/']},
    }),
    'index.html': '<!doctype html><h1>Py</h1>',
    'backend/api.py': `
import json
def handle_request(req):
    data = json.loads(req["body"] or "{}")
    return {"status": 201, "json": {"echo": data.get("tag"), "path": req["path"]}}
`,
  }, 'py-api');

  const p1 = runRunner(pyRoot, {
    path: '/api/pings',
    method: 'POST',
    queryString: '',
    headers: {'content-type': 'application/json'},
    bodyBase64: Buffer.from(JSON.stringify({tag: 'pong'})).toString('base64'),
    client_ip: '127.0.0.1',
  });
  assert.equal(p1.status, 201, `${p1.bodyText} | stderr: ${p1.stderr}`);
  assert.deepEqual(JSON.parse(p1.bodyText), {echo: 'pong', path: '/api/pings'});
});

const brewDeskZip = fileURLToPath(new URL('../../softn-web/public/business-demos/BrewDesk-1.0.0.softn', import.meta.url));
test('runs real Slim 4 PHP business bundle (BrewDesk) inside ZIPP safe-sandbox through runner.mjs', {skip: (!hasCoreWasm || !hasPhpWasm || !existsSync(brewDeskZip)) && 'BrewDesk demo or ZIPP PHP WASM unavailable'}, t => {
  const entries = unzipSync(readFileSync(brewDeskZip));
  const files = {};
  for (const [name, bytes] of Object.entries(entries)) {
    if (!name.endsWith('/')) files[name] = Buffer.from(bytes);
  }
  const manifest = JSON.parse(files['manifest.json'].toString('utf8'));
  const root = makeBackendFixture(t, files, manifest.id || 'brewdesk');

  const session = runRunner(root, {
    path: '/api/session',
    method: 'GET',
    queryString: '',
    headers: {},
    bodyBase64: '',
    client_ip: '127.0.0.1',
  });
  assert.equal(session.status, 200, session.bodyText);
  const parsed = JSON.parse(session.bodyText);
  assert.equal(typeof parsed.setupDone, 'boolean', session.bodyText);

  const setup = runRunner(root, {
    path: '/api/setup',
    method: 'POST',
    queryString: '',
    headers: {'content-type': 'application/json'},
    bodyBase64: Buffer.from(JSON.stringify({business_name: 'Roastery Co', owner_name: 'Alex'})).toString('base64'),
    client_ip: '127.0.0.1',
  });
  assert.ok(setup.status === 200 || setup.status === 201, `${setup.status}: ${setup.bodyText}`);
  assert.equal(JSON.parse(setup.bodyText).settings.business_name, 'Roastery Co');

  const sample = runRunner(root, {
    path: '/api/sample/load',
    method: 'POST',
    queryString: '',
    headers: {'content-type': 'application/json'},
    bodyBase64: Buffer.from('{}').toString('base64'),
    client_ip: '127.0.0.1',
  });
  assert.ok(sample.status === 200 || sample.status === 201, `${sample.status}: ${sample.bodyText}`);

  const menu = runRunner(root, {
    path: '/api/menu',
    method: 'GET',
    queryString: '',
    headers: {},
    bodyBase64: '',
    client_ip: '127.0.0.1',
  });
  assert.equal(menu.status, 200, menu.bodyText);
  const menuJson = JSON.parse(menu.bodyText);
  const items = Array.isArray(menuJson) ? menuJson : menuJson.items || menuJson.menu || [];
  assert.ok(items.length > 0, `expected sample menu items, got: ${menu.bodyText}`);
});

test('request.php selects Node for v2 containers, parses container responses, and forwards cookies', {skip: !hasPhpCli && 'php not on PATH'}, t => {
  const dir = mkdtempSync(join(tmpdir(), 'softn-php-req-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  mkdirSync(join(dir, 'bin'), {recursive: true});
  writeFileSync(join(dir, 'bin/softn-runner-linux-x86_64'), 'stub');
  const script = `
require ${JSON.stringify(join(runtimeDir, 'request.php'))};
$v2 = ['engine' => 2, 'backend' => ['runtime' => 'php', 'entry' => 'server/public/index.php', 'routes' => ['/api/']]];
$v1 = ['server' => ['entry' => 'server/main.logic', 'routes' => []]];
$out = [
  'isV2' => softn_is_container_manifest($v2),
  'isV1' => softn_is_container_manifest($v1),
  'matchApi' => softn_container_route_matches($v2, '/api/orders'),
  'matchMeta' => softn_container_route_matches($v2, '/api/meta'),
  'matchOther' => softn_container_route_matches($v2, '/index.html'),
  'choiceV2' => softn_runner_choice(${JSON.stringify(dir)}, [], 'Linux', 'x86_64', $v2)['runner'],
  'choiceV1' => softn_runner_choice(${JSON.stringify(dir)}, [], 'Linux', 'x86_64', $v1)['runner'],
  'headersNoCookie' => softn_request_headers(['HTTP_COOKIE' => 'a=1']),
  'headersWithCookie' => softn_request_headers(['HTTP_COOKIE' => 'a=1'], true),
  'resultContainer' => softn_runner_result(json_encode(['status' => 201, 'headers' => [['Content-Type', 'text/plain']], 'bodyBase64' => base64_encode('hi')])),
];
echo json_encode($out);
`;
  const r = spawnSync('php', ['-r', script], {encoding: 'utf8'});
  assert.equal(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout);
  assert.equal(got.isV2, true);
  assert.equal(got.isV1, false);
  assert.equal(got.matchApi, true);
  assert.equal(got.matchMeta, true);
  assert.equal(got.matchOther, false);
  assert.equal(got.choiceV2, 'node');
  assert.equal(got.choiceV1, 'softn-runner');
  assert.equal(got.headersNoCookie.cookie, undefined);
  assert.equal(got.headersWithCookie.cookie, 'a=1');
  assert.deepEqual(got.resultContainer, {status: 201, headers: [['Content-Type', 'text/plain']], bodyRaw: 'hi'});
});

test('package.mjs bundles container ZIPP WASM engines and sets backendUrl for v2 containers', {skip: (!hasCoreWasm || !hasPhpWasm) && 'ZIPP WASM engines not built'}, t => {
  const cfg = deploymentConfig({id: 'brew', name: 'BrewDesk', backend: {runtime: 'php', entry: 'server/public/index.php'}}, Buffer.from('zip'));
  assert.equal(cfg.backendUrl, '.');

  const dir = mkdtempSync(join(tmpdir(), 'softn-pkg-container-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const elf = () => { const b = Buffer.alloc(64); b.write('7f454c46', 'hex'); b.writeUInt16LE(62, 18); return b; };
  const runtime = join(dir, 'runtime'), node = join(dir, 'node'), notices = join(dir, 'notices');
  for (const d of [runtime, join(node, 'bin'), notices]) mkdirSync(d, {recursive: true});
  for (const name of ['index.html', 'app.softn', 'runtime.config.json', 'LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.txt']) writeFileSync(join(runtime, name), name);
  writeFileSync(join(node, 'bin/node'), elf());
  writeFileSync(join(node, 'LICENSE'), 'node licence');
  writeFileSync(join(notices, 'ZIPP-LICENSE-APACHE'), 'zipp licence');
  const out = join(dir, 'out.zip');
  packagePhp({runtime, nodeDir: node, wasmDir: coreWasmDir, containerEnginesDir, notices, out, template: true, templateClient: true});
  const {entries, problems} = readArchive(readFileSync(out));
  assert.deepEqual(problems, []);
  assert.ok(entries.has('backend/container-backend.mjs'));
  assert.ok(entries.has('backend/wasm/container/zipp-php.wasm'));
  assert.ok(entries.has('backend/wasm/container/zipp-php.glue.js'));
  assert.ok(entries.has('backend/wasm/container/zipp-typescript.wasm'));
  assert.ok(entries.has('backend/wasm/container/zipp-rust.wasm'));
});

test('FormLogic multi-user mode stores primary SQLite at application.sqlite and forwards verified hostContext while blocking spoofed headers', {skip: (!hasCoreWasm || !hasPhpWasm) && 'ZIPP WASM engines not built'}, t => {
  const root = makeBackendFixture(t, {
    'manifest.json': JSON.stringify({
      engine: 2,
      id: 'fl-multi-notes',
      name: 'FL Multi Notes',
      version: '1.0.0',
      main: 'public/index.html',
      frontendRoot: 'public',
      backend: {runtime: 'php', entry: 'backend/index.php', mode: 'api', routes: ['/api/']},
      databases: [{name: 'app', engine: 'sqlite', file: 'app.db', seedSql: 'backend/schema.sql', persist: true}],
    }),
    'public/index.html': '<!doctype html><h1>Notes</h1>',
    'backend/schema.sql': 'CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, text TEXT NOT NULL);',
    'backend/index.php': `<?php
header('Content-Type: application/json; charset=utf-8');
$pdo = new PDO('sqlite:app');
$userId = $_SERVER['HTTP_X_FORMLOGIC_USER_ID'] ?? 'anon';
$spoof = $_SERVER['HTTP_X_FORMLOGIC_SPOOF'] ?? null;
$ctx = json_decode($_SERVER['HTTP_X_FORMLOGIC_CONTEXT'] ?? '{}', true);
if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST') {
    $in = json_decode(file_get_contents('php://input'), true) ?: [];
    $stmt = $pdo->prepare('INSERT INTO items (user_id, text) VALUES (?, ?)');
    $stmt->execute([$userId, $in['text'] ?? '']);
}
$rows = $pdo->query('SELECT id, user_id, text FROM items ORDER BY id')->fetchAll(PDO::FETCH_ASSOC);
echo json_encode(['userId' => $userId, 'spoof' => $spoof, 'roleId' => $ctx['roleId'] ?? null, 'items' => $rows]);
`,
  }, 'fl-multi-notes');

  // Enable FormLogic multi-user config flags
  const cfgPath = join(root, 'private/config.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  cfg.enableHostContext = true;
  cfg.containerPrimaryDatabase = 'application.sqlite';
  writeFileSync(cfgPath, JSON.stringify(cfg));

  const res = spawnSync(process.execPath, [join(root, 'runner.mjs')], {
    input: JSON.stringify({
      path: '/api/items',
      method: 'POST',
      queryString: '',
      headers: {
        'content-type': 'application/json',
        'x-formlogic-user-id': 'spoofed-admin',
        'x-formlogic-spoof': 'evil',
      },
      bodyBase64: Buffer.from(JSON.stringify({text: 'Hello FormLogic'})).toString('base64'),
      client_ip: '127.0.0.1',
    }),
    encoding: 'utf8',
    env: {
      ...process.env,
      SOFTN_BACKEND_ROOT: root,
      SOFTN_CONTAINER_ENGINES_DIR: containerEnginesDir,
      SOFTN_HOST_CONTEXT: JSON.stringify({userId: 'user-42', roleId: 'member', authenticated: true, appId: 'fl-multi-notes'}),
    },
  });
  assert.equal(res.status, 0, res.stderr);
  const parsed = JSON.parse(res.stdout);
  const body = JSON.parse(Buffer.from(parsed.bodyBase64, 'base64').toString('utf8'));
  assert.equal(body.userId, 'user-42');
  assert.equal(body.roleId, 'member');
  assert.equal(body.spoof, null);
  assert.equal(body.items.length, 1);
  assert.deepEqual(body.items[0], {id: 1, user_id: 'user-42', text: 'Hello FormLogic'});
  // Verify primary DB landed at private/data/application.sqlite for FormLogic Data manager & backups!
  assert.equal(existsSync(join(root, 'private/data/application.sqlite')), true);
});

test('caps :memory: SQLite handles and blocks private script/key/WAL static assets', {skip: !hasCoreWasm && 'ZIPP WASM engines not built'}, t => {
  const root = makeBackendFixture(t, {
    'manifest.json': JSON.stringify({
      engine: 2,
      id: 'mem-cap-app',
      name: 'Mem Cap App',
      version: '1.0.0',
      main: 'public/index.html',
      frontendRoot: 'public',
      backend: {runtime: 'javascript', entry: 'backend/api.js', mode: 'api', routes: ['/api/']},
    }),
    'public/index.html': '<!doctype html><h1>ok</h1>',
    'public/secret.pem': '-----BEGIN PRIVATE KEY-----',
    'public/app.sqlite-wal': 'wal-bytes',
    'public/alt.php8': '<?php echo "nope";',
    'backend/api.js': `
function handleRequest(req) {
  if (req.path === '/api/memcap') {
    var opened = [];
    var err = null;
    for (var i = 0; i < 8; i++) {
      try {
        opened.push(sqlite.open(':memory:'));
      } catch (e) {
        err = String(e.message || e);
        break;
      }
    }
    for (var j = 0; j < opened.length; j++) opened[j].close();
    return { status: 200, headers: [['Content-Type', 'application/json']], body: JSON.stringify({ opened: opened.length, err: err }) };
  }
  return { status: 404, body: 'not found' };
}
`,
  }, 'mem-cap-app');

  const cap = runRunner(root, {
    path: '/api/memcap',
    method: 'GET',
    queryString: '',
    headers: {},
    bodyBase64: '',
    client_ip: '127.0.0.1',
  });
  assert.equal(cap.status, 200, cap.bodyText);
  const data = JSON.parse(cap.bodyText);
  assert.equal(data.opened, 4);
  assert.match(String(data.err), /in-memory SQLite handle limit exceeded/i);

  for (const blockedPath of ['/secret.pem', '/app.sqlite-wal', '/alt.php8']) {
    const r = runRunner(root, {
      path: blockedPath,
      method: 'GET',
      queryString: '',
      headers: {},
      bodyBase64: '',
      client_ip: '127.0.0.1',
    });
    assert.equal(r.status, 404, `expected 404 for ${blockedPath}, got ${r.status}`);
  }
});
