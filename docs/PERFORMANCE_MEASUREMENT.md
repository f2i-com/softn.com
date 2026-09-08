# Measuring what it costs to open an app

`npm run bench` opens a set of fixed bundles in a production build of a host, in headless Edge or Chrome, and records what the visit fetched and when the app came up. It exists so that a change to loading — code splitting, demand-loaded features, a different archive reader — can be argued from two runs of the same script on the same machine rather than from a bundle analyser and a hunch. The audit brief this answers is explicit that a performance claim without the build, workload, device, cache state and method behind it is not a claim; the summary files carry all five.

The harness is `scripts/bench/measure.mjs`. It has no dependencies beyond the workspace: Node's global `WebSocket` speaks the DevTools protocol and `fflate` zips the fixtures.

## Running it

Build the packages and the host you want to measure, then run:

```
npm run build:packages
npm run build -w @softn/single          # or: npm run build -w @softn/web
npm run bench -- --host single --label before-split
```

Options:

| flag                 | default    | meaning                                                                                                   |
| -------------------- | ---------- | --------------------------------------------------------------------------------------------------------- |
| `--host single\|web` | `single`   | Which built host to serve: `apps/softn-single/dist` or `apps/softn-web/dist`.                             |
| `--scenario a,b`     | all        | Which fixtures to open (see below).                                                                       |
| `--runs N`           | `5`        | Runs per scenario; each is a fresh browser profile.                                                       |
| `--label name`       | `local`    | Names the measurement; results go to `scripts/bench/results/<label>/`.                                    |
| `--out dir`          | from label | Write somewhere else.                                                                                     |
| `--browser path`     | found      | A Chromium binary; `SOFTN_BROWSER` also works.                                                            |
| `--dist dir`         | from host  | Serve another build of the host.                                                                          |
| `--build`            | off        | Build the host first.                                                                                     |
| `--bypass-sw`        | off        | Warm pass with the service worker bypassed, so HTTP-cache-warm and service-worker-warm can be told apart. |
| `--settle ms`        | `1500`     | How long after the app is ready to keep collecting.                                                       |
| `--timeout ms`       | `60000`    | How long to wait for the app before giving up on a run.                                                   |
| `--no-runs`          | off        | Do not write the per-run JSON files.                                                                      |
| `--port N`           | ephemeral  | The port to serve on.                                                                                     |

Both hosts can be measured into the same label; a second invocation adds its host to `summary.json` beside the first. `SOFTN_BENCH_DEBUG=1` narrates the protocol (which targets attached, what each answered) when a run misbehaves.

The web host must be built for the site root — `npm run build -w @softn/web` with `VITE_BASE` unset. The harness refuses a `/web/` build because its absolute asset URLs would 404 when served from `/`.

## What is opened

The fixtures live under `scripts/bench/fixtures/` as ordinary bundle sources (manifest, permission declaration, `.ui`, `.logic`) and are zipped when the harness starts. The scene fixtures carry a glTF binary that `scripts/bench/glb.mjs` generates — a tetrahedron, about a kilobyte — so no model is committed and a diff of the fixture is a diff of everything the run saw.

| scenario        | what it is                                                                        | what it asks                                                                                                                          |
| --------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `minimal`       | A heading, a paragraph, an input and a button. No 3D, no assets, no permissions.  | What the runtime costs before an app asks it for anything; the acceptance test that a minimal app pulls in nothing from the 3D stack. |
| `scene-glb`     | One `Scene3D` showing the bundled GLB and a floor. No effects, no orbit controls. | The renderer, the loader modules and a model, without post-processing.                                                                |
| `scene-effects` | The same scene with bloom on.                                                     | The post-processing path on top of `scene-glb`.                                                                                       |

In the single host each scenario is served as its own directory (`/s/<scenario>/`) with its own `runtime.config.json`; in the web host it is opened with `?open=/bench/<scenario>.softn&embed=1`, the way a directory card opens an app. The server sends the deployment's cross-origin isolation headers on every response and its cache rules — hashed assets immutable, other static files an hour, documents, JSON, the service worker and bundles revalidated — so the warm pass measures against the same caching a deployed copy gets.

