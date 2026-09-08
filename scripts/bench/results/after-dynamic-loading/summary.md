# Bench: after-dynamic-loading

## Host: single

Generated 2026-09-08T00:46:15.823Z · apps/softn-single/dist built 2026-09-08T00:37:48.662Z · package 0.0.7 · git audit/dynamic-loading@e9fccda (dirty tree)

Edg/152.0.4191.66 headless · SwiftShader software WebGL (headless); not a GPU · AMD Ryzen 9 9950X3D 16-Core Processor (32 cores, 190 GB) · win32 10.0.26200 · Node v24.12.0

5 runs per scenario, fresh profile each; cold = HTTP cache disabled, warm = second navigation in the same profile. localhost HTTP/1.1, no compression, deployment cache headers. Medians and nearest-rank p90 over runs.

### minimal — Minimal text and form

A heading, a paragraph, an input and a button. No 3D. Bundle: 1.1 KB (logic/main.logic 0.1 KB, manifest.json 0.3 KB, permission.json 0.0 KB, ui/main.ui 0.7 KB).

- cold: ready 5/5; 3D module URL requested in 0/5; 3D code inside loaded JS in 0/5; WebGL2 available in 5/5 (ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)); service worker controlling 0/5
- warm: ready 5/5; 3D module URL requested in 0/5; 3D code inside loaded JS in 0/5; WebGL2 available in 5/5 (ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)); service worker controlling 0/5

| metric | cold median | cold p90 | warm median | warm p90 |
|---|---:|---:|---:|---:|
| app ready (ms) | 306 | 374 | 32 | 47 |
| first paint (ms) | 336 | 409 | 72 | 91 |
| first contentful paint (ms) | 336 | 409 | 72 | 91 |
| document responseEnd (ms) | 239 | 308 | 5 | 6 |
| DOMContentLoaded (ms) | 273 | 341 | 19 | 36 |
| load event end (ms) | 273 | 341 | 20 | 36 |
| page requests | 7 | 7 | 7 | 7 |
| page bytes on the wire | 5743.2 KB | 5743.2 KB | 3.6 KB | 3.6 KB |
| page bytes loaded (content-length, cached or not) | 5741.1 KB | 5741.1 KB | 5741.1 KB | 5741.1 KB |
| JS bytes | 611.7 KB | 611.7 KB | 0.0 KB | 0.0 KB |
| wasm bytes | 5126.1 KB | 5126.1 KB | 0.0 KB | 0.0 KB |
| CSS bytes | 1.8 KB | 1.8 KB | 0.0 KB | 0.0 KB |
| bundle bytes | 1.4 KB | 1.4 KB | 1.4 KB | 1.4 KB |
| requests from HTTP cache | 0 | 0 | 4 | 4 |
| requests from service worker | 0 | 0 | 0 | 0 |
| failed requests | 0 | 0 | 0 | 0 |
| page requests until ready | 7 | 7 | 7 | 7 |
| page bytes until ready | 5743.2 KB | 5743.2 KB | 3.6 KB | 3.6 KB |
| service worker requests | 0 | 0 | 0 | 0 |
| service worker bytes on the wire | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB |
| service worker bytes loaded (content-length) | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB |
| service worker requests from HTTP cache | 0 | 0 | 0 | 0 |
| service worker bytes on the wire until ready | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB |
| dedicated worker requests | 0 | 0 | 0 | 0 |
| dedicated worker bytes on the wire | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB |
| dedicated worker bytes loaded (content-length) | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB |
| long tasks | 0 | 0 | 0 | 0 |
| long task total (ms) | 0 | 0 | 0 | 0 |
| longest task (ms) | 0 | 0 | 0 | 0 |
| script time (ms) | 19 | 19 | 8 | 8 |
| main-thread task time (ms) | 107 | 109 | 44 | 59 |
| JS heap used (MB) | 3.1 | 3.2 | 4.6 | 4.7 |
| uncaught errors | 0 | 0 | 0 | 0 |

| phase (softn: marks, ms) | cold median | cold p90 | warm median | warm p90 |
|---|---:|---:|---:|---:|
| softn:bundle-fetch | 5 | 9 | 2 | 2 |
| softn:component-preload | 2 | 2 | 2 | 2 |
| softn:compose | 1 | 1 | 0 | 0 |
| softn:digest | 0 | 0 | 0 | 0 |
| softn:parse | 1 | 1 | 0 | 0 |
| softn:vm-init | 73 | 85 | 17 | 18 |
| softn:xdb-seed | 1 | 1 | 0 | 0 |
| softn:zip | 1 | 1 | 0 | 1 |

<details><summary>Requests, cold pass (representative run: 7 rows)</summary>

| # | context | kind | status | bytes | cache | url |
|---:|---|---|---:|---:|---|---|
| 1 | page | html | 200 | 1.8 KB | network | `/s/minimal/` |
| 2 | page | js | 200 | 611.4 KB | network | `/s/minimal/assets/index-DMXCCIp5.js` |
| 3 | page | css | 200 | 1.8 KB | network | `/s/minimal/assets/index-AvXQ3nb8.css` |
| 4 | page | json | 200 | 0.4 KB | network | `/s/minimal/runtime.config.json` |
| 5 | page | bundle | 200 | 1.4 KB | network | `/s/minimal/app.softn` |
| 6 | page | wasm | 200 | 5126.1 KB | network | `/s/minimal/assets/zipp_wasm_bg-DZSXgiaN.wasm` |
| 7 | page | js | 200 | 0.4 KB | network | `/s/minimal/assets/xdb-N2VKATSB-CAPnBhP7.js` |

</details>

<details><summary>Requests, warm pass (representative run: 7 rows)</summary>

| # | context | kind | status | bytes | cache | url |
|---:|---|---|---:|---:|---|---|
| 1 | page | html | 200 | 1.8 KB | network | `/s/minimal/` |
| 2 | page | js | 200 | 0.0 KB | memory | `/s/minimal/assets/index-DMXCCIp5.js` |
| 3 | page | css | 200 | 0.0 KB | memory | `/s/minimal/assets/index-AvXQ3nb8.css` |
| 4 | page | json | 200 | 0.4 KB | network | `/s/minimal/runtime.config.json` |
| 5 | page | bundle | 200 | 1.4 KB | network | `/s/minimal/app.softn` |
| 6 | page | wasm | 200 | 0.0 KB | disk | `/s/minimal/assets/zipp_wasm_bg-DZSXgiaN.wasm` |
| 7 | page | js | 200 | 0.0 KB | memory | `/s/minimal/assets/xdb-N2VKATSB-CAPnBhP7.js` |

</details>

### scene-glb — Scene3D with one bundled GLB

One Scene3D, one bundled glTF binary, no effects, no orbit controls. Bundle: 1.9 KB (logic/main.logic 0.4 KB, manifest.json 0.3 KB, permission.json 0.0 KB, ui/main.ui 1.0 KB, assets/models/tetra.glb 1.1 KB).

- cold: ready 5/5; 3D module URL requested in 5/5; 3D code inside loaded JS in 5/5; WebGL2 available in 5/5 (ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)); service worker controlling 0/5
- warm: ready 5/5; 3D module URL requested in 5/5; 3D code inside loaded JS in 5/5; WebGL2 available in 5/5 (ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)); service worker controlling 0/5

Scripts carrying 3D code (cold): three in `/s/scene-glb/assets/vendor-three-CH15DcEN.js`; gltf in `/s/scene-glb/assets/GLTFLoader-CGDVEtfg.js`.

| metric | cold median | cold p90 | warm median | warm p90 |
|---|---:|---:|---:|---:|
| app ready (ms) | 342 | 356 | 69 | 93 |
| first paint (ms) | 336 | 339 | 78 | 98 |
| first contentful paint (ms) | 336 | 339 | 78 | 98 |
| document responseEnd (ms) | 235 | 240 | 5 | 6 |
| DOMContentLoaded (ms) | 266 | 272 | 22 | 40 |
| load event end (ms) | 266 | 273 | 22 | 40 |
| first WebGL context (ms) | 333 | 348 | 63 | 85 |
| first GL draw (ms) | 381 | 425 | 105 | 134 |
| page requests | 12 | 12 | 12 | 12 |
| page bytes on the wire | 6403.9 KB | 6403.9 KB | 4.4 KB | 4.4 KB |
| page bytes loaded (content-length, cached or not) | 6402.0 KB | 6402.0 KB | 6402.0 KB | 6402.0 KB |
| JS bytes | 1271.6 KB | 1271.6 KB | 0.0 KB | 0.0 KB |
| wasm bytes | 5126.1 KB | 5126.1 KB | 0.0 KB | 0.0 KB |
| CSS bytes | 1.8 KB | 1.8 KB | 0.0 KB | 0.0 KB |
| bundle bytes | 2.2 KB | 2.2 KB | 2.2 KB | 2.2 KB |
| requests from HTTP cache | 0 | 0 | 7 | 7 |
| requests from service worker | 0 | 0 | 0 | 0 |
| failed requests | 0 | 0 | 0 | 0 |
| page requests until ready | 12 | 12 | 12 | 12 |
| page bytes until ready | 6403.9 KB | 6403.9 KB | 4.4 KB | 4.4 KB |
| service worker requests | 0 | 0 | 0 | 0 |
| service worker bytes on the wire | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB |
| service worker bytes loaded (content-length) | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB |
| service worker requests from HTTP cache | 0 | 0 | 0 | 0 |
| service worker bytes on the wire until ready | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB |
| dedicated worker requests | 0 | 0 | 0 | 0 |
| dedicated worker bytes on the wire | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB |
| dedicated worker bytes loaded (content-length) | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB |
| long tasks | 0 | 0 | 0 | 0 |
| long task total (ms) | 0 | 0 | 0 | 0 |
| longest task (ms) | 0 | 0 | 0 | 0 |
| script time (ms) | 102 | 104 | 49 | 58 |
| main-thread task time (ms) | 202 | 205 | 113 | 140 |
| JS heap used (MB) | 4.9 | 6.3 | 7.7 | 9.0 |
| uncaught errors | 0 | 0 | 0 | 0 |

