// node --test apps/formlogic-host/test/container.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildContainerSource,
  createPortBackendTransport,
  grantedContainerCapabilities,
  isContainerBundle,
  isSafeClientPath,
  isSafeLocalContainerPath,
} from '../src/containerBridge.ts';

test('identifies v2 Web Containers by manifest engine, container flag, backend block, or zero-config HTML', () => {
  const html = new Map([['index.html', '<!doctype html><html><body>Hi</body></html>']]);
  assert.equal(isContainerBundle({}, html), true);

  const v2 = new Map([
    ['manifest.json', JSON.stringify({ engine: 2, name: 'App', main: 'index.html' })],
    ['index.html', '<p>hi</p>'],
  ]);
  assert.equal(isContainerBundle({ engine: 2, name: 'App', main: 'index.html' }, v2), true);
  assert.equal(isContainerBundle({ container: true, name: 'App', main: 'index.html' }, v2), true);
  assert.equal(
    isContainerBundle({ name: 'App', main: 'public/index.html', backend: { runtime: 'php', entry: 'server/public/index.php' } }, v2),
    true
  );

  // Legacy v1 bundles stay on SoftNWithXDB.
  const v1 = new Map([
    ['manifest.json', JSON.stringify({ name: 'Notes', main: 'ui/main.ui' })],
    ['ui/main.ui', '<App><Text>Hi</Text></App>'],
  ]);
  assert.equal(isContainerBundle({ name: 'Notes', main: 'ui/main.ui' }, v1), false);
  assert.equal(isContainerBundle({ engine: '2', name: 'Notes', main: 'ui/main.ui' }, v1), false);
  assert.equal(
    isContainerBundle({ name: 'Notes', main: 'ui/main.ui', backend: { runtime: 'javascript', entry: 'backend/server.js' } }, v1),
    false
  );
});

test('assembles container VFS from client text and binary/base64 assets while dropping unsafe paths', () => {
  const files = new Map([
    ['manifest.json', '{"engine":2,"name":"Desk","main":"public/index.html"}'],
    ['public/index.html', '<h1>Desk</h1>'],
    ['../escape.txt', 'bad'],
  ]);
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const vfs = buildContainerSource(files, {
    'public/logo.bin': bytes,
    'public/icon.bin': new Uint8Array([5, 6]).buffer,
    'public/b64.txt': Buffer.from('hello').toString('base64'),
    'a\\b.png': bytes,
  });
  assert.equal(vfs['public/index.html'], '<h1>Desk</h1>');
  assert.equal(vfs['../escape.txt'], undefined);
  assert.equal(vfs['a\\b.png'], undefined);
  assert.deepEqual(vfs['public/logo.bin'], bytes);
  assert.deepEqual(vfs['public/icon.bin'], new Uint8Array([5, 6]));
  assert.equal(new TextDecoder().decode(vfs['public/b64.txt']), 'hello');
});

test('forwards only explicitly enabled capabilities to the container', () => {
  assert.deepEqual(
    grantedContainerCapabilities({
      permissions: { files: { enabled: true }, net: { enabled: false }, camera: { enabled: true } },
    }),
    ['camera', 'files']
  );
  assert.deepEqual(grantedContainerCapabilities(undefined), []);
});

