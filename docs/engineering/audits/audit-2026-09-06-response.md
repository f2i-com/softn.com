# Response to the 6 September 2026 platform and examples audit

The audit reviewed softn.com at `48fbcfa` and softn-Examples at `bc31024`. This
is what was done about each finding, and where. Findings that are architecture
or test-infrastructure recommendations rather than defects are listed at the end
as open, with what a decision on them would involve.

## Fixed

| ID | Finding | What changed | Where |
|---|---|---|---|
| S01 | Rich text, SVG and CSS bypass the markup network check | The sanitizer takes the same judge the renderer applies to URL props (`markupUrlJudge`); `<RichTextEditor>` and `<Icon svg>` pass it from the capability context. A withheld URL waits on a `data-softn-withheld-*` attribute and is restored once allowed, so an editor's value survives consent. The CSS scan decodes escapes and comments and knows `url()`, `image-set()`, `image()`, `src()` and `cross-fade()`; an inline declaration it cannot read is dropped whole. | `renderer/sanitize-html.ts`, `renderer/render.tsx`, `runtime/egress-policy.ts`, `loader/consent-gate.tsx`, `components/display/Icon.tsx`, `components/editors/RichTextEditor.tsx`; tests in `core/test/sanitize-html`, `css-sanitizer`, `markup-egress` |
| D01 | Export, migration and deletion omit guest localStorage | `appDataStores(origin)` names both prefixes (`xdb:` records and `softn:` script keys); count, copy, migrate, export, import and remove go through it. Snapshot format 2 carries both stores; format 1 still reads. | `softn-web/src/lib/appCache.ts`; tests in `softn-web/test/appCache`, `appData` |
| D02 | Storage bridge suppresses write failures | A refused `localStorage` write throws into the script and reaches the host through `onPersistenceFailure`, which the renderer shows as a dismissable notice with the browser's reason. The engine flattens the exception's message, so the reason travels on the host path. Worker mode reports each lost mutation and re-syncs truth on the next snapshot. | `runtime/zipp-wasm-adapter.ts`, `script-runtime.ts`, `script-worker-runtime.ts`, `loader/SoftNRenderer.tsx`; test `core/test/localstorage-bridge-failure` |
| D03 | Import rollback is not crash-atomic | An import writes a journal of what it replaces before touching anything; `recoverInterruptedImports()` runs at startup and puts the old keys back. A journal that cannot be written refuses the import untouched. | `appCache.ts`, `softn-web/src/App.tsx` |
| B01 | Build credential sent to every https source | A token goes only to the pinned repository on `github.com` / `api.github.com`; redirects are followed by hand without it. | `scripts/fetch-demos.mjs`; test `scripts/fetch-demos.test.mjs` |
| B02 | Downloader unbounded | Each archive streams against its pinned size with a per-transfer deadline and bounded retries; the served set is replaced only after every archive has verified. | `scripts/fetch-demos.mjs` |
| S02 | Authorization and quota separate from the write | Every write is one `BEGIN IMMEDIATE` transaction; `UPDATE`/`DELETE` name the row's owner as well as its id and must change exactly one row, else 409. Lock contention is a 503. | `softn-api/lib/storage.php`; tests in `softn-api/test/api.test.mjs` |
| S03 | Collection listing bypasses read policy | The listing takes the caller: publisher collections are hidden from visitors, private ones show the visitor's own count and are hidden without a token. | `storage.php` |
| S04 | Implicit public storage | DeadHours and Snake declare `scores` append-only and say on the board that scores are self-reported; Notes declares its collection public on purpose. Publishing warns (engine and site alike) when storage is enabled with no policies. | Examples `bundles/*/permission.json` and `ui/`; `core/src/bundle/inspect.ts`, `softn-site/src/lib/inspectBundle.ts` |
| O01 | Quota ignores the WAL | The quota is the data itself (record and key bytes), counted inside the write transaction; `diskBytes` (main file, WAL, SHM) is reported separately. | `storage.php` |
| U01 | "No network" overstates | "No general network access" on the app page, publish preview and cards; the filter is "No general network"; the badge's title says hosted services still reach the site. | `softn-site` pages, `lib/format.ts`, `components/directory/` |
| G01 | Poker resume clears the ticket on temporary failure | Only the server's own word (closed, no such table, ticket unknown) clears the ticket; anything else keeps it, shows a banner with a "Try now" button, and retries with a growing pause. Views apply only when their revision is newer; late answers after leaving are dropped. | Examples `TexasHoldem/logic/authority-client.logic`, `ui/main.ui`; `scripts/test-texasholdem-authority-client.cjs` |
| G02 | Pocket battery ignores write failure | A refused battery write keeps the save in RAM, tells the player in the drawer, and is retried while playing; pending saves are flushed before pause, reset, cartridge swap and the drawer opening. Saves are keyed by a digest of the whole ROM, with saves under the old key migrated on first load. | Examples `Pocket/logic/main.logic`, `ui/main.ui` |
| P01 | PhotoStudio fixed pixel budget | Compositing slices are timed and the budget adapts towards a 12 ms slice, smoothed; job steppers read the live budget each step. | Examples `PhotoStudio/logic/ps_editor.logic`, `ps_core.logic` |
| R01 | Release assets replaceable | The workflow confirms an existing tag's archives and refuses to replace different ones; write permission is confined to the publish job; actions are pinned to commits; a repository ruleset blocks deleting or moving `v*` tags. | Examples `.github/workflows/`, repository rulesets |

## Open

| ID | Finding | What a decision would involve |
|---|---|---|
| R02 | Runtime–examples compatibility contract | Deciding what versions the catalogue should carry (bundle format, capability schema, tested runtime commit, ZIPP artifact digest) and adding a cross-repository job in each direction. |
| Q01 | Browser-level scenario matrix | Choosing the scenarios to gate on (permission denial, storage failure, reconnect, repeated mount) and the harness; the shipped ZIPP artifact would run in headless Chromium in CI. |
| U02 | Actionable capability failures | A structured diagnostic channel from the runtime to the host, with a developer panel. The persistence notice added for D02 is the first use of that idea; generalising it is a design choice. |
| A01 | Artifact identity versus deployment identity | An integration test with identical bytes under two directory slugs, then a decision on which contexts key on the slug. |
| P01 (rest) | Worker compositing, cancellation, measurements on named devices | Instrumentation first; the adaptive budget above is the cheap half. |
| S04 (rest) | Server-side score validation | A server-authoritative run protocol for competitive rankings; append-only plus honest labelling is what ships now. |
