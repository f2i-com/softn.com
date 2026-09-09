import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { coreWorkerAssetPlugin } from './core-worker-assets.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'softn-worker-assets-'));
  t.after(() => {
    assert.equal(path.dirname(temp), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temp).startsWith('softn-worker-assets-'));
    fs.rmSync(temp, { recursive: true, force: true });
  });
  const core = path.join(temp, 'core');
  const files = {
    'runtime/neural-speech-worker.js': Buffer.from('export const local = true;'),
    'runtime/speech/ort/ort-wasm-simd-threaded.mjs': Buffer.from('export default {};'),
    'runtime/speech/ort/ort-wasm-simd-threaded.wasm': Buffer.from([0, 97, 115, 109, 0, 255, 254]),
    'runtime/speech/voices/af_heart.bin': Buffer.from([0, 255, 0, 254]),
    'runtime/speech/NOTICE.txt': Buffer.from('Local speech notices'),
  };
  for (const [name, bytes] of Object.entries(files)) {
    const target = path.join(core, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  }
  return { temp, core, files };
}

test('every browser runtime consumer registers assets before its PWA and excludes optional downloads', () => {
  for (const name of ['web', 'builder', 'studio']) {
    const source = fs.readFileSync(path.join(root, `apps/softn-${name}/vite.config.ts`), 'utf8');
    assert.ok(source.includes("from '../../scripts/core-worker-assets.mjs'"), name);
    assert.ok(source.indexOf('coreWorkerAssetPlugin(),') < source.indexOf('VitePWA({'), name);
    // The list may span lines; what matters is that the runtime folder is in it.
    const ignores = source.indexOf('globIgnores:');
    assert.ok(ignores >= 0, name);
    const block = source.slice(ignores, source.indexOf(']', ignores));
    assert.ok(block.includes("'**/core-runtime/**'"), name);
  }
});

test('production copies nested worker, WASM, voices and notices byte-for-byte for each app', t => {
  const { temp, core, files } = fixture(t);
  for (const name of ['web', 'builder', 'studio']) {
    const plugin = coreWorkerAssetPlugin({ coreDistRoot: core });
    const output = path.join(temp, name);
    plugin.configResolved({ root: temp, build: { outDir: name } });
    plugin.writeBundle({});
    for (const [relative, bytes] of Object.entries(files)) assert.deepEqual(fs.readFileSync(path.join(output, 'assets/core-runtime', relative)), bytes);
  }
});

test('development serves modules and binary data, preserving subpath prefixes and blocking fallback/traversal', t => {
  const { core, files } = fixture(t);
  const plugin = coreWorkerAssetPlugin({ coreDistRoot: core });
  let middleware;
  plugin.configureServer({ middlewares: { use(fn) { middleware = fn; } } });
  function request(url) {
    const result = { statusCode: 0, headers: {}, body: null, next: false };
    middleware({ url }, { set statusCode(value) { result.statusCode = value; }, setHeader(name, value) { result.headers[name] = value; }, end(body) { result.body = body; } }, () => { result.next = true; });
    return result;
  }
  for (const [relative, bytes] of Object.entries(files)) {
    const result = request('/studio/assets/core-runtime/' + relative + '?v=1');
    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.body, bytes);
    const type = result.headers['Content-Type'];
    if (relative.endsWith('.js') || relative.endsWith('.mjs')) assert.match(type, /^application\/javascript/);
    else if (relative.endsWith('.wasm')) assert.equal(type, 'application/wasm');
    else if (relative.endsWith('.bin')) assert.equal(type, 'application/octet-stream');
  }
  for (const relative of ['missing.js', '../outside', '%2e%2e/outside', '%2fetc/passwd', 'runtime%5c..%5coutside', '%zz']) {
    const result = request('/builder/assets/core-runtime/' + relative);
    assert.equal(result.statusCode, 404, relative);
    assert.equal(result.next, false, relative);
  }
  assert.equal(request('/builder/not-an-asset').next, true);
});

test('production refuses missing core assets instead of shipping a broken capability', t => {
  const { temp } = fixture(t);
  const plugin = coreWorkerAssetPlugin({ coreDistRoot: path.join(temp, 'missing') });
  assert.throws(() => plugin.writeBundle({ dir: path.join(temp, 'output') }), /Build @softn\/core/);
});