| phase (softn: marks, ms) | cold median | cold p90 | warm median | warm p90 |
|---|---:|---:|---:|---:|
| softn:asset-extract | 0 | 0 | 0 | 0 |
| softn:asset-warm | 18 | 63 | 41 | 54 |
| softn:bundle-fetch | 6 | 9 | 3 | 3 |
| softn:component-preload | 20 | 22 | 7 | 9 |
| softn:compose | 1 | 1 | 0 | 0 |
| softn:digest | 0 | 0 | 0 | 0 |
| softn:parse | 1 | 1 | 1 | 1 |
| softn:vm-init | 111 | 128 | 47 | 58 |
| softn:xdb-seed | 1 | 1 | 0 | 0 |
| softn:zip | 1 | 1 | 1 | 1 |

| mark (ms from navigation) | cold median | warm median |
|---|---:|---:|
| softn:scene3d-assets-ready | 372 | 80 |
| softn:scene3d-first-frame | 391 | 106 |
| softn:scene3d-renderer-ready | 340 | 68 |

3D module URLs the page or a worker fetched (cold): `/s/scene-glb/assets/GLTFLoader-CGDVEtfg.js`, `/s/scene-glb/assets/scene3d-WNubQ0uA.js`.

<details><summary>Requests, cold pass (representative run: 12 rows)</summary>

| # | context | kind | status | bytes | cache | url |
|---:|---|---|---:|---:|---|---|
| 1 | page | html | 200 | 1.8 KB | network | `/s/scene-glb/` |
| 2 | page | js | 200 | 611.4 KB | network | `/s/scene-glb/assets/index-DMXCCIp5.js` |
| 3 | page | css | 200 | 1.8 KB | network | `/s/scene-glb/assets/index-AvXQ3nb8.css` |
| 4 | page | json | 200 | 0.4 KB | network | `/s/scene-glb/runtime.config.json` |
| 5 | page | bundle | 200 | 2.2 KB | network | `/s/scene-glb/app.softn` |
| 6 | page | js | — | 0.0 KB | network | `/s/scene-glb/assets/zipWorker-CNwCUJT5.js` |
| 7 | page | js | 200 | 56.8 KB | network | `/s/scene-glb/assets/scene3d-WNubQ0uA.js` |
| 8 | page | js | 200 | 558.3 KB | network | `/s/scene-glb/assets/vendor-three-CH15DcEN.js` |
| 9 | page | wasm | 200 | 5126.1 KB | network | `/s/scene-glb/assets/zipp_wasm_bg-DZSXgiaN.wasm` |
| 10 | page | blob | 200 | 0.0 KB | network | `blob:http://127.0.0.1:60570/4d4480be-c9b3-4001-a5e9-75c5d7cfc77f` |
| 11 | page | js | 200 | 44.7 KB | network | `/s/scene-glb/assets/GLTFLoader-CGDVEtfg.js` |
| 12 | page | js | 200 | 0.4 KB | network | `/s/scene-glb/assets/xdb-N2VKATSB-CAPnBhP7.js` |

</details>

<details><summary>Requests, warm pass (representative run: 12 rows)</summary>

| # | context | kind | status | bytes | cache | url |
|---:|---|---|---:|---:|---|---|
| 1 | page | html | 200 | 1.8 KB | network | `/s/scene-glb/` |
| 2 | page | js | 200 | 0.0 KB | memory | `/s/scene-glb/assets/index-DMXCCIp5.js` |
| 3 | page | css | 200 | 0.0 KB | memory | `/s/scene-glb/assets/index-AvXQ3nb8.css` |
| 4 | page | json | 200 | 0.4 KB | network | `/s/scene-glb/runtime.config.json` |
| 5 | page | bundle | 200 | 2.2 KB | network | `/s/scene-glb/app.softn` |
| 6 | page | js | — | 0.0 KB | network | `/s/scene-glb/assets/zipWorker-CNwCUJT5.js` |
| 7 | page | js | 200 | 0.0 KB | memory | `/s/scene-glb/assets/scene3d-WNubQ0uA.js` |
| 8 | page | js | 200 | 0.0 KB | memory | `/s/scene-glb/assets/vendor-three-CH15DcEN.js` |
| 9 | page | wasm | 200 | 0.0 KB | disk | `/s/scene-glb/assets/zipp_wasm_bg-DZSXgiaN.wasm` |
| 10 | page | blob | 200 | 0.0 KB | network | `blob:http://127.0.0.1:60570/9caad944-25ec-449b-bdf3-62eafb21ab93` |
| 11 | page | js | 200 | 0.0 KB | memory | `/s/scene-glb/assets/GLTFLoader-CGDVEtfg.js` |
| 12 | page | js | 200 | 0.0 KB | memory | `/s/scene-glb/assets/xdb-N2VKATSB-CAPnBhP7.js` |

</details>

### scene-effects — Scene3D with bloom

The scene-glb fixture with bloom on, so the post-processing path is exercised. Bundle: 2.0 KB (logic/main.logic 0.4 KB, manifest.json 0.3 KB, permission.json 0.0 KB, ui/main.ui 1.0 KB, assets/models/tetra.glb 1.1 KB).

- cold: ready 5/5; 3D module URL requested in 5/5; 3D code inside loaded JS in 5/5; WebGL2 available in 5/5 (ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)); service worker controlling 0/5
- warm: ready 5/5; 3D module URL requested in 5/5; 3D code inside loaded JS in 5/5; WebGL2 available in 5/5 (ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)); service worker controlling 0/5

Scripts carrying 3D code (cold): three in `/s/scene-effects/assets/vendor-three-CH15DcEN.js`; gltf in `/s/scene-effects/assets/GLTFLoader-CGDVEtfg.js`; postprocessing in `/s/scene-effects/assets/EffectComposer-Bb3GwojG.js`; bloom in `/s/scene-effects/assets/UnrealBloomPass-Ceb1K-D4.js`.

| metric | cold median | cold p90 | warm median | warm p90 |
|---|---:|---:|---:|---:|
| app ready (ms) | 322 | 346 | 193 | 200 |
| first paint (ms) | 315 | 338 | 214 | 237 |
| first contentful paint (ms) | 315 | 338 | 214 | 237 |
| document responseEnd (ms) | 214 | 248 | 5 | 6 |
| DOMContentLoaded (ms) | 247 | 280 | 153 | 163 |
| load event end (ms) | 247 | 280 | 153 | 163 |
| first WebGL context (ms) | 311 | 337 | 186 | 193 |
| first GL draw (ms) | 380 | 401 | 218 | 229 |
| page requests | 19 | 19 | 19 | 19 |
| page bytes on the wire | 6424.5 KB | 6424.5 KB | 4.5 KB | 4.5 KB |
| page bytes loaded (content-length, cached or not) | 6420.5 KB | 6420.5 KB | 6420.5 KB | 6420.5 KB |
| JS bytes | 1292.2 KB | 1292.2 KB | 0.0 KB | 0.0 KB |
| wasm bytes | 5126.1 KB | 5126.1 KB | 0.0 KB | 0.0 KB |
| CSS bytes | 1.8 KB | 1.8 KB | 0.0 KB | 0.0 KB |
| bundle bytes | 2.3 KB | 2.3 KB | 2.3 KB | 2.3 KB |
| requests from HTTP cache | 0 | 0 | 14 | 14 |
| requests from service worker | 0 | 0 | 0 | 0 |
| failed requests | 0 | 0 | 0 | 0 |
| page requests until ready | 19 | 19 | 19 | 19 |
| page bytes until ready | 6424.5 KB | 6424.5 KB | 4.5 KB | 4.5 KB |
| service worker requests | 0 | 0 | 0 | 0 |
| service worker bytes on the wire | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB |
| service worker bytes loaded (content-length) | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB |
| service worker requests from HTTP cache | 0 | 0 | 0 | 0 |
| service worker bytes on the wire until ready | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB |
| dedicated worker requests | 0 | 0 | 0 | 0 |
| dedicated worker bytes on the wire | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB |
| dedicated worker bytes loaded (content-length) | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB |
| long tasks | 2 | 2 | 1 | 2 |
| long task total (ms) | 133 | 176 | 141 | 191 |
| longest task (ms) | 114 | 121 | 112 | 141 |
| script time (ms) | 208 | 248 | 181 | 244 |
| main-thread task time (ms) | 345 | 368 | 459 | 565 |
| JS heap used (MB) | 6.5 | 6.7 | 9.3 | 10.3 |
| uncaught errors | 0 | 0 | 0 | 0 |

| phase (softn: marks, ms) | cold median | cold p90 | warm median | warm p90 |
|---|---:|---:|---:|---:|
| softn:asset-extract | 0 | 0 | 0 | 0 |
| softn:asset-warm | 23 | 25 | 40 | 48 |
| softn:bundle-fetch | 7 | 7 | 2 | 2 |
| softn:component-preload | 21 | 23 | 7 | 8 |
| softn:compose | 1 | 1 | 0 | 0 |
| softn:digest | 0 | 0 | 0 | 0 |
| softn:parse | 1 | 2 | 1 | 1 |
| softn:vm-init | 97 | 150 | 47 | 185 |
| softn:xdb-seed | 1 | 1 | 0 | 0 |
| softn:zip | 1 | 1 | 1 | 1 |

