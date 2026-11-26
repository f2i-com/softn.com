/**
 * What a SoftN host fetches the first time a page needs it rather than on its
 * first load. softn-web spreads these into its PWA's `globIgnores` and
 * `runtimeCaching`, so its precache is the shell and each app it opens is
 * installed by itself (apps/softn-web/src/lib/offlineInstall.ts); Studio and
 * the Builder install the shared full engine on demand as well.
 * docs/engineering/COMPONENT_LOADING.md has the whole policy; the build-graph
 * tests hold each app's manifest to it.
 *
 * A host registers the built-in components through
 * registerRuntimeComponents() (@softn/components/lazy): the start-up set
 * eagerly, every other component as a loader, so a feature is a chunk of its
 * own that nothing imports statically. What is left in softn-web's precache
 * is the shell: the entry, what it imports statically, and shared archive
 * support. XDB is retained with the classic renderer.
 */

/**
 * The feature entries of @softn/components, as registerRuntimeComponents()
 * loads them: one dynamic import each, so Rolldown emits one chunk each, named
 * after the facade it starts at — dist/scene3d.js becomes
 * assets/scene3d-<hash>.js. Three.js itself is `vendor-three` below.
 */
export const featureChunks = ['scene3d', 'charts', 'editors', 'smart', 'media', 'qr-reader', 'animation', 'pickers', 'games', 'wasm'];

/**
 * The light classic component groups. A classic page's first draw waits for
 * the groups it uses. Its offline installer keeps those groups and their
 * shared chunks using the production manifest (classic-assets.mjs).
 */
export const componentGroupChunks = ['controls', 'feedback', 'data', 'display', 'navigation'];

/**
 * Core's own on-demand modules that only some apps reach, by the name each
 * chunk starts with: `ai-manager-*`, `model-host-*` and
 * `ai-gpu-compute-manager-*` are the AI side (a local model itself runs in
 * core-runtime/runtime/model-worker.js, a worker asset); `xdb-sync-*` the
 * peer sync runtime (yjs) and `xdb-server-sync-*` the directory's server
 * sync; `zipp_torch-*` the loader for the torch Python package (its
 * zipp_torch.wasm is a worker asset); `wasm-host-*` what runs an app's
 * WebAssembly modules (softn.wasm, <WasmApp>), whose worker is made from it
 * as a `blob:`. Each is a dynamic import in core, so each is a chunk of its
 * own. The XDB loader itself is part of the classic renderer's offline group.
 */
export const onDemandRuntimeChunks = [
  'ai-manager',
  'model-host',
  'ai-gpu-compute-manager',
  'xdb-sync',
  'xdb-server-sync',
  'zipp_torch',
  'wasm-host',
];

/**
 * The Three addons Scene3D reaches through its own import() — the model
 * loaders, the controls, the room environment, the readers of a panorama
 * file, the post-processing set (bloom, depth of field, ambient occlusion),
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
  'RGBELoader',
  'EXRLoader',
  'SkeletonUtils',
  'EffectComposer',
  'RenderPass',
  'UnrealBloomPass',
  'BokehPass',
  'GTAOPass',
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
 * Libraries every host bundles, each under a name of its own, so that the same
 * library comes out of each app's build as the same file. Every app here is
 * built on its own, and Rolldown otherwise merged a library into whichever chunk
 * first needed it: React's DOM renderer into each app's entry, the peer-sync
 * stack (yjs, lib0, y-webrtc, simple-peer) into the sync runtime's chunk and
 * the camera scanner (@yudiel/react-qr-scanner, barcode-detector,
 * webrtc-adapter) into the QR reader's. Those chunks import core, which each
 * app tree-shakes its own way, so they never matched, and the site kept one
 * copy of each library per app (shared-assets.mjs keeps one file of a name and
 * content, not two). As a group of its own a library imports nothing that
 * differs between the apps, so the builds agree on its bytes and its name, and
 * a visitor who opens a second app has it already.
 *
 * React is ahead of the others, so the scanner's React import is React's chunk
 * and not a second copy inside the scanner's (a group takes the dependencies of
 * what it captures unless a group ahead of it has them). The sync and scanner
 * groups are reached only through their features' dynamic imports, like the
 * chunks they came out of: onDemandGlobIgnores keeps them out of softn-web's
 * precache as it keeps those.
 */
