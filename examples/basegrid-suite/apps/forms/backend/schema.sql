CREATE TABLE IF NOT EXISTS forms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  cover_gradient TEXT NOT NULL DEFAULT 'linear-gradient(135deg,#2563eb,#7c3aed)',
  submit_label TEXT NOT NULL DEFAULT 'Submit Request',
  target_table TEXT NOT NULL DEFAULT 'Initiatives',
  is_open INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS form_fields (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  form_id INTEGER NOT NULL,
  field_key TEXT NOT NULL,
  label TEXT NOT NULL,
  field_type TEXT NOT NULL DEFAULT 'text',
  required INTEGER NOT NULL DEFAULT 0,
  placeholder TEXT NOT NULL DEFAULT '',
  help_text TEXT NOT NULL DEFAULT '',
  options_json TEXT NOT NULL DEFAULT '[]',
  condition_json TEXT NOT NULL DEFAULT '{}',
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS form_submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  form_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'New',
  submitter_name TEXT NOT NULL DEFAULT 'Anonymous',
  submitter_email TEXT NOT NULL DEFAULT '',
  answers_json TEXT NOT NULL DEFAULT '{}',
  reviewer_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

INSERT OR IGNORE INTO forms (id, slug, title, description, cover_gradient, submit_label, target_table, is_open, created_at) VALUES
  (1, 'product-feature-intake', 'Product Feature & Enhancement Request', 'Submit customer or internal product ideas directly into the Q4 Roadmap base with automatic priority triage.', 'linear-gradient(135deg,#6d28d9,#2563eb)', 'Submit Feature Request', 'Initiatives', 1, '2026-10-12'),
  (2, 'creative-campaign-brief', 'Marketing Campaign & Creative Brief', 'Kick off blog posts, video shoots, webinars, or paid launches with structured assets and budget fields.', 'linear-gradient(135deg,#ea580c,#db2777)', 'Send Creative Brief', 'Content Calendar', 1, '2026-10-20'),
  (3, 'enterprise-demo-intake', 'Enterprise Self-Hosted Evaluation', 'Request a BaseGrid SoftN deployment architecture review for ZIPP WASM or standalone PHP hosting.', 'linear-gradient(135deg,#0d9488,#0284c7)', 'Request Evaluation', 'Accounts', 1, '2026-11-01');

-- Fields for Form 1
INSERT OR IGNORE INTO form_fields (id, form_id, field_key, label, field_type, required, placeholder, help_text, options_json, condition_json, position) VALUES
  (1, 1, 'title', 'Feature Title', 'text', 1, 'e.g. Two-way Jira webhook sync', 'Short descriptive headline for the roadmap table.', '[]', '{}', 0),
  (2, 1, 'category', 'Request Category', 'single_select', 1, '', 'Determines routing to the owning engineering pod.', '["Core Database","AI & Agents","Enterprise Security","Interfaces & Views"]', '{}', 1),
  (3, 1, 'security_scope', 'Compliance / Security Scope', 'single_select', 0, '', 'Shown conditionally when Enterprise Security is selected.', '["SAML SSO / SCIM","Audit Logs","EU/AU Residency","HIPAA / SOC 2"]', '{"fieldKey":"category","equals":"Enterprise Security"}', 2),
  (4, 1, 'urgency', 'Customer Impact Rating', 'rating', 1, '', '1 = Nice to have | 5 = Deal blocker', '[]', '{}', 3),
  (5, 1, 'target_date', 'Desired Delivery Date', 'date', 0, '', '', '[]', '{}', 4),
  (6, 1, 'details', 'Problem Statement & Use Case', 'long_text', 1, 'Describe who needs this and the measurable outcome...', '', '[]', '{}', 5);

-- Fields for Form 2
INSERT OR IGNORE INTO form_fields (id, form_id, field_key, label, field_type, required, placeholder, help_text, options_json, condition_json, position) VALUES
  (10, 2, 'campaign_name', 'Campaign / Asset Name', 'text', 1, 'e.g. Q1 Enterprise Launch Video', '', '[]', '{}', 0),
  (11, 2, 'channel', 'Primary Channel', 'single_select', 1, '', '', '["Blog","Video","Webinar","Paid Campaign","Case Study"]', '{}', 1),
  (12, 2, 'ad_budget', 'Paid Media Budget ($)', 'number', 0, '15000', 'Only shown when Primary Channel is Paid Campaign.', '[]', '{"fieldKey":"channel","equals":"Paid Campaign"}', 2),
  (13, 2, 'publish_date', 'Target Publish Date', 'date', 1, '', '', '[]', '{}', 3),
  (14, 2, 'brief', 'Key Messaging & CTA', 'long_text', 1, 'Outline target audience, proof points, and CTA...', '', '[]', '{}', 4);

-- Fields for Form 3
INSERT OR IGNORE INTO form_fields (id, form_id, field_key, label, field_type, required, placeholder, help_text, options_json, condition_json, position) VALUES
  (20, 3, 'company', 'Company Name', 'text', 1, 'e.g. Pacific Logistics Group', '', '[]', '{}', 0),
  (21, 3, 'seats', 'Estimated Team Size', 'number', 1, '45', 'Used to estimate per-seat savings vs Airtable Business.', '[]', '{}', 1),
  (22, 3, 'hosting', 'Preferred Backend Mode', 'single_select', 1, '', '', '["ZIPP WASM Embedded (Zero Server)","Standalone PHP 8 + SQLite","Hybrid (Both)"]', '{}', 2),
  (23, 3, 'notes', 'Current Airtable / Spreadsheet Workflow', 'long_text', 0, 'Tell us about your bases, portals, and automations...', '', '[]', '{}', 3);

-- Seed Submissions
INSERT OR IGNORE INTO form_submissions (id, form_id, status, submitter_name, submitter_email, answers_json, reviewer_note, created_at) VALUES
  (1, 1, 'Approved', 'Claire Bennett', 'claire@harbourlogistics.example', '{"title":"Offline SQLite Snapshot Diff Viewer","category":"Core Database","urgency":5,"target_date":"2026-12-18","details":"Ops managers want to compare two exported XDB snapshots before syncing warehouse counts."}', 'Scheduled into Q4 Core Platform sprint.', '2026-11-16 10:15'),
  (2, 1, 'Reviewing', 'Arjun Mehta', 'arjun@vanguardretail.example', '{"title":"Okta SCIM Group Role Sync","category":"Enterprise Security","security_scope":"SAML SSO / SCIM","urgency":5,"target_date":"2026-12-08","details":"Map Okta security groups directly to BaseGrid table & field-level permissions."}', 'Security pod validating SCIM payload.', '2026-11-19 14:40'),
  (3, 1, 'New', 'Hannah Cho', 'hannah@lumenstudios.example', '{"title":"AI Formula Explainer Tooltip","category":"AI & Agents","urgency":4,"target_date":"2026-12-22","details":"Show plain-English explanation when hovering over complex rollup & RICE formulas."}', '', '2026-11-21 09:05'),
  (4, 2, 'Approved', 'Chloe Alvarez', 'chloe@basegrid.local', '{"campaign_name":"Zero-Seat-Fee Portals Launch Film","channel":"Video","publish_date":"2026-12-02","brief":"90-second product film highlighting instant guest portals without $150/mo add-ons."}', 'Storyboard locked.', '2026-11-18 11:30'),
  (5, 3, 'New', 'Marcus Vance', 'mvance@northstar.example', '{"company":"Northstar Media Group","seats":120,"hosting":"Hybrid (Both)","notes":"Looking to migrate 14 editorial bases and 4 client portals off Airtable Business."}', '', '2026-11-20 16:20');
