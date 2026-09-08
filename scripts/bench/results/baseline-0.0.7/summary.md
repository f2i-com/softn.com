# Bench: baseline-0.0.7

## Host: single

Generated 2026-09-07T22:41:21.707Z · apps/softn-single/dist built 2026-09-07T22:29:56.318Z · package 0.0.7 · git audit/dynamic-loading@e9fccda (dirty tree)

Edg/152.0.4191.66 headless · SwiftShader software WebGL (headless); not a GPU · AMD Ryzen 9 9950X3D 16-Core Processor (32 cores, 190 GB) · win32 10.0.26200 · Node v24.12.0

5 runs per scenario, fresh profile each; cold = HTTP cache disabled, warm = second navigation in the same profile. localhost HTTP/1.1, no compression, deployment cache headers. Medians and nearest-rank p90 over runs.

### minimal — Minimal text and form

A heading, a paragraph, an input and a button. No 3D. Bundle: 1.1 KB (logic/main.logic 0.1 KB, manifest.json 0.3 KB, permission.json 0.0 KB, ui/main.ui 0.7 KB).

- cold: ready 5/5; 3D module URL requested in 0/5; 3D code inside loaded JS in 5/5; WebGL2 available in 5/5 (ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)); service worker controlling 0/5
- warm: ready 5/5; 3D module URL requested in 0/5; 3D code inside loaded JS in 5/5; WebGL2 available in 5/5 (ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)); service worker controlling 0/5

Scripts carrying 3D code (cold): three in `/s/minimal/assets/index-DFgNNp4P.js`; gltf in `/s/minimal/assets/index-DFgNNp4P.js`; obj in `/s/minimal/assets/index-DFgNNp4P.js`; fbx in `/s/minimal/assets/index-DFgNNp4P.js`; stl in `/s/minimal/assets/index-DFgNNp4P.js`; postprocessing in `/s/minimal/assets/index-DFgNNp4P.js`; bloom in `/s/minimal/assets/index-DFgNNp4P.js`.

| metric | cold median | cold p90 | warm median | warm p90 |
|---|---:|---:|---:|---:|
| app ready (ms) | 325 | 347 | 37 | 53 |
| first paint (ms) | 333 | 340 | 66 | 128 |
| first contentful paint (ms) | 333 | 340 | 66 | 128 |
| document responseEnd (ms) | 241 | 261 | 4 | 5 |
| DOMContentLoaded (ms) | 293 | 313 | 21 | 37 |
| load event end (ms) | 293 | 313 | 22 | 37 |
| page requests | 8 | 8 | 8 | 8 |
| page bytes on the wire | 6968.1 KB | 6968.1 KB | 3.6 KB | 3.6 KB |
| page bytes loaded (content-length, cached or not) | 6965.7 KB | 6965.7 KB | 6965.7 KB | 6965.7 KB |
| JS bytes | 1836.6 KB | 1836.6 KB | 0.0 KB | 0.0 KB |
| wasm bytes | 5126.1 KB | 5126.1 KB | 0.0 KB | 0.0 KB |
| CSS bytes | 1.8 KB | 1.8 KB | 0.0 KB | 0.0 KB |
| bundle bytes | 1.4 KB | 1.4 KB | 1.4 KB | 1.4 KB |
| requests from HTTP cache | 0 | 0 | 5 | 5 |
| requests from service worker | 0 | 0 | 0 | 0 |
| failed requests | 0 | 0 | 0 | 0 |
| page requests until ready | 8 | 8 | 8 | 8 |
| page bytes until ready | 6968.1 KB | 6968.1 KB | 3.6 KB | 3.6 KB |
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
| script time (ms) | 31 | 33 | 11 | 12 |
| main-thread task time (ms) | 119 | 122 | 51 | 67 |
| JS heap used (MB) | 5.0 | 5.0 | 7.0 | 7.0 |
| uncaught errors | 0 | 0 | 0 | 0 |

| phase (softn: marks, ms) | cold median | cold p90 | warm median | warm p90 |
|---|---:|---:|---:|---:|
| softn:bundle-fetch | 4 | 6 | 2 | 2 |
| softn:compose | 1 | 1 | 0 | 0 |
| softn:digest | 0 | 0 | 0 | 0 |
| softn:parse | 1 | 1 | 0 | 0 |
| softn:vm-init | 74 | 84 | 19 | 19 |
| softn:xdb-seed | 1 | 1 | 0 | 0 |
| softn:zip | 1 | 1 | 0 | 1 |

<details><summary>Requests, cold pass (representative run: 8 rows)</summary>

| # | context | kind | status | bytes | cache | url |
|---:|---|---|---:|---:|---|---|
| 1 | page | html | 200 | 1.8 KB | network | `/s/minimal/` |
| 2 | page | js | 200 | 1641.6 KB | network | `/s/minimal/assets/index-DFgNNp4P.js` |
| 3 | page | css | 200 | 1.8 KB | network | `/s/minimal/assets/index-AvXQ3nb8.css` |
| 4 | page | json | 200 | 0.4 KB | network | `/s/minimal/runtime.config.json` |
| 5 | page | bundle | 200 | 1.4 KB | network | `/s/minimal/app.softn` |
| 6 | page | wasm | 200 | 5126.1 KB | network | `/s/minimal/assets/zipp_wasm_bg-DZSXgiaN.wasm` |
| 7 | page | js | 200 | 194.7 KB | network | `/s/minimal/assets/xdb-sync-HEXTLQED-vvx5bu8Q.js` |
| 8 | page | js | 200 | 0.4 KB | network | `/s/minimal/assets/xdb-PM4ITEJI-CrBD4ZXI.js` |

</details>

<details><summary>Requests, warm pass (representative run: 8 rows)</summary>

| # | context | kind | status | bytes | cache | url |
|---:|---|---|---:|---:|---|---|
| 1 | page | html | 200 | 1.8 KB | network | `/s/minimal/` |
| 2 | page | js | 200 | 0.0 KB | memory | `/s/minimal/assets/index-DFgNNp4P.js` |
| 3 | page | css | 200 | 0.0 KB | memory | `/s/minimal/assets/index-AvXQ3nb8.css` |
| 4 | page | json | 200 | 0.4 KB | network | `/s/minimal/runtime.config.json` |
| 5 | page | bundle | 200 | 1.4 KB | network | `/s/minimal/app.softn` |
| 6 | page | wasm | 200 | 0.0 KB | disk | `/s/minimal/assets/zipp_wasm_bg-DZSXgiaN.wasm` |
| 7 | page | js | 200 | 0.0 KB | memory | `/s/minimal/assets/xdb-sync-HEXTLQED-vvx5bu8Q.js` |
| 8 | page | js | 200 | 0.0 KB | memory | `/s/minimal/assets/xdb-PM4ITEJI-CrBD4ZXI.js` |

</details>

### scene-glb — Scene3D with one bundled GLB

One Scene3D, one bundled glTF binary, no effects, no orbit controls. Bundle: 1.9 KB (logic/main.logic 0.4 KB, manifest.json 0.3 KB, permission.json 0.0 KB, ui/main.ui 1.0 KB, assets/models/tetra.glb 1.1 KB).

- cold: ready 5/5; 3D module URL requested in 0/5; 3D code inside loaded JS in 5/5; WebGL2 available in 5/5 (ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)); service worker controlling 0/5
- warm: ready 5/5; 3D module URL requested in 0/5; 3D code inside loaded JS in 5/5; WebGL2 available in 5/5 (ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)); service worker controlling 0/5

Scripts carrying 3D code (cold): three in `/s/scene-glb/assets/index-DFgNNp4P.js`; gltf in `/s/scene-glb/assets/index-DFgNNp4P.js`; obj in `/s/scene-glb/assets/index-DFgNNp4P.js`; fbx in `/s/scene-glb/assets/index-DFgNNp4P.js`; stl in `/s/scene-glb/assets/index-DFgNNp4P.js`; postprocessing in `/s/scene-glb/assets/index-DFgNNp4P.js`; bloom in `/s/scene-glb/assets/index-DFgNNp4P.js`.

