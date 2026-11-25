import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { retireServiceWorkersPlugin } from '../../scripts/dev/dev-service-worker.mjs';
import { docsDevPlugin } from '../../scripts/dev/dev-docs.mjs';
import { scriptPolicyPlugin } from '../../scripts/build/script-policy.mjs';
import { buildSourcemaps } from '../../scripts/build/sourcemaps.mjs';
import { sharedAssetsBase, sharedRenderBuiltUrl, woff2OnlyFontsPlugin } from '../../scripts/build/shared-assets.mjs';

const appDir = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig(({ mode }) => {
  // loadEnv, not process.env. Vite never writes .env values into process.env —
  // it keeps them in its own resolved env and injects them into client code as
  // import.meta.env. Reading process.env at module scope also runs before Vite
  // has opened a .env file at all, so VITE_WEB_URL set in .env.local was visible
  // to the app through import.meta.env but invisible to the proxy and the port
  // below: half the config honoured the file and half ignored it. Real
  // environment variables still win, which is what CI and the site build rely on.
  const env = loadEnv(mode, appDir, 'VITE_');

  // Standalone site development can point directly at another runtime.
  // `npm run dev` instead supplies private proxy targets and browser-facing
  // paths, making this Vite server the one public origin for all four apps.
  const webRuntimeTarget = env.VITE_WEB_PROXY_TARGET || env.VITE_WEB_URL || 'http://localhost:1420';
  const appProxies = [
    ['/web/', env.VITE_WEB_PROXY_TARGET],
    ['/builder/', env.VITE_BUILDER_PROXY_TARGET],
    ['/studio/', env.VITE_STUDIO_PROXY_TARGET],
    ['/api', env.VITE_API_PROXY_TARGET],
  ].filter((entry): entry is [string, string] => Boolean(entry[1]));
  const demoProxy = {
    target: webRuntimeTarget,
    changeOrigin: true,
    // The runtime's public/ directory follows its `/web/` Vite base. Production
    // also copies those bundles to root `/demos/`; mirror that alias in dev.
    ...(env.VITE_WEB_PROXY_TARGET && { rewrite: (url: string) => `/web${url}` }),
  };

  // Match production .htaccess / nginx: `/web`, `/builder`, `/studio` without a
  // trailing slash redirect to their canonical directory URLs so Vite's base
  // check never answers 404 when a developer types `/studio` or `/builder`.
  const canonicalAppSlashesPlugin = {
    name: 'softn-canonical-app-slashes',
    configureServer(server: {
      middlewares: {
        use: (
          fn: (
            req: { url?: string },
            res: { statusCode: number; setHeader: (k: string, v: string) => void; end: () => void },
            next: () => void,
          ) => void,
        ) => void;
      };
    }) {
      server.middlewares.use((req, res, next) => {
        const match = /^\/(web|builder|studio)(\?.*)?$/.exec(req.url ?? '');
        if (match) {
          res.statusCode = 308;
          res.setHeader('Location', `/${match[1]}/${match[2] ?? ''}`);
          res.end();
          return;
        }
        next();
      });
    },
  };

  // Preload the two primary Latin woff2 webfonts (hero display + body regular) so
  // browsers start fetching them alongside CSS instead of waiting for @font-face parse.
  const PRIMARY_FONT_RE = /(?:bricolage-grotesque-latin-wght-normal|ibm-plex-sans-latin-400-normal)-[^/]+\.woff2$/;
  const preloadPrimaryFontsPlugin = {
    name: 'softn-preload-primary-fonts',
    transformIndexHtml: {
      order: 'post' as const,
      handler(_html: string, ctx: { bundle?: Record<string, { fileName?: string }> }) {
        if (!ctx.bundle) return [];
        const shared = sharedAssetsBase();
        const tags: Array<{ tag: string; attrs: Record<string, string | boolean>; injectTo: 'head' }> = [];
        for (const chunk of Object.values(ctx.bundle)) {
          const file = chunk?.fileName;
          if (!file || !PRIMARY_FONT_RE.test(file)) continue;
          const href = shared && file.startsWith('assets/') ? shared + file.slice('assets/'.length) : `/${file}`;
          tags.push({
            tag: 'link',
            attrs: { rel: 'preload', href, as: 'font', type: 'font/woff2', crossorigin: '' },
            injectTo: 'head',
          });
        }
        return tags;
      },
    },
  };

  return {
    // scriptPolicyPlugin: what runs as script is this deployment's files only (scripts/build/script-policy.mjs).
    plugins: [canonicalAppSlashesPlugin, retireServiceWorkersPlugin(), docsDevPlugin(), woff2OnlyFontsPlugin(), react(), preloadPrimaryFontsPlugin, scriptPolicyPlugin()],
    server: {
      port: env.VITE_PORT ? Number(env.VITE_PORT) : 1421,
      strictPort: true,
      proxy: Object.fromEntries([
        // Preserve the browser's Host header for `/api` so PHP's same-origin
        // check (`Cors::requestOrigin()`) sees the real site origin (e.g.
        // localhost:1420) instead of the private loopback API port.
        ...appProxies.map(([route, target]) => [route, { target, changeOrigin: route !== '/api', ws: true }]),
        // In a deployed build the site and the runtime sit under one origin and
        // `/demos` is a plain directory. Proxying it in dev keeps the fetch
        // same-origin in both places, so the demo shelf needs no CORS handling
        // and no separate code path.
        ['/demos', demoProxy],
      ]),
    },
    // In the site build, what this builds is kept with the apps' own, in the one
    // shared folder (scripts/build/shared-assets.mjs); elsewhere, Vite's own URLs.
    experimental: { renderBuiltUrl: sharedRenderBuiltUrl },
    build: {
      target: 'es2022',
      // In a development build only (scripts/build/sourcemaps.mjs).
      sourcemap: buildSourcemaps(),
    },
  };
});
