/**
 * What a publish, a new version and the demo sync may not do to an app that
 * is already there.
 *
 * Each case here let one request change something a person had been told
 * was settled: a publisher's next version re-declared a collection's policy
 * and so read every visitor's private records; a publish answered 400 for a
 * picture it did not like after the app was already listed, with an edit
 * key nobody was sent; `?v=` served version 1 under the cache lifetime of a
 * pinned version; and a release that added a demo took over the app of a
 * visitor who had published under that name first.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, makeBundle, skip, PNG_1x1 } from './helpers/harness.mjs';

const servers = [];
after(() => servers.forEach((s) => s.stop()));

async function server(options = {}) {
  const s = await startServer({ prefix: 'softn-integrity-', ...options });
  servers.push(s);
  return s;
}

const storage = (collections) => ({ storage: { enabled: true, collections } });

/** Upload a new version of `slug` as its publisher (or as the operator). */
function addVersion(s, slug, editKey, name, permissions, { admin = false } = {}) {
  const fd = new FormData();
  fd.append('bundle', new Blob([makeBundle(name, { version: '2.0.0', permissions })]), 'next.softn');
  if (!admin) fd.append('editKey', editKey);
  return s.api('POST', `/api/apps/${slug}/versions`, { body: fd, headers: admin ? { 'X-Admin-Key': s.adminKey } : {} });
}

test("a publisher's new version cannot change a collection's storage policy", skip, async () => {
  const s = await server({ config: { limits: { storageWrite: [500, 60], storageRead: [500, 60] } } });
  const pub = await s.publish('Private Notes', { permissions: storage({ notes: 'private', scores: 'append-only', '*': 'public' }) });
  const slug = pub.app.slug;
  const ann = { 'X-Visitor-Token': 'ann-token-0123456789abcdef' };

  const written = await s.api('POST', `/api/apps/${slug}/storage`, { body: { op: 'insert', collection: 'notes', data: { text: 'for my eyes' } }, headers: ann });
  assert.equal(written.status, 200, written.text);
  const anonymous = () => s.api('POST', `/api/apps/${slug}/storage`, { body: { op: 'query', collection: 'notes' } });
  assert.equal((await anonymous()).status, 403, 'a private collection is not read without a visitor token');

  // The move: the same app, `notes` now public.
  const opened = await addVersion(s, slug, pub.editKey, 'Private Notes', storage({ notes: 'public', scores: 'append-only', '*': 'public' }));
  assert.equal(opened.status, 400, opened.text);
  assert.match(opened.json.error, /storage policy of notes/);
  assert.equal((await s.api('GET', `/api/apps/${slug}`)).json.app.versions.length, 1, 'no version was added');
  assert.equal((await anonymous()).status, 403, 'and the records are still private');

  // Loosening through the wildcard is the same change, said differently.
  const viaStar = await addVersion(s, slug, pub.editKey, 'Private Notes', storage({ '*': 'public' }));
  assert.equal(viaStar.status, 400, viaStar.text);
  assert.match(viaStar.json.error, /notes/);
  assert.match(viaStar.json.error, /scores/);

  // Dropping the storage declaration altogether leaves every collection public.
  const dropped = await addVersion(s, slug, pub.editKey, 'Private Notes', undefined);
  assert.equal(dropped.status, 400, dropped.text);

  // The same rules, re-spelled, are not a change: `drafts` was public through `*`.
  const respelled = await addVersion(s, slug, pub.editKey, 'Private Notes', storage({ notes: 'private', scores: 'append-only', drafts: 'public', '*': 'public' }));
  assert.equal(respelled.status, 201, respelled.text);
  assert.equal((await anonymous()).status, 403);

  // The operator's word is still the operator's.
  const byAdmin = await addVersion(s, slug, pub.editKey, 'Private Notes', storage({ notes: 'owner-write', scores: 'append-only', '*': 'public' }), { admin: true });
  assert.equal(byAdmin.status, 201, byAdmin.text);
});

test('an app that had no storage may add it in a later version', skip, async () => {
  const s = await server();
  const pub = await s.publish('Plain App');
  const added = await addVersion(s, pub.app.slug, pub.editKey, 'Plain App', storage({ notes: 'private', '*': 'publisher' }));
  assert.equal(added.status, 201, added.text);
  // From then on those policies are the promise.
  const changed = await addVersion(s, pub.app.slug, pub.editKey, 'Plain App', storage({ notes: 'public', '*': 'publisher' }));
  assert.equal(changed.status, 400, changed.text);
});

