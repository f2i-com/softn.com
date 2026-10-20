/**
 * What the backend review of 25 September 2026 changed, pinned:
 *
 * - a JSON body is read before the catalogue lock is taken, on every route:
 *   the comment, rating, run, storage, PATCH and DELETE handlers used to
 *   open the catalogue first and then read the body, so one client sending
 *   a small body slowly (mod_php and Apache's FastCGI proxy hand PHP the
 *   body as it arrives) held every other request, reads included;
 * - trust is the operator's word about the bundle they looked at: a new
 *   version uploaded with an edit key drops it, so a publisher cannot ship
 *   new code, or new capabilities, under a preapproval given to the old;
 * - a rating is one per visitor the way a rate limit counts visitors, an
 *   IPv6 /64 as one: a fresh address in the prefix was a fresh vote;
 * - a bundle with two entries of one name is refused at publication, as
 *   the runtime and softn-serve refuse to open it;
 * - /api/health names the extensions the API needs, not just zip;
 * - router.php runs only under PHP's built-in server and serves no
 *   dotfile, as nginx and the deployed .htaccess refuse them;
 * - the API's .htaccess hands every address to index.php: no file in api/
 *   (router.php, a benchmark's results, .user.ini) is served as itself.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { apiDir, startServer, runPhp, startPhp, makeBundle, skip } from './helpers/harness.mjs';

const { zipSync, unzipSync, strToU8 } = createRequire(import.meta.url)('fflate');

let s = null;

before(async () => {
  if (skip.skip) return;
  s = await startServer({ config: { trustedProxies: ['127.0.0.1'] }, prefix: 'softn-review-' });
});

after(() => s?.stop());

/** Whether another process could take the catalogue lock right now. */
function catalogueFree(dataDir) {
  const r = runPhp({ dataDir, script: `$f = fopen($argv[1] . '/catalog.lock', 'c'); echo flock($f, LOCK_EX | LOCK_NB) ? 'free' : 'held';` });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim() === 'free';
}

test('a slow JSON body is read before the catalogue lock is taken, on every route that takes one', skip, async () => {
  const { app } = await s.publish('Slow Body');
  const routes = [
    ['POST', `/api/apps/${app.slug}/comments`],
    ['POST', `/api/apps/${app.slug}/rating`],
    ['POST', `/api/apps/${app.slug}/runs`],
    ['PATCH', `/api/apps/${app.slug}`],
    ['DELETE', `/api/apps/${app.slug}`],
  ];
  for (const [method, uri] of routes) {
    // index.php itself, on the command line, where php://input is stdin: the
    // body arrives as a client trickling it would send it, the first bytes
    // now and the rest never.
    const child = spawn('php', ['-d', 'error_log=', path.join(s.root, 'api/index.php')], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, SOFTN_DATA_DIR: s.dataDir, REQUEST_METHOD: method, REQUEST_URI: uri, CONTENT_TYPE: 'application/json', CONTENT_LENGTH: '4096', REMOTE_ADDR: '198.51.100.40' },
    });
    try {
      child.stdin.write('{"body":"');
      await new Promise((r) => setTimeout(r, 900));
      assert.equal(child.exitCode, null, `${method} ${uri} is still waiting for its body`);
      assert.equal(catalogueFree(s.dataDir), true, `${method} ${uri} holds no catalogue lock while its body is still arriving`);
    } finally {
      child.kill();
    }
  }
  assert.equal((await s.api('GET', '/api/apps')).status, 200);
});

