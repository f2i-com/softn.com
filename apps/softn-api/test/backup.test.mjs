/**
 * Backup and restore as a product capability (API-03 acceptance, QA-02):
 * `php backup.php export|verify|restore`.
 *
 * A directory backup was a file copy an operator made by hand, with
 * nothing that checked it was complete, consistent, or restorable. These
 * tests take a served catalogue through export, restore into a fresh data
 * directory, and serve it again: the same slugs, versions and digests, the
 * same bundle bytes, the same comments and ratings, the same app storage,
 * and the same keys. They then tamper with the archive in each way that
 * matters (a byte, a missing file, an extra file, an edited manifest, not
 * an archive at all) and pin that restore refuses it and writes nothing;
 * and that a destination with data in it is refused unless --force is
 * given, which replaces it.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { startServer, makeBundle, skip, apiDir } from './helpers/harness.mjs';

const require = createRequire(import.meta.url);
const { unzipSync, zipSync } = require('fflate');

const servers = [];
const dirs = [];
after(() => {
  servers.forEach((s) => s.stop());
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const scratch = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'softn-backup-'));
  dirs.push(d);
  return d;
};

function backup(args) {
  return spawnSync('php', ['-d', 'error_log=', path.join(apiDir, 'backup.php'), ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** What a served catalogue holds, as the comparison sees it. */
async function inventory(base, slugs) {
  const out = {};
  for (const slug of slugs) {
    const r = await fetch(`${base}/api/apps/${slug}`);
    assert.equal(r.status, 200, `${slug} on ${base}`);
    const { app } = await r.json();
    const versions = [];
    for (const v of app.versions) {
      const bytes = Buffer.from(await (await fetch(`${base}/api/apps/${slug}/bundle.softn?v=${v.version}`)).arrayBuffer());
      versions.push({ version: v.version, size: v.size, sha256: v.sha256, bytes: bytes.toString('base64') });
    }
    out[slug] = { name: app.name, description: app.description, versions, comments: app.comments, rating: app.rating, runs: app.runs, storage: app.storage };
  }
  return out;
}

/** A source catalogue with the shapes a backup has to carry. */
async function seed() {
  const s = await startServer({ prefix: 'softn-backup-src-' });
  servers.push(s);
  const a = await s.publish('Backup Alpha');
  const b = await s.publish('Backup Beta', { permissions: { storage: { enabled: true, collections: { '*': 'public' } } } });
  const c = await s.publish('Backup Gamma');
  const fd = new FormData();
  fd.append('bundle', new Blob([makeBundle('Backup Alpha', { version: '1.1.0', extra: { 'assets/pad.bin': new Uint8Array(3000).map((_, i) => i & 0xff) } })]), 'v2.softn');
  fd.append('editKey', a.editKey);
  assert.equal((await s.api('POST', `/api/apps/${a.app.slug}/versions`, { body: fd })).status, 201);
  assert.equal((await s.api('POST', `/api/apps/${a.app.slug}/comments`, { body: { name: 'Ann', body: 'Worth keeping.' } })).status, 201);
  assert.equal((await s.api('POST', `/api/apps/${a.app.slug}/rating`, { body: { stars: 4 } })).status, 200);
  assert.equal((await s.api('POST', `/api/apps/${a.app.slug}/runs`)).status, 204);
  const kv = await s.api('POST', `/api/apps/${b.app.slug}/storage`, { body: { op: 'kvSet', key: 'greeting', value: { text: 'hello from before the backup' } } });
  assert.equal(kv.status, 200, kv.text);
  const ins = await s.api('POST', `/api/apps/${b.app.slug}/storage`, { body: { op: 'insert', collection: 'notes', data: { n: 1 } } });
  assert.equal(ins.status, 200, ins.text);
  const slugs = [a.app.slug, b.app.slug, c.app.slug];
  return { s, a, b, c, slugs };
}

