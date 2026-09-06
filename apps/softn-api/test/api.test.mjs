/**
 * The directory API, driven the way its clients drive it.
 *
 * A site root is assembled in a temporary directory — the API, the demo
 * bundles, an index.html with the tags the share page rewrites — and PHP's
 * built-in server is started on it through router.php. Everything below then
 * goes over HTTP: a real multipart upload, a raw-body upload, JSON with
 * base64, the storage operations an app makes, the limits a visitor hits.
 *
 * Needs `php` on PATH with pdo_sqlite and zip; without it the suite is
 * skipped with a note rather than failed, since the site itself does not
 * need PHP to build.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.resolve(here, '..');
const repo = path.resolve(apiDir, '../..');
const require = createRequire(import.meta.url);

const php = spawnSync('php', ['-v'], { encoding: 'utf8' });
const HAVE_PHP = php.status === 0;
if (!HAVE_PHP) console.log('# php is not on PATH; the API tests are skipped');
/** The per-app storage quota the test server runs with; see `before`. */
const STORAGE_QUOTA_BYTES = 256 * 1024;

let root = '';
let server = null;
let base = '';
let adminKey = '';

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.name === 'test' || entry.name === 'node_modules') continue;
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dest);
    else fs.copyFileSync(src, dest);
  }
}

async function waitFor(url, ms = 15000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(url);
      if (r.ok || r.status === 503) return r;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`${url} did not come up`);
}

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
    /* not json */
  }
  return { status: res.status, json, text, headers: res.headers };
}

/** A small valid bundle built in memory, with whatever permission.json is asked for. */
function makeBundle(name, { permissions, version = '1.0.0', icon = false } = {}) {
  const { zipSync, strToU8 } = require('fflate');
  const files = {
    'manifest.json': strToU8(
      JSON.stringify({
        name,
        version,
        description: `${name}, made by the test`,
        main: 'ui/main.ui',
        icon: icon ? 'assets/icon.svg' : undefined,
        files: { ui: ['ui/main.ui'], logic: ['logic/main.logic'] },
        config: { theme: { primary: '#3366ff' } },
      })
    ),
    'ui/main.ui': strToU8('<App><Text>hello</Text></App>\n'),
    'logic/main.logic': strToU8('let x = 1\n'),
  };
  if (permissions) files['permission.json'] = strToU8(JSON.stringify({ permissions }));
  if (icon) files['assets/icon.svg'] = strToU8('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#36f"/></svg>');
  return zipSync(files);
}

before(async () => {
  if (!HAVE_PHP) return;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'softn-api-'));
  copyDir(apiDir, path.join(root, 'api'));
  copyDir(path.join(repo, 'apps/softn-web/public/demos'), path.join(root, 'demos'));
  // A storage quota small enough to reach in a test. The server fills in the
  // rest of the configuration around it on first use.
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data/config.json'), JSON.stringify({ storage: { maxDatabaseBytes: STORAGE_QUOTA_BYTES } }));
  fs.writeFileSync(
    path.join(root, 'index.html'),
    `<!doctype html><html><head><title>SoftN — a UI language and its runtime</title>
<link rel="canonical" href="https://softn.com/" />
<meta name="description" content="site description" />
<meta property="og:title" content="SoftN — a UI language and its runtime" />
<meta property="og:description" content="site og description" />
<meta property="og:type" content="website" />
<meta property="og:url" content="https://softn.com/" />
<meta property="og:image" content="https://softn.com/og.png" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta property="og:image:alt" content="SoftN" />
</head><body><div id="root"></div></body></html>`
  );
  const port = 5600 + Math.floor(Math.random() * 300);
  base = `http://127.0.0.1:${port}`;
  server = spawn('php', ['-S', `127.0.0.1:${port}`, '-t', root, path.join(root, 'api/router.php')], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env },
  });
  server.stderr.on('data', (d) => {
    const s = String(d);
    // The built-in server logs every request to stderr; only PHP's own
    // complaints are worth seeing.
    if (/PHP (Warning|Fatal|Parse|Notice)|softn-api:/.test(s)) process.stderr.write(s);
  });
  await waitFor(`${base}/api/health`);
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'data/config.json'), 'utf8'));
  adminKey = cfg.adminKey;
});