| metric | cold median | cold p90 | warm median | warm p90 |
|---|---:|---:|---:|---:|
| app ready (ms) | 341 | 351 | 56 | 68 |
| first paint (ms) | 339 | 349 | 62 | 79 |
| first contentful paint (ms) | 339 | 349 | 62 | 79 |
| document responseEnd (ms) | 244 | 247 | 5 | 5 |
| DOMContentLoaded (ms) | 293 | 303 | 25 | 26 |
| load event end (ms) | 293 | 303 | 26 | 26 |
| first WebGL context (ms) | 331 | 341 | 51 | 62 |
| first GL draw (ms) | 380 | 403 | 83 | 96 |
| page requests | 9 | 9 | 9 | 9 |
| page bytes on the wire | 6968.9 KB | 6968.9 KB | 4.4 KB | 4.4 KB |
| page bytes loaded (content-length, cached or not) | 6967.6 KB | 6967.6 KB | 6967.6 KB | 6967.6 KB |
| JS bytes | 1836.6 KB | 1836.6 KB | 0.0 KB | 0.0 KB |
| wasm bytes | 5126.1 KB | 5126.1 KB | 0.0 KB | 0.0 KB |
| CSS bytes | 1.8 KB | 1.8 KB | 0.0 KB | 0.0 KB |
| bundle bytes | 2.2 KB | 2.2 KB | 2.2 KB | 2.2 KB |
| requests from HTTP cache | 0 | 0 | 5 | 5 |
| requests from service worker | 0 | 0 | 0 | 0 |
| failed requests | 0 | 0 | 0 | 0 |
| page requests until ready | 9 | 9 | 9 | 9 |
| page bytes until ready | 6968.9 KB | 6968.9 KB | 4.4 KB | 4.4 KB |
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
| script time (ms) | 86 | 93 | 41 | 52 |
| main-thread task time (ms) | 188 | 191 | 95 | 106 |
| JS heap used (MB) | 6.2 | 6.4 | 9.7 | 10.4 |
| uncaught errors | 0 | 0 | 0 | 0 |

| phase (softn: marks, ms) | cold median | cold p90 | warm median | warm p90 |
|---|---:|---:|---:|---:|
| softn:bundle-fetch | 6 | 7 | 2 | 2 |
| softn:compose | 1 | 1 | 0 | 0 |
| softn:digest | 0 | 0 | 0 | 0 |
| softn:parse | 1 | 2 | 0 | 0 |
| softn:vm-init | 105 | 114 | 41 | 47 |
| softn:xdb-seed | 1 | 1 | 0 | 0 |
| softn:zip | 1 | 1 | 1 | 1 |

<details><summary>Requests, cold pass (representative run: 9 rows)</summary>

| # | context | kind | status | bytes | cache | url |
|---:|---|---|---:|---:|---|---|
| 1 | page | html | 200 | 1.8 KB | network | `/s/scene-glb/` |
| 2 | page | js | 200 | 1641.6 KB | network | `/s/scene-glb/assets/index-DFgNNp4P.js` |
| 3 | page | css | 200 | 1.8 KB | network | `/s/scene-glb/assets/index-AvXQ3nb8.css` |
| 4 | page | json | 200 | 0.4 KB | network | `/s/scene-glb/runtime.config.json` |
| 5 | page | bundle | 200 | 2.2 KB | network | `/s/scene-glb/app.softn` |
| 6 | page | wasm | 200 | 5126.1 KB | network | `/s/scene-glb/assets/zipp_wasm_bg-DZSXgiaN.wasm` |
| 7 | page | js | 200 | 194.7 KB | network | `/s/scene-glb/assets/xdb-sync-HEXTLQED-vvx5bu8Q.js` |
| 8 | page | blob | 200 | 0.0 KB | network | `blob:http://127.0.0.1:56023/c79c9631-4a4f-4a55-875a-fec574a66716` |
| 9 | page | js | 200 | 0.4 KB | network | `/s/scene-glb/assets/xdb-PM4ITEJI-CrBD4ZXI.js` |

</details>

<details><summary>Requests, warm pass (representative run: 9 rows)</summary>

| # | context | kind | status | bytes | cache | url |
|---:|---|---|---:|---:|---|---|
| 1 | page | html | 200 | 1.8 KB | network | `/s/scene-glb/` |
| 2 | page | js | 200 | 0.0 KB | memory | `/s/scene-glb/assets/index-DFgNNp4P.js` |
| 3 | page | css | 200 | 0.0 KB | memory | `/s/scene-glb/assets/index-AvXQ3nb8.css` |
| 4 | page | json | 200 | 0.4 KB | network | `/s/scene-glb/runtime.config.json` |
| 5 | page | bundle | 200 | 2.2 KB | network | `/s/scene-glb/app.softn` |
| 6 | page | blob | 200 | 0.0 KB | network | `blob:http://127.0.0.1:56023/39af4b29-04d8-434c-b34c-6e0aeade61f4` |
| 7 | page | wasm | 200 | 0.0 KB | disk | `/s/scene-glb/assets/zipp_wasm_bg-DZSXgiaN.wasm` |
| 8 | page | js | 200 | 0.0 KB | memory | `/s/scene-glb/assets/xdb-sync-HEXTLQED-vvx5bu8Q.js` |
| 9 | page | js | 200 | 0.0 KB | memory | `/s/scene-glb/assets/xdb-PM4ITEJI-CrBD4ZXI.js` |

</details>

### scene-effects — Scene3D with bloom

The scene-glb fixture with bloom on, so the post-processing path is exercised. Bundle: 2.0 KB (logic/main.logic 0.4 KB, manifest.json 0.3 KB, permission.json 0.0 KB, ui/main.ui 1.0 KB, assets/models/tetra.glb 1.1 KB).

- cold: ready 5/5; 3D module URL requested in 0/5; 3D code inside loaded JS in 5/5; WebGL2 available in 5/5 (ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)); service worker controlling 0/5
- warm: ready 5/5; 3D module URL requested in 0/5; 3D code inside loaded JS in 5/5; WebGL2 available in 5/5 (ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)); service worker controlling 0/5

Scripts carrying 3D code (cold): three in `/s/scene-effects/assets/index-DFgNNp4P.js`; gltf in `/s/scene-effects/assets/index-DFgNNp4P.js`; obj in `/s/scene-effects/assets/index-DFgNNp4P.js`; fbx in `/s/scene-effects/assets/index-DFgNNp4P.js`; stl in `/s/scene-effects/assets/index-DFgNNp4P.js`; postprocessing in `/s/scene-effects/assets/index-DFgNNp4P.js`; bloom in `/s/scene-effects/assets/index-DFgNNp4P.js`.

