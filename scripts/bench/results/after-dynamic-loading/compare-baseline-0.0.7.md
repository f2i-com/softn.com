# baseline-0.0.7 → after-dynamic-loading

## Host: single

| measurement | git | package | browser | CPU | OS | Node | runs |
|---|---|---|---|---|---|---|---:|
| baseline-0.0.7 | e9fccda (dirty) | 0.0.7 | Edg/152.0.4191.66 | AMD Ryzen 9 9950X3D 16-Core Processor | win32 10.0.26200 | v24.12.0 | 5 |
| after-dynamic-loading | e9fccda (dirty) | 0.0.7 | Edg/152.0.4191.66 | AMD Ryzen 9 9950X3D 16-Core Processor | win32 10.0.26200 | v24.12.0 | 5 |

### minimal — Minimal text and form

#### cold

| runs | baseline-0.0.7 | after-dynamic-loading |
|---|---:|---:|
| ready | 5/5 | 5/5 |
| 3D module URL requested | 0/5 | 0/5 |
| 3D code inside loaded JS | 5/5 | 0/5 |
| service worker controlling | 0/5 | 0/5 |

| metric | baseline-0.0.7 median | after-dynamic-loading median | Δ median | baseline-0.0.7 p90 | after-dynamic-loading p90 | Δ p90 |
|---|---:|---:|---:|---:|---:|---:|
| page requests | 8 | 7 | -1 | 8 | 7 | -1 |
| page bytes on the wire | 6968.1 KB | 5743.2 KB | -1224.9 KB | 6968.1 KB | 5743.2 KB | -1224.9 KB |
| page bytes loaded (content-length, cached or not) | 6965.7 KB | 5741.1 KB | -1224.6 KB | 6965.7 KB | 5741.1 KB | -1224.6 KB |
| JS bytes on the wire | 1836.6 KB | 611.7 KB | -1224.9 KB | 1836.6 KB | 611.7 KB | -1224.9 KB |
| wasm bytes on the wire | 5126.1 KB | 5126.1 KB | 0.0 KB | 5126.1 KB | 5126.1 KB | 0.0 KB |
| CSS bytes on the wire | 1.8 KB | 1.8 KB | 0.0 KB | 1.8 KB | 1.8 KB | 0.0 KB |
| page requests until ready | 8 | 7 | -1 | 8 | 7 | -1 |
| page bytes until ready | 6968.1 KB | 5743.2 KB | -1224.9 KB | 6968.1 KB | 5743.2 KB | -1224.9 KB |
| service worker requests | 0 | 0 | 0 | 0 | 0 | 0 |
| service worker bytes on the wire | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB |
| service worker bytes loaded (content-length) | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB |
| dedicated worker requests | 0 | 0 | 0 | 0 | 0 | 0 |
| long tasks | 0 | 0 | 0 | 0 | 0 | 0 |
| long task total (ms) | 0 | 0 | 0 | 0 | 0 | 0 |
| longest task (ms) | 0 | 0 | 0 | 0 | 0 | 0 |
| app ready (ms) | 325 | 306 | -19 | 347 | 374 | +27 |
| first paint (ms) | 333 | 336 | +3 | 340 | 409 | +69 |
| first contentful paint (ms) | 333 | 336 | +3 | 340 | 409 | +69 |
| document responseEnd (ms) | 241 | 239 | -2 | 261 | 308 | +47 |
| DOMContentLoaded (ms) | 293 | 273 | -19 | 313 | 341 | +28 |
| load event end (ms) | 293 | 273 | -19 | 313 | 341 | +28 |
| script time (ms) | 31 | 19 | -12 | 33 | 19 | -14 |
| main-thread task time (ms) | 119 | 107 | -12 | 122 | 109 | -13 |
| JS heap used (MB) | 5.0 | 3.1 | -1.8 | 5.0 | 3.2 | -1.8 |
| uncaught errors | 0 | 0 | 0 | 0 | 0 | 0 |

| phase (softn: marks, ms) | baseline-0.0.7 median | after-dynamic-loading median | Δ median | baseline-0.0.7 p90 | after-dynamic-loading p90 | Δ p90 |
|---|---:|---:|---:|---:|---:|---:|
| softn:bundle-fetch | 4 | 5 | +1 | 6 | 9 | +3 |
| softn:compose | 1 | 1 | 0 | 1 | 1 | 0 |
| softn:digest | 0 | 0 | +0 | 0 | 0 | +0 |
| softn:parse | 1 | 1 | 0 | 1 | 1 | 0 |
| softn:vm-init | 74 | 73 | 0 | 84 | 85 | +1 |
| softn:xdb-seed | 1 | 1 | +0 | 1 | 1 | 0 |
| softn:zip | 1 | 1 | +0 | 1 | 1 | +0 |

Phases measured only in after-dynamic-loading: softn:component-preload 2 ms (p90 2).

**Nothing worse in after-dynamic-loading (cold) beyond noise.**

#### warm

| runs | baseline-0.0.7 | after-dynamic-loading |
|---|---:|---:|
| ready | 5/5 | 5/5 |
| 3D module URL requested | 0/5 | 0/5 |
| 3D code inside loaded JS | 5/5 | 0/5 |
| service worker controlling | 0/5 | 0/5 |

| metric | baseline-0.0.7 median | after-dynamic-loading median | Δ median | baseline-0.0.7 p90 | after-dynamic-loading p90 | Δ p90 |
|---|---:|---:|---:|---:|---:|---:|
| page requests | 8 | 7 | -1 | 8 | 7 | -1 |
| page bytes on the wire | 3.6 KB | 3.6 KB | 0.0 KB | 3.6 KB | 3.6 KB | 0.0 KB |
| page bytes loaded (content-length, cached or not) | 6965.7 KB | 5741.1 KB | -1224.6 KB | 6965.7 KB | 5741.1 KB | -1224.6 KB |
| JS bytes on the wire | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB |
| wasm bytes on the wire | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB |
| CSS bytes on the wire | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB |
| page requests until ready | 8 | 7 | -1 | 8 | 7 | -1 |
| page bytes until ready | 3.6 KB | 3.6 KB | 0.0 KB | 3.6 KB | 3.6 KB | 0.0 KB |
| service worker requests | 0 | 0 | 0 | 0 | 0 | 0 |
| service worker bytes on the wire | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB |
| service worker bytes loaded (content-length) | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB |
| dedicated worker requests | 0 | 0 | 0 | 0 | 0 | 0 |
| long tasks | 0 | 0 | 0 | 0 | 0 | 0 |
| long task total (ms) | 0 | 0 | 0 | 0 | 0 | 0 |
| longest task (ms) | 0 | 0 | 0 | 0 | 0 | 0 |
| app ready (ms) | 37 | 32 | -5 | 53 | 47 | -6 |
| first paint (ms) | 66 | 72 | +6 | 128 | 91 | -36 |
| first contentful paint (ms) | 66 | 72 | +6 | 128 | 91 | -36 |
| document responseEnd (ms) | 4 | 5 | +0 | 5 | 6 | +1 |
| DOMContentLoaded (ms) | 21 | 19 | -2 | 37 | 36 | -1 |
| load event end (ms) | 22 | 20 | -2 | 37 | 36 | -1 |
| script time (ms) | 11 | 8 | -3 | 12 | 8 | -3 |
| main-thread task time (ms) | 51 | 44 | -8 | 67 | 59 | -7 |
| JS heap used (MB) | 7.0 | 4.6 | -2.4 | 7.0 | 4.7 | -2.4 |
| uncaught errors | 0 | 0 | 0 | 0 | 0 | 0 |

