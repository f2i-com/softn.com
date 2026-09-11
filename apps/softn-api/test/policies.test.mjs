/**
 * The threat-boundary matrix for per-app storage (QA-02, fixture F17): each
 * collection policy against each visitor identity, with and without the
 * edit key, one request at a time and many at once; and the edit key's
 * confinement to the one reply that hands it out.
 *
 * The policies existed and were tested one path at a time; what was not
 * pinned was the whole grid, what N simultaneous writers get, and that no
 * listing, search, comment, page or storage reply ever carries the key or
 * its hash. This suite is that grid. It publishes its own app on a fresh
 * server and never reaches a real directory.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, skip } from './helpers/harness.mjs';

const permissions = {
  storage: {
    enabled: true,
    collections: { scores: 'append-only', posts: 'owner-write', notes: 'private', config: 'publisher', '*': 'public' },
  },
};

let s = null;
let slug = '';
let editKey = '';
const ANN = 'ann-token-0123456789abcdef';
const BOB = 'bob-token-0123456789abcdef';
/** The identities of the matrix. `owner` holds the edit key; `anon` sent nothing. */
let actors = {};

before(async () => {
  s = await startServer({ config: { limits: { storageWrite: [5000, 60], storageRead: [5000, 60], comment: [50, 600] } }, prefix: 'softn-policies-' });
  const pub = await s.publish('Matrix Board', { permissions }, { category: 'tools', description: 'A board for the matrix' });
  slug = pub.app.slug;
  editKey = pub.editKey;
  actors = {
    anon: {},
    ann: { 'X-Visitor-Token': ANN },
    bob: { 'X-Visitor-Token': BOB },
    owner: { 'X-Edit-Key': editKey },
  };
});

after(() => s?.stop());

const S = (body, headers = {}) => s.api('POST', `/api/apps/${slug}/storage`, { body, headers });

/**
 * The grid. For each policy: who may add, read, change a record someone
 * else added, change their own, remove, and clear. A record "someone else"
 * added is Ann's — or the owner's, where only the owner may add.
 */
const matrix = {
  'append-only': {
    collection: 'scores',
    seededBy: 'ann',
    insert: { anon: 200, ann: 200, bob: 200, owner: 200 },
    read: { anon: 200, ann: 200, bob: 200, owner: 200 },
    updateOther: { anon: 403, bob: 403, ann: 403, owner: 200 },
    removeOther: { anon: 403, bob: 403, ann: 403, owner: 200 },
    clear: { anon: 403, ann: 403, bob: 403, owner: 200 },
  },
  'owner-write': {
    collection: 'posts',
    seededBy: 'ann',
    insert: { anon: 403, ann: 200, bob: 200, owner: 200 },
    read: { anon: 200, ann: 200, bob: 200, owner: 200 },
    updateOther: { anon: 403, bob: 403, ann: 200, owner: 200 },
    removeOther: { anon: 403, bob: 403, ann: 200, owner: 200 },
    clear: { anon: 403, ann: 403, bob: 403, owner: 200 },
  },
  private: {
    collection: 'notes',
    seededBy: 'ann',
    insert: { anon: 403, ann: 200, bob: 200, owner: 403 },
    read: { anon: 403, ann: 200, bob: 200, owner: 403 },
    updateOther: { anon: 403, bob: 404, owner: 403, ann: 200 },
    removeOther: { anon: 403, bob: 404, owner: 403, ann: 200 },
    clear: { anon: 403, ann: 403, bob: 403, owner: 200 },
  },
  publisher: {
    collection: 'config',
    seededBy: 'owner',
    insert: { anon: 403, ann: 403, bob: 403, owner: 200 },
    read: { anon: 403, ann: 403, bob: 403, owner: 200 },
    updateOther: { anon: 403, ann: 403, bob: 403, owner: 200 },
    removeOther: { anon: 403, ann: 403, bob: 403, owner: 200 },
    clear: { anon: 403, ann: 403, bob: 403, owner: 200 },
  },
  public: {
    collection: 'guestbook',
    seededBy: 'ann',
    insert: { anon: 200, ann: 200, bob: 200, owner: 200 },
    read: { anon: 200, ann: 200, bob: 200, owner: 200 },
    updateOther: { anon: 200, bob: 200, ann: 200, owner: 200 },
    removeOther: { anon: 200, bob: 200, ann: 200, owner: 200 },
    clear: { anon: 403, ann: 403, bob: 403, owner: 200 },
  },
};

