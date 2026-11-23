CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  classification TEXT NOT NULL,
  account_type TEXT NOT NULL,
  default_tax_code TEXT NOT NULL DEFAULT 'GST',
  balance REAL NOT NULL DEFAULT 0,
  is_system INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS journal_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  journal_number TEXT NOT NULL UNIQUE,
  entry_date TEXT NOT NULL,
  memo TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'General Journal',
  total_debit REAL NOT NULL DEFAULT 0,
  total_credit REAL NOT NULL DEFAULT 0,
  reversed INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS journal_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  journal_id INTEGER NOT NULL,
  account_code TEXT NOT NULL,
  account_name TEXT NOT NULL,
  tax_code TEXT NOT NULL DEFAULT 'N-T',
  debit REAL NOT NULL DEFAULT 0,
  credit REAL NOT NULL DEFAULT 0,
  line_memo TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS tax_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  period TEXT NOT NULL DEFAULT 'Q2 FY2026-27',
  tx_date TEXT NOT NULL,
  reference TEXT NOT NULL,
  direction TEXT NOT NULL,
  tax_code TEXT NOT NULL,
  account_code TEXT NOT NULL,
  gross_amount REAL NOT NULL,
  gst_amount REAL NOT NULL,
  anomaly_flag TEXT NOT NULL DEFAULT '',
  resolved INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS bas_lodgements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  period TEXT NOT NULL,
  date_range TEXT NOT NULL,
  g1_sales REAL NOT NULL,
  g2_exports REAL NOT NULL,
  g3_gst_free REAL NOT NULL,
  g10_capital REAL NOT NULL,
  g11_non_capital REAL NOT NULL,
  gst_1a REAL NOT NULL,
  gst_1b REAL NOT NULL,
  w1_wages REAL NOT NULL,
  w2_payg REAL NOT NULL,
  net_payable REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'Lodged',
  ato_receipt TEXT NOT NULL,
  lodged_at TEXT NOT NULL
);

INSERT OR IGNORE INTO accounts (id, code, name, classification, account_type, default_tax_code, balance, is_system) VALUES
  (1, '1-1100', 'CommBank Business Everyday', 'Asset', 'Bank', 'N-T', 164820.50, 1),
  (2, '1-1120', 'NAB Business Cash Maximiser', 'Asset', 'Bank', 'N-T', 88450.00, 1),
  (3, '1-1200', 'Trade Debtors (Accounts Receivable)', 'Asset', 'Accounts Receivable', 'N-T', 27015.00, 1),
  (4, '1-2100', 'Inventory On Hand', 'Asset', 'Other Current Asset', 'N-T', 44280.00, 1),
  (5, '1-3200', 'Computer & Office Equipment', 'Asset', 'Fixed Asset', 'CAP', 28400.00, 0),
  (6, '2-1100', 'Trade Creditors (Accounts Payable)', 'Liability', 'Accounts Payable', 'N-T', 10900.00, 1),
  (7, '2-1200', 'ANZ Business Rewards Visa', 'Liability', 'Credit Card', 'N-T', 4182.40, 1),
  (8, '2-1310', 'GST Collected (1A)', 'Liability', 'Other Current Liability', 'N-T', 18420.00, 1),
  (9, '2-1320', 'GST Paid (1B)', 'Liability', 'Other Current Liability', 'N-T', -6840.00, 1),
  (10, '2-1400', 'PAYG Withholding Payable (W2)', 'Liability', 'Other Current Liability', 'N-T', 11420.00, 1),
  (11, '2-1500', 'Superannuation Payable (12% SG)', 'Liability', 'Other Current Liability', 'N-T', 5280.00, 1),
  (12, '3-1100', 'Issued Share Capital', 'Equity', 'Equity', 'N-T', 50000.00, 1),
  (13, '3-8000', 'Retained Earnings', 'Equity', 'Equity', 'N-T', 152843.10, 1),
  (14, '4-1100', 'Product & Platform Sales', 'Income', 'Income', 'GST', 148200.00, 0),
  (15, '4-1200', 'Consulting & Implementation', 'Income', 'Income', 'GST', 58600.00, 0),
  (16, '4-2100', 'Export Advisory Services (GST-Free)', 'Income', 'Income', 'EXP', 14500.00, 0),
  (17, '5-1100', 'Hardware & Inventory COGS', 'Cost of Sales', 'Cost of Sales', 'GST', 24800.00, 0),
  (18, '6-1200', 'Cloud Hosting & Software', 'Expense', 'Expense', 'GST', 9840.00, 0),
  (19, '6-1400', 'Office Supplies & Printing', 'Expense', 'Expense', 'GST', 2410.00, 0),
  (20, '6-1600', 'Telephone & Internet', 'Expense', 'Expense', 'GST', 1890.00, 0),
  (21, '6-1800', 'Office Rent & Outgoings', 'Expense', 'Expense', 'GST', 17400.00, 0),
  (22, '6-2400', 'Travel & Accommodation', 'Expense', 'Expense', 'GST', 4220.00, 0),
  (23, '6-3100', 'Wages & Salaries (W1)', 'Expense', 'Expense', 'N-T', 48500.00, 0),
  (24, '6-3200', 'Superannuation Expense (12%)', 'Expense', 'Expense', 'N-T', 5820.00, 0),
  (25, '8-1100', 'Bank Interest Income', 'Other Income', 'Other Income', 'FRE', 340.00, 0);

