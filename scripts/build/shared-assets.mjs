/**
 * What the site's apps build, kept once: one folder of built files,
 * /shared/assets/, for the site and the four apps beside it, rather than an
 * assets/ folder in each.
 *
 * The site deploys five builds (the site at /, and /web/, /studio/, /builder/
 * and /play/), each built on its own. Everything Vite emits is named by a
 * hash of its contents, so the same file comes out of two builds under the
 * same name: the ZIPP engine (6.3 MB, and its .br and .gz) and the QR decoder
 * out of four, and so do Three.js and its loaders, React, the fonts (51 files
 * out of each of four builds) and some sixty more chunks. Core's workers and
 * the torch package (assets/core-runtime/, 2 MB with their twins) are copied
 * into each app whole. In copies that was a quarter of the archive, and a
 * visitor who opened a second app downloaded each of them again under the
 * second app's address.
 *
 * In the site build (SOFTN_SHARED_ASSETS, set by scripts/build/build-site.mjs)
 * every build refers to what it emits at /shared/assets/<name> instead: in its
 * page, its scripts and its stylesheets (renderBuiltUrl below) and in its
 * service worker's precache (pwa.mjs). collectSharedAssets() then moves each
 * build's assets/ into the one folder, checks that two files of one name are
 * the same file, and leaves no assets/ behind. A chunk imports its neighbours
 * by relative address and core finds its workers beside its own chunk
 * (./core-runtime/), so both follow the chunk to the shared folder with
 * nothing told; an app's service worker may precache and answer for a
 * same-origin file outside its scope.
 *
 * What a build copies from its public/ folder (icons, the manifest, the
 * service worker) is not built and stays where it is: those names are not
 * hashed, and two apps' favicon.svg are two files.
 *
 * Without the variable — an app built on its own, the desktop and single-app
 * hosts, FormLogic's editors — nothing changes: each build keeps its assets/.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** The folder Vite builds into, in every app here (its default `build.assetsDir`). */
const BUILT = 'assets/';

/** The engine and the QR reader's decoder, which the site build must find to share. */
export const SHARED_ASSET = /^(?:zipp_wasm_bg|zxing_reader)-[\w-]+\.wasm$/;

/** Where the site keeps what its builds emit, as an absolute path ending in `/`; null when the build is not the site's. */
export function sharedAssetsBase(env = process.env) {
  const base = env.SOFTN_SHARED_ASSETS;
  if (!base) return null;
  if (!/^\/(?:[\w-]+\/)+$/.test(base)) throw new Error(`SOFTN_SHARED_ASSETS must be an absolute path ending in "/", not "${base}"`);
  return base;
}

/** A built file's address in the shared folder, or null for a file that is not a built one. */
function sharedUrl(file, base) {
  return base && file.startsWith(BUILT) && file.length > BUILT.length ? base + file.slice(BUILT.length) : null;
}

/**
 * Vite's experimental.renderBuiltUrl: in the site build a built file by its
 * shared address, wherever it is named (a page, a script's preload list, a
 * stylesheet's `url()`, a worker's address); anything else, and every file in
 * any other build, as Vite would. A file copied from public/ is not built.
 */
export function sharedRenderBuiltUrl(filename, context = {}) {
  if (context.type === 'public') return undefined;
  return sharedUrl(filename, sharedAssetsBase()) ?? undefined;
}

/** A precache entry's URL: a built file's shared address, any other file's own. */
export function sharedPrecacheUrl(file, base = sharedAssetsBase()) {
  return sharedUrl(file, base) ?? file;
}

/**
 * `@fontsource` stylesheets list both WOFF2 and legacy WOFF (`url(...woff2) format('woff2'),
 * url(...woff) format('woff')`). Every browser that runs WebAssembly and ES2022 supports WOFF2,
 * so Vite's asset pipeline otherwise emits 28 dead `.woff` files (~320 KB) alongside `.woff2`.
 * Stripping the `.woff` fallback ahead of Vite's CSS plugin keeps only `.woff2`.
 */
