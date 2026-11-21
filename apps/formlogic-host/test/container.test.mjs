// node --test apps/formlogic-host/test/container.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildContainerSource,
  createPortBackendTransport,
  grantedContainerCapabilities,
  isContainerBundle,
  isSafeClientPath,
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
  assert.deepEqual(res.headers, [
    ['content-type', 'application/json'],
    ['set-cookie', 'a=1'],
    ['set-cookie', 'b=2'],
  ]);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(res.body)), { created: true });

  assert.equal(isSafeClientPath('public/logo.png'), true);
  assert.equal(isSafeClientPath('assets/icon.svg'), true);
  assert.equal(isSafeClientPath('backend/index.php'), false);
  assert.equal(isSafeClientPath('server/main.logic'), false);
  assert.equal(isSafeClientPath('private/config.json'), false);
  assert.equal(isSafeClientPath('db/schema.sql'), false);

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
