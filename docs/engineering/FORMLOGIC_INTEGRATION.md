# FormLogic starters

FormLogic can export a form or an app's attached forms as an editable `.softn` bundle. The canonical conversion module is `packages/@softn/core/src/integrations/formlogic.ts`, exported from `@softn/core` as `createFormlogicProject`.

```ts
const project = createFormlogicProject({
  origin: 'https://formlogic.example',
  sourceKind: 'form',
  app: { id: 'contact-form', name: 'Contact us' },
  forms: [{
    id: 'contact-form', title: 'Contact us',
    fields: [{ id: 'email', label: 'Email address', type: 'email', required: true }],
  }],
});
// ZIP project.files as UTF-8 entries to create a .softn file.
// Show project.warnings to the owner before download.
```

Open the bundle in a host built from the current Softn sources. This change includes a parser fix required for `SmartForm collection=...` to persist records, plus SmartGrid field labels and SmartForm accessibility fixes. Deploy those runtime changes with the integration.

The generated project contains `manifest.json`, `permission.json`, `ui/main.ui`, `logic/main.logic`, `formlogic.connection.json` and a README. It includes supported input schemas, not responses, credentials, private forms, existing scripts or access grants. Conversion warnings identify unsupported fields and rules. UI and logic literals escape tag delimiters.

This is an independent local-data starter. Browser XDB uses app-scoped localStorage; desktop hosts can use their native XDB backend. It is not connected to FormLogic's live API. The mapping file records the source origin, source kind/identity, collections and field IDs, with `sync: false`. It grants no access.

For `softn-single`, supply an operator-owned runtime configuration with a deployment ID satisfying that host's 64-character identifier contract. Its ID and configuration URL define storage identity; do not copy an untrusted manifest ID into host configuration automatically.

FormLogic keeps a vendored copy with license and SHA-256 provenance. After changing the canonical adapter, run `node scripts/sync-softn.mjs` from the sibling FormLogic UI checkout. Production FormLogic builds use the committed copy without requiring a sibling repository.

The intended next step is a scoped FormLogic host SDK for authenticated form operations, followed by revisioned hosting and optional private SQLite entities. Preserve original form/field IDs, reuse server validation and idempotency, and keep customized UI files separate from regenerated form components. Existing forms should retain their current runtime until field and permission parity is verified.

