/**
 * The installable-app half of a SoftN app's build: its web manifest, its
 * service worker, and the hook that registers it.
 *
 * This replaces vite-plugin-pwa, whose build half (workbox-build) bundled the
 * worker with Babel, Rollup plugins and terser: 201 packages and 30 MB of
 * node_modules for three apps. The worker's runtime is still Workbox's
 * (scripts/pwa-sw.js); what is here is the build: glob the output, revision
 * what is not already named by its hash, write the list into the worker and
 * bundle it with esbuild, write the manifest, and tag index.html.
 *
 * The options are vite-plugin-pwa's names for what the apps use of them, so a
 * config reads as it did:
 *
 *   disable           no worker, no manifest, a registration hook that does nothing
 *   registerType      'autoUpdate': the new worker takes over at once (web);
 *                     'prompt': it waits for the page to ask (Studio, Builder)
 *   injectRegister    'script' (default) writes registerSW.js and tags it;
 *                     false leaves registration to the app's hook
 *   manifest          the web manifest's fields
 *   workbox           { globPatterns, globIgnores, maximumFileSizeToCacheInBytes,
 *                       importScripts, runtimeCaching }
 *
 * An app registers through `virtual:softn-pwa/react`'s `useRegisterSW`, which
 * answers `{ needRefresh, offlineReady, updateServiceWorker }` and calls
 * `onRegisteredSW(url, registration)`, as the hook it replaces did.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SW_TEMPLATE = fileURLToPath(new URL('./pwa-sw.js', import.meta.url));
const VIRTUAL = 'virtual:softn-pwa/react';
const RESOLVED = '\0' + VIRTUAL;

/** A glob as a regular expression over a forward-slashed path relative to the output folder. */
export function globToRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const slash = glob[i + 2] === '/';
        out += slash ? '(?:.*/)?' : '.*';
        i += slash ? 2 : 1;
      } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else if (c === '{') {
      const end = glob.indexOf('}', i);
      out += `(?:${glob.slice(i + 1, end).split(',').map((part) => part.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')).join('|')})`;
      i = end;
    } else out += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

