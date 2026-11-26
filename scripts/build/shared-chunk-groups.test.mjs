/**
 * The libraries every app bundles come out of each app's build as one file
 * (on-demand-chunks.mjs, sharedChunkGroups), which the site keeps once in
 * /shared/assets/. That holds only while every app splits by the same groups,
 * the groups take the packages they are meant to and nothing else, and the
 * ones a feature reaches stay out of the runtime's precache.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { globToRegExp } from './pwa.mjs';
import {
  onDemandGlobIgnores,
  sharedChunkGroups,
  vendorQrScannerGroup,
  vendorReactGroup,
  vendorSyncGroup,
  vendorThreeGroup,
} from './on-demand-chunks.mjs';
import { repoRoot } from '../lib/paths.mjs';

const SITE_APPS = ['softn-web', 'softn-builder', 'softn-studio', 'softn-single', 'softn-site'];

test('every app the site serves splits its chunks by the shared groups', () => {
  for (const app of SITE_APPS) {
    const config = fs.readFileSync(path.join(repoRoot, 'apps', app, 'vite.config.ts'), 'utf8');
    assert.match(config, /import \{[^}]*\bsharedChunkGroups\b[^}]*\} from '\.\.\/\.\.\/scripts\/build\/on-demand-chunks\.mjs'/, app);
    assert.match(config, /groups: sharedChunkGroups\b/, app);
  }
  assert.deepEqual(sharedChunkGroups, [vendorThreeGroup, vendorReactGroup, vendorSyncGroup, vendorQrScannerGroup]);
});

test('each group takes its own packages, with either path separator, and no others', () => {
  const ids = (names) => names.flatMap((name) => [`E:/repo/node_modules/${name}`, `E:\\repo\\node_modules\\${name.replaceAll('/', '\\')}`]);
  const cases = [
    [vendorReactGroup, ['react/index.js', 'react/jsx-runtime.js', 'react-dom/client.js', 'react-dom/cjs/react-dom.production.min.js', 'scheduler/index.js'],
      ['react-dnd/dist/index.js', 'react-dnd-html5-backend/dist/index.js', '@yudiel/react-qr-scanner/dist/index.esm.mjs', 'use-sync-external-store/index.js', 'zustand/esm/index.mjs']],
    [vendorSyncGroup, ['yjs/dist/yjs.mjs', 'lib0/encoding.js', 'y-protocols/awareness.js', 'y-webrtc/src/y-webrtc.js', 'y-indexeddb/src/y-indexeddb.js', 'simple-peer/simplepeer.min.js'],
      ['react/index.js', 'idb/build/index.js', 'yaml/dist/index.js']],
    [vendorQrScannerGroup, ['@yudiel/react-qr-scanner/dist/index.esm.mjs', 'barcode-detector/dist/es/ponyfill.js', 'webrtc-adapter/src/js/adapter_core.js', 'sdp/sdp.js', 'zxing-wasm/dist/reader/index.js'],
      ['@rc-component/qrcode/lib/index.js', 'react-dom/client.js', 'three/build/three.module.js']],
  ];
  for (const [group, taken, left] of cases) {
    for (const id of ids(taken)) assert.equal(group.test.test(id), true, `${group.name} leaves ${id}`);
    for (const id of ids(left)) assert.equal(group.test.test(id), false, `${group.name} takes ${id}`);
  }
  // React before the libraries that import it, or a group would take React with them.
  assert.ok(vendorReactGroup.priority > vendorSyncGroup.priority && vendorReactGroup.priority > vendorQrScannerGroup.priority);
});

test("the sync and scanner libraries stay out of the runtime's precache; React is part of the shell", () => {
  const ignored = (file) => onDemandGlobIgnores.some((glob) => globToRegExp(glob).test(file));
  assert.equal(ignored('assets/vendor-sync-Ab12Cd34.js'), true);
  assert.equal(ignored('assets/vendor-qr-scanner-Ab12Cd34.js'), true);
  assert.equal(ignored('assets/vendor-react-Ab12Cd34.js'), false);
});

test("the play shell imports react-dom's own entry, as the apps whose React chunk it shares do", () => {
  const main = fs.readFileSync(path.join(repoRoot, 'apps/softn-single/src/main.tsx'), 'utf8');
  assert.match(main, /^import 'react-dom';$/m);
});