Every run launches a fresh browser profile and navigates twice. The **cold** pass has the HTTP cache disabled on an empty profile. The **warm** pass is a second navigation in the same profile with the cache on; on the web host the service worker installed by the first visit now controls the page, so warm means both HTTP-cache-warm and service-worker-warm unless `--bypass-sw` is given. There is no installed-offline case yet.

## What is measured

Each pass records, for the page and separately for the service worker and any dedicated worker:

- **Requests.** Every URL, its kind (html, js, css, wasm, json, font, image, bundle, blob, other), status, bytes on the wire (`encodedDataLength`, which is zero for a cache hit), the `Content-Length` it was served with, and whether the HTTP cache, the memory cache or the service worker answered it. A `blob:` request is a bundled asset reaching a component — the model load shows up as one.
- **3D module URL requested.** Whether any page or worker request's file name, hash stripped, matches `three|scene3d|gltf|objloader|fbx|stl|postprocessing|bloom`. The service worker's precache is judged separately.
- **3D code inside loaded JS.** The same question asked of the bytes: each script the page loaded is read back and searched for Three.js's own strings (`THREE.WebGLRenderer`, `THREE.GLTFLoader`, `UnrealBloomPass`, …). A host that bundles Three into its entry chunk shows nothing in a URL; this is what catches it, per feature and per chunk.
- **Phase marks.** Every `performance.mark` whose name starts with `softn:`. A `softn:<phase>:start` is paired with the first `softn:<phase>:end` after it into a duration; a phase that runs more than once reports its total; a mark with neither suffix is reported as a point in time; `performance.measure` entries named `softn:…` are durations too. Marks made inside a worker are not visible to the page and are not collected.
- **App ready.** The first moment the fixture's own sentence ("Bench minimal is ready", "Bench scene is ready" beside a `<canvas>`) is in the DOM, timed by a mutation observer installed before any page script runs. It is a DOM signal, not a paint.
- **Paint and navigation timing.** `first-paint`, `first-contentful-paint`, `responseEnd`, `DOMContentLoaded`, `loadEventEnd`.
- **First WebGL context** and **first GL draw call**, from hooks installed before any page script runs (the draw hooks remove themselves after the first call). Whether a WebGL2 context was obtainable at all, and which renderer answered.
- **Long tasks** (count, total, longest) up to ready plus settle, from a `longtask` observer; main thread only.
- **Main-thread totals** from `Performance.getMetrics`: script time, task time, JS heap.
- **Errors.** Uncaught exceptions and console errors, with the first few messages, so a run that measured an error card says so.

The environment goes into the summary with the numbers: the build's mtime, package version, git revision and whether the tree was dirty, browser version, CPU, memory, OS, Node, viewport, and the options used.

## Reading the summary

`summary.md` has one table per host and scenario, with cold and warm medians and nearest-rank p90s over the runs. Times are milliseconds from navigation start. Bytes are what the server sent uncompressed — the local server does not gzip or brotli, so they are comparable between runs but larger than a deployed transfer.

| column                                                   | meaning                                                                                                                                                                                                             |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| app ready                                                | The fixture's sentence is in the DOM.                                                                                                                                                                               |
| first paint / first contentful paint                     | The browser's paint entries. The shell can paint long before the app is ready, and the app can be ready before it paints.                                                                                           |
| document responseEnd / DOMContentLoaded / load event end | Navigation timing of the host document.                                                                                                                                                                             |
| first WebGL context / first GL draw                      | When a renderer existed and when it first drew anything. A draw is not a useful frame: the model may not have arrived.                                                                                              |
| page requests / page bytes on the wire                   | What the page itself fetched, and what actually crossed the wire (cache hits count as zero bytes).                                                                                                                  |
| page bytes loaded                                        | The `Content-Length` sum of the same list, cached or not: what a visitor with an empty cache pays for it.                                                                                                           |
| JS / wasm / CSS / bundle bytes                           | Wire bytes by kind.                                                                                                                                                                                                 |
| requests from HTTP cache / from service worker           | Where the warm pass's answers came from.                                                                                                                                                                            |
| … until ready                                            | The same counts stopped at the ready moment, so traffic that continued afterwards is visible.                                                                                                                       |
| service worker requests / bytes                          | What the worker fetched on its own account — the precache — reported apart from the page. Its wire bytes are small when the page has just fetched the same files; its content bytes are the size of what it stored. |
| dedicated worker requests / bytes                        | A worker-mode app's script runtime, when there is one.                                                                                                                                                              |
| long tasks / long task total / longest task              | Main-thread tasks over 50 ms up to ready plus settle.                                                                                                                                                               |
| script time / main-thread task time / JS heap used       | `Performance.getMetrics` at collection.                                                                                                                                                                             |
| uncaught errors                                          | Anything that threw. A non-zero count is a run to look at before quoting.                                                                                                                                           |