| phase (softn: marks, ms) | baseline-0.0.7 median | after-dynamic-loading median | Δ median | baseline-0.0.7 p90 | after-dynamic-loading p90 | Δ p90 |
|---|---:|---:|---:|---:|---:|---:|
| softn:bundle-fetch | 2 | 2 | 0 | 2 | 2 | +0 |
| softn:compose | 0 | 0 | 0 | 0 | 0 | +0 |
| softn:digest | 0 | 0 | +0 | 0 | 0 | 0 |
| softn:parse | 0 | 0 | 0 | 0 | 0 | 0 |
| softn:vm-init | 19 | 17 | -1 | 19 | 18 | -1 |
| softn:xdb-seed | 0 | 0 | 0 | 0 | 0 | 0 |
| softn:zip | 0 | 0 | +0 | 1 | 1 | +0 |

Phases measured only in after-dynamic-loading: softn:component-preload 2 ms (p90 2).

**Worse in after-dynamic-loading (warm):** first paint (ms): 66 → 72 (+6); first contentful paint (ms): 66 → 72 (+6).

### scene-glb — Scene3D with one bundled GLB

#### cold

| runs | baseline-0.0.7 | after-dynamic-loading |
|---|---:|---:|
| ready | 5/5 | 5/5 |
| 3D module URL requested | 0/5 | 5/5 |
| 3D code inside loaded JS | 5/5 | 5/5 |
| service worker controlling | 0/5 | 0/5 |

| metric | baseline-0.0.7 median | after-dynamic-loading median | Δ median | baseline-0.0.7 p90 | after-dynamic-loading p90 | Δ p90 |
|---|---:|---:|---:|---:|---:|---:|
| page requests | 9 | 12 | +3 | 9 | 12 | +3 |
| page bytes on the wire | 6968.9 KB | 6403.9 KB | -565.0 KB | 6968.9 KB | 6403.9 KB | -565.0 KB |
| page bytes loaded (content-length, cached or not) | 6967.6 KB | 6402.0 KB | -565.6 KB | 6967.6 KB | 6402.0 KB | -565.6 KB |
| JS bytes on the wire | 1836.6 KB | 1271.6 KB | -565.0 KB | 1836.6 KB | 1271.6 KB | -565.0 KB |
| wasm bytes on the wire | 5126.1 KB | 5126.1 KB | 0.0 KB | 5126.1 KB | 5126.1 KB | 0.0 KB |
| CSS bytes on the wire | 1.8 KB | 1.8 KB | 0.0 KB | 1.8 KB | 1.8 KB | 0.0 KB |
| page requests until ready | 9 | 12 | +3 | 9 | 12 | +3 |
| page bytes until ready | 6968.9 KB | 6403.9 KB | -565.0 KB | 6968.9 KB | 6403.9 KB | -565.0 KB |
| service worker requests | 0 | 0 | 0 | 0 | 0 | 0 |
| service worker bytes on the wire | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB |
| service worker bytes loaded (content-length) | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB |
| dedicated worker requests | 0 | 0 | 0 | 0 | 0 | 0 |
| long tasks | 0 | 0 | 0 | 0 | 0 | 0 |
| long task total (ms) | 0 | 0 | 0 | 0 | 0 | 0 |
| longest task (ms) | 0 | 0 | 0 | 0 | 0 | 0 |
| app ready (ms) | 341 | 342 | +1 | 351 | 356 | +5 |
| first paint (ms) | 339 | 336 | -3 | 349 | 339 | -10 |
| first contentful paint (ms) | 339 | 336 | -3 | 349 | 339 | -10 |
| document responseEnd (ms) | 244 | 235 | -9 | 247 | 240 | -7 |
| DOMContentLoaded (ms) | 293 | 266 | -27 | 303 | 272 | -31 |
| load event end (ms) | 293 | 266 | -27 | 303 | 273 | -31 |
| first WebGL context (ms) | 331 | 333 | +1 | 341 | 348 | +6 |
| first GL draw (ms) | 380 | 381 | +1 | 403 | 425 | +22 |
| script time (ms) | 86 | 102 | +17 | 93 | 104 | +11 |
| main-thread task time (ms) | 188 | 202 | +15 | 191 | 205 | +14 |
| JS heap used (MB) | 6.2 | 4.9 | -1.2 | 6.4 | 6.3 | -0.1 |
| uncaught errors | 0 | 0 | 0 | 0 | 0 | 0 |

| phase (softn: marks, ms) | baseline-0.0.7 median | after-dynamic-loading median | Δ median | baseline-0.0.7 p90 | after-dynamic-loading p90 | Δ p90 |
|---|---:|---:|---:|---:|---:|---:|
| softn:bundle-fetch | 6 | 6 | 0 | 7 | 9 | +2 |
| softn:compose | 1 | 1 | 0 | 1 | 1 | 0 |
| softn:digest | 0 | 0 | 0 | 0 | 0 | 0 |
| softn:parse | 1 | 1 | +0 | 2 | 1 | 0 |
| softn:vm-init | 105 | 111 | +6 | 114 | 128 | +15 |
| softn:xdb-seed | 1 | 1 | 0 | 1 | 1 | 0 |
| softn:zip | 1 | 1 | +0 | 1 | 1 | 0 |

Phases measured only in after-dynamic-loading: softn:asset-extract 0 ms (p90 0); softn:asset-warm 18 ms (p90 63); softn:component-preload 20 ms (p90 22).

Points in time in after-dynamic-loading (ms from navigation, median): softn:scene3d-assets-ready 372; softn:scene3d-first-frame 391; softn:scene3d-renderer-ready 340.

3D module URLs requested in after-dynamic-loading: `/s/scene-glb/assets/GLTFLoader-CGDVEtfg.js`, `/s/scene-glb/assets/scene3d-WNubQ0uA.js`.

Scripts carrying 3D code in after-dynamic-loading: three in `/s/scene-glb/assets/vendor-three-CH15DcEN.js`; gltf in `/s/scene-glb/assets/GLTFLoader-CGDVEtfg.js`.

**Worse in after-dynamic-loading (cold):** page requests: 9 → 12 (+3); page requests until ready: 9 → 12 (+3); script time (ms): 86 → 102 (+17); main-thread task time (ms): 188 → 202 (+15); softn:vm-init: 105 → 111 ms (+6); 3D module URL requested in 5/5 runs, was 0/5 — expected: this scenario asks for a scene, and the 3D code is now a separate chunk it has to request.

#### warm

| runs | baseline-0.0.7 | after-dynamic-loading |
|---|---:|---:|
| ready | 5/5 | 5/5 |
| 3D module URL requested | 0/5 | 5/5 |
| 3D code inside loaded JS | 5/5 | 5/5 |
| service worker controlling | 0/5 | 0/5 |

