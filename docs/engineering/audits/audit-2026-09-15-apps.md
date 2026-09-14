# softn.com apps: design and behaviour audit (read-only, 15 September 2026)

Scope: `apps/softn-builder` (28 421 lines of TS/TSX, 130 files), `softn-studio` (14 841 / 48), `softn-web` (7 821 / 24), `softn-single` (653 / 5), `softn-single-php-serve` (378 / 5), `softn-loader` (1 959 / 9, TypeScript side), `apps/shared` (1 file, 128 lines), `apps/formlogic-host` (130 lines). Method: grep/diff/wc, reading of the open, handoff, identity, permission, theme, service-worker and error paths, plus a script that lists exports nothing else in the same app references. Nothing modified.

## 1. Findings by severity

### High

**H1. A bundle without `manifest.files` opens in some apps and crashes or is refused in others (backwards-compatibility split).**
Core is lenient: `packages/@softn/core/src/bundle/inspect.ts:152-169` validates `manifest.files` only *when present*, and `composeBundleSource` (`bundle/source-composer.ts:101-104`) defaults the logic list to `[]`. The apps disagree:
- `softn-web/src/lib/bundleProcessor.ts:284` (`manifest.files.xdb || []`) and `:313` (`manifest.files.logic`) dereference `files` unguarded, so after `App.tsx:676-698` accepted the manifest (it checks only `name` and `main`) the load dies with a `TypeError` instead of the runtime's own error text.
- `softn-loader/src/bundleRuntime.ts:40` (`manifest.files.logic`) and `:62` (`manifest.files.xdb ?? []`) — the same crash on desktop; `softn-loader/src/App.tsx:438-443` never validates `main` or `name` at all, and a manifest that is not JSON surfaces as a raw `SyntaxError` message.
- `softn-single/src/load.ts:54-62` refuses outright (`!raw.files` → "Invalid application manifest").
- `softn-builder/src/utils/bundleLoader.ts:175-177` is stricter still: the entry file must be *listed in* `manifest.files.ui`, so a bundle whose `main` is present but unlisted (valid for core, web and studio) cannot be opened in Builder.
- `formlogic-host/src/main.tsx:83` (`manifest.files?.logic || []`) and Studio tolerate it.
Fix: one `readManifest(textFiles)` in core (exported next to `composeBundleSource`) that returns a normalised manifest (`files` defaulted to `{}` with each group an array, `main` verified present) and a typed error; every app calls it. Keep core's leniency so existing bundles keep opening everywhere; Builder should list an unlisted entry rather than refuse it.

**H2. The web runtime can strand the launcher on a failed handoff.**
`softn-web/src/App.tsx:1047` returns `takeBundleHandoff(id, 'runtime').then(...)` with no `catch` inside `openFromUrl`; the other branches are wrapped in `try/catch` (`:1060-1066`). The caller at `:1495` does `openFromUrl(...).then(() => setUrlReady(true))` with no `catch` either, so an IndexedDB failure in the handoff read rejects unobserved and `urlReady` is never set: whatever waits on it keeps waiting, with no error and no retry. Same shape at `:1521` (`attempt.then(...)`). Fix: `finally(() => setUrlReady(true))` and route the rejection to `setError`.

### Medium

**M1. Duplicated editor plumbing between Builder and Studio, drifting.** See the table in §2. `handoff.ts` differs by 65 stripped lines (59 vs 80); `openRemoteBundle` exists twice with different safety properties: Studio (`projectSession.ts:649-675`) checks that a redirect stayed on this origin and cancels the body; Builder (`openProject.ts:682-712`) confirms before replacing dirty work and checks a workspace generation after every await. Neither has both. `bundleNameFromUrl` in Studio (`projectSession.ts:619-628`) understands `/app/<slug>/bundle.softn`; the web copy (`remoteBundle.ts:123-131`) names such a bundle "bundle".

**M2. `softn-single-php-serve` imports Single's source by relative path.** `softn-single-php-serve/src/load.ts:7-8` imports `../../softn-single/src/config` and `../../softn-single/src/SingleApp`; its `load.ts` differs from Single's by 224 stripped lines. Two apps, one of them reaching into the other's `src`, is the pattern the root audit flagged for tests, now in production code. Fix: a `packages/@softn/single-shell` (or fold the PHP-served variant into `softn-single` behind a source-pack option).

