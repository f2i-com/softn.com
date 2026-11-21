import { readFile } from 'node:fs/promises';

// The site and tools normally share an origin. When Vite serves a tool on
// its own port, its same-origin ?open= links still need the site's archives.
export function exampleBundlesPlugin() {
  const directory = new URL('../../apps/softn-site/public/examples/', import.meta.url);
  return {
    name: 'softn-development-example-bundles',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const name = /^\/examples\/([A-Za-z0-9_-]+\.softn)(?:\?.*)?$/.exec(request.url ?? '/')?.[1];
        if (!name || (request.method !== 'GET' && request.method !== 'HEAD')) return next();
        try {
          const bytes = await readFile(new URL(name, directory));
          response.setHeader('Content-Type', 'application/zip');
          response.setHeader('Content-Length', bytes.byteLength);
          response.end(request.method === 'HEAD' ? undefined : bytes);
        } catch (error) {
          if (error.code !== 'ENOENT') return next(error);
          response.statusCode = 404;
          response.end();
        }
      });
    },
  };
}
