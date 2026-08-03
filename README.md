# SoftN

**A dynamic, AI-friendly UI language and runtime for building applications -- desktop and web.**

SoftN is a complete system for creating modular, reactive UI applications using a custom Domain-Specific Language (DSL). It includes a visual builder, desktop runtime, web runtime, 90 built-in components, a sandboxed scripting engine, and a local-first P2P database -- all designed for rapid application development and AI code generation.

---

## Key Features

- **AI-Friendly DSL** -- Clean, consistent `.ui` syntax optimized for AI code generation
- **90 Built-in Components** -- Comprehensive library across 12 categories including 3D, charts, and animation
- **Smart Components** -- Auto-configured, data-driven components with search, sort, pagination, and CRUD
- **zipp Engine** -- Sandboxed JavaScript engine written in Rust, running in WebAssembly (no `eval`, no `new Function`)
- **XDB Database** -- Local-first database with CRDT-based P2P synchronization
- **Web Runtime** -- Browser-based `.softn` bundle runner with PWA support
- **Desktop Runtime** -- Tauri-based loader for running `.softn` bundles natively
- **Visual Builder** -- Full IDE for visually creating SoftN applications
- **Bundle System** -- Portable `.softn` files (ZIP archives) for distribution
- **Theme System** -- Built-in light/dark theme support with CSS custom properties
- **3D Support** -- Three.js integration with Scene3D component (GLTF, OBJ, FBX, STL)
- **Animation** -- Built-in animation components (draggable, sortable, typewriter, marquee)

---

## Repository Structure

```
softn.com/
+-- packages/
|   +-- @softn/
|       +-- core/              # Core engine (parser, renderer, runtime)
|       +-- components/        # Built-in component library (90 components)
|       +-- vite-plugin/       # Vite plugin for .softn files
+-- apps/
|   +-- softn-site/            # softn.com landing page
|   +-- softn-web/             # Web runtime (browser-based bundle runner)
|   +-- softn-studio/          # AI studio (brief -> blueprint -> app)
|   +-- softn-builder/         # Visual IDE / builder
|   +-- softn-loader/          # Desktop runtime (Tauri)
|   +-- softn-server/          # Rust host for `.logic` server routes and XDB sync
|   +-- demo/                  # Demo applications
+-- scripts/                   # dev-all and site assembly
+-- .github/workflows/         # CI/CD
```

### Related Repositories

