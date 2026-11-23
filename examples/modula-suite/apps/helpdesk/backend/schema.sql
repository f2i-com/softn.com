CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_number TEXT NOT NULL UNIQUE,
  subject TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  customer_email TEXT NOT NULL DEFAULT '',
  stage TEXT NOT NULL DEFAULT 'New',
  priority TEXT NOT NULL DEFAULT 'Normal',
  assignee TEXT NOT NULL DEFAULT 'Samira Khan',
  sla_status TEXT NOT NULL DEFAULT 'On Track',
  tags TEXT NOT NULL DEFAULT 'Support',
  csat_rating INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ticket_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL,
  author TEXT NOT NULL,
  is_internal INTEGER NOT NULL DEFAULT 0,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS canned_responses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shortcut TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  body TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kb_articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Operations',
  body TEXT NOT NULL,
  helpful_votes INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO tickets (id, ticket_number, subject, customer_name, customer_email, stage, priority, assignee, sla_status, tags, csat_rating, created_at) VALUES
  (1, 'HD-1041', 'Export XDB SQLite backup from Inventory container', 'Claire Bennett', 'claire@harbourlogistics.example', 'In Progress', 'High', 'Samira Khan', 'On Track', 'SQLite, Backup', 0, '2026-11-19 09:12'),
  (2, 'HD-1042', 'Switch CRM backend from ZIPP WASM to standalone PHP host', 'Marcus Vance', 'mvance@northstar.example', 'New', 'Urgent', 'Jordan Patel', 'Due in 2h', 'Deployment, PHP', 0, '2026-11-20 11:40'),
  (3, 'HD-1043', 'Custom tax rate 15% GST for New Zealand invoices', 'Liam O''Connor', 'liam@brightleaf.example', 'Waiting', 'Normal', 'Samira Khan', 'On Track', 'Accounting', 0, '2026-11-18 15:22'),
  (4, 'HD-1044', 'Add custom SKU barcode column to PO receiving', 'Priya Nair', 'priya@kestrelmfg.example', 'Solved', 'Low', 'Alex Rivera', 'Met', 'Inventory', 5, '2026-11-15 10:05'),
  (5, 'HD-1045', 'Bulk import 850 legacy Odoo contacts CSV', 'Hannah Cho', 'hcho@solsticehealth.example', 'Solved', 'Normal', 'Samira Khan', 'Met', 'Migration', 5, '2026-11-14 14:30');

INSERT OR IGNORE INTO ticket_messages (id, ticket_id, author, is_internal, body, created_at) VALUES
  (1, 1, 'Claire Bennett', 0, 'Hi team, how can our finance auditor pull a raw SQLite snapshot of our warehouse data each Friday?', '2026-11-19 09:12'),
  (2, 1, 'Samira Khan', 0, 'Hi Claire! Click "Export SQLite .db" in the Modula parent toolbar - it downloads a standard SQLite 3 database directly from XDB WASM.', '2026-11-19 09:38'),
  (3, 1, 'Samira Khan', 1, 'Internal note: Verified Harbour Logistics is on Modula v1.0 with persistent IndexedDB enabled.', '2026-11-19 09:41'),
  (4, 2, 'Marcus Vance', 0, 'We want to point our 14 retail stores to a shared PHP + WAL SQLite server on our VPC instead of browser-local ZIPP.', '2026-11-20 11:40');

INSERT OR IGNORE INTO canned_responses (id, shortcut, title, body) VALUES
  (1, '/sqlite', 'SQLite Export Instructions', 'You can export your full SQLite 3 database at any time by clicking "Export SQLite .db" in the Modula Parent Workspace toolbar. The exported .sqlite3 file opens directly in SoftN Studio or DB Browser for SQLite.'),
  (2, '/php-host', 'Standalone PHP Hosting Guide', 'To host this app on your own PHP 8 server, start `node examples/modula-suite/serve-php.mjs` (or deploy backend/index.php behind Apache/Nginx) and switch the Workspace topbar toggle to "Standalone PHP Host". Zero app code changes needed!'),
  (3, '/escalate', 'Engineering Escalation', 'Thanks for flagging this! I have escalated your ticket to our Core Systems team with full diagnostic context and will update you within 2 business hours.');

INSERT OR IGNORE INTO kb_articles (id, title, category, body, helpful_votes, updated_at) VALUES
  (1, 'Hosting a Modula App on Standalone PHP vs ZIPP WASM', 'Deployment', 'Every Modula .softn app ships with a dual-mode PHP 8 backend (backend/index.php + backend/micro.php). Inside the browser parent shell, SoftN runs PHP inside zipp-php.wasm backed by XDB SQLite WASM in IndexedDB - no server required. To scale multi-user, run `php -S 127.0.0.1:8101 backend/index.php` (or deploy behind Apache/Nginx/softn-host-php) and pass `backendUrl` from the parent application.', 24, '2026-11-18'),
  (2, 'Exporting & Auditing XDB SQLite Databases', 'Database', 'Because Modula stores all ERP data in standard SQLite 3 files (via XDB WASM locally or WAL SQLite on a server), you can export `.db` snapshots at any time with zero vendor lock-in and inspect them using DB Browser for SQLite or SoftN Studio Data Explorer.', 19, '2026-11-16'),
  (3, 'Migrating from Odoo Enterprise to Modula SoftN Containers', 'Migration', 'Export your Odoo contacts, products, invoices, and employees as CSV or JSON, then import them directly into the matching Modula app. Unlike Odoo, adding a 2nd, 3rd, or 7th app never unlocks a per-user SaaS fee.', 31, '2026-11-19');
