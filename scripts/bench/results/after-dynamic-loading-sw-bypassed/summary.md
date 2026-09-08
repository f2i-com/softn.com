# Bench: after-dynamic-loading-sw-bypassed

## Host: web

Generated 2026-09-08T00:51:03.003Z · apps/softn-web/dist built 2026-09-08T00:40:09.816Z · package 0.0.7 · git audit/dynamic-loading@e9fccda (dirty tree)

Edg/152.0.4191.66 headless · SwiftShader software WebGL (headless); not a GPU · AMD Ryzen 9 9950X3D 16-Core Processor (32 cores, 190 GB) · win32 10.0.26200 · Node v24.12.0

5 runs per scenario, fresh profile each; cold = HTTP cache disabled, warm = second navigation in the same profile with the service worker bypassed. localhost HTTP/1.1, no compression, deployment cache headers. Medians and nearest-rank p90 over runs.

### minimal — Minimal text and form

A heading, a paragraph, an input and a button. No 3D. Bundle: 1.1 KB (logic/main.logic 0.1 KB, manifest.json 0.3 KB, permission.json 0.0 KB, ui/main.ui 0.7 KB).

- cold: ready 5/5; 3D module URL requested in 0/5; 3D code inside loaded JS in 0/5; WebGL2 available in 5/5 (ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)); service worker controlling 5/5
- warm: ready 5/5; 3D module URL requested in 0/5; 3D code inside loaded JS in 0/5; WebGL2 available in 5/5 (ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)); service worker controlling 0/5

| metric | cold median | cold p90 | warm median | warm p90 |
|---|---:|---:|---:|---:|
| app ready (ms) | 370 | 413 | 39 | 45 |
| first paint (ms) | 282 | 329 | 65 | 131 |
| first contentful paint (ms) | 548 | 564 | 117 | 159 |
| document responseEnd (ms) | 221 | 242 | 5 | 5 |
| DOMContentLoaded (ms) | 259 | 292 | 22 | 23 |
| load event end (ms) | 259 | 293 | 22 | 24 |
| page requests | 15 | 15 | 14 | 14 |
| page bytes on the wire | 5994.3 KB | 5994.3 KB | 5.2 KB | 5.2 KB |
| page bytes loaded (content-length, cached or not) | 5989.9 KB | 5989.9 KB | 5989.5 KB | 5989.5 KB |
| JS bytes | 716.3 KB | 716.3 KB | 0.4 KB | 0.4 KB |
| wasm bytes | 5126.1 KB | 5126.1 KB | 0.0 KB | 0.0 KB |
| CSS bytes | 15.6 KB | 15.6 KB | 0.0 KB | 0.0 KB |
| bundle bytes | 1.4 KB | 1.4 KB | 1.4 KB | 1.4 KB |
| requests from HTTP cache | 0 | 0 | 10 | 10 |
| requests from service worker | 0 | 0 | 0 | 0 |
| failed requests | 0 | 0 | 0 | 0 |
| page requests until ready | 15 | 15 | 14 | 14 |
| page bytes until ready | 5994.3 KB | 5994.3 KB | 5.2 KB | 5.2 KB |
| service worker requests | 47 | 47 | 0 | 0 |
| service worker bytes on the wire | 344.8 KB | 344.8 KB | 0.0 KB | 0.0 KB |
| service worker bytes loaded (content-length) | 6343.7 KB | 6343.7 KB | 0.0 KB | 0.0 KB |
| service worker requests from HTTP cache | 9 | 9 | 0 | 0 |
| service worker bytes on the wire until ready | 344.8 KB | 344.8 KB | 0.0 KB | 0.0 KB |
| dedicated worker requests | 0 | 0 | 0 | 0 |
| dedicated worker bytes on the wire | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB |
| dedicated worker bytes loaded (content-length) | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB |
| long tasks | 0 | 1 | 0 | 0 |
| long task total (ms) | 0 | 50 | 0 | 0 |
| longest task (ms) | 0 | 50 | 0 | 0 |
| script time (ms) | 30 | 33 | 12 | 14 |
| main-thread task time (ms) | 145 | 154 | 47 | 51 |
| JS heap used (MB) | 3.9 | 3.9 | 4.8 | 4.8 |
| uncaught errors | 0 | 0 | 0 | 0 |