test('export, restore into a fresh directory, serve: the same inventory, bytes, social history, storage and keys', skip, async () => {
  const { s, a, b, slugs } = await seed();
  const before = await inventory(s.base, slugs);
  const work = scratch();
  const archive = path.join(work, 'backup.zip');

  const exported = backup(['export', archive, '--data', s.dataDir]);
  assert.equal(exported.status, 0, exported.stderr);
  assert.match(exported.stdout, /exported .* 3 apps/);
  const entries = Object.keys(unzipSync(fs.readFileSync(archive)));
  assert.ok(entries.includes('softn-backup.json'), 'the manifest');
  assert.ok(entries.includes('config.json'), 'the configuration with its keys');
  assert.ok(entries.includes(`apps/${a.app.slug}/v2.softn`) && entries.includes(`apps/${b.app.slug}/storage.sqlite`));
  assert.ok(!entries.some((e) => e.startsWith('cache/') || e === 'catalog.lock' || e === 'config.lock'), 'not the cache or the locks');
  const manifest = JSON.parse(Buffer.from(unzipSync(fs.readFileSync(archive))['softn-backup.json']).toString());
  assert.equal(manifest.schemaVersion, 1);
  assert.deepEqual(manifest.apps.map((x) => x.slug).sort(), [...slugs].sort());
  assert.equal(manifest.apps.find((x) => x.slug === a.app.slug).versions.length, 2);
  for (const f of manifest.files) assert.match(f.sha256, /^[0-9a-f]{64}$/);

  const verified = backup(['verify', archive]);
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /verified/);

  // The source keeps serving after the export: the lock was released.
  assert.equal((await s.api('GET', '/api/health')).status, 200);

  const restored = path.join(work, 'restored');
  const r = backup(['restore', archive, '--into', restored]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /restored \d+ files/);
  assert.match(r.stdout, /rebuilt: 3 apps listed, 4 versions, 0 folders skipped/);
  assert.match(r.stdout, /inventory matches the archive/);
  assert.ok(fs.existsSync(path.join(restored, 'cache/bundles.json')), 'the cache was rebuilt by the boot');
  assert.ok(!fs.readdirSync(work).some((n) => n.startsWith('.softn-restore-')), 'no staging folder left behind');

  const t = await startServer({ env: { SOFTN_DATA_DIR: restored }, prefix: 'softn-backup-dst-' });
  servers.push(t);
  const after = await inventory(t.base, slugs);
  assert.deepEqual(after, before, 'slugs, versions, digests, bytes, comments, ratings, runs and storage summary');
  const list = await t.api('GET', '/api/apps?perPage=48');
  assert.deepEqual(list.json.apps.map((x) => x.slug).sort(), [...slugs].sort());
  const kv = await t.api('POST', `/api/apps/${b.app.slug}/storage`, { body: { op: 'kvGet', key: 'greeting' } });
  assert.equal(kv.status, 200, kv.text);
  assert.deepEqual(kv.json.result.value, { text: 'hello from before the backup' });
  // The edit key issued before the backup still opens the app after it: config.json travelled.
  const patched = await t.api('PATCH', `/api/apps/${a.app.slug}`, { body: { description: 'edited after restore' }, headers: { 'X-Edit-Key': a.editKey } });
  assert.equal(patched.status, 200, patched.text);
  const admin = await t.api('GET', '/api/admin/stats', { headers: { 'X-Admin-Key': s.adminKey } });
  assert.equal(admin.status, 200, 'the admin key from the source');
});

test('a tampered archive is refused and nothing is written', skip, async () => {
  const { s, a } = await seed();
  const work = scratch();
  const archive = path.join(work, 'good.zip');
  assert.equal(backup(['export', archive, '--data', s.dataDir]).status, 0);
  const good = unzipSync(fs.readFileSync(archive));
  const bundleName = `apps/${a.app.slug}/v1.softn`;

  const cases = [
    ['a byte changed inside a bundle', (z) => { z[bundleName] = z[bundleName].slice(); z[bundleName][40] ^= 0xff; }, /does not match its digest/],
    ['a file removed', (z) => { delete z[bundleName]; }, /which the archive does not hold/],
    ['a file added', (z) => { z['apps/extra/app.json'] = new TextEncoder().encode('{}'); }, /which the manifest does not list/],
    ['the manifest edited', (z) => { const m = JSON.parse(Buffer.from(z['softn-backup.json']).toString()); m.files[0].sha256 = '0'.repeat(64); z['softn-backup.json'] = new TextEncoder().encode(JSON.stringify(m)); }, /has been altered/],
    ['the manifest missing', (z) => { delete z['softn-backup.json']; }, /has no softn-backup.json/],
  ];
  for (const [name, tamper, reason] of cases) {
    const copy = Object.fromEntries(Object.entries(good).map(([k, v]) => [k, v]));
    tamper(copy);
    const bad = path.join(work, `${name.replace(/\W+/g, '-')}.zip`);
    fs.writeFileSync(bad, zipSync(copy, { level: 0 }));
    const v = backup(['verify', bad]);
    assert.equal(v.status, 2, `${name}: verify refuses (${v.stderr})`);
    assert.match(v.stderr, reason, name);
    const dest = path.join(work, `dest-${name.replace(/\W+/g, '-')}`);
    const r = backup(['restore', bad, '--into', dest]);
    assert.equal(r.status, 2, `${name}: restore refuses (${r.stderr})`);
    assert.match(r.stderr, reason, name);
    assert.ok(!fs.existsSync(dest), `${name}: the destination was not created`);
  }
  // Not an archive at all.
  const text = path.join(work, 'text.zip');
  fs.writeFileSync(text, 'this is not a zip');
  const r = backup(['restore', text, '--into', path.join(work, 'dest-text')]);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /does not open/);
  assert.ok(!fs.readdirSync(work).some((n) => n.startsWith('.softn-restore-')), 'no staging folder left behind');
  // The good archive still restores.
  const ok = backup(['restore', archive, '--into', path.join(work, 'dest-good')]);
  assert.equal(ok.status, 0, ok.stderr);
});