| mark (ms from navigation) | cold median | warm median |
|---|---:|---:|
| softn:scene3d-assets-ready | 383 | 208 |
| softn:scene3d-first-frame | 490 | 334 |
| softn:scene3d-renderer-ready | 319 | 191 |

3D module URLs the page or a worker fetched (cold): `/s/scene-effects/assets/GLTFLoader-CGDVEtfg.js`, `/s/scene-effects/assets/UnrealBloomPass-Ceb1K-D4.js`, `/s/scene-effects/assets/scene3d-WNubQ0uA.js`.

<details><summary>Requests, cold pass (representative run: 19 rows)</summary>

| # | context | kind | status | bytes | cache | url |
|---:|---|---|---:|---:|---|---|
| 1 | page | html | 200 | 1.8 KB | network | `/s/scene-effects/` |
| 2 | page | js | 200 | 611.4 KB | network | `/s/scene-effects/assets/index-DMXCCIp5.js` |
| 3 | page | css | 200 | 1.8 KB | network | `/s/scene-effects/assets/index-AvXQ3nb8.css` |
| 4 | page | json | 200 | 0.4 KB | network | `/s/scene-effects/runtime.config.json` |
| 5 | page | bundle | 200 | 2.3 KB | network | `/s/scene-effects/app.softn` |
| 6 | page | js | — | 0.0 KB | network | `/s/scene-effects/assets/zipWorker-CNwCUJT5.js` |
| 7 | page | js | 200 | 56.8 KB | network | `/s/scene-effects/assets/scene3d-WNubQ0uA.js` |
| 8 | page | js | 200 | 558.3 KB | network | `/s/scene-effects/assets/vendor-three-CH15DcEN.js` |
| 9 | page | wasm | 200 | 5126.1 KB | network | `/s/scene-effects/assets/zipp_wasm_bg-DZSXgiaN.wasm` |
| 10 | page | js | 200 | 0.4 KB | network | `/s/scene-effects/assets/xdb-N2VKATSB-CAPnBhP7.js` |
| 11 | page | js | 200 | 4.1 KB | network | `/s/scene-effects/assets/EffectComposer-Bb3GwojG.js` |
| 12 | page | js | 200 | 0.7 KB | network | `/s/scene-effects/assets/CopyShader-CHGAmNbz.js` |
| 13 | page | js | 200 | 1.0 KB | network | `/s/scene-effects/assets/Pass-C7UaUlwC.js` |
| 14 | page | js | 200 | 1.2 KB | network | `/s/scene-effects/assets/ShaderPass-CCeC9IPn.js` |
| 15 | page | js | 200 | 1.4 KB | network | `/s/scene-effects/assets/RenderPass-B2-e22jQ.js` |
| 16 | page | js | 200 | 9.2 KB | network | `/s/scene-effects/assets/UnrealBloomPass-Ceb1K-D4.js` |
| 17 | page | js | 200 | 3.1 KB | network | `/s/scene-effects/assets/OutputPass-DUGoZ9ki.js` |
| 18 | page | blob | 200 | 0.0 KB | network | `blob:http://127.0.0.1:60570/aeb6f606-31e1-4b00-ab2a-828ed6cbb9d1` |
| 19 | page | js | 200 | 44.7 KB | network | `/s/scene-effects/assets/GLTFLoader-CGDVEtfg.js` |

</details>

<details><summary>Requests, warm pass (representative run: 19 rows)</summary>

| # | context | kind | status | bytes | cache | url |
|---:|---|---|---:|---:|---|---|
| 1 | page | html | 200 | 1.8 KB | network | `/s/scene-effects/` |
| 2 | page | js | 200 | 0.0 KB | memory | `/s/scene-effects/assets/index-DMXCCIp5.js` |
| 3 | page | css | 200 | 0.0 KB | memory | `/s/scene-effects/assets/index-AvXQ3nb8.css` |
| 4 | page | json | 200 | 0.4 KB | network | `/s/scene-effects/runtime.config.json` |
| 5 | page | bundle | 200 | 2.3 KB | network | `/s/scene-effects/app.softn` |
| 6 | page | js | — | 0.0 KB | network | `/s/scene-effects/assets/zipWorker-CNwCUJT5.js` |
| 7 | page | js | 200 | 0.0 KB | memory | `/s/scene-effects/assets/scene3d-WNubQ0uA.js` |
| 8 | page | js | 200 | 0.0 KB | memory | `/s/scene-effects/assets/vendor-three-CH15DcEN.js` |
| 9 | page | wasm | 200 | 0.0 KB | disk | `/s/scene-effects/assets/zipp_wasm_bg-DZSXgiaN.wasm` |
| 10 | page | js | 200 | 0.0 KB | memory | `/s/scene-effects/assets/EffectComposer-Bb3GwojG.js` |
| 11 | page | js | 200 | 0.0 KB | memory | `/s/scene-effects/assets/CopyShader-CHGAmNbz.js` |
| 12 | page | js | 200 | 0.0 KB | memory | `/s/scene-effects/assets/Pass-C7UaUlwC.js` |
| 13 | page | js | 200 | 0.0 KB | memory | `/s/scene-effects/assets/ShaderPass-CCeC9IPn.js` |
| 14 | page | js | 200 | 0.0 KB | memory | `/s/scene-effects/assets/RenderPass-B2-e22jQ.js` |
| 15 | page | js | 200 | 0.0 KB | memory | `/s/scene-effects/assets/UnrealBloomPass-Ceb1K-D4.js` |
| 16 | page | js | 200 | 0.0 KB | memory | `/s/scene-effects/assets/OutputPass-DUGoZ9ki.js` |
| 17 | page | blob | 200 | 0.0 KB | network | `blob:http://127.0.0.1:60570/c11368e2-13f0-4c7d-b1a4-ea45d29a4526` |
| 18 | page | js | 200 | 0.0 KB | memory | `/s/scene-effects/assets/GLTFLoader-CGDVEtfg.js` |
| 19 | page | js | 200 | 0.0 KB | memory | `/s/scene-effects/assets/xdb-N2VKATSB-CAPnBhP7.js` |

</details>

## Host: web

Generated 2026-09-08T00:48:59.123Z · apps/softn-web/dist built 2026-09-08T00:40:09.816Z · package 0.0.7 · git audit/dynamic-loading@e9fccda (dirty tree)

Edg/152.0.4191.66 headless · SwiftShader software WebGL (headless); not a GPU · AMD Ryzen 9 9950X3D 16-Core Processor (32 cores, 190 GB) · win32 10.0.26200 · Node v24.12.0

5 runs per scenario, fresh profile each; cold = HTTP cache disabled, warm = second navigation in the same profile. localhost HTTP/1.1, no compression, deployment cache headers. Medians and nearest-rank p90 over runs.

### minimal — Minimal text and form

A heading, a paragraph, an input and a button. No 3D. Bundle: 1.1 KB (logic/main.logic 0.1 KB, manifest.json 0.3 KB, permission.json 0.0 KB, ui/main.ui 0.7 KB).

- cold: ready 5/5; 3D module URL requested in 0/5; 3D code inside loaded JS in 0/5; WebGL2 available in 5/5 (ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)); service worker controlling 5/5
- warm: ready 5/5; 3D module URL requested in 0/5; 3D code inside loaded JS in 0/5; WebGL2 available in 5/5 (ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)); service worker controlling 5/5

| metric | cold median | cold p90 | warm median | warm p90 |
|---|---:|---:|---:|---:|
| app ready (ms) | 398 | 447 | 51 | 54 |
| first paint (ms) | 306 | 364 | 64 | 70 |
| first contentful paint (ms) | 539 | 614 | 96 | 163 |
| document responseEnd (ms) | 223 | 279 | 14 | 15 |
| DOMContentLoaded (ms) | 263 | 328 | 32 | 36 |
| load event end (ms) | 264 | 329 | 32 | 36 |
| page requests | 15 | 15 | 9 | 9 |
| page bytes on the wire | 5994.3 KB | 5994.3 KB | 1.4 KB | 1.4 KB |
| page bytes loaded (content-length, cached or not) | 5989.9 KB | 5989.9 KB | 5865.4 KB | 5865.4 KB |
| JS bytes | 716.3 KB | 716.3 KB | 0.0 KB | 0.0 KB |
| wasm bytes | 5126.1 KB | 5126.1 KB | 0.0 KB | 0.0 KB |
| CSS bytes | 15.6 KB | 15.6 KB | 0.0 KB | 0.0 KB |
| bundle bytes | 1.4 KB | 1.4 KB | 1.4 KB | 1.4 KB |
| requests from HTTP cache | 0 | 0 | 7 | 7 |
| requests from service worker | 0 | 0 | 8 | 8 |
| failed requests | 0 | 0 | 0 | 0 |
| page requests until ready | 15 | 15 | 9 | 9 |
| page bytes until ready | 5994.3 KB | 5994.3 KB | 1.4 KB | 1.4 KB |
| service worker requests | 47 | 47 | 1 | 1 |
| service worker bytes on the wire | 344.8 KB | 344.8 KB | 2.6 KB | 2.6 KB |
| service worker bytes loaded (content-length) | 6343.7 KB | 6343.7 KB | 2.3 KB | 2.3 KB |
| service worker requests from HTTP cache | 9 | 9 | 0 | 0 |
| service worker bytes on the wire until ready | 344.8 KB | 344.8 KB | 2.6 KB | 2.6 KB |
| dedicated worker requests | 0 | 0 | 0 | 0 |
| dedicated worker bytes on the wire | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB |
| dedicated worker bytes loaded (content-length) | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB |
| long tasks | 0 | 0 | 0 | 0 |
| long task total (ms) | 0 | 0 | 0 | 0 |
| longest task (ms) | 0 | 0 | 0 | 0 |
| script time (ms) | 31 | 33 | 12 | 15 |
| main-thread task time (ms) | 143 | 149 | 48 | 55 |
| JS heap used (MB) | 3.9 | 3.9 | 5.1 | 5.1 |
| uncaught errors | 0 | 0 | 0 | 0 |

