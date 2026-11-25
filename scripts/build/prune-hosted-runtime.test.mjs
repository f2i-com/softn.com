import assert from 'node:assert/strict';
import test from 'node:test';
import {
  analyzeHostedAppNeeds,
  pruneHostedRuntimeEntries,
  shouldPruneWebrootAsset,
} from './prune-hosted-runtime.mjs';

const b = (s) => Buffer.from(s, 'utf8');

function sampleWebrootEntries() {
  return {
    'webroot/index.html': b('<!doctype html>'),
    'webroot/assets/index-AbCd1234.js': b('entry'),
    'webroot/assets/vendor-three-AbCd1234.js': b('three'.repeat(100)),
    'webroot/assets/scene3d-AbCd1234.js': b('scene3d'),
    'webroot/assets/GLTFLoader-AbCd1234.js': b('gltf'),
    'webroot/assets/OrbitControls-AbCd1234.js': b('orbit'),
    'webroot/assets/webgl-scene-host-AbCd1234.js': b('webgl-scene'),
    'webroot/assets/webgl-worker-host-AbCd1234.js': b('webgl-worker'),
    'webroot/assets/guest-webgl-AbCd1234.js': b('guest-webgl'),
    'webroot/assets/qr-reader-AbCd1234.js': b('qr-reader'),
    'webroot/assets/zxing_reader-AbCd1234.wasm': b('zxing-wasm'),
    'webroot/assets/zipp_wasm_bg-AbCd1234.wasm': b('full-zipp'),
    'webroot/assets/zipp_torch-AbCd1234.js': b('torch'),
    'webroot/assets/ai-manager-AbCd1234.js': b('ai'),
    'webroot/assets/xdb-sync-AbCd1234.js': b('sync'),
    'webroot/assets/UiApplicationSurface-AbCd1234.js': b('ui-surface'),
    'webroot/assets/charts-AbCd1234.js': b('charts'),
    'webroot/assets/media-AbCd1234.js': b('media'),
    'webroot/assets/core-runtime/runtime/script-worker.js': b('script-worker'),
    'webroot/assets/core-runtime/runtime/model-worker.js': b('model-worker'),
    'webroot/assets/core-runtime/wasm-zipp-torch/zipp_torch.wasm': b('torch-wasm'),
    'webroot/assets/container-runtime/0123456789ab/container-worker.js': b('worker'),
    'webroot/assets/container-runtime/0123456789ab/backend-worker.js': b('backend-worker'),
    'webroot/assets/container-runtime/0123456789ab/engines/zipp-javascript-lite.wasm': b('lite-wasm'),
    'webroot/assets/container-runtime/0123456789ab/engines/zipp-javascript-lite.glue.js': b('lite-glue'),
    'webroot/assets/container-runtime/0123456789ab/engines/zipp-typescript.wasm': b('ts-wasm'),
    'webroot/assets/container-runtime/0123456789ab/engines/zipp-typescript.glue.js': b('ts-glue'),
    'webroot/assets/container-runtime/0123456789ab/engines/zipp-python-base.glue.js': b('py-glue'),
    'webroot/assets/container-runtime/0123456789ab/engines/xdb-wasm.wasm': b('xdb-wasm'),
    'webroot/assets/container-runtime/0123456789ab/vendor/three.js': b('three-vendor'),
    'webroot/assets/container-runtime/0123456789ab/vendor/gltf-loader.js': b('gltf-vendor'),
    'webroot/assets/container-runtime/0123456789ab/worker-chunks/three-worker-host-AbCd1234.js': b('three-wh'),
    'webroot/assets/container-runtime/0123456789ab/worker-chunks/guest-three-native-AbCd1234.js': b('three-gn'),
    'webroot/assets/container-runtime/0123456789ab/worker-chunks/webgl-worker-host-AbCd1234.js': b('gl-wh'),
    'webroot/assets/container-runtime/0123456789ab/worker-chunks/guest-webgl-AbCd1234.js': b('gl-guest'),
    'webroot/assets/container-runtime/0123456789ab/worker-chunks/guest-indexeddb-AbCd1234.js': b('idb'),
    'webroot/assets/container-runtime/0123456789ab/worker-chunks/guest-react-vendor-AbCd1234.js': b('react'),
    'webroot/assets/container-runtime/0123456789ab/worker-chunks/jsx-transform-AbCd1234.js': b('jsx'),
    'webroot/assets/container-runtime/0123456789ab/worker-chunks/guest-worker-scope-AbCd1234.js': b('worker-scope'),
    'webroot/assets/container-runtime/0123456789ab/worker-chunks/guest-vendors-AbCd1234.js': b('vendors'),
  };
}