after(() => {
  if (server) server.kill();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

const skip = { skip: !HAVE_PHP };

test('health reports a working SQLite with FTS5 and a writable data dir', skip, async () => {
  const { status, json } = await api('GET', '/api/health');
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.dataWritable, true);
  assert.equal(json.zip, true);
});

test('the demos are seeded on first use, into their categories', skip, async () => {
  const { json } = await api('GET', '/api/apps?perPage=48');
  assert.equal(json.ok, true);
  assert.ok(json.total >= 10, `seeded ${json.total} apps`);
  const snake = json.apps.find((a) => a.slug === 'snake-game');
  assert.ok(snake, 'snake-game is listed');
  assert.equal(snake.category, 'games');
  assert.equal(snake.author, 'SoftN');
  assert.equal(snake.source, 'seed');
  assert.ok(snake.urls.run.endsWith('/web/app/snake-game'));
  const cats = (await api('GET', '/api/categories')).json.categories;
  assert.ok(cats.find((c) => c.id === 'games' && c.apps >= 1));
  assert.ok(cats.length >= 9);
});

test('search finds by name and description, category filters, pages paginate', skip, async () => {
  const snake = (await api('GET', '/api/apps?q=snake')).json;
  assert.ok(snake.apps.some((a) => a.slug === 'snake-game'));
  const cart = (await api('GET', '/api/apps?q=handheld')).json;
  assert.ok(cart.apps.some((a) => a.slug === 'pocket'), 'description words match');
  const games = (await api('GET', '/api/apps?category=games')).json;
  assert.ok(games.apps.every((a) => a.category === 'games'));
  const p1 = (await api('GET', '/api/apps?perPage=2&page=1&sort=name')).json;
  const p2 = (await api('GET', '/api/apps?perPage=2&page=2&sort=name')).json;
  assert.equal(p1.apps.length, 2);
  assert.notEqual(p1.apps[0].slug, p2.apps[0].slug);
  assert.equal(p1.pages, Math.ceil(p1.total / 2));
  const none = (await api('GET', '/api/apps?q=zzqqxx')).json;
  assert.equal(none.total, 0);
});

test('an app has a detail, a bundle, a thumbnail and readable source', skip, async () => {
  const { json } = await api('GET', '/api/apps/snake-game');
  assert.equal(json.app.name, 'Snake');
  assert.equal(json.app.versions.length, 1);
  assert.deepEqual(json.app.ratingBreakdown, { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 });
  const bundle = await fetch(`${base}/api/apps/snake-game/bundle.softn`);
  assert.equal(bundle.status, 200);
  assert.equal(bundle.headers.get('content-type'), 'application/octet-stream');
  const bytes = new Uint8Array(await bundle.arrayBuffer());
  const onDisk = fs.readFileSync(path.join(root, 'demos/SnakeGame.softn'));
  assert.equal(bytes.length, onDisk.length);
  assert.ok(Buffer.from(bytes).equals(onDisk), 'the bundle is byte for byte the file');
  const dl = await fetch(`${base}/api/apps/snake-game/bundle.softn?download=1`);
  assert.match(dl.headers.get('content-disposition') || '', /snake-game\.softn/);
  const thumb = await fetch(`${base}/api/apps/snake-game/thumbnail`);
  assert.equal(thumb.status, 200);
  assert.match(thumb.headers.get('content-type') || '', /^image\//);
  const src = (await api('GET', '/api/apps/snake-game/source')).json;
  assert.ok(src.files.some((f) => f.path === 'ui/main.ui' && typeof f.text === 'string' && f.text.length > 10));
  assert.ok(src.files.some((f) => f.path === 'manifest.json'));
  // The manifest name works in a URL as well as the slug.
  const byName = (await api('GET', '/api/apps/Snake%20Game')).json;
  assert.equal(byName.app.slug, 'snake-game');
});

let published = null;
let editKey = '';

test('publishing by multipart form returns an edit key and a unique slug', skip, async () => {
  const fd = new FormData();
  fd.append('bundle', new Blob([makeBundle('Test Snake', { icon: true })]), 'test.softn');
  fd.append('category', 'Games');
  fd.append('tags', 'arcade, test, Arcade');
  fd.append('author', 'Tester');
  fd.append('description', 'A bundle the test made');
  const { status, json } = await api('POST', '/api/apps', { body: fd });
  assert.equal(status, 201, JSON.stringify(json));
  assert.equal(json.app.slug, 'test-snake');
  assert.equal(json.app.category, 'games');
  assert.deepEqual(json.app.tags, ['arcade', 'test']);
  assert.equal(json.app.author, 'Tester');
  assert.equal(json.app.primary, '#3366ff');
  assert.equal(json.app.thumbnailKind, 'icon');
  assert.match(json.editKey, /^[0-9a-f]{40}$/);
  published = json.app;
  editKey = json.editKey;

  const again = await api('POST', '/api/apps', { raw: makeBundle('Test Snake'), headers: { 'Content-Type': 'application/octet-stream' } });
  assert.equal(again.status, 201);
  assert.equal(again.json.app.slug, 'test-snake-2', 'a second app of the same name gets a numbered slug');
  assert.equal(again.json.app.source, 'api');
});

test('publishing as JSON with base64 works, and a non-bundle is refused', skip, async () => {
  const b64 = Buffer.from(makeBundle('JSON Published')).toString('base64');
  const { status, json } = await api('POST', '/api/apps', { body: { bundleBase64: b64, category: 'tools', author: 'A bot' } });
  assert.equal(status, 201, JSON.stringify(json));
  assert.equal(json.app.slug, 'json-published');
  assert.equal(json.app.category, 'tools');
  const bad = await api('POST', '/api/apps', { raw: Buffer.from('not a zip at all, but long enough to be looked at'), headers: { 'Content-Type': 'application/octet-stream' } });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /not a \.softn/);
  const { zipSync, strToU8 } = require('fflate');
  const noManifest = zipSync({ 'ui/main.ui': strToU8('<App/>') });
  const nm = await api('POST', '/api/apps', { raw: noManifest, headers: { 'Content-Type': 'application/octet-stream' } });
  assert.equal(nm.status, 400);
  assert.match(nm.json.error, /manifest/);
  const honeypot = new FormData();
  honeypot.append('bundle', new Blob([makeBundle('Spam')]), 'spam.softn');
  honeypot.append('website', 'http://spam.example');
  assert.equal((await api('POST', '/api/apps', { body: honeypot })).status, 400);
});

test('metadata, versions and the thumbnail need the edit key', skip, async () => {
  const noKey = await api('PATCH', '/api/apps/test-snake', { body: { description: 'changed' } });
  assert.equal(noKey.status, 403);
  const wrong = await api('PATCH', '/api/apps/test-snake', { body: { description: 'changed' }, headers: { 'X-Edit-Key': 'nope' } });
  assert.equal(wrong.status, 403);
  const ok = await api('PATCH', '/api/apps/test-snake', { body: { description: 'changed', tags: ['one', 'two'], category: 'experiments' }, headers: { 'X-Edit-Key': editKey } });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.app.description, 'changed');
  assert.deepEqual(ok.json.app.tags, ['one', 'two']);
  assert.equal(ok.json.app.category, 'experiments');
  // hidden is the admin's alone
  const hide = await api('PATCH', '/api/apps/test-snake', { body: { hidden: true }, headers: { 'X-Edit-Key': editKey } });
  assert.equal(hide.status, 200);
  assert.equal((await api('GET', '/api/apps/test-snake')).status, 200, 'still visible');

  const fd = new FormData();
  fd.append('bundle', new Blob([makeBundle('Test Snake', { version: '1.1.0' })]), 'v2.softn');
  fd.append('editKey', editKey);
  fd.append('notes', 'Second version');
  const v2 = await api('POST', '/api/apps/test-snake/versions', { body: fd });
  assert.equal(v2.status, 201, JSON.stringify(v2.json));
  assert.equal(v2.json.app.version, 2);
  assert.equal(v2.json.app.versions[0].manifestVersion, '1.1.0');
  assert.equal(v2.json.app.versions[0].notes, 'Second version');
  const v1 = await fetch(`${base}/api/apps/test-snake/bundle.softn?v=1`);
  assert.equal(v1.status, 200);
  const latest = await fetch(`${base}/api/apps/test-snake/bundle.softn`);
  assert.notEqual((await v1.arrayBuffer()).byteLength, (await latest.arrayBuffer()).byteLength);

  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const tfd = new FormData();
  tfd.append('thumbnail', new Blob([png], { type: 'image/png' }), 'thumb.png');
  const t = await api('POST', '/api/apps/test-snake/thumbnail', { body: tfd, headers: { 'X-Edit-Key': editKey } });
  assert.equal(t.status, 200, JSON.stringify(t.json));
  assert.equal(t.json.app.thumbnailKind, 'image');
  const thumb = await fetch(`${base}/api/apps/test-snake/thumbnail`);
  assert.equal(thumb.headers.get('content-type'), 'image/png');
  const notImage = await api('POST', '/api/apps/test-snake/thumbnail', { body: { thumbnailBase64: Buffer.from('hello').toString('base64') }, headers: { 'X-Edit-Key': editKey } });
  assert.equal(notImage.status, 400);
});

