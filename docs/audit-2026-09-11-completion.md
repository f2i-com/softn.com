# Audit 2026-09-11 — completion record

Reference: `SoftN-Audit-AI-Dev-Handoff-2026-09-11` (34 items), audited at commit `b9d291f`.
Repairs: thirteen commits `b135b63..6669d82` on `main`, 2026-09-11.

This record distinguishes what was executed from what was not. "Executed" means run on this
machine (Windows 11, Node 24.12, PHP 8.4.15, Chromium via Playwright 1.63) on the final tree.

## Executed on the final tree

| Check | Result |
|---|---|
| `npm run typecheck` (root, includes test files) | clean |
| `npm run lint:errors` | 0 errors (223 pre-existing `no-console` warnings) |
| `npm run build:packages` + `npm run build:apps` + `SOFTN_WITH_DEMOS=1 npm run build:site` | clean |
| `npm test` (every workspace) | all suites pass except two tests in `packages/@softn/components` (`lazy-entries.test.ts`) that fail only with the pre-existing uncommitted edits to `ViewportTileMap.tsx` / `tilemap-window.ts` in the working tree; they pass with those edits stashed. Not part of this repair. |
| Per-workspace counts | core 869; site 66; studio 174; builder 243; web 171; api 66; loader 62; single 74; vite-plugin 4 |
| `npm run e2e` (Playwright, built topology on one origin, php -S API on a disposable data dir) | 7 passed, 7.3 s |

## Not executed

Firefox/WebKit, mobile widths and 200 % zoom, screen-reader sessions, popup-blocked mode, the
10,000-app catalogue benchmark, a dependency CVE scan, production proxy/header inspection, and any
live-site or paid-provider request. No real hosted app was published, updated or deleted.

## Per issue

Legend: **R** = reproduced on HEAD with a focused test before the fix; **P** = partially addressed.

### Wave A

