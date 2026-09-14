# softn.com: design and structure audit (15 September 2026)

Method: measured with `find`/`wc`/`grep`/`diff`/`md5sum`, `npx tsc --noEmit` (root), `npx eslint -f json`, and reading of `package.json`, workflows and the largest modules. Excluded: `node_modules`, `dist`, `vendor`, `docs/audit-*.md`. Nothing was modified.

## 1. The architecture as it is

npm workspaces: `packages/@softn/*`, `apps/*`, `e2e`.

| Workspace | Package | Role | Depends on (in repo) |
| --- | --- | --- | --- |
| packages/@softn/core | `@softn/core` (public) | parser, renderer, script runtime (ZIPP wasm), XDB storage, bundle format, FormLogic adapter; 51 133 lines | — |
| packages/@softn/components | `@softn/components` (public) | 90 UI components; 42 460 lines | core |
| packages/@softn/vite-plugin | `@softn/vite-plugin` (public) | build integration; 781 lines | core, components |
| packages/@softn/brand | `@softn/brand` (private, no build/test) | tokens, fonts, product bar, shared by the four web apps | — |
| apps/softn-site | `@softn/site` | landing page + app directory UI + publish flow; 9 162 lines | brand only (deliberately NOT core, see 2.1) |
| apps/softn-web | `@softn/web` | browser runtime (`/web/`); 12 650 lines | brand, components, core |
| apps/softn-builder | `@softn/builder` | visual builder (`/builder/`, also a Tauri app); 34 778 lines | brand, components, core |
| apps/softn-studio | `@softn/studio` | AI studio (`/studio/`); 19 749 lines | brand, components, core |
| apps/softn-loader | `@softn/loader` | Tauri desktop runtime, consumes xdb.org as a sibling path dep; 3 807 lines | brand, components, core |
| apps/softn-single | `@softn/single` | single-app hosting shell (`/play/<slug>`); 1 517 lines | brand, components, core |
| apps/softn-single-php-serve | `@softn/single-php-serve` | PHP-served single app variant; 2 233 lines | components, core |
| apps/softn-api | `@softn/api` (test only) | the directory API: PHP, folder catalogue, JSON metadata, optional SQLite per app; 8 195 lines | — |
| apps/softn-php | (no package.json) | on-demand WASM runtime host: PHP front + bundled Node worker; 834 lines + 5 test files | — |
| apps/softn-rust | (no package.json; Cargo) | private backend server host (Rust); 7 452 lines | — |
| apps/formlogic-host | (no package name; vite only) | trusted iframe shell FormLogic uses to host a bundle; 138 lines | reaches into core via `../../../packages/@softn/core/wasm-zipp/SOURCE.json` |
| apps/shared | (not a workspace) | `hostedEditor.ts`, 128 lines, imported by relative path from builder and studio | — |
| e2e | `@softn/e2e` | Playwright smoke gate for a built site; no `test` script by design | — |

Build: `npm run build` = build core, components, vite-plugin, then every app with a build script. `scripts/build-site.mjs` (938 lines) assembles `dist/` = landing page (site) + `/web`, `/builder`, `/studio`, `/play` (single) + `/api` (PHP) + `/data` + deployment files, then `package-site.mjs` zips it. Tauri builds (loader, builder) run in `build.yml`. The root `npm test` runs six script tests plus every workspace `test` script.

Boundaries are, on the whole, respected: there are **zero** imports of `@softn/*/src` from apps (everything goes through package `exports`), and the only production-code cross-workspace relative import is `formlogic-host/src/main.tsx` reading a JSON file from core. The exceptions are tests (below).

## 2. Findings, most important first

### 2.1 The landing site keeps hand-copied forks of three core modules

`apps/softn-site` deliberately does not depend on `@softn/core` ("the site does not depend on the engine", `apps/softn-site/src/lib/handoff.ts` header), so it re-implements:

| site copy | core original | diff (whitespace-stripped lines) |
| --- | --- | --- |
| `src/lib/handoff.ts` (166 lines) | `packages/@softn/core/src/bundle/handoff.ts` (311) | 221 |
| `src/lib/capabilities.ts` (156) | `core/src/runtime/capabilities.ts` (194) | 144 |
| `src/lib/inspectBundle.ts` (239) | `core/src/bundle/inspect.ts` (260) | 89 |

The duplicated exported names are `takeBundleHandoff`, `sha256Hex`, `handoffIdFrom`, `describeHandoffFailure`, `isStoragePolicy`, `isCapability`, `inspectDeclaration`, `inspectBundle`, plus `timeAgo`/`formatDate` (`site/src/lib/format.ts` vs `core/src/runtime/helpers.ts`). The handoff contract (IndexedDB database, store, record shape) is shared with Builder and Studio; `apps/softn-site/test/handoff.test.ts` imports core by relative path (`../../../packages/@softn/core/src/bundle/handoff`) to check the two agree, which is the only thing preventing silent drift. The copies have already diverged in size, so the test guards the record shape, not the behaviour.

Recommendation: extract the bundle-format pieces (`bundle/handoff`, `bundle/inspect`, `runtime/capabilities`, the two formatters) into a small dependency-free package (`@softn/bundle-format`, tree-shakeable, no wasm, no React) that both core and the site depend on. Risk: low; the site's bundle stays small because the package would contain no engine code. Until then, at least move the agreement test's import to a package export rather than a `../../../` path.

### 2.2 Builder and Studio duplicate their editor plumbing

`apps/softn-builder/src/utils/handoff.ts` (59 lines) and `apps/softn-studio/src/lib/handoff.ts` (80 lines) both export `prepareHandoff` and `destinationLabel` (65 differing lines); `openRemoteBundle` exists in `builder/src/utils/openProject.ts` and `studio/src/lib/projectSession.ts`; `bundleNameFromUrl` in `studio/src/lib/projectSession.ts` and `web/src/lib/remoteBundle.ts`; `validateManifest` in `builder/src/utils/bundleExporter.ts` and `core/src/bundle/types.ts`. The one piece the two editors do share, `apps/shared/hostedEditor.ts`, is not a workspace: it has no `package.json`, no tests of its own, no typecheck of its own, and is reached by relative path from 10 files.

Recommendation: promote `apps/shared` to `packages/@softn/editor-shared` (or fold it into the bundle-format package) and move `prepareHandoff`/`destinationLabel`/`openRemoteBundle`/`bundleNameFromUrl` into it. Risk: low, mechanical.

### 2.3 Tests reach across workspaces by relative path

`packages/@softn/core/test/parity-run-paths.test.ts` imports **seven** modules from `apps/softn-builder/src/*` and `apps/softn-studio/src/*` (`../../../../apps/...`), and `threat-boundary-export.test.ts` one more; `softn-site`, `softn-studio` tests import `packages/@softn/core/test/helpers/fake-indexeddb`; `softn-builder/src/utils/appThemeDefaults.test.ts` imports `packages/@softn/components/src/...`. A package test that depends on two apps inverts the dependency direction: core's suite cannot run from a published checkout of core, and any app refactor breaks core's tests. Root `tsconfig.json` has no `paths`, so these are also invisible to the typecheck's project graph.

Recommendation: move parity/threat-boundary tests into `e2e` or a new `apps/*`-level integration test workspace; publish `fake-indexeddb` helper from a `@softn/test-utils` dev package. Risk: low.

### 2.4 `npm run lint` cannot pass and CI does not run it

`.eslintrc.cjs` sets `no-console: warn` and the root `lint` script uses `--max-warnings 0`; the tree has 223 warnings (all severity 1: `no-console` 112, `@typescript-eslint/no-explicit-any` 110, `react-hooks/exhaustive-deps` 1), 141 of them in `packages/@softn/core` (50 alone in `core/test/parser.test.ts`, 42 in `builder/src/utils/preview-pipeline.test.ts`). `verify.yml` therefore runs `lint:errors` instead. Effect: the strict script is dead, the warning count only grows, and nobody sees a new `any`. The root typecheck is clean (exit 0) and so is the loader's own tsconfig now; the earlier "pre-existing ai-gpu-compute-manager tsc errors" no longer reproduce.

