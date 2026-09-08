# Response to the 8 September 2026 demand-loading audit

The audit reviewed softn.com at `e9fccda` (release 0.0.7) and came with an
implementation brief, `SoftN-implementation-handoff.md`, in seven change sets:
a measured baseline, isolation and request policy, trusted feature module
boundaries, offline installation and deployment, archive and source loading,
Three.js startup and lifecycle, and a set of smaller correctness and HTTP
fixes. This is what was done about each, and where. What the brief asked for
and this tree does not do is listed at the end as open, with what a decision
on it would involve. The measurements the brief insists on — production
build, workload, device, cache state and method, before and after — are in
the last section.

## Fixed

| ID | Finding | What changed | Where |
|---|---|---|---|
| B01 | No phase boundaries on the timeline; page and service-worker bytes not told apart | Every host writes the same guarded `performance.mark('softn:<phase>:start' / ':end')` pairs: `bundle-fetch`, `digest`, `zip` (archive index plus text entries), `asset-extract` (a main-thread inflate on demand), `asset-warm` (the worker warm-up), `compose`, `parse`, `component-preload`, `vm-init`, `xdb-seed` and `offline-install`. Scene3D marks three instants: `scene3d-renderer-ready`, `scene3d-assets-ready`, `scene3d-first-frame`. The harness attributes requests to the page, the service worker and any dedicated worker separately and reports the precache apart from the first screen. | `core/loader/SoftNRenderer.tsx` (`perfMark`), `softn-web/src/App.tsx`, `softn-single/src/load.ts`, `softn-web/src/lib/bundleProcessor.ts`, `zipWarmup.ts`, `offlineInstall.ts`, `components/threed/milestones.ts`; tests `softn-single/test/load.test.ts` ("marks each startup phase"), `components/test/scene3d-milestones` |
| B02 | No measurement method; a performance claim would have no build, workload, device or cache state behind it | A harness serves a production build of either host with the deployment's isolation and cache headers, opens fixed fixtures in headless Edge or Chrome over the DevTools protocol, fresh profile per run, cold (cache off) then warm (cache on, service worker controlling, or `--bypass-sw`), and records requests by context and kind, 3D module URLs and 3D code inside loaded scripts, the `softn:` marks, paint and navigation timing, first WebGL context and draw, long tasks, main-thread totals and errors, with the environment block beside the numbers. `compare.mjs` diffs two labels and names every row that got worse. | `scripts/bench/measure.mjs`, `scenarios.mjs`, `glb.mjs`, `compare.mjs`, `fixtures/`; results in `scripts/bench/results/baseline-0.0.7/`, `after-dynamic-loading/`, `after-dynamic-loading-sw-bypassed/`; `docs/PERFORMANCE_MEASUREMENT.md` |
| B03 | No build-graph assertion; a regression would be a surprise on a phone | Both hosts build with `build.manifest` on, and a test reads the manifest, walks the entry's static import closure, prints its bytes, holds it under 1 MB and free of Three.js, the model loaders and post-processing, and checks each feature is a dynamic entry that nothing imports statically (and, since C05, that each Three addon is one too). The web test also holds the precache to the closure plus the inflate worker and the XDB module, and none of the feature, addon or on-demand runtime chunks. | `softn-web/test/build-graph.test.ts`, `softn-single/test/build-graph.test.ts`, `softn-web/vite.config.ts`, `softn-single/vite.config.ts` |
| I01 | Implicit current-app database resolution; a handler that yielded wrote into whichever app rendered last | The app a component belongs to is React context. `SoftNRenderer` publishes `{ appId, xdb, active, assets }` through `AppScopeProvider`; `useAppScope`, `useAppXDB`, `useAppActive` and `useAppAssets` read it at render time, so the store a callback captured is the one it uses however long it suspends. `useCollection` and `useRecord` read the same context (the object lives in `runtime/app-scope-context.ts`, below `xdb.ts`). `SmartForm` takes its store at render instead of after an awaited import. `createBundleRuntime` takes an `appId` so its seeder and its components agree on a store. `setActiveXDBApp` is deprecated and no longer called; the no-argument lookup is the shared default and nothing moves it. | `core/loader/app-scope.tsx`, `core/runtime/app-scope-context.ts`, `core/runtime/xdb.ts`, `core/loader/SoftNRenderer.tsx`, `core/bundle/runtime.tsx`, `components/smart/SmartForm.tsx`, `softn-web/src/components/AppRunner.tsx` (`active` per tab); tests `core/test/app-scope-isolation`, `xdb-hooks-scope`, `xdb-isolation`, `components/test/smart-form-scope` |
| I02 | A model's buffers and images were fetched unjudged through Three's global loading manager, and a bundle model's relative URIs resolved against a `blob:` URL | Every model load gets a `LoadingManager` of its own — never `DefaultLoadingManager`, never one shared between loads — whose URL modifier decides each URL before Three dispatches it: a bundle model's relative URI is resolved against the archive directory the host's resolver names (`pathOf(url)` maps the minted object URL back to `models/hero/hero.gltf`) and answered with the host's own object URL; anything else is judged by the same egress policy as the model; a refusal, an escape above the bundle root or a missing file becomes `data:,`, so nothing is requested and the model fails closed with the refused URL in its error. The policy is read at each decision, so a consent answered while a model is in flight applies to the rest of it. | `components/threed/model-resources.ts`, `model-loaders.ts`, `Scene3D.tsx`; `softn-web/src/lib/bundleProcessor.ts` (`AssetResolver.pathOf`); tests `components/test/scene3d-resources` ("never requests a buffer on a host the bundle was not granted", "leaves three's global loading manager alone", "sends no request for a path that climbs out of the bundle") |
| I03 | Remote imports followed redirects and only checked the final URL, after the forbidden host had been reached | `createImportResolver` fetches with `redirect: 'error'`, so the browser rejects at the first redirect response and the hop's target is never requested; the final-URL check stays as defence in depth. Cancellation on dispose and the body byte cap are tested with it. | `softn-web/src/lib/bundleProcessor.ts`; tests `softn-web/test/bundleProcessor.test.ts` ("asks fetch to refuse redirects", "makes no follow-up request when the browser refuses a redirect", "re-checks redirects and caps remote import bodies") |
| C01 | One barrel: importing anything from `@softn/components` put Three.js, four model loaders and the bloom pass into every shell | The package exports entries — `minimal`, `lazy`, `theme`, `scene3d`, `charts`, `editors`, `smart`, `media`, `animation` — each a tsup entry with its own types; the root barrel is kept as the explicit compatibility path for Studio, the Builder, the desktop loader and the Vite plugin. `sideEffects: false`; every `three` import, static or dynamic, is external to the package build so the host decides where Three.js lands. The eager `builtinComponents` record is the union of the entries, so the two registration paths cannot name different sets. | `components/package.json`, `tsup.config.ts`, `src/entries/*`, `src/registry.ts`; test `components/test/lazy-entries.test.ts` (importing `lazy` evaluates nothing from `threed/`) |
| C02 | No lazy registry; a rejected `React.lazy` load is cached and an error boundary reset re-throws it | `ComponentRegistry` takes loaders (`registerLazy`, `registerAllLazy`) beside components. `get()` returns one stable wrapper per lazy name, so a document re-render never remounts the region; the wrapper renders the entry's current `React.lazy` instance under its own `Suspense` placeholder (`role="status"`) and its own error boundary, and a preloaded component renders directly with no placeholder frame. The loader runs at most once per generation; `retry(name)` bumps the generation, replaces the lazy instance and re-keys the boundary so the cached rejection is gone. The boundary offers **Retry**, and **Reload** when the failure looks like a chunk no longer on the server (`isMissingChunkError`). `preload`, `load`, `getLoadState`, `isLoaded`, `getFeature` are there for hosts. | `core/renderer/registry.ts`, `core/renderer/lazy-component.tsx`; tests `core/test/lazy-registry.test.tsx` |
| C03 | The two browser hosts booted differently and both from the barrel | `registerRuntimeComponents()` from `@softn/components/lazy` is the one bootstrap in `softn-web` and `softn-single`: the minimal set eagerly, every other built-in by a loader that is one `import()` of a feature entry followed by the named export — never the barrel, never a live map of static references. The shells import `Spinner`, `Box`, `Text`, `Card` from `minimal` and `ThemeProvider` from `theme`. Both Vite configs name `node_modules/three/build/` `vendor-three` (Three's own build; the addons are outside the group, C05); the comment and the build-graph test both say that names a chunk that is already asynchronous and is not what makes it so. | `softn-web/src/main.tsx`, `App.tsx`, `components/AppRunner.tsx`, `vite.config.ts`; `softn-single/src/main.tsx`, `SingleApp.tsx`, `vite.config.ts`; tests both `build-graph.test.ts` |
| C04 | Prefetch policy: every branch, or nothing | After a parse succeeds, `SoftNRenderer` preloads `collectFirstScreenTags(doc)` between `softn:component-preload` marks while the VM comes up. The walk takes element children, `#each` bodies and `#empty` fallbacks, slot fallbacks and template-slot children, and skips every `#if`/`#elseif`/`#else` arm and every element with an inline `if={}` — a Scene3D behind `#if page === 'game'` is a later route and is resolved by the wrapper on first render. No bootstrap hint was needed. | `core/renderer/document-tags.ts`, `core/loader/SoftNRenderer.tsx`; tests `core/test/document-tags.test.ts`, `lazy-registry` ("preloads each idle loader once and skips eager, unknown and started names") |
| O01 | The service worker precached every script, feature or not, for every visitor | Three tiers. The precache is the shell: the entry closure, its CSS and fonts, the engine's wasm, the inflate worker and the XDB module; `globIgnores` drops `vendor-three-*`, the six feature chunks, the Three addon chunks (C05) and core's on-demand modules (`ai-manager`, `ai-onnx-manager`, `ai-transformers-manager`, `ai-gpu-compute-manager`, `transformers.web`, `ort.bundle.min`, `xdb-sync`, `xdb-server-sync`). A `CacheFirst` route (`softn-feature-chunks`, 80 entries, 30 days) keeps hashed `/assets/*.js` chunks the first time a document needs them; a `NetworkFirst` route (`softn-worker-assets`) holds the script worker's files, whose entry keeps one name across builds. The build precaches 44 entries, 6,314.59 KiB; the measured precache traffic fell from 8,508 KB stored to 6,344 KB and from 1,294 KB to 334–345 KB on the wire. | `softn-web/vite.config.ts`; tests `softn-web/test/build-graph.test.ts` ("precaches the entry closure and not the feature chunks", "leaves the on-demand runtime chunks to the runtime cache and keeps the inflate worker and XDB precached") |
| O02 | "Offline" was an unqualified promise for every possible future branch | An app is marked offline-ready only after an install: `requiredFeatures(source)` walks `collectAllComponentTags` — every arm of every branch — over the composed source; `installAppOffline` waits for a controlling service worker (up to 10 s; nothing is counted before one), loads every required feature through the registry (retrying a cached rejection), preloads the sync runtime for an app that asked for `sync` (`preloadSyncRuntime()` performs the same `import('./xdb-sync')` as `startSync`), fetches the script worker's graph with `cache: 'reload'` for an app whose manifest runs its script in a worker, and reports `{ ready, features, missing, workerAssets, optionalOnline }`. AI stays online by design (`optionalOnline: ['ai']`); server storage and `config.server` sync are network features and are not installed. The result is written on the cache record with the build id; the launcher shows **Offline ready**, **Installing…** or **Needs connection** as text. The install runs in the background after the app opens, keyed by record, aborted with its tab. | `softn-web/src/lib/offlineInstall.ts`, `appCache.ts` (`OfflineState`, `setOfflineState`, `currentBuildId`, `isOfflineReady`), `App.tsx`, `components/Launcher.tsx`; `core/renderer/document-tags.ts` (`collectAllComponentTags`), `core/runtime/xdb-sync-preload.ts`, `core/package.json` (`./bundle` export); tests `softn-web/test/offlineInstall.test.ts`, `core/test/document-tags.test.ts` |
| O03 | No defined behaviour when a required old chunk is gone after a deployment | A failed feature load that looks like a missing chunk says the app was updated while open and offers **Reload** beside **Retry**. An offline record carries the build it was installed against (`VITE_BUILD_ID`, else the entry chunk's hash) and is installed again when the shell is a different build. The requirement to keep the previous release's hashed assets alongside the new ones for one release is documented for whoever runs the deployment; the build script is unchanged (see X04). | `core/renderer/lazy-component.tsx`, `softn-web/src/lib/appCache.ts`, `docs/COMPONENT_LOADING.md` ("Deploying"); tests `lazy-registry` ("reads a missing chunk as an update and offers Reload beside Retry"), `offlineInstall` (`isOfflineReady` against a build id) |
| A01 | The whole archive was inflated at open; a bundle with one corrupt image did not open at all | `openBundleArchive(data)` validates the central directory in full first — matching entry counts, no ZIP64, stored or deflate only, the per-entry and total size limits, no duplicate names or headers, every payload inside the file, escaping names dropped — and reads text entries at once, because the composer needs them all. Binary entries are indexed and inflated on the first `read()` that asks, each charged to the same running budget, into a buffer of exactly its declared size, refused unless length and CRC-32 match. `readBundleEntries` is `openBundleArchive(data).readAll()`, so the eager readers and the demand-reading hosts share one interpretation of headers, names, sizes and checksums. The hosts' `binaryFiles` is a `BundleBinaryStore` shaped like the `Map` it replaced; `has`, `keys`, `size`, `declaredSize` read nothing. A corrupt entry fails on the read that touches it with the same message, is remembered, and resolves to no URL. `release()` through the asset resolver's `dispose()` frees the bytes on tab close and unmount. The synchronous `asset()` contract is kept: an entry not yet read is inflated on the main thread, memoised, and minted once. | `core/bundle/zip.ts` (`BundleArchive`, `openBundleArchive`, `inflateEntries`), `softn-web/src/lib/bundleProcessor.ts` (`readZip`, `BundleBinaryStore`, `createAssetResolver`), `softn-web/src/App.tsx`, `softn-single/src/SingleApp.tsx`; tests `core/test/bundle-archive.test.ts`, `softn-web/test/bundleProcessor.test.ts` |
| A02 | Extraction on the main thread; a worker that copied the archive and every asset back would not have helped | After composition, without being awaited, `warmFirstScreen` picks the manifest icon and every `asset("…")` literal in source order (cut at 32 entries or 64 MB declared), creates a module worker from app source, hands it one copy of the archive (the main thread keeps its own for synchronous reads), asks for about 2 MB of names per step, and receives the inflated buffers in the transfer list. `BundleArchive.warm` verifies every buffer against the central directory on the main thread before keeping it — a worker is a peer, not an authority. No `Worker`, a worker that fails, errors or is silent for 20 s, or an abort, and the warm-up carries on synchronously in the same steps with a yield between them; releasing the archive stops it. The worker imports the reader from `@softn/core/bundle`, core's own entry, and is a 10,145-byte chunk (1.35 MB through the barrel). | `softn-web/src/lib/zipWarmup.ts`, `zipWorker.ts`, `core/bundle/zip.ts` (`warm`, `WARM_CHUNK_BYTES`), `softn-single/src/load.ts`; tests `core/test/bundle-archive.test.ts` ("warm"), `softn-single/test/load.test.ts` ("warms the assets the source names by literal"), `softn-web/test/build-graph.test.ts` (worker chunk under 50 KB and precached) |
| A03 | "Lazy extraction reduces downloaded bytes" must not be claimed | It is not claimed. The whole archive is still fetched and digested before anything above runs; the bundle bytes in the measurement are unchanged (1.4 / 2.2 / 2.3 KB per fixture). The demand read saves inflate time and resident memory for entries an app does not touch, and that is all it saves. The reason — identity and every check hang off the complete archive — and what a range or sidecar design would need are written down. | `docs/BUNDLE_LOADING.md` ("What this does not change: downloaded bytes") |
| A04 | Source parsed once per stage; VM state and subscriptions must stay per instance | `parseCached(source, version = PARSER_VERSION)` keeps the last eight documents, least recently used out first, keyed by the source string and the parser version; `SoftNWithXDB` and the `SoftNRenderer` it wraps are handed the same object — one parse per load where there were two. A throwing parse stores nothing. The VM, XDB subscriptions and permission checks are still created per renderer instance from that document, in the order they always were. The AST audit of `loader/`, `renderer/`, `runtime/` and `bundle/` found no write into a parsed node; the proof deep-freezes the very instance the cache holds and mounts it through both renderers, under StrictMode and across a source swap, clicking through state changes. | `core/parser/parse-cache.ts`, `core/parser/parser.ts` (`PARSER_VERSION`), `core/loader/SoftNRenderer.tsx`; tests `core/test/parse-cache.test.tsx`, `core/test/ast-immutability.test.tsx` |
| T01 | Scene3D imported every format loader, the controls, the room environment and five post-processing modules statically | `three` is the one static import. GLTF, OBJ, FBX and STL loaders, OrbitControls, RoomEnvironment, the post-processing set, SkeletonUtils and the Meshopt decoder are each fetched on first need, once per page, with a failed import forgotten so the next scene retries. The format comes from `modelFormat`, else the archive path (a minted object URL has no extension), else `gltf`. A scene renders plainly until its chain, controls or environment arrive. (What the host build does with those modules — one chunk per addon — is C05.) | `components/threed/Scene3D.tsx`, `model-loaders.ts`, `effects.ts`; test `components/test/scene3d-loading.test.tsx` (counts module evaluations per feature) |
| T02 | No model states, progress, retry or cancel; `onReady` meant an empty world | `onModelState({ objectId, state, attempt, error? })` reports `pending`, `loaded`, `error` per model; a change of the object's numeric `reload` is a new attempt on the same URL; the stale-request rule is unchanged. `onReady` keeps its meaning (context drawn, world possibly empty); `onAssetsReady` fires when every model the scene opened with has settled, loaded or failed; `onFirstFrame` is the frame after that — each with its `performance.mark`. | `components/threed/milestones.ts`, `Scene3D.tsx`; tests `components/test/scene3d-milestones.test.tsx` |
| T03 | No bounded template cache; instances shared skeletons and materials, and removing one disposed another's | `ModelTemplateCache`: one load per key (app id, URL, format) produces a template that is never placed in a scene; concurrent acquires share the load; every scene object is a clone. Geometry and textures belong to the template and are disposed only on eviction; each instance owns its cloned materials and, for a skinned model, its skeleton (`SkeletonUtils.clone`). Instances are released, never disposed; a template with no holders stays for reuse up to 16 idle templates, least recently used first out; a template in use is never evicted; `reload` invalidates without pulling the template from under its holders. | `components/threed/model-cache.ts`, `Scene3D.tsx`; tests `components/test/scene3d-model-cache.test.ts`, `scene3d-lifecycle.test.tsx` ("releases a model that finishes loading after unmount to the cache, which disposes it") |
| T04 | Post-processing rebuilt for a tuning change and its passes leaked; groups replaced wholesale | Which effects are on decides which passes exist; strength, radius, threshold, vignette and grain are written into the running passes. Switching an effect rebuilds the chain and disposes every pass the old one owned, as does unmount. A group's children are reconciled by id: a persisting id is patched in place (transform, material, geometry when its dimensions changed, its own children when it is a group), a gone id is disposed, a new id is built, an unchanged spec object is not looked at. | `components/threed/effects.ts`, `Scene3D.tsx`; tests `components/test/scene3d-effects.test.tsx`, `scene3d-groups.test.tsx` |
| T05 | Hidden tabs kept rendering; resume jumped the hidden interval | The render loop runs only while `useAppActive()` (false for a background softn-web tab, which passes `active` per tab) and `document.visibilityState` both say yes; nothing is disposed while stopped, and the clock is re-baselined before the first frame after resume. The first frame is still drawn at mount so `onReady` means what it says. | `components/threed/activity.ts`, `Scene3D.tsx`, `core/loader/app-scope.tsx`, `softn-web/src/components/AppRunner.tsx`; tests `components/test/scene3d-activity.test.tsx` |
| T06 | Codecs: nothing said which were supported, and a decoder pool per model was the risk | Codec needs are read from the asset before the parser sees it. `EXT_meshopt_compression` fetches the self-contained Meshopt decoder on demand. `KHR_draco_mesh_compression` and a required `KHR_texture_basisu` fail early with a message naming the decoder this build does not ship; a merely used KTX2 texture loads with those textures missing, as the extension allows. Nothing is downloaded just in case. | `components/threed/model-loaders.ts`; tests `components/test/scene3d-loading.test.tsx` ("codecs are taken from the asset, not in advance") |
| H01 | The browser XDB import merge kept two rows for one newly imported id | `import()` builds one id-keyed index per collection from the stored rows, applies the incoming rows in order — last value wins, an existing id keeps its place, an unseen id appends — and writes once per collection; `merge: false` goes through the same index and, on Tauri, sends the `clear_collection` the memory swap alone did not. A row that is not an object with a non-empty string id, or a collection that is not an array, is skipped and counted in `skipped`. The handoff's isolated reproduction is ported into the service's suite. | `core/runtime/xdb.ts` (`import`, `isImportableRecord`, `XDBImportResult`); tests `core/test/xdb-import-merge.test.ts` (browser, localStorage under an app prefix, Tauri) |
| H02 | The standalone host ran every script on the main thread; the same bundle ran in a worker in the launcher | `loadApplication` reads `config.execution` the way `inspectBundle` does — the literal `'worker'` asks for a worker, anything else is main — and `SingleApp` forwards it as `executionPreference`, subject to the renderer's existing compatibility checks; it also passes the asset resolver so bundle models resolve their subresources. The runtime doc says rendering, 3D scenes included, stays on the main thread either way. | `softn-single/src/load.ts`, `SingleApp.tsx`, `docs/SINGLE_APP_RUNTIME.md`; tests `softn-single/test/load.test.ts` ("forwards manifest config … as execution …") |
| H03 | A saved sync room seeded a "connecting" flag nothing was clearing, and survived exactly one reload | `buildRunnerInitialState` seeds the page and the saved room and no connection flag; the flag belongs to the app's own sync control, which sets it when it calls `startSync` and clears it on a status. The room is read from the app-namespaced key core writes (`xdb-sync-active-room:<appId>`). The renderer's mount-time cleanup calls the new `closeSyncRoom(room, appId)`, which releases a leftover adapter and leaves the saved key alone; `stopSync` still forgets the room, as leaving one should. | `softn-web/src/lib/runnerState.ts`, `components/AppRunner.tsx`, `core/runtime/xdb-sync.ts`, `core/loader/SoftNRenderer.tsx`; tests `softn-web/test/runnerState.test.ts`, `core/test/xdb-sync.test.ts` (the saved key survives two mounts) |
| H04 | The bundle endpoint sent an `ETag` but never evaluated it; no `HEAD`; ranges unspecified; one cache rule for "latest" and a version | `Request::ifNoneMatch` compares the weak way RFC 9110 prescribes for this header (`W/` ignored, `*` matches, tags picked out by their quotes) and a match is a bodiless `304` that repeats `ETag`, `Cache-Control` and `Content-Type` (PHP would otherwise relabel a stored archive as HTML). `HEAD` is routed as `GET` and `Response::send` leaves the body out, `Content-Length` included. `bundle.softn` with no `v=` is `no-cache, must-revalidate`; `bundle.softn?v=N` is `public, max-age=86400` — a day, not immutable, because an unpublish, a purge or the seed replacing a demo's v1 has to reach every cache. `Accept-Ranges: none` is stated rather than left to the host (Apache would slice a script's output into a 206 on its own). CORS allows `If-None-Match` and exposes `ETag`, `Content-Disposition`, `Retry-After`. | `softn-api/index.php`, `softn-api/lib/http.php`, `softn-api/README.md` ("Caching a bundle"); tests `softn-api/test/api.test.mjs` ("a bundle revalidates by ETag, answers HEAD, and holds a version-addressed URL for a day", "a page on another origin can revalidate a bundle and read its ETag" — run when PHP is on the path) |
| C05 | The `vendor-three` chunk carried every Three addon: `codeSplitting.groups` in both Vite configs put everything under `node_modules/three/` into one 740 KB chunk the scene3d chunk imported statically, so a scene with one glTF and no effects downloaded the bloom pass and three loaders it never used | The group's test is `node_modules/three/build/` — Three itself, and nothing more. Each addon Scene3D reaches through `import()` (T01) is now a chunk of its own, named after its module (`GLTFLoader-<hash>.js`, `OrbitControls-*`, `RoomEnvironment-*`, `SkeletonUtils-*`, `meshopt_decoder.module-*`, and the five post-processing modules with the two helpers they share, `Pass-*` and `CopyShader-*`). `vendor-three` is 571 KB where it was 740; the addons are 1–47 KB each; the entry closure is one chunk in both hosts (the `rolldown-runtime` helper folded in). The web precache ignores all fifteen (`threeAddonChunks`), so it is back to the shell: 44 entries. The scene3d chunk's static closure is itself, `vendor-three` and the entry — nothing inlined, checked by reading Rolldown's manifest. Measured: `scene-glb` requests `scene3d`, `vendor-three` and `GLTFLoader` and no other addon; `scene-effects` adds the five post-processing chunks and their two helpers; "3D code inside loaded JS" names `postprocessing` and `bloom` only in `scene-effects`. (The harness's signatures for those two had to change with it: the scene3d chunk now *names* `EffectComposer` and `UnrealBloomPass` in its import specifiers and property accesses without containing them, so the check is for the render-target names the modules write themselves, `EffectComposer.rt1` and `UnrealBloomPass.h`/`.v`.) | `apps/softn-web/vite.config.ts` (`threeAddonChunks`, the narrowed group), `apps/softn-single/vite.config.ts`; tests `apps/softn-web/test/build-graph.test.ts` and `apps/softn-single/test/build-graph.test.ts` ("keeps every Three addon out of the scene3d chunk's static closure and reaches it by dynamic import"; the web one also holds each addon chunk emitted and out of the precache); `scripts/bench/measure.mjs` (`HEAVY_CODE`) |
| H05 | Every app fetched the peer sync runtime: `SoftNWithXDB`'s mount-time cleanup did `import('../runtime/xdb-sync')` to ask whether a room was saved, so `xdb-sync-*` (199 KB, yjs included) was requested by every app in both hosts on every cold visit, `sync` or not | The saved-room key is read first, through `runtime/xdb-sync-key.ts` — a module that imports nothing and holds the one spelling of the key (`getSyncRoomKey`, `readSavedSyncRoom`); `xdb-sync.ts`'s `getSyncRoomKey` and `getSavedSyncRoom`, and the renderer's three other by-hand readers of the key, now use it, so the rule cannot drift — and the sync module is imported only when a room is saved, to close its adapter. An app with nothing saved loads nothing. Measured: `xdb-sync-*` is no longer among the scripts the `minimal` fixture requests in either host (its cold page scripts are the entry and the XDB module), and the web host's warm pass no longer writes it into the runtime cache. | `packages/@softn/core/src/runtime/xdb-sync-key.ts`, `packages/@softn/core/src/runtime/xdb-sync.ts`, `packages/@softn/core/src/loader/SoftNRenderer.tsx`; test `packages/@softn/core/test/xdb-sync-mount.test.tsx` (the mock factory counts module loads: none without a saved room, none for another app's room, one with — and the room survives the close) |

## Open

| ID | Finding | What a decision would involve |
|---|---|---|
| X01 | Deferred app-logic semantics | The brief is explicit that this is a language and semantics change, not a consequence of lazy host components, and nothing here defers a `.logic` block. A decision would define what a not-yet-loaded module's state, events and ordering mean to a document that references it, and add the source-expansion, node and depth budgets the brief asks for when composition is redesigned. |
| X02 | Authenticated partial-archive delivery | Downloaded bytes are unchanged (A03). Fetching entries on demand would need metadata bound to the bundle's identity with a hash per entry, correct HTTP range support with its failure modes, a full-download fallback for hosts and caches that cannot serve ranges, and the portable single-file archive kept as an interchange format. The API's `Accept-Ranges: none` (H04) is the current answer. |
| X03 | Draco and KTX2 decoder shipping | Both fail early today with a named reason (T06). Shipping them means serving the decoders from the site itself so offline installation holds, a shared bounded decoder pool, renderer capabilities configured before any KTX2 work, and a measurement — decoder bytes, decode and transcode time, GPU upload, visual regressions — against the devices the site targets, alongside plain GLB and Meshopt. |
| X04 | Retaining previous hashed assets at deployment | The requirement is documented (`docs/COMPONENT_LOADING.md`, "Deploying") and the tab-side behaviour exists (O03), but `scripts/build-site.mjs` still empties `dist/` and the release workflow does not carry the previous release's `web/assets/` and `single/assets/` forward. A decision picks the mechanism (copy the old directory first, or sync without deletion and prune after two releases) and adds a check that a tab open across a deployment still opens a scene. |
| X05 | An asynchronous asset descriptor for host components | `asset()` stays synchronous, so an entry the warm-up has not reached is inflated on the main thread at first use (A01). Letting components accept an asynchronous descriptor or resolver is a component-API change; the archive's `warm()` and `BundleBinaryStore.isRead()` are the pieces it would build on. |
| X08 | Phases the brief names that are not yet marked | Texture preparation, shader preparation and interaction readiness have no marks; `compileAsync` was not evaluated, and the first useful frame is measured as the frame after assets settle (`scene3d-first-frame`), not as a shader-warm frame. `softn:asset-extract` reads 0 ms in every run because the fixtures' one model is warmed by the worker before the first `asset()` call; a fixture with a dynamic `asset(path)` would exercise it. |
| X09 | Workloads the brief asks for that the harness does not have | A single textured animated model, repeated model instances, several mounted app tabs, and a large archive whose first screen uses a fraction of its assets are not fixtures yet; there is no installed-offline pass; every number comes from headless SwiftShader on one desktop, and the brief's "actual target devices" have not been measured. Adding a fixture is a folder under `scripts/bench/fixtures/` and an entry in `scenarios.mjs`; the device runs need a device. |
| X10 | Browser-level checks not run | The per-app install (O02) is verified by unit tests with an injected host and by the build-graph and precache assertions; no real browser has reopened a worker-mode app offline (the repo has no Playwright service-worker harness). Deployment below a subpath and custom-domain standalone hosting are covered by URL tests, not by a browser opening a built site from either. |
| X11 | `VITE_BUILD_ID` | The site build writes `BUILD-INFO.json` beside the site but does not set `VITE_BUILD_ID`, so the offline record's build id is the entry chunk's hash (O03). Having `scripts/build-site.mjs` pass the id into both host builds would make the record's build id and the site's build info the same string. |
| X12 | Revocation while a load is in flight | Model subresources are judged by the policy in force at each request, so a grant answered mid-load applies to the rest of it and a URL judged while consent was pending is refused rather than requested (I02); pending imports are refused at dispatch (I03). No test revokes a grant while a model load or an import is in flight and asserts the pending work is invalidated; adding one is a fixture and a clock. |

## Measurements

Method: `scripts/bench/measure.mjs`, as `docs/PERFORMANCE_MEASUREMENT.md`
describes it. Production builds (`npm run build:packages`, then
`npm run build -w @softn/single` and `npm run build -w @softn/web` with
`VITE_BASE` unset; the web build precaches 44 entries, 6,314.59 KiB), served
from one local origin with the deployment's isolation and cache headers, no
compression. Three fixtures — `minimal` (heading, paragraph, input, button),
`scene-glb` (one Scene3D, one 1.1 KB glTF binary, no effects), `scene-effects`
(the same with bloom) — opened in both hosts, five runs each, a fresh browser
profile per run; cold is the first navigation with the HTTP cache disabled,
warm the second in the same profile with the cache on and, on the web host,
the service worker installed by the first visit controlling the page. Headless
Edge 152.0.4191.66 on SwiftShader (a software rasteriser, not a GPU), AMD
Ryzen 9 9950X3D, Windows 11 10.0.26200, Node 24.12.0, viewport 1280×800.
The baseline (`scripts/bench/results/baseline-0.0.7/`) was taken on the
release tree at `e9fccda` with the marks added; the after measurement
(`scripts/bench/results/after-dynamic-loading/`) on the same machine and
browser the next morning with this tree. The first after pass showed two
things the design did not intend — `vendor-three` carrying every Three
addon, and every app fetching the sync runtime at mount — and also
overlapped another bench process on the same machine; both were fixed (C05,
H05) and both hosts were measured again, with nothing else running, into
the same folders under the same label, overwriting the first pass. Every
after number below is that second measurement, and the `-sw-bypassed`
folder and the compare file were regenerated with it. `node
scripts/bench/compare.mjs baseline-0.0.7 after-dynamic-loading` produced
`after-dynamic-loading/compare-baseline-0.0.7.md`, which has every row of
both; the tables below are the rows the brief asks for. Medians and
nearest-rank p90s (the second-worst of five) as `median / p90`.

### The build graph

The build-graph test prints the entry's static import closure. On the 0.0.7
build it was 1,764,885 bytes in one chunk (the number recorded for the
baseline; the test's own comment records 1,780,427 on the tree just before
the split, which had grown since the release). Now:

| host | entry closure | chunks | feature chunks (fetched on demand) | Three addon chunks (fetched by scene3d on first need) |
|---|---:|---:|---|---|
| web | 732,403 bytes | `index` 732,403 | `vendor-three` 571,466; `scene3d` 58,049; `media` 186,302; `smart` 61,987; `charts` 30,119; `animation` 18,098; `editors` 16,739 | `GLTFLoader` 45,574; `FBXLoader` 47,373; `OBJLoader` 8,654; `STLLoader` 3,128; `OrbitControls` 18,944; `RoomEnvironment` 1,902; `SkeletonUtils` 4,071; `EffectComposer` 3,934; `RenderPass` 1,125; `UnrealBloomPass` 9,149; `OutputPass` 2,929; `ShaderPass` 942; `meshopt_decoder.module` 22,463 |
| single | 625,720 bytes | `index` 625,720 | `vendor-three` 571,409; `scene3d` 57,873; `media` 186,063; `smart` 61,944; `charts` 30,075; `animation` 18,042; `editors` 16,693 | `GLTFLoader` 45,490; `FBXLoader` 47,311; `OBJLoader` 8,607; `STLLoader` 3,081; `OrbitControls` 18,893; `RoomEnvironment` 1,849; `SkeletonUtils` 4,005; `EffectComposer` 3,882; `RenderPass` 1,077; `UnrealBloomPass` 9,096; `OutputPass` 2,881; `ShaderPass` 894; `meshopt_decoder.module` 22,403 |

The scene3d chunk's static closure is itself, `vendor-three` and the entry;
every addon is under its `dynamicImports` and nowhere in that closure (the
build-graph tests read the manifest for both). The harness's byte-level
check agrees: in `minimal`, "3D code inside loaded JS" went from 5/5 runs to
0/5 in both hosts, and no 3D module URL was requested. In `scene-glb` the
3D code is in `vendor-three`, `scene3d` and `GLTFLoader`, which the scene
requests, and nowhere else; `scene-effects` adds the post-processing chunks,
and is the only fixture in which `postprocessing` and `bloom` are found.

### single · minimal

| | cold before | cold after | warm before | warm after |
|---|---:|---:|---:|---:|
| 3D module URL requested (runs) | 0/5 | 0/5 | 0/5 | 0/5 |
| 3D code inside loaded JS (runs) | 5/5 | 0/5 | 5/5 | 0/5 |
| ready (runs) | 5/5 | 5/5 | 5/5 | 5/5 |

| metric (median / p90) | cold before | cold after | warm before | warm after |
|---|---:|---:|---:|---:|
| page bytes on the wire | 6968.1 KB / 6968.1 KB | 5743.2 KB / 5743.2 KB | 3.6 KB / 3.6 KB | 3.6 KB / 3.6 KB |
| JS bytes on the wire | 1836.6 KB / 1836.6 KB | 611.7 KB / 611.7 KB | 0.0 KB / 0.0 KB | 0.0 KB / 0.0 KB |
| wasm bytes on the wire | 5126.1 KB / 5126.1 KB | 5126.1 KB / 5126.1 KB | 0.0 KB / 0.0 KB | 0.0 KB / 0.0 KB |
| page requests | 8 / 8 | 7 / 7 | 8 / 8 | 7 / 7 |
| service worker requests | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| service worker bytes on the wire | 0.0 KB / 0.0 KB | 0.0 KB / 0.0 KB | 0.0 KB / 0.0 KB | 0.0 KB / 0.0 KB |
| service worker bytes loaded (content-length) | 0.0 KB / 0.0 KB | 0.0 KB / 0.0 KB | 0.0 KB / 0.0 KB | 0.0 KB / 0.0 KB |
| long tasks | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| long task total (ms) | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| longest task (ms) | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| document responseEnd (ms) | 241 / 261 | 239 / 308 | 4 / 5 | 5 / 6 |
| DOMContentLoaded (ms) | 293 / 313 | 273 / 341 | 21 / 37 | 19 / 36 |
| load event end (ms) | 293 / 313 | 273 / 341 | 22 / 37 | 20 / 36 |
| first contentful paint (ms) | 333 / 340 | 336 / 409 | 66 / 128 | 72 / 91 |
| app ready (ms) | 325 / 347 | 306 / 374 | 37 / 53 | 32 / 47 |
| uncaught errors | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |

| softn: phase (ms, median / p90) | cold before | cold after | warm before | warm after |
|---|---:|---:|---:|---:|
| softn:bundle-fetch | 4 / 6 | 5 / 9 | 2 / 2 | 2 / 2 |
| softn:component-preload | — | 2 / 2 | — | 2 / 2 |
| softn:compose | 1 / 1 | 1 / 1 | 0 / 0 | 0 / 0 |
| softn:digest | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| softn:parse | 1 / 1 | 1 / 1 | 0 / 0 | 0 / 0 |
| softn:vm-init | 74 / 84 | 73 / 85 | 19 / 19 | 17 / 18 |
| softn:xdb-seed | 1 / 1 | 1 / 1 | 0 / 0 | 0 / 0 |
| softn:zip | 1 / 1 | 1 / 1 | 0 / 1 | 0 / 1 |

### single · scene-glb

| | cold before | cold after | warm before | warm after |
|---|---:|---:|---:|---:|
| 3D module URL requested (runs) | 0/5 | 5/5 | 0/5 | 5/5 |
| 3D code inside loaded JS (runs) | 5/5 | 5/5 | 5/5 | 5/5 |
| ready (runs) | 5/5 | 5/5 | 5/5 | 5/5 |

| metric (median / p90) | cold before | cold after | warm before | warm after |
|---|---:|---:|---:|---:|
| page bytes on the wire | 6968.9 KB / 6968.9 KB | 6403.9 KB / 6403.9 KB | 4.4 KB / 4.4 KB | 4.4 KB / 4.4 KB |
| JS bytes on the wire | 1836.6 KB / 1836.6 KB | 1271.6 KB / 1271.6 KB | 0.0 KB / 0.0 KB | 0.0 KB / 0.0 KB |
| wasm bytes on the wire | 5126.1 KB / 5126.1 KB | 5126.1 KB / 5126.1 KB | 0.0 KB / 0.0 KB | 0.0 KB / 0.0 KB |
| page requests | 9 / 9 | 12 / 12 | 9 / 9 | 12 / 12 |
| service worker requests | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| service worker bytes on the wire | 0.0 KB / 0.0 KB | 0.0 KB / 0.0 KB | 0.0 KB / 0.0 KB | 0.0 KB / 0.0 KB |
| service worker bytes loaded (content-length) | 0.0 KB / 0.0 KB | 0.0 KB / 0.0 KB | 0.0 KB / 0.0 KB | 0.0 KB / 0.0 KB |
| long tasks | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| long task total (ms) | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| longest task (ms) | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| document responseEnd (ms) | 244 / 247 | 235 / 240 | 5 / 5 | 5 / 6 |
| DOMContentLoaded (ms) | 293 / 303 | 266 / 272 | 25 / 26 | 22 / 40 |
| load event end (ms) | 293 / 303 | 266 / 273 | 26 / 26 | 22 / 40 |
| first contentful paint (ms) | 339 / 349 | 336 / 339 | 62 / 79 | 78 / 98 |
| app ready (ms) | 341 / 351 | 342 / 356 | 56 / 68 | 69 / 93 |
| first WebGL context (ms) | 331 / 341 | 333 / 348 | 51 / 62 | 63 / 85 |
| first GL draw (ms) | 380 / 403 | 381 / 425 | 83 / 96 | 105 / 134 |
| uncaught errors | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |

| softn: phase (ms, median / p90) | cold before | cold after | warm before | warm after |
|---|---:|---:|---:|---:|
| softn:asset-extract | — | 0 / 0 | — | 0 / 0 |
| softn:asset-warm | — | 18 / 63 | — | 41 / 54 |
| softn:bundle-fetch | 6 / 7 | 6 / 9 | 2 / 2 | 3 / 3 |
| softn:component-preload | — | 20 / 22 | — | 7 / 9 |
| softn:compose | 1 / 1 | 1 / 1 | 0 / 0 | 0 / 0 |
| softn:digest | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| softn:parse | 1 / 2 | 1 / 1 | 0 / 0 | 1 / 1 |
| softn:vm-init | 105 / 114 | 111 / 128 | 41 / 47 | 47 / 58 |
| softn:xdb-seed | 1 / 1 | 1 / 1 | 0 / 0 | 0 / 0 |
| softn:zip | 1 / 1 | 1 / 1 | 1 / 1 | 1 / 1 |
| softn:scene3d-assets-ready (point, ms from navigation) | — | 372 / 386 | — | 80 / 105 |
| softn:scene3d-first-frame (point, ms from navigation) | — | 391 / 425 | — | 106 / 134 |
| softn:scene3d-renderer-ready (point, ms from navigation) | — | 340 / 354 | — | 68 / 92 |

### single · scene-effects

| | cold before | cold after | warm before | warm after |
|---|---:|---:|---:|---:|
| 3D module URL requested (runs) | 0/5 | 5/5 | 0/5 | 5/5 |
| 3D code inside loaded JS (runs) | 5/5 | 5/5 | 5/5 | 5/5 |
| ready (runs) | 5/5 | 5/5 | 5/5 | 5/5 |

| metric (median / p90) | cold before | cold after | warm before | warm after |
|---|---:|---:|---:|---:|
| page bytes on the wire | 6969.0 KB / 6969.0 KB | 6424.5 KB / 6424.5 KB | 4.5 KB / 4.5 KB | 4.5 KB / 4.5 KB |
| JS bytes on the wire | 1836.6 KB / 1836.6 KB | 1292.2 KB / 1292.2 KB | 0.0 KB / 0.0 KB | 0.0 KB / 0.0 KB |
| wasm bytes on the wire | 5126.1 KB / 5126.1 KB | 5126.1 KB / 5126.1 KB | 0.0 KB / 0.0 KB | 0.0 KB / 0.0 KB |
| page requests | 9 / 9 | 19 / 19 | 9 / 9 | 19 / 19 |
| service worker requests | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| service worker bytes on the wire | 0.0 KB / 0.0 KB | 0.0 KB / 0.0 KB | 0.0 KB / 0.0 KB | 0.0 KB / 0.0 KB |
| service worker bytes loaded (content-length) | 0.0 KB / 0.0 KB | 0.0 KB / 0.0 KB | 0.0 KB / 0.0 KB | 0.0 KB / 0.0 KB |
| long tasks | 2 / 3 | 2 / 2 | 3 / 3 | 1 / 2 |
| long task total (ms) | 203 / 257 | 133 / 176 | 209 / 233 | 141 / 191 |
| longest task (ms) | 113 / 123 | 114 / 121 | 93 / 111 | 112 / 141 |
| document responseEnd (ms) | 231 / 236 | 214 / 248 | 5 / 5 | 5 / 6 |
| DOMContentLoaded (ms) | 286 / 293 | 247 / 280 | 143 / 144 | 153 / 163 |
| load event end (ms) | 287 / 293 | 247 / 280 | 143 / 144 | 153 / 163 |
| first contentful paint (ms) | 330 / 341 | 315 / 338 | 257 / 303 | 214 / 237 |
| app ready (ms) | 361 / 417 | 322 / 346 | 238 / 267 | 193 / 200 |
| first WebGL context (ms) | 323 / 327 | 311 / 337 | 162 / 165 | 186 / 193 |
| first GL draw (ms) | 337 / 340 | 380 / 401 | 168 / 171 | 218 / 229 |
| uncaught errors | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |

| softn: phase (ms, median / p90) | cold before | cold after | warm before | warm after |
|---|---:|---:|---:|---:|
| softn:asset-extract | — | 0 / 0 | — | 0 / 0 |
| softn:asset-warm | — | 23 / 25 | — | 40 / 48 |
| softn:bundle-fetch | 4 / 7 | 7 / 7 | 2 / 2 | 2 / 2 |
| softn:component-preload | — | 21 / 23 | — | 7 / 8 |
| softn:compose | 1 / 1 | 1 / 1 | 0 / 0 | 0 / 0 |
| softn:digest | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| softn:parse | 1 / 1 | 1 / 2 | 0 / 1 | 1 / 1 |
| softn:vm-init | 303 / 321 | 97 / 150 | 235 / 246 | 47 / 185 |
| softn:xdb-seed | 1 / 1 | 1 / 1 | 0 / 0 | 0 / 0 |
| softn:zip | 1 / 1 | 1 / 1 | 1 / 1 | 1 / 1 |
| softn:scene3d-assets-ready (point, ms from navigation) | — | 383 / 597 | — | 208 / 350 |
| softn:scene3d-first-frame (point, ms from navigation) | — | 490 / 599 | — | 334 / 415 |
| softn:scene3d-renderer-ready (point, ms from navigation) | — | 319 / 344 | — | 191 / 199 |

### web · minimal

| | cold before | cold after | warm before | warm after |
|---|---:|---:|---:|---:|
| 3D module URL requested (runs) | 0/5 | 0/5 | 0/5 | 0/5 |
| 3D code inside loaded JS (runs) | 5/5 | 0/5 | 5/5 | 0/5 |
| ready (runs) | 5/5 | 5/5 | 5/5 | 5/5 |

| metric (median / p90) | cold before | cold after | warm before | warm after |
|---|---:|---:|---:|---:|
| page bytes on the wire | 7212.8 KB / 7212.8 KB | 5994.3 KB / 5994.3 KB | 1.4 KB / 1.4 KB | 1.4 KB / 1.4 KB |
| JS bytes on the wire | 1934.8 KB / 1934.8 KB | 716.3 KB / 716.3 KB | 0.0 KB / 0.0 KB | 0.0 KB / 0.0 KB |
| wasm bytes on the wire | 5126.1 KB / 5126.1 KB | 5126.1 KB / 5126.1 KB | 0.0 KB / 0.0 KB | 0.0 KB / 0.0 KB |
| page requests | 16 / 16 | 15 / 15 | 10 / 10 | 9 / 9 |
| service worker requests | 54 / 54 | 47 / 47 | 1 / 1 | 1 / 1 |
| service worker bytes on the wire | 1293.9 KB / 1293.9 KB | 344.8 KB / 344.8 KB | 2.6 KB / 2.6 KB | 2.6 KB / 2.6 KB |
| service worker bytes loaded (content-length) | 8508.2 KB / 8508.2 KB | 6343.7 KB / 6343.7 KB | 2.3 KB / 2.3 KB | 2.3 KB / 2.3 KB |
| long tasks | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| long task total (ms) | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| longest task (ms) | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| document responseEnd (ms) | 221 / 248 | 223 / 279 | 11 / 12 | 14 / 15 |
| DOMContentLoaded (ms) | 278 / 308 | 263 / 328 | 44 / 45 | 32 / 36 |
| load event end (ms) | 278 / 308 | 264 / 329 | 44 / 46 | 32 / 36 |
| first contentful paint (ms) | 554 / 579 | 539 / 614 | 140 / 170 | 96 / 163 |
| app ready (ms) | 377 / 412 | 398 / 447 | 63 / 63 | 51 / 54 |
| uncaught errors | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |

| softn: phase (ms, median / p90) | cold before | cold after | warm before | warm after |
|---|---:|---:|---:|---:|
| softn:component-preload | — | 3 / 3 | — | 2 / 3 |
| softn:compose | 1 / 1 | 1 / 1 | 0 / 0 | 0 / 0 |
| softn:offline-install | — | 278 / 303 | — | — |
| softn:parse | 1 / 1 | 0 / 0 | 0 / 0 | 0 / 0 |
| softn:vm-init | 88 / 110 | 85 / 123 | 17 / 18 | 18 / 22 |
| softn:xdb-seed | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| softn:zip | 1 / 2 | 2 / 2 | 2 / 2 | 1 / 1 |

### web · scene-glb

| | cold before | cold after | warm before | warm after |
|---|---:|---:|---:|---:|
| 3D module URL requested (runs) | 0/5 | 5/5 | 0/5 | 5/5 |
| 3D code inside loaded JS (runs) | 5/5 | 5/5 | 5/5 | 5/5 |
| ready (runs) | 5/5 | 5/5 | 5/5 | 5/5 |

| metric (median / p90) | cold before | cold after | warm before | warm after |
|---|---:|---:|---:|---:|
| page bytes on the wire | 7213.6 KB / 7213.6 KB | 6655.2 KB / 6655.2 KB | 2.2 KB / 2.2 KB | 2.2 KB / 2.2 KB |
| JS bytes on the wire | 1934.8 KB / 1934.8 KB | 1376.5 KB / 1376.5 KB | 0.0 KB / 0.0 KB | 0.0 KB / 0.0 KB |
| wasm bytes on the wire | 5126.1 KB / 5126.1 KB | 5126.1 KB / 5126.1 KB | 0.0 KB / 0.0 KB | 0.0 KB / 0.0 KB |
| page requests | 17 / 17 | 20 / 20 | 11 / 11 | 14 / 14 |
| service worker requests | 54 / 54 | 47 / 47 | 1 / 1 | 5 / 5 |
| service worker bytes on the wire | 1293.9 KB / 1293.9 KB | 334.3 KB / 334.3 KB | 2.6 KB / 2.6 KB | 2.6 KB / 2.6 KB |
| service worker bytes loaded (content-length) | 8508.2 KB / 8508.2 KB | 6343.7 KB / 6343.7 KB | 2.3 KB / 2.3 KB | 672.2 KB / 672.2 KB |
| long tasks | 1 / 1 | 1 / 1 | 0 / 0 | 0 / 0 |
| long task total (ms) | 52 / 56 | 50 / 77 | 0 / 0 | 0 / 0 |
| longest task (ms) | 52 / 56 | 50 / 77 | 0 / 0 | 0 / 0 |
| document responseEnd (ms) | 239 / 275 | 214 / 277 | 11 / 12 | 12 / 16 |
| DOMContentLoaded (ms) | 310 / 333 | 261 / 310 | 45 / 46 | 32 / 37 |
| load event end (ms) | 311 / 333 | 262 / 310 | 45 / 47 | 33 / 38 |
| first contentful paint (ms) | 505 / 541 | 492 / 499 | 102 / 117 | 105 / 107 |
| app ready (ms) | 454 / 480 | 442 / 466 | 73 / 76 | 87 / 109 |
| first WebGL context (ms) | 445 / 470 | 431 / 455 | 69 / 71 | 81 / 103 |
| first GL draw (ms) | 522 / 564 | 514 / 530 | 105 / 107 | 115 / 143 |
| uncaught errors | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |

| softn: phase (ms, median / p90) | cold before | cold after | warm before | warm after |
|---|---:|---:|---:|---:|
| softn:asset-extract | — | 0 / 0 | — | 0 / 0 |
| softn:asset-warm | — | 22 / 25 | — | 37 / 42 |
| softn:component-preload | — | 19 / 21 | — | 21 / 22 |
| softn:compose | 1 / 1 | 1 / 1 | 0 / 0 | 0 / 0 |
| softn:offline-install | — | 296 / 310 | — | — |
| softn:parse | 1 / 1 | 1 / 1 | 0 / 0 | 0 / 1 |
| softn:vm-init | 126 / 134 | 142 / 151 | 34 / 37 | 48 / 62 |
| softn:xdb-seed | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| softn:zip | 1 / 2 | 2 / 2 | 2 / 2 | 1 / 1 |
| softn:scene3d-assets-ready (point, ms from navigation) | — | 466 / 488 | — | 93 / 117 |
| softn:scene3d-first-frame (point, ms from navigation) | — | 514 / 530 | — | 115 / 143 |
| softn:scene3d-renderer-ready (point, ms from navigation) | — | 440 / 464 | — | 86 / 108 |

### web · scene-effects

| | cold before | cold after | warm before | warm after |
|---|---:|---:|---:|---:|
| 3D module URL requested (runs) | 0/5 | 5/5 | 0/5 | 5/5 |
| 3D code inside loaded JS (runs) | 5/5 | 5/5 | 5/5 | 5/5 |
| ready (runs) | 5/5 | 5/5 | 5/5 | 5/5 |

| metric (median / p90) | cold before | cold after | warm before | warm after |
|---|---:|---:|---:|---:|
| page bytes on the wire | 7213.6 KB / 7213.6 KB | 6676.2 KB / 6676.2 KB | 2.3 KB / 2.3 KB | 2.3 KB / 2.3 KB |
| JS bytes on the wire | 1934.8 KB / 1934.8 KB | 1397.5 KB / 1397.5 KB | 0.0 KB / 0.0 KB | 0.0 KB / 0.0 KB |
| wasm bytes on the wire | 5126.1 KB / 5126.1 KB | 5126.1 KB / 5126.1 KB | 0.0 KB / 0.0 KB | 0.0 KB / 0.0 KB |
| page requests | 17 / 17 | 27 / 27 | 11 / 11 | 21 / 21 |
| service worker requests | 54 / 54 | 47 / 47 | 1 / 1 | 12 / 12 |
| service worker bytes on the wire | 1294.2 KB / 1294.2 KB | 333.9 KB / 334.3 KB | 2.6 KB / 2.6 KB | 2.6 KB / 2.6 KB |
| service worker bytes loaded (content-length) | 8508.2 KB / 8508.2 KB | 6343.7 KB / 6343.7 KB | 2.3 KB / 2.3 KB | 691.1 KB / 691.1 KB |
| long tasks | 4 / 4 | 2 / 2 | 2 / 3 | 1 / 2 |
| long task total (ms) | 325 / 338 | 158 / 190 | 216 / 361 | 64 / 216 |
| longest task (ms) | 119 / 165 | 104 / 140 | 153 / 187 | 64 / 126 |
| document responseEnd (ms) | 232 / 258 | 230 / 244 | 12 / 14 | 13 / 14 |
| DOMContentLoaded (ms) | 291 / 315 | 268 / 293 | 51 / 52 | 33 / 38 |
| load event end (ms) | 292 / 315 | 268 / 293 | 52 / 52 | 34 / 39 |
| first contentful paint (ms) | 595 / 673 | 445 / 522 | 313 / 383 | 177 / 232 |
| app ready (ms) | 471 / 567 | 441 / 458 | 220 / 258 | 148 / 170 |
| first WebGL context (ms) | 428 / 449 | 431 / 448 | 146 / 183 | 101 / 165 |
| first GL draw (ms) | 448 / 468 | 509 / 549 | 152 / 189 | 182 / 208 |
| uncaught errors | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |

| softn: phase (ms, median / p90) | cold before | cold after | warm before | warm after |
|---|---:|---:|---:|---:|
| softn:asset-extract | — | 0 / 0 | — | 0 / 0 |
| softn:asset-warm | — | 20 / 28 | — | 24 / 26 |
| softn:component-preload | — | 20 / 25 | — | 20 / 22 |
| softn:compose | 1 / 1 | 1 / 1 | 0 / 0 | 0 / 0 |
| softn:offline-install | — | 306 / 394 | — | — |
| softn:parse | 1 / 2 | 1 / 1 | 0 / 1 | 0 / 1 |
| softn:vm-init | 338 / 343 | 126 / 295 | 301 / 311 | 112 / 131 |
| softn:xdb-seed | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| softn:zip | 1 / 3 | 2 / 2 | 2 / 2 | 1 / 1 |
| softn:scene3d-assets-ready (point, ms from navigation) | — | 470 / 485 | — | 160 / 180 |
| softn:scene3d-first-frame (point, ms from navigation) | — | 618 / 676 | — | 211 / 330 |
| softn:scene3d-renderer-ready (point, ms from navigation) | — | 438 / 455 | — | 146 / 169 |

### HTTP-cache-warm and service-worker-warm, told apart

The warm columns above for the web host are the service worker answering.
`scripts/bench/results/after-dynamic-loading-sw-bypassed/` is the same
build and fixtures measured with `--bypass-sw`, so the warm pass is the HTTP
cache alone (service worker controlling 0/5):

| web, warm pass, median | with the service worker | HTTP cache only |
|---|---:|---:|
| page bytes on the wire, minimal / scene-glb / scene-effects | 1.4 / 2.2 / 2.3 KB | 5.2 / 6.0 / 6.1 KB |
| page requests, minimal / scene-glb / scene-effects | 9 / 14 / 21 | 14 / 19 / 26 |
| answered from the HTTP cache, minimal / scene-glb / scene-effects | 7 / 10 / 17 | 10 / 13 / 20 |
| app ready (ms), minimal / scene-glb / scene-effects | 51 / 87 / 148 | 39 / 68 / 156 |

Either way a warm visit moves single-digit kilobytes: the document, the
config, the bundle (revalidated) and, without the worker, the revalidations of
the non-hashed files. There is still no installed-offline pass (X09).

### What got better

- **A form app no longer downloads Three.js, or the sync runtime.** JS on
  the wire for `minimal` fell from 1,836.6 KB to 611.7 KB in the standalone
  host and from 1,934.8 KB to 716.3 KB in the web host — one entry chunk of
  611 KB / 715 KB, the 0.4 KB XDB module and nothing else. "3D code inside
  loaded JS" went from every run to no run, and the 195 KB `xdb-sync`
  chunk that every app fetched at mount (H05) is in no request list of the
  after measurement, so `minimal` makes one request fewer than 0.0.7 (8 →
  7 single, 16 → 15 web) rather than one more.
- **A scene downloads Three's core and the loader it uses.** `scene-glb`
  requests `scene3d` (57 KB), `vendor-three` (571 KB) and `GLTFLoader`
  (45 KB) and comes out 565.0 KB (single) and 558.3 KB (web) lighter than
  0.0.7 in JS on the wire: 1,271.6 KB and 1,376.5 KB. `scene-effects` adds
  `EffectComposer`, `RenderPass`, `UnrealBloomPass`, `OutputPass`,
  `ShaderPass` and the two helpers they share — about 19 KB over seven
  files — and is 544.4 KB / 537.4 KB lighter (1,292.2 / 1,397.5 KB). The
  OBJ, FBX and STL loaders (59 KB together), OrbitControls, RoomEnvironment,
  SkeletonUtils and the Meshopt decoder are fetched by neither fixture
  (C05); in the first after measurement every one of them came down with
  `vendor-three`.
- **The service worker's background traffic** on a first visit fell from
  1,293.9 KB to 334–345 KB on the wire and from 8,508.2 KB to 6,343.7 KB
  stored, 54 requests to 47: the AI runtimes, the sync runtimes, the feature
  chunks and the Three addons are no longer precached for every visitor.
- **Long tasks in the bloom scene**: cold, 203 → 133 ms in total (single)
  and 325 → 158 ms (web); warm, 209 → 141 ms (single) and 216 → 64 ms (web).
  Script time on the cold bloom visit went 349 → 208 ms (single) and 386 →
  259 ms (web). `softn:vm-init` on the bloom scene went from 303 → 97 ms
  cold and 235 → 47 ms warm (single) and 338 → 126 ms cold and 301 → 112 ms
  warm (web); the cause was not isolated, and the cold p90s (150 ms single,
  295 ms web) say one run in five still pays most of the old figure, so
  this is reported, not claimed. The web `scene-glb` cold visit's one long
  task is still there (52 → 50 ms).
- **Warm navigation timing on the web host** improved across the board:
  DOMContentLoaded 44 → 32 ms (`minimal`), 45 → 32 (`scene-glb`), 51 →
  33 (`scene-effects`); app ready 63 → 51 (`minimal`) and 220 → 148
  (`scene-effects`); first contentful paint 140 → 96 (`minimal`) and 313
  → 177 (`scene-effects`). The cold bloom visit's first contentful paint
  went 595 → 445 ms and its app ready 471 → 441. JS heap after a cold
  `minimal` visit is 5.0 → 3.1 MB (single) and 5.9 → 3.9 MB (web).

### What got worse

- **Request counts rose in the scenes**, cold and warm alike: by three in
  `scene-glb` (9 → 12 single, 17 → 20 web: `scene3d`, `vendor-three`,
  `GLTFLoader` and the inflate worker's script, less the `xdb-sync`
  request that is gone) and by ten in `scene-effects` (9 → 19, 17 → 27:
  the seven post-processing files on top). That is the design; on a real
  network each request is latency the single entry chunk did not pay, and
  the harness cannot measure that (see caveats). Seven requests for 19 KB
  of post-processing is the one place the split may have gone a file too
  far; merging the passes into one chunk is a config change and a
  re-measure.
- **First GL draw in the scenes is later.** Cold: single `scene-effects`
  337 → 380 ms and web `scene-effects` 448 → 509 ms (single `scene-glb`
  380 → 381 and web `scene-glb` 522 → 514 did not move). Warm: single
  `scene-glb` 83 → 105 ms and `scene-effects` 168 → 218 ms; web
  `scene-glb` 105 → 115 ms and `scene-effects` 152 → 182 ms. The first
  WebGL context moves with it on warm visits (single 51 → 63 and 162 → 186
  ms, web `scene-glb` 69 → 81), and so do app ready (single `scene-glb`
  56 → 69 ms, web 73 → 87) and single `scene-glb`'s first paint (62 → 78
  ms); web `scene-effects` first paint is later too, 296 → 320 ms cold and
  156 → 167 warm, while its first contentful paint fell. The scene now waits
  for three chunks the entry used to carry — ten with bloom — and the
  preload (`softn:component-preload`, 19–21 ms cold in the scenes)
  overlaps the VM's initialisation but not the parse before it. These are
  the cost of the trade, on SwiftShader, on a desktop.