| phase (softn: marks, ms) | cold median | cold p90 | warm median | warm p90 |
|---|---:|---:|---:|---:|
| softn:component-preload | 2 | 3 | 2 | 3 |
| softn:compose | 1 | 1 | 0 | 0 |
| softn:offline-install | 317 | 663 | — | — |
| softn:parse | 0 | 0 | 0 | 1 |
| softn:vm-init | 98 | 111 | 18 | 19 |
| softn:xdb-seed | 0 | 0 | 0 | 0 |
| softn:zip | 1 | 2 | 1 | 1 |

<details><summary>Requests, cold pass (representative run: 62 rows)</summary>

| # | context | kind | status | bytes | cache | url |
|---:|---|---|---:|---:|---|---|
| 1 | page | html | 200 | 2.6 KB | network | `/?open=%2Fbench%2Fminimal.softn&embed=1` |
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
| 12 | page | bundle | 200 | 1.4 KB | network | `/bench/minimal.softn` |
| 13 | page | image | 200 | 0.7 KB | network | `/favicon.svg` |
| 14 | page | image | 200 | 5.2 KB | network | `/pwa-192x192.png` |
| 15 | serviceWorker | js | 200 | 0.0 KB | network | `/workbox-63c18b4d.js` |
| 16 | serviceWorker | js | 200 | 0.0 KB | network | `/coi.js` |
| 17 | serviceWorker | js | 200 | 0.4 KB | network | `/registerSW.js` |
| 18 | serviceWorker | image | 200 | 8.7 KB | network | `/pwa-maskable-512x512.png` |
| 19 | serviceWorker | image | 200 | 15.0 KB | network | `/pwa-512x512.png` |
| 20 | serviceWorker | image | 200 | 5.2 KB | network | `/pwa-192x192.png` |
| 21 | page | wasm | 200 | 5126.1 KB | network | `/assets/zipp_wasm_bg-DZSXgiaN.wasm` |
| 22 | serviceWorker | html | 200 | 2.6 KB | network | `/index.html` |
| 23 | serviceWorker | image | 200 | 0.7 KB | network | `/favicon.svg` |
| 24 | page | js | 200 | 0.4 KB | network | `/assets/xdb-N2VKATSB-BwhH368Z.js` |
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

<details><summary>Requests, warm pass (representative run: 14 rows)</summary>

| # | context | kind | status | bytes | cache | url |
|---:|---|---|---:|---:|---|---|
| 1 | page | html | 200 | 2.6 KB | network | `/?open=%2Fbench%2Fminimal.softn&embed=1` |
| 2 | page | js | 200 | 0.0 KB | memory | `/assets/index-DSZmgK9M.js` |
| 3 | page | css | 200 | 0.0 KB | memory | `/assets/index-BdKE3FSy.css` |
| 4 | page | js | 200 | 0.4 KB | network | `/registerSW.js` |
| 5 | page | font | 200 | 0.0 KB | memory | `/assets/bricolage-grotesque-latin-wght-normal-DLoelf7F.woff2` |
| 6 | page | font | 200 | 0.0 KB | memory | `/assets/ibm-plex-sans-latin-400-normal-CDDApCn2.woff2` |
| 7 | page | font | 200 | 0.0 KB | memory | `/assets/ibm-plex-sans-latin-500-normal-6ng42L7E.woff2` |
| 8 | page | font | 200 | 0.0 KB | memory | `/assets/ibm-plex-sans-latin-600-normal-CuJfVYMP.woff2` |
| 9 | page | font | 200 | 0.0 KB | memory | `/assets/ibm-plex-mono-latin-400-normal-DMJ8VG8y.woff2` |
| 10 | page | bundle | 200 | 1.4 KB | network | `/bench/minimal.softn` |
| 11 | page | json | 200 | 0.8 KB | network | `/manifest.webmanifest` |
| 12 | page | image | 200 | 0.0 KB | disk | `/pwa-192x192.png` |
| 13 | page | wasm | 200 | 0.0 KB | disk | `/assets/zipp_wasm_bg-DZSXgiaN.wasm` |
| 14 | page | js | 200 | 0.0 KB | memory | `/assets/xdb-N2VKATSB-BwhH368Z.js` |

