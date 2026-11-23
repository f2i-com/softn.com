CREATE TABLE IF NOT EXISTS interface_pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  audience TEXT NOT NULL DEFAULT 'Executive',
  accent_color TEXT NOT NULL DEFAULT '#2563eb',
  is_public INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS interface_widgets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id INTEGER NOT NULL,
  widget_type TEXT NOT NULL,
  title TEXT NOT NULL,
  span TEXT NOT NULL DEFAULT 'half',
  config_json TEXT NOT NULL DEFAULT '{}',
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS portfolio_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  department TEXT NOT NULL,
  status TEXT NOT NULL,
  quarter TEXT NOT NULL,
  owner_name TEXT NOT NULL,
  budget REAL NOT NULL DEFAULT 0,
  projected_arr REAL NOT NULL DEFAULT 0,
  progress INTEGER NOT NULL DEFAULT 0,
  approved INTEGER NOT NULL DEFAULT 0,
  priority TEXT NOT NULL DEFAULT 'P1',
  summary TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO interface_pages (id, name, description, audience, accent_color, is_public, created_at) VALUES
  (1, 'Executive Portfolio Summary', 'Leadership KPI ribbon, department spend bar chart, status distribution donut & live approval review.', 'Executive', '#6d28d9', 1, '2026-10-10'),
  (2, 'Revenue & Pipeline Review', 'ARR impact by quarter, pipeline velocity & high-value initiative drilldown.', 'Sales & RevOps', '#ea580c', 0, '2026-10-18'),
  (3, 'Pivot & Reporting Studio', 'Multi-dimensional cross-tab pivot extension with live heatmap intensity and summary rollups.', 'Operations', '#0d9488', 0, '2026-11-01');

INSERT OR IGNORE INTO interface_widgets (id, page_id, widget_type, title, span, config_json, position) VALUES
  (1, 1, 'kpi_strip', 'Exec Summary Cards', 'full', '{}', 0),
  (2, 1, 'bar_chart', 'Budget Allocation by Department', 'half', '{"groupBy":"department","metric":"budget"}', 1),
  (3, 1, 'donut_chart', 'Initiatives by Status', 'half', '{"groupBy":"status","metric":"count"}', 2),
  (4, 1, 'record_review', 'Live Record Picker & Approval Actions', 'full', '{}', 3),
  (5, 2, 'kpi_strip', 'Revenue Impact Highlights', 'full', '{}', 0),
  (6, 2, 'bar_chart', 'Projected ARR by Quarter', 'half', '{"groupBy":"quarter","metric":"projected_arr"}', 1),
  (7, 2, 'bar_chart', 'Projected ARR by Priority', 'half', '{"groupBy":"priority","metric":"projected_arr"}', 2),
  (8, 2, 'record_review', 'Deal & Initiative Drilldown', 'full', '{}', 3),
  (9, 3, 'pivot_table', 'Interactive Cross-Tab Pivot Table', 'full', '{"rowField":"department","colField":"status","metric":"projected_arr"}', 0),
  (10, 3, 'bar_chart', 'Department Progress Comparison', 'full', '{"groupBy":"department","metric":"projected_arr"}', 1);

INSERT OR IGNORE INTO portfolio_records (id, title, department, status, quarter, owner_name, budget, projected_arr, progress, approved, priority, summary, updated_at) VALUES
  (1, 'ZIPP WASM Relational Engine 2.0', 'Engineering', 'Launched', 'Q4 2026', 'Maya Lin', 68000, 420000, 100, 1, 'P0', 'Full relational tables, formulas, and XDB SQLite running client-side with zero server latency.', '2026-11-18'),
  (2, 'Omni AI App Builder & Field Agents', 'Product', 'In Review', 'Q4 2026', 'Devon Brooks', 92000, 680000, 92, 1, 'P0', 'Conversational schema generation + per-column AI Field Agents with zero data retention.', '2026-11-20'),
  (3, 'Two-Way Sync & HyperDB Connectors', 'Engineering', 'In Progress', 'Q4 2026', 'Priya Rao', 74000, 510000, 74, 1, 'P1', 'Bi-directional sync across Jira, Salesforce, and Snowflake warehouse subsets.', '2026-11-21'),
  (4, 'White-Label External Guest Portals', 'Product', 'Beta', 'Q4 2026', 'Arjun Mehta', 56000, 390000, 82, 1, 'P1', 'Zero-seat-fee client and vendor portals replacing $150/mo SaaS portal add-ons.', '2026-11-20'),
  (5, 'Q4 Self-Hosted Campaign Wave', 'Marketing', 'In Progress', 'Q4 2026', 'Chloe Alvarez', 45000, 290000, 68, 1, 'P1', 'Interactive pricing savings benchmarks, case studies, and video walkthrough series.', '2026-11-19'),
  (6, 'Enterprise SCIM & Audit Governance', 'Operations', 'At Risk', 'Q4 2026', 'Arjun Mehta', 83000, 540000, 58, 0, 'P0', 'Pending final IdP group sync verification for enterprise security review.', '2026-11-21'),
  (7, 'Global Partner Portal Launch', 'Sales', 'Planning', 'Q1 2027', 'Jordan Patel', 38000, 310000, 35, 0, 'P2', 'Self-service deal registration and white-label demo deployment for channel partners.', '2026-11-17'),
  (8, 'Mobile Offline Companion App', 'Design & UX', 'Planning', 'Q1 2027', 'Chloe Alvarez', 32000, 195000, 28, 0, 'P2', 'Offline-first mobile shell backed by SoftN PWA cache and IndexedDB.', '2026-11-16'),
  (9, 'Autonomous Support Triage Plays', 'Operations', 'Launched', 'Q3 2026', 'Samira Khan', 29000, 175000, 100, 1, 'P1', 'Automated ticket classification, sentiment scoring, and SLA escalation workflows.', '2026-10-28'),
  (10, 'Visual Interface Charts & Pivots', 'Design & UX', 'In Review', 'Q4 2026', 'Hannah Cho', 41000, 260000, 88, 1, 'P1', 'Drag-and-drop dashboard builder with live role simulation and read-only sharing.', '2026-11-21');
