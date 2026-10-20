/**
 * The large binaries every app of the site ships alike — the ZIPP engine and
 * the QR decoder — kept once, under /shared/assets/, rather than once per app.
 *
 * The site deploys four apps (/web/, /studio/, /builder/, /play/), each built
 * on its own and each emitting the same engine (6.1 MB, and its .br and .gz)
 * and the same QR decoder (0.9 MB) under its own assets/. That was some 30 MB
 * of a deployment in copies, and a visitor who opened a second app downloaded
 * the engine again under the second app's URL. In the site build
 * (SOFTN_SHARED_ASSETS, set by scripts/build/build-site.mjs) each app refers
 * to these files at /shared/assets/<name> instead — in its scripts
 * (renderBuiltUrl below) and in its service worker's precache (pwa.mjs) — so
 * one copy serves every app and one download every app a visitor opens. An
 * app's service worker may precache and answer for a same-origin file outside
 * its scope. The names are content hashes, so the copies are the same file;
 * collectSharedAssets() checks that, keeps one and removes the rest.
 *
 * Without the variable — an app built on its own, the desktop and single-app
 * hosts, FormLogic's editors — nothing changes: each app keeps its own copy.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** The files kept once: the engine, and the QR reader's decoder. */
export const SHARED_ASSET = /^(?:zipp_wasm_bg|zxing_reader)-[\w-]+\.wasm$/;

/** Where the site keeps them, as an absolute path ending in `/`; null when the build is not the site's. */
export function sharedAssetsBase(env = process.env) {
  const base = env.SOFTN_SHARED_ASSETS;
  if (!base) return null;
  if (!/^\/(?:[\w-]+\/)+$/.test(base)) throw new Error(`SOFTN_SHARED_ASSETS must be an absolute path ending in "/", not "${base}"`);
  return base;
}

/** Vite's experimental.renderBuiltUrl: a shared file by its shared path, anything else as Vite would. */
export function sharedRenderBuiltUrl(filename) {
  const base = sharedAssetsBase();
  const name = path.posix.basename(filename);
  return base && SHARED_ASSET.test(name) ? base + name : undefined;
}

/** A precache entry's URL: a shared file's shared path, any other file's own. */
export function sharedPrecacheUrl(file, base = sharedAssetsBase()) {
  const name = path.posix.basename(file);
  return base && file.startsWith('assets/') && SHARED_ASSET.test(name) ? base + name : file;
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/**
 * After the apps are built into `outDir/<app>/`: move each shared file to
 * `outDir/<base>` once, and remove the apps' copies. Refuses two different
 * files under one name, and an app whose scripts still name a shared file by
 * its own path (built without the variable). Returns the names kept.
 */
export function collectSharedAssets(outDir, apps, base) {
  const target = path.join(outDir, ...base.split('/').filter(Boolean));
  const kept = new Map();
  for (const app of apps) {
    const assets = path.join(outDir, app, 'assets');
    if (!fs.existsSync(assets)) continue;
    for (const name of fs.readdirSync(assets).filter((n) => SHARED_ASSET.test(n))) {
      const file = path.join(assets, name);
      const digest = sha256(file);
      const first = kept.get(name);
      if (first && first.digest !== digest) throw new Error(`${app}/assets/${name} differs from ${first.app}'s file of the same name`);
      if (!first) {
        fs.mkdirSync(target, { recursive: true });
        fs.copyFileSync(file, path.join(target, name));
        kept.set(name, { app, digest });
      }
      fs.rmSync(file);
    }
  }
  for (const app of apps) {
    const assets = path.join(outDir, app, 'assets');
    if (!fs.existsSync(assets)) continue;
    for (const script of fs.readdirSync(assets).filter((n) => /\.m?js$/.test(n))) {
      const text = fs.readFileSync(path.join(assets, script), 'utf8');
      for (const name of kept.keys()) {
        let at = text.indexOf(name);
        while (at >= 0) {
          if (!text.slice(Math.max(0, at - base.length), at).endsWith(base)) {
            throw new Error(`${app}/assets/${script} names ${name} by its own path; build ${app} with SOFTN_SHARED_ASSETS=${base}`);
          }
          at = text.indexOf(name, at + name.length);
        }
      }
    }
  }
  return [...kept.keys()].sort();
}