| metric | baseline-0.0.7 median | after-dynamic-loading median | Δ median | baseline-0.0.7 p90 | after-dynamic-loading p90 | Δ p90 |
|---|---:|---:|---:|---:|---:|---:|
| page requests | 9 | 12 | +3 | 9 | 12 | +3 |
| page bytes on the wire | 4.4 KB | 4.4 KB | 0.0 KB | 4.4 KB | 4.4 KB | 0.0 KB |
| page bytes loaded (content-length, cached or not) | 6967.6 KB | 6402.0 KB | -565.6 KB | 6967.6 KB | 6402.0 KB | -565.6 KB |
| JS bytes on the wire | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB |
| wasm bytes on the wire | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB |
| CSS bytes on the wire | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB |
| page requests until ready | 9 | 12 | +3 | 9 | 12 | +3 |
| page bytes until ready | 4.4 KB | 4.4 KB | 0.0 KB | 4.4 KB | 4.4 KB | 0.0 KB |
| service worker requests | 0 | 0 | 0 | 0 | 0 | 0 |
| service worker bytes on the wire | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB |
| service worker bytes loaded (content-length) | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB |
| dedicated worker requests | 0 | 0 | 0 | 0 | 0 | 0 |
| long tasks | 0 | 0 | 0 | 0 | 0 | 0 |
| long task total (ms) | 0 | 0 | 0 | 0 | 0 | 0 |
| longest task (ms) | 0 | 0 | 0 | 0 | 0 | 0 |
| app ready (ms) | 56 | 69 | +13 | 68 | 93 | +25 |
| first paint (ms) | 62 | 78 | +16 | 79 | 98 | +19 |
| first contentful paint (ms) | 62 | 78 | +16 | 79 | 98 | +19 |
| document responseEnd (ms) | 5 | 5 | +0 | 5 | 6 | +1 |
| DOMContentLoaded (ms) | 25 | 22 | -3 | 26 | 40 | +14 |
| load event end (ms) | 26 | 22 | -3 | 26 | 40 | +14 |
| first WebGL context (ms) | 51 | 63 | +11 | 62 | 85 | +22 |
| first GL draw (ms) | 83 | 105 | +22 | 96 | 134 | +38 |
| script time (ms) | 41 | 49 | +8 | 52 | 58 | +6 |
| main-thread task time (ms) | 95 | 113 | +18 | 106 | 140 | +35 |
| JS heap used (MB) | 9.7 | 7.7 | -2.0 | 10.4 | 9.0 | -1.4 |
| uncaught errors | 0 | 0 | 0 | 0 | 0 | 0 |

| phase (softn: marks, ms) | baseline-0.0.7 median | after-dynamic-loading median | Δ median | baseline-0.0.7 p90 | after-dynamic-loading p90 | Δ p90 |
|---|---:|---:|---:|---:|---:|---:|
| softn:bundle-fetch | 2 | 3 | +1 | 2 | 3 | +1 |
| softn:compose | 0 | 0 | +0 | 0 | 0 | +0 |
| softn:digest | 0 | 0 | +0 | 0 | 0 | +0 |
| softn:parse | 0 | 1 | +0 | 0 | 1 | +0 |
| softn:vm-init | 41 | 47 | +6 | 47 | 58 | +11 |
| softn:xdb-seed | 0 | 0 | 0 | 0 | 0 | +0 |
| softn:zip | 1 | 1 | +0 | 1 | 1 | +0 |

Phases measured only in after-dynamic-loading: softn:asset-extract 0 ms (p90 0); softn:asset-warm 41 ms (p90 54); softn:component-preload 7 ms (p90 9).

Points in time in after-dynamic-loading (ms from navigation, median): softn:scene3d-assets-ready 80; softn:scene3d-first-frame 106; softn:scene3d-renderer-ready 68.

3D module URLs requested in after-dynamic-loading: `/s/scene-glb/assets/GLTFLoader-CGDVEtfg.js`, `/s/scene-glb/assets/scene3d-WNubQ0uA.js`.

Scripts carrying 3D code in after-dynamic-loading: three in `/s/scene-glb/assets/vendor-three-CH15DcEN.js`; gltf in `/s/scene-glb/assets/GLTFLoader-CGDVEtfg.js`.

**Worse in after-dynamic-loading (warm):** page requests: 9 → 12 (+3); page requests until ready: 9 → 12 (+3); app ready (ms): 56 → 69 (+13); first paint (ms): 62 → 78 (+16); first contentful paint (ms): 62 → 78 (+16); first WebGL context (ms): 51 → 63 (+11); first GL draw (ms): 83 → 105 (+22); script time (ms): 41 → 49 (+8); main-thread task time (ms): 95 → 113 (+18); softn:vm-init: 41 → 47 ms (+6); 3D module URL requested in 5/5 runs, was 0/5 — expected: this scenario asks for a scene, and the 3D code is now a separate chunk it has to request.

### scene-effects — Scene3D with bloom

#### cold

| runs | baseline-0.0.7 | after-dynamic-loading |
|---|---:|---:|
| ready | 5/5 | 5/5 |
| 3D module URL requested | 0/5 | 5/5 |
| 3D code inside loaded JS | 5/5 | 5/5 |
| service worker controlling | 0/5 | 0/5 |

| metric | baseline-0.0.7 median | after-dynamic-loading median | Δ median | baseline-0.0.7 p90 | after-dynamic-loading p90 | Δ p90 |
|---|---:|---:|---:|---:|---:|---:|
| page requests | 9 | 19 | +10 | 9 | 19 | +10 |
| page bytes on the wire | 6969.0 KB | 6424.5 KB | -544.4 KB | 6969.0 KB | 6424.5 KB | -544.4 KB |
| page bytes loaded (content-length, cached or not) | 6967.7 KB | 6420.5 KB | -547.1 KB | 6967.7 KB | 6420.5 KB | -547.1 KB |
| JS bytes on the wire | 1836.6 KB | 1292.2 KB | -544.4 KB | 1836.6 KB | 1292.2 KB | -544.4 KB |
| wasm bytes on the wire | 5126.1 KB | 5126.1 KB | 0.0 KB | 5126.1 KB | 5126.1 KB | 0.0 KB |
| CSS bytes on the wire | 1.8 KB | 1.8 KB | 0.0 KB | 1.8 KB | 1.8 KB | 0.0 KB |
| page requests until ready | 9 | 19 | +10 | 9 | 19 | +10 |
| page bytes until ready | 6969.0 KB | 6424.5 KB | -544.4 KB | 6969.0 KB | 6424.5 KB | -544.4 KB |
| service worker requests | 0 | 0 | 0 | 0 | 0 | 0 |
| service worker bytes on the wire | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB |
| service worker bytes loaded (content-length) | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB |
| dedicated worker requests | 0 | 0 | 0 | 0 | 0 | 0 |
| long tasks | 2 | 2 | 0 | 3 | 2 | -1 |
| long task total (ms) | 203 | 133 | -70 | 257 | 176 | -81 |
| longest task (ms) | 113 | 114 | +1 | 123 | 121 | -2 |
| app ready (ms) | 361 | 322 | -39 | 417 | 346 | -71 |
| first paint (ms) | 330 | 315 | -15 | 341 | 338 | -3 |
| first contentful paint (ms) | 330 | 315 | -15 | 341 | 338 | -3 |
| document responseEnd (ms) | 231 | 214 | -17 | 236 | 248 | +12 |
| DOMContentLoaded (ms) | 286 | 247 | -39 | 293 | 280 | -13 |
| load event end (ms) | 287 | 247 | -39 | 293 | 280 | -13 |
| first WebGL context (ms) | 323 | 311 | -12 | 327 | 337 | +10 |
| first GL draw (ms) | 337 | 380 | +43 | 340 | 401 | +61 |
| script time (ms) | 349 | 208 | -141 | 354 | 248 | -105 |
| main-thread task time (ms) | 469 | 345 | -124 | 476 | 368 | -109 |
| JS heap used (MB) | 7.5 | 6.5 | -1.0 | 7.6 | 6.7 | -0.9 |
| uncaught errors | 0 | 0 | 0 | 0 | 0 | 0 |

