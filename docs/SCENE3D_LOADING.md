# Scene3D loading

How `Scene3D` gets a model onto the screen: what it fetches, when, from where, who owns the result, and what it tells the app along the way. The appearance controls are in [SCENE3D_APPEARANCE.md](SCENE3D_APPEARANCE.md) and the lighting and material settings in [SCENE3D_MATERIAL_QUALITY.md](SCENE3D_MATERIAL_QUALITY.md).

## What is imported, and when

`three` itself is a static import: every scene needs the renderer, the geometries and the materials. Everything else is fetched on demand, once per page, the first time a scene asks for it:

| Feature | Module fetched | Taken when |
|---|---|---|
| glTF / GLB model | `three/addons/loaders/GLTFLoader.js` | an object of `type: 'model'` resolves to the `gltf` format |
| OBJ model | `three/addons/loaders/OBJLoader.js` | … to `obj` |
| FBX model | `three/addons/loaders/FBXLoader.js` | … to `fbx` |
| STL model | `three/addons/loaders/STLLoader.js` | … to `stl` |
| Orbit controls | `three/addons/controls/OrbitControls.js` | `orbitControls` is set (and mouse look is not) |
| Studio lighting | `three/addons/environments/RoomEnvironment.js` | `environment="studio"` |
| Bloom, vignette, grain | the five `three/addons/postprocessing/*` modules, together | any effect in `effects` is on |
| Skinned-mesh instancing | `three/addons/utils/SkeletonUtils.js` | a loaded model contains a `SkinnedMesh` |
| Meshopt decoding | `three/addons/libs/meshopt_decoder.module.js` | a glTF declares `EXT_meshopt_compression` |

The format is taken from `modelFormat`, else from the file name — the archive path when the model came from a bundle, since a minted object URL has no extension — and is `gltf` when nothing says otherwise. A scene with primitives only imports no addon at all. The in-flight import is cached at module scope, so twenty scenes share one fetch; a failed import is forgotten so the next scene retries it.

In the browser hosts each module in the table is a chunk of its own, named after it (`assets/GLTFLoader-<hash>.js`), reached only through `scene3d`'s dynamic imports; Three's core is the `vendor-three` chunk, which is what `scene3d` imports statically. None of them is in the web host's service-worker precache — each is fetched the first time a scene needs it and kept by the runtime cache from then on (docs/COMPONENT_LOADING.md, "The PWA policy"); both hosts' build-graph tests hold every addon out of the `scene3d` chunk's static closure.

Because these arrive asynchronously, a scene renders plainly until its post-processing chain exists, looks where `camera.lookAt` says until its controls exist (which then adopt that target, not the origin), and has no environment until the room has been generated. The test `scene3d-loading.test.tsx` pins the table above by counting module evaluations.

## Milestones

Three callbacks, each firing once per mount, each with a `performance.mark` of the same meaning (an instant, which `scripts/bench/measure.mjs` reports as a point in time):

| Prop | Mark | Meaning |
|---|---|---|
| `onReady` | `softn:scene3d-renderer-ready` | The WebGL context exists and has drawn a frame. The world may be empty. |
| `onAssetsReady` | `softn:scene3d-assets-ready` | Every model present in the scene's first reconcile has settled — loaded *or* failed. |
| `onFirstFrame` | `softn:scene3d-first-frame` | The first frame drawn after `onAssetsReady`. The one a loading screen should wait for. |

`onAssetsReady` counts the models the scene opened with and no others: a model added later reports through `onModelState` but does not reopen readiness; one removed before it settled stops holding it, and so does one replaced before it settled — an object whose id turns into a primitive or a group, or whose URL or `reload` changes, has discarded the load readiness was waiting on, and whatever takes its id is a model added later. A failure counts as settled because the scene is then what it is going to be, and the failure has its own channel. A model whose URL the permission policy withheld is not loading and is not counted. A scene with no models is asset-ready immediately after its first reconcile.

`onReady` keeps its old meaning. Code that dropped a loading screen on it was seeing an empty world; it should wait for `onFirstFrame`.