| metric | cold median | cold p90 | warm median | warm p90 |
|---|---:|---:|---:|---:|
| app ready (ms) | 361 | 417 | 238 | 267 |
| first paint (ms) | 330 | 341 | 257 | 303 |
| first contentful paint (ms) | 330 | 341 | 257 | 303 |
| document responseEnd (ms) | 231 | 236 | 5 | 5 |
| DOMContentLoaded (ms) | 286 | 293 | 143 | 144 |
| load event end (ms) | 287 | 293 | 143 | 144 |
| first WebGL context (ms) | 323 | 327 | 162 | 165 |
| first GL draw (ms) | 337 | 340 | 168 | 171 |
| page requests | 9 | 9 | 9 | 9 |
| page bytes on the wire | 6969.0 KB | 6969.0 KB | 4.5 KB | 4.5 KB |
| page bytes loaded (content-length, cached or not) | 6967.7 KB | 6967.7 KB | 6967.7 KB | 6967.7 KB |
| JS bytes | 1836.6 KB | 1836.6 KB | 0.0 KB | 0.0 KB |
| wasm bytes | 5126.1 KB | 5126.1 KB | 0.0 KB | 0.0 KB |
| CSS bytes | 1.8 KB | 1.8 KB | 0.0 KB | 0.0 KB |
| bundle bytes | 2.3 KB | 2.3 KB | 2.3 KB | 2.3 KB |
| requests from HTTP cache | 0 | 0 | 5 | 5 |
| requests from service worker | 0 | 0 | 0 | 0 |
| failed requests | 0 | 0 | 0 | 0 |
| page requests until ready | 9 | 9 | 9 | 9 |
| page bytes until ready | 6969.0 KB | 6969.0 KB | 4.5 KB | 4.5 KB |
| service worker requests | 0 | 0 | 0 | 0 |
| service worker bytes on the wire | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB |
| service worker bytes loaded (content-length) | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB |
| service worker requests from HTTP cache | 0 | 0 | 0 | 0 |
| service worker bytes on the wire until ready | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB |
| dedicated worker requests | 0 | 0 | 0 | 0 |
| dedicated worker bytes on the wire | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB |
| dedicated worker bytes loaded (content-length) | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB |
| long tasks | 2 | 3 | 3 | 3 |
| long task total (ms) | 203 | 257 | 209 | 233 |
| longest task (ms) | 113 | 123 | 93 | 111 |
| script time (ms) | 349 | 354 | 280 | 297 |
| main-thread task time (ms) | 469 | 476 | 594 | 613 |
| JS heap used (MB) | 7.5 | 7.6 | 9.8 | 9.9 |
| uncaught errors | 0 | 0 | 0 | 0 |

| phase (softn: marks, ms) | cold median | cold p90 | warm median | warm p90 |
|---|---:|---:|---:|---:|
| softn:bundle-fetch | 4 | 7 | 2 | 2 |
| softn:compose | 1 | 1 | 0 | 0 |
| softn:digest | 0 | 0 | 0 | 0 |
| softn:parse | 1 | 1 | 0 | 1 |
| softn:vm-init | 303 | 321 | 235 | 246 |
| softn:xdb-seed | 1 | 1 | 0 | 0 |
| softn:zip | 1 | 1 | 1 | 1 |

<details><summary>Requests, cold pass (representative run: 9 rows)</summary>

| # | context | kind | status | bytes | cache | url |
|---:|---|---|---:|---:|---|---|
| 1 | page | html | 200 | 1.8 KB | network | `/s/scene-effects/` |
| 2 | page | js | 200 | 1641.6 KB | network | `/s/scene-effects/assets/index-DFgNNp4P.js` |
| 3 | page | css | 200 | 1.8 KB | network | `/s/scene-effects/assets/index-AvXQ3nb8.css` |
| 4 | page | json | 200 | 0.4 KB | network | `/s/scene-effects/runtime.config.json` |
| 5 | page | bundle | 200 | 2.3 KB | network | `/s/scene-effects/app.softn` |
| 6 | page | wasm | 200 | 5126.1 KB | network | `/s/scene-effects/assets/zipp_wasm_bg-DZSXgiaN.wasm` |
| 7 | page | js | 200 | 194.7 KB | network | `/s/scene-effects/assets/xdb-sync-HEXTLQED-vvx5bu8Q.js` |
| 8 | page | blob | 200 | 0.0 KB | network | `blob:http://127.0.0.1:56023/7093d373-8c3a-4b06-813a-e4087be7d190` |
| 9 | page | js | 200 | 0.4 KB | network | `/s/scene-effects/assets/xdb-PM4ITEJI-CrBD4ZXI.js` |

</details>

<details><summary>Requests, warm pass (representative run: 9 rows)</summary>

| # | context | kind | status | bytes | cache | url |
|---:|---|---|---:|---:|---|---|
| 1 | page | html | 200 | 1.8 KB | network | `/s/scene-effects/` |
| 2 | page | js | 200 | 0.0 KB | memory | `/s/scene-effects/assets/index-DFgNNp4P.js` |
| 3 | page | css | 200 | 0.0 KB | memory | `/s/scene-effects/assets/index-AvXQ3nb8.css` |
| 4 | page | json | 200 | 0.4 KB | network | `/s/scene-effects/runtime.config.json` |
| 5 | page | bundle | 200 | 2.3 KB | network | `/s/scene-effects/app.softn` |
| 6 | page | blob | 200 | 0.0 KB | network | `blob:http://127.0.0.1:56023/7135f393-b6b0-4443-8349-a008101105ae` |
| 7 | page | wasm | 200 | 0.0 KB | disk | `/s/scene-effects/assets/zipp_wasm_bg-DZSXgiaN.wasm` |
| 8 | page | js | 200 | 0.0 KB | memory | `/s/scene-effects/assets/xdb-sync-HEXTLQED-vvx5bu8Q.js` |
| 9 | page | js | 200 | 0.0 KB | memory | `/s/scene-effects/assets/xdb-PM4ITEJI-CrBD4ZXI.js` |

</details>

## Host: web

Generated 2026-09-07T22:43:27.254Z · apps/softn-web/dist built 2026-09-07T22:30:02.971Z · package 0.0.7 · git audit/dynamic-loading@e9fccda (dirty tree)

Edg/152.0.4191.66 headless · SwiftShader software WebGL (headless); not a GPU · AMD Ryzen 9 9950X3D 16-Core Processor (32 cores, 190 GB) · win32 10.0.26200 · Node v24.12.0

5 runs per scenario, fresh profile each; cold = HTTP cache disabled, warm = second navigation in the same profile. localhost HTTP/1.1, no compression, deployment cache headers. Medians and nearest-rank p90 over runs.

### minimal — Minimal text and form

A heading, a paragraph, an input and a button. No 3D. Bundle: 1.1 KB (logic/main.logic 0.1 KB, manifest.json 0.3 KB, permission.json 0.0 KB, ui/main.ui 0.7 KB).

- cold: ready 5/5; 3D module URL requested in 0/5; 3D code inside loaded JS in 5/5; WebGL2 available in 5/5 (ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)); service worker controlling 5/5
- warm: ready 5/5; 3D module URL requested in 0/5; 3D code inside loaded JS in 5/5; WebGL2 available in 5/5 (ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)); service worker controlling 5/5

Scripts carrying 3D code (cold): three in `/assets/index-CwQnIrts.js`; gltf in `/assets/index-CwQnIrts.js`; obj in `/assets/index-CwQnIrts.js`; fbx in `/assets/index-CwQnIrts.js`; stl in `/assets/index-CwQnIrts.js`; postprocessing in `/assets/index-CwQnIrts.js`; bloom in `/assets/index-CwQnIrts.js`.