| phase (softn: marks, ms) | cold median | cold p90 | warm median | warm p90 |
|---|---:|---:|---:|---:|
| softn:component-preload | 3 | 3 | 2 | 3 |
| softn:compose | 1 | 1 | 0 | 0 |
| softn:offline-install | 278 | 303 | — | — |
| softn:parse | 0 | 0 | 0 | 0 |
| softn:vm-init | 85 | 123 | 18 | 22 |
| softn:xdb-seed | 0 | 0 | 0 | 0 |
| softn:zip | 2 | 2 | 1 | 1 |

<details><summary>Requests, cold pass (representative run: 62 rows)</summary>

| # | context | kind | status | bytes | cache | url |
|---:|---|---|---:|---:|---|---|
| 1 | page | html | 200 | 2.6 KB | network | `/?open=%2Fbench%2Fminimal.softn&embed=1` |
| 2 | page | js | 200 | 715.5 KB | network | `/assets/index-DSZmgK9M.js` |
| 3 | page | css | 200 | 15.6 KB | network | `/assets/index-BdKE3FSy.css` |
| 4 | page | js | 200 | 0.4 KB | network | `/registerSW.js` |
| 5 | page | json | 200 | 0.8 KB | network | `/manifest.webmanifest` |
| 6 | page | bundle | 200 | 1.4 KB | network | `/bench/minimal.softn` |
| 7 | page | font | 200 | 40.7 KB | network | `/assets/bricolage-grotesque-latin-wght-normal-DLoelf7F.woff2` |
| 8 | page | font | 200 | 22.3 KB | network | `/assets/ibm-plex-sans-latin-400-normal-CDDApCn2.woff2` |
| 9 | page | font | 200 | 14.6 KB | network | `/assets/ibm-plex-mono-latin-400-normal-DMJ8VG8y.woff2` |
| 10 | page | font | 200 | 24.0 KB | network | `/assets/ibm-plex-sans-latin-600-normal-CuJfVYMP.woff2` |
| 11 | page | font | 200 | 23.9 KB | network | `/assets/ibm-plex-sans-latin-500-normal-6ng42L7E.woff2` |
| 12 | page | image | 200 | 0.7 KB | network | `/favicon.svg` |
| 13 | serviceWorker | js | 200 | 0.3 KB | network | `/sw.js` |
| 14 | page | image | 200 | 5.2 KB | network | `/pwa-192x192.png` |
| 15 | serviceWorker | js | 200 | 0.0 KB | network | `/workbox-63c18b4d.js` |
| 16 | serviceWorker | js | 200 | 0.0 KB | network | `/coi.js` |
| 17 | serviceWorker | js | 200 | 0.4 KB | network | `/registerSW.js` |
| 18 | serviceWorker | image | 200 | 8.7 KB | network | `/pwa-maskable-512x512.png` |
| 19 | page | wasm | 200 | 5126.1 KB | network | `/assets/zipp_wasm_bg-DZSXgiaN.wasm` |
| 20 | serviceWorker | image | 200 | 15.0 KB | network | `/pwa-512x512.png` |
| 21 | serviceWorker | image | 200 | 5.2 KB | network | `/pwa-192x192.png` |
| 22 | serviceWorker | html | 200 | 2.6 KB | network | `/index.html` |
| 23 | page | js | 200 | 0.4 KB | network | `/assets/xdb-N2VKATSB-BwhH368Z.js` |
| 24 | serviceWorker | image | 200 | 0.7 KB | network | `/favicon.svg` |
| 25 | serviceWorker | js | 200 | 1.9 KB | network | `/coi.js` |
| 26 | serviceWorker | js | 200 | 10.9 KB | network | `/assets/zipWorker-DuMQt4DG.js` |
| 27 | serviceWorker | wasm | 200 | 0.0 KB | disk | `/assets/zipp_wasm_bg-DZSXgiaN.wasm` |
| 28 | serviceWorker | js | 200 | 0.0 KB | disk | `/assets/xdb-N2VKATSB-BwhH368Z.js` |
| 29 | serviceWorker | js | 200 | 0.0 KB | disk | `/assets/index-DSZmgK9M.js` |
| 30 | serviceWorker | css | 200 | 0.0 KB | disk | `/assets/index-BdKE3FSy.css` |
| 31 | serviceWorker | font | 200 | 8.5 KB | network | `/assets/ibm-plex-sans-vietnamese-600-normal-DpPYBSTl.woff2` |
| 32 | serviceWorker | font | 200 | 8.5 KB | network | `/assets/ibm-plex-sans-vietnamese-500-normal-e4dixQRQ.woff2` |
| 33 | serviceWorker | font | 200 | 8.3 KB | network | `/assets/ibm-plex-sans-vietnamese-400-normal-DG4YqDda.woff2` |
| 34 | serviceWorker | font | 200 | 16.3 KB | network | `/assets/ibm-plex-sans-latin-ext-600-normal-DOrvGEcy.woff2` |
| 35 | serviceWorker | font | 200 | 16.4 KB | network | `/assets/ibm-plex-sans-latin-ext-500-normal-DakdToA3.woff2` |
| 36 | serviceWorker | font | 200 | 15.9 KB | network | `/assets/ibm-plex-sans-latin-ext-400-normal-C5H60-Va.woff2` |
| 37 | serviceWorker | font | 200 | 0.0 KB | disk | `/assets/ibm-plex-sans-latin-600-normal-CuJfVYMP.woff2` |
| 38 | serviceWorker | font | 200 | 0.0 KB | disk | `/assets/ibm-plex-sans-latin-500-normal-6ng42L7E.woff2` |
| 39 | serviceWorker | font | 200 | 0.0 KB | disk | `/assets/ibm-plex-sans-latin-400-normal-CDDApCn2.woff2` |
| 40 | serviceWorker | font | 200 | 10.4 KB | network | `/assets/ibm-plex-sans-greek-600-normal-DzTrcv_p.woff2` |
| 41 | serviceWorker | font | 200 | 10.4 KB | network | `/assets/ibm-plex-sans-greek-500-normal-JMMifIXV.woff2` |
| 42 | serviceWorker | font | 200 | 10.0 KB | network | `/assets/ibm-plex-sans-greek-400-normal-_efipK4i.woff2` |
| 43 | serviceWorker | font | 200 | 12.3 KB | network | `/assets/ibm-plex-sans-cyrillic-ext-600-normal-DUMzJB7m.woff2` |
| 44 | serviceWorker | font | 200 | 12.3 KB | network | `/assets/ibm-plex-sans-cyrillic-ext-500-normal-Cs5J6C77.woff2` |
| 45 | serviceWorker | font | 200 | 12.1 KB | network | `/assets/ibm-plex-sans-cyrillic-ext-400-normal-g30qAdWV.woff2` |
| 46 | serviceWorker | font | 200 | 15.0 KB | network | `/assets/ibm-plex-sans-cyrillic-600-normal-71GNu3SW.woff2` |
| 47 | serviceWorker | font | 200 | 14.9 KB | network | `/assets/ibm-plex-sans-cyrillic-500-normal-CocWQlwt.woff2` |
| 48 | serviceWorker | font | 200 | 14.7 KB | network | `/assets/ibm-plex-sans-cyrillic-400-normal-DZqxrq2p.woff2` |
| 49 | serviceWorker | font | 200 | 6.2 KB | network | `/assets/ibm-plex-mono-vietnamese-500-normal-DZ4AoWbu.woff2` |
| 50 | serviceWorker | font | 200 | 6.0 KB | network | `/assets/ibm-plex-mono-vietnamese-400-normal-BulugwFq.woff2` |
| 51 | serviceWorker | font | 200 | 13.4 KB | network | `/assets/ibm-plex-mono-latin-ext-500-normal-CAhNIIs5.woff2` |
| 52 | serviceWorker | font | 200 | 13.3 KB | network | `/assets/ibm-plex-mono-latin-ext-400-normal-BmRBH3aV.woff2` |
| 53 | serviceWorker | font | 200 | 14.8 KB | network | `/assets/ibm-plex-mono-latin-500-normal-DSY6xOcd.woff2` |
| 54 | serviceWorker | font | 200 | 0.0 KB | disk | `/assets/ibm-plex-mono-latin-400-normal-DMJ8VG8y.woff2` |
| 55 | serviceWorker | font | 200 | 7.1 KB | network | `/assets/ibm-plex-mono-cyrillic-ext-500-normal-BqneJy0T.woff2` |
| 56 | serviceWorker | font | 200 | 7.0 KB | network | `/assets/ibm-plex-mono-cyrillic-ext-400-normal-xuaO2J-f.woff2` |
| 57 | serviceWorker | font | 200 | 8.5 KB | network | `/assets/ibm-plex-mono-cyrillic-500-normal-Bq9vWWag.woff2` |
| 58 | serviceWorker | font | 200 | 8.4 KB | network | `/assets/ibm-plex-mono-cyrillic-400-normal-BSMlKf0J.woff2` |
| 59 | serviceWorker | font | 200 | 8.7 KB | network | `/assets/bricolage-grotesque-vietnamese-wght-normal-BUzh504Q.woff2` |
| 60 | serviceWorker | font | 200 | 0.0 KB | disk | `/assets/bricolage-grotesque-latin-wght-normal-DLoelf7F.woff2` |
| 61 | serviceWorker | font | 200 | 18.5 KB | network | `/assets/bricolage-grotesque-latin-ext-wght-normal-CcLUaPy7.woff2` |
| 62 | serviceWorker | json | 200 | 0.8 KB | network | `/manifest.webmanifest` |

