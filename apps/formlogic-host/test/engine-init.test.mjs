// node --test apps/formlogic-host/test/engine-init.test.mjs
// (Node 24 runs the TypeScript module directly; it uses only erasable syntax.)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_ENGINE,
  DOCUMENT_ENGINE_LISTS,
  ENGINE_LANGUAGES,
  HOSTED_ENGINES_PROTOCOL,
  HOST_JS_DOCUMENT_ENGINES,
  LOGIC_LANGUAGES_PROTOCOL,
  PYTHON_LOGIC_SUFFIX,
  RUNTIME_ENGINES,
  RUNTIME_FEATURES,
  ZIPP_DOCUMENT_ENGINES,
  acceptEngine,
  acceptZippBytes,
  bundleLanguages,
  documentEngines,
  readyEngines,
  requireBundleLanguages,
  requireEngineLanguages,
  servableEngines,
  zippIdentities,
} from '../src/engineInit.ts';

/** An install's SOURCE.json as the shell reads it: the engine, and its web variant. */
const SOURCE = {
  version: '0.0.18',
  release: 'v0.0.18',
  sha256: 'a'.repeat(64),
  variants: { web: { sha256: 'b'.repeat(64), variant: 'javascript', languages: ['javascript'], stackBytes: 1048576 } },
};
const IDENTITIES = zippIdentities(SOURCE);

test('an init that names no engine gets the engine hosted apps have always run', () => {
  assert.equal(DEFAULT_ENGINE, 'zipp-web-python');
  assert.equal(acceptEngine(undefined, ZIPP_DOCUMENT_ENGINES), 'zipp-web-python');
  // A parent that has the field but leaves it empty is the same case.
  assert.equal(acceptEngine(null, ZIPP_DOCUMENT_ENGINES), 'zipp-web-python');
  assert.equal(acceptEngine('zipp-web-python', ZIPP_DOCUMENT_ENGINES), 'zipp-web-python');
  // The same document serves the JavaScript-only build, by name.
  assert.equal(acceptEngine('zipp-web', ZIPP_DOCUMENT_ENGINES), 'zipp-web');
  assert.deepEqual([...ZIPP_DOCUMENT_ENGINES], ['zipp-web-python', 'zipp-web']);
});

