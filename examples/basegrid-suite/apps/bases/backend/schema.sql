CREATE TABLE IF NOT EXISTS bases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '#2563eb',
  icon TEXT NOT NULL DEFAULT 'BG',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tables_meta (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  base_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS fields_meta (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  table_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  field_type TEXT NOT NULL DEFAULT 'text',
  options_json TEXT NOT NULL DEFAULT '{}',
  is_primary INTEGER NOT NULL DEFAULT 0,
  width INTEGER NOT NULL DEFAULT 170,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS records_data (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  table_id INTEGER NOT NULL,
  cells_json TEXT NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL DEFAULT 'Maya Lin',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS views_meta (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  table_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  view_type TEXT NOT NULL DEFAULT 'grid',
  config_json TEXT NOT NULL DEFAULT '{}',
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS record_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id INTEGER NOT NULL,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS record_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id INTEGER NOT NULL,
  actor TEXT NOT NULL,
  field_name TEXT NOT NULL,
  old_value TEXT NOT NULL DEFAULT '',
  new_value TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

-- =========================================================================
-- SEED BASES (3 Flagship Airtable-Style Relational Bases)
-- =========================================================================
INSERT OR IGNORE INTO bases (id, name, description, color, icon, created_at) VALUES
  (1, 'Product Roadmap & Launch', 'Cross-functional initiatives, linked feature specs, RICE formulas, team rollups & Gantt schedules.', '#6d28d9', 'PR', '2026-10-01'),
  (2, 'Pipeline Radar CRM', 'Enterprise accounts, funding tiers, ARR tracking, linked deals & AI risk scoring.', '#ea580c', 'RD', '2026-10-12'),
  (3, 'Content & Campaign Studio', 'Multi-channel editorial calendar, creative assets gallery, budgets & launch cadence.', '#0d9488', 'CC', '2026-10-20');

-- =========================================================================
-- TABLES
-- =========================================================================
INSERT OR IGNORE INTO tables_meta (id, base_id, name, description, position) VALUES
  (1, 1, 'Initiatives', 'Strategic product initiatives linked to teams and specs.', 0),
  (2, 1, 'Feature Specs', 'Deliverable features rolling up effort and story counts.', 1),
  (3, 1, 'Teams', 'Functional engineering & product pods.', 2),
  (4, 2, 'Accounts', 'Target & active customer accounts with AI risk scoring.', 0),
  (5, 2, 'Opportunities', 'Active sales deals linked directly to Accounts.', 1),
  (6, 3, 'Content Calendar', 'Editorial calendar across blog, video, webinar & social.', 0),
  (7, 3, 'Campaigns', 'Quarterly marketing campaigns with spend & target rollups.', 1);

-- =========================================================================
-- FIELDS: BASE 1 / TABLE 1 (Initiatives)
-- =========================================================================
INSERT OR IGNORE INTO fields_meta (id, table_id, name, field_type, options_json, is_primary, width, position) VALUES
  (1, 1, 'Initiative', 'text', '{}', 1, 240, 0),
  (2, 1, 'Status', 'single_select', '{"choices":["Planning","In Progress","In Review","Beta","Launched","At Risk"]}', 0, 135, 1),
  (3, 1, 'Priority', 'single_select', '{"choices":["P0","P1","P2","P3"]}', 0, 95, 2),
  (4, 1, 'Owner Team', 'link', '{"targetTableId":3}', 0, 165, 3),
  (5, 1, 'Team Lead', 'lookup', '{"linkFieldId":4,"targetFieldId":21}', 0, 145, 4),
  (6, 1, 'Linked Specs', 'link', '{"targetTableId":2}', 0, 195, 5),
  (7, 1, 'Spec Effort (hrs)', 'rollup', '{"linkFieldId":6,"targetFieldId":17,"agg":"SUM"}', 0, 140, 6),
  (8, 1, 'Budget', 'currency', '{"symbol":"$"}', 0, 125, 7),
  (9, 1, 'Impact', 'rating', '{"max":5}', 0, 115, 8),
  (10, 1, 'Confidence %', 'percent', '{}', 0, 115, 9),
  (11, 1, 'RICE Score', 'formula', '{"formula":"ROUND(({Impact} * 20 * {Confidence %}) / MAX({Spec Effort (hrs)}, 10), 1)"}', 0, 115, 10),
  (12, 1, 'Start Date', 'date', '{}', 0, 125, 11),
  (13, 1, 'Launch Date', 'date', '{}', 0, 125, 12),
  (14, 1, 'Tags', 'multi_select', '{"choices":["AI","Enterprise","Mobile","Security","DX","Growth"]}', 0, 185, 13),
  (15, 1, 'Approved', 'checkbox', '{}', 0, 95, 14),
  (16, 1, 'AI Brief', 'ai_agent', '{"prompt":"Summarize launch readiness and top risk for {Initiative} ({Status}, budget {Budget})","mode":"summary"}', 0, 240, 15);

-- FIELDS: BASE 1 / TABLE 2 (Feature Specs)
INSERT OR IGNORE INTO fields_meta (id, table_id, name, field_type, options_json, is_primary, width, position) VALUES
  (170, 2, 'Spec Title', 'text', '{}', 1, 240, 0),
  (171, 2, 'Stage', 'single_select', '{"choices":["Backlog","Design","Building","In Review","Done"]}', 0, 130, 1),
  (17, 2, 'Est Hours', 'number', '{}', 0, 110, 2),
  (172, 2, 'Assignee', 'text', '{}', 0, 140, 3),
  (173, 2, 'Due Date', 'date', '{}', 0, 125, 4),
  (174, 2, 'QA Signed', 'checkbox', '{}', 0, 95, 5),
  (175, 2, 'Spec Link', 'url', '{}', 0, 190, 6);

-- FIELDS: BASE 1 / TABLE 3 (Teams)
INSERT OR IGNORE INTO fields_meta (id, table_id, name, field_type, options_json, is_primary, width, position) VALUES
  (20, 3, 'Team Name', 'text', '{}', 1, 190, 0),
  (21, 3, 'Lead', 'text', '{}', 0, 150, 1),
  (22, 3, 'Department', 'single_select', '{"choices":["Product","Engineering","Design & UX","Operations"]}', 0, 140, 2),
  (23, 3, 'Headcount', 'number', '{}', 0, 110, 3),
  (24, 3, 'Slack Channel', 'text', '{}', 0, 150, 4);

-- FIELDS: BASE 2 / TABLE 4 (Accounts - Airtable Homepage Pipeline Radar Inspired)
INSERT OR IGNORE INTO fields_meta (id, table_id, name, field_type, options_json, is_primary, width, position) VALUES
  (30, 4, 'Account Name', 'text', '{}', 1, 210, 0),
  (31, 4, 'Tier', 'single_select', '{"choices":["Tier 1","Tier 2","Tier 3"]}', 0, 115, 1),
  (32, 4, 'Funding Stage', 'single_select', '{"choices":["Seed","Series A","Series B","Series C","Enterprise"]}', 0, 135, 2),
  (33, 4, 'Estimated ARR', 'currency', '{"symbol":"$"}', 0, 140, 3),
  (34, 4, 'Employees', 'number', '{}', 0, 110, 4),
  (35, 4, 'Website', 'url', '{}', 0, 190, 5),
  (36, 4, 'Last Interaction', 'date', '{}', 0, 135, 6),
  (37, 4, 'Recently Funded', 'checkbox', '{}', 0, 130, 7),
  (38, 4, 'Linked Deals', 'link', '{"targetTableId":5}', 0, 185, 8),
  (39, 4, 'Pipeline Rollup', 'rollup', '{"linkFieldId":38,"targetFieldId":42,"agg":"SUM"}', 0, 140, 9),
  (40, 4, 'AI Account Signal', 'ai_agent', '{"prompt":"Assess expansion readiness for {Account Name} at {Funding Stage}","mode":"risk"}', 0, 220, 10);

-- FIELDS: BASE 2 / TABLE 5 (Opportunities)
INSERT OR IGNORE INTO fields_meta (id, table_id, name, field_type, options_json, is_primary, width, position) VALUES
  (41, 5, 'Opportunity', 'text', '{}', 1, 230, 0),
  (42, 5, 'Deal Value', 'currency', '{"symbol":"$"}', 0, 130, 1),
  (43, 5, 'Stage', 'single_select', '{"choices":["Discovery","Proposal","Negotiation","Won","At Risk"]}', 0, 130, 2),
  (44, 5, 'Win Prob %', 'percent', '{}', 0, 110, 3),
  (45, 5, 'Weighted ARR', 'formula', '{"formula":"ROUND({Deal Value} * ({Win Prob %} / 100), 0)"}', 0, 135, 4),
  (46, 5, 'Close Date', 'date', '{}', 0, 125, 5),
  (47, 5, 'Owner', 'text', '{}', 0, 140, 6);

-- FIELDS: BASE 3 / TABLE 6 (Content Calendar)
INSERT OR IGNORE INTO fields_meta (id, table_id, name, field_type, options_json, is_primary, width, position) VALUES
  (50, 6, 'Content Title', 'text', '{}', 1, 240, 0),
  (51, 6, 'Format', 'single_select', '{"choices":["Blog","Video","Webinar","Social","Email","Case Study"]}', 0, 125, 1),
  (52, 6, 'Status', 'single_select', '{"choices":["Draft","In Review","Scheduled","Published"]}', 0, 125, 2),
  (53, 6, 'Campaign', 'link', '{"targetTableId":7}', 0, 170, 3),
  (54, 6, 'Publish Date', 'date', '{}', 0, 125, 4),
  (55, 6, 'Author', 'text', '{}', 0, 135, 5),
  (56, 6, 'Est Views', 'number', '{}', 0, 110, 6),
  (57, 6, 'Cover Theme', 'attachment', '{}', 0, 130, 7);

-- FIELDS: BASE 3 / TABLE 7 (Campaigns)
INSERT OR IGNORE INTO fields_meta (id, table_id, name, field_type, options_json, is_primary, width, position) VALUES
  (60, 7, 'Campaign Name', 'text', '{}', 1, 220, 0),
  (61, 7, 'Status', 'single_select', '{"choices":["Planning","Active","Completed"]}', 0, 120, 1),
  (62, 7, 'Budget', 'currency', '{"symbol":"$"}', 0, 125, 2),
  (63, 7, 'Spend to Date', 'currency', '{"symbol":"$"}', 0, 130, 3),
  (64, 7, 'Remaining', 'formula', '{"formula":"{Budget} - {Spend to Date}"}', 0, 125, 4),
  (65, 7, 'Start Date', 'date', '{}', 0, 125, 5),
  (66, 7, 'End Date', 'date', '{}', 0, 125, 6);

-- =========================================================================
-- RECORDS: TEAMS (Table 3)
-- =========================================================================
INSERT OR IGNORE INTO records_data (id, table_id, cells_json, created_by, created_at, updated_at) VALUES
  (201, 3, '{"20":"Core Platform","21":"Maya Lin","22":"Engineering","23":12,"24":"#pod-core-platform"}', 'Maya Lin', '2026-10-02', '2026-11-10'),
  (202, 3, '{"20":"AI & Agents","21":"Devon Brooks","22":"Product","23":8,"24":"#pod-omni-ai"}', 'Maya Lin', '2026-10-02', '2026-11-12'),
  (203, 3, '{"20":"Design Systems","21":"Chloe Alvarez","22":"Design & UX","23":6,"24":"#pod-design-sys"}', 'Maya Lin', '2026-10-02', '2026-11-14'),
  (204, 3, '{"20":"Enterprise Trust","21":"Arjun Mehta","22":"Operations","23":9,"24":"#pod-trust-sec"}', 'Maya Lin', '2026-10-02', '2026-11-15');

-- RECORDS: FEATURE SPECS (Table 2)
INSERT OR IGNORE INTO records_data (id, table_id, cells_json, created_by, created_at, updated_at) VALUES
  (101, 2, '{"170":"Formula Engine v2 Parser","171":"Done","17":42,"172":"Liam Chen","173":"2026-11-14","174":true,"175":"https://docs.basegrid.local/specs/formula-v2"}', 'Maya Lin', '2026-10-05', '2026-11-14'),
  (102, 2, '{"170":"Bi-Directional Sync Worker","171":"Building","17":64,"172":"Priya Rao","173":"2026-12-03","174":false,"175":"https://docs.basegrid.local/specs/two-way-sync"}', 'Maya Lin', '2026-10-08', '2026-11-18'),
  (103, 2, '{"170":"Field Agent Batch Queue","171":"In Review","17":36,"172":"Devon Brooks","173":"2026-11-28","174":true,"175":"https://docs.basegrid.local/specs/field-agents"}', 'Devon Brooks', '2026-10-12', '2026-11-19'),
  (104, 2, '{"170":"Gantt Dependency Arrows","171":"Building","17":28,"172":"Chloe Alvarez","173":"2026-12-09","174":false,"175":"https://docs.basegrid.local/specs/gantt-deps"}', 'Chloe Alvarez', '2026-10-15', '2026-11-20'),
  (105, 2, '{"170":"White-Label Guest Portals","171":"Design","17":48,"172":"Hannah Cho","173":"2026-12-18","174":false,"175":"https://docs.basegrid.local/specs/portals"}', 'Arjun Mehta', '2026-10-18', '2026-11-18'),
  (106, 2, '{"170":"SAML SSO + SCIM Provisioning","171":"In Review","17":54,"172":"Arjun Mehta","173":"2026-12-05","174":true,"175":"https://docs.basegrid.local/specs/scim-sso"}', 'Arjun Mehta', '2026-10-20', '2026-11-21'),
  (107, 2, '{"170":"Offline XDB SQLite Export","171":"Done","17":22,"172":"Liam Chen","173":"2026-11-10","174":true,"175":"https://docs.basegrid.local/specs/xdb-export"}', 'Maya Lin', '2026-10-21', '2026-11-10');

-- RECORDS: INITIATIVES (Table 1)
INSERT OR IGNORE INTO records_data (id, table_id, cells_json, created_by, created_at, updated_at) VALUES
  (1, 1, '{"1":"ZIPP WASM Relational Engine 2.0","2":"Launched","3":"P0","4":[201],"6":[101,107],"8":68000,"9":5,"10":95,"12":"2026-10-05","13":"2026-11-18","14":["DX","Enterprise"],"15":true,"16":"Shipped ahead of target with zero-egress XDB persistence and 100% formula coverage."}', 'Maya Lin', '2026-10-03', '2026-11-19'),
  (2, 1, '{"1":"Omni AI App Builder & Field Agents","2":"In Review","3":"P0","4":[202],"6":[103],"8":92000,"9":5,"10":88,"12":"2026-10-20","13":"2026-11-30","14":["AI","Growth"],"15":true,"16":"High confidence; final latency pass on batch column runs before GA launch."}', 'Devon Brooks', '2026-10-08', '2026-11-20'),
  (3, 1, '{"1":"Two-Way Sync & HyperDB Connectors","2":"In Progress","3":"P1","4":[201],"6":[102],"8":74000,"9":4,"10":75,"12":"2026-11-01","13":"2026-12-12","14":["Enterprise","DX"],"15":true,"16":"Conflict resolution worker active; Snowflake & Jira delta sync in staging."}', 'Maya Lin', '2026-10-14', '2026-11-21'),
  (4, 1, '{"1":"Visual Timeline & Gantt Dependencies","2":"In Progress","3":"P1","4":[203],"6":[104],"8":41000,"9":4,"10":85,"12":"2026-11-08","13":"2026-12-15","14":["DX","Mobile"],"15":true,"16":"Quarter/month zoom ready; critical path dependency markers underway."}', 'Chloe Alvarez', '2026-10-19', '2026-11-20'),
  (5, 1, '{"1":"External Client Portals (Zero Seat Fee)","2":"Beta","3":"P1","4":[204],"6":[105],"8":56000,"9":5,"10":80,"12":"2026-11-12","13":"2026-12-22","14":["Enterprise","Growth"],"15":true,"16":"Replaces $150/mo portal add-on; custom domain branding in design review."}', 'Arjun Mehta', '2026-10-22', '2026-11-21'),
  (6, 1, '{"1":"Enterprise Governance, SCIM & Audit","2":"At Risk","3":"P0","4":[204],"6":[106],"8":83000,"9":4,"10":62,"12":"2026-11-04","13":"2026-12-08","14":["Security","Enterprise"],"15":false,"16":"Requires IdP group mapping sign-off from security review committee."}', 'Arjun Mehta', '2026-10-25', '2026-11-21'),
  (7, 1, '{"1":"Mobile Offline Companion Shell","2":"Planning","3":"P2","4":[203],"6":[],"8":32000,"9":3,"10":70,"12":"2026-12-01","13":"2027-01-20","14":["Mobile"],"15":false,"16":"Scoped for Q1; leverages SoftN PWA cache and IndexedDB sync queue."}', 'Chloe Alvarez', '2026-11-02', '2026-11-18');

-- RECORDS: OPPORTUNITIES (Table 5)
INSERT OR IGNORE INTO records_data (id, table_id, cells_json, created_by, created_at, updated_at) VALUES
  (401, 5, '{"41":"Helios Robotics - Global Ops Workspace","42":145000,"43":"Negotiation","44":85,"46":"2026-12-05","47":"Jordan Patel"}', 'Jordan Patel', '2026-10-15', '2026-11-20'),
  (402, 5, '{"41":"Northstar Media - 120-Seat Editorial Hub","42":86000,"43":"Proposal","44":65,"46":"2026-12-14","47":"Samira Khan"}', 'Samira Khan', '2026-10-19', '2026-11-19'),
  (403, 5, '{"41":"Kestrel Bio - Lab Inventory & Forms","42":64000,"43":"Won","44":100,"46":"2026-11-14","47":"Jordan Patel"}', 'Jordan Patel', '2026-10-10', '2026-11-14'),
  (404, 5, '{"41":"Vanguard Retail - Vendor Portal Suite","42":112000,"43":"At Risk","44":35,"46":"2026-12-22","47":"Alex Rivera"}', 'Alex Rivera', '2026-10-28', '2026-11-21'),
  (405, 5, '{"41":"Lumen Studios - Production Pipeline","42":48000,"43":"Discovery","44":45,"46":"2027-01-10","47":"Samira Khan"}', 'Samira Khan', '2026-11-05', '2026-11-18');

-- RECORDS: ACCOUNTS (Table 4)
INSERT OR IGNORE INTO records_data (id, table_id, cells_json, created_by, created_at, updated_at) VALUES
  (301, 4, '{"30":"Helios Robotics","31":"Tier 1","32":"Series C","33":42000000,"34":340,"35":"https://heliosrobotics.example","36":"2026-11-20","37":true,"38":[401],"40":"Strong expansion signal: fresh Series C + 85% close probability."}', 'Jordan Patel', '2026-10-14', '2026-11-20'),
  (302, 4, '{"30":"Northstar Media Group","31":"Tier 1","32":"Enterprise","33":128000000,"34":1150,"35":"https://northstarmedia.example","36":"2026-11-18","37":false,"38":[402],"40":"Replacing $64k/yr Airtable Business contract with self-hosted PHP."}', 'Samira Khan', '2026-10-18', '2026-11-19'),
  (303, 4, '{"30":"Kestrel BioLabs","31":"Tier 2","32":"Series B","33":19500000,"34":145,"35":"https://kestrelbio.example","36":"2026-11-14","37":true,"38":[403],"40":"Active customer; high satisfaction with offline XDB SQLite lab exports."}', 'Jordan Patel', '2026-10-10', '2026-11-15'),
  (304, 4, '{"30":"Vanguard Retail Co","31":"Tier 1","32":"Enterprise","33":210000000,"34":2400,"35":"https://vanguardretail.example","36":"2026-11-09","37":false,"38":[404],"40":"High Risk: security questionnaire pending SCIM compliance review."}', 'Alex Rivera', '2026-10-25', '2026-11-21'),
  (305, 4, '{"30":"Lumen Creative Studios","31":"Tier 3","32":"Series A","33":7800000,"34":62,"35":"https://lumenstudios.example","36":"2026-11-16","37":true,"38":[405],"40":"Fast-moving creative agency; needs Gallery + Client Portals immediately."}', 'Samira Khan', '2026-11-04', '2026-11-18');

-- RECORDS: CAMPAIGNS (Table 7)
INSERT OR IGNORE INTO records_data (id, table_id, cells_json, created_by, created_at, updated_at) VALUES
  (601, 7, '{"60":"Q4 Self-Hosted Launch Wave","61":"Active","62":45000,"63":28400,"65":"2026-11-01","66":"2026-12-20"}', 'Chloe Alvarez', '2026-10-20', '2026-11-19'),
  (602, 7, '{"60":"Omni AI Field Agents Spotlight","61":"Active","62":32000,"63":14200,"65":"2026-11-10","66":"2026-12-30"}', 'Chloe Alvarez', '2026-10-25', '2026-11-20'),
  (603, 7, '{"60":"Enterprise Portals Migration Guide","61":"Planning","62":18000,"63":2500,"65":"2026-12-01","66":"2027-01-15"}', 'Devon Brooks', '2026-11-01', '2026-11-18');

-- RECORDS: CONTENT CALENDAR (Table 6)
INSERT OR IGNORE INTO records_data (id, table_id, cells_json, created_by, created_at, updated_at) VALUES
  (501, 6, '{"50":"Why Teams Move From $45/Seat SaaS to SoftN Containers","51":"Blog","52":"Published","53":[601],"54":"2026-11-12","55":"Maya Lin","56":18400,"57":"linear-gradient(135deg,#2563eb,#7c3aed)"}', 'Maya Lin', '2026-11-01', '2026-11-12'),
  (502, 6, '{"50":"Live Demo: Building a Relational Base in 90 Seconds","51":"Video","52":"Scheduled","53":[601],"54":"2026-11-24","55":"Chloe Alvarez","56":24500,"57":"linear-gradient(135deg,#ea580c,#db2777)"}', 'Chloe Alvarez', '2026-11-06', '2026-11-20'),
  (503, 6, '{"50":"Deploying Autonomous AI Field Agents Without Cloud Lock-In","51":"Webinar","52":"In Review","53":[602],"54":"2026-11-29","55":"Devon Brooks","56":9200,"57":"linear-gradient(135deg,#0d9488,#2563eb)"}', 'Devon Brooks', '2026-11-09', '2026-11-21'),
  (504, 6, '{"50":"How Kestrel BioLabs Cut Tooling Spend by 81%","51":"Case Study","52":"Draft","53":[603],"54":"2026-12-04","55":"Samira Khan","56":6800,"57":"linear-gradient(135deg,#059669,#0ea5e9)"}', 'Samira Khan', '2026-11-14', '2026-11-20'),
  (505, 6, '{"50":"Zero-Code Formulas, Rollups & Gantt Cheat Sheet","51":"Social","52":"Scheduled","53":[601],"54":"2026-11-26","55":"Chloe Alvarez","56":31200,"57":"linear-gradient(135deg,#d97706,#ea580c)"}', 'Chloe Alvarez', '2026-11-16', '2026-11-21');

-- =========================================================================
-- SAVED VIEWS (Demonstrating all 7 Airtable View Types!)
-- =========================================================================
INSERT OR IGNORE INTO views_meta (id, table_id, name, view_type, config_json, position) VALUES
  (1, 1, 'All Initiatives (Grid)', 'grid', '{"rowHeight":"medium","groupBy":null,"filters":[],"sorts":[]}', 0),
  (2, 1, 'Status Board (Kanban)', 'kanban', '{"groupFieldId":2}', 1),
  (3, 1, 'Launch Timeline (Gantt)', 'timeline', '{"startFieldId":12,"endFieldId":13,"statusFieldId":2}', 2),
  (4, 1, 'Release Calendar', 'calendar', '{"dateFieldId":13,"statusFieldId":2}', 3),
  (5, 1, 'Initiative Gallery', 'gallery', '{"statusFieldId":2}', 4),
  (6, 1, 'Compact Checklist (List)', 'list', '{"groupFieldId":2,"checkFieldId":15}', 5),
  (7, 1, 'Review Inbox', 'inbox', '{"statusFieldId":2}', 6),
  (8, 2, 'All Feature Specs', 'grid', '{"rowHeight":"compact"}', 0),
  (9, 2, 'Engineering Kanban', 'kanban', '{"groupFieldId":171}', 1),
  (10, 3, 'Product & Eng Teams', 'grid', '{"rowHeight":"medium"}', 0),
  (11, 4, 'Pipeline Radar Grid', 'grid', '{"rowHeight":"medium"}', 0),
  (12, 4, 'Accounts by Funding Stage', 'kanban', '{"groupFieldId":32}', 1),
  (13, 4, 'Account Cards Gallery', 'gallery', '{"statusFieldId":31}', 2),
  (14, 5, 'Opportunities Grid', 'grid', '{"rowHeight":"medium"}', 0),
  (15, 5, 'Deal Stage Board', 'kanban', '{"groupFieldId":43}', 1),
  (16, 6, 'Editorial Calendar', 'calendar', '{"dateFieldId":54,"statusFieldId":52}', 0),
  (17, 6, 'Asset Gallery', 'gallery', '{"statusFieldId":52,"coverFieldId":57}', 1),
  (18, 6, 'Content Grid', 'grid', '{"rowHeight":"medium"}', 2),
  (19, 6, 'Editorial Kanban', 'kanban', '{"groupFieldId":52}', 3),
  (20, 7, 'Campaigns Overview', 'grid', '{"rowHeight":"medium"}', 0);

-- =========================================================================
-- COMMENTS & REVISION HISTORY
-- =========================================================================
INSERT OR IGNORE INTO record_comments (id, record_id, author, body, created_at) VALUES
  (1, 2, 'Devon Brooks', 'Batch AI Field Agent benchmark hit 40 rows/sec inside ZIPP PHP WASM with zero external API keys.', '2026-11-19 11:20'),
  (2, 2, 'Maya Lin', 'Love it - let us enable the Paused-for-Review toggle by default before opening GA.', '2026-11-20 09:42'),
  (3, 6, 'Arjun Mehta', 'Waiting on IdP SCIM group mapping test from Vanguard security team.', '2026-11-20 16:15'),
  (4, 301, 'Jordan Patel', 'CTO loved the dual-mode PHP architecture - running locally in browser during workshops and on AWS PHP in prod.', '2026-11-20 14:30');

INSERT OR IGNORE INTO record_history (id, record_id, actor, field_name, old_value, new_value, created_at) VALUES
  (1, 1, 'Maya Lin', 'Status', 'Beta', 'Launched', '2026-11-18 17:05'),
  (2, 2, 'Devon Brooks', 'Status', 'In Progress', 'In Review', '2026-11-19 10:12'),
  (3, 2, 'Devon Brooks', 'Confidence %', '80', '88', '2026-11-20 08:30'),
  (4, 6, 'Arjun Mehta', 'Status', 'In Progress', 'At Risk', '2026-11-21 09:10');
