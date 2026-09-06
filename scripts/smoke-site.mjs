#!/usr/bin/env node
/**
 * Serve a built site the way a host would and ask it what a browser asks.
 *
 *   node scripts/smoke-site.mjs --root dist
 *   node scripts/smoke-site.mjs --root smoke-root     (an unpacked release archive)
 *
 * The release workflow proves the archive's bytes match dist/ and that the
 * archive opens. Neither proves the site inside it works: that the landing
 * page and the runtime are served at their paths, that a nested route such
 * as /web/app/Notes reaches the runtime's shell rather than the landing
 * page's, that the PHP directory API answers and seeds itself from the
 * bundles beside it, that a bundle and a hashed asset come back with the
 * cross-origin isolation headers the runtime's worker mode depends on. This
 * script starts PHP's built-in server on the root with the API's router in
 * front of it — the same arrangement the README gives for a local preview,
 * and the stand-in for the deployed .htaccess — and checks each of those.
 *
 * The API's state goes to a temporary directory (SOFTN_DATA_DIR), so the
 * root is not written to: dist/ can be smoke-tested and then packaged.
 *
 * Needs `php` on PATH with pdo_sqlite and zip. Without it the script fails:
 * a release gate that quietly passes when its tool is missing is not one.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const root = path.resolve(opt('--root') ?? 'dist');

function fail(message) {
  console.error(`smoke: ${message}`);
  process.exit(1);
}

for (const required of ['index.html', 'web/index.html', 'api/index.php', 'api/router.php', '.htaccess', 'BUILD-INFO.json']) {
  if (!fs.existsSync(path.join(root, required))) fail(`${root} has no ${required}; is it a built site?`);
}
// The default build ships no example bundles and the directory starts empty;
// `--with-demos` ships them and the API seeds the directory. BUILD-INFO.json
// says which this is, so the checks below expect the right one.
const buildInfo = JSON.parse(fs.readFileSync(path.join(root, 'BUILD-INFO.json'), 'utf8'));
const bundled = Number(buildInfo?.examples?.bundled ?? 0);
if (bundled > 0 && !fs.existsSync(path.join(root, 'demos/index.json'))) fail(`${root} claims ${bundled} example bundles but has no demos/index.json`);
if (bundled === 0 && fs.existsSync(path.join(root, 'demos'))) fail(`${root} claims no example bundles but has a demos/ directory`);

const php = spawnSync('php', ['-v'], { encoding: 'utf8' });
if (php.status !== 0) fail('php is not on PATH. The smoke test serves the site through PHP, as a host does.');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'softn-smoke-'));

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const server = spawn('php', ['-S', `127.0.0.1:${port}`, '-t', root, path.join(root, 'api/router.php')], {
  env: { ...process.env, SOFTN_DATA_DIR: dataDir },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));

function cleanup() {
  if (!server.killed) server.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
process.on('exit', cleanup);

async function waitForServer(ms = 20000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok || r.status === 503) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  fail(`the server did not come up on ${base}\n${serverLog}`);
}

const failures = [];
let passed = 0;

/**
 * One request and what it must come back as. `html: true` accepts text/html
 * (the SPA shells); `isolated: true` requires the two cross-origin isolation
 * headers, which must be on every response a worker-mode app fetches.
 */
async function check(name, url, { accept = 'text/html', status = 200, type, isolated = false, body } = {}) {
  let res;
  let text;
  try {
    res = await fetch(base + url, { headers: { Accept: accept }, redirect: 'manual' });
    text = await res.text();
  } catch (err) {
    failures.push(`${name}: ${url} -> ${err.message}`);
    return null;
  }
  const problems = [];
  if (res.status !== status) problems.push(`status ${res.status}, wanted ${status}`);
  const contentType = res.headers.get('content-type') ?? '';
  if (type && !contentType.startsWith(type)) problems.push(`content-type "${contentType}", wanted ${type}`);
  if (isolated) {
    if (res.headers.get('cross-origin-opener-policy') !== 'same-origin') problems.push('no Cross-Origin-Opener-Policy: same-origin');
    const coep = res.headers.get('cross-origin-embedder-policy');
    if (coep !== 'credentialless' && coep !== 'require-corp') problems.push('no Cross-Origin-Embedder-Policy');
  }
  if (body) {
    try {
      const verdict = body(text, res);
      if (typeof verdict === 'string') problems.push(verdict);
    } catch (err) {
      problems.push(`body check threw: ${err.message}`);
    }
  }
  if (problems.length > 0) failures.push(`${name}: ${url} -> ${problems.join('; ')}`);
  else passed += 1;
  return text;
}

const json = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

await waitForServer();

// ── The pages ──────────────────────────────────────────────────────────
const landing = await check('landing page', '/', { type: 'text/html', isolated: true, body: (t) => (t.includes('id="root"') ? true : 'no #root in index.html') });
const runtime = await check('runtime shell', '/web/', { type: 'text/html', isolated: true, body: (t) => (t.includes('id="root"') ? true : 'no #root in web/index.html') });
if (landing !== null && runtime !== null && landing === runtime) failures.push('runtime shell: /web/ served the landing page, not the runtime');

