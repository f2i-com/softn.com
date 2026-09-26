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
  `build-app-editors.mjs` checks that path exists, so it stays. AI requests
  carry text to every host; to a host that announced `aiTools: 1` in
  `formlogic-editor-connect` they may also carry `tools` and structured
  messages and get tool calls back (`requestHostedAIReply`). An editor with an
  agent (Studio) also announces `agentRuns: 1`: a host that answers it may
  open the editor with a `brief` for the agent (`readHostedBrief`) and hears
  how the agent is doing (`reportHostedAgentStatus`). The wire is described in
  `docs/engineering/FORMLOGIC_INTEGRATION.md`.

Each editor keeps a thin module with its own signature on top of these
(`apps/softn-builder/src/utils/handoff.ts`, `apps/softn-studio/src/lib/handoff.ts`,
and the `openRemoteBundle` in each), so call sites and tests are unchanged.
