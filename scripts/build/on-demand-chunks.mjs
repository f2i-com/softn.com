/**
 * What a SoftN host fetches the first time a page needs it rather than on its
 * first load. softn-web spreads these into its PWA's `globIgnores` and
 * `runtimeCaching`, so its precache is the shell and each app it opens is
 * installed by itself (apps/softn-web/src/lib/offlineInstall.ts); Studio and
 * the Builder take only the chunk group, and install everything they ship.
 * docs/engineering/COMPONENT_LOADING.md has the whole policy; the build-graph
 * tests hold each app's manifest to it.
 *
 * A host registers the built-in components through
 * registerRuntimeComponents() (@softn/components/lazy): the start-up set
 * eagerly, every other component as a loader, so a feature is a chunk of its
 * own that nothing imports statically. What is left in softn-web's precache
 * is the shell: the entry, what it imports statically, the engine and the
 * XDB module every app opens.
 */

/**
 * The feature entries of @softn/components, as registerRuntimeComponents()
 * loads them: one dynamic import each, so Rolldown emits one chunk each, named
 * after the facade it starts at — dist/scene3d.js becomes
 * assets/scene3d-<hash>.js. Three.js itself is `vendor-three` below.
 */
export const featureChunks = ['scene3d', 'charts', 'editors', 'smart', 'media', 'animation', 'pickers', 'games'];

/**
 * The light component groups, each a chunk of its own like a feature, but
 * kept in softn-web's precache with the shell: they were in the shell until
 * 2026-10-22, and an app that uses one works offline as it did. A page
 * fetches the ones it draws (its first draw waits for them, a moment from the
 * precache), so a page that draws none parses none of their code. Not in
 * `featureChunks`, which the precache ignores.
 */
export const componentGroupChunks = ['controls', 'feedback', 'data', 'display', 'navigation'];

/**
 * Core's own on-demand modules that only some apps reach, by the name each
 * chunk starts with: `ai-manager-*`, `model-host-*` and
 * `ai-gpu-compute-manager-*` are the AI side (a local model itself runs in
 * core-runtime/runtime/model-worker.js, a worker asset); `xdb-sync-*` the
 * peer sync runtime (yjs) and `xdb-server-sync-*` the directory's server
 * sync; `zipp_torch-*` the loader for the torch Python package (its
 * zipp_torch.wasm is a worker asset). Each is a dynamic import in core, so
 * each is a chunk of its own. `xdb-*` alone — the XDB module every app opens —
 * is not in this list and stays precached.
 */
export const onDemandRuntimeChunks = [
  'ai-manager',
  'model-host',
  'ai-gpu-compute-manager',
  'xdb-sync',
  'xdb-server-sync',
  'zipp_torch',
];

/**
 * The Three addons Scene3D reaches through its own import() — the model
 * loaders, the controls, the room environment, the post-processing set,
 * SkeletonUtils and the Meshopt decoder (docs/engineering/SCENE3D_LOADING.md) — each a
 * chunk named after its module, plus the two modules the post-processing
 * chunks share between them (Pass, CopyShader), which Rolldown emits as
 * chunks of their own. They are separate from vendor-three because that group
 * covers three/build/ only: a scene fetches the ones it uses.
 */
export const threeAddonChunks = [
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

/**
 * Three.js itself — `three/build/` — under one name. It is reached only
 * through the scene3d feature's dynamic import, so this names a chunk that is
 * already asynchronous. The addons under `three/examples/jsm/` are
 * deliberately not in the group: a test over `node_modules/three/` swept them
 * all into this chunk — measured at 740 KB against 712 KB for Three.js alone —
 * so a scene with one model and no effects downloaded the bloom pass and three
 * loaders it never used.
 */
export const vendorThreeGroup = { name: 'vendor-three', test: /node_modules[\\/]three[\\/]build[\\/]/ };

/**
 * The precache leaves these out. The QR decoder (<QRReader>), ~0.9 MB, is
 * emitted from the host's build; only a scanning app needs it.
 */
export const onDemandGlobIgnores = [
  '**/assets/zxing_reader-*.wasm',
  '**/assets/vendor-three-*.js',
  ...featureChunks.map((name) => `**/assets/${name}-*.js`),
  ...threeAddonChunks.map((name) => `**/assets/${name}-*.js`),
  ...onDemandRuntimeChunks.map((name) => `**/assets/${name}-*.js`),
];

/**
 * The runtime routes that keep what a page fetched on demand, so it works
 * offline after its first use.
 */
export const onDemandRuntimeCaching = [
  {
    // Every script under assets/ is hashed, so a copy is right for as long as
    // anything references it and a new release references new names:
    // CacheFirst. The precache route is registered ahead of this one and keeps
    // answering for the shell's own files; this answers for the rest — the
    // feature chunks, vendor-three and the Three addons. A RegExp route
    // matches a cross-origin URL only from its first character, and no
    // absolute URL starts with /assets/, so this is same-origin by construction.
    urlPattern: /\/assets\/[^/?#]+\.js$/,
    handler: 'CacheFirst',
    options: {
      cacheName: 'softn-feature-chunks',
      expiration: { maxEntries: 80, maxAgeSeconds: 60 * 60 * 24 * 30 },
      cacheableResponse: { statuses: [0, 200] },
    },
  },
  {
    // The QR decoder, hashed like the chunks above and fetched the first time
    // an app scans; kept so scanning works offline after.
    urlPattern: /\/assets\/zxing_reader-[^/?#]+\.wasm$/,
    handler: 'CacheFirst',
    options: {
      cacheName: 'softn-qr-decoder',
      expiration: { maxEntries: 2, maxAgeSeconds: 60 * 60 * 24 * 30 },
      cacheableResponse: { statuses: [0, 200] },
    },
  },
  {
    // The workers' files under assets/core-runtime/ (the script worker of an
    // app that runs in one, the local-model worker). The route above cannot
    // hold them: they sit two directories down. NetworkFirst rather than
    // CacheFirst because a worker's entry keeps one name across builds —
    // `runtime/script-worker.js` — and a worker served from a cache after a
    // deployment would be the previous release's, talking to this release's
    // main thread. Online it is always the current one, and the copy is
    // refreshed; offline the copy answers.
    urlPattern: /\/assets\/core-runtime\/.+\.(?:js|wasm|json)$/,
    handler: 'NetworkFirst',
    options: {
      cacheName: 'softn-worker-assets',
      networkTimeoutSeconds: 4,
      expiration: { maxEntries: 40, maxAgeSeconds: 60 * 60 * 24 * 30 },
      cacheableResponse: { statuses: [0, 200] },
    },
  },
];
