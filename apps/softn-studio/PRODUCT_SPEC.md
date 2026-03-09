# SoftN Studio Product Spec

Version: 2.1
Date: 2026-03-08
Status: Working draft

## 1. Product Definition

SoftN Studio is the no-code creation surface for the SoftN ecosystem. It lets a user describe an app in natural language, shape it visually, wire data and actions without writing code, then either:

- download the result as a portable `.softn` bundle, or
- publish it to the web and open it in a browser-based SoftN viewer.

The product is not just a prompt box. It is a guided studio with:

- a structured brief flow,
- an AI-generated blueprint,
- a visual canvas and inspector,
- a virtual file system for bundle assets,
- validation and repair loops,
- flexible AI access via BYOK or SoftN-hosted credits.

Core promise:

- describe the app in plain language,
- review the AI's plan before generation,
- visually edit pages, data, and actions,
- export or publish without touching code.

## 2. Product Goals

### Primary goals

- Make SoftN app creation accessible to non-developers.
- Keep generation aligned to SoftN-native patterns instead of generic code output.
- Support both privacy-conscious BYOK users and zero-setup House AI users.
- Make export and publish feel like first-class outcomes, not afterthoughts.

### Non-goals

- General-purpose website builder outside the SoftN runtime.
- Full traditional IDE replacement for developers.
- Long-term storage of user API keys in SoftN cloud systems.

## 3. Target Users

### No-code creator

- Wants to describe a tool, dashboard, CRM, scheduler, or internal app.
- Prefers visual editing over code editing.
- Needs working output fast.

### Technical founder / operator

- Wants a fast prototype or internal workflow app.
- May bring their own OpenAI, Anthropic, or custom endpoint.
- Cares about exportability and not being locked into a hosted editor.

### SoftN power user

- Wants advanced editing, file visibility, and manual logic tweaks.
- Uses the visual builder first, then drops into advanced mode when needed.

## 4. Core User Outcomes

Users should be able to:

1. Create a new app from a guided brief or prompt.
2. Choose a runtime target: web, desktop, or dual-target.
3. Choose an AI mode: BYOK or House AI credits.
4. Approve an AI-generated architecture before scaffolding starts.
5. Edit pages, components, bindings, and actions visually.
6. Preview the app live at desktop, tablet, and mobile widths.
7. Export the app as a `.softn` file.
8. Publish the app to the web and open it in a web viewer.

## 5. Product Principles

- Blueprint first: the system should reason from design intent, not only file diffs.
- Visual by default: the canvas and inspector are primary; code is secondary.
- Transparent AI: the user should see what the agent is doing, spending, and changing.
- Portable output: the resulting app belongs to the user and can be exported anytime.
- Safe credentials: BYOK secrets stay in the browser session and never persist to SoftN cloud storage.

## 6. End-to-End Product Flow

### Phase A: Entry

User lands on the Studio dashboard and can:

- create a blank project,
- start from a template,
- import an existing `.softn` bundle,
- reopen a recent project.

### Phase B: Guided brief

The user is prompted for:

- app name,
- app description,
- target runtime,
- desired pages,
- required data collections,
- auth needs,
- visual style direction,
- reference images,
- AI mode.

The brief can be wizard-based or prompt-first. Both end in a structured requirements object.

### Phase C: AI setup

The user selects one of two modes:

- BYOK: supply OpenAI, Anthropic, custom OpenAI-compatible, or local gateway settings.
- House AI: use SoftN-managed models by spending purchased credits.

Before generation begins, the UI shows the model routing profile and estimated cost.

### Phase D: Blueprint review

The Architect agent converts the brief into a blueprint containing:

- page map,
- navigation structure,
- data collections and relationships,
- major components,
- workflows and actions,
- target-specific constraints,
- risks, assumptions, and estimated cost.

The user can approve, revise, or reject the blueprint.

### Phase E: Scaffolding

Once approved, the Builder creates the initial SoftN bundle structure, including:

- `manifest.json`,
- page `.ui` files,
- `.logic` files,
- `.xdb` schemas,
- assets,
- builder metadata.

The result is immediately mounted in the preview.

