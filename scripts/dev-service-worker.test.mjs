import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { chromium } from '@playwright/test';
import { retireServiceWorkersPlugin } from './dev-service-worker.mjs';

function middlewareFor(base = '/') {
  let middleware;
  const plugin = retireServiceWorkersPlugin();
  plugin.configureServer({ config: { base }, middlewares: { use(handler) { middleware = handler; } } });
  assert.equal(typeof middleware, 'function');
  return middleware;
}

test('retirement is development-only and serves only known worker scripts', () => {
  const plugin = retireServiceWorkersPlugin();
  assert.equal(plugin.apply, 'serve');
  assert.equal(plugin.enforce, 'pre');
  const middleware = middlewareFor('/custom-runtime/');

  for (const url of ['/sw.js', '/web/sw.js', '/studio/sw.js', '/builder/sw.js', '/play/sw.js', '/custom-runtime/sw.js', '/web/sw.js?update=1']) {
    const headers = new Map();
    let body;
    let forwarded = false;
    const response = { statusCode: 0, setHeader(key, value) { headers.set(key.toLowerCase(), value); }, end(value) { body = value; } };
    middleware({ url, method: 'GET' }, response, () => { forwarded = true; });
    assert.equal(forwarded, false, url);
    assert.equal(response.statusCode, 200, url);
    assert.match(headers.get('content-type'), /application\/javascript/, url);
    assert.equal(headers.get('cache-control'), 'no-store', url);
    assert.match(body, /registration\.unregister/, url);
  }

  for (const url of ['/web/', '/src/main.tsx', '/assets/sw.js', '/other/sw.js', '/web/sw.js.map', '/web/sw.js/extra', '/registerSW.js']) {
    let forwarded = false;
    middleware({ url, method: 'GET' }, { setHeader() { assert.fail(`Intercepted ${url}`); } }, () => { forwarded = true; });
    assert.equal(forwarded, true, url);
  }

  let forwarded = false;
  middleware({ url: '/sw.js', method: 'POST' }, { setHeader() { assert.fail('Intercepted POST'); } }, () => { forwarded = true; });
  assert.equal(forwarded, true);
  let headBody = 'not ended';
  middleware({ url: '/sw.js', method: 'HEAD' }, { setHeader() {}, end(body) { headBody = body; } }, () => assert.fail('Forwarded worker HEAD'));
  assert.equal(headBody, undefined);
});

const OLD_WORKER = `
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open('softn-offline-regression');
    await cache.put('/old-shell', new Response('<!doctype html><html><body><h1>Old cached runtime</h1></body></html>', { headers: { 'Content-Type': 'text/html' } }));
    await cache.put('/saved-bundle.softn', new Response('saved bundle bytes'));
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  if (event.request.mode === 'navigate') event.respondWith(caches.match('/old-shell'));
});
`;

for (const workerPath of ['/sw.js', '/web/sw.js']) {
  test(`a stale ${workerPath} worker retires without clearing saved app data`, { timeout: 45_000 }, async () => {
    let mode = 'production';
    const middleware = middlewareFor('/web/');
    const server = createServer((request, response) => {
      const pathname = new URL(request.url, 'http://local.test').pathname;
      const fallback = () => {
        if (mode === 'production' && pathname === workerPath) {
          response.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' });
          response.end(OLD_WORKER);
          return;
        }
        response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
        response.end('<!doctype html><html><body><h1>Current development runtime</h1></body></html>');
      };
      if (mode === 'development') middleware(request, response, fallback);
      else fallback();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    let browser;
    try {
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext();
      const page = await context.newPage();
      const uncaught = [];
      page.on('pageerror', (error) => uncaught.push(error.message));
      await page.goto(`${origin}/web/`);
      await page.evaluate(async (script) => {
        localStorage.setItem('softn:regression:notes', 'keep these records');
        await new Promise((resolve, reject) => {
          const request = indexedDB.open('softn-saved-apps-regression', 1);
          request.onupgradeneeded = () => request.result.createObjectStore('apps');
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const db = request.result;
            const transaction = db.transaction('apps', 'readwrite');
            transaction.objectStore('apps').put({ name: 'Saved notes', bytes: 'app bundle' }, 'app');
            transaction.oncomplete = () => { db.close(); resolve(); };
            transaction.onerror = () => reject(transaction.error);
          };
        });
        await navigator.serviceWorker.register(script);
        await navigator.serviceWorker.ready;
      }, workerPath);
      await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
      await page.reload();
      assert.equal(await page.locator('h1').textContent(), 'Old cached runtime');

      // This is the previous Vite behaviour: the worker update URL returned
      // index.html, so an ordinary refresh could not remove the cached shell.
      mode = 'broken-development';
      assert.equal(await page.evaluate(async () => {
        try { await (await navigator.serviceWorker.getRegistration()).update(); return false; }
        catch { return true; }
      }), true);
      await page.reload();
      assert.equal(await page.locator('h1').textContent(), 'Old cached runtime');

      mode = 'development';
      await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
      await page.waitForFunction(async () => (await navigator.serviceWorker.getRegistrations()).length === 0);
      // Retiring the worker must not forcibly navigate any open app or tab.
      assert.equal(await page.locator('h1').textContent(), 'Old cached runtime');
      await page.reload();
      assert.equal(await page.locator('h1').textContent(), 'Current development runtime');
      const stored = await page.evaluate(async () => {
        const request = indexedDB.open('softn-saved-apps-regression', 1);
        const app = await new Promise((resolve, reject) => {
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const db = request.result;
            const read = db.transaction('apps').objectStore('apps').get('app');
            read.onsuccess = () => { db.close(); resolve(read.result); };
            read.onerror = () => reject(read.error);
          };
        });
        return {
          local: localStorage.getItem('softn:regression:notes'),
          app,
          bundle: await (await caches.match('/saved-bundle.softn'))?.text(),
          registrations: (await navigator.serviceWorker.getRegistrations()).length,
        };
      });
      assert.deepEqual(stored, { local: 'keep these records', app: { name: 'Saved notes', bytes: 'app bundle' }, bundle: 'saved bundle bytes', registrations: 0 });
      assert.deepEqual(uncaught, []);
    } finally {
      await browser?.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
}