for (const [policy, spec] of Object.entries(matrix)) {
  test(`policy ${policy}: the grid of who may add, read, change, remove and clear`, skip, async () => {
    const c = spec.collection;
    const seed = async (id) => {
      const r = await S({ op: 'insert', collection: c, id, data: { text: 'seeded', by: spec.seededBy } }, actors[spec.seededBy]);
      assert.equal(r.status, 200, `seeding ${c}/${id}: ${r.text}`);
    };
    for (const [actor, status] of Object.entries(spec.insert)) {
      const r = await S({ op: 'insert', collection: c, id: `ins-${actor}`, data: { by: actor } }, actors[actor]);
      assert.equal(r.status, status, `${policy} insert by ${actor}: ${r.text}`);
      if (status === 200) assert.equal(r.json.result.mine, actor === 'ann' || actor === 'bob', 'mine says whether a visitor added it');
    }
    await seed('readable');
    for (const [actor, status] of Object.entries(spec.read)) {
      const got = await S({ op: 'get', collection: c, id: 'readable' }, actors[actor]);
      assert.equal(got.status, status, `${policy} get by ${actor}: ${got.text}`);
      const q = await S({ op: 'query', collection: c }, actors[actor]);
      assert.equal(q.status, status, `${policy} query by ${actor}: ${q.text}`);
      if (status === 200 && policy === 'private') {
        const own = actor === spec.seededBy;
        assert.equal(got.json.result !== null, own, `${actor} ${own ? 'sees' : 'does not see'} the private record`);
        assert.ok(q.json.result.records.every((r) => r.mine), `${actor} sees only their own private records`);
      } else if (status === 200) {
        assert.equal(got.json.result.data.text, 'seeded');
      }
    }
    // Changing and removing what someone else added; the order puts the
    // actors that may succeed last, so the record is there for the refusals.
    await seed('theirs');
    for (const [actor, status] of Object.entries(spec.updateOther)) {
      const r = await S({ op: 'update', collection: c, id: 'theirs', data: { text: `changed by ${actor}` } }, actors[actor]);
      assert.equal(r.status, status, `${policy} update by ${actor}: ${r.text}`);
      const setR = await S({ op: 'set', collection: c, id: 'theirs', data: { text: `set by ${actor}` } }, actors[actor]);
      assert.equal(setR.status, status, `${policy} set by ${actor}: ${setR.text}`);
    }
    const after = await S({ op: 'get', collection: c, id: 'theirs' }, actors[spec.seededBy]);
    const lastAllowed = Object.entries(spec.updateOther).filter(([, st]) => st === 200).pop()?.[0];
    assert.equal(after.json.result.data.text, `set by ${lastAllowed}`, `${policy}: only the allowed writes landed`);
    for (const [actor, status] of Object.entries(spec.removeOther)) {
      const r = await S({ op: 'remove', collection: c, id: 'theirs' }, actors[actor]);
      assert.equal(r.status, status, `${policy} remove by ${actor}: ${r.text}`);
      if (status === 200) {
        const gone = actor === Object.entries(spec.removeOther).find(([, st]) => st === 200)[0];
        assert.equal(r.json.result.removed, gone ? 1 : 0, `${actor} removed it${gone ? '' : ' (already gone)'}`);
      }
    }
    for (const [actor, status] of Object.entries(spec.clear)) {
      const r = await S({ op: 'clear', collection: c }, actors[actor]);
      assert.equal(r.status, status, `${policy} clear by ${actor}: ${r.text}`);
    }
    if (policy !== 'publisher' && policy !== 'private') {
      assert.equal((await S({ op: 'count', collection: c }, actors.ann)).json.result.count, 0, 'cleared');
    }
  });
}

