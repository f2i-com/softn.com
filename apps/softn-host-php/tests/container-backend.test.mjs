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
import {isDeniedByHtaccess, htaccessRefusal} from '../runtime/container-backend.mjs';
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

const htaccessDenies = (source, path, method = 'GET') => isDeniedByHtaccess(new Map([['.htaccess', Buffer.from(source)]]), path, method);
const LOOKAHEAD_HTACCESS = '<FilesMatch "^(?!index\\.php$).*\\.php$">\n  Require all denied\n</FilesMatch>\n';
const DRUPAL_HTACCESS = [
  '<FilesMatch "\\.(engine|inc|install|make|module|profile|po|sh|.*sql|theme|twig|tpl(\\.php)?|xtmpl|yml)',
  '(~|\\.sw[op]|\\.bak|\\.orig|\\.save)?$|^(\\.(?!well-known).*|Entries.*|Repository|Root|Tag|Template|',
  'composer\\.(json|lock)|web\\.config|yarn\\.lock|package\\.json)$|^#.*#$|\\.php(~|\\.sw[op]|\\.bak|\\.orig|\\.save)$">\n',
  '  <IfModule mod_authz_core.c>\n    Require all denied\n  </IfModule>\n',
  '  <IfModule !mod_authz_core.c>\n    Order allow,deny\n    Deny from all\n  </IfModule>\n',
  '</FilesMatch>\n',
].join('');

// The same cases as the Rust host's htaccess_deny_inside_a_section_is_not_a_deny_for_the_directory,
// which reads .htaccess the same way.
test('an .htaccess deny inside a section is not a deny for the directory', () => {
  // Patterns this host does not compile: shaped like one that backtracks without end, or not a
  // regular expression. None of the blocks may take the entry script, or anything else, with it.
  // Nor may Drupal's stock rule, which compiles here (this host did not compile it when it held
  // a pattern to 256 characters) and not on the Rust host. (A pattern over 512 bytes is not read
  // either, and closes the directory instead: "the two hosts close a directory whose <Files>
  // pattern is too long".)
  const nested = '<FilesMatch "^(a+)+$">\nDeny from all\n</FilesMatch>\n';
  const invalid = '<FilesMatch "(">\nDeny from all\n</FilesMatch>\n';
  for (const source of [DRUPAL_HTACCESS, nested, invalid]) {
    for (const path of ['/index.php', '/', '/assets/app.css', '/api/notes', '/aaa']) {
      assert.equal(htaccessDenies(source, path), false, `${path} under ${source}`);
    }
  }
  assert.equal(htaccessDenies(DRUPAL_HTACCESS, '/core.module'), true, 'what Drupal names, it refuses here');
  // A look-ahead does compile here, and names every script but the entry.
  assert.equal(htaccessDenies(LOOKAHEAD_HTACCESS, '/index.php'), false);
  assert.equal(htaccessDenies(LOOKAHEAD_HTACCESS, '/admin.php'), true);
  // A header whose pattern holds a `<` or a `>` still opens a block. One that is not closed is
  // not a header Apache reads, and closes the directory ("the two hosts close a directory whose
  // section tags are malformed").
  const unclosedHeader = '<FilesMatch "\\.inc$"\nDeny from all\n</FilesMatch>\n';
  assert.equal(htaccessDenies(unclosedHeader, '/index.php'), true);
  assert.equal(htaccessDenies(unclosedHeader, '/db.inc'), true);
  const named = '<FilesMatch "\\.(?<ext>bak|old)$">\nDeny from all\n</FilesMatch>\n';
  assert.equal(htaccessDenies(named, '/index.php'), false);
  assert.equal(htaccessDenies(named, '/site.old'), true);

  // The block ends where it says, so what follows it is still read.
  const thenFiles = `${DRUPAL_HTACCESS}<Files "notes.txt">\nDeny from all\n</Files>\n`;
  assert.equal(htaccessDenies(thenFiles, '/notes.txt'), true);
  assert.equal(htaccessDenies(thenFiles, '/index.php'), false);
  assert.equal(htaccessDenies(`${DRUPAL_HTACCESS}Require all denied\n`, '/index.php'), true);

  // `<Files ~ "regex">` is the regular-expression form, and an opening tag may have spaces before
  // its `>` (a closing one may not: `</Files >` closes the directory).
  const tilde = '<Files ~ "^\\.ht|\\.bak$">\nDeny from all\n</Files>\n';
  assert.equal(htaccessDenies(tilde, '/old.BAK'), true);
  assert.equal(htaccessDenies(tilde, '/index.php'), false);
  const quoted = "<FilesMatch '\\.(inc|tpl)$' >\nRequire all denied\n</FilesMatch>\n<Files config.php>\nRequire all denied\n</Files>\n";
  assert.equal(htaccessDenies(quoted, '/lib/db.inc'), true);
  assert.equal(htaccessDenies(quoted, '/config.php'), true);
  assert.equal(htaccessDenies(quoted, '/index.php'), false);

  // Expression sections are not evaluated, so their denies are for nobody. A method section's
  // are for the methods it names ("the two hosts read .htaccess denies alike").
  const conditional = [
    '<LimitExcept GET POST>\n  Order deny,allow\n  Deny from all\n</LimitExcept>\n',
    '<Limit PUT DELETE>\n  Require all denied\n</Limit>\n',
    '<If "%{HTTP_HOST} == \'old.example\'">\n  Require all denied\n</If>\n',
    '<ElseIf "-R \'10.0.0.0/8\'">\n  Require all denied\n</ElseIf>\n',
    '<Else>\n  <Files "index.php">\n    Require all denied\n  </Files>\n</Else>\n',
    '<Files "admin.php">\n  <Limit POST>\n    Require all denied\n  </Limit>\n</Files>\n',
    '<Files "notes.txt">\n  Require all denied\n</Files>\n',
  ].join('');
  for (const path of ['/index.php', '/admin.php', '/assets/app.css']) {
    assert.equal(htaccessDenies(conditional, path, 'GET'), false, `GET ${path}`);
    assert.equal(htaccessDenies(conditional, path, 'PUT'), true, `PUT ${path}`);
  }
  assert.equal(htaccessDenies(conditional, '/index.php', 'POST'), false);
  assert.equal(htaccessDenies(conditional, '/admin.php', 'POST'), true);
  for (const method of ['GET', 'POST', 'PUT']) {
    assert.equal(htaccessDenies(conditional, '/notes.txt', method), true);
  }

  // <IfModule> bodies apply as written: the usual way to close a directory still does.
  const closed = '<IfModule mod_authz_core.c>\n  Require all denied\n</IfModule>\n<IfModule !mod_authz_core.c>\n  Deny from all\n</IfModule>\n';
  assert.equal(htaccessDenies(closed, '/index.php'), true);
  const inIfModule = '<IfModule mod_authz_core.c>\n  <Files "config.php">\n    Require all denied\n  </Files>\n</IfModule>\n';
  assert.equal(htaccessDenies(inIfModule, '/config.php'), true);
  assert.equal(htaccessDenies(inIfModule, '/index.php'), false);
});