test('comments, ratings and runs', skip, async () => {
  const c1 = await api('POST', '/api/apps/test-snake/comments', { body: { name: 'Ann', body: 'Lovely little game.' } });
  assert.equal(c1.status, 201, JSON.stringify(c1.json));
  assert.equal(c1.json.comment.name, 'Ann');
  const c2 = await api('POST', '/api/apps/test-snake/comments', { body: { body: 'Second, anonymous' } });
  assert.equal(c2.json.comment.name, 'Anonymous');
  const spam = await api('POST', '/api/apps/test-snake/comments', { body: { body: 'buy now', website: 'x' } });
  assert.equal(spam.status, 400);
  const short = await api('POST', '/api/apps/test-snake/comments', { body: { body: 'x' } });
  assert.equal(short.status, 400);
  const list = (await api('GET', '/api/apps/test-snake/comments')).json;
  assert.equal(list.total, 2);
  assert.equal(list.comments[0].body, 'Second, anonymous', 'newest first');
  assert.equal((await api('GET', '/api/apps/test-snake')).json.app.comments, 2);

  const r0 = (await api('GET', '/api/apps/test-snake/rating')).json.rating;
  assert.equal(r0.mine, null);
  const r1 = await api('POST', '/api/apps/test-snake/rating', { body: { stars: 4 } });
  assert.equal(r1.status, 200, JSON.stringify(r1.json));
  assert.equal(r1.json.rating.average, 4);
  assert.equal(r1.json.rating.count, 1);
  const r2 = (await api('POST', '/api/apps/test-snake/rating', { body: { stars: 5 } })).json.rating;
  assert.equal(r2.count, 1, 'one rating per visitor, changed not added');
  assert.equal(r2.average, 5);
  assert.equal(r2.mine, 5);
  assert.equal((await api('POST', '/api/apps/test-snake/rating', { body: { stars: 9 } })).status, 400);
  const detail = (await api('GET', '/api/apps/test-snake')).json.app;
  assert.equal(detail.rating.count, 1);
  assert.equal(detail.ratingBreakdown[5], 1);

  const before = detail.runs;
  const run = await api('POST', '/api/apps/test-snake/runs');
  assert.equal(run.status, 204);
  assert.equal((await api('GET', '/api/apps/test-snake')).json.app.runs, before + 1);
  // Runs feed the trending sort.
  const trending = (await api('GET', '/api/apps?sort=trending')).json;
  assert.ok(trending.apps.length > 0);
});

test('a remix is a new app that remembers its parent', skip, async () => {
  const rm = await api('POST', '/api/apps/test-snake/remix', { body: { author: 'Remixer' } });
  assert.equal(rm.status, 201, JSON.stringify(rm.json));
  assert.equal(rm.json.app.slug, 'test-snake-remix');
  assert.equal(rm.json.app.parent.slug, 'test-snake');
  assert.equal(rm.json.app.source, 'remix');
  assert.match(rm.json.editKey, /^[0-9a-f]{40}$/);
  const parent = (await api('GET', '/api/apps/test-snake')).json.app;
  assert.equal(parent.remixes, 1);
  assert.ok(parent.remixList.some((r) => r.slug === 'test-snake-remix'));
  const child = (await api('GET', '/api/apps/test-snake-remix')).json.app;
  assert.deepEqual(child.lineage.map((l) => l.slug), ['test-snake']);
  // A remix carrying its own bundle, through the publish route with `parent`.
  const fd = new FormData();
  fd.append('bundle', new Blob([makeBundle('Test Snake Deluxe')]), 'deluxe.softn');
  fd.append('parent', 'test-snake-remix');
  const grand = await api('POST', '/api/apps', { body: fd });
  assert.equal(grand.status, 201);
  const gc = (await api('GET', '/api/apps/test-snake-deluxe')).json.app;
  assert.deepEqual(gc.lineage.map((l) => l.slug), ['test-snake-remix', 'test-snake']);
  const remixed = (await api('GET', '/api/apps?sort=remixed')).json;
  assert.equal(remixed.apps[0].slug, 'test-snake');
});