| phase (softn: marks, ms) | baseline-0.0.7 median | after-dynamic-loading median | Δ median | baseline-0.0.7 p90 | after-dynamic-loading p90 | Δ p90 |
|---|---:|---:|---:|---:|---:|---:|
| softn:bundle-fetch | 4 | 7 | +2 | 7 | 7 | 0 |
| softn:compose | 1 | 1 | 0 | 1 | 1 | 0 |
| softn:digest | 0 | 0 | 0 | 0 | 0 | +0 |
| softn:parse | 1 | 1 | +0 | 1 | 2 | +0 |
| softn:vm-init | 303 | 97 | -206 | 321 | 150 | -170 |
| softn:xdb-seed | 1 | 1 | 0 | 1 | 1 | 0 |
| softn:zip | 1 | 1 | +0 | 1 | 1 | +0 |

Phases measured only in after-dynamic-loading: softn:asset-extract 0 ms (p90 0); softn:asset-warm 23 ms (p90 25); softn:component-preload 21 ms (p90 23).

Points in time in after-dynamic-loading (ms from navigation, median): softn:scene3d-assets-ready 383; softn:scene3d-first-frame 490; softn:scene3d-renderer-ready 319.

3D module URLs requested in after-dynamic-loading: `/s/scene-effects/assets/GLTFLoader-CGDVEtfg.js`, `/s/scene-effects/assets/UnrealBloomPass-Ceb1K-D4.js`, `/s/scene-effects/assets/scene3d-WNubQ0uA.js`.

Scripts carrying 3D code in after-dynamic-loading: three in `/s/scene-effects/assets/vendor-three-CH15DcEN.js`; gltf in `/s/scene-effects/assets/GLTFLoader-CGDVEtfg.js`; postprocessing in `/s/scene-effects/assets/EffectComposer-Bb3GwojG.js`; bloom in `/s/scene-effects/assets/UnrealBloomPass-Ceb1K-D4.js`.

**Worse in after-dynamic-loading (cold):** page requests: 9 → 19 (+10); page requests until ready: 9 → 19 (+10); first GL draw (ms): 337 → 380 (+43); 3D module URL requested in 5/5 runs, was 0/5 — expected: this scenario asks for a scene, and the 3D code is now a separate chunk it has to request.

#### warm

| runs | baseline-0.0.7 | after-dynamic-loading |
|---|---:|---:|
| ready | 5/5 | 5/5 |
| 3D module URL requested | 0/5 | 5/5 |
| 3D code inside loaded JS | 5/5 | 5/5 |
| service worker controlling | 0/5 | 0/5 |

| metric | baseline-0.0.7 median | after-dynamic-loading median | Δ median | baseline-0.0.7 p90 | after-dynamic-loading p90 | Δ p90 |
|---|---:|---:|---:|---:|---:|---:|
| page requests | 9 | 19 | +10 | 9 | 19 | +10 |
| page bytes on the wire | 4.5 KB | 4.5 KB | 0.0 KB | 4.5 KB | 4.5 KB | 0.0 KB |
| page bytes loaded (content-length, cached or not) | 6967.7 KB | 6420.5 KB | -547.1 KB | 6967.7 KB | 6420.5 KB | -547.1 KB |
| JS bytes on the wire | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB |
| wasm bytes on the wire | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB |
| CSS bytes on the wire | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB |
| page requests until ready | 9 | 19 | +10 | 9 | 19 | +10 |
| page bytes until ready | 4.5 KB | 4.5 KB | 0.0 KB | 4.5 KB | 4.5 KB | 0.0 KB |
| service worker requests | 0 | 0 | 0 | 0 | 0 | 0 |
| service worker bytes on the wire | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB |
| service worker bytes loaded (content-length) | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB |
| dedicated worker requests | 0 | 0 | 0 | 0 | 0 | 0 |
| long tasks | 3 | 1 | -2 | 3 | 2 | -1 |
| long task total (ms) | 209 | 141 | -68 | 233 | 191 | -42 |
| longest task (ms) | 93 | 112 | +19 | 111 | 141 | +30 |
| app ready (ms) | 238 | 193 | -45 | 267 | 200 | -67 |
| first paint (ms) | 257 | 214 | -42 | 303 | 237 | -66 |
| first contentful paint (ms) | 257 | 214 | -42 | 303 | 237 | -66 |
| document responseEnd (ms) | 5 | 5 | +0 | 5 | 6 | +1 |
| DOMContentLoaded (ms) | 143 | 153 | +10 | 144 | 163 | +19 |
| load event end (ms) | 143 | 153 | +10 | 144 | 163 | +19 |
| first WebGL context (ms) | 162 | 186 | +24 | 165 | 193 | +29 |
| first GL draw (ms) | 168 | 218 | +50 | 171 | 229 | +58 |
| script time (ms) | 280 | 181 | -99 | 297 | 244 | -53 |
| main-thread task time (ms) | 594 | 459 | -135 | 613 | 565 | -48 |
| JS heap used (MB) | 9.8 | 9.3 | -0.5 | 9.9 | 10.3 | +0.5 |
| uncaught errors | 0 | 0 | 0 | 0 | 0 | 0 |

| phase (softn: marks, ms) | baseline-0.0.7 median | after-dynamic-loading median | Δ median | baseline-0.0.7 p90 | after-dynamic-loading p90 | Δ p90 |
|---|---:|---:|---:|---:|---:|---:|
| softn:bundle-fetch | 2 | 2 | +0 | 2 | 2 | +0 |
| softn:compose | 0 | 0 | +0 | 0 | 0 | +0 |
| softn:digest | 0 | 0 | +0 | 0 | 0 | +0 |
| softn:parse | 0 | 1 | +0 | 1 | 1 | +0 |
| softn:vm-init | 235 | 47 | -187 | 246 | 185 | -60 |
| softn:xdb-seed | 0 | 0 | +0 | 0 | 0 | 0 |
| softn:zip | 1 | 1 | +0 | 1 | 1 | +0 |

Phases measured only in after-dynamic-loading: softn:asset-extract 0 ms (p90 0); softn:asset-warm 40 ms (p90 48); softn:component-preload 7 ms (p90 8).

Points in time in after-dynamic-loading (ms from navigation, median): softn:scene3d-assets-ready 208; softn:scene3d-first-frame 334; softn:scene3d-renderer-ready 191.

3D module URLs requested in after-dynamic-loading: `/s/scene-effects/assets/GLTFLoader-CGDVEtfg.js`, `/s/scene-effects/assets/UnrealBloomPass-Ceb1K-D4.js`, `/s/scene-effects/assets/scene3d-WNubQ0uA.js`.

Scripts carrying 3D code in after-dynamic-loading: three in `/s/scene-effects/assets/vendor-three-CH15DcEN.js`; gltf in `/s/scene-effects/assets/GLTFLoader-CGDVEtfg.js`; postprocessing in `/s/scene-effects/assets/EffectComposer-Bb3GwojG.js`; bloom in `/s/scene-effects/assets/UnrealBloomPass-Ceb1K-D4.js`.

**Worse in after-dynamic-loading (warm):** page requests: 9 → 19 (+10); page requests until ready: 9 → 19 (+10); longest task (ms): 93 → 112 (+19); DOMContentLoaded (ms): 143 → 153 (+10); load event end (ms): 143 → 153 (+10); first WebGL context (ms): 162 → 186 (+24); first GL draw (ms): 168 → 218 (+50); 3D module URL requested in 5/5 runs, was 0/5 — expected: this scenario asks for a scene, and the 3D code is now a separate chunk it has to request.

