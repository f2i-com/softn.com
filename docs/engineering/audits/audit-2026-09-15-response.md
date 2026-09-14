# Response to the 15 September 2026 audits

The five reports from that day (`audit-2026-09-15-structure.md`, `-core.md`,
`-apps.md`, `-formlogic-integration.md`, `-server.md`) were acted on in the
commits that follow the structure audit's first response. Every change keeps
existing `.softn` bundles opening as before: the bundle format, manifest and
`permission.json` semantics, the XDB key scheme, the export envelope, the
hand-off record and the host API are unchanged. Where a derived value would
have changed for an existing app, the old value was kept as canonical and
the reasoning is in the code.

## Done

### Structure (R1, R2, R3 of the structure audit)

- `@softn/bundle-format`: the archive reader, inspector, capability
  declarations and hand-off moved out of core (history kept); core re-exports
  under its old paths and inlines the package into its build; the site
  imports it instead of its drifted copies. `resolveBundleUrl` and
  `bundleNameFromUrl` joined it later.
- `@softn/editor-shared`: hand-off staging, same-origin remote open, modal
  focus and the hosted-editor bridge shared by Builder and Studio.
  `apps/shared/hostedEditor.ts` remains as a re-export because FormLogic's
  editor build checks that path.
- `resolveSiteUrls` in `@softn/brand` replaces the two `siteUrls` copies.
- `packages/@softn/core/wasm` (the retired FormLogic bytecode VM) and its
  adapter removed; nothing imported them.

### Core

- 2.1/2.3: one derivation of a sync room's scope, key and shared flag
  (`runtime/sync-room-security.ts`) and one set of start/stop/status
  controls (`runtime/db-sync-controls.ts`) used by the script runtime and
  the renderer. The sticky per-app shared flag is now per room; the legacy
  flag is still read for the saved room.
- 2.2: `readManifest`/`normalizeManifest`/`ManifestError` and
  `extractPermissions` in `bundle/manifest.ts`; every host uses them.
- 2.4: refused native writes surface in `getStorageStatus()` as a degraded
  `write-failed` issue; a native create notifies sync after SQLite
  acknowledges it, under the server id.
- 2.5: `config.xdb.sync`/`.collections` marked deprecated (accepted, never
  read).
- 2.6: the FormLogic adapter writes the app identity into `permission.json`
  so exports of one app share a room scope.
- 2.7: worker bridge gained `prune` and `clearCollection`.
- The inspector reports archive entries the reader drops as escape attempts.

### Apps

- H1/M6: one lenient manifest read in web, loader, Single, PHP-served Single
  and Builder; Builder lists an unlisted entry instead of refusing it.
- H2: the web launcher's hand-off rejection reaches the error card and
  `urlReady` is always set.
- M1/M3: see editor-shared above. M4: Studio's brief wizard and blueprint
  review are dialogs with a focus trap. M5: loader pre-paint script, with a
  brand test over every product-bar app. L2, L3: constants and `siteUrls`
  deduplicated.

### Server

- H1: `Db::rateLimit` has its own lock; uploads read the body before the
  catalogue lock.
- H2: the PHP host normalises route declarations to the Rust host's
  defaults, sets aside what it cannot serve (listed in `/api/meta` as
  `unservedRoutes`), and its body limit default is 256 KB with
  `maxBodySize` honoured up to 2 MB.
- M1: canonical and `og:url` only when `siteOrigin` is set; `/api/health`
  warns otherwise and reports `proxy.forwardedButUntrusted`.
- M2: owner and admin routes answer CORS only for `siteOrigin`,
  `allowedOrigins`, or the request's own origin.
- M4: `resolveSlug` no longer matches names; the publish `parent` field uses
  `resolveParent` (slug, else a unique name).
- M6: worker slot count from `config.server.workers` (default 4, cap 16).
- L2 retire deletes recursively; Rust L3 `..` rejected per path component;
  L4 `GET /tenants` only in `--dev`.

### FormLogic integration (in the FormLogic repository)

- M1: `ecosystem-manifest.mjs --check` verifies the vendored adapter against
  its provenance and against the Softn source (LF-normalised digests).
- M2: the PHP side checks the Node version against the runtime's minimum
  per request (cached), refusing with 503.
- M3: Node is launched with an allowlisted environment.
- M4: the manifest check runs inside `prepare-hosted-runtime`.
- L3: one protocol constant set (`softn/protocol.json`) on both PHP and TS.

## Second pass, same day