Private SQLite deployment is documented in [PRIVATE_BACKEND.md](https://github.com/f2i-com/softn.com/blob/main/apps/softn-host-rust/PRIVATE_BACKEND.md) and [SINGLE_APP_DEPLOYMENT.md](https://github.com/f2i-com/softn.com/blob/main/apps/softn-host-php/SINGLE_APP_DEPLOYMENT.md). Downloadable client artifacts must remain separate from registered server bundles, operator keys and databases.

## Mobile project navigation

Generated multi-form projects now include labelled form navigation and preserve unfinished input when switching screens. They use FormLogic-facing names; attribution stays on the FormLogic landing page. The FormLogic preparation dialog supports selecting a subset of attached forms. Download contents and source mappings retain the existing format.

Use the updated runtime parser (cache version 4) so hyphenated ARIA and data attributes survive parsing. This is required for accessible navigation names and active-button styling.

## FormLogic takes the release, not the source

Every SoftN release (`v*` tag) carries `softn-formlogic-runtime-<tag>.zip`,
written by `scripts/release/package-formlogic-runtime.mjs`: `hosted-runtime/`
(`apps/formlogic-host` built as FormLogic's `build-hosted-runtime.mjs` builds
it), `app-editors/` (Builder and Studio built as hosted editors, with the
editor bridge protocol in `manifest.json`), `native-runtime/`
(`apps/softn-host-php/runtime/*` byte for byte, the ZIPP engine, licences,
`provenance.json`, and `bin/softn-runner-linux-x86_64` and
`bin/softn-runner-windows-x86_64.exe`: `apps/softn-runner`, which answers the
same requests as `runner.mjs` without Node, the app's logic in ZIPP compiled to
WebAssembly under wasmtime, with the licences of what it compiles in in
`SOFTN-RUNNER-THIRD-PARTY-LICENSES.txt`, recorded in `provenance.json` under
`runner`; a FormLogic on Linux or Windows x86-64 starts it instead of Node),
`zipp/` (`packages/@softn/core/wasm-zipp/` byte for byte:
ZIPP's javascript-python-base engine module as published, its bindings as
`zipp_wasm.js`, the embed kit's declarations and `LICENSE-APACHE`, ZIPP's
release `SHA256SUMS` as `RELEASE-SHA256SUMS`, the notices and `SOURCE.json`),
`zipp-web/` (`packages/@softn/core/wasm-zipp-web/` byte for byte: the same ZIPP
release's JavaScript-only module and its own `SOURCE.json` — verified as a
variant of `zipp/`: same commit, same imports, no export `zipp/` lacks, so it
runs under `zipp/`'s glue; `zipp/SOURCE.json` names it under `variants.web`),
`zipp-torch/` (`packages/@softn/core/wasm-zipp-torch/` byte for byte: the same
release's torch package — `zipp_torch.wasm` as published, the `zipp_torch.js`
loader and declarations SoftN generates, and `SOURCE.json` — which
`zipp/SOURCE.json` records under `packages.torch`;
the runtime loads it only for an app that declares
`config.python.packages: ["torch"]`), `adapter/`
(`packages/@softn/core/src/integrations/formlogic.ts` with its provenance) and
`softn-release.json` (tag, commit, the engine's whole `SOURCE.json` record with
its `variants`, protocols, adapter digest, a digest of every other file). Each built folder
carries the `runtime-manifest.json` FormLogic's `checkRuntimeArtifact`
verifies. `hosted-runtime/runtime-manifest.json` also names, in `engines`, the
engine ids its shell will accept in `formlogic:init`, and in `features` the
optional capabilities it has beyond them, so a host can tell from what it
INSTALLED which engines it may offer and what else it may ask of them. Both are
additions; `formatVersion` stays 1 and a reader that
knows only the older keys is unaffected. Every copy of the engine in the
archive, recognised by its exports, is the one under `zipp/` — except the one
at `zipp-web/zipp_wasm_bg.wasm`, which is the web variant `variants.web`
records, and which may carry that digest nowhere else. `zipp/` itself holds
exactly the engine install, so a FormLogic that offers only `zipp-web-python`
sees what it always saw; one that offers `zipp-web` takes the variant from
`zipp-web/`, checks it against `variants.web`, and announces it under that id.
Every copy of the torch package, recognised by its exports, must carry the
digest `packages.torch` records: `zipp-torch/` and the `assets/core-runtime/`
copy beside each built runtime and editor.

From v0.0.35 the built runtime and editors carry no engine at all: FormLogic's
page downloads `zipp/`'s engine once, checks it against `SOURCE.json`, and gives
it to each of them. The hosted runtime has always run the bytes the page posts
in `formlogic:init` (it never fetched the copy beside it); Builder and Studio
take it through the editor bridge's `engine` capability (below). The packager
drops the copy Vite emits beside each of them (`dropEngineCopies`), and
`archiveEngineProblems` refuses an engine anywhere in `hosted-runtime/` or
`app-editors/` (`ENGINE_FREE_TREES`), so the archive holds the engine at
`zipp/` and `native-runtime/wasm/` alone (and the variant at `zipp-web/`): 20 MB
less in every FormLogic install, three copies of the 6.6 MB engine. A SoftN
page posts the engine it compiled to every worker it starts, so no worker reads
a copy either. Archives through v0.0.34 carried one in each tree, and through
v0.0.27 a second at `assets/core-runtime/zipp_wasm_bg.wasm`; FormLogic from
v0.1.29 installs both shapes, holding any copy to the release's digest.

`hosted-runtime/` has two entry documents. `index.html` serves the ZIPP
engines; `host.html` is the same document with one attribute and serves only
`host-js`, which runs the app author's `.logic` as the document's own
JavaScript. That needs `'unsafe-eval'` in the shell's Content-Security-Policy,
and a meta policy can be tightened after it is written but never relaxed, so it
has to be a separate document rather than a flag on the first. A host that
offers `host-js` mounts `host.html`, sends no engine bytes, and is deciding to
trust the app's author: the frame is the only thing containing their code.
`softn-release.json` says so in `protocols.hostedEngines`, so a FormLogic that
knows only one entry document refuses the archive instead of installing one
whose manifest offers an engine it would never mount.

A client logic file whose name ends `.py` is Python. The shell derives an app's
languages from its client file names and nothing else — no part of the bundle
declares them, so an app cannot be one thing to whoever chose the engine and
another to the engine — and an engine that cannot run one of those languages is
refused by name, before any engine is configured: `zipp-web` is ZIPP's
JavaScript-only build and `host-js` is the document's own JavaScript, and
neither can execute Python at all. `hosted-runtime/runtime-manifest.json` names
that contract as `python-logic/1` in `features`, and `softn-release.json`
carries it as `protocols.logicLanguages`, so a FormLogic that would hand a `.py`
file to a JavaScript engine learns the rule before it installs the runtime that
follows it. A host that answers a native app's network calls itself can supply
the runtime's `netFetchHandler` instead of the `<logic>` bridge that rewrites
`softn.net.fetch` inside a JavaScript guest; the two answer identically, and
supplying a handler moves the capability's checks to the host with it.

FormLogic's `prepare-hosted-runtime` fetches the latest release, checks the
`.sha256` sidecar and every digest, requires the protocol numbers it speaks,
takes its browser engine from `zipp/`, and unpacks the folders where its build
expects them; `SOFTN_RELEASE=<tag>` pins a release, `SOFTN_RELEASE_ARCHIVE`
uses a downloaded copy, and `SOFTN_REPO` still builds from a working tree
for development. A release whose engine copies disagree or whose protocols
differ fails there, before any FormLogic test or package step, with a message
naming what to update. (A FormLogic that still vendors its own engine refuses
any release built with a different one; pin `SOFTN_RELEASE` there.) From the
first SoftN release on ZIPP 0.0.26, the three ZIPP trees hold the module-format
install described in `ZIPP_LANGUAGES.md`: no `BUILD-INFO.txt`, `PROFILE.json`,
bundle `SHA256SUMS` or ZIPP-published `zipp_torch.js`, each `bundle` naming a
`.wasm` file whose `bundleSha256` is its own digest, and a `kit` record in
`zipp/SOURCE.json`. A FormLogic whose checks still expect the zip-bundle files
refuses such a release until its checks follow; pin `SOFTN_RELEASE` to an
earlier release meanwhile. `npm run package:formlogic-runtime -- --tag vX.Y.Z` builds the
archive locally (`--allow-dirty` for a trial from an uncommitted tree).

## A newer version of an app, in the frame it runs in (unreleased)

A parent that had a newer version of a running app's files had one way to
show it: a new frame, in which the app starts from nothing. It can now hand
the files to the frame the app is in, and the frame changes as little of the
running app as it must (core's live app, `docs/engineering/LIVE_APPS.md`; the
frame's side is `apps/formlogic-host/src/update.ts`). It is an addition:
`nativeProtocol` and `storageProtocol` are what they were, and a parent that
never sends an update sees nothing different.

- The frame says it can: `formlogic:ready` carries `update: 1`.
- Once the frame has posted `shown`, the parent may post on the app's port
  `{ type: 'formlogic:update', id, client, assets? }`:
  - `client`: the app's text files as `init` carries them, path to text. All
    of them, not the ones that changed.
  - `assets`: its media as `init` carries it, path to base64, again the whole
    set. Left out (or `null`), the media is as the parent last sent it, in
    `init` or an update, which is the thing to do when it has not changed:
    every file sent is read whole. Media sent with a version that was kept
    back is not lost; it comes with the next version that leaves its media
    out. `{}` is an app with no media.
  - `id`: the parent's own, a number or text of 1 to 64 characters. It comes
    back on the answer and is read as nothing else (it may be a number one of
    the frame's `call` messages has).
- The frame answers each update once, on the port, with
  `{ type: 'updated', id, outcome, changed?, reason?, carried?, problem? }`:
  - `updated`: drawn again where the app stood, with its variables, timers
    and open page as they were. `changed` lists what differed: the renderer's
    `page` and `styles`, and the frame's own `media` (its media is not what it
    was) and `theme` (the manifest's `config.theme.mode`).
  - `restarted`: it started again, and `_init()` ran again. Most often its
    logic differed (`changed` has `logic`), in a file the page names or one
    the logic imports. `reason` says why in words for a person, and `carried`
    whether its variables were carried into the new start.
  - `kept`: the version has a problem, said in `problem`, and the last
    version that worked is still on screen and running, on its own files and
    media. A page or logic that does not parse, or will not start, is kept
    back by the renderer, which also says so in a line over the app. A
    manifest that is not JSON or names no main page, and files that do not
    compose (a page that is missing, Python and JavaScript mixed), are kept
    back before that and said in the answer alone. A new frame could not open
    such a version either and would show only its error, which is why these
    answer `kept` and not `reopen`.
  - `unchanged`: nothing differed.
  - `reopen`: this frame cannot take the version, `reason` says why, and the
    parent makes a new frame for it, as it did for every change before.
- What answers `reopen`:
  - the manifest names another `main`;
  - what the app asks permission for changed (`permission.json`, compared as
    JSON, so the same request written out again is no change; or the
    manifest's older `permissions` block): the parent settles a grant before
    an app opens;
  - the languages its logic is written in changed (a client file ending `.py`
    came or went), or the Python packages it asks for
    (`config.python.packages`): a frame's engine is chosen and configured
    once, for the app it opened;
  - there is no app to update: the frame has not posted `shown` yet, it
    reported an `error` with `phase: 'load'`, or it has ended;
  - the message is not one the frame takes: no usable `id` (answered with
    `id: null`), a `client` that is not an object of text, an `assets` that
    is not an object, or more than a frame takes where it stands (4,000 text
    files and 32 MiB of characters, 4,000 media files and 128 MiB of media,
    32 updates waiting). `init` holds a parent to none of these, so the new
    frame takes what the update could not.
- Everything else of the manifest is taken where the app stands: its list of
  logic files is composed like the pages, the side it declares is drawn, and
  what the frame never read (a name, a version, a window size) changes
  nothing. The frame answers for what it reads. What the parent decides on
  its own side from the files (the engine it offers, the grant, a native
  backend) is the parent's to notice, and it needs no answer from the frame
  to make a new one.
- Stored data is never touched. The app's seed records (`manifest.files.xdb`)
  were added once, before it first drew, and an update adds none: a `.xdb`
  file it adds or changes is read when the app is next opened in a new frame.
- The logic's imports are answered from the files of the version that is
  running, and the page's `asset()` from that version's media. Media is
  served as `data:` URLs, so nothing is held open for a file an update
  replaced. Logic that kept an asset's address in a variable holds the old
  one until it starts again.
- Updates are taken one at a time, in the order they came. Those that arrive
  while one is being taken are gathered: the newest files are the ones taken
  (with the media last sent among them), and every `id` gets an answer, each
  saying what became of that newest version.
- `reason` and `problem` are one line of at most 300 characters, never a
  stack. An update the port could not deserialise names no `id` and is not
  answered, and nothing is answered after `formlogic:dispose`, so a parent
  keeps a deadline of its own.

## Page links, and where the app is (unreleased)

A link to another page of the app (`<a href="about.html">`) was left to the
browser, which took the frame to an address the parent has no such page at:
the app went blank until it was opened again. The frame now follows such a
link itself, as SoftN Web and the single-file shell do (core's `bundlePageAt`
and `composePage`), and says where the app is so the parent can put it in its
own address. It is an addition: a parent that sends no place and reads none
sees nothing different, but for links that now work. The frame's side is
`apps/formlogic-host/src/place.ts` and `main.tsx`.

- The frame says it can: `formlogic:ready` carries `places: 1`.
- A place is one string the parent keeps as it came: `/` for the main page,
  `/about.html` or `/docs/guide.html` for another page file by its path among
  the app's files, and a named page inside the app (a NavItem's `page`, kept
  in `currentPage`) after `#`: `/#settings`, `/docs/guide.html#team`. Each
  part is percent-encoded. It starts with one `/`, never `//`, holds no `\`
  or `?`, and is at most 2000 characters.
- The frame posts `{ type: 'place', place }` on the app's port right after
  `shown`, then whenever the place changes. Never the same one twice in a row.
- `formlogic:init` may carry `place`, read once: the app starts there. It is
  read as untrusted. Anything that is no place of this app (no such page, a
  file that is not a page, the wrong shape) starts the app on its main page,
  with no error.
- A link is followed when it names a page of the app (`.html`, `.htm`, `.ui`
  among the files `init` carried); its `?query` and `#fragment` are not read.
  Another page is a fresh run: its variables start again and what the app has
  stored is kept. A link to anything else is still the browser's.
- A `formlogic:update` while another page is showing keeps that page if the
  new version has it. If it does not, the frame posts the place `/` and then
  answers `restarted` with `changed` holding `page`.

## The editor bridge's AI requests

The hosted editors talk to FormLogic over the channel in
`packages/@softn/editor-shared/src/hostedEditor.ts` (the editor sends
`formlogic-editor-ready`, FormLogic answers `formlogic-editor-connect` with a
`MessagePort`). Studio's AI requests go over that port as `ai-request` /
`ai-response` / `ai-cancel`. The bridge protocol stays `1` (it is what
`app-editors/manifest.json` records); tool calls are an optional capability
on top of it, `aiTools`, currently version `1`:

- The editor announces it: `{ kind: 'formlogic-editor-ready', protocol: 1, aiTools: 1 }`.
- A host that speaks it announces it back: `{ kind: 'formlogic-editor-connect', protocol: 1, aiTools: 1 }`.
  A host that says nothing is a host from before it, and the editor sends it
  only what every host takes.
- Without `aiTools` (every FormLogic today): `{ kind: 'ai-request', id, messages }`,
  each message `{ role: 'system' | 'user' | 'assistant', content: string }`,
  answered `{ kind: 'ai-response', id, ok: true, value: string }` or
  `{ kind: 'ai-response', id, ok: false, error }`. Studio's agent then writes
  its tool calls as text (`<tool_call>` blocks) and reads them back itself.
- With `aiTools: 1` announced, Studio sends
  `{ kind: 'ai-request', id, aiTools: 1, messages, tools, maxOutputTokens }`:
  - `tools`: `[{ name, description, inputSchema }]`, `inputSchema` a JSON
    schema object — the list Studio sends Anthropic (`input_schema`) and
    OpenAI (`function.parameters`), in one neutral shape;
  - `messages`: `{ role: 'system' | 'user', content }`,
    `{ role: 'assistant', content, toolCalls?: [{ id, name, arguments }] }`
    (`arguments` an object) and
    `{ role: 'tool', toolCallId, name, content, isError? }`.

  The host maps these to its provider (Anthropic `tool_use` / `tool_result`
  blocks, OpenAI `tool_calls` / `role: 'tool'` messages) and answers
  `{ kind: 'ai-response', id, ok: true, value: { text, toolCalls: [{ id, name, arguments }], stopReason, usage: { inputTokens, outputTokens } } }`.
  `arguments` may be the parsed object or the provider's raw JSON string;
  `stopReason` is the provider's own (`max_tokens`/`length` marks a reply cut
  at the output limit, `refusal`/`content_filter` one the model declined);
  `usage` may be left out, and Studio then counts by estimate.
- A host whose provider cannot take tools answers
  `{ ok: false, code: 'tools-unsupported', error }`, or simply answers with a
  string `value`: either way Studio carries on with text tool calls for that
  provider and model, and remembers it.
- Replies are whole; the bridge does not stream. `ai-cancel` (same `id`)
  still stops a request.

The host side lives in FormLogic (`ui/src/components/studio/AppEditorDialog.tsx`,
the `ai-request` handler). Its current check refuses any message whose role is
not system/user/assistant or whose content is not a string, which is why
Studio never sends the structured form until the host has announced `aiTools`.

A second optional capability, `agentRuns` (version `1`), lets the host take a
person to Studio to have its agent build or change their app while they watch:

- Studio announces it beside `aiTools`: `{ kind: 'formlogic-editor-ready', protocol: 1, aiTools: 1, agentRuns: 1 }`.
  The Builder has no agent and does not.
- A host that speaks it answers `agentRuns: 1` in `formlogic-editor-connect`.
- Such a host's `open` may carry `brief: { prompt, kind: 'build' | 'edit' }`
  (the prompt up to 8,000 characters). Once the project is open, Studio puts
  the prompt in its chat as the person's request and starts an agent run of
  that kind, with the chat showing. A brief from a host that did not announce
  `agentRuns` is ignored.
- Studio then reports its agent to that host, once per change:
  `{ kind: 'agent-status', state, step?, summary?, reason? }`, `state` one of
  `idle`, `running` (with the step Studio shows, such as "Checking the app…"),
  `waiting` (a question for the person), `paused` (a network failure it will
  resume from, with `reason`), `stopped`, `finished` (with the model's
  `summary`) or `failed` (with `reason`). The host can say what the agent is
  doing and hold its own "review" and "close" while a run is `running`
  (Studio's `export` is refused then in any case).

FormLogic's side is `AppEditorDialog.tsx` (the `brief` prop and the status
bar) and its SoftN app workspace, which opens Studio with the request from
"Create app" or from its chat. A FormLogic that does not speak `agentRuns`
opens Studio exactly as before.

A third, `engine` (version `1`, v0.0.35 on), is how an editor FormLogic
installs runs without an engine of its own:

- Builder and Studio, built as hosted editors, announce it with the ZIPP build
  they were made with: `{ kind: 'formlogic-editor-ready', protocol: 1, …, engine: 1, zipp: { version, sha256 } }`
  (`hostedEngineSource` in `packages/@softn/editor-shared/src/hostedEditor.ts`,
  called from each editor's `main.tsx` before anything starts ZIPP, and handed
  to core's `awaitZippWasmSource`).
- A host that has that build sends its bytes with the connection:
  `{ kind: 'formlogic-editor-connect', protocol: 1, …, zippWasm }`, an
  `ArrayBuffer` or `Uint8Array` of at most 32 MB, cloned, never transferred.
  FormLogic sends the bytes its page downloaded and checked (the ones the app
  frame is sent), so one file serves the page, the frame and both editors.
- The editor's engine waits for the connection; a host that sends none (one
  before this) leaves it to fetch the copy beside its chunk, which an archive
  from v0.0.35 does not carry. A host that cannot download the engine says so
  itself rather than connect an editor that has none.
- With `glue: 1` beside `engine: 1` (unreleased, for v0.0.36), the editor runs
  the host's own ZIPP: the host sends its engine bytes and names that ZIPP's
  glue in the site's ZIPP folder (`zippGlue: { url, sha256 }`, the folder
  beside `/app-editors/`), whichever ZIPP the editor was built with. Core
  imports the glue only after its bytes match the digest (`awaitZippGlue`,
  `zipp-glue.ts`), and refuses one that lacks a name core calls
  (`ZIPP_GLUE_EXPORTS`). A glue named without engine bytes, outside the
  folder or without its digest is ignored, and the editor runs its own.

### A host's own ZIPP (unreleased, for v0.0.36)

A FormLogic can run a ZIPP other than the one a SoftN release was built with,
in the browser: the app frame and the editors take the engine bytes from the
page, as they do already, and ZIPP's glue and torch package from the site's
ZIPP folder, `/zipp/` beside `/hosted-runtime/`, one folder per ZIPP named by
the first 12 hex digits of its engine's sha256. The engine and its glue are a
pair (the glue's imports are the engine's, by names that change with every
ZIPP build), so the host always sends the two together.

- The runtime declares `host-zipp/1` in `runtime-manifest.json` `features`,
  and its `formlogic:ready` says `zippGlue: 1` with `zippGlueExports`, the
  names a glue must export for core to run it.
- A host that speaks it sends, beside `zippWasm`, `zippGlue: { url, sha256 }`
  and, where its ZIPP has one, `zippTorch: { url, sha256 }`, both in the ZIPP
  folder (`acceptZippAddress`: resolved as URLs first, a `.js` glue and a
  `.wasm` package, no query, nothing outside the folder). The frame checks each
  file's digest before it imports the glue or runs the package, and refuses a
  glue without one of `zippGlueExports`. Without them the frame runs the glue
  it was built with, and the host must send that build's engine, as before.
- The frame's policy names the ZIPP folder in `script-src` (for the glue, the
  one script it imports from outside its own folder) and `connect-src` (for
  those checks and the torch package). It is the host's static install; nothing
  an app sends reaches it. `host.html` names it too, so the two documents still
  differ by `'unsafe-eval'` alone.
- Workers a SoftN page starts are given the glue's address with the compiled
  engine (`zippGlueForWorker`, `adoptZippGlue`), so they run the same pair.
- Only the browser: an app's backend still runs on the native runtime this
  archive carries, with the ZIPP it was built with.

From v0.0.37 the archive carries ZIPP's release installer, `zipp-tools/`
(`scripts/release/bundle-zipp-installer.mjs`): `packages/@softn/core/scripts/
fetch-zipp-release.mjs` bundled with what it imports into one script that
runs on Node alone, laid out as core is (`scripts/` beside `zipp-notices/`).
A FormLogic runs it to install a ZIPP release of its own choosing, with every
check this repository makes of one (`ZIPP_OUT`, `ZIPP_CACHE_DIR`,
`ZIPP_SUMS_SHA256`); one verifier, not two. `hosted-runtime/runtime-manifest.json`
and `app-editors/manifest.json` say what that ZIPP's glue must export
(`zippGlueExports`), and the editors' manifest declares `host-zipp/1` beside
the runtime's, so a host can tell before it installs a ZIPP whether this
release's runtime and editors run it.

FormLogic's side: `publish-zipp.mjs` writes the folder from its installed ZIPP,
`HostedAppFrame` and `AppEditorDialog` name its files, and its server rules
answer the folder to the frame's opaque origin. Tested with FormLogic on ZIPP
v0.0.32 and this runtime and these editors built with v0.0.33: every hosted-app
end-to-end test passed, the frame and both editors running v0.0.32's pair.

Any host's `open` may also carry `saveLabel`, its own name for taking the
editor's work back ("Save changes"; one line, up to 32 characters). Studio's
and the Builder's buttons that ask the host to save (`save-requested`) then
use it, so the editor's button and the host's button beside it say the same
thing. It needs no capability: an editor from before it ignores it, and a
host that sends none leaves each editor its own label ("Review changes" in
Studio, "Save" in the Builder).

`open` may also carry `aiLabel`, which AI the host answers the editor's AI
requests with, in its own words ("Desktop AI — oaiy-engine · flash"; one line,
cut at 120 characters). Studio's settings and its AI pill name it, its Test
asks it through the bridge, and what runs learn about the AI is kept under
it. Like `saveLabel` it needs no capability; a host that sends none is shown
as "Your default AI in FormLogic". A hosted Studio never offers a provider of
its own: every AI request goes to the host.