## Model states and retry

`onModelState({ objectId, state, attempt, error? })` reports each model's load:

- `pending` — a fetch has started, with `attempt` 1 for the first load of a URL.
- `loaded` — the object is in the scene.
- `error` — it is not, and `error` says why. When the reason is a subresource the policy refused (below), the message names that URL and the reason; when the model needs a decoder this build does not ship, it says which.

To try the same URL again, change the object's numeric `reload` field. Each change is a new fetch — the template cache forgets what it holds for the URL first — reported as `pending` with `attempt` one higher, then `loaded` or `error`. A change of URL or format starts the count at 1 again. An unchanged `reload` is not a retry.

The stale-request rule is unchanged: a load whose object was removed, whose URL changed, or whose scene unmounted before it settled is discarded on arrival (its lease on the cache is released at once) and reports nothing.

## Where a model's bytes may come from

A model is more than one file: a `.gltf` names buffers and images by URI, an FBX names its textures. Every load now gets a `THREE.LoadingManager` of its own — never `THREE.DefaultLoadingManager`, never one shared between loads — and its URL modifier decides each URL *before* three dispatches a request:

1. **The model itself** was judged when the scene received it: not egress at all (a bundle asset, a same-origin path), or `net` granted for its host. It passes the modifier untouched.
2. **A relative URI in a bundle model** is resolved against the model's directory in the archive and handed to the host's asset resolver. The scene knows the model is in the bundle because `useAppAssets()` gives it the app's `AppAssetResolver`, whose `pathOf(modelUrl)` maps the object URL the host minted back to the archive path — `models/hero/hero.gltf`. From there `textures/skin.png` is `models/hero/textures/skin.png`, `../shared/a.bin` is `models/shared/a.bin`, `%20` is a space, and a leading `/` is the bundle root. The resolver returns the host's own object URL for that file, or nothing.
3. **Any other URL** — absolute, or relative to a remote model — is judged with the same egress policy as the model itself: the DOM's scheme list, then `describeMarkupEgress` against the bundle's `net` grant and its `allowed_hosts`. An embedded `data:` buffer or image never leaves the page and is allowed.

The modifier reads the scene's policy at each decision, not once when the load began: a consent answered while a model's bytes were on their way is the policy its buffers and images are judged by. Nothing is requested early either way — a URL judged while consent was pending is refused, and a refusal is not a request.

A URL that is refused, that climbs out of the bundle, or that names a file the bundle does not have, is replaced by `data:,` — a URL that yields nothing without a request. The loader "fetches" an empty body, the model fails to parse, and the failure is reported through `onModelState` naming the refused URL. Fail-closed: nothing was asked of the network. When the parser copes without the part (an optional texture), the model loads and the refusal is logged as a warning.

`textureUrl` on a primitive goes through a per-load manager the same way, for uniformity; it has no subresources of its own.

This needs `pathOf` on the host's resolver. A host that mints URLs without providing `pathOf` gets rule 3 for everything, and a bundle model's relative URIs — now resolved by three against a `blob:` base — will not be found. Both `softn-web` and `softn-single` provide it.

## The template cache and who owns what

`packages/@softn/components/src/threed/model-cache.ts`. One load per key produces a **template**: the object as the loader made it, never placed in a scene. Every object in a scene is an **instance** cloned from it.

