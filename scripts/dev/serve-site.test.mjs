/**
 * The static preview (`npm run preview:site`) answers no more than a host
 * does, and no request stops it.
 *
 * - The directory's state under data/ (its config holds the admin key) and
 *   the API's PHP under api/ are never served by the shipped Apache rules,
 *   the nginx config or the PHP router; the preview served both as files.
 *   Dotfiles are configuration and are refused by all three as well.
 * - A request target that does not parse as a URL (`//`) threw out of the
 *   request listener, which ends the process: one such request stopped the
 *   preview.
 * - Nothing outside dist/ is reachable, however the path is spelt.
 *
 * The script serves the dist/ beside its own scripts/ folder, so it is copied
 * into a temporary root with a small dist/ of its own, on a port the system
 * picks.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function startPreview(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'softn-preview-test-'));
  const files = {
    'dist/index.html': '<!doctype html><title>site</title>',
    'dist/web/index.html': '<!doctype html><title>runtime</title>',
    'dist/assets/app.js': 'console.log(1)',
    'dist/.htaccess': 'Options -Indexes\n',
    'dist/.well-known/security.txt': 'Contact: mailto:security@example.test\n',
    'dist/data/.htaccess': 'Require all denied\n',
    'dist/data/config.json': '{"adminKey":"the-admin-key"}',
    'dist/data/apps/notes/bundle.softn': 'PK-an-uploaded-bundle',
    'dist/api/index.php': '<?php // the API',
    'dist/api/lib/db.php': '<?php // its library',
    'outside.txt': 'outside dist',
  };
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), text);
  }
  fs.mkdirSync(path.join(root, 'scripts/dev'), { recursive: true });
  fs.copyFileSync(new URL('./serve-site.mjs', import.meta.url), path.join(root, 'scripts/dev/serve-site.mjs'));
  // It finds the checkout's root through scripts/lib/paths.mjs, which comes along.
  fs.mkdirSync(path.join(root, 'scripts/lib'), { recursive: true });
  fs.copyFileSync(new URL('../lib/paths.mjs', import.meta.url), path.join(root, 'scripts/lib/paths.mjs'));

  const port = await freePort();
  const child = spawn(process.execPath, [path.join(root, 'scripts/dev/serve-site.mjs')], {
    env: { ...process.env, SOFTN_SITE_PORT: String(port), SOFTN_SITE_HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let exited = null;
  child.on('exit', (code) => (exited = code ?? 1));
  t.after(() => {
    child.kill();
    const checked = fs.realpathSync(root);
    assert.equal(path.dirname(checked), fs.realpathSync(os.tmpdir()));
    fs.rmSync(checked, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    let log = '';
    child.stdout.on('data', (chunk) => {
      log += chunk;
      if (log.includes('softn.com preview')) resolve();
    });
    child.stderr.on('data', (chunk) => (log += chunk));
    child.on('exit', () => reject(new Error(`the preview did not start:\n${log}`)));
  });

  /** One GET with the request target sent exactly as written: fetch would tidy it first. */
  const get = (target, accept = '*/*') =>
    new Promise((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port, path: target, headers: { Accept: accept } }, (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => (body += chunk));
        response.on('end', () => resolve({ status: response.statusCode, body }));
      });
      request.on('error', reject);
      request.end();
    });
  return { get, stopped: () => exited };
}

test('serves the site and nothing a host keeps private', async (t) => {
  const { get } = await startPreview(t);
  assert.equal((await get('/', 'text/html')).body, '<!doctype html><title>site</title>');
  assert.equal((await get('/assets/app.js')).status, 200);
  assert.equal((await get('/.well-known/security.txt')).status, 200);

  for (const target of ['/data/config.json', '/data/apps/notes/bundle.softn', '/data/', '/data', '/data/.htaccess', '/api/index.php', '/api/lib/db.php', '/.htaccess']) {
    for (const accept of ['*/*', 'text/html']) {
      const answer = await get(target, accept);
      assert.equal(answer.status, 404, `${target} (Accept: ${accept})`);
      assert.ok(!/admin-key|uploaded-bundle|<\?php|Options|Require/.test(answer.body), `${target} gives nothing away`);
    }
  }
  // Other names for the same files on a file system that ignores case or has
  // NTFS streams: on Windows each of these opened the private file.
  for (const target of ['/DATA/config.json', '/data::$INDEX_ALLOCATION/config.json', '/data/config.json::$DATA', '/API/index.php', '/data./config.json', '/data%20/config.json', '/index.html::$DATA']) {
    for (const accept of ['*/*', 'text/html']) {
      const answer = await get(target, accept);
      assert.equal(answer.status, 404, `${target} (Accept: ${accept})`);
      assert.ok(!/admin-key|<\?php/.test(answer.body), `${target} gives nothing away`);
    }
  }
  // A route inside the runtime may be spelt with a colon; it is the app's, and gets the shell.
  const route = await get('/web/app/a:b', 'text/html');
  assert.equal(route.status, 200);
  assert.equal(route.body, '<!doctype html><title>runtime</title>');
});

test('reaches nothing outside dist/, however the path is spelt', async (t) => {
  const { get } = await startPreview(t);
  for (const target of ['/../outside.txt', '/%2e%2e/outside.txt', '/..%2foutside.txt', '/..%5coutside.txt', '/assets/..%2f..%2foutside.txt', '/%252e%252e/outside.txt', '/assets/%00/../../outside.txt']) {
    const answer = await get(target);
    assert.ok(answer.status === 400 || answer.status === 404, `${target} answered ${answer.status}`);
    assert.ok(!answer.body.includes('outside dist'), `${target} gives nothing away`);
  }
});

test('a request target that is not a URL is refused, and the preview keeps serving', async (t) => {
  const { get, stopped } = await startPreview(t);
  const answer = await get('//').catch((error) => ({ status: `no answer (${error.code ?? error.message})` }));
  assert.equal(answer.status, 400);
  assert.equal((await get('/', 'text/html')).status, 200, 'still serving');
  assert.equal(stopped(), null, 'the process is still running');
});
