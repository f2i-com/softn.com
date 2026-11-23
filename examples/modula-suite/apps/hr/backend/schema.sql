CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  role_title TEXT NOT NULL,
  department TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT 'Sydney',
  manager_name TEXT NOT NULL DEFAULT 'Executive',
  employment_type TEXT NOT NULL DEFAULT 'Full-Time',
  base_salary REAL NOT NULL DEFAULT 95000,
  status TEXT NOT NULL DEFAULT 'Active',
  leave_balance REAL NOT NULL DEFAULT 20,
  start_date TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS leave_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL,
  employee_name TEXT NOT NULL,
  leave_type TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  days REAL NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'Pending'
);

CREATE TABLE IF NOT EXISTS candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  role_applied TEXT NOT NULL,
  department TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  stage TEXT NOT NULL DEFAULT 'Applied',
  rating INTEGER NOT NULL DEFAULT 3,
  notes TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS attendances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL,
  employee_name TEXT NOT NULL,
  work_date TEXT NOT NULL,
  check_in TEXT NOT NULL,
  check_out TEXT NOT NULL DEFAULT '',
  worked_hours REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'Checked In'
);

CREATE TABLE IF NOT EXISTS appraisals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL,
  employee_name TEXT NOT NULL,
  cycle TEXT NOT NULL DEFAULT '2026 Q4',
  goals TEXT NOT NULL,
  self_rating INTEGER NOT NULL DEFAULT 4,
  manager_rating INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'Scheduled',
  review_date TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payslips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slip_number TEXT NOT NULL UNIQUE,
  employee_id INTEGER NOT NULL,
  employee_name TEXT NOT NULL,
  pay_period TEXT NOT NULL,
  gross_pay REAL NOT NULL,
  tax_withheld REAL NOT NULL,
  super_contrib REAL NOT NULL,
  net_pay REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'Draft',
  created_at TEXT NOT NULL
);

INSERT OR IGNORE INTO employees (id, name, role_title, department, email, location, manager_name, employment_type, base_salary, status, leave_balance, start_date) VALUES
  (1, 'Alex Rivera', 'Solutions Architect', 'Engineering', 'alex@modula.example', 'Sydney', 'CTO', 'Full-Time', 148000, 'Active', 18.5, '2024-03-11'),
  (2, 'Jordan Patel', 'Staff Systems Engineer', 'Engineering', 'jordan@modula.example', 'Melbourne', 'Alex Rivera', 'Full-Time', 156000, 'Active', 14.0, '2024-06-03'),
  (3, 'Samira Khan', 'Customer Success Lead', 'Operations', 'samira@modula.example', 'Brisbane', 'COO', 'Full-Time', 118000, 'Active', 21.0, '2025-01-20'),
  (4, 'Toby Mercer', 'Account Executive', 'Sales', 'toby@modula.example', 'Sydney', 'VP Sales', 'Full-Time', 110000, 'On Leave', 11.5, '2025-04-07'),
  (5, 'Elena Novak', 'Finance Controller', 'Finance', 'elena@modula.example', 'Melbourne', 'CFO', 'Full-Time', 136000, 'Active', 16.0, '2024-09-16');

INSERT OR IGNORE INTO leave_requests (id, employee_id, employee_name, leave_type, start_date, end_date, days, reason, status) VALUES
  (1, 1, 'Alex Rivera', 'Annual Leave', '2026-12-21', '2026-12-24', 4, 'Holiday travel with family', 'Pending'),
  (2, 2, 'Jordan Patel', 'Personal', '2026-11-27', '2026-11-27', 1, 'Home installation appointment', 'Pending'),
  (3, 4, 'Toby Mercer', 'Annual Leave', '2026-11-18', '2026-11-22', 3, 'Coastal hiking trip', 'Approved');

INSERT OR IGNORE INTO candidates (id, name, role_applied, department, email, stage, rating, notes) VALUES
  (1, 'Maya Chen', 'Senior React & WASM Engineer', 'Engineering', 'maya.chen@example.com', 'Offer', 5, 'Outstanding architecture interview; ready for offer.'),
  (2, 'Daniel Okafor', 'PHP Backend Specialist', 'Engineering', 'd.okafor@example.com', 'Interview', 4, 'Strong PDO/SQLite optimization experience.'),
  (3, 'Sophie Laurent', 'ERP Implementation Consultant', 'Operations', 'slaurent@example.com', 'Screening', 4, 'Previously deployed Odoo & NetSuite for 12 SMBs.'),
  (4, 'Benji Sato', 'Support Engineer', 'Operations', 'benji@example.com', 'Applied', 3, 'Great customer empathy and SQL troubleshooting.');

INSERT OR IGNORE INTO attendances (id, employee_id, employee_name, work_date, check_in, check_out, worked_hours, status) VALUES
  (1, 1, 'Alex Rivera', '2026-11-21', '08:52', '', 0, 'Checked In'),
  (2, 2, 'Jordan Patel', '2026-11-21', '09:05', '', 0, 'Checked In'),
  (3, 3, 'Samira Khan', '2026-11-20', '08:40', '17:15', 8.6, 'Completed'),
  (4, 5, 'Elena Novak', '2026-11-20', '09:00', '17:30', 8.5, 'Completed');

INSERT OR IGNORE INTO appraisals (id, employee_id, employee_name, cycle, goals, self_rating, manager_rating, status, review_date) VALUES
  (1, 1, 'Alex Rivera', '2026 Q4', 'Deliver dual-mode PHP + ZIPP WASM ERP architecture & mentor 2 engineers', 5, 5, 'Completed', '2026-11-15'),
  (2, 2, 'Jordan Patel', '2026 Q4', 'Ship XDB SQLite WAL persistence & zero-downtime standalone PHP deployment', 5, 4, 'In Review', '2026-11-26'),
  (3, 3, 'Samira Khan', '2026 Q4', 'Maintain >96% CSAT and publish 15 customer migration runbooks', 4, 0, 'Scheduled', '2026-12-03');

INSERT OR IGNORE INTO payslips (id, slip_number, employee_id, employee_name, pay_period, gross_pay, tax_withheld, super_contrib, net_pay, status, created_at) VALUES
  (1, 'PAY-2026-10-001', 1, 'Alex Rivera', '2026-10', 12333.33, 2713.33, 1418.33, 9620.00, 'Paid', '2026-10-31'),
  (2, 'PAY-2026-10-002', 2, 'Jordan Patel', '2026-10', 13000.00, 2860.00, 1495.00, 10140.00, 'Paid', '2026-10-31'),
  (3, 'PAY-2026-10-003', 3, 'Samira Khan', '2026-10', 9833.33, 2163.33, 1130.83, 7670.00, 'Paid', '2026-10-31');
