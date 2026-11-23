# Modula — Open Odoo.com Alternative on SoftN Containers

Modula is a modular business ERP suite & competitor showcase built on **SoftN v2 Web Containers**:

- **Competitor Website + Internal Parent Workspace (`parent-host/`)** built in **React 18** with an Odoo-style 9-dot app switcher, `Ctrl+K` Command Palette, keep-alive container tabs, App Store modal, and custom `.softn` sideloading.
- **11 Portable Full-Stack `.softn` Business Apps (`bundles/modula-*.softn`)** covering all 8 Odoo departments (36+ live modules), each organized into modular React components (`src/types.ts`, `src/components/*.tsx`, `src/App.tsx`, thin `src/main.tsx`), paired with:
  - **React 18** frontend (Vite production build running inside `zipp-javascript-lite.wasm`)
  - **PHP 8** REST API backend (`backend/index.php` + `backend/micro.php`)
  - **XDB SQLite 3** database (`backend/schema.sql`, persisted in browser IndexedDB via `xdb-wasm.wasm`)

## Dual-Mode PHP Execution (ZIPP WASM by Default, Standalone PHP Optional)

Every Modula `.softn` app uses the **exact same PHP 8 code** in both modes:

1. **Embedded inside a Parent Application (Default — Zero Server):**
   `mountSoftNContainer()` runs the PHP backend inside an isolated **`zipp-php.wasm`** Worker backed by **XDB SQLite 3 WASM** (persisted per container in browser IndexedDB). No PHP server, no Docker, and no external network permissions are required.
2. **Hosted Standalone on PHP (`php -S` / Apache / `softn-host-php`):**
   Point `backendUrl` at a native PHP server (or run `node examples/modula-suite/serve-php.mjs`) and the same PHP scripts automatically switch to a local WAL SQLite 3 file with zero code changes.

## Included Full-Stack `.softn` Apps (11 Core Containers)

| Bundle | Replaces Odoo Modules | SQLite Tables |
| :--- | :--- | :--- |
| `modula-crm.softn` | CRM, Sales, Quotations, Subscriptions | `crm_leads`, `deals`, `contacts`, `quotes`, `subscriptions`, `activities` |
| `modula-pos.softn` | Point of Sale (Shop & Restaurant), Rental | `pos_sessions`, `pos_items`, `pos_orders`, `rental_assets`, `rental_bookings` |
| `modula-accounting.softn` | Accounting, Invoicing, Bank Recon, Expenses | `accounts`, `invoices`, `bank_transactions`, `expenses`, `journal_entries` |
| `modula-inventory.softn` | Inventory, Purchase, Manufacturing (MRP) | `products`, `vendors`, `purchase_orders`, `boms`, `manufacturing_orders`, `stock_moves` |
| `modula-projects.softn` | Project, Milestones, Timesheets | `projects`, `tasks`, `milestones`, `timesheets` |
| `modula-fieldservice.softn` | Field Service, Appointments, Planning | `technicians`, `work_orders`, `appointments`, `shifts` |
| `modula-hr.softn` | Employees, Attendance, Time Off, ATS, Appraisals, Payroll | `employees`, `attendances`, `leave_requests`, `candidates`, `appraisals`, `payslips` |
| `modula-website.softn` | Website Builder, eCommerce, Blog, Email Marketing | `pages`, `store_products`, `store_orders`, `blog_posts`, `campaigns`, `leads` |
| `modula-events.softn` | Events, Surveys (NPS), eLearning Academy | `events`, `registrations`, `surveys`, `survey_responses`, `courses`, `lessons` |
| `modula-helpdesk.softn` | Helpdesk, CSAT, Macros, Knowledge Wiki | `tickets`, `ticket_messages`, `canned_responses`, `kb_articles` |
| `modula-workspace.softn` | Documents, eSign (SHA-256), Approvals, Discuss | `documents`, `sign_requests`, `approvals`, `channels`, `channel_messages` |

In addition, the Parent Workspace can mount SoftN's existing vertical industry business packs (POS Retail, Restaurant FOH/KDS, Cafe, Fleet, ISO QMS, Events, Trades, Salon) or any custom `.softn` bundle uploaded from disk.

## Build, Verify & Run

```bash
# 1. Build all 11 .softn containers and the React Parent Host
node examples/modula-suite/build.mjs

# 2. Run automated verification across all 11 ZIPP WASM + XDB SQLite apps & standalone PHP
node examples/modula-suite/verify.mjs

# 3. Launch the Competitor Site & Parent Workspace (ZIPP WASM mode, zero server)
node examples/modula-suite/serve.mjs
# Open http://127.0.0.1:4840/

# 4. (Optional) Start standalone native PHP servers (ports 8101-8111) to test ZIPP vs Standalone toggle
node examples/modula-suite/serve-php.mjs
```
