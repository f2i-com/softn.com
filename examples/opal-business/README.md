# Opal Business — Australian MYOB Business Alternative on SoftN Containers

**Opal Business** is a complete Australian small-to-medium business accounting, payroll, GST/BAS, banking, inventory, and reporting suite built as a modular collection of **8 full-stack `.softn` v2 web containers** hosted internally inside a unified React parent application.

Each module is a self-contained portable `.softn` bundle running:
- **React 18** frontend (Vite production build running inside `zipp-javascript-lite.wasm`)
- **PHP 8** REST API backend (`backend/index.php` + `backend/opal_micro.php`)
- **XDB SQLite 3** database (`backend/schema.sql`, persisted locally in browser IndexedDB via `xdb-wasm.wasm`)

## Dual-Mode PHP Execution (ZIPP WASM by Default, Standalone PHP Optional)

Every Opal Business `.softn` app uses the **exact same PHP 8 code** in both modes:

1. **Hosted Internally in Parent App (Default — Zero Server):**
   `mountSoftNContainer()` runs PHP inside an isolated **`zipp-php.wasm`** Worker backed by **XDB SQLite 3 WASM** (persisted per module in IndexedDB). No PHP server, Docker, or external network permissions required.
2. **Hosted Standalone on Native PHP (`php -S` / Apache / `softn-host-php`):**
   Toggle **Standalone PHP** in the Parent Host topbar (after starting `node examples/opal-business/serve-php.mjs`) and the identical PHP files switch automatically to local WAL SQLite 3 files with zero code changes.

## Included SoftN Modules (MYOB.com.au Parity)

| Bundle | MYOB Business / AccountRight Equivalent | SQLite Tables |
| :--- | :--- | :--- |
| `opal-sales.softn` | Sales, Quotes, Sales Orders, Tax Invoices, Customer Returns & Recurring | `sales_docs`, `customer_payments`, `customer_credits`, `recurring_templates` |
| `opal-purchases.softn` | In Tray (OCR Receipts), Supplier Bills, POs, Supplier Returns & Expenses | `intray_docs`, `purchase_docs`, `supplier_debits`, `expense_claims` |
| `opal-banking.softn` | Unlimited AU Bank Feeds, Smart Matching, Bank Rules & Reconciliation | `bank_accounts`, `bank_transactions`, `bank_rules`, `reconciliations` |
| `opal-accounting.softn` | AU Chart of Accounts (1-xxxx–8-xxxx), General Journals, GST & AI BAS | `accounts`, `journal_entries`, `journal_lines`, `tax_transactions`, `bas_lodgements` |
| `opal-payroll.softn` | Unlimited AU Payroll, Stage 3 PAYG, 12% SG Super, STP Phase 2 & Leave | `employees`, `pay_runs`, `payslips`, `timesheets`, `leave_requests` |
| `opal-inventory.softn` | Multi-Location Inventory, 3-Tier Pricing, Stocktakes, Jobs & Time Billing | `items`, `stock_adjustments`, `jobs`, `time_slips` |
| `opal-contacts.softn` | Customers, Suppliers, ATO TPAR Contractors, Advisors & Mod-89 ABN Check | `contacts`, `contact_notes` |
| `opal-reporting.softn` | P&L (Accrual/Cash), Balance Sheet, Cash Flow, Trial Balance, Aged AR/AP & Multi-Currency FX | `ledger_summary`, `monthly_cashflow`, `aged_items`, `fx_positions`, `saved_packs` |

## Build, Verify & Run

```bash
# 1. Build all 8 full-stack .softn bundles and the React Parent Host
node examples/opal-business/build.mjs

# 2. Verify all 8 ZIPP PHP WASM + XDB SQLite bundles & Standalone PHP mode
node examples/opal-business/verify.mjs

# 3. Launch the Opal Business Parent Workspace (ZIPP WASM default, zero server)
node examples/opal-business/serve.mjs
# Open http://127.0.0.1:4850/

# 4. (Optional) Start standalone native PHP 8 servers on ports 8201..8208
node examples/opal-business/serve-php.mjs
```
