/**
 * Replacing an edit key.
 *
 * A key is a bearer secret with no account behind it: whoever holds it can
 * publish a new version over the app, change or unpublish its listing, and
 * act as the publisher in its server storage. Until this route there was no
 * way to replace one, so a key that might have been copied stayed good for
 * as long as the app existed. `POST /api/apps/{slug}/key` takes the current
 * key, hands out a new one, and the old one is refused from that request on,
 * on every route that took it.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, makeBundle, skip } from './helpers/harness.mjs';

const SITE = 'https://directory.example';
const ELSEWHERE = 'https://elsewhere.example';
const permissions = { storage: { enabled: true, collections: { config: 'publisher', '*': 'public' } } };

let s = null;

before(async () => {
  // Two replacements an hour from one visitor, so the limit is reachable.
  s = await startServer({ config: { siteOrigin: SITE, limits: { rekey: [2, 3600] } }, prefix: 'softn-rekey-' });
});

after(() => s?.stop());

const rotate = (slug, headers = {}) => s.api('POST', `/api/apps/${slug}/key`, { headers });
const insertConfig = (slug, key) =>
  s.api('POST', `/api/apps/${slug}/storage`, { body: { op: 'insert', collection: 'config', data: { theme: 'dark' } }, headers: { 'X-Edit-Key': key } });

test('a key replaced is refused everywhere at once, and the new one does what the old one did', skip, async () => {
  const pub = await s.publish('Rotating Board', { permissions }, { category: 'tools' });
  const slug = pub.app.slug;
  const oldKey = pub.editKey;
  const before = (await s.api('GET', `/api/apps/${slug}`)).json.app;
  assert.equal((await insertConfig(slug, oldKey)).status, 200, 'the old key is the publisher before the replacement');

  const r = await rotate(slug, { 'X-Edit-Key': oldKey });
  assert.equal(r.status, 200, r.text);
  const newKey = r.json.editKey;
  assert.match(newKey, /^[0-9a-f]{40}$/);
  assert.notEqual(newKey, oldKey);
  assert.equal(r.json.app.slug, slug);
  assert.equal(r.headers.get('cache-control'), 'no-store', 'a reply carrying a key is not cached');

  // The old key, on each kind of route that took it.
  assert.equal((await s.api('PATCH', `/api/apps/${slug}`, { body: { description: 'changed by the old key' }, headers: { 'X-Edit-Key': oldKey } })).status, 403);
  assert.equal((await rotate(slug, { 'X-Edit-Key': oldKey })).status, 403, 'the old key cannot take the app back');
  assert.equal((await insertConfig(slug, oldKey)).status, 403, "the old key is no longer the publisher in the app's storage");
  const fd = new FormData();
  fd.append('bundle', new Blob([makeBundle('Rotating Board', { permissions, version: '2.0.0' })]), 'app.softn');
  assert.equal((await s.api('POST', `/api/apps/${slug}/versions`, { body: fd, headers: { 'X-Edit-Key': oldKey } })).status, 403);
  assert.equal((await s.api('DELETE', `/api/apps/${slug}`, { headers: { 'X-Edit-Key': oldKey } })).status, 403);

  // The new key, on the same routes.
  assert.equal((await insertConfig(slug, newKey)).status, 200);
  const patched = await s.api('PATCH', `/api/apps/${slug}`, { body: { description: 'changed by the new key' }, headers: { 'X-Edit-Key': newKey } });
  assert.equal(patched.status, 200, patched.text);
  assert.equal(patched.json.app.description, 'changed by the new key');

  // The listing does not announce that a key changed, and nothing but the hash is kept.
  const doc = JSON.parse(fs.readFileSync(path.join(s.dataDir, 'apps', slug, 'app.json'), 'utf8'));
  assert.equal(doc.app.edit_key_hash, crypto.createHash('sha256').update(newKey).digest('hex'));
  assert.ok(!JSON.stringify(doc).includes(newKey) && !JSON.stringify(doc).includes(oldKey));
  const card = (await s.api('GET', `/api/apps/${slug}`)).json.app;
  assert.equal(card.version, before.version);
});

test('a wrong key, no key and an unknown app are refused, and nothing changes', skip, async () => {
  const pub = await s.publish('Kept Board', {}, { category: 'tools' });
  const slug = pub.app.slug;
  const hashBefore = JSON.parse(fs.readFileSync(path.join(s.dataDir, 'apps', slug, 'app.json'), 'utf8')).app.edit_key_hash;
  assert.equal((await rotate(slug, { 'X-Edit-Key': 'f'.repeat(40) })).status, 403);
  assert.equal((await rotate(slug)).status, 403);
  assert.equal((await rotate('no-such-app', { 'X-Edit-Key': pub.editKey })).status, 404);
  const hashAfter = JSON.parse(fs.readFileSync(path.join(s.dataDir, 'apps', slug, 'app.json'), 'utf8')).app.edit_key_hash;
  assert.equal(hashAfter, hashBefore);
  // The key that was never replaced still works.
  assert.equal((await s.api('PATCH', `/api/apps/${slug}`, { body: { description: 'still mine' }, headers: { 'X-Edit-Key': pub.editKey } })).status, 200);
});

test('the admin can replace a lost key, but cannot give a key to an app that belongs to the site', skip, async () => {
  const pub = await s.publish('Lost Key Board', {}, { category: 'tools' });
  const r = await rotate(pub.app.slug, { 'X-Admin-Key': s.adminKey });
  assert.equal(r.status, 200, r.text);
  assert.equal((await s.api('PATCH', `/api/apps/${pub.app.slug}`, { body: { description: 'x' }, headers: { 'X-Edit-Key': pub.editKey } })).status, 403);
  assert.equal((await s.api('PATCH', `/api/apps/${pub.app.slug}`, { body: { description: 'x' }, headers: { 'X-Edit-Key': r.json.editKey } })).status, 200);

  // A folder the operator dropped in has no edit key: it is the site's.
  const dir = path.join(s.dataDir, 'apps', 'site-owned');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'v1.softn'), makeBundle('Site Owned'));
  assert.equal((await s.api('GET', '/api/apps/site-owned')).status, 200);
  const refused = await rotate('site-owned', { 'X-Admin-Key': s.adminKey });
  assert.equal(refused.status, 409, refused.text);
  assert.match(refused.json.error, /no edit key/);
  const doc = JSON.parse(fs.readFileSync(path.join(dir, 'app.json'), 'utf8'));
  assert.equal(doc.app.edit_key_hash, null);
});

test('a page on another origin cannot replace a key, even with it', skip, async () => {
  const pub = await s.publish('Origin Board', {}, { category: 'tools' });
  const preflight = await s.api('OPTIONS', `/api/apps/${pub.app.slug}/key`, { headers: { Origin: ELSEWHERE, 'Access-Control-Request-Method': 'POST' } });
  assert.equal(preflight.status, 403);
  const r = await rotate(pub.app.slug, { 'X-Edit-Key': pub.editKey, Origin: ELSEWHERE });
  assert.equal(r.status, 403);
  assert.equal((await s.api('PATCH', `/api/apps/${pub.app.slug}`, { body: { description: 'x' }, headers: { 'X-Edit-Key': pub.editKey } })).status, 200, 'the key was not replaced');
  // The site's own pages may.
  const own = await rotate(pub.app.slug, { 'X-Edit-Key': pub.editKey, Origin: SITE });
  assert.equal(own.status, 200, own.text);
  assert.equal(own.headers.get('access-control-allow-origin'), SITE);
});

test('replacing keys is rate-limited per visitor, after the key is checked, and not for the admin', skip, async () => {
  // The earlier tests used this visitor's two replacements this hour.
  const pub = await s.publish('Limited Board', {}, { category: 'tools' });
  const wrong = await rotate(pub.app.slug, { 'X-Edit-Key': 'e'.repeat(40) });
  assert.equal(wrong.status, 403, 'a refused key is refused for the key, not counted');
  const limited = await rotate(pub.app.slug, { 'X-Edit-Key': pub.editKey });
  assert.equal(limited.status, 429, limited.text);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  assert.equal((await s.api('PATCH', `/api/apps/${pub.app.slug}`, { body: { description: 'x' }, headers: { 'X-Edit-Key': pub.editKey } })).status, 200, 'a refused replacement leaves the key as it was');
  assert.equal((await rotate(pub.app.slug, { 'X-Admin-Key': s.adminKey })).status, 200);
});
