// node --test apps/formlogic-host/test/nativeFetch.test.mjs
// (Node 24 runs the TypeScript module directly; it uses only erasable syntax.)
//
// A native app's `softn.net.fetch` is answered by the host itself. Until
// v0.0.28 a JavaScript app was given a `<logic>` fragment prepended to its entry
// file instead, which ran too late for an app's helper files. These tests run
// that fragment (kept below as it was) beside the handler and compare the
// answers, so the move changed the route and not the capability.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NATIVE_REQUEST_ACTION,
  createNativeNetFetch,
} from '../src/nativeFetch.ts';

/**
 * Run the real bridge text as the guest would: compile the fragment against a
 * stand-in `softn`, call the `net.fetch` it installed, and collect both what it
 * asked the backend for and what it handed back to the script.
 */
function throughBridge(url, options, reply) {
  const code = BRIDGE.match(/<logic>([\s\S]*?)<\/logic>/)[1];
  const asked = [];
  const softn = {
    net: {},
    backend: {
      call(action, input, done) {
        asked.push([action, input]);
        done(reply);
      },
    },
  };
  new Function('softn', code)(softn);
  let answer;
  softn.net.fetch(url, options, (value) => {
    answer = value;
  });
  return { answer, asked };
}

/** The same request through the host-side handler. */
async function throughHandler(url, options, reply) {
  const asked = [];
  const handler = createNativeNetFetch(async (action, input) => {
    asked.push([action, input]);
    return reply;
  });
  return { answer: await handler(url, options), asked };
}

/**
 * The fragment every JavaScript native app was given until v0.0.28, as it was:
 * what the handler is held to.
 */
const BRIDGE = `<logic>
softn.net.fetch = function(url, options, done) {
  softn.backend.call("nativeRequest", {url:url,options:options || {}}, function(response) {
    if (response.error) { done({ok:false,status:503,body:JSON.stringify({error:response.error}),headers:{}}); return; }
    const result = response.result;
    done({ok:result.status >= 200 && result.status < 300,status:result.status,body:JSON.stringify(result.body),headers:{}});
  });
};
</logic>
`;

test('the action is the one the parent routes to the app backend', () => {
  assert.equal(NATIVE_REQUEST_ACTION, 'nativeRequest');
});

test('a method is sent upper-cased, as a browser sends it', async () => {
  const { asked } = await throughHandler('https://api.test/save', { method: 'post', body: { a: 1 } }, { result: { status: 201, body: {} } });
  assert.deepEqual(asked, [[NATIVE_REQUEST_ACTION, { url: 'https://api.test/save', options: { method: 'POST', body: { a: 1 } } }]]);
  // Options with no method are sent as they came.
  assert.deepEqual((await throughHandler('https://api.test/x', { headers: { a: 'b' } }, { result: { status: 200 } })).asked[0][1].options, { headers: { a: 'b' } });
});

test('both routes ask the backend for the same thing', async () => {
  const options = { method: 'POST', body: 'a=1', headers: { accept: 'application/json' } };
  const reply = { result: { status: 200, body: { ok: true } } };
  const bridge = throughBridge('https://api.test/save', options, reply);
  const handler = await throughHandler('https://api.test/save', options, reply);
  assert.deepEqual(bridge.asked, [[NATIVE_REQUEST_ACTION, { url: 'https://api.test/save', options }]]);
  assert.deepEqual(handler.asked, bridge.asked);
  // No options at all is the same call on both sides.
  assert.deepEqual(
    (await throughHandler('https://api.test/x', undefined, reply)).asked,
    throughBridge('https://api.test/x', undefined, reply).asked
  );
});

test('both routes answer the script with the same response', async () => {
  const cases = [
    ['a success, with a JSON body', { result: { status: 200, body: { ok: true } } }],
    ['a created record', { result: { status: 201, body: [1, 2, 3] } }],
    ['a 199, which is not ok', { result: { status: 199, body: null } }],
    ['a 300, which is not ok either', { result: { status: 300, body: 'x' } }],
    ['a not-found', { result: { status: 404, body: { error: 'nope' } } }],
    ['a server error', { result: { status: 500, body: '' } }],
    ['the backend refusing', { error: 'This app has no connected backend.' }],
  ];
  for (const [what, reply] of cases) {
    const bridge = throughBridge('https://api.test/x', {}, reply);
    const handler = await throughHandler('https://api.test/x', {}, reply);
    assert.deepEqual(handler.answer, bridge.answer, what);
  }
  // Spelled out once, so a change to both at once is still visible here.
  assert.deepEqual((await throughHandler('https://api.test/x', {}, { result: { status: 200, body: { ok: true } } })).answer, {
    ok: true,
    status: 200,
    body: '{"ok":true}',
    headers: {},
  });
  assert.deepEqual((await throughHandler('https://api.test/x', {}, { error: 'down' })).answer, {
    ok: false,
    status: 503,
    body: '{"error":"down"}',
    headers: {},
  });
});

test('a backend that answers with no body at all is the one place the two differ', async () => {
  const reply = { result: { status: 204 } };
  const bridge = throughBridge('https://api.test/x', {}, reply);
  const handler = await throughHandler('https://api.test/x', {}, reply);
  // `JSON.stringify(undefined)` is undefined, which the bridge passes through
  // as a missing key. The handler returns the empty string instead: the same
  // falsy nothing to a script, and a `body` that is always a string.
  assert.equal(bridge.answer.body, undefined);
  assert.equal(handler.answer.body, '');
  for (const key of ['ok', 'status', 'headers']) {
    assert.deepEqual(handler.answer[key], bridge.answer[key], key);
  }
});