export function woff2OnlyFontsPlugin() {
  return {
    name: 'softn-woff2-only-fonts',
    enforce: 'pre',
    transform(code, id) {
      const cleanId = id.split('?')[0];
      if (!/@fontsource(?:-variable)?[\\/].*\.css$/.test(cleanId) || !code.includes('.woff')) return null;
      const next = code.replace(/,\s*url\([^)]+\.woff['"]?\)\s*format\(['"]woff['"]\)/g, '');
      return next === code ? null : { code: next, map: null };
    },
  };
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** Every file under `dir`, as forward-slashed paths relative to it. */
function walk(dir, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), rel));
    else if (entry.isFile()) out.push(rel);
    else throw new Error(`${path.join(dir, entry.name)} is neither a file nor a folder`);
  }
  return out;
}

const TEXT = /\.(?:m?js|css|html|webmanifest|json)$/;

/**
 * After the builds are in place (`outDir/<app>/`, and the site's own at
 * `outDir` itself, named `''`): move every file of each build's assets/ into
 * `outDir/<base>` once and remove the build's folder.
 *
 * Refuses two different files under one name (a hashed name says the bytes;
 * core's workers keep their names and are one build of core), and a build
 * that still names its own assets/ in a page, a script, a stylesheet or its
 * service worker: built without the variable, it would ask for files that are
 * no longer there. Returns what was kept: `names` (sorted, relative to the
 * shared folder), and `copies`, how many files the builds held between them.
 */
export function collectSharedAssets(outDir, apps, base) {
  const target = path.join(outDir, ...base.split('/').filter(Boolean));
  const kept = new Map();
  let copies = 0;
  for (const app of apps) {
    const assets = path.join(outDir, app, 'assets');
    if (!fs.existsSync(assets)) continue;
    const label = app || 'the site';
    for (const name of walk(assets)) {
      const file = path.join(assets, name);
      const digest = sha256(file);
      const first = kept.get(name);
      if (first && first.digest !== digest) throw new Error(`${label}'s assets/${name} differs from ${first.label}'s file of the same name`);
      if (!first) {
        const to = path.join(target, name);
        if (fs.existsSync(to)) throw new Error(`${base}${name} exists before any build's file was moved there`);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(file, to);
        kept.set(name, { label, digest });
      }
      copies += 1;
    }
    fs.rmSync(assets, { recursive: true });
  }
  // What a build still asks for by its own address. The site's own is
  // `/assets/`, which every other address ends with, so it is looked for only
  // where an address starts: after a quote, a bracket or a space.
  for (const app of apps) {
    const dir = path.join(outDir, app);
    if (!fs.existsSync(dir)) continue;
    const own = app ? `/${app}/assets/` : '/assets/';
    const named = app ? (text) => text.includes(own) : (text) => /["'`(\s=]\/assets\//.test(text);
    // The build's own files (not the other apps' folders under the site's), and what it built.
    const files = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && TEXT.test(entry.name))
      .map((entry) => path.join(dir, entry.name));
    for (const file of files) {
      if (named(fs.readFileSync(file, 'utf8'))) throw new Error(`${path.relative(outDir, file).replaceAll('\\', '/')} names ${own}; build ${app || 'the site'} with SOFTN_SHARED_ASSETS=${base}`);
    }
  }
  for (const name of kept.keys()) {
    if (!TEXT.test(name)) continue;
    const text = fs.readFileSync(path.join(target, name), 'utf8');
    for (const app of apps.filter(Boolean)) {
      if (text.includes(`/${app}/assets/`)) throw new Error(`${base}${name} names /${app}/assets/; build ${app} with SOFTN_SHARED_ASSETS=${base}`);
    }
  }
  return { names: [...kept.keys()].sort(), copies };
}