</details>

### scene-glb — Scene3D with one bundled GLB

One Scene3D, one bundled glTF binary, no effects, no orbit controls. Bundle: 1.9 KB (logic/main.logic 0.4 KB, manifest.json 0.3 KB, permission.json 0.0 KB, ui/main.ui 1.0 KB, assets/models/tetra.glb 1.1 KB).

- cold: ready 5/5; 3D module URL requested in 5/5; 3D code inside loaded JS in 5/5; WebGL2 available in 5/5 (ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)); service worker controlling 5/5
- warm: ready 5/5; 3D module URL requested in 5/5; 3D code inside loaded JS in 5/5; WebGL2 available in 5/5 (ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)); service worker controlling 0/5

Scripts carrying 3D code (cold): three in `/assets/vendor-three-DRaE6mEZ.js`; gltf in `/assets/GLTFLoader-DBAV7NEX.js`.

| metric | cold median | cold p90 | warm median | warm p90 |
|---|---:|---:|---:|---:|
| app ready (ms) | 416 | 429 | 68 | 86 |
| first paint (ms) | 320 | 342 | 59 | 101 |
| first contentful paint (ms) | 445 | 467 | 91 | 149 |
| document responseEnd (ms) | 210 | 239 | 5 | 5 |
| DOMContentLoaded (ms) | 255 | 280 | 24 | 26 |
| load event end (ms) | 256 | 281 | 24 | 27 |
| first WebGL context (ms) | 407 | 419 | 62 | 80 |
| first GL draw (ms) | 493 | 502 | 95 | 137 |
| page requests | 20 | 20 | 19 | 19 |
| page bytes on the wire | 6655.2 KB | 6655.2 KB | 6.0 KB | 6.0 KB |
| page bytes loaded (content-length, cached or not) | 6651.1 KB | 6651.1 KB | 6650.6 KB | 6650.6 KB |
| JS bytes | 1376.5 KB | 1376.5 KB | 0.4 KB | 0.4 KB |
| wasm bytes | 5126.1 KB | 5126.1 KB | 0.0 KB | 0.0 KB |
| CSS bytes | 15.6 KB | 15.6 KB | 0.0 KB | 0.0 KB |
| bundle bytes | 2.2 KB | 2.2 KB | 2.2 KB | 2.2 KB |
| requests from HTTP cache | 0 | 0 | 13 | 13 |
| requests from service worker | 0 | 0 | 0 | 0 |
| failed requests | 0 | 0 | 0 | 0 |
| page requests until ready | 20 | 20 | 19 | 19 |
| page bytes until ready | 6655.2 KB | 6655.2 KB | 6.0 KB | 6.0 KB |
| service worker requests | 47 | 47 | 0 | 0 |
| service worker bytes on the wire | 333.9 KB | 334.3 KB | 0.0 KB | 0.0 KB |
| service worker bytes loaded (content-length) | 6343.7 KB | 6343.7 KB | 0.0 KB | 0.0 KB |
| service worker requests from HTTP cache | 10 | 10 | 0 | 0 |
| service worker bytes on the wire until ready | 333.9 KB | 334.3 KB | 0.0 KB | 0.0 KB |
| dedicated worker requests | 0 | 0 | 0 | 0 |
| dedicated worker bytes on the wire | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB |
| dedicated worker bytes loaded (content-length) | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB |
| long tasks | 0 | 1 | 0 | 0 |
| long task total (ms) | 0 | 60 | 0 | 0 |
| longest task (ms) | 0 | 60 | 0 | 0 |
| script time (ms) | 105 | 143 | 57 | 75 |
| main-thread task time (ms) | 240 | 279 | 113 | 135 |
| JS heap used (MB) | 5.8 | 5.9 | 9.0 | 9.1 |
| uncaught errors | 0 | 0 | 0 | 0 |