Recommendation: decide the policy once. Either make test files exempt from `no-console`/`no-explicit-any` via an `overrides` block (which removes ~120 warnings) and fix the remaining ~100 (mostly `cli.ts`, `DataGrid.tsx`, `SoftNRenderer.tsx`, the AI managers) so `lint` passes and CI runs it, or drop `--max-warnings 0`. Risk: none.

### 2.5 Suites that never run anywhere

- `apps/softn-php/tests/*.test.mjs` (4 Node test files, plus `apache-smoke.py`): the directory has no `package.json`, so `npm test --workspaces` skips it, and no root script or workflow runs the `.mjs` tests (only the Apache smoke runs in `build.yml`/`release.yml`).
- `apps/softn-rust` (Cargo workspace, `tests/` + `test_edge.py`, `test_ws.py`): no workflow runs `cargo test` for it, and no root script mentions it.
- `e2e` (Playwright): no workflow invokes it; the root `e2e` script exists but CI never runs a built-site smoke.
- `packages/@softn/brand`: no build, test or typecheck script; consumed as raw `src/index.ts` through `exports` (works with Vite, but nothing checks it standalone).

Recommendation: add a `package.json` with `"test": "node --test tests/*.test.mjs"` to `softn-php`; add a `cargo test --manifest-path apps/softn-rust/Cargo.toml` step to `verify.yml` (Linux only if it needs it); run `e2e` in `release.yml` against the packaged site it already smoke-tests with curl. Risk: CI time.

### 2.6 God modules in core

| file | lines | what it mixes |
| --- | --- | --- |
| `core/src/runtime/script-runtime.ts` | 3 924 | one class with ~84 methods: ZIPP host bridge, XDB module, nav/console modules, permission checks, persistence failures, worker/main-thread modes, sync room setup |
| `core/src/runtime/xdb.ts` | 2 638 | one `XDBService` with ~89 methods branching on `useTauri` 36 times: browser localStorage backend, native Tauri IPC backend, corruption quarantine, hydration, import/restore planning, events |
| `core/src/loader/SoftNRenderer.tsx` | 2 465 | React renderer, error boundary, CSS sanitiser, persistence notices, expression analysis, and its own sync-room setup (21 non-trivial lines identical to script-runtime, including `syncOpts.password = 'softn-shared:' + room` at `SoftNRenderer.tsx:2158` and `script-runtime.ts:3726`) |
| `components/src/threed/Scene3D.tsx` | 2 977 | one component |
| `core/src/parser/parser.ts` | 2 136 | the parser (cohesive; fine) |
| `builder/src/utils/componentRegistry.ts` | 1 807 | 90 hand-written component descriptors that mirror `@softn/components`' own props (a second source of truth for the same components) |

`xdb.ts` is the clearest split: a `BrowserStorageBackend` and a `NativeBackend` behind one interface, with the planning/quarantine logic backend-agnostic, would remove the 36 `useTauri` branches and make the R2/R3/R4 restore rules testable per backend. The shared sync-room setup between renderer and runtime should live in one place (the shared password derivation in particular). Risk: medium; do it behind the existing 93-file core suite.

### 2.7 Duplicated build artefacts inside core

`packages/@softn/core/wasm/` and `packages/@softn/core/src/runtime/wasm/` both hold `formlogic_wasm.js`, `formlogic_wasm.d.ts`, `formlogic_wasm_bg.wasm` and `formlogic_wasm_bg.wasm.d.ts`; the `.wasm` files are byte-identical (`cmp` clean). Only the top-level copy is imported (`formlogic-wasm-adapter.ts:13` uses `../../wasm/formlogic_wasm.js`); the `src/runtime/wasm` copy is dead and shows up in the "duplicate exported function" scan (`detectHostBridges`, `initSync`, `wasm_engine_info`, `init_panic_hook`). Recommendation: delete `src/runtime/wasm/` (verify nothing under `dist` build copies it). Risk: none if the grep above holds.

