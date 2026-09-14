# FormLogic → Softn integration: touchpoints and audit (15 September 2026, read-only)

Method: read every FormLogic script, workflow, component and PHP service that names a Softn path, and Softn's `apps/formlogic-host`, `apps/shared/hostedEditor.ts`, `apps/softn-php/runtime/*` and `packages/@softn/core/src/integrations/formlogic.ts`; diffed each vendored/prepared copy against Softn HEAD (1c9cb07, which FormLogic pins in `action.yml`). Nothing was modified or run except `diff`/`cmp`/`sha256sum`.

## 1. Touchpoints

| # | Softn source | FormLogic destination / consumer | Contract | Must not move or rename without |
| --- | --- | --- | --- | --- |
| T1 | `packages/@softn/core/src/integrations/formlogic.ts` | `formlogic/ui/src/lib/softn/project.ts` (+ `provenance.json` with sha256, `LICENSE`, `NOTICE`), copied by `formlogic/ui/scripts/sync-softn.mjs:5-12`; imported by `src/components/studio/SoftnExportPanel.tsx:7` | exports `createFormlogicProject`, types `FormlogicProject`, `FormlogicSchema`, `FormlogicProjectInput`, `FormlogicField` (formlogic.ts:4-46) | updating `sync-softn.mjs:5` and re-running it |
| T2 | `packages/@softn/core/wasm-zipp/{zipp_wasm.js,.d.ts,zipp_wasm_bg.wasm,.wasm.d.ts,SOURCE.json,THIRD_PARTY_LICENSES.txt}` | `formlogic/ui/vendor/zipp-wasm/*` and `public/zipp-licenses.txt`, copied by `scripts/sync-zipp-from-softn.mjs:11-31` after checking revision/sha256 and the `safe-sandbox` profile | `SOURCE.json` fields `revision` (40 hex), `sha256` (64 hex), `version`; bytes must hash to `sha256` | updating `sync-zipp-from-softn.mjs:11`, `prepare-native-runtime.mjs:9`, `build-hosted-runtime.mjs:14`, `build-app-editors.mjs:15`, `ecosystem-manifest.mjs:70,92`, and `apps/formlogic-host/src/main.tsx:7` |
| T3 | `apps/softn-php/runtime/{runner.mjs,request-worker.mjs,request-hook.mjs,wasm-host.mjs,migrations.mjs,crypto.mjs,time.mjs,host-protocol.json,record-events.mjs}` + T2's wasm | `formlogic/backend/resources/softn-native/` (gitignored; `provenance.json` with per-module sha256), by `scripts/prepare-native-runtime.mjs:8-30`; consumed by `backend/src/Services/NativeAppService.php` (`runtime()` :51, file list :293,:311, `invoke()` :672-705) | `host-protocol.json` `{nativeProtocol:1, recordEvents:1, minimumNode}`; the runner is started as `node --max-old-space-size=128 --disable-proto=throw runner.mjs` with stdin JSON request, env `SOFTN_BACKEND_ROOT`, `SOFTN_HOST_CONTEXT`, `SOFTN_RECORD_EVENTS`, cwd = app root; app root layout `app/`, `private/config.json`, `private/data/application.sqlite`; `config.json` fields `appId, development, keyHex, capabilities, cryptoDomains{hmac,seal}, enableHostContext` (NativeAppService.php:549-560; request-worker.mjs:20-39,81,93) | updating the module list in `prepare-native-runtime.mjs:11` and `NativeAppService::preflight` :293/:311, and `ecosystem-manifest.mjs:21,69` |
| T4 | `apps/formlogic-host` (Vite app; imports `@softn/core`, `@softn/components`, T2's `SOURCE.json`) | `formlogic/ui/public/hosted-runtime/` (gitignored) built by `formlogic/ui/scripts/build-hosted-runtime.mjs:17-37` (runs `npm run build -w @softn/core -w @softn/components` then `vite build apps/formlogic-host` inside the Softn checkout), verified by `hosted-runtime-artifact.mjs` (`runtime-manifest.json`, per-file sha256, zipp identity) and loaded by `src/components/studio/HostedAppFrame.tsx:192` in `sandbox="allow-scripts"` | postMessage protocol: child → parent `{type:'formlogic:ready', nativeProtocol:1, zipp:{version,sha256}}` (main.tsx:95); parent → child `{type:'formlogic:init', client, appId, native, assets, storage, dark, zippWasm}` with a `MessagePort` (HostedAppFrame.tsx:152-165); port messages `{type:'call', id, action, input}` / `{id,result}` / `{type:'error'}`; actions `nativeStorage`, `nativeRequest`, `workspaceInfo|workspaceRecords|workspaceOpen|workspaceDashboard` (HostedAppFrame.tsx:96-141) | updating `build-hosted-runtime.mjs:19,30` and `build-app-editors.mjs`; the message field names above are the contract on both sides |
| T5 | `apps/softn-builder`, `apps/softn-studio` (built with `?formlogicEditor=1`), `apps/shared/hostedEditor.ts` | `formlogic/ui/public/app-editors/{builder,studio}` (gitignored) + `manifest.json {protocol:1, editors:[builder,studio]}` by `build-app-editors.mjs:8-28`, checked by `check-app-editors.mjs:7-12` (every wasm under it must hash to the vendored ZIPP sha); driven by `src/components/studio/AppEditorDialog.tsx:79-129` | postMessage: child → parent `{kind:'formlogic-editor-ready', protocol:1}` to `location.origin`; parent → child `{kind:'formlogic-editor-connect', protocol:1}` + port; port methods `open`/`export`, `save-requested`/`save-result`, `ai-request`/`ai-response`/`ai-cancel` (hostedEditor.ts:30-112) | updating `build-app-editors.mjs:13,20` (it `access()`es `apps/shared/hostedEditor.ts` by path, :13) |
| T6 | `examples/formlogic-workspace/{ui/main.ui,logic/main.logic}`, `examples/aokie-workspace/...` | `formlogic/ui/src/data/{connected-workspace,aokie-workspace}.json` and `formlogic/backend/resources/...json`, by `formlogic/ui/scripts/sync-workspace-project.mjs:3-11` | the two files' contents, wrapped with a FormLogic-authored `manifest.json`, `permission.json`, `formlogic.connection.json` | updating `sync-workspace-project.mjs:3` |
| T7 | `.github/scripts/checkout-xdb.sh` (`XDB_COMMIT`), `apps/softn-php/runtime/host-protocol.json`, `packages/@softn/core/wasm-zipp/SOURCE.json`, `apps/softn-loader/src-tauri/Cargo.toml` (xdb path dep) | `scripts/ecosystem-manifest.mjs:54-95` → `docs/ecosystem/compatibility-manifest.json`; `--check` runs in `ci.yml:130` against the pinned checkout | pin regexes at :55 (`repository: f2i-com/softn.com` + `ref:`), :67 (`XDB_COMMIT="<40hex>"`), :72 (`xdb = { ... path = "..." }`) | updating those regexes |
| T8 | Softn checkout at the pinned ref | `.github/actions/prepare-hosted-runtime/action.yml`: `npm ci` in the checkout, then T4 build + `test:hosted-runtime`, T5 build + check, T3 prepare; used by `ci.yml:63,124`, `e2e.yml:64`, `package.yml:73,185,229` | the Softn root `npm ci`/`npm run build -w @softn/core -w @softn/components`, `node_modules/vite/bin/vite.js`, and the app directories named in T4/T5 | bumping `ref:` (and regenerating the manifest) whenever Softn moves |

Not a touchpoint: the Softn `docs/` reorganisation. `sync-prelude.mjs` copies FormLogic's own prelude (`src/lib/formlogic/prelude.js`) into its worker, not from Softn.

## 2. Drift check (vendored / prepared copies vs Softn 1c9cb07)

| Copy | State |
| --- | --- |
| T1 `project.ts` | **Stale by one line**: `provenance.json` sha `5a41a2e1…`, current `formlogic.ts` sha `9e37b03e…`; the only difference is the README text inside the generated project (`softn.com/docs/SINGLE_APP_PHP_SERVE.md` → `docs/engineering/SINGLE_APP_PHP_SERVE.md`, formlogic.ts:143), changed by Softn 15fa946 today. Behaviour identical; provenance no longer matches the source it names. |
| T2 ZIPP | Identical: both `SOURCE.json` say 0.0.18 @ 2f5c4c8d…, both `.wasm` hash `206630229207…`. The vendored `README.md:3` still says "ZIPP v0.0.17" (doc drift only). |
| T3 native runtime | All nine modules byte-identical to `apps/softn-php/runtime/` (`cmp` clean); `provenance.json` records the same ZIPP. |
| T6 workspace examples | Identical after CRLF normalisation (the JSON copies hold LF, the Softn files are checked out CRLF on this machine); no content drift. |
| T4/T5 built runtimes | Generated per CI run from the pin (gitignored locally); not diffable, verified by their manifests. |

## 3. Findings, by severity

### Medium

**M1. The vendored adapter's provenance is stale and nothing checks it.** `sync-softn.mjs` writes `provenance.json.sha256` but no script, test or CI step compares that hash with the Softn file at the pinned ref, so a Softn change to `formlogic.ts` (today's: 15fa946) silently leaves FormLogic exporting the older text (`project.ts` sha 5a41… vs 9e37…). Every other copy (T2, T3, T4, T5) is hash-checked in CI; this one is the exception. Fix: add to `ecosystem-manifest.mjs` a `must(sha256(softnRepo/packages/@softn/core/src/integrations/formlogic.ts) === provenance.sha256, 'vendored FormLogic adapter is stale; run node formlogic/ui/scripts/sync-softn.mjs')`, and re-run `sync-softn.mjs` now (one-line README path change).

