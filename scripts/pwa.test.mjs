import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { buildWorker, globToRegExp, hookSource, manifestJson, precacheEntries, workerConfig } from './pwa.mjs';

test('globs read as the apps write them', () => {
  const take = globToRegExp('**/*.{js,css,html,svg,png,woff2,wasm}');
  for (const file of ['index.html', 'sw-helper.js', 'assets/index-AbCd1234.js', 'assets/fonts/plex.woff2']) assert.ok(take.test(file), file);
  for (const file of ['manifest.webmanifest', 'a.jsx', 'a.js.map', 'a.js.br']) assert.ok(!take.test(file), file);
  assert.ok(globToRegExp('**/core-runtime/**').test('assets/core-runtime/runtime/model-worker.js'));
  assert.ok(globToRegExp('**/assets/vendor-three-*.js').test('assets/vendor-three-x1.js'));
  assert.ok(!globToRegExp('**/assets/vendor-three-*.js').test('assets/sub/vendor-three-x1.js'));
  assert.ok(globToRegExp('**/assets/zxing_reader-*.wasm').test('assets/zxing_reader-EOacYbLr.wasm'));
});

test('the precache takes what the globs take, revisions what its name does not, and leaves the rest', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'softn-pwa-'));
  t.after(() => {
    assert.ok(path.basename(dir).startsWith('softn-pwa-'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const files = {
    'index.html': '<!doctype html>', 'coi.js': 'x', 'sw.js': 'old', 'manifest.webmanifest': '{}', 'big.wasm': 'x'.repeat(64),
    'assets/index-AbCd1234.js': 'y', 'assets/core-runtime/zipp_wasm_bg.wasm': 'z', 'assets/scene3d-Zz99Yy88.js': 'q', 'notes.txt': 'n',
  };
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  const warned = [];
  const entries = precacheEntries(dir, {
    globPatterns: ['**/*.{js,html,wasm}'],
    globIgnores: ['**/core-runtime/**', '**/assets/scene3d-*.js'],
    maximumFileSizeToCacheInBytes: 32,
  }, { warn: (m) => warned.push(m) });
  assert.deepEqual(entries.map((e) => e.url), ['assets/index-AbCd1234.js', 'coi.js', 'index.html', 'manifest.webmanifest']);
  assert.equal(entries[0].revision, null);
  assert.match(entries[1].revision, /^[0-9a-f]{32}$/);
  assert.equal(warned.length, 1);
  assert.match(warned[0], /big\.wasm/);

  // An editor installs the workers' files too. Under assets/ as they are, their
  // names do not change with their content, so each is revisioned.
  const complete = precacheEntries(dir, { globPatterns: ['**/*.{js,html,wasm}'], maximumFileSizeToCacheInBytes: 32 });
  const worker = complete.find((e) => e.url === 'assets/core-runtime/zipp_wasm_bg.wasm');
  assert.match(worker.revision, /^[0-9a-f]{32}$/);
  assert.equal(complete.find((e) => e.url === 'assets/scene3d-Zz99Yy88.js').revision, null);
});

test('the manifest is written as the plugin it replaces wrote it', () => {
  const json = manifestJson({ name: 'SoftN Studio', short_name: 'Studio', description: 'd', display: 'standalone', orientation: 'any', theme_color: '#101317', background_color: '#101317', start_url: '.', scope: '.', categories: ['developertools'], icons: [{ src: 'a.png' }] });
  assert.equal(json, '{"name":"SoftN Studio","short_name":"Studio","description":"d","start_url":".","display":"standalone","background_color":"#101317","theme_color":"#101317","lang":"en","scope":".","orientation":"any","categories":["developertools"],"icons":[{"src":"a.png"}]}');
});

test('a worker takes over at once only when the build registers it', () => {
  assert.equal(workerConfig({ registerType: 'autoUpdate' }).autoUpdate, true);
  assert.equal(workerConfig({ registerType: 'autoUpdate', injectRegister: false }).autoUpdate, false);
  assert.equal(workerConfig({ registerType: 'prompt' }).autoUpdate, false);
  const routes = workerConfig({ workbox: { runtimeCaching: [{ urlPattern: /\/assets\/[^/?#]+\.js$/i, handler: 'CacheFirst', options: { cacheName: 'c', expiration: { maxEntries: 2 }, cacheableResponse: { statuses: [0, 200] } } }] } }).routes;
  assert.deepEqual(routes, [{ pattern: '\\/assets\\/[^/?#]+\\.js$', flags: 'i', handler: 'CacheFirst', cacheName: 'c', networkTimeoutSeconds: undefined, expiration: { maxEntries: 2 }, statuses: [0, 200] }]);
});

test('the worker carries its list as one JSON line and imports its scripts before any fetch listener', async () => {
  const precache = [{ url: 'index.html', revision: 'abc' }, { url: 'assets/a-12345678.js', revision: null }];
  const code = await buildWorker(precache, workerConfig({ registerType: 'autoUpdate', workbox: { importScripts: ['coi.js'] } }));
  const line = /^self\.__SOFTN_PRECACHE=(\[.*\]);$/m.exec(code);
  assert.deepEqual(JSON.parse(line[1]), precache);
  assert.ok(!/process\.env/.test(code), 'development logging is compiled out');
  // Run it in a stand-in worker global and keep what it did, in order.
  const did = [];
  const self = {
    location: new URL('https://softn.test/web/sw.js'),
    registration: { scope: 'https://softn.test/web/' },
    addEventListener: (type) => did.push(`listen ${type}`),
    skipWaiting: () => did.push('skipWaiting'),
    clients: { claim: () => did.push('claim') },
    importScripts: (...urls) => did.push(`import ${urls.join(',')}`),
  };
  self.self = self;
  vm.runInNewContext(code, Object.assign(self, { URL, Request, Response, Headers, console, caches: {} }));
  assert.equal(did[0], 'import coi.js', 'coi.js is imported before anything else');
  assert.ok(did.includes('listen fetch'), did.join('; '));
  assert.ok(did.indexOf('import coi.js') < did.indexOf('listen fetch'));
  assert.ok(did.includes('skipWaiting') && did.includes('listen activate'), did.join('; '));
});

test('a worker that waits listens for the page\'s word and claims nothing', async () => {
  // index.html is always precached: the navigation fallback is bound to it.
  const code = await buildWorker([{ url: 'index.html', revision: 'a' }], workerConfig({ registerType: 'prompt' }));
  const did = [];
  const self = {
    location: new URL('https://softn.test/studio/sw.js'),
    registration: { scope: 'https://softn.test/studio/' },
    addEventListener: (type) => did.push(`listen ${type}`),
    skipWaiting: () => did.push('skipWaiting'),
    clients: { claim: () => did.push('claim') },
    importScripts: () => did.push('import'),
  };
  self.self = self;
  vm.runInNewContext(code, Object.assign(self, { URL, Request, Response, Headers, console, caches: {} }));
  assert.ok(did.includes('listen message'), did.join('; '));
  assert.ok(!did.includes('skipWaiting') && !did.includes('claim') && !did.includes('import'), did.join('; '));
});

test('the registration hook does nothing where the worker is turned off', () => {
  assert.match(hookSource({ base: '/studio/', enabled: true }), /register\(SW_URL, \{ scope: SCOPE \}\)/);
  assert.match(hookSource({ base: '/studio/', enabled: true }), /"\/studio\/sw\.js"/);
  assert.doesNotMatch(hookSource({ base: '/', enabled: false }), /serviceWorker/);
});
