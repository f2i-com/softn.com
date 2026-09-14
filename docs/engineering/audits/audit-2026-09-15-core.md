# @softn/core and @softn/components: compatibility and correctness audit (read-only, 15 September 2026)

Method: grep/awk/wc over `packages/@softn/core/src`, `packages/@softn/components/src` and the hosts under `apps/*` that consume them; reading of `bundle/types.ts`, `bundle/bundle.ts`, `runtime/xdb.ts` (2 638 lines), `runtime/script-runtime.ts` (3 924), `runtime/capabilities.ts`, `runtime/softn-preamble.ts`, `runtime/script-worker-bridges.ts`, `renderer/render.tsx`, `renderer/sanitize-html.ts`, `loader/SoftNRenderer.tsx` (2 465), `integrations/formlogic.ts`. Nothing modified. Line numbers are as of softn.com `1c9cb07`.

## 1. The compatibility contract, as the code reads it

### 1.1 manifest.json

Required by `validateManifest` (`bundle/types.ts:270-296`): `name`, `version`, `main` (non-empty strings). `files` is optional; when present it must be an object whose `ui`/`logic`/`xdb`/`assets` are string arrays. Everything else is optional and read leniently:

| Field | Read by | Fallback |
| --- | --- | --- |
| `main` | core `bundle.ts:57-64` (normalises `\`, leading `/`, doubled `/`; must exist in the zip), every host | none (required) |
| `files.xdb` | web `bundleProcessor.ts:284`, loader `bundleRuntime.ts:62`, builder | `[]` |
| `files.ui/logic/assets` | builder (12 reads of `main`, 2 of `files`), web `files` ×2 | listing only; loading is by `main` + imports, so a bundle whose `files` lists are stale still runs |
| `config.execution` | renderer (`worker` \| `main`, falls back to main when the script needs it, `SoftNRenderer.tsx:963,1002,1103`) | main thread |
| `config.window`, `config.mobile.orientation` | loader, single | none |
| `config.theme.mode` | renderer/theme | system |
| `config.xdb.sync/collections` | declared in the type; **no reader found in core or apps** (dead field) | — |
| `config.server` | site, single, web (server endpoints) | host defaults |
| `permissions` (legacy `AppPermissions`) | web `bundleProcessor.ts:extractPermissions:482-516`, single `load.ts:67`, single-php-serve `load.ts:142` | see 2.2: only `network`→`net` and `filesystem`→`files` survive |
| `icon` | core ×5, hosts | none |
| `id` | `permissionConfig.app.id` is what scopes sync rooms (`script-runtime.ts:3711`), **not** `manifest.id`; the FormLogic adapter writes `manifest.id` (`formlogic.ts:117`) which nothing in core reads | host app id (digest) |

Tolerance for older bundles: a manifest with only `name/version/main` loads; unknown fields are ignored; the `files` object is validated only for shape.

### 1.2 permission.json

`{ "permissions": { <capability>: { enabled: boolean, ...options } }, "app"?: {id,name,version} }`, schema version 2 (`capabilities.ts:31`). Ten names: `net camera mic files qr ai gpu sync storage accel`. Missing file: **deny everything** (`script-runtime.ts:2211-2224`); malformed JSON: deny everything (`bundleProcessor.ts:492-501`, loader `App.tsx:423-433`). `inspectDeclaration` (`capabilities.ts:132`) is what the directory and the launcher describe requests with; `checkPermission` is what the runtime enforces. Enforcement count by capability (`checkPermission('…')` sites): ai 13, gpu 9, files 5, camera 3, net 3, qr 2, sync 2, mic 1, storage 1; `accel` is gated inline at `script-runtime.ts:2260`; `sync` is additionally gated in the renderer helper (`SoftNRenderer.tsx:2110-2131`).

### 1.3 File layout, seeds, assets

- `.ui` and `.logic` resolved by extension (`bundle.ts:350-353`, `572-573`); imports by relative path; `<logic src>` and `<import X from>` in `.ui`.
- Seeds: `files.xdb` entries are `.xdb` JSON; `parseXDBFile` falls back to the file name as the collection (`bundle.ts:474`); `seedXDBBundleData` (`bundle.ts:546-567`) inserts only ids not already present (tombstones included, so a deleted seed stays deleted) and forces `deleted:false` on what it inserts. Web and loader both call it; builder/studio preview seeds via the renderer's ephemeral scope.
- Assets: `asset(path)` hands out `blob:` URLs for binary files and base64 `data:` URLs for text (`bundle/runtime.tsx:140-170`), cached per path and revoked on dispose (`:337-343`).

### 1.4 XDB storage

- Browser keys: `xdb:<appId>:<collection>` (`prefixFor`, `xdb.ts:2200`); a collection name never contains `:`. Legacy bare `xdb:<collection>` keys are **copied** (never deleted) into every app namespace on that app's first open, verified, and marked with `xdb-meta:<appId>:legacy-migration=done` (`xdb.ts:2212-2260`). Consequence: every app opened after the upgrade receives a copy of every legacy collection; documented and deliberate, but storage grows by (apps × legacy bytes).
- Quarantine: unreadable JSON is copied to `xdb:<appId>:<collection>.corrupt.<base36 time>` and reads return `[]` while writes are refused until acknowledged (`xdb.ts:556-570`).
- Export envelope: `{ version: 1, exportedAt, collections: { [name]: XDBRecord[] } }` (`xdb.ts:1743-1756`); import accepts rows with a non-empty string `id` and skips the rest; `merge:false`/`clearFirst` mean "exactly the accepted rows" on both backends (R2/R3 work).
- Native (Tauri) commands used by the service: `create_record`, `update_record`, `upsert_record`, `delete_record`, `clear_collection`, `import_records`, `request_sync`, `get_network_status`, each with `appId` injected (`xdb.ts:313-316`). `update_records` (XDB c349911) is registered in the loader but not yet used here.
- Sync-related keys: saved room via `xdb-sync-key.ts`; `xdb-sync-shared:<appId>` = `'true'` (see finding 2.1); the per-app encryption key handled by `xdb-sync-key.ts`.

### 1.5 Host API (`softn.*`) and `db`

Modules the preamble defines for scripts (`softn-preamble.ts`): `backend.call`, `net.fetch`, `qr.encode/decode`, `camera.capturePhoto/recordVideo/startLive/stopLive`, `mic.record/stop/isRecording`, `audio.speechCapabilities/loadSpeechModel/releaseSpeechModel/speak/…` (plus the play/stop/setVolume/stopAll the README documents, in `script-runtime.ts:2583+`), `files.*`, `ai.*`, `gpu.*`, `storage.*`, `input.captureKeys`, `accel.*`. Every call goes through `host.call(name, jsonArgs, callback)`, so the same preamble serves the worker.

`db` has **four** implementations: (A) `script-runtime.ts:3533` async host-call surface (`query get create update delete sync connected peers room peerId`), (B) `createDBNamespace` `:3616-3800` (adds `hardDelete startSync stopSync getSyncStatus getSavedSyncRoom prune clearCollection ready`), (C) `:3828-3924` an in-memory mock with `mock-…` ids that also carries `nav.goto/back/params` and `console.log/error/warn` (a test double living in the production module), and (D) the renderer's `xdbHelpers` (`SoftNRenderer.tsx:2098-2200`: `count clear sync startSync stopSync getSavedSyncRoom …`). The worker bridge (`script-worker-bridges.ts:121-206`) mirrors B minus `prune/clearCollection`. The guides (`docs/content/softn-docs.json`) claim `db.create/query/update/delete/startSync`: all exist on B and the worker bridge.

## 2. Findings, most important first

### 2.1 The shared-room encryption switch is sticky, one-directional and applied on only one of the four `startSync` paths

Evidence: `script-runtime.ts:3693-3737` derives `isShared` from `options.sharedRoom || options.noEncrypt`, **or** from `localStorage['xdb-sync-shared:<appId>'] === 'true'`, then persists `'true'` whenever shared; nothing in the tree ever removes that key (only the two reads at `SoftNRenderer.tsx:2385` and `script-runtime.ts:3693` and the one write at `:3728`). The renderer helper path (`SoftNRenderer.tsx:2140-2160`) derives `isShared` from the options only and persists nothing. Both derive the room password as `'softn-shared:' + room` and drop the per-user `encryptionKey`.

Impact on existing apps: once a script has ever started one shared room, every later `db.startSync(room)` from script in that app, for any room, silently becomes shared (room-name-derived key, no per-user key) for the life of the browser profile, while the same call made through the renderer helper or the `<data>` block keeps the per-user key. Two peers of one app can therefore sit in the same room with different keys (one path sticky-shared, the other private) and never see each other, and a private room downgrades to a guessable key without the author asking for it.

Fix that keeps old bundles working: one function (`deriveRoomSecurity(room, options, appId)` in `host-bound-sync-options.ts`, next to `bindSyncOptions`) used by all four paths; the persisted flag should be **per room** (`xdb-sync-shared:<appId>:<room>`), written when a shared room is started and cleared by `stopSync(room)`, and read only for the saved-room auto-resume, never to override an explicit `startSync(room)` call. Old flag value: treat the legacy per-app key as applying to the saved room only, then migrate.

### 2.2 Legacy `manifest.permissions` is honoured by three hosts and ignored by two

Evidence: web `bundleProcessor.ts:504-512`, single `load.ts:67`, single-php-serve `load.ts:142` map `network→net`, `filesystem→files` (and drop `clipboard/notifications/storage/geolocation`); the desktop loader reads only `permission.json` (`apps/softn-loader/src/App.tsx:422-436`) and passes `manifest.permissions` to the renderer as a display-only prop (`:590`); the builder/studio previews read neither.

Impact: a pre-`permission.json` bundle that declared `"permissions": { "network": true }` gets `softn.net.fetch` in the browser runtime and the single-app hosts but is refused it on the desktop, with an error telling the author to write a `permission.json` they cannot retrofit into a published file.

Fix: move `extractPermissions` (and its legacy mapping) from `apps/softn-web` into core (`runtime/capabilities.ts` or `bundle/inspect.ts`) and call it from every host; keep the mapping exactly (`network`, `filesystem`) so behaviour on the three hosts that already honour it does not change; the comment at `bundleProcessor.ts:493-499` still says a null config allows everything, which stopped being true when `checkPermission` was inverted (`script-runtime.ts:2213-2224`) and should be rewritten with it.

### 2.3 Four copies of the `db` namespace, one of them a mock in the production bundle

Evidence: section 1.5 (A, B, C, D). C (`script-runtime.ts:3828-3924`) creates records with `mock-<time>-<rand>` ids into a local `Map` and carries `nav` and `console` stand-ins; nothing outside tests should reach it, but it ships in the library. A has no `startSync`, D and B each gate `sync` with differently worded errors (`SoftNRenderer.tsx:2110-2131` vs `createDBNamespace.startSync`).

Impact: the same script line behaves differently depending on which surface the host wired; a fix to one (2.1 is the concrete case) misses the others.

Fix: one `createDBNamespace(xdb, policy)` in `runtime/db-namespace.ts` returning the B surface; A becomes `B` awaited; D delegates to B; C moves to `test/helpers`. Method names and signatures unchanged, so bundles are unaffected.

### 2.4 Native writes are fire-and-forget on the synchronous XDB paths

Evidence: `create()` on Tauri returns an optimistic record and only logs on failure (`xdb.ts:840-851`); `clear()` likewise (`:1600-1607`); of 16 `this.native<…>` calls, 6 attach a `.catch` that logs and rolls back the cache, the rest are awaited by the `*Async` variants. `notifyMutation` fires before the native write is known to have landed on the sync path.

Impact: an app calling `db.create` then closing (or the desktop host losing the IPC) shows a record that never reached SQLite; the sync notification may announce a record that does not exist.

Fix (compatible): keep the synchronous signatures, but route B's `create/update/delete` to the `*Async` variants when `isP2PAvailable()` (A already does this at `script-runtime.ts:3533-3560`), surface a `storageState: 'degraded'` issue on native failure (the mechanism exists at `xdb.ts:405`), and emit `notifyMutation` after the native promise resolves.

### 2.5 `config.xdb.sync` and `config.xdb.collections` are declared and documented but read by nothing

Evidence: `bundle/types.ts:78-83`; no reader in core or apps (grep for `config.xdb`, `xdb.sync`, `xdb.collections` finds only the type). The guides do not promise them, the README's manifest example lists the field.

Impact: an author who sets `config.xdb.sync: true` expects sync and gets nothing; harmless to existing apps.

Fix: either wire `collections` to `xdb.ensureCollection` at load and `sync` to the saved-room resume (gated by the `sync` capability), or mark the fields deprecated in the type and drop them from the README.

### 2.6 `manifest.id` is written by the FormLogic adapter and read by nobody; room scoping uses `permission.json`'s `app.id`

Evidence: `integrations/formlogic.ts:117` writes `manifest.id = formlogic_<hex>`; room scope is `permissionConfig.app?.id || appId` (`script-runtime.ts:3711`, `SoftNRenderer.tsx:2156`); the adapter writes `permission.json` as `{ permissions: {} }` with no `app`.

Impact: two FormLogic exports of the same app (different bytes, so different digests) do not meet in a sync room even though the adapter went to the trouble of a stable identity; not a regression for existing bundles.

Fix: have the adapter also write `permission.json.app = { id, name, version }`; optionally let the hosts fall back to `manifest.id` when `app.id` is absent (additive).

### 2.7 Worker mode has no `prune`/`clearCollection`, and its mutations are applied after the fact

Evidence: `script-worker-bridges.ts` `DBMutation` union (`:12-19`) covers create/update/delete/hardDelete/startSync/stopSync; B also exposes `prune` and `clearCollection`; worker `create` returns a `tempId` that the main thread later replaces.

Impact: a script that calls `db.clearCollection` and is later moved to `config.execution: "worker"` fails at run time; a script that stores the returned id of `db.create` in worker mode stores a temp id. Both are only visible to bundles opting into the worker, so no existing default-mode bundle changes.

Fix: add the two mutation kinds to the bridge; document temp ids in the worker section of the guides, or have the bridge await the flushed id (it already has `ready`).

### 2.8 Renderer sanitisation: solid, with two things worth pinning

Evidence: `sanitizeBundleCSS` (`SoftNRenderer.tsx:89-147`) strips escapes, `@import`, remote/`javascript:`/`data:`/`blob:` `url()`, `image-set`, `expression()`, `-moz-binding`; `render.tsx` has an allowlist plus a denylist of tags (`:330-360`) and sanitises `URL_PROPS` including `srcSet`, `xlinkHref`, `formaction`, `poster` (`:457-478`, `sanitize-html.ts:279-291`) and inline `style` remote `url()` (`:479-500`). Components: `Icon` inlines only its own `ICONS` table or a sanitised custom SVG (`Icon.tsx:29,106,112`); `MarkdownEditor` previews through `sanitizeRichText` with the egress judge (`:265-270`); `RichTextEditor` the same; `Layout`/`ThemeProvider` inject their own generated CSS.

Gaps to pin rather than bugs found: (a) `isSafeUrl` accepts any scheme in `SAFE_URL_SCHEMES` plus `SAFE_DATA_URL`; confirm `data:text/html` is excluded by the latter (not verified here). (b) `URL_PROPS` is keyed by React prop spelling; an attribute passed with unusual casing from a template (`FORMACTION`) depends on the parser normalising names before this check.

### 2.9 Enforcement gaps to confirm with tests

`checkPermission('mic')` has one site and `'storage'` one; `accel` is gated inline (`:2260`) rather than through `checkPermission`, so it bypasses the consent-pending wording. `'sync'` has three differently worded gates (2.3). Not a bypass found, but the single-site capabilities are one refactor away from unguarded.

### 2.10 Resource lifetimes: fine, one 30-second window

Evidence: object URLs 4 created / 3 revoked, the fourth (`script-runtime.ts:3069`) revoked on a 30 s timer after the download click; `addEventListener` 8 / `removeEventListener` 8; `setInterval` 1 / `clearInterval` 5; media streams stopped via `getTracks` (5 sites); workers 5 created, terminated through `sandboxHost.dispose()` and `vmEngine.dispose()` (`:788,945,1664`); event coalescers disposed (`:1682`). Existing tests cover renderer disposal and URL lifecycle (`test/bundle-renderer-disposal.test.tsx`, `bundle-url-lifecycle.test.tsx`).

### 2.11 Documentation drift (small)

`bundleProcessor.ts:493-499` (null config "allows everything", false since the inversion). README lists `config.xdb` (2.5). The guides say `db.startSync` exists, true, but do not mention that shared rooms use a room-derived key (2.1 makes that matter).

## 3. Tests that would pin the contract

1. `bundle-compat.test.ts`: load fixtures for each historical manifest shape (name/version/main only; with `files` lists that are stale; with legacy `permissions`; with `config.execution: "worker"`) and assert what runs and which capabilities resolve, on core alone.
2. `permission-compat.test.ts`: the legacy `manifest.permissions` → `PermissionConfig` mapping, once it lives in core, asserted identical for web, single, single-php-serve and loader (import each host's loader and compare).
3. `xdb-key-scheme.test.ts`: the exact key strings (`xdb:<app>:<coll>`, `.corrupt.`, `xdb-meta:…:legacy-migration`, `xdb-sync-shared:…`) and the export envelope (`version: 1`), so a rename is a deliberate, tested migration.
4. `sync-room-security.test.ts`: for each of the four `startSync` entry points, the same (room, options, appId, stored flags) yields the same `password`/`encryptionKey`/`roomScope`; a shared room does not make a later private room shared; `stopSync` clears the persisted flag.
5. `db-namespace-parity.test.ts`: the method set and argument arity of B, the worker bridge and the renderer helper are identical (and C is absent from the library entry points).
6. `worker-parity.test.ts`: a script using `clearCollection`, `prune` and the id returned by `create` behaves the same under `execution: main` and `execution: worker`.
7. `sanitizer-corpus.test.ts`: a fixed corpus of CSS/HTML attacks (escaped `@import`, `image-set`, `data:text/html`, cased attribute names, `srcset` with remote candidates) asserted against `sanitizeBundleCSS` and `render.tsx`.
8. `formlogic-adapter.test.ts`: the generated bundle loads in core with `validateManifest`, seeds nothing, declares no capability, and (after 2.6) carries `app.id` in `permission.json`.
