// node --test apps/formlogic-host/test/engine-init.test.mjs
// (Node 24 runs the TypeScript module directly; it uses only erasable syntax.)
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_ENGINE,
  DOCUMENT_ENGINE_LISTS,
  RUNTIME_ENGINES,
  ZIPP_DOCUMENT_ENGINES,
  acceptEngine,
  acceptZippBytes,
  requireEngineLanguages,
  zippReadyEngines,
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
  const announced = zippReadyEngines(identity);
  assert.deepEqual(Object.keys(announced), [...ZIPP_DOCUMENT_ENGINES]);
  for (const id of ZIPP_DOCUMENT_ENGINES) {
    assert.deepEqual(announced[id], identity, `${id} is described by the installed release`);
    assert.equal(acceptEngine(id, ZIPP_DOCUMENT_ENGINES), id, `${id} is accepted in init`);
  }
});

test('the runtime manifest list is the union of what the documents serve', () => {
  const union = [...new Set(DOCUMENT_ENGINE_LISTS.flat())].sort();
  assert.deepEqual([...RUNTIME_ENGINES], union);
  assert.deepEqual([...RUNTIME_ENGINES], ['zipp-web-python']);
});