test('plain Container v2 app drops Three.js, WebGL, QR, Torch, AI, Classic UI, full ZIPP WASM, and unused worker-chunks', () => {
  const entries = sampleWebrootEntries();
  const manifest = { id: 'plain-web', name: 'Plain Web', main: 'index.html' };
  const clientFiles = {
    'manifest.json': b(JSON.stringify(manifest)),
    'index.html': b('<!doctype html><html><body><h1>Hello</h1><script src="app.js"></script></body></html>'),
    'app.js': b('document.querySelector("h1").textContent = "Ready";'),
  };
  const { removed, savedBytes, needs } = pruneHostedRuntimeEntries(entries, manifest, clientFiles);
  assert.equal(needs.usesThree, false);
  assert.equal(needs.usesWebgl, false);
  assert.equal(needs.usesQrScanner, false);
  assert.equal(needs.containerNeedsLiteEngine, true);
  assert.equal(needs.needsFullCoreWasm, false);
  assert.ok(savedBytes > 0);
  assert.ok(removed.length > 20);

  // Kept: entry, container-worker, lite engine + glue
  assert.ok(entries['webroot/index.html']);
  assert.ok(entries['webroot/assets/index-AbCd1234.js']);
  assert.ok(entries['webroot/assets/container-runtime/0123456789ab/container-worker.js']);
  assert.ok(entries['webroot/assets/container-runtime/0123456789ab/engines/zipp-javascript-lite.wasm']);
  assert.ok(entries['webroot/assets/container-runtime/0123456789ab/engines/zipp-javascript-lite.glue.js']);

  // Pruned: Three.js, QR, Torch, AI, Sync, Classic UI, TS engine, full ZIPP WASM, unused worker chunks
  for (const dropped of [
    'webroot/assets/vendor-three-AbCd1234.js',
    'webroot/assets/scene3d-AbCd1234.js',
    'webroot/assets/GLTFLoader-AbCd1234.js',
    'webroot/assets/qr-reader-AbCd1234.js',
    'webroot/assets/zxing_reader-AbCd1234.wasm',
    'webroot/assets/zipp_wasm_bg-AbCd1234.wasm',
    'webroot/assets/UiApplicationSurface-AbCd1234.js',
    'webroot/assets/core-runtime/runtime/script-worker.js',
    'webroot/assets/container-runtime/0123456789ab/vendor/three.js',
    'webroot/assets/container-runtime/0123456789ab/engines/zipp-typescript.wasm',
    'webroot/assets/container-runtime/0123456789ab/worker-chunks/guest-indexeddb-AbCd1234.js',
    'webroot/assets/container-runtime/0123456789ab/worker-chunks/guest-react-vendor-AbCd1234.js',
  ]) {
    assert.equal(entries[dropped], undefined, `expected ${dropped} to be pruned`);
  }
});

test('Container v2 Three.js + Intl app retains Three.js, WebGL, and full ZIPP WASM while still pruning QR/Torch/Classic UI', () => {
  const entries = sampleWebrootEntries();
  const manifest = { id: 'viewer-3d', name: '3D Viewer', main: 'index.html' };
  const clientFiles = {
    'manifest.json': b(JSON.stringify(manifest)),
    'index.html': b('<!doctype html><script type="module" src="main.js"></script>'),
    'main.js': b('import * as THREE from "three"; const fmt = new Intl.NumberFormat("en"); console.log(THREE, fmt);'),
  };
  pruneHostedRuntimeEntries(entries, manifest, clientFiles);

  // Kept: Three.js + WebGL + full core WASM + python-base glue
  assert.ok(entries['webroot/assets/vendor-three-AbCd1234.js']);
  assert.ok(entries['webroot/assets/container-runtime/0123456789ab/vendor/three.js']);
  assert.ok(entries['webroot/assets/container-runtime/0123456789ab/worker-chunks/three-worker-host-AbCd1234.js']);
  assert.ok(entries['webroot/assets/container-runtime/0123456789ab/worker-chunks/guest-webgl-AbCd1234.js']);
  assert.ok(entries['webroot/assets/zipp_wasm_bg-AbCd1234.wasm']);
  assert.ok(entries['webroot/assets/container-runtime/0123456789ab/engines/zipp-python-base.glue.js']);

  // Still pruned: lite engine, TS engine, QR scanner, Classic UI
  assert.equal(entries['webroot/assets/container-runtime/0123456789ab/engines/zipp-javascript-lite.wasm'], undefined);
  assert.equal(entries['webroot/assets/container-runtime/0123456789ab/engines/zipp-typescript.wasm'], undefined);
  assert.equal(entries['webroot/assets/zxing_reader-AbCd1234.wasm'], undefined);
  assert.equal(entries['webroot/assets/UiApplicationSurface-AbCd1234.js'], undefined);
});

