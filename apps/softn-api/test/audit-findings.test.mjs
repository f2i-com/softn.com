/**
 * What an audit of the directory API found, each held here: a limit a
 * request could get round, a reply that said one thing and did another, and
 * a name the API could not give.
 *
 * - A form body was taken past its route's limit (a 2 MB comment as a form
 *   was a 201 where the same as JSON was a 413).
 * - The storage summary, a count over the whole store, was not counted as a
 *   read of it, on its own route or on the app's page.
 * - One invalid UTF-8 byte in a field emptied the whole field.
 * - A linked app, which has nothing to remix, could be named as a parent.
 * - Hidden categories filled the room for new ones for good.
 * - The thousandth app whose name has no Latin letter could not be published.
 * - The dev router's redirect could name another site.
 * - On Windows, a killed writer's temp files went into a backup.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { startServer, makeBundle, skip, apiDir } from './helpers/harness.mjs';

const servers = [];
const dirs = [];
after(() => {
  servers.forEach((s) => s.stop());
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
async function server(options) {
  const s = await startServer(options);
  servers.push(s);
  return s;
}

test('a form body is held to its route’s limit, as a JSON one is', skip, async () => {
  const s = await server({ config: { maxJsonBytes: 64 * 1024 }, prefix: 'softn-audit-form-' });
  const { app } = await s.publish('Form Limit');
  const long = 'x'.repeat(200 * 1024);
  const form = await s.api('POST', `/api/apps/${app.slug}/comments`, {
    raw: `name=Ann&body=${long}`,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  assert.equal(form.status, 413, form.text);
  const fd = new FormData();
  fd.append('name', 'Ann');
  fd.append('body', long);
  assert.equal((await s.api('POST', `/api/apps/${app.slug}/comments`, { body: fd })).status, 413);
  const small = await s.api('POST', `/api/apps/${app.slug}/comments`, {
    raw: 'name=Ann&body=A+short+one',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  assert.equal(small.status, 201, small.text);
});

test('the storage summary is a read of the store, counted as one; past the limit the app’s page still answers', skip, async () => {
  const s = await server({ config: { limits: { storageRead: [2, 60] } }, prefix: 'softn-audit-read-' });
  const { app } = await s.publish('Read Count', { permissions: { storage: { enabled: true } } });
  const summary = [];
  for (let i = 0; i < 3; i++) summary.push((await s.api('GET', `/api/apps/${app.slug}/storage`)).status);
  assert.deepEqual(summary, [200, 200, 429]);
  const page = await s.api('GET', `/api/apps/${app.slug}`);
  assert.equal(page.status, 200);
  assert.equal(page.json.app.storage.unavailable, true);
});

test('an invalid byte in a field is replaced, not the field emptied', skip, async () => {
  const s = await server({ prefix: 'softn-audit-utf8-' });
  const { app } = await s.publish('Stray Byte');
  const r = await s.api('POST', `/api/apps/${app.slug}/comments`, {
    raw: 'name=Ann%FFie&body=A+good+comment+with+one+stray+byte%FF',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  assert.equal(r.status, 201, r.text);
  assert.match(r.json.comment.name, /^Ann.ie$/);
  assert.match(r.json.comment.body, /^A good comment with one stray byte/);
});

test('a linked app cannot be named as a new app’s parent', skip, async () => {
  const s = await server({ prefix: 'softn-audit-linked-' });
  fs.mkdirSync(path.join(s.dataDir, 'apps/linked-elsewhere'), { recursive: true });
  fs.writeFileSync(
    path.join(s.dataDir, 'apps/linked-elsewhere/app.json'),
    JSON.stringify({ schemaVersion: 1, app: { slug: 'linked-elsewhere', name: 'Linked Elsewhere', play_url: 'https://elsewhere.test/play' } })
  );
  const fd = new FormData();
  fd.append('bundle', new Blob([makeBundle('Would Be Child')]), 'child.softn');
  fd.append('parent', 'linked-elsewhere');
  const r = await s.api('POST', '/api/apps', { body: fd, headers: { 'X-Admin-Key': s.adminKey } });
  assert.equal(r.status, 404, r.text);
});

test('hidden categories leave room for new ones', skip, async () => {
  const s = await server({ prefix: 'softn-audit-categories-' });
  const rows = Object.fromEntries(
    Array.from({ length: 200 }, (_, i) => [`spam-${i}`, { id: `spam-${i}`, name: `Spam ${i}`, description: '', emoji: '🏷️', status: 'hidden', sort: 500, created_at: 0 }])
  );
  fs.writeFileSync(path.join(s.dataDir, 'categories.json'), JSON.stringify(rows));
  const r = await s.api('POST', '/api/categories', { body: { name: 'Music Toys' } });
  assert.equal(r.status, 201, r.text);
});

test('the thousandth app named without a Latin letter is published under a name of its own', skip, async () => {
  const s = await server({ prefix: 'softn-audit-slugs-' });
  for (const slug of ['app', ...Array.from({ length: 998 }, (_, i) => `app-${i + 2}`)]) fs.mkdirSync(path.join(s.dataDir, 'apps', slug), { recursive: true });
  const fd = new FormData();
  fd.append('bundle', new Blob([makeBundle('例子')]), 'example.softn');
  const r = await s.api('POST', '/api/apps', { body: fd, headers: { 'X-Admin-Key': s.adminKey } });
  assert.equal(r.status, 201, r.text);
  assert.match(r.json.app.slug, /^app-[0-9a-f]{6}$/);
});

test('the dev router’s redirect to a folder never names another site', skip, async () => {
  const s = await server({ prefix: 'softn-audit-router-' });
  for (const route of ['/%2F%2Fevil.example%2F..%2Fplay', '/%5Cevil.example/../play']) {
    const r = await fetch(s.base + route, { redirect: 'manual' });
    const location = r.headers.get('location');
    if (location !== null) assert.doesNotMatch(location, /^\/[\\/]/, `${route} -> ${location}`);
  }
});

test('a backup leaves out the temp files a killed writer left, as Windows names them too', skip, async () => {
  const s = await server({ prefix: 'softn-audit-backup-' });
  await s.publish('Backed Up');
  for (const name of ['.js9C61.tmp', '.up9C71.tmp', '.json-abc123', '.upload-def456']) fs.writeFileSync(path.join(s.dataDir, name), 'partial');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'softn-audit-backup-out-'));
  dirs.push(work);
  const archive = path.join(work, 'backup.zip');
  const exported = spawnSync('php', ['-d', 'error_log=', path.join(apiDir, 'backup.php'), 'export', archive, '--data', s.dataDir], { encoding: 'utf8' });
  assert.equal(exported.status, 0, exported.stderr);
  const listing = fs.readFileSync(archive).toString('latin1');
  for (const name of ['.js9C61.tmp', '.up9C71.tmp', '.json-abc123', '.upload-def456']) assert.ok(!listing.includes(name), `${name} was exported`);
});