## Host: web

| measurement | git | package | browser | CPU | OS | Node | runs |
|---|---|---|---|---|---|---|---:|
| baseline-0.0.7 | e9fccda (dirty) | 0.0.7 | Edg/152.0.4191.66 | AMD Ryzen 9 9950X3D 16-Core Processor | win32 10.0.26200 | v24.12.0 | 5 |
| after-dynamic-loading | e9fccda (dirty) | 0.0.7 | Edg/152.0.4191.66 | AMD Ryzen 9 9950X3D 16-Core Processor | win32 10.0.26200 | v24.12.0 | 5 |

### minimal — Minimal text and form

#### cold

| runs | baseline-0.0.7 | after-dynamic-loading |
|---|---:|---:|
| ready | 5/5 | 5/5 |
| 3D module URL requested | 0/5 | 0/5 |
| 3D code inside loaded JS | 5/5 | 0/5 |
| service worker controlling | 5/5 | 5/5 |

| metric | baseline-0.0.7 median | after-dynamic-loading median | Δ median | baseline-0.0.7 p90 | after-dynamic-loading p90 | Δ p90 |
|---|---:|---:|---:|---:|---:|---:|
| page requests | 16 | 15 | -1 | 16 | 15 | -1 |
| page bytes on the wire | 7212.8 KB | 5994.3 KB | -1218.5 KB | 7212.8 KB | 5994.3 KB | -1218.5 KB |
| page bytes loaded (content-length, cached or not) | 7208.1 KB | 5989.9 KB | -1218.2 KB | 7208.1 KB | 5989.9 KB | -1218.2 KB |
| JS bytes on the wire | 1934.8 KB | 716.3 KB | -1218.5 KB | 1934.8 KB | 716.3 KB | -1218.5 KB |
| wasm bytes on the wire | 5126.1 KB | 5126.1 KB | 0.0 KB | 5126.1 KB | 5126.1 KB | 0.0 KB |
| CSS bytes on the wire | 15.6 KB | 15.6 KB | 0.0 KB | 15.6 KB | 15.6 KB | 0.0 KB |
| page requests until ready | 16 | 15 | -1 | 16 | 15 | -1 |
| page bytes until ready | 7212.8 KB | 5994.3 KB | -1218.5 KB | 7212.8 KB | 5994.3 KB | -1218.5 KB |
| service worker requests | 54 | 47 | -7 | 54 | 47 | -7 |
| service worker bytes on the wire | 1293.9 KB | 344.8 KB | -949.0 KB | 1293.9 KB | 344.8 KB | -949.0 KB |
| service worker bytes loaded (content-length) | 8508.2 KB | 6343.7 KB | -2164.5 KB | 8508.2 KB | 6343.7 KB | -2164.5 KB |
| dedicated worker requests | 0 | 0 | 0 | 0 | 0 | 0 |
| long tasks | 0 | 0 | 0 | 0 | 0 | 0 |
| long task total (ms) | 0 | 0 | 0 | 0 | 0 | 0 |
| longest task (ms) | 0 | 0 | 0 | 0 | 0 | 0 |
| app ready (ms) | 377 | 398 | +21 | 412 | 447 | +35 |
| first paint (ms) | 298 | 306 | +8 | 319 | 364 | +45 |
| first contentful paint (ms) | 554 | 539 | -15 | 579 | 614 | +35 |
| document responseEnd (ms) | 221 | 223 | +2 | 248 | 279 | +31 |
| DOMContentLoaded (ms) | 278 | 263 | -15 | 308 | 328 | +20 |
| load event end (ms) | 278 | 264 | -14 | 308 | 329 | +20 |
| script time (ms) | 39 | 31 | -8 | 41 | 33 | -8 |
| main-thread task time (ms) | 147 | 143 | -4 | 151 | 149 | -3 |
| JS heap used (MB) | 5.9 | 3.9 | -2.1 | 6.0 | 3.9 | -2.1 |
| uncaught errors | 0 | 0 | 0 | 0 | 0 | 0 |

| phase (softn: marks, ms) | baseline-0.0.7 median | after-dynamic-loading median | Δ median | baseline-0.0.7 p90 | after-dynamic-loading p90 | Δ p90 |
|---|---:|---:|---:|---:|---:|---:|
| softn:compose | 1 | 1 | +0 | 1 | 1 | +0 |
| softn:parse | 1 | 0 | -1 | 1 | 0 | -1 |
| softn:vm-init | 88 | 85 | -3 | 110 | 123 | +12 |
| softn:xdb-seed | 0 | 0 | +0 | 0 | 0 | +0 |
| softn:zip | 1 | 2 | +0 | 2 | 2 | +0 |

Phases measured only in after-dynamic-loading: softn:component-preload 3 ms (p90 3); softn:offline-install 278 ms (p90 303).

**Worse in after-dynamic-loading (cold):** app ready (ms): 377 → 398 (+21).

#### warm

| runs | baseline-0.0.7 | after-dynamic-loading |
|---|---:|---:|
| ready | 5/5 | 5/5 |
| 3D module URL requested | 0/5 | 0/5 |
| 3D code inside loaded JS | 5/5 | 0/5 |
| service worker controlling | 5/5 | 5/5 |

| metric | baseline-0.0.7 median | after-dynamic-loading median | Δ median | baseline-0.0.7 p90 | after-dynamic-loading p90 | Δ p90 |
|---|---:|---:|---:|---:|---:|---:|
| page requests | 10 | 9 | -1 | 10 | 9 | -1 |
| page bytes on the wire | 1.4 KB | 1.4 KB | 0.0 KB | 1.4 KB | 1.4 KB | 0.0 KB |
| page bytes loaded (content-length, cached or not) | 7083.6 KB | 5865.4 KB | -1218.2 KB | 7083.6 KB | 5865.4 KB | -1218.2 KB |
| JS bytes on the wire | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB |
| wasm bytes on the wire | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB |
| CSS bytes on the wire | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB |
| page requests until ready | 10 | 9 | -1 | 10 | 9 | -1 |
| page bytes until ready | 1.4 KB | 1.4 KB | 0.0 KB | 1.4 KB | 1.4 KB | 0.0 KB |
| service worker requests | 1 | 1 | 0 | 1 | 1 | 0 |
| service worker bytes on the wire | 2.6 KB | 2.6 KB | 0.0 KB | 2.6 KB | 2.6 KB | 0.0 KB |
| service worker bytes loaded (content-length) | 2.3 KB | 2.3 KB | 0.0 KB | 2.3 KB | 2.3 KB | 0.0 KB |
| dedicated worker requests | 0 | 0 | 0 | 0 | 0 | 0 |
| long tasks | 0 | 0 | 0 | 0 | 0 | 0 |
| long task total (ms) | 0 | 0 | 0 | 0 | 0 | 0 |
| longest task (ms) | 0 | 0 | 0 | 0 | 0 | 0 |
| app ready (ms) | 63 | 51 | -12 | 63 | 54 | -9 |
| first paint (ms) | 46 | 64 | +18 | 74 | 70 | -5 |
| first contentful paint (ms) | 140 | 96 | -44 | 170 | 163 | -6 |
| document responseEnd (ms) | 11 | 14 | +3 | 12 | 15 | +3 |
| DOMContentLoaded (ms) | 44 | 32 | -12 | 45 | 36 | -9 |
| load event end (ms) | 44 | 32 | -12 | 46 | 36 | -9 |
| script time (ms) | 14 | 12 | -2 | 14 | 15 | +1 |
| main-thread task time (ms) | 51 | 48 | -3 | 52 | 55 | +2 |
| JS heap used (MB) | 8.3 | 5.1 | -3.2 | 8.3 | 5.1 | -3.2 |
| uncaught errors | 0 | 0 | 0 | 0 | 0 | 0 |

