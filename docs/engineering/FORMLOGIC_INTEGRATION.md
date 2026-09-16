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
ZIPP's web-python release files with the bundle's `SHA256SUMS`, ZIPP's release
`SHA256SUMS` as `RELEASE-SHA256SUMS`, the notices and `SOURCE.json`), `adapter/`
(`packages/@softn/core/src/integrations/formlogic.ts` with its provenance) and
`softn-release.json` (tag, commit, the engine's whole `SOURCE.json` record,
protocols, adapter digest, a digest of every other file). Each built folder
carries the `runtime-manifest.json` FormLogic's `checkRuntimeArtifact`
verifies. `hosted-runtime/runtime-manifest.json` also names, in `engines`, the
engine ids its shell will accept in `formlogic:init` (and `features` for later
runtime capabilities), so a host can tell from what it INSTALLED which engines
it may offer. Both are additions; `formatVersion` stays 1 and a reader that
knows only the older keys is unaffected. Every copy of the engine in the
archive, recognised by its exports, is the one under `zipp/`.

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