| metric | cold median | cold p90 | warm median | warm p90 |
|---|---:|---:|---:|---:|
| app ready (ms) | 377 | 412 | 63 | 63 |
| first paint (ms) | 298 | 319 | 46 | 74 |
| first contentful paint (ms) | 554 | 579 | 140 | 170 |
| document responseEnd (ms) | 221 | 248 | 11 | 12 |
| DOMContentLoaded (ms) | 278 | 308 | 44 | 45 |
| load event end (ms) | 278 | 308 | 44 | 46 |
| page requests | 16 | 16 | 10 | 10 |
| page bytes on the wire | 7212.8 KB | 7212.8 KB | 1.4 KB | 1.4 KB |
| page bytes loaded (content-length, cached or not) | 7208.1 KB | 7208.1 KB | 7083.6 KB | 7083.6 KB |
| JS bytes | 1934.8 KB | 1934.8 KB | 0.0 KB | 0.0 KB |
| wasm bytes | 5126.1 KB | 5126.1 KB | 0.0 KB | 0.0 KB |
| CSS bytes | 15.6 KB | 15.6 KB | 0.0 KB | 0.0 KB |
| bundle bytes | 1.4 KB | 1.4 KB | 1.4 KB | 1.4 KB |
| requests from HTTP cache | 0 | 0 | 8 | 8 |
| requests from service worker | 0 | 0 | 9 | 9 |
| failed requests | 0 | 0 | 0 | 0 |
| page requests until ready | 16 | 16 | 10 | 10 |
| page bytes until ready | 7212.8 KB | 7212.8 KB | 1.4 KB | 1.4 KB |
| service worker requests | 54 | 54 | 1 | 1 |
| service worker bytes on the wire | 1293.9 KB | 1293.9 KB | 2.6 KB | 2.6 KB |
| service worker bytes loaded (content-length) | 8508.2 KB | 8508.2 KB | 2.3 KB | 2.3 KB |
| service worker requests from HTTP cache | 10 | 10 | 0 | 0 |
| service worker bytes on the wire until ready | 1293.9 KB | 1293.9 KB | 2.6 KB | 2.6 KB |
| dedicated worker requests | 0 | 0 | 0 | 0 |
| dedicated worker bytes on the wire | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB |
| dedicated worker bytes loaded (content-length) | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB |
| long tasks | 0 | 0 | 0 | 0 |
| long task total (ms) | 0 | 0 | 0 | 0 |
| longest task (ms) | 0 | 0 | 0 | 0 |
| script time (ms) | 39 | 41 | 14 | 14 |
| main-thread task time (ms) | 147 | 151 | 51 | 52 |
| JS heap used (MB) | 5.9 | 6.0 | 8.3 | 8.3 |
| uncaught errors | 0 | 0 | 0 | 0 |

| phase (softn: marks, ms) | cold median | cold p90 | warm median | warm p90 |
|---|---:|---:|---:|---:|
| softn:compose | 1 | 1 | 0 | 0 |
| softn:parse | 1 | 1 | 0 | 0 |
| softn:vm-init | 88 | 110 | 17 | 18 |
| softn:xdb-seed | 0 | 0 | 0 | 0 |
| softn:zip | 1 | 2 | 2 | 2 |

<details><summary>Requests, cold pass (representative run: 70 rows)</summary>

| # | context | kind | status | bytes | cache | url |
|---:|---|---|---:|---:|---|---|
| 1 | page | html | 200 | 2.6 KB | network | `/?open=%2Fbench%2Fminimal.softn&embed=1` |
| 2 | page | js | 200 | 1739.0 KB | network | `/assets/index-CwQnIrts.js` |
| 3 | page | css | 200 | 15.6 KB | network | `/assets/index-BdKE3FSy.css` |
| 4 | page | js | 200 | 0.4 KB | network | `/registerSW.js` |
| 5 | page | json | 200 | 0.8 KB | network | `/manifest.webmanifest` |
| 6 | page | bundle | 200 | 1.4 KB | network | `/bench/minimal.softn` |
| 7 | page | font | 200 | 40.7 KB | network | `/assets/bricolage-grotesque-latin-wght-normal-DLoelf7F.woff2` |
| 8 | page | font | 200 | 22.3 KB | network | `/assets/ibm-plex-sans-latin-400-normal-CDDApCn2.woff2` |
| 9 | page | font | 200 | 14.6 KB | network | `/assets/ibm-plex-mono-latin-400-normal-DMJ8VG8y.woff2` |
| 10 | page | font | 200 | 24.0 KB | network | `/assets/ibm-plex-sans-latin-600-normal-CuJfVYMP.woff2` |
| 11 | page | font | 200 | 23.9 KB | network | `/assets/ibm-plex-sans-latin-500-normal-6ng42L7E.woff2` |
| 12 | serviceWorker | js | 200 | 0.3 KB | network | `/sw.js` |
| 13 | page | image | 200 | 0.7 KB | network | `/favicon.svg` |
| 14 | page | image | 200 | 5.2 KB | network | `/pwa-192x192.png` |
| 15 | serviceWorker | js | 200 | 0.0 KB | network | `/workbox-835c8c05.js` |
| 16 | serviceWorker | js | 200 | 0.0 KB | network | `/coi.js` |
| 17 | serviceWorker | js | 200 | 0.4 KB | network | `/registerSW.js` |
| 18 | page | wasm | 200 | 5126.1 KB | network | `/assets/zipp_wasm_bg-DZSXgiaN.wasm` |
| 19 | page | js | 200 | 195.0 KB | network | `/assets/xdb-sync-HEXTLQED-DRD-N-r4.js` |
| 20 | serviceWorker | image | 200 | 8.7 KB | network | `/pwa-maskable-512x512.png` |
| 21 | serviceWorker | image | 200 | 15.0 KB | network | `/pwa-512x512.png` |
| 22 | serviceWorker | image | 200 | 5.2 KB | network | `/pwa-192x192.png` |
| 23 | serviceWorker | html | 200 | 2.6 KB | network | `/index.html` |
| 24 | page | js | 200 | 0.4 KB | network | `/assets/xdb-PM4ITEJI-Btzr6Iku.js` |
| 25 | serviceWorker | image | 200 | 0.7 KB | network | `/favicon.svg` |
| 26 | serviceWorker | js | 200 | 1.9 KB | network | `/coi.js` |
| 27 | serviceWorker | wasm | 200 | 0.0 KB | disk | `/assets/zipp_wasm_bg-DZSXgiaN.wasm` |
| 28 | serviceWorker | js | 200 | 0.0 KB | disk | `/assets/xdb-sync-HEXTLQED-DRD-N-r4.js` |
| 29 | serviceWorker | js | 200 | 0.4 KB | network | `/assets/xdb-server-sync-VW7F6A3M-BLpazDwl.js` |
| 30 | serviceWorker | js | 200 | 0.0 KB | disk | `/assets/xdb-PM4ITEJI-Btzr6Iku.js` |
| 31 | serviceWorker | js | 200 | 544.2 KB | network | `/assets/transformers.web-DOBZSmMm.js` |
| 32 | serviceWorker | js | 200 | 394.1 KB | network | `/assets/ort.bundle.min-D4iHWIJU.js` |
| 33 | serviceWorker | js | 200 | 0.0 KB | disk | `/assets/index-CwQnIrts.js` |
| 34 | serviceWorker | css | 200 | 0.0 KB | disk | `/assets/index-BdKE3FSy.css` |
| 35 | serviceWorker | font | 200 | 8.5 KB | network | `/assets/ibm-plex-sans-vietnamese-600-normal-DpPYBSTl.woff2` |
| 36 | serviceWorker | font | 200 | 8.5 KB | network | `/assets/ibm-plex-sans-vietnamese-500-normal-e4dixQRQ.woff2` |
| 37 | serviceWorker | font | 200 | 8.3 KB | network | `/assets/ibm-plex-sans-vietnamese-400-normal-DG4YqDda.woff2` |
| 38 | serviceWorker | font | 200 | 16.3 KB | network | `/assets/ibm-plex-sans-latin-ext-600-normal-DOrvGEcy.woff2` |
| 39 | serviceWorker | font | 200 | 16.4 KB | network | `/assets/ibm-plex-sans-latin-ext-500-normal-DakdToA3.woff2` |
| 40 | serviceWorker | font | 200 | 15.9 KB | network | `/assets/ibm-plex-sans-latin-ext-400-normal-C5H60-Va.woff2` |
| 41 | serviceWorker | font | 200 | 0.0 KB | disk | `/assets/ibm-plex-sans-latin-600-normal-CuJfVYMP.woff2` |
| 42 | serviceWorker | font | 200 | 0.0 KB | disk | `/assets/ibm-plex-sans-latin-500-normal-6ng42L7E.woff2` |
| 43 | serviceWorker | font | 200 | 0.0 KB | disk | `/assets/ibm-plex-sans-latin-400-normal-CDDApCn2.woff2` |
| 44 | serviceWorker | font | 200 | 10.4 KB | network | `/assets/ibm-plex-sans-greek-600-normal-DzTrcv_p.woff2` |
| 45 | serviceWorker | font | 200 | 10.4 KB | network | `/assets/ibm-plex-sans-greek-500-normal-JMMifIXV.woff2` |
| 46 | serviceWorker | font | 200 | 10.0 KB | network | `/assets/ibm-plex-sans-greek-400-normal-_efipK4i.woff2` |
| 47 | serviceWorker | font | 200 | 12.3 KB | network | `/assets/ibm-plex-sans-cyrillic-ext-600-normal-DUMzJB7m.woff2` |
| 48 | serviceWorker | font | 200 | 12.3 KB | network | `/assets/ibm-plex-sans-cyrillic-ext-500-normal-Cs5J6C77.woff2` |
| 49 | serviceWorker | font | 200 | 12.1 KB | network | `/assets/ibm-plex-sans-cyrillic-ext-400-normal-g30qAdWV.woff2` |
| 50 | serviceWorker | font | 200 | 15.0 KB | network | `/assets/ibm-plex-sans-cyrillic-600-normal-71GNu3SW.woff2` |
| 51 | serviceWorker | font | 200 | 14.9 KB | network | `/assets/ibm-plex-sans-cyrillic-500-normal-CocWQlwt.woff2` |
| 52 | serviceWorker | font | 200 | 14.7 KB | network | `/assets/ibm-plex-sans-cyrillic-400-normal-DZqxrq2p.woff2` |
| 53 | serviceWorker | font | 200 | 6.2 KB | network | `/assets/ibm-plex-mono-vietnamese-500-normal-DZ4AoWbu.woff2` |
| 54 | serviceWorker | font | 200 | 6.0 KB | network | `/assets/ibm-plex-mono-vietnamese-400-normal-BulugwFq.woff2` |
| 55 | serviceWorker | font | 200 | 13.4 KB | network | `/assets/ibm-plex-mono-latin-ext-500-normal-CAhNIIs5.woff2` |
| 56 | serviceWorker | font | 200 | 13.3 KB | network | `/assets/ibm-plex-mono-latin-ext-400-normal-BmRBH3aV.woff2` |
| 57 | serviceWorker | font | 200 | 14.8 KB | network | `/assets/ibm-plex-mono-latin-500-normal-DSY6xOcd.woff2` |
| 58 | serviceWorker | font | 200 | 0.0 KB | disk | `/assets/ibm-plex-mono-latin-400-normal-DMJ8VG8y.woff2` |
| 59 | serviceWorker | font | 200 | 7.1 KB | network | `/assets/ibm-plex-mono-cyrillic-ext-500-normal-BqneJy0T.woff2` |
| 60 | serviceWorker | font | 200 | 7.0 KB | network | `/assets/ibm-plex-mono-cyrillic-ext-400-normal-xuaO2J-f.woff2` |
| 61 | serviceWorker | font | 200 | 8.5 KB | network | `/assets/ibm-plex-mono-cyrillic-500-normal-Bq9vWWag.woff2` |
| 62 | serviceWorker | font | 200 | 8.4 KB | network | `/assets/ibm-plex-mono-cyrillic-400-normal-BSMlKf0J.woff2` |
| 63 | serviceWorker | font | 200 | 8.7 KB | network | `/assets/bricolage-grotesque-vietnamese-wght-normal-BUzh504Q.woff2` |
| 64 | serviceWorker | font | 200 | 0.0 KB | disk | `/assets/bricolage-grotesque-latin-wght-normal-DLoelf7F.woff2` |
| 65 | serviceWorker | font | 200 | 18.5 KB | network | `/assets/bricolage-grotesque-latin-ext-wght-normal-CcLUaPy7.woff2` |
| 66 | serviceWorker | js | 200 | 8.4 KB | network | `/assets/ai-transformers-manager-62BSY5MF-Dvo2ZdQZ.js` |
| 67 | serviceWorker | js | 200 | 5.3 KB | network | `/assets/ai-onnx-manager-55MQNARR-D79-9uIb.js` |
| 68 | serviceWorker | js | 200 | 0.8 KB | network | `/assets/ai-manager-5ZCT5HOR-BKIFcns7.js` |
| 69 | serviceWorker | js | 200 | 6.7 KB | network | `/assets/ai-gpu-compute-manager-R64QBIWU-BSpUXTks.js` |
| 70 | serviceWorker | json | 200 | 0.8 KB | network | `/manifest.webmanifest` |

