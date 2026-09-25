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

Private SQLite deployment is documented in [PRIVATE_BACKEND.md](../apps/softn-host-rust/PRIVATE_BACKEND.md) and [SINGLE_APP_DEPLOYMENT.md](../apps/softn-host-php/SINGLE_APP_DEPLOYMENT.md). Downloadable client artifacts must remain separate from registered server bundles, operator keys and databases.

## Mobile project navigation

Generated multi-form projects now include labelled form navigation and preserve unfinished input when switching screens. They use FormLogic-facing names; attribution stays on the FormLogic landing page. The FormLogic preparation dialog supports selecting a subset of attached forms. Download contents and source mappings retain the existing format.

Use the updated runtime parser (cache version 4) so hyphenated ARIA and data attributes survive parsing. This is required for accessible navigation names and active-button styling.

## FormLogic takes the release, not the source

Every SoftN release (`v*` tag) carries `softn-formlogic-runtime-<tag>.zip`,
written by `scripts/package-formlogic-runtime.mjs`: `hosted-runtime/`
(`apps/formlogic-host` built as FormLogic's `build-hosted-runtime.mjs` builds
it), `app-editors/` (Builder and Studio built as hosted editors, with the
editor bridge protocol in `manifest.json`), `native-runtime/`
(`apps/softn-host-php/runtime/*` byte for byte, the ZIPP engine, licences,
`provenance.json`), `zipp/` (`packages/@softn/core/wasm-zipp/` byte for byte:
ZIPP's web-python-base release files with the bundle's `SHA256SUMS`, ZIPP's release
`SHA256SUMS` as `RELEASE-SHA256SUMS`, the notices and `SOURCE.json`), `zipp-web/`
(`packages/@softn/core/wasm-zipp-web/` byte for byte: the same ZIPP release's
JavaScript-only build — its module, `BUILD-INFO.txt`, `PROFILE.json`, its
bundle's `SHA256SUMS` and its own `SOURCE.json` — verified as a variant of
`zipp/`: same commit, same imports, no export `zipp/` lacks, so it runs under
`zipp/`'s glue; `zipp/SOURCE.json` names it under `variants.web`), `zipp-torch/`
(`packages/@softn/core/wasm-zipp-torch/` byte for byte: the same release's
torch package — `zipp_torch.wasm`, ZIPP's `zipp_torch.js` loader, its
`BUILD-INFO.txt` pairing it with exactly the `zipp/` bundle, its `SHA256SUMS`
and `SOURCE.json` — which `zipp/SOURCE.json` records under `packages.torch`;
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
any release built with a different one; pin `SOFTN_RELEASE` there.) `npm run package:formlogic-runtime -- --tag vX.Y.Z` builds the
archive locally (`--allow-dirty` for a trial from an uncommitted tree).

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
