CREATE TABLE IF NOT EXISTS sales_docs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_type TEXT NOT NULL DEFAULT 'invoice',
  doc_number TEXT NOT NULL UNIQUE,
  customer_name TEXT NOT NULL,
  customer_abn TEXT NOT NULL DEFAULT '',
  issue_date TEXT NOT NULL,
  due_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Open',
  tax_mode TEXT NOT NULL DEFAULT 'exclusive',
  subtotal REAL NOT NULL DEFAULT 0,
  gst_amount REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  paid_amount REAL NOT NULL DEFAULT 0,
  online_pay_enabled INTEGER NOT NULL DEFAULT 1,
  reminder_count INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  lines_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS customer_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id INTEGER NOT NULL,
  doc_number TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  payment_date TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT 'EFT / OSKO',
  reference TEXT NOT NULL DEFAULT '',
  amount REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS customer_credits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  credit_number TEXT NOT NULL UNIQUE,
  customer_name TEXT NOT NULL,
  issue_date TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  subtotal REAL NOT NULL DEFAULT 0,
  gst_amount REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  applied_amount REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'Open',
  applied_doc_number TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS recurring_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  template_name TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  customer_abn TEXT NOT NULL DEFAULT '',
  frequency TEXT NOT NULL DEFAULT 'Monthly',
  next_run_date TEXT NOT NULL,
  subtotal REAL NOT NULL DEFAULT 0,
  gst_amount REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  lines_json TEXT NOT NULL DEFAULT '[]'
);

INSERT OR IGNORE INTO sales_docs
  (id, doc_type, doc_number, customer_name, customer_abn, issue_date, due_date, status, tax_mode, subtotal, gst_amount, total, paid_amount, online_pay_enabled, reminder_count, notes, lines_json)
VALUES
  (1, 'invoice', 'INV-000401', 'Southern Cross Coffee Roasters Pty Ltd', '51 824 753 556', '2026-11-01', '2026-11-15', 'Paid', 'exclusive', 14200.00, 1420.00, 15620.00, 15620.00, 1, 0, 'Thank you for your prompt EFT settlement.', '[{"description":"Cloud Commerce Platform Setup","qty":1,"unitPrice":9800,"taxCode":"GST"},{"description":"POS Hardware Integration & Training","qty":2,"unitPrice":2200,"taxCode":"GST"}]'),
  (2, 'invoice', 'INV-000402', 'Bayside Marine Engineering Pty Ltd', '33 051 775 556', '2026-11-08', '2026-11-22', 'Partial', 'exclusive', 18500.00, 1850.00, 20350.00, 10000.00, 1, 0, '50% progress deposit received via OSKO.', '[{"description":"Inventory Telemetry Rollout (Stage 2)","qty":1,"unitPrice":14500,"taxCode":"GST"},{"description":"On-site Brisbane Workshop (2 Days)","qty":2,"unitPrice":2000,"taxCode":"GST"}]'),
  (3, 'invoice', 'INV-000403', 'Kangaroo Valley Organics', '64 008 402 990', '2026-10-14', '2026-10-28', 'Overdue', 'exclusive', 6400.00, 420.00, 6820.00, 0.00, 1, 2, 'Automated reminder sent 10 Nov & 18 Nov.', '[{"description":"Wholesale Portal Configuration","qty":1,"unitPrice":4200,"taxCode":"GST"},{"description":"GST-Free Fresh Produce Compliance Guide","qty":1,"unitPrice":2200,"taxCode":"FRE"}]'),
  (4, 'invoice', 'INV-000404', 'Melbourne Dental Collective', '79 004 378 880', '2026-11-18', '2026-12-02', 'Open', 'exclusive', 8950.00, 895.00, 9845.00, 0.00, 1, 0, 'BPAY & Online Card Pay link enabled.', '[{"description":"Practice Ledger Migration & STP Setup","qty":1,"unitPrice":6450,"taxCode":"GST"},{"description":"Staff Payroll Onboarding (10 Staff)","qty":10,"unitPrice":250,"taxCode":"GST"}]'),
  (5, 'quote', 'QUO-000118', 'Barossa Estate Vineyards Pty Ltd', '88 007 671 845', '2026-11-16', '2026-12-16', 'Sent', 'exclusive', 24600.00, 2460.00, 27060.00, 0.00, 1, 0, 'Valid for 30 days. Includes multi-location cellar door inventory.', '[{"description":"Cellar Door Inventory & Batch Tracking","qty":1,"unitPrice":16800,"taxCode":"GST"},{"description":"AccountRight Migration & Data Audit","qty":1,"unitPrice":7800,"taxCode":"GST"}]'),
  (6, 'quote', 'QUO-000119', 'Perth Solar & Battery Co', '42 602 184 911', '2026-11-20', '2026-12-20', 'Accepted', 'exclusive', 11200.00, 1120.00, 12320.00, 0.00, 1, 0, 'Client accepted via email - ready to convert to Tax Invoice.', '[{"description":"Field Job Costing & Time Billing Pack","qty":1,"unitPrice":8200,"taxCode":"GST"},{"description":"Technicians Mobile Timesheet Training","qty":1,"unitPrice":3000,"taxCode":"GST"}]'),
  (7, 'order', 'SO-000084', 'Tasman Timber & Joinery', '29 099 441 720', '2026-11-19', '2026-12-05', 'Confirmed', 'exclusive', 13400.00, 1340.00, 14740.00, 0.00, 1, 0, 'Stock reserved at Sydney HQ warehouse awaiting dispatch.', '[{"description":"Rugged Barcode Scanner Bundle","qty":8,"unitPrice":925,"taxCode":"GST"},{"description":"Thermal Label Printers + Stock Labels","qty":4,"unitPrice":1500,"taxCode":"GST"}]');

