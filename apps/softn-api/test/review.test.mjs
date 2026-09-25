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
import { apiDir, startServer, runPhp, makeBundle, skip } from './helpers/harness.mjs';

const { zipSync, strToU8 } = createRequire(import.meta.url)('fflate');

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
  assert.deepEqual(Object.keys(h.extensions).sort(), ['dom', 'mbstring', 'pdo_sqlite', 'zip']);
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
