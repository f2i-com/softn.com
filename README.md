# SoftN

**A dynamic, AI-friendly UI language and runtime for building applications -- desktop and web.**

SoftN is a complete system for creating modular, reactive UI applications using a custom Domain-Specific Language (DSL). It includes a visual builder, desktop runtime, web runtime, 78 built-in components, a sandboxed scripting engine, and a local-first P2P database -- all designed for rapid application development and AI code generation.

---

## Key Features

- **AI-Friendly DSL** -- Clean, consistent `.ui` syntax optimized for AI code generation
- **78 Built-in Components** -- Comprehensive library across 12 categories including 3D, charts, and animation
- **Smart Components** -- Auto-configured, data-driven components with search, sort, pagination, and CRUD
- **FormLogic VM** -- Sandboxed bytecode-compiled scripting engine written in Rust, running in WebAssembly (no `eval`, no `new Function`)
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
|       +-- components/        # Built-in component library (78 components)
|       +-- vite-plugin/       # Vite plugin for .softn files
+-- apps/
|   +-- softn-web/             # Web runtime (browser-based bundle runner)
|   +-- softn-loader/          # Desktop runtime (Tauri)
|   +-- softn-builder/         # Visual IDE / builder
|   +-- demo/                  # Demo applications
+-- .github/workflows/         # CI/CD
```

### Related Repositories

| Repository | Description |
|-----------|-------------|
| [formlogic-rust](https://github.com/f2i-com/formlogic-rust) | FormLogic scripting engine (Rust to WebAssembly) |
| [xdb.org](https://github.com/f2i-com/xdb.org) | XDB database (Tauri/Rust -- SQLite + libp2p + Y-CRDT) |

---

## Technology Stack

| Layer | Technology |
|-------|-----------|
| UI Rendering | React 18/19 |
| Language | TypeScript 5.3+ |
| Desktop Framework | Tauri 2.0+ |
| Scripting Engine | FormLogic-Rust (register-based bytecode VM compiled to WebAssembly) |
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

# Install dependencies
npm install

# Build all packages (core must build before apps)
npm run build

# Run the web runtime (dev server on port 1422)
cd apps/softn-web
npm run dev
```

Open `http://localhost:1422` and drag-drop a `.softn` bundle to run it.

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
                           (78 built-in + custom)

.logic Source
      |
      v
  +-------+     +---------+     +----------+     +----------+
  | Lexer | --> | Parser  | --> | Compiler | --> | WASM VM  |
  +-------+     +---------+     +----------+     +----------+
   Tokens         AST            Bytecode        Register-based
                                                 execution (Rust)
```

### State Flow

```
FormLogic VM Globals  <--sync-->  React componentState  -->  Render Context  -->  UI
         |                                                        ^
         v                                                        |
    VM Bridges (db, localStorage, window, navigator)         Expression eval
```

Before each FormLogic function call, all React state is synced to VM globals. After the call returns, VM globals are synced back to React state, triggering a re-render.

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

## Component Library (78 Components)

| Category | Count | Components |
|----------|-------|-----------|
| Layout | 15 | `App`, `Box`, `Stack`, `Grid`, `Card`, `Container`, `Center`, `Layout`, `Header`, `Content`, `Section`, `Sidebar`, `Split`, `Spacer`, `Divider` |
| Form | 11 | `Button`, `Input`, `TextArea`, `Select`, `Checkbox`, `Radio`, `Switch`, `Form`, `Slider`, `DatePicker`, `ColorPicker` |
| Display | 8 | `Text`, `Heading`, `Badge`, `Tag`, `Avatar`, `Progress`, `Spinner`, `Image` |
| Feedback | 6 | `Alert`, `Modal`, `Toast`, `Drawer`, `Popover`, `EmptyState` |
| Data | 6 | `List`, `ListItem`, `Table`, `DataGrid`, `TreeView`, `Pagination` |
| Navigation | 4 | `Tabs`, `Breadcrumb`, `Menu`, `NavItem` |
| Utility | 5 | `Accordion`, `Collapse`, `Tooltip`, `Loop`, `PixelGrid` |
| Charts | 6 | `LineChart`, `BarChart`, `PieChart`, `AreaChart`, `RadarChart`, `GaugeChart` |
| Animation | 6 | `AnimatedBox`, `AnimatedNumber`, `Marquee`, `Typewriter`, `Draggable`, `SortableList` |
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

## FormLogic Scripting Engine

Sandboxed JavaScript-like language written in Rust, compiled to WebAssembly. Source: [formlogic-rust](https://github.com/f2i-com/formlogic-rust).

```
Source Code -> Lexer -> Parser -> Compiler -> Bytecode -> Register-based VM (Rust/WASM)
```

- JavaScript-like syntax with classes, async/await, destructuring, spread/rest
- Rust + WASM register-based VM via `wasm-bindgen`
- True sandboxing with configurable instruction limits and wall-clock timeouts
- Custom modules: `db`, `localStorage`, `console`, `Math`, `JSON`, `Date`

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
| **softn-web** | Browser-based `.softn` runtime with PWA support, multi-tab, URL routing |
| **softn-loader** | Tauri desktop runtime with `.softn` file association and XDB/SQLite |
| **softn-builder** | Visual IDE with drag-and-drop editor, live preview, bundle export |

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
| VM Sandboxing | FormLogic bytecode VM -- no `eval()`, no `new Function()`, no host access |
| Instruction Limits | Configurable max instructions and wall-clock timeouts |
| Bridge Isolation | `window` and `navigator` are controlled bridge objects |
| localStorage | App-scoped prefix `softn:{appId}:` prevents cross-app leakage |
| ZIP Extraction | Rejects `../`, absolute paths, null bytes, Windows drive letters |

---

## Development

### Prerequisites

- Node.js 18+
- npm
- Rust + Cargo (for Tauri apps and WASM compilation)

### Setup

```bash
npm install
npm run build      # Build all packages
```

### Running Apps

```bash
# Web runtime (port 1422)
cd apps/softn-web && npm run dev

# Desktop loader (requires Rust)
cd apps/softn-loader && npm run tauri dev

# Visual builder (requires Rust)
cd apps/softn-builder && npm run tauri dev
```

### Key File Paths

| File | Purpose |
|------|---------|
| `packages/@softn/core/src/parser/` | Lexer and AST parser |
| `packages/@softn/core/src/renderer/` | AST to React renderer and component registry |
| `packages/@softn/core/src/runtime/formlogic.ts` | FormLogic script runtime |
| `packages/@softn/core/src/runtime/xdb.ts` | XDB database service |
| `packages/@softn/core/src/bundle/bundle.ts` | ZIP bundle reader |
| `packages/@softn/core/src/loader/SoftNRenderer.tsx` | Main renderer component |
| `packages/@softn/components/src/registry.ts` | Built-in component registration |

---

## License

MIT

---

## Credits

Built with [FormLogic-Rust](https://github.com/f2i-com/formlogic-rust), [XDB](https://github.com/f2i-com/xdb.org), [Tauri](https://tauri.app), [React](https://react.dev), [Three.js](https://threejs.org), and [Yjs](https://yjs.dev).