/** N requests at once; the built-in server queues them, independent workers race them — either way the outcome is what is asserted. */
const parallel = (n, fn) => Promise.all(Array.from({ length: n }, (_, i) => fn(i)));
const N = 12;

test('concurrent writes: the unauthorised are all refused and the authorised commit exactly once', skip, async () => {
  // Twelve inserts of one id into an append-only collection, from every kind of visitor: one record.
  const who = ['anon', 'ann', 'bob', 'owner'];
  const race = await parallel(N, (i) => S({ op: 'insert', collection: 'scores', id: 'race', data: { by: who[i % 4], i } }, actors[who[i % 4]]));
  assert.deepEqual(
    race.map((r) => r.status).sort(),
    [200, ...Array(N - 1).fill(409)],
    race.map((r) => r.status).join(',')
  );
  assert.equal((await S({ op: 'count', collection: 'scores' }, actors.ann)).json.result.count, 1);

  // Twelve attempts by Bob on Ann's owner-write record: none land; twelve by Ann: all do, one at a time.
  const mine = await S({ op: 'insert', collection: 'posts', id: 'mine', data: { text: 'ann wrote this', n: 0 } }, actors.ann);
  assert.equal(mine.status, 200, mine.text);
  const bobs = await parallel(N, (i) => S({ op: 'update', collection: 'posts', id: 'mine', data: { text: `bob ${i}` } }, actors.bob));
  assert.ok(bobs.every((r) => r.status === 403), bobs.map((r) => r.status).join(','));
  const anons = await parallel(N, (i) => S({ op: 'set', collection: 'posts', id: 'mine', data: { text: `anon ${i}` } }));
  assert.ok(anons.every((r) => r.status === 403));
  assert.equal((await S({ op: 'get', collection: 'posts', id: 'mine' }, actors.bob)).json.result.data.text, 'ann wrote this');
  const anns = await parallel(N, (i) => S({ op: 'update', collection: 'posts', id: 'mine', data: { text: `ann ${i}` } }, actors.ann));
  assert.ok(anns.every((r) => r.status === 200), anns.map((r) => r.status).join(','));
  const final = (await S({ op: 'get', collection: 'posts', id: 'mine' }, actors.ann)).json.result.data.text;
  assert.match(final, /^ann \d+$/, 'the record holds one of the authorised writes');
  assert.equal((await S({ op: 'count', collection: 'posts' }, actors.ann)).json.result.count, 1, 'and there is still one record');

  // Twelve visitors setting the publisher's record at once: refused; twelve removals by the owner: one removes.
  assert.equal((await S({ op: 'set', collection: 'config', id: 'main', data: { theme: 'dark' } }, actors.owner)).status, 200);
  const visitors = await parallel(N, (i) => S({ op: 'set', collection: 'config', id: 'main', data: { theme: `hijacked ${i}` } }, actors[i % 2 ? 'ann' : 'bob']));
  assert.ok(visitors.every((r) => r.status === 403));
  assert.equal((await S({ op: 'get', collection: 'config', id: 'main' }, actors.owner)).json.result.data.theme, 'dark');
  const removals = await parallel(N, () => S({ op: 'remove', collection: 'config', id: 'main' }, actors.owner));
  assert.ok(removals.every((r) => r.status === 200));
  assert.deepEqual(
    removals.map((r) => r.json.result.removed).sort(),
    [...Array(N - 1).fill(0), 1],
    'exactly one removal removed it'
  );

  // Twelve of Bob's removals of Ann's private note: none; it is still hers.
  const secret = await S({ op: 'insert', collection: 'notes', id: 'secret', data: { text: 'mine alone' } }, actors.ann);
  assert.equal(secret.status, 200);
  const prying = await parallel(N, () => S({ op: 'remove', collection: 'notes', id: 'secret' }, actors.bob));
  assert.ok(prying.every((r) => r.status === 404), prying.map((r) => r.status).join(','));
  assert.equal((await S({ op: 'get', collection: 'notes', id: 'secret' }, actors.ann)).json.result.data.text, 'mine alone');
});