export const vendorReactGroup = { name: 'vendor-react', test: /node_modules[\\/](?:react|react-dom|scheduler)[\\/]/, priority: 20 };
export const vendorSyncGroup = { name: 'vendor-sync', test: /node_modules[\\/](?:yjs|lib0|y-protocols|y-webrtc|y-indexeddb|simple-peer)[\\/]/, priority: 10 };
export const vendorQrScannerGroup = {
  name: 'vendor-qr-scanner',
  test: /node_modules[\\/](?:@yudiel[\\/]react-qr-scanner|barcode-detector|webrtc-adapter|sdp|zxing-wasm)[\\/]/,
  priority: 10,
};

/** The groups every SoftN host's build splits its chunks by, Three.js included. */
export const sharedChunkGroups = [vendorThreeGroup, vendorReactGroup, vendorSyncGroup, vendorQrScannerGroup];

/** Core's shared JavaScript/Python engine. Vite fingerprints the same file under
 * /assets/ in a standalone build and /shared/assets/ on the combined site. */
export const fullEngineGlob = '**/assets/zipp_wasm_bg-*.wasm';
export const fullEngineRuntimeCaching = {
  urlPattern: /\/assets\/zipp_wasm_bg-[\w-]+\.wasm$/,
  handler: 'CacheFirst',
  options: {
    cacheName: 'softn-full-engine',
    expiration: { maxEntries: 8 },
    cacheableResponse: { statuses: [200] },
  },
};

/**
 * The precache leaves these out. The QR decoder (<QRReader>), ~0.9 MB, is
 * emitted from the host's build; only a scanning app needs it.
 */
export const onDemandGlobIgnores = [
  fullEngineGlob,
  '**/assets/zxing_reader-*.wasm',
  '**/assets/vendor-three-*.js',
  // The libraries of the sync runtime and the QR reader (vendorSyncGroup,
  // vendorQrScannerGroup), fetched with the chunks below that import them.
  '**/assets/vendor-sync-*.js',
  '**/assets/vendor-qr-scanner-*.js',
  '**/assets/webgl-scene-host-*.js',
  '**/assets/local-backend-transport-*.js',
  '**/assets/device-bridge-*.js',
  '**/assets/virtual-nav-bar-*.js',
  '**/assets/guest-indexeddb-*.js',
  '**/assets/guest-three-native-*.js',
  '**/assets/guest-vendors-*.js',
  '**/assets/guest-worker-scope-*.js',
  '**/assets/guest-webgl-*.js',
  '**/assets/guest-react-vendor-*.js',
  '**/assets/three-worker-host-*.js',
  '**/assets/webgl-worker-host-*.js',
  '**/assets/jsx-transform-*.js',
  ...featureChunks.map((name) => `**/assets/${name}-*.js`),
  ...threeAddonChunks.map((name) => `**/assets/${name}-*.js`),
  ...onDemandRuntimeChunks.map((name) => `**/assets/${name}-*.js`),
];

/**
 * The runtime routes that keep what a page fetched on demand, so it works
 * offline after its first use.
 */
export const onDemandRuntimeCaching = [
  fullEngineRuntimeCaching,
  {
    // Every script under assets/ is hashed, so a copy is right for as long as
    // anything references it and a new release references new names:
    // CacheFirst. The precache route is registered ahead of this one and keeps
    // answering for the shell's own files; this answers for the rest — the
    // feature chunks, vendor-three and the Three addons. A pattern written as
    // a path is tested against the path of a same-origin request with no
    // query (sw-route-match.js), so it is same-origin by construction.
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
  {
    // What @softn/container fetches for an app it runs: its Worker, the engine of the app's
    // tier and that engine's bindings, a vendor module. Its folder is named by the digest of
    // its contents (container-runtime-assets.mjs), in the app or under the site's /shared/,
    // so a copy is right for as long as anything asks for it: CacheFirst, like the hashed
    // chunks above. The runtime keeps only what an app it opened needed.
    urlPattern: /\/(?:assets|shared)\/container-runtime\/[0-9a-f]{12}\/.+\.(?:js|wasm)$/,
    handler: 'CacheFirst',
    options: {
      cacheName: 'softn-container-runtime',
      expiration: { maxEntries: 60, maxAgeSeconds: 60 * 60 * 24 * 30 },
      cacheableResponse: { statuses: [0, 200] },
    },
  },
];