// The same cases as the Rust host's the_two_hosts_read_htaccess_denies_alike: where the two
// differed.
test('the two hosts read .htaccess denies alike', () => {
  // Whether a request is refused under a bundle whose root .htaccess is `source` and whose
  // other files are `files`.
  const fileDenies = (source, files, method, path) =>
    isDeniedByHtaccess(new Map([['.htaccess', Buffer.from(source)], ...files.map(file => [file, Buffer.alloc(0)])]), path, method);
  const denies = (source, method, path) => fileDenies(source, [], method, path);

  // A directive is its words: in any case, with any run of spaces and tabs between. The Rust
  // host wanted single spaces; this one took `Deny from all.example.com` for a deny.
  for (const deny of ['deny  from\tall', 'DENY FROM ALL', 'Require\t\tall   denied', 'require all DENIED', '\t Deny from all \t', '\uFEFFDeny from all']) {
    assert.equal(denies(`${deny}\n`, 'GET', '/index.php'), true, JSON.stringify(deny));
    assert.equal(denies(`<Files "a.txt">\n${deny}\n</Files>\n`, 'GET', '/a.txt'), true, JSON.stringify(deny));
  }
  for (const other of ['Deny from all.example.com', 'Deny from allowed.example', 'Require all deniedx', 'Require all granted', 'Denyfrom all', '# Deny from all']) {
    assert.equal(denies(`${other}\n`, 'GET', '/index.php'), false, JSON.stringify(other));
  }

  // A rules file too large to read in full refuses everything under it. This host read none
  // of it and the Rust host its first 64 KiB: each let through what the rest refused.
  const padding = bytes => `#${'x'.repeat(bytes - 2)}\n`;
  const tooLarge = `${padding(64 * 1024)}Options -Indexes\n`;
  for (const path of ['/index.php', '/assets/app.css', '/']) {
    assert.equal(denies(tooLarge, 'GET', path), true, path);
  }
  const lastBlock = '<Files "z.txt">\nDeny from all\n</Files>\n';
  const largest = `${padding(64 * 1024 - lastBlock.length)}${lastBlock}`;
  assert.equal(Buffer.byteLength(largest), 64 * 1024);
  assert.equal(denies(largest, 'GET', '/index.php'), false);
  assert.equal(denies(largest, 'GET', '/z.txt'), true, 'a file that fits is read to its end');
  // By the file's size, not its text's: these bytes are three times as long read as text.
  const notUtf8 = Buffer.concat([Buffer.from('Options -Indexes\n'), Buffer.alloc(30 * 1024, 0xff)]);
  assert.equal(fileDenies(notUtf8, [], 'GET', '/index.php'), false);

  // A <Files> block names the file a request is mapped to: the last segment, and a segment
  // before it that is a file (the rest is its PATH_INFO). This host tested only the last.
  const inc = '<FilesMatch "\\.inc$">\nRequire all denied\n</FilesMatch>\n';
  const under = path => fileDenies(inc, ['index.php', 'db.inc', 'lib/db.inc'], 'GET', path);
  for (const path of ['/db.inc', '/lib/db.inc', '/nowhere/x.inc', '/db.inc/anything', '/lib/db.inc/a/b']) {
    assert.equal(under(path), true, path);
  }
  // `/missing.inc` is not a file, so not what the request is mapped to.
  for (const path of ['/missing.inc/anything', '/index.php/anything', '/lib/other']) {
    assert.equal(under(path), false, path);
  }

  // A deny inside <Limit>/<LimitExcept> is for the methods the section names. Both hosts
  // dropped it, and then it was for nobody.
  const except = '<LimitExcept GET POST>\n  Order deny,allow\n  Deny from all\n</LimitExcept>\n';
  for (const [method, refused] of [['GET', false], ['HEAD', false], ['POST', false], ['get', false], ['PUT', true], ['DELETE', true], ['PROPFIND', true]]) {
    assert.equal(denies(except, method, '/index.php'), refused, method);
  }
  const only = '<Limit PUT DELETE>\n  Require all denied\n</Limit>\n';
  for (const [method, refused] of [['PUT', true], ['DELETE', true], ['delete', true], ['GET', false], ['POST', false]]) {
    assert.equal(denies(only, method, '/index.php'), refused, method);
  }
  // To Apache HEAD is GET, and a method's name is matched by case.
  const get = '<Limit GET>\nDeny from all\n</Limit>\n';
  assert.deepEqual(['GET', 'HEAD', 'POST'].map(method => denies(get, method, '/')), [true, true, false]);
  const head = '<LimitExcept HEAD>\nDeny from all\n</LimitExcept>\n';
  assert.deepEqual(['GET', 'HEAD', 'POST'].map(method => denies(head, method, '/')), [false, false, true]);
  assert.equal(denies('<Limit get>\nDeny from all\n</Limit>\n', 'GET', '/'), false);
  assert.equal(denies('<LimitExcept get>\nDeny from all\n</LimitExcept>\n', 'GET', '/'), true);
  // Inside a block, and with the block's own deny beside it.
  const admin = '<Files "admin.php">\n  <Limit POST>\n    Require all denied\n  </Limit>\n</Files>\n<Limit PUT>\nDeny from all\n</Limit>\n<Files "x.txt">\nDeny from all\n</Files>\n';
  assert.deepEqual(
    [['POST', '/admin.php'], ['GET', '/admin.php'], ['POST', '/index.php'], ['PUT', '/index.php'], ['GET', '/x.txt'], ['GET', '/index.php']].map(([method, path]) => denies(admin, method, path)),
    [true, false, false, true, true, false]
  );
  // What Apache would not load is read the safe way: for every method.
  const nested = '<Limit POST>\n<LimitExcept GET>\nDeny from all\n</LimitExcept>\n</Limit>\n';
  assert.deepEqual(['GET', 'POST'].map(method => denies(nested, method, '/')), [true, true]);
  assert.equal(denies('<Limit>\nDeny from all\n</Limit>\n', 'GET', '/'), true);
  // A method section under an expression section is skipped with it, as before.
  assert.equal(denies('<If "true">\n<Limit GET>\nDeny from all\n</Limit>\n</If>\n', 'GET', '/'), false);
  // A caller that does not say how the request was made is refused what any method is.
  assert.equal(isDeniedByHtaccess(new Map([['.htaccess', Buffer.from(only)]]), '/index.php'), true);

  // More denies than are kept close the directory. The Rust host dropped the ones past the
  // sixty-fourth; this one kept them all.
  const blocks = count =>
    Array.from({length: count}, (_, n) => `<Files "f${n}.txt">\n<IfModule a>\nRequire all denied\n</IfModule>\n<IfModule !a>\nDeny from all\n</IfModule>\n</Files>\n`).join('');
  assert.equal(denies(blocks(64), 'GET', '/index.php'), false, 'said twice in a block is one deny');
  assert.equal(denies(blocks(64), 'GET', '/f63.txt'), true);
  assert.equal(denies(blocks(65), 'GET', '/index.php'), true);
  assert.equal(denies(`${blocks(64)}Require all denied\n`, 'GET', '/assets/app.css'), true);

  // A request for a directory is under that directory's own rules, as one for a file in it
  // is. This host read them only for what lay below the directory.
  const closedDir = new Map([['admin/.htaccess', Buffer.from('Require all denied\n')], ['admin/index.php', Buffer.alloc(0)]]);
  for (const path of ['/admin', '/admin/', '/admin/index.php', '/admin/missing']) {
    assert.equal(isDeniedByHtaccess(closedDir, path, 'GET'), true, path);
  }
  assert.equal(isDeniedByHtaccess(closedDir, '/', 'GET'), false);
  assert.equal(isDeniedByHtaccess(closedDir, '/administrator', 'GET'), false);
});