/** Every file under `dir`, as forward-slashed paths relative to it. */
function walk(dir, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

/**
 * What the worker precaches: the files the globs take and the ignores leave,
 * under the size cap, each with a revision unless its name already changes
 * with its content (Vite's hashed assets/, but not the workers' files in
 * assets/core-runtime/). The manifest is added, as it is written outside the
 * globs' extensions.
 */
export function precacheEntries(outDir, { globPatterns = [], globIgnores = [], maximumFileSizeToCacheInBytes = 2 * 1024 * 1024 } = {}, { warn = () => {} } = {}) {
  const take = globPatterns.map(globToRegExp);
  const leave = globIgnores.map(globToRegExp);
  const entries = [];
  for (const file of walk(outDir).sort()) {
    if (file === 'sw.js') continue;
    const always = file === 'manifest.webmanifest';
    if (!always && (!take.some((re) => re.test(file)) || leave.some((re) => re.test(file)))) continue;
    const bytes = fs.readFileSync(path.join(outDir, file));
    if (bytes.length > maximumFileSizeToCacheInBytes) {
      warn(`${file} is ${bytes.length} bytes, past maximumFileSizeToCacheInBytes, and is not precached`);
      continue;
    }
    // Vite's own assets/ are hashed; the workers' files it copies to
    // assets/core-runtime/ keep their names from build to build.
    const hashed = file.startsWith('assets/') && !file.startsWith('assets/core-runtime/');
    entries.push({ url: file, revision: hashed ? null : createHash('md5').update(bytes).digest('hex') });
  }
  return entries;
}

/** The manifest as vite-plugin-pwa wrote it: its defaults first, the app's other fields, the icons last. */
export function manifestJson(manifest) {
  const { name, short_name, description, start_url = './', display = 'standalone', background_color = '#ffffff', theme_color = '#42b883', lang = 'en', scope, icons = [], ...rest } = manifest;
  return JSON.stringify({ name, short_name, description, start_url, display, background_color, theme_color, lang, scope, ...rest, icons });
}

/** The worker's wiring, with each route's pattern as text a RegExp can be made from again. */
export function workerConfig({ registerType = 'prompt', injectRegister = 'script', workbox = {} }) {
  return {
    importScripts: workbox.importScripts ?? [],
    // As vite-plugin-pwa had it: a worker that takes over at once only when the
    // build also registers it. An app that registers through the hook asks.
    autoUpdate: registerType === 'autoUpdate' && injectRegister !== false,
    routes: (workbox.runtimeCaching ?? []).map(({ urlPattern, handler, options = {} }) => ({
      pattern: urlPattern.source,
      flags: urlPattern.flags,
      handler,
      cacheName: options.cacheName,
      networkTimeoutSeconds: options.networkTimeoutSeconds,
      expiration: options.expiration,
      statuses: options.cacheableResponse?.statuses,
    })),
  };
}

/** The worker, bundled: the two globals first, then Workbox and pwa-sw.js. */
export async function buildWorker(precache, config) {
  const { build } = await import('esbuild');
  const result = await build({
    entryPoints: [SW_TEMPLATE],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    minify: true,
    write: false,
    define: { 'process.env.NODE_ENV': '"production"' },
    banner: { js: `self.__SOFTN_SW__=${JSON.stringify(config)};\nself.__SOFTN_PRECACHE=${JSON.stringify(precache)};` },
    logLevel: 'silent',
  });
  return result.outputFiles[0].text;
}

/** The registration hook an app imports, for this base, or one that does nothing. */
export function hookSource({ base, enabled }) {
  if (!enabled) {
    return `import { useState } from 'react';
export function useRegisterSW() {
  const needRefresh = useState(false), offlineReady = useState(false);
  return { needRefresh, offlineReady, updateServiceWorker: async () => {} };
}
`;
  }
  return `import { useCallback, useEffect, useRef, useState } from 'react';
const SW_URL = ${JSON.stringify(`${base}sw.js`)};
const SCOPE = ${JSON.stringify(base)};
export function useRegisterSW(options = {}) {
  const needRefresh = useState(false), offlineReady = useState(false);
  const [, setNeedRefresh] = needRefresh, [, setOfflineReady] = offlineReady;
  const registration = useRef(null), latest = useRef(options);
  latest.current = options;
  useEffect(() => {
    if (import.meta.env.DEV || !('serviceWorker' in navigator)) return;
    let live = true;
    navigator.serviceWorker.register(SW_URL, { scope: SCOPE }).then((reg) => {
      // Nothing to watch where registration is stubbed out (an automated or locked-down browser).
      if (!live || !reg) return;
      registration.current = reg;
      latest.current.onRegisteredSW?.(SW_URL, reg);
      // Installed with a page already controlled is an update; with none, the first install.
      const watch = (worker) => {
        if (!worker) return;
        const check = () => {
          if (worker.state !== 'installed') return;
          if (navigator.serviceWorker.controller) setNeedRefresh(true);
          else setOfflineReady(true);
        };
        check();
        worker.addEventListener('statechange', check);
      };
      watch(reg.waiting);
      watch(reg.installing);
      reg.addEventListener('updatefound', () => watch(reg.installing));
    }, (error) => latest.current.onRegisterError?.(error));
    return () => { live = false; };
  }, []);
  const updateServiceWorker = useCallback(async (reload = true) => {
    const waiting = registration.current?.waiting;
    if (!waiting) return;
    if (reload) navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
    waiting.postMessage({ type: 'SKIP_WAITING' });
  }, []);
  return { needRefresh, offlineReady, updateServiceWorker };
}
`;
}

export function softnPwa(options) {
  const { disable = false, injectRegister = 'script', manifest } = options;
  let base = '/';
  let outDir = 'dist';
  let isBuild = false;
  return {
    name: 'softn-pwa',
    configResolved(config) {
      base = config.base || '/';
      outDir = path.resolve(config.root, config.build.outDir);
      isBuild = config.command === 'build';
    },
    resolveId(id) {
      return id === VIRTUAL ? RESOLVED : undefined;
    },
    load(id) {
      return id === RESOLVED ? hookSource({ base, enabled: !disable }) : undefined;
    },
    transformIndexHtml() {
      if (disable || !isBuild) return [];
      const tags = [{ tag: 'link', attrs: { rel: 'manifest', href: `${base}manifest.webmanifest` }, injectTo: 'head' }];
      if (injectRegister === 'script') tags.push({ tag: 'script', attrs: { id: 'softn-register-sw', src: `${base}registerSW.js` }, injectTo: 'head' });
      return tags;
    },
    async closeBundle() {
      if (disable || !isBuild) return;
      fs.writeFileSync(path.join(outDir, 'manifest.webmanifest'), manifestJson(manifest));
      if (injectRegister === 'script') {
        fs.writeFileSync(path.join(outDir, 'registerSW.js'),
          `if('serviceWorker' in navigator) {window.addEventListener('load', () => {navigator.serviceWorker.register('${base}sw.js', { scope: '${base}' })})}`);
      }
      const precache = precacheEntries(outDir, options.workbox, { warn: (message) => this.warn(message) });
      fs.writeFileSync(path.join(outDir, 'sw.js'), await buildWorker(precache, workerConfig(options)));
    },
  };
}
