/**
 * Catalogue timings and recovery (API-03, fixture F20): the numbers the
 * catalogue reports about its own locking, cache rebuilds and metadata
 * commits, and what a reader finds after a writer died mid-commit.
 *
 * The catalogue's design — one exclusive lock per request, JSON rewritten
 * through a temp sibling and a rename — was documented but not measured,
 * and its recovery from an interrupted write was asserted from the code
 * alone. These tests pin the timing surface the benchmark reads
 * (scripts/bench/catalog-bench.mjs), and simulate the crash: a process that
 * holds the lock, leaves half-written temp siblings beside the live files,
 * and is killed.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, startPhp, skip } from './helpers/harness.mjs';

const servers = [];
after(() => servers.forEach((s) => s.stop()));

test('health reports the timings of its own catalogue boot; Server-Timing is a configuration switch', skip, async () => {
  const quiet = await startServer({ prefix: 'softn-timings-off-' });
  servers.push(quiet);
  await quiet.publish('Timed');
  const h = await quiet.api('GET', '/api/health');
  assert.equal(h.status, 200);
  const t = h.json.timings;
  assert.ok(t, 'a timings block');
  for (const k of ['lockWaitMs', 'lockHoldMs', 'bootMs']) assert.equal(typeof t[k], 'number', `${k} is a number`);
  assert.ok(t.lockWaitMs >= 0 && t.lockHoldMs >= 0 && t.bootMs >= 0);
  assert.equal(typeof t.rebuild.count, 'number');
  assert.equal(typeof t.rebuild.ms, 'number');
  assert.equal(typeof t.commit.count, 'number');
  assert.equal(typeof t.commit.ms, 'number');
  assert.equal(t.apps, 1, 'the number of app folders the boot loaded');
  assert.equal(h.headers.get('server-timing'), null, 'no per-response header unless asked for');

  const loud = await startServer({ config: { debugTimings: true }, prefix: 'softn-timings-on-' });
  servers.push(loud);
  // The first request after a publish meets a folder the cache has not
  // seen: a rebuild of one bundle. Deleting the cache is another.
  const { app } = await loud.publish('Loud');
  const first = await loud.api('GET', '/api/apps');
  assert.match(first.headers.get('server-timing') || '', /\brebuild;dur=\d+(\.\d+)?;desc="1 bundle/, `the new folder: ${first.headers.get('server-timing')}`);
  fs.unlinkSync(path.join(loud.dataDir, 'cache/bundles.json'));
  const list = await loud.api('GET', '/api/apps');
  const st = list.headers.get('server-timing') || '';
  assert.match(st, /\block;dur=\d+(\.\d+)?/, `lock wait: ${st}`);
  assert.match(st, /\bhold;dur=\d+(\.\d+)?/, `lock hold: ${st}`);
  assert.match(st, /\bboot;dur=\d+(\.\d+)?/, `boot: ${st}`);
  assert.match(st, /\brebuild;dur=\d+(\.\d+)?;desc="1 bundle/, `a rebuild of one bundle: ${st}`);
  // A write commits metadata; the header says how many files and how long.
  const run = await loud.api('POST', `/api/apps/${app.slug}/runs`);
  assert.equal(run.status, 204);
  assert.match(run.headers.get('server-timing') || '', /\bcommit;dur=\d+(\.\d+)?;desc="[1-9]\d* file/, `a commit: ${run.headers.get('server-timing')}`);
  const cached = await loud.api('GET', '/api/apps');
  assert.match(cached.headers.get('server-timing') || '', /\brebuild;dur=\d+(\.\d+)?;desc="0 bundles"/, 'nothing to rebuild the second time');
});

test('a writer killed with half-written temp siblings in place leaves a catalogue that reads, writes and rebuilds to the same inventory', skip, async () => {
  const s = await startServer({ prefix: 'softn-crash-' });
  servers.push(s);
  const a = await s.publish('Survivor One');
  const b = await s.publish('Survivor Two');
  const before = (await s.api('GET', '/api/apps?perPage=48')).json;
  const inventory = (list) => list.apps.map((x) => [x.slug, x.version, x.size]).sort();
  assert.equal(before.total, 2);
  const appDir = path.join(s.dataDir, 'apps', a.app.slug);
  const appJson = path.join(appDir, 'app.json');
  const intact = fs.readFileSync(appJson, 'utf8');

  // A process that takes the lock, writes the way a commit starts — a temp
  // sibling of app.json, of a bundle, of the cache — and dies before rename.
  const marker = path.join(s.dataDir, 'crashing');
  const w = startPhp({
    dataDir: s.dataDir,
    script: `
Catalog::boot();
$dir = ${JSON.stringify(appDir.replace(/\\/g, '/'))};
file_put_contents("$dir/.json-crash1", '{"schemaVersion":1,"app":{"slug":"' . ${JSON.stringify(a.app.slug)} . '","name":"HALF');
file_put_contents("$dir/.upload-crash", "PK\\x03\\x04 half a bundle");
file_put_contents("$dir/v2.softn", "PK\\x03\\x04 a bundle cut off mid-copy");
@mkdir(dirname(${JSON.stringify(s.dataDir.replace(/\\/g, '/'))} . '/cache/x'), 0775, true);
file_put_contents(${JSON.stringify(s.dataDir.replace(/\\/g, '/'))} . '/cache/.json-crash2', '{"partial":');
file_put_contents(${JSON.stringify(s.dataDir.replace(/\\/g, '/'))} . '/.json-crash3', '[1,2,');
touch(${JSON.stringify(marker.replace(/\\/g, '/'))});
sleep(30);`,
  });
  for (let i = 0; i < 200 && !fs.existsSync(marker); i++) await new Promise((r) => setTimeout(r, 25));
  assert.ok(fs.existsSync(marker), 'the crashing writer got the lock and left its debris');
  w.process.kill();
  await w.done;

  // The live file is what it was; the temp siblings are not metadata.
  assert.equal(fs.readFileSync(appJson, 'utf8'), intact, 'app.json is untouched');
  const after = (await s.api('GET', '/api/apps?perPage=48')).json;
  assert.deepEqual(inventory(after), inventory(before), 'the inventory is what was committed');
  const detail = (await s.api('GET', `/api/apps/${a.app.slug}`)).json.app;
  assert.equal(detail.versions.length, 1, 'the bundle cut off mid-copy is not a version');
  assert.ok(!fs.existsSync(path.join(s.dataDir, 'apps', a.app.slug, 'app.json.tmp')));
  // Writing still works after the crash, and the cache rebuilds to the same inventory.
  assert.equal((await s.api('POST', `/api/apps/${a.app.slug}/runs`)).status, 204);
  assert.equal((await s.api('GET', `/api/apps/${a.app.slug}`)).json.app.runs, 1);
  fs.unlinkSync(path.join(s.dataDir, 'cache/bundles.json'));
  const rebuilt = (await s.api('GET', '/api/apps?perPage=48')).json;
  assert.deepEqual(inventory(rebuilt), inventory(before));
  assert.equal((await s.api('GET', `/api/apps/${b.app.slug}`)).json.app.name, 'Survivor Two');
  assert.equal(JSON.parse(fs.readFileSync(appJson, 'utf8')).app.runs, 1, 'the commit after the crash is on disk, whole');
  // Every JSON file the catalogue keeps parses; the debris is still just debris.
  for (const f of ['categories.json', 'ratelimits.json', 'cache/bundles.json']) {
    const p = path.join(s.dataDir, f);
    if (fs.existsSync(p)) JSON.parse(fs.readFileSync(p, 'utf8'));
  }
  assert.ok(fs.existsSync(path.join(appDir, '.json-crash1')), 'nothing here pretends the debris was cleaned');
});

test('a reader that arrives during a commit gets the committed document, whole', skip, async () => {
  const s = await startServer({ prefix: 'softn-serial-' });
  servers.push(s);
  const { app } = await s.publish('Serialised');
  const marker = path.join(s.dataDir, 'writing');
  const w = startPhp({
    dataDir: s.dataDir,
    script: `
Catalog::boot();
touch(${JSON.stringify(marker.replace(/\\/g, '/'))});
usleep(700000);
Catalog::patch(${JSON.stringify(app.slug)}, ['description' => 'written under the lock']);
Catalog::release();`,
  });
  for (let i = 0; i < 200 && !fs.existsSync(marker); i++) await new Promise((r) => setTimeout(r, 25));
  assert.ok(fs.existsSync(marker));
  const started = Date.now();
  const r = await s.api('GET', `/api/apps/${app.slug}`);
  const waited = Date.now() - started;
  const { code, err } = await w.done;
  assert.equal(code, 0, err);
  assert.equal(r.status, 200);
  assert.equal(r.json.app.description, 'written under the lock', 'the reader was held until the commit and saw all of it');
  assert.ok(waited >= 300, `the reader waited on the lock (${waited} ms)`);
  const doc = JSON.parse(fs.readFileSync(path.join(s.dataDir, 'apps', app.slug, 'app.json'), 'utf8'));
  assert.equal(doc.app.description, 'written under the lock');
});
