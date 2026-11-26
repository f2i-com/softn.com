/**
 * The site keeps what its builds emit once, under /shared/assets/, rather
 * than an assets/ folder for the site and one for each app; a build without
 * SOFTN_SHARED_ASSETS is unchanged.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SHARED_ASSET, collectSharedAssets, sharedAssetsBase, sharedNameOf, sharedPrecacheUrl, sharedRenderBuiltUrl, woff2OnlyFontsPlugin } from './shared-assets.mjs';

const BASE = '/shared/assets/';

function site(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'softn-shared-assets-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
/** Every file under `dir`, forward-slashed and sorted. */
function files(dir, prefix = '') {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => (entry.isDirectory() ? files(path.join(dir, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`]))
    .sort();
}
function withEnv(t, value) {
  const before = process.env.SOFTN_SHARED_ASSETS;
  if (value === undefined) delete process.env.SOFTN_SHARED_ASSETS;
  else process.env.SOFTN_SHARED_ASSETS = value;
  t.after(() => {
    if (before === undefined) delete process.env.SOFTN_SHARED_ASSETS;
    else process.env.SOFTN_SHARED_ASSETS = before;
  });
}

test('the engine and the QR decoder are named, for the site build to find them', () => {
  assert.ok(SHARED_ASSET.test('zipp_wasm_bg-CqW-oDNC.wasm'));
  assert.ok(SHARED_ASSET.test('zxing_reader-EOacYbLr.wasm'));
  assert.ok(!SHARED_ASSET.test('index-D1Cq8NzU.js'));
  assert.ok(!SHARED_ASSET.test('zipp_torch.wasm'));
});

test('is off unless the site build asks, and takes only an absolute folder', () => {
  assert.equal(sharedAssetsBase({}), null);
  assert.equal(sharedAssetsBase({ SOFTN_SHARED_ASSETS: BASE }), BASE);
  assert.throws(() => sharedAssetsBase({ SOFTN_SHARED_ASSETS: 'shared/assets' }), /absolute path/);
  assert.throws(() => sharedAssetsBase({ SOFTN_SHARED_ASSETS: '/shared/assets' }), /absolute path/);
});

test('a precache entry is the shared address of every built file, and the own address of anything else', () => {
  // Not the site's build: as written.
  for (const file of ['assets/zipp_wasm_bg-CqW-oDNC.wasm', 'assets/index-D1Cq8NzU.js', 'index.html']) assert.equal(sharedPrecacheUrl(file, null), file);
  // The site's: what Vite built, whatever it is, and core's workers beside the chunks.
  assert.equal(sharedPrecacheUrl('assets/zipp_wasm_bg-CqW-oDNC.wasm', BASE), '/shared/assets/zipp_wasm_bg-CqW-oDNC.wasm');
  assert.equal(sharedPrecacheUrl('assets/index-D1Cq8NzU.js', BASE), '/shared/assets/index-D1Cq8NzU.js');
  assert.equal(sharedPrecacheUrl('assets/index-CDGy2PAY.css', BASE), '/shared/assets/index-CDGy2PAY.css');
  assert.equal(sharedPrecacheUrl('assets/core-runtime/runtime/script-worker.js', BASE), '/shared/assets/core-runtime/runtime/script-worker.js');
  // What the app copied from public/, its page and its manifest stay the app's own.
  for (const file of ['index.html', 'favicon.svg', 'pwa-192x192.png', 'manifest.webmanifest', 'coi.js', 'assets/', 'other/assets/index-D1Cq8NzU.js']) {
    assert.equal(sharedPrecacheUrl(file, BASE), file, file);
  }
});

test('Vite is told the shared address of a built file wherever it is named, in the site build only', (t) => {
  withEnv(t, BASE);
  for (const hostType of ['js', 'css', 'html']) {
    assert.equal(sharedRenderBuiltUrl('assets/index-D1Cq8NzU.js', { type: 'asset', hostType }), '/shared/assets/index-D1Cq8NzU.js');
  }
  assert.equal(sharedRenderBuiltUrl('assets/ibm-plex-sans-latin-400-normal-CDDApCn2.woff2', { type: 'asset', hostType: 'css' }), '/shared/assets/ibm-plex-sans-latin-400-normal-CDDApCn2.woff2');
  // Called with a name alone, as it once was.
  assert.equal(sharedRenderBuiltUrl('assets/zipp_wasm_bg-CqW-oDNC.wasm'), '/shared/assets/zipp_wasm_bg-CqW-oDNC.wasm');
  // A file copied from public/ is the app's own, whatever its folder is called.
  assert.equal(sharedRenderBuiltUrl('favicon.svg', { type: 'public', hostType: 'html' }), undefined);
  assert.equal(sharedRenderBuiltUrl('assets/logo.svg', { type: 'public', hostType: 'html' }), undefined);
  assert.equal(sharedRenderBuiltUrl('registerSW.js', { type: 'asset', hostType: 'html' }), undefined);

  delete process.env.SOFTN_SHARED_ASSETS;
  assert.equal(sharedRenderBuiltUrl('assets/index-D1Cq8NzU.js', { type: 'asset', hostType: 'html' }), undefined);
});

test('the builds are gathered into one folder: one copy of each file, core’s workers with them, and no assets/ left behind', (t) => {
  const out = site(t);
  // The site's own build is at the root.
  write(path.join(out, 'index.html'), '<script type="module" src="/shared/assets/index-SITE0000.js"></script>');
  write(path.join(out, 'assets', 'index-SITE0000.js'), 'site');
  write(path.join(out, 'assets', 'ibm-plex-sans-latin-400-normal-CDDApCn2.woff2'), 'font');
  for (const app of ['web', 'studio']) {
    write(path.join(out, app, 'index.html'), `<script type="module" src="/shared/assets/index-${app}0000.js"></script>`);
    write(path.join(out, app, 'favicon.svg'), `<svg>${app}</svg>`);
    write(path.join(out, app, 'assets', `index-${app}0000.js`), `import "./react-DA3A6BO2.js"; fetch(new URL("/shared/assets/zipp_wasm_bg-AAAAAAAA.wasm", import.meta.url)) // ${app}`);
    write(path.join(out, app, 'assets', 'react-DA3A6BO2.js'), 'react');
    write(path.join(out, app, 'assets', 'zipp_wasm_bg-AAAAAAAA.wasm'), 'engine');
    write(path.join(out, app, 'assets', 'ibm-plex-sans-latin-400-normal-CDDApCn2.woff2'), 'font');
    write(path.join(out, app, 'assets', 'core-runtime', 'zipp_torch.wasm'), 'torch');
    write(path.join(out, app, 'assets', 'core-runtime', 'runtime', 'script-worker.js'), 'import "./chunk-ABCDEFGH.js";');
  }
  // 'builder' was not built: a folder that is not there is not an error here (the site build checks each build first).
  const kept = collectSharedAssets(out, ['', 'web', 'studio', 'builder'], BASE);
  assert.deepEqual(kept.names, [
    'core-runtime/runtime/script-worker.js',
    'core-runtime/zipp_torch.wasm',
    'ibm-plex-sans-latin-400-normal-CDDApCn2.woff2',
    'index-SITE0000.js',
    'index-studio0000.js',
    'index-web0000.js',
    'react-DA3A6BO2.js',
    'zipp_wasm_bg-AAAAAAAA.wasm',
  ]);
  // Two for the site, six for each app.
  assert.equal(kept.copies, 14);
  assert.deepEqual(files(path.join(out, 'shared', 'assets')), kept.names);
  assert.equal(fs.readFileSync(path.join(out, 'shared', 'assets', 'zipp_wasm_bg-AAAAAAAA.wasm'), 'utf8'), 'engine');
  assert.equal(fs.readFileSync(path.join(out, 'shared', 'assets', 'core-runtime', 'zipp_torch.wasm'), 'utf8'), 'torch');
  // Nothing built stays with a build; what it copied from public/ does.
  for (const app of ['', 'web', 'studio']) assert.equal(fs.existsSync(path.join(out, app, 'assets')), false, app || 'site');
  assert.deepEqual(files(path.join(out, 'web')), ['favicon.svg', 'index.html']);
});

test('two different files under one name stop the build, hashed or not', (t) => {
  const out = site(t);
  write(path.join(out, 'web', 'assets', 'zipp_wasm_bg-AAAAAAAA.wasm'), 'engine');
  write(path.join(out, 'studio', 'assets', 'zipp_wasm_bg-AAAAAAAA.wasm'), 'another engine');
  assert.throws(() => collectSharedAssets(out, ['web', 'studio'], BASE), /studio's assets\/zipp_wasm_bg-AAAAAAAA\.wasm differs from web's/);

  // Core's workers keep their names: two builds of core are two different files of one name.
  const out2 = site(t);
  write(path.join(out2, 'assets', 'index-SITE0000.js'), 'site');
  write(path.join(out2, 'web', 'assets', 'core-runtime', 'runtime', 'script-worker.js'), 'this core');
  write(path.join(out2, 'play', 'assets', 'core-runtime', 'runtime', 'script-worker.js'), 'another core');
  assert.throws(() => collectSharedAssets(out2, ['', 'web', 'play'], BASE), /play's assets\/core-runtime\/runtime\/script-worker\.js differs from web's/);

  // And a folder that already holds a file of that name is not written over.
  const out3 = site(t);
  write(path.join(out3, 'shared', 'assets', 'react-DA3A6BO2.js'), 'left from another build');
  write(path.join(out3, 'web', 'assets', 'react-DA3A6BO2.js'), 'react');
  assert.throws(() => collectSharedAssets(out3, ['web'], BASE), /\/shared\/assets\/react-DA3A6BO2\.js exists/);
});

test('a build that still names its own assets/ stops the build: its page, its service worker, or a script', (t) => {
  // An app's page.
  const page = site(t);
  write(path.join(page, 'web', 'index.html'), '<script type="module" src="/web/assets/index-BBBBBBBB.js"></script>');
  write(path.join(page, 'web', 'assets', 'index-BBBBBBBB.js'), 'app');
  assert.throws(() => collectSharedAssets(page, ['web'], BASE), /web\/index\.html names \/web\/assets\/; build web with SOFTN_SHARED_ASSETS=\/shared\/assets\//);

  // Its service worker's list.
  const worker = site(t);
  write(path.join(worker, 'studio', 'index.html'), '<script type="module" src="/shared/assets/index-BBBBBBBB.js"></script>');
  write(path.join(worker, 'studio', 'sw.js'), 'self.__SOFTN_PRECACHE=[{"url":"/studio/assets/index-BBBBBBBB.js","revision":null}]');
  write(path.join(worker, 'studio', 'assets', 'index-BBBBBBBB.js'), 'app');
  assert.throws(() => collectSharedAssets(worker, ['studio'], BASE), /studio\/sw\.js names \/studio\/assets\//);

  // A script's preload list.
  const script = site(t);
  write(path.join(script, 'builder', 'index.html'), '<script type="module" src="/shared/assets/index-BBBBBBBB.js"></script>');
  write(path.join(script, 'builder', 'assets', 'index-BBBBBBBB.js'), '__vite__mapDeps=["/builder/assets/scene3d-CCCCCCCC.js"]');
  assert.throws(() => collectSharedAssets(script, ['builder'], BASE), /\/shared\/assets\/index-BBBBBBBB\.js names \/builder\/assets\//);

  // The site's own page: its address is /assets/, which the shared one ends with and is not.
  const root = site(t);
  write(path.join(root, 'index.html'), '<link rel="stylesheet" href="/assets/index-CDGy2PAY.css"><script type="module" src="/shared/assets/index-SITE0000.js"></script>');
  write(path.join(root, 'assets', 'index-SITE0000.js'), 'site');
  assert.throws(() => collectSharedAssets(root, [''], BASE), /index\.html names \/assets\/; build the site with/);

  const fine = site(t);
  write(path.join(fine, 'index.html'), '<link rel="stylesheet" href="/shared/assets/index-CDGy2PAY.css"><script type="module" src="/shared/assets/index-SITE0000.js"></script>');
  write(path.join(fine, 'assets', 'index-SITE0000.js'), 'site');
  assert.deepEqual(collectSharedAssets(fine, [''], BASE).names, ['index-SITE0000.js']);
});

test('woff2OnlyFontsPlugin strips legacy .woff fallbacks from @fontsource stylesheets and leaves other CSS untouched', () => {
  const plugin = woff2OnlyFontsPlugin();
  const fontCss =
    "@font-face {\n  src: url(./files/ibm-plex-sans-latin-400-normal.woff2) format('woff2'), url(./files/ibm-plex-sans-latin-400-normal.woff) format('woff');\n}\n";
  const out = plugin.transform(fontCss, '/repo/node_modules/@fontsource/ibm-plex-sans/400.css?used');
  assert.ok(out);
  assert.equal(out.code, "@font-face {\n  src: url(./files/ibm-plex-sans-latin-400-normal.woff2) format('woff2');\n}\n");
  assert.equal(plugin.transform(fontCss, '/repo/apps/softn-site/src/index.css'), null);
});

test("sharedNameOf names a build's own chunk of a module, which a search of the shared names cannot tell from another app's", () => {
  // Two apps' chunks of @softn/container/mount, side by side in /shared/assets/: the first
  // by name is the runtime's facade, the play shell's is the other one.
  const shared = ['mount-CjpS-nPu.js', 'mount-D9vHx0Q2.js'];
  const play = {
    'index.html': { file: 'assets/index-DRcQWQoC.js', isEntry: true },
    '../../packages/@softn/container/dist/mount.js': { file: 'assets/mount-D9vHx0Q2.js', isDynamicEntry: true },
  };
  const mount = /(?:^|\/)container\/dist\/mount\.js$/;
  assert.equal(shared.find((name) => /^mount-/.test(name)), 'mount-CjpS-nPu.js');
  assert.equal(sharedNameOf(play, mount), 'mount-D9vHx0Q2.js');
  assert.equal(sharedNameOf({ 'index.html': { file: 'assets/index-DRcQWQoC.js' } }, mount), null);
  // Only a built file has a name in the shared folder.
  assert.equal(sharedNameOf({ '../../packages/@softn/container/dist/mount.js': { file: 'softn-page.js' } }, mount), null);
});
