# Changelog

One section per release tag, newest first. The release workflow takes the
section for the tag being released and puts it at the top of the release
notes, above the downloads table; it refuses to package a tag that has no
section here. Write the section before tagging. Headings are the tag
(`## v1.2.3`); anything after the tag on the heading line is ignored.

## Unreleased

- Studio can be taken to an app with a request to build: the hosted editor bridge gains an optional `agentRuns` capability. Studio announces it; a host that answers it may open Studio with `brief: { prompt, kind }`, and Studio puts the request in its chat and runs its agent on it. Studio then reports its agent to that host (`agent-status`: running with the current step, waiting, paused, stopped, finished with the summary, failed with the reason), so the host can show the work and hold its own review while the agent writes. Hosts that do not answer it see the bridge exactly as before. `docs/engineering/FORMLOGIC_INTEGRATION.md` describes the wire.
- Studio's agent knows how to write an app's private backend: a project whose manifest has a `server` block gets a guide to its routes, `server/main.logic` handlers, `softn.sql` and numbered migrations, and to calling it from the page, held by a test to what the host runtime does.
- `.sql` is text to every reader (`application/sql`): an editor held a private backend's migrations as opaque bytes, so Studio's agent could neither read the schema nor write the next migration.
- In a hosted editor, the migrations a project arrives with have run on its host's database: Studio's agent is refused a change, delete or rename of one and told to add the next numbered migration instead, which the host then applies. (A host refuses to start on a changed migration; the agent used to rewrite `001.sql` and find out only when the host refused the whole version.)
- `check_app` checks an app's private backend the way its host starts it: routes a host serves (exact `/api/` paths; GET, POST, PUT or DELETE; once each), listed migrations that exist, and an entry that loads in the real engine and defines a function for every route. A host refuses a whole version whose backend does not start; the agent now finds that before it finishes.
- The backend guide gives a host's SQL rules exactly — the functions a query may call, the clock functions a migration may add, no triggers, views, PRAGMAs or transactions, SQLite not Postgres — held by a test to the host's own lists, and `check_app` refuses what a host always refuses in a migration or in a query written as a plain string (a real model's `datetime('now')` in a query, and a migration the host would not run).
- A hosted editor waits 630 s for an AI answer rather than 180: one round of an agent writing whole files runs minutes on a local model.
- The hosted editor reads the app a host sends by its type tag rather than `instanceof`, so an array cloned from another realm is not refused.

## v0.0.17

- The FormLogic runtime archive carries the native runtime's `sql.mjs`. v0.0.16's native runtime imported it from `migrations.mjs` and `wasm-host.mjs` but the archive's fixed module list never gained it, so FormLogic's native runtime could not start and every native app request failed. The packager now refuses to build when a native module imports a file the archive does not carry, and a test holds the list to the modules' imports.

## v0.0.16

- ZIPP v0.0.21 (commit `9df6e2fd`): the browser engine (`npm run fetch:zipp`) and the Rust host's `zipp-vm` tag move together to the release; the Rust host builds and passes unchanged. ZIPP's Python now parses with its own front end (`zipp-pyparse`) instead of a RustPython fork, runs faster, and prints CPython's tracebacks; Softn's Python and FormLogic dialect suites pass on it unchanged. Since 0.0.21 ZIPP's complete `web-python` bundle builds torch in (9.4 MB raw); Softn takes the new `web-python-base` bundle instead, the same JavaScript-and-Python engine without torch and with a byte-identical glue: 7.46 MB raw (8.2 MB for 0.0.19's engine), so every page downloads less than before and the Workbox precache caps of the web runtime, Builder and Studio stay at 8 MiB. Torch comes from the release's `web-torch` bundle, installed beside the engine as a verified package (`packages/@softn/core/wasm-zipp-torch/`: `zipp_torch.wasm`, 2.05 MB, and ZIPP's `zipp_torch.js` loader), held to the same `SHA256SUMS`, its own, a `BUILD-INFO.txt` pairing it with exactly the installed engine bundle and commit, and proven at install by adding it to the engine and running `import torch`; `wasm-zipp/SOURCE.json` records it under `packages.torch`. The runtime loads it on demand, once per page, only for an app that declares torch; it is not in any PWA's startup precache.
- The JavaScript-only `web` variant is held to import nothing the engine's glue does not provide, rather than exactly the engine's imports: 0.0.21's `web` build has no torch and so does not import the torch kernel hook, which instantiation simply leaves unread. It is still loaded under the engine's glue at install and must report `["javascript"]` with its Python entry points refusing.
- The curated ZIPP notices drop the RustPython parser's MIT licence, since 0.0.21 contains no RustPython code (zipp-pyparse's README says so); the Unicode notice stays.
- A Python app's `.py` files are text in every loader. `@softn/core`'s asset registry had no `py` entry, so a `.py` fell to the opaque-bytes default, the web runtime kept it out of the files the composer reads, and a bundled Python app failed at Run with its own `main.py` "not in the bundle". The Builder's preview, which composes from its own file map, never showed it. The PHP host's copy of the registry gains the same entry.
- Python apps run in every runtime. The shared `processBundle` was typed as three fields of the composition, and the web runtime, the single-app shell and the desktop loader each passed on only those three, so a Python app opened in any of them as a page with no logic at all; only the Builder's preview and the engine tests, which build the prop themselves, ever ran one. Each host now forwards the app's `python` project, and `scripts/python-hosts.test.mjs` fails by name if one stops.
- Python apps can use torch for machine learning by declaring it: `"config": { "python": { "packages": ["torch"] } }` in `manifest.json`. The composer refuses an `import torch` the manifest does not declare, naming the line to add; the inspector refuses a package the runtime does not offer; `torch.py` is a reserved module name; and the runtime adds ZIPP's torch package (`zipp_torch.wasm`, fetched from beside core's chunk, or supplied by a host through `configureZippTorchSource`) the first time a declaring app starts, once per page; an app that declares nothing never fetches it. Only if that load fails is the app refused by name, with the reason, before it compiles. `examples/torch-trainer/` is a working example; `docs/engineering/ZIPP_LANGUAGES.md` has the details.
- Builder: a new project can be JavaScript or Python (`logic/main.py`, a Python starter), `.py` names are kept as typed and held to core's module-name rules, and a new logic file starts with a header in its own language. The logic dock edits the file the active UI file links with `<logic src>`, in that file's language; before, an app without `logic/main.logic` (every Python app) lost dock edits on save, and typing in the Code view inlined the logic so later dock edits never reached preview or export. The Python preview now runs its logic. The file store refuses duplicate paths, which export used to drop silently; `<logic src>` follows moved UI files and renamed folders; the entry file is protected by what the project really runs rather than by two hard-coded ids. Preview is offered while a logic file is open, and canvas images resolve Python string constants.
- Studio: the preview composes through core's `composeBundleSource`, as Run does, so Python logic runs, paths resolve the same way, and a refusal is shown instead of a page with no logic. A brief chooses JavaScript or Python, the scaffold and the model's instructions follow it, and an imported project's language comes from its files. `.py` imports as text, exports under `logic`, and the validator runs the composer before Run or Export. Clicking a page opens it in Studio-created projects, and there is a Python example.
- Security: an `accel` kernel could reach `globalThis` through JSFuck-style syntax the token filter allowed, and so the network without `net`; kernels are now parsed against a small grammar with every name resolved in its scope, and only the rewritten parse reaches `new Function`. `formAction` (and every React-cased URL prop) is judged like `href`; `fallbackSrc` and colour props written into CSS no longer fetch without `net`; QRReader loads its decoder from the host's build instead of jsDelivr; the mic and camera stop after a failed setup; an app is painted inside a contained box so it cannot draw over its consent bar, and markup cannot reach the top layer through `popover`/`commandfor`.
- Security, directory and hosts: SVG icons are parsed against an allowlist and every user-content response is served sandboxed (a namespaced `<x:script>` icon was stored XSS on the site's origin); share pages no longer expand `$1`/`\0` from an app's name into a redirect; the Rust host checks `Origin` on the sync upgrade (a self-hosted host serving apps played elsewhere must list those origins in `config.server.allowedOrigins`), strips `Cookie`/`Proxy-Authorization` and its own verified `Authorization` before a script sees a request, and redacts query strings in traces; the sync client takes a short-lived ticket instead of sending the token as a first message the host never read; the directory rate-limits IPv6 by /64 and its 503s no longer leak paths; the PHP host can trust a listed proxy for client addresses.
- Desktop loader: a bundle that declares nothing runs with nothing granted, declared capabilities wait for Allow (grants keyed by bundle digest and declaration), `softn.net.fetch` goes through a native handler that enforces the bundle's allowed hosts under a tight CSP, desktop page script loses `fs:*`, and `config.execution` is honoured.
- One consent implementation: the permission bar, prompt, grant storage and withheld-capability helpers live in `@softn/runtime-shell` and serve the web runtime, the single-app shell and the loader, which each had their own; the "new since the previous build" line now shows. The web runtime's failures read as what went wrong and what to do, focus follows the person between home and tabs, and an offline install that failed says why.
- An empty main `.ui` is refused by name instead of leaving a tab loading forever, and `style="…"` written as CSS text works on components and raw elements (it threw "Failed to set an indexed property"), held to the same remote-`url()` rule as a style object.
- Components: CodeEditor highlights with a real scanner shared with Studio (JavaScript, TypeScript, Python, JSON, CSS, HTML, SQL, Markdown, SoftN markup) rendered as React nodes, and indents with Tab without trapping focus; ThemeProvider checks every theme value before it reaches a stylesheet; dialogs, menus, tabs, selects, trees, the date picker, charts and animations gained the keyboard patterns, ARIA, dark-mode colours and reduced-motion handling they lacked.
- Studio: redesigned on the brand's colour rule; the first thing a new visitor sees is connecting an AI provider (a local model, an OpenAI key or an Anthropic key), with the provider's own model list to pick from and no model name anywhere in Studio; logic, JSON and markup are syntax-highlighted by language; a `.ui` file has Preview and Code; images, audio, video, fonts and PDFs render; a Python brief can ask for torch.
- Studio's AI builds an app as an agent: a tool-calling loop (native tool use on Anthropic and OpenAI-compatible providers, a text protocol where a provider or the hosted editor cannot carry tools) that lists, reads, searches, writes and edits files, looks up components and the SoftN guides, checks the app after every change with the composer, validator and a real render, inspects the preview, calls the app's own functions to test them, keeps a visible plan, asks the user when the brief leaves something open, and finishes with a summary. A run cannot finish while the check fails; it stops at a step limit, a token budget, repeated identical failures or Stop, pauses on a network failure with Resume, and every writing step can be undone, or the whole run reverted. The chat shows the run as a live timeline with diffs and check reports. The AI's guide to the SoftN language was rewritten against the parser, renderer and composer (the old one taught `:value` as two-way and a `#each` form that does not parse), and `lookup_components`/`read_docs` answer from modules generated out of the component manifest and the published guides, with tests that fail when either goes stale. "Approve and build" on a blueprint starts a build run, and Settings opens the provider setup as a dialog and gains an Agent runs section.
- Text after an expression keeps its space: `{streak} days` rendered "12days" and `{a} {b}` "xy", because the lexer skipped the whitespace after `}` as it does before every token. Inline whitespace there is now text, read as HTML reads it; a line break between an expression and an element is still layout.
- PHP backend host: an app's response body is passed through as the app wrote it (re-encoding turned `{}` into `[]` and made some committed writes answer 503); `ALTER TABLE` ADD/RENAME/DROP COLUMN and RENAME TABLE work in migrations, which run sorted, and a dropped or duplicated applied migration stops startup; the site's own origin is always allowed; a busy database answers `503 database_busy` after 3 s; an empty body is `{}`, the query and headers reach the app as the Rust host passes them, and the body limit is the smaller of the route's and the app's; `setup.php` proves the bundled Node runs; the live-updates bridge allows at most two connections per visitor. Request-time SQL uses a real statement tokenizer (CTEs, `;` in literals) with the Rust host's function list, integers bind as integers, missing parameters are refused, and OPTIONS is answered before any origin check.
- Rust backend host: requests are served only for a `Host` it knows (address literals, `localhost`, `--allowed-hosts`, the hosts of `allowedOrigins`, or through `--trusted-proxy`), which closes DNS rebinding — a host reached by name must now use one of those; sync can no longer write outside the collection a hook approved, the sync client keeps operations until the server acknowledges them, script HTTP requests cannot reach private or metadata addresses (including through proxy variables and IPv6 forms), pulls, frames, connections and slow clients are bounded, configuration is validated at load, SIGTERM shuts down gracefully, `poll` and `upload: "photo"` routes load, and error codes match the PHP host. `DROP COLUMN` works in migrations and the host's reserved `_` names cannot be taken by rename or index.
- Both backend hosts run one shared SQL parity fixture (`apps/softn-host-php/tests/sql-parity.json`, 85 migration and request-time cases) and answer every case the same way.
- Directory and private single-app server: a publisher's new version no longer inherits the operator's trust (and so its preapproved permissions); release archives no longer copy an operator's private files; a slow request body can no longer hold the catalogue lock; a bundle's `server/` folder is never served; IPv6 ratings count by /64; range requests stream; the private single-app page cannot be framed by another site unless `frameAncestors` lists it.
- Studio's agent: runs stream text and tool calls (Anthropic and OpenAI-compatible, with a per-provider fallback), the hosted-editor bridge can carry native tool calls once a host announces `aiTools: 1`, the check reports markup that reads or calls names the logic never defines (with the nearest defined name), the stable prompt prefix is cached (Anthropic breakpoints; byte-stable prefixes for OpenAI-compatible and local servers) with budgets counted in effective tokens, a run holds a Web Lock so a background tab is not frozen, and a run interrupted by a reload offers Continue. Tested end to end against a local 27B model through LM Studio.
- Studio's undo survives a reload: an undo journal saved with the project backs step Undo, Revert run and Revert this turn, with the same conflict rule as in the session; max output tokens is an Agent runs setting (default 32,768) and a reply cut at the limit is retried once.
- Rust host: the whole request body has a deadline (`bodyTimeoutSeconds`, default 60, answered 408), a foreign Origin, unknown Host or rate-limited request is refused before its body is read, and one visitor holds at most `maxSyncConnectionsPerVisitor` sync sockets (default 16).
- Builder: the brand's colour rule throughout, JavaScript and Python as the first choice of a new app with torch beside Python, keyboard access to the file tree, hierarchy and component list, and three bugs fixed: starter templates produced an empty page, the logic dock could open on the previous project's code and save it over the new one, and a double-click add could not be undone. Old sessions with inline logic are migrated; handler fields suggest the linked file's functions; undo groups edits per field.
- Site and docs: the site says apps are written in JavaScript or Python, gives every route its own canonical URL, and defers the live preview's engine on slow connections; the product bar fits all six links on a phone; the guides were checked against the source, rewritten without hedging, and gained "Machine learning with torch"; `npm run dev` serves them at `/docs/`, rebuilt as they are edited.
- Tooling: `npm test` finds its test files by glob, CI cancels superseded runs only for pull requests and reads Node from `.nvmrc`, Prettier accepts either line ending, `npm run dev` explains a missing build, PHP or port, and new Playwright smoke tests cover a Python app, an undeclared torch import, the docs, Studio's first visit and the phone product bar.
- Single-app runtime: `runtime.config.json` takes two optional fields. `host` names a same-origin module whose default export supplies the backend an app's `softn.backend.call` reaches, for an app whose actions need something only its host should hold; it is loaded once before the app mounts and fails closed. `layout: "page"` lets an app grow with its content and the document scroll, instead of pinning it to the viewport. See `docs/engineering/SINGLE_APP_RUNTIME.md`.
- The runtime no longer logs its own progress to every visitor's console (the files a bundle carried, a script's functions, its whole initial state). Those diagnostics go through `debug()` in `@softn/core`: on in a development build, and in any page after `localStorage['softn.debug'] = '1'` (or `globalThis.SOFTN_DEBUG = true` in a worker). Warnings and errors are unchanged, and so is an app's own `print` and console output.
- Lint is at zero warnings again and the ceiling back at `--max-warnings 0`, where it began; it had been raised to 100. Typing the `any`s turned up one real fault: a GPU `writeBuffer` with a dtype outside `float32`/`int32`/`uint32`/`uint8` failed with "Ctor is not a constructor", and now says which dtype it was given. DataGrid's cell values are `unknown` and its filters `string | number`; the bind handlers read a changed value through one helper instead of three copies of the same guesswork.
- `*.mjs` and `*.cjs` are checked out with LF everywhere. A `#!` line ending in CR broke two @softn/components suites on Windows while they passed on Linux.