</details>

<details><summary>Requests, warm pass (representative run: 10 rows)</summary>

| # | context | kind | status | bytes | cache | url |
|---:|---|---|---:|---:|---|---|
| 1 | page | html | 200 | 0.0 KB | sw | `/?open=%2Fbench%2Fminimal.softn&embed=1` |
| 2 | serviceWorker | html | 200 | 2.6 KB | network | `/?open=%2Fbench%2Fminimal.softn&embed=1` |
| 3 | page | js | 200 | 0.0 KB | sw | `/assets/index-DSZmgK9M.js` |
| 4 | page | css | 200 | 0.0 KB | sw | `/assets/index-BdKE3FSy.css` |
| 5 | page | js | 200 | 0.0 KB | sw | `/registerSW.js` |
| 6 | page | json | 200 | 0.0 KB | sw | `/manifest.webmanifest` |
| 7 | page | bundle | 200 | 1.4 KB | network | `/bench/minimal.softn` |
| 8 | page | image | 200 | 0.0 KB | sw | `/pwa-192x192.png` |
| 9 | page | wasm | 200 | 0.0 KB | sw | `/assets/zipp_wasm_bg-DZSXgiaN.wasm` |
| 10 | page | js | 200 | 0.0 KB | sw | `/assets/xdb-N2VKATSB-BwhH368Z.js` |

</details>

### scene-glb — Scene3D with one bundled GLB

One Scene3D, one bundled glTF binary, no effects, no orbit controls. Bundle: 1.9 KB (logic/main.logic 0.4 KB, manifest.json 0.3 KB, permission.json 0.0 KB, ui/main.ui 1.0 KB, assets/models/tetra.glb 1.1 KB).

- cold: ready 5/5; 3D module URL requested in 5/5; 3D code inside loaded JS in 5/5; WebGL2 available in 5/5 (ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)); service worker controlling 5/5
- warm: ready 5/5; 3D module URL requested in 5/5; 3D code inside loaded JS in 5/5; WebGL2 available in 5/5 (ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)); service worker controlling 5/5

Scripts carrying 3D code (cold): three in `/assets/vendor-three-DRaE6mEZ.js`; gltf in `/assets/GLTFLoader-DBAV7NEX.js`.

| metric | cold median | cold p90 | warm median | warm p90 |
|---|---:|---:|---:|---:|
| app ready (ms) | 442 | 466 | 87 | 109 |
| first paint (ms) | 307 | 338 | 75 | 86 |
| first contentful paint (ms) | 492 | 499 | 105 | 107 |
| document responseEnd (ms) | 214 | 277 | 12 | 16 |
| DOMContentLoaded (ms) | 261 | 310 | 32 | 37 |
| load event end (ms) | 262 | 310 | 33 | 38 |
| first WebGL context (ms) | 431 | 455 | 81 | 103 |
| first GL draw (ms) | 514 | 530 | 115 | 143 |
| page requests | 20 | 20 | 14 | 14 |
| page bytes on the wire | 6655.2 KB | 6655.2 KB | 2.2 KB | 2.2 KB |
| page bytes loaded (content-length, cached or not) | 6651.1 KB | 6651.1 KB | 6526.5 KB | 6526.5 KB |
| JS bytes | 1376.5 KB | 1376.5 KB | 0.0 KB | 0.0 KB |
| wasm bytes | 5126.1 KB | 5126.1 KB | 0.0 KB | 0.0 KB |
| CSS bytes | 15.6 KB | 15.6 KB | 0.0 KB | 0.0 KB |
| bundle bytes | 2.2 KB | 2.2 KB | 2.2 KB | 2.2 KB |
| requests from HTTP cache | 0 | 0 | 10 | 10 |
| requests from service worker | 0 | 0 | 11 | 11 |
| failed requests | 0 | 0 | 0 | 0 |
| page requests until ready | 20 | 20 | 14 | 14 |
| page bytes until ready | 6655.2 KB | 6655.2 KB | 2.2 KB | 2.2 KB |
| service worker requests | 47 | 47 | 5 | 5 |
| service worker bytes on the wire | 334.3 KB | 334.3 KB | 2.6 KB | 2.6 KB |
| service worker bytes loaded (content-length) | 6343.7 KB | 6343.7 KB | 672.2 KB | 672.2 KB |
| service worker requests from HTTP cache | 9 | 10 | 4 | 4 |
| service worker bytes on the wire until ready | 334.3 KB | 334.3 KB | 2.6 KB | 2.6 KB |
| dedicated worker requests | 0 | 0 | 0 | 0 |
| dedicated worker bytes on the wire | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB |
| dedicated worker bytes loaded (content-length) | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB |
| long tasks | 1 | 1 | 0 | 0 |
| long task total (ms) | 50 | 77 | 0 | 0 |
| longest task (ms) | 50 | 77 | 0 | 0 |
| script time (ms) | 141 | 150 | 46 | 64 |
| main-thread task time (ms) | 282 | 295 | 106 | 126 |
| JS heap used (MB) | 5.7 | 5.8 | 9.5 | 9.7 |
| uncaught errors | 0 | 0 | 0 | 0 |

| phase (softn: marks, ms) | cold median | cold p90 | warm median | warm p90 |
|---|---:|---:|---:|---:|
| softn:asset-extract | 0 | 0 | 0 | 0 |
| softn:asset-warm | 22 | 25 | 37 | 42 |
| softn:component-preload | 19 | 21 | 21 | 22 |
| softn:compose | 1 | 1 | 0 | 0 |
| softn:offline-install | 296 | 310 | — | — |
| softn:parse | 1 | 1 | 0 | 1 |
| softn:vm-init | 142 | 151 | 48 | 62 |
| softn:xdb-seed | 0 | 0 | 0 | 0 |
| softn:zip | 2 | 2 | 1 | 1 |

| mark (ms from navigation) | cold median | warm median |
|---|---:|---:|
| softn:scene3d-assets-ready | 466 | 93 |
| softn:scene3d-first-frame | 514 | 115 |
| softn:scene3d-renderer-ready | 440 | 86 |

3D module URLs the page or a worker fetched (cold): `/assets/GLTFLoader-DBAV7NEX.js`, `/assets/scene3d-CsGv-ogZ.js`.

<details><summary>Requests, cold pass (representative run: 67 rows)</summary>

