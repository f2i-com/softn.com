CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  balance REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_number TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'customer',
  party_name TEXT NOT NULL,
  issue_date TEXT NOT NULL,
  due_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Draft',
  subtotal REAL NOT NULL DEFAULT 0,
  tax_amount REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  paid_amount REAL NOT NULL DEFAULT 0,
  lines_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_name TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  amount REAL NOT NULL,
  expense_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Submitted'
);

CREATE TABLE IF NOT EXISTS bank_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tx_date TEXT NOT NULL,
  bank_ref TEXT NOT NULL,
  counterparty TEXT NOT NULL,
  memo TEXT NOT NULL DEFAULT '',
  amount REAL NOT NULL,
  reconciled INTEGER NOT NULL DEFAULT 0,
  matched_invoice_id INTEGER
);

CREATE TABLE IF NOT EXISTS journal_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_date TEXT NOT NULL,
  reference TEXT NOT NULL,
  account_code TEXT NOT NULL,
  account_name TEXT NOT NULL,
  debit REAL NOT NULL DEFAULT 0,
  credit REAL NOT NULL DEFAULT 0,
  memo TEXT NOT NULL DEFAULT ''
);

INSERT OR IGNORE INTO accounts (id, code, name, kind, balance) VALUES
  (1, '1000', 'Operating Bank Account', 'Asset', 148420.00),
  (2, '1200', 'Accounts Receivable', 'Asset', 31400.00),
  (3, '2000', 'Accounts Payable', 'Liability', 9850.00),
  (4, '2100', 'GST / Sales Tax Payable', 'Liability', 4620.00),
  (5, '3000', 'Owner Equity', 'Equity', 14300.00),
  (6, '4000', 'Product & License Revenue', 'Revenue', 124600.00),
  (7, '4100', 'Implementation Services', 'Revenue', 41800.00),
  (8, '5000', 'Cloud & Hosting Costs', 'Expense', 6420.00),
  (9, '6100', 'Travel & Operations Expenses', 'Expense', 8930.00);

INSERT OR IGNORE INTO invoices (id, invoice_number, kind, party_name, issue_date, due_date, status, subtotal, tax_amount, total, paid_amount, lines_json) VALUES
  (1, 'INV-2026-101', 'customer', 'Brightleaf Roasters', '2026-11-01', '2026-11-15', 'Paid', 16818.18, 1681.82, 18500.00, 18500.00, '[{"description":"Modula Self-Hosted Suite Setup","qty":1,"unitPrice":9500},{"description":"Data Migration & Training","qty":1,"unitPrice":7318.18}]'),
  (2, 'INV-2026-102', 'customer', 'Harbour Logistics Pty', '2026-11-10', '2026-12-10', 'Partial', 22000.00, 2200.00, 24200.00, 10000.00, '[{"description":"Phase 1 Discovery & Sandbox Deployment","qty":1,"unitPrice":22000}]'),
  (3, 'INV-2026-103', 'customer', 'Northstar Retail Group', '2026-10-18', '2026-11-05', 'Overdue', 15636.36, 1563.64, 17200.00, 0.00, '[{"description":"POS Container Pilot (4 Stores)","qty":4,"unitPrice":3909.09}]'),
  (4, 'BILL-2026-041', 'vendor', 'Pacific Cloud Fibre', '2026-11-04', '2026-11-28', 'Sent', 4200.00, 420.00, 4620.00, 0.00, '[{"description":"Dedicated Bare-Metal Cluster","qty":1,"unitPrice":4200}]'),
  (5, 'BILL-2026-042', 'vendor', 'Apex Hardware Imports', '2026-11-12', '2026-12-12', 'Sent', 4754.55, 475.45, 5230.00, 0.00, '[{"description":"Barcode Scanners & Receipt Printers","qty":10,"unitPrice":475.455}]');

INSERT OR IGNORE INTO expenses (id, employee_name, category, description, amount, expense_date, status) VALUES
  (1, 'Alex Rivera', 'Travel', 'Client workshop flights (Sydney -> Melbourne)', 640.00, '2026-11-14', 'Submitted'),
  (2, 'Jordan Patel', 'Hardware', 'USB-C Barcode scanner test kit', 285.50, '2026-11-16', 'Approved'),
  (3, 'Samira Khan', 'Software', 'SSL wildcard certificate renewal', 199.00, '2026-11-08', 'Reimbursed');

INSERT OR IGNORE INTO bank_transactions (id, tx_date, bank_ref, counterparty, memo, amount, reconciled, matched_invoice_id) VALUES
  (1, '2026-11-20', 'EFT-99412', 'Harbour Logistics Pty', 'Balance settlement INV-2026-102', 14200.00, 0, NULL),
  (2, '2026-11-20', 'EFT-99418', 'Northstar Retail Group', 'Pilot invoice remittance', 17200.00, 0, NULL),
  (3, '2026-11-19', 'BPAY-4410', 'Pacific Cloud Fibre', 'Cluster hosting November', -4620.00, 0, NULL),
  (4, '2026-11-09', 'EFT-98102', 'Brightleaf Roasters', 'Invoice 101 full payment', 18500.00, 1, 1);

INSERT OR IGNORE INTO journal_entries (id, entry_date, reference, account_code, account_name, debit, credit, memo) VALUES
  (1, '2026-11-01', 'INV-2026-101', '1200', 'Accounts Receivable', 18500.00, 0.00, 'Invoice issued to Brightleaf Roasters'),
  (2, '2026-11-01', 'INV-2026-101', '4000', 'Product & License Revenue', 0.00, 16818.18, 'Invoice revenue recognition'),
  (3, '2026-11-01', 'INV-2026-101', '2100', 'GST / Sales Tax Payable', 0.00, 1681.82, 'Output tax collected'),
  (4, '2026-11-09', 'PAY-2026-101', '1000', 'Operating Bank Account', 18500.00, 0.00, 'Payment received - Brightleaf Roasters'),
  (5, '2026-11-09', 'PAY-2026-101', '1200', 'Accounts Receivable', 0.00, 18500.00, 'Receivable settled');