test('restore refuses a destination with data in it unless --force, which replaces it', skip, async () => {
  const { s, slugs } = await seed();
  const work = scratch();
  const archive = path.join(work, 'backup.zip');
  assert.equal(backup(['export', archive, '--data', s.dataDir]).status, 0);

  const dest = path.join(work, 'occupied');
  fs.mkdirSync(path.join(dest, 'apps/stray'), { recursive: true });
  fs.writeFileSync(path.join(dest, 'apps/stray/app.json'), '{"schemaVersion":1,"app":{"name":"Stray"}}');
  fs.writeFileSync(path.join(dest, 'catalog.lock'), '');
  const refused = backup(['restore', archive, '--into', dest]);
  assert.equal(refused.status, 2, refused.stderr);
  assert.match(refused.stderr, /not empty/);
  assert.deepEqual(fs.readdirSync(dest).sort(), ['apps', 'catalog.lock'], 'nothing was added');
  assert.deepEqual(fs.readdirSync(path.join(dest, 'apps')), ['stray']);

  const forced = backup(['restore', archive, '--into', dest, '--force']);
  assert.equal(forced.status, 0, forced.stderr + forced.stdout);
  assert.match(forced.stdout, /inventory matches/);
  assert.deepEqual(fs.readdirSync(path.join(dest, 'apps')).sort(), [...slugs].sort(), 'the stray folder is gone, the archive is there');
  assert.ok(fs.existsSync(path.join(dest, 'catalog.lock')));

  // Lock files and README.txt alone do not make a destination occupied.
  const fresh = path.join(work, 'fresh');
  fs.mkdirSync(fresh);
  for (const f of ['catalog.lock', 'config.lock', 'README.txt']) fs.writeFileSync(path.join(fresh, f), '');
  const ok = backup(['restore', archive, '--into', fresh]);
  assert.equal(ok.status, 0, ok.stderr);

  // An existing archive name is not overwritten by export.
  const again = backup(['export', archive, '--data', s.dataDir]);
  assert.equal(again.status, 2);
  assert.match(again.stderr, /exists/);
});

test('a tar archive round-trips the same way, and a byte flipped inside it is refused', skip, async () => {
  const { s, a, slugs } = await seed();
  const before = await inventory(s.base, slugs);
  const work = scratch();
  const archive = path.join(work, 'backup.tar');
  const exported = backup(['export', archive, '--data', s.dataDir]);
  assert.equal(exported.status, 0, exported.stderr);
  assert.equal(backup(['verify', archive]).status, 0);
  const restored = path.join(work, 'restored');
  const r = backup(['restore', archive, '--into', restored]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /inventory matches/);
  // Every app file is byte-for-byte what the source holds.
  for (const slug of slugs) {
    for (const name of fs.readdirSync(path.join(s.dataDir, 'apps', slug))) {
      if (name.endsWith('-shm') || name.endsWith('-wal')) continue;
      assert.ok(Buffer.from(fs.readFileSync(path.join(s.dataDir, 'apps', slug, name))).equals(fs.readFileSync(path.join(restored, 'apps', slug, name))), `${slug}/${name}`);
    }
  }
  const t = await startServer({ env: { SOFTN_DATA_DIR: restored }, prefix: 'softn-backup-tar-' });
  servers.push(t);
  assert.deepEqual(await inventory(t.base, slugs), before);

  // A tar stores files raw: find the bundle inside it and flip one byte.
  const tar = fs.readFileSync(archive);
  const bundle = fs.readFileSync(path.join(s.dataDir, 'apps', a.app.slug, 'v1.softn'));
  const at = tar.indexOf(bundle);
  assert.ok(at > 0, 'the bundle is stored in the tar as it is');
  tar[at + 40] ^= 0xff;
  const bad = path.join(work, 'bad.tar');
  fs.writeFileSync(bad, tar);
  const v = backup(['verify', bad]);
  assert.equal(v.status, 2, v.stderr);
  assert.match(v.stderr, /does not match its digest/);
  const dest = path.join(work, 'dest-bad');
  assert.equal(backup(['restore', bad, '--into', dest]).status, 2);
  assert.ok(!fs.existsSync(dest));
});
