// node --test apps/formlogic-host/test/nativeFetch.test.mjs
// (Node 24 runs the TypeScript module directly; it uses only erasable syntax.)
//
// A native app's `softn.net.fetch` has one behaviour and two routes to it. The
// route a JavaScript app takes is a `<logic>` fragment prepended to its entry
// file; the route an app whose logic is not JavaScript takes is the host
// answering the call itself. These tests run BOTH and compare the answers, so
// the second route cannot quietly become a different capability from the first.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NATIVE_FETCH_BRIDGE,
  NATIVE_REQUEST_ACTION,
  createNativeNetFetch,
  nativeFetchRoute,
} from '../src/nativeFetch.ts';

/**
 * Run the real bridge text as the guest would: compile the fragment against a
 * stand-in `softn`, call the `net.fetch` it installed, and collect both what it
 * asked the backend for and what it handed back to the script.
 */
function throughBridge(url, options, reply) {
  const code = NATIVE_FETCH_BRIDGE.match(/<logic>([\s\S]*?)<\/logic>/)[1];
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
 * The fragment every native app has been given, written out as one literal
 * rather than built — the way `policy.test.mjs` writes out the ZIPP policy.
 * Moving it out of `main.tsx` was meant to change nothing about it, and a diff
 * here is a change to source that is prepended to a real app's entry file.
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

test('a JavaScript app keeps the bridge; only Python takes the handler', () => {
  assert.equal(nativeFetchRoute(['javascript']), 'logic-bridge');
  assert.equal(nativeFetchRoute([]), 'logic-bridge');
  assert.equal(nativeFetchRoute(['javascript', 'python']), 'host-handler');
  assert.equal(nativeFetchRoute(['python']), 'host-handler');
  // The bridge is the text it has always been, character for character.
  assert.equal(NATIVE_FETCH_BRIDGE, BRIDGE);
  assert.equal(NATIVE_REQUEST_ACTION, 'nativeRequest');
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
