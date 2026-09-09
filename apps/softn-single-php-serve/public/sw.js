/* SoftN single-app host: the service worker index.php registers when `pwa` is on.
 *
 * It makes the page installable and keeps the runtime's hashed assets, the
 * icons and the share image cached. It never touches index.php with a query
 * (the source pack, entries, the icon, the manifest), so those stay private,
 * cookie-gated answers from the server and a redeployed application is seen on
 * the next visit. Paths are taken from the registration scope, so a deployment
 * under a sub-directory works unchanged. Bump VERSION when this file changes. */
var VERSION = 'softn-serve-sw-1';
var base = new URL(self.registration.scope).pathname;
var precache = [
  base + 'pwa-icons/icon-192.png',
  base + 'pwa-icons/icon-512.png',
  base + 'pwa-icons/icon-maskable-512.png',
  base + 'apple-touch-icon.png',
  base + 'share.png',
];

function offlinePage() {
  var html =
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Offline</title>' +
    '<body style="margin:0;min-height:100vh;display:grid;place-content:center;font-family:system-ui;background:#171821;color:#f5f5f8;text-align:center">' +
    '<p>This application needs a connection the first time it loads.<br>Try again when you are back online.</p></body>';
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(VERSION).then(function (cache) {
      // Placeholders an operator removed must not block installation.
      return Promise.allSettled(precache.map(function (url) { return cache.add(url); }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (key) { return key !== VERSION; }).map(function (key) { return caches.delete(key); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') return;
  var url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.indexOf(base) !== 0) return;
  // The host's dynamic answers are never cached.
  if (url.search !== '') return;
  if (url.pathname.indexOf(base + 'api') === 0) return;
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).then(function (response) {
        if (response.ok) {
          var copy = response.clone();
          caches.open(VERSION).then(function (cache) { return cache.put(base, copy); }).catch(function () {});
        }
        return response;
      }).catch(function () {
        return caches.match(base).then(function (cached) { return cached || offlinePage(); });
      })
    );
    return;
  }
  var relative = url.pathname.slice(base.length);
  if (relative.indexOf('assets/') === 0 || relative.indexOf('pwa-icons/') === 0 || precache.indexOf(url.pathname) >= 0) {
    event.respondWith(
      caches.match(request).then(function (cached) {
        if (cached) return cached;
        return fetch(request).then(function (response) {
          if (response.ok) {
            var copy = response.clone();
            caches.open(VERSION).then(function (cache) { return cache.put(request, copy); }).catch(function () {});
          }
          return response;
        });
      })
    );
  }
});
