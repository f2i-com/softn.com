/**
 * The PWAs precache the ZIPP engine so a bundle runs offline, and Workbox
 * skips any file over maximumFileSizeToCacheInBytes without failing the build
 * (apps/softn-web/vite.config.ts says so beside its glob). ZIPP's release
 * engine is not run through wasm-opt here; 0.0.27's javascript-python-base
 * module, bindings included, is about 6.1 MiB under today's 8 MiB caps, so a larger release has to raise the caps
 * first, or every PWA silently loses its engine offline.
 *
 * The torch package (zipp_torch.wasm, about 2 MiB) is deliberately NOT in
 * softn-web's precache: the runtime fetches it from assets/core-runtime/ —
 * which its globIgnores leaves out — only for an app that declares torch.
 * Studio and the Builder install everything they ship, torch included, so an
 * installed editor works offline with every feature.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { root } from './release-packages.mjs';

const CONFIGS = ['apps/softn-web/vite.config.ts', 'apps/softn-builder/vite.config.ts', 'apps/softn-studio/vite.config.ts'];
const ENGINE = 'packages/@softn/core/wasm-zipp/zipp_wasm_bg.wasm';

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

test('the ZIPP engine fits under the smallest Workbox precache cap of every PWA', () => {
  const caps = CONFIGS.map((file) => ({ file, cap: precacheCap(fs.readFileSync(path.join(root, file), 'utf8'), file) }));
  for (const { file, cap } of caps) assert.ok(Number.isSafeInteger(cap) && cap > 0, `${file}: ${cap}`);
  const smallest = caps.reduce((a, b) => (b.cap < a.cap ? b : a));
  const size = fs.statSync(path.join(root, ENGINE)).size;
  assert.ok(
    size < smallest.cap,
    `${ENGINE} is ${size} bytes, not under the ${smallest.cap}-byte precache cap in ${smallest.file}. ` +
      `Raise maximumFileSizeToCacheInBytes in ${CONFIGS.join(', ')}; Workbox would otherwise leave the engine out of the offline cache without an error.`
  );
});

test('the torch package stays out of the runtime\'s startup precache, and is in the editors\' complete install', () => {
  // The runtime resolves it as ./core-runtime/zipp_torch.wasm from core's chunk
  // (packages/@softn/core/src/runtime/zipp-wasm-loader.ts), through a variable
  // so Vite does not emit a hashed copy under assets/ for the glob to sweep.
  const loader = fs.readFileSync(path.join(root, 'packages/@softn/core/src/runtime/zipp-wasm-loader.ts'), 'utf8');
  assert.match(loader, /const TORCH_WASM_PATH = '\.\/core-runtime\/zipp_torch\.wasm';/);
  assert.match(loader, /new URL\(TORCH_WASM_PATH, import\.meta\.url\)/);
  assert.doesNotMatch(loader, /new URL\(\s*['"`][^'"`]*zipp_torch\.wasm['"`]/, 'a literal URL would be emitted into assets/ and precached');
  const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
  assert.match(read('apps/softn-web/vite.config.ts'), /globIgnores:[^\]]*'\*\*\/core-runtime\/\*\*'/s, 'softn-web leaves assets/core-runtime/ out of the precache');
  for (const file of ['apps/softn-builder/vite.config.ts', 'apps/softn-studio/vite.config.ts']) {
    assert.match(read(file), /globIgnores:\s*\[\]/, `${file} installs everything it ships`);
  }
});