### Phase F: Visual refinement

Inside the editor, the user can:

- select any component on the canvas,
- edit props and styles in the inspector,
- bind inputs to data,
- map events to logic functions,
- add or reorder pages,
- add collections and relationships,
- ask the AI to change only the selected component, page, or flow.

### Phase G: Validation and repair

Every meaningful change triggers validation. If errors appear, the Repair agent receives a minimal failure packet and patches only the necessary files.

### Phase H: Export or publish

The user can:

- export a `.softn` bundle for download,
- publish to `play.softn.com`,
- open the published app in a browser viewer,
- manage versions and visibility.

## 7. AI Access Model

### 7.1 Bring Your Own AI

Supported provider classes:

- Anthropic
- OpenAI
- Custom OpenAI-compatible endpoints
- Local gateways such as Ollama or LM Studio

Required capabilities:

- save provider config locally in encrypted IndexedDB,
- support optional base URL and model overrides,
- support per-role model routing,
- never send provider secrets to the SoftN backend,
- allow session purge on logout or expiry.

Recommended role mapping:

- Architect -> premium reasoning model
- Builder -> balanced generation model
- Repair -> lower-cost fast model
- Vision -> multimodal model when image input is used

### 7.2 House AI

House AI is for users who do not want to manage API keys.

Required capabilities:

- credit wallet tied to authenticated user,
- prepaid credit purchase flow,
- pre-run estimate,
- live spend during generation,
- atomic deduction per completed step,
- pause generation when credit budget is exhausted,
- allow top-up and resume.

### 7.3 Unified provider abstraction

The orchestration layer should not care whether the model is BYOK or House AI. It should request a provider instance by role and execute through a shared interface.

## 8. Core Experience Areas

### 8.1 Dashboard

Must include:

- recent projects,
- starter templates,
- import flow for `.softn`,
- create project entry point.

### 8.2 Studio shell

Primary desktop layout:

- top bar,
- left rail with expandable panels,
- central live canvas,
- right-side inspector,
- bottom drawer for validation, console, diffs, and agent actions.

Mobile behavior:

- compact tabbed experience for chat, preview, and settings,
- no full desktop editing parity required.

### 8.3 Visual canvas

Must support:

- live preview,
- click-to-select,
- hover outlines,
- drag-drop insertion,
- page tabs,
- viewport presets,
- zoom,
- theme toggle,
- screenshot capture.

### 8.4 Inspector

Must support context-aware editing for:

- component props,
- spacing and layout,
- typography and colors,
- data bindings,
- event wiring,
- scoped AI edits,
- page-level settings when no component is selected.

### 8.5 Advanced mode

Must expose:

- VFS file tree,
- Monaco editor,
- syntax highlighting for SoftN files,
- inline validation,
- diff view for AI changes,
- AI patching of a code selection.

## 9. Builder Operating Model

### 9.1 Blueprint layer

The blueprint is the source of design intent. It sits above bundle files and makes agent iteration, rollback, and scoped edits reliable.

Expected builder metadata:

- `builder/blueprint.json`
- `builder/data-model.json`
- `builder/requirements.md`
- `builder/task-graph.json`
- `builder/component-map.json`
- `builder/generation-log.json`
- `builder/provider-config.json` without secrets

### 9.2 Virtual file system

The editor runtime should maintain an in-memory VFS with:

- file CRUD,
- patch support,
- event history,
- undo and redo,
- autosave to IndexedDB,
- import and export support.

### 9.3 Agent loop

Recommended role split:

- Architect: turns brief into blueprint
- Builder: creates and updates files
- Validator: deterministic checks only
- Repair: fixes scoped failures
- Budget Manager: enforces spend and retry rules

The loop must be task-scoped, budget-aware, and pausable.

## 10. Validation Requirements

Validation must cover:

- syntax parsing for `.ui`, `.logic`, and manifest files,
- schema correctness,
- valid component and prop usage,
- data binding correctness,
- logic compilation,
- runtime mounting errors,
- bundle policy checks,
- target capability linting,
- optional interaction replay tests.

Validation output should be clickable from the UI and point the user to the affected page, component, or file.

