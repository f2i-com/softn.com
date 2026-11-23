CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  emp_code TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  role_title TEXT NOT NULL,
  employment_type TEXT NOT NULL DEFAULT 'Full-Time',
  stp_income_type TEXT NOT NULL DEFAULT 'SAW',
  pay_basis TEXT NOT NULL DEFAULT 'Salary',
  pay_rate REAL NOT NULL DEFAULT 95000,
  pay_frequency TEXT NOT NULL DEFAULT 'Fortnightly',
  tax_free_threshold INTEGER NOT NULL DEFAULT 1,
  has_help_debt INTEGER NOT NULL DEFAULT 0,
  super_fund TEXT NOT NULL DEFAULT 'AustralianSuper',
  super_usi TEXT NOT NULL DEFAULT 'STA0100AU',
  annual_leave_hrs REAL NOT NULL DEFAULT 76.0,
  personal_leave_hrs REAL NOT NULL DEFAULT 38.0,
  ytd_gross REAL NOT NULL DEFAULT 0,
  ytd_payg REAL NOT NULL DEFAULT 0,
  ytd_super REAL NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS pay_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_number TEXT NOT NULL UNIQUE,
  frequency TEXT NOT NULL DEFAULT 'Fortnightly',
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  payment_date TEXT NOT NULL,
  employee_count INTEGER NOT NULL DEFAULT 0,
  total_gross REAL NOT NULL DEFAULT 0,
  total_payg REAL NOT NULL DEFAULT 0,
  total_super REAL NOT NULL DEFAULT 0,
  total_net REAL NOT NULL DEFAULT 0,
  stp_status TEXT NOT NULL DEFAULT 'Pending ATO',
  stp_receipt TEXT NOT NULL DEFAULT '',
  super_status TEXT NOT NULL DEFAULT 'Unpaid',
  super_ref TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS payslips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pay_run_id INTEGER NOT NULL,
  run_number TEXT NOT NULL,
  employee_id INTEGER NOT NULL,
  employee_name TEXT NOT NULL,
  role_title TEXT NOT NULL,
  super_fund TEXT NOT NULL,
  super_usi TEXT NOT NULL,
  ordinary_hours REAL NOT NULL DEFAULT 76,
  overtime_hours REAL NOT NULL DEFAULT 0,
  ordinary_pay REAL NOT NULL DEFAULT 0,
  overtime_pay REAL NOT NULL DEFAULT 0,
  allowances REAL NOT NULL DEFAULT 0,
  gross_pay REAL NOT NULL DEFAULT 0,
  payg_tax REAL NOT NULL DEFAULT 0,
  super_amount REAL NOT NULL DEFAULT 0,
  net_pay REAL NOT NULL DEFAULT 0,
  annual_leave_bal REAL NOT NULL DEFAULT 0,
  personal_leave_bal REAL NOT NULL DEFAULT 0,
  payment_date TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS timesheets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL,
  employee_name TEXT NOT NULL,
  week_ending TEXT NOT NULL,
  ordinary_hours REAL NOT NULL DEFAULT 38,
  overtime_hours REAL NOT NULL DEFAULT 0,
  job_code TEXT NOT NULL DEFAULT 'INTERNAL',
  status TEXT NOT NULL DEFAULT 'Submitted'
);

CREATE TABLE IF NOT EXISTS leave_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL,
  employee_name TEXT NOT NULL,
  leave_type TEXT NOT NULL DEFAULT 'Annual Leave',
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  hours REAL NOT NULL DEFAULT 7.6,
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'Pending'
);

INSERT OR IGNORE INTO employees
  (id, emp_code, full_name, role_title, employment_type, stp_income_type, pay_basis, pay_rate, pay_frequency, tax_free_threshold, has_help_debt, super_fund, super_usi, annual_leave_hrs, personal_leave_hrs, ytd_gross, ytd_payg, ytd_super, active)