| phase (softn: marks, ms) | baseline-0.0.7 median | after-dynamic-loading median | Δ median | baseline-0.0.7 p90 | after-dynamic-loading p90 | Δ p90 |
|---|---:|---:|---:|---:|---:|---:|
| softn:compose | 0 | 0 | +0 | 0 | 0 | +0 |
| softn:parse | 0 | 0 | +0 | 0 | 0 | +0 |
| softn:vm-init | 17 | 18 | +1 | 18 | 22 | +5 |
| softn:xdb-seed | 0 | 0 | 0 | 0 | 0 | 0 |
| softn:zip | 2 | 1 | 0 | 2 | 1 | 0 |

Phases measured only in after-dynamic-loading: softn:component-preload 2 ms (p90 3).

**Worse in after-dynamic-loading (warm):** first paint (ms): 46 → 64 (+18).

### scene-glb — Scene3D with one bundled GLB

#### cold

| runs | baseline-0.0.7 | after-dynamic-loading |
|---|---:|---:|
| ready | 5/5 | 5/5 |
| 3D module URL requested | 0/5 | 5/5 |
| 3D code inside loaded JS | 5/5 | 5/5 |
| service worker controlling | 5/5 | 5/5 |

| metric | baseline-0.0.7 median | after-dynamic-loading median | Δ median | baseline-0.0.7 p90 | after-dynamic-loading p90 | Δ p90 |
|---|---:|---:|---:|---:|---:|---:|
| page requests | 17 | 20 | +3 | 17 | 20 | +3 |
| page bytes on the wire | 7213.6 KB | 6655.2 KB | -558.3 KB | 7213.6 KB | 6655.2 KB | -558.3 KB |
| page bytes loaded (content-length, cached or not) | 7210.0 KB | 6651.1 KB | -558.9 KB | 7210.0 KB | 6651.1 KB | -558.9 KB |
| JS bytes on the wire | 1934.8 KB | 1376.5 KB | -558.3 KB | 1934.8 KB | 1376.5 KB | -558.3 KB |
| wasm bytes on the wire | 5126.1 KB | 5126.1 KB | 0.0 KB | 5126.1 KB | 5126.1 KB | 0.0 KB |
| CSS bytes on the wire | 15.6 KB | 15.6 KB | 0.0 KB | 15.6 KB | 15.6 KB | 0.0 KB |
| page requests until ready | 17 | 20 | +3 | 17 | 20 | +3 |
| page bytes until ready | 7213.6 KB | 6655.2 KB | -558.3 KB | 7213.6 KB | 6655.2 KB | -558.3 KB |
| service worker requests | 54 | 47 | -7 | 54 | 47 | -7 |
| service worker bytes on the wire | 1293.9 KB | 334.3 KB | -959.6 KB | 1293.9 KB | 334.3 KB | -959.6 KB |
| service worker bytes loaded (content-length) | 8508.2 KB | 6343.7 KB | -2164.5 KB | 8508.2 KB | 6343.7 KB | -2164.5 KB |
| dedicated worker requests | 0 | 0 | 0 | 0 | 0 | 0 |
| long tasks | 1 | 1 | 0 | 1 | 1 | 0 |
| long task total (ms) | 52 | 50 | -2 | 56 | 77 | +21 |
| longest task (ms) | 52 | 50 | -2 | 56 | 77 | +21 |
| app ready (ms) | 454 | 442 | -12 | 480 | 466 | -15 |
| first paint (ms) | 313 | 307 | -5 | 353 | 338 | -15 |
| first contentful paint (ms) | 505 | 492 | -13 | 541 | 499 | -42 |
| document responseEnd (ms) | 239 | 214 | -25 | 275 | 277 | +3 |
| DOMContentLoaded (ms) | 310 | 261 | -49 | 333 | 310 | -23 |
| load event end (ms) | 311 | 262 | -49 | 333 | 310 | -23 |
| first WebGL context (ms) | 445 | 431 | -14 | 470 | 455 | -15 |
| first GL draw (ms) | 522 | 514 | -8 | 564 | 530 | -34 |
| script time (ms) | 125 | 141 | +16 | 136 | 150 | +14 |
| main-thread task time (ms) | 244 | 282 | +39 | 260 | 295 | +35 |
| JS heap used (MB) | 7.6 | 5.7 | -1.9 | 7.7 | 5.8 | -1.8 |
| uncaught errors | 0 | 0 | 0 | 0 | 0 | 0 |

| phase (softn: marks, ms) | baseline-0.0.7 median | after-dynamic-loading median | Δ median | baseline-0.0.7 p90 | after-dynamic-loading p90 | Δ p90 |
|---|---:|---:|---:|---:|---:|---:|
| softn:compose | 1 | 1 | 0 | 1 | 1 | 0 |
| softn:parse | 1 | 1 | 0 | 1 | 1 | 0 |
| softn:vm-init | 126 | 142 | +16 | 134 | 151 | +17 |
| softn:xdb-seed | 0 | 0 | +0 | 0 | 0 | +0 |
| softn:zip | 1 | 2 | +0 | 2 | 2 | 0 |

Phases measured only in after-dynamic-loading: softn:asset-extract 0 ms (p90 0); softn:asset-warm 22 ms (p90 25); softn:component-preload 19 ms (p90 21); softn:offline-install 296 ms (p90 310).

Points in time in after-dynamic-loading (ms from navigation, median): softn:scene3d-assets-ready 466; softn:scene3d-first-frame 514; softn:scene3d-renderer-ready 440.

3D module URLs requested in after-dynamic-loading: `/assets/GLTFLoader-DBAV7NEX.js`, `/assets/scene3d-CsGv-ogZ.js`.

Scripts carrying 3D code in after-dynamic-loading: three in `/assets/vendor-three-DRaE6mEZ.js`; gltf in `/assets/GLTFLoader-DBAV7NEX.js`.

**Worse in after-dynamic-loading (cold):** page requests: 17 → 20 (+3); page requests until ready: 17 → 20 (+3); script time (ms): 125 → 141 (+16); main-thread task time (ms): 244 → 282 (+39); softn:vm-init: 126 → 142 ms (+16); 3D module URL requested in 5/5 runs, was 0/5 — expected: this scenario asks for a scene, and the 3D code is now a separate chunk it has to request.

#### warm

| runs | baseline-0.0.7 | after-dynamic-loading |
|---|---:|---:|
| ready | 5/5 | 5/5 |
| 3D module URL requested | 0/5 | 5/5 |
| 3D code inside loaded JS | 5/5 | 5/5 |
| service worker controlling | 5/5 | 5/5 |