test('Classic .ui app without Scene3D or QRReader drops container-runtime, Three.js, and zxing_reader while keeping Classic UI', () => {
  const entries = sampleWebrootEntries();
  const manifest = { id: 'classic-crm', name: 'CRM', main: 'ui/main.ui' };
  const clientFiles = {
    'manifest.json': b(JSON.stringify(manifest)),
    'ui/main.ui': b('<App><Heading>CRM</Heading><BarChart data={rows} /></App>'),
  };
  const needs = analyzeHostedAppNeeds(manifest, clientFiles);
  assert.equal(needs.hasUiPages, true);
  assert.equal(needs.hasHtmlPages, false);
  assert.equal(needs.classicFeatures.charts, true);
  assert.equal(needs.classicFeatures.media, false);

  pruneHostedRuntimeEntries(entries, manifest, clientFiles);
  assert.ok(entries['webroot/assets/UiApplicationSurface-AbCd1234.js']);
  assert.ok(entries['webroot/assets/charts-AbCd1234.js']);
  assert.ok(entries['webroot/assets/zipp_wasm_bg-AbCd1234.wasm']);
  assert.ok(entries['webroot/assets/core-runtime/runtime/script-worker.js']);

  assert.equal(entries['webroot/assets/vendor-three-AbCd1234.js'], undefined);
  assert.equal(entries['webroot/assets/zxing_reader-AbCd1234.wasm'], undefined);
  assert.equal(entries['webroot/assets/media-AbCd1234.js'], undefined);
  assert.equal(entries['webroot/assets/container-runtime/0123456789ab/container-worker.js'], undefined);
});

test('Classic .ui app using <Camera> keeps media chunk but still prunes QR scanner and zxing_reader.wasm', () => {
  const manifest = { id: 'cam-app', name: 'Cam', main: 'ui/main.ui' };
  const clientFiles = {
    'manifest.json': b(JSON.stringify(manifest)),
    'ui/main.ui': b('<App><Camera active={true} /></App>'),
  };
  const needs = analyzeHostedAppNeeds(manifest, clientFiles);
  assert.equal(needs.classicFeatures.media, true);
  assert.equal(needs.usesQrScanner, false);
  assert.equal(shouldPruneWebrootAsset('assets/media-AbCd1234.js', needs), false);
  assert.equal(shouldPruneWebrootAsset('assets/qr-reader-AbCd1234.js', needs), true);
  assert.equal(shouldPruneWebrootAsset('assets/zxing_reader-AbCd1234.wasm', needs), true);
});

test('HTML prose mentioning Intl does not drop lite engine, and remoteHostedBackend drops browser backend WASM', () => {
  const manifest = { id: 'php-app', name: 'PHP App', main: 'index.html', backend: { runtime: 'php' } };
  const clientFiles = {
    'manifest.json': b(JSON.stringify(manifest)),
    'index.html': b('<!doctype html><p>Built for Intl customers</p><script>document.title="ok";</script>'),
  };
  const needs = analyzeHostedAppNeeds(manifest, clientFiles, { remoteHostedBackend: true });
  assert.equal(needs.containerNeedsLiteEngine, true);
  assert.equal(needs.usesContainerSqlite, false);
  assert.equal(needs.usesBrowserPhpBackend, false);
  assert.equal(shouldPruneWebrootAsset('assets/container-runtime/0123456789ab/engines/zipp-javascript-lite.wasm', needs), false);
  assert.equal(shouldPruneWebrootAsset('assets/container-runtime/0123456789ab/engines/zipp-php.wasm', needs), true);
  assert.equal(shouldPruneWebrootAsset('assets/container-runtime/0123456789ab/engines/xdb-wasm.wasm', needs), true);
  assert.equal(shouldPruneWebrootAsset('assets/core-runtime/zipp_torch.wasm', needs), true);
  assert.equal(shouldPruneWebrootAsset('assets/core-runtime/runtime/models/gguf_wasm_bg.wasm', needs), true);
});

test('Vue SFC and programmatic softn-chart + QRReader decouple from media cleanly', () => {
  const vueNeeds = analyzeHostedAppNeeds({ id: 'v', name: 'V', main: 'index.html' }, {
    'index.html': b('<!doctype html><script type="module/ts" src="App.vue"></script>'),
    'App.vue': b('<script setup>import * as THREE from "three"; document.createElement("softn-chart");</script>'),
  });
  assert.equal(vueNeeds.usesThree, true);
  assert.equal(vueNeeds.usesContainerChart, true);
  assert.equal(vueNeeds.containerNeedsTypescriptEngine, true);

  const qrOnlyNeeds = analyzeHostedAppNeeds({ id: 'q', name: 'Q', main: 'ui/main.ui' }, {
    'ui/main.ui': b('<App><QRReader /></App>'),
  });
  assert.equal(qrOnlyNeeds.usesQrScanner, true);
  assert.equal(qrOnlyNeeds.classicFeatures.media, false);
  assert.equal(shouldPruneWebrootAsset('assets/qr-reader-AbCd1234.js', qrOnlyNeeds), false);
  assert.equal(shouldPruneWebrootAsset('assets/media-AbCd1234.js', qrOnlyNeeds), true);
});