/** How storage.lock is held right now, as another process finds it: free, shared, or exclusive. */
function storageLock(dataDir) {
  const r = runPhp({
    dataDir,
    script: `$f = fopen($argv[1] . '/storage.lock', 'c');
echo flock($f, LOCK_EX | LOCK_NB) ? 'free' : (flock($f, LOCK_SH | LOCK_NB) ? 'shared' : 'exclusive');`,
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

/** A process that does `script` and says "holding" when it is in the middle of it. Resolves when it says so. */
async function holding(dataDir, script, args) {
  const held = startPhp({ dataDir, script, args });
  await new Promise((resolve, reject) => {
    let seen = '';
    held.process.stdout.on('data', (chunk) => { seen += chunk; if (seen.includes('holding')) resolve(); });
    held.process.on('exit', () => reject(new Error('the holder ended before it held anything: ' + seen)));
  });
  return held;
}

const storagePermission = { storage: { enabled: true, collections: { '*': 'public' } } };

test('a storage request works in the app\'s database without the directory-wide lock', skip, async () => {
  const { app } = await s.publish('Busy Store', { permissions: storagePermission });
  const uri = `/api/apps/${app.slug}/storage`;
  assert.equal((await s.api('POST', uri, { body: { op: 'insert', collection: 'log', data: { n: 0 } } })).status, 200);

  // Another connection holds the store's write lock for a while, as a long
  // write by another visitor would: the request below has to wait inside SQLite.
  const writer = await holding(s.dataDir, `
$pdo = new PDO('sqlite:' . $argv[1] . '/apps/' . $argv[2] . '/storage.sqlite');
$pdo->exec('BEGIN IMMEDIATE');
echo "holding\n";
usleep(2500000);
$pdo->exec('ROLLBACK');`, [app.slug]);
  const body = JSON.stringify({ op: 'insert', collection: 'log', data: { n: 1 } });
  const child = spawn('php', ['-d', 'error_log=', path.join(s.root, 'api/index.php')], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, SOFTN_DATA_DIR: s.dataDir, REQUEST_METHOD: 'POST', REQUEST_URI: uri, CONTENT_TYPE: 'application/json', CONTENT_LENGTH: String(body.length), REMOTE_ADDR: '198.51.100.41' },
  });
  let out = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  const ended = new Promise((resolve) => child.on('exit', resolve));
  try {
    child.stdin.end(body);
    // Until the request is in the store, which it holds storage.lock shared
    // for while SQLite makes it wait. A fixed 900 ms was less than a busy
    // machine's PHP took to start; the writer holds its lock for 2.5 s.
    const until = Date.now() + 2000;
    while (storageLock(s.dataDir) !== 'shared' && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    assert.equal(child.exitCode, null, 'the request is waiting for the store: ' + out);
    assert.equal(catalogueFree(s.dataDir), true, 'the whole directory waited behind one app\'s store');
    assert.equal(storageLock(s.dataDir), 'shared', 'and the request is known to be in a store');
    await writer.done;
    await ended;
    assert.match(out, /"ok":true/, out);
  } finally {
    child.kill();
    writer.process.kill();
  }
  assert.equal(storageLock(s.dataDir), 'free');
  assert.equal((await s.api('POST', uri, { body: { op: 'count', collection: 'log' } })).json.result.count, 2);

  // The app's page reads its store the same way, and still reports it.
  const page = runPhp({
    dataDir: s.dataDir,
    args: [app.slug],
    script: `
Catalog::boot();
$app = Apps::detail(Apps::row($argv[2]), false);
$probe = fn() => flock(fopen($argv[1] . '/catalog.lock', 'c'), LOCK_EX | LOCK_NB);
$during = $probe();
$app['storage'] = Storage::summaryOutsideCatalogue($argv[2]);
echo json_encode(['heldWhileListing' => !$during, 'freeForTheStore' => $probe(), 'storage' => $app['storage'], 'keys' => array_keys($app)]);`,
  });
  assert.equal(page.status, 0, page.stderr);
  const seen = JSON.parse(page.stdout);
  assert.equal(seen.heldWhileListing, true);
  assert.equal(seen.freeForTheStore, true, 'the store was read under the catalogue lock');
  assert.equal(seen.storage.records, 2);
  const served = (await s.api('GET', `/api/apps/${app.slug}`)).json.app;
  assert.deepEqual(Object.keys(served), seen.keys, 'the page has the fields it had, in their order');
  assert.equal(served.storage.records, 2);
  assert.equal((await s.api('GET', `/api/apps/${app.slug}/storage`)).json.storage.records, 2);
});

test('an export and an unpublish wait for a storage request in flight', skip, async () => {
  const { app } = await s.publish('Quiet Store', { permissions: storagePermission });
  const uri = `/api/apps/${app.slug}/storage`;
  assert.equal((await s.api('POST', uri, { body: { op: 'insert', collection: 'log', data: { n: 0 } } })).status, 200);
  // A storage request in the middle of its work: it holds storage.lock
  // shared, as Storage::leaveCatalogue takes it, and writes a second later.
  const inFlight = (marker) => holding(s.dataDir, `
$lock = fopen($argv[1] . '/storage.lock', 'c');
flock($lock, LOCK_SH);
echo "holding\n";
usleep(1500000);
if ($argv[3] !== '') {
  $pdo = new PDO('sqlite:' . $argv[1] . '/apps/' . $argv[2] . '/storage.sqlite');
  $pdo->exec('PRAGMA busy_timeout=5000');
  $pdo->prepare("INSERT INTO records (collection, id, data, created_at, updated_at) VALUES ('log', ?, ?, 1, 1)")->execute([$argv[3], json_encode(['marker' => $argv[3]])]);
}
flock($lock, LOCK_UN);`, [app.slug, marker]);

  const marker = 'written-while-the-export-waited';
  const request = await inFlight(marker);
  const archive = path.join(s.tmp, 'quiet.zip');
  const exported = spawnSync('php', ['-d', 'error_log=', path.join(apiDir, 'backup.php'), 'export', archive, '--data', s.dataDir], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  await request.done;
  assert.equal(exported.status, 0, exported.stderr);
  const store = unzipSync(fs.readFileSync(archive))[`apps/${app.slug}/storage.sqlite`];
  assert.ok(Buffer.from(store).includes(marker), 'the export copied the store while a request was still writing to it');
  const verified = spawnSync('php', ['-d', 'error_log=', path.join(apiDir, 'backup.php'), 'verify', archive], { encoding: 'utf8' });
  assert.equal(verified.status, 0, verified.stderr + verified.stdout);
  fs.rmSync(archive, { force: true });

  // Unpublishing waits the same way, and then the folder goes whole.
  const busy = await inFlight('');
  const began = Date.now();
  const gone = await s.api('DELETE', `/api/apps/${app.slug}?purge=1`, { headers: { 'X-Admin-Key': s.adminKey } });
  const waited = Date.now() - began;
  await busy.done;
  assert.equal(gone.status, 204, gone.text);
  assert.ok(waited >= 900, `the folder was removed ${waited} ms into a request that had a second and a half to run`);
  assert.equal(fs.existsSync(path.join(s.dataDir, 'apps', app.slug)), false);
  assert.equal((await s.api('POST', uri, { body: { op: 'count', collection: 'log' } })).status, 404);
  assert.equal(storageLock(s.dataDir), 'free');
});

test('a new version uploaded with the edit key drops the operator\'s trust; one the admin uploads keeps it', skip, async () => {
  const fd = new FormData();
  fd.append('bundle', new Blob([makeBundle('Vouched For')]), 'app.softn');
  const published = await s.api('POST', '/api/apps', { body: fd, headers: { 'X-Admin-Key': s.adminKey } });
  assert.equal(published.status, 201, published.text);
  const { slug } = published.json.app;
  const editKey = published.json.editKey;
  const appJson = path.join(s.dataDir, 'apps', slug, 'app.json');
  const trust = () => {
    const doc = JSON.parse(fs.readFileSync(appJson, 'utf8'));
    doc.app.trusted = true;
    fs.writeFileSync(appJson, JSON.stringify(doc, null, 2));
  };
  const playMode = async () => {
    const html = await (await fetch(`${s.base}/play/${slug}`, { headers: { Accept: 'text/html' } })).text();
    return JSON.parse(html.match(/id="softn-runtime-config">(.*?)<\/script>/s)[1]).permissionMode;
  };
  trust();
  assert.equal(await playMode(), 'preapproved', 'the operator trusted v1');

  // The publisher ships v2 asking for more than v1 did. It is not the bundle
  // the operator vouched for, and it must not inherit the preapproval.
  const v2 = new FormData();
  v2.append('bundle', new Blob([makeBundle('Vouched For', { version: '2.0.0', permissions: { net: { enabled: true }, camera: { enabled: true } } })]), 'app.softn');
  const added = await s.api('POST', `/api/apps/${slug}/versions`, { body: v2, headers: { 'X-Edit-Key': editKey } });
  assert.equal(added.status, 201, added.text);
  assert.equal(added.json.app.trusted, false, 'the reply says the trust is gone');
  assert.equal(await playMode(), 'prompt', 'v2 plays behind the permission bar');
  assert.equal(JSON.parse(fs.readFileSync(appJson, 'utf8')).app.trusted, undefined, 'and app.json no longer claims it');

  // The operator, uploading with the admin key, is the one who vouches.
  trust();
  const v3 = new FormData();
  v3.append('bundle', new Blob([makeBundle('Vouched For', { version: '3.0.0' })]), 'app.softn');
  const byAdmin = await s.api('POST', `/api/apps/${slug}/versions`, { body: v3, headers: { 'X-Admin-Key': s.adminKey } });
  assert.equal(byAdmin.status, 201, byAdmin.text);
  assert.equal(await playMode(), 'preapproved', 'the admin\'s own upload keeps it');
});

test('one IPv6 /64 casts one rating, whichever address in it votes', skip, async () => {
  const { app } = await s.publish('Rated Once');
  const rate = (xff, stars) => s.api('POST', `/api/apps/${app.slug}/rating`, { body: { stars }, headers: { 'X-Forwarded-For': xff } });
  assert.equal((await rate('2001:db8:5:6::1', 5)).status, 200);
  const again = await rate('2001:db8:5:6:aaaa:bbbb:cccc:dddd', 5);
  assert.equal(again.status, 200);
  assert.equal(again.json.rating.count, 1, 'a second address in the same /64 changed the vote rather than adding one');
  assert.equal(again.json.rating.mine, 5, 'and it is that visitor\'s own');
  const other = await rate('2001:db8:5:7::1', 1);
  assert.equal(other.json.rating.count, 2, 'the next /64 is somebody else');
  const v4a = await rate('198.51.100.7', 3);
  const v4b = await rate('198.51.100.8', 3);
  assert.equal(v4a.json.rating.count, 3);
  assert.equal(v4b.json.rating.count, 4, 'IPv4 is still one address, one vote');
});

/** A zip with two entries both called `name`: fflate writes distinct names, so the second is renamed in place (same length, and the CRC does not cover names). */
function duplicateEntryZip(name) {
  const decoy = name.slice(0, -1) + (name.endsWith('x') ? 'y' : 'x');
  const files = {
    'manifest.json': strToU8(JSON.stringify({ name: 'Twice', version: '1.0.0', main: 'ui/main.ui', files: { ui: ['ui/main.ui'] } })),
    'ui/main.ui': strToU8('<App><Text>one</Text></App>\n'),
    [decoy]: name === 'manifest.json'
      ? strToU8(JSON.stringify({ name: 'Other', version: '9.9.9', main: 'ui/main.ui', files: { ui: ['ui/main.ui'] } }))
      : strToU8('<App><Text>two</Text></App>\n'),
  };
  const bytes = Buffer.from(zipSync(files));
  const from = Buffer.from(decoy, 'latin1');
  const to = Buffer.from(name, 'latin1');
  let at = 0;
  let renamed = 0;
  while ((at = bytes.indexOf(from, at)) !== -1) {
    to.copy(bytes, at);
    at += to.length;
    renamed++;
  }
  assert.equal(renamed, 2, 'the local header and the central directory both carry the name');
  return bytes;
}
test('a request that let the catalogue go cannot take it again', skip, () => {
  // It holds the stores' lock from then on, and a backup takes the two in
  // the other order. Coming back for the catalogue is how the two would wait
  // on each other with nothing to end it, so the handler's mistake is
  // refused where it is made, and the lock is not asked for at all.
  const again = runPhp({
    dataDir: s.dataDir,
    script: `
Catalog::boot();
Storage::leaveCatalogue();
$free = flock(fopen($argv[1] . '/catalog.lock', 'c'), LOCK_EX | LOCK_NB);
try { Catalog::boot(); $outcome = 'taken again'; }
catch (LogicException $e) { $outcome = 'refused: ' . $e->getMessage(); }
echo json_encode(['freeAfterLeaving' => $free, 'outcome' => $outcome]);`,
  });
  assert.equal(again.status, 0, again.stderr);
  const seen = JSON.parse(again.stdout);
  assert.equal(seen.freeAfterLeaving, true);
  assert.match(seen.outcome, /^refused: The catalogue was let go/);

  // A request that never left it boots as often as it likes.
  const twice = runPhp({ dataDir: s.dataDir, script: `Catalog::boot(); Catalog::release(); Catalog::boot(); echo 'ok';` });
  assert.equal(twice.status, 0, twice.stderr);
  assert.equal(twice.stdout, 'ok');
});

test('a bundle with two entries of one name is refused at publication', skip, async () => {
  for (const name of ['manifest.json', 'ui/main.ui']) {
    const fd = new FormData();
    fd.append('bundle', new Blob([duplicateEntryZip(name)]), 'app.softn');
    const r = await s.api('POST', '/api/apps', { body: fd, headers: { 'X-Admin-Key': s.adminKey } });
    assert.equal(r.status, 400, `${name}: ${r.text}`);
    assert.match(r.json.error, new RegExp(`more than one entry named ${name}`), r.json.error);
  }
});

test('health names the extensions the API needs, and warns about any that are missing', skip, async () => {
  const h = (await s.api('GET', '/api/health')).json;
  assert.deepEqual(Object.keys(h.extensions).sort(), ['dom', 'mbstring', 'pdo_sqlite', 'zip', 'zlib']);
  for (const [name, loaded] of Object.entries(h.extensions)) {
    const probe = spawnSync('php', ['-r', `echo extension_loaded(${JSON.stringify(name)}) ? 'y' : 'n';`], { encoding: 'utf8' });
    assert.equal(loaded, probe.stdout === 'y', name);
    if (!loaded) assert.ok(h.warnings.some((w) => w.includes(name)), `a warning names ${name}`);
  }
});

test('router.php serves no dotfile, and does nothing outside PHP\'s built-in server', skip, async () => {
  fs.writeFileSync(path.join(s.root, '.htaccess'), 'Require all denied\n');
  fs.mkdirSync(path.join(s.root, 'web'), { recursive: true });
  fs.writeFileSync(path.join(s.root, 'web/.env'), 'SECRET=1\n');
  for (const p of ['/.htaccess', '/web/.env', '/%2ehtaccess']) {
    const r = await fetch(s.base + p);
    const text = await r.text();
    assert.equal(r.status, 404, p);
    assert.doesNotMatch(text, /Require all denied|SECRET/, p);
  }
  const cli = spawnSync('php', [path.join(s.root, 'api/router.php')], { encoding: 'utf8', env: { ...process.env, DOCUMENT_ROOT: s.root, REQUEST_URI: '/' } });
  assert.equal(cli.stdout, '', 'run any other way, it prints nothing');
});

test('the API .htaccess hands every address in api/ to index.php, files included', skip, () => {
  const rules = fs.readFileSync(path.join(apiDir, '.htaccess'), 'utf8').replace(/\r\n/g, '\n');
  assert.doesNotMatch(rules, /REQUEST_FILENAME\}\s+!-f/, 'no "unless it is a file" exception');
  const last = rules.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('RewriteRule ')).at(-1);
  assert.equal(last, 'RewriteRule !^index\\.php$ index.php [QSA,L]');
  const pattern = /^index\.php$/;
  for (const rel of ['router.php', 'backup.php', 'bench/results.json', '.user.ini', 'apps/x/bundle.softn', '']) {
    assert.ok(!pattern.test(rel), `${rel || '(the directory)'} goes to the script`);
  }
});