| phase (softn: marks, ms) | cold median | cold p90 | warm median | warm p90 |
|---|---:|---:|---:|---:|
| softn:asset-extract | 0 | 0 | 0 | 0 |
| softn:asset-warm | 20 | 23 | 45 | 51 |
| softn:component-preload | 19 | 20 | 9 | 10 |
| softn:compose | 1 | 1 | 0 | 0 |
| softn:offline-install | 279 | 286 | — | — |
| softn:parse | 0 | 1 | 0 | 1 |
| softn:vm-init | 105 | 140 | 49 | 66 |
| softn:xdb-seed | 0 | 0 | 0 | 0 |
| softn:zip | 2 | 2 | 1 | 1 |

| mark (ms from navigation) | cold median | warm median |
|---|---:|---:|
| softn:scene3d-assets-ready | 440 | 86 |
| softn:scene3d-first-frame | 493 | 95 |
| softn:scene3d-renderer-ready | 414 | 67 |

3D module URLs the page or a worker fetched (cold): `/assets/GLTFLoader-DBAV7NEX.js`, `/assets/scene3d-CsGv-ogZ.js`.

<details><summary>Requests, cold pass (representative run: 67 rows)</summary>

| # | context | kind | status | bytes | cache | url |
|---:|---|---|---:|---:|---|---|
| 1 | page | html | 200 | 2.6 KB | network | `/?open=%2Fbench%2Fscene-glb.softn&embed=1` |
| 2 | page | js | 200 | 715.5 KB | network | `/assets/index-DSZmgK9M.js` |
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
| 27 | page | blob | 200 | 0.0 KB | network | `blob:http://127.0.0.1:58187/63326cf5-75cc-4fb4-abf7-09391d8f29a9` |
| 28 | page | js | 200 | 44.8 KB | network | `/assets/GLTFLoader-DBAV7NEX.js` |
| 29 | serviceWorker | js | 200 | 1.9 KB | network | `/coi.js` |
| 30 | page | js | 200 | 0.4 KB | network | `/assets/xdb-N2VKATSB-BwhH368Z.js` |
| 31 | serviceWorker | js | 200 | 0.0 KB | disk | `/assets/zipWorker-DuMQt4DG.js` |
| 32 | serviceWorker | wasm | 200 | 0.0 KB | disk | `/assets/zipp_wasm_bg-DZSXgiaN.wasm` |
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
| 1 | page | html | 200 | 2.6 KB | network | `/?open=%2Fbench%2Fscene-glb.softn&embed=1` |
| 2 | page | js | 200 | 0.0 KB | memory | `/assets/index-DSZmgK9M.js` |
| 3 | page | css | 200 | 0.0 KB | memory | `/assets/index-BdKE3FSy.css` |
| 4 | page | js | 200 | 0.4 KB | network | `/registerSW.js` |
| 5 | page | font | 200 | 0.0 KB | memory | `/assets/bricolage-grotesque-latin-wght-normal-DLoelf7F.woff2` |
| 6 | page | font | 200 | 0.0 KB | memory | `/assets/ibm-plex-sans-latin-400-normal-CDDApCn2.woff2` |
| 7 | page | font | 200 | 0.0 KB | memory | `/assets/ibm-plex-sans-latin-500-normal-6ng42L7E.woff2` |
| 8 | page | font | 200 | 0.0 KB | memory | `/assets/ibm-plex-sans-latin-600-normal-CuJfVYMP.woff2` |
| 9 | page | font | 200 | 0.0 KB | memory | `/assets/ibm-plex-mono-latin-400-normal-DMJ8VG8y.woff2` |
| 10 | page | bundle | 200 | 2.2 KB | network | `/bench/scene-glb.softn` |
| 11 | page | json | 200 | 0.8 KB | network | `/manifest.webmanifest` |
| 12 | page | js | — | 0.0 KB | network | `/assets/zipWorker-DuMQt4DG.js` |
| 13 | page | image | 200 | 0.0 KB | disk | `/pwa-192x192.png` |
| 14 | page | js | 200 | 0.0 KB | memory | `/assets/scene3d-CsGv-ogZ.js` |
| 15 | page | js | 200 | 0.0 KB | memory | `/assets/vendor-three-DRaE6mEZ.js` |
| 16 | page | wasm | 200 | 0.0 KB | disk | `/assets/zipp_wasm_bg-DZSXgiaN.wasm` |
| 17 | page | blob | 200 | 0.0 KB | network | `blob:http://127.0.0.1:58187/46f039a4-19cd-4280-9b30-db501743be27` |
| 18 | page | js | 200 | 0.0 KB | memory | `/assets/GLTFLoader-DBAV7NEX.js` |
| 19 | page | js | 200 | 0.0 KB | memory | `/assets/xdb-N2VKATSB-BwhH368Z.js` |