test('a publish whose picture is refused publishes nothing', skip, async () => {
  const s = await server();
  const listed = async () => (await s.api('GET', '/api/apps?perPage=48')).json.apps.map((a) => a.slug);
  const attempt = (thumbnail) => {
    const fd = new FormData();
    fd.append('bundle', new Blob([makeBundle('Picture Trouble')]), 'app.softn');
    fd.append('thumbnail', new Blob([thumbnail], { type: 'image/png' }), 'thumb.png');
    return s.api('POST', '/api/apps', { body: fd });
  };

  const refused = await attempt(Buffer.from('this is not a picture'));
  assert.equal(refused.status, 400, refused.text);
  assert.deepEqual(await listed(), [], 'the app was not created behind the refusal');
  assert.ok(!fs.existsSync(path.join(s.dataDir, 'apps/picture-trouble')));

  // The retry is the first publish, under the name asked for, with its key.
  const ok = await attempt(PNG_1x1);
  assert.equal(ok.status, 201, ok.text);
  assert.equal(ok.json.app.slug, 'picture-trouble');
  assert.ok(typeof ok.json.editKey === 'string' && ok.json.editKey.length > 20);
  assert.deepEqual(await listed(), ['picture-trouble']);
});

test('a remix whose picture is refused creates nothing', skip, async () => {
  const s = await server();
  const parent = await s.publish('Remix Source');
  const fd = new FormData();
  fd.append('thumbnail', new Blob([Buffer.from('not a picture either')], { type: 'image/png' }), 'thumb.png');
  const refused = await s.api('POST', `/api/apps/${parent.app.slug}/remix`, { body: fd });
  assert.equal(refused.status, 400, refused.text);
  const slugs = (await s.api('GET', '/api/apps?perPage=48')).json.apps.map((a) => a.slug);
  assert.deepEqual(slugs, [parent.app.slug]);
});

test('?v= names a version or is left out; anything else is refused, not read as version 1', skip, async () => {
  const s = await server();
  const pub = await s.publish('Two Versions');
  const slug = pub.app.slug;
  const second = await addVersion(s, slug, pub.editKey, 'Two Versions');
  assert.equal(second.status, 201, second.text);

  const sha = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
  const get = async (query) => {
    const r = await fetch(`${s.base}/api/apps/${slug}/bundle.softn${query}`);
    return { status: r.status, cache: r.headers.get('cache-control') ?? '', sha: r.status === 200 ? sha(Buffer.from(await r.arrayBuffer())) : null };
  };
  const { versions } = (await s.api('GET', `/api/apps/${slug}`)).json.app;
  const digest = Object.fromEntries(versions.map((v) => [v.version, v.sha256]));
  assert.notEqual(digest[1], digest[2]);

  const latest = await get('');
  const pinned = await get('?v=1');
  assert.equal(latest.sha, digest[2]);
  assert.equal(pinned.sha, digest[1]);
  assert.match(pinned.cache, /max-age=86400/);

  // An empty v is no version named: the latest, under the latest's caching.
  const empty = await get('?v=');
  assert.equal(empty.sha, digest[2], '?v= served an old version');
  assert.equal(empty.cache, latest.cache);
  const withDownload = await get('?v=&download=1');
  assert.equal(withDownload.sha, digest[2]);

  for (const bad of ['?v=latest', '?v=0', '?v=-1', '?v=1x', '?v=1.5']) {
    const r = await get(bad);
    assert.equal(r.status, 400, `${bad} answered ${r.status}`);
  }
  assert.equal((await get('?v=9')).status, 404);

  // The source listing reads the same parameter the same way.
  assert.equal((await s.api('GET', `/api/apps/${slug}/source?v=`)).json.version, 2);
  assert.equal((await s.api('GET', `/api/apps/${slug}/source?v=1`)).json.version, 1);
  assert.equal((await s.api('GET', `/api/apps/${slug}/source?v=latest`)).status, 400);
});

