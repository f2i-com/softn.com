CREATE TABLE IF NOT EXISTS portals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  brand_color TEXT NOT NULL DEFAULT '#2563eb',
  welcome_text TEXT NOT NULL DEFAULT '',
  domain_label TEXT NOT NULL DEFAULT '',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS portal_guests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  portal_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  company TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'Commenter',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS portal_deliverables (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  portal_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  milestone TEXT NOT NULL DEFAULT 'Phase 1',
  status TEXT NOT NULL DEFAULT 'In Review',
  due_date TEXT NOT NULL DEFAULT '',
  client_approved INTEGER NOT NULL DEFAULT 0,
  client_feedback TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  provider TEXT NOT NULL,
  direction TEXT NOT NULL DEFAULT 'Two-Way',
  verified INTEGER NOT NULL DEFAULT 1,
  scale_tier TEXT NOT NULL DEFAULT 'Standard',
  records_synced INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'Synced',
  last_synced_at TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL,
  source_name TEXT NOT NULL,
  rows_added INTEGER NOT NULL DEFAULT 0,
  rows_updated INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 18,
  status TEXT NOT NULL DEFAULT 'Succeeded',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rbac_policies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role_name TEXT NOT NULL,
  can_edit_schema INTEGER NOT NULL DEFAULT 0,
  can_edit_records INTEGER NOT NULL DEFAULT 0,
  can_comment INTEGER NOT NULL DEFAULT 1,
  can_export_csv INTEGER NOT NULL DEFAULT 0,
  can_manage_portals INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS governance_flags (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  saml_sso INTEGER NOT NULL DEFAULT 1,
  scim_groups INTEGER NOT NULL DEFAULT 1,
  app_sandbox INTEGER NOT NULL DEFAULT 1,
  dlp_guard INTEGER NOT NULL DEFAULT 1,
  data_residency TEXT NOT NULL DEFAULT 'Australia (ap-southeast-2)'
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,
  category TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  created_at TEXT NOT NULL
);

INSERT OR IGNORE INTO portals (id, name, slug, brand_color, welcome_text, domain_label, is_active, created_at) VALUES
  (1, 'Northstar Client Delivery Portal', 'northstar-portal', '#2563eb', 'Review editorial rollout milestones, sign off deliverables, and share feedback with the BaseGrid implementation team.', 'portal.northstar.example', 1, '2026-10-15'),
  (2, 'Kestrel Vendor & Quality Portal', 'kestrel-vendors', '#0d9488', 'Upload quality compliance certificates, review purchase schedules, and confirm batch approvals.', 'vendors.kestrel.example', 1, '2026-10-24'),
  (3, 'Helios Executive Partner Hub', 'helios-partners', '#6d28d9', 'Joint roadmap milestones, Snowflake HyperDB sync metrics, and co-sell pipeline status.', 'partners.helios.example', 1, '2026-11-02');

INSERT OR IGNORE INTO portal_guests (id, portal_id, name, email, company, role, created_at) VALUES
  (1, 1, 'Marcus Vance', 'mvance@northstar.example', 'Northstar Media', 'Editor', '2026-10-16'),
  (2, 1, 'Elena Rostova', 'elena@northstar.example', 'Northstar Media', 'Commenter', '2026-10-18'),
  (3, 2, 'Priya Nair', 'priya@kestrel.example', 'Kestrel BioLabs', 'Editor', '2026-10-25'),
  (4, 3, 'Owen Gallagher', 'owen@helios.example', 'Helios Robotics', 'Viewer', '2026-11-03');

INSERT OR IGNORE INTO portal_deliverables (id, portal_id, title, milestone, status, due_date, client_approved, client_feedback, updated_at) VALUES
  (1, 1, '14 Editorial Base Schemas Migrated to XDB SQLite', 'Phase 1: Data', 'Approved', '2026-11-18', 1, 'All formulas and rollups matched legacy Airtable totals 100%.', '2026-11-18'),
  (2, 1, 'Brand Asset Gallery & Calendar Views Configured', 'Phase 2: Views', 'In Review', '2026-11-28', 0, 'Checking mobile card layout with editorial leads.', '2026-11-20'),
  (3, 1, 'Standalone PHP 8 VPC Production Cutover Plan', 'Phase 3: Go-Live', 'In Progress', '2026-12-08', 0, '', '2026-11-21'),
  (4, 2, 'Supplier ISO 9001 Certificate Intake Form', 'Compliance', 'In Review', '2026-12-02', 0, 'Needs EU residency badge added to header.', '2026-11-19'),
  (5, 3, 'Snowflake HyperDB 10M-Row Account Subset Sync', 'Scale Pilot', 'Approved', '2026-11-22', 1, 'Sub-50ms filtered query latency confirmed.', '2026-11-21');

INSERT OR IGNORE INTO sync_sources (id, name, provider, direction, verified, scale_tier, records_synced, status, last_synced_at) VALUES
  (1, 'Roadmap <-> Pipeline Radar Cross-Base Sync', 'BaseGrid Native', 'Two-Way', 1, 'Standard', 1480, 'Synced', '2026-11-21 09:30:00'),
  (2, 'Snowflake Enterprise Warehouse (HyperDB)', 'Snowflake', 'One-Way', 1, 'HyperDB (100M cap)', 4820000, 'Synced', '2026-11-21 09:15:00'),
  (3, 'Jira Cloud Engineering Issues', 'Jira', 'Two-Way', 1, 'Premium', 6420, 'Synced', '2026-11-21 09:05:00'),
  (4, 'Salesforce Global Accounts & ARR', 'Salesforce', 'Two-Way', 1, 'Premium', 19350, 'Synced', '2026-11-21 08:45:00'),
  (5, 'Stripe Subscriptions & Invoices', 'Stripe', 'One-Way', 1, 'Standard', 3210, 'Synced', '2026-11-21 08:30:00');

INSERT OR IGNORE INTO sync_runs (id, source_id, source_name, rows_added, rows_updated, duration_ms, status, created_at) VALUES
  (1, 2, 'Snowflake Enterprise Warehouse (HyperDB)', 1420, 890, 64, 'Succeeded', '2026-11-21 09:15:00'),
  (2, 3, 'Jira Cloud Engineering Issues', 18, 42, 24, 'Succeeded', '2026-11-21 09:05:00');

INSERT OR IGNORE INTO rbac_policies (id, role_name, can_edit_schema, can_edit_records, can_comment, can_export_csv, can_manage_portals) VALUES
  (1, 'Owner / Creator', 1, 1, 1, 1, 1),
  (2, 'Editor', 0, 1, 1, 1, 0),
  (3, 'Commenter', 0, 0, 1, 0, 0),
  (4, 'Read-Only Viewer', 0, 0, 0, 0, 0),
  (5, 'External Portal Guest', 0, 0, 1, 0, 0);

INSERT OR IGNORE INTO governance_flags (id, saml_sso, scim_groups, app_sandbox, dlp_guard, data_residency) VALUES
  (1, 1, 1, 1, 1, 'Australia (ap-southeast-2)');

INSERT OR IGNORE INTO audit_logs (id, actor, category, action, target, created_at) VALUES
  (1, 'Arjun Mehta', 'Governance', 'Enabled SCIM IdP group synchronization', 'Workspace Security', '2026-11-19 11:20:00'),
  (2, 'Marcus Vance (Guest)', 'Portal', 'Approved deliverable #1', 'Northstar Client Delivery Portal', '2026-11-18 16:40:00'),
  (3, 'System Sync Worker', 'Sync', 'Completed incremental HyperDB warehouse sync (+1,420 rows)', 'Snowflake Enterprise Warehouse', '2026-11-21 09:15:00');
