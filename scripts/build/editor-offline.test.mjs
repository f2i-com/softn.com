/**
 * Studio and Builder install their editor tools and lite previews. A project
 * that first needs the full engine downloads it to a separate cache. A page
 * still loads each feature the first time it draws one, as the runtimes do:
 * the editor's entry reaches none of them statically. Read from each editor's
 * own build, when there is one.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { repoRoot as root } from '../lib/paths.mjs';

const HEAVY = /three|scene3d|gltf|fbx|stl|postprocessing|zxing/i;
/** Where the site build keeps what its apps built (scripts/build/build-site.mjs). */
const SITE_SHARED = '/shared/assets/';
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
  // Site builds put worker entry points inside the editor's own service-worker scope.
  if (fs.existsSync(path.join(dist, 'workers'))) walk(path.join(dist, 'workers'), 'workers');
  return files.filter((file) => /\.(js|css|wasm|woff2|svg|png)$/.test(file));
}

function staticClosure(manifest, roots = Object.keys(manifest).filter((key) => manifest[key].isEntry)) {
  const seen = new Set();
  const queue = [...roots];
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

  test(`${app} installs its offline tools and lite runtime and caches the full engine on demand`, { skip: !built && `build apps/${app} first` }, () => {
    // Built for the site, what the app built is installed from the site's one
    // folder of built files (shared-assets.mjs): the same files the app ships,
    // each at its shared address.
    const entries = precache(dist).map((entry) => ({ ...entry, url: entry.url.startsWith(SITE_SHARED) ? `assets/${entry.url.slice(SITE_SHARED.length)}` : entry.url }));
    const urls = new Set(entries.map((entry) => entry.url));
    const files = shipped(dist);
    const fullEngines = files.filter((file) => /^assets\/zipp_wasm_bg-[^/]+\.wasm$/.test(file));
    assert.equal(fullEngines.length, 1, 'the full engine is available to projects');
    const configLine = fs.readFileSync(path.join(dist, 'sw.js'), 'utf8').split('\n').find((line) => line.startsWith('self.__SOFTN_SW__='));
    const { routes, classicAssets, classicRevisions, sourceCompilers } = JSON.parse(configLine.slice('self.__SOFTN_SW__='.length).replace(/;\s*$/, ''));
    const classic = new Set(Object.values(classicAssets).flat().map((url) => url.replace(SITE_SHARED, 'assets/')));
    assert.ok(classicAssets.renderer.length > 0, 'classic previews load their renderer on demand');
    const compilers = new Set(Object.values(sourceCompilers).flat().map((url) => url.replace(SITE_SHARED, 'assets/')));
    assert.deepEqual([...compilers].filter(file => classic.has(file)), [], 'web compilers must not fetch classic-only assets');
    const graph = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    for (const format of ['jsx', 'vue']) {
      assert.ok(sourceCompilers[format].length > 0, format + ' compiler has an on-demand entry');
      const available = new Set([...urls, ...sourceCompilers[format].map(url => url.replace(SITE_SHARED, 'assets/'))]);
      const root = '../../packages/@softn/editor-shared/src/';
      for (const { file } of staticClosure(graph, [root + 'webSourceCompiler.ts', root + 'sourceCompilers/' + format + '.ts'])) {
        assert.ok(available.has(file), format + ' needs ' + file + ' after an offline reload');
      }
    }
    for (const file of compilers) assert.ok(!urls.has(file), file + ' was eagerly cached');
    assert.deepEqual(files.filter((file) => !urls.has(file)).sort(), [...new Set([...fullEngines, ...classic, ...compilers])].sort());
    for (const group of ['controls', 'feedback', 'navigation', 'charts', 'scene3d']) {
      assert.ok(classicAssets[group].some((url) => url.includes('/' + group + '-')), group);
    }
    const sharedWorker = [...urls].find((url) => /^\/shared\/container-runtime\/[0-9a-f]{12}\/container-worker\.js$/.test(url));
    if (sharedWorker) {
      const digest = sharedWorker.split('/').at(-2);
      assert.ok(urls.has(`container-worker-${digest}.js`), 'the preview worker starts inside the editor’s offline scope');
      for (const file of files.filter((file) => file.startsWith('workers/'))) {
        if (file.endsWith('-worker.js')) assert.ok(classic.has(file), file);
        else assert.ok(urls.has(file), file);
      }
    }
    const pathname = sharedWorker ? `/shared/${fullEngines[0]}` : `/${app}/${fullEngines[0]}`;
    const route = routes.find(({ pattern, flags }) => new RegExp(pattern, flags).test(pathname));
    assert.equal(route?.handler, 'CacheFirst', pathname);
    assert.equal(route.cacheName, 'softn-full-engine');
    for (const wanted of [/\/container-runtime\/[0-9a-f]{12}\/engines\/zipp-javascript-lite\.wasm$/, /^assets\/core-runtime\/zipp_torch\.wasm$/]) {
      assert.ok([...urls].some((url) => wanted.test(url)), `${wanted} is installed`);
    }
    const revisioned = new Set(Object.keys(classicRevisions).map((url) => url.replace(SITE_SHARED, 'assets/')));
    for (const name of ['script-worker.js', 'model-worker.js', 'sandbox-worker.js', 'models/kernels.wasm', 'models/gguf_wasm_bg.wasm']) {
      const file = 'assets/core-runtime/runtime/' + name;
      assert.ok(classic.has(file) && !urls.has(file), file + ' is downloaded with classic previews');
      assert.ok(revisioned.has(file), file + ' has a versioned cache key');
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
    // Shared core helpers can pull the renderer into an anonymous chunk even
    // when every named classic entry is dynamic. Check the emitted code too.
    for (const { file } of closure) {
      assert.ok(!fs.readFileSync(path.join(dist, file), 'utf8').includes('[SoftNRenderer]'), file + ' contains the classic renderer');
    }
    const three = Object.entries(manifest).find(([, chunk]) => /^assets\/vendor-three-[^/]+\.js$/.test(chunk.file));
    assert.ok(three, 'Three.js is a chunk of its own');
    assert.ok(!closure.some(({ key }) => key === three[0]), 'the entry does not reach Three.js statically');
  });
}