</details>

### scene-effects — Scene3D with bloom

The scene-glb fixture with bloom on, so the post-processing path is exercised. Bundle: 2.0 KB (logic/main.logic 0.4 KB, manifest.json 0.3 KB, permission.json 0.0 KB, ui/main.ui 1.0 KB, assets/models/tetra.glb 1.1 KB).

- cold: ready 5/5; 3D module URL requested in 5/5; 3D code inside loaded JS in 5/5; WebGL2 available in 5/5 (ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)); service worker controlling 5/5
- warm: ready 5/5; 3D module URL requested in 5/5; 3D code inside loaded JS in 5/5; WebGL2 available in 5/5 (ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)); service worker controlling 0/5

Scripts carrying 3D code (cold): three in `/assets/vendor-three-DRaE6mEZ.js`; gltf in `/assets/GLTFLoader-DBAV7NEX.js`; postprocessing in `/assets/EffectComposer-SOTmTxfr.js`; bloom in `/assets/UnrealBloomPass-CUvuWZpG.js`.

| metric | cold median | cold p90 | warm median | warm p90 |
|---|---:|---:|---:|---:|
| app ready (ms) | 435 | 451 | 156 | 161 |
| first paint (ms) | 270 | 280 | 164 | 178 |
| first contentful paint (ms) | 489 | 499 | 178 | 216 |
| document responseEnd (ms) | 200 | 225 | 6 | 6 |
| DOMContentLoaded (ms) | 254 | 267 | 28 | 28 |
| load event end (ms) | 254 | 267 | 29 | 29 |
| first WebGL context (ms) | 423 | 435 | 149 | 153 |
| first GL draw (ms) | 480 | 502 | 175 | 189 |
| page requests | 27 | 27 | 26 | 26 |
| page bytes on the wire | 6676.2 KB | 6676.2 KB | 6.1 KB | 6.1 KB |
| page bytes loaded (content-length, cached or not) | 6670.0 KB | 6670.0 KB | 6669.5 KB | 6669.5 KB |
| JS bytes | 1397.5 KB | 1397.5 KB | 0.4 KB | 0.4 KB |
| wasm bytes | 5126.1 KB | 5126.1 KB | 0.0 KB | 0.0 KB |
| CSS bytes | 15.6 KB | 15.6 KB | 0.0 KB | 0.0 KB |
| bundle bytes | 2.3 KB | 2.3 KB | 2.3 KB | 2.3 KB |
| requests from HTTP cache | 0 | 0 | 20 | 20 |
| requests from service worker | 0 | 0 | 0 | 0 |
| failed requests | 0 | 0 | 0 | 0 |
| page requests until ready | 27 | 27 | 26 | 26 |
| page bytes until ready | 6676.2 KB | 6676.2 KB | 6.1 KB | 6.1 KB |
| service worker requests | 47 | 47 | 0 | 0 |
| service worker bytes on the wire | 334.3 KB | 334.3 KB | 0.0 KB | 0.0 KB |
| service worker bytes loaded (content-length) | 6343.7 KB | 6343.7 KB | 0.0 KB | 0.0 KB |
| service worker requests from HTTP cache | 9 | 10 | 0 | 0 |
| service worker bytes on the wire until ready | 334.3 KB | 334.3 KB | 0.0 KB | 0.0 KB |
| dedicated worker requests | 0 | 0 | 0 | 0 |
| dedicated worker bytes on the wire | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB |
| dedicated worker bytes loaded (content-length) | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB |
| long tasks | 3 | 5 | 2 | 3 |
| long task total (ms) | 257 | 395 | 230 | 312 |
| longest task (ms) | 120 | 143 | 126 | 138 |
| script time (ms) | 317 | 409 | 265 | 354 |
| main-thread task time (ms) | 489 | 569 | 319 | 435 |
| JS heap used (MB) | 7.0 | 7.3 | 9.4 | 10.1 |
| uncaught errors | 0 | 0 | 0 | 0 |

