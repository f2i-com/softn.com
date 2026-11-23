CREATE TABLE IF NOT EXISTS ledger_summary (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  section TEXT NOT NULL,
  accrual_amount REAL NOT NULL DEFAULT 0,
  cash_amount REAL NOT NULL DEFAULT 0,
  prior_amount REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS monthly_cashflow (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  month_label TEXT NOT NULL,
  revenue REAL NOT NULL,
  expenses REAL NOT NULL,
  operating_cash REAL NOT NULL,
  investing_cash REAL NOT NULL,
  financing_cash REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS aged_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  side TEXT NOT NULL,
  party_name TEXT NOT NULL,
  current_amt REAL NOT NULL DEFAULT 0,
  days_1_30 REAL NOT NULL DEFAULT 0,
  days_31_60 REAL NOT NULL DEFAULT 0,
  days_60_plus REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS fx_positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  currency TEXT NOT NULL UNIQUE,
  account_label TEXT NOT NULL,
  foreign_balance REAL NOT NULL,
  booked_rate REAL NOT NULL,
  current_rate REAL NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS saved_packs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pack_name TEXT NOT NULL,
  basis TEXT NOT NULL DEFAULT 'Accrual',
  period_label TEXT NOT NULL DEFAULT 'FY2026-27 YTD',
  includes TEXT NOT NULL,
  created_at TEXT NOT NULL
);

INSERT OR IGNORE INTO ledger_summary (id, code, name, section, accrual_amount, cash_amount, prior_amount) VALUES
  (1, '4-1100', 'Product & Platform Sales', 'Income', 148200.00, 132600.00, 121400.00),
  (2, '4-1200', 'Consulting & Implementation', 'Income', 58600.00, 49100.00, 46200.00),
  (3, '4-2100', 'Export Advisory Services (GST-Free)', 'Income', 14500.00, 14500.00, 9800.00),
  (4, '8-1100', 'Bank Interest Income', 'Income', 340.00, 340.00, 210.00),
  (5, '5-1100', 'Hardware & Inventory COGS', 'COGS', 24800.00, 22900.00, 21200.00),
  (6, '6-1200', 'Cloud Hosting & Software', 'Expense', 9840.00, 9840.00, 8150.00),
  (7, '6-1400', 'Office Supplies & Printing', 'Expense', 2410.00, 2100.00, 1980.00),
  (8, '6-1600', 'Telephone & Internet', 'Expense', 1890.00, 1400.00, 1740.00),
  (9, '6-1800', 'Office Rent & Outgoings', 'Expense', 17400.00, 11020.00, 16800.00),
  (10, '6-2400', 'Travel & Accommodation', 'Expense', 4220.00, 3538.00, 3100.00),
  (11, '6-3100', 'Wages & Salaries (W1)', 'Expense', 48500.00, 48500.00, 42900.00),
  (12, '6-3200', 'Superannuation Expense (12% SG)', 'Expense', 5820.00, 3466.00, 4933.50),
  (13, '1-1100', 'CommBank Business Everyday', 'Asset', 164820.50, 164820.50, 128400.00),
  (14, '1-1120', 'NAB Business Cash Maximiser', 'Asset', 88450.00, 88450.00, 74200.00),
  (15, '1-1200', 'Trade Debtors (Accounts Receivable)', 'Asset', 27015.00, 0.00, 19800.00),
  (16, '1-2100', 'Inventory On Hand', 'Asset', 44280.00, 44280.00, 38100.00),
  (17, '1-3200', 'Computer & Office Equipment', 'Asset', 28400.00, 28400.00, 21600.00),
  (18, '2-1100', 'Trade Creditors (Accounts Payable)', 'Liability', 10900.00, 0.00, 8400.00),
  (19, '2-1200', 'ANZ Business Rewards Visa', 'Liability', 4182.40, 4182.40, 2940.00),
  (20, '2-1300', 'Net GST Payable (1A - 1B)', 'Liability', 11580.00, 9420.00, 9120.00),
  (21, '2-1400', 'PAYG Withholding Payable (W2)', 'Liability', 11420.00, 11420.00, 9850.00),
  (22, '2-1500', 'Superannuation Payable (12% SG)', 'Liability', 5280.00, 5280.00, 4420.00),
  (23, '3-1100', 'Issued Share Capital', 'Equity', 50000.00, 50000.00, 50000.00),
  (24, '3-8000', 'Retained Earnings (Prior Periods)', 'Equity', 152843.10, 152843.10, 118573.50);

INSERT OR IGNORE INTO monthly_cashflow (id, month_label, revenue, expenses, operating_cash, investing_cash, financing_cash) VALUES
  (1, 'Jul 26', 38400, 21200, 16800, -1400, 0),
  (2, 'Aug 26', 42900, 22800, 19400, -2200, 0),
  (3, 'Sep 26', 45100, 23900, 21100, -900, -3000),
  (4, 'Oct 26', 46800, 24100, 22450, -3520, 0),
  (5, 'Nov 26', 48440, 22880, 25120, -1800, 0);

INSERT OR IGNORE INTO aged_items (id, side, party_name, current_amt, days_1_30, days_31_60, days_60_plus) VALUES
  (1, 'receivable', 'Bayside Marine Engineering Pty Ltd', 10350.00, 0.00, 0.00, 0.00),
  (2, 'receivable', 'Melbourne Dental Collective', 9845.00, 0.00, 0.00, 0.00),
  (3, 'receivable', 'Kangaroo Valley Organics', 0.00, 6820.00, 0.00, 0.00),
  (4, 'payable', 'Sydney CBD Commercial Property Trust', 0.00, 6380.00, 0.00, 0.00),
  (5, 'payable', 'JB Hi-Fi Business', 3520.00, 0.00, 0.00, 0.00),
  (6, 'payable', 'Australia Post Business', 1000.00, 0.00, 0.00, 0.00);

INSERT OR IGNORE INTO fx_positions (id, currency, account_label, foreign_balance, booked_rate, current_rate, updated_at) VALUES
  (1, 'USD', 'US SaaS Export Receivables (USD)', 18500.00, 1.5200, 1.5450, '2026-11-22'),
  (2, 'NZD', 'Auckland Partner Account (NZD)', 14200.00, 0.9150, 0.9080, '2026-11-22'),
  (3, 'GBP', 'UK Advisory Retainer (GBP)', 6400.00, 1.9400, 1.9720, '2026-11-22'),
  (4, 'SGD', 'Singapore Cloud Settlement (SGD)', 9800.00, 1.1350, 1.1490, '2026-11-22');

INSERT OR IGNORE INTO saved_packs (id, pack_name, basis, period_label, includes, created_at) VALUES
  (1, 'Board Monthly Financial Pack', 'Accrual', 'FY2026-27 YTD', 'Profit & Loss, Balance Sheet, Cash Flow, Aged AR/AP', '2026-11-05'),
  (2, 'ATO Tax Agent Quarterly Pack', 'Accrual', 'Q1 FY2026-27', 'Trial Balance, P&L, Balance Sheet, FX Revaluation', '2026-10-20');