| Repository | Description |
|-----------|-------------|
| [zipp.org](https://github.com/f2i-com/zipp.org) | zipp -- the JavaScript engine `.logic` runs on (Rust to WebAssembly) |
| [xdb.org](https://github.com/f2i-com/xdb.org) | XDB database (Tauri/Rust -- SQLite + libp2p + Y-CRDT) |

---

## Technology Stack

| Layer | Technology |
|-------|-----------|
| UI Rendering | React 18/19 |
| Language | TypeScript 5.3+ |
| Desktop Framework | Tauri 2.0+ |
| Scripting Engine | zipp (NaN-boxed register VM with inline caches, Rust compiled to WebAssembly) |
| Database (Web) | IndexedDB + Yjs + y-webrtc |
| Database (Desktop) | SQLite + Y-CRDT + libp2p |
| Build Tooling | Vite 5+ / tsup |
| State Management | React Context + Zustand (builder) |
| 3D Graphics | Three.js |

---

## Quick Start

```bash
# Clone the repository
git clone https://github.com/f2i-com/softn.com.git
cd softn.com

# Install exactly the versions package-lock.json pins
npm ci

# Build the packages the apps import, in dependency order
npm run build:packages

# Start the landing page, the runtime, the builder and the studio together
npm run dev
```

| | |
|-|-|
| `http://localhost:1421` | **Landing page** — start here. Runs the demos in place and links to the rest. |
| `http://localhost:1420` | **Web runtime** — drag-drop a `.softn` bundle, or open one with `?open=/demos/SnakeGame.softn` |
| `http://localhost:1422` | **Builder** |
| `http://localhost:1423` | **Studio** |

If a port is already taken, `npm run dev` moves that app to the next free one and
tells the landing page where it went. To run a single app instead, use
`npm run dev:site`, `dev:web`, `dev:builder` or `dev:studio`.

---

## Architecture Overview

```
.softn/.ui Source
      |
      v
  +-------+     +---------+     +----------+     +----------+
  | Lexer | --> | Parser  | --> | Renderer | --> |  React   |
  +-------+     +---------+     +----------+     +----------+
   Tokens         AST             Elements         Display
                                    |
                                    v
                            Component Registry
                           (90 built-in + custom)

.logic Source
      |
      v
  +-------+     +---------+     +----------+     +----------+
  | Lexer | --> | Parser  | --> | Compiler | --> | zipp VM  |
  +-------+     +---------+     +----------+     +----------+
   Tokens         AST            Bytecode        Register-based
                                                 execution (Rust)
```

### State Flow

```
Script VM Globals     <--sync-->  React componentState  -->  Render Context  -->  UI
         |                                                        ^
         v                                                        |
    VM Bridges (db, localStorage, window, navigator)         Expression eval
```

Before each script function call, all React state is synced to VM globals. After the call returns, VM globals are synced back to React state, triggering a re-render.

---

## SoftN Language Syntax

### Quick Example

```xml
<logic>
  let count = 0

  function increment() {
    count = count + 1
  }
</logic>

<App theme="dark">
  <Stack direction="vertical" gap="md" padding="lg">
    <Heading level={1}>Counter</Heading>
    <Text>Count: {count}</Text>
    <Button variant="primary" @click={increment}>Increment</Button>
  </Stack>
</App>
```

### Props, Events, and Data Binding

```xml
// String and expression props
<Button variant="primary" size="md">Click Me</Button>
<Text color={isDark ? "white" : "black"}>{message}</Text>

// Event handlers
<Button @click={handleClick}>Click</Button>

// Two-way binding
<Input :bind={username} placeholder="Enter name" />

// Conditional rendering
#if (isLoggedIn)
  <Dashboard />
#else
  <LoginForm />
#end

// Loop rendering
#each (task in tasks)
  <TaskCard task={task} />
#empty
  <Text>No tasks yet!</Text>
#end
```

---

## Component Library (90 Components)

| Category | Count | Components |
|----------|-------|-----------|
| Layout | 15 | `App`, `Box`, `Stack`, `Grid`, `Card`, `Container`, `Center`, `Layout`, `Header`, `Content`, `Section`, `Sidebar`, `Split`, `Spacer`, `Divider` |
| Form | 12 | `Button`, `Input`, `TextArea`, `Select`, `Checkbox`, `Radio`, `Switch`, `Form`, `Slider`, `DatePicker`, `ColorPicker`, `FileChooser` |
| Display | 9 | `Text`, `Heading`, `Badge`, `Tag`, `Avatar`, `Progress`, `Spinner`, `Image`, `Icon` |
| Feedback | 6 | `Alert`, `Modal`, `Toast`, `Drawer`, `Popover`, `EmptyState` |
| Data | 6 | `List`, `ListItem`, `Table`, `DataGrid`, `TreeView`, `Pagination` |
| Navigation | 4 | `Tabs`, `Breadcrumb`, `Menu`, `NavItem` |
| Utility | 12 | `Accordion`, `Collapse`, `Tooltip`, `Loop`, `PixelGrid`, `PixelCanvas`, `QRCode`, `QRReader`, `Camera`, `Microphone`, `AudioStream`, `DPad` |
| Charts | 6 | `LineChart`, `BarChart`, `PieChart`, `AreaChart`, `RadarChart`, `GaugeChart` |
| Animation | 9 | `AnimatedBox`, `AnimatedNumber`, `Marquee`, `Typewriter`, `Draggable`, `SortableList`, `PanView`, `Sprite`, `TileMap` |
| Editors | 3 | `CodeEditor`, `MarkdownEditor`, `RichTextEditor` |
| 3D | 1 | `Scene3D` (Three.js with GLTF, OBJ, FBX, STL) |
| Smart | 7 | `SmartGrid`, `SmartView`, `SmartForm`, `SmartCards`, `SmartList`, `SmartTimeline`, `SmartStats` |

---

## Smart Components

Auto-configured, data-driven components:

```xml
<SmartGrid
  collection="clients"
  columns="name, email, phone, visits"
  searchable sortable pageable
  editable deletable
  onEdit={editClient}
  onDelete={deleteClient}
/>

<SmartForm
  collection="clients"
  fields="name:text:required, email:email:required, phone:text"
  onSaved={closeModal}
  submitText="Add Client"
/>
```

---

## Bundle Format (.softn)

SoftN applications are distributed as `.softn` bundles (ZIP archives).

```
MyApp.softn (ZIP archive)
+-- manifest.json          # App metadata and configuration
+-- permission.json        # Capabilities the app needs, and what the user approves
+-- ui/main.ui             # Main entry point
+-- logic/main.logic       # Application logic
+-- server/*.logic         # Optional: routes run by softn-server, not the browser
+-- xdb/*.xdb              # Collection data (JSON)
+-- assets/*               # Images, CSS, etc.
```

`permission.json` is not optional in practice. The runtime denies every gated
capability — network, camera, microphone, filesystem, AI, GPU and peer-to-peer sync — to a
bundle that does not declare it, and the consent prompt is built from what it
declares, so an app that ships without one can run but cannot reach the host:

```json
{ "permissions": { "net": { "enabled": true, "allowed_hosts": ["api.example.com"] } } }
```

An app's identity is a digest of its bundle, not the name in its manifest — two
bundles calling themselves the same thing are two apps, with separate databases
and separate grants.

---

## Scripting Engine

`.logic` files are JavaScript, executed by [zipp](https://github.com/f2i-com/zipp.org) -- a clean-sheet
JavaScript engine written in Rust and compiled to WebAssembly.

```
Source Code -> Lexer -> Parser -> Compiler -> Bytecode -> Register-based VM (Rust/WASM)
```

- Real JavaScript: classes, async/await, destructuring, spread/rest, closures, regex
- Rust + WASM register VM with per-call-site inline caches, via `wasm-bindgen`
- True sandboxing: the script reaches nothing the engine preamble does not hand it
- Host modules: `db`, `localStorage`, `window`, `navigator`, `host`, plus the `softn.*` async APIs

The compiled engine is committed at `packages/@softn/core/wasm-zipp/`, so building SoftN needs no
Rust toolchain. To pick up a new engine revision from a `zipp-lang` checkout beside this repo:

```bash
npm run build:zipp-wasm -w @softn/core   # needs rustup + wasm-pack
```

The engine is selected in one place -- `packages/@softn/core/src/runtime/vm-adapter.ts`.

```javascript
let clients = []

function _init() {
  clients = db.query("clients")
}

function addClient(name, email) {
  db.create("clients", { name: name, email: email })
  clients = db.query("clients")
}
```

---

## XDB Database

Local-first, reactive database with P2P synchronization. Source: [xdb.org](https://github.com/f2i-com/xdb.org).

```javascript
let client = db.create("clients", { name: "John", email: "john@example.com" })
let allClients = db.query("clients")
db.update(client.id, { phone: "555-1234" })
db.delete(client.id)
await db.startSync("my-room-name")
```

All CRUD operations are **synchronous** (XDB caches everything in memory).

---

## Audio

`softn.audio` plays sound from a `.logic` script. Paths are resolved inside the
bundle, the same way `asset()` resolves them for a template.

```javascript
softn.audio.play("assets/pickup.wav")
softn.audio.play("assets/theme.mp3", { volume: 0.4, loop: true }, function (r) {
  themeHandle = r.handle
})
softn.audio.setVolume(0.5)      // scales what is playing now, and what comes next
softn.audio.stop(themeHandle)
softn.audio.stopAll()
```

No capability is declared for it: a template can already write
`<audio src={asset("…")} autoPlay />` with none, so gating the API and not the
tag would inconvenience the tidier route and secure nothing. Sound reads
nothing and sends nothing, and everything an app started stops when it closes.

Browsers refuse to make noise before the user has interacted with the page. A
one-shot that lands in that window reports `{ played: false, blocked: true }`
rather than throwing — playing it later would be a sound effect at the wrong
moment. Anything `loop`ing is treated as a soundtrack and starts on the first
click or keystroke instead.

---

## Microphone

Listening, unlike playing, is gated: `mic` has to be in `permission.json`, and
the consent prompt names it. The comment above the audio API argues that sound
is a nuisance rather than a disclosure because it "reads nothing, sends
nothing" — a microphone is the thing that fails that test.

```json
{ "permissions": { "mic": { "enabled": true, "maxSeconds": 20 } } }
```

There are two routes. The `<Microphone>` component puts a level meter and a
record button on screen:

```xml
<Microphone
  mode="clip"          // clip | live | level
  sampleRate={48000}
  processing={false}
  maxSeconds={20}
  onCapture={handleClip}   // { dataUrl, duration, sampleRate, sampleCount }
  onSamples={handleWindow} // live mode: { samples, sampleRate, timestamp }
  onLevel={handleLevel}    // { level, peak, clipping }
/>
```

And `softn.mic.*` records without anything visible:

```javascript
softn.mic.record({ seconds: 5, sampleRate: 48000 }, function (r) {
  if (r.recorded) softn.audio.play(r.dataUrl)
})
softn.mic.stop()          // end it early; the record callback still fires
```

Both hand back **uncompressed 16-bit WAV** as a `data:` URL, not MediaRecorder's
Opus. Opus is a speech codec: it reproduces what a voice sounds like, not what
the waveform was. That is fine for a voice note and useless for anything
treating sound as a signal — level analysis, pitch detection, or data over
audio. A WAV is what came off the microphone, so it can be played, saved, or
taken apart sample by sample.

`processing` is the one switch for the browser's echo cancellation, noise
suppression and automatic gain control. It defaults to on, which is right for
speech. Turn it off for anything measuring the sound rather than listening to
it: all three are trained on speech and treat a steady tone as noise to remove,
so a level meter reads low, a tuner drifts, and data sent over audio arrives as
silence.

`sampleRate` is a request, not a promise. The graph is built at the rate asked
for so the samples really are resampled, but hardware and browser both get a
say — every callback reports the rate actually in use, and code that cares
about absolute frequencies must read that rather than assume.

Like `<Camera>`, the component opens the device itself and the browser's own
permission prompt is what stands in front of the hardware; the `mic` capability
gates the scripting API and is what the consent dialog shows the user.

---

## Pixels and PCM

Two primitives for scripts that generate a signal rather than arrange widgets.
Neither is gated: both are sinks, and a script that can already draw a `<Box>`
or play an `<audio>` tag gains nothing it did not have.

`<PixelCanvas>` is the dense-bitmap counterpart to `<PixelGrid>`. PixelGrid
renders sparse `{x, y, color}` cells as DOM nodes, which is right for a board of
a few hundred squares and hopeless for a photograph — 160x144 is 23,040 divs and
around 54ms a frame before the browser paints. PixelCanvas keeps one `ImageData`
and one canvas, pulls frames through a callable prop on its own
`requestAnimationFrame` loop, and never re-renders React.

```xml
<PixelCanvas
  width={160} height={144}
  palette={shades}         // present => 1 byte per pixel; absent => RGBA
  fit="contain"            // fill the box, or "pixel" for whole-number scaling
  getFrame={nextFrame}     // -> { pixels: "<base64>", ... }, or null to hold
  @fps={report}
/>
```

`fit` is the one choice worth making deliberately. `"pixel"` takes the largest
whole multiple that fits and centres it, so every source pixel is the same size
— what pixel art needs, at the cost of a margin. `"contain"` fills the box and
lets the factor go fractional, which is right when filling the frame matters
more than exact geometry.

`<AudioStream>` is the output side of `softn.audio`. That API plays *files*;
this one plays a waveform a script is still generating, which `.logic` cannot do
by itself — it has no `AudioContext`, no `AudioWorklet` and no `Blob`.

```xml
<AudioStream
  getSamples={nextBlock}   // -> { pcm: "<base64>", frames, rate, ... }
  sampleRate={48000} channels={2} format="i16"
  bufferMs={90} muted={muted}
  @ready={started}         // reports the rate the browser ACTUALLY gave
/>
```

It owns the graph and schedules successive buffers at explicit start times so
playback is gapless. `sampleRate` is a request: hardware and browser both get a
say, so `@ready` reports what was really allocated and a script that cares about
pitch must read it rather than assume. The `frames` field of each block is
authoritative too — at 48kHz a 59.7275Hz console frame is 803.65 samples, so the count
genuinely varies and a caller that assumes a constant drifts.

Both are demonstrated by **Pocket**, an 8-bit handheld emulator: `.logic` runs the CPU,
PPU, APU and mappers, PixelCanvas shows the screen and AudioStream is the
speaker.

---

## Applications

| App | Description |
|-----|-------------|
| **softn-site** | The softn.com landing page. Runs the demo bundles in an embedded runtime frame |
| **softn-web** | Browser-based `.softn` runtime with multi-tab, URL routing and `?open=` deep links. Installable PWA |
| **softn-studio** | Brief to blueprint to app, against whichever model provider you configure. Installable PWA |
| **softn-builder** | Visual IDE with drag-and-drop editor, live preview, bundle export. Installable PWA |
| **softn-loader** | Tauri desktop runtime with `.softn` file association and XDB/SQLite |

The three browser apps are installable PWAs: each ships a web app manifest and a
service worker that precaches the runtime, the component library and the
WebAssembly engine, so they keep working with the network off.

### Deploying softn.com

```bash
npm run build:site
```

Builds the packages, then each app with the `VITE_BASE` matching where it will be
served, and assembles a single uploadable tree:

```
dist/            landing page
dist/demos/      .softn bundles
dist/web/        web runtime
dist/builder/    visual builder
dist/studio/     AI studio
```

### Demos

| Demo | Description |
|------|-------------|
| **GlamourStudio** | Salon management app |
| **TheOffice** | Office simulation with AI character interactions |
| **SnakeGame** | Classic snake game using `PixelGrid` and `Loop` |
| **MazeEscape3D** | 3D maze game using `Scene3D` |
| **WarbleWire** | The QXW acoustic transport — text becomes synthetic birdsong and is decoded back, over the air through `Microphone` |
| **Pocket** | An 8-bit handheld console emulator. The CPU, PPU, APU, timer and MBC1/2/3/5 mappers are all `.logic`; `PixelCanvas` is the screen and `AudioStream` is the speaker. Runs commercial cartridges at 60fps with sound, save states and battery-backed saves |

---

## Security Model

| Layer | Protection |
|-------|-----------|
| VM Sandboxing | zipp WASM VM -- no `eval()`, no `new Function()`, no host access |
| Instruction Limits | **Server only.** `softn-server` builds zipp with `instrument`, giving it a step budget and an abort flag. The browser adapter has no budget: a runaway loop wedges the tab it runs in |
| Bridge Isolation | `window` and `navigator` are controlled bridge objects |
| localStorage | App-scoped prefix `softn:{appId}:` prevents cross-app leakage |
| ZIP Extraction | Rejects `../`, absolute paths, null bytes, Windows drive letters |

---

## Development

### Prerequisites

- Node.js 20.19+ (Vite 8's floor)
- npm
- Rust + Cargo (for Tauri apps and WASM compilation)

### Setup

```bash
npm ci
npm run build      # packages in dependency order, then every app
```

`npm run clean` removes build output and stale Vite caches. To remove `node_modules`
as well, use `npm run clean -- --deps` — the bare `--` is what stops npm from eating
the flag before the script sees it.

### Running Apps

```bash
# Everything web, on one command
npm run dev

# Or one at a time
npm run dev:site      # landing page   1421
npm run dev:web       # web runtime    1420
npm run dev:builder   # visual builder 1422
npm run dev:studio    # AI studio      1423

# Desktop loader (requires Rust)
npm run dev:desktop

# Builder in its Tauri shell (requires Rust)
cd apps/softn-builder && npm run tauri dev
```

Rust is needed for the two Tauri shells, for `softn-server` (the host that runs a
bundle's `server/` routes and backs XDB sync), and for recompiling the scripting
engine. The four browser apps — the landing page, the runtime, the builder and
Studio — need Node alone.

### Key File Paths

| File | Purpose |
|------|---------|
| `packages/@softn/core/src/parser/` | Lexer and AST parser |
| `packages/@softn/core/src/renderer/` | AST to React renderer and component registry |
| `packages/@softn/core/src/runtime/script-runtime.ts` | Script runtime (state sync, bridges, host calls) |
| `packages/@softn/core/src/runtime/vm-adapter.ts` | Which engine `.logic` runs on |
| `packages/@softn/core/src/runtime/xdb.ts` | XDB database service |
| `packages/@softn/core/src/bundle/bundle.ts` | ZIP bundle reader |
| `packages/@softn/core/src/loader/SoftNRenderer.tsx` | Main renderer component |
| `packages/@softn/components/src/registry.ts` | Built-in component registration |

---

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) and
[NOTICE](NOTICE).

---

## Credits

Built with [zipp](https://github.com/f2i-com/zipp.org), [XDB](https://github.com/f2i-com/xdb.org), [Tauri](https://tauri.app), [React](https://react.dev), [Three.js](https://threejs.org), and [Yjs](https://yjs.dev).
