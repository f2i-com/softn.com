CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  company TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  role_title TEXT NOT NULL DEFAULT '',
  tag TEXT NOT NULL DEFAULT 'Prospect',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS crm_leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  company TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'Website',
  est_budget REAL NOT NULL DEFAULT 15000,
  team_size INTEGER NOT NULL DEFAULT 15,
  score INTEGER NOT NULL DEFAULT 50,
  status TEXT NOT NULL DEFAULT 'Open',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  company TEXT NOT NULL DEFAULT '',
  contact_name TEXT NOT NULL DEFAULT '',
  contact_email TEXT NOT NULL DEFAULT '',
  stage TEXT NOT NULL DEFAULT 'New',
  expected_revenue REAL NOT NULL DEFAULT 0,
  probability INTEGER NOT NULL DEFAULT 25,
  priority INTEGER NOT NULL DEFAULT 2,
  owner_name TEXT NOT NULL DEFAULT 'Alex Rivera',
  close_date TEXT NOT NULL DEFAULT '',
  lost_reason TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quote_number TEXT NOT NULL UNIQUE,
  deal_id INTEGER,
  customer_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Draft',
  subtotal REAL NOT NULL DEFAULT 0,
  tax_rate REAL NOT NULL DEFAULT 10,
  total REAL NOT NULL DEFAULT 0,
  valid_until TEXT NOT NULL DEFAULT '',
  items_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sub_number TEXT NOT NULL UNIQUE,
  customer_name TEXT NOT NULL,
  plan_name TEXT NOT NULL,
  billing_cycle TEXT NOT NULL DEFAULT 'Monthly',
  mrr REAL NOT NULL DEFAULT 0,
  seats INTEGER NOT NULL DEFAULT 10,
  status TEXT NOT NULL DEFAULT 'Active',
  next_billing_date TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS activities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deal_id INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'Note',
  author TEXT NOT NULL DEFAULT 'Alex Rivera',
  summary TEXT NOT NULL,
  due_date TEXT NOT NULL DEFAULT '',
  done INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

INSERT OR IGNORE INTO contacts (id, name, company, email, phone, role_title, tag, created_at) VALUES
  (1, 'Claire Bennett', 'Harbour Logistics Pty', 'claire@harbourlogistics.example', '+61 2 9012 4410', 'Operations Director', 'Enterprise', '2026-10-18'),
  (2, 'Marcus Vance', 'Northstar Retail Group', 'mvance@northstar.example', '+61 3 8821 1904', 'Head of Digital', 'Customer', '2026-10-21'),
  (3, 'Priya Nair', 'Kestrel Manufacturing', 'priya@kestrelmfg.example', '+61 7 3100 7782', 'VP Supply Chain', 'Enterprise', '2026-10-29'),
  (4, 'Liam O''Connor', 'Brightleaf Roasters', 'liam@brightleaf.example', '+61 2 8411 2290', 'Founder', 'SMB', '2026-11-02'),
  (5, 'Hannah Cho', 'Solstice Health Clinics', 'hcho@solsticehealth.example', '+61 3 9001 5531', 'Practice Manager', 'Partner', '2026-11-08');

INSERT OR IGNORE INTO crm_leads (id, name, company, email, phone, source, est_budget, team_size, score, status, notes, created_at) VALUES
  (1, 'Rory Gallagher', 'Pacific Cold Storage', 'rory@pacificcold.example', '+61 2 8001 4412', 'Website', 48000, 45, 88, 'Open', 'Migrating off 45-seat Odoo Custom plan; wants standalone PHP on local VPC.', '2026-11-18'),
  (2, 'Mei-Ling Zhou', 'Aurora Architectural Studio', 'mei@aurorastudio.example', '+61 3 9112 3300', 'Referral', 22000, 18, 74, 'Open', 'Needs Projects, Timesheets & Invoicing containers embedded in client portal.', '2026-11-19'),
  (3, 'Kieran Walsh', 'Redgum Timber & Hardware', 'kieran@redgum.example', '+61 8 6200 1190', 'Trade Show', 35000, 32, 81, 'Open', 'Interested in Inventory BoMs, barcode receiving and POS.', '2026-11-20');