test('independent PHP processes racing on one record: one insert wins, every unauthorised change is refused', skip, async () => {
  // Separate PHP processes, started together, each taking SQLite's write
  // lock and the catalogue lock for one storage operation.
  const { spawn } = await import('node:child_process');
  const launch = (job) =>
    new Promise((resolve) => {
      const file = path.join(s.dataDir, `race-${crypto.randomUUID()}.php`);
      const libs = path.resolve(s.root, 'api').replace(/\\/g, '/');
      const server = {
        REQUEST_METHOD: 'POST',
        REQUEST_URI: `/api/apps/${slug}/storage`,
        REMOTE_ADDR: job.ip ?? '127.0.0.1',
        ...(job.token ? { HTTP_X_VISITOR_TOKEN: job.token } : {}),
        ...(job.key ? { HTTP_X_EDIT_KEY: job.key } : {}),
      };
      fs.writeFileSync(
        file,
        `<?php
putenv('SOFTN_DATA_DIR=' . $argv[1]);
foreach (['http', 'db', 'catalog', 'bundle', 'apps', 'storage', 'social'] as $lib) require ${JSON.stringify(libs)} . '/lib/' . $lib . '.php';
foreach (json_decode(${JSON.stringify(JSON.stringify(server))}, true) as $k => $v) $_SERVER[$k] = $v;
$job = json_decode(${JSON.stringify(JSON.stringify(job))}, true);
$r = Request::fromGlobals();
try { echo json_encode(['status' => 200, 'result' => Storage::run($r, ${JSON.stringify(slug)}, $job['body'])]); }
catch (ApiError $e) { echo json_encode(['status' => $e->status, 'error' => $e->getMessage()]); }`
      );
      const p = spawn('php', ['-d', 'error_log=', file, s.dataDir], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (err += d));
      p.on('exit', (code) => {
        fs.unlinkSync(file);
        resolve(code === 0 && out ? JSON.parse(out) : { status: -1, error: err });
      });
    });
  const P = 8;
  const ips = (i) => `10.9.0.${i + 1}`;
  const inserts = await Promise.all(
    Array.from({ length: P }, (_, i) => launch({ ip: ips(i), token: i % 2 ? ANN : BOB, body: { op: 'insert', collection: 'scores', id: 'proc-race', data: { i } } }))
  );
  assert.deepEqual(inserts.map((r) => r.status).sort(), [200, ...Array(P - 1).fill(409)], JSON.stringify(inserts));
  const changes = await Promise.all(
    Array.from({ length: P }, (_, i) => launch({ ip: ips(i), token: i % 2 ? ANN : BOB, body: { op: 'update', collection: 'scores', id: 'proc-race', data: { i: 'hijacked' } } }))
  );
  assert.ok(changes.every((r) => r.status === 403), JSON.stringify(changes));
  const ownerEdits = await Promise.all(
    Array.from({ length: P }, (_, i) => launch({ ip: ips(i), key: editKey, body: { op: 'update', collection: 'scores', id: 'proc-race', data: { edit: i } } }))
  );
  assert.ok(ownerEdits.every((r) => r.status === 200), JSON.stringify(ownerEdits));
  const record = (await S({ op: 'get', collection: 'scores', id: 'proc-race' })).json.result;
  assert.equal(typeof record.data.edit, 'number', 'one of the owner edits is the record');
  assert.notEqual(record.data.i, 'hijacked');
  assert.equal((await S({ op: 'count', collection: 'scores' })).json.result.count, 2, 'race and proc-race');
});