**M3. `apps/shared/hostedEditor.ts` is not a workspace.** One 128-line file, imported by five files across Builder and Studio by `../../shared/...`, tested only through `softn-builder/src/hostedEditor.test.ts:13` (a dynamic import by relative path); no `package.json`, no own typecheck. Fix: `packages/@softn/editor-shared` with the duplicated helpers from M1.

**M4. Studio's overlays have no dialog semantics.** Studio has zero `role="dialog"` (Builder has four, each with `aria-modal`, a labelled title and a tab trap: `ExportDialog.tsx:518-528`; web's `PermissionPrompt.tsx:255-263` likewise). Studio's BriefWizard (1 269 lines) and BlueprintReview are full-screen overlays with `role="status"`/`role="group"` inside but no dialog role, no `aria-modal`, and only 10 focus/Escape handlers across all Studio components. A screen-reader user has no announcement that a wizard opened and focus is not held. Fix: reuse Builder's `useModalFocus` (`softn-builder/src/hooks/useModalFocus.test.ts` exists) from the shared package.

**M5. Theme pre-paint is inconsistent.** `softn-builder/index.html`, `softn-studio/index.html` and `softn-web/index.html` carry the `softn.site.theme` pre-paint script; `softn-loader/index.html`, `softn-single/index.html` and `softn-single-php-serve/index.html` do not (0 matches). The loader wears the product bar with a theme toggle, so a light-mode reader gets a dark flash on every desktop start; Single is unbranded by design, so only the loader is a defect. `@softn/brand/theme.ts` exports `PRE_PAINT_SCRIPT` precisely so each app can inline it; nothing checks that they did. Fix: a test in `@softn/brand` that reads each app's `index.html` and asserts the script is present where the bar is used.

**M6. Manifest validation strictness varies with no shared error vocabulary** (the other half of H1): web checks `name` type and length ≤ 255 (`App.tsx:687-695`), Single checks `name`, `main`, `files` and that `main` exists (`load.ts:55-62`), loader checks nothing, Builder checks entry listing. The same bad bundle gets four different messages. Same fix as H1.

### Low

**L1. Unused exports.** Script `dead_exports.py` (exports no other file in the app, tests included, references): Builder 20 (e.g. `utils/sourceFidelity.ts` exports eight helpers only it uses; `PreviewFrame`, `DropIndicator` components unreferenced), Studio 26 (`lib/persistence.ts` legacy helpers `hasLegacySnapshots`, `loadLegacyProject`, `legacyProjectToRecord`, `isPersistedWorkspace`; `lib/agentOrchestrator.ts` budget constants; `projectSession.ts` `currentGeneration`/`touchRevision`/`isHydrating`/`isSavedAt`/`markSaved`), web 4, Single 2 (`SingleApp.tsx:Failure`, `config.ts:localUrl`), loader 5. Most are "exported for symmetry"; the Studio persistence legacy path is worth either a test or removal.

**L2. Duplicated constants inside Studio.** `DEFAULT_REQUEST_TIMEOUT_MS` and `DEFAULT_MAX_OUTPUT_TOKENS` are defined in both `lib/aiProvider.ts:16-17` and `stores/aiStore.ts:11,22` (same values today; two places to change).

**L3. `siteUrls.ts` exists twice with different dev-detection rules.** Builder (`utils/siteUrls.ts`) branches on `isDesktop()` and `import.meta.env.DEV`; Studio (`lib/siteUrls.ts`) on `BASE_URL === /studio/` ("shared origin") — the Builder rule does not know the integrated dev launcher, the Studio rule does not know desktop. Both export `PUBLISH_URL` (unused in Builder).

**L4. FormLogic host: backend-call back-pressure is an error, not a queue.** `formlogic-host/src/main.tsx:26` resolves `{ error: 'Please wait for the current request.' }` when four calls are in flight, so an app that fires five `softn.backend.call`s at once (a dashboard with five widgets) sees a spurious failure on the fifth rather than a delay; `:29` times each call out at 20 s with no retry. Fix: queue (bounded, say 32) and surface a single visible "backend busy" state.

