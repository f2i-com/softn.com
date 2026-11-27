// node --test apps/formlogic-host/test/web-calls.test.mjs
//
// What the web frame passes to FormLogic's page when an app calls `softn.backend.call` (web.ts,
// frameBackendCall). Beside an upload and a request to one of its own routes, the four calls the
// page answers itself, as the classic frame passes them: the wallet (after a declined charge), what
// the page can do, listening and an app offered. They were all answered "Use an app-relative API
// route under /api/.", so a web app that takes payments could not open the wallet. Every other name
// is still refused here, where the frame's own storage, HTTP and engine calls cannot be imitated.
import test from 'node:test';
import assert from 'node:assert/strict';
import { frameBackendCall, PAGE_ACTIONS } from '../src/containerBridge.ts';

const ROUTE = 'Use an app-relative API route under /api/.';

/** The frame's router over a parent that answers every call it is sent, and what it was sent. */
function frame() {
  const sent = [];
  const call = frameBackendCall(async (action, input) => {
    sent.push([action, input]);
    return { result: { answered: action } };
  });
  return { call, sent };
}

test('passes the page\'s own calls to the parent as the app made them, and answers with what it says', async () => {
  const { call, sent } = frame();
  const asks = [
    ['formlogicWallet', { op: 'open' }],
    ['formlogicHost', { op: 'abilities' }],
    ['formlogicDictate', { op: 'start' }],
    ['formlogicDictate', { op: 'stop' }],
    ['formlogicAddApp', { op: 'offer', from: '/api/projects/7/export', name: 'Tiny notes' }],
    ['formlogicAddApp', { op: 'status' }],
  ];
  for (const [action, input] of asks) assert.deepEqual(await call(action, input), { result: { answered: action } }, action);
  assert.deepEqual(sent, asks);
  assert.deepEqual([...PAGE_ACTIONS].sort(), ['formlogicAddApp', 'formlogicDictate', 'formlogicHost', 'formlogicWallet']);
});

test('refuses every other name without asking the parent: the frame\'s own calls are not the app\'s to make', async () => {
  const { call, sent } = frame();
  for (const action of ['nativeStorage', 'containerHttp', 'containerEngine', 'workspaceInfo', 'workspaceRecords', 'pluginDone', 'formlogicMicrophone', 'formlogicwallet', 'listNotes']) {
    assert.deepEqual(await call(action, { op: 'open', operation: 'batch', path: '/api/x', url: '/api/x' }), { error: ROUTE }, action);
  }
  assert.deepEqual(sent, []);
});

test('still sends a request only for one of the app\'s own routes', async () => {
  const { call, sent } = frame();
  await call('nativeRequest', { url: '/api/notes?limit=5', options: { method: 'GET' } });
  for (const url of ['https://elsewhere.example/api/notes', '/api/../admin', '/api/%2e%2e/admin', '/api/a%2fb', '/other', '/api/x\r\nHost: y', `/api/${'a'.repeat(2050)}`]) {
    assert.deepEqual(await call('nativeRequest', { url, options: {} }), { error: ROUTE }, url);
  }
  assert.deepEqual(sent, [['nativeRequest', { url: '/api/notes?limit=5', options: { method: 'GET' } }]]);
});

test('still checks an upload\'s shape before the parent is asked', async () => {
  const { call, sent } = frame();
  assert.deepEqual(await call('formlogicUpload', { op: 'erase' }), { error: 'Unsupported upload operation.' });
  assert.deepEqual(await call('formlogicUpload', { op: 'delete', id: '../x' }), { error: 'Invalid upload id.' });
  assert.deepEqual(await call('formlogicUpload', { contentBase64: '' }), { error: 'Invalid upload payload.' });
  assert.deepEqual(await call('formlogicUpload', { op: 'list', folder: 7 }), { error: 'Invalid upload folder.' });
  assert.deepEqual(sent, []);
  await call('formlogicUpload', { contentBase64: 'aGk=', filename: 'hi.txt' });
  await call('formlogicUpload', { op: 'list', folder: 'photos' });
  await call('formlogicUpload', { op: 'delete', id: 'abcd-1234' });
  assert.deepEqual(sent.map(([action, input]) => [action, input.op ?? 'upload']), [['formlogicUpload', 'upload'], ['formlogicUpload', 'list'], ['formlogicUpload', 'delete']]);
});

test('validates bounded binary app offers (formlogicOfferBundle) before forwarding to parent', async () => {
  const { call, sent } = frame();
  const goodSha = 'a'.repeat(64);
  assert.deepEqual(await call('formlogicOfferBundle', { op: 'delete' }), { error: 'Unsupported binary app offer operation.' });
  assert.deepEqual(await call('formlogicOfferBundle', { name: '', operation: 'create', bundleBase64: 'UEs=', sha256: goodSha }), { error: 'Invalid binary app offer payload.' });
  assert.deepEqual(await call('formlogicOfferBundle', { name: 'App', operation: 'create', bundleBase64: 'UEs=', sha256: 'short' }), { error: 'Invalid binary app offer payload.' });
  assert.deepEqual(await call('formlogicOfferBundle', { name: 'App', operation: 'update', targetAppId: '../evil', bundleBase64: 'UEs=', sha256: goodSha }), { error: 'Invalid binary app offer payload.' });
  assert.deepEqual(sent, []);

  await call('formlogicOfferBundle', {
    op: 'offer',
    name: 'Inventory App',
    operation: 'create',
    bundleBase64: 'UEsDBAo=',
    sha256: goodSha,
  });
  await call('formlogicOfferBundle', { op: 'status' });
  assert.deepEqual(sent.map(([action, input]) => [action, input.op]), [['formlogicOfferBundle', 'offer'], ['formlogicOfferBundle', 'status']]);
});
