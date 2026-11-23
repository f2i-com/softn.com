CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  client_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'Active',
  budget_hours REAL NOT NULL DEFAULT 80,
  hourly_rate REAL NOT NULL DEFAULT 165,
  cost_rate REAL NOT NULL DEFAULT 75,
  due_date TEXT NOT NULL DEFAULT '',
  lead_name TEXT NOT NULL DEFAULT 'Alex Rivera'
);

CREATE TABLE IF NOT EXISTS milestones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  target_date TEXT NOT NULL,
  bill_amount REAL NOT NULL DEFAULT 0,
  reached INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT 'Backlog',
  priority TEXT NOT NULL DEFAULT 'Medium',
  assignee TEXT NOT NULL DEFAULT 'Alex Rivera',
  estimate_hours REAL NOT NULL DEFAULT 4,
  logged_hours REAL NOT NULL DEFAULT 0,
  due_date TEXT NOT NULL DEFAULT '',
  subtasks_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS timesheets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  task_id INTEGER NOT NULL,
  employee_name TEXT NOT NULL,
  work_date TEXT NOT NULL,
  hours REAL NOT NULL,
  billable INTEGER NOT NULL DEFAULT 1,
  note TEXT NOT NULL DEFAULT ''
);

INSERT OR IGNORE INTO projects (id, name, client_name, status, budget_hours, hourly_rate, cost_rate, due_date, lead_name) VALUES
  (1, 'Harbour Logistics Warehouse Rollout', 'Harbour Logistics Pty', 'Active', 120, 185, 82, '2026-12-18', 'Alex Rivera'),
  (2, 'Northstar Offline POS Deployment', 'Northstar Retail Group', 'Active', 90, 175, 78, '2026-12-22', 'Jordan Patel'),
  (3, 'Brightleaf Wholesale Portal Launch', 'Brightleaf Roasters', 'Active', 45, 160, 72, '2026-11-30', 'Samira Khan');

INSERT OR IGNORE INTO milestones (id, project_id, title, target_date, bill_amount, reached) VALUES
  (1, 1, 'Phase 1: SKU Catalog & Bin Migration Sign-Off', '2026-11-15', 12000, 1),
  (2, 1, 'Phase 2: Standalone PHP Failover Go-Live', '2026-12-02', 18000, 0),
  (3, 2, 'Pilot Store Offline POS Certification (4 Stores)', '2026-11-28', 15000, 0),
  (4, 3, 'B2B Portal Live Launch & Team Handover', '2026-11-30', 9500, 1);

INSERT OR IGNORE INTO tasks (id, project_id, title, stage, priority, assignee, estimate_hours, logged_hours, due_date, subtasks_json) VALUES
  (1, 1, 'Import 4,200 warehouse SKUs into XDB SQLite', 'Done', 'High', 'Alex Rivera', 12, 11.5, '2026-11-12', '[{"text":"Clean CSV columns","done":true},{"text":"Validate barcode uniqueness","done":true}]'),
  (2, 1, 'Configure standalone PHP failover server', 'In Progress', 'Urgent', 'Jordan Patel', 16, 9.0, '2026-11-25', '[{"text":"Enable WAL SQLite mode","done":true},{"text":"Configure daily backup cron","done":false},{"text":"Load test 50 concurrent reps","done":false}]'),
  (3, 1, 'Train floor supervisors on PO receiving', 'Backlog', 'Medium', 'Samira Khan', 8, 0, '2026-12-04', '[{"text":"Prepare receiving cheat sheet","done":false}]'),
  (4, 2, 'Package React POS bundle as .softn container', 'Review', 'High', 'Jordan Patel', 14, 13.0, '2026-11-23', '[{"text":"Verify zipp-javascript-lite tier","done":true},{"text":"Test IndexedDB persistence offline","done":true}]'),
  (5, 2, 'Test thermal printer receipt layout', 'In Progress', 'Medium', 'Alex Rivera', 10, 4.5, '2026-11-27', '[{"text":"Align 80mm QR code footer","done":false}]'),
  (6, 3, 'Publish customer B2B pricing catalog', 'Done', 'High', 'Samira Khan', 10, 8.5, '2026-11-16', '[{"text":"Import wholesale tier discounts","done":true}]');

INSERT OR IGNORE INTO timesheets (id, project_id, task_id, employee_name, work_date, hours, billable, note) VALUES
  (1, 1, 1, 'Alex Rivera', '2026-11-11', 6.5, 1, 'Cleaned CSV barcode fields and validated schema import'),
  (2, 1, 1, 'Alex Rivera', '2026-11-12', 5.0, 1, 'Verified bin allocations across 4 depots'),
  (3, 1, 2, 'Jordan Patel', '2026-11-19', 9.0, 1, 'Configured WAL SQLite backups and nginx proxy'),
  (4, 2, 4, 'Jordan Patel', '2026-11-18', 7.5, 1, 'Compiled Vite React dist and verified offline IndexedDB persistence'),
  (5, 2, 5, 'Alex Rivera', '2026-11-20', 4.5, 1, 'Tested 80mm thermal printer output');
