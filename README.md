# SoftN

**A dynamic, AI-friendly UI language and runtime for building applications -- desktop and web.**

SoftN is a complete system for creating modular, reactive UI applications using a custom Domain-Specific Language (DSL). It includes a visual builder, desktop runtime, web runtime, 86 built-in components, a sandboxed scripting engine, and a local-first P2P database -- all designed for rapid application development and AI code generation.

---

## Key Features

- **AI-Friendly DSL** -- Clean, consistent `.ui` syntax optimized for AI code generation
- **86 Built-in Components** -- Comprehensive library across 12 categories including 3D, charts, and animation
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
|       +-- components/        # Built-in component library (86 components)
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
                           (86 built-in + custom)

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

## Component Library (86 Components)

| Category | Count | Components |
|----------|-------|-----------|
| Layout | 15 | `App`, `Box`, `Stack`, `Grid`, `Card`, `Container`, `Center`, `Layout`, `Header`, `Content`, `Section`, `Sidebar`, `Split`, `Spacer`, `Divider` |
| Form | 12 | `Button`, `Input`, `TextArea`, `Select`, `Checkbox`, `Radio`, `Switch`, `Form`, `Slider`, `DatePicker`, `ColorPicker`, `FileChooser` |
| Display | 9 | `Text`, `Heading`, `Badge`, `Tag`, `Avatar`, `Progress`, `Spinner`, `Image`, `Icon` |
| Feedback | 6 | `Alert`, `Modal`, `Toast`, `Drawer`, `Popover`, `EmptyState` |
| Data | 6 | `List`, `ListItem`, `Table`, `DataGrid`, `TreeView`, `Pagination` |
| Navigation | 4 | `Tabs`, `Breadcrumb`, `Menu`, `NavItem` |
| Utility | 9 | `Accordion`, `Collapse`, `Tooltip`, `Loop`, `PixelGrid`, `QRCode`, `QRReader`, `Camera`, `DPad` |
| Charts | 6 | `LineChart`, `BarChart`, `PieChart`, `AreaChart`, `RadarChart`, `GaugeChart` |
| Animation | 8 | `AnimatedBox`, `AnimatedNumber`, `Marquee`, `Typewriter`, `Draggable`, `SortableList`, `Sprite`, `TileMap` |
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
+-- ui/main.ui             # Main entry point
+-- logic/main.logic       # Application logic
+-- xdb/*.xdb              # Collection data (JSON)
+-- assets/*               # Images, CSS, etc.
```

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

Rust is only needed for the two Tauri shells and for recompiling the scripting
engine. The four browser apps need Node alone.

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
