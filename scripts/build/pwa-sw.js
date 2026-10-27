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
import { routeMatcher } from './sw-route-match.js';

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

for (const route of config.routes) {
  const plugins = [];
  if (route.expiration) plugins.push(new ExpirationPlugin(route.expiration));
  if (route.statuses) plugins.push(new CacheableResponsePlugin({ statuses: route.statuses }));
  const Strategy = route.handler === 'NetworkFirst' ? NetworkFirst : CacheFirst;
  const options = { cacheName: route.cacheName, plugins };
  if (route.networkTimeoutSeconds !== undefined) options.networkTimeoutSeconds = route.networkTimeoutSeconds;
  registerRoute(routeMatcher(route.pattern, route.flags, self.location.origin), new Strategy(options), 'GET');
}
