/**
 * Studio and the Builder install completely and load lazily. Installing one
 * (its service worker's precache) takes everything it ships, so an installed
 * editor works offline with every feature: the charts, the editors, Scene3D
 * with Three.js and its loaders, the QR decoder, the workers' files. A page
 * still loads each feature the first time it draws one, as the runtimes do:
 * the editor's entry reaches none of them statically. Read from each editor's
 * own build, when there is one.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const HEAVY = /three|scene3d|gltf|fbx|stl|postprocessing|zxing/i;
/** A built file's name without the hash Vite gives it, which can spell anything. */
const unhashed = (file) => file.replace(/-[\w-]{8}(\.[a-z0-9]+)$/i, '$1');

function precache(dist) {
  const line = fs.readFileSync(path.join(dist, 'sw.js'), 'utf8').split('\n').find((text) => text.startsWith('self.__SOFTN_PRECACHE='));
  return JSON.parse(line.slice('self.__SOFTN_PRECACHE='.length).replace(/;\s*$/, ''));
}

function shipped(dist) {
  const files = [];
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
      else files.push(rel);
    }
  };
  walk(path.join(dist, 'assets'), 'assets');
  return files.filter((file) => /\.(js|css|wasm|woff2|svg|png)$/.test(file));
}

function staticClosure(manifest) {
  const seen = new Set();
  const queue = Object.entries(manifest).filter(([, chunk]) => chunk.isEntry).map(([key]) => key);
  while (queue.length) {
    const key = queue.shift();
    if (seen.has(key) || !manifest[key]) continue;
    seen.add(key);
    queue.push(...(manifest[key].imports ?? []));
  }
  return [...seen].map((key) => ({ key, file: manifest[key].file }));
}

for (const app of ['softn-studio', 'softn-builder']) {
  const dist = path.join(root, 'apps', app, 'dist');
  const manifestPath = path.join(dist, '.vite', 'manifest.json');
  const built = fs.existsSync(manifestPath) && fs.existsSync(path.join(dist, 'sw.js'));

  test(`${app} installs everything it ships`, { skip: !built && `build apps/${app} first` }, () => {
    const entries = precache(dist);
    const urls = new Set(entries.map((entry) => entry.url));
    assert.deepEqual(shipped(dist).filter((file) => !urls.has(file)), []);
    for (const wanted of [/^assets\/zipp_wasm_bg-[^/]+\.wasm$/, /^assets\/vendor-three-[^/]+\.js$/, /^assets\/scene3d-[^/]+\.js$/, /^assets\/zxing_reader-[^/]+\.wasm$/, /^assets\/core-runtime\/runtime\/script-worker\.js$/, /^assets\/core-runtime\/zipp_torch\.wasm$/]) {
      assert.ok([...urls].some((url) => wanted.test(url)), `${wanted} is installed`);
    }
    // The workers' files keep their names from build to build, so each carries a revision.
    for (const entry of entries.filter((e) => e.url.startsWith('assets/core-runtime/'))) {
      assert.match(entry.revision ?? '', /^[0-9a-f]{32}$/, entry.url);
    }
  });

  test(`${app} still loads Three.js and the features only through a dynamic import`, { skip: !built && `build apps/${app} first` }, () => {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const closure = staticClosure(manifest);
    assert.deepEqual(closure.filter(({ key, file }) => HEAVY.test(key) || HEAVY.test(unhashed(file))), []);
    const three = Object.entries(manifest).find(([, chunk]) => /^assets\/vendor-three-[^/]+\.js$/.test(chunk.file));
    assert.ok(three, 'Three.js is a chunk of its own');
    assert.ok(!closure.some(({ key }) => key === three[0]), 'the entry does not reach Three.js statically');
  });
}
