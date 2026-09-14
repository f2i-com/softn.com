# The packages

`packages/@softn/*` is what the [apps](../apps/README.md) are built from: the
engine, the components, the contracts they share, and the look. None of them
is an application; each is imported by several.

| Package | In one line | Used by |
| --- | --- | --- |
| [`core/`](@softn/core) | The engine: the `.ui` parser, the renderer, the `.logic` runtime on the vendored ZIPP WebAssembly engine (`wasm-zipp/`), XDB records and sync, bundle loading, the FormLogic starter adapter | Every runtime and editor |
| [`components/`](@softn/components) | The built-in component library (layout, forms, data, charts, audio, 3D, smart components) registered into core's renderer | Every runtime and editor |
| [`bundle-format/`](@softn/bundle-format) | The `.softn` contract without the engine: the archive reader, the inspector, `permission.json` declarations, the page-to-page hand-off and bundle URL rules | Core (re-exported), the site, the editors, the web runtime |
| [`editor-shared/`](@softn/editor-shared) | What Builder and Studio share and neither owns: hand-off to the runtime and publish page, opening a bundle from a same-origin link, modal keyboard ownership, the FormLogic editor channel | Builder, Studio |
| [`brand/`](@softn/brand) | The one look the apps share: tokens, fonts, the theme switch, the product bar, the site URL rules | Site, web runtime, Builder, Studio, loader, the docs |
| [`vite-plugin/`](@softn/vite-plugin) | A Vite plugin that imports `.ui` files as SoftN sources in an ordinary web project | Anyone building with SoftN outside these apps |

Build order matters for the two that produce `dist/`: `npm run build:packages`
builds `core`, then `components`, then `vite-plugin`. The others are consumed
as TypeScript sources through workspace links. `bundle-format` is inlined into
core's published build so core stays self-contained.

A change to `bundle-format` or to core's bundle loading is a change to the
contract every existing `.softn` file relies on: keep old bundles opening
exactly as before and add a test that pins it.

`core/wasm-zipp/` is the compiled engine with its `SOURCE.json` provenance;
FormLogic vendors the same release and checks the digest, so update it in
both places together (see `docs/engineering/FORMLOGIC_INTEGRATION.md`).