// The status a request is refused with under a bundle whose .htaccess files are `htaccess`
// (each a directory and its text) and whose other files are `files`, or 0 when it is not.
function refusalUnder(htaccess, files, {method = 'GET', path, query = '', host = 'localhost', headers = {}}) {
  const vfs = new Map([
    ...Object.entries(htaccess).map(([dir, text]) => [dir ? `${dir}/.htaccess` : '.htaccess', Buffer.from(text)]),
    ...files.map(file => [file, Buffer.alloc(0)]),
  ]);
  return htaccessRefusal(vfs, path, {method, query, host, https: false, headers});
}

// The same cases as the Rust host's the_two_hosts_refuse_what_redirect_match_and_rewrite_rules_refuse.
// This host enforced neither: a request the Rust host refused was run here.
test('the two hosts refuse what RedirectMatch and RewriteRule refuse', () => {
  const files = ['index.php', 'lib/db.inc', 'lib/util.php'];
  const refused = (htaccess, request) => refusalUnder(htaccess, files, request);
  const get = (source, path, query = '') => refused({'': source}, {path, query});

  // A RedirectMatch to a status of 400 or more refuses what it matches with that status. It
  // matches the whole path, by case, for any method.
  const statuses = [
    'RedirectMatch 403 ^/secret/',
    'RedirectMatch 404 ^/includes/',
    'RedirectMatch gone ^/old\\.php$',
    'RedirectMatch 401 ^/members',
    'RedirectMatch 451 ^/withheld',
    'RedirectMatch 503 ^/down$',
    'RedirectMatch 403 ^/Cased',
  ].join('\n');
  for (const [path, status] of [
    ['/secret/key', 403], ['/secret', 0], ['/includes/config.php', 404], ['/old.php', 410], ['/members/list', 401],
    ['/withheld', 451], ['/down', 503], ['/down/x', 0], ['/Cased', 403], ['/cased', 0], ['/index.php', 0],
  ]) {
    assert.equal(get(statuses, path), status, path);
  }
  assert.equal(refused({'': statuses}, {method: 'POST', path: '/secret/key'}), 403);
  // One that sends the request elsewhere first is the answer; one without a target is passed over.
  const order = 'RedirectMatch 301 ^/moved/(.*)$ /new/$1\nRedirectMatch 403 ^/moved/\nRedirectMatch 302 ^/bare\nRedirectMatch 403 ^/bare\n';
  assert.equal(get(order, '/moved/x'), 0);
  assert.equal(get(order, '/bare'), 403);
  // A status of 400 or more refuses with a target too; `seeother` is a redirect (303).
  assert.equal(get('RedirectMatch 401 ^/members /login\n', '/members/x'), 401);
  assert.equal(get('RedirectMatch seeother ^/x /y\nRedirectMatch 403 ^/x\n', '/x'), 0);
  // Not read inside a block, a method section or an expression section; read inside <IfModule>.
  const sections = [
    '<Files "x.txt">\nRedirectMatch 403 ^/\n</Files>\n',
    '<Limit GET>\nRedirectMatch 403 ^/\n</Limit>\n',
    '<If "true">\nRedirectMatch 403 ^/\n</If>\n',
    '<IfModule mod_alias.c>\nRedirectMatch 404 ^/hidden/\n</IfModule>\n',
  ].join('');
  assert.deepEqual(['/x.txt', '/index.php', '/hidden/a'].map(path => get(sections, path)), [0, 0, 404]);
  // A directory's own, for the directory and what is under it, by the whole path.
  const admin = {admin: 'RedirectMatch 403 ^/admin/?$\nRedirectMatch 404 ^/admin/private/\n'};
  assert.deepEqual(
    ['/admin', '/admin/', '/admin/private/x', '/admin/ok.php', '/private/x'].map(path => refused(admin, {path})),
    [403, 403, 404, 0, 0]
  );

  // `RewriteRule … [F]` refuses with 403 and `[G]` with 410, where the rewrite engine is on,
  // the rules before it let the request get that far, and its conditions hold.
  const rules = [
    'RewriteEngine On',
    'RewriteRule ^index\\.php$ - [L]',
    'RewriteRule ^admin/ - [F]',
    'RewriteRule ^ADMIN2 - [F,NC]',
    'RewriteRule ^old\\.html$ - [G]',
    'RewriteCond %{REQUEST_METHOD} =POST',
    'RewriteRule ^api/ - [F]',
    'RewriteCond %{QUERY_STRING} (^|&)debug=',
    'RewriteRule ^ - [F]',
  ].join('\n');
  for (const [path, query, status] of [
    ['/admin/x', '', 403], ['/admin2', '', 403], ['/old.html', '', 410], ['/api/notes', '', 0],
    ['/page', 'debug=1', 403], ['/page', 'a=1&debug', 0], ['/page', '', 0], ['/index.php', 'debug=1', 0], ['/other', '', 0],
  ]) {
    assert.equal(get(rules, path, query), status, `${path}?${query}`);
  }
  assert.equal(refused({'': rules}, {method: 'POST', path: '/api/notes'}), 403);
  // With the engine off, at the end of the file or never turned on, no rule is run.
  assert.equal(get('RewriteEngine On\nRewriteRule ^ - [F]\nRewriteEngine Off\n', '/x'), 0);
  assert.equal(get('RewriteRule ^ - [F]\n', '/x'), 0);

  // A request the rules rewrite is refused for where it is rewritten to: by a later rule, a
  // <FilesMatch> or a RedirectMatch. One they send elsewhere first is not refused.
  const rewrites = [
    'RewriteEngine On',
    'RewriteRule ^go$ /elsewhere [R=301,L]',
    'RewriteRule ^go$ - [F]',
    'RewriteRule ^old/(.*)$ new/$1',
    'RewriteRule ^new/secret - [F]',
    'RewriteRule ^config$ lib/db.inc [L]',
    'RewriteRule ^hide/(.*)$ /hidden/$1 [L]',
    '<FilesMatch "\\.inc$">\nRequire all denied\n</FilesMatch>',
    'RedirectMatch 404 ^/hidden/',
  ].join('\n');
  assert.deepEqual(['/go', '/old/secret', '/old/public', '/config', '/hide/a'].map(path => get(rewrites, path)), [0, 403, 0, 403, 404]);

  // Conditions on the bundle's files and directories, the host and the request's headers, with
  // [OR] and [NC]. The Cookie header is never read into one.
  const conditions = [
    'RewriteEngine On',
    'RewriteCond %{REQUEST_FILENAME} !-f',
    'RewriteRule \\.php$ - [F]',
    'RewriteCond %{REQUEST_FILENAME} -d',
    'RewriteRule ^ - [G]',
    'RewriteCond %{HTTP_HOST} ^old\\. [NC,OR]',
    'RewriteCond %{HTTP:X-Legacy} ^1$',
    'RewriteRule ^ - [F]',
    'RewriteCond %{HTTP:Cookie} session',
    'RewriteRule ^ - [F]',
  ].join('\n');
  const asked = request => refused({'': conditions}, request);
  assert.equal(asked({path: '/missing.php'}), 403);
  assert.equal(asked({path: '/index.php'}), 0);
  assert.equal(asked({path: '/lib/util.php'}), 0);
  assert.equal(asked({path: '/lib'}), 410);
  assert.equal(asked({path: '/page', host: 'Old.example.com'}), 403);
  assert.equal(asked({path: '/page', headers: {'x-legacy': '1'}}), 403);
  assert.equal(asked({path: '/page', headers: {cookie: 'session=abc'}}), 0);
  assert.equal(asked({path: '/page'}), 0);

  // A directory's rules are for what is under it, matched without its name.
  const sub = {admin: 'RewriteEngine On\nRewriteRule ^secret - [F]\n'};
  assert.deepEqual(['/admin/secret.txt', '/secret.txt', '/admin', '/admin/x/secret'].map(path => refused(sub, {path})), [403, 0, 0, 0]);
  // Not read inside a method section; a rule whose pattern does not compile is not read, and
  // the conditions before it go with it.
  assert.equal(refused({'': 'RewriteEngine On\n<Limit POST>\nRewriteRule ^ - [F]\n</Limit>\n'}, {method: 'POST', path: '/x'}), 0);
  const invalid = 'RewriteEngine On\nRewriteCond %{REQUEST_METHOD} =GET\nRewriteRule ( - [F]\nRewriteRule ^blocked - [F]\n';
  assert.equal(refused({'': invalid}, {method: 'POST', path: '/blocked'}), 403);
  assert.equal(get(invalid, '/x'), 0);
});

