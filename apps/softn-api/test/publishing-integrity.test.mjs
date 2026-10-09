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
import { startServer, makeBundle, skip, PNG_1x1, pngDeclaring } from './helpers/harness.mjs';

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
  // A store with nothing in it is no promise to anyone: asking for a listing
  // used to leave one in the folder of an app that had no storage at all.
  fs.writeFileSync(path.join(s.dataDir, 'apps', pub.app.slug, 'storage.sqlite'), '');
  const added = await addVersion(s, pub.app.slug, pub.editKey, 'Plain App', storage({ notes: 'private', '*': 'publisher' }));
  assert.equal(added.status, 201, added.text);
  // From then on those policies are the promise.
  const changed = await addVersion(s, pub.app.slug, pub.editKey, 'Plain App', storage({ notes: 'public', '*': 'publisher' }));
  assert.equal(changed.status, 400, changed.text);
});

test('a version that switches storage off does not lift the freeze on its policies', skip, async () => {
  // The check asked whether the app's newest version declared storage. A
  // version with the same collections and `enabled: false` passed it, the app
  // then "had no storage", and the version after that could declare anything
  // over the records still in the store: every private note, public.
  const s = await server({ config: { limits: { storageWrite: [500, 60], storageRead: [500, 60] } } });
  const promised = { notes: 'private', '*': 'public' };
  const off = { storage: { enabled: false, collections: promised } };
  const ann = { 'X-Visitor-Token': 'ann-token-0123456789abcdef' };
  const note = (slug) => s.api('POST', `/api/apps/${slug}/storage`, { body: { op: 'insert', collection: 'notes', id: 'diary', data: { text: 'for my eyes' } }, headers: ann });
  const anonymous = (slug) => s.api('POST', `/api/apps/${slug}/storage`, { body: { op: 'query', collection: 'notes' } });

  const pub = await s.publish('Switched Off', { permissions: storage(promised) });
  const slug = pub.app.slug;
  assert.equal((await note(slug)).status, 200);
  // Storage off, the collections as they were: nothing changes, so it is taken.
  const closed = await addVersion(s, slug, pub.editKey, 'Switched Off', off);
  assert.equal(closed.status, 201, closed.text);
  // On again with `notes` public: the change the freeze is there to refuse.
  const opened = await addVersion(s, slug, pub.editKey, 'Switched Off', storage({ notes: 'public', '*': 'public' }));
  assert.equal(opened.status, 400, opened.text);
  assert.match(opened.json.error, /storage policy of notes/);
  // On again as it was promised: taken, and the note is still Ann's alone.
  const back = await addVersion(s, slug, pub.editKey, 'Switched Off', storage(promised));
  assert.equal(back.status, 201, back.text);
  assert.equal((await anonymous(slug)).status, 403);

  // An app whose storage was switched off before anything was remembered
  // (here, by a bundle put in its folder) still has its store, and the
  // records in it are held to what its declaration says.
  const old = await s.publish('Switched Off Before', { permissions: storage(promised) });
  assert.equal((await note(old.app.slug)).status, 200);
  fs.writeFileSync(path.join(s.dataDir, 'apps', old.app.slug, 'v2.softn'), makeBundle('Switched Off Before', { version: '2.0.0', permissions: off }));
  assert.deepEqual((await s.api('GET', `/api/apps/${old.app.slug}`)).json.app.capabilities, []);
  const reopened = await addVersion(s, old.app.slug, old.editKey, 'Switched Off Before', storage({ notes: 'public', '*': 'public' }));
  assert.equal(reopened.status, 400, reopened.text);
  assert.equal((await addVersion(s, old.app.slug, old.editKey, 'Switched Off Before', storage(promised))).status, 201);
  assert.equal((await anonymous(old.app.slug)).status, 403);
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

test('an empty object an app stores comes back as an object, not a list', skip, async () => {
  // PHP read `{}` and `[]` as the same empty array and wrote both back as
  // `[]`. An app that read its `{}` as `[]` and set a field on it saved `[]`
  // again: JSON.stringify drops a named property of an array.
  const s = await server({ config: { limits: { storageWrite: [500, 60], storageRead: [500, 60] } } });
  const pub = await s.publish('Empty Objects', { permissions: storage({ '*': 'public' }) });
  const S = (body) => s.api('POST', `/api/apps/${pub.app.slug}/storage`, { body });
  const data = { prefs: {}, tags: [], nested: { deep: {}, list: [{}, []] }, name: 'x' };
  const made = await S({ op: 'insert', collection: 'profiles', id: 'p1', data });
  assert.equal(made.status, 200, made.text);
  assert.deepEqual(made.json.result.data, data);
  assert.deepEqual((await S({ op: 'get', collection: 'profiles', id: 'p1' })).json.result.data, data);
  const listed = (await S({ op: 'query', collection: 'profiles' })).json.result.records;
  assert.deepEqual(listed.map((r) => r.data), [data]);
  // A patch keeps what it does not name, and its own empty object.
  const patched = (await S({ op: 'update', collection: 'profiles', id: 'p1', data: { extra: {}, name: 'y' } })).json.result;
  assert.deepEqual(patched.data, { ...data, extra: {}, name: 'y' });
  // A record with no fields is still an object.
  assert.deepEqual((await S({ op: 'set', collection: 'profiles', id: 'p2', data: {} })).json.result.data, {});
  assert.deepEqual((await S({ op: 'get', collection: 'profiles', id: 'p2' })).json.result.data, {});
  // Key-value: the value itself, and what is inside it.
  for (const value of [{}, [], { a: {}, b: [] }, [{}, []], 'text', 0, null]) {
    assert.equal((await S({ op: 'kvSet', key: 'k', value })).status, 200);
    assert.deepEqual((await S({ op: 'kvGet', key: 'k' })).json.result.value, value, JSON.stringify(value));
  }
  // An empty object in the request itself still asks for nothing.
  assert.equal((await S({ op: 'query', collection: 'profiles', where: {} })).json.result.total, 2);
  assert.equal((await S({ op: 'count', collection: 'profiles', where: {} })).json.result.count, 2);
});

test('an object whose keys are numbers comes back as an object, not a list', skip, async () => {
  // PHP holds `{"0":3,"1":5}` and `[3,5]` as the same array and wrote both
  // back as the list. `votes[i] = n` on an object is exactly that; read back
  // as a list, the next named property set on it is dropped when it is
  // saved. A record whose own fields were numbered was refused outright.
  const s = await server({ config: { limits: { storageWrite: [500, 60], storageRead: [500, 60] } } });
  const pub = await s.publish('Numbered Keys', { permissions: storage({ '*': 'public' }) });
  const S = (body) => s.api('POST', `/api/apps/${pub.app.slug}/storage`, { body });
  const data = { votes: { 0: 3, 1: 5 }, byId: { 7: 'x' }, list: [3, 5], deep: { 0: { 0: [{ 0: 'a' }, ['b']] } }, empty: {} };
  const made = await S({ op: 'insert', collection: 'polls', id: 'p1', data });
  assert.equal(made.status, 200, made.text);
  assert.deepEqual(made.json.result.data, data);
  assert.deepEqual((await S({ op: 'get', collection: 'polls', id: 'p1' })).json.result.data, data);
  assert.deepEqual((await S({ op: 'query', collection: 'polls' })).json.result.records.map((r) => r.data), [data]);
  // A record whose own fields are numbered is an object like any other.
  const numbered = await S({ op: 'set', collection: 'polls', id: 'p2', data: { 0: 'a', 1: 'b' } });
  assert.equal(numbered.status, 200, numbered.text);
  assert.deepEqual(numbered.json.result.data, { 0: 'a', 1: 'b' });
  assert.deepEqual((await S({ op: 'get', collection: 'polls', id: 'p2' })).json.result.data, { 0: 'a', 1: 'b' });
  // A patch lays its numbered fields over the record's, and stays an object.
  const patched = await S({ op: 'update', collection: 'polls', id: 'p2', data: { 1: 'c', 2: { 0: 'z' } } });
  assert.equal(patched.status, 200, patched.text);
  assert.deepEqual(patched.json.result.data, { 0: 'a', 1: 'c', 2: { 0: 'z' } });
  assert.deepEqual((await S({ op: 'get', collection: 'polls', id: 'p2' })).json.result.data, { 0: 'a', 1: 'c', 2: { 0: 'z' } });
  // Key-value: an object is an object and a list a list, at every depth.
  for (const value of [{ 0: 'a', 1: 'b' }, ['a', 'b'], { 0: { 0: 1 } }, [{ 0: 1 }, [1]]]) {
    const set = await S({ op: 'kvSet', key: 'k', value });
    assert.equal(set.status, 200, set.text);
    assert.deepEqual(set.json.result.value, value, JSON.stringify(value));
    assert.deepEqual((await S({ op: 'kvGet', key: 'k' })).json.result.value, value, JSON.stringify(value));
  }
  // A list is still not a record.
  assert.equal((await S({ op: 'insert', collection: 'polls', data: ['a', 'b'] })).status, 400);
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

test('a name that spells no slug is nobody else\'s app or category', skip, async () => {
  const s = await server({ config: { limits: { suggest: [50, 60] } } });
  const suggest = async (name) => {
    const r = await s.api('POST', '/api/categories', { body: { name, description: 'suggested by a visitor', emoji: '' } });
    assert.equal(r.status, 201, r.text);
    return r.json.category;
  };
  assert.equal((await s.publish('Before')).app.category, 'other');
  // A visitor suggests a category called "App": its id is the fallback every
  // empty or unspellable name used to slugify to.
  assert.equal((await suggest('App')).id, 'app');
  assert.equal((await s.publish('After')).app.category, 'other', 'an app published with no category was filed under the visitor\'s');
  assert.equal((await s.publish('Named', {}, { category: 'App' })).app.category, 'app', 'asked for by name, it is still found');

  // Two names in scripts a slug cannot hold are two categories.
  const first = await suggest('日本語');
  const second = await suggest('中文');
  assert.match(first.id, /^c-[0-9a-f]{12}$/);
  assert.notEqual(second.id, first.id, 'the second was answered with the first one\'s category');
  assert.equal((await suggest('日本語')).id, first.id, 'the same name is the same category');
  assert.equal((await s.publish('Filed', {}, { category: '中文' })).app.category, second.id);

  // And an address a slug cannot hold is not the app whose slug is `app`.
  assert.equal((await s.publish('App')).app.slug, 'app');
  assert.equal((await s.api('GET', '/api/apps/app')).status, 200);
  assert.equal((await s.api('GET', `/api/apps/${encodeURIComponent('日本語')}`)).status, 404);
});

test('the demo sync compares a demo with the version it wrote, and leaves a later version\'s app alone', skip, async () => {
  const s = await server({ config: { seedDemos: true } });
  const demos = path.join(s.root, 'demos');
  fs.mkdirSync(demos, { recursive: true });
  const demo = path.join(demos, 'SyncDemo.softn');
  fs.writeFileSync(demo, makeBundle('Sync Demo', { description: 'As shipped' }));
  fs.writeFileSync(path.join(demos, 'index.json'), JSON.stringify([{ id: 'sync-demo', name: 'Sync Demo', description: 'As shipped', file: 'SyncDemo.softn' }]));
  const list = () => s.api('GET', '/api/apps?perPage=48');
  const detail = async () => (await s.api('GET', '/api/apps/sync-demo')).json.app;
  const v1 = (app) => app.versions.find((v) => v.version === 1);
  assert.equal((await list()).status, 200);
  const seeded = await detail();
  assert.equal(seeded.source, 'seed');

  // The site owner publishes a second version, which declares storage.
  const next = await addVersion(s, 'sync-demo', null, 'Sync Demo', storage({ '*': 'public' }), { admin: true });
  assert.equal(next.status, 201, next.text);
  const published = await detail();
  assert.ok(published.capabilities.includes('storage'));
  await new Promise((r) => setTimeout(r, 1100));
  for (let i = 0; i < 3; i++) assert.equal((await list()).status, 200);
  const later = await detail();
  assert.deepEqual(later.capabilities, published.capabilities, 'version 1\'s capabilities were written over the app');
  assert.equal(later.updatedAt, published.updatedAt, 'every request moved the app\'s date');
  assert.deepEqual(v1(later), v1(published), 'every request rewrote version 1');

  // What each file hashed to is on record, and believed while the file is
  // as it was: with a wrong hash recorded, the demo is taken to have changed.
  const stampFile = path.join(s.dataDir, 'cache/seed.json');
  const stamps = JSON.parse(fs.readFileSync(stampFile, 'utf8'));
  const key = Object.keys(stamps).find((k) => k.replaceAll('\\', '/').endsWith('/demos/SyncDemo.softn'));
  assert.ok(key, JSON.stringify(Object.keys(stamps)));
  assert.equal(stamps[key][3], v1(later).sha256);
  stamps[key][3] = '0'.repeat(64);
  fs.writeFileSync(stampFile, JSON.stringify(stamps));
  assert.equal((await list()).status, 200);
  const trusted = await detail();
  assert.notEqual(v1(trusted).createdAt, v1(later).createdAt, 'the file was hashed again although nothing about it had changed');
  assert.deepEqual(trusted.capabilities, published.capabilities, 'and the later version\'s app is still left alone');

  // A demo that does change on disk is picked up, as version 1.
  fs.writeFileSync(demo, makeBundle('Sync Demo', { description: 'As shipped, second printing with more in it' }));
  assert.equal((await list()).status, 200);
  const replaced = await detail();
  assert.notEqual(v1(replaced).sha256, v1(later).sha256);
  assert.deepEqual(replaced.capabilities, published.capabilities);
  assert.equal(replaced.versions.length, 2);
});

test('the demo sync keeps what the operator set on a demo, and still brings its own up to date', skip, async () => {
  // A seeded demo has no edit key; the admin key changes it. The sync put its
  // category back to the built-in table's and its picture back to the shipped
  // screenshot on the next request, whatever the operator had just set.
  const s = await server({ config: { seedDemos: true } });
  const admin = { 'X-Admin-Key': s.adminKey };
  const demos = path.join(s.root, 'demos');
  fs.mkdirSync(path.join(demos, 'thumbs'), { recursive: true });
  // Three pictures of three sizes: the sync takes a file of the same size and time for the same file.
  const [shipped, retaken, own] = [0, 8, 16].map((padding) => Buffer.concat([pngDeclaring(4, 4), Buffer.alloc(padding)]));
  // Two demos the built-in table files under Games, each with a screenshot.
  for (const name of ['Twenty48', 'Blockfall']) {
    fs.writeFileSync(path.join(demos, `${name}.softn`), makeBundle(name));
    fs.writeFileSync(path.join(demos, `thumbs/${name}.png`), shipped);
  }
  fs.writeFileSync(path.join(demos, 'index.json'), JSON.stringify([{ id: 'twenty48', name: 'Twenty48', file: 'Twenty48.softn' }, { id: 'blockfall', name: 'Blockfall', file: 'Blockfall.softn' }]));
  const list = () => s.api('GET', '/api/apps?perPage=48');
  const category = async (slug) => (await s.api('GET', `/api/apps/${slug}`)).json.app.category;
  const picture = async (slug) => Buffer.from(await (await fetch(`${s.base}/api/apps/${slug}/thumbnail`)).arrayBuffer());
  assert.equal((await list()).status, 200);
  assert.equal(await category('twenty48'), 'games');
  assert.ok((await picture('twenty48')).equals(shipped));

  // The operator files one of them elsewhere and gives it a picture.
  const filed = await s.api('PATCH', '/api/apps/twenty48', { body: { category: 'tools' }, headers: admin });
  assert.equal(filed.status, 200, filed.text);
  const fd = new FormData();
  fd.append('thumbnail', new Blob([own], { type: 'image/png' }), 'thumb.png');
  assert.equal((await s.api('POST', '/api/apps/twenty48/thumbnail', { body: fd, headers: admin })).status, 200);
  for (let i = 0; i < 2; i++) assert.equal((await list()).status, 200);
  assert.equal(await category('twenty48'), 'tools', 'the sync filed the demo back where the table has it');
  assert.ok((await picture('twenty48')).equals(own), 'the sync put the shipped screenshot back');

  // A retaken screenshot still reaches the demo nobody touched, and only that one.
  for (const name of ['Twenty48', 'Blockfall']) fs.writeFileSync(path.join(demos, `thumbs/${name}.png`), retaken);
  assert.equal((await list()).status, 200);
  assert.ok((await picture('blockfall')).equals(retaken), 'the retaken screenshot did not reach the demo');
  assert.ok((await picture('twenty48')).equals(own), 'a retaken screenshot replaced the operator\'s picture');
  assert.equal(await category('blockfall'), 'games');
  assert.equal(await category('twenty48'), 'tools');
});

test('a picture the client already holds is answered 304', skip, async () => {
  const s = await server();
  const pub = await s.publish('Pictured', { icon: { path: 'assets/icon.png', bytes: PNG_1x1 } });
  const slug = pub.app.slug;
  for (const which of ['thumbnail', 'icon']) {
    const url = `${s.base}/api/apps/${slug}/${which}`;
    const first = await fetch(url);
    assert.equal(first.status, 200, which);
    assert.equal(first.headers.get('content-type'), 'image/png', which);
    const etag = first.headers.get('etag');
    assert.match(etag ?? '', /^"[0-9a-f]{32}"$/, which);
    assert.equal((await first.arrayBuffer()).byteLength, PNG_1x1.length);
    const again = await fetch(url, { headers: { 'If-None-Match': etag } });
    assert.equal(again.status, 304, `${which}: the picture was sent again`);
    assert.equal(again.headers.get('etag'), etag);
    assert.equal(again.headers.get('content-type'), 'image/png');
    assert.equal((await again.arrayBuffer()).byteLength, 0);
    // Another tag, or none, is answered with the picture.
    assert.equal((await fetch(url, { headers: { 'If-None-Match': '"0"' } })).status, 200);
  }
});

test('an app keeps ninety days of daily run counts, not every day it ever ran', skip, async () => {
  const s = await server({ config: { limits: { run: [50, 60] } } });
  const pub = await s.publish('Counted');
  const file = path.join(s.dataDir, 'apps', pub.app.slug, 'app.json');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const today = Math.floor(Date.now() / 86400000);
  // Three years of days, one run each.
  doc.runsDaily = Array.from({ length: 1000 }, (_, i) => ({ slug: pub.app.slug, day: today - 1000 + i, count: 1 }));
  fs.writeFileSync(file, JSON.stringify(doc));
  assert.equal((await s.api('POST', `/api/apps/${pub.app.slug}/runs`)).status, 204);
  const kept = JSON.parse(fs.readFileSync(file, 'utf8')).runsDaily;
  assert.equal(kept.length, 90, `${kept.length} days kept`);
  assert.deepEqual(kept.at(-1), { slug: pub.app.slug, day: today, count: 1 });
  assert.equal(kept[0].day, today - 89);
});
