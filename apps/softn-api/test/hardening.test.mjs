/**
 * What the server audit of 15 September 2026 changed, pinned:
 *
 * - the rate limiter has a lock of its own and never opens the catalogue,
 *   so a slow upload after a limit check holds nothing but its own request;
 * - a share or play page carries no absolute address unless `siteOrigin` is
 *   configured, and /api/health says when it is not (and when a proxy is
 *   forwarding addresses nobody trusts);
 * - the owner and admin routes answer the site's own origin only, and the
 *   origins `allowedOrigins` lists; every other route still answers any;
 * - an address names a slug, never an app's name; a remix `parent` may be a
 *   name when exactly one app has it;
 * - a purged app's folder goes with everything under it.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, runPhp, makeBundle, skip } from './helpers/harness.mjs';

const SITE = 'https://directory.example';
const STUDIO = 'https://studio.example';
const ELSEWHERE = 'https://elsewhere.example';

/** A server with a configured origin and one listed editor origin. */
let s = null;
/** A server with no siteOrigin at all: a fresh install. */
let bare = null;

before(async () => {
  s = await startServer({ config: { siteOrigin: SITE + '/', allowedOrigins: [STUDIO] }, prefix: 'softn-hardening-' });
  bare = await startServer({ prefix: 'softn-hardening-bare-' });
});

after(() => {
  s?.stop();
  bare?.stop();
});

test('the rate limiter holds its own lock and leaves the catalogue lock free', skip, () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'softn-ratelimit-'));
  try {
    const r = runPhp({
      dataDir,
      script: `
Db::rateLimit('publish', 'someone');
// Another handle on each lock file, from this same process: a lock this
// request still held would refuse it (flock is per open file, PHP's Windows
// emulation included).
$catalog = fopen($argv[1] . '/catalog.lock', 'c');
$limits = fopen($argv[1] . '/ratelimits.lock', 'c');
$refused = 0;
for ($i = 0; $i < 12; $i++) { try { Db::rateLimit('publish', 'someone'); } catch (ApiError $e) { $refused = $e->status; $retry = $e->extra['retryAfter']; break; } }
echo json_encode(['catalogFree' => flock($catalog, LOCK_EX | LOCK_NB), 'limitsFree' => flock($limits, LOCK_EX | LOCK_NB), 'refused' => $refused, 'retryAfter' => $retry ?? null, 'booted' => is_dir($argv[1] . '/apps')]);`,
    });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.catalogFree, true, 'the catalogue lock was never taken');
    assert.equal(out.limitsFree, true, 'the limiter releases its lock as it returns');
    assert.equal(out.refused, 429, 'the eleventh publish in the window is refused');
    assert.ok(out.retryAfter > 0);
    assert.equal(out.booted, false, 'counting a use did not boot the catalogue');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('without siteOrigin the share and play pages carry no absolute address, and health says so', skip, async () => {
  const { app } = await bare.publish('Unaddressed');
  const share = await fetch(`${bare.base}/app/${app.slug}`, { headers: { Accept: 'text/html' } });
  assert.equal(share.status, 200);
  const html = await share.text();
  assert.match(html, /<title>Unaddressed — SoftN<\/title>/, 'the page is still the app\'s');
  assert.doesNotMatch(html, /property="og:url"/, 'no og:url is guessed from the Host header');
  assert.doesNotMatch(html, /rel="canonical"/, 'no canonical address is guessed either');
  assert.match(html, new RegExp(`property="og:image" content="/api/apps/${app.slug}/thumbnail\\?v=\\d+"`), 'the picture is named by its path');
  assert.doesNotMatch(html, /127\.0\.0\.1/, 'the request\'s own host appears nowhere');
  const play = await fetch(`${bare.base}/play/${app.slug}`, { headers: { Accept: 'text/html' } });
  assert.equal(play.status, 200);
  const shell = await play.text();
  assert.doesNotMatch(shell, /rel="canonical"/);
  assert.match(shell, /id="softn-runtime-config"/, 'the app still plays');
  const health = (await bare.api('GET', '/api/health')).json;
  assert.equal(health.siteOrigin, null);
  assert.ok(health.warnings.some((w) => /siteOrigin/.test(w)), JSON.stringify(health.warnings));
});