VALUES
  (1, 'EMP-001', 'Liam O''Connor', 'Lead Systems Architect', 'Full-Time', 'SAW', 'Salary', 142000.00, 'Fortnightly', 1, 0, 'AustralianSuper', 'STA0100AU', 112.4, 58.2, 54615.38, 13440.00, 6553.85, 1),
  (2, 'EMP-002', 'Chloe Nguyen', 'Senior Financial Controller', 'Full-Time', 'SAW', 'Salary', 124000.00, 'Fortnightly', 1, 1, 'Aware Super', 'FSP0001AU', 84.0, 44.6, 47692.31, 13260.00, 5723.08, 1),
  (3, 'EMP-003', 'Jack Henderson', 'Client Onboarding Specialist', 'Full-Time', 'SAW', 'Salary', 88000.00, 'Fortnightly', 1, 1, 'Hostplus Super', 'HOS0100AU', 62.5, 34.0, 33846.15, 7180.00, 4061.54, 1),
  (4, 'EMP-004', 'Priya Sharma', 'Product Designer', 'Part-Time', 'SAW', 'Hourly', 64.50, 'Fortnightly', 1, 0, 'REST Industry Super', 'RES0103AU', 48.2, 26.4, 24510.00, 3810.00, 2941.20, 1),
  (5, 'EMP-005', 'Toby Mitchell', 'Implementation Technician', 'Casual', 'SAW', 'Hourly', 52.00, 'Fortnightly', 1, 0, 'AustralianSuper', 'STA0100AU', 0.0, 0.0, 15600.00, 1980.00, 1872.00, 1);

INSERT OR IGNORE INTO pay_runs
  (id, run_number, frequency, period_start, period_end, payment_date, employee_count, total_gross, total_payg, total_super, total_net, stp_status, stp_receipt, super_status, super_ref)
VALUES
  (1, 'PR-2026-09', 'Fortnightly', '2026-10-19', '2026-11-01', '2026-11-02', 5, 19242.31, 4398.00, 2309.08, 14844.31, 'Accepted by ATO', 'ATO-STP2-20261102-4910', 'Paid', 'SBSCH-884120'),
  (2, 'PR-2026-10', 'Fortnightly', '2026-11-02', '2026-11-15', '2026-11-16', 5, 19618.31, 4512.00, 2354.20, 15106.31, 'Accepted by ATO', 'ATO-STP2-20261116-5104', 'Unpaid', '');

INSERT OR IGNORE INTO payslips
  (id, pay_run_id, run_number, employee_id, employee_name, role_title, super_fund, super_usi, ordinary_hours, overtime_hours, ordinary_pay, overtime_pay, allowances, gross_pay, payg_tax, super_amount, net_pay, annual_leave_bal, personal_leave_bal, payment_date)
VALUES
  (1, 2, 'PR-2026-10', 1, 'Liam O''Connor', 'Lead Systems Architect', 'AustralianSuper', 'STA0100AU', 76, 0, 5461.54, 0, 0, 5461.54, 1422.00, 655.38, 4039.54, 112.4, 58.2, '2026-11-16'),
  (2, 2, 'PR-2026-10', 2, 'Chloe Nguyen', 'Senior Financial Controller', 'Aware Super', 'FSP0001AU', 76, 0, 4769.23, 0, 0, 4769.23, 1348.00, 572.31, 3421.23, 84.0, 44.6, '2026-11-16'),
  (3, 2, 'PR-2026-10', 3, 'Jack Henderson', 'Client Onboarding Specialist', 'Hostplus Super', 'HOS0100AU', 76, 4, 3384.62, 267.20, 0, 3651.82, 812.00, 406.15, 2839.82, 62.5, 34.0, '2026-11-16'),
  (4, 2, 'PR-2026-10', 4, 'Priya Sharma', 'Product Designer', 'REST Industry Super', 'RES0103AU', 60, 0, 3870.00, 0, 0, 3870.00, 690.00, 464.40, 3180.00, 48.2, 26.4, '2026-11-16'),
  (5, 2, 'PR-2026-10', 5, 'Toby Mitchell', 'Implementation Technician', 'AustralianSuper', 'STA0100AU', 36, 0, 1872.00, 0, 0, 1872.00, 240.00, 224.64, 1632.00, 0.0, 0.0, '2026-11-16');

INSERT OR IGNORE INTO timesheets (id, employee_id, employee_name, week_ending, ordinary_hours, overtime_hours, job_code, status) VALUES
  (1, 4, 'Priya Sharma', '2026-11-22', 30.0, 0.0, 'JOB-102', 'Approved'),
  (2, 5, 'Toby Mitchell', '2026-11-22', 24.0, 3.5, 'JOB-101', 'Submitted'),
  (3, 3, 'Jack Henderson', '2026-11-22', 38.0, 2.0, 'JOB-103', 'Submitted');

INSERT OR IGNORE INTO leave_requests (id, employee_id, employee_name, leave_type, start_date, end_date, hours, reason, status) VALUES
  (1, 1, 'Liam O''Connor', 'Annual Leave', '2026-12-21', '2026-12-24', 30.4, 'Christmas family trip to Byron Bay', 'Pending'),
  (2, 3, 'Jack Henderson', 'Personal / Carer''s Leave', '2026-11-18', '2026-11-18', 7.6, 'Dental appointment & recovery', 'Approved');
