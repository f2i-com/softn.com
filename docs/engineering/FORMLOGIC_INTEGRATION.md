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

Private SQLite deployment is documented in [PRIVATE_BACKEND.md](../apps/softn-rust/PRIVATE_BACKEND.md) and [SINGLE_APP_DEPLOYMENT.md](../apps/softn-php/SINGLE_APP_DEPLOYMENT.md). Downloadable client artifacts must remain separate from registered server bundles, operator keys and databases.

## Mobile project navigation

Generated multi-form projects now include labelled form navigation and preserve unfinished input when switching screens. They use FormLogic-facing names; attribution stays on the FormLogic landing page. The FormLogic preparation dialog supports selecting a subset of attached forms. Download contents and source mappings retain the existing format.

Use the updated runtime parser (cache version 4) so hyphenated ARIA and data attributes survive parsing. This is required for accessible navigation names and active-button styling.
