/* SoftN single-app host: the service worker index.php registers when `pwa` is on.
 *
 * It makes the page installable and keeps the runtime's hashed assets, the
 * icons and the share image cached. It never touches index.php with a query
 * (the source pack, entries, the icon, the manifest), so those stay private,
 * cookie-gated answers from the server and a redeployed application is seen on
 * the next visit. Paths are taken from the registration scope, so a deployment
 * under a sub-directory works unchanged. Bump VERSION when this file changes. */
var VERSION = 'softn-serve-sw-5';
var base = new URL(self.registration.scope).pathname;
var CACHE_NAME = base === '/' ? VERSION : VERSION + ':' + base;

function cacheableAsset(pathname, responseClone) {
  if (!responseClone || !responseClone.ok) return Promise.resolve(false);
  var ct = (responseClone.headers.get('content-type') || '').toLowerCase();
  if (ct.indexOf('text/html') === 0) return Promise.resolve(false);
  if (/\.wasm$/i.test(pathname) && typeof WebAssembly !== 'undefined' && typeof WebAssembly.validate === 'function') {
    return responseClone.clone().arrayBuffer().then(function (buf) {
      return WebAssembly.validate(buf);
    }).catch(function () { return false; });
  }
  return Promise.resolve(true);
}
var precache = [
  base + 'pwa-icons/icon-192.png',
  base + 'pwa-icons/icon-512.png',
  base + 'pwa-icons/icon-maskable-512.png',
  base + 'apple-touch-icon.png',
  base + 'share.png',
];

function isOwnStaleCache(key) {
  if (key === CACHE_NAME || key.indexOf('softn-serve-sw-') !== 0) return false;
  if (base === '/') return key.indexOf(':') === -1;
  return key.slice(-base.length - 1) === ':' + base;
}

function offlinePage() {
  var html =
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Offline</title>' +
    '<body style="margin:0;min-height:100vh;display:grid;place-content:center;font-family:system-ui;background:#171821;color:#f5f5f8;text-align:center">' +
    '<p>This application needs a connection the first time it loads.<br>Try again when you are back online.</p></body>';
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      // Placeholders an operator removed must not block installation.
      return Promise.allSettled(precache.map(function (url) { return cache.add(url); }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      // Only remove this scope's older SW caches; never touch downloaded models
      // (`softn-models-v1`) or sibling apps sharing the same origin.
      return Promise.all(keys.filter(isOwnStaleCache).map(function (key) { return caches.delete(key); }));
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
    var isAppEntry = url.pathname === base || url.pathname === base + 'index.php';
    if (!isAppEntry) return;
    event.respondWith(
      fetch(request).then(function (response) {
        var cc = (response.headers.get('cache-control') || '').toLowerCase();
        if (response.ok && cc.indexOf('no-store') < 0) {
          var copy = response.clone();
          caches.open(CACHE_NAME).then(function (cache) { return cache.put(base, copy); }).catch(function () {});
        }
        return response;
      }).catch(function () {
        // When the private index.php shell is uncacheable (`no-store`), fall back cleanly to offlinePage().
        return caches.open(CACHE_NAME).then(function (cache) { return cache.match(base); }).then(function (cached) { return cached || offlinePage(); });
      })
    );
    return;
  }
  var relative = url.pathname.slice(base.length);
  // The runtime's workers and unhashed assets keep their names from release to release,
  // unlike content-hashed bundles under assets/ or digest-foldered container-runtime/<hex>/.
  // Use network-first for unhashed runtime paths so security updates take effect immediately.
  var isUnhashedContainerRuntime =
    relative.indexOf('assets/container-runtime/') === 0 &&
    !/^assets\/container-runtime\/[0-9a-f]{8,}\//i.test(relative);
  if (relative.indexOf('assets/core-runtime/') === 0 || isUnhashedContainerRuntime) {
    event.respondWith(
      fetch(request).then(function (response) {
        if (response.ok) {
          var copy = response.clone();
          cacheableAsset(url.pathname, copy).then(function (ok) {
            if (!ok) return;
            caches.open(CACHE_NAME).then(function (cache) { return cache.put(request, copy); }).catch(function () {});
          });
        }
        return response;
      }).catch(function (error) {
        return caches.open(CACHE_NAME).then(function (cache) { return cache.match(request); }).then(function (cached) {
          if (cached) return cached;
          throw error;
        });
      })
    );
    return;
  }
  if (relative.indexOf('assets/') === 0 || relative.indexOf('pwa-icons/') === 0 || precache.indexOf(url.pathname) >= 0) {
    event.respondWith(
      // This worker's own cache: an app's model downloads share the origin's
      // Cache Storage, under addresses its script names (core's model-host.ts).
      caches.open(CACHE_NAME).then(function (cache) { return cache.match(request); }).then(function (cached) {
        if (cached) return cached;
        return fetch(request).then(function (response) {
          if (response.ok) {
            var copy = response.clone();
            cacheableAsset(url.pathname, copy).then(function (ok) {
              if (!ok) return;
              caches.open(CACHE_NAME).then(function (cache) { return cache.put(request, copy); }).catch(function () {});
            });
          }
          return response;
        });
      })
    );
  }
});