**M2. `host-protocol.json.minimumNode` is enforced only in preflight, not at request time.** `NativeAppService::preflight` compares the Node version against `minimumNode` (:334), but `invoke()` (:672-705) runs `runner.mjs` with whatever `FORMLOGIC_NODE_BIN` names. `request-worker.mjs:2` uses `node:sqlite` (`DatabaseSync`), available only from Node 22.5 and stable in 24; on an older binary the worker fails at import and the app request becomes an opaque "Native runtime returned no response" (:702). Preflight results are cached for `PREFLIGHT_TTL` (:272), so a binary changed after preflight is not re-checked. Fix: have `runner.mjs` (or the PHP `invoke`) assert `process.version >= minimumNode` once per process and return a typed `runtime.node` failure; cheap, and the same check protects Softn's own PHP host.

**M3. `enableHostContext` is set on every FormLogic install (:557-559) and, when set, the runtime trusts `SOFTN_HOST_CONTEXT` and `SOFTN_RECORD_EVENTS` wholesale from the environment (`request-worker.mjs:81,93`).** That is the intended trust model (the PHP host is the operator), and env vars are not readable by the guest. But `SOFTN_HOST_CONTEXT` is passed through `getenv()` merged with the whole PHP environment (:692, `array_merge(getenv(), ...)`), so every environment variable of the PHP worker (DB passwords in `.env`-derived env, API keys) is inherited by the Node process. The guest cannot read `process.env` (it runs in ZIPP wasm with a capability allowlist, `wasm-host.mjs:96`), so this is not an exposure today, but it widens the blast radius of any runtime bug. Fix: pass an explicit minimal env (`PATH`, `SYSTEMROOT`/`TEMP` on Windows, `NODE_NO_WARNINGS`, the three `SOFTN_*` keys) instead of `getenv()`.