| phase (softn: marks, ms) | cold median | cold p90 | warm median | warm p90 |
|---|---:|---:|---:|---:|
| softn:asset-extract | 0 | 0 | 0 | 0 |
| softn:asset-warm | 23 | 25 | 127 | 132 |
| softn:component-preload | 19 | 20 | 9 | 12 |
| softn:compose | 1 | 1 | 0 | 0 |
| softn:offline-install | 337 | 357 | — | — |
| softn:parse | 1 | 2 | 1 | 1 |
| softn:vm-init | 297 | 379 | 160 | 287 |
| softn:xdb-seed | 0 | 0 | 0 | 0 |
| softn:zip | 2 | 2 | 1 | 1 |

| mark (ms from navigation) | cold median | warm median |
|---|---:|---:|
| softn:scene3d-assets-ready | 473 | 173 |
| softn:scene3d-first-frame | 632 | 304 |
| softn:scene3d-renderer-ready | 431 | 154 |

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
| 13 | serviceWorker | js | 200 | 0.0 KB | network | `/workbox-63c18b4d.js` |
| 14 | page | image | 200 | 0.7 KB | network | `/favicon.svg` |
| 15 | page | image | 200 | 5.2 KB | network | `/pwa-192x192.png` |
| 16 | serviceWorker | js | 200 | 0.0 KB | network | `/coi.js` |
| 17 | serviceWorker | js | 200 | 0.4 KB | network | `/registerSW.js` |
| 18 | serviceWorker | image | 200 | 8.7 KB | network | `/pwa-maskable-512x512.png` |
| 19 | serviceWorker | image | 200 | 15.0 KB | network | `/pwa-512x512.png` |
| 20 | page | js | — | 0.0 KB | network | `/assets/zipWorker-DuMQt4DG.js` |
| 21 | serviceWorker | image | 200 | 5.2 KB | network | `/pwa-192x192.png` |
| 22 | serviceWorker | html | 200 | 2.6 KB | network | `/index.html` |
| 23 | page | js | 200 | 57.0 KB | network | `/assets/scene3d-CsGv-ogZ.js` |
| 24 | page | js | 200 | 558.4 KB | network | `/assets/vendor-three-DRaE6mEZ.js` |
| 25 | page | wasm | 200 | 5126.1 KB | network | `/assets/zipp_wasm_bg-DZSXgiaN.wasm` |
| 26 | serviceWorker | image | 200 | 0.7 KB | network | `/favicon.svg` |
| 27 | serviceWorker | js | 200 | 1.9 KB | network | `/coi.js` |
| 28 | serviceWorker | js | 200 | 0.0 KB | disk | `/assets/zipWorker-DuMQt4DG.js` |
| 29 | serviceWorker | wasm | 200 | 0.0 KB | disk | `/assets/zipp_wasm_bg-DZSXgiaN.wasm` |
| 30 | page | js | 200 | 4.1 KB | network | `/assets/EffectComposer-SOTmTxfr.js` |
| 31 | page | js | 200 | 0.8 KB | network | `/assets/CopyShader-CHGAmNbz.js` |
| 32 | page | js | 200 | 1.0 KB | network | `/assets/Pass-xoVzREwE.js` |
| 33 | page | js | 200 | 1.2 KB | network | `/assets/ShaderPass-vmutAxOU.js` |
| 34 | page | js | 200 | 1.4 KB | network | `/assets/RenderPass-DMdn9WGj.js` |
| 35 | page | js | 200 | 9.2 KB | network | `/assets/UnrealBloomPass-CUvuWZpG.js` |
| 36 | page | js | 200 | 3.2 KB | network | `/assets/OutputPass-CpHVr2kg.js` |
| 37 | page | blob | 200 | 0.0 KB | network | `blob:http://127.0.0.1:58187/e7b94af5-0b77-4e15-ae7a-cf7e47453684` |
| 38 | page | js | 200 | 44.8 KB | network | `/assets/GLTFLoader-DBAV7NEX.js` |
| 39 | serviceWorker | js | 200 | 0.4 KB | network | `/assets/xdb-N2VKATSB-BwhH368Z.js` |
| 40 | serviceWorker | js | 200 | 0.0 KB | disk | `/assets/index-DSZmgK9M.js` |
| 41 | page | js | 200 | 0.4 KB | network | `/assets/xdb-N2VKATSB-BwhH368Z.js` |
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

