/**
 * The guides at /docs/ during `npm run dev` are answered the way the static
 * hosts answer them: a guide's page, a redirect for a missing slash, a real
 * 404 for a guide that does not exist, and the docs sitemap — and anything
 * else is left to the site. The plugin is driven through a stand-in for the
 * Vite server, into a temporary directory, so the running server's
 * docs/dist/ is never touched.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { docsDevPlugin } from './dev-docs.mjs';

async function startPlugin(t) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'softn-dev-docs-'));
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));
  const middlewares = [];
  const server = {
    config: { server: { port: 1420 }, logger: { info() {}, error() {} } },
    watcher: { add() {}, on() {} },
    ws: { send() {} },
    middlewares: { use: (handler) => middlewares.push(handler) },
  };
  await docsDevPlugin({ outDir }).configureServer(server);
  const request = (url, method = 'GET') =>
    new Promise((resolve) => {
      const headers = {};
      const response = {
        statusCode: 200,
        setHeader: (name, value) => (headers[name.toLowerCase()] = value),
        end: (body) => resolve({ status: response.statusCode, headers, body: body ? String(body) : '' }),
      };
      middlewares[0]({ url, method }, response, () => resolve({ next: true }));
    });
  return { outDir, request };
}

test('serves the guides, redirects a missing slash, and 404s what does not exist', async (t) => {
  const { outDir, request } = await startPlugin(t);
  // The build starts with the server; a request waits for it.
  const home = await request('/docs/');
  assert.ok(fs.existsSync(path.join(outDir, 'docs', 'index.html')), 'the guides were built into the given directory');
  assert.equal(home.status, 200);
  assert.match(home.headers['content-type'], /^text\/html/);
  assert.match(home.body, /<h1[^>]*>/);

  const guide = await request('/docs/first-app/');
  assert.equal(guide.status, 200);
  assert.deepEqual(await request('/docs/first-app'), { status: 301, headers: { location: '/docs/first-app/' }, body: '' });
  assert.deepEqual(await request('/docs'), { status: 301, headers: { location: '/docs/' }, body: '' });

  const missing = await request('/docs/no-such-guide/');
  assert.equal(missing.status, 404);
  // An encoded slash survives URL parsing and would climb out once decoded.
  assert.equal((await request('/docs/..%2f..%2fpackage.json')).status, 404, 'nothing outside the build is reachable');

  const sitemap = await request('/sitemap-docs.xml');
  assert.equal(sitemap.status, 200);
  assert.match(sitemap.body, /<loc>http:\/\/localhost:1420\/docs\//);
});

test('leaves every other path, and every other method, to the site', async (t) => {
  const { request } = await startPlugin(t);
  assert.deepEqual(await request('/'), { next: true });
  assert.deepEqual(await request('/docsville/'), { next: true });
  assert.deepEqual(await request('/docs/', 'POST'), { next: true });
});
