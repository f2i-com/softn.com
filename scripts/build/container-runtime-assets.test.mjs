/**
 * What a SoftN app serves for @softn/container, and where: the files core does not already
 * have, in a folder named by their digest, once per app or once for the whole site.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  CONTAINER_RUNTIME_ENV,
  containerRuntimeAssetPlugin,
  containerRuntimeDigest,
  copyHostedRuntime,
  hostedRuntimeFiles,
  isHostedRuntimeFile,
  placeSharedContainerRuntime,
  sharedContainerPrecache,
  sharedContainerRuntimeBase,
} from './container-runtime-assets.mjs';
import { onDemandRuntimeCaching } from './on-demand-chunks.mjs';
import { precacheEntries } from './pwa.mjs';
import { repoRoot as root } from '../lib/paths.mjs';

const WASM = (tail) => Buffer.from([0, 97, 115, 109, 1, 0, 0, 0, tail]);

// The package's dist/runtime/ as its build leaves it: the drop-in's entry and chunks, the
// Worker, every engine with its bindings, twins and maps, and the vendor modules.
const RUNTIME = {
  'softn.js': Buffer.from('export const dropIn = true;'),
  'softn.js.map': Buffer.from('{}'),
  'chunk-EMPE36JR.js': Buffer.from('export const chunk = true;'),
  'worker-runtime-I4CH3MDX.js': Buffer.from('export const inline = true;'),
  'container-worker.js': Buffer.from('self.onmessage = () => {};'),
  'container-worker.js.map': Buffer.from('{}'),
  'engines/zipp-javascript-lite.wasm': WASM(1),
  'engines/zipp-javascript-lite.wasm.br': Buffer.from('br'),
  'engines/zipp-javascript-lite.glue.js': Buffer.from('export default 1;'),
  'engines/zipp-javascript.wasm': WASM(2),
  'engines/zipp-javascript.glue.js': Buffer.from('export default 2;'),
  'engines/zipp-typescript.wasm': WASM(3),
  'engines/zipp-typescript.glue.js': Buffer.from('export default 3;'),
  'engines/zipp-python-base.wasm': WASM(4),
  'engines/zipp-python-base.wasm.br': Buffer.from('br'),
  'engines/zipp-python-base.glue.js': Buffer.from('export default 4;'),
  'engines/zipp-torch.wasm': WASM(5),
  'engines/zipp-torch.wasm.br': Buffer.from('br'),
  'vendor/three.js': Buffer.from('export const REVISION = "170";'),
};

const HOSTED = [
  'container-worker.js',
  'engines/zipp-javascript-lite.glue.js',
  'engines/zipp-javascript-lite.wasm',
  'engines/zipp-python-base.glue.js',
  'engines/zipp-typescript.glue.js',
  'engines/zipp-typescript.wasm',
];

function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'softn-container-assets-'));
  t.after(() => {
    assert.equal(path.dirname(temp), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temp).startsWith('softn-container-assets-'));
    fs.rmSync(temp, { recursive: true, force: true });
  });
  const runtime = path.join(temp, 'runtime');
  for (const [name, bytes] of Object.entries(RUNTIME)) {
    const target = path.join(runtime, ...name.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  }
  return { temp, runtime };
}

function walk(dir, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out.sort();
}

test('a host serves the Worker, the two engines core cannot stand in for and the bindings of each engine that runs', (t) => {
  const { runtime } = fixture(t);
  assert.deepEqual(hostedRuntimeFiles(runtime), HOSTED);
  // Core's own engine and torch package, under the drop-in's names: the same bytes twice.
  assert.equal(isHostedRuntimeFile('engines/zipp-python-base.wasm'), false);
  assert.equal(isHostedRuntimeFile('engines/zipp-torch.wasm'), false);
  // The JavaScript-only build of core's engine: the `javascript` tier runs core's, under core's bindings.
  assert.equal(isHostedRuntimeFile('engines/zipp-javascript.wasm'), false);
  assert.equal(isHostedRuntimeFile('engines/zipp-javascript.glue.js'), false);
  // Core's engine's bindings stay: the Worker imports them for whichever tier that engine runs.
  assert.equal(isHostedRuntimeFile('engines/zipp-python-base.glue.js'), true);
  // Three.js: the app bundles its own for its 3D components and hands it to the container.
  assert.equal(isHostedRuntimeFile('vendor/three.js'), false);
  assert.equal(isHostedRuntimeFile('vendor/marked.js'), true);
  // The drop-in's entry and chunks are compiled into the app, and never asked for.
  for (const name of ['softn.js', 'chunk-EMPE36JR.js', 'worker-runtime-I4CH3MDX.js']) assert.equal(isHostedRuntimeFile(name), false, name);
  for (const name of ['container-worker.js.map', 'engines/zipp-javascript-lite.wasm.br', 'vendor/three.js.gz']) assert.equal(isHostedRuntimeFile(name), false, name);
});

test('the real package, when built, hosts no engine that core ships', { skip: !fs.existsSync(path.join(root, 'packages/@softn/container/dist/runtime/container-worker.js')) && 'build @softn/container first' }, () => {
  const files = hostedRuntimeFiles();
  assert.ok(files.includes('container-worker.js'));
  assert.ok(files.includes('engines/zipp-javascript-lite.wasm'));
  assert.deepEqual(files.filter((name) => name.endsWith('.wasm')), ['engines/zipp-javascript-lite.wasm', 'engines/zipp-typescript.wasm']);
  // Each engine the folder holds, and the one core supplies, has its bindings beside it.
  for (const tier of ['javascript-lite', 'typescript', 'python-base']) assert.ok(files.includes(`engines/zipp-${tier}.glue.js`), tier);
  // No engine in the folder is one core installs under another name: its engine, that
  // engine's JavaScript-only build, or its torch package.
  const core = path.join(root, 'packages/@softn/core');
  const sameBytes = (a, b) => fs.existsSync(a) && fs.existsSync(b) && fs.readFileSync(a).equals(fs.readFileSync(b));
  const runtime = path.join(root, 'packages/@softn/container/dist/runtime');
  for (const file of files.filter((name) => name.endsWith('.wasm'))) {
    for (const [what, coreFile] of [['engine', 'wasm-zipp/zipp_wasm_bg.wasm'], ['JavaScript-only engine', 'wasm-zipp-web/zipp_wasm_bg.wasm'], ['torch package', 'wasm-zipp-torch/zipp_torch.wasm']]) {
      assert.equal(sameBytes(path.join(runtime, file), path.join(core, ...coreFile.split('/'))), false, `${file} is core's ${what}`);
    }
  }
});

test('the digest changes with any hosted file and with the set of them, and with nothing else', (t) => {
  const { runtime } = fixture(t);
  const first = containerRuntimeDigest(runtime);
  assert.match(first, /^[0-9a-f]{12}$/);
  assert.equal(containerRuntimeDigest(runtime), first);
  // What is not hosted does not move it: core's engine, a map, the drop-in's entry.
  fs.writeFileSync(path.join(runtime, 'engines', 'zipp-python-base.wasm'), WASM(9));
  fs.writeFileSync(path.join(runtime, 'container-worker.js.map'), '{"v":2}');
  fs.writeFileSync(path.join(runtime, 'softn.js'), 'export const dropIn = 2;');
  assert.equal(containerRuntimeDigest(runtime), first);
  // One byte of an engine does, and so do its bindings, and so does a new file.
  fs.writeFileSync(path.join(runtime, 'engines', 'zipp-javascript-lite.wasm'), WASM(8));
  const second = containerRuntimeDigest(runtime);
  assert.notEqual(second, first);
  fs.writeFileSync(path.join(runtime, 'engines', 'zipp-javascript-lite.glue.js'), 'export default 9;');
  const third = containerRuntimeDigest(runtime);
  assert.notEqual(third, second);
  fs.writeFileSync(path.join(runtime, 'vendor', 'marked.js'), 'export const marked = 1;');
  assert.notEqual(containerRuntimeDigest(runtime), third);
});

test('a build of an app alone names its own folder by the digest and writes exactly the hosted files there', (t) => {
  const { temp, runtime } = fixture(t);
  const plugin = containerRuntimeAssetPlugin({ runtimeDistRoot: runtime, env: {} });
  const digest = containerRuntimeDigest(runtime);
  const config = plugin.config({}, { command: 'build' });
  assert.deepEqual(config, { define: { [`import.meta.env.${CONTAINER_RUNTIME_ENV}`]: JSON.stringify(`assets/container-runtime/${digest}/`) } });
  plugin.configResolved({ root: temp, build: { outDir: 'app' } });
  // A folder a previous build named does not stay beside this one's.
  const stale = path.join(temp, 'app', 'assets', 'container-runtime', '000000000000');
  fs.mkdirSync(stale, { recursive: true });
  fs.writeFileSync(path.join(stale, 'container-worker.js'), 'old');
  plugin.writeBundle({});
  const own = path.join(temp, 'app', 'assets', 'container-runtime');
  assert.deepEqual(fs.readdirSync(own), [digest]);
  assert.deepEqual(walk(path.join(own, digest)), HOSTED);
  for (const name of HOSTED) assert.deepEqual(fs.readFileSync(path.join(own, digest, ...name.split('/'))), RUNTIME[name], name);
});

test('the dev server is told nothing and serves the package’s files from the bare folder', (t) => {
  const { runtime } = fixture(t);
  const plugin = containerRuntimeAssetPlugin({ runtimeDistRoot: runtime, env: {} });
  assert.equal(plugin.config({}, { command: 'serve' }), undefined);
  let middleware;
  plugin.configureServer({ middlewares: { use(fn) { middleware = fn; } } });
  function request(url) {
    const result = { statusCode: 0, headers: {}, body: null, next: false };
    middleware({ url, headers: {} }, { set statusCode(value) { result.statusCode = value; }, setHeader(name, value) { result.headers[name] = value; }, end(body) { result.body = body; } }, () => { result.next = true; });
    return result;
  }
  const worker = request('/studio/assets/container-runtime/container-worker.js?v=1');
  assert.equal(worker.statusCode, 200);
  assert.deepEqual(worker.body, RUNTIME['container-worker.js']);
  assert.match(worker.headers['Content-Type'], /^application\/javascript/);
  assert.equal(request('/assets/container-runtime/engines/zipp-typescript.wasm').headers['Content-Type'], 'application/wasm');
  for (const relative of ['missing.js', '../outside', '%2e%2e/outside', '%2fetc/passwd', 'engines%5c..%5coutside', '%zz']) {
    const result = request('/builder/assets/container-runtime/' + relative);
    assert.equal(result.statusCode, 404, relative);
    assert.equal(result.next, false, relative);
  }
  assert.equal(request('/builder/not-an-asset').next, true);
});

test('in the site build an app names the shared folder and keeps none of its own', (t) => {
  const { temp, runtime } = fixture(t);
  const env = { SOFTN_SHARED_CONTAINER_RUNTIME: '/shared/container-runtime/' };
  const plugin = containerRuntimeAssetPlugin({ runtimeDistRoot: runtime, env });
  const digest = containerRuntimeDigest(runtime);
  assert.deepEqual(plugin.config({}, { command: 'build' }), {
    define: { [`import.meta.env.${CONTAINER_RUNTIME_ENV}`]: JSON.stringify(`/shared/container-runtime/${digest}/`) },
  });
  plugin.configResolved({ root: temp, build: { outDir: 'web' } });
  plugin.writeBundle({});
  assert.equal(fs.existsSync(path.join(temp, 'web', 'assets', 'container-runtime')), false);
  // What an app that installs everything precaches: the shared folder's files, by address.
  assert.deepEqual(sharedContainerPrecache(env, runtime), HOSTED.map((name) => ({ url: `/shared/container-runtime/${digest}/${name}`, revision: null })));
  assert.deepEqual(sharedContainerPrecache({}, runtime), []);
  assert.equal(sharedContainerRuntimeBase({}), null);
  for (const bad of ['shared/container-runtime/', '/shared/container-runtime', 'https://cdn.example/x/', '/a b/']) {
    assert.throws(() => sharedContainerRuntimeBase({ SOFTN_SHARED_CONTAINER_RUNTIME: bad }), /absolute path ending in "\/"/, bad);
  }
});

test('the site keeps one folder, and refuses an app that would ask elsewhere', (t) => {
  const { temp, runtime } = fixture(t);
  const digest = containerRuntimeDigest(runtime);
  const base = '/shared/container-runtime/';
  const site = path.join(temp, 'dist');
  const app = (name, script) => {
    fs.mkdirSync(path.join(site, name, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(site, name, 'assets', 'index-abc12345.js'), script);
  };
  app('web', `const folder="${base}${digest}/";`);
  app('studio', `const folder="${base}${digest}/";`);
  const placed = placeSharedContainerRuntime(site, ['web', 'studio'], base, runtime);
  assert.equal(placed.digest, digest);
  assert.equal(placed.url, `${base}${digest}/`);
  assert.deepEqual(placed.files, HOSTED);
  assert.deepEqual(walk(path.join(site, 'shared', 'container-runtime')), HOSTED.map((name) => `${digest}/${name}`));

  // Built without the variable: it kept its own folder, and names it.
  app('builder', 'const folder="assets/container-runtime/";');
  fs.mkdirSync(path.join(site, 'builder', 'assets', 'container-runtime', digest), { recursive: true });
  assert.throws(() => placeSharedContainerRuntime(site, ['web', 'builder'], base, runtime), /builder\/assets\/container-runtime\/ exists/);
  // Built against another build of the container: it names a folder that is not written.
  app('play', `const folder="${base}000000000000/";`);
  assert.throws(() => placeSharedContainerRuntime(site, ['web', 'play'], base, runtime), /No script of play names \/shared\/container-runtime\//);
});

test('a build with no container to copy stops, rather than ship an app that cannot run one', (t) => {
  const { temp } = fixture(t);
  const missing = path.join(temp, 'missing');
  assert.throws(() => containerRuntimeAssetPlugin({ runtimeDistRoot: missing, env: {} }).config({}, { command: 'build' }), /Build @softn\/container/);
  assert.throws(() => copyHostedRuntime(path.join(temp, 'out'), missing), /Build @softn\/container/);
});

test('the service worker keeps the folder’s files by the digest in their path, and installs the shared ones by address', (t) => {
  const { temp } = fixture(t);
  const route = onDemandRuntimeCaching.find((entry) => entry.options?.cacheName === 'softn-container-runtime');
  assert.ok(route, 'the runtime has a route for the container folder');
  assert.equal(route.handler, 'CacheFirst');
  for (const url of [
    '/web/assets/container-runtime/fbb4a0524cc8/container-worker.js',
    '/shared/container-runtime/fbb4a0524cc8/engines/zipp-javascript-lite.wasm',
    '/shared/container-runtime/fbb4a0524cc8/engines/zipp-typescript.glue.js',
    '/shared/container-runtime/fbb4a0524cc8/engines/zipp-python-base.glue.js',
  ]) assert.match(url, route.urlPattern, url);
  // Not a folder with no digest (the dev server's, which no worker controls), and not core's workers.
  for (const url of ['/web/assets/container-runtime/container-worker.js', '/web/assets/core-runtime/runtime/script-worker.js']) assert.doesNotMatch(url, route.urlPattern, url);
  // Core's workers keep their route, which the container's files no longer share.
  const workers = onDemandRuntimeCaching.find((entry) => entry.options?.cacheName === 'softn-worker-assets');
  assert.match('/web/assets/core-runtime/runtime/script-worker.js', workers.urlPattern);
  assert.doesNotMatch('/shared/container-runtime/fbb4a0524cc8/container-worker.js', workers.urlPattern);

  // An app's precache takes the shared entries as given, ahead of its own files.
  const out = path.join(temp, 'studio');
  fs.mkdirSync(path.join(out, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html>');
  fs.writeFileSync(path.join(out, 'assets', 'index-abc12345.js'), 'export {};');
  const entries = precacheEntries(out, {
    globPatterns: ['**/*.{js,html,wasm}'],
    additionalManifestEntries: [{ url: '/shared/container-runtime/fbb4a0524cc8/container-worker.js', revision: null }],
  });
  assert.deepEqual(entries.map((entry) => entry.url), ['/shared/container-runtime/fbb4a0524cc8/container-worker.js', 'assets/index-abc12345.js', 'index.html']);
  assert.equal(entries[0].revision, null);
});

