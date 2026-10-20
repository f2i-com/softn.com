/**
 * Studio and the Builder load components as the runtimes do: the minimal set
 * with the shell, every other feature — Three.js and its addons, the charts,
 * the editors, the QR decoder — the first time a page draws it
 * (scripts/on-demand-chunks.mjs). Read from each editor's own build, when
 * there is one: its precache holds none of them, its entry reaches none of
 * them statically, and Three.js is a chunk only a dynamic import reaches.
 * softn-web's build-graph test holds the runtime to the same policy.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { onDemandGlobIgnores } from './on-demand-chunks.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const HEAVY = /three|scene3d|gltf|fbx|stl|postprocessing|zxing/i;
/** A built file's name without the hash Vite gives it, which can spell anything. */
const unhashed = (file) => file.replace(/-[\w-]{8}(\.[a-z0-9]+)$/i, '$1');

/** A glob of the precache's ignores as a test for one file under assets/. */
const ignored = onDemandGlobIgnores.map((glob) => new RegExp(`^${glob.replace(/^\*\*\//, '').replace(/[.]/g, '\\.').replace(/\*/g, '[^/]*')}$`));

function precache(dist) {
  const line = fs.readFileSync(path.join(dist, 'sw.js'), 'utf8').split('\n').find((text) => text.startsWith('self.__SOFTN_PRECACHE='));
  return JSON.parse(line.slice('self.__SOFTN_PRECACHE='.length).replace(/;\s*$/, '')).map((entry) => entry.url);
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

  test(`${app} precaches no on-demand chunk`, { skip: !built && `build apps/${app} first` }, () => {
    const urls = precache(dist);
    assert.ok(urls.some((url) => /^assets\/zipp_wasm_bg-[^/]+\.wasm$/.test(url)), 'the engine is in the shell');
    assert.deepEqual(urls.filter((url) => ignored.some((pattern) => pattern.test(url))), []);
    assert.deepEqual(urls.filter((url) => HEAVY.test(unhashed(url))), []);
  });

  test(`${app} reaches Three.js and the features only through a dynamic import`, { skip: !built && `build apps/${app} first` }, () => {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const closure = staticClosure(manifest);
    assert.deepEqual(closure.filter(({ key, file }) => HEAVY.test(key) || HEAVY.test(unhashed(file))), []);
    const three = Object.entries(manifest).find(([, chunk]) => /^assets\/vendor-three-[^/]+\.js$/.test(chunk.file));
    assert.ok(three, 'Three.js is a chunk of its own');
    assert.ok(!closure.some(({ key }) => key === three[0]), 'the entry does not reach Three.js statically');
  });
}
