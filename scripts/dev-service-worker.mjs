// A production PWA can outlive the server that installed it. During local
// development Vite otherwise answers its update request with index.html,
// leaving the old worker permanently serving a cached production shell.
const RETIRE_WORKER = `/* Softn development service-worker retirement. */
self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    await self.clients.claim();
    await self.registration.unregister();
  })());
});
// No fetch handler: requests reach the development server. Saved bundles,
// app records, preferences and offline caches are deliberately untouched.
`;

/** Retire only Softn's old PWA workers when serving source with Vite. */
export function retireServiceWorkersPlugin() {
  return {
    name: 'softn-retire-development-service-workers',
    apply: 'serve',
    enforce: 'pre',
    configureServer(server) {
      const paths = new Set(['/sw.js', '/web/sw.js', '/studio/sw.js', '/builder/sw.js', '/play/sw.js']);
      const base = server.config.base;
      if (base?.startsWith('/')) paths.add(`${base.replace(/\/+$/, '')}/sw.js`);
      server.middlewares.use((request, response, next) => {
        const pathname = new URL(request.url ?? '/', 'http://softn.local').pathname;
        if (!paths.has(pathname) || !['GET', 'HEAD'].includes(request.method ?? 'GET')) return next();
        response.statusCode = 200;
        response.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        response.setHeader('Cache-Control', 'no-store');
        response.end(request.method === 'HEAD' ? undefined : RETIRE_WORKER);
      });
    },
  };
}
