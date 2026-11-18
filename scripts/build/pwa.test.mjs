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

// Matched against the whole address, a path pattern found `/assets/a.js` in a query: an app's
// <img src="/web/?n=1/assets/a.js"> filled the chunks' cache, and kept SoftN Web's page in it.
test('a path route matches the path of a request to this origin with no query', async () => {
  const { routeMatcher } = await import('./sw-route-match.js');
  const origin = 'https://softn.test';
  const chunk = routeMatcher('\\/assets\\/[^/?#]+\\.js$', '', origin);
  const at = (href) => chunk({ url: new URL(href) });
  assert.ok(at('https://softn.test/web/assets/feature-1a2b3c4d.js'));
  assert.ok(!at('https://softn.test/web/?n=1/assets/a.js'), 'a query that ends like a chunk');
  assert.ok(!at('https://softn.test/web/assets/a.js?x=1'), 'a chunk asked for with a query');
  assert.ok(!at('https://cdn.example/assets/a.js'), 'another origin');
  // An absolute pattern stays the RegExp route it was.
  const fonts = routeMatcher('^https:\\/\\/fonts\\.googleapis\\.com\\/.*', 'i', origin);
  assert.ok(fonts instanceof RegExp && fonts.test('https://fonts.googleapis.com/css2?family=x'));
});

test('a page answered in place of a file is told from the file', async () => {
  const { isPageInPlaceOfFile } = await import('./sw-route-match.js');
  const answered = (type) => new Response('x', type ? { headers: { 'content-type': type } } : undefined);
  // The app's own page, where a script or an engine was asked for.
  assert.ok(isPageInPlaceOfFile('https://softn.test/web/app/~x/assets/a.js', answered('text/html; charset=utf-8')));
  assert.ok(isPageInPlaceOfFile('https://softn.test/shared/container-runtime/e03138f892dd/engines/zipp-typescript.wasm', answered('TEXT/HTML')));
  assert.ok(isPageInPlaceOfFile('https://softn.test/web/assets/EditPane-1a2b3c4d.css', answered(' text/html')));
  // The file itself, whatever a host calls a script.
  assert.ok(!isPageInPlaceOfFile('https://softn.test/web/assets/a.js', answered('text/javascript')));
  assert.ok(!isPageInPlaceOfFile('https://softn.test/web/assets/a.js', answered('application/javascript; charset=utf-8')));
  assert.ok(!isPageInPlaceOfFile('https://softn.test/shared/assets/zipp_wasm_bg-1a2b3c4d.wasm', answered('application/wasm')));
  // No type at all (an opaque answer has none) is not known to be a page.
  assert.ok(!isPageInPlaceOfFile('https://softn.test/web/assets/a.js', new Response(null)));
  // A page asked for as a page is a page.
  assert.ok(!isPageInPlaceOfFile('https://softn.test/docs/index.html', answered('text/html')));
  assert.ok(!isPageInPlaceOfFile('https://softn.test/docs/guide.HTM', answered('text/html')));
});