test('the storage quota is counted in bytes, whatever the text is made of', skip, async () => {
  // SQLite's LENGTH of text counts characters, and what is about to be
  // written was measured in bytes: text that is not ASCII was admitted at
  // several times the quota.
  const QUOTA = 96 * 1024;
  const s = await server({ config: { storage: { maxDatabaseBytes: QUOTA }, limits: { storageWrite: [500, 60], storageRead: [500, 60] } } });
  const pub = await s.publish('Wide Text', { permissions: storage({ '*': 'public' }) });
  const S = (body) => s.api('POST', `/api/apps/${pub.app.slug}/storage`, { body });
  // 3,000 characters, 12,000 bytes.
  const text = '\u{1F600}'.repeat(3000);
  assert.equal(Buffer.byteLength(text), 12000);
  let full = null;
  for (let i = 0; i < 40 && full === null; i++) {
    const r = await S({ op: 'insert', collection: 'notes', id: `n${i}`, data: { text } });
    if (r.status === 507) full = i;
    else assert.equal(r.status, 200, r.text);
  }
  // Seven or eight 12 KB records fit in 96 KB; counted in characters, thirty did.
  assert.ok(full !== null && full <= 8, `the quota was reached after ${full} records`);
  const summary = (await s.api('GET', `/api/apps/${pub.app.slug}`)).json.app.storage;
  assert.ok(summary.bytes <= QUOTA, `${summary.bytes} bytes reported within a quota of ${QUOTA}`);
  assert.ok(summary.bytes >= full * 12000, `${summary.bytes} bytes reported for ${full} records of 12,000`);
  // The key-value side shares the count.
  assert.equal((await S({ op: 'kvSet', key: 'wide', value: text })).status, 507);
});

test('a storage file that is not a database is a 503 for storage and leaves the app\'s page up', skip, async () => {
  const s = await server();
  const pub = await s.publish('Broken Store', { permissions: storage({ '*': 'public' }) });
  const slug = pub.app.slug;
  const S = (body) => s.api('POST', `/api/apps/${slug}/storage`, { body });
  assert.equal((await S({ op: 'insert', collection: 'notes', data: { n: 1 } })).status, 200);
  // What a truncated or half-restored file looks like.
  const file = path.join(s.dataDir, 'apps', slug, 'storage.sqlite');
  for (const suffix of ['-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
  fs.writeFileSync(file, 'this is not a database, though it sits where one should be');

  const detail = await s.api('GET', `/api/apps/${slug}`);
  assert.equal(detail.status, 200, detail.text);
  assert.equal(detail.json.app.name, 'Broken Store');
  assert.equal(detail.json.app.storage.unavailable, true);
  assert.equal(detail.json.app.storage.records, 0);

  const call = await S({ op: 'query', collection: 'notes' });
  assert.equal(call.status, 503, call.text);
  assert.match(call.json.error, /database cannot be opened/);
  // The list and the other apps are untouched.
  assert.equal((await s.api('GET', '/api/apps?perPage=48')).status, 200);
});

test('the demo sync leaves an app it did not create alone', skip, async () => {
  const s = await server({ config: { seedDemos: true } });
  // A visitor publishes under a plain name...
  const fd = new FormData();
  fd.append('bundle', new Blob([makeBundle('Zebra Board', { description: 'A board of my own' })]), 'app.softn');
  const mine = await s.api('POST', '/api/apps', { body: fd });
  assert.equal(mine.status, 201, mine.text);
  assert.equal(mine.json.app.slug, 'zebra-board');
  const before = (await s.api('GET', '/api/apps/zebra-board')).json.app;

  // ...and a later release ships a demo with that id.
  const demos = path.join(s.root, 'demos');
  fs.mkdirSync(demos, { recursive: true });
  fs.writeFileSync(path.join(demos, 'ZebraDemo.softn'), makeBundle('Zebra Demo', { description: 'The official demo', version: '3.0.0' }));
  fs.writeFileSync(path.join(demos, 'index.json'), JSON.stringify([{ id: 'zebra-board', name: 'Zebra Demo', description: 'The official demo', file: 'ZebraDemo.softn' }]));

  for (let i = 0; i < 2; i++) assert.equal((await s.api('GET', '/api/apps?perPage=48')).status, 200);
  const after = (await s.api('GET', '/api/apps/zebra-board')).json.app;
  assert.equal(after.name, 'Zebra Board', 'the visitor\'s app was renamed to the demo');
  assert.equal(after.description, 'A board of my own');
  assert.deepEqual(after.versions.map((v) => v.sha256), before.versions.map((v) => v.sha256), 'its bundle was replaced');
  assert.equal(after.source, before.source);
});