| # | context | kind | status | bytes | cache | url |
|---:|---|---|---:|---:|---|---|
| 1 | page | html | 200 | 2.6 KB | network | `/?open=%2Fbench%2Fscene-glb.softn&embed=1` |
| 2 | page | js | 200 | 715.5 KB | network | `/assets/index-DSZmgK9M.js` |
| 3 | page | css | 200 | 15.6 KB | network | `/assets/index-BdKE3FSy.css` |
| 4 | page | js | 200 | 0.4 KB | network | `/registerSW.js` |
| 5 | page | json | 200 | 0.8 KB | network | `/manifest.webmanifest` |
| 6 | page | font | 200 | 40.7 KB | network | `/assets/bricolage-grotesque-latin-wght-normal-DLoelf7F.woff2` |
| 7 | page | font | 200 | 22.3 KB | network | `/assets/ibm-plex-sans-latin-400-normal-CDDApCn2.woff2` |
| 8 | page | font | 200 | 14.6 KB | network | `/assets/ibm-plex-mono-latin-400-normal-DMJ8VG8y.woff2` |
| 9 | page | font | 200 | 24.0 KB | network | `/assets/ibm-plex-sans-latin-600-normal-CuJfVYMP.woff2` |
| 10 | page | font | 200 | 23.9 KB | network | `/assets/ibm-plex-sans-latin-500-normal-6ng42L7E.woff2` |
| 11 | page | bundle | 200 | 2.2 KB | network | `/bench/scene-glb.softn` |
| 12 | serviceWorker | js | 200 | 0.3 KB | network | `/sw.js` |
| 13 | page | image | 200 | 0.7 KB | network | `/favicon.svg` |
| 14 | page | image | 200 | 5.2 KB | network | `/pwa-192x192.png` |
| 15 | serviceWorker | js | 200 | 0.0 KB | network | `/workbox-63c18b4d.js` |
| 16 | serviceWorker | js | 200 | 0.0 KB | network | `/coi.js` |
| 17 | serviceWorker | js | 200 | 0.4 KB | network | `/registerSW.js` |
| 18 | page | js | — | 0.0 KB | network | `/assets/zipWorker-DuMQt4DG.js` |
| 19 | page | js | 200 | 57.0 KB | network | `/assets/scene3d-CsGv-ogZ.js` |
| 20 | page | js | 200 | 558.4 KB | network | `/assets/vendor-three-DRaE6mEZ.js` |
| 21 | serviceWorker | image | 200 | 8.7 KB | network | `/pwa-maskable-512x512.png` |
| 22 | page | wasm | 200 | 5126.1 KB | network | `/assets/zipp_wasm_bg-DZSXgiaN.wasm` |
| 23 | serviceWorker | image | 200 | 15.0 KB | network | `/pwa-512x512.png` |
| 24 | serviceWorker | image | 200 | 5.2 KB | network | `/pwa-192x192.png` |
| 25 | serviceWorker | html | 200 | 2.6 KB | network | `/index.html` |
| 26 | serviceWorker | image | 200 | 0.7 KB | network | `/favicon.svg` |
| 27 | serviceWorker | js | 200 | 1.9 KB | network | `/coi.js` |
| 28 | serviceWorker | js | 200 | 0.0 KB | disk | `/assets/zipWorker-DuMQt4DG.js` |
| 29 | page | blob | 200 | 0.0 KB | network | `blob:http://127.0.0.1:58345/1ef5aaab-364d-4e35-ad7a-59e9f557e07c` |
| 30 | page | js | 200 | 44.8 KB | network | `/assets/GLTFLoader-DBAV7NEX.js` |
| 31 | serviceWorker | wasm | 200 | 0.0 KB | disk | `/assets/zipp_wasm_bg-DZSXgiaN.wasm` |
| 32 | page | js | 200 | 0.4 KB | network | `/assets/xdb-N2VKATSB-BwhH368Z.js` |
| 33 | serviceWorker | js | 200 | 0.0 KB | disk | `/assets/xdb-N2VKATSB-BwhH368Z.js` |
| 34 | serviceWorker | js | 200 | 0.0 KB | disk | `/assets/index-DSZmgK9M.js` |
| 35 | serviceWorker | css | 200 | 0.0 KB | disk | `/assets/index-BdKE3FSy.css` |
| 36 | serviceWorker | font | 200 | 8.5 KB | network | `/assets/ibm-plex-sans-vietnamese-600-normal-DpPYBSTl.woff2` |
| 37 | serviceWorker | font | 200 | 8.5 KB | network | `/assets/ibm-plex-sans-vietnamese-500-normal-e4dixQRQ.woff2` |
| 38 | serviceWorker | font | 200 | 8.3 KB | network | `/assets/ibm-plex-sans-vietnamese-400-normal-DG4YqDda.woff2` |
| 39 | serviceWorker | font | 200 | 16.3 KB | network | `/assets/ibm-plex-sans-latin-ext-600-normal-DOrvGEcy.woff2` |
| 40 | serviceWorker | font | 200 | 16.4 KB | network | `/assets/ibm-plex-sans-latin-ext-500-normal-DakdToA3.woff2` |
| 41 | serviceWorker | font | 200 | 15.9 KB | network | `/assets/ibm-plex-sans-latin-ext-400-normal-C5H60-Va.woff2` |
| 42 | serviceWorker | font | 200 | 0.0 KB | disk | `/assets/ibm-plex-sans-latin-600-normal-CuJfVYMP.woff2` |
| 43 | serviceWorker | font | 200 | 0.0 KB | disk | `/assets/ibm-plex-sans-latin-500-normal-6ng42L7E.woff2` |
| 44 | serviceWorker | font | 200 | 0.0 KB | disk | `/assets/ibm-plex-sans-latin-400-normal-CDDApCn2.woff2` |
| 45 | serviceWorker | font | 200 | 10.4 KB | network | `/assets/ibm-plex-sans-greek-600-normal-DzTrcv_p.woff2` |
| 46 | serviceWorker | font | 200 | 10.4 KB | network | `/assets/ibm-plex-sans-greek-500-normal-JMMifIXV.woff2` |
| 47 | serviceWorker | font | 200 | 10.0 KB | network | `/assets/ibm-plex-sans-greek-400-normal-_efipK4i.woff2` |
| 48 | serviceWorker | font | 200 | 12.3 KB | network | `/assets/ibm-plex-sans-cyrillic-ext-600-normal-DUMzJB7m.woff2` |
| 49 | serviceWorker | font | 200 | 12.3 KB | network | `/assets/ibm-plex-sans-cyrillic-ext-500-normal-Cs5J6C77.woff2` |
| 50 | serviceWorker | font | 200 | 12.1 KB | network | `/assets/ibm-plex-sans-cyrillic-ext-400-normal-g30qAdWV.woff2` |
| 51 | serviceWorker | font | 200 | 15.0 KB | network | `/assets/ibm-plex-sans-cyrillic-600-normal-71GNu3SW.woff2` |
| 52 | serviceWorker | font | 200 | 14.9 KB | network | `/assets/ibm-plex-sans-cyrillic-500-normal-CocWQlwt.woff2` |
| 53 | serviceWorker | font | 200 | 14.7 KB | network | `/assets/ibm-plex-sans-cyrillic-400-normal-DZqxrq2p.woff2` |
| 54 | serviceWorker | font | 200 | 6.2 KB | network | `/assets/ibm-plex-mono-vietnamese-500-normal-DZ4AoWbu.woff2` |
| 55 | serviceWorker | font | 200 | 6.0 KB | network | `/assets/ibm-plex-mono-vietnamese-400-normal-BulugwFq.woff2` |
| 56 | serviceWorker | font | 200 | 13.4 KB | network | `/assets/ibm-plex-mono-latin-ext-500-normal-CAhNIIs5.woff2` |
| 57 | serviceWorker | font | 200 | 13.3 KB | network | `/assets/ibm-plex-mono-latin-ext-400-normal-BmRBH3aV.woff2` |
| 58 | serviceWorker | font | 200 | 14.8 KB | network | `/assets/ibm-plex-mono-latin-500-normal-DSY6xOcd.woff2` |
| 59 | serviceWorker | font | 200 | 0.0 KB | disk | `/assets/ibm-plex-mono-latin-400-normal-DMJ8VG8y.woff2` |
| 60 | serviceWorker | font | 200 | 7.1 KB | network | `/assets/ibm-plex-mono-cyrillic-ext-500-normal-BqneJy0T.woff2` |
| 61 | serviceWorker | font | 200 | 7.0 KB | network | `/assets/ibm-plex-mono-cyrillic-ext-400-normal-xuaO2J-f.woff2` |
| 62 | serviceWorker | font | 200 | 8.5 KB | network | `/assets/ibm-plex-mono-cyrillic-500-normal-Bq9vWWag.woff2` |
| 63 | serviceWorker | font | 200 | 8.4 KB | network | `/assets/ibm-plex-mono-cyrillic-400-normal-BSMlKf0J.woff2` |
| 64 | serviceWorker | font | 200 | 8.7 KB | network | `/assets/bricolage-grotesque-vietnamese-wght-normal-BUzh504Q.woff2` |
| 65 | serviceWorker | font | 200 | 0.0 KB | disk | `/assets/bricolage-grotesque-latin-wght-normal-DLoelf7F.woff2` |
| 66 | serviceWorker | font | 200 | 18.5 KB | network | `/assets/bricolage-grotesque-latin-ext-wght-normal-CcLUaPy7.woff2` |
| 67 | serviceWorker | json | 200 | 0.8 KB | network | `/manifest.webmanifest` |

</details>

<details><summary>Requests, warm pass (representative run: 19 rows)</summary>

| # | context | kind | status | bytes | cache | url |
|---:|---|---|---:|---:|---|---|
| 1 | page | html | 200 | 0.0 KB | sw | `/?open=%2Fbench%2Fscene-glb.softn&embed=1` |
| 2 | serviceWorker | html | 200 | 2.6 KB | network | `/?open=%2Fbench%2Fscene-glb.softn&embed=1` |
| 3 | page | js | 200 | 0.0 KB | sw | `/assets/index-DSZmgK9M.js` |
| 4 | page | css | 200 | 0.0 KB | sw | `/assets/index-BdKE3FSy.css` |
| 5 | page | js | 200 | 0.0 KB | sw | `/registerSW.js` |
| 6 | page | json | 200 | 0.0 KB | sw | `/manifest.webmanifest` |
| 7 | page | bundle | 200 | 2.2 KB | network | `/bench/scene-glb.softn` |
| 8 | page | image | 200 | 0.0 KB | sw | `/pwa-192x192.png` |
| 9 | page | js | 200 | 0.0 KB | sw | `/assets/scene3d-CsGv-ogZ.js` |
| 10 | page | js | 200 | 0.0 KB | sw | `/assets/vendor-three-DRaE6mEZ.js` |
| 11 | serviceWorker | js | 200 | 0.0 KB | disk | `/assets/scene3d-CsGv-ogZ.js` |
| 12 | serviceWorker | js | 200 | 0.0 KB | disk | `/assets/vendor-three-DRaE6mEZ.js` |
| 13 | page | js | — | 0.0 KB | network | `/assets/zipWorker-DuMQt4DG.js` |
| 14 | serviceWorker | js | 200 | 0.0 KB | disk | `/assets/zipWorker-DuMQt4DG.js` |
| 15 | page | wasm | 200 | 0.0 KB | sw | `/assets/zipp_wasm_bg-DZSXgiaN.wasm` |
| 16 | page | js | 200 | 0.0 KB | sw | `/assets/xdb-N2VKATSB-BwhH368Z.js` |
| 17 | page | blob | 200 | 0.0 KB | network | `blob:http://127.0.0.1:58345/9017b789-6c53-4811-b260-31026c5578d7` |
| 18 | page | js | 200 | 0.0 KB | sw | `/assets/GLTFLoader-DBAV7NEX.js` |
| 19 | serviceWorker | js | 200 | 0.0 KB | disk | `/assets/GLTFLoader-DBAV7NEX.js` |

</details>

### scene-effects — Scene3D with bloom

The scene-glb fixture with bloom on, so the post-processing path is exercised. Bundle: 2.0 KB (logic/main.logic 0.4 KB, manifest.json 0.3 KB, permission.json 0.0 KB, ui/main.ui 1.0 KB, assets/models/tetra.glb 1.1 KB).

- cold: ready 5/5; 3D module URL requested in 5/5; 3D code inside loaded JS in 5/5; WebGL2 available in 5/5 (ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)); service worker controlling 5/5
- warm: ready 5/5; 3D module URL requested in 5/5; 3D code inside loaded JS in 5/5; WebGL2 available in 5/5 (ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)); service worker controlling 5/5