INSERT OR IGNORE INTO customer_payments (id, doc_id, doc_number, customer_name, payment_date, method, reference, amount) VALUES
  (1, 1, 'INV-000401', 'Southern Cross Coffee Roasters Pty Ltd', '2026-11-12', 'EFT / OSKO', 'OSKO-448102', 15620.00),
  (2, 2, 'INV-000402', 'Bayside Marine Engineering Pty Ltd', '2026-11-14', 'BPAY', 'BPAY-992104', 10000.00);

INSERT OR IGNORE INTO customer_credits (id, credit_number, customer_name, issue_date, reason, subtotal, gst_amount, total, applied_amount, status, applied_doc_number) VALUES
  (1, 'CN-000021', 'Kangaroo Valley Organics', '2026-11-19', 'Service credit - delayed API sync on wholesale catalog', 600.00, 60.00, 660.00, 0.00, 'Open', ''),
  (2, 'CN-000020', 'Southern Cross Coffee Roasters Pty Ltd', '2026-10-29', 'Returned surplus barcode cradle', 350.00, 35.00, 385.00, 385.00, 'Applied', 'INV-000395');

INSERT OR IGNORE INTO recurring_templates (id, template_name, customer_name, customer_abn, frequency, next_run_date, subtotal, gst_amount, total, active, lines_json) VALUES
  (1, 'Monthly Managed Bookkeeping & Cloud Support', 'Southern Cross Coffee Roasters Pty Ltd', '51 824 753 556', 'Monthly', '2026-12-01', 1850.00, 185.00, 2035.00, 1, '[{"description":"Monthly Managed Cloud & Advisory Retainer","qty":1,"unitPrice":1850,"taxCode":"GST"}]'),
  (2, 'Quarterly BAS Review & Payroll Audit', 'Melbourne Dental Collective', '79 004 378 880', 'Quarterly', '2027-01-01', 1200.00, 120.00, 1320.00, 1, '[{"description":"Quarterly BAS Preparation & STP Audit","qty":1,"unitPrice":1200,"taxCode":"GST"}]'),
  (3, 'Monthly Support SLA - Marine Telemetry', 'Bayside Marine Engineering Pty Ltd', '33 051 775 556', 'Monthly', '2026-12-01', 950.00, 95.00, 1045.00, 1, '[{"description":"Managed Hosting & Priority Support SLA","qty":1,"unitPrice":950,"taxCode":"GST"}]');