</details>

<details><summary>Requests, warm pass (representative run: 11 rows)</summary>

| # | context | kind | status | bytes | cache | url |
|---:|---|---|---:|---:|---|---|
| 1 | page | html | 200 | 0.0 KB | sw | `/?open=%2Fbench%2Fminimal.softn&embed=1` |
| 2 | serviceWorker | html | 200 | 2.6 KB | network | `/?open=%2Fbench%2Fminimal.softn&embed=1` |
| 3 | page | js | 200 | 0.0 KB | sw | `/assets/index-CwQnIrts.js` |
| 4 | page | css | 200 | 0.0 KB | sw | `/assets/index-BdKE3FSy.css` |
| 5 | page | js | 200 | 0.0 KB | sw | `/registerSW.js` |
| 6 | page | json | 200 | 0.0 KB | sw | `/manifest.webmanifest` |
| 7 | page | bundle | 200 | 1.4 KB | network | `/bench/minimal.softn` |
| 8 | page | image | 200 | 0.0 KB | sw | `/pwa-192x192.png` |
| 9 | page | wasm | 200 | 0.0 KB | sw | `/assets/zipp_wasm_bg-DZSXgiaN.wasm` |
| 10 | page | js | 200 | 0.0 KB | sw | `/assets/xdb-sync-HEXTLQED-DRD-N-r4.js` |
| 11 | page | js | 200 | 0.0 KB | sw | `/assets/xdb-PM4ITEJI-Btzr6Iku.js` |

</details>

### scene-glb — Scene3D with one bundled GLB

One Scene3D, one bundled glTF binary, no effects, no orbit controls. Bundle: 1.9 KB (logic/main.logic 0.4 KB, manifest.json 0.3 KB, permission.json 0.0 KB, ui/main.ui 1.0 KB, assets/models/tetra.glb 1.1 KB).

- cold: ready 5/5; 3D module URL requested in 0/5; 3D code inside loaded JS in 5/5; WebGL2 available in 5/5 (ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)); service worker controlling 5/5
- warm: ready 5/5; 3D module URL requested in 0/5; 3D code inside loaded JS in 5/5; WebGL2 available in 5/5 (ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)); service worker controlling 5/5

Scripts carrying 3D code (cold): three in `/assets/index-CwQnIrts.js`; gltf in `/assets/index-CwQnIrts.js`; obj in `/assets/index-CwQnIrts.js`; fbx in `/assets/index-CwQnIrts.js`; stl in `/assets/index-CwQnIrts.js`; postprocessing in `/assets/index-CwQnIrts.js`; bloom in `/assets/index-CwQnIrts.js`.