test('bridges container HTTP requests across MessagePort via containerHttp action', async () => {
  const seen = [];
  const transport = createPortBackendTransport(async (action, input) => {
    seen.push({ action, input });
    return {
      status: 201,
      headers: { 'Content-Type': 'application/json', 'Set-Cookie': ['a=1', 'b=2'] },
      bodyBase64: Buffer.from(JSON.stringify({ created: true })).toString('base64'),
    };
  });
  assert.equal(transport.kind, 'remote');
  await transport.ready;
  const res = await transport.fetch({
    method: 'POST',
    path: '/api/items',
    query: 'limit=5',
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode('{"name":"Coffee"}'),
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].action, 'containerHttp');
  assert.equal(seen[0].input.method, 'POST');
  assert.equal(seen[0].input.path, '/api/items');
  assert.equal(seen[0].input.query, 'limit=5');
  assert.equal(Buffer.from(seen[0].input.bodyBase64, 'base64').toString('utf8'), '{"name":"Coffee"}');
  assert.equal(res.status, 201);
  // Set-Cookie headers are ingested into the host cookie jar and stripped from guest-visible headers.
  assert.deepEqual(res.headers, [
    ['content-type', 'application/json'],
  ]);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(res.body)), { created: true });
  await transport.fetch({
    method: 'GET',
    path: '/api/items',
    query: '',
    headers: {},
    body: new Uint8Array(),
  });
  assert.equal(seen[1].input.headers.cookie, 'a=1; b=2');

  assert.equal(isSafeClientPath('public/logo.png'), true);
  assert.equal(isSafeClientPath('assets/icon.svg'), true);
  assert.equal(isSafeClientPath('backend/index.php'), false);
  assert.equal(isSafeClientPath('server/main.logic'), false);
  assert.equal(isSafeClientPath('private/config.json'), false);
  assert.equal(isSafeClientPath('db/schema.sql'), false);

  assert.equal(isSafeLocalContainerPath('backend/server.js'), true);
  assert.equal(isSafeLocalContainerPath('server/index.php'), true);
  assert.equal(isSafeLocalContainerPath('db/schema.sql'), true);
  assert.equal(isSafeLocalContainerPath('private/config.json'), false);
  assert.equal(isSafeLocalContainerPath('../escape.sql'), false);

  const localVfs = buildContainerSource(
    new Map([
      ['manifest.json', '{"engine":2,"main":"index.html","backend":{"runtime":"javascript","entry":"backend/server.js"}}'],
      ['index.html', '<h1>App</h1>'],
      ['backend/server.js', 'function handleRequest() { return "ok"; }'],
      ['db/schema.sql', 'CREATE TABLE t (id INTEGER PRIMARY KEY);'],
      ['private/secret.json', '{"key":"no"}'],
    ]),
    undefined,
    { allowLocalBackend: true }
  );
  assert.equal(localVfs['backend/server.js'], 'function handleRequest() { return "ok"; }');
  assert.equal(localVfs['db/schema.sql'], 'CREATE TABLE t (id INTEGER PRIMARY KEY);');
  assert.equal(localVfs['private/secret.json'], undefined);

  const wrappedTransport = createPortBackendTransport(async () => ({
    result: {
      status: 200,
      headers: [['Content-Type', 'application/json']],
      bodyBase64: Buffer.from('{"ok":true}').toString('base64'),
    },
  }));
  const wrappedRes = await wrappedTransport.fetch({ method: 'GET', path: '/api/ping' });
  assert.equal(wrappedRes.status, 200);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(wrappedRes.body)), { ok: true });

  transport.dispose();
  const afterDispose = await transport.fetch({
    method: 'GET',
    path: '/api/items',
  });
  assert.equal(afterDispose.status, 503);
});

test('PortBackendTransport maintains Set-Cookie session jar, blocks SSRF/spoofing headers, and survives bad base64', async () => {
  const seen = [];
  let callNum = 0;
  const transport = createPortBackendTransport(async (_action, input) => {
    seen.push(input);
    callNum++;
    if (callNum === 1) {
      return {
        status: 200,
        headers: [['Set-Cookie', 'sid=abc123; Path=/; HttpOnly']],
        bodyBase64: Buffer.from('ok').toString('base64'),
      };
    }
    if (callNum === 2) {
      return {
        status: 200,
        headers: [['Set-Cookie', 'sid=; Path=/; Max-Age=0']],
        bodyBase64: '!!!not-valid-base64!!!',
      };
    }
    return { status: 200, headers: [], bodyBase64: '' };
  });

  // 1. Path traversal / protocol-relative SSRF rejected locally before reaching host.
  assert.equal((await transport.fetch({ method: 'GET', path: '//evil.example/x' })).status, 400);
  assert.equal((await transport.fetch({ method: 'GET', path: '/../secret' })).status, 400);
  assert.equal((await transport.fetch({ method: 'GET', path: '/%2e%2e/secret' })).status, 400);
  assert.equal(seen.length, 0);

  // 2. Host-identity headers (hyphen AND underscore variants) stripped before sending.
  const first = await transport.fetch({
    method: 'GET',
    path: '/api/login',
    headers: {
      'X-FormLogic-User-Id': 'spoof',
      'x_formlogic_user_id': 'spoof',
      'X-App-Token': 'ok',
    },
  });
  assert.equal(first.status, 200);
  assert.equal(seen[0].headers['x-formlogic-user-id'], undefined);
  assert.equal(seen[0].headers['x_formlogic_user_id'], undefined);
  assert.equal(seen[0].headers['x-app-token'], 'ok');

  // 3. Second request automatically carries captured cookie, and malformed base64 returns 502 instead of throwing.
  const second = await transport.fetch({ method: 'GET', path: '/api/me' });
  assert.equal(seen[1].headers.cookie, 'sid=abc123');
  assert.equal(second.status, 502);

  // 4. Third request has Max-Age=0 cookie cleared.
  const third = await transport.fetch({ method: 'GET', path: '/api/me' });
  assert.equal(third.status, 200);
  assert.equal(seen[2].headers.cookie, undefined);

  // 5. Tightened isSafeClientPath blocks secrets and backend code extensions.
  assert.equal(isSafeClientPath('.env'), false);
  assert.equal(isSafeClientPath('.env.production'), false);
  assert.equal(isSafeClientPath('.htaccess'), false);
  assert.equal(isSafeClientPath('.git/config'), false);
  assert.equal(isSafeClientPath('admin.php'), false);
  assert.equal(isSafeClientPath('data.sqlite'), false);
});