test('with siteOrigin the pages carry it, trailing slash and all, and health carries no warning', skip, async () => {
  const { app } = await s.publish('Addressed');
  const html = await (await fetch(`${s.base}/app/${app.slug}`, { headers: { Accept: 'text/html' } })).text();
  assert.match(html, new RegExp(`property="og:url" content="${SITE}/app/${app.slug}"`));
  // (The share page rewrites a canonical link the site's index.html carries;
  // the harness's carries none. The play page writes its own, below.)
  assert.match(html, new RegExp(`property="og:image" content="${SITE}/api/apps/${app.slug}/thumbnail\\?v=\\d+"`));
  const shell = await (await fetch(`${s.base}/play/${app.slug}`, { headers: { Accept: 'text/html' } })).text();
  assert.match(shell, new RegExp(`rel="canonical" href="${SITE}/app/${app.slug}"`));
  const health = (await s.api('GET', '/api/health')).json;
  assert.equal(health.siteOrigin, SITE);
  assert.deepEqual(health.warnings, []);
});

test('health warns when addresses are forwarded by a proxy nobody trusts', skip, async () => {
  const forwarded = (await s.api('GET', '/api/health', { headers: { 'X-Forwarded-For': '203.0.113.9' } })).json;
  assert.equal(forwarded.proxy.forwardedButUntrusted, true);
  assert.ok(forwarded.warnings.some((w) => /trustedProxies/.test(w)), JSON.stringify(forwarded.warnings));
  const plain = (await s.api('GET', '/api/health')).json;
  assert.equal(plain.proxy.forwardedButUntrusted, false);
  const trusted = await startServer({ config: { siteOrigin: SITE, trustedProxies: ['127.0.0.1'] }, prefix: 'softn-hardening-proxy-' });
  try {
    const h = (await trusted.api('GET', '/api/health', { headers: { 'X-Forwarded-For': '203.0.113.9' } })).json;
    assert.equal(h.proxy.forwardedButUntrusted, false);
    assert.deepEqual(h.warnings, []);
  } finally {
    trusted.stop();
  }
});

test('the owner routes answer the site, its listed origins and the host itself; the rest answer anyone', skip, async () => {
  const { app, editKey } = await s.publish('Guarded');
  const route = `/api/apps/${app.slug}`;
  const preflight = (origin, method, path = route) =>
    s.api('OPTIONS', path, { headers: { Origin: origin, 'Access-Control-Request-Method': method, 'Access-Control-Request-Headers': 'x-edit-key' } });

  // A page elsewhere: refused at the preflight, with the reason.
  const refused = await preflight(ELSEWHERE, 'PATCH');
  assert.equal(refused.status, 403);
  assert.equal(refused.headers.get('access-control-allow-origin'), null);
  assert.match(refused.json.error, /allowedOrigins/);
  // The site's own origin and a listed one: reflected, and the reply varies by it.
  for (const origin of [SITE, STUDIO]) {
    const ok = await preflight(origin, 'PATCH');
    assert.equal(ok.status, 204, origin);
    assert.equal(ok.headers.get('access-control-allow-origin'), origin);
    assert.match(ok.headers.get('vary') ?? '', /Origin/);
  }
  // The origin the request was addressed to counts too, so a site with no
  // configuration keeps working from its own pages.
  const self = await bare.api('OPTIONS', '/api/apps/x', { headers: { Origin: bare.base, 'Access-Control-Request-Method': 'DELETE' } });
  assert.equal(self.status, 204);
  assert.equal(self.headers.get('access-control-allow-origin'), bare.base);
  assert.equal((await bare.api('OPTIONS', '/api/apps/x', { headers: { Origin: ELSEWHERE, 'Access-Control-Request-Method': 'DELETE' } })).status, 403);

  // The request itself, not only its preflight: a key in the body of a
  // request a browser sends without one is still refused from elsewhere.
  const patched = await s.api('PATCH', route, { body: { description: 'changed from elsewhere', editKey }, headers: { Origin: ELSEWHERE } });
  assert.equal(patched.status, 403);
  assert.equal((await s.api('GET', route)).json.app.description, 'Guarded, made by the test', 'nothing changed');
  const fd = new FormData();
  fd.append('bundle', new Blob([makeBundle('Guarded', { version: '1.1.0' })]), 'app.softn');
  fd.append('editKey', editKey);
  assert.equal((await s.api('POST', `${route}/versions`, { body: fd, headers: { Origin: ELSEWHERE } })).status, 403);
  assert.equal((await s.api('POST', `${route}/thumbnail`, { body: fd, headers: { Origin: ELSEWHERE } })).status, 403);
  assert.equal((await s.api('DELETE', route, { headers: { Origin: ELSEWHERE, 'X-Edit-Key': editKey } })).status, 403);
  assert.equal((await s.api('GET', '/api/admin/stats', { headers: { Origin: ELSEWHERE, 'X-Admin-Key': s.adminKey } })).status, 403);
  // From the site, the same requests work as before.
  const fromSite = await s.api('PATCH', route, { body: { description: 'changed from the site' }, headers: { Origin: SITE, 'X-Edit-Key': editKey } });
  assert.equal(fromSite.status, 200, fromSite.text);
  assert.equal(fromSite.headers.get('access-control-allow-origin'), SITE);
  // No Origin at all — curl, a script — is not a page and is not restricted.
  assert.equal((await s.api('PATCH', route, { body: { description: 'changed by a script' }, headers: { 'X-Edit-Key': editKey } })).status, 200);

  // Everything anyone may call still answers any origin: reading, playing,
  // publishing, remixing, commenting.
  for (const [method, path, init] of [
    ['GET', '/api/apps', {}],
    ['GET', route, {}],
    ['GET', `${route}/bundle.softn`, {}],
    ['POST', `${route}/runs`, {}],
    ['POST', `${route}/comments`, { body: { name: 'A', body: 'hello' } }],
    ['POST', '/api/apps', { raw: makeBundle('Published From Elsewhere'), headers: { 'Content-Type': 'application/octet-stream' } }],
  ]) {
    const r = await s.api(method, path, { ...init, headers: { ...(init.headers ?? {}), Origin: ELSEWHERE } });
    assert.ok(r.status < 300, `${method} ${path}: ${r.status} ${r.text}`);
    assert.equal(r.headers.get('access-control-allow-origin'), '*', `${method} ${path}`);
  }
  assert.equal((await preflight(ELSEWHERE, 'GET', `${route}/bundle.softn`)).headers.get('access-control-allow-origin'), '*');
});