test('per-app storage: records, queries, the key-value store, and the limits', skip, async () => {
  const noCap = await api('POST', '/api/apps/test-snake/storage', { body: { op: 'insert', collection: 'scores', data: { n: 1 } } });
  assert.equal(noCap.status, 403, 'an app that did not declare storage has none');

  const fd = new FormData();
  fd.append('bundle', new Blob([makeBundle('Score Board', { permissions: { storage: { enabled: true } } })]), 'scores.softn');
  const pub = await api('POST', '/api/apps', { body: fd });
  assert.equal(pub.status, 201);
  assert.deepEqual(pub.json.app.capabilities, ['storage']);
  const key = pub.json.editKey;
  const S = (body, headers) => api('POST', '/api/apps/score-board/storage', { body, headers });

  const a = await S({ op: 'insert', collection: 'scores', data: { player: 'Ann', score: 120, level: 2 } });
  assert.equal(a.status, 200, JSON.stringify(a.json));
  assert.match(a.json.result.id, /^[A-Za-z0-9_-]{12}$/);
  await S({ op: 'insert', collection: 'scores', data: { player: 'Bob', score: 300, level: 3 } });
  await S({ op: 'insert', collection: 'scores', data: { player: 'Cy', score: 80, level: 1 } });
  const withId = await S({ op: 'insert', collection: 'scores', id: 'ann-2', data: { player: 'Ann', score: 200, level: 2 } });
  assert.equal(withId.json.result.id, 'ann-2');
  assert.equal((await S({ op: 'insert', collection: 'scores', id: 'ann-2', data: { player: 'dup' } })).status, 409);

  const top = (await S({ op: 'query', collection: 'scores', orderBy: ['score', 'desc'], limit: 2 })).json.result;
  assert.equal(top.total, 4);
  assert.deepEqual(top.records.map((r) => r.data.player), ['Bob', 'Ann']);
  const ann = (await S({ op: 'query', collection: 'scores', where: { player: 'Ann' }, orderBy: 'score' })).json.result;
  assert.deepEqual(ann.records.map((r) => r.data.score), [120, 200]);
  const big = (await S({ op: 'query', collection: 'scores', where: { score: { gte: 120 } } })).json.result;
  assert.equal(big.total, 3);
  const levels = (await S({ op: 'query', collection: 'scores', where: { level: { in: [1, 3] } } })).json.result;
  assert.equal(levels.total, 2);
  const like = (await S({ op: 'query', collection: 'scores', where: { player: { contains: 'b' } } })).json.result;
  assert.equal(like.total, 1);
  assert.equal((await S({ op: 'count', collection: 'scores', where: { level: 2 } })).json.result.count, 2);

  const got = (await S({ op: 'get', collection: 'scores', id: 'ann-2' })).json.result;
  assert.equal(got.data.score, 200);
  const upd = (await S({ op: 'update', collection: 'scores', id: 'ann-2', data: { score: 250 } })).json.result;
  assert.equal(upd.data.score, 250);
  assert.equal(upd.data.player, 'Ann', 'update merges');
  const set = (await S({ op: 'set', collection: 'profile', id: 'ann', data: { colour: 'green' } })).json.result;
  assert.equal(set.data.colour, 'green');
  assert.equal((await S({ op: 'get', collection: 'scores', id: 'missing' })).json.result, null);
  assert.equal((await S({ op: 'remove', collection: 'scores', id: 'ann-2' })).json.result.removed, 1);
  assert.equal((await S({ op: 'count', collection: 'scores' })).json.result.count, 3);
  const cols = (await S({ op: 'collections' })).json.result.collections;
  assert.deepEqual(cols.map((c) => c.name), ['profile', 'scores']);

  assert.equal((await S({ op: 'kvSet', key: 'theme', value: { dark: true } })).status, 200);
  assert.deepEqual((await S({ op: 'kvGet', key: 'theme' })).json.result.value, { dark: true });
  assert.equal((await S({ op: 'kvGet', key: 'nothing' })).json.result.value, null);
  assert.equal((await S({ op: 'kvRemove', key: 'theme' })).json.result.removed, 1);

  // What the API refuses.
  assert.equal((await S({ op: 'insert', collection: 'Bad Name', data: {} })).status, 400);
  assert.equal((await S({ op: 'insert', collection: 'scores', data: 'not an object' })).status, 400);
  assert.equal((await S({ op: 'insert', collection: 'scores', data: { blob: 'x'.repeat(17000) } })).status, 413);
  assert.equal((await S({ op: 'query', collection: 'scores', where: { 'drop table': 1 } })).status, 400);
  assert.equal((await S({ op: 'query', collection: 'scores', where: { score: { like: 1 } } })).status, 400);
  assert.equal((await S({ op: 'explode' })).status, 400);
  const empty = (await S({ op: 'insert', collection: 'blank', data: {} })).json.result;
  assert.equal(JSON.stringify(empty.data), '{}', 'an empty record is an object');

  // Clearing is the publisher's.
  assert.equal((await S({ op: 'clear', collection: 'scores' })).status, 403);
  assert.equal((await S({ op: 'clear', collection: 'scores' }, { 'X-Edit-Key': key })).json.result.removed, 3);

  const summary = (await api('GET', '/api/apps/score-board')).json.app.storage;
  assert.equal(summary.collections, 2);
  const listed = (await api('GET', '/api/apps/score-board/storage/profile')).json.result;
  assert.equal(listed.total, 1);
});