// The same cases as the Rust host's the_two_hosts_close_a_directory_with_more_rules_than_are_kept.
// The Rust host dropped the lines past the count, and any of them could have refused a request,
// or kept one from a rule that would have.
test('the two hosts close a directory with more rules than are kept', () => {
  const get = (source, path) => refusalUnder({'': source}, ['index.php'], {path});
  const lines = (count, line) => Array.from({length: count}, (_, n) => `${line(n)}\n`).join('');

  // 256 RewriteRule lines are read, the last of them too; a 257th closes the directory.
  const rules = count => `RewriteEngine On\n${lines(count, n => `RewriteRule ^r${n}$ /x${n}`)}RewriteRule ^admin - [F]\n`;
  assert.equal(get(rules(255), '/admin'), 403);
  assert.equal(get(rules(255), '/index.php'), 0);
  for (const path of ['/admin', '/index.php', '/assets/app.css']) {
    assert.equal(get(rules(256), path), 403, path);
  }
  // So do 257 RedirectMatch lines.
  const redirects = count => `${lines(count, n => `RedirectMatch 301 ^/r${n}$ /x${n}`)}RedirectMatch 403 ^/secret\n`;
  assert.equal(get(redirects(255), '/secret'), 403);
  assert.equal(get(redirects(255), '/index.php'), 0);
  assert.equal(get(redirects(256), '/secret'), 403);
  assert.equal(get(redirects(256), '/index.php'), 403);
  // And 65 RewriteCond lines before one rule (64 are read). The one past the count, here the
  // last, would have kept `/public` from the pass-through and so for the [F] after it.
  const conds = (count, then) =>
    `RewriteEngine On\n${lines(count, n => `RewriteCond %{HTTP_HOST} !^nowhere${n}$`)}${then}RewriteRule ^public - [L]\nRewriteRule ^ - [F]\n`;
  assert.equal(get(conds(64, ''), '/public'), 0);
  assert.equal(get(conds(64, ''), '/other'), 403);
  assert.equal(get(conds(64, 'RewriteCond %{HTTP_HOST} =nowhere\n'), '/public'), 403);
  assert.equal(get(conds(65, ''), '/public'), 403);
  // Lines that are not read (in an expression section) are not counted.
  const skipped = `RewriteEngine On\n<If "true">\n${lines(300, n => `RewriteRule ^r${n}$ /x${n}`)}</If>\nRewriteRule ^admin - [F]\n`;
  assert.equal(get(skipped, '/admin'), 403);
  assert.equal(get(skipped, '/index.php'), 0);
});

