import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { softnPwa } from '../../scripts/pwa.mjs';
import { coreWorkerAssetPlugin } from '../../scripts/core-worker-assets.mjs';
import { retireServiceWorkersPlugin } from '../../scripts/dev-service-worker.mjs';
import { scriptPolicyPlugin } from '../../scripts/script-policy.mjs';
import { onDemandGlobIgnores, onDemandRuntimeCaching, vendorThreeGroup } from '../../scripts/on-demand-chunks.mjs';

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};

// What is fetched the first time a page needs it, the same for Studio and the
// Builder: scripts/on-demand-chunks.mjs. test/build-graph.test.ts holds the
// names to what the manifest actually contains.

export default defineConfig({
  // Serving from a subpath such as /web/ is a deployment decision, so the base
  // is an env var rather than a constant.
  base: env.VITE_BASE || '/',
  plugins: [
    retireServiceWorkersPlugin(),
    react(),
    coreWorkerAssetPlugin(),
    // What runs as script: this deployment's files only (scripts/script-policy.mjs).
    scriptPolicyPlugin(),
    softnPwa({
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
        // assets/core-runtime/ is a whole copy of @softn/core's dist, put there
        // by coreWorkerAssetPlugin above so the off-main-thread script runtime
        // can reach its worker (core's SoftNRenderer starts one for a bundle
        // whose manifest asks for `config.execution: "worker"`). Most bundles
        // never do, yet globbing swept 23 files and 5.68 MiB into the
        // precache, over half of every visitor's first load. The worker needs
        // three modules of it, and no engine: the page posts it the engine it
        // compiled, the one precached copy, and the copy here carries none.
        // The per-app install fetches exactly those modules, for exactly the
        // apps that run a worker, through the softn-worker-assets route below.
        // The rest of the copy stays for the model worker and for dev, and
        // precaching it does not.
        // Optional demos are removed from the default website distribution.
        // Missing demo icons must not prevent the worker from installing.
        //
        // The feature chunks, Three.js and its addons are not precached
        // either, and nor are the runtime's own on-demand modules that only
        // some apps reach:
        // the AI side (tens of kilobytes, for apps that asked for `ai`;
        // the model worker is a core-runtime asset), and the peer and
        // server sync runtimes (~200 KB, for apps that asked for `sync` or
        // configured a server). What is precached is the shell: the entry,
        // what it imports statically, the engine's wasm, the inflate worker
        // and the XDB module every app opens. Everything else is fetched
        // the first time a document or a script needs it and kept by the
        // runtime rule below. So there are three tiers: the shell precache
        // (this glob), the runtime cache of hashed chunks
        // (softn-feature-chunks), and the per-app offline install in
        // src/lib/offlineInstall.ts, which fetches exactly the features an
        // app's documents can reach — every branch — plus the sync runtime
        // when the app asked for it and the worker's files when its script
        // runs in one, and only then calls the app offline-ready. The AI
        // runtime stays online by design: its models are downloads.
        // docs/engineering/COMPONENT_LOADING.md has the whole policy; the build-graph
        // test holds the precache to it.
        globIgnores: [
          '**/core-runtime/**',
          '**/demos/**',
          ...onDemandGlobIgnores,
        ],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        runtimeCaching: [
          ...onDemandRuntimeCaching,
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
    // dist/.vite/manifest.json: the entry's static import closure, which
    // test/build-graph.test.ts holds free of Three.js and the model loaders,
    // and which the service-worker policy above is defined against.
    manifest: true,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [vendorThreeGroup],
        },
      },
    },
  },
});