test('a visitor can suggest a category and use it at once; the admin approves it', skip, async () => {
  const s = await api('POST', '/api/categories', { body: { name: 'Music Toys', description: 'Things that make noise', emoji: '🎵' } });
  assert.equal(s.status, 201, JSON.stringify(s.json));
  assert.equal(s.json.category.id, 'music-toys');
  assert.equal(s.json.category.suggested, true);
  const dup = await api('POST', '/api/categories', { body: { name: 'music toys' } });
  assert.equal(dup.json.category.id, 'music-toys');
  const fd = new FormData();
  fd.append('bundle', new Blob([makeBundle('Beeper')]), 'beeper.softn');
  fd.append('category', 'music-toys');
  const pub = await api('POST', '/api/apps', { body: fd });
  assert.equal(pub.json.app.category, 'music-toys');
  const noAdmin = await api('POST', '/api/admin/categories/music-toys', { body: { status: 'approved' } });
  assert.equal(noAdmin.status, 403);
  const approved = await api('POST', '/api/admin/categories/music-toys', { body: { status: 'approved' }, headers: { 'X-Admin-Key': adminKey } });
  assert.equal(approved.status, 200, JSON.stringify(approved.json));
  assert.equal(approved.json.category.suggested, false);
  const stats = await api('GET', '/api/admin/stats', { headers: { 'X-Admin-Key': adminKey } });
  assert.equal(stats.status, 200);
  assert.ok(stats.json.apps >= 15);
});

test('hiding an app takes it out of the directory; the admin can purge it', skip, async () => {
  const del = await api('DELETE', '/api/apps/test-snake-2', { headers: { 'X-Edit-Key': 'wrong' } });
  assert.equal(del.status, 403);
  const rm = await api('POST', '/api/apps/test-snake-2/remix', { body: {} });
  assert.equal(rm.status, 201, JSON.stringify(rm.json));
  const child = rm.json.app.slug;
  const childKey = rm.json.editKey;
  assert.equal((await api('DELETE', `/api/apps/${child}`, { headers: { 'X-Edit-Key': childKey } })).status, 204);
  assert.equal((await api('GET', `/api/apps/${child}`)).status, 404);
  assert.ok(!(await api('GET', '/api/apps?q=snake&perPage=48')).json.apps.some((a) => a.slug === child));
  const purge = await api('DELETE', `/api/apps/${child}?purge=1`, { headers: { 'X-Admin-Key': adminKey } });
  assert.equal(purge.status, 204);
  assert.ok(!fs.existsSync(path.join(root, 'data/apps', child)), 'the files are gone');
  // A seeded app has no edit key; the admin key manages it.
  assert.equal((await api('PATCH', '/api/apps/snake-game', { body: { description: 'x' }, headers: { 'X-Edit-Key': editKey } })).status, 403);
  assert.equal((await api('PATCH', '/api/apps/snake-game', { body: { tags: ['arcade', 'classic', 'seeded'] }, headers: { 'X-Admin-Key': adminKey } })).status, 200);
});