// The same cases as the Rust host's the_two_hosts_close_a_directory_whose_sections_do_not_match_up.
// Apache will not load such a file and answers 500 for everything under it; both hosts read as
// far as it went, so a block left open denied nothing, and what followed a stray closing tag
// was read as though it were outside the section.
test('the two hosts close a directory whose sections do not match up', () => {
  const get = (source, path) => refusalUnder({'': source}, ['index.php'], {path});
  // Left open at the end of the file: a block, a method section, <IfModule>, <If>.
  for (const source of [
    '<Files "secret.txt">\nRequire all denied\n',
    '<FilesMatch "\\.inc$">\nDeny from all\n',
    '<Files "a.txt">\nRequire all denied\nRewriteEngine On\nRewriteRule ^admin - [F]\n',
    '<Limit POST>\nRequire all denied\n',
    '<IfModule mod_rewrite.c>\nRewriteEngine On\n',
    '<If "true">\nRequire all denied\n',
    '<IfModule a>\n<Files "x.txt">\nRequire all denied\n</Files>\n',
  ]) {
    for (const path of ['/index.php', '/secret.txt', '/assets/app.css', '/']) {
      assert.equal(get(source, path), 403, `${path} under ${JSON.stringify(source)}`);
    }
  }
  // Closed where it is not the innermost open section, or not open at all.
  for (const source of [
    '</Files>\nOptions -Indexes\n',
    '<Files "a.txt">\nRequire all denied\n</FilesMatch>\n',
    '<IfModule a>\n<Files "x">\n</IfModule>\n</Files>\n',
    '<Limit POST>\n</LimitExcept>\n',
    '<If "true">\n</If>\n</If>\n',
  ]) {
    assert.equal(get(source, '/index.php'), 403, JSON.stringify(source));
  }
  // Sections that match up are read as before, whatever the case of their names.
  const nested = '<IfModule a>\n<Files "x.txt">\nRequire all denied\n</Files>\n</IfModule>\n';
  assert.deepEqual([get(nested, '/x.txt'), get(nested, '/index.php')], [403, 0]);
  const cased = '<files "x.txt">\nRequire all denied\n</FILES>\n';
  assert.deepEqual([get(cased, '/x.txt'), get(cased, '/index.php')], [403, 0]);
  assert.equal(get('# <Files "x.txt">\nOptions -Indexes\n', '/index.php'), 0);
});

// The status a request is refused with under a bundle of index.php, lib/db.inc and lib/util.php
// whose .htaccess files are `htaccess`, or 0.
const refusalOf = (htaccess, request) => refusalUnder(htaccess, ['index.php', 'lib/db.inc', 'lib/util.php'], request);

// The same cases as the Rust host's the_two_hosts_read_negated_rule_patterns_as_apache_does, and
// the browser's reader's (packages/@softn/container/test/htaccess-and-vnav.test.ts). All three
// took the `!` of `RewriteRule !pattern` for part of the pattern, so `RewriteRule !^public/ - [F]`
// matched nothing and forbade nothing.
test('the two hosts read negated rule patterns as Apache does', () => {
  const get = (source, path) => refusalOf({'': source}, {path});

  // `RewriteRule !pattern` is for a path the pattern does not match, by case unless [NC].
  const outside = 'RewriteEngine On\nRewriteRule !^public/ - [F]\n';
  assert.deepEqual(
    ['/public/app.css', '/public/', '/index.php', '/public', '/', '/x/public/a', '/PUBLIC/a'].map(path => get(outside, path)),
    [0, 0, 403, 403, 403, 403, 403]
  );
  assert.deepEqual(['/PUBLIC/a', '/Other'].map(path => get('RewriteEngine On\nRewriteRule !^public/ - [F,NC]\n', path)), [0, 403]);
  assert.deepEqual(['/keep.html', '/x'].map(path => get('RewriteEngine On\nRewriteRule !^keep\\.html$ - [G]\n', path)), [0, 410]);
  // An empty pattern matches every path, so its negation none.
  assert.equal(get('RewriteEngine On\nRewriteRule ! - [F]\n', '/x'), 0);
  // A directory's, for what is under it, matched without its name.
  const admin = {admin: 'RewriteEngine On\nRewriteRule !^login\\.php$ - [F]\n'};
  assert.deepEqual(['/admin/login.php', '/admin/users', '/admin', '/index.php'].map(path => refusalOf(admin, {path})), [0, 403, 403, 0]);
  // Its conditions must hold, as for any rule.
  const posted = {'': 'RewriteEngine On\nRewriteCond %{REQUEST_METHOD} =POST\nRewriteRule !^api/ - [F]\n'};
  assert.deepEqual(
    [['POST', '/x'], ['POST', '/api/notes'], ['GET', '/x']].map(([method, path]) => refusalOf(posted, {method, path})),
    [403, 0, 0]
  );
  // `$1`…`$9` are empty, as the pattern matched nothing: `/x` is rewritten to `/gone/`.
  const groups = 'RewriteEngine On\nRewriteRule !^(public)/(.*)$ /gone/$2 [L]\nRedirectMatch 410 ^/gone/$\n';
  assert.deepEqual(['/x', '/public/a'].map(path => get(groups, path)), [410, 0]);
});

// The same cases as the Rust host's the_two_hosts_read_negated_conditions_and_redirect_match_as_apache_does,
// and the browser's reader's. All three read these so already.
test('the two hosts read negated conditions and RedirectMatch as Apache does', () => {
  const get = (source, path) => refusalOf({'': source}, {path});

  // RedirectMatch has no negated form: a leading `!` is part of its pattern, as Apache reads it,
  // so `!^/public/` matches nothing.
  const redirects = 'RedirectMatch 403 !^/public/\nRedirectMatch 404 !private\n';
  assert.deepEqual(['/x', '/public/a', '/private', '/a!private'].map(path => get(redirects, path)), [0, 0, 0, 404]);

  // `RewriteCond … !CondPattern` holds where the pattern does not: a pattern, `=text` (by case
  // unless [NC]) or a file test, alone or in an [OR] run.
  const conds = {'': 'RewriteEngine On\nRewriteCond %{REQUEST_URI} !^/public/\nRewriteCond %{HTTP_HOST} !=static.example [NC]\nRewriteRule ^ - [F]\n'};
  assert.deepEqual(
    [['/public/x', 'localhost'], ['/other', 'localhost'], ['/other', 'STATIC.example'], ['/other', 'static.example.com']].map(([path, host]) => refusalOf(conds, {path, host})),
    [0, 403, 0, 403]
  );
  assert.deepEqual(['/lib', '/lib.txt'].map(path => get('RewriteEngine On\nRewriteCond %{REQUEST_FILENAME} !-d\nRewriteRule ^lib - [F]\n', path)), [0, 403]);
  const either = {'': 'RewriteEngine On\nRewriteCond %{HTTP_HOST} ^admin\\. [OR]\nRewriteCond %{QUERY_STRING} !(^|&)token=\nRewriteRule ^panel - [F]\n'};
  assert.deepEqual(
    [['', 'localhost'], ['token=1', 'localhost'], ['token=1', 'admin.example']].map(([query, host]) => refusalOf(either, {path: '/panel', query, host})),
    [403, 0, 403]
  );
  // A negated condition gives `%1`…`%9` nothing, even where its pattern matched: `%1` here is the
  // first condition's `secret`, not the second's `public`.
  const backrefs = {
    '': [
      'RewriteEngine On',
      'RewriteCond %{QUERY_STRING} ^to=([a-z]+)$',
      'RewriteCond %{HTTP_HOST} !^(public)\\. [OR]',
      'RewriteCond %{REQUEST_METHOD} =GET',
      'RewriteRule ^go$ /%1 [L]',
      'RewriteRule ^secret$ - [F]',
    ].join('\n'),
  };
  assert.deepEqual(
    [['to=secret', 'public.example'], ['to=secret', 'localhost'], ['to=public', 'public.example']].map(([query, host]) => refusalOf(backrefs, {path: '/go', query, host})),
    [403, 403, 0]
  );
});