- **Key**: `${appId}|bundle:${archivePath}|${format}` for a model the host's resolver can map back to its bundle (`pathOf`), `appId` from `useAppScope()`. The object URL the host minted for it is fresh per open of the app and dead once the host revokes it, while the archive path names the same bytes for as long as the app id does — in `softn-web` the app id is the bundle's digest — so a tab closed and reopened finds its model. Everything else is keyed `${appId ?? '_default'}|${modelUrl}|${format}`. Two apps naming one URL or path do not hand each other their models.
- **Dedupe**: concurrent acquires of one key share the one load in flight — a hundred crates is one fetch and one decode. A failed load is forgotten so a retry fetches.
- **Shared, owned by the template**: geometry and textures. Disposed only when the template is evicted.
- **Owned by the instance**: its materials (cloned, so `color`/`opacity` overrides and `appearance` tints on one crate cannot recolour another) and, for a skinned model, its skeleton (`SkeletonUtils.clone`, so two figures do not share bones). Animation clips are shared; a mixer binds them to its own root. A clip's tracks name their nodes, and three names a node the file left unnamed by its uuid, which a clone does not keep — so every unnamed node in a template is given its uuid as its name before the first instance is cut, and the tracks find it on every clone.
- **Once per template, not per instance**: the anisotropy pass on a model's maps. A texture's `needsUpdate` is an upload and a mipmap regeneration, and the textures are the template's, so an instance sets anisotropy only where it actually differs — the first instance does, the rest find it done.
- **Release, not dispose**: an instance leaving the scene is released to the cache, which disposes the instance's own materials and skeleton and decrements the template. `disposeObject3D` is never run on a model instance.
- **Bound**: a template with no instances stays for reuse — a tab closed and reopened gets its model back — up to **16 idle templates** across the page, least recently used first out. A template in use is never evicted. The bound is a count rather than a byte estimate because a model's real cost is on the GPU, where nothing here can measure it, and a count is at least honest. A template filed under a `blob:` URL — a host whose resolver has no `pathOf`, or a scene outside any app — is not kept idle at all: the cache cannot see the host revoke the URL, and nothing will name it again, so it goes with its last instance rather than taking a slot. `modelTemplateCacheStats()` reports entries, referenced, idle, evicted and loads for an inspector.
- **Invalidate**: a `reload` drops the template from the map; instances already holding it keep it, and it is disposed when the last of them is released.

## Activity

The render loop runs only while the app is shown: `useAppActive()` from `@softn/core` (false for a background tab in `softn-web`) and `document.visibilityState`. When either says no, no frame is scheduled and every mesh, mixer and load stays exactly as it was; when both say yes again the clock is re-baselined before the first frame — the hidden interval is taken out of both its delta and its elapsed time — so rotate animations and clip mixers advance a frame's worth rather than the whole hidden interval, and a float animation, whose height is a function of elapsed time, keeps its phase. The first frame is drawn at mount regardless, so `onReady` means what it says.

## Effects

Which effects are on decides which passes exist; their numbers are written into the passes that exist. Retuning bloom strength, radius or threshold, or the vignette and grain amounts, updates the running chain in place; a number that is not finite is its default, since a NaN in a pass is a black frame with no error. Switching an effect on or off rebuilds the chain and disposes every pass the old one owned — `EffectComposer.dispose()` frees only its own targets, and `UnrealBloomPass` carries render targets of its own — as does unmount.

## Groups

A group's children are reconciled by id. A child whose id persists is patched — transform, material properties, geometry when its dimensions changed, its own children when it is a group — and stays the same `Object3D`. A child whose id is gone is disposed; a new id is built. A child whose spec is the same object as last time is not looked at. Two children with one id: the first is taken and the rest are skipped, when the group is built and when it is reconciled alike, so the two never disagree about which node is the id's.

## Codecs

Read from the asset before the parser sees it: a `.glb`'s JSON chunk, a `.gltf`'s text.

| Extension | Status |
|---|---|
| `EXT_meshopt_compression` | Supported. The decoder is self-contained JavaScript and is fetched when a glTF declares it. |
| `KHR_draco_mesh_compression` | **Not supported.** The Draco decoder is a separate wasm binary this build does not ship. A model declaring it fails early with `model needs the Draco decoder, which this runtime does not ship`. |
| `KHR_texture_basisu` | **Not supported** when required. The KTX2 transcoder is a separate binary. A model that *requires* it fails early with a message naming it; one that merely *uses* it loads with those textures missing, as the extension allows. |

Nothing is downloaded "just in case". Shipping Draco and KTX2 is a follow-up that should be measured as the handoff asks — decoder bytes, decoding time, GPU upload, visual regressions — against the devices the site targets, with the decoders served from the site itself, not a CDN, so offline installation keeps working.
