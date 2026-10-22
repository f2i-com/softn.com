# Component loading

How the browser runtimes get their built-in components: which ones ship in
the shell, which are fetched on demand, what the registry does while a fetch
is in flight or after it fails, what the service worker keeps, and what a
deployment has to leave on the server.

## The problem this replaces

Until 0.0.7 both `apps/softn-web/src/main.tsx` and `apps/softn-single/src/main.tsx`
called `registerAllBuiltins()` from the `@softn/components` root barrel, and
that barrel imported every component statically — `threed/Scene3D.tsx` with
Three.js, four model loaders, OrbitControls, the room environment and five
post-processing modules among them. The web build therefore had one entry
chunk of 1,780,427 bytes carrying Three.js for every app, a form or a scene
alike, and the service worker precached it for every visitor. (The 0.0.7
release measured in `scripts/bench/results/baseline-0.0.7/` reads 1,764,885;
the tree has grown since.)

After this change the web entry closure is 732,413 bytes and the standalone
one 625,726, one chunk each; Three's core (`vendor-three`, 571 KB,
`three/build/` alone), each feature and each Three addon are separate
chunks fetched when a document needs them, and none of them is in the
service worker's precache. Both numbers are asserted by
`apps/softn-web/test/build-graph.test.ts` and `apps/softn-single/test/build-graph.test.ts`,
which read Vite's manifest and print the closure, the feature chunks and the
addon chunks into the test log.

