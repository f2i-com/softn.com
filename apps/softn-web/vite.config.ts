import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { coreWorkerAssetPlugin } from '../../scripts/core-worker-assets.mjs';

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};

// The feature entries of @softn/components, as registerRuntimeComponents()
// in main.tsx loads them: one dynamic import each, so Rolldown emits one
// chunk each, named after the facade it starts at — dist/scene3d.js becomes
// assets/scene3d-<hash>.js. Three.js itself is named vendor-three in `build`
// below. test/build-graph.test.ts holds these names to what the manifest
// actually contains.
const featureChunks = ['scene3d', 'charts', 'editors', 'smart', 'media', 'animation'];

// Core's own on-demand modules that only some apps reach, by the name each
// chunk starts with in dist/assets: `ai-manager-*`, `ai-onnx-manager-*`,
// `ai-transformers-manager-*` and `ai-gpu-compute-manager-*` are the AI
// managers; `transformers.web-*` and `ort.bundle.min-*` the runtimes behind
// them; `xdb-sync-*` the peer sync runtime (yjs) and `xdb-server-sync-*` the
// directory's server sync. Each is a dynamic import in core, so each is a
// chunk of its own, and none is fetched until an app asks. `xdb-*` alone —
// the XDB module every app opens — is not in this list and stays precached.
// The build-graph test checks both halves against the emitted names.
const onDemandRuntimeChunks = [
  'ai-manager',
  'ai-onnx-manager',
  'ai-transformers-manager',
  'ai-gpu-compute-manager',
  'transformers.web',
  'ort.bundle.min',
  'xdb-sync',
  'xdb-server-sync',
];

// The Three addons Scene3D reaches through its own import() — the model
// loaders, the controls, the room environment, the post-processing set,
// SkeletonUtils and the Meshopt decoder (docs/SCENE3D_LOADING.md) — each a
// chunk named after its module, plus the two modules the post-processing
// chunks share between them (Pass, CopyShader), which Rolldown emits as
// chunks of their own. They are separate from vendor-three because the
// group in `build` below covers three/build/ only; without a name here the
// glob would precache all fifteen for every visitor — measured: 59 entries
// where the shell is 45. A scene fetches the ones it uses, and the runtime
// rule below keeps them. The build-graph test holds each to being emitted,
// dynamically imported by scene3d and out of the precache.
const threeAddonChunks = [
  'GLTFLoader',
  'OBJLoader',
  'FBXLoader',
  'STLLoader',
  'OrbitControls',
  'RoomEnvironment',
  'SkeletonUtils',
  'EffectComposer',
  'RenderPass',
  'UnrealBloomPass',
  'OutputPass',
  'ShaderPass',
  'Pass',
  'CopyShader',
  'meshopt_decoder.module',
];

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
        // can reach its worker (core's SoftNRenderer starts one for a bundle
        // whose manifest asks for `config.execution: "worker"`). Most bundles
        // never do, yet globbing swept 23 files and 5.68 MiB into the
        // precache, over half of every visitor's first load, including a
        // second copy of both WASM engines. The worker needs three modules and
        // one .wasm of it; the per-app install fetches exactly those, for
        // exactly the apps that run a worker, through the softn-worker-assets
        // route below. The rest of the copy stays for the speech worker and
        // for dev, and precaching it does not.
        // Optional demos are removed from the default website distribution.
        // Missing demo icons must not prevent the worker from installing.
        //
        // The feature chunks, Three.js and its addons are not precached
        // either, and nor are the runtime's own on-demand modules that only
        // some apps reach:
        // the AI managers with the transformers and ORT bundles behind them
        // (~1 MB together, for apps that asked for `ai`), and the peer and
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
        // docs/COMPONENT_LOADING.md has the whole policy; the build-graph
        // test holds the precache to it.
        globIgnores: [
          '**/ort-*.wasm',
          '**/core-runtime/**',
          '**/demos/**',
          '**/assets/vendor-three-*.js',
          ...featureChunks.map((name) => `**/assets/${name}-*.js`),
          ...threeAddonChunks.map((name) => `**/assets/${name}-*.js`),
          ...onDemandRuntimeChunks.map((name) => `**/assets/${name}-*.js`),
        ],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        runtimeCaching: [
          {
            // Every script under assets/ is hashed, so a copy is right for as
            // long as anything references it and a new release references
            // new names: CacheFirst. The precache route is registered ahead
            // of this one and keeps answering for the shell's own files; this
            // answers for the rest — the feature chunks, vendor-three and
            // the Three addons above. A RegExp route matches a cross-origin URL only from its
            // first character, and no absolute URL starts with /assets/, so
            // this is same-origin by construction.
            urlPattern: /\/assets\/[^/?#]+\.js$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'softn-feature-chunks',
              expiration: { maxEntries: 80, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // The script worker's files, which the per-app install fetches
            // for an app whose manifest runs its script in a worker
            // (src/lib/offlineInstall.ts). The route above cannot hold them:
            // they sit two directories down. NetworkFirst rather than
            // CacheFirst because the worker's entry keeps one name across
            // builds — `runtime/script-worker.js` — and a worker served from
            // a cache after a deployment would be the previous release's,
            // talking to this release's main thread. Online it is always the
            // current one, and the copy is refreshed; offline the copy answers.
            // Same-origin by the same construction as the route above.
            urlPattern: /\/assets\/core-runtime\/.+\.(?:js|wasm|json)$/,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'softn-worker-assets',
              networkTimeoutSeconds: 4,
              expiration: { maxEntries: 40, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
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
          groups: [
            // Three.js itself — `three/build/` — under one name. It is reached
            // only through the scene3d feature's dynamic import, so this names
            // a chunk that is already asynchronous; it is not what makes it so
            // — registerRuntimeComponents() in main.tsx does that at the
            // source. The addons under `three/examples/jsm/` are deliberately
            // not in the group: Scene3D reaches each loader, the controls, the
            // environment and the post-processing set through its own
            // import(), so each is a chunk of its own, fetched the first time
            // a scene needs it. A test over `node_modules/three/` swept them
            // all into this chunk — measured at 740 KB against 712 KB for
            // Three.js alone — so a scene with one model and no effects
            // downloaded the bloom pass and three loaders it never used.
            { name: 'vendor-three', test: /node_modules[\\/]three[\\/]build[\\/]/ },
          ],
        },
      },
    },
  },
});