Scripts carrying 3D code (cold): three in `/assets/vendor-three-DRaE6mEZ.js`; gltf in `/assets/GLTFLoader-DBAV7NEX.js`; postprocessing in `/assets/EffectComposer-SOTmTxfr.js`; bloom in `/assets/UnrealBloomPass-CUvuWZpG.js`.

| metric | cold median | cold p90 | warm median | warm p90 |
|---|---:|---:|---:|---:|
| app ready (ms) | 441 | 458 | 148 | 170 |
| first paint (ms) | 320 | 345 | 167 | 177 |
| first contentful paint (ms) | 445 | 522 | 177 | 232 |
| document responseEnd (ms) | 230 | 244 | 13 | 14 |
| DOMContentLoaded (ms) | 268 | 293 | 33 | 38 |
| load event end (ms) | 268 | 293 | 34 | 39 |
| first WebGL context (ms) | 431 | 448 | 101 | 165 |
| first GL draw (ms) | 509 | 549 | 182 | 208 |
| page requests | 27 | 27 | 21 | 21 |
| page bytes on the wire | 6676.2 KB | 6676.2 KB | 2.3 KB | 2.3 KB |
| page bytes loaded (content-length, cached or not) | 6670.0 KB | 6670.0 KB | 6545.4 KB | 6545.4 KB |
| JS bytes | 1397.5 KB | 1397.5 KB | 0.0 KB | 0.0 KB |
| wasm bytes | 5126.1 KB | 5126.1 KB | 0.0 KB | 0.0 KB |
| CSS bytes | 15.6 KB | 15.6 KB | 0.0 KB | 0.0 KB |
| bundle bytes | 2.3 KB | 2.3 KB | 2.3 KB | 2.3 KB |
| requests from HTTP cache | 0 | 0 | 17 | 17 |
| requests from service worker | 0 | 0 | 18 | 18 |
| failed requests | 0 | 0 | 0 | 0 |
| page requests until ready | 27 | 27 | 21 | 21 |
| page bytes until ready | 6676.2 KB | 6676.2 KB | 2.3 KB | 2.3 KB |
| service worker requests | 47 | 47 | 12 | 12 |
| service worker bytes on the wire | 333.9 KB | 334.3 KB | 2.6 KB | 2.6 KB |
| service worker bytes loaded (content-length) | 6343.7 KB | 6343.7 KB | 691.1 KB | 691.1 KB |
| service worker requests from HTTP cache | 10 | 10 | 11 | 11 |
| service worker bytes on the wire until ready | 333.9 KB | 334.3 KB | 2.6 KB | 2.6 KB |
| dedicated worker requests | 0 | 0 | 0 | 0 |
| dedicated worker bytes on the wire | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB |
| dedicated worker bytes loaded (content-length) | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB |
| long tasks | 2 | 2 | 1 | 2 |
| long task total (ms) | 158 | 190 | 64 | 216 |
| longest task (ms) | 104 | 140 | 64 | 126 |
| script time (ms) | 259 | 272 | 138 | 255 |
| main-thread task time (ms) | 391 | 407 | 196 | 312 |
| JS heap used (MB) | 7.3 | 7.4 | 9.4 | 10.9 |
| uncaught errors | 0 | 0 | 0 | 0 |

| phase (softn: marks, ms) | cold median | cold p90 | warm median | warm p90 |
|---|---:|---:|---:|---:|
| softn:asset-extract | 0 | 0 | 0 | 0 |
| softn:asset-warm | 20 | 28 | 24 | 26 |
| softn:component-preload | 20 | 25 | 20 | 22 |
| softn:compose | 1 | 1 | 0 | 0 |
| softn:offline-install | 306 | 394 | — | — |
| softn:parse | 1 | 1 | 0 | 1 |
| softn:vm-init | 126 | 295 | 112 | 131 |
| softn:xdb-seed | 0 | 0 | 0 | 0 |
| softn:zip | 2 | 2 | 1 | 1 |

| mark (ms from navigation) | cold median | warm median |
|---|---:|---:|
| softn:scene3d-assets-ready | 470 | 160 |
| softn:scene3d-first-frame | 618 | 211 |
| softn:scene3d-renderer-ready | 438 | 146 |

3D module URLs the page or a worker fetched (cold): `/assets/GLTFLoader-DBAV7NEX.js`, `/assets/UnrealBloomPass-CUvuWZpG.js`, `/assets/scene3d-CsGv-ogZ.js`.

<details><summary>Requests, cold pass (representative run: 74 rows)</summary>