test('web.ts handles formlogic:update, guards typed message IDs from settling backend calls, and gates place until shown', async () => {
  const { readFileSync } = await import('node:fs');
  const webSrc = readFileSync(new URL('../src/web.ts', import.meta.url), 'utf8');
  assert.match(webSrc, /data\?\.type === 'formlogic:update'/);
  assert.match(webSrc, /outcome: 'reopen'/);
  assert.match(webSrc, /if \(data\?\.type !== undefined\) return;/);
  assert.match(webSrc, /pendingNavigate/);
  assert.match(webSrc, /pendingPlace/);
  assert.match(webSrc, /outsideAddress/);
});

test('PortBackendTransport strips spoofed Cookie/X-Forwarded headers, rejects bad methods/CRLF, and withholds manifest backend files', async () => {
  const seen = [];
  const transport = createPortBackendTransport(async (_action, input) => {
    seen.push(input);
    return { status: 200, headers: [], bodyBase64: '' };
  });

  // Unsupported HTTP method rejected
  assert.equal((await transport.fetch({ method: 'CONNECT', path: '/api/ping' })).status, 405);
  // CRLF in query rejected
  assert.equal((await transport.fetch({ method: 'GET', path: '/api/ping', query: 'a=1\r\nX-Injected: yes' })).status, 400);
  assert.equal(seen.length, 0);

  // Guest-supplied Cookie and X-Forwarded-* headers stripped
  await transport.fetch({
    method: 'GET',
    path: '/api/ping',
    headers: {
      cookie: 'spoof=1',
      'x-forwarded-for': '127.0.0.1',
      'x-forwarded-host': 'evil.example',
      'x-original-url': '/admin',
      'x-bad-crlf': 'ok\r\nevil: 1',
      'x-good': 'kept',
    },
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].headers.cookie, undefined);
  assert.equal(seen[0].headers['x-forwarded-for'], undefined);
  assert.equal(seen[0].headers['x-forwarded-host'], undefined);
  assert.equal(seen[0].headers['x-original-url'], undefined);
  assert.equal(seen[0].headers['x-bad-crlf'], undefined);
  assert.equal(seen[0].headers['x-good'], 'kept');

  // Manifest-aware isSafeClientPath blocks custom backend roots, seedJson/seedSql, Cargo.toml, .py/.rs
  const manifest = {
    backend: { root: 'custom_srv', entry: 'api_dir/main.ts' },
    ssrEntry: 'ssr/render.js',
    databases: [{ name: 'app', file: 'data/app.bin', seedJson: 'init/seed.json', seedSql: 'init/schema.txt' }],
  };
  assert.equal(isSafeClientPath('custom_srv/secret.js', manifest), false);
  assert.equal(isSafeClientPath('api_dir/helper.js', manifest), false);
  assert.equal(isSafeClientPath('ssr/render.js', manifest), false);
  assert.equal(isSafeClientPath('data/app.bin', manifest), false);
  assert.equal(isSafeClientPath('init/seed.json', manifest), false);
  assert.equal(isSafeClientPath('init/schema.txt', manifest), false);
  assert.equal(isSafeClientPath('Cargo.toml', manifest), false);
  assert.equal(isSafeClientPath('script.py', manifest), false);
  assert.equal(isSafeClientPath('public/app.js', manifest), true);

  // buildContainerSource applies parsed manifest.json to drop custom backend files when host-backed
  const hostedFiles = new Map([
    ['manifest.json', JSON.stringify({ engine: 2, main: 'public/index.html', backend: { root: 'custom_srv', entry: 'custom_srv/main.js' } })],
    ['public/index.html', '<h1>Hi</h1>'],
    ['custom_srv/main.js', 'secret'],
    ['custom_srv/helper.js', 'secret2'],
  ]);
  const hostedVfs = buildContainerSource(hostedFiles, { 'custom_srv/data.bin': new Uint8Array([1]) });
  assert.equal(hostedVfs['public/index.html'], '<h1>Hi</h1>');
  assert.equal(hostedVfs['custom_srv/main.js'], undefined);
  assert.equal(hostedVfs['custom_srv/helper.js'], undefined);
  assert.equal(hostedVfs['custom_srv/data.bin'], undefined);

  // PortBackendTransport rejects query/fragment/double-encoding/oversized paths
  assert.equal((await transport.fetch({ method: 'GET', path: '/api/ping?a=1' })).status, 400);
  assert.equal((await transport.fetch({ method: 'GET', path: '/api/ping#frag' })).status, 400);
  assert.equal((await transport.fetch({ method: 'GET', path: '/api/%252e%252e/secret' })).status, 400);
  assert.equal((await transport.fetch({ method: 'GET', path: `/api/${'a'.repeat(2100)}` })).status, 400);
});