| metric | baseline-0.0.7 median | after-dynamic-loading median | Δ median | baseline-0.0.7 p90 | after-dynamic-loading p90 | Δ p90 |
|---|---:|---:|---:|---:|---:|---:|
| page requests | 11 | 14 | +3 | 11 | 14 | +3 |
| page bytes on the wire | 2.2 KB | 2.2 KB | 0.0 KB | 2.2 KB | 2.2 KB | 0.0 KB |
| page bytes loaded (content-length, cached or not) | 7085.5 KB | 6526.5 KB | -558.9 KB | 7085.5 KB | 6526.5 KB | -558.9 KB |
| JS bytes on the wire | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB |
| wasm bytes on the wire | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB |
| CSS bytes on the wire | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB |
| page requests until ready | 11 | 14 | +3 | 11 | 14 | +3 |
| page bytes until ready | 2.2 KB | 2.2 KB | 0.0 KB | 2.2 KB | 2.2 KB | 0.0 KB |
| service worker requests | 1 | 5 | +4 | 1 | 5 | +4 |
| service worker bytes on the wire | 2.6 KB | 2.6 KB | 0.0 KB | 2.6 KB | 2.6 KB | 0.0 KB |
| service worker bytes loaded (content-length) | 2.3 KB | 672.2 KB | +669.9 KB | 2.3 KB | 672.2 KB | +669.9 KB |
| dedicated worker requests | 0 | 0 | 0 | 0 | 0 | 0 |
| long tasks | 0 | 0 | 0 | 0 | 0 | 0 |
| long task total (ms) | 0 | 0 | 0 | 0 | 0 | 0 |
| longest task (ms) | 0 | 0 | 0 | 0 | 0 | 0 |
| app ready (ms) | 73 | 87 | +14 | 76 | 109 | +32 |
| first paint (ms) | 71 | 75 | +5 | 86 | 86 | 0 |
| first contentful paint (ms) | 102 | 105 | +3 | 117 | 107 | -11 |
| document responseEnd (ms) | 11 | 12 | +1 | 12 | 16 | +4 |
| DOMContentLoaded (ms) | 45 | 32 | -12 | 46 | 37 | -9 |
| load event end (ms) | 45 | 33 | -12 | 47 | 38 | -9 |
| first WebGL context (ms) | 69 | 81 | +13 | 71 | 103 | +32 |
| first GL draw (ms) | 105 | 115 | +10 | 107 | 143 | +36 |
| script time (ms) | 42 | 46 | +5 | 43 | 64 | +21 |
| main-thread task time (ms) | 94 | 106 | +12 | 111 | 126 | +15 |
| JS heap used (MB) | 8.4 | 9.5 | +1.1 | 11.5 | 9.7 | -1.7 |
| uncaught errors | 0 | 0 | 0 | 0 | 0 | 0 |

| phase (softn: marks, ms) | baseline-0.0.7 median | after-dynamic-loading median | Δ median | baseline-0.0.7 p90 | after-dynamic-loading p90 | Δ p90 |
|---|---:|---:|---:|---:|---:|---:|
| softn:compose | 0 | 0 | +0 | 0 | 0 | 0 |
| softn:parse | 0 | 0 | +0 | 0 | 1 | +0 |
| softn:vm-init | 34 | 48 | +14 | 37 | 62 | +25 |
| softn:xdb-seed | 0 | 0 | +0 | 0 | 0 | 0 |
| softn:zip | 2 | 1 | 0 | 2 | 1 | 0 |

Phases measured only in after-dynamic-loading: softn:asset-extract 0 ms (p90 0); softn:asset-warm 37 ms (p90 42); softn:component-preload 21 ms (p90 22).

Points in time in after-dynamic-loading (ms from navigation, median): softn:scene3d-assets-ready 93; softn:scene3d-first-frame 115; softn:scene3d-renderer-ready 86.

3D module URLs requested in after-dynamic-loading: `/assets/GLTFLoader-DBAV7NEX.js`, `/assets/scene3d-CsGv-ogZ.js`.

Scripts carrying 3D code in after-dynamic-loading: three in `/assets/vendor-three-DRaE6mEZ.js`; gltf in `/assets/GLTFLoader-DBAV7NEX.js`.

**Worse in after-dynamic-loading (warm):** page requests: 11 → 14 (+3); page requests until ready: 11 → 14 (+3); service worker requests: 1 → 5 (+4); service worker bytes loaded (content-length): 2.3 KB → 672.2 KB (+669.9 KB); app ready (ms): 73 → 87 (+14); first WebGL context (ms): 69 → 81 (+13); first GL draw (ms): 105 → 115 (+10); main-thread task time (ms): 94 → 106 (+12); JS heap used (MB): 8.4 → 9.5 (+1.1); softn:vm-init: 34 → 48 ms (+14); 3D module URL requested in 5/5 runs, was 0/5 — expected: this scenario asks for a scene, and the 3D code is now a separate chunk it has to request.

### scene-effects — Scene3D with bloom

#### cold

| runs | baseline-0.0.7 | after-dynamic-loading |
|---|---:|---:|
| ready | 5/5 | 5/5 |
| 3D module URL requested | 0/5 | 5/5 |
| 3D code inside loaded JS | 5/5 | 5/5 |
| service worker controlling | 5/5 | 5/5 |

| metric | baseline-0.0.7 median | after-dynamic-loading median | Δ median | baseline-0.0.7 p90 | after-dynamic-loading p90 | Δ p90 |
|---|---:|---:|---:|---:|---:|---:|
| page requests | 17 | 27 | +10 | 17 | 27 | +10 |
| page bytes on the wire | 7213.6 KB | 6676.2 KB | -537.4 KB | 7213.6 KB | 6676.2 KB | -537.4 KB |
| page bytes loaded (content-length, cached or not) | 7210.0 KB | 6670.0 KB | -540.1 KB | 7210.0 KB | 6670.0 KB | -540.1 KB |
| JS bytes on the wire | 1934.8 KB | 1397.5 KB | -537.4 KB | 1934.8 KB | 1397.5 KB | -537.4 KB |
| wasm bytes on the wire | 5126.1 KB | 5126.1 KB | 0.0 KB | 5126.1 KB | 5126.1 KB | 0.0 KB |
| CSS bytes on the wire | 15.6 KB | 15.6 KB | 0.0 KB | 15.6 KB | 15.6 KB | 0.0 KB |
| page requests until ready | 17 | 27 | +10 | 17 | 27 | +10 |
| page bytes until ready | 7213.6 KB | 6676.2 KB | -537.4 KB | 7213.6 KB | 6676.2 KB | -537.4 KB |
| service worker requests | 54 | 47 | -7 | 54 | 47 | -7 |
| service worker bytes on the wire | 1294.2 KB | 333.9 KB | -960.3 KB | 1294.2 KB | 334.3 KB | -960.0 KB |
| service worker bytes loaded (content-length) | 8508.2 KB | 6343.7 KB | -2164.5 KB | 8508.2 KB | 6343.7 KB | -2164.5 KB |
| dedicated worker requests | 0 | 0 | 0 | 0 | 0 | 0 |
| long tasks | 4 | 2 | -2 | 4 | 2 | -2 |
| long task total (ms) | 325 | 158 | -167 | 338 | 190 | -148 |
| longest task (ms) | 119 | 104 | -15 | 165 | 140 | -25 |
| app ready (ms) | 471 | 441 | -30 | 567 | 458 | -109 |
| first paint (ms) | 296 | 320 | +24 | 329 | 345 | +16 |
| first contentful paint (ms) | 595 | 445 | -150 | 673 | 522 | -151 |
| document responseEnd (ms) | 232 | 230 | -1 | 258 | 244 | -14 |
| DOMContentLoaded (ms) | 291 | 268 | -24 | 315 | 293 | -22 |
| load event end (ms) | 292 | 268 | -24 | 315 | 293 | -22 |
| first WebGL context (ms) | 428 | 431 | +3 | 449 | 448 | -1 |
| first GL draw (ms) | 448 | 509 | +61 | 468 | 549 | +81 |
| script time (ms) | 386 | 259 | -127 | 398 | 272 | -127 |
| main-thread task time (ms) | 527 | 391 | -136 | 536 | 407 | -130 |
| JS heap used (MB) | 7.4 | 7.3 | -0.1 | 7.8 | 7.4 | -0.5 |
| uncaught errors | 0 | 0 | 0 | 0 | 0 | 0 |