test('the edit key appears in the publish reply and nowhere else — not in listings, search, comments, pages or storage', skip, async () => {
  const hash = crypto.createHash('sha256').update(editKey).digest('hex');
  assert.equal((await s.api('POST', `/api/apps/${slug}/comments`, { body: { name: 'Ann', body: 'A comment for the scan.' } })).status, 201);
  assert.equal((await s.api('POST', `/api/apps/${slug}/rating`, { body: { stars: 4 } })).status, 200);
  const responses = {
    listing: await s.api('GET', '/api/apps?perPage=48'),
    search: await s.api('GET', '/api/apps?q=matrix'),
    detail: await s.api('GET', `/api/apps/${slug}`),
    comments: await s.api('GET', `/api/apps/${slug}/comments`),
    rating: await s.api('GET', `/api/apps/${slug}/rating`),
    source: await s.api('GET', `/api/apps/${slug}/source`),
    storageSummary: await s.api('GET', `/api/apps/${slug}/storage`),
    storageList: await s.api('GET', `/api/apps/${slug}/storage/scores`),
    storageQuery: await S({ op: 'query', collection: 'scores' }, actors.owner),
    storageCollections: await S({ op: 'collections' }, actors.owner),
    categories: await s.api('GET', '/api/categories'),
    patch: await s.api('PATCH', `/api/apps/${slug}`, { body: { description: 'patched for the scan' }, headers: actors.owner }),
    sharePage: { text: await (await fetch(`${s.base}/app/${slug}`)).text() },
    playPage: { text: await (await fetch(`${s.base}/play/${slug}`)).text() },
    adminStats: await s.api('GET', '/api/admin/stats', { headers: { 'X-Admin-Key': s.adminKey } }),
    wrongKey: await s.api('PATCH', `/api/apps/${slug}`, { body: { description: 'x' }, headers: { 'X-Edit-Key': 'wrong' } }),
    index: await s.api('GET', '/api'),
  };
  for (const [name, r] of Object.entries(responses)) {
    assert.ok(!r.text.includes(editKey), `${name} carries the edit key`);
    assert.ok(!r.text.includes(hash), `${name} carries the edit key's hash`);
    assert.ok(!/edit_?key/i.test(r.text) || name === 'index', `${name} mentions the key field: ${r.text.match(/.{0,40}edit_?key.{0,40}/i)?.[0]}`);
  }
  const onDisk = fs.readFileSync(path.join(s.dataDir, 'apps', slug, 'app.json'), 'utf8');
  assert.ok(!onDisk.includes(editKey), 'the key itself is never written down');
  assert.ok(onDisk.includes(hash), 'only its hash is');
  // A remix hands out its own key, and not its parent's.
  const remix = await s.api('POST', `/api/apps/${slug}/remix`, { body: { author: 'Remixer' } });
  assert.equal(remix.status, 201, remix.text);
  assert.match(remix.json.editKey, /^[0-9a-f]{40}$/);
  assert.notEqual(remix.json.editKey, editKey);
  assert.ok(!remix.text.includes(editKey) && !remix.text.includes(hash));
});

test('a key in the query string is never a credential, on any route that takes one', skip, async () => {
  const q = `editKey=${editKey}`;
  assert.equal((await s.api('PATCH', `/api/apps/${slug}`, { body: { description: 'via query' }, query: q })).status, 403);
  assert.equal((await s.api('DELETE', `/api/apps/${slug}`, { query: q })).status, 403);
  assert.equal((await s.api('POST', `/api/apps/${slug}/storage`, { body: { op: 'query', collection: 'config' }, query: q })).status, 403);
  assert.equal((await s.api('POST', `/api/apps/${slug}/storage`, { body: { op: 'clear', collection: 'scores' }, query: q })).status, 403);
  assert.equal((await s.api('GET', `/api/apps/${slug}/storage/config`, { query: q })).status, 403);
  assert.equal((await s.api('GET', '/api/admin/stats', { query: `adminKey=${s.adminKey}` })).status, 403);
  assert.equal((await s.api('POST', `/api/apps/${slug}/storage`, { body: { op: 'query', collection: 'config' }, query: `adminKey=${s.adminKey}` })).status, 403);
  assert.equal((await s.api('GET', `/api/apps/${slug}`)).json.app.description, 'patched for the scan', 'nothing changed');
  // The header and the body are where a key goes.
  assert.equal((await s.api('POST', `/api/apps/${slug}/storage`, { body: { op: 'query', collection: 'config' }, headers: actors.owner })).status, 200);
  assert.equal((await s.api('POST', `/api/apps/${slug}/storage`, { body: { op: 'query', collection: 'config', editKey } })).status, 200);
  assert.equal((await s.api('GET', `/api/apps/${slug}/storage/config`, { headers: actors.owner })).status, 200);
});
