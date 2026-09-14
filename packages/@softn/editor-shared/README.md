# @softn/editor-shared

What Builder and Studio share and neither owns. No engine; React only for
the focus hook.

- `handoff` — staging a bundle for the runtime or the publish page and
  handing back the address that claims it (desktop builds export instead;
  another-origin receivers are refused before staging).
- `remoteOpen` — fetching a bundle from a same-origin `?open=` link, bound
  to the workspace it was started for: redirect-origin check, bounded read,
  body cancelled and result dropped when the workspace moved on.
- `useModalFocus` — keyboard ownership for a modal: initial focus, Tab
  trap, Escape closes, focus returns to the opener.
- `hostedEditor` — the private channel FormLogic drives an embedded editor
  through. `apps/shared/hostedEditor.ts` re-exports it: FormLogic's
  `build-app-editors.mjs` checks that path exists, so it stays.

Each editor keeps a thin module with its own signature on top of these
(`apps/softn-builder/src/utils/handoff.ts`, `apps/softn-studio/src/lib/handoff.ts`,
and the `openRemoteBundle` in each), so call sites and tests are unchanged.