INSERT OR IGNORE INTO journal_entries (id, journal_number, entry_date, memo, source, total_debit, total_credit, reversed) VALUES
  (1, 'GJ-000101', '2026-10-31', 'Monthly Depreciation - Computer Equipment', 'General Journal', 950.00, 950.00, 0),
  (2, 'GJ-000102', '2026-11-15', 'Fortnightly Payroll Accrual (W1 Wages + 12% SG + PAYG)', 'Payroll Sync', 27160.00, 27160.00, 0),
  (3, 'GJ-000103', '2026-11-18', 'Prepaid Annual Insurance Reclassification', 'General Journal', 2400.00, 2400.00, 0);

INSERT OR IGNORE INTO journal_lines (id, journal_id, account_code, account_name, tax_code, debit, credit, line_memo) VALUES
  (1, 1, '6-1400', 'Office Supplies & Printing', 'N-T', 950.00, 0.00, 'Oct depreciation expense'),
  (2, 1, '1-3200', 'Computer & Office Equipment', 'N-T', 0.00, 950.00, 'Accumulated depreciation'),
  (3, 2, '6-3100', 'Wages & Salaries (W1)', 'N-T', 24250.00, 0.00, 'Gross wages'),
  (4, 2, '6-3200', 'Superannuation Expense (12%)', 'N-T', 2910.00, 0.00, '12% SG contribution'),
  (5, 2, '2-1400', 'PAYG Withholding Payable (W2)', 'N-T', 0.00, 5710.00, 'ATO PAYG withheld'),
  (6, 2, '2-1500', 'Superannuation Payable (12% SG)', 'N-T', 0.00, 2910.00, 'Pay Super clearing'),
  (7, 2, '1-1100', 'CommBank Business Everyday', 'N-T', 0.00, 18540.00, 'Net employee EFT disbursement'),
  (8, 3, '6-1800', 'Office Rent & Outgoings', 'N-T', 2400.00, 0.00, 'Nov outgoings accrual'),
  (9, 3, '1-1100', 'CommBank Business Everyday', 'N-T', 0.00, 2400.00, 'Settlement');

INSERT OR IGNORE INTO tax_transactions (id, period, tx_date, reference, direction, tax_code, account_code, gross_amount, gst_amount, anomaly_flag, resolved) VALUES
  (1, 'Q2 FY2026-27', '2026-10-18', 'INV-000398', 'sale', 'GST', '4-1100', 46200.00, 4200.00, '', 1),
  (2, 'Q2 FY2026-27', '2026-11-01', 'INV-000401', 'sale', 'GST', '4-1100', 15620.00, 1420.00, '', 1),
  (3, 'Q2 FY2026-27', '2026-11-08', 'INV-000402', 'sale', 'GST', '4-1200', 20350.00, 1850.00, '', 1),
  (4, 'Q2 FY2026-27', '2026-11-12', 'INV-000405', 'sale', 'EXP', '4-2100', 14500.00, 0.00, '', 1),
  (5, 'Q2 FY2026-27', '2026-11-14', 'INV-000403', 'sale', 'FRE', '4-1100', 2200.00, 0.00, 'GST-Free (FRE) coded to taxable sales account 4-1100 - verify fresh produce exemption', 0),
  (6, 'Q2 FY2026-27', '2026-11-02', 'BILL-000210', 'purchase', 'GST', '6-1200', 3080.00, 280.00, '', 1),
  (7, 'Q2 FY2026-27', '2026-11-10', 'BILL-000212', 'purchase', 'GST', '6-1800', 19140.00, 1740.00, '', 1),
  (8, 'Q2 FY2026-27', '2026-11-15', 'BILL-000211', 'purchase', 'CAP', '1-3200', 3520.00, 320.00, '', 1),
  (9, 'Q2 FY2026-27', '2026-11-17', 'BILL-000215', 'purchase', 'GST', '1-3200', 2640.00, 240.00, 'Fixed Asset purchase > $1,000 coded as GST instead of CAP (G10 Capital Acquisition)', 0),
  (10, 'Q2 FY2026-27', '2026-11-19', 'BILL-000216', 'purchase', 'GST', '5-1100', 13200.00, 1200.00, '', 1);

INSERT OR IGNORE INTO bas_lodgements
  (id, period, date_range, g1_sales, g2_exports, g3_gst_free, g10_capital, g11_non_capital, gst_1a, gst_1b, w1_wages, w2_payg, net_payable, status, ato_receipt, lodged_at)
VALUES
  (1, 'Q1 FY2026-27', '1 Jul 2026 - 30 Sep 2026', 184800.00, 11200.00, 1800.00, 6600.00, 58300.00, 15618.00, 5900.00, 68400.00, 16120.00, 25838.00, 'Lodged', 'ATO-BAS-2026Q1-884920', '2026-10-21 14:18');
