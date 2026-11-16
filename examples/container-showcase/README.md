# SoftN v2 Container Showcase ("Docker for Web Apps")

Demonstrates three isolated `<softn-app>` containers running simultaneously inside Dedicated ZIPP WASM Workers with **zero React** on the host:

1. **`compiled-kanban.softn`** — A Vite-style `dist/` web app zipped directly into `.softn` with **no `manifest.json`** and **no SoftN-specific code** (minified ES module chunks, intra-bundle `fetch()`, and HTML5 Canvas 2D rendering).
2. **`preact-fieldnotes.softn`** — A **~1.4 KB** zero-build TypeScript app importing `preact`, `preact/hooks`, `htm`, and `softn:db` directly from SoftN's hosted `/runtime/` catalog, plus auto-loaded `<softn-chart>` and `<softn-datagrid>` Custom Elements.
3. **`three-orbit.softn`** — A **~1.1 KB** 3D app importing `import * as THREE from 'three'` via SoftN's Split-Realm WebGL2 host (0 KB of Three.js inside the `.softn` bundle).

## Run

```bash
npm run build -w @softn/container
npm run demo:container
```

Then open <http://127.0.0.1:4830/>.