// The same cases as the Rust host's the_two_hosts_close_a_directory_whose_section_tags_are_malformed,
// and the browser's reader's. Apache will not load a file with a section tag like these and answers
// 500 for everything under the directory; all three readers took `</Files >` and
// `<Files "secret.txt"` for the tags they look like.
test('the two hosts close a directory whose section tags are malformed', () => {
  const get = (source, path) => refusalUnder({'': source}, ['index.php'], {path});
  const malformed = [
    // An opening tag without its `>`, one with a `>` among its arguments and none at the end, one
    // whose name runs into its argument, and one in a section not evaluated.
    '<Files "secret.txt"\nRequire all denied\n</Files>\n',
    '<FilesMatch "\\.inc$"\nDeny from all\n</FilesMatch>\n',
    '<IfModule mod_rewrite.c\nRewriteEngine On\n</IfModule>\n',
    '<IfVersion >= 2.4\n</IfVersion>\n',
    '<Files"secret.txt">\nRequire all denied\n</Files>\n',
    '<If "true">\n<Files "secret.txt"\n</Files>\n</If>\n',
    // A closing tag that is not `</Name>`: a space before its `>`, no `>`, a space after its `<`.
    '<Files "secret.txt">\nRequire all denied\n</Files >\n',
    '<Files "secret.txt">\nRequire all denied\n</Files\n',
    '<IfModule a>\n</IfModule >\n',
    '</ Files>\nOptions -Indexes\n',
    // Words after a tag's `>`. Apache passes over them after some tags and not others; here a
    // tag is its whole line.
    '<Files "secret.txt"> # private\nRequire all denied\n</Files>\n',
    '<Files "secret.txt">\nRequire all denied\n</Files> # private\n',
  ];
  const readAnyway = malformed.filter(source => ['/index.php', '/secret.txt', '/assets/app.css', '/'].some(path => get(source, path) !== 403));
  assert.deepEqual(readAnyway, [], 'not refused everything under these');
  // Spaces before an opening tag's `>`, a tab after its name, a `>` among its arguments or in its
  // pattern, and a name with its `>` alone, are tags Apache reads, and so are they here.
  for (const source of [
    '<Files "secret.txt" >\nRequire all denied\n</Files>\n',
    '<Files\t"secret.txt">\nRequire all denied\n</Files>\n',
    '<IfVersion >= 2.4>\n<Files "secret.txt">\nRequire all denied\n</Files>\n</IfVersion>\n',
    '<FilesMatch "^secret>?\\.txt$">\nRequire all denied\n</FilesMatch>\n',
    '<If "true">\n</If>\n<Else>\nRequire all denied\n</Else>\n<Files "secret.txt">\nRequire all denied\n</Files>\n',
  ]) {
    assert.deepEqual([get(source, '/secret.txt'), get(source, '/index.php')], [403, 0], JSON.stringify(source));
  }
});

// The same cases as the Rust host's the_two_hosts_close_a_directory_whose_files_pattern_is_too_long,
// and the browser's reader's. A <FilesMatch> or <Files ~> pattern was held to 256 characters here,
// 1024 bytes on the Rust host and 512 characters in the browser, and a <Files> name to 256
// characters here and bytes there, and one past the limit denied nothing.
test('the two hosts close a directory whose <Files> pattern is too long', () => {
  const get = (source, path) => refusalUnder({'': source}, ['index.php'], {path});
  const regexOf = padding => `^secret\\.txt$|^${padding}$`;
  const filesMatch = pattern => `<FilesMatch "${pattern}">\nRequire all denied\n</FilesMatch>\n`;
  const tilde = pattern => `<Files ~ "${pattern}">\nRequire all denied\n</Files>\n`;
  const files = name => `<Files "${name}">\nRequire all denied\n</Files>\n`;
  // 512 bytes, in ASCII and in two-byte characters, and a byte more.
  const [fits, fitsShort] = [regexOf('a'.repeat(496)), regexOf('é'.repeat(248))];
  const [over, overShort] = [regexOf('a'.repeat(497)), regexOf(`a${'é'.repeat(248)}`)];
  const [name, nameShort] = [`${'a'.repeat(508)}.txt`, `${'é'.repeat(254)}.txt`];
  const [longName, longNameShort] = [`${'a'.repeat(509)}.txt`, `a${'é'.repeat(254)}.txt`];
  assert.deepEqual(
    [fits, fitsShort, over, overShort, name, nameShort, longName, longNameShort].map(pattern => [Buffer.byteLength(pattern), pattern.length]),
    [[512, 512], [512, 264], [513, 513], [513, 265], [512, 512], [512, 258], [513, 513], [513, 259]]
  );

  // A pattern of 512 bytes is read: it names what it names, and nothing else.
  const read = [
    ['<FilesMatch> of 512 bytes', filesMatch(fits), '/secret.txt'],
    ['<FilesMatch> of 512 bytes in 264 characters', filesMatch(fitsShort), '/secret.txt'],
    ['<Files ~> of 512 bytes', tilde(fits), '/secret.txt'],
    ['<Files ~> of 512 bytes in 264 characters', tilde(fitsShort), '/secret.txt'],
    ['<Files> of 512 bytes', files(name), `/${name}`],
    ['<Files> of 512 bytes in 258 characters', files(nameShort), `/${nameShort}`],
  ];
  const misread = read.filter(([, source, named]) => get(source, named) !== 403 || get(source, '/index.php') !== 0).map(([label]) => label);

  // One a byte longer, or far longer, refuses everything under the directory.
  const closing = [
    ['<FilesMatch> of 513 bytes', filesMatch(over)],
    ['<FilesMatch> of 513 bytes in 265 characters', filesMatch(overShort)],
    ['<FilesMatch> of 2000 bytes', filesMatch('a'.repeat(2000))],
    ['<Files ~> of 513 bytes', tilde(over)],
    ['<Files ~> of 513 bytes in 265 characters', tilde(overShort)],
    ['<Files> of 513 bytes', files(longName)],
    ['<Files> of 513 bytes in 259 characters', files(longNameShort)],
  ];
  const readAnyway = closing
    .filter(([, source]) => ['/index.php', '/secret.txt', '/assets/app.css', '/'].some(path => get(source, path) !== 403))
    .map(([label]) => label);
  // Those not read as written, and those not refused everything under.
  assert.deepEqual({misread, readAnyway}, {misread: [], readAnyway: []});

  // Not read in a section that is not evaluated, and so not held to the limit.
  assert.equal(get(`<If "true">\n${filesMatch('a'.repeat(2000))}</If>\n`, '/index.php'), 0);
});

