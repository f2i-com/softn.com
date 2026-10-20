// Cross-origin isolation from the service worker's side.
//
// The server sends Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy
// so the runtime gets SharedArrayBuffer (a model on the CPU provider then uses
// every core). A document served from this worker's precache carries whatever
// headers it had when it was cached — possibly none — and a runtime embedded
// in a page that is isolated is refused outright by the browser if it is not
// isolated itself. So every navigation this worker answers is stamped here,
// wherever the bytes came from.
//
// Dedicated worker scripts get the same treatment: an isolated page refuses
// to start a worker whose script arrives without the embedder policy, and the
// runtime's worker mode (the emulator, the modem) is nothing but such a worker.
//
// Network first, but not for ever: a server that accepts the connection and
// then stalls held Home back for as long as it stalled. After NETWORK_WAIT_MS
// the precached copy answers if there is one, as the worker-asset route does
// after 4 s (scripts/build/on-demand-chunks.mjs). With no copy — a first
// visit, a worker script that is not precached — the request keeps waiting on
// the same fetch, so a slow answer is still an answer.
//
// Nothing here is declared at the top level: this file is imported into the
// generated sw.js (importScripts), whose global scope it shares.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.mode !== 'navigate' && req.destination !== 'worker' && req.destination !== 'sharedworker') return;
  const NETWORK_WAIT_MS = 3000;
  const cachedCopy = async () => {
    const res = await caches.match(req, { ignoreSearch: true });
    if (res || req.mode !== 'navigate') return res;
    return caches.match(new URL('./index.html', self.registration.scope).href, { ignoreSearch: true });
  };
  event.respondWith(
    (async () => {
      const network = fetch(req);
      // Answered from the cache, a network failure that arrives later is
      // nobody's to report.
      network.catch(() => {});
      let timer;
      const slow = new Promise((resolve) => {
        timer = setTimeout(() => resolve('slow'), NETWORK_WAIT_MS);
      });
      let res;
      try {
        const first = await Promise.race([network, slow]);
        if (first === 'slow') {
          res = await cachedCopy();
          if (!res) res = await network;
        } else {
          res = first;
        }
      } catch (err) {
        res = await cachedCopy();
        if (!res) throw err;
      } finally {
        clearTimeout(timer);
      }
      // A navigation answered with a redirect arrives here opaque, status 0,
      // and `new Response(body, { status: 0 })` throws — so every redirected
      // navigation in scope showed a network error. There are no headers to
      // stamp on an opaque response anyway; the browser follows it, and the
      // document it lands on comes back through this handler.
      if (res.status === 0 || res.type === 'opaqueredirect' || res.type === 'opaque') return res;
      const headers = new Headers(res.headers);
      headers.set('Cross-Origin-Opener-Policy', 'same-origin');
      headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    })()
  );
});