Below the table: the phase marks, the chunks carrying 3D code, and the full request list of a representative run (the one whose page bytes sit at the median) for each pass.

`summary.json` holds everything the markdown shows plus the scalar metrics of every run, so two labels can be diffed by script. Per-run JSON under `runs/` (unless `--no-runs`) has the complete request list of each pass.

## The 0.0.7 baseline

`scripts/bench/results/baseline-0.0.7/` is the reference the demand-loading work is measured against: both hosts, all three scenarios, five runs each, `--no-runs`, taken on the tree at `e9fccda` with the phase marks added. Its `summary.json` carries the environment block; a later label is comparable with it only on the same machine and browser.

What it shows, before any change: a minimal text-and-form app pulls about 7 MB over the wire in either host — a 1.7 MB entry chunk and the 5 MB scripting engine — and the entry chunk carries Three.js, every model loader and the bloom pass, so the "3D code inside loaded JS" column is 5/5 for `minimal` while no separate 3D chunk URL exists to request. The web host's service worker then precaches about 8.5 MB more in the background. Warm visits move a few kilobytes. Those request lists, not the millisecond columns, are the numbers a code-splitting change has to move.

## Caveats

These are the conditions under which a number from this harness means something, and the ways it can mislead.

- **Production builds only.** The harness serves `dist/`. A dev server's module graph, transforms and source maps have nothing to do with what a visitor downloads.
- **Cache state is part of the number.** Cold and warm are different measurements and the summary keeps them apart; quote which one. On the web host, warm includes the service worker unless `--bypass-sw` was used, and the cold pass's service-worker bytes include the precache the worker fetched in the background after the app was up.
- **Device.** Numbers from this machine compare with numbers from this machine. The environment block records what it was; a comparison across labels needs the same block.
- **The headless GPU is not a GPU.** WebGL runs on SwiftShader, a software rasteriser. Context creation, shader compilation and draw times bear no relation to a real device; treat them as "the path was exercised" and not as a frame time. `webglAvailable` says whether the path ran at all.
- **Localhost is not a network.** Bytes are the right metric here; transfer time is not. There is no compression, no latency and no bandwidth cap. What loads in 300 ms here loads in seconds on a phone; the byte counts and the request list are what carries over.
- **Shell paint, app init and first useful frame are different numbers.** First contentful paint is the host's shell. App ready is the runtime having rendered the fixture's markup. First GL draw is the renderer drawing something, possibly a placeholder before the model arrived. None of them is "the first frame the user would call the app", and the harness does not measure steady-state frame time at all.
- **Ready is what the fixture says it is.** The sentence appears when the runtime has rendered the template; logic may still be initialising. A scenario measuring something later should put its sentence there.
- **Marks are only as good as their placement.** The harness pairs whatever `softn:` marks the code makes; a phase with no marks is invisible, and a mark inside a worker is not collected.
- **Five runs is a small sample.** The p90 is the second-worst run. Anything within a few percent between two labels is noise on a desktop; look at bytes and request lists, which do not jitter, before looking at times.
- **The scenarios are small on purpose.** They isolate the runtime's own cost. The audit brief also asks for a textured animated model, repeated instances, several mounted tabs and a large archive whose first screen uses a fraction of its assets; those are further fixtures, not different tooling.

## Adding a scenario

Put a bundle source under `scripts/bench/fixtures/<name>/` and an entry in `scripts/bench/scenarios.mjs` with a `ready` expression that only holds once the thing you want to time is on screen. Generated assets go in the entry's `generated` map. The manifest is checked against the files at build time so a missing asset is an error, not a measurement of a missing-file path.

## Adding a mark

