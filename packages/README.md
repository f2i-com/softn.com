# The packages

`packages/@softn/*` is what the [apps](../apps/README.md) are built from: the
engine, the components, the contracts they share, and the look. None of them
is an application; each is imported by several.

| Package | In one line | Used by |
| --- | --- | --- |
| [`core/`](@softn/core) | The engine: the `.ui` parser, the renderer, the `.logic` runtime on the ZIPP WebAssembly engine (`wasm-zipp/`, installed from a ZIPP release), XDB records and sync, bundle loading, the FormLogic starter adapter | Every runtime and editor |
| [`components/`](@softn/components) | The built-in component library (layout, forms, data, charts, audio, 3D, smart components) registered into core's renderer | Every runtime and editor |
| [`bundle-format/`](@softn/bundle-format) | The `.softn` contract without the engine: the archive reader, the inspector, `permission.json` declarations, the page-to-page hand-off and bundle URL rules | Core (re-exported), the site, the editors, the web runtime |
| [`editor-shared/`](@softn/editor-shared) | What Builder and Studio share and neither owns: hand-off to the runtime and publish page, opening a bundle from a same-origin link, modal keyboard ownership, the FormLogic editor channel | Builder, Studio |
| [`runtime-shell/`](@softn/runtime-shell) | What every runtime does with a bundle before the app appears: unpacking and composing it (`bundleProcessor`), warming the ZIP worker, and the frame bar drawn over a running app | Web runtime, the single-app shell |
| [`single-shell/`](@softn/single-shell) | The single-app shell both single-app hosts render: the unbranded page, its configuration, favicon, loading and the assembly of one bundle into a running app | The static single app, the private single app |
| [`test-utils/`](@softn/test-utils) | Test helpers shared across workspaces (the fake IndexedDB), so no test imports another workspace's files by path | Core, site and Studio tests |
| [`brand/`](@softn/brand) | The one look the apps share: tokens, fonts, the theme switch, the product bar, the site URL rules | Site, web runtime, Builder, Studio, loader, the docs |
| [`vite-plugin/`](@softn/vite-plugin) | A Vite plugin that imports `.ui` files as SoftN sources in an ordinary web project | Anyone building with SoftN outside these apps |

Build order matters for the two that produce `dist/`: `npm run build:packages`
builds `core`, then `components`, then `vite-plugin`. The others are consumed
as TypeScript sources through workspace links. `bundle-format` is inlined into
core's published build so core stays self-contained.

A change to `bundle-format` or to core's bundle loading is a change to the
contract every existing `.softn` file relies on: keep old bundles opening
exactly as before and add a test that pins it.

`core/wasm-zipp/` is the compiled engine, generated rather than committed: core's
build and test hooks (or `npm run fetch:zipp`) install the ZIPP release that
`apps/softn-host-rust/Cargo.toml`'s `zipp-vm` tag names and verify it against
that release's `SHA256SUMS`, with its `SOURCE.json` provenance. FormLogic takes
the same install from the release archive's `zipp/` folder (see
`docs/engineering/FORMLOGIC_INTEGRATION.md`).

What FormLogic embeds from these packages (the hosted frame built from `apps/formlogic-host`, Builder and Studio as hosted editors, the native runtime and core's starter adapter) ships already built as `softn-formlogic-runtime-<tag>.zip` on every release; FormLogic fetches that instead of building the packages itself.