test('every app that mounts a container asks the host options for its folder and engines, and builds with the plugin', () => {
  // One place names the folder and hands over core's engine (runtime-shell/containerHost.ts).
  // A mount that named the folder itself would ask a path the build no longer writes.
  for (const file of [
    'packages/@softn/runtime-shell/src/WebContainerView.tsx',
    'apps/softn-studio/src/components/canvas/VisualCanvas.tsx',
    'apps/softn-studio/src/lib/agent/appCheck.ts',
    'apps/softn-builder/src/components/preview/ContainerPreviewRuntime.tsx',
  ]) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.ok(source.includes('hostedContainerOptions()'), `${file} mounts with hostedContainerOptions()`);
    assert.ok(!/assets\/container-runtime/.test(source), `${file} names the folder itself`);
  }
  for (const app of ['web', 'studio', 'builder', 'single', 'single-private']) {
    const source = fs.readFileSync(path.join(root, `apps/softn-${app}/vite.config.ts`), 'utf8');
    assert.ok(source.includes('containerRuntimeAssetPlugin()'), app);
  }
  // The editors install everything they ship: in the site build that includes the shared folder.
  for (const app of ['studio', 'builder']) {
    const source = fs.readFileSync(path.join(root, `apps/softn-${app}/vite.config.ts`), 'utf8');
    assert.ok(source.includes('sharedContainerPrecache()'), app);
  }
});
