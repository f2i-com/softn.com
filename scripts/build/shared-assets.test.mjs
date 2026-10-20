/**
 * The site keeps the engine and the QR decoder once, under /shared/assets/,
 * rather than once per app; a build without SOFTN_SHARED_ASSETS is unchanged.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SHARED_ASSET, collectSharedAssets, sharedAssetsBase, sharedPrecacheUrl } from './shared-assets.mjs';

function site(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'softn-shared-assets-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

test('names the engine and the QR decoder, and nothing else', () => {
  assert.ok(SHARED_ASSET.test('zipp_wasm_bg-CqW-oDNC.wasm'));
  assert.ok(SHARED_ASSET.test('zxing_reader-EOacYbLr.wasm'));
  assert.ok(!SHARED_ASSET.test('index-D1Cq8NzU.js'));
  assert.ok(!SHARED_ASSET.test('zipp_torch.wasm'));
});

test('is off unless the site build asks, and takes only an absolute folder', () => {
  assert.equal(sharedAssetsBase({}), null);
  assert.equal(sharedAssetsBase({ SOFTN_SHARED_ASSETS: '/shared/assets/' }), '/shared/assets/');
  assert.throws(() => sharedAssetsBase({ SOFTN_SHARED_ASSETS: 'shared/assets' }), /absolute path/);
  assert.equal(sharedPrecacheUrl('assets/zipp_wasm_bg-CqW-oDNC.wasm', null), 'assets/zipp_wasm_bg-CqW-oDNC.wasm');
  assert.equal(sharedPrecacheUrl('assets/zipp_wasm_bg-CqW-oDNC.wasm', '/shared/assets/'), '/shared/assets/zipp_wasm_bg-CqW-oDNC.wasm');
  assert.equal(sharedPrecacheUrl('assets/index-D1Cq8NzU.js', '/shared/assets/'), 'assets/index-D1Cq8NzU.js');
});

test('keeps one copy of each shared file and removes the apps\' own', (t) => {
  const out = site(t);
  for (const app of ['web', 'studio']) {
    write(path.join(out, app, 'assets', 'zipp_wasm_bg-AAAAAAAA.wasm'), 'engine');
    write(path.join(out, app, 'assets', 'index-BBBBBBBB.js'), 'fetch(new URL("/shared/assets/zipp_wasm_bg-AAAAAAAA.wasm", import.meta.url))');
  }
  assert.deepEqual(collectSharedAssets(out, ['web', 'studio', 'builder'], '/shared/assets/'), ['zipp_wasm_bg-AAAAAAAA.wasm']);
  assert.equal(fs.readFileSync(path.join(out, 'shared', 'assets', 'zipp_wasm_bg-AAAAAAAA.wasm'), 'utf8'), 'engine');
  for (const app of ['web', 'studio']) assert.equal(fs.existsSync(path.join(out, app, 'assets', 'zipp_wasm_bg-AAAAAAAA.wasm')), false);
});

test('refuses two different files under one name, and an app that names a shared file by its own path', (t) => {
  const out = site(t);
  write(path.join(out, 'web', 'assets', 'zipp_wasm_bg-AAAAAAAA.wasm'), 'engine');
  write(path.join(out, 'studio', 'assets', 'zipp_wasm_bg-AAAAAAAA.wasm'), 'another engine');
  assert.throws(() => collectSharedAssets(out, ['web', 'studio'], '/shared/assets/'), /differs/);

  const out2 = site(t);
  write(path.join(out2, 'web', 'assets', 'zipp_wasm_bg-AAAAAAAA.wasm'), 'engine');
  write(path.join(out2, 'web', 'assets', 'index-BBBBBBBB.js'), 'new URL("zipp_wasm_bg-AAAAAAAA.wasm", import.meta.url)');
  assert.throws(() => collectSharedAssets(out2, ['web'], '/shared/assets/'), /by its own path/);
});
