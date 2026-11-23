# BaseGrid — Open Airtable Alternative on SoftN Containers

BaseGrid is a modular Airtable alternative built as a collection of **6 portable full-stack `.softn` v2 Web Containers** hosted internally inside a **React 18 Parent Application**:

- **Airtable-Inspired Competitor Showcase + Internal Parent Workspace (`parent-host/`)** built in **React 18**.
- **6 Portable Full-Stack `.softn` Apps (`bundles/basegrid-*.softn`)**, each combining:
  - **React 18** frontend (Vite production build running inside `zipp-javascript-lite.wasm`)
  - **PHP 8** REST API backend (`backend/index.php` + `backend/micro.php`)
  - **XDB SQLite 3** database (`backend/schema.sql`, persisted in browser IndexedDB via `xdb-wasm.wasm`)

## Dual-Mode PHP Execution (ZIPP WASM by Default, Standalone PHP Optional)

Every BaseGrid `.softn` container executes the **exact same PHP 8 backend code** in both modes:

1. **Embedded inside a Parent Application (Default — Zero Server):**
   `mountSoftNContainer()` runs the PHP backend inside an isolated **`zipp-php.wasm`** Worker backed by **XDB SQLite 3 WASM** (persisted per container in browser IndexedDB). No PHP server, no Docker, and no external network permissions are needed.
2. **Hosted Standalone on PHP (`php -S` / Apache / `softn-host-php`):**
   Point `backendUrl` at a native PHP server (or run `node examples/basegrid-suite/serve-php.mjs`) and the same PHP scripts automatically switch to a local WAL SQLite 3 file with zero code changes.

## Included Full-Stack `.softn` Apps

| Bundle | Replaces Airtable Capabilities | SQLite Tables |
| :--- | :--- | :--- |
| `basegrid-bases.softn` | Relational Bases, 17 Field Types, Links, Lookups, Rollups, Formulas, 7 Views (Grid, Kanban, Calendar, Gallery, Timeline/Gantt, List, Inbox), Comments, Revision History & CSV Import/Export | `bases`, `tables_meta`, `fields_meta`, `records_data`, `views_meta`, `record_comments`, `record_history` |
| `basegrid-interfaces.softn` | Interface Designer, Exec Summary KPI Cards, Charts, Interactive Record Pickers, Action Buttons & Cross-Tab Pivot Table Extension | `interface_pages`, `interface_widgets`, `portfolio_records` |
| `basegrid-forms.softn` | Branded Forms, Conditional Field Visibility Logic, Submissions Triage & `<softn-app>` Embeds | `forms`, `form_fields`, `form_submissions` |
| `basegrid-automations.softn` | No-Code Trigger/Action Workflows, Paused-for-Review Guard, Live Execution Engine, Run Traces & Slack/Email/Webhook Outbox | `automations`, `automation_steps`, `workflow_records`, `automation_runs`, `notification_outbox` |
| `basegrid-ai-omni.softn` | Airtable Omni Conversational App Builder, AI Plays, Column Field Agents, MCP Tool Console & AI Governance | `omni_blueprints`, `omni_messages`, `field_agents`, `agent_rows`, `mcp_settings`, `mcp_call_logs` |
| `basegrid-portals-sync.softn` | White-Label External Guest Portals ($0 fee), Two-Way & HyperDB Sync Connectors, RBAC Matrix & Immutable Audit Trail | `portals`, `portal_guests`, `portal_deliverables`, `sync_sources`, `sync_runs`, `rbac_policies`, `governance_flags`, `audit_logs` |

## Build, Verify & Run

```bash
# 1. Build all 6 .softn containers and the React Parent Host
node examples/basegrid-suite/build.mjs

# 2. Verify all 6 containers in real ZIPP PHP WASM + XDB SQLite + Standalone PHP mode
node examples/basegrid-suite/verify.mjs

# 3. Launch the Showcase & Internal Parent Workspace (ZIPP WASM mode, zero server)
node examples/basegrid-suite/serve.mjs
# Open http://127.0.0.1:4850/

# 4. (Optional) Start standalone native PHP servers to test ZIPP vs Standalone toggle
node examples/basegrid-suite/serve-php.mjs
```