- **`softn:vm-init` is longer in `scene-glb`**, where the preload runs
  beside it: 105 → 111 ms cold and 41 → 47 warm (single), 126 → 142 cold
  and 34 → 48 warm (web). Script time and main-thread task time on the cold
  `scene-glb` visit rose with it — 86 → 102 / 188 → 202 ms (single), 125 →
  141 / 244 → 282 ms (web) — and on the warm one (single 41 → 49 / 95 → 113,
  web task time 94 → 106). Single `scene-effects` warm: longest task 93 →
  112 ms and DOMContentLoaded 143 → 153 ms, with the long-task total lower.
- **The web host's warm pass shows the service worker fetching 672 KB
  (`scene-glb`, 5 requests) and 691 KB (`scene-effects`, 12) of content**
  where it fetched 2.3 KB over one request before. That is the
  `softn-feature-chunks` runtime cache filling from the HTTP cache —
  `scene3d`, `vendor-three`, `GLTFLoader` and, with bloom, the
  post-processing files — on the first visit the worker controls; the bytes
  on the wire for the same pass are 2.6 KB, unchanged. Not a transfer, but a
  cache write the visitor's disk pays once. `minimal` no longer shows it
  (one request, 2.3 KB, as in 0.0.7), because nothing on demand is fetched
  now that `xdb-sync` is not.
