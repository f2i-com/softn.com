/**
 * The two costs the API-03 benchmark found at 1,000 apps, pinned (round 2
 * of the 2026-09-11 audit repair).
 *
 * The bundle cache re-inspected every bundle whose `checked` stamp was
 * older than five seconds, so under load, where every request waited
 * longer than that for the lock, each worker re-read every archive on
 * every request: 20,908 inspections during 200 list requests, and a lock
 * held for half a second at a time. The stat fingerprint (size, mtime,
 * ctime) already said whether a bundle had changed; the wall-clock clause
 * made it worthless. Now an unchanged bundle is never re-inspected, and a
 * bounded sweep re-reads the oldest stamps a batch at a time, minutes
 * apart, as the safety net for a replacement that kept its timestamps.
 *
 * The listing built the slug-keyed catalogue (with its O(n) remix count per
 * row) again for every card that had a parent and for every row lookup.
 * It is now built once per request and handed to the cards. The fixture
 * comparison at the end pins that no answer changed.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, makeBundle, skip } from './helpers/harness.mjs';
import { copyFixture, snapshot } from './fixtures/catalog/queries.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const servers = [];
after(() => servers.forEach((s) => s.stop()));

/** The bundle count the Server-Timing header reports for this response's rebuild. */
function inspected(r) {
  const m = (r.headers.get('server-timing') || '').match(/\brebuild;dur=[\d.]+;desc="(\d+) bundle/);
  assert.ok(m, `a rebuild entry: ${r.headers.get('server-timing')}`);
  return parseInt(m[1], 10);
}

/** Move every `checked` stamp in the bundle cache back by `seconds`. */
function backdate(dataDir, seconds) {
  const file = path.join(dataDir, 'cache/bundles.json');
  const cache = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const entry of Object.values(cache)) entry.checked -= seconds;
  fs.writeFileSync(file, JSON.stringify(cache));
  return Object.keys(cache).length;
}

async function publishMany(s, prefix, n) {
  const apps = [];
  for (let i = 0; i < n; i++) apps.push(await s.publish(`${prefix} ${i}`));
  await s.api('GET', '/api/apps'); // the first request after a publish meets the new folders
  return apps;
}

test('a list request on a warm catalogue inspects no bundle, however old the cache stamps are', skip, async () => {
  const s = await startServer({ config: { debugTimings: true }, prefix: 'softn-warm-' });
  servers.push(s);
  await publishMany(s, 'Warm', 6);
  assert.equal(inspected(await s.api('GET', '/api/apps')), 0, 'settled');
  // Stamps older than the five seconds the old code allowed. Nothing on
  // disk changed, so nothing may be re-read.
  assert.equal(backdate(s.dataDir, 30), 6);
  const before = await s.api('GET', '/api/health');
  assert.equal(before.status, 200);
  assert.equal(before.json.timings.rebuild.count, 0, 'health before the list: the stale stamps alone cause no inspection');
  const list = await s.api('GET', '/api/apps?perPage=48');
  assert.equal(list.json.total, 6);
  assert.equal(inspected(list), 0, 'the list itself inspected nothing');
  const after = await s.api('GET', '/api/health');
  assert.equal(after.json.timings.rebuild.count, 0, 'health after the list');
  assert.equal(after.json.timings.apps, 6);
  // The health route now names the thresholds an operator's probe compares against.
  const t = after.json.timings.thresholds;
  assert.ok(t, 'timings.thresholds');
  for (const k of ['lockWaitMsP95', 'lockHoldMsP95', 'warmRebuildCount']) assert.equal(typeof t[k], 'number', k);
  assert.equal(t.warmRebuildCount, 0);
});