| # | context | kind | status | bytes | cache | url |
|---:|---|---|---:|---:|---|---|
| 1 | page | html | 200 | 2.6 KB | network | `/?open=%2Fbench%2Fscene-effects.softn&embed=1` |
| 2 | page | js | 200 | 715.5 KB | network | `/assets/index-DSZmgK9M.js` |
| 3 | page | css | 200 | 15.6 KB | network | `/assets/index-BdKE3FSy.css` |
| 4 | page | js | 200 | 0.4 KB | network | `/registerSW.js` |
| 5 | page | json | 200 | 0.8 KB | network | `/manifest.webmanifest` |
| 6 | page | font | 200 | 40.7 KB | network | `/assets/bricolage-grotesque-latin-wght-normal-DLoelf7F.woff2` |
| 7 | page | font | 200 | 22.3 KB | network | `/assets/ibm-plex-sans-latin-400-normal-CDDApCn2.woff2` |
| 8 | page | font | 200 | 14.6 KB | network | `/assets/ibm-plex-mono-latin-400-normal-DMJ8VG8y.woff2` |
| 9 | page | font | 200 | 24.0 KB | network | `/assets/ibm-plex-sans-latin-600-normal-CuJfVYMP.woff2` |
| 10 | page | font | 200 | 23.9 KB | network | `/assets/ibm-plex-sans-latin-500-normal-6ng42L7E.woff2` |
| 11 | serviceWorker | js | 200 | 0.3 KB | network | `/sw.js` |
| 12 | page | bundle | 200 | 2.3 KB | network | `/bench/scene-effects.softn` |
| 13 | page | image | 200 | 0.7 KB | network | `/favicon.svg` |
| 14 | page | image | 200 | 5.2 KB | network | `/pwa-192x192.png` |
| 15 | serviceWorker | js | 200 | 0.0 KB | network | `/workbox-63c18b4d.js` |
| 16 | serviceWorker | js | 200 | 0.0 KB | network | `/coi.js` |
| 17 | serviceWorker | js | 200 | 0.4 KB | network | `/registerSW.js` |
| 18 | serviceWorker | image | 200 | 8.7 KB | network | `/pwa-maskable-512x512.png` |
| 19 | page | js | — | 0.0 KB | network | `/assets/zipWorker-DuMQt4DG.js` |
| 20 | serviceWorker | image | 200 | 15.0 KB | network | `/pwa-512x512.png` |
| 21 | page | js | 200 | 57.0 KB | network | `/assets/scene3d-CsGv-ogZ.js` |
| 22 | page | js | 200 | 558.4 KB | network | `/assets/vendor-three-DRaE6mEZ.js` |
| 23 | serviceWorker | image | 200 | 5.2 KB | network | `/pwa-192x192.png` |
| 24 | page | wasm | 200 | 5126.1 KB | network | `/assets/zipp_wasm_bg-DZSXgiaN.wasm` |
| 25 | serviceWorker | html | 200 | 2.6 KB | network | `/index.html` |
| 26 | serviceWorker | image | 200 | 0.7 KB | network | `/favicon.svg` |
| 27 | serviceWorker | js | 200 | 1.9 KB | network | `/coi.js` |
| 28 | page | js | 200 | 4.1 KB | network | `/assets/EffectComposer-SOTmTxfr.js` |
| 29 | page | js | 200 | 0.8 KB | network | `/assets/CopyShader-CHGAmNbz.js` |
| 30 | page | js | 200 | 1.0 KB | network | `/assets/Pass-xoVzREwE.js` |
| 31 | page | js | 200 | 1.2 KB | network | `/assets/ShaderPass-vmutAxOU.js` |
| 32 | page | js | 200 | 1.4 KB | network | `/assets/RenderPass-DMdn9WGj.js` |
| 33 | page | js | 200 | 9.2 KB | network | `/assets/UnrealBloomPass-CUvuWZpG.js` |
| 34 | page | js | 200 | 3.2 KB | network | `/assets/OutputPass-CpHVr2kg.js` |
| 35 | page | blob | 200 | 0.0 KB | network | `blob:http://127.0.0.1:58345/77de80a6-9ab3-4cea-9d6a-67f94d120006` |
| 36 | page | js | 200 | 44.8 KB | network | `/assets/GLTFLoader-DBAV7NEX.js` |
| 37 | serviceWorker | js | 200 | 0.0 KB | disk | `/assets/zipWorker-DuMQt4DG.js` |
| 38 | serviceWorker | wasm | 200 | 0.0 KB | disk | `/assets/zipp_wasm_bg-DZSXgiaN.wasm` |
| 39 | page | js | 200 | 0.4 KB | network | `/assets/xdb-N2VKATSB-BwhH368Z.js` |
| 40 | serviceWorker | js | 200 | 0.0 KB | disk | `/assets/xdb-N2VKATSB-BwhH368Z.js` |
| 41 | serviceWorker | js | 200 | 0.0 KB | disk | `/assets/index-DSZmgK9M.js` |
| 42 | serviceWorker | css | 200 | 0.0 KB | disk | `/assets/index-BdKE3FSy.css` |
| 43 | serviceWorker | font | 200 | 8.5 KB | network | `/assets/ibm-plex-sans-vietnamese-600-normal-DpPYBSTl.woff2` |
| 44 | serviceWorker | font | 200 | 8.5 KB | network | `/assets/ibm-plex-sans-vietnamese-500-normal-e4dixQRQ.woff2` |
| 45 | serviceWorker | font | 200 | 8.3 KB | network | `/assets/ibm-plex-sans-vietnamese-400-normal-DG4YqDda.woff2` |
| 46 | serviceWorker | font | 200 | 16.3 KB | network | `/assets/ibm-plex-sans-latin-ext-600-normal-DOrvGEcy.woff2` |
| 47 | serviceWorker | font | 200 | 16.4 KB | network | `/assets/ibm-plex-sans-latin-ext-500-normal-DakdToA3.woff2` |
| 48 | serviceWorker | font | 200 | 15.9 KB | network | `/assets/ibm-plex-sans-latin-ext-400-normal-C5H60-Va.woff2` |
| 49 | serviceWorker | font | 200 | 0.0 KB | disk | `/assets/ibm-plex-sans-latin-600-normal-CuJfVYMP.woff2` |
| 50 | serviceWorker | font | 200 | 0.0 KB | disk | `/assets/ibm-plex-sans-latin-500-normal-6ng42L7E.woff2` |
| 51 | serviceWorker | font | 200 | 0.0 KB | disk | `/assets/ibm-plex-sans-latin-400-normal-CDDApCn2.woff2` |
| 52 | serviceWorker | font | 200 | 10.4 KB | network | `/assets/ibm-plex-sans-greek-600-normal-DzTrcv_p.woff2` |
| 53 | serviceWorker | font | 200 | 10.4 KB | network | `/assets/ibm-plex-sans-greek-500-normal-JMMifIXV.woff2` |
| 54 | serviceWorker | font | 200 | 10.0 KB | network | `/assets/ibm-plex-sans-greek-400-normal-_efipK4i.woff2` |
| 55 | serviceWorker | font | 200 | 12.3 KB | network | `/assets/ibm-plex-sans-cyrillic-ext-600-normal-DUMzJB7m.woff2` |
| 56 | serviceWorker | font | 200 | 12.3 KB | network | `/assets/ibm-plex-sans-cyrillic-ext-500-normal-Cs5J6C77.woff2` |
| 57 | serviceWorker | font | 200 | 12.1 KB | network | `/assets/ibm-plex-sans-cyrillic-ext-400-normal-g30qAdWV.woff2` |
| 58 | serviceWorker | font | 200 | 15.0 KB | network | `/assets/ibm-plex-sans-cyrillic-600-normal-71GNu3SW.woff2` |
| 59 | serviceWorker | font | 200 | 14.9 KB | network | `/assets/ibm-plex-sans-cyrillic-500-normal-CocWQlwt.woff2` |
| 60 | serviceWorker | font | 200 | 14.7 KB | network | `/assets/ibm-plex-sans-cyrillic-400-normal-DZqxrq2p.woff2` |
| 61 | serviceWorker | font | 200 | 6.2 KB | network | `/assets/ibm-plex-mono-vietnamese-500-normal-DZ4AoWbu.woff2` |
| 62 | serviceWorker | font | 200 | 6.0 KB | network | `/assets/ibm-plex-mono-vietnamese-400-normal-BulugwFq.woff2` |
| 63 | serviceWorker | font | 200 | 13.4 KB | network | `/assets/ibm-plex-mono-latin-ext-500-normal-CAhNIIs5.woff2` |
| 64 | serviceWorker | font | 200 | 13.3 KB | network | `/assets/ibm-plex-mono-latin-ext-400-normal-BmRBH3aV.woff2` |
| 65 | serviceWorker | font | 200 | 14.8 KB | network | `/assets/ibm-plex-mono-latin-500-normal-DSY6xOcd.woff2` |
| 66 | serviceWorker | font | 200 | 0.0 KB | disk | `/assets/ibm-plex-mono-latin-400-normal-DMJ8VG8y.woff2` |
| 67 | serviceWorker | font | 200 | 7.1 KB | network | `/assets/ibm-plex-mono-cyrillic-ext-500-normal-BqneJy0T.woff2` |
| 68 | serviceWorker | font | 200 | 7.0 KB | network | `/assets/ibm-plex-mono-cyrillic-ext-400-normal-xuaO2J-f.woff2` |
| 69 | serviceWorker | font | 200 | 8.5 KB | network | `/assets/ibm-plex-mono-cyrillic-500-normal-Bq9vWWag.woff2` |
| 70 | serviceWorker | font | 200 | 8.4 KB | network | `/assets/ibm-plex-mono-cyrillic-400-normal-BSMlKf0J.woff2` |
| 71 | serviceWorker | font | 200 | 8.7 KB | network | `/assets/bricolage-grotesque-vietnamese-wght-normal-BUzh504Q.woff2` |
| 72 | serviceWorker | font | 200 | 0.0 KB | disk | `/assets/bricolage-grotesque-latin-wght-normal-DLoelf7F.woff2` |
| 73 | serviceWorker | font | 200 | 18.5 KB | network | `/assets/bricolage-grotesque-latin-ext-wght-normal-CcLUaPy7.woff2` |
| 74 | serviceWorker | json | 200 | 0.8 KB | network | `/manifest.webmanifest` |

</details>

<details><summary>Requests, warm pass (representative run: 33 rows)</summary>

| # | context | kind | status | bytes | cache | url |
|---:|---|---|---:|---:|---|---|
| 1 | page | html | 200 | 0.0 KB | sw | `/?open=%2Fbench%2Fscene-effects.softn&embed=1` |
| 2 | serviceWorker | html | 200 | 2.6 KB | network | `/?open=%2Fbench%2Fscene-effects.softn&embed=1` |
| 3 | page | js | 200 | 0.0 KB | sw | `/assets/index-DSZmgK9M.js` |
| 4 | page | css | 200 | 0.0 KB | sw | `/assets/index-BdKE3FSy.css` |
| 5 | page | js | 200 | 0.0 KB | sw | `/registerSW.js` |
| 6 | page | json | 200 | 0.0 KB | sw | `/manifest.webmanifest` |
| 7 | page | bundle | 200 | 2.3 KB | network | `/bench/scene-effects.softn` |
| 8 | page | image | 200 | 0.0 KB | sw | `/pwa-192x192.png` |
| 9 | page | js | — | 0.0 KB | network | `/assets/zipWorker-DuMQt4DG.js` |
| 10 | serviceWorker | js | 200 | 0.0 KB | disk | `/assets/zipWorker-DuMQt4DG.js` |
| 11 | page | js | 200 | 0.0 KB | sw | `/assets/scene3d-CsGv-ogZ.js` |
| 12 | page | js | 200 | 0.0 KB | sw | `/assets/vendor-three-DRaE6mEZ.js` |
| 13 | serviceWorker | js | 200 | 0.0 KB | disk | `/assets/scene3d-CsGv-ogZ.js` |
| 14 | serviceWorker | js | 200 | 0.0 KB | disk | `/assets/vendor-three-DRaE6mEZ.js` |
| 15 | page | wasm | 200 | 0.0 KB | sw | `/assets/zipp_wasm_bg-DZSXgiaN.wasm` |
| 16 | page | js | 200 | 0.0 KB | sw | `/assets/xdb-N2VKATSB-BwhH368Z.js` |
| 17 | page | js | 200 | 0.0 KB | sw | `/assets/EffectComposer-SOTmTxfr.js` |
| 18 | page | js | 200 | 0.0 KB | sw | `/assets/CopyShader-CHGAmNbz.js` |
| 19 | page | js | 200 | 0.0 KB | sw | `/assets/Pass-xoVzREwE.js` |
| 20 | page | js | 200 | 0.0 KB | sw | `/assets/ShaderPass-vmutAxOU.js` |
| 21 | page | js | 200 | 0.0 KB | sw | `/assets/RenderPass-DMdn9WGj.js` |
| 22 | page | js | 200 | 0.0 KB | sw | `/assets/UnrealBloomPass-CUvuWZpG.js` |
| 23 | page | js | 200 | 0.0 KB | sw | `/assets/OutputPass-CpHVr2kg.js` |
| 24 | page | blob | 200 | 0.0 KB | network | `blob:http://127.0.0.1:58345/a820820c-476b-4c93-9c6b-4039e412e8d0` |
| 25 | serviceWorker | js | 200 | 0.0 KB | disk | `/assets/EffectComposer-SOTmTxfr.js` |
| 26 | page | js | 200 | 0.0 KB | sw | `/assets/GLTFLoader-DBAV7NEX.js` |
| 27 | serviceWorker | js | 200 | 0.0 KB | disk | `/assets/CopyShader-CHGAmNbz.js` |
| 28 | serviceWorker | js | 200 | 0.0 KB | disk | `/assets/Pass-xoVzREwE.js` |
| 29 | serviceWorker | js | 200 | 0.0 KB | disk | `/assets/ShaderPass-vmutAxOU.js` |
| 30 | serviceWorker | js | 200 | 0.0 KB | disk | `/assets/RenderPass-DMdn9WGj.js` |
| 31 | serviceWorker | js | 200 | 0.0 KB | disk | `/assets/UnrealBloomPass-CUvuWZpG.js` |
| 32 | serviceWorker | js | 200 | 0.0 KB | disk | `/assets/OutputPass-CpHVr2kg.js` |
| 33 | serviceWorker | js | 200 | 0.0 KB | disk | `/assets/GLTFLoader-DBAV7NEX.js` |

</details>