- **JS heap on the warm web `scene-glb` visit is 1.1 MB higher** (8.4 →
  9.5 MB): the template cache holds the model for reuse. The other warm
  scenes' heaps are lower at the median (single `scene-effects` 9.8 → 9.3
  MB, web 10.2 → 9.4) and 0.5–0.6 MB higher at p90.
- **`minimal` timings that moved the wrong way**: web cold app ready 377
  → 398 ms (p90 412 → 447) while its DOMContentLoaded (278 → 263) and first
  contentful paint (554 → 539) came sooner and `softn:vm-init` did not
  move (88 → 85); web warm first paint 46 → 64 ms while first contentful
  paint fell 140 → 96; single warm first paint 66 → 72 ms. All under 25 ms
  on a desktop; listed because the compare names them.
- **Some p90s are worse where the medians are not**: single `minimal` cold
  app ready 347 → 374 ms with the median down (325 → 306), document
  responseEnd 261 → 308 and first contentful paint 340 → 409; web `minimal`
  cold first contentful paint 579 → 614 (median 554 → 539) and
  `softn:vm-init` 110 → 123 (median 88 → 85); web `scene-glb` cold long
  task 56 → 77 ms (median 52 → 50); web `scene-effects` warm long-task
  total 361 → 216 ms is better, but that p90 is three times its median (64).
  Five runs make the p90 the second-worst run; these are within the noise
  the measurement doc warns about, and are listed so that nobody has to
  find them.
