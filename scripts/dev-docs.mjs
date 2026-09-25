// The guides at /docs/ during `npm run dev`.
//
// In a deployed site /docs/ is a directory of static pages the site build
// generates from docs/content/softn-docs.json. Vite knows nothing of it, so in
// development /docs/ fell through to the site's own index.html and the
// product bar's "Docs" link opened the landing page. This builds the guides
// into docs/dist/ (the generator's own, ignored output) when the server starts,
// serves them as the static host would — a directory's index.html, a real 404
// for a guide that does not exist, /docs without its slash redirected — and
// builds again, then reloads the page, when the content, the styles or the
// generator change.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docsDir = path.join(root, 'docs');
const defaultOutDir = path.join(docsDir, 'dist');
const WATCHED = ['content', 'assets', 'scripts'].map((dir) => path.join(docsDir, dir));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

/** The file a request for `pathname` is answered with from `outDir`, or null for a 404. */
function resolveDocsFile(outDir, pathname) {
  const target = path.resolve(outDir, `.${decodeURIComponent(pathname)}`);
  if (target !== outDir && !target.startsWith(outDir + path.sep)) return null;
  const candidate = pathname.endsWith('/') ? path.join(target, 'index.html') : target;
  return fs.existsSync(candidate) && fs.statSync(candidate).isFile() ? candidate : null;
}

/**
 * Serve the generated guides from the site's development server. `outDir` is
 * where they are built; only the tests pass another.
 */
export function docsDevPlugin({ outDir = defaultOutDir } = {}) {
  return {
    name: 'softn-docs-development',
    apply: 'serve',
    async configureServer(server) {
      // Imported here, not at the top, so a production build of the site never
      // loads the generator through its Vite config.
      const { buildSite } = await import('../docs/scripts/build-docs.mjs');
      let building = null;
      let lastError = null;
      const build = async () => {
        try {
          const origin = `http://localhost:${server.config.server.port ?? 1420}`;
          const result = await buildSite({ outDir, origin });
          lastError = null;
          server.config.logger.info(`  docs: ${result.pages} guides at /docs/`, { timestamp: true });
        } catch (error) {
          lastError = error;
          server.config.logger.error(`  docs: build failed: ${error.message}`, { timestamp: true });
        }
      };
      building = build();

      let timer;
      server.watcher.add(WATCHED);
      server.watcher.on('change', (file) => {
        if (!WATCHED.some((dir) => file.startsWith(dir + path.sep))) return;
        clearTimeout(timer);
        timer = setTimeout(async () => {
          building = build();
          await building;
          server.ws.send({ type: 'full-reload', path: '*' });
        }, 150);
      });

      server.middlewares.use(async (request, response, next) => {
        const pathname = new URL(request.url ?? '/', 'http://softn.local').pathname;
        if (pathname !== '/docs' && !pathname.startsWith('/docs/') && pathname !== '/sitemap-docs.xml') return next();
        if (!['GET', 'HEAD'].includes(request.method ?? 'GET')) return next();
        if (pathname === '/docs') {
          response.statusCode = 301;
          response.setHeader('Location', '/docs/');
          return response.end();
        }
        await building;
        let file = resolveDocsFile(outDir, pathname);
        // A guide's URL without its trailing slash, the way the hosts redirect it.
        if (!file && !pathname.endsWith('/') && !path.extname(pathname) && resolveDocsFile(outDir, `${pathname}/`)) {
          response.statusCode = 301;
          response.setHeader('Location', `${pathname}/`);
          return response.end();
        }
        response.setHeader('Cache-Control', 'no-store');
        if (!file) {
          response.statusCode = 404;
          response.setHeader('Content-Type', 'text/plain; charset=utf-8');
          return response.end(lastError ? `The documentation did not build: ${lastError.message}` : `No guide at ${pathname}`);
        }
        response.statusCode = 200;
        response.setHeader('Content-Type', TYPES[path.extname(file)] ?? 'application/octet-stream');
        response.end(request.method === 'HEAD' ? undefined : fs.readFileSync(file));
      });
    },
  };
}
