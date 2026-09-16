// node --test apps/formlogic-host/test/engine-init.test.mjs
// (Node 24 runs the TypeScript module directly; it uses only erasable syntax.)
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_ENGINE,
  DOCUMENT_ENGINE_LISTS,
  HOSTED_ENGINES_PROTOCOL,
  HOST_JS_DOCUMENT_ENGINES,
  RUNTIME_ENGINES,
  ZIPP_DOCUMENT_ENGINES,
  acceptEngine,
  acceptZippBytes,
  documentEngines,
  readyEngines,
  requireEngineLanguages,
} from '../src/engineInit.ts';

test('an init that names no engine gets the engine hosted apps have always run', () => {
  assert.equal(DEFAULT_ENGINE, 'zipp-web-python');
  assert.equal(acceptEngine(undefined, ZIPP_DOCUMENT_ENGINES), 'zipp-web-python');
  // A parent that has the field but leaves it empty is the same case.
  assert.equal(acceptEngine(null, ZIPP_DOCUMENT_ENGINES), 'zipp-web-python');
  assert.equal(acceptEngine('zipp-web-python', ZIPP_DOCUMENT_ENGINES), 'zipp-web-python');
});

test('an engine this document does not serve is refused by name, not replaced', () => {
  for (const id of ['zipp-web', 'host-js']) {
    assert.throws(() => acceptEngine(id, ZIPP_DOCUMENT_ENGINES), new RegExp(`does not run the "${id}" engine`));
  }
  assert.throws(() => acceptEngine('anything-else', ZIPP_DOCUMENT_ENGINES), /does not run/);
  assert.throws(() => acceptEngine(7, ZIPP_DOCUMENT_ENGINES), /does not run the 7 engine/);
  assert.throws(() => acceptEngine({}, ZIPP_DOCUMENT_ENGINES), /does not run/);
});

test('the engine bytes are bounded exactly as they were, with the same reason', () => {
  const reason = { message: 'The parent must supply the matching ZIPP engine bytes' };
  const smallest = new ArrayBuffer(8);
  const largest = new ArrayBuffer(32 * 1024 * 1024);
  assert.equal(acceptZippBytes(smallest), smallest);
  assert.equal(acceptZippBytes(largest), largest);
  assert.throws(() => acceptZippBytes(new ArrayBuffer(7)), reason);
  assert.throws(() => acceptZippBytes(new ArrayBuffer(32 * 1024 * 1024 + 1)), reason);
  assert.throws(() => acceptZippBytes(undefined), reason);
  assert.throws(() => acceptZippBytes(new Uint8Array(4096)), reason, 'a view is not the cloned buffer');
});

test('an engine whose profile cannot run what its id promises is refused', () => {
  requireEngineLanguages('zipp-web-python', ['javascript', 'python']);
  assert.throws(
    () => requireEngineLanguages('zipp-web-python', ['javascript']),
    /zipp-web-python engine must run python/
  );
  // An engine that could not be asked answers nothing, and nothing is refused.
  assert.throws(() => requireEngineLanguages('zipp-web-python', []), /must run javascript and python/);
  requireEngineLanguages('zipp-web', ['javascript']);
  requireEngineLanguages('host-js', []);
});

test('ready announces exactly the engines this document accepts in init', () => {
  const identity = { version: '0.0.18', sha256: 'a'.repeat(64), release: 'v0.0.18' };
  for (const served of DOCUMENT_ENGINE_LISTS) {
    const announced = readyEngines(served, identity);
    assert.deepEqual(Object.keys(announced), [...served]);
    for (const id of served) assert.equal(acceptEngine(id, served), id, `${id} is accepted in init`);
  }
  // A ZIPP engine is announced with the bytes it wants; host JavaScript wants
  // none, and says so rather than naming an engine it will not load.
  assert.deepEqual(readyEngines(ZIPP_DOCUMENT_ENGINES, identity), { 'zipp-web-python': identity });
  assert.deepEqual(readyEngines(HOST_JS_DOCUMENT_ENGINES, identity), { 'host-js': true });
});

test('each document refuses the other document’s engine, by name', () => {
  assert.equal(acceptEngine('host-js', HOST_JS_DOCUMENT_ENGINES), 'host-js');
  assert.throws(() => acceptEngine('host-js', ZIPP_DOCUMENT_ENGINES), /does not run the "host-js" engine/);
  assert.throws(
    () => acceptEngine('zipp-web-python', HOST_JS_DOCUMENT_ENGINES),
    /does not run the "zipp-web-python" engine/
  );
  // The default is ZIPP, so a FormLogic that predates the choice and sends no
  // engine at all cannot be given host JavaScript by the host document either.
  assert.throws(() => acceptEngine(undefined, HOST_JS_DOCUMENT_ENGINES), /does not run/);
  assert.throws(() => acceptEngine(null, HOST_JS_DOCUMENT_ENGINES), /does not run/);
});

test('the document attribute decides what the document serves, and fails closed', () => {
  assert.deepEqual(documentEngines(null), ZIPP_DOCUMENT_ENGINES);
  assert.deepEqual(documentEngines(undefined), ZIPP_DOCUMENT_ENGINES);
  assert.deepEqual(documentEngines(''), ZIPP_DOCUMENT_ENGINES);
  assert.deepEqual(documentEngines('host-js'), HOST_JS_DOCUMENT_ENGINES);
  // An attribute this build does not know serves nothing at all: every init is
  // refused rather than run on a guess.
  for (const unknown of ['host-python', 'HOST-JS', 'zipp-web-python', ' host-js']) {
    assert.deepEqual(documentEngines(unknown), [], unknown);
    assert.throws(() => acceptEngine(undefined, documentEngines(unknown)), /does not run/);
  }
});

test('the runtime manifest list is the union of what the documents serve', () => {
  const union = [...new Set(DOCUMENT_ENGINE_LISTS.flat())].sort();
  assert.deepEqual([...RUNTIME_ENGINES], union);
  assert.deepEqual([...RUNTIME_ENGINES], ['host-js', 'zipp-web-python']);
  // Every document a build serves is one FormLogic has to know how to mount,
  // which is what the protocol number in softn-release.json says.
  assert.equal(HOSTED_ENGINES_PROTOCOL, 1);
  assert.ok(Number.isInteger(HOSTED_ENGINES_PROTOCOL));
});