## 11. Runtime Targeting

The brief must force an initial target choice:

- Web
- Desktop
- Dual-target

This target influences:

- storage strategy,
- sync strategy,
- navigation patterns,
- allowed capabilities,
- publish behavior,
- validation rules.

The system should prevent or warn on target-incompatible generation.

## 12. Export and Web Viewing

### Export

Export flow:

1. Run full validation.
2. Show warnings and allow informed export when only warnings remain.
3. Strip builder-only metadata from production output.
4. Zip the bundle into a `.softn` file.
5. Trigger browser download.

### Publish

Publish flow:

1. Require zero blocking validation errors.
2. Upload the generated bundle and assets.
3. Create a publish record with slug, visibility, and version.
4. Return a public viewer URL.
5. Open the published app through a lightweight web viewer powered by the SoftN runtime.

### Viewer requirements

The web viewer should:

- fetch the published `.softn` bundle,
- mount it using the SoftN runtime,
- support responsive viewing,
- support PWA install where relevant,
- honor public, unlisted, or password-protected visibility rules.

## 13. Billing and Commerce

House AI requires:

- credit packages,
- Stripe checkout,
- ledger-based credit accounting,
- purchase history,
- clear usage receipts at generation-step level.

Recommended pricing model:

- Starter: low-friction entry pack
- Builder: standard active-user pack
- Pro: bulk usage pack

Internally, usage should be based on actual token consumption, mapped to credits with a simple public conversion rule.

## 14. Security Model

### BYOK security

- API keys stored locally only
- encrypted at rest in browser storage
- purged on logout or session expiry
- never persisted to SoftN cloud storage

### Preview security

- sandboxed iframe
- isolated runtime execution
- explicit postMessage bridge only
- no direct access to parent app state except approved events

### Publishing security

- publish only validated static bundles
- block forbidden paths and absolute references
- scan for common unsafe patterns before publish

## 15. Analytics

The product should measure:

- time to first preview,
- blueprint approval rate,
- export vs publish ratio,
- credits consumed per app,
- validation failure rate,
- retry frequency,
- smart-component usage rate,
- publish success rate.

User-facing analytics for published apps can include:

- views,
- unique visitors,
- session duration,
- install count,
- high-level geography.

## 16. MVP Scope

### MVP must-have

- dashboard with new project, templates, and import
- guided brief wizard
- BYOK setup for OpenAI, Anthropic, and custom endpoint
- House AI mode selection and credits display
- blueprint creation and approval UI
- canvas-first editor shell
- inspector for props, styles, bindings, and events
- VFS-backed preview and export
- validation drawer with actionable errors
- `.softn` export
- publish to web viewer

### Post-MVP

- collaboration
- template marketplace
- custom component SDK
- GitHub sync
- CI/CD publishing
- custom domains
- backend functions

## 17. Implementation Notes For This Repo

Current app shell already reflects part of the intended product:

- `src/App.tsx` wires dashboard, brief, import, and editor views.
- `src/components/layout/Dashboard.tsx` already supports template selection and import entry.
- `src/components/toolbar/TopBar.tsx` already exposes mode switching, preview controls, and export.
- `src/stores/workspaceStore.ts` holds core builder UI state.
- `src/stores/aiStore.ts` already models AI mode, provider config, budget state, and chat history.
- `src/lib/aiProvider.ts` already provides the first provider abstraction layer.

Recommended next implementation slices:

1. Persist brief, providers, and VFS state to IndexedDB.
2. Add explicit blueprint data structures and approval UI.
3. Build agent action timeline and validation pipeline UI.
4. Implement BYOK provider management with encrypted session storage.
5. Add House AI credit purchase, estimate, and ledger flows.
6. Implement publish API contract and web viewer integration.

## 18. Acceptance Criteria

- A new user can create a project from a guided brief in under 3 minutes.
- A user can connect either BYOK or House AI before generation.
- The user can review and approve a blueprint before file generation.
- The editor shows a live preview and supports selection-driven inspection.
- The user can export a valid `.softn` bundle.
- The user can publish a validated app and open it in a web viewer.
- The system surfaces spend, progress, and validation issues clearly.