The deferred list above was worked through, and a sixth audit
(`audit-2026-09-15-remaining.md`: components, brand, vite plugin, scripts,
workflows, e2e, the Tauri side, the docs kit, the examples) was acted on.

- Server: Rust `--trusted-proxy=<peers>` with a CIDR list (bare flag keeps
  the old meaning); COOP/COEP sent by the static and private single-app
  hosts exactly as the site sends them, with tests reading the site's
  Apache config; L1/L5 documented in the API README; L6 pinned by a
  packaging test. M6 stays: answering `If-None-Match` without running the
  handler needs a data-version signal from the vendored runtime protocol.
- FormLogic host: a bounded call queue (4 in flight, 32 waiting) replaces
  the "please wait" error, `messageerror` is handled, and the error message
  carries a reason (extra field only).
- Core: a delete or update racing an in-flight native create is applied
  after the create lands and never resurrects the record; worker-mode
  creates use real UUIDs handed to the store; `xdb.ts` is split into
  types/service/registry/hooks/native-transport modules with every export
  unchanged; `useDynamicSoftN` is deprecated with a clear error because no
  desktop app registers its commands.
- Components: a generated `component-manifest.json` with a staleness test;
  chart palettes read `--color-chart-1..6` from the theme; a hex-literal
  ratchet test (no new file with literals, no file may grow).
- Apps: `@softn/single-shell` holds the single-app shell both variants use
  (the PHP-served variant no longer imports Single's `src`); unused exports
  removed after a repo-wide reference check; `@softn/test-utils` for the
  fake IndexedDB helper; a root `vitest.base.mjs`; dependency ranges
  aligned.
- Desktop: the loader reads only bundles the person opened (CLI, the
  native picker, a drop onto the window), backs up and restores its
  database through two wrappers so the page never names a path, caps the
  window icon at 1 MiB / 1024 px, and both desktop crates keep the web
  inspector out of release builds. XDB re-exports its network state type
  for the wrapper (pin bumped).
- Docs: the single-app runtime guide rewritten from the engineering guide
  (every `runtime.config.json` field), the two moved-guide links fixed, all
  ten capabilities and the whole `db` surface documented, a test that every
  repository link names a file in the checkout.
- Release: `apps/README.md` and `packages/README.md` explain every folder;
  one `scripts/release-packages.mjs` describes the five archives and
  generates each archive's `README.md`, the `RELEASE-GUIDE.md` attached to
  the release and the release notes from `CHANGELOG.md` (a tag without a
  section fails before anything is built); one shared zip writer
  (`scripts/lib/archive.mjs`); CI now runs verify on push and pull request,
  checks the loader's Rust crate, uses Node 24, and runs the Playwright
  journeys on release.
- Renamed: `apps/softn-single-php-serve` → `apps/softn-single-private`
  with its PHP under `php/`; the archives are `softn-website`,
  `softn-app-static`, `softn-app-static-with-backend-linux-x64`,
  `softn-app-private`, `softn-app-private-with-backend-linux-x64`, each
  explainer naming the previous name once.

Still open: Builder-side generation of its component registry from the
manifest; a package home for the web runtime modules the single shell
imports (`bundleProcessor`, `zipWarmup`, `FrameBar`); desktop code
signing; the historical `If-None-Match` item. (`apps/softn-php` and
`apps/softn-rust` were since renamed `apps/softn-host-php` and
`apps/softn-host-rust`, with the FormLogic scripts following.)

## Deferred at the first pass (for the record)

- Server M6 `If-None-Match` before taking a slot: needs a server-side
  response cache; the ETag is the hash of the authenticated handler's
  output and the host deliberately always runs the handler.
- Server M3 Rust `--trust-proxy=<cidr>`, M5 COOP/COEP agreement across the
  three hosts, L1, L5, L6: not started.
- Core 2.3 C (`createMockXDBModule` stays in `script-runtime.ts`): a public
  export used by many tests; moving it changes the surface for no
  compatibility gain. Worker `create` temp ids (`_wk_*`) unchanged; the
  ZIPP engine's fixed `DB_SYNC_OPS` list means `db.prune`/`db.clearCollection`
  are not yet reachable from `.logic` in either mode. `delete()` of a
  still-pending optimistic id can resurrect the record when the create
  lands: follow-up.
- Apps M2 (`softn-single-php-serve` importing Single's `src`), L1 (unused
  exports), L4 (FormLogic host back-pressure queue): not started.
- Structure: `@softn/test-utils` for cross-workspace test imports,
  dependency-range alignment, shared vitest base, `scripts/lib/`, the
  `xdb.ts` backend split and generated component registry: not started.