## v0.0.15

- ZIPP v0.0.19 (commit `2e6a39c3`): the browser engine (`npm run fetch:zipp`) and the Rust host's `zipp-vm` tag move together to the release. ZIPP's `web-python` engine has the same method set and Python API as v0.0.18; its glue (`zipp_wasm.js`) changed to carry a `Float32Array` across the host boundary, which the Rust host now serves as a JSON array of numbers where v0.0.18 read one as an opaque value (a top-level `Float32Array` handler result was an error, a nested one `null`). The curated RustPython and Unicode notices are unchanged at that tag.
- The ZIPP engine is ZIPP's own `web-python` release build (the release `apps/softn-host-rust/Cargo.toml` declares), unchanged, instead of a local build: `npm run fetch:zipp` (`packages/@softn/core/scripts/fetch-zipp-release.mjs`, formerly `vendor:zipp-release`, which took the JavaScript-only bundle) installs it only after the bundle matches the release's `SHA256SUMS`, every file the bundle's own `SHA256SUMS`, and `BUILD-INFO.txt` and the module describe that release's web-python build. `SOURCE.json` records the release, both digests, the stack size and the notices' origin; `--check` verifies an install offline and `--check --online` against the published release. The engine is 8.2 MB raw (no wasm-opt) and 2.6% smaller with brotli.
- The RustPython and Unicode notices, which the release bundle does not carry, ship from a curated copy in `packages/@softn/core/zipp-notices/`; `licenses:check` names that in a warning and refuses anything but a verified release install.
- `softn-formlogic-runtime-<tag>.zip` carries the install unchanged under `zipp/` (with ZIPP's release `SHA256SUMS`), `softn-release.json` records the engine's whole `SOURCE.json`, and every copy of the engine in the archive, found by its exports, must be that release. A FormLogic that still vendors its own engine refuses this release; pin `SOFTN_RELEASE=v0.0.14` there.
- `build:zipp-wasm` builds an unreleased engine into `.cache/zipp-local/` for experiments; `fetch-zipp-release.mjs --install-local` installs it as a `local` build, which no release step accepts.
- Tests pin the Rust host's `zipp-vm` tag and its `Cargo.lock` commit to the installed release, and the engine to below the PWAs' Workbox precache cap.
- `packages/@softn/core/wasm-zipp/` is no longer committed. The build, test, typecheck and licence scripts install the ZIPP release that the `zipp-vm` tag in `apps/softn-host-rust/Cargo.toml` declares when the install is missing or another release (`fetch-zipp-release.mjs --ensure`, also an explicit step in every CI job that builds), so a commit builds against the same ZIPP in every job, and a new ZIPP release never changes an existing commit's result. A fresh clone needs network access, or `ZIPP_RELEASE_DIR`, the first time. `npm run fetch:zipp` without a tag installs the declared release; `--latest` only on request, and the next hook puts the declared release back unless `ZIPP_RELEASE` names another. Installs into one folder take turns under a lock file, so hooks started together cannot swap it under each other. `package:formlogic-runtime` installs it too before reading it.
- The release workflow's gate asks ZIPP for its latest release and refuses to ship unless that is the Cargo tag (`scripts/zipp-release-gate.mjs`); the `allow-older-zipp` dispatch input, or `[allow-older-zipp]` in the tag message, ships the declared release anyway (an older one, or a published pre-release) and the release notes say so. A dispatch retry works for tags from v0.0.15 on. The gate freezes the release and the digest of its `SHA256SUMS` for the verify, browser and packaging jobs; the packaging job checks the install against the published release again, requires `softn-release.json` to record that release, and names it in the release notes.
- The install lock names its holder (pid and a nonce), and a lock a killed install left is taken over by one waiter at a time (`.wasm-zipp.lock.break`), so hooks started together on it still install once; an install releases only its own lock, writes nothing once its lock is no longer its own, and on Windows tries again when a lock is refused for a moment while another is being deleted.

## v0.0.14

- Desktop runtime (loader): one owner per installation lifecycle. An upgrade, rollback or recovery holds an operation lease from its first precondition read to its last registry commit, a second operation on the same installation is refused, and finishing an upgrade is refused while a rollback or recovery holds the lease, so the registry can never describe a newer generation as active while an older snapshot is being written back. Registry writes carry a revision and a stale save is redone from a fresh read.
- Documentation pages wear the site's own product bar.
- Release workflow: a `skip-tests` option (dispatch input, or `[skip-tests]` in the tag message) ships a patch build without the verify and browser gates; the release notes say when it was used.

## v0.0.13

- A sixth release archive, `softn-formlogic-runtime-<tag>.zip`: the hosted
  frame, Builder and Studio as hosted editors, the native runtime and the
  starter adapter, already built, with a digest of every file in
  `softn-release.json`. FormLogic fetches the latest release instead of
  checking SoftN out and building it.
- The release archives each carry a plain-language `README.md` first, then
  their detailed guide; `RELEASE-GUIDE.md` on the release compares them.
- `@softn/bundle-format` and `@softn/editor-shared` share what the site, the
  editors and the runtime used to copy; every host reads manifests the same
  lenient way; sync-room security has one derivation; the PHP host follows
  the Rust host's route defaults; the directory API's owner routes answer
  CORS only for the site's own origin.
- The retired FormLogic bytecode VM is gone from `@softn/core`.
- Renamed archives, so the names say what they are (each archive's
  `README.md` and `RELEASE-GUIDE.md` say the old name too):
  `softn-com-<tag>-zipp-<engine>.zip` → `softn-website-<tag>-zipp-<engine>.zip`,
  `softn-single-<tag>.zip` → `softn-app-static-<tag>.zip`,
  `softn-single-php-linux-x64-<tag>.zip` → `softn-app-static-with-backend-linux-x64-<tag>.zip`,
  `softn-single-php-serve-<tag>.zip` → `softn-app-private-<tag>.zip`,
  `softn-private-single-php-linux-x64-<tag>.zip` → `softn-app-private-with-backend-linux-x64-<tag>.zip`.
- `apps/softn-single-php-serve` is now `apps/softn-single-private`
  (`@softn/single-private`), with its PHP in `php/` rather than `public/`;
  `npm run build:single-php-serve` and `package:single-php-serve` still work
  as aliases for one release. The guide is `docs/engineering/SINGLE_APP_PRIVATE.md`.
- The two backend hosts are named for what they are: `apps/softn-php` is now
  `apps/softn-host-php` (`@softn/host-php`; its `runtime/` files are unchanged
  byte for byte, so FormLogic's vendored copy still matches) and
  `apps/softn-rust` is `apps/softn-host-rust` (the crate and binary stay
  `softn-server`).

## v0.0.12

- Locally built ZIPP 0.0.18 with JavaScript and experimental Python support, recorded source provenance and matching runtime checksums. Existing reactive `.logic` screens continue to use JavaScript; Python is available through the engine host API.
- FormLogic-integrated Builder and Studio sessions, shared runtime loading, hosted draft review, and AI generation safeguards.
- Native SQLite record events for FormLogic automations, portable form modules, and improved hosted database editing guidance.
- Release packaging now includes locally built ZIPP provenance and Apache/Python notices without requiring an upstream release archive.
- Additional runtime lifecycle and language regression checks, plus updated build instructions and third-party notices.

## v0.0.11

- Verified ZIPP and editor integration.

## v0.0.10

- ZIPP 0.0.18 and the FormLogic integration.

## v0.0.9

- Tagged release.

## v0.0.8

- Tagged release.

## v0.0.7

- Website and single-app hosting distributions.

## v0.0.6

- Tagged release.

## v0.0.5

- Tagged release.

## v0.0.4

- Tagged release.

## v0.0.3

- Tagged release.

## v0.0.2

- Tagged release.

## v0.0.1

- First tagged release.