// Drupal's stock <FilesMatch>, which the Rust host cannot compile and this host did not while it
// held a pattern to 256 characters, takes neither the entry script nor the block after it with it.
test("a PHP bundle with Drupal's stock FilesMatch still answers", {skip: (!hasCoreWasm || !hasPhpWasm) && 'ZIPP WASM engines not built'}, t => {
  const root = makeBackendFixture(t, {
    'manifest.json': JSON.stringify({
      engine: 2,
      id: 'php-htaccess',
      name: 'PHP htaccess',
      version: '1.0.0',
      main: 'public/index.html',
      frontendRoot: 'public',
      backend: {runtime: 'php', entry: 'index.php', mode: 'api', routes: ['/api/']},
    }),
    'public/index.html': '<!doctype html><h1>ok</h1>',
    '.htaccess': `${DRUPAL_HTACCESS}<Files "closed.php">\n  Require all denied\n</Files>\n`,
    'index.php': "<?php header('Content-Type: text/plain'); echo 'entry';",
    'closed.php': "<?php echo 'closed';",
  }, 'php-htaccess');
  const get = path => runRunner(root, {path, method: 'GET', queryString: '', headers: {}, bodyBase64: '', client_ip: '127.0.0.1'});
  const entry = get('/api/hello');
  assert.equal(entry.status, 200, entry.bodyText);
  assert.equal(entry.bodyText, 'entry');
  assert.equal(get('/closed.php').status, 403);
  assert.equal(get('/closed').status, 403);
});

// The refusals of "the two hosts refuse what RedirectMatch and RewriteRule refuse", through the
// runner: the query and the headers reach the conditions, and each refusal is answered with its
// own status. The entry script used to answer all of these.
test('a PHP bundle is refused what its RewriteRule and RedirectMatch refuse', {skip: (!hasCoreWasm || !hasPhpWasm) && 'ZIPP WASM engines not built'}, t => {
  const root = makeBackendFixture(t, {
    'manifest.json': JSON.stringify({
      engine: 2,
      id: 'php-rewrite-refusals',
      name: 'PHP rewrite refusals',
      version: '1.0.0',
      main: 'public/index.html',
      frontendRoot: 'public',
      backend: {runtime: 'php', entry: 'index.php', mode: 'api', routes: ['/api/']},
    }),
    'public/index.html': '<!doctype html><h1>ok</h1>',
    '.htaccess': [
      'RewriteEngine On',
      'RewriteCond %{QUERY_STRING} (^|&)debug=',
      'RewriteRule ^ - [F]',
      'RewriteCond %{HTTP:X-Legacy} ^1$',
      'RewriteRule ^api/ - [G]',
      'RedirectMatch 404 ^/api/hidden/',
      'RedirectMatch 451 ^/api/withheld$',
    ].join('\n'),
    'index.php': "<?php header('Content-Type: text/plain'); echo 'entry';",
  }, 'php-rewrite-refusals');
  const ask = (path, queryString = '', headers = {}) =>
    runRunner(root, {path, method: 'GET', queryString, headers, bodyBase64: '', client_ip: '127.0.0.1'});
  const entry = ask('/api/hello', 'debugging=1');
  assert.equal(entry.status, 200, entry.bodyText);
  assert.equal(entry.bodyText, 'entry');
  for (const [answer, status, code] of [
    [ask('/api/hello', 'debug=1'), 403, 'forbidden'],
    [ask('/api/hello', '', {'x-legacy': '1'}), 410, 'gone'],
    [ask('/api/hidden/x'), 404, 'not_found'],
    [ask('/api/withheld'), 451, 'refused'],
  ]) {
    assert.equal(answer.status, status, answer.bodyText);
    assert.equal(JSON.parse(answer.bodyText).code, code);
  }
});

test('a <Files> wildcard is matched in time its length bounds, not by backtracking', () => {
  // As a backtracking RegExp, `*a*a*a*a*b` took over a minute against one 400-character segment of
  // a path, which anybody may send. The wildcard keeps its meaning: `*` any run, `?` one character,
  // by any case.
  const rules = '<Files "*.ini">\n  Require all denied\n</Files>\n<Files "secret?.txt">\n  Require all denied\n</Files>\n';
  assert.equal(htaccessDenies(rules, '/config.ini'), true);
  assert.equal(htaccessDenies(rules, '/conf/CONFIG.INI'), true, 'by any case');
  assert.equal(htaccessDenies(rules, '/config.ini.txt'), false, 'a wildcard name is matched whole');
  assert.equal(htaccessDenies(rules, '/secret1.txt'), true);
  assert.equal(htaccessDenies(rules, '/secret12.txt'), false, '? is one character');
  assert.equal(htaccessDenies(rules, '/secret.txt'), false);
  const slow = '<Files "*a*a*a*a*b">\n  Require all denied\n</Files>\n';
  const started = Date.now();
  assert.equal(htaccessDenies(slow, '/' + 'a'.repeat(400)), false);
  assert.equal(htaccessDenies(slow, '/' + 'a'.repeat(400) + 'b'), true);
  assert.ok(Date.now() - started < 1000, `answered in ${Date.now() - started} ms`);
});

