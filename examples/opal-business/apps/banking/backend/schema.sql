CREATE TABLE IF NOT EXISTS bank_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  institution TEXT NOT NULL,
  account_type TEXT NOT NULL DEFAULT 'Everyday',
  bsb TEXT NOT NULL DEFAULT '',
  account_number TEXT NOT NULL DEFAULT '',
  feed_status TEXT NOT NULL DEFAULT 'Connected',
  last_synced TEXT NOT NULL,
  balance REAL NOT NULL DEFAULT 0,
  statement_balance REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS bank_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  tx_date TEXT NOT NULL,
  bank_ref TEXT NOT NULL,
  description TEXT NOT NULL,
  counterparty TEXT NOT NULL DEFAULT '',
  amount REAL NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  tax_code TEXT NOT NULL DEFAULT 'GST',
  allocated INTEGER NOT NULL DEFAULT 0,
  reconciled INTEGER NOT NULL DEFAULT 0,
  matched_rule TEXT NOT NULL DEFAULT '',
  suggested_match TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS bank_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_name TEXT NOT NULL,
  match_text TEXT NOT NULL,
  direction TEXT NOT NULL DEFAULT 'spend',
  category TEXT NOT NULL,
  tax_code TEXT NOT NULL DEFAULT 'GST',
  contact_name TEXT NOT NULL DEFAULT '',
  times_applied INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS reconciliations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  account_name TEXT NOT NULL,
  statement_date TEXT NOT NULL,
  statement_balance REAL NOT NULL,
  cleared_count INTEGER NOT NULL DEFAULT 0,
  reconciled_at TEXT NOT NULL
);

INSERT OR IGNORE INTO bank_accounts (id, name, institution, account_type, bsb, account_number, feed_status, last_synced, balance, statement_balance) VALUES
  (1, 'CommBank Business Everyday', 'Commonwealth Bank AU', 'Everyday', '062-000', '1084 9201', 'Connected', '2026-11-22 01:15', 164820.50, 164820.50),
  (2, 'NAB Business Cash Maximiser', 'National Australia Bank', 'Savings', '082-057', '7741 3308', 'Connected', '2026-11-22 01:15', 88450.00, 88450.00),
  (3, 'ANZ Business Rewards Visa', 'ANZ Australia', 'Credit Card', '012-003', '4564 **** 8819', 'Connected', '2026-11-22 01:15', -4182.40, -4182.40),
  (4, 'Stripe AU Payout Clearing', 'Stripe Australia', 'Clearing', '802-985', 'STRP-AU-01', 'Connected', '2026-11-22 01:15', 6240.00, 6240.00);

INSERT OR IGNORE INTO bank_rules (id, rule_name, match_text, direction, category, tax_code, contact_name, times_applied, active) VALUES
  (1, 'Telstra Telecom Auto-Code', 'TELSTRA', 'spend', '6-1600 Telephone & Internet', 'GST', 'Telstra Business Australia', 14, 1),
  (2, 'AWS Sydney Cloud Hosting', 'AMAZON WEB', 'spend', '6-1200 Cloud & Software', 'GST', 'Amazon Web Services Australia', 11, 1),
  (3, 'Bank Account Fees (GST Free)', 'ACCOUNT FEE', 'spend', '6-1100 Bank Charges', 'FRE', 'Commonwealth Bank AU', 9, 1),
  (4, 'Xero/Software Subscriptions', 'ATLASSIAN', 'spend', '6-1200 Cloud & Software', 'GST', 'Atlassian Pty Ltd', 6, 1),
  (5, 'ATO BAS / PAYG Remittance', 'ATO EFT', 'spend', '2-1400 GST & PAYG Clearing', 'N-T', 'Australian Taxation Office', 4, 1);

INSERT OR IGNORE INTO bank_transactions (id, account_id, tx_date, bank_ref, description, counterparty, amount, category, tax_code, allocated, reconciled, matched_rule, suggested_match) VALUES
  (1, 1, '2026-11-21', 'OSKO-88241', 'OSKO PAYMENT BAYSIDE MARINE INV-000402', 'Bayside Marine Engineering', 10350.00, '', 'GST', 0, 0, '', 'Match Tax Invoice INV-000402 ($10,350.00)'),
  (2, 1, '2026-11-21', 'DD-44109', 'DIRECT DEBIT TELSTRA BUSINESS 901822', 'Telstra Business Australia', -490.00, '', 'GST', 0, 0, '', ''),
  (3, 1, '2026-11-20', 'CARD-9910', 'AMAZON WEB SERVICES SYDNEY AU', 'Amazon Web Services Australia', -1870.00, '', 'GST', 0, 0, '', ''),
  (4, 1, '2026-11-20', 'FEE-1102', 'MONTHLY BUSINESS ACCOUNT FEE', 'Commonwealth Bank AU', -15.00, '', 'FRE', 0, 0, '', ''),
  (5, 1, '2026-11-19', 'BPAY-6612', 'BPAY MELBOURNE DENTAL COLLECTIVE', 'Melbourne Dental Collective', 9845.00, '', 'GST', 0, 0, '', 'Match Tax Invoice INV-000404 ($9,845.00)'),
  (6, 1, '2026-11-12', 'OSKO-44810', 'OSKO SOUTHERN CROSS COFFEE INV-000401', 'Southern Cross Coffee Roasters', 15620.00, '4-1100 Sales Revenue', 'GST', 1, 1, 'Matched INV-000401', ''),
  (7, 1, '2026-11-10', 'EFT-33102', 'SYDNEY CBD COMMERCIAL RENT NOV', 'Sydney CBD Property Trust', -6380.00, '6-1800 Rent & Outgoings', 'GST', 1, 0, 'Manual Allocate', ''),
  (8, 3, '2026-11-19', 'VISA-7712', 'ATLASSIAN PTY LTD SYDNEY AU', 'Atlassian Pty Ltd', -352.00, '', 'GST', 0, 0, '', ''),
  (9, 3, '2026-11-17', 'VISA-7690', 'QANTAS AIRWAYS SYD-BNE', 'Qantas Airways', -682.00, '6-2400 Travel & Accommodation', 'GST', 1, 0, 'Manual Allocate', ''),
  (10, 2, '2026-11-15', 'INT-202611', 'CREDIT INTEREST PAID', 'National Australia Bank', 312.45, '8-1100 Interest Income', 'FRE', 1, 1, 'Interest Auto', '');

INSERT OR IGNORE INTO reconciliations (id, account_id, account_name, statement_date, statement_balance, cleared_count, reconciled_at) VALUES
  (1, 1, 'CommBank Business Everyday', '2026-10-31', 142150.00, 42, '2026-11-02 09:30'),
  (2, 2, 'NAB Business Cash Maximiser', '2026-10-31', 88137.55, 6, '2026-11-02 09:42');
