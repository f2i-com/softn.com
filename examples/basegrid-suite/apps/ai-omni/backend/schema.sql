CREATE TABLE IF NOT EXISTS omni_blueprints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  domain TEXT NOT NULL DEFAULT 'Operations',
  tables_json TEXT NOT NULL DEFAULT '[]',
  views_json TEXT NOT NULL DEFAULT '[]',
  automations_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS omni_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  blueprint_id INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS field_agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  output_column TEXT NOT NULL,
  model_name TEXT NOT NULL DEFAULT 'BaseGrid Local NLP',
  temperature REAL NOT NULL DEFAULT 0.2,
  web_search INTEGER NOT NULL DEFAULT 0,
  prompt_template TEXT NOT NULL,
  runs_completed INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS agent_rows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company TEXT NOT NULL,
  source_text TEXT NOT NULL,
  arr_value REAL NOT NULL DEFAULT 0,
  ai_summary TEXT NOT NULL DEFAULT '',
  ai_risk TEXT NOT NULL DEFAULT '',
  ai_category TEXT NOT NULL DEFAULT '',
  ai_next_action TEXT NOT NULL DEFAULT '',
  confidence INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mcp_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  mcp_enabled INTEGER NOT NULL DEFAULT 1,
  zero_retention INTEGER NOT NULL DEFAULT 1,
  pause_ai_automations INTEGER NOT NULL DEFAULT 1,
  monthly_credit_cap INTEGER NOT NULL DEFAULT 50000,
  credits_used INTEGER NOT NULL DEFAULT 1240
);

CREATE TABLE IF NOT EXISTS mcp_call_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tool_name TEXT NOT NULL,
  args_json TEXT NOT NULL DEFAULT '{}',
  result_preview TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER NOT NULL DEFAULT 6,
  created_at TEXT NOT NULL
);

INSERT OR IGNORE INTO omni_blueprints (id, name, prompt, domain, tables_json, views_json, automations_json, created_at) VALUES
  (1, 'Competitor Battlecard & Intel Base', 'Build a competitive intelligence tracker with competitor profiles, feature parity matrix, pricing changes, and AI win-loss summaries.', 'Product Marketing', '[{"name":"Competitors","fields":["Company","Category","Pricing Model","Threat Level","AI Battlecard"]},{"name":"Feature Matrix","fields":["Capability","BaseGrid Support","Competitor Gap","Linked Competitor"]},{"name":"Win/Loss Calls","fields":["Deal","Outcome","Competitor","Key Objection","AI Extraction"]}]', '["Grid View","Threat Kanban","Exec Comparison Interface","Intake Form"]', '["Alert #competitive-intel when Threat Level = High (Paused for review)"]', '2026-11-18 10:15:00');

INSERT OR IGNORE INTO omni_messages (id, role, content, blueprint_id, created_at) VALUES
  (1, 'user', 'Build a competitive intelligence tracker with competitor profiles, feature parity matrix, pricing changes, and AI win-loss summaries.', 1, '2026-11-18 10:14:55'),
  (2, 'assistant', 'Generated "Competitor Battlecard & Intel Base" with 3 relational tables (Competitors, Feature Matrix, Win/Loss Calls), 4 views, AI Field Agent columns, and 1 automation drafted paused for human review.', 1, '2026-11-18 10:15:00');

INSERT OR IGNORE INTO field_agents (id, name, output_column, model_name, temperature, web_search, prompt_template, runs_completed) VALUES
  (1, 'Executive Summarizer', 'ai_summary', 'BaseGrid Local NLP', 0.2, 0, 'Distill {company} customer notes into a 1-sentence executive takeaway.', 18),
  (2, 'Churn & Deal Risk Classifier', 'ai_risk', 'BaseGrid Local NLP', 0.1, 0, 'Classify expansion/churn risk level (Low Risk / Medium / High Risk) from {source_text}.', 18),
  (3, 'Topic & Intent Tagger', 'ai_category', 'BaseGrid Local NLP', 0.1, 0, 'Assign primary workflow category (Migration / Security / Portals / Analytics).', 18),
  (4, 'Next Best Action Recommender', 'ai_next_action', 'BaseGrid Local NLP', 0.3, 1, 'Recommend one concrete follow-up action for {company} (${arr_value}).', 18);

INSERT OR IGNORE INTO agent_rows (id, company, source_text, arr_value, ai_summary, ai_risk, ai_category, ai_next_action, confidence, updated_at) VALUES
  (1, 'Northstar Media Group', 'Team of 120 editors frustrated by $64k/yr Airtable Business + Portals billing. Loves self-hosted PHP option and wants zero-egress browser preview.', 86000, 'High-intent 120-seat migration from Airtable Business driven by seat & portal cost savings.', 'Low Risk', 'Migration', 'Send 3-year ROI worksheet & schedule standalone PHP sandbox walkthrough.', 96, '2026-11-20'),
  (2, 'Vanguard Retail Co', 'Legal blocked rollout pending SCIM Okta group mapping, HIPAA/SOC 2 audit trail export, and EU data residency proof.', 112000, 'Enterprise deployment paused on SCIM IdP integration and audit log compliance review.', 'High Risk', 'Security', 'Escalate to Enterprise Trust pod & share immutable SQLite audit log demo.', 94, '2026-11-21'),
  (3, 'Lumen Creative Studios', 'Creative director wants branded external client approval portals and visual Gallery cards for 45 active brand campaigns without paying $150/mo portal fees.', 48000, 'Agency buyer seeking white-label client portals and rich gallery proofing workflows.', 'Low Risk', 'Portals', 'Spin up branded Lumen guest portal preview with Gallery view template.', 92, '2026-11-19'),
  (4, 'Helios Robotics', 'Engineering ops wants two-way Jira & Snowflake HyperDB sync feeding executive dashboards and automated P0 incident escalation.', 145000, 'Strong expansion opportunity anchored on HyperDB warehouse sync and exec reporting.', 'Medium', 'Analytics', 'Run live Jira/Snowflake sync benchmark & exec KPI interface workshop.', 95, '2026-11-20'),
  (5, 'Solstice Health Clinics', 'Clinic managers still managing patient staffing schedules in legacy spreadsheets; urgent need for offline-capable forms and calendar views.', 39000, '', '', '', '', 0, '2026-11-21');

INSERT OR IGNORE INTO mcp_settings (id, mcp_enabled, zero_retention, pause_ai_automations, monthly_credit_cap, credits_used) VALUES
  (1, 1, 1, 1, 50000, 1240);

INSERT OR IGNORE INTO mcp_call_logs (id, tool_name, args_json, result_preview, duration_ms, created_at) VALUES
  (1, 'list_blueprints', '{}', 'Returned 1 relational blueprint (3 tables, 4 views)', 4, '2026-11-20 11:05:00'),
  (2, 'query_agent_rows', '{"risk":"High Risk"}', 'Matched 1 row: Vanguard Retail Co ($112,000 ARR)', 5, '2026-11-21 08:40:00');