- **SITE-01** (P0) R. `apps/softn-site/src/lib/api.ts`, `pages/PublishPage.tsx`, `test/your-apps.test.tsx`. Lookups classified loaded/missing/unavailable; a listing refresh never touches the key map; explicit two-step forget scoped to one slug; unreadable map is never replaced. Also gated by e2e spec 4.
- **SHR-01** (P1) R. `packages/@softn/core/src/bundle/handoff.ts`, `apps/softn-site/src/lib/handoff.ts`, `test/handoff.test.ts` (site pins the producer address against its router). Publish goes to `/publish?from=handoff&handoff=<id>`; base prefixes join cleanly. e2e specs 1, 2, 6.
- **SHR-02** (P1) R (unit; plus the audit's isolated browser premise). Studio `lib/handoff.ts` + `components/common/HandoffReady.tsx` + `TopBar.tsx`; Builder `utils/handoff.ts` + `ExportDialog.tsx`. No `window.open`; staged first, then a `rel=noopener` link the person clicks, with an explicit same-tab alternative; cross-origin dev receivers reported before staging. e2e specs 1, 2, 4, 5 assert the editor URL and page count are unchanged and `window.opener === null` in the receiver.
- **SHR-03** (P1) R. Addressed records with unguessable id, SHA-256, destination, expiry; atomic claim counted only on commit; wrong destination left in place; StrictMode-safe memoised claims. `packages/@softn/core/test/bundle-handoff.test.ts` (16), site copy tested against core's implementation. Test double: `packages/@softn/core/test/helpers/fake-indexeddb.ts`.
- **BLD-01** (P0) R (3 of 4 round-trip cases fail without the guard). `filesStore.updateUIFile` no-op on structurally equal trees (`utils/elementsEqual.ts`); source-only mode for lossy files (see BLD-02/03 commit). `utils/roundTrip.test.ts`.
- **STU-01** (P0) R. Prompt records what it supplied (complete/truncated, version); whole-file writes for partial, unseen or stale files refused; `<softn-read>` rounds. `test/agentOrchestrator.test.ts`.

### Wave B

- **SHR-05** (P1) R. `apps/softn-studio/src/lib/paths.ts` used by import, VFS, changeset, export and validator; F10 table in `test/paths.test.ts`; `assets/version..png` kept everywhere.
- **SHR-04** (P1) R in both editors. Studio: workspace generation claimed before fetch, re-checked before commit, restore-first precedence (`test/remoteOpen.test.ts`). Builder: `openRemoteBundle` bound to `workspaceGeneration`, confirm before replacing edited work (`utils/openProject.test.ts`).
- **BLD-02** (P1) R. `utils/expressionPrinter.ts`; `(a + b) * c` evaluates to 25 in the engine after a round trip; 105 printer cases. Caveat: core's AST carries no source spans, so the printer is canonical rather than slice-preserving.
- **BLD-03** (P1) R. Blocks are explicit nodes (`CanvasElement.block`), `#empty`/`#elseif` kept, nested loops keep both levels; `utils/blockStructure.test.ts`. Caveat: the canvas shows a block's branch as a notice rather than droppable children.
- **BLD-04** (P1) R. `utils/xdbFormat.ts` shared by both exporters; schema, aliases, relationships survive. Studio-preview parity not exercised.
- **BLD-05** (P1) R. Record identity kept in `schemaStore` (`recordIdentity`, `tombstones`); ids/timestamps stable on no-edit; `updated_at` moves only with data. No "import as new" operation offered.
- **BLD-06** (P1) R. Retained manifest and opaque passthrough entries in `projectStore.source`; declared `main` followed by file id; `utils/migrations.ts` allowlist; `utils/bundleRoundTrip.test.ts` compares the full inventory and manifest of a no-edit export (F06) byte-for-byte.
- **BLD-07** (P1). `utils/saveProject.ts`: revision captured before build, `markCleanIf`, distinct cancel / I-O failure / session-storage failure outcomes (`saveProject.test.ts`).
- **BLD-08** (P1). `utils/openProject.ts`: validate a complete candidate, commit atomically with rollback; quarantine malformed recovery payloads with download (`openProject.test.ts`).
- **STU-02** (P1) R. `lib/changeset.ts`; all-or-nothing commit under a turn id; "Revert this turn" in the chat. Reviewed-subset apply not offered.
- **STU-03** (P1) R. One `ProjectRecord` per project in IndexedDB, typed `SaveResult`, `SaveStatus` indicator with in-memory Export; migration only after read-back (`test/persistence.test.ts`, `projectRecords.test.ts`).
- **STU-04** (P1) R. Durable ids, id-keyed recent list, remove-from-list vs scoped delete, checkpoint before replace, provider settings outside project records.
- **SITE-02** (P1) R. `apps/softn-site/src/lib/selection.ts`; generation-guarded selection, admission before read, bounded concurrency (`test/publish-selection.test.tsx`). Per-row retry exists in the module but is not exposed on the page.
- **QA-01** (P1). `e2e/` Playwright gate, `scripts/serve-topology.mjs`, CI job `e2e` in `.github/workflows/build.yml`. Sensitivity: SHR-02 regressions fail the URL/page-count assertions, SHR-01 the `/publish` href, SITE-01 the key-unchanged assertion.
- **QA-02** (P1). Runtime/core matrix (`packages/@softn/core/test/threat-boundary-*.test.ts`, `apps/softn-web/test/appStorageIsolation.test.ts`) and API policy matrix (`apps/softn-api/test/policies.test.mjs`). One real defect found and fixed: the runtime granted a capability for any truthy `enabled` (`b606169`). Deployment headers (COOP/CSP) are checked by `scripts/smoke-site.mjs`, not by unit tests.

### Wave C / D

- **STU-05** (P2) R. Completion status, all text blocks, sanitised usage, timeout, 429 Retry-After; truncated replies never applied; budget reserved before send. No settings UI yet for timeout/max-output.
- **STU-06** (P2) R. Exact create/update contracts, unit-based undo/redo, whole-unit pruning. Known gap: a file deleted and re-created restarts at version 1.
- **STU-07** (P2) P. `components/mobile/MobileProjectMenu.tsx` shares desktop actions; Export reachable when Run is refused. 200 % zoom not verified in a browser.
- **STU-08** (P2) R. Managed groups rebuilt; stale `server` group removed; dangling unknown-group entries pruned with a warning.
- **SITE-03** (P2). Typed key persistence result, "not kept" notices, key backup export/import with per-entry validation. Backups are plain JSON, not encrypted.
- **SITE-04** (P2) R. Not-found page, bounded `page` parameter, distinct no-results / not-loaded / failed states, previous results kept on failure. A true 404 status needs deployment routing.
- **UX-01** (P2) P. Site route focus and labels; Studio recent rows as buttons; Builder export dialog with dialog semantics and focus trap. Not a WCAG audit.
- **UX-02** (P2) P. Studio settings explain what exists today; consistent Preview / Run / Save project / Export bundle / Publish wording in Studio. No first-run guided example.
- **PLT-01** (P2) P. Explicit preview-data reset and a documented reseed policy in Studio; sandbox unchanged. Runtime-parity test across all run paths not built.
- **PLT-02** (P2) P. Studio autosave debounced and revision-skipped; Builder no longer regenerates unchanged files. No benchmark fixtures or measurements committed.
- **API-01** (P2) R. Bounded reader per route, declared-vs-actual length checks, decoded-size and image budgets, temp cleanup (`test/admission.test.mjs`).
- **API-02** (P2) R. `trustedProxies` list with right-to-left chain walk; boolean kept as deprecated alias (`test/proxy.test.mjs`).
- **API-03** (P2) P. Lock/boot/rebuild/commit timings on `/api/health`; killed-writer recovery test; `scripts/bench/catalog-bench.mjs` run at 100 and 1,000 apps (10,000 not run). The numbers put the current design's envelope at a few hundred apps; the two costs to fix first are the 5-second cache revalidation and per-card catalogue reads. Not changed here: the audit asked for measurement, not migration. The 100-app phase ran with a second benchmark accidentally contending; rerun before quoting.

## Not addressed

- QA-02 backup-restore as a product capability (API-03 acceptance item).
- Firefox/WebKit and mobile-width browser runs (scheduled/release matrix).
- A Studio settings control for the new provider timeout and output cap.