test('the share page carries the app into its meta tags', skip, async () => {
  const res = await fetch(`${base}/app/snake-game`, { headers: { Accept: 'text/html' } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /<title>Snake — SoftN<\/title>/);
  assert.match(html, /property="og:image" content="http:\/\/127\.0\.0\.1:\d+\/api\/apps\/snake-game\/thumbnail\?v=\d+"/);
  assert.match(html, /property="og:url" content="http:\/\/127\.0\.0\.1:\d+\/app\/snake-game"/);
  assert.match(html, /name="softn:app" content="snake-game"/);
  assert.doesNotMatch(html, /og:image:width/);
  const missing = await fetch(`${base}/app/no-such-app`);
  assert.equal(missing.status, 200);
  assert.match(await missing.text(), /<title>SoftN — a UI language and its runtime<\/title>/, 'an unknown app gets the plain site');
});

/**
 * Empty the rate-limit windows. The publish window is ten an hour per
 * visitor and every test here is the same visitor; a test that publishes
 * several bundles of its own starts from a clean window rather than from
 * whatever the tests before it left.
 */
function resetRateLimits() {
  const script = path.join(root, 'reset-ratelimit.php');
  fs.writeFileSync(script, "<?php $p = new PDO('sqlite:' . $argv[1]); $p->exec('DELETE FROM ratelimit');");
  const r = spawnSync('php', [script, path.join(root, 'data/directory.sqlite')], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`could not reset rate limits: ${r.stderr}`);
}

test("a bundle's declaration is held to the capability schema", skip, async () => {
  resetRateLimits();
  const { zipSync, strToU8 } = require('fflate');
  const withPermissionJson = (name, text) => {
    const files = {
      'manifest.json': strToU8(JSON.stringify({ name, version: '1.0.0', main: 'ui/main.ui', files: { ui: ['ui/main.ui'] } })),
      'ui/main.ui': strToU8('<App><Text>hello</Text></App>'),
      'permission.json': strToU8(text),
    };
    return zipSync(files);
  };
  const publish = async (bytes) => {
    const fd = new FormData();
    fd.append('bundle', new Blob([bytes]), 'app.softn');
    return api('POST', '/api/apps', { body: fd });
  };

  // accel is a capability the runtime enforces; the directory used to list
  // nine names and describe an app asking only for it as asking for nothing.
  const accel = await publish(makeBundle('Accelerated', { permissions: { accel: { enabled: true } } }));
  assert.equal(accel.status, 201, JSON.stringify(accel.json));
  assert.deepEqual(accel.json.app.capabilities, ['accel']);
  const page = await api('GET', '/api/apps/accelerated');
  assert.deepEqual(page.json.app.capabilities, ['accel']);

  const every = await publish(makeBundle('Everything', { permissions: Object.fromEntries(['net', 'camera', 'mic', 'files', 'qr', 'ai', 'gpu', 'sync', 'storage', 'accel'].map((c) => [c, { enabled: true }])) }));
  assert.equal(every.status, 201, JSON.stringify(every.json));
  assert.deepEqual(every.json.app.capabilities, ['net', 'camera', 'mic', 'files', 'qr', 'ai', 'gpu', 'sync', 'storage', 'accel']);

  // A declaration the runtime could not honour is refused with the name in
  // the message, not published as an app that asks for nothing.
  const unknown = await publish(withPermissionJson('Typo', JSON.stringify({ permissions: { network: { enabled: true } } })));
  assert.equal(unknown.status, 400, JSON.stringify(unknown.json));
  assert.match(unknown.json.error, /network/);
  assert.match(unknown.json.error, /accel/);

  const malformed = await publish(withPermissionJson('Malformed', JSON.stringify({ permissions: { net: { enabled: 'yes' }, camera: true } })));
  assert.equal(malformed.status, 400, JSON.stringify(malformed.json));
  assert.match(malformed.json.error, /net, camera/);

  const notJson = await publish(withPermissionJson('Broken', '{ "permissions": { "net": { "enabled": true }, } }'));
  assert.equal(notJson.status, 400, JSON.stringify(notJson.json));
  assert.match(notJson.json.error, /permission\.json/);

  const listNotObject = await publish(withPermissionJson('Listed', JSON.stringify({ permissions: ['net'] })));
  assert.equal(listNotObject.status, 400);

  // Disabled and absent are both "not requested"; an empty file is an empty declaration.
  const disabled = await publish(withPermissionJson('Quiet', JSON.stringify({ permissions: { net: { enabled: false }, files: {} } })));
  assert.equal(disabled.status, 201, JSON.stringify(disabled.json));
  assert.deepEqual(disabled.json.app.capabilities, []);
  const empty = await publish(withPermissionJson('Empty', '{}'));
  assert.equal(empty.status, 201, JSON.stringify(empty.json));
  assert.deepEqual(empty.json.app.capabilities, []);
});

test('storage collection policies: who may do what, per collection', skip, async () => {
  resetRateLimits();
  const fd = new FormData();
  const permissions = {
    storage: {
      enabled: true,
      collections: { scores: 'append-only', posts: 'owner-write', notes: 'private', config: 'publisher', '*': 'public' },
    },
  };
  fd.append('bundle', new Blob([makeBundle('Policy Board', { permissions })]), 'policy.softn');
  const pub = await api('POST', '/api/apps', { body: fd });
  assert.equal(pub.status, 201, JSON.stringify(pub.json));
  assert.deepEqual(pub.json.app.storagePolicies, permissions.storage.collections);
  const editKey = pub.json.editKey;
  const page = await api('GET', '/api/apps/policy-board');
  assert.deepEqual(page.json.app.storagePolicies, permissions.storage.collections);

  // Two visitors, told apart by the token their runtimes keep; and the publisher.
  const ann = { 'X-Visitor-Token': 'ann-token-0123456789abcdef' };
  const bob = { 'X-Visitor-Token': 'bob-token-0123456789abcdef' };
  const owner = { 'X-Edit-Key': editKey };
  const S = (body, headers = {}) => api('POST', '/api/apps/policy-board/storage', { body, headers });

  // append-only: anyone adds and reads; changing or removing needs the edit key.
  const s1 = await S({ op: 'insert', collection: 'scores', data: { player: 'Ann', score: 10 } }, ann);
  assert.equal(s1.status, 200, JSON.stringify(s1.json));
  const s2 = await S({ op: 'insert', collection: 'scores', data: { player: 'Anon', score: 5 } });
  assert.equal(s2.status, 200, 'no token needed to append');
  assert.equal((await S({ op: 'update', collection: 'scores', id: s1.json.result.id, data: { score: 999 } }, ann)).status, 403, 'not even by whoever added it');
  assert.equal((await S({ op: 'remove', collection: 'scores', id: s1.json.result.id }, bob)).status, 403);
  assert.equal((await S({ op: 'set', collection: 'scores', id: s1.json.result.id, data: { score: 1 } }, bob)).status, 403);
  const readBack = await S({ op: 'query', collection: 'scores' }, bob);
  assert.equal(readBack.json.result.total, 2, 'everyone reads');
  assert.equal((await S({ op: 'update', collection: 'scores', id: s1.json.result.id, data: { score: 11 } }, owner)).status, 200, 'the edit key can');
  assert.equal((await S({ op: 'remove', collection: 'scores', id: s2.json.result.id }, owner)).json.result.removed, 1);

  // owner-write: anyone reads; a record is changed or removed by whoever added it, or the publisher.
  const p1 = await S({ op: 'insert', collection: 'posts', data: { text: 'hello' } }, ann);
  assert.equal(p1.status, 200);
  assert.equal(p1.json.result.mine, true);
  assert.equal((await S({ op: 'insert', collection: 'posts', data: { text: 'anon' } })).status, 403, 'adding needs a token');
  const bobSees = await S({ op: 'query', collection: 'posts' }, bob);
  assert.equal(bobSees.json.result.total, 1);
  assert.equal(bobSees.json.result.records[0].mine, false);
  assert.equal((await S({ op: 'update', collection: 'posts', id: p1.json.result.id, data: { text: 'hijacked' } }, bob)).status, 403);
  assert.equal((await S({ op: 'remove', collection: 'posts', id: p1.json.result.id }, bob)).status, 403);
  const annEdit = await S({ op: 'update', collection: 'posts', id: p1.json.result.id, data: { text: 'edited' } }, ann);
  assert.equal(annEdit.status, 200, JSON.stringify(annEdit.json));
  assert.equal(annEdit.json.result.data.text, 'edited');
  assert.equal(annEdit.json.result.mine, true);
  assert.equal((await S({ op: 'set', collection: 'posts', id: p1.json.result.id, data: { text: 'replaced' } }, owner)).status, 200, 'the publisher can');
  assert.equal((await S({ op: 'get', collection: 'posts', id: p1.json.result.id }, ann)).json.result.mine, true, 'replacing does not adopt');
  assert.equal((await S({ op: 'remove', collection: 'posts', id: p1.json.result.id }, ann)).json.result.removed, 1);

  // private: each visitor sees only their own; nobody else, the publisher included.
  const n1 = await S({ op: 'insert', collection: 'notes', data: { text: "Ann's" } }, ann);
  assert.equal(n1.status, 200, JSON.stringify(n1.json));
  await S({ op: 'insert', collection: 'notes', data: { text: "Bob's" } }, bob);
  assert.equal((await S({ op: 'insert', collection: 'notes', data: { text: 'anon' } })).status, 403);
  assert.equal((await S({ op: 'query', collection: 'notes' })).status, 403, 'reading needs a token');
  const annNotes = await S({ op: 'query', collection: 'notes' }, ann);
  assert.equal(annNotes.json.result.total, 1);
  assert.equal(annNotes.json.result.records[0].data.text, "Ann's");
  assert.equal((await S({ op: 'count', collection: 'notes' }, bob)).json.result.count, 1);
  assert.equal((await S({ op: 'get', collection: 'notes', id: n1.json.result.id }, bob)).json.result, null, "Bob cannot see Ann's");
  assert.equal((await S({ op: 'update', collection: 'notes', id: n1.json.result.id, data: { text: 'x' } }, bob)).status, 404);
  assert.equal((await S({ op: 'remove', collection: 'notes', id: n1.json.result.id }, bob)).status, 404);
  const ownerReads = await S({ op: 'query', collection: 'notes' }, owner);
  assert.equal(ownerReads.status, 403, 'the edit key is not a visitor');
  const browse = await api('GET', '/api/apps/policy-board/storage/notes');
  assert.equal(browse.status, 403, 'nor is the browse route without a token');
  assert.equal((await S({ op: 'clear', collection: 'notes' }, owner)).json.result.removed, 2, 'clearing is still the publisher');

  // publisher: reading and writing need the edit key.
  assert.equal((await S({ op: 'insert', collection: 'config', data: { theme: 'dark' } }, ann)).status, 403);
  assert.equal((await S({ op: 'query', collection: 'config' }, ann)).status, 403);
  const cfg = await S({ op: 'set', collection: 'config', id: 'main', data: { theme: 'dark' } }, owner);
  assert.equal(cfg.status, 200, JSON.stringify(cfg.json));
  assert.equal((await S({ op: 'get', collection: 'config', id: 'main' }, owner)).json.result.data.theme, 'dark');

  // The default, spelled out as public: as it always was.
  const g = await S({ op: 'insert', collection: 'guestbook', data: { text: 'hi' } });
  assert.equal(g.status, 200);
  assert.equal((await S({ op: 'update', collection: 'guestbook', id: g.json.result.id, data: { text: 'bye' } }, bob)).status, 200);

  // A policy the directory does not know is refused at publication, by name.
  const badFd = new FormData();
  badFd.append('bundle', new Blob([makeBundle('Bad Policy', { permissions: { storage: { enabled: true, collections: { notes: 'readonly' } } } })]), 'bad.softn');
  const bad = await api('POST', '/api/apps', { body: badFd });
  assert.equal(bad.status, 400, JSON.stringify(bad.json));
  assert.match(bad.json.error, /notes=readonly/);
  assert.match(bad.json.error, /append-only/);
});

test('a collection listing shows each visitor what they may read', skip, async () => {
  // The policy board from the test above: scores (append-only), posts
  // (owner-write), notes (private), config (publisher), guestbook (public).
  const ann = { 'X-Visitor-Token': 'ann-token-0123456789abcdef' };
  const bob = { 'X-Visitor-Token': 'bob-token-0123456789abcdef' };
  const S = (body, headers = {}) => api('POST', '/api/apps/policy-board/storage', { body, headers });
  await S({ op: 'insert', collection: 'notes', data: { text: 'ann 1' } }, ann);
  await S({ op: 'insert', collection: 'notes', data: { text: 'ann 2' } }, ann);
  await S({ op: 'insert', collection: 'notes', data: { text: 'bob 1' } }, bob);
  const names = (r) => r.json.result.collections.map((c) => c.name);
  const count = (r, name) => r.json.result.collections.find((c) => c.name === name)?.records;

  const anon = await S({ op: 'collections' });
  assert.ok(!names(anon).includes('config'), "a visitor is not told about the publisher's collection");
  assert.ok(!names(anon).includes('notes'), 'nor about private notes without a token');
  assert.ok(names(anon).includes('scores'));

  const annSees = await S({ op: 'collections' }, ann);
  assert.equal(count(annSees, 'notes'), 2, 'a visitor sees the count of their own private records');
  assert.equal(count(await S({ op: 'collections' }, bob), 'notes'), 1);
  assert.ok(!names(annSees).includes('config'));
});

test('a write lands on the record the check saw, or not at all', skip, async () => {
  const ann = { 'X-Visitor-Token': 'ann-token-0123456789abcdef' };
  const bob = { 'X-Visitor-Token': 'bob-token-0123456789abcdef' };
  const S = (body, headers = {}) => api('POST', '/api/apps/policy-board/storage', { body, headers });
  // Ann adds a post, removes it, and Bob re-adds one under the same id. Ann's
  // authorization on the old record does not carry to Bob's new one.
  const p = await S({ op: 'insert', collection: 'posts', id: 'reused', data: { text: 'ann' } }, ann);
  assert.equal(p.status, 200, JSON.stringify(p.json));
  assert.equal((await S({ op: 'remove', collection: 'posts', id: 'reused' }, ann)).json.result.removed, 1);
  assert.equal((await S({ op: 'insert', collection: 'posts', id: 'reused', data: { text: 'bob' } }, bob)).status, 200);
  assert.equal((await S({ op: 'set', collection: 'posts', id: 'reused', data: { text: 'ann again' } }, ann)).status, 403);
  assert.equal((await S({ op: 'update', collection: 'posts', id: 'reused', data: { text: 'ann again' } }, ann)).status, 403);
  assert.equal((await S({ op: 'remove', collection: 'posts', id: 'reused' }, ann)).status, 403);
  assert.equal((await S({ op: 'get', collection: 'posts', id: 'reused' }, bob)).json.result.data.text, 'bob');
});

test('the storage quota is the data itself, and is enforced as it is written', skip, async () => {
  resetRateLimits();
  const fd = new FormData();
  fd.append('bundle', new Blob([makeBundle('Quota Board', { permissions: { storage: { enabled: true } } })]), 'quota.softn');
  const pub = await api('POST', '/api/apps', { body: fd });
  assert.equal(pub.status, 201, JSON.stringify(pub.json));
  const S = (body, headers = {}) => api('POST', '/api/apps/quota-board/storage', { body, headers });
  const blob = 'x'.repeat(15 * 1024);
  let full = null;
  for (let i = 0; i < 40 && full === null; i++) {
    const r = await S({ op: 'insert', collection: 'blobs', id: `b${i}`, data: { blob } });
    if (r.status === 507) full = i;
    else assert.equal(r.status, 200, JSON.stringify(r.json));
  }
  assert.ok(full !== null && full > 5, `the quota was reached after ${full} records`);
  const summary = (await api('GET', '/api/apps/quota-board')).json.app.storage;
  assert.ok(summary.bytes <= STORAGE_QUOTA_BYTES, `${summary.bytes} bytes of data is within the quota`);
  assert.ok(summary.bytes > STORAGE_QUOTA_BYTES - 16 * 1024, 'and close to it');
  assert.equal(typeof summary.diskBytes, 'number', 'what the files take on disk is reported separately');
  // Removing makes room; the key-value store shares the same quota.
  assert.equal((await S({ op: 'remove', collection: 'blobs', id: 'b0' })).json.result.removed, 1);
  assert.equal((await S({ op: 'insert', collection: 'blobs', id: 'again', data: { blob } })).status, 200);
  assert.equal((await S({ op: 'kvSet', key: 'big', value: blob })).status, 507);
  assert.equal((await S({ op: 'kvSet', key: 'small', value: 'ok' })).status, 200);
});

test('a launch and a run are counted apart', skip, async () => {
  const before = (await api('GET', '/api/apps/test-snake')).json.app;
  assert.equal((await api('POST', '/api/apps/test-snake/runs', { body: { stage: 'launch' } })).status, 204);
  assert.equal((await api('POST', '/api/apps/test-snake/runs', { body: { stage: 'open' } })).status, 204);
  assert.equal((await api('POST', '/api/apps/test-snake/runs')).status, 204, 'no stage is an open, as before');
  const after = (await api('GET', '/api/apps/test-snake')).json.app;
  assert.equal(after.launches, before.launches + 1);
  assert.equal(after.runs, before.runs + 2);
});

test('rate limits refuse a flood', skip, async () => {
  // The publish window is ten an hour; the tests above used some of it.
  let refused = false;
  for (let i = 0; i < 12; i++) {
    const r = await api('POST', '/api/apps', { raw: makeBundle(`Flood ${i}`), headers: { 'Content-Type': 'application/octet-stream' } });
    if (r.status === 429) {
      refused = true;
      assert.ok(Number(r.headers.get('retry-after')) > 0);
      assert.ok(r.json.retryAfter > 0);
      break;
    }
    assert.equal(r.status, 201);
  }
  assert.ok(refused, 'the eleventh publish in an hour is refused');
});

test('the admin key is not held to the publish limit; a wrong key is', skip, async () => {
  // The flood above left this visitor at the limit.
  const visitor = await api('POST', '/api/apps', { raw: makeBundle('Owner Batch 0'), headers: { 'Content-Type': 'application/octet-stream' } });
  assert.equal(visitor.status, 429, 'the visitor is still refused');
  const wrong = await api('POST', '/api/apps', {
    raw: makeBundle('Owner Batch 0'),
    headers: { 'Content-Type': 'application/octet-stream', 'X-Admin-Key': 'not-the-key' },
  });
  assert.equal(wrong.status, 429, 'a wrong admin key is a visitor');
  for (let i = 1; i <= 3; i++) {
    const owner = await api('POST', '/api/apps', {
      raw: makeBundle(`Owner Batch ${i}`),
      headers: { 'Content-Type': 'application/octet-stream', 'X-Admin-Key': adminKey },
    });
    assert.equal(owner.status, 201, JSON.stringify(owner.json));
    assert.equal(owner.json.app.slug, `owner-batch-${i}`);
  }
  resetRateLimits();
});

test('the api root describes itself and unknown routes are 404 JSON', skip, async () => {
  const idx = await api('GET', '/api');
  assert.equal(idx.status, 200);
  assert.ok(Array.isArray(idx.json.routes));
  const nope = await api('GET', '/api/nothing/here');
  assert.equal(nope.status, 404);
  assert.equal(nope.json.ok, false);
  const opt = await fetch(`${base}/api/apps`, { method: 'OPTIONS' });
  assert.equal(opt.status, 204);
  assert.equal(opt.headers.get('access-control-allow-origin'), '*');
});