Studio, the Builder, the desktop loader and the apps `@softn/vite-plugin`
builds register the same way since 2026-10-20 (`registerRuntimeComponents`,
or `ensureRuntimeComponents` in the plugin's generated modules): a preview,
the Builder's canvas or a built app fetches a feature the first time a page
draws it, so a page with a chart fetches the charts and a page with no
`Scene3D` never fetches Three.js. The editors are installed whole: their
service workers precache everything they ship (`globIgnores: []`), the
features, Three.js and its addons, the QR decoder and the workers' files
under `core-runtime/` included, so an installed Studio or Builder works
offline with every feature, while a page still loads each one only when it
draws it; `scripts/build/editor-offline.test.mjs` holds the two editors' builds to
both halves. The Builder's entry fell from 2.4 MB to 1.1 MB. SoftN Web keeps
the shell-only precache below, and installs each app it opens. Studio's agent check, which reads what a
page shows, preloads every component the page names (on every branch) before
it renders. The Builder's canvas draws the start-up set at once and any other
component (a QRCode) as its stand-in until its feature has arrived.

Since 2026-10-22 the shell itself carries only the start-up set
(`essentials`): the layout, text and images, a button, a text field, a form
and a list. The rest of what was the minimal set is five light groups, each
a chunk a page fetches when it draws one of its components, and a page's
first draw waits a moment for the ones its first screen names (below), so
an app opens drawn rather than around placeholders.

## The entries of `@softn/components`

`packages/@softn/components/package.json` exports these, each a tsup entry with
its own `.d.ts` (`packages/@softn/components/tsup.config.ts`):

| Entry | Contents | Minified, dependencies external |
| --- | --- | --- |
| `@softn/components` | The legacy barrel: everything, eagerly, plus `registerAllBuiltins()`, for a consumer outside this repository that relies on it. Nothing here imports it at run time any more (tests do, to hold the entries equal to it). Importing anything from it puts every component, Three.js included, into the importing chunk. | all of the below |
| `@softn/components/essentials` | The start-up set, what most apps draw on their first screen: the layout (Stack, Box, Card, Grid, Container, the app frame and the rest of `layout/`), Text, Heading, Badge, Image, Icon, Spinner, Button, Input, TextArea, Form, Field, List, ListItem, EmptyState and Loop. `essentialComponents`. Chosen by counting what the example apps, Studio's templates and the guides draw. | ~90 KB |
| `@softn/components/controls` | Select, Checkbox, Switch, Radio, Slider, FileChooser, NumberInput, Rating, SegmentedControl, ButtonGroup, CopyButton. `controlComponents`. | ~63 KB |
| `@softn/components/feedback` | Alert, Modal, Toast, Drawer, Popover, Confirm, Tooltip. `feedbackComponents`. | ~43 KB |
| `@softn/components/data` | Table, TreeView, Pagination, DataGrid, Timeline. `dataComponents`. | ~29 KB |
| `@softn/components/display` | Avatar, AvatarGroup, Tag, TagGroup, Progress, Skeleton, Stat, Kbd, DescriptionList. `displayComponents`. | ~27 KB |
| `@softn/components/navigation` | Tabs, Breadcrumb, Menu, NavItem, Steps, Accordion, Collapse. `navigationComponents`. | ~32 KB |
| `@softn/components/minimal` | The start-up set and the five groups above, together: what the shell carried until 2026-10-22. `minimalComponents` and `registerMinimalComponents()`, for a host that wants them all at once without loaders. Nothing beyond React and `@softn/core` in its import graph. | ~247 KB |
| `@softn/components/lazy` | `registerRuntimeComponents(registry?)`: the start-up set eagerly, every other built-in by loader; `ensureRuntimeComponents(registry?)`, the same once per registry, for code that may run more than once (each module `@softn/vite-plugin` compiles). `lazyComponentRegistrations` (name → feature + loader, and whether a first draw waits for it) and `runtimeComponentNames`. Imports `essentials` statically and every other entry only through `import()`. | ~4 KB + essentials |
| `@softn/components/theme` | `ThemeProvider`, the token sets, the variant and size scales. No component. | ~16 KB |
| `@softn/components/scene3d` | `Scene3D`, with Three.js as its one static import. The GLTF/OBJ/FBX/STL loaders, OrbitControls, RoomEnvironment, the post-processing set, SkeletonUtils and the Meshopt decoder are each an `import()` of its own inside it (docs/engineering/SCENE3D_LOADING.md), so each is a further chunk fetched the first time a scene needs it. | ~49 KB + Three.js (~571 KB in the host build); the addons 1–47 KB each |
| `@softn/components/charts` | LineChart, BarChart, PieChart, AreaChart, RadarChart, GaugeChart (SVG). | ~30 KB |
| `@softn/components/editors` | CodeEditor, MarkdownEditor, RichTextEditor. | ~17 KB |
| `@softn/components/smart` | SmartGrid, SmartView, SmartForm, SmartStats, SmartCards, SmartList, SmartTimeline. | ~60 KB |
| `@softn/components/media` | Camera, Microphone, AudioStream, QRCode, QRReader, with `@rc-component/qrcode` and `@yudiel/react-qr-scanner`. | ~186 KB in the host build, before the scanner's WASM decoder |
| `@softn/components/animation` | AnimatedBox, AnimatedNumber, Marquee, Typewriter, Draggable, SortableList, PanView, Sprite, TileMap. | ~19 KB |
| `@softn/components/pickers` | DatePicker, ColorPicker. | ~15 KB |
| `@softn/components/games` | PixelGrid, PixelCanvas, DPad. | ~12 KB |

The sizes come from bundling each source module with esbuild, minified, with
react, `@softn/core`, three and the QR libraries external; the host-build
figures are the chunks Vite emitted. Each light group's figure counts the
helpers it shares with the start-up set, which a host build leaves in the
shell, so the five add up to more than `minimal` less `essentials`. The
animation group is the marginal one — a tenth of the minimal set — and is
separate because games and showcases use it and forms do not.

`registry.ts`'s eager `builtinComponents` is the union of the entries'
records, so the two registration paths cannot name different sets by
construction; `packages/@softn/components/test/lazy-entries.test.ts` holds
`registerRuntimeComponents()` to exactly those names and checks that
importing `lazy` evaluates nothing from `threed/`.

The package declares `"sideEffects": false`. Every component module is pure
at the top level (no stylesheet imports, no `document` access at load), and
the flag is what lets a host that imports one component from the root barrel
have the rest tree-shaken away. A host should still import from `essentials`,
`minimal`, `theme` or a feature entry rather than rely on that: the barrel is
the eager path by definition.

Every three import — the bare package and any `three/addons/...` path,
static or dynamic — is external to the tsup build (a RegExp in
`tsup.config.ts`), so the host's bundler decides where Three.js lands and an
addon import added inside Scene3D cannot be inlined into the components
package by accident.

## How the registry resolves a name

`ComponentRegistry` in `packages/@softn/core/src/renderer/registry.ts` holds
two maps: components registered directly (`register`, `registerAll`) and
loaders (`registerLazy(name, load, { feature, beforeFirstDraw })`,
`registerAllLazy`). The
document renderer asks `get(name)` for every tag and cannot tell the two
apart:

- For a lazy name, `get()` returns **one wrapper component per name**,
  created at registration and never replaced. React sees the same element
  type on every render, so a re-render of the document does not remount the
  region — a Scene3D keeps its WebGL context.
- The wrapper (`lazy-component.tsx`) renders the entry's current `React.lazy`
  instance inside its own `<Suspense>` with a compact placeholder
  (`role="status" aria-busy="true"`, sized by nothing: it takes no height of
  its own) and its own error boundary. Both are local to the component's
  region; the rest of the document renders around them.
- A component that was preloaded renders directly, not through `React.lazy`,
  because `React.lazy` suspends at least once even for a promise that has
  already settled and the placeholder would flash for a frame. The choice is
  made once per mount and generation, so a component that started through
  `React.lazy` stays there after it resolves rather than being remounted. It
  renders under the same local error boundary either way; only the
  `<Suspense>` is specific to the `React.lazy` path, so whether a render
  error stays in its region does not depend on whether the chunk was already
  warm.
- `has()` is true for lazy names, `getNames()` lists them, and
  `getLoadState(name)` answers `'eager' | 'idle' | 'loading' | 'loaded' | 'error' | undefined`.
  `isLoaded(name)`, `load(name)`, `getFeature(name)` and `preload(names)` are
  there for hosts; `preload` starts the idle loaders among `names`, ignores
  eager and unknown names, never rejects and settles when what it started
  has settled. `firstDrawLoads(names)` is the same for the loaders
  registered with `beforeFirstDraw` alone: a promise that settles (never
  rejects) when every one of them among `names` that is not yet loaded or
  failed has settled, or `null` when there is none to wait for.

The loader function runs **at most once per generation**: every wrapper,
`load()` and `preload()` share the entry's one promise, in flight or settled.

## Retry and the version-mismatch reload

`React.lazy` caches a rejected load forever; resetting an error boundary
around it re-throws the same rejection. So each entry counts generations.
`retry(name)` clears the cached promise, bumps the generation, creates a new
`React.lazy` instance and notifies every mounted wrapper through a small
subscription; the wrapper re-renders with the new instance under a boundary
keyed by the generation, so the old boundary — and the rejection it caught —
is gone with it. The loader runs again, once.

The boundary tells the loader's own rejection — the one `React.lazy`
re-throws, which the entry recorded; identity, not a message match — from an
error the loaded component threw while rendering. A render error reads
`<Name> failed to render: <message>` with a **Retry** button (`retry()`)
alone: it is the app's own and a reload would reproduce it. A load failure
reads `<Name> could not load: <message>` with Retry; when it looks like a
chunk that is no longer on the server — a `TypeError` from `import()` whose
message mentions import, module or fetch, or a 404-ish message — and
`navigator.onLine` is not `false`, the text says the app was updated while it
was open and a **Reload** button (`location.reload()`) appears beside Retry.
That is what a deployment looks like from a tab that was open before it: the
shell it is running still references the previous release's hashed file
names, and only a reload picks up the new shell. Offline, the same failure
reads `<Name> is not available offline; retry once connected.` with Retry
alone: the chunk was never fetched and a reload would fetch the same nothing.
`isMissingChunkError()` is exported for hosts that want the same judgement;
it is a heuristic over the message and only meaningful for an error a loader
produced.

## Prefetch policy

Right after a parse succeeds, `SoftNRenderer` calls
`getDefaultRegistry().preload(collectFirstScreenTags(doc))`, between the
performance marks `softn:component-preload:start` and `:end`. The VM takes a
while to come up; a first-screen feature is fetched in that time rather
than discovered on first render.

`collectFirstScreenTags` (`packages/@softn/core/src/renderer/document-tags.ts`)
walks the template and returns the tags reachable **without entering a
conditional branch**:

- Element children count; so do `#each` bodies and their `#empty` fallbacks
  (a list either has records or does not, and the first screen shows one of
  the two — neither is a route), slot fallbacks and template-slot children.
- `#if` blocks are skipped whole — every branch, `#elseif` and `#else`
  included — and so is an element carrying an inline `if={…}` with
  everything under it. A `Scene3D` behind `#if (page === 'game')` is a later
  route and is not fetched until that route renders.

Whatever appears later is resolved at runtime by the wrapper on its first
render. The rule is deliberately the narrow one: static analysis can see
every branch, and fetching them all would be the eager barrel by another
route.

### The first draw

A heavy feature is drawn around: a chart or a scene stands as its
placeholder until its chunk arrives, and the rest of the page is usable
meanwhile. The light groups are different. A Select, Tabs or a Table is
most of what a form or a list page is, a placeholder in its place would
shift the page as it arrived, and a Tabs or an Accordion standing as a
placeholder hides everything it holds. So the groups' loaders are
registered with `beforeFirstDraw` (`fromGroup` in `lazy.ts`), and
`SoftNRenderer` holds the page's first draw for them:

- Right after the parse, beside the preload above, it asks
  `registry.firstDrawLoads(collectFirstScreenTags(doc))`. The loads have
  already started; this only says which to wait for.
- Where it would otherwise show the document — at once, with the VM
  starting beside it — it waits for those loads, or for
  `FIRST_DRAW_WAIT_MS` (300 ms) from that moment, whichever is first,
  together with the early shell of a page drawn from its own document.
  From the service worker's precache the wait is a few milliseconds, and
  the VM's start-up goes on through it.
- After the cap the page is drawn as it stands, and each component still
  loading is the usual placeholder, replaced where it stands when its chunk
  arrives. A failed load is not waited for twice: it is the usual local
  error with Retry.

An app opens the same way each time, so the renderer writes down what its
first draw waited for, and the next open starts it before the page has been
read (`packages/@softn/core/src/renderer/first-draw-memory.ts`):

- When it parses an app's first page, `SoftNRenderer` records
  `registry.firstDrawNames(firstScreen)` under the app's id. Once per app per
  page load, from the first page it draws; the record replaces the last
  one, so a component the app stopped using stops being started, and an
  empty list removes it. One map in localStorage (`softn:first-draw`), at
  most 50 apps, the least recently opened dropped first; storage that
  refuses remembers nothing.
- A host calls `preloadRememberedFirstDraw(appId)` as soon as it knows the
  id: the standalone shell right after its configuration, before the
  bundle's download; the PHP-served one when its pack arrives; SoftN Web
  when the bundle's digest is done, beside the archive's read. Only names
  registered `beforeFirstDraw` are started, whatever the record says.
- The renderer's own `firstDrawLoads` then joins what is already on its way.

A first visit has no record and loads as above. A wrong record costs a
light component loaded early; nothing waits on it.

A component behind a condition is not waited for, as it is not preloaded:
the branch that draws it draws its placeholder for as long as a fetch takes,
which from the precache is a frame or two.
`packages/@softn/core/test/first-draw-wait.test.tsx` holds the renderer to
the four cases: a light component held for and drawn without a placeholder,
one that never loads drawn after the cap, a heavy one drawn at once, and a
page with nothing pending drawn at once.

The other question a host asks of a document — "what could ever be
needed?" — is `collectAllComponentTags(doc)` in the same file: every element
tag anywhere in the template, each arm of an `#if`/`#elseif`/`#else` chain,
inline `if={…}` elements and their subtrees, `#each` bodies and fallbacks,
slot fallbacks and template-slot children. It is a superset of the
first-screen set by construction, and it is what the per-app offline install
below walks, because a route the user has not visited is exactly what has to
be there when the network is not.

## What a host shows while it waits

Core keeps one list of what the page is downloading to run its apps
(`packages/@softn/core/src/runtime/load-progress.ts`): the app's bundle, the
script engine, the torch package and each on-demand feature's chunk, by an
id that says what it is (`bundle:<address>`, `engine`, `torch`,
`components:<feature>`). The engine and the torch package are counted from a
clone of their response, so the response compiled is the one fetched and the
browser's code cache for it still applies; the engine's size is written into
core's build (`__SOFTN_ENGINE_BYTES__` in `tsup.config.ts`), because a server
that compresses it gives only the compressed length. A bundle is counted
through `readBoundedBody`'s `onChunk`, which is handed each piece's size. A
component chunk comes through `import()`, which says nothing of its bytes:
it is named, not measured. The list tells its listeners at most once a frame.

`@softn/runtime-shell/LoadProgress` shows it in two forms, in the standalone
shell and in SoftN Web:

- **On a loading screen** (`panel`), under the spinner: a bar for the bytes
  of the downloads whose size is known, and a line for each download ("Script
  engine 2.4 MB of 6.5 MB", "Tables Ready"). It appears once the wait has
  gone on 400 ms, counted from the screen's appearance or the oldest download
  still arriving, whichever was sooner; a load from the cache is over first.
- **Over an app already drawn** (`bar`): a thin line along the top of the
  app, under any permission bar, with a small label at its right ("Script
  engine · 34%"), while something it needs is still arriving after 400 ms. A
  page is drawn before the engine is ready (its taps wait for the script),
  and an app that draws its screen from its script's state is blank until
  then, so on a first visit over a slow connection this is what says the
  6.5 MB engine is still on its way; later it is a page's 3D arriving.

The bar is a `progressbar` with its value when the sizes are known and a
text of what is arriving; the lines are not a live region, so a screen
reader is not read every piece.

## The PWA policy (softn-web)

`apps/softn-web/vite.config.ts` defines three tiers. "The shell works
offline" is the first two; "this app works offline" is the third, and the
launcher says which of the two it is promising for each app.

1. **Shell precache.** The precache glob (`scripts/build/pwa.mjs`, which writes each
   app's manifest and bundles its `sw.js` on Workbox's runtime) sweeps `dist` for js, css, html, svg,
   png, woff2 and wasm, minus:
   `core-runtime/`, the demos, `assets/vendor-three-*.js`, the feature
   chunks `assets/{scene3d,charts,editors,smart,media,animation,pickers,games}-*.js`, the
   Three addon chunks — `GLTFLoader-*`, `OBJLoader-*`, `FBXLoader-*`,
   `STLLoader-*`, `OrbitControls-*`, `RoomEnvironment-*`, `SkeletonUtils-*`,
   `EffectComposer-*`, `RenderPass-*`, `UnrealBloomPass-*`, `OutputPass-*`,
   `ShaderPass-*`, `meshopt_decoder.module-*`, and the two helpers the
   post-processing chunks share, `Pass-*` and `CopyShader-*`
   (`threeAddonChunks` in the config) — and
   core's own on-demand modules that only some apps reach —
   `ai-manager-*`, `model-host-*`, `ai-gpu-compute-manager-*`,
   `xdb-sync-*` (~200 KB) and
   `xdb-server-sync-*` (`onDemandRuntimeChunks` in the config). What remains
   is the shell: the entry, its CSS and fonts, the scripting engine's wasm,
   the inflate worker (`zipWorker-*.js`), the XDB module every app opens
   (`xdb-*.js`, which is not a sync runtime) and the five light component
   groups (`assets/{controls,feedback,data,display,navigation}-*.js`,
   `componentGroupChunks` in `scripts/build/on-demand-chunks.mjs`). The
   groups left the entry on 2026-10-22 but not the precache: a page parses
   only the ones it draws, and an app that draws one works offline as it did.
   The build-graph test holds the precache to containing every file of the
   entry closure, the inflate worker, the XDB module and each group with its
   own static imports, and none of the feature, addon or on-demand chunks;
   it also checks each excluded name was actually emitted, so the ignore
   patterns cannot go stale silently. It holds each group to being an
   `import()` that nothing imports statically, as it does each feature. The build after this change
   precaches 44 entries, 6,315 KiB, down from 52 and 7,458 KiB (and 59 and
   9,816 KiB in 0.0.7).
2. **Runtime caches.** A route for same-origin `/assets/*.js` with
   `CacheFirst`, cache name `softn-feature-chunks`, 80 entries, 30 days,
   statuses 0 and 200: the feature chunks, `vendor-three`, the Three addon
   chunks and the on-demand runtime modules above, each fetched the first
   time a document or a script needs it. Hashed names are immutable, so a chunk fetched once is right
   for as long as the shell that references it, and a new release references
   new names. The precache route is registered first and keeps answering for
   the shell's own files. A second route, `softn-worker-assets`, holds the
   script worker's files under `/assets/core-runtime/` (js, wasm, json) with
   `NetworkFirst` (4 s network timeout, 40 entries, 30 days). The engine is
   not among them: the page compiles the shell's one precached copy and posts
   the module to every worker it starts, so `core-runtime/` carries none and
   the offline install fetches none. The worker's
   entry keeps one name across builds, `runtime/script-worker.js`, so a
   CacheFirst copy would outlive the release that made it and a worker from
   the previous release would be talking to this release's main thread.
   Online the current one is served and the copy refreshed; offline the
   copy answers.
3. **Per-app offline install** — `apps/softn-web/src/lib/offlineInstall.ts`,
   started by `App.tsx` in the background after an app opens while
   `navigator.onLine`, keyed by the app's cache record, aborted when its tab
   closes. `requiredFeatures(source)` parses the composed source (every
   page, every component the composer inlined) and keeps the tags of
   `collectAllComponentTags` that the default registry knows as loaders.
   `installAppOffline(app, { signal })` then:
   - waits for a service worker to control the page (`navigator.serviceWorker.ready`
     and the controller, up to 10 s: the runtime's worker claims pages as it
     activates) and refuses to count anything before one does — a fetch
     nothing keeps is not an install;
   - loads every required name through the registry (`load()`, or `retry()`
     for a name whose earlier attempt failed), waits for all of them, and
     lists under `missing` any whose state is not `loaded`;
   - for an app whose permission declaration requests `sync`, calls core's
     `preloadSyncRuntime()` (`packages/@softn/core/src/runtime/xdb-sync-preload.ts`),
     which performs the same `import('./xdb-sync')` the runtime's `startSync`
     does, so the same `xdb-sync-*` chunk is fetched; it appears in
     `features` as `sync-runtime`, and in `missing` if the import fails;
   - runs each loaded component's `offlineExtras` (`@softn/components/lazy`):
     what it fetches later than its chunk, when a page first uses it a
     particular way — every Three.js loader, the controls, the environment,
     the bloom pipeline and the Meshopt decoder for a `Scene3D`, whatever
     models it will be given; the decoder for a `QRReader`. A component
     whose extras fail is listed under `missing`;
   - fetches the workers' files the app can start (`workerEntries`) with
     `cache: 'reload'` through the `softn-worker-assets` route: the script
     worker for an app whose manifest sets `config.execution: "worker"`,
     the sandbox worker for one whose code names `sandbox`, the local-model
     worker for one that asked for `ai`. Each entry under
     `assets/core-runtime/runtime/`, every module it imports, statically or
     by a literal `import()` (read from the served text and followed, the
     way the browser will — the names change with every core build), and
     every file it names with `new URL('…', import.meta.url)` (the model
     worker's modules). Not the engine, which the page posts every worker;
     references that leave `core-runtime/` are not followed either.
     `workerAssets` is `installed`, `unavailable` or `not-needed`;
   - for an app that asked for `ai`, calls core's `preloadAIRuntime()`
     (`packages/@softn/core/src/runtime/ai-runtime-preload.ts`): the model
     host, the capability report and the GPU compute manager, each the chunk
     the runtime's own `import()` fetches; `ai-runtime` in `missing` if it fails;
   - reports `ready` only when `missing` is empty and the worker assets, if
     needed, are installed. The result is `{ ready, features, missing,
     workerAssets, optionalOnline, error? }`, marked `softn:offline-install:start`/`:end`.

   The outcome is written onto the cache record as
   `offline: { ready, features, optionalOnline, build, at }`
   (`setOfflineState` in `appCache.ts`), where `build` is `currentBuildId()`:
   `VITE_BUILD_ID` if a deployment sets one, else the hash in the entry
   script's file name (`assets/index-<hash>.js`), which changes with every
   deployment; a dev server is one build called `dev`. Setting it is a
   matter of the build's environment alone — `VITE_BUILD_ID=<id> npm run
   build -w @softn/web` — because Vite exposes every `VITE_`-prefixed
   variable on `import.meta.env` and replaces the read at build time;
   `vite.config.ts` does not (and need not) `define` it. A record whose build
   is not this one is stale — the chunks it fetched are the previous
   release's — and is installed again the next time the app opens online.
   One install runs per record at a time; a second open joins the first.

   **An AI model stays a download.** The runtime that runs one is installed
   with the app, and a model is kept in Cache Storage (`softn-models-v1`)
   the first time the app loads it, so an app that asked for `ai` is
   reported ready with `optionalOnline: ['ai']`: it runs offline with a
   model it has loaded before, a model shipped in its bundle among them, and
   needs a connection for one it has not. Server storage (`storage`) and
   the manifest's `config.server` sync are network features by nature and
   are not installed either; the shell precaches neither runtime.

The launcher shows one of three words on every cached app's card, as text
rather than a colour: **Offline ready** (the record's install succeeded
against this build; the tooltip notes when a model may still be a download),
**Installing…** (an install is running for it now), or **Needs connection**
(never installed, the install failed or was cut short, or it was installed
against an earlier build). The bundle bytes are in IndexedDB in every case;
the word is about the code that renders them.

What "offline" promises, then: the shell, always; and for an app marked
Offline ready, every route of it. An app not so marked opens offline only
if this browser happens to have rendered every feature it needs — the
pre-install state, in which an app whose game route needs Scene3D, opened
offline before that route was ever visited, shows the wrapper's local error
for the scene and the rest of the app.

The chunk names are Rolldown's — a dynamic chunk is named after the facade
module it starts at, so `dist/scene3d.js` becomes `assets/scene3d-<hash>.js`
and `three/examples/jsm/loaders/GLTFLoader.js` becomes
`assets/GLTFLoader-<hash>.js` — except `vendor-three`, which
`build.rolldownOptions.output.codeSplitting` names for Three's own build,
`node_modules/three/build/`, and nothing more. The addons are deliberately
outside that group: a group over the whole of `node_modules/three/` swept
every loader, the controls, the environment and the post-processing set
into one 740 KB chunk that the scene3d chunk imported statically, so a scene
with one glTF and no effects downloaded the bloom pass. The group names a
chunk that is already asynchronous; it is not what makes it so. What makes
it so is `registerRuntimeComponents()` reaching the feature through
`import()`, and Scene3D reaching each addon the same way; the build-graph
tests check the manifest lists each feature under some chunk's
`dynamicImports` and under nobody's `imports`, and each addon under the
scene3d chunk's `dynamicImports` and nowhere in its static closure.

The standalone host (`apps/softn-single`) has no service worker; it gets the
same manifest, the same `vendor-three` naming and its own build-graph test.

## Deploying: keep the previous release's assets for one release

A tab that was open before a deployment keeps running the old shell, and the
old shell asks for the old hashed feature chunks the first time a document
needs one. If the deployment deleted them, every such tab gets the
version-mismatch message above the moment it opens a scene, a chart or an
editor. It recovers with one click, but it should not have to.

`scripts/build/build-site.mjs` empties `dist/` and rebuilds it, so a deployment
that mirrors `dist/` exactly (`rsync --delete`, an S3 sync with deletion, a
container image) removes the previous release's `assets/`. Deployers should
retain the previous release's `web/assets/` and `single/assets/` files
alongside the new ones for at least one release — copy the old directory
over first, or sync without deletion and prune anything older than two
releases. Hashed names never collide, so the two sets coexist. The site build
script is not changed by this work; the requirement is documented here for
whoever runs the deployment.

## Adding a component

- A component nearly every app's first screen draws goes in
  `src/entries/essentials.ts`: export it and add it to
  `essentialComponents`. Every byte there is parsed by every app, so this is
  the exception; `minimal.ts` takes it with the rest.
- A light component that some apps draw goes in the group it belongs to
  (`controls`, `feedback`, `data`, `display` or `navigation`): export it,
  add it to the group's record, give it one `fromGroup(...)` line in
  `src/entries/lazy.ts`, and an export line in `minimal.ts` if its
  `export *` lines do not already cover the module (they cover the
  `display`, `feedback`, `navigation` and `data` folders whole; a form
  control needs a line of its own).
  `lazy-entries.test.ts` holds the six records disjoint and their union
  equal to `minimalComponents`.
- A component of an existing feature goes in that feature's entry record and
  gets one `fromFeature(...)` line in `src/entries/lazy.ts`. The key is
  checked against the entry's exports at compile time; the parity test
  catches a record entry with no loader line.
- A new feature is a new entry file, a tsup entry, a package.json export, a
  loader group in `lazy.ts`, a name in `featureChunks` in the web Vite config,
  and a name in `FEATURES` in both build-graph tests. Measure it first; a
  group under ~20 KB minified is not worth a request unless it is also rare.