// A nested route inside each app must reach that app's shell, not the
// landing page's: a generic static server sends index.html for everything,
// which looks fine at the HTTP layer and boots the wrong React app.
await check('directory page route', '/apps', { type: 'text/html', body: (t) => (t === landing ? true : 'not the landing shell') });
await check('directory page route with a query', '/apps?category=games', { type: 'text/html', body: (t) => (t === landing ? true : 'not the landing shell') });
await check('runtime nested route', '/web/app/Notes', { type: 'text/html', isolated: true, body: (t) => (t === runtime ? true : 'not the runtime shell') });
await check('runtime deeper route', '/web/app/Notes/page/settings', { type: 'text/html', isolated: true, body: (t) => (t === runtime ? true : 'not the runtime shell') });
await check('runtime without trailing slash redirects', '/web', { status: 308 });
for (const app of ['builder', 'studio']) {
  if (fs.existsSync(path.join(root, app, 'index.html'))) {
    await check(`${app} shell`, `/${app}/`, { type: 'text/html', isolated: true, body: (t) => (t.includes('id="root"') ? true : 'no #root') });
  }
}

// ── The API ────────────────────────────────────────────────────────────
await check('api health', '/api/health', {
  accept: 'application/json',
  type: 'application/json',
  body: (t) => {
    const j = json(t);
    if (!j || j.ok !== true) return `not ok: ${t.slice(0, 200)}`;
    if (j.dataWritable !== true) return 'data dir not writable';
    if (j.zip !== true) return 'PHP has no zip extension';
    return true;
  },
});
let firstSlug = null;
await check(bundled > 0 ? 'api lists the seeded examples' : 'api answers with an empty directory', '/api/apps?perPage=48', {
  accept: 'application/json',
  type: 'application/json',
  body: (t) => {
    const j = json(t);
    if (!j || j.ok !== true) return `not ok: ${t.slice(0, 200)}`;
    if (!Array.isArray(j.apps)) return 'no apps array';
    if (bundled > 0 && j.apps.length === 0) return 'no apps: the examples beside the API did not seed';
    if (bundled === 0 && j.apps.length !== 0) return `${j.apps.length} apps in a build that ships none`;
    firstSlug = j.apps.find((a) => a.slug === 'notes')?.slug ?? j.apps[0]?.slug ?? null;
    return true;
  },
});
await check('api categories', '/api/categories', {
  accept: 'application/json',
  type: 'application/json',
  body: (t) => {
    const j = json(t);
    return j && j.ok === true && Array.isArray(j.categories) && j.categories.length > 0 ? true : 'no categories';
  },
});
if (firstSlug) {
  await check('api one app', `/api/apps/${firstSlug}`, {
    accept: 'application/json',
    type: 'application/json',
    body: (t) => {
      const j = json(t);
      if (!j || j.ok !== true || j.app?.slug !== firstSlug) return `wrong app: ${t.slice(0, 200)}`;
      if (!Array.isArray(j.app.capabilities)) return 'no capabilities array';
      return true;
    },
  });
  await check('api serves the bundle', `/api/apps/${firstSlug}/bundle.softn`, {
    accept: '*/*',
    type: 'application/octet-stream',
    body: (t) => (t.length > 100 && t.startsWith('PK') ? true : 'not a zip'),
  });
  await check('share page', `/app/${firstSlug}`, { type: 'text/html', body: (t) => (t.includes('og:title') ? true : 'no Open Graph tags') });
}
await check('api 404 is JSON', '/api/apps/no-such-app-here', {
  accept: 'application/json',
  status: 404,
  type: 'application/json',
  body: (t) => (json(t)?.ok === false ? true : 'not an error envelope'),
});

// ── Static files, with the isolation headers ───────────────────────────
const demoIndex = bundled > 0 ? json(fs.readFileSync(path.join(root, 'demos/index.json'), 'utf8')) : null;
const firstDemo = Array.isArray(demoIndex) && demoIndex.length > 0 ? demoIndex[0].file : null;
if (bundled > 0) await check('demo index', '/demos/index.json', { accept: 'application/json', type: 'application/json', isolated: true });
else await check('no demo index', '/demos/index.json', { status: 404 });
if (firstDemo) {
  await check('demo bundle', `/demos/${firstDemo}`, {
    accept: '*/*',
    type: 'application/octet-stream',
    isolated: true,
    body: (t) => (t.startsWith('PK') ? true : 'not a zip'),
  });
}
if (landing) {
  const asset = landing.match(/(?:src|href)="(\/assets\/[^"]+\.(?:js|css))"/)?.[1];
  if (asset) {
    await check('hashed asset', asset, { accept: '*/*', isolated: true, type: asset.endsWith('.css') ? 'text/css' : 'text/javascript' });
  } else {
    failures.push('hashed asset: index.html references nothing under /assets/');
  }
}
if (runtime) {
  const asset = runtime.match(/(?:src|href)="(\/web\/assets\/[^"]+\.js)"/)?.[1];
  if (asset) await check('runtime asset', asset, { accept: '*/*', isolated: true, type: 'text/javascript' });
}
await check('missing asset is a 404, not a shell', '/assets/does-not-exist.js', { status: 404 });
await check('data directory is refused', '/data/directory.sqlite', { accept: '*/*', status: 404 });
await check('api library is refused', '/api/lib/db.php', { accept: '*/*', status: 404 });

cleanup();
if (failures.length > 0) {
  console.error(`smoke: ${failures.length} check(s) failed, ${passed} passed:`);
  for (const f of failures) console.error(`  - ${f}`);
  if (serverLog.trim()) console.error(`\nserver log:\n${serverLog}`);
  process.exit(1);
}
console.log(`smoke: ${passed} checks passed against ${root}`);
