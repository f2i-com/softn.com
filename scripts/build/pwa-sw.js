/**
 * The service worker every installable SoftN app ships, bundled per app by
 * scripts/build/pwa.mjs with esbuild. Workbox's own runtime does the work that
 * fails quietly offline (revisioned precache, stale-cache cleanup, the
 * navigation fallback, expiry); what this file adds is only the wiring, read
 * from two globals the build writes ahead of it:
 *
 *   self.__SOFTN_SW__      { importScripts, autoUpdate, routes }
 *   self.__SOFTN_PRECACHE  [{ url, revision }]
 */
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { CacheFirst, NetworkFirst } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';
import { CacheableResponsePlugin } from 'workbox-cacheable-response';
import { clientsClaim } from 'workbox-core';
import { isPageInPlaceOfFile, routeMatcher } from './sw-route-match.js';
import { installedClassicGroups } from './sw-classic-upgrade.js';

const config = self.__SOFTN_SW__;

// First, before any fetch listener of Workbox's: the web runtime's coi.js
// answers documents with the cross-origin isolation headers, and a listener
// registered ahead of it would answer first.
if (config.importScripts.length) importScripts(...config.importScripts);

if (config.autoUpdate) {
  self.skipWaiting();
  clientsClaim();
} else {
  // A new build waits until the page asks it to take over, so an edit in
  // progress is never reloaded out from under the person.
  self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
  });
}

precacheAndRoute(self.__SOFTN_PRECACHE);
cleanupOutdatedCaches();
registerRoute(new NavigationRoute(createHandlerBoundToURL('index.html')));

// A page answered in place of a script or an engine is not kept by any route (sw-route-match.js).
const fileNotPage = {
  cacheWillUpdate: async ({ request, response }) => (response && isPageInPlaceOfFile(request.url, response) ? null : response),
};

if (config.classicAssets) {
  const scope = self.registration.scope;
  const groups = Object.fromEntries(Object.entries(config.classicAssets).map(([name, paths]) =>
    [name, paths.map((path) => new URL(path, scope).href)]));
  for (const [format, paths] of Object.entries(config.sourceCompilers ?? {})) {
    groups['compiler-' + format] = paths.map((path) => new URL(path, scope).href);
  }
  const urls = new Set(Object.values(groups).flat());
  const revisions = new Map(Object.entries(config.classicRevisions ?? {}).map(([path, revision]) => {
    const url = new URL(path, scope);
    const href = url.href;
    url.searchParams.set('__WB_REVISION__', revision);
    return [href, url.href];
  }));
  const cacheName = 'softn-classic-assets-' + scope;
  const groupKey = (name) => new URL(`__classic__/${name}`, scope).href;
  const inFlight = new Map();

  async function keepFile(cache, url) {
    const key = revisions.get(url) ?? url;
    const saved = await cache.match(key);
    if (saved) return;
    if (inFlight.has(url)) return inFlight.get(url);
    const write = (async () => {
      const response = await fetch(url, { credentials: 'same-origin', cache: revisions.has(url) ? 'reload' : 'default' });
      if (!response.ok || isPageInPlaceOfFile(url, response)) throw new Error('Missing classic app asset: ' + url);
      if (url.endsWith('.wasm') && !WebAssembly.validate(await response.clone().arrayBuffer())) {
        throw new Error('Incomplete WebAssembly engine: ' + url);
      }
      await cache.put(key, response);
    })().finally(() => inFlight.delete(url));
    inFlight.set(url, write);
    return write;
  }

  // The set held for each app comes from this build, never from URLs supplied by an app.
  async function keepGroups(names) {
    const cache = await caches.open(cacheName);
    const files = new Set();
    for (const name of names) {
      if (!Object.hasOwn(groups, name)) throw new Error('Unknown classic component group: ' + name);
      for (const file of groups[name]) files.add(file);
    }
    await Promise.all([...files].map((file) => keepFile(cache, file)));
    if (!config.classicTags) await Promise.all(names.map((name) => cache.put(groupKey(name), new Response('1'))));
  }

  // If this browser kept a classic app, install its groups from the new build before the
  // worker takes over. A failed update leaves the working offline version in control.
  self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
      if (!self.registration.active) return;
      if (config.classicTags) {
        const names = await installedClassicGroups(self.indexedDB, config.classicTags, (bytes, tags) => {
          if (!self.softnClassicUpgrade) importScripts(config.classicUpgrade);
          return self.softnClassicUpgrade.scan(bytes, tags);
        });
        await keepGroups(names);
        if (names.includes('script')) {
          await keepFile(await caches.open('softn-full-engine'), new URL(config.fullEngine, scope).href);
        }
        return;
      }
      const cache = await caches.open(cacheName);
      const saved = await cache.keys();
      const installed = new Set(saved.map((request) => request.url));
      await keepGroups(Object.keys(groups).filter((name) => installed.has(groupKey(name))));
    })());
  });
  self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
      const tabs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      if (tabs.some((tab) => tab.url.startsWith(scope))) return;
      const cache = await caches.open(cacheName);
      const valid = new Set([...Array.from(urls, (url) => revisions.get(url) ?? url), ...Object.keys(groups).map(groupKey)]);
      await Promise.all((await cache.keys()).filter((request) => !valid.has(request.url)).map((request) => cache.delete(request)));
    })());
  });
  self.addEventListener('message', (event) => {
    if (!event.ports[0]) return;
    let names;
    if (event.data?.type === 'SOFTN_KEEP_CLASSIC' && Array.isArray(event.data.groups)) {
      names = [...new Set(['renderer', ...event.data.groups])];
    } else if (event.data?.type === 'SOFTN_KEEP_COMPILER' && Object.hasOwn(config.sourceCompilers ?? {}, event.data.format)) {
      names = ['compiler-' + event.data.format];
    } else return;
    event.waitUntil(keepGroups(names).then(
      () => event.ports[0].postMessage({ ok: true }),
      (err) => event.ports[0].postMessage({ error: String(err) })
    ));
  });
  registerRoute(({ url }) => urls.has(url.href), new CacheFirst({
    cacheName,
    plugins: [fileNotPage, {
      cacheKeyWillBeUsed: ({ request }) => revisions.get(request.url) ?? request,
      requestWillFetch: ({ request }) => revisions.has(request.url) ? new Request(request, { cache: 'reload' }) : request,
    }],
  }));
}

for (const route of config.routes) {
  const plugins = [fileNotPage];
  // An older open tab may request a hash from the preceding build after activation.
  if (config.classicAssets && route.handler === 'CacheFirst') plugins.push({
    handlerDidError: async ({ request }) => (await caches.open('softn-classic-assets-' + self.registration.scope)).match(request),
  });
  if (route.expiration) plugins.push(new ExpirationPlugin(route.expiration));
  if (route.statuses) plugins.push(new CacheableResponsePlugin({ statuses: route.statuses }));
  const Strategy = route.handler === 'NetworkFirst' ? NetworkFirst : CacheFirst;
  const options = { cacheName: route.cacheName, plugins };
  if (route.networkTimeoutSeconds !== undefined) options.networkTimeoutSeconds = route.networkTimeoutSeconds;
  registerRoute(routeMatcher(route.pattern, route.flags, self.location.origin), new Strategy(options), 'GET');
}