**M4. Two of the three CI consumers skip the manifest check.** `ecosystem-manifest.mjs --check` runs only in the UI job (`ci.yml:130`); the backend job (`ci.yml:63`, `native-only`) and `package.yml` (:73,185,229) prepare the runtime from the pin without asserting that the committed manifest describes that pin. A pin bump that forgets the manifest passes the backend and packaging jobs. Fix: run `node scripts/ecosystem-manifest.mjs --check` inside `prepare-hosted-runtime/action.yml` as its last step (it already has `SOFTN_REPO`).

### Low

**L1. Hosted-frame handshake accepts a `ready` message from the frame before any zipp/protocol check only by `event.source` (HostedAppFrame.tsx:55).** Correct for an opaque-origin sandbox (there is no origin to compare), and the parent then verifies `nativeProtocol` (:60) and the ZIPP identity (:65) before sending bytes; the `init` is sent with `targetOrigin '*'` (:163), also unavoidable for an opaque origin, and it carries only public client files plus a *clone* of public wasm bytes. The child-side guard is `event.source !== parent` plus a one-shot `started` flag (main.tsx:39-40). Acceptable; note that a parent-side `frame.current.contentWindow` comparison is the whole authentication, so `HostedAppFrame` must never be rendered with a `src` the app can influence (today it is the constant `/hosted-runtime/index.html`, :192).

