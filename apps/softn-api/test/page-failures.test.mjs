/**
 * What someone who followed a link is answered when the directory has a
 * problem. /app/<slug> and /play/<slug> are pages: they used to answer a
 * problem as the API does, in JSON, which is clear to an operator and nothing
 * to the person who clicked. And a broken categories.json, which the catalogue
 * can do without (the site's own categories are built in), took down the
 * listing and every play page with it.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runPhp, startServer, skip } from './helpers/harness.mjs';

const servers = [];
after(() => servers.forEach((s) => s.stop()));

async function site(prefix) {
  const s = await startServer({ prefix });
  servers.push(s);
  const { app } = await s.publish('Followed');
  return { s, slug: app.slug };
}

const open = (s, target) => fetch(`${s.base}${target}`, { headers: { Accept: 'text/html' } });

test('a page answers a broken configuration with a page, at the same status', skip, async () => {
  const { s, slug } = await site('softn-page-config-');
  fs.writeFileSync(path.join(s.dataDir, 'config.json'), '{ not json');
  for (const target of [`/play/${slug}`, `/app/${slug}`, `/api/page/play/${slug}`, `/api/page/app/${slug}`]) {
    const res = await open(s, target);
    assert.equal(res.status, 503, target);
    assert.match(res.headers.get('content-type'), /^text\/html/, `${target} is a page`);
    const page = await res.text();
    assert.match(page, /<title>[^<]*SoftN<\/title>/, target);
    assert.match(page, /href="\/apps"/, `${target} has a way back`);
    assert.match(page, /Invalid JSON metadata: config\.json/, `${target} says why`);
  }
  // The API stays the API: a script reads JSON.
  const api = await s.api('GET', '/api/apps');
  assert.equal(api.status, 503);
  assert.match(api.headers.get('content-type'), /^application\/json/);
});

// .htaccess and the nginx config set these on every response. Sent by PHP too they arrive
// twice and a browser ignores them, which only a real server shows: `php -S` keeps one of a
// repeated header, so this reads what the page asks to send rather than what arrives. That
// /play/<slug> is isolated is the e2e gate's.
test('a page leaves the isolation headers to the server', skip, async () => {
  const { s } = await site('softn-page-headers-');
  const asked = runPhp({ dataDir: s.dataDir, script: "echo json_encode(array_keys(Response::html('<p>page</p>')->headers));" });
  assert.equal(asked.status, 0, asked.stderr);
  assert.deepEqual(JSON.parse(asked.stdout), ['Content-Type']);
  const res = await open(s, '/play/no-such-app');
  assert.equal(res.headers.get('cross-origin-opener-policy'), 'same-origin', 'router.php is the server under `php -S`');
});

test('a page escapes what it says', skip, async () => {
  const { s } = await site('softn-page-escape-');
  const res = await open(s, `/play/${encodeURIComponent('<img src=x onerror=alert(1)>')}`);
  assert.equal(res.status, 404);
  assert.doesNotMatch(await res.text(), /<img/);
});

test('the listing and the play page go on with the built-in categories when categories.json is broken', skip, async () => {
  const { s, slug } = await site('softn-page-categories-');
  const file = path.join(s.dataDir, 'categories.json');
  fs.writeFileSync(file, '{ half a file');

  const categories = await s.api('GET', '/api/categories');
  assert.equal(categories.status, 200);
  assert.ok(categories.json.categories.some((row) => row.id === 'games'), 'the built-in categories');
  const listing = await s.api('GET', '/api/apps');
  assert.equal(listing.status, 200);
  assert.ok(listing.json.apps.some((app) => app.slug === slug));
  assert.equal((await open(s, `/play/${slug}`)).status, 200);
  assert.equal((await open(s, `/app/${slug}`)).status, 200);

  // A write would replace what the owner may yet recover, so it is refused and the file stays.
  const suggested = await s.api('POST', '/api/categories', { body: { name: 'Puzzles' } });
  assert.equal(suggested.status, 503);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ half a file');
});