**L5. Silent catches are numerous but, in the sample, justified.** 44 empty `catch {}` in web, 26 in Studio, 14 in Builder. The eight sampled in `softn-web/src/App.tsx` (:209, :250, :264, :351, :365, :386, :394, :684) all guard storage/URL parsing with a comment. Not a finding; noted so nobody re-counts them.

**L6. Resource hygiene is balanced.** `createObjectURL`/`revokeObjectURL` 6/6 (Builder), 4/4 (Studio), 3/3 (web), 1/1 (loader); `new Worker`/`terminate` 2/2 (web); `window|document.addEventListener`/`removeEventListener` 20/20, 10/10, 6/6. No leak found by count.

## 2. The FormLogic host iframe: contract and assessment

`apps/formlogic-host/src/main.tsx` is the trusted shell FormLogic embeds at `/hosted-runtime/index.html` in `<iframe sandbox="allow-scripts" referrerPolicy="no-referrer">` (`formlogic/ui/src/components/studio/HostedAppFrame.tsx:188-196`), so the shell runs in an **opaque origin** with no FormLogic credentials.

| Direction | Message | Contents | Check on receipt |
| --- | --- | --- | --- |
| shell → parent | `formlogic:ready` (`main.tsx:97`, `postMessage(..., '*')`) | `nativeProtocol: 1`, `zipp: { version, sha256 }` from the vendored `SOURCE.json` | Parent accepts only from `frame.contentWindow`, once, and refuses when `matchesZippRuntime` fails or `nativeProtocol !== 1` for a native app (`HostedAppFrame.tsx:53-70`); 90 s overall timeout with a reload prompt (`:44-52`). |
| parent → shell | `formlogic:init` (`HostedAppFrame.tsx:152-165`, targetOrigin `'*'`, one `MessagePort` transferred) | `client` (files), `appId` (`native-<slug>` or `hosted-<slug>-<version>`), `native`, `assets` (base64), `storage` snapshot, `dark`, `zippWasm` (cloned bytes) | Shell accepts only `event.source === parent`, only once (`started`), requires a port and 8 B…32 MiB engine bytes (`main.tsx:45-56`). No origin check (impossible for an opaque origin; the parent is whoever embedded the shell). |
| shell → parent (port) | `{ type: 'call', id, action, input }` | backend action; at most 4 in flight, 20 s each | Parent validates `type`, `id` safe integer, `action` `/^[a-z][a-zA-Z0-9_-]{0,63}$/`, `input` a plain object (`:93-108`); `nativeRequest` URLs must be same-origin or a declared native origin (`:128-129`). |
| parent → shell (port) | `{ id, result }` | action result | Shell matches by id only; `result` is trusted verbatim (`main.tsx:38-44`). |
| shell → parent (port) | `{ type: 'error' }` | load failure | Parent shows a fixed message (`:89-93`). |