// ZIPP's PHP takes each character of a string it is handed as one byte, and hands each byte of
// one back as a character. A script reads what was sent as it was sent, and its headers go out as
// it wrote them, on both hosts (the Rust host's `a_php_script_reads_text_and_bytes_as_they_were_sent`
// and `a_php_scripts_headers_are_sent_as_it_wrote_them`, and the browser's container): handed as
// text, "José" reached a script as "Jos\xE9", a JSON body with any character past ASCII did not
// decode, U+672C became a comma, a binary upload was mangled, and a download named café.txt was
// saved as cafÃ©.txt. A form body is read by the engine, as PHP reads one (`tags[]` an array).
test('a PHP script reads text and bytes as they were sent, and its headers go out as it wrote them', {skip: (!hasCoreWasm || !hasPhpWasm) && 'ZIPP WASM engines not built'}, t => {
  const root = makeBackendFixture(t, {
    'manifest.json': JSON.stringify({
      engine: 2,
      id: 'php-bytes',
      name: 'PHP bytes',
      version: '1.0.0',
      main: 'public/index.html',
      frontendRoot: 'public',
      backend: {runtime: 'php', entry: 'index.php', mode: 'api', routes: ['/api/']},
    }),
    'public/index.html': '<!doctype html><h1>ok</h1>',
    'index.php': `<?php
header('Content-Type: application/json');
header('X-Name: Zoë');
header('Content-Disposition: attachment; filename="café.txt"');
$raw = file_get_contents('php://input');
$type = $_SERVER['CONTENT_TYPE'] ?? '';
echo json_encode([
  'raw' => bin2hex($raw),
  'json' => str_starts_with($type, 'application/json') ? json_decode($raw, true) : null,
  'post' => $_POST,
  'get' => $_GET,
  'cookie' => $_COOKIE['c'] ?? null,
  'uri' => $_SERVER['REQUEST_URI'],
  'named' => $_SERVER['HTTP_X_NAME'] ?? null,
]);
`,
  }, 'php-bytes');
  const ask = (path, queryString, headers, body) =>
    runRunner(root, {path, method: 'POST', queryString, headers, bodyBase64: Buffer.from(body).toString('base64'), client_ip: '127.0.0.1'});
  const header = (answer, name) => answer.headers.find(([k]) => k.toLowerCase() === name)?.[1];

  const text = '{"name":"José — 日本"}';
  const sent = ask('/api/café', 'q=Jos%C3%A9', {'content-type': 'application/json', cookie: 'c=José', 'x-name': 'Zoë'}, text);
  assert.equal(sent.status, 200, sent.bodyText);
  const seen = JSON.parse(sent.bodyText);
  assert.equal(seen.raw, Buffer.from(text).toString('hex'));
  assert.deepEqual(seen.json, {name: 'José — 日本'});
  assert.deepEqual(seen.get, {q: 'José'});
  assert.equal(seen.cookie, 'José');
  assert.equal(seen.uri, '/api/café?q=Jos%C3%A9');
  assert.equal(seen.named, 'Zoë');
  assert.equal(header(sent, 'x-name'), 'Zoë');
  assert.equal(header(sent, 'content-disposition'), 'attachment; filename="café.txt"');

  // Bytes that are no text arrive as they are.
  const binary = Buffer.from(Array.from({length: 256}, (_, i) => i));
  const upload = ask('/api/upload', '', {'content-type': 'application/octet-stream'}, binary);
  assert.equal(JSON.parse(upload.bodyText).raw, binary.toString('hex'));

  // A form, as PHP reads one.
  const form = ask('/api/form', '', {'content-type': 'application/x-www-form-urlencoded'}, 'name=Jos%C3%A9&tags%5B%5D=a&tags%5B%5D=b&plain=x+y');
  assert.deepEqual(JSON.parse(form.bodyText).post, {name: 'José', tags: ['a', 'b'], plain: 'x y'});
});

/** A PHP app whose one database is seeded by SQL and by JSON, and whose script lists both and adds to one. */
function seededApp(t, seedJson) {
  const root = makeBackendFixture(t, {
    'manifest.json': JSON.stringify({
      engine: 2,
      id: 'php-seeded',
      name: 'PHP seeded',
      version: '1.0.0',
      main: 'public/index.html',
      frontendRoot: 'public',
      backend: {runtime: 'php', entry: 'index.php', mode: 'api', routes: ['/api/']},
      databases: [{name: 'app', engine: 'sqlite', file: 'app.db', seedSql: 'seed.sql', seedJson: 'seed.json'}],
    }),
    'public/index.html': '<!doctype html><h1>ok</h1>',
    'seed.sql': "CREATE TABLE IF NOT EXISTS items (name TEXT NOT NULL); INSERT INTO items (name) VALUES ('from-seed');",
    'seed.json': seedJson,
    'index.php': `<?php
header('Content-Type: application/json');
$pdo = new PDO('sqlite:app.db');
if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST') $pdo->exec("INSERT INTO items (name) VALUES ('mine')");
echo json_encode([
  'items' => $pdo->query('SELECT name FROM items ORDER BY rowid')->fetchAll(PDO::FETCH_COLUMN),
  'tags' => $pdo->query('SELECT label FROM tags ORDER BY rowid')->fetchAll(PDO::FETCH_COLUMN),
]);
`,
  }, 'php-seeded');
  const ask = (method = 'GET') => runRunner(root, {path: '/api/items', method, queryString: '', headers: {}, bodyBase64: '', client_ip: '127.0.0.1'});
  const database = join(root, 'private/data/databases/app.db');
  return {root, ask, database, marker: `${database}.softn_seeded`};
}

// A database is seeded once: one that has the app's tables and has lost its mark (restored from a
// backup without it, or the process stopped between seeding and writing it) is not seeded again.
// The check meant to see that (`NOT LIKE '_%'`) named no table at all, since `_` is a LIKE wildcard,
// so the seed SQL ran over the records again (twice the seed rows, or a failed start where it
// inserts a key), as it did on the Rust host, which had no such check.
test('a database that lost its seed mark is not seeded again', {skip: (!hasCoreWasm || !hasPhpWasm) && 'ZIPP WASM engines not built'}, t => {
  const app = seededApp(t, '{"tags":[{"label":"seeded"}]}');
  const first = app.ask();
  assert.equal(first.status, 200, first.bodyText);
  assert.deepEqual(JSON.parse(first.bodyText), {items: ['from-seed'], tags: ['seeded']});
  assert.deepEqual(JSON.parse(app.ask('POST').bodyText).items, ['from-seed', 'mine']);
  rmSync(app.marker);
  const restored = app.ask();
  assert.equal(restored.status, 200, restored.bodyText);
  assert.deepEqual(JSON.parse(restored.bodyText), {items: ['from-seed', 'mine'], tags: ['seeded']});
  assert.ok(existsSync(app.marker), 'the mark is written again');
});

// A seed that fails on a new database leaves no database behind, for seedJson as for seedSql: the
// next attempt starts from nothing and seeds it whole. A database the failed seedJson left with the
// seed SQL's rows was seeded by that SQL again on the next attempt.
test('a seed that fails on a new database leaves no database behind', {skip: (!hasCoreWasm || !hasPhpWasm) && 'ZIPP WASM engines not built'}, t => {
  const app = seededApp(t, '{"tags":[{"label":"seeded"}]');
  const failed = app.ask();
  assert.equal(failed.status, 503, failed.bodyText ?? JSON.stringify(failed.body));
  assert.ok(!existsSync(app.database), 'the database the failed seed made is gone');
  assert.ok(!existsSync(app.marker));
  writeFileSync(join(app.root, 'app/seed.json'), '{"tags":[{"label":"seeded"}]}');
  const fixed = app.ask();
  assert.equal(fixed.status, 200, fixed.bodyText);
  assert.deepEqual(JSON.parse(fixed.bodyText), {items: ['from-seed'], tags: ['seeded']});
});
