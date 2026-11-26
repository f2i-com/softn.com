/**
 * Round 4 (container host): the request path a backend is given.
 *
 * Both native hosts decode a request's path once where it comes in, before `.htaccess` and the
 * backend see it (`decode_http_path` in apps/softn-host-rust, `softn_decode_path` in
 * apps/softn-host-php/runtime/request.php), keep its trailing `/`, and answer 400 for an
 * encoded separator, control character, `?` or `#`, a `..` segment, or bytes that are not UTF-8.
 */
import { describe, it, expect } from 'vitest';
import { LocalBackendTransport } from '../src/local-backend-transport';
import type { BackendConfig } from '../src/types';

const dec = new TextDecoder();

function transport(backend: BackendConfig, textFiles: Record<string, string>) {
  return new LocalBackendTransport({
    appId: 'r4-paths',
    storagePrefix: 'r4-paths:',
    persistStorage: false,
    backend,
    textFiles,
    binaryFiles: {},
    runtimeUrl: '/runtime/',
    isolation: 'inline',
  });
}

async function get(t: LocalBackendTransport, p: string, query = '') {
  const r = await t.fetch({ method: 'GET', path: p, query, headers: {} });
  const location = r.headers.find(([k]) => k.toLowerCase() === 'location')?.[1];
  return { status: r.status, text: dec.decode(r.body), location };
}

const PHP: BackendConfig = { runtime: 'php', entry: 'index.php', mode: 'ssr' };

describe('r4 host: a backend is given the path decoded, as on the native hosts', () => {
  it('serves a PHP app file whose name has a space or a letter outside ASCII', async () => {
    const t = transport(PHP, {
      'index.php': `<?php echo 'front:' . $_SERVER['REQUEST_URI'];`,
      'docs/my report.txt': 'the report',
      'café.php': `<?php echo 'cafe:' . $_SERVER['REQUEST_URI'];`,
    });
    await t.ready;
    expect(await get(t, '/docs/my%20report.txt')).toMatchObject({ status: 200, text: 'the report' });
    expect(await get(t, '/caf%C3%A9.php', 'x=1')).toMatchObject({ status: 200, text: 'cafe:/café.php?x=1' });
    t.dispose();
  });

  it('applies an .htaccess rule to a path whose letters are percent-encoded', async () => {
    const t = transport(PHP, {
      '.htaccess': 'RewriteEngine On\nRewriteRule ^admin - [F]\n',
      'index.php': `<?php echo 'front:' . $_SERVER['REQUEST_URI'];`,
    });
    await t.ready;
    expect((await get(t, '/admin/users')).status).toBe(403);
    expect((await get(t, '/%61dmin/users')).status).toBe(403);
    expect(await get(t, '/other')).toMatchObject({ status: 200, text: 'front:/other' });
    t.dispose();
  });

  it('keeps the trailing slash for .htaccess, as Laravel\'s rules read it', async () => {
    const t = transport(PHP, {
      '.htaccess': [
        'RewriteEngine On',
        'RewriteCond %{REQUEST_FILENAME} !-d',
        'RewriteCond %{REQUEST_URI} (.+)/$',
        'RewriteRule ^ %1 [L,R=301]',
        'RewriteCond %{REQUEST_FILENAME} !-d',
        'RewriteCond %{REQUEST_FILENAME} !-f',
        'RewriteRule ^ index.php [L]',
      ].join('\n'),
      'index.php': `<?php echo 'front:' . $_SERVER['REQUEST_URI'];`,
    });
    await t.ready;
    expect(await get(t, '/blog/')).toMatchObject({ status: 301, location: '/blog' });
    expect(await get(t, '/blog')).toMatchObject({ status: 200, text: 'front:/blog' });
    t.dispose();
  });

  it('answers 400 for a path the hosts refuse', async () => {
    const t = transport(PHP, { 'index.php': `<?php echo 'front';` });
    await t.ready;
    expect((await get(t, '/a%2Fb')).status).toBe(400);
    expect((await get(t, '/a%5Cb')).status).toBe(400);
    expect((await get(t, '/a/%2e%2e/index.php')).status).toBe(400);
    expect((await get(t, '/a%00b')).status).toBe(400);
    expect((await get(t, '/a%zz')).status).toBe(400);
    expect((await get(t, '/a%C3')).status).toBe(400);
    expect(await get(t, '/fine')).toMatchObject({ status: 200, text: 'front' });
    t.dispose();
  });

  it('gives a JS backend the decoded path', async () => {
    const t = transport({ runtime: 'javascript', entry: 'backend/index.js', mode: 'api', routes: ['/api/'] }, {
      'backend/index.js': `function handleRequest(req) { return { status: 200, body: req.path }; }`,
    });
    await t.ready;
    expect(await get(t, '/api/items/my%20item')).toMatchObject({ status: 200, text: '/api/items/my item' });
    expect(await get(t, '/api/items/')).toMatchObject({ status: 200, text: '/api/items/' });
    t.dispose();
  });
});