| phase (softn: marks, ms) | baseline-0.0.7 median | after-dynamic-loading median | Δ median | baseline-0.0.7 p90 | after-dynamic-loading p90 | Δ p90 |
|---|---:|---:|---:|---:|---:|---:|
| softn:compose | 1 | 1 | 0 | 1 | 1 | 0 |
| softn:parse | 1 | 1 | 0 | 2 | 1 | 0 |
| softn:vm-init | 338 | 126 | -212 | 343 | 295 | -48 |
| softn:xdb-seed | 0 | 0 | +0 | 0 | 0 | 0 |
| softn:zip | 1 | 2 | +0 | 3 | 2 | -1 |

Phases measured only in after-dynamic-loading: softn:asset-extract 0 ms (p90 0); softn:asset-warm 20 ms (p90 28); softn:component-preload 20 ms (p90 25); softn:offline-install 306 ms (p90 394).

Points in time in after-dynamic-loading (ms from navigation, median): softn:scene3d-assets-ready 470; softn:scene3d-first-frame 618; softn:scene3d-renderer-ready 438.

3D module URLs requested in after-dynamic-loading: `/assets/GLTFLoader-DBAV7NEX.js`, `/assets/UnrealBloomPass-CUvuWZpG.js`, `/assets/scene3d-CsGv-ogZ.js`.

Scripts carrying 3D code in after-dynamic-loading: three in `/assets/vendor-three-DRaE6mEZ.js`; gltf in `/assets/GLTFLoader-DBAV7NEX.js`; postprocessing in `/assets/EffectComposer-SOTmTxfr.js`; bloom in `/assets/UnrealBloomPass-CUvuWZpG.js`.

**Worse in after-dynamic-loading (cold):** page requests: 17 → 27 (+10); page requests until ready: 17 → 27 (+10); first paint (ms): 296 → 320 (+24); first GL draw (ms): 448 → 509 (+61); 3D module URL requested in 5/5 runs, was 0/5 — expected: this scenario asks for a scene, and the 3D code is now a separate chunk it has to request.

#### warm

| runs | baseline-0.0.7 | after-dynamic-loading |
|---|---:|---:|
| ready | 5/5 | 5/5 |
| 3D module URL requested | 0/5 | 5/5 |
| 3D code inside loaded JS | 5/5 | 5/5 |
| service worker controlling | 5/5 | 5/5 |

| metric | baseline-0.0.7 median | after-dynamic-loading median | Δ median | baseline-0.0.7 p90 | after-dynamic-loading p90 | Δ p90 |
|---|---:|---:|---:|---:|---:|---:|
| page requests | 11 | 21 | +10 | 11 | 21 | +10 |
| page bytes on the wire | 2.3 KB | 2.3 KB | 0.0 KB | 2.3 KB | 2.3 KB | 0.0 KB |
| page bytes loaded (content-length, cached or not) | 7085.5 KB | 6545.4 KB | -540.1 KB | 7085.5 KB | 6545.4 KB | -540.1 KB |
| JS bytes on the wire | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB |
| wasm bytes on the wire | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB |
| CSS bytes on the wire | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB | 0.0 KB |
| page requests until ready | 11 | 21 | +10 | 11 | 21 | +10 |
| page bytes until ready | 2.3 KB | 2.3 KB | 0.0 KB | 2.3 KB | 2.3 KB | 0.0 KB |
| service worker requests | 1 | 12 | +11 | 1 | 12 | +11 |
| service worker bytes on the wire | 2.6 KB | 2.6 KB | 0.0 KB | 2.6 KB | 2.6 KB | 0.0 KB |
| service worker bytes loaded (content-length) | 2.3 KB | 691.1 KB | +688.8 KB | 2.3 KB | 691.1 KB | +688.8 KB |
| dedicated worker requests | 0 | 0 | 0 | 0 | 0 | 0 |
| long tasks | 2 | 1 | -1 | 3 | 2 | -1 |
| long task total (ms) | 216 | 64 | -152 | 361 | 216 | -145 |
| longest task (ms) | 153 | 64 | -89 | 187 | 126 | -61 |
| app ready (ms) | 220 | 148 | -73 | 258 | 170 | -88 |
| first paint (ms) | 156 | 167 | +11 | 196 | 177 | -18 |
| first contentful paint (ms) | 313 | 177 | -135 | 383 | 232 | -151 |
| document responseEnd (ms) | 12 | 13 | +1 | 14 | 14 | +0 |
| DOMContentLoaded (ms) | 51 | 33 | -18 | 52 | 38 | -14 |
| load event end (ms) | 52 | 34 | -18 | 52 | 39 | -14 |
| first WebGL context (ms) | 146 | 101 | -45 | 183 | 165 | -18 |
| first GL draw (ms) | 152 | 182 | +30 | 189 | 208 | +19 |
| script time (ms) | 283 | 138 | -145 | 298 | 255 | -43 |
| main-thread task time (ms) | 452 | 196 | -256 | 583 | 312 | -271 |
| JS heap used (MB) | 10.2 | 9.4 | -0.9 | 10.3 | 10.9 | +0.6 |
| uncaught errors | 0 | 0 | 0 | 0 | 0 | 0 |

| phase (softn: marks, ms) | baseline-0.0.7 median | after-dynamic-loading median | Δ median | baseline-0.0.7 p90 | after-dynamic-loading p90 | Δ p90 |
|---|---:|---:|---:|---:|---:|---:|
| softn:compose | 0 | 0 | +0 | 0 | 0 | 0 |
| softn:parse | 1 | 0 | 0 | 1 | 1 | 0 |
| softn:vm-init | 301 | 112 | -189 | 311 | 131 | -181 |
| softn:xdb-seed | 0 | 0 | 0 | 0 | 0 | 0 |
| softn:zip | 2 | 1 | -1 | 2 | 1 | -1 |

Phases measured only in after-dynamic-loading: softn:asset-extract 0 ms (p90 0); softn:asset-warm 24 ms (p90 26); softn:component-preload 20 ms (p90 22).

Points in time in after-dynamic-loading (ms from navigation, median): softn:scene3d-assets-ready 160; softn:scene3d-first-frame 211; softn:scene3d-renderer-ready 146.

3D module URLs requested in after-dynamic-loading: `/assets/GLTFLoader-DBAV7NEX.js`, `/assets/UnrealBloomPass-CUvuWZpG.js`, `/assets/scene3d-CsGv-ogZ.js`.

Scripts carrying 3D code in after-dynamic-loading: three in `/assets/vendor-three-DRaE6mEZ.js`; gltf in `/assets/GLTFLoader-DBAV7NEX.js`; postprocessing in `/assets/EffectComposer-SOTmTxfr.js`; bloom in `/assets/UnrealBloomPass-CUvuWZpG.js`.

**Worse in after-dynamic-loading (warm):** page requests: 11 → 21 (+10); page requests until ready: 11 → 21 (+10); service worker requests: 1 → 12 (+11); service worker bytes loaded (content-length): 2.3 KB → 691.1 KB (+688.8 KB); first paint (ms): 156 → 167 (+11); first GL draw (ms): 152 → 182 (+30); 3D module URL requested in 5/5 runs, was 0/5 — expected: this scenario asks for a scene, and the 3D code is now a separate chunk it has to request.
