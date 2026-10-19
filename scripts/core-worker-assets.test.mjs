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
    'runtime/model-worker.js': Buffer.from('export const local = true;'),
    'runtime/models/kernels.wasm': Buffer.from([0, 97, 115, 109, 0, 255, 254]),
    'runtime/models/gguf_wasm_bg.wasm': Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]),
    'runtime/models/ZIPP-gpu-lab-LICENSE.txt': Buffer.from('Apache License 2.0'),
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
    assert.ok(source.indexOf('coreWorkerAssetPlugin(),') < source.indexOf('softnPwa({'), name);
    // The list may span lines; what matters is that the runtime folder is in it.
    const ignores = source.indexOf('globIgnores:');
    assert.ok(ignores >= 0, name);
    const block = source.slice(ignores, source.indexOf(']', ignores));
    assert.ok(block.includes("'**/core-runtime/**'"), name);
  }
});

test('production copies nested worker, WASM and licences byte-for-byte for each app', t => {
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

test('production leaves source maps behind; development still serves them', t => {
  const { temp, core } = fixture(t);
  fs.writeFileSync(path.join(core, 'runtime', 'model-worker.js.map'), '{}');
  const output = path.join(temp, 'maps');
  coreWorkerAssetPlugin({ coreDistRoot: core }).writeBundle({ dir: output });
  assert.equal(fs.existsSync(path.join(output, 'assets', 'core-runtime', 'runtime', 'model-worker.js')), true);
  assert.equal(fs.existsSync(path.join(output, 'assets', 'core-runtime', 'runtime', 'model-worker.js.map')), false);
  const plugin = coreWorkerAssetPlugin({ coreDistRoot: core });
  let middleware;
  plugin.configureServer({ middlewares: { use(fn) { middleware = fn; } } });
  let status = 0;
  middleware({ url: '/assets/core-runtime/runtime/model-worker.js.map' }, { set statusCode(value) { status = value; }, setHeader() {}, end() {} }, () => {});
  assert.equal(status, 200);
});

test('production omits the core dist mirror while retaining the worker dependency tree', t => {
  const { temp, core, files } = fixture(t);
  fs.mkdirSync(path.join(core, 'core-runtime', 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(core, 'core-runtime', 'runtime', 'unused-copy.js'), 'duplicate');
  const output = path.join(temp, 'hosted-runtime');
  coreWorkerAssetPlugin({ coreDistRoot: core }).writeBundle({ dir: output });
  const destination = path.join(output, 'assets', 'core-runtime');
  assert.equal(fs.existsSync(path.join(destination, 'core-runtime')), false);
  for (const [relative, bytes] of Object.entries(files)) {
    assert.deepEqual(fs.readFileSync(path.join(destination, relative)), bytes);
  }
});