<details><summary>Requests, warm pass (representative run: 26 rows)</summary>

| # | context | kind | status | bytes | cache | url |
|---:|---|---|---:|---:|---|---|
| 1 | page | html | 200 | 2.6 KB | network | `/?open=%2Fbench%2Fscene-effects.softn&embed=1` |
| 2 | page | js | 200 | 0.0 KB | memory | `/assets/index-DSZmgK9M.js` |
| 3 | page | css | 200 | 0.0 KB | memory | `/assets/index-BdKE3FSy.css` |
| 4 | page | js | 200 | 0.4 KB | network | `/registerSW.js` |
| 5 | page | font | 200 | 0.0 KB | memory | `/assets/bricolage-grotesque-latin-wght-normal-DLoelf7F.woff2` |
| 6 | page | font | 200 | 0.0 KB | memory | `/assets/ibm-plex-sans-latin-400-normal-CDDApCn2.woff2` |
| 7 | page | font | 200 | 0.0 KB | memory | `/assets/ibm-plex-sans-latin-500-normal-6ng42L7E.woff2` |
| 8 | page | font | 200 | 0.0 KB | memory | `/assets/ibm-plex-sans-latin-600-normal-CuJfVYMP.woff2` |
| 9 | page | font | 200 | 0.0 KB | memory | `/assets/ibm-plex-mono-latin-400-normal-DMJ8VG8y.woff2` |
| 10 | page | bundle | 200 | 2.3 KB | network | `/bench/scene-effects.softn` |
| 11 | page | json | 200 | 0.8 KB | network | `/manifest.webmanifest` |
| 12 | page | js | — | 0.0 KB | network | `/assets/zipWorker-DuMQt4DG.js` |
| 13 | page | image | 200 | 0.0 KB | disk | `/pwa-192x192.png` |
| 14 | page | js | 200 | 0.0 KB | memory | `/assets/scene3d-CsGv-ogZ.js` |
| 15 | page | js | 200 | 0.0 KB | memory | `/assets/vendor-three-DRaE6mEZ.js` |
| 16 | page | wasm | 200 | 0.0 KB | disk | `/assets/zipp_wasm_bg-DZSXgiaN.wasm` |
| 17 | page | js | 200 | 0.0 KB | memory | `/assets/EffectComposer-SOTmTxfr.js` |
| 18 | page | js | 200 | 0.0 KB | memory | `/assets/CopyShader-CHGAmNbz.js` |
| 19 | page | js | 200 | 0.0 KB | memory | `/assets/Pass-xoVzREwE.js` |
| 20 | page | js | 200 | 0.0 KB | memory | `/assets/ShaderPass-vmutAxOU.js` |
| 21 | page | js | 200 | 0.0 KB | memory | `/assets/RenderPass-DMdn9WGj.js` |
| 22 | page | js | 200 | 0.0 KB | memory | `/assets/UnrealBloomPass-CUvuWZpG.js` |
| 23 | page | js | 200 | 0.0 KB | memory | `/assets/OutputPass-CpHVr2kg.js` |
| 24 | page | blob | 200 | 0.0 KB | network | `blob:http://127.0.0.1:58187/212b3780-9474-4445-87af-0a11544fd83e` |
| 25 | page | js | 200 | 0.0 KB | memory | `/assets/GLTFLoader-DBAV7NEX.js` |
| 26 | page | js | 200 | 0.0 KB | memory | `/assets/xdb-N2VKATSB-BwhH368Z.js` |

</details>
