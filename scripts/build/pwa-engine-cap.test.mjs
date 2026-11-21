/**
 * Studio and Builder precache the torch package with their editing tools.
 * Keep its release payload under both caps. The generated service workers'
 * separate policy for the full engine is checked by the build-graph tests.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { root } from '../release/release-packages.mjs';

const EDITOR_CONFIGS = ['apps/softn-builder/vite.config.ts', 'apps/softn-studio/vite.config.ts'];
const TORCH = 'packages/@softn/core/wasm-zipp-torch/zipp_torch.wasm';

/** The cap a config sets: a byte count written as a product of integers (`8 * 1024 * 1024`). */
function precacheCap(text, file) {
  const caps = [...text.matchAll(/maximumFileSizeToCacheInBytes:\s*([0-9_\s*]+?)\s*,/g)];
  assert.equal(caps.length, 1, `${file} sets maximumFileSizeToCacheInBytes once, as a product of integers`);
  return caps[0][1].split('*').reduce((product, factor) => product * Number(factor.replaceAll('_', '').trim()), 1);
}

test('the cap reader reads what the configs write', () => {
  assert.equal(precacheCap('workbox: { maximumFileSizeToCacheInBytes: 8 * 1024 * 1024, runtimeCaching: [] }', 'x'), 8388608);
  assert.equal(precacheCap('maximumFileSizeToCacheInBytes: 12_000_000,\n', 'x'), 12000000);
  assert.throws(() => precacheCap('maximumFileSizeToCacheInBytes: SIZE,', 'x'));
});

test('the torch package fits the offline install in both editors', () => {
  const size = fs.statSync(path.join(root, TORCH)).size;
  for (const file of EDITOR_CONFIGS) {
    const cap = precacheCap(fs.readFileSync(path.join(root, file), 'utf8'), file);
    assert.ok(size <= cap, `${TORCH} is ${size} bytes, above the ${cap}-byte precache cap in ${file}`);
  }
});

test('the runtime leaves torch to apps that use it', () => {
  // The runtime resolves it as ./core-runtime/zipp_torch.wasm from core's chunk
  // (packages/@softn/core/src/runtime/zipp-wasm-loader.ts), through a variable
  // so Vite does not emit a hashed copy under assets/ for the glob to sweep.
  const loader = fs.readFileSync(path.join(root, 'packages/@softn/core/src/runtime/zipp-wasm-loader.ts'), 'utf8');
  assert.match(loader, /const TORCH_WASM_PATH = '\.\/core-runtime\/zipp_torch\.wasm';/);
  assert.match(loader, /new URL\(TORCH_WASM_PATH, import\.meta\.url\)/);
  assert.doesNotMatch(loader, /new URL\(\s*['"`][^'"`]*zipp_torch\.wasm['"`]/, 'a literal URL would be emitted into assets/ and precached');
  const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
  assert.match(read('apps/softn-web/vite.config.ts'), /globIgnores:[^\]]*'\*\*\/core-runtime\/\*\*'/s, 'softn-web leaves assets/core-runtime/ out of the precache');
});