| metric | cold median | cold p90 | warm median | warm p90 |
|---|---:|---:|---:|---:|
| app ready (ms) | 454 | 480 | 73 | 76 |
| first paint (ms) | 313 | 353 | 71 | 86 |
| first contentful paint (ms) | 505 | 541 | 102 | 117 |
| document responseEnd (ms) | 239 | 275 | 11 | 12 |
| DOMContentLoaded (ms) | 310 | 333 | 45 | 46 |
| load event end (ms) | 311 | 333 | 45 | 47 |
| first WebGL context (ms) | 445 | 470 | 69 | 71 |
| first GL draw (ms) | 522 | 564 | 105 | 107 |
| page requests | 17 | 17 | 11 | 11 |
| page bytes on the wire | 7213.6 KB | 7213.6 KB | 2.2 KB | 2.2 KB |
| page bytes loaded (content-length, cached or not) | 7210.0 KB | 7210.0 KB | 7085.5 KB | 7085.5 KB |
| JS bytes | 1934.8 KB | 1934.8 KB | 0.0 KB | 0.0 KB |
| wasm bytes | 5126.1 KB | 5126.1 KB | 0.0 KB | 0.0 KB |
| CSS bytes | 15.6 KB | 15.6 KB | 0.0 KB | 0.0 KB |
| bundle bytes | 2.2 KB | 2.2 KB | 2.2 KB | 2.2 KB |
| requests from HTTP cache | 0 | 0 | 8 | 8 |
| requests from service worker | 0 | 0 | 9 | 9 |
| failed requests | 0 | 0 | 0 | 0 |
| page requests until ready | 17 | 17 | 11 | 11 |
| page bytes until ready | 7213.6 KB | 7213.6 KB | 2.2 KB | 2.2 KB |
| service worker requests | 54 | 54 | 1 | 1 |
| service worker bytes on the wire | 1293.9 KB | 1293.9 KB | 2.6 KB | 2.6 KB |
| service worker bytes loaded (content-length) | 8508.2 KB | 8508.2 KB | 2.3 KB | 2.3 KB |
| service worker requests from HTTP cache | 10 | 10 | 0 | 0 |
| service worker bytes on the wire until ready | 1293.9 KB | 1293.9 KB | 2.6 KB | 2.6 KB |
| dedicated worker requests | 0 | 0 | 0 | 0 |
| dedicated worker bytes on the wire | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB |
| dedicated worker bytes loaded (content-length) | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB |
| long tasks | 1 | 1 | 0 | 0 |
| long task total (ms) | 52 | 56 | 0 | 0 |
| longest task (ms) | 52 | 56 | 0 | 0 |
| script time (ms) | 125 | 136 | 42 | 43 |
| main-thread task time (ms) | 244 | 260 | 94 | 111 |
| JS heap used (MB) | 7.6 | 7.7 | 8.4 | 11.5 |
| uncaught errors | 0 | 0 | 0 | 0 |

| phase (softn: marks, ms) | cold median | cold p90 | warm median | warm p90 |
|---|---:|---:|---:|---:|
| softn:compose | 1 | 1 | 0 | 0 |
| softn:parse | 1 | 1 | 0 | 0 |
| softn:vm-init | 126 | 134 | 34 | 37 |
| softn:xdb-seed | 0 | 0 | 0 | 0 |
| softn:zip | 1 | 2 | 2 | 2 |

<details><summary>Requests, cold pass (representative run: 71 rows)</summary>

| # | context | kind | status | bytes | cache | url |
|---:|---|---|---:|---:|---|---|
| 1 | page | html | 200 | 2.6 KB | network | `/?open=%2Fbench%2Fscene-glb.softn&embed=1` |
| 2 | page | js | 200 | 1739.0 KB | network | `/assets/index-CwQnIrts.js` |
| 3 | page | css | 200 | 15.6 KB | network | `/assets/index-BdKE3FSy.css` |
| 4 | page | js | 200 | 0.4 KB | network | `/registerSW.js` |
| 5 | page | json | 200 | 0.8 KB | network | `/manifest.webmanifest` |
| 6 | page | bundle | 200 | 2.2 KB | network | `/bench/scene-glb.softn` |
| 7 | page | font | 200 | 40.7 KB | network | `/assets/bricolage-grotesque-latin-wght-normal-DLoelf7F.woff2` |
| 8 | page | font | 200 | 22.3 KB | network | `/assets/ibm-plex-sans-latin-400-normal-CDDApCn2.woff2` |
| 9 | page | font | 200 | 14.6 KB | network | `/assets/ibm-plex-mono-latin-400-normal-DMJ8VG8y.woff2` |
| 10 | page | font | 200 | 24.0 KB | network | `/assets/ibm-plex-sans-latin-600-normal-CuJfVYMP.woff2` |
| 11 | page | font | 200 | 23.9 KB | network | `/assets/ibm-plex-sans-latin-500-normal-6ng42L7E.woff2` |
| 12 | serviceWorker | js | 200 | 0.3 KB | network | `/sw.js` |
| 13 | page | image | 200 | 0.7 KB | network | `/favicon.svg` |
| 14 | page | image | 200 | 5.2 KB | network | `/pwa-192x192.png` |
| 15 | serviceWorker | js | 200 | 0.0 KB | network | `/workbox-835c8c05.js` |
| 16 | serviceWorker | js | 200 | 0.0 KB | network | `/coi.js` |
| 17 | serviceWorker | js | 200 | 0.4 KB | network | `/registerSW.js` |
| 18 | serviceWorker | image | 200 | 8.7 KB | network | `/pwa-maskable-512x512.png` |
| 19 | serviceWorker | image | 200 | 15.0 KB | network | `/pwa-512x512.png` |
| 20 | page | wasm | 200 | 5126.1 KB | network | `/assets/zipp_wasm_bg-DZSXgiaN.wasm` |
| 21 | page | js | 200 | 195.0 KB | network | `/assets/xdb-sync-HEXTLQED-DRD-N-r4.js` |
| 22 | serviceWorker | image | 200 | 5.2 KB | network | `/pwa-192x192.png` |
| 23 | serviceWorker | html | 200 | 2.6 KB | network | `/index.html` |
| 24 | serviceWorker | image | 200 | 0.7 KB | network | `/favicon.svg` |
| 25 | serviceWorker | js | 200 | 1.9 KB | network | `/coi.js` |
| 26 | page | blob | 200 | 0.0 KB | network | `blob:http://127.0.0.1:63377/f24f9811-78e5-4aed-8be8-42603f1ab33b` |
| 27 | serviceWorker | wasm | 200 | 0.0 KB | disk | `/assets/zipp_wasm_bg-DZSXgiaN.wasm` |
| 28 | page | js | 200 | 0.4 KB | network | `/assets/xdb-PM4ITEJI-Btzr6Iku.js` |
| 29 | serviceWorker | js | 200 | 0.0 KB | disk | `/assets/xdb-sync-HEXTLQED-DRD-N-r4.js` |
| 30 | serviceWorker | js | 200 | 0.4 KB | network | `/assets/xdb-server-sync-VW7F6A3M-BLpazDwl.js` |
| 31 | serviceWorker | js | 200 | 0.0 KB | disk | `/assets/xdb-PM4ITEJI-Btzr6Iku.js` |
| 32 | serviceWorker | js | 200 | 544.2 KB | network | `/assets/transformers.web-DOBZSmMm.js` |
| 33 | serviceWorker | js | 200 | 394.1 KB | network | `/assets/ort.bundle.min-D4iHWIJU.js` |
| 34 | serviceWorker | js | 200 | 0.0 KB | disk | `/assets/index-CwQnIrts.js` |
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
| 67 | serviceWorker | js | 200 | 8.4 KB | network | `/assets/ai-transformers-manager-62BSY5MF-Dvo2ZdQZ.js` |
| 68 | serviceWorker | js | 200 | 5.3 KB | network | `/assets/ai-onnx-manager-55MQNARR-D79-9uIb.js` |
| 69 | serviceWorker | js | 200 | 0.8 KB | network | `/assets/ai-manager-5ZCT5HOR-BKIFcns7.js` |
| 70 | serviceWorker | js | 200 | 6.7 KB | network | `/assets/ai-gpu-compute-manager-R64QBIWU-BSpUXTks.js` |
| 71 | serviceWorker | json | 200 | 0.8 KB | network | `/manifest.webmanifest` |