What the shell trusts: everything in `formlogic:init` (files, assets, storage, app id, engine bytes), because the parent is trusted by construction. What it enforces itself: a runtime-injected CSP (`main.tsx:11-15`: `default-src 'none'`, scripts and connections only from the shell's own directory, `frame-src 'none'`, `form-action 'none'`, `worker-src blob:`), `permissionConfig: { permissions: {} }` so a bundle's `permission.json` cannot grant network/hardware/sync (`:90`), `resumeSavedSyncRoom={false}`, main-thread script execution, and a synchronous `localStorage` replacement (`storage.ts`) with ordered acknowledged writes to the parent, limits of 200 keys / 30 000 chars per value / 256 KiB total, and a visible alert when persistence fails.

Weaknesses (none severe):
1. Anyone can embed the public shell URL and drive it with their own `formlogic:init` — but they get only their own files running in an opaque frame with a port they supplied; no FormLogic state is reachable. Acceptable; worth a sentence in `apps/formlogic-host/README.md`.
2. The CSP is a `<meta>` appended after the module script has executed (`main.tsx:11-15`), so it governs later loads only; the shell's own bundle is already trusted, and `index.html` has no CSP of its own. Moving the policy into `index.html` (or the parent serving the shell with a CSP header) would make it apply from the first byte.
3. Back-pressure and timeout (L4). Also no `messageerror` handler on the port; a structured-clone failure of a result is silently a timeout.
4. `event.data.native === true` prepends a `<logic>` bridge to the entry file (`main.tsx:72-81`) by string concatenation; correct today, but any future need to keep the entry's own `<logic>` first would have to touch this.
5. The `Boundary` error message and the catch-all `catch {}` at `:93` both report "Check the interface and logic files" without the reason; the parent only learns `{ type: 'error' }`. A reason string would help the app author.

## 3. Duplicated symbols to consolidate

| Symbol | Copies | Better version and why | Home |
| --- | --- | --- | --- |
| `prepareHandoff`, `handoffBase`, `destinationLabel` | `softn-builder/src/utils/handoff.ts:30-59`, `softn-studio/src/lib/handoff.ts:38-80` | Studio: builds the bundle itself, records `stagedAt`, `capitalise` helper, explains the same-origin refusal; Builder adds the desktop branch ("export instead"), which the shared version must keep. | `@softn/editor-shared` |
| `openRemoteBundle` | `softn-builder/src/utils/openProject.ts:682`, `softn-studio/src/lib/projectSession.ts:649` | Merge: Studio's redirect-origin check and body cancel + Builder's dirty-work confirmation and generation check after every await. | `@softn/editor-shared` |
| `bundleNameFromUrl` | `softn-studio/src/lib/projectSession.ts:619`, `softn-web/src/lib/remoteBundle.ts:123` | Studio: handles `<slug>/bundle.softn` and decoding; web's returns "bundle" for directory URLs. | `@softn/bundle-format` (root audit 2.1) |
| `openRemoteBundle`'s same-origin rule vs web `resolveBundleUrl` | `softn-web/src/lib/remoteBundle.ts:18-45` | Web's is the most careful (scheme before origin, blob: refusal); reuse it in both editors. | `@softn/bundle-format` |
| `SITE_URL`, `RUNTIME_URL`, `PUBLISH_URL` (+ `STUDIO_URL`, `PRODUCT_URLS`) | `softn-builder/src/utils/siteUrls.ts`, `softn-studio/src/lib/siteUrls.ts` | Neither: union of Builder's desktop branch and Studio's shared-origin detection, next to `DEFAULT_URLS` in `@softn/brand/ProductBar.tsx` which already knows the production layout. | `@softn/brand` |
| `DEFAULT_REQUEST_TIMEOUT_MS`, `DEFAULT_MAX_OUTPUT_TOKENS` | `softn-studio/src/lib/aiProvider.ts:16-17`, `softn-studio/src/stores/aiStore.ts:11,22` | `aiProvider.ts` (the consumer); the store should import them. | Studio |
| Single-app load pipeline | `softn-single/src/load.ts`, `softn-single-php-serve/src/load.ts` (224 differing lines; the latter imports the former's `src`) | Single's (`fetchBytes` bounds, digest pin, `execution` handling, favicon size guard); the PHP variant differs in where the pack comes from. | `@softn/single-shell` |
| Manifest read + validation | web `App.tsx:676-698`, Single `load.ts:54-62`, loader (none), Builder `bundleLoader.ts:104-177`, host `main.tsx:83` | Core, new: `readManifest` on top of `inspectBundle`'s rules (lenient on `files`, strict on `main` existing). | `@softn/core` |

## 4. Test coverage holes for the main flows

- Web: no test opens a bundle whose manifest lacks `files` (H1) or exercises the handoff-rejection path (H2); `test/openFromUrl.test.ts` covers URL policy, not the promise chain.
- Loader: `test/bundleRuntime.test.ts` and `desktopApp.test.tsx` never pass a manifest without `main` or `files`.
- Builder: `bundleLoader` has round-trip tests but none for "entry present, not listed in `files.ui`".
- Studio: no accessibility assertions for BriefWizard/BlueprintReview (Builder has `useModalFocus.test.ts`).
- Single vs php-serve: each has `load.test.ts`; nothing asserts the two shells accept the same bundles.
- FormLogic host: tested only from the FormLogic side (`HostedAppFrame.test.tsx`); the shell's own storage limits and back-pressure have no test in this repository.

Out of scope, noted: the Rust side of the loader was only read for its command list (it registers XDB commands explicitly, including the new `update_records`/`recover_restore`); nothing here contradicts the root structure audit.
