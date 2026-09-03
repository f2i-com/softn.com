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
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.mode !== 'navigate' && req.destination !== 'worker' && req.destination !== 'sharedworker') return;
  event.respondWith(
    (async () => {
      let res;
      try {
        res = await fetch(req);
      } catch (err) {
        res = await caches.match(req, { ignoreSearch: true });
        if (!res && req.mode === 'navigate') res = await caches.match(new URL('./index.html', self.registration.scope).href, { ignoreSearch: true });
        if (!res) throw err;
      }
      const headers = new Headers(res.headers);
      headers.set('Cross-Origin-Opener-Policy', 'same-origin');
      headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    })()
  );
});