</details>

<details><summary>Requests, warm pass (representative run: 12 rows)</summary>

| # | context | kind | status | bytes | cache | url |
|---:|---|---|---:|---:|---|---|
| 1 | page | html | 200 | 0.0 KB | sw | `/?open=%2Fbench%2Fscene-glb.softn&embed=1` |
| 2 | serviceWorker | html | 200 | 2.6 KB | network | `/?open=%2Fbench%2Fscene-glb.softn&embed=1` |
| 3 | page | js | 200 | 0.0 KB | sw | `/assets/index-CwQnIrts.js` |
| 4 | page | css | 200 | 0.0 KB | sw | `/assets/index-BdKE3FSy.css` |
| 5 | page | js | 200 | 0.0 KB | sw | `/registerSW.js` |
| 6 | page | json | 200 | 0.0 KB | sw | `/manifest.webmanifest` |
| 7 | page | bundle | 200 | 2.2 KB | network | `/bench/scene-glb.softn` |
| 8 | page | image | 200 | 0.0 KB | sw | `/pwa-192x192.png` |
| 9 | page | blob | 200 | 0.0 KB | network | `blob:http://127.0.0.1:63377/77c781d9-e9cd-4c33-9f2f-32eeb3984fa5` |
| 10 | page | wasm | 200 | 0.0 KB | sw | `/assets/zipp_wasm_bg-DZSXgiaN.wasm` |
| 11 | page | js | 200 | 0.0 KB | sw | `/assets/xdb-sync-HEXTLQED-DRD-N-r4.js` |
| 12 | page | js | 200 | 0.0 KB | sw | `/assets/xdb-PM4ITEJI-Btzr6Iku.js` |

</details>

### scene-effects — Scene3D with bloom

The scene-glb fixture with bloom on, so the post-processing path is exercised. Bundle: 2.0 KB (logic/main.logic 0.4 KB, manifest.json 0.3 KB, permission.json 0.0 KB, ui/main.ui 1.0 KB, assets/models/tetra.glb 1.1 KB).

- cold: ready 5/5; 3D module URL requested in 0/5; 3D code inside loaded JS in 5/5; WebGL2 available in 5/5 (ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)); service worker controlling 5/5
- warm: ready 5/5; 3D module URL requested in 0/5; 3D code inside loaded JS in 5/5; WebGL2 available in 5/5 (ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)); service worker controlling 5/5

Scripts carrying 3D code (cold): three in `/assets/index-CwQnIrts.js`; gltf in `/assets/index-CwQnIrts.js`; obj in `/assets/index-CwQnIrts.js`; fbx in `/assets/index-CwQnIrts.js`; stl in `/assets/index-CwQnIrts.js`; postprocessing in `/assets/index-CwQnIrts.js`; bloom in `/assets/index-CwQnIrts.js`.

| metric | cold median | cold p90 | warm median | warm p90 |
|---|---:|---:|---:|---:|
| app ready (ms) | 471 | 567 | 220 | 258 |
| first paint (ms) | 296 | 329 | 156 | 196 |
| first contentful paint (ms) | 595 | 673 | 313 | 383 |
| document responseEnd (ms) | 232 | 258 | 12 | 14 |
| DOMContentLoaded (ms) | 291 | 315 | 51 | 52 |
| load event end (ms) | 292 | 315 | 52 | 52 |
| first WebGL context (ms) | 428 | 449 | 146 | 183 |
| first GL draw (ms) | 448 | 468 | 152 | 189 |
| page requests | 17 | 17 | 11 | 11 |
| page bytes on the wire | 7213.6 KB | 7213.6 KB | 2.3 KB | 2.3 KB |
| page bytes loaded (content-length, cached or not) | 7210.0 KB | 7210.0 KB | 7085.5 KB | 7085.5 KB |
| JS bytes | 1934.8 KB | 1934.8 KB | 0.0 KB | 0.0 KB |
| wasm bytes | 5126.1 KB | 5126.1 KB | 0.0 KB | 0.0 KB |
| CSS bytes | 15.6 KB | 15.6 KB | 0.0 KB | 0.0 KB |
| bundle bytes | 2.3 KB | 2.3 KB | 2.3 KB | 2.3 KB |
| requests from HTTP cache | 0 | 0 | 8 | 8 |
| requests from service worker | 0 | 0 | 9 | 9 |
| failed requests | 0 | 0 | 0 | 0 |
| page requests until ready | 17 | 17 | 11 | 11 |
| page bytes until ready | 7213.6 KB | 7213.6 KB | 2.3 KB | 2.3 KB |
| service worker requests | 54 | 54 | 1 | 1 |
| service worker bytes on the wire | 1294.2 KB | 1294.2 KB | 2.6 KB | 2.6 KB |
| service worker bytes loaded (content-length) | 8508.2 KB | 8508.2 KB | 2.3 KB | 2.3 KB |
| service worker requests from HTTP cache | 9 | 9 | 0 | 0 |
| service worker bytes on the wire until ready | 1294.2 KB | 1294.2 KB | 2.6 KB | 2.6 KB |
| dedicated worker requests | 0 | 0 | 0 | 0 |
| dedicated worker bytes on the wire | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB |
| dedicated worker bytes loaded (content-length) | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB |
| long tasks | 4 | 4 | 2 | 3 |
| long task total (ms) | 325 | 338 | 216 | 361 |
| longest task (ms) | 119 | 165 | 153 | 187 |
| script time (ms) | 386 | 398 | 283 | 298 |
| main-thread task time (ms) | 527 | 536 | 452 | 583 |
| JS heap used (MB) | 7.4 | 7.8 | 10.2 | 10.3 |
| uncaught errors | 0 | 0 | 0 | 0 |

| phase (softn: marks, ms) | cold median | cold p90 | warm median | warm p90 |
|---|---:|---:|---:|---:|
| softn:compose | 1 | 1 | 0 | 0 |
| softn:parse | 1 | 2 | 1 | 1 |
| softn:vm-init | 338 | 343 | 301 | 311 |
| softn:xdb-seed | 0 | 0 | 0 | 0 |
| softn:zip | 1 | 3 | 2 | 2 |

<details><summary>Requests, cold pass (representative run: 71 rows)</summary>