**L2. Editor bridge is the stricter twin.** Both sides check `event.source`, `event.origin === location.origin` and `protocol === 1` (AppEditorDialog.tsx:79, hostedEditor.ts:76); the editors are same-origin (no sandbox attribute on :129), which is what makes the origin check possible but also means the Builder/Studio bundles run with the FormLogic origin's storage. That is by design (trusted first-party builds, hash-checked by `check-app-editors.mjs`), but it is the reason `app-editors` must stay a build output of the pinned checkout and never a downloaded artefact.

**L3. Protocol version fields are hard-coded, not shared.** `nativeProtocol: 1` appears as a literal in `main.tsx:95`, `HostedAppFrame.tsx:60`, `prepare-native-runtime.mjs:13`, `NativeAppService.php:317`, `ecosystem-manifest.mjs`, `build-app-editors.mjs:26`, `check-app-editors.mjs:8`, `hostedEditor.ts:74,76`, `AppEditorDialog.tsx:79,104`. Any bump is a nine-file edit across two repositories with no test that they agree. Fix: FormLogic's `check-contracts.mjs` (exists, `scripts/`) could assert the literals match `host-protocol.json` at the pinned checkout.

**L4. Vendored ZIPP README says 0.0.17; SOURCE.json says 0.0.18.** Doc drift in `formlogic/ui/vendor/zipp-wasm/README.md:3`.

**L5. `prepare-native-runtime.mjs` copies `LICENSE`/`NOTICE` from the Softn root but the runtime's own `THIRD_PARTY_LICENSES.txt` only from `wasm-zipp/`**; `apps/softn-php/runtime` has no third-party notice of its own (it is dependency-free), so this is complete today, but a future dependency in the runtime (e.g. the `vendor/ws` the websocket module imports at `websocket.mjs`, not shipped to FormLogic) would not be covered. Note only.

### Verified as sound (no finding)

- ZIPP identity is enforced at every hop: sync (`sync-zipp-from-softn.mjs:15-24`), native prepare (`prepare-native-runtime.mjs:14-17`), hosted runtime (`hosted-runtime-artifact.mjs:16,45,58`), editors (`check-app-editors.mjs:12`), the browser (`zipp-bytes.ts:23-26,43-44`, digest of downloaded bytes), and the manifest (`ecosystem-manifest.mjs:86-93`).
- The native runner validates everything it is given from the app root: `config.json` shape (`request-worker.mjs:22`), bundle path containment with realpath and symlink refusal (:24-28,:49-50,:57), manifest ↔ config `appId` (:33), capability allowlist (:34-37), route declarations (:41-45), migrations by hash with an SQLite authorizer that denies `_`-prefixed tables and non-DDL (`migrations.mjs`), request shape (:54), and every host call by capability and budget (`wasm-host.mjs:69-71,96-97,103`). Input is capped at 6 MB on both sides (`runner.mjs:7`, PHP :681).
- PHP-side project validation (`validateProject` :461-488) mirrors the runtime's rules (server API v1, capability allowlist, private-sqlite, declared migrations present) so a project the PHP accepts is one the runtime will start.
- Record-event subscriptions are authorised per event and bounded (`record-events.mjs:11-18`), delivered through an outbox table the guest cannot read (:43).
- The compatibility manifest catches pin/checkout mismatch (:73), ZIPP mismatch across all three copies, protocol versions and the native provenance (:95-108), and CI fails on a stale manifest (:57).