INSERT OR IGNORE INTO deals (id, title, company, contact_name, contact_email, stage, expected_revenue, probability, priority, owner_name, close_date, lost_reason, notes, created_at) VALUES
  (1, 'Multi-Warehouse ERP Rollout', 'Harbour Logistics Pty', 'Claire Bennett', 'claire@harbourlogistics.example', 'Negotiation', 68000, 80, 3, 'Alex Rivera', '2026-12-05', '', 'Replacing legacy spreadsheet tracking across 4 coastal depots.', '2026-10-19'),
  (2, 'POS & Inventory Unification (14 Stores)', 'Northstar Retail Group', 'Marcus Vance', 'mvance@northstar.example', 'Proposition', 42500, 60, 3, 'Jordan Patel', '2026-12-14', '', 'Wants offline-first SoftN containers at store registers.', '2026-10-24'),
  (3, 'Automated Procurement & Quality Pack', 'Kestrel Manufacturing', 'Priya Nair', 'priya@kestrelmfg.example', 'Qualified', 54000, 45, 2, 'Alex Rivera', '2026-12-28', '', 'Demo scheduled with plant managers next Tuesday.', '2026-11-01'),
  (4, 'Wholesale B2B Portal + Invoicing', 'Brightleaf Roasters', 'Liam O''Connor', 'liam@brightleaf.example', 'Won', 18500, 100, 2, 'Samira Khan', '2026-11-12', '', 'Signed annual self-hosted license. Kickoff completed.', '2026-10-12'),
  (5, 'Clinic HR, Scheduling & Helpdesk Suite', 'Solstice Health Clinics', 'Hannah Cho', 'hcho@solsticehealth.example', 'New', 29000, 20, 1, 'Jordan Patel', '2027-01-15', '', 'Inbound demo request comparing against Odoo Custom plan.', '2026-11-16'),
  (6, 'Fleet Maintenance & Field Dispatch', 'Tasman Civil Services', 'Owen Gallagher', 'owen@tasmancivil.example', 'Qualified', 36000, 40, 2, 'Samira Khan', '2026-12-20', '', 'Evaluating standalone PHP hosting on internal VPC.', '2026-11-10'),
  (7, 'Legacy Accounting Migration', 'Outback Freight Ltd', 'Derek Shaw', 'dshaw@outbackfreight.example', 'Lost', 24000, 0, 1, 'Toby Mercer', '2026-11-05', 'Timing / Delayed', 'Deferred ERP migration to Q3 next financial year.', '2026-10-02');

INSERT OR IGNORE INTO quotes (id, quote_number, deal_id, customer_name, status, subtotal, tax_rate, total, valid_until, items_json, created_at) VALUES
  (1, 'SO-2026-001', 4, 'Brightleaf Roasters', 'Accepted', 16818.18, 10, 18500.00, '2026-11-30', '[{"description":"Modula Self-Hosted Suite Setup","qty":1,"unitPrice":9500},{"description":"Data Migration & Staff Training","qty":1,"unitPrice":7318.18}]', '2026-11-04'),
  (2, 'SO-2026-002', 1, 'Harbour Logistics Pty', 'Sent', 61818.18, 10, 68000.00, '2026-12-15', '[{"description":"Warehouse + Inventory Container Pack","qty":4,"unitPrice":11500},{"description":"Custom PHP ERP Integration","qty":1,"unitPrice":15818.18}]', '2026-11-14'),
  (3, 'SO-2026-003', 2, 'Northstar Retail Group', 'Draft', 38636.36, 10, 42500.00, '2026-12-20', '[{"description":"Retail POS & Stock Sync Rollout (14 Sites)","qty":14,"unitPrice":2400},{"description":"Dedicated Support Onboarding","qty":1,"unitPrice":5036.36}]', '2026-11-18');

INSERT OR IGNORE INTO subscriptions (id, sub_number, customer_name, plan_name, billing_cycle, mrr, seats, status, next_billing_date, created_at) VALUES
  (1, 'SUB-2026-01', 'Brightleaf Roasters', 'Enterprise Support & Updates', 'Annual', 490.00, 22, 'Active', '2027-11-01', '2026-11-01'),
  (2, 'SUB-2026-02', 'Northstar Retail Group', 'Managed PHP Cloud Hosting', 'Monthly', 850.00, 48, 'Active', '2026-12-15', '2026-09-15'),
  (3, 'SUB-2026-03', 'Solstice Health Clinics', 'HIPAA / Compliance Pack Add-on', 'Monthly', 320.00, 16, 'Paused', '2026-12-20', '2026-08-20');

INSERT OR IGNORE INTO activities (id, deal_id, kind, author, summary, due_date, done, created_at) VALUES
  (1, 1, 'Meeting', 'Alex Rivera', 'Reviewed ZIPP WASM offline failover and standalone PHP deployment with IT team.', '2026-11-15', 1, '2026-11-15 10:30'),
  (2, 1, 'Call', 'Alex Rivera', 'Follow up with Legal on SLA appendix and final sign-off.', '2026-11-24', 0, '2026-11-19 14:15'),
  (3, 2, 'Email', 'Jordan Patel', 'Sent ROI comparison showing 74% savings vs per-seat Odoo Enterprise pricing.', '2026-11-17', 1, '2026-11-17 09:45'),
  (4, 3, 'Demo', 'Alex Rivera', 'Run live MRP BoM & barcode receiving walkthrough for plant managers.', '2026-11-26', 0, '2026-11-18 16:05');