`performance.mark('softn:<phase>:start')` and `performance.mark('softn:<phase>:end')` around the phase, each guarded by `typeof performance !== 'undefined' && typeof performance.mark === 'function'` because the runtime also renders where the User Timing API is absent. Phase names are lower-case kebab. A single `performance.mark('softn:<event>')` reports a point in time. Nothing else is needed; the harness collects every `softn:` mark it can see.

## Results (2026-09-08)

Two labels, both hosts, all three scenarios, five runs each, `--no-runs`,
same machine and browser (Edge 152.0.4191.66 headless on SwiftShader, Ryzen 9
9950X3D, Windows 11, Node 24.12.0):

- `scripts/bench/results/baseline-0.0.7/` — the 0.0.7 tree at `e9fccda`
  with the phase marks added, taken 7 September.
- `scripts/bench/results/after-dynamic-loading/` — the demand-loading tree
  (component entries and lazy registry, precache tiers and per-app install,
  archive index and worker warm-up, parsed-document reuse, Scene3D on-demand
  loading), taken 8 September on production builds
  (`npm run build:packages`, `npm run build -w @softn/single`,
  `npm run build -w @softn/web`). The first run of this label showed two
  things the design did not intend — the `vendor-three` chunk carried every
  Three addon, so `scene-glb` downloaded the bloom pass it does not use, and
  every app fetched the 195 KB `xdb-sync-*` runtime at mount because the
  renderer imported it to look for a saved room. Both were fixed (the group
  narrowed to `three/build/`, the saved-room key read from a module that
  imports nothing) and both hosts were measured again, later the same day,
  into the same folder under the same label; the first run's files were
  overwritten, and everything quoted from this label is the second run.
  `compare-baseline-0.0.7.md` in that folder is `node
  scripts/bench/compare.mjs baseline-0.0.7 after-dynamic-loading`, regenerated
  from it: every metric and every shared mark of both labels side by side,
  with the rows that got worse named under each table.
- `scripts/bench/results/after-dynamic-loading-sw-bypassed/` — the web host
  again with `--bypass-sw`, also re-measured after the two fixes, so its warm
  pass is the HTTP cache alone and HTTP-cache-warm and service-worker-warm
  can be read apart.

What moved, in the numbers the baseline section above said had to move: the
`minimal` fixture's JS on the wire fell from 1,836.6 KB to 611.7 KB
(standalone) and 1,934.8 KB to 716.3 KB (web), "3D code inside loaded JS"
from 5/5 runs to 0/5 in both hosts, and the web host's background precache
from 1,293.9 KB to 334–345 KB on the wire (8,508 KB to 6,344 KB stored). The
scenes request `scene3d-*`, `vendor-three-*` and `GLTFLoader-*` (57 KB,
571 KB and 45 KB), the bloom scene the seven post-processing files as well
(19 KB together), and land 537–565 KB lighter than before. Request counts
fell by one in `minimal` (no `xdb-sync-*` request) and rose by three
(`scene-glb`) and ten (`scene-effects`); a scene's first GL draw is up to 61
ms later on a cold visit and 10–50 ms later warm, on SwiftShader;
`softn:vm-init` is 6–16 ms longer in `scene-glb`, where the component
preload runs beside it, and 190–210 ms shorter on the cold bloom scene. The
engine's 5,126 KB wasm and the bundle bytes are unchanged. The build-graph
tests report an entry closure of 732,413 bytes (web) and 625,726 bytes
(single), one chunk each, against 1,764,885 bytes for the 0.0.7 build.

`docs/audit-2026-09-08-response.md` has the tables, the SW-bypassed
comparison, and the list of what got worse; quote from there with its
caveats. The two fixes the first run of this label prompted are its rows C05
(`vendor-three` is Three's core; each addon is its own on-demand chunk) and
H05 (the sync runtime is not imported to find out that nothing needs it).

To compare a later change against either label:

```
npm run build:packages && npm run build -w @softn/single && npm run build -w @softn/web
npm run bench -- --host single --label <name> --no-runs
npm run bench -- --host web --label <name> --no-runs
node scripts/bench/compare.mjs after-dynamic-loading <name> --out scripts/bench/results/<name>/compare-after-dynamic-loading.md
```