### 2.8 Dependency ranges drift across workspaces

Same library, different declared ranges: `@fontsource/*` `^5.3.0` everywhere except `softn-site` (`^5.1.0`); `@tauri-apps/plugin-dialog` `^2.0.0` (builder) vs `^2.6.0` (loader), `plugin-fs` `^2.0.0` vs `^2.4.5`; `@huggingface/transformers` pinned three different ways (root `^4.0.0-next.5`, core `>=3.0.0 || >=4.0.0-next.0`, loader/web `^4.0.0-next.5`); apps declare `@softn/core`/`@softn/components` as `*` while vite-plugin/components declare `^0.0.12`. The lockfile resolves them to one install today (no nested duplicate `react`/`vite`/`vitest` found), so this is latent, not broken. Recommendation: hoist shared dev tooling versions to the root and declare `@softn/*` as `workspace:*`-style exact ranges consistently. Risk: none.

### 2.9 Ten vitest configs, ten variants

Every workspace has its own `vitest.config.ts` and all ten are different (`md5sum`: 10 distinct). Two of them carry the same hand-written comment about `dedupe: ['react','react-dom']` and hoisting; `softn-web` uses `environment: 'node'`, `softn-site` `jsdom`. Recommendation: a root `vitest.workspace.ts` (or a shared `vitest.base.ts` that each config spreads) with the dedupe rule set once. Risk: none.

### 2.10 Packaging scripts

`package-site.mjs` (331 lines), `package-single.mjs` (49), `package-single-php-serve.mjs` (63), `package-private-single-php.mjs` (27) and `build-site.mjs` (938) are mostly distinct and the three small ones already share `single-backend-inputs.mjs`; this is not the duplication the audit brief suspected. What is duplicated is test-harness scaffolding across `scripts/*.mjs` (`fail` ×4, `fixture` ×3, `waitForServer`, `shutdown`, `sha256`, `freePort`, `download`, `collect` ×2 each): a `scripts/lib/` with those helpers would shrink the 7 660 lines of scripts. Risk: none.

### 2.11 Documentation drift (small)

`docs/FORMLOGIC_INTEGRATION.md` refers to `scripts/sync-softn.mjs` and `docs/ZIPP_LANGUAGES.md` to `scripts/sync-zipp-from-softn.mjs`; neither script exists. `docs/SINGLE_APP_RUNTIME.md`'s `apps/x/runs` / `apps/x/storage` are illustrative paths, fine. Nine `docs/audit-*.md` files (out of scope here) sit beside the user docs and outnumber them; they belong under `docs/audits/` or in `.github/`.

### 2.12 Naming

Directories are `apps/softn-*`, packages are `@softn/*`, and app package names drop the prefix (`@softn/site`, `@softn/web`, `@softn/loader`): three spellings for one thing, which shows up in every `-w @softn/…` script versus every `apps/softn-…` path. Not wrong, but it is why `apps/shared`, `apps/formlogic-host` (no package name), `apps/softn-php` and `apps/softn-rust` (no package.json) can silently fall outside `--workspaces`. Recommendation: every directory under `apps/` gets a `package.json` (even a one-line test script for the PHP and Rust hosts), so "is it a workspace?" has one answer.

### 2.13 Security-relevant structure (no defect found)

No committed `.env`, no credential literals (the only hits are the deliberate `softn-shared:<room>` sync-room password derivation in two places, see 2.6). The PHP directory API (`apps/softn-api`) is the one privileged surface: it writes `data/config.json` holding the admin key at first use, and `dist/DEPLOY.md` documents keeping `data/` private; the PHP entry points use PDO with prepared statements and PRAGMA setup only (no `exec`/`shell_exec`/`eval` found under `apps/`). `apps/softn-php` starts Node per request via `proc_open` by design and documents it. The structural risk is only that `softn-api`'s trust boundary lives in PHP tested by Node tests with no PHP static analysis; adding `phpstan` or `psalm` to `verify.yml` for `apps/softn-api` and `apps/softn-php` would be cheap.