test('an engine this document does not serve is refused by name, not replaced', () => {
  assert.throws(() => acceptEngine('host-js', ZIPP_DOCUMENT_ENGINES), /does not run the "host-js" engine/);
  for (const id of ['zipp-web', 'zipp-web-python']) {
    assert.throws(() => acceptEngine(id, HOST_JS_DOCUMENT_ENGINES), new RegExp(`does not run the "${id}" engine`));
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

test('an engine whose profile does not run exactly what its id promises is refused', () => {
  requireEngineLanguages('zipp-web-python', ['javascript', 'python']);
  assert.throws(
    () => requireEngineLanguages('zipp-web-python', ['javascript']),
    /zipp-web-python engine must run python/
  );
  // An engine that could not be asked answers nothing, and nothing is refused.
  assert.throws(() => requireEngineLanguages('zipp-web-python', []), /must run javascript and python/);
  requireEngineLanguages('zipp-web', ['javascript']);
  requireEngineLanguages('host-js', []);
  // Exactly: the Python build posted under the JavaScript-only name is refused
  // too, naming the language the smaller engine was chosen not to have. Order
  // does not matter; the set does.
  assert.throws(
    () => requireEngineLanguages('zipp-web', ['javascript', 'python']),
    /The zipp-web engine runs javascript only, and the supplied engine also runs python/
  );
  assert.throws(() => requireEngineLanguages('zipp-web', ['python']), /zipp-web engine must run javascript/);
  assert.throws(() => requireEngineLanguages('zipp-web', []), /zipp-web engine must run javascript/);
  assert.throws(() => requireEngineLanguages('zipp-web-python', ['python', 'javascript', 'lua']), /also runs lua/);
  requireEngineLanguages('zipp-web-python', ['python', 'javascript']);
});

test('ready announces exactly the engines this document accepts in init', () => {
  for (const document of DOCUMENT_ENGINE_LISTS) {
    const served = servableEngines(document, IDENTITIES);
    assert.deepEqual([...served], [...document], 'with the variant installed, every engine of the document is servable');
    const announced = readyEngines(served, IDENTITIES);
    assert.deepEqual(Object.keys(announced), [...served]);
    for (const id of served) assert.equal(acceptEngine(id, served), id, `${id} is accepted in init`);
  }
  // A ZIPP engine is announced with the bytes it wants — the install's identity
  // for the engine, the same record with the variant's digest for the variant;
  // host JavaScript wants none, and says so rather than naming an engine it
  // will not load.
  assert.deepEqual(readyEngines(ZIPP_DOCUMENT_ENGINES, IDENTITIES), {
    'zipp-web-python': { version: '0.0.18', sha256: 'a'.repeat(64), release: 'v0.0.18' },
    'zipp-web': { version: '0.0.18', sha256: 'b'.repeat(64), release: 'v0.0.18' },
  });
  assert.deepEqual(readyEngines(HOST_JS_DOCUMENT_ENGINES, IDENTITIES), { 'host-js': true });
});

test('the identities come from the install, and an install without the variant neither announces nor accepts zipp-web', () => {
  assert.deepEqual(IDENTITIES, {
    'zipp-web-python': { version: '0.0.18', sha256: 'a'.repeat(64), release: 'v0.0.18' },
    'zipp-web': { version: '0.0.18', sha256: 'b'.repeat(64), release: 'v0.0.18' },
  });
  // A local engine build records no release and no variant.
  const local = zippIdentities({ version: '0.0.18', sha256: 'c'.repeat(64) });
  assert.deepEqual(local, { 'zipp-web-python': { version: '0.0.18', sha256: 'c'.repeat(64), release: undefined } });
  assert.equal(Object.hasOwn(local, 'zipp-web'), false);
  // A variant record without a digest names nothing the parent could send.
  assert.equal(Object.hasOwn(zippIdentities({ ...SOURCE, variants: { web: {} } }), 'zipp-web'), false);
  // One filter reduces both lists, so the document cannot invite what it would refuse.
  const served = servableEngines(ZIPP_DOCUMENT_ENGINES, local);
  assert.deepEqual([...served], ['zipp-web-python']);
  assert.deepEqual(readyEngines(served, local), { 'zipp-web-python': local['zipp-web-python'] });
  assert.throws(() => acceptEngine('zipp-web', served), /does not run the "zipp-web" engine/);
  // Even asked to announce the whole document list, nothing without an identity is named.
  assert.deepEqual(Object.keys(readyEngines(ZIPP_DOCUMENT_ENGINES, local)), ['zipp-web-python']);
  // Host JavaScript needs no identity and is never filtered.
  assert.deepEqual([...servableEngines(HOST_JS_DOCUMENT_ENGINES, {})], ['host-js']);
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
  assert.deepEqual([...RUNTIME_ENGINES], ['host-js', 'zipp-web', 'zipp-web-python']);
  // Every document a build serves is one FormLogic has to know how to mount,
  // which is what the protocol number in softn-release.json says.
  assert.equal(HOSTED_ENGINES_PROTOCOL, 1);
  assert.ok(Number.isInteger(HOSTED_ENGINES_PROTOCOL));
});

test('a bundle’s logic languages come from its client file names, and nothing else', () => {
  assert.equal(PYTHON_LOGIC_SUFFIX, '.py');
  // The app every hosted app has been until now: no .py, so JavaScript.
  assert.deepEqual(bundleLanguages(['manifest.json', 'app.softn', 'app.logic']), ['javascript']);
  assert.deepEqual(bundleLanguages([]), ['javascript']);
  // One .py anywhere in the client files is the declaration, wherever it is
  // and whether or not the manifest lists it. JavaScript stays in the list:
  // the markup and its template expressions are evaluated on this side.
  assert.deepEqual(bundleLanguages(['manifest.json', 'app.softn', 'app.py']), ['javascript', 'python']);
  assert.deepEqual(bundleLanguages(['lib/helpers.py']), ['javascript', 'python']);
  assert.deepEqual(bundleLanguages(['app.PY']), ['javascript', 'python'], 'the name is not case-sensitive');
  assert.deepEqual(bundleLanguages(['a.logic', 'b.py', 'c.logic']), ['javascript', 'python']);
  // A name that merely contains the letters is not a Python file.
  assert.deepEqual(bundleLanguages(['pyramid.logic', 'py', 'app.python', 'a.py.logic']), ['javascript']);
  // Nothing inside the bundle is consulted: a manifest that claims Python and
  // a logic file that is Python are not the same claim, and only the second
  // is one this reads.
  assert.deepEqual(bundleLanguages(['manifest.json']), ['javascript']);
});

test('an engine that cannot run this app’s logic is refused by name, before anything is configured', () => {
  // The one engine that runs Python is the one hosted apps already run on.
  requireBundleLanguages('zipp-web-python', ['javascript', 'python']);
  requireBundleLanguages('zipp-web-python', ['javascript']);
  // Neither of the others can execute Python at all: zipp-web is ZIPP's
  // JavaScript-only build and host-js is the document's own JavaScript.
  assert.throws(
    () => requireBundleLanguages('zipp-web', ['javascript', 'python']),
    /written in python, and the zipp-web engine does not run that language/
  );
  assert.throws(
    () => requireBundleLanguages('host-js', ['javascript', 'python']),
    /written in python, and the host-js engine does not run that language/
  );
  // Both still run every JavaScript app they always did.
  requireBundleLanguages('zipp-web', ['javascript']);
  requireBundleLanguages('host-js', ['javascript']);
  // The two maps say different things on purpose: what a loaded engine must
  // REPORT before its bytes are believed, and what it can RUN. host-js has no
  // profile to report and runs JavaScript; reading the first where the second
  // is meant would let a Python app onto it.
  assert.deepEqual([...ENGINE_LANGUAGES['host-js']], ['javascript']);
  for (const id of RUNTIME_ENGINES) assert.ok(ENGINE_LANGUAGES[id], `${id} says what it runs`);
  // Every engine the shell knows of, including one no document serves yet.
  assert.deepEqual(Object.keys(ENGINE_LANGUAGES).sort(), ['host-js', 'zipp-web', 'zipp-web-python']);
});

test('the refusal happens for the languages the file names actually declare', () => {
  // The two halves joined up: a .py in the client files, on each engine.
  const python = bundleLanguages(['manifest.json', 'app.softn', 'app.py']);
  const javascript = bundleLanguages(['manifest.json', 'app.softn', 'app.logic']);
  for (const id of ['zipp-web', 'host-js']) {
    assert.throws(() => requireBundleLanguages(id, python), new RegExp(`the ${id} engine does not run`));
    requireBundleLanguages(id, javascript);
  }
  requireBundleLanguages('zipp-web-python', python);
  requireBundleLanguages('zipp-web-python', javascript);
});

test('the shell refuses the engine before it configures one, and routes native fetch by the same list', () => {
  const main = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/main.tsx'),
    'utf8'
  );
  const derived = main.indexOf('bundleLanguages(');
  const refused = main.indexOf('requireBundleLanguages(');
  assert.ok(derived > 0 && refused > derived, 'the languages are derived, then the engine is held to them');
  // Configuring an engine is a one-way door: `configureLogicEngine` and
  // `configureZippWasmSource` both freeze. A refusal after either of them
  // would be a refusal that came too late to mean anything.
  for (const configure of ['installHostJsEngine()', 'configureZippWasmSource(']) {
    const at = main.indexOf(configure);
    assert.ok(at > 0, configure);
    assert.ok(refused < at, `${configure} is reached only after the refusal`);
  }
  // From the client file names the parent sent, not from the manifest inside
  // the bundle — the manifest is the app talking about itself.
  assert.match(main, /bundleLanguages\(files\.keys\(\)\)/);
  assert.ok(main.indexOf('bundleLanguages(') < main.indexOf('JSON.parse(files.get(\'manifest.json\')'));
  // The native network route is chosen from the same list, and a JavaScript
  // app still has the bridge prepended to its entry file, exactly as before.
  assert.match(main, /nativeFetchRoute\(languages\)/);
  assert.match(main, /files\.set\(entry, NATIVE_FETCH_BRIDGE \+ \(files\.get\(entry\) \|\| ''\)\)/);
  // The engines are named by the install's SOURCE.json, once, and the one
  // filtered list is what `init` is checked against and what `ready` announces;
  // `ready.zipp` stays the engine's own identity, so an older parent sees what
  // it always saw.
  assert.match(main, /const identities = zippIdentities\(zippSource\)/);
  assert.match(main, /const served = servableEngines\(documentEngines\(/);
  assert.match(main, /zipp: identities\['zipp-web-python'\], engines: readyEngines\(served, identities\)/);
  assert.ok(!/'zipp-web'/.test(main), 'the shell names no engine id of its own; they all flow from engineInit');
});

test('the runtime says which optional capabilities it has, and how to read an app’s languages', () => {
  // The manifest's `features` is this list; the packager reads it from here.
  assert.deepEqual([...RUNTIME_FEATURES], ['python-logic/1']);
  assert.ok(RUNTIME_FEATURES.every((f) => /^[a-z][a-z0-9-]*\/\d+$/.test(f)), 'named and versioned');
  assert.equal(LOGIC_LANGUAGES_PROTOCOL, 1);
  assert.ok(Number.isInteger(LOGIC_LANGUAGES_PROTOCOL));
});