test('a change re-inspects exactly the bundle that changed; a metadata change re-inspects none', skip, async () => {
  const s = await startServer({ config: { debugTimings: true }, prefix: 'softn-change-' });
  servers.push(s);
  const [a, b] = await publishMany(s, 'Change', 4);
  assert.equal(inspected(await s.api('GET', '/api/apps')), 0);

  // A new version through the API: its file alone is met on the next request.
  const fd = new FormData();
  fd.append('bundle', new Blob([makeBundle('Change 0', { version: '2.0.0' })]), 'v2.softn');
  fd.append('editKey', a.editKey);
  const v2 = await s.api('POST', `/api/apps/${a.app.slug}/versions`, { body: fd });
  assert.equal(v2.status, 201, v2.text);
  assert.equal(inspected(await s.api('GET', '/api/apps')), 1, 'the new version');
  assert.equal(inspected(await s.api('GET', '/api/apps')), 0);

  // A metadata change touches app.json, not a bundle.
  const patched = await s.api('PATCH', `/api/apps/${a.app.slug}`, { body: { description: 'edited' }, headers: { 'X-Edit-Key': a.editKey } });
  assert.equal(patched.status, 200, patched.text);
  assert.equal(inspected(await s.api('GET', '/api/apps')), 0, 'a patch is not a bundle change');

  // A bundle dropped into a folder by hand, then replaced in place.
  const dir = path.join(s.dataDir, 'apps', b.app.slug);
  fs.writeFileSync(path.join(dir, 'v2.softn'), makeBundle('Change 1', { version: '2.0.0' }));
  assert.equal(inspected(await s.api('GET', '/api/apps')), 1, 'the dropped file');
  const detail = (await s.api('GET', `/api/apps/${b.app.slug}`)).json.app;
  assert.equal(detail.version, 2);
  const digest = detail.versions[0].sha256;
  fs.writeFileSync(path.join(dir, 'v2.softn'), makeBundle('Change 1', { version: '2.0.1', extra: { 'assets/pad.bin': new Uint8Array(4096) } }));
  assert.equal(inspected(await s.api('GET', '/api/apps')), 1, 'the replaced file');
  const replaced = (await s.api('GET', `/api/apps/${b.app.slug}`)).json.app;
  assert.notEqual(replaced.versions[0].sha256, digest, 'the digest follows the bytes');
  assert.equal(replaced.versions[0].manifestVersion, '2.0.1');
  assert.equal(inspected(await s.api('GET', '/api/apps')), 0);

  // The cache is still disposable: without it every bundle is read once, then none.
  fs.unlinkSync(path.join(s.dataDir, 'cache/bundles.json'));
  assert.equal(inspected(await s.api('GET', '/api/apps')), 6, 'four apps, two of them with two versions');
  assert.equal(inspected(await s.api('GET', '/api/apps')), 0);
});

test('the periodic sweep re-inspects the oldest stamps a bounded batch per request', skip, async () => {
  const s = await startServer({ config: { debugTimings: true, cacheSweepBatch: 4 }, prefix: 'softn-sweep-' });
  servers.push(s);
  await publishMany(s, 'Sweep', 6);
  assert.equal(inspected(await s.api('GET', '/api/apps')), 0);
  // Stamps a day old: past the sweep interval, so every bundle is due, four at a time.
  assert.equal(backdate(s.dataDir, 86400), 6);
  assert.equal(inspected(await s.api('GET', '/api/apps')), 4, 'the first batch');
  assert.equal(inspected(await s.api('GET', '/api/apps')), 2, 'the rest');
  assert.equal(inspected(await s.api('GET', '/api/apps')), 0, 'swept');
  const cache = JSON.parse(fs.readFileSync(path.join(s.dataDir, 'cache/bundles.json'), 'utf8'));
  const now = Math.floor(Date.now() / 1000);
  for (const [key, entry] of Object.entries(cache)) assert.ok(now - entry.checked < 60, `${key} was stamped by the sweep`);
  const health = await s.api('GET', '/api/health');
  assert.equal(health.json.timings.rebuild.swept, 0, 'the sweep is reported apart from change-driven rebuilds');
});

test('listing, cards and details answer exactly as before the change (fixture comparison)', skip, () => {
  const fixture = path.join(here, 'fixtures/catalog');
  const expected = JSON.parse(fs.readFileSync(path.join(fixture, 'expected.json'), 'utf8'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'softn-fixture-'));
  try {
    copyFixture(path.join(fixture, 'data'), dir);
    const slugs = fs.readdirSync(path.join(dir, 'apps'));
    const docs = Object.fromEntries(slugs.map((s) => [s, fs.readFileSync(path.join(dir, 'apps', s, 'app.json'), 'utf8')]));
    // Cold (no cache), then warm: the same answers both times, and no app.json rewritten.
    assert.deepEqual(snapshot(dir), expected, 'cold');
    assert.deepEqual(snapshot(dir), expected, 'warm');
    for (const s of slugs) assert.equal(fs.readFileSync(path.join(dir, 'apps', s, 'app.json'), 'utf8'), docs[s], `${s}/app.json untouched`);
    // What the fixture covers, so a trimmed fixture cannot pass by accident.
    assert.equal(expected.list.total, 4, 'four listed: the hidden one is not, the linked one is');
    assert.equal(expected.all.alpha.remixes, 1, 'the remix count from the folder relationships');
    assert.equal(expected.card['beta-lantern'].parent.slug, 'alpha', 'a card with a parent');
    assert.deepEqual(expected.detail['beta-lantern'].lineage.map((l) => l.slug), ['alpha']);
    assert.equal(expected.detail.alpha.remixList[0].slug, 'beta-lantern');
    assert.deepEqual(expected.card.epsilon.capabilities, ['net', 'storage']);
    assert.equal(expected.card.delta.external.host, 'delta.example');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