- **Unchanged, and the largest number on the page:** the 5,126 KB scripting
  engine wasm on every cold visit, and the bundle bytes (A03). Nothing here
  touched either.

### Caveats

- Production builds of this tree, served from localhost without compression:
  bytes are comparable between labels and larger than a deployed transfer;
  transfer time and request latency are not measured at all, so the request
  count is the only proxy for what a network pays for the extra chunks.
- Headless Edge on SwiftShader: WebGL context, shader and draw times say
  the path ran, not how long it takes on a device. No real GPU, phone or
  laptop has been measured (X09).
- Cache state is part of every number: cold, warm-with-service-worker and
  warm-HTTP-cache-only are three measurements and are kept apart above; an
  installed-offline case does not exist yet.
- One desktop (Ryzen 9 9950X3D, 32 threads, 190 GB), one browser build,
  five runs per cell; anything within a few percent between the two labels
  is noise, and p90 is one run.
- `softn:offline-install` (278–306 ms cold) runs in the background after the
  app is ready and is not on the critical path; it has no warm figure because
  the record is already installed against this build.
- In the after measurement the inflate worker's script appears in the page
  request list with no status: the module worker's fetch is observed by the
  page target but its response is delivered to a target the harness does not
  attach to. Failed requests are 0 in every run; the row is an attribution
  gap in the harness, not a failed load.
- Both measurements were taken on a dirty tree at `e9fccda` — the baseline
  with the marks added, the after with the whole change, C05 and H05
  included — as `summary.json`'s environment block records.