| # | context | kind | status | bytes | cache | url |
|---:|---|---|---:|---:|---|---|
| 1 | page | html | 200 | 2.6 KB | network | `/?open=%2Fbench%2Fscene-effects.softn&embed=1` |
| 2 | page | js | 200 | 1739.0 KB | network | `/assets/index-CwQnIrts.js` |
| 3 | page | css | 200 | 15.6 KB | network | `/assets/index-BdKE3FSy.css` |
| 4 | page | js | 200 | 0.4 KB | network | `/registerSW.js` |
| 5 | page | json | 200 | 0.8 KB | network | `/manifest.webmanifest` |
| 6 | page | bundle | 200 | 2.3 KB | network | `/bench/scene-effects.softn` |
| 7 | page | font | 200 | 40.7 KB | network | `/assets/bricolage-grotesque-latin-wght-normal-DLoelf7F.woff2` |
| 8 | page | font | 200 | 22.3 KB | network | `/assets/ibm-plex-sans-latin-400-normal-CDDApCn2.woff2` |
| 9 | page | font | 200 | 14.6 KB | network | `/assets/ibm-plex-mono-latin-400-normal-DMJ8VG8y.woff2` |
| 10 | page | font | 200 | 24.0 KB | network | `/assets/ibm-plex-sans-latin-600-normal-CuJfVYMP.woff2` |
| 11 | page | font | 200 | 23.9 KB | network | `/assets/ibm-plex-sans-latin-500-normal-6ng42L7E.woff2` |
| 12 | serviceWorker | js | 200 | 0.3 KB | network | `/sw.js` |
| 13 | page | image | 200 | 0.7 KB | network | `/favicon.svg` |
| 14 | page | image | 200 | 5.2 KB | network | `/pwa-192x192.png` |
| 15 | serviceWorker | js | 200 | 0.0 KB | network | `/workbox-835c8c05.js` |
| 16 | serviceWorker | js | 200 | 0.0 KB | network | `/coi.js` |
| 17 | serviceWorker | js | 200 | 0.4 KB | network | `/registerSW.js` |
| 18 | page | wasm | 200 | 5126.1 KB | network | `/assets/zipp_wasm_bg-DZSXgiaN.wasm` |
| 19 | page | js | 200 | 195.0 KB | network | `/assets/xdb-sync-HEXTLQED-DRD-N-r4.js` |
| 20 | serviceWorker | image | 200 | 8.7 KB | network | `/pwa-maskable-512x512.png` |
| 21 | serviceWorker | image | 200 | 15.0 KB | network | `/pwa-512x512.png` |
| 22 | serviceWorker | image | 200 | 5.2 KB | network | `/pwa-192x192.png` |
| 23 | serviceWorker | html | 200 | 2.6 KB | network | `/index.html` |
| 24 | serviceWorker | image | 200 | 0.7 KB | network | `/favicon.svg` |
| 25 | serviceWorker | js | 200 | 1.9 KB | network | `/coi.js` |
| 26 | serviceWorker | wasm | 200 | 0.0 KB | disk | `/assets/zipp_wasm_bg-DZSXgiaN.wasm` |
| 27 | page | blob | 200 | 0.0 KB | network | `blob:http://127.0.0.1:63377/a5d57b1f-8762-46e4-ab23-51c9b04ad7ed` |
| 28 | serviceWorker | js | 200 | 0.0 KB | disk | `/assets/xdb-sync-HEXTLQED-DRD-N-r4.js` |
| 29 | serviceWorker | js | 200 | 0.4 KB | network | `/assets/xdb-server-sync-VW7F6A3M-BLpazDwl.js` |
| 30 | serviceWorker | js | 200 | 0.4 KB | network | `/assets/xdb-PM4ITEJI-Btzr6Iku.js` |
| 31 | serviceWorker | js | 200 | 544.2 KB | network | `/assets/transformers.web-DOBZSmMm.js` |
| 32 | serviceWorker | js | 200 | 394.1 KB | network | `/assets/ort.bundle.min-D4iHWIJU.js` |
| 33 | serviceWorker | js | 200 | 0.0 KB | disk | `/assets/index-CwQnIrts.js` |
| 34 | serviceWorker | css | 200 | 0.0 KB | disk | `/assets/index-BdKE3FSy.css` |
| 35 | serviceWorker | font | 200 | 8.5 KB | network | `/assets/ibm-plex-sans-vietnamese-600-normal-DpPYBSTl.woff2` |
| 36 | serviceWorker | font | 200 | 8.5 KB | network | `/assets/ibm-plex-sans-vietnamese-500-normal-e4dixQRQ.woff2` |
| 37 | serviceWorker | font | 200 | 8.3 KB | network | `/assets/ibm-plex-sans-vietnamese-400-normal-DG4YqDda.woff2` |
| 38 | serviceWorker | font | 200 | 16.3 KB | network | `/assets/ibm-plex-sans-latin-ext-600-normal-DOrvGEcy.woff2` |
| 39 | serviceWorker | font | 200 | 16.4 KB | network | `/assets/ibm-plex-sans-latin-ext-500-normal-DakdToA3.woff2` |
| 40 | serviceWorker | font | 200 | 15.9 KB | network | `/assets/ibm-plex-sans-latin-ext-400-normal-C5H60-Va.woff2` |
| 41 | serviceWorker | font | 200 | 0.0 KB | disk | `/assets/ibm-plex-sans-latin-600-normal-CuJfVYMP.woff2` |
| 42 | serviceWorker | font | 200 | 0.0 KB | disk | `/assets/ibm-plex-sans-latin-500-normal-6ng42L7E.woff2` |
| 43 | serviceWorker | font | 200 | 0.0 KB | disk | `/assets/ibm-plex-sans-latin-400-normal-CDDApCn2.woff2` |
| 44 | serviceWorker | font | 200 | 10.4 KB | network | `/assets/ibm-plex-sans-greek-600-normal-DzTrcv_p.woff2` |
| 45 | serviceWorker | font | 200 | 10.4 KB | network | `/assets/ibm-plex-sans-greek-500-normal-JMMifIXV.woff2` |
| 46 | serviceWorker | font | 200 | 10.0 KB | network | `/assets/ibm-plex-sans-greek-400-normal-_efipK4i.woff2` |
| 47 | serviceWorker | font | 200 | 12.3 KB | network | `/assets/ibm-plex-sans-cyrillic-ext-600-normal-DUMzJB7m.woff2` |
| 48 | serviceWorker | font | 200 | 12.3 KB | network | `/assets/ibm-plex-sans-cyrillic-ext-500-normal-Cs5J6C77.woff2` |
| 49 | serviceWorker | font | 200 | 12.1 KB | network | `/assets/ibm-plex-sans-cyrillic-ext-400-normal-g30qAdWV.woff2` |
| 50 | page | js | 200 | 0.4 KB | network | `/assets/xdb-PM4ITEJI-Btzr6Iku.js` |
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
| 67 | serviceWorker | js | 200 | 8.4 KB | network | `/assets/ai-transformers-manager-62BSY5MF-Dvo2ZdQZ.js` |
| 68 | serviceWorker | js | 200 | 5.3 KB | network | `/assets/ai-onnx-manager-55MQNARR-D79-9uIb.js` |
| 69 | serviceWorker | js | 200 | 0.8 KB | network | `/assets/ai-manager-5ZCT5HOR-BKIFcns7.js` |
| 70 | serviceWorker | js | 200 | 6.7 KB | network | `/assets/ai-gpu-compute-manager-R64QBIWU-BSpUXTks.js` |
| 71 | serviceWorker | json | 200 | 0.8 KB | network | `/manifest.webmanifest` |

</details>

<details><summary>Requests, warm pass (representative run: 12 rows)</summary>

| # | context | kind | status | bytes | cache | url |
|---:|---|---|---:|---:|---|---|
| 1 | page | html | 200 | 0.0 KB | sw | `/?open=%2Fbench%2Fscene-effects.softn&embed=1` |
| 2 | serviceWorker | html | 200 | 2.6 KB | network | `/?open=%2Fbench%2Fscene-effects.softn&embed=1` |
| 3 | page | js | 200 | 0.0 KB | sw | `/assets/index-CwQnIrts.js` |
| 4 | page | css | 200 | 0.0 KB | sw | `/assets/index-BdKE3FSy.css` |
| 5 | page | js | 200 | 0.0 KB | sw | `/registerSW.js` |
| 6 | page | json | 200 | 0.0 KB | sw | `/manifest.webmanifest` |
| 7 | page | bundle | 200 | 2.3 KB | network | `/bench/scene-effects.softn` |
| 8 | page | image | 200 | 0.0 KB | sw | `/pwa-192x192.png` |
| 9 | page | blob | 200 | 0.0 KB | network | `blob:http://127.0.0.1:63377/d98147ed-725c-4cb4-b715-aed05519c759` |
| 10 | page | wasm | 200 | 0.0 KB | sw | `/assets/zipp_wasm_bg-DZSXgiaN.wasm` |
| 11 | page | js | 200 | 0.0 KB | sw | `/assets/xdb-sync-HEXTLQED-DRD-N-r4.js` |
| 12 | page | js | 200 | 0.0 KB | sw | `/assets/xdb-PM4ITEJI-Btzr6Iku.js` |

</details>