// On a host that answers every unknown address with the app's page, any app could fill a
// route's cache with that page (an <img src> needs no permission), pushing out the real
// chunks and the container's engines; and a chunk asked for mid-deployment was kept as the
// page for thirty days. Run in the built worker, with Workbox's own strategies.
test('a route keeps the file it was asked for, and never the page a host gave in its place', async () => {
  const code = await buildWorker(
    [{ url: 'index.html', revision: 'a' }],
    {
      ...workerConfig({
        registerType: 'autoUpdate',
        workbox: { runtimeCaching: [{ urlPattern: /\/assets\/[^/?#]+\.js$/, handler: 'CacheFirst', options: { cacheName: 'chunks', cacheableResponse: { statuses: [0, 200] } } }] },
      }),
      classicAssets: { renderer: ['workers/script-worker.js'] },
      classicRevisions: { 'workers/script-worker.js': 'v2' },
    }
  );
  const stores = new Map();
  const store = (name) => stores.get(name) ?? stores.set(name, new Map()).get(name);
  const keyOf = (request) => (typeof request === 'string' ? request : request.url);
  const caches = {
    open: async (name) => ({
      match: async (request) => store(name).get(keyOf(request))?.clone(),
      put: async (request, response) => void store(name).set(keyOf(request), response),
      keys: async () => [...store(name).keys()].map((url) => new Request(url)),
      delete: async (request) => store(name).delete(keyOf(request)),
    }),
    keys: async () => [...stores.keys()],
    has: async (name) => stores.has(name),
    delete: async (name) => stores.delete(name),
    // As Workbox asks: one cache, by name.
    match: async (request, options = {}) => {
      for (const name of options.cacheName ? [options.cacheName] : [...stores.keys()]) {
        const found = store(name).get(keyOf(request));
        if (found) return found.clone();
      }
      return undefined;
    },
  };
  const asked = [];
  const answers = {
    '/web/assets/feature-1a2b3c4d.js': () => new Response('export const feature = 1;', { headers: { 'content-type': 'text/javascript' } }),
    '/web/workers/script-worker.js': () => new Response('worker v2', { headers: { 'content-type': 'text/javascript' } }),
    // What a single-page host answers for an address it has no file for.
    '/web/app/~x/assets/a.js': () => new Response('<!doctype html><title>SoftN Web</title>', { headers: { 'content-type': 'text/html; charset=utf-8' } }),
  };
  const fetch = async (request) => {
    const path = new URL(keyOf(request)).pathname;
    asked.push(path);
    return answers[path]();
  };
  class ExtendableEvent {}
  class FetchEvent extends ExtendableEvent {}
  const listeners = {};
  const self = {
    location: new URL('https://softn.test/web/sw.js'),
    registration: { scope: 'https://softn.test/web/' },
    addEventListener: (type, listener) => (listeners[type] ??= []).push(listener),
    skipWaiting: () => {},
    clients: { claim: () => {} },
    importScripts: () => {},
  };
  self.self = self;
  vm.runInNewContext(code, Object.assign(self, { URL, Request, Response, Headers, console, caches, fetch, ExtendableEvent, FetchEvent, setTimeout, clearTimeout }));

  const ask = async (href) => {
    let answer;
    const work = [];
    const event = Object.assign(new FetchEvent(), {
      request: new Request(href),
      respondWith: (promise) => {
        answer = promise;
      },
      waitUntil: (promise) => work.push(promise),
    });
    for (const listener of listeners.fetch) if (!answer) listener(event);
    assert.ok(answer, `${href} is answered by a route`);
    const response = await answer;
    await Promise.all(work);
    return response.text();
  };

  // The chunk: fetched once, kept, and answered from the copy after.
  assert.equal(await ask('https://softn.test/web/assets/feature-1a2b3c4d.js'), 'export const feature = 1;');
  assert.equal(await ask('https://softn.test/web/assets/feature-1a2b3c4d.js'), 'export const feature = 1;');
  assert.deepEqual(asked, ['/web/assets/feature-1a2b3c4d.js']);
  assert.deepEqual([...store('chunks').keys()], ['https://softn.test/web/assets/feature-1a2b3c4d.js']);

  // The page under a chunk's name: handed on as it came (the request fails as it would with
  // no worker), and not kept, so it is asked for again and pushes nothing out.
  assert.match(await ask('https://softn.test/web/app/~x/assets/a.js'), /<title>SoftN Web<\/title>/);
  assert.deepEqual([...store('chunks').keys()], ['https://softn.test/web/assets/feature-1a2b3c4d.js']);
  await ask('https://softn.test/web/app/~x/assets/a.js');
  assert.deepEqual(asked, ['/web/assets/feature-1a2b3c4d.js', '/web/app/~x/assets/a.js', '/web/app/~x/assets/a.js']);

  // The previous and active workers can answer their respective releases at
  // the same public URL, including during a prompt-mode editor's update.
  const worker = 'https://softn.test/web/workers/script-worker.js';
  const classic = store('softn-classic-assets-https://softn.test/web/');
  classic.set(worker + '?__WB_REVISION__=v1', new Response('worker v1'));
  assert.equal(await ask(worker), 'worker v2');
  delete answers['/web/workers/script-worker.js'];
  assert.equal(await ask(worker), 'worker v2');
  assert.deepEqual([...classic.keys()], [worker + '?__WB_REVISION__=v1', worker + '?__WB_REVISION__=v2']);
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