## 4. Refactor guard-rails for Softn (what a change must keep)

1. Paths in T1–T7 stay where they are, or the named FormLogic scripts are updated in the same change and the pin bumped.
2. `packages/@softn/core` and `packages/@softn/components` keep `npm run build` producing `dist/` the way `apps/formlogic-host`'s Vite config resolves them (T4 builds from the checkout, not from npm).
3. `apps/softn-php/runtime/*.mjs` stay dependency-free ES modules runnable by a bare Node binary with `node:sqlite` (no `node_modules` is copied to FormLogic).
4. `host-protocol.json` keeps `nativeProtocol: 1` and `recordEvents: 1` unless FormLogic's nine literals move with it.
5. `apps/shared/hostedEditor.ts` keeps its path (T5 `access()`es it) and its message kinds.
6. The `formlogic:ready`/`formlogic:init` and editor `kind`/`protocol` message shapes are frozen at protocol 1.
7. `.github/scripts/checkout-xdb.sh` keeps the `XDB_COMMIT="<40hex>"` form and `apps/softn-loader/src-tauri/Cargo.toml` the `xdb = { path = ... }` line (manifest regexes).

## 5. End-to-end verification on this machine (commands only; not run here)

```sh
# 0. Pins agree and every copy matches the pinned Softn checkout (softn.com must be at the pinned ref)
cd C:/Users/User/Documents/repos/formlogic_project/formlogic.com
SOFTN_REPO=../softn.com node scripts/ecosystem-manifest.mjs --check

# 1. Refresh the vendored copies from the sibling checkout and confirm nothing changed (or commit what did)
node formlogic/ui/scripts/sync-softn.mjs && node scripts/sync-zipp-from-softn.mjs && \
  node formlogic/ui/scripts/sync-workspace-project.mjs formlogic-workspace && \
  node formlogic/ui/scripts/sync-workspace-project.mjs aokie-workspace && git status --short

# 2. Native runtime: prepare from Softn, then the backend suite that drives it
SOFTN_REPO=../softn.com node scripts/prepare-native-runtime.mjs
cd formlogic/backend
export FORMLOGIC_NODE_BIN="C:/Program Files/nodejs/node.exe" DB_HOST=127.0.0.1 DB_PORT=3306 DB_USERNAME=root DB_PASSWORD= DB_TEST_DATABASE=formlogic_test
php -d xdebug.mode=off -d variables_order=EGPCS vendor/bin/phpunit tests/Unit/NativeAppServiceTest.php
php -d xdebug.mode=off -d variables_order=EGPCS vendor/bin/phpunit          # full suite, MySQL via WAMP
vendor/bin/phpstan analyse --no-progress

# 3. Hosted runtime and editors built from the Softn checkout, then their checks and the UI suite
cd ../ui
(cd ../../../softn.com && npm ci)                       # once
SOFTN_REPO=../../../softn.com npm run build:hosted-runtime
SOFTN_REPO=../../../softn.com npm run test:hosted-runtime
SOFTN_REPO=../../../softn.com npm run build:app-editors && node scripts/check-app-editors.mjs
npm run test:zipp-sharing                                # Playwright: hosted apps reuse the parent's wasm bytes
npx vitest run                                           # includes HostedAppFrame.test.tsx, AppEditorDialog.test.tsx, workspaceBridge.test.ts
```