## 3. Quick wins versus larger refactors

| Change | Size | Risk | Finding |
| --- | --- | --- | --- |
| Delete `core/src/runtime/wasm/` (dead duplicate of `core/wasm/`) | tiny | none | 2.7 |
| Lint policy: exempt tests from `no-console`/`no-explicit-any`, fix the rest, make CI run `lint` | small | none | 2.4 |
| `package.json` for `softn-php` (Node tests) and a `cargo test` step for `softn-rust`; run `e2e` in `release.yml` | small | CI time | 2.5 |
| Fix two dead script references in docs; move `docs/audit-*.md` to `docs/audits/` | tiny | none | 2.11 |
| Align dependency ranges; `@softn/*` as exact workspace ranges | small | none | 2.8 |
| Shared `vitest.base.ts` with the dedupe rule | small | none | 2.9 |
| `scripts/lib/` for `fail`/`fixture`/`waitForServer`/`sha256`/`freePort` | small | none | 2.10 |
| `@softn/bundle-format` package: handoff, inspect, capabilities, formatters; site and core depend on it | medium | low | 2.1 |
| `packages/@softn/editor-shared` from `apps/shared` + the duplicated editor helpers | medium | low | 2.2 |
| Move cross-app parity/threat tests out of core into an integration workspace; `@softn/test-utils` for fake-indexeddb | medium | low | 2.3 |
| Split `xdb.ts` into backends behind one interface; single sync-room setup for renderer and runtime | large | medium | 2.6 |
| Generate `builder/src/utils/componentRegistry.ts` from `@softn/components` metadata instead of hand-maintaining 1 807 lines | large | medium | 2.6 |

Not findings: package `exports` discipline (no `src` imports across packages), the root typecheck (clean), the lockfile (no nested duplicate majors), the three packaging scripts (they share their inputs helper and differ for a reason).

## 4. Acted on, 15 September 2026 (same day, in the commit that adds this report)

| Finding | Done |
| --- | --- |
| 2.7 dead `core/src/runtime/wasm/` | Deleted (nothing imported it; the ignore pattern in `.eslintrc.cjs` stays harmless). |
| 2.4 `lint` could never pass | `.eslintrc.cjs` exempts test files (and the CLI, whose console *is* its output) from `no-console` and `no-explicit-any`; the one disable directive that became unused was removed; `lint` is now a ratchet at the tree's exact count (`--max-warnings 100`, 0 errors) and `verify.yml` runs it instead of `lint:errors`. The 100 remaining warnings are real (`DataGrid.tsx` 18, `SoftNRenderer.tsx` 11, the AI managers, `render.tsx`, `script-runtime.ts`) and can only go down. |
| 2.5 suites nothing runs | `apps/softn-php` has a `package.json` with a `test` script, so `npm test --workspaces` runs it; its three fixture-bound files skip visibly without `SOFTN_PHP_TEST_BACKEND` instead of throwing (5 pass, 11 skipped, 0 fail). `verify.yml` installs a Rust toolchain and runs `cargo test` for `apps/softn-rust` (23 tests pass locally). `e2e` is still not in CI. |
| 2.11 documentation drift | The two "missing" sync scripts exist in the sibling FormLogic checkout, which is what both notes say, so those references stand. The audit reports moved to `docs/engineering/audits/` and the one cross-reference was updated. The engineering notes as a whole moved to `docs/engineering/` so `docs/` could hold the published guides (see `docs/README.md`). |
| preview parity (not in the findings above) | `scripts/serve-site.mjs` answered 200 with the SPA for any unknown path and served slashless directories in place; it now applies the same page allowlist as the shipped Apache/nginx rules (404 with the site as body) and redirects a slashless directory to its canonical URL, so the preview agrees with production for the new `/docs/` pages. |

Left as recommendations (2.1, 2.2, 2.3, 2.6, 2.8, 2.9, 2.10, 2.12, 2.13): each is a deliberate refactor with its own review, not a same-day fix.
