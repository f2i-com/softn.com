// node --test apps/formlogic-host/test/policy.test.mjs
// (Node 24 runs the TypeScript modules directly; they use only erasable syntax.)
//
// The two entry documents and the one thing that differs between them. A meta
// Content-Security-Policy can be tightened after it is written but never
// relaxed, so `host-js` — which compiles the author's `.logic` with this
// document's own engine — cannot be a flag on `index.html`. It is a second
// document, and the only difference between the two policies is the token that
// lets that engine exist.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { framePolicy } from '../src/framePolicy.ts';
import { HOST_JS_DOCUMENT_ENGINES, ZIPP_DOCUMENT_ENGINES, documentEngines } from '../src/engineInit.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.join(here, '..');
const ASSETS = 'https://runtime.example/hosted-runtime/';

/**
 * The policy `index.html` has carried since the hosted runtime shipped, as one
 * literal. It is written out rather than built, because the point of the test
 * is that nothing about serving a second engine changed it: a diff here is a
 * change to what every hosted app has always been allowed to do.
 */
const ZIPP_POLICY =
  `default-src 'none'; script-src ${ASSETS} 'wasm-unsafe-eval'; connect-src ${ASSETS}; ` +
  `style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; ` +
  `worker-src blob:; form-action 'none'; base-uri 'none'; frame-src 'none'`;

test('the ZIPP document keeps the policy it has always had, byte for byte', () => {
  assert.equal(framePolicy(ASSETS, ZIPP_DOCUMENT_ENGINES), ZIPP_POLICY);
  // A document whose attribute this build does not understand serves no engine
  // at all, and gets the strict policy rather than a guess.
  assert.equal(framePolicy(ASSETS, []), ZIPP_POLICY);
  assert.equal(framePolicy(ASSETS, documentEngines(null)), ZIPP_POLICY);
  // `'wasm-unsafe-eval'` is not `'unsafe-eval'`: it allows compiling WebAssembly
  // and nothing else, and the ZIPP document has always had it.
  assert.ok(!ZIPP_POLICY.includes("'unsafe-eval'"));
  assert.ok(ZIPP_POLICY.includes("'wasm-unsafe-eval'"));
});

test('the host-JavaScript document differs by exactly one unsafe-eval token', () => {
  const host = framePolicy(ASSETS, HOST_JS_DOCUMENT_ENGINES);
  assert.notEqual(host, ZIPP_POLICY);
  assert.equal(host.replace(" 'unsafe-eval'", ''), ZIPP_POLICY, 'one token is the whole difference');
  assert.equal([...host.matchAll(/'unsafe-eval'/g)].length, 1, 'it appears once');
  // And in script-src, not somewhere a reader would not look for it.
  const directives = Object.fromEntries(host.split('; ').map((d) => [d.split(' ')[0], d]));
  assert.ok(directives['script-src'].includes("'unsafe-eval'"));
  for (const [name, directive] of Object.entries(directives)) {
    if (name !== 'script-src') assert.ok(!directive.includes("'unsafe-eval'"), name);
  }
  assert.equal(framePolicy(ASSETS, documentEngines('host-js')), host);
});

test('host.html is index.html with one attribute, and nothing else', () => {
  const index = fs.readFileSync(path.join(app, 'index.html'), 'utf8');
  const host = fs.readFileSync(path.join(app, 'host.html'), 'utf8');
  assert.equal(host.replace(' data-softn-logic-engine="host-js"', ''), index);
  // Both documents run the same shell; the attribute is all it reads to tell
  // which one it is in.
  assert.ok(index.includes('<script type="module" src="/src/main.tsx"></script>'));
  assert.ok(host.includes('<script type="module" src="/src/main.tsx"></script>'));
});

test('host JavaScript is turned on in the host entry, and only there', () => {
  const entry = fs.readFileSync(path.join(app, 'src/hostEngine.ts'), 'utf8');
  const configured = entry.indexOf('configureLogicEngine(');
  assert.ok(configured > 0, 'the host entry is what configures the engine');
  // Both checks, and both BEFORE the engine is configured: the document has to
  // be the one that serves host JavaScript, and the frame has to be the opaque
  // origin the shell is only safe in.
  for (const guard of ["!== HOST_JS_DOCUMENT", "self.origin !== 'null'"]) {
    const at = entry.indexOf(guard);
    assert.ok(at > 0, guard);
    assert.ok(at < configured, `${guard} is checked before the engine is configured`);
  }
  // They are here and not in the adapter's constructor: the core suite drives
  // that adapter in a page that is neither sandboxed nor this document, and a
  // guard the engine carried would be one the engine could be asked to skip.
  const adapter = fs.readFileSync(
    path.join(app, '../../packages/@softn/core/src/runtime/host-js/host-js-adapter.ts'),
    'utf8'
  );
  assert.ok(!adapter.includes('self.origin'), 'the adapter does not check the frame it is in');
  assert.ok(!adapter.includes('data-softn-logic-engine'), 'nor which document it is in');

  // And the shell reaches the entry only on demand, so the ZIPP document never
  // loads the chunk the engine is in (scripts/host-js-isolation.test.mjs).
  const main = fs.readFileSync(path.join(app, 'src/main.tsx'), 'utf8');
  assert.match(main, /await import\('\.\/hostEngine'\)/);
  assert.ok(!/^import .* from '\.\/hostEngine'/m.test(main), 'never statically');
});

test('the shell decides the document before it writes the policy', () => {
  const main = fs.readFileSync(path.join(app, 'src/main.tsx'), 'utf8');
  const attribute = main.indexOf('data-softn-logic-engine');
  const written = main.indexOf('policy.content');
  assert.ok(attribute > 0 && written > attribute, 'the attribute is read before the policy is written');
  // The relaxed policy belongs to the document, not to a message: nothing the
  // parent sends may reach `framePolicy`.
  assert.ok(!/framePolicy\([^)]*event\.data/.test(main));
});
