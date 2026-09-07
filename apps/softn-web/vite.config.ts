import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { coreWorkerAssetPlugin } from '../../scripts/core-worker-assets.mjs';

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};

export default defineConfig({
  // Serving from a subpath such as /web/ is a deployment decision, so the base
  // is an env var rather than a constant.
  base: env.VITE_BASE || '/',
  plugins: [
    react(),
    coreWorkerAssetPlugin(),
    VitePWA({
      registerType: 'autoUpdate',
      // Nothing is named here on purpose. Everything in public/ is copied into
      // dist, and the workbox globs below already sweep dist for png and svg,
      // so naming the icons again precaches each of them twice — measured, not
      // assumed: `includeAssets: ['favicon.svg', 'pwa-*.png']` puts four files
      // in sw.js in duplicate. The list this replaces was `icons/*.png`, which
      // matched nothing at all, so no icon was ever included by name.
      includeManifestIcons: false,
      // Generated rather than a static public/manifest.json so the paths follow
      // `base`. Every URL in here is relative for the same reason: an installed
      // copy served from /web/ must not launch itself at the site root.
      manifest: {
        name: 'SoftN Web',
        short_name: 'SoftN',
        description: 'Run .softn application bundles in the browser',
        start_url: '.',
        scope: '.',
        display: 'standalone',
        theme_color: '#0c0a09',
        background_color: '#0c0a09',
        // PNG, not the SVG this used to name: Chrome on Android accepts an SVG
        // for neither the install prompt nor a maskable purpose, so a manifest
        // offering only vectors was promising a maskable icon no launcher could
        // mask. `npm run generate-icons` draws these from the same mark as
        // favicon.svg.
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-maskable-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Every document the worker serves gets the isolation headers, from
        // the precache as much as from the network — see public/coi.js.
        importScripts: ['coi.js'],
        // `wasm` is not optional: the scripting engine is a .wasm, so without
        // it every bundle fails to run offline. It is also larger than
        // Workbox's 2 MiB default cap, which would silently skip the file.
        globPatterns: ['**/*.{js,css,html,svg,png,woff2,wasm}'],
        // The ONNX runtime binaries are ~25 MB each and back optional AI
        // features. Precaching them would make first load pay for capabilities
        // most bundles never touch; they are fetched on demand instead.
        //
        // assets/core-runtime/ is a whole copy of @softn/core's dist, put there
        // by coreWorkerAssetPlugin above so the off-main-thread script runtime
        // can reach its worker. That runtime is currently parked — its only
        // import is commented out in core's SoftNRenderer — so nothing fetches
        // any of it, yet globbing swept 23 files and 5.68 MiB into the precache,
        // over half of every visitor's first load, including a second copy of
        // both WASM engines. The copy stays so re-enabling the worker works in
        // dev and production alike; precaching a directory the app never
        // references does not.
        // Optional demos are removed from the default website distribution.
        // Missing demo icons must not prevent the worker from installing.
        globIgnores: ['**/ort-*.wasm', '**/core-runtime/**', '**/demos/**'],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-cache',
              expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
  server: {
    port: env.VITE_PORT ? Number(env.VITE_PORT) : 1420,
    strictPort: true,
    // Cross-origin isolation, as the deployed .htaccess sets it: with it the
    // CPU provider runs a model on every core (SharedArrayBuffer).
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
  },
  build: {
    target: 'es2020',
    sourcemap: true,
  },
});
