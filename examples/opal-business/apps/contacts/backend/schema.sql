CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  contact_type TEXT NOT NULL DEFAULT 'Customer',
  abn TEXT NOT NULL DEFAULT '',
  abn_valid INTEGER NOT NULL DEFAULT 0,
  primary_person TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  suburb TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'NSW',
  postcode TEXT NOT NULL DEFAULT '',
  payment_terms TEXT NOT NULL DEFAULT 'Net 14',
  credit_limit REAL NOT NULL DEFAULT 0,
  balance REAL NOT NULL DEFAULT 0,
  bsb TEXT NOT NULL DEFAULT '',
  bank_account TEXT NOT NULL DEFAULT '',
  tpar_reportable INTEGER NOT NULL DEFAULT 0,
  tpar_ytd REAL NOT NULL DEFAULT 0,
  default_tax_code TEXT NOT NULL DEFAULT 'GST'
);

CREATE TABLE IF NOT EXISTS contact_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  author TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'Note',
  body TEXT NOT NULL
);

INSERT OR IGNORE INTO contacts
  (id, name, contact_type, abn, abn_valid, primary_person, email, phone, suburb, state, postcode, payment_terms, credit_limit, balance, bsb, bank_account, tpar_reportable, tpar_ytd, default_tax_code)
VALUES
  (1, 'Southern Cross Coffee Roasters Pty Ltd', 'Customer', '51 824 753 556', 1, 'Elena Ross', 'accounts@southerncrossroasters.com.au', '02 9182 4410', 'Marrickville', 'NSW', '2204', 'Net 14', 45000.00, 0.00, '', '', 0, 0.00, 'GST'),
  (2, 'Bayside Marine Engineering Pty Ltd', 'Customer', '33 051 775 556', 1, 'Marcus Doyle', 'finance@baysidemarine.com.au', '07 3891 2204', 'Morningside', 'QLD', '4170', 'Net 14', 50000.00, 10350.00, '', '', 0, 0.00, 'GST'),
  (3, 'Kangaroo Valley Organics', 'Customer', '64 008 402 990', 1, 'Sarah Chen', 'orders@kvorganics.com.au', '02 4465 1190', 'Kangaroo Valley', 'NSW', '2577', 'Net 14', 20000.00, 6820.00, '', '', 0, 0.00, 'FRE'),
  (4, 'Melbourne Dental Collective', 'Customer', '79 004 378 880', 1, 'Dr. Nathan Brooks', 'practice@melbdental.com.au', '03 9654 8812', 'South Yarra', 'VIC', '3141', 'Net 14', 35000.00, 9845.00, '', '', 0, 0.00, 'GST'),
  (5, 'Bunnings Trade Pty Ltd', 'Supplier', '26 008 672 179', 1, 'PowerPass Trade Desk', 'trade@bunnings.com.au', '1300 554 777', 'Hawthorn East', 'VIC', '3123', 'EOM', 15000.00, 924.00, '083-004', '5144 9021', 0, 0.00, 'GST'),
  (6, 'Amazon Web Services Australia', 'Supplier', '36 605 345 895', 1, 'AU Billing Support', 'au-billing@amazonaws.com', '1800 000 297', 'Sydney', 'NSW', '2000', 'Net 14', 25000.00, 0.00, '062-000', '9821 4401', 0, 0.00, 'GST'),
  (7, 'Harbour Electrical & Cabling Services', 'Contractor', '53 004 085 616', 1, 'Dave Kowalski', 'dave@harbourelectrical.com.au', '0412 889 301', 'Alexandria', 'NSW', '2015', 'Net 7', 10000.00, 1480.00, '062-112', '1044 7712', 1, 18450.00, 'GST'),
  (8, 'Outback Cloud DevOps Consulting', 'Contractor', '33 102 417 032', 1, 'Rachel Tan', 'rachel@outbackdevops.com.au', '0408 331 942', 'Fortitude Valley', 'QLD', '4006', 'Net 14', 25000.00, 0.00, '014-209', '4910 2283', 1, 26800.00, 'GST'),
  (9, 'Whitmore & Co Chartered Accountants', 'Advisor', '51 824 753 556', 1, 'Catherine Whitmore CA', 'catherine@whitmoreca.com.au', '02 9221 6700', 'Sydney CBD', 'NSW', '2000', 'Net 30', 0.00, 0.00, '', '', 0, 0.00, 'GST');

INSERT OR IGNORE INTO contact_notes (id, contact_id, created_at, author, channel, body) VALUES
  (1, 2, '2026-11-18 11:20', 'Chloe Nguyen', 'Phone Call', 'Confirmed Stage 2 balance payment of $10,350 scheduled via OSKO for 21 Nov.'),
  (2, 3, '2026-11-18 15:05', 'Jack Henderson', 'Email', 'Sent friendly reminder for INV-000403 and noted $660 credit CN-000021 available to apply.'),
  (3, 7, '2026-11-12 09:45', 'Liam O''Connor', 'Compliance', 'Verified valid ABN and flagged for ATO TPAR annual lodgement (IT & Electrical services).'),
  (4, 9, '2026-11-03 16:30', 'Chloe Nguyen', 'Advisor', 'Granted read-only BAS & General Ledger advisor access for Q2 FY2026-27 review.');