test('an address names a slug, never a name; a parent may be a name exactly one app has', skip, async () => {
  const first = await s.publish('Twin Name');
  const second = await s.publish('Twin Name');
  assert.equal(first.app.slug, 'twin-name');
  assert.equal(second.app.slug, 'twin-name-2');
  // The name spelt as a slug still finds the app that owns that slug.
  assert.equal((await s.api('GET', '/api/apps/Twin%20Name')).json.app.slug, 'twin-name');
  // Renamed, the app is no longer reachable by its name: a name is not an address.
  assert.equal((await s.api('PATCH', '/api/apps/twin-name', { body: { name: 'Renamed Once' }, headers: { 'X-Edit-Key': first.editKey } })).status, 200);
  assert.equal((await s.api('GET', '/api/apps/Renamed%20Once')).status, 404);
  assert.equal((await fetch(`${s.base}/play/Renamed%20Once`)).status, 404);
  // As a remix parent, the unique name resolves.
  const child = await s.api('POST', '/api/apps', { raw: makeBundle('Child Of Renamed'), headers: { 'Content-Type': 'application/octet-stream', 'X-Admin-Key': s.adminKey }, query: 'parent=Renamed%20Once' });
  assert.equal(child.status, 201, child.text);
  assert.equal(child.json.app.parent.slug, 'twin-name');
  // Two apps with the name: neither is chosen for the other.
  assert.equal((await s.api('PATCH', '/api/apps/twin-name-2', { body: { name: 'Renamed Once' }, headers: { 'X-Edit-Key': second.editKey } })).status, 200);
  const ambiguous = await s.api('POST', '/api/apps', { raw: makeBundle('Child Of Which'), headers: { 'Content-Type': 'application/octet-stream', 'X-Admin-Key': s.adminKey }, query: 'parent=Renamed%20Once' });
  assert.equal(ambiguous.status, 404);
  assert.match(ambiguous.json.error, /More than one/);
  assert.equal((await s.api('GET', '/api/apps/child-of-which')).status, 404, 'nothing was published');
});

test('a purged app leaves nothing behind, subfolders included', skip, async () => {
  const { app, editKey } = await s.publish('Purged With Extras');
  const folder = path.join(s.dataDir, 'apps', app.slug);
  fs.mkdirSync(path.join(folder, 'extra/deeper'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'extra/deeper/leftover.txt'), 'x');
  assert.equal((await s.api('DELETE', `/api/apps/${app.slug}?purge=1`, { headers: { 'X-Edit-Key': editKey, 'X-Admin-Key': s.adminKey } })).status, 204);
  assert.ok(!fs.existsSync(folder));
  assert.deepEqual(fs.readdirSync(s.dataDir).filter((n) => n.startsWith('.retired-')), [], 'no retired folder stays behind');
});
